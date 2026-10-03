import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const LEARNING_EVENT_KINDS = Object.freeze([
  'session_start_prompt', 'branch_exposed', 'branch_exact_selected', 'regenerate',
  'delete', 'turn_accepted_weak', 'explicit_preference',
] as const);
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];
export const PREFERENCE_LEARNING_EVENT_KINDS = Object.freeze([
  'session_start_prompt', 'branch_exact_selected',
] as const satisfies readonly LearningEventKind[]);
export const PREFERENCE_CLEAR_TOMBSTONE_VERSION = 'preference-clear-v1';
export interface PreferenceLearningEvidenceState {
  readonly revision: string;
  readonly sampleCount: number;
  readonly preferenceEpoch: number;
}
export interface PreferenceLearningEvidenceRow {
  readonly event_id: string;
  readonly payload_digest: string;
  readonly preference_epoch: number;
}
export type LearningContentMode = 'nsf' | 'nsfw';
export interface LearningProfileIdentityValue {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: LearningContentMode;
}
export interface LearningProfileIdentityInput {
  readonly rawSessionId: string;
  readonly cardName?: string | null;
  readonly cardFile?: string | null;
  readonly contentMode?: LearningContentMode | null;
}
export type LearningFeatureValue = string | number | boolean | null | readonly string[];

export interface LearningEventInput {
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
  readonly createdAt: string;
}

export interface LearningEventRecord extends LearningEventInput {
  readonly payloadDigest: string;
  readonly deliveredAt: string | null;
}

export interface PreferenceClearTombstone {
  readonly event: LearningEventRecord;
  readonly identity: LearningProfileIdentityValue;
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly previousEpoch: number;
  readonly preferenceEpoch: number;
  readonly removed: number;
  readonly resultRevision: string;
}

export interface PreferenceClearInput {
  readonly identity: LearningProfileIdentityValue;
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly createdAt?: string;
}

export interface PreferenceClearResult extends PreferenceLearningEvidenceState {
  readonly removed: number;
  readonly replayed: boolean;
  readonly tombstone: LearningEventRecord;
}

export class LearningEventConflictError extends Error {
  readonly code = 'learning-event-identity-conflict';
  constructor() { super('learning event identity is already bound to another payload'); }
}

export class PreferenceClearOperationIntentConflictError extends Error {
  readonly code = 'learning-preference-clear-operation-intent-conflict';
  constructor() { super('preference clear operation is already bound to another intent'); }
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const FEATURE_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/u;

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${field}-invalid`);
  return value;
}

function nullableToken(value: unknown, field: string): string | null {
  return value === null ? null : token(value, field);
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${field}-invalid`);
  return Number(value);
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field, 1);
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

function normalizeFeatures(value: unknown): Readonly<Record<string, LearningFeatureValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('learning-features-invalid');
  }
  const output: Record<string, LearningFeatureValue> = {};
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 32) throw new Error('learning-features-invalid');
  for (const [key, item] of entries) {
    if (!FEATURE_KEY.test(key)) throw new Error('learning-feature-key-invalid');
    if (typeof item === 'string') {
      if (!TOKEN.test(item)) throw new Error('learning-feature-string-invalid');
      output[key] = item;
    } else if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0) throw new Error('learning-feature-number-invalid');
      output[key] = item;
    } else if (typeof item === 'boolean' || item === null) {
      output[key] = item;
    } else if (Array.isArray(item) && item.length <= 32
      && item.every((entry) => typeof entry === 'string' && TOKEN.test(entry))) {
      output[key] = Object.freeze([...new Set(item as string[])]);
    } else {
      throw new Error('learning-feature-value-invalid');
    }
  }
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text, 'utf8') > 4_096) throw new Error('learning-features-too-large');
  return Object.freeze(output);
}

function payload(input: Omit<LearningEventRecord, 'payloadDigest' | 'deliveredAt'>): Record<string, unknown> {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    cardId: input.cardId,
    contentMode: input.contentMode,
    eventKind: input.eventKind,
    round: input.round,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    sourceRevision: input.sourceRevision,
    subjectDigest: input.subjectDigest,
    features: input.features,
  };
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function learningEventId(...identity: readonly (string | number | null)[]): string {
  return `learning:sha256:${createHash('sha256').update(identity.map((item) => String(item ?? '')).join('\0'), 'utf8').digest('hex')}`;
}

/** 保留安全短键；文件名/外部标签若不满足账本 token 契约则只暴露摘要。 */
export function opaqueLearningToken(prefix: string, value: string): string {
  const safePrefix = token(prefix, 'opaque-prefix');
  return TOKEN.test(value) ? value : `${safePrefix}:${sha256Digest(value)}`;
}

/**
 * Shared content-free owner identity for the session outbox, central learning ledger and
 * read-only control surface. Keep this formula in one place: a restored server session and a
 * metadata-only GET must never resolve the same card to different learning scopes.
 */
export function deriveLearningProfileIdentity(input: LearningProfileIdentityInput): LearningProfileIdentityValue {
  const sessionId = opaqueLearningToken('session', input.rawSessionId);
  const cardOwner = input.cardName || input.cardFile;
  return Object.freeze({
    sessionId,
    // Legacy/partial sessions must not collapse into one global unknown-card profile.
    cardId: `card:${sha256Digest(cardOwner || `unknown-card\0${sessionId}`)}`,
    contentMode: input.contentMode === 'nsf' ? 'nsf' : 'nsfw',
  });
}

/** Shared content-free CAS formula for live and metadata-only control reads. */
export function derivePreferenceLearningEvidenceState(input: {
  readonly identity: LearningProfileIdentityValue;
  readonly preferenceEpoch: number;
  readonly rows: readonly PreferenceLearningEvidenceRow[];
}): PreferenceLearningEvidenceState {
  const identity = normalizeLearningProfileIdentity(input.identity);
  const preferenceEpoch = integer(input.preferenceEpoch, 'preference-epoch', 0);
  const stable = input.rows.filter((row) => row.preference_epoch === preferenceEpoch)
    .sort((left, right) => left.event_id.localeCompare(right.event_id));
  return Object.freeze({
    revision: sha256Digest(JSON.stringify({
      identity,
      preferenceEpoch,
      rows: stable.map((row) => [row.event_id, row.payload_digest]),
    })),
    sampleCount: stable.length,
    preferenceEpoch,
  });
}

function normalizeLearningProfileIdentity(identity: LearningProfileIdentityValue): LearningProfileIdentityValue {
  if (identity.contentMode !== 'nsf' && identity.contentMode !== 'nsfw') {
    throw new Error('learning-content-mode-invalid');
  }
  return Object.freeze({
    sessionId: token(identity.sessionId, 'session-id'),
    cardId: token(identity.cardId, 'card-id'),
    contentMode: identity.contentMode,
  });
}

function exactIdentityKey(identity: LearningProfileIdentityValue): string {
  return `${identity.sessionId}\0${identity.cardId}\0${identity.contentMode}`;
}

/** Positive Preference samples written before epoch fencing are epoch zero. */
export function preferenceEpochOf(
  event: Pick<LearningEventInput, 'eventKind' | 'features'>,
): number | null {
  if (!PREFERENCE_LEARNING_EVENT_KINDS.includes(
    event.eventKind as (typeof PREFERENCE_LEARNING_EVENT_KINDS)[number],
  )) return null;
  const value = event.features.preferenceEpoch;
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function preferenceClearEventId(identity: LearningProfileIdentityValue, operationId: string): string {
  return learningEventId(
    PREFERENCE_CLEAR_TOMBSTONE_VERSION,
    identity.sessionId,
    identity.cardId,
    identity.contentMode,
    operationId,
  );
}

function preferenceClearSubject(input: {
  identity: LearningProfileIdentityValue;
  operationId: string;
  expectedRevision: string;
  previousEpoch: number;
  preferenceEpoch: number;
  removed: number;
  resultRevision: string;
}): string {
  return sha256Digest(JSON.stringify({
    version: PREFERENCE_CLEAR_TOMBSTONE_VERSION,
    identity: input.identity,
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    previousEpoch: input.previousEpoch,
    preferenceEpoch: input.preferenceEpoch,
    removed: input.removed,
    resultRevision: input.resultRevision,
  }));
}

/** Strictly recognizes only the content-free delete marker emitted by clearPreferenceEvidenceCas. */
export function parsePreferenceClearTombstone(event: LearningEventRecord): PreferenceClearTombstone | null {
  try {
    const normalized = normalizeLearningEvent(event);
    if (normalized.payloadDigest !== event.payloadDigest) return null;
    if (event.deliveredAt !== null) timestamp(event.deliveredAt, 'delivered-at');
  } catch {
    return null;
  }
  if (event.eventKind !== 'delete' || event.runId !== null || event.round !== 0
    || event.userMessageId !== null || event.assistantMessageId !== null || event.sourceRevision !== null) return null;
  const keys = Object.keys(event.features).sort();
  const expectedKeys = [
    'preferenceClearExpectedRevision', 'preferenceClearOperationId', 'preferenceClearPreviousEpoch',
    'preferenceClearRemoved', 'preferenceClearResultRevision', 'preferenceClearVersion', 'preferenceEpoch',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return null;
  const version = event.features.preferenceClearVersion;
  const operationId = event.features.preferenceClearOperationId;
  const expectedRevision = event.features.preferenceClearExpectedRevision;
  const previousEpoch = event.features.preferenceClearPreviousEpoch;
  const preferenceEpoch = event.features.preferenceEpoch;
  const removed = event.features.preferenceClearRemoved;
  const resultRevision = event.features.preferenceClearResultRevision;
  if (version !== PREFERENCE_CLEAR_TOMBSTONE_VERSION
    || typeof operationId !== 'string' || !TOKEN.test(operationId)
    || typeof expectedRevision !== 'string' || !DIGEST.test(expectedRevision)
    || !Number.isSafeInteger(previousEpoch) || Number(previousEpoch) < 0
    || !Number.isSafeInteger(preferenceEpoch) || Number(preferenceEpoch) !== Number(previousEpoch) + 1
    || !Number.isSafeInteger(removed) || Number(removed) < 0
    || typeof resultRevision !== 'string' || !DIGEST.test(resultRevision)) return null;
  const identity = normalizeLearningProfileIdentity({
    sessionId: event.sessionId,
    cardId: event.cardId,
    contentMode: event.contentMode,
  });
  const normalized = {
    identity,
    operationId,
    expectedRevision,
    previousEpoch: Number(previousEpoch),
    preferenceEpoch: Number(preferenceEpoch),
    removed: Number(removed),
    resultRevision,
  };
  if (event.eventId !== preferenceClearEventId(identity, operationId)) return null;
  const derivedResult = derivePreferenceLearningEvidenceState({ identity, preferenceEpoch: normalized.preferenceEpoch, rows: [] });
  if (resultRevision !== derivedResult.revision || event.subjectDigest !== preferenceClearSubject(normalized)) return null;
  return Object.freeze({ event, ...normalized });
}

export function normalizeLearningEvent(input: LearningEventInput): LearningEventRecord {
  if (!LEARNING_EVENT_KINDS.includes(input.eventKind)) throw new Error('learning-event-kind-invalid');
  if (input.contentMode !== 'nsf' && input.contentMode !== 'nsfw') throw new Error('learning-content-mode-invalid');
  const record = {
    eventId: token(input.eventId, 'event-id'),
    runId: nullableToken(input.runId, 'run-id'),
    sessionId: token(input.sessionId, 'session-id'),
    cardId: token(input.cardId, 'card-id'),
    contentMode: input.contentMode,
    eventKind: input.eventKind,
    round: integer(input.round, 'round', 0),
    userMessageId: nullableInteger(input.userMessageId, 'user-message-id'),
    assistantMessageId: nullableInteger(input.assistantMessageId, 'assistant-message-id'),
    sourceRevision: nullableToken(input.sourceRevision, 'source-revision'),
    subjectDigest: digest(input.subjectDigest, 'subject-digest'),
    features: normalizeFeatures(input.features),
    createdAt: timestamp(input.createdAt, 'created-at'),
  } as const;
  return Object.freeze({
    ...record,
    payloadDigest: sha256Digest(JSON.stringify(payload(record))),
    deliveredAt: null,
  });
}

function parseRow(row: Record<string, unknown>): LearningEventRecord {
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
    createdAt: String(row.created_at),
  });
  if (normalized.payloadDigest !== row.payload_digest) throw new Error('learning-event-payload-mismatch');
  return Object.freeze({
    ...normalized,
    deliveredAt: row.delivered_at === null ? null : timestamp(row.delivered_at, 'delivered-at'),
  });
}

export class LearningOutboxStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transactionActive: () => boolean = () => false,
  ) {}

  append(input: LearningEventInput): LearningEventRecord {
    const positive = PREFERENCE_LEARNING_EVENT_KINDS.includes(
      input.eventKind as (typeof PREFERENCE_LEARNING_EVENT_KINDS)[number],
    );
    if (!positive || this.transactionActive()) return this.appendAtCurrentEpoch(input, positive);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.appendAtCurrentEpoch(input, true);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private appendAtCurrentEpoch(input: LearningEventInput, positive: boolean): LearningEventRecord {
    const identity = normalizeLearningProfileIdentity(input);
    const event = normalizeLearningEvent({
      ...input,
      features: positive
        ? { ...input.features, preferenceEpoch: this.currentPreferenceEpoch(identity) }
        : input.features,
    });
    const existing = this.get(event.eventId);
    if (existing) {
      if (existing.payloadDigest !== event.payloadDigest) throw new LearningEventConflictError();
      return existing;
    }
    this.db.prepare(`
      INSERT INTO learning_outbox(
        event_id,run_id,session_id,card_id,content_mode,event_kind,round,user_message_id,
        assistant_message_id,source_revision,subject_digest,features_json,payload_digest,created_at,delivered_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    `).run(
      event.eventId, event.runId, event.sessionId, event.cardId, event.contentMode,
      event.eventKind, event.round, event.userMessageId, event.assistantMessageId,
      event.sourceRevision, event.subjectDigest, JSON.stringify(event.features),
      event.payloadDigest, event.createdAt,
    );
    return event;
  }

  get(eventId: string): LearningEventRecord | null {
    const row = this.db.prepare('SELECT * FROM learning_outbox WHERE event_id=?')
      .get(token(eventId, 'event-id')) as Record<string, unknown> | undefined;
    return row ? parseRow(row) : null;
  }

  list(input: {
    pendingOnly?: boolean;
    limit?: number;
    after?: { createdAt: string; eventId: string };
  } = {}): LearningEventRecord[] {
    const limit = input.limit ?? 10_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('learning-limit-invalid');
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.pendingOnly) where.push('delivered_at IS NULL');
    if (input.after) {
      const createdAt = timestamp(input.after.createdAt, 'after-created-at');
      const eventId = token(input.after.eventId, 'after-event-id');
      where.push('(created_at > ? OR (created_at = ? AND event_id > ?))');
      params.push(createdAt, createdAt, eventId);
    }
    params.push(limit);
    return (this.db.prepare(`SELECT * FROM learning_outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at,event_id LIMIT ?`).all(...params) as Record<string, unknown>[]).map(parseRow);
  }

  /** Every exact identity's latest durable fence, including already-delivered tombstones. */
  preferenceClearTombstones(): LearningEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM learning_outbox WHERE event_kind='delete' ORDER BY created_at,event_id
    `).all() as Record<string, unknown>[];
    const latest = new Map<string, PreferenceClearTombstone>();
    for (const row of rows) {
      const parsed = parsePreferenceClearTombstone(parseRow(row));
      if (!parsed) continue;
      const key = exactIdentityKey(parsed.identity);
      const previous = latest.get(key);
      if (!previous || parsed.preferenceEpoch > previous.preferenceEpoch
        || (parsed.preferenceEpoch === previous.preferenceEpoch
          && parsed.event.eventId.localeCompare(previous.event.eventId) > 0)) latest.set(key, parsed);
    }
    return [...latest.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([, tombstone]) => tombstone.event);
  }

  currentPreferenceEpoch(identityInput: LearningProfileIdentityValue): number {
    const identity = normalizeLearningProfileIdentity(identityInput);
    const rows = this.db.prepare(`
      SELECT * FROM learning_outbox
      WHERE session_id=? AND round=0 AND event_kind='delete' AND card_id=? AND content_mode=?
      ORDER BY created_at DESC,event_id DESC
    `).all(identity.sessionId, identity.cardId, identity.contentMode) as Record<string, unknown>[];
    let latest = 0;
    for (const row of rows) {
      const tombstone = parsePreferenceClearTombstone(parseRow(row));
      if (tombstone && tombstone.preferenceEpoch > latest) latest = tombstone.preferenceEpoch;
    }
    return latest;
  }

  /**
   * Preference/branch preference 的可重建正样本状态。revision 绑定 exact identity、当前 epoch
   * 和当前 epoch 内的 event identity + payload digest，不含用户正文，也不是时间戳。
   */
  preferenceEvidenceState(identityInput: LearningProfileIdentityValue): PreferenceLearningEvidenceState {
    const identity = normalizeLearningProfileIdentity(identityInput);
    const preferenceEpoch = this.currentPreferenceEpoch(identity);
    const rows = this.db.prepare(`
      SELECT event_id,payload_digest,event_kind,features_json FROM learning_outbox
      WHERE session_id=? AND card_id=? AND content_mode=?
        AND event_kind IN ('session_start_prompt','branch_exact_selected')
      ORDER BY event_id
    `).all(identity.sessionId, identity.cardId, identity.contentMode) as Array<{
      event_id: string; payload_digest: string; event_kind: LearningEventKind; features_json: string;
    }>;
    return derivePreferenceLearningEvidenceState({
      identity,
      preferenceEpoch,
      rows: rows.flatMap((row) => {
        const epoch = preferenceEpochOf({
          eventKind: row.event_kind,
          features: JSON.parse(row.features_json) as Record<string, LearningFeatureValue>,
        });
        return epoch === null ? [] : [{
          event_id: row.event_id,
          payload_digest: row.payload_digest,
          preference_epoch: epoch,
        }];
      }),
    });
  }

  /**
   * 先持久化可同步的 epoch fence，再物理删除 exact identity 的两类正样本。共享的
   * regenerate/delete tombstone 保留；same operation replay 在 CAS 之前返回原结果。
   */
  clearPreferenceEvidenceCas(input: PreferenceClearInput): PreferenceClearResult {
    const identity = normalizeLearningProfileIdentity(input.identity);
    const operationId = token(input.operationId, 'preference-clear-operation-id');
    const expectedRevision = digest(input.expectedRevision, 'preference-revision');
    const eventId = preferenceClearEventId(identity, operationId);
    const replay = this.get(eventId);
    if (replay) return this.preferenceClearReplay(replay, { identity, operationId, expectedRevision });
    const ownsTransaction = !this.transactionActive();
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const concurrentReplay = this.get(eventId);
      if (concurrentReplay) {
        const result = this.preferenceClearReplay(concurrentReplay, { identity, operationId, expectedRevision });
        if (ownsTransaction) this.db.exec('COMMIT');
        return result;
      }
      const before = this.preferenceEvidenceState(identity);
      if (before.revision !== expectedRevision) throw new Error('learning-preference-revision-conflict');
      if (before.preferenceEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('learning-preference-epoch-exhausted');
      const preferenceEpoch = before.preferenceEpoch + 1;
      const physicalCount = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM learning_outbox
        WHERE session_id=? AND card_id=? AND content_mode=?
          AND event_kind IN ('session_start_prompt','branch_exact_selected')
      `).get(identity.sessionId, identity.cardId, identity.contentMode) as { count: number }).count);
      const resultRevision = derivePreferenceLearningEvidenceState({ identity, preferenceEpoch, rows: [] }).revision;
      const tombstoneIntent = {
        identity,
        operationId,
        expectedRevision,
        previousEpoch: before.preferenceEpoch,
        preferenceEpoch,
        removed: physicalCount,
        resultRevision,
      };
      const tombstone = this.append({
        eventId,
        runId: null,
        ...identity,
        eventKind: 'delete',
        round: 0,
        userMessageId: null,
        assistantMessageId: null,
        sourceRevision: null,
        subjectDigest: preferenceClearSubject(tombstoneIntent),
        features: {
          preferenceClearVersion: PREFERENCE_CLEAR_TOMBSTONE_VERSION,
          preferenceClearOperationId: operationId,
          preferenceClearExpectedRevision: expectedRevision,
          preferenceClearPreviousEpoch: before.preferenceEpoch,
          preferenceEpoch,
          preferenceClearRemoved: physicalCount,
          preferenceClearResultRevision: resultRevision,
        },
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      const removed = Number(this.db.prepare(`
        DELETE FROM learning_outbox
        WHERE session_id=? AND card_id=? AND content_mode=?
          AND event_kind IN ('session_start_prompt','branch_exact_selected')
      `).run(identity.sessionId, identity.cardId, identity.contentMode).changes);
      if (removed !== physicalCount) throw new Error('learning-preference-clear-delete-conflict');
      const after = this.preferenceEvidenceState(identity);
      if (after.revision !== resultRevision || after.sampleCount !== 0 || after.preferenceEpoch !== preferenceEpoch) {
        throw new Error('learning-preference-clear-fence-conflict');
      }
      if (ownsTransaction) this.db.exec('COMMIT');
      return Object.freeze({ ...after, removed, replayed: false, tombstone });
    } catch (error) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  private preferenceClearReplay(
    event: LearningEventRecord,
    intent: Pick<PreferenceClearInput, 'identity' | 'operationId' | 'expectedRevision'>,
  ): PreferenceClearResult {
    const parsed = parsePreferenceClearTombstone(event);
    if (!parsed || exactIdentityKey(parsed.identity) !== exactIdentityKey(intent.identity)
      || parsed.operationId !== intent.operationId || parsed.expectedRevision !== intent.expectedRevision) {
      throw new PreferenceClearOperationIntentConflictError();
    }
    return Object.freeze({
      revision: parsed.resultRevision,
      sampleCount: 0,
      preferenceEpoch: parsed.preferenceEpoch,
      removed: parsed.removed,
      replayed: true,
      tombstone: event,
    });
  }

  /** 仅在独立 learning ledger 已确认同 payload eventId 后调用；重复确认幂等。 */
  markDelivered(eventId: string, payloadDigest: string, deliveredAt: string): { replayed: boolean } {
    const id = token(eventId, 'event-id');
    const expectedPayload = digest(payloadDigest, 'payload-digest');
    const at = timestamp(deliveredAt, 'delivered-at');
    const existing = this.get(id);
    if (!existing) throw new Error('learning-event-not-found');
    if (existing.payloadDigest !== expectedPayload) throw new LearningEventConflictError();
    if (existing.deliveredAt !== null) return { replayed: true };
    const result = this.db.prepare(
      'UPDATE learning_outbox SET delivered_at=? WHERE event_id=? AND payload_digest=? AND delivered_at IS NULL',
    ).run(at, id, expectedPayload);
    if (Number(result.changes) !== 1) throw new Error('learning-delivery-ack-conflict');
    return { replayed: false };
  }
}
