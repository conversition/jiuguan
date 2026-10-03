import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LEARNING_EVENT_KINDS,
  PREFERENCE_LEARNING_EVENT_KINDS,
  LearningEventConflictError,
  normalizeLearningEvent,
  parsePreferenceClearTombstone,
  preferenceEpochOf,
  type LearningContentMode,
  type LearningEventKind,
  type LearningEventRecord,
  type LearningFeatureValue,
  type LearningProfileIdentityValue,
} from '../../packages/memory/src/learning-outbox.ts';
import {
  rebuildBranchPreferenceProfiles,
  type BranchPreferenceProfiles,
} from '../../packages/agent-policy/src/branch-preference.ts';
import {
  rebuildPromptPreferenceProfiles,
  type PromptPreferenceProfiles,
} from '../../packages/agent-policy/src/prompt-preference.ts';
import {
  rebuildStyleEvidenceProfiles,
  type StyleEvidenceProfiles,
} from '../../packages/agent-policy/src/style-evidence.ts';
import {
  rebuildArcSessionProjections,
  type ArcSessionProjection,
} from '../../packages/agent-policy/src/arc-projection.ts';
import {
  rebuildNpcSessionProjections,
  type NpcSessionProjection,
} from '../../packages/agent-policy/src/npc-evidence.ts';
import {
  resolveLearningHydration,
  type LearningHydrationSnapshot,
  type LearningProfileIdentity,
} from '../../packages/agent-policy/src/learning-hydration.ts';

export const AGENT_LEARNING_DB_FILE = 'agent-learning.sqlite';
export const AGENT_LEARNING_SCHEMA_VERSION = 1;
export const AGENT_LEARNING_APPLICATION_ID = 0x4a474c4e; // JGLN

type Row = Record<string, unknown>;

export interface AgentLearningRow {
  readonly eventId: string;
  readonly runId: string | null;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: LearningContentMode;
  readonly eventKind: LearningEventKind;
  readonly round: number;
  readonly userMessageId: number | null;
  readonly assistantMessageId: number | null;
  readonly sourceRevision: string | null;
  readonly subjectDigest: string;
  readonly features: Readonly<Record<string, LearningFeatureValue>>;
  readonly payloadDigest: string;
  readonly sourceCreatedAt: string;
  readonly ingestedAt: string;
}

export type AgentLearningAppendResult = Readonly<
  | {
    status: 'inserted' | 'replayed';
    replayed: boolean;
    discardedStale: false;
    discardedDeletedSession: false;
    row: AgentLearningRow;
  }
  | {
    status: 'discarded-stale';
    replayed: false;
    discardedStale: true;
    discardedDeletedSession: false;
    row: null;
  }
  | {
    status: 'discarded-deleted-session';
    replayed: false;
    discardedStale: false;
    discardedDeletedSession: true;
    row: null;
  }
>;

export type IsLearningSessionDeleted = (sessionId: string) => boolean;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EXACT_COLUMNS = Object.freeze({
  learning_event: Object.freeze([
    'event_id', 'payload_digest', 'run_id', 'session_id', 'card_id', 'content_mode',
    'event_kind', 'round', 'user_message_id', 'assistant_message_id', 'source_revision',
    'subject_digest', 'features_json', 'source_created_at', 'ingested_at',
  ]),
});

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`agent-learning-${name}-invalid`);
  return Number(value);
}

function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const applicationId = pragma(db, 'application_id');
  if (version > AGENT_LEARNING_SCHEMA_VERSION) throw new Error('agent-learning-too-new');
  if (version !== 0) {
    if (version !== AGENT_LEARNING_SCHEMA_VERSION || applicationId !== AGENT_LEARNING_APPLICATION_ID) {
      throw new Error('agent-learning-metadata-mismatch');
    }
    return;
  }
  if (applicationId !== 0) throw new Error('agent-learning-application-id-mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${AGENT_LEARNING_APPLICATION_ID};
      CREATE TABLE learning_event (
        event_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=71),
        run_id TEXT,
        session_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        content_mode TEXT NOT NULL CHECK(content_mode IN ('nsf','nsfw')),
        event_kind TEXT NOT NULL CHECK(event_kind IN (
          'session_start_prompt','branch_exposed','branch_exact_selected','regenerate',
          'delete','turn_accepted_weak','explicit_preference'
        )),
        round INTEGER NOT NULL CHECK(round >= 0),
        user_message_id INTEGER CHECK(user_message_id IS NULL OR user_message_id >= 1),
        assistant_message_id INTEGER CHECK(assistant_message_id IS NULL OR assistant_message_id >= 1),
        source_revision TEXT,
        subject_digest TEXT NOT NULL CHECK(length(subject_digest)=71),
        features_json TEXT NOT NULL CHECK(json_valid(features_json)),
        source_created_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );
      CREATE INDEX learning_event_session ON learning_event(session_id,source_created_at,event_id);
      CREATE INDEX learning_event_card_mode ON learning_event(card_id,content_mode,event_kind,source_created_at);
      CREATE INDEX learning_event_run ON learning_event(run_id,event_kind) WHERE run_id IS NOT NULL;
      PRAGMA user_version = ${AGENT_LEARNING_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
}

function inspectExactSchema(db: DatabaseSync): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (tables.join(',') !== Object.keys(EXACT_COLUMNS).sort().join(',')) {
    throw new Error('agent-learning-schema-tables-mismatch');
  }
  for (const [table, expected] of Object.entries(EXACT_COLUMNS)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    if (columns.join(',') !== expected.join(',')) throw new Error('agent-learning-schema-columns-mismatch');
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${field}-invalid`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field}-invalid`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${field}-invalid`);
  return value;
}

function parseRow(row: Row): AgentLearningRow {
  const normalized = normalizeLearningEvent({
    eventId: String(row.event_id),
    runId: row.run_id === null ? null : String(row.run_id),
    sessionId: String(row.session_id),
    cardId: String(row.card_id),
    contentMode: row.content_mode as LearningContentMode,
    eventKind: row.event_kind as LearningEventKind,
    round: Number(row.round),
    userMessageId: row.user_message_id === null ? null : Number(row.user_message_id),
    assistantMessageId: row.assistant_message_id === null ? null : Number(row.assistant_message_id),
    sourceRevision: row.source_revision === null ? null : String(row.source_revision),
    subjectDigest: String(row.subject_digest),
    features: JSON.parse(String(row.features_json)) as Record<string, LearningFeatureValue>,
    createdAt: String(row.source_created_at),
  });
  if (normalized.payloadDigest !== row.payload_digest) throw new Error('agent-learning-payload-mismatch');
  return Object.freeze({
    eventId: normalized.eventId,
    runId: normalized.runId,
    sessionId: normalized.sessionId,
    cardId: normalized.cardId,
    contentMode: normalized.contentMode,
    eventKind: normalized.eventKind,
    round: normalized.round,
    userMessageId: normalized.userMessageId,
    assistantMessageId: normalized.assistantMessageId,
    sourceRevision: normalized.sourceRevision,
    subjectDigest: normalized.subjectDigest,
    features: normalized.features,
    payloadDigest: normalized.payloadDigest,
    sourceCreatedAt: normalized.createdAt,
    ingestedAt: timestamp(row.ingested_at, 'ingested-at'),
  });
}

function assertRecord(record: LearningEventRecord): LearningEventRecord {
  const normalized = normalizeLearningEvent(record);
  if (normalized.payloadDigest !== record.payloadDigest) throw new Error('agent-learning-payload-mismatch');
  return { ...normalized, deliveredAt: record.deliveredAt };
}

export class AgentLearningLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #afterPreferenceFenceInsert?: (event: LearningEventRecord) => void;
  readonly #isSessionDeleted: IsLearningSessionDeleted;
  #closed = false;

  constructor(options: {
    dataDir: string;
    now?: () => string;
    busyTimeoutMs?: number;
    /** Durable deletion-intent lookup. Must be side-effect free and fail closed by throwing. */
    isSessionDeleted?: IsLearningSessionDeleted;
    /** Crash-window fixture hook. Production must omit. */
    afterPreferenceFenceInsert?: (event: LearningEventRecord) => void;
  }) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('agent-learning-data-dir-invalid');
    const path = join(dataDir, AGENT_LEARNING_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('agent-learning-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5_000};`);
      initialize(this.#db);
      inspectExactSchema(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL inherited from private data dir. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#isSessionDeleted = options.isSessionDeleted ?? (() => false);
    this.#afterPreferenceFenceInsert = options.afterPreferenceFenceInsert;
  }

  append(input: LearningEventRecord): AgentLearningAppendResult {
    this.#assertOpen();
    const event = assertRecord(input);
    const deleted = this.#isSessionDeleted(event.sessionId);
    if (typeof deleted !== 'boolean') throw new Error('agent-learning-session-deletion-state-invalid');
    if (deleted) {
      return Object.freeze({
        status: 'discarded-deleted-session',
        replayed: false,
        discardedStale: false,
        discardedDeletedSession: true,
        row: null,
      });
    }
    const clear = parsePreferenceClearTombstone(event);
    if (clear) return this.#appendPreferenceFence(event, clear.identity, clear.preferenceEpoch);
    const eventEpoch = preferenceEpochOf(event);
    if (PREFERENCE_LEARNING_EVENT_KINDS.includes(
      event.eventKind as (typeof PREFERENCE_LEARNING_EVENT_KINDS)[number],
    ) && eventEpoch === null) throw new Error('learning-preference-epoch-invalid');
    if (eventEpoch !== null) {
      const currentEpoch = this.preferenceEpoch({
        sessionId: event.sessionId,
        cardId: event.cardId,
        contentMode: event.contentMode,
      });
      if (eventEpoch < currentEpoch) {
        return Object.freeze({
          status: 'discarded-stale', replayed: false, discardedStale: true,
          discardedDeletedSession: false, row: null,
        });
      }
      if (eventEpoch > currentEpoch) throw new Error('learning-preference-epoch-ahead');
    }
    const existing = this.get(event.eventId);
    if (existing) {
      if (existing.payloadDigest !== event.payloadDigest) throw new LearningEventConflictError();
      return Object.freeze({
        status: 'replayed', replayed: true, discardedStale: false,
        discardedDeletedSession: false, row: existing,
      });
    }
    const ingestedAt = timestamp(this.#now(), 'ingested-at');
    this.#insert(event, ingestedAt);
    return Object.freeze({
      status: 'inserted', replayed: false, discardedStale: false,
      discardedDeletedSession: false, row: this.get(event.eventId)!,
    });
  }

  /** Latest committed preference fence for one exact session/card/mode owner. */
  preferenceEpoch(identity: LearningProfileIdentityValue): number {
    this.#assertOpen();
    const rows = this.#db.prepare(`
      SELECT * FROM learning_event
      WHERE session_id=? AND card_id=? AND content_mode=? AND event_kind='delete'
      ORDER BY source_created_at,event_id
    `).all(
      token(identity.sessionId, 'session-id'),
      token(identity.cardId, 'card-id'),
      identity.contentMode,
    ) as Row[];
    let epoch = 0;
    for (const row of rows) {
      const parsed = parseRow(row);
      const fence = parsePreferenceClearTombstone(normalizeLearningEvent({
        eventId: parsed.eventId,
        runId: parsed.runId,
        sessionId: parsed.sessionId,
        cardId: parsed.cardId,
        contentMode: parsed.contentMode,
        eventKind: parsed.eventKind,
        round: parsed.round,
        userMessageId: parsed.userMessageId,
        assistantMessageId: parsed.assistantMessageId,
        sourceRevision: parsed.sourceRevision,
        subjectDigest: parsed.subjectDigest,
        features: parsed.features,
        createdAt: parsed.sourceCreatedAt,
      }));
      if (fence) epoch = Math.max(epoch, fence.preferenceEpoch);
    }
    return epoch;
  }

  get(eventId: string): AgentLearningRow | null {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM learning_event WHERE event_id=?')
      .get(token(eventId, 'event-id')) as Row | undefined;
    return row ? parseRow(row) : null;
  }

  list(input: { sessionId?: string; cardId?: string; eventKind?: LearningEventKind; limit?: number } = {}): AgentLearningRow[] {
    this.#assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.sessionId !== undefined) { where.push('session_id=?'); params.push(token(input.sessionId, 'session-id')); }
    if (input.cardId !== undefined) { where.push('card_id=?'); params.push(token(input.cardId, 'card-id')); }
    if (input.eventKind !== undefined) {
      if (!LEARNING_EVENT_KINDS.includes(input.eventKind)) throw new Error('event-kind-invalid');
      where.push('event_kind=?'); params.push(input.eventKind);
    }
    const limit = input.limit ?? 10_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('limit-invalid');
    params.push(limit);
    return (this.#db.prepare(`SELECT * FROM learning_event${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY source_created_at,event_id LIMIT ?`).all(...params) as Row[]).map(parseRow);
  }

  /** P14-03B shadow：从 append-only 正样本按需完整重建，不新增第二份 profile 真值。 */
  branchPreferenceProfiles(): BranchPreferenceProfiles {
    this.#assertOpen();
    const rows = (this.#db.prepare(
      "SELECT * FROM learning_event WHERE event_kind IN ('branch_exact_selected','regenerate','delete') ORDER BY source_created_at,event_id",
    ).all() as Row[]).map(parseRow);
    return rebuildBranchPreferenceProfiles(rows);
  }

  /** P14-03C-01 shadow：只消费 session_start_prompt 的固定标签 features，不读取源消息正文。 */
  promptPreferenceProfiles(): PromptPreferenceProfiles {
    this.#assertOpen();
    const rows = (this.#db.prepare(
      "SELECT * FROM learning_event WHERE event_kind IN ('session_start_prompt','regenerate','delete') ORDER BY source_created_at,event_id",
    ).all() as Row[]).map(parseRow);
    return rebuildPromptPreferenceProfiles(rows);
  }

  /** P14-04A shadow：弱样本遇 delete/regenerate 自动失效，纯重建不读取消息正文。 */
  styleEvidenceProfiles(): StyleEvidenceProfiles {
    this.#assertOpen();
    const rows = (this.#db.prepare(
      "SELECT * FROM learning_event WHERE event_kind IN ('turn_accepted_weak','regenerate','delete') ORDER BY source_created_at,event_id",
    ).all() as Row[]).map(parseRow);
    return rebuildStyleEvidenceProfiles(rows);
  }

  /** H0-R3：精确 session 优先，其次同 card+contentMode；不制造 global scope。 */
  learningHydration(identity: LearningProfileIdentity): LearningHydrationSnapshot {
    this.#assertOpen();
    return resolveLearningHydration({
      identity,
      prompt: this.promptPreferenceProfiles(),
      branch: this.branchPreferenceProfiles(),
      style: this.styleEvidenceProfiles(),
    });
  }

  /** P14-05A shadow：独立于旧 memory_arc，只从脱敏事件纯重建 Arc 投影与 typed proposal。 */
  arcSessionProjections(): readonly ArcSessionProjection[] {
    this.#assertOpen();
    const rows = (this.#db.prepare(
      "SELECT * FROM learning_event WHERE event_kind IN ('turn_accepted_weak','regenerate','delete') ORDER BY source_created_at,event_id",
    ).all() as Row[]).map(parseRow);
    return rebuildArcSessionProjections(rows);
  }

  /** P14-05B shadow：只保留稳定人物摘要/类别统计；CharacterStore 仍是唯一人物事实真源。 */
  npcSessionProjections(): readonly NpcSessionProjection[] {
    this.#assertOpen();
    const rows = (this.#db.prepare(
      "SELECT * FROM learning_event WHERE event_kind IN ('turn_accepted_weak','regenerate','delete') ORDER BY source_created_at,event_id",
    ).all() as Row[]).map(parseRow);
    return rebuildNpcSessionProjections(rows);
  }

  /** 显式删除策略：至少给 session 或 card scope；生产端须与源 session 删除协调，避免重建回填。 */
  deleteScope(input: { sessionId?: string; cardId?: string }): number {
    this.#assertOpen();
    if (input.sessionId === undefined && input.cardId === undefined) throw new Error('delete-scope-required');
    const where: string[] = [];
    const params: string[] = [];
    if (input.sessionId !== undefined) { where.push('session_id=?'); params.push(token(input.sessionId, 'session-id')); }
    if (input.cardId !== undefined) { where.push('card_id=?'); params.push(token(input.cardId, 'card-id')); }
    return Number(this.#db.prepare(`DELETE FROM learning_event WHERE ${where.join(' AND ')}`).run(...params).changes);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #appendPreferenceFence(
    event: LearningEventRecord,
    identity: LearningProfileIdentityValue,
    preferenceEpoch: number,
  ): AgentLearningAppendResult {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(event.eventId);
      if (existing) {
        if (existing.payloadDigest !== event.payloadDigest) throw new LearningEventConflictError();
        this.#deleteStalePreferenceEvidence(identity, preferenceEpoch);
        this.#db.exec('COMMIT');
        return Object.freeze({
          status: 'replayed', replayed: true, discardedStale: false,
          discardedDeletedSession: false, row: existing,
        });
      }
      const currentEpoch = this.preferenceEpoch(identity);
      if (preferenceEpoch < currentEpoch) {
        this.#db.exec('COMMIT');
        return Object.freeze({
          status: 'discarded-stale', replayed: false, discardedStale: true,
          discardedDeletedSession: false, row: null,
        });
      }
      if (preferenceEpoch === currentEpoch) throw new Error('learning-preference-fence-conflict');
      // The source deliberately exposes only its latest exact-scope fence. Accept a monotonic
      // jump so two offline clears can recover a newly restored/empty central ledger.
      this.#insert(event, timestamp(this.#now(), 'ingested-at'));
      this.#afterPreferenceFenceInsert?.(event);
      this.#deleteStalePreferenceEvidence(identity, preferenceEpoch);
      const row = this.get(event.eventId);
      if (!row) throw new Error('learning-preference-fence-missing');
      this.#db.exec('COMMIT');
      return Object.freeze({
        status: 'inserted', replayed: false, discardedStale: false,
        discardedDeletedSession: false, row,
      });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  #deleteStalePreferenceEvidence(identity: LearningProfileIdentityValue, preferenceEpoch: number): number {
    return Number(this.#db.prepare(`
      DELETE FROM learning_event
      WHERE session_id=? AND card_id=? AND content_mode=?
        AND event_kind IN ('session_start_prompt','branch_exact_selected')
        AND CASE
          WHEN json_type(features_json,'$.preferenceEpoch')='integer'
            THEN json_extract(features_json,'$.preferenceEpoch')
          ELSE 0
        END < ?
    `).run(
      token(identity.sessionId, 'session-id'),
      token(identity.cardId, 'card-id'),
      identity.contentMode,
      preferenceEpoch,
    ).changes);
  }

  #insert(event: LearningEventRecord, ingestedAt: string): void {
    this.#db.prepare(`INSERT INTO learning_event(
      event_id,payload_digest,run_id,session_id,card_id,content_mode,event_kind,round,
      user_message_id,assistant_message_id,source_revision,subject_digest,features_json,
      source_created_at,ingested_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.eventId, event.payloadDigest, event.runId, event.sessionId, event.cardId,
      event.contentMode, event.eventKind, event.round, event.userMessageId,
      event.assistantMessageId, event.sourceRevision, event.subjectDigest,
      JSON.stringify(event.features), event.createdAt, ingestedAt,
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('agent-learning-ledger-closed');
  }
}

/** 严格只读；缺失文件返回空，不得为分析创建数据库。 */
export function readAgentLearningFile(file: string): AgentLearningRow[] {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agent-learning-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (pragma(db, 'application_id') !== AGENT_LEARNING_APPLICATION_ID
      || pragma(db, 'user_version') !== AGENT_LEARNING_SCHEMA_VERSION) {
      throw new Error('agent-learning-metadata-mismatch');
    }
    inspectExactSchema(db);
    return (db.prepare('SELECT * FROM learning_event ORDER BY source_created_at,event_id').all() as Row[]).map(parseRow);
  } finally {
    db.close();
  }
}
