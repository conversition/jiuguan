import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_CLOSURE_CONTRACT_VERSION,
  AGENT_CLOSURE_CAPABILITIES,
  AGENT_CLOSURE_EVENT_TYPES,
  agentClosureCapabilityFilter,
  agentClosureDigest,
  agentClosureTimestamp,
  agentClosureToken,
  canonicalAgentClosureCapability,
  foldAgentClosure,
  normalizeAgentClosureEvent,
  normalizeAgentClosureRun,
  type AgentClosureCapability,
  type AgentClosureEvent,
  type AgentClosureEventInput,
  type AgentClosureExecutionClass,
  type AgentClosureFold,
  type AgentClosureKind,
  type AgentClosureLane,
  type AgentClosureRunInput,
  type AgentClosureStage,
  type AgentClosureStatus,
} from '../../packages/agent-closure/index.ts';

export const AGENT_CLOSURE_DB_FILE = 'agent-closure.sqlite';
export const AGENT_CLOSURE_SCHEMA_VERSION = 2;
export const AGENT_CLOSURE_APPLICATION_ID = 0x4a474352; // JGCR

type Row = Record<string, unknown>;

export interface AgentClosureRecord extends AgentClosureRunInput, AgentClosureFold {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly AgentClosureEvent[];
}

export interface AgentClosureListFilters {
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly capability?: AgentClosureCapability;
  readonly lane?: AgentClosureLane;
  readonly status?: AgentClosureStatus;
  readonly limit?: number;
}

export interface AgentClosureSummary {
  readonly total: number;
  readonly productionClosed: number;
  readonly incomplete: number;
  readonly byCapability: readonly Readonly<{
    capability: AgentClosureCapability;
    total: number;
    productionClosed: number;
    incomplete: number;
  }>[];
}

export interface AgentClosureRedactResult {
  readonly deletedRuns: number;
  readonly deletedEvents: number;
}

export interface AgentClosureRecordOptions {
  readonly expectedRevision?: number;
}

const SINGLETON_EVENTS = new Set<AgentClosureEvent['type']>([
  'admitted', 'execution-completed', 'proposal-persisted', 'artifact-validated', 'apply-committed',
  'readback-verified', 'no-op-completed', 'rejected', 'stale', 'rolled-back',
]);

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`agent-closure-${name}-invalid`);
  return value as number;
}

function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const applicationId = pragma(db, 'application_id');
  if (version > AGENT_CLOSURE_SCHEMA_VERSION) throw new Error('agent-closure-too-new');
  if (version === 1 && applicationId === AGENT_CLOSURE_APPLICATION_ID) {
    assertExactSchema(db, true);
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`ALTER TABLE agent_closure_event ADD COLUMN skill_attribution_json TEXT;
        PRAGMA user_version = ${AGENT_CLOSURE_SCHEMA_VERSION};`);
      assertExactSchema(db);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
    return;
  }
  if (version !== 0) {
    if (version !== AGENT_CLOSURE_SCHEMA_VERSION
      || applicationId !== AGENT_CLOSURE_APPLICATION_ID) {
      throw new Error('agent-closure-metadata-mismatch');
    }
    return;
  }
  if (applicationId !== 0) throw new Error('agent-closure-application-id-mismatch');
  const existingTables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1`).all() as Row[];
  if (existingTables.length > 0) throw new Error('agent-closure-unclaimed-schema-not-empty');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${AGENT_CLOSURE_APPLICATION_ID};
      CREATE TABLE agent_closure_run (
        operation_id TEXT PRIMARY KEY,
        contract_version TEXT NOT NULL CHECK(contract_version='agent-closure-v1'),
        run_id TEXT NOT NULL,
        parent_run_id TEXT,
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('interactive','learning','maintenance')),
        closure_kind TEXT NOT NULL CHECK(closure_kind IN ('advisory','proposal')),
        execution_class TEXT NOT NULL CHECK(execution_class IN ('production','shadow','operational-replay','fixture')),
        source_revision TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        evidence_digest TEXT,
        current_stage TEXT NOT NULL CHECK(current_stage IN ('admitted','executed','proposed','validated','applied','verified','consumed','observed')),
        status TEXT NOT NULL CHECK(status IN ('active','closed','no_op','failed','cancelled','rejected','stale','rolled_back')),
        next_required_event TEXT,
        consumed_count INTEGER NOT NULL CHECK(consumed_count >= 0),
        production_closed INTEGER NOT NULL CHECK(production_closed IN (0,1)),
        latest_reason_code TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        admitted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_closure_session ON agent_closure_run(session_id,updated_at);
      CREATE INDEX agent_closure_capability ON agent_closure_run(capability,status,updated_at);
      CREATE TABLE agent_closure_event (
        event_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES agent_closure_run(operation_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'admitted','execution-completed','proposal-persisted','artifact-validated',
          'apply-committed','readback-verified','context-consumed','effect-observed',
          'no-op-completed','failed','cancelled','rejected','stale','rolled-back'
        )),
        idempotency_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        artifact_digest TEXT,
        evidence_ref TEXT,
        source_revision TEXT,
        target_revision TEXT,
        consumer_run_id TEXT,
        context_block TEXT,
        reason_code TEXT,
        item_count INTEGER CHECK(item_count IS NULL OR item_count >= 0),
        token_count INTEGER CHECK(token_count IS NULL OR token_count >= 0),
        effect_outcome TEXT CHECK(effect_outcome IS NULL OR effect_outcome IN (
          'positive','neutral','negative','inconclusive'
        )),
        skill_attribution_json TEXT,
        UNIQUE(operation_id,sequence),
        UNIQUE(operation_id,idempotency_key)
      );
      CREATE INDEX agent_closure_event_type
        ON agent_closure_event(operation_id,event_type,sequence);
      PRAGMA user_version = ${AGENT_CLOSURE_SCHEMA_VERSION};
    `);
    assertExactSchema(db);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
}

const EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agent_closure_run: Object.freeze([
    'operation_id', 'contract_version', 'run_id', 'parent_run_id', 'session_id',
    'capability', 'lane', 'closure_kind', 'execution_class', 'source_revision',
    'policy_version', 'evidence_digest', 'current_stage', 'status',
    'next_required_event', 'consumed_count', 'production_closed', 'latest_reason_code',
    'revision', 'admitted_at', 'created_at', 'updated_at',
  ]),
  agent_closure_event: Object.freeze([
    'event_id', 'operation_id', 'sequence', 'event_type', 'idempotency_key',
    'occurred_at', 'artifact_digest', 'evidence_ref', 'source_revision',
    'target_revision', 'consumer_run_id', 'context_block', 'reason_code',
    'item_count', 'token_count', 'effect_outcome', 'skill_attribution_json',
  ]),
});

function assertExactSchema(db: DatabaseSync, legacy = false): void {
  const tables = (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Row[])
    .map((row) => String(row.name));
  if (JSON.stringify(tables) !== JSON.stringify(Object.keys(EXACT_COLUMNS).sort())) {
    throw new Error('agent-closure-schema-tables-mismatch');
  }
  for (const [table, expected] of Object.entries(EXACT_COLUMNS)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[])
      .map((row) => String(row.name));
    const required = legacy && table === 'agent_closure_event'
      ? expected.filter((column) => column !== 'skill_attribution_json') : expected;
    if (JSON.stringify(columns) !== JSON.stringify(required)) {
      throw new Error(`agent-closure-schema-columns-mismatch-${table}`);
    }
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as Row[]).length > 0) {
    throw new Error('agent-closure-foreign-key-check-failed');
  }
  const eventForeignKeys = db.prepare('PRAGMA foreign_key_list(agent_closure_event)').all() as Row[];
  if (eventForeignKeys.length !== 1
    || eventForeignKeys[0]?.table !== 'agent_closure_run'
    || eventForeignKeys[0]?.from !== 'operation_id'
    || eventForeignKeys[0]?.to !== 'operation_id'
    || String(eventForeignKeys[0]?.on_delete).toUpperCase() !== 'CASCADE') {
    throw new Error('agent-closure-foreign-key-definition-mismatch');
  }
  if ((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Row[]).length > 0) {
    throw new Error('agent-closure-schema-triggers-forbidden');
  }
}

function integer(value: unknown, label: string, min = 0, max = 1_000_000_000): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}-invalid`);
  }
  return parsed;
}

function nullableToken(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : agentClosureToken(value, label);
}

function nullableDigest(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : agentClosureDigest(value, label);
}

function parseEvent(row: Row): AgentClosureEvent {
  const type = String(row.event_type);
  if (!(AGENT_CLOSURE_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error('agent-closure-event-type-invalid');
  }
  if (row.skill_attribution_json !== null && row.skill_attribution_json !== undefined
    && (type !== 'context-consumed' || typeof row.skill_attribution_json !== 'string'
      || row.skill_attribution_json.length > 20_000)) throw new Error('agent-closure-skill-attribution-invalid');
  const base = {
    ...(row.skill_attribution_json === null || row.skill_attribution_json === undefined ? {} : {
      skillAttribution: JSON.parse(String(row.skill_attribution_json)),
    }),
    eventId: agentClosureToken(row.event_id, 'event-id'),
    sequence: integer(row.sequence, 'event-sequence', 1),
    type: type as AgentClosureEvent['type'],
    idempotencyKey: agentClosureToken(row.idempotency_key, 'idempotency-key'),
    occurredAt: agentClosureTimestamp(row.occurred_at, 'occurred-at'),
    ...(nullableDigest(row.artifact_digest, 'artifact-digest') === undefined ? {} : {
      artifactDigest: nullableDigest(row.artifact_digest, 'artifact-digest'),
    }),
    ...(nullableToken(row.evidence_ref, 'evidence-ref') === undefined ? {} : {
      evidenceRef: nullableToken(row.evidence_ref, 'evidence-ref'),
    }),
    ...(nullableToken(row.source_revision, 'event-source-revision') === undefined ? {} : {
      sourceRevision: nullableToken(row.source_revision, 'event-source-revision'),
    }),
    ...(nullableToken(row.target_revision, 'event-target-revision') === undefined ? {} : {
      targetRevision: nullableToken(row.target_revision, 'event-target-revision'),
    }),
    ...(nullableToken(row.consumer_run_id, 'consumer-run-id') === undefined ? {} : {
      consumerRunId: nullableToken(row.consumer_run_id, 'consumer-run-id'),
    }),
    ...(nullableToken(row.context_block, 'context-block') === undefined ? {} : {
      contextBlock: nullableToken(row.context_block, 'context-block'),
    }),
    ...(nullableToken(row.reason_code, 'reason-code') === undefined ? {} : {
      reasonCode: nullableToken(row.reason_code, 'reason-code'),
    }),
    ...(row.item_count === null || row.item_count === undefined ? {} : {
      itemCount: integer(row.item_count, 'item-count'),
    }),
    ...(row.token_count === null || row.token_count === undefined ? {} : {
      tokenCount: integer(row.token_count, 'token-count'),
    }),
    ...(row.effect_outcome === null || row.effect_outcome === undefined ? {} : {
      effectOutcome: String(row.effect_outcome) as AgentClosureEvent['effectOutcome'],
    }),
  };
  if (base.type === 'admitted') {
    if (base.idempotencyKey !== 'admitted' || !base.sourceRevision) {
      throw new Error('agent-closure-admission-event-invalid');
    }
    return Object.freeze(base);
  }
  const normalized = normalizeAgentClosureEvent(base as AgentClosureEventInput);
  return Object.freeze({
    eventId: base.eventId,
    sequence: base.sequence,
    ...normalized,
  });
}

function eventRows(db: DatabaseSync, operationId: string): AgentClosureEvent[] {
  return (db.prepare(
    'SELECT * FROM agent_closure_event WHERE operation_id=? ORDER BY sequence',
  ).all(operationId) as Row[]).map(parseEvent);
}

function parseRun(db: DatabaseSync, row: Row): AgentClosureRecord {
  if (row.contract_version !== AGENT_CLOSURE_CONTRACT_VERSION) {
    throw new Error('agent-closure-contract-version-mismatch');
  }
  const normalized = normalizeAgentClosureRun({
    operationId: String(row.operation_id),
    runId: String(row.run_id),
    ...(row.parent_run_id === null ? {} : { parentRunId: String(row.parent_run_id) }),
    sessionId: String(row.session_id),
    capability: String(row.capability) as AgentClosureCapability,
    lane: String(row.lane) as AgentClosureLane,
    kind: String(row.closure_kind) as AgentClosureKind,
    executionClass: String(row.execution_class) as AgentClosureExecutionClass,
    sourceRevision: String(row.source_revision),
    policyVersion: String(row.policy_version),
    ...(row.evidence_digest === null ? {} : { evidenceDigest: String(row.evidence_digest) }),
    admittedAt: String(row.admitted_at),
  });
  const events = Object.freeze(eventRows(db, normalized.operationId));
  const fold = foldAgentClosure(normalized.kind, events, normalized.executionClass);
  if (row.current_stage !== fold.stage || row.status !== fold.status
    || row.next_required_event !== fold.nextRequiredEvent
    || Number(row.consumed_count) !== fold.consumedCount
    || Number(row.production_closed) !== Number(fold.qualifiesAsProductionClosure)
    || (row.latest_reason_code === null ? undefined : String(row.latest_reason_code)) !== fold.latestReasonCode) {
    throw new Error('agent-closure-materialized-state-mismatch');
  }
  return Object.freeze({
    ...normalized,
    ...fold,
    revision: integer(row.revision, 'revision', 1),
    createdAt: agentClosureTimestamp(row.created_at, 'created-at'),
    updatedAt: agentClosureTimestamp(row.updated_at, 'updated-at'),
    events,
  });
}

function getRow(db: DatabaseSync, operationId: string): Row | undefined {
  return db.prepare('SELECT * FROM agent_closure_run WHERE operation_id=?')
    .get(operationId) as Row | undefined;
}

function listRows(db: DatabaseSync, filters: AgentClosureListFilters = {}): AgentClosureRecord[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.operationId !== undefined) {
    where.push('operation_id=?'); params.push(agentClosureToken(filters.operationId, 'operation-id'));
  }
  if (filters.sessionId !== undefined) {
    where.push('session_id=?'); params.push(agentClosureToken(filters.sessionId, 'session-id'));
  }
  if (filters.capability !== undefined) {
    if (!(AGENT_CLOSURE_CAPABILITIES as readonly string[]).includes(filters.capability)) {
      throw new Error('capability-invalid');
    }
    // P16 C1：按别名过滤必须同时命中唯一归属，避免迁移前后被拆成两个分母。
    const capabilities = agentClosureCapabilityFilter(filters.capability);
    where.push(`capability IN (${capabilities.map(() => '?').join(',')})`);
    params.push(...capabilities);
  }
  if (filters.lane !== undefined) {
    if (!['interactive', 'learning', 'maintenance'].includes(filters.lane)) throw new Error('lane-invalid');
    where.push('lane=?'); params.push(filters.lane);
  }
  if (filters.status !== undefined) {
    if (!['active', 'closed', 'no_op', 'failed', 'cancelled', 'rejected', 'stale', 'rolled_back']
      .includes(filters.status)) throw new Error('status-invalid');
    where.push('status=?'); params.push(filters.status);
  }
  const limit = filters.limit === undefined ? 500 : integer(filters.limit, 'limit', 1, 10_000);
  params.push(limit);
  return (db.prepare(`SELECT * FROM agent_closure_run${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC,operation_id DESC LIMIT ?`).all(...params) as Row[])
    .map((row) => parseRun(db, row));
}

function summaryRows(
  db: DatabaseSync,
  filters: Omit<AgentClosureListFilters, 'limit'>,
): AgentClosureSummary {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.operationId !== undefined) {
    where.push('operation_id=?'); params.push(agentClosureToken(filters.operationId, 'operation-id'));
  }
  if (filters.sessionId !== undefined) {
    where.push('session_id=?'); params.push(agentClosureToken(filters.sessionId, 'session-id'));
  }
  if (filters.capability !== undefined) {
    if (!(AGENT_CLOSURE_CAPABILITIES as readonly string[]).includes(filters.capability)) {
      throw new Error('capability-invalid');
    }
    const capabilities = agentClosureCapabilityFilter(filters.capability);
    where.push(`capability IN (${capabilities.map(() => '?').join(',')})`);
    params.push(...capabilities);
  }
  if (filters.lane !== undefined) {
    if (!['interactive', 'learning', 'maintenance'].includes(filters.lane)) throw new Error('lane-invalid');
    where.push('lane=?'); params.push(filters.lane);
  }
  if (filters.status !== undefined) {
    if (!['active', 'closed', 'no_op', 'failed', 'cancelled', 'rejected', 'stale', 'rolled_back']
      .includes(filters.status)) throw new Error('status-invalid');
    where.push('status=?'); params.push(filters.status);
  }
  const rows = db.prepare(`SELECT capability,COUNT(*) total,
      SUM(production_closed) production_closed,
      SUM(CASE WHEN production_closed=0
        AND status NOT IN ('no_op','rejected','stale','cancelled','rolled_back') THEN 1 ELSE 0 END) incomplete
    FROM agent_closure_run${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    GROUP BY capability ORDER BY capability`).all(...params) as Row[];
  const grouped = new Map<AgentClosureCapability, Readonly<{
    total: number;
    productionClosed: number;
    incomplete: number;
  }>>();
  for (const row of rows) {
    const stored = String(row.capability);
    if (!(AGENT_CLOSURE_CAPABILITIES as readonly string[]).includes(stored)) {
      throw new Error('capability-invalid');
    }
    // P16 C1：按唯一归属汇总，别名行与规范行进入同一个分母（不复制、不双计）。
    const capability = canonicalAgentClosureCapability(stored);
    const previous = grouped.get(capability);
    grouped.set(capability, Object.freeze({
      total: (previous?.total ?? 0) + integer(row.total, 'summary-total'),
      productionClosed: (previous?.productionClosed ?? 0)
        + integer(row.production_closed ?? 0, 'summary-production-closed'),
      incomplete: (previous?.incomplete ?? 0) + integer(row.incomplete ?? 0, 'summary-incomplete'),
    }));
  }
  // Zero rows are deliberate coverage signals: a capability with no
  // instrumentation/evidence must not disappear from the report denominator.
  // Legacy aliases are folded into their unique owner, so the domain never
  // contains both an alias and its canonical capability.
  const capabilityDomain = filters.capability === undefined
    ? AGENT_CLOSURE_CAPABILITIES.filter((capability) => (
      canonicalAgentClosureCapability(capability) === capability))
    : [canonicalAgentClosureCapability(filters.capability)] as const;
  const byCapability = capabilityDomain.map((capability) => Object.freeze({
    capability,
    total: grouped.get(capability)?.total ?? 0,
    productionClosed: grouped.get(capability)?.productionClosed ?? 0,
    incomplete: grouped.get(capability)?.incomplete ?? 0,
  }));
  return Object.freeze({
    total: byCapability.reduce((sum, row) => sum + row.total, 0),
    productionClosed: byCapability.reduce((sum, row) => sum + row.productionClosed, 0),
    incomplete: byCapability.reduce((sum, row) => sum + row.incomplete, 0),
    byCapability: Object.freeze(byCapability),
  });
}

/** Strictly read-only analytics entry: no creation, migration, WAL or repair. */
export function readAgentClosureFile(
  file: string,
  filters: AgentClosureListFilters = {},
): readonly AgentClosureRecord[] {
  const path = resolve(file);
  if (!existsSync(path)) return Object.freeze([]);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agent-closure-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN;');
    const version = pragma(db, 'user_version');
    if (pragma(db, 'application_id') !== AGENT_CLOSURE_APPLICATION_ID
      || (version !== 1 && version !== AGENT_CLOSURE_SCHEMA_VERSION)) {
      throw new Error('agent-closure-metadata-mismatch');
    }
    assertExactSchema(db, version === 1);
    return Object.freeze(listRows(db, filters));
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK;');
    db.close();
  }
}

/** Stable, bounded original effect-event pages; never creates or repairs a Closure store. */
export function readAgentClosureEffectPage(file: string, input: {
  readonly sessionId?: string; readonly cursor?: number; readonly limit?: number;
} = {}): Readonly<{ entries: readonly Readonly<{ cursor: number; eventId: string; record: AgentClosureRecord }>[];
    attempted: number; nextCursor: number; hasMore: boolean }> | null {
  const cursor = input.cursor ?? 0, limit = input.limit ?? 8;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error('agent-closure-effect-page-invalid');
  const session = input.sessionId === undefined ? null : agentClosureToken(input.sessionId, 'session-id');
  const path = resolve(file);
  if (!existsSync(path)) return null;
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('agent-closure-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN;');
    const version = pragma(db, 'user_version');
    if (pragma(db, 'application_id') !== AGENT_CLOSURE_APPLICATION_ID
      || (version !== 1 && version !== AGENT_CLOSURE_SCHEMA_VERSION)) throw new Error('agent-closure-metadata-mismatch');
    assertExactSchema(db, version === 1);
    const sql = `SELECT e.rowid AS cursor,e.event_id,e.operation_id FROM agent_closure_event e
      JOIN agent_closure_run r ON r.operation_id=e.operation_id
      WHERE e.event_type='effect-observed' AND e.rowid>?${session === null ? '' : ' AND r.session_id=?'}
      ORDER BY e.rowid LIMIT ?`;
    const rows = db.prepare(sql).all(...(session === null ? [cursor, limit + 1] : [cursor, session, limit + 1])) as Row[];
    let nextCursor = cursor;
    const entries = rows.slice(0, limit).map((row) => {
      const position = integer(row.cursor, 'cursor', 1);
      if (position <= nextCursor) throw new Error('agent-closure-effect-cursor-invalid');
      nextCursor = position;
      const operationId = agentClosureToken(row.operation_id, 'operation-id');
      const eventId = agentClosureToken(row.event_id, 'event-id');
      const run = getRow(db, operationId);
      if (!run) throw new Error('agent-closure-effect-run-missing');
      const record = parseRun(db, run);
      if (session !== null && record.sessionId !== session
        || !record.events.some(event => event.eventId === eventId && event.type === 'effect-observed'))
        throw new Error('agent-closure-effect-event-mismatch');
      return Object.freeze({ cursor: position, eventId, record });
    });
    db.exec('ROLLBACK;');
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error('agent-closure-file-drift');
    return Object.freeze({ entries: Object.freeze(entries), attempted: entries.length,
      nextCursor, hasMore: rows.length > limit });
  } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

export class AgentClosureStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #randomId: () => string;
  #closed = false;

  constructor(options: {
    dataDir: string;
    busyTimeoutMs?: number;
    now?: () => string;
    randomId?: () => string;
  }) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('agent-closure-data-dir-invalid');
    const path = join(dataDir, AGENT_CLOSURE_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('agent-closure-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5_000};`);
      initialize(this.#db);
      assertExactSchema(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL follows the private data dir. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
  }

  begin(input: Omit<AgentClosureRunInput, 'admittedAt'> & { readonly admittedAt?: string }): AgentClosureRecord {
    this.#assertOpen();
    const admittedAt = agentClosureTimestamp(input.admittedAt ?? this.#now(), 'admitted-at');
    const normalized = normalizeAgentClosureRun({ ...input, admittedAt });
    const existing = getRow(this.#db, normalized.operationId);
    if (existing) {
      const current = parseRun(this.#db, existing);
      const identity = (value: AgentClosureRunInput) => ({
        operationId: value.operationId,
        runId: value.runId,
        ...(value.parentRunId === undefined ? {} : { parentRunId: value.parentRunId }),
        sessionId: value.sessionId,
        // P16 C1：capability 别名（branchIndex → arc）视为同一归属，历史 run 重新
        // 观察不会因为归属迁移被误判冲突；存量行保持原值，不改写历史证据。
        capability: canonicalAgentClosureCapability(value.capability),
        lane: value.lane,
        kind: value.kind,
        executionClass: value.executionClass,
        sourceRevision: value.sourceRevision,
        policyVersion: value.policyVersion,
        ...(value.evidenceDigest === undefined ? {} : { evidenceDigest: value.evidenceDigest }),
      });
      if (JSON.stringify(identity(current)) !== JSON.stringify(identity(normalized))) {
        throw new Error('agent-closure-operation-conflict');
      }
      return current;
    }
    const admittedEvent: AgentClosureEvent = Object.freeze({
      eventId: this.#newEventId(), sequence: 1, type: 'admitted',
      idempotencyKey: 'admitted', occurredAt: normalized.admittedAt,
      sourceRevision: normalized.sourceRevision,
      ...(normalized.evidenceDigest ? { artifactDigest: normalized.evidenceDigest } : {}),
    });
    const fold = foldAgentClosure(normalized.kind, [admittedEvent], normalized.executionClass);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      this.#db.prepare(`INSERT INTO agent_closure_run(
        operation_id,contract_version,run_id,parent_run_id,session_id,capability,lane,
        closure_kind,execution_class,source_revision,policy_version,evidence_digest,
        current_stage,status,next_required_event,consumed_count,production_closed,
        latest_reason_code,revision,admitted_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        normalized.operationId, AGENT_CLOSURE_CONTRACT_VERSION, normalized.runId,
        normalized.parentRunId ?? null, normalized.sessionId, normalized.capability,
        normalized.lane, normalized.kind, normalized.executionClass,
        normalized.sourceRevision, normalized.policyVersion, normalized.evidenceDigest ?? null,
        fold.stage, fold.status, fold.nextRequiredEvent, fold.consumedCount,
        Number(fold.qualifiesAsProductionClosure), fold.latestReasonCode ?? null,
        normalized.admittedAt, normalized.admittedAt, normalized.admittedAt,
      );
      this.#insertEvent(normalized.operationId, admittedEvent);
      this.#db.exec('COMMIT;');
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
    return this.get(normalized.operationId)!;
  }

  record(
    operationIdValue: string,
    eventValue: AgentClosureEventInput,
    options: AgentClosureRecordOptions = {},
  ): AgentClosureRecord {
    this.#assertOpen();
    const operationId = agentClosureToken(operationIdValue, 'operation-id');
    const event = normalizeAgentClosureEvent(eventValue);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = getRow(this.#db, operationId);
      if (!row) throw new Error('agent-closure-operation-not-found');
      const replay = this.#db.prepare(
        'SELECT * FROM agent_closure_event WHERE operation_id=? AND idempotency_key=?',
      ).get(operationId, event.idempotencyKey) as Row | undefined;
      if (replay) {
        const existing = parseEvent(replay);
        if (!this.#sameEventIntent(existing, event)) throw new Error('agent-closure-idempotency-conflict');
        this.#db.exec('COMMIT;');
        return parseRun(this.#db, row);
      }
      if (options.expectedRevision !== undefined
        && integer(options.expectedRevision, 'expected-revision', 1) !== Number(row.revision)) {
        throw new Error('agent-closure-revision-conflict');
      }
      if (event.sourceRevision !== undefined && event.sourceRevision !== String(row.source_revision)) {
        throw new Error('agent-closure-source-revision-mismatch');
      }
      if (['no_op', 'failed', 'rejected', 'stale', 'cancelled', 'rolled_back']
        .includes(String(row.status))) {
        throw new Error('agent-closure-terminal');
      }
      if (String(row.status) === 'closed'
        && !['context-consumed', 'effect-observed', 'rolled-back'].includes(event.type)) {
        throw new Error('agent-closure-terminal');
      }
      if (SINGLETON_EVENTS.has(event.type)) {
        const duplicate = this.#db.prepare(
          'SELECT * FROM agent_closure_event WHERE operation_id=? AND event_type=? LIMIT 1',
        ).get(operationId, event.type) as Row | undefined;
        if (duplicate) {
          if (!this.#sameEventIntent(parseEvent(duplicate), event)) {
            throw new Error('agent-closure-milestone-conflict');
          }
          this.#db.exec('COMMIT;');
          return parseRun(this.#db, row);
        }
      }
      const sequenceRow = this.#db.prepare(
        'SELECT COALESCE(MAX(sequence),0) sequence FROM agent_closure_event WHERE operation_id=?',
      ).get(operationId) as Row;
      const persisted: AgentClosureEvent = Object.freeze({
        ...event,
        eventId: this.#newEventId(),
        sequence: integer(sequenceRow.sequence, 'event-sequence') + 1,
      });
      this.#insertEvent(operationId, persisted);
      const events = eventRows(this.#db, operationId);
      const kind = String(row.closure_kind) as AgentClosureKind;
      const executionClass = String(row.execution_class) as AgentClosureExecutionClass;
      const fold = foldAgentClosure(kind, events, executionClass);
      const updatedAt = agentClosureTimestamp(this.#now(), 'updated-at');
      this.#db.prepare(`UPDATE agent_closure_run SET
        current_stage=?,status=?,next_required_event=?,consumed_count=?,production_closed=?,
        latest_reason_code=?,revision=revision+1,updated_at=? WHERE operation_id=?`).run(
        fold.stage, fold.status, fold.nextRequiredEvent, fold.consumedCount,
        Number(fold.qualifiesAsProductionClosure), fold.latestReasonCode ?? null,
        updatedAt, operationId,
      );
      this.#db.exec('COMMIT;');
      return this.get(operationId)!;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  get(operationIdValue: string): AgentClosureRecord | undefined {
    this.#assertOpen();
    const operationId = agentClosureToken(operationIdValue, 'operation-id');
    const row = getRow(this.#db, operationId);
    return row ? parseRun(this.#db, row) : undefined;
  }

  list(filters: AgentClosureListFilters = {}): readonly AgentClosureRecord[] {
    this.#assertOpen();
    return Object.freeze(listRows(this.#db, filters));
  }

  /** Exact run source; filter in SQL before the bound so unrelated newer rows cannot hide it. */
  listContextForRun(sessionIdValue: string, runIdValue: string): readonly AgentClosureRecord[] {
    this.#assertOpen();
    const sessionId = agentClosureToken(sessionIdValue, 'session-id');
    const runId = agentClosureToken(runIdValue, 'run-id');
    const read = () => {
      const rows = this.#db.prepare(`SELECT * FROM agent_closure_run
        WHERE session_id=? AND run_id=? AND capability='context.compiler' AND lane='interactive'
        ORDER BY operation_id LIMIT 257`).all(sessionId, runId) as Row[];
      if (rows.length > 256) throw new Error('agent-closure-run-limit');
      return Object.freeze(rows.map(row => parseRun(this.#db, row)));
    };
    if (this.#db.isTransaction) return read();
    this.#db.exec('BEGIN');
    try { const result = read(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }

  /** Only original background jobs whose persisted parent is this exact Session run. */
  listMaintenanceForParentRun(sessionIdValue: string, parentRunIdValue: string): readonly AgentClosureRecord[] {
    this.#assertOpen();
    const sessionId = agentClosureToken(sessionIdValue, 'session-id');
    const parentRunId = agentClosureToken(parentRunIdValue, 'parent-run-id');
    const read = () => {
      const rows = this.#db.prepare(`SELECT * FROM agent_closure_run
        WHERE session_id=? AND parent_run_id=? AND lane='maintenance'
        ORDER BY operation_id LIMIT 257`).all(sessionId, parentRunId) as Row[];
      if (rows.length > 256) throw new Error('agent-closure-run-limit');
      return Object.freeze(rows.map(row => parseRun(this.#db, row)));
    };
    if (this.#db.isTransaction) return read();
    this.#db.exec('BEGIN');
    try { const result = read(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }

  /** Consumption belongs to the consumer run, even when its producer is older. */
  listLearningForConsumerRun(sessionIdValue: string, runIdValue: string): readonly AgentClosureRecord[] {
    this.#assertOpen();
    const sessionId = agentClosureToken(sessionIdValue, 'session-id');
    const runId = agentClosureToken(runIdValue, 'run-id');
    const read = () => {
      const rows = this.#db.prepare(`SELECT r.* FROM agent_closure_run r
        WHERE r.session_id=? AND r.lane='learning' AND r.capability IN ('learning.preference','learning.branchPreference')
        AND EXISTS (SELECT 1 FROM agent_closure_event e WHERE e.operation_id=r.operation_id
          AND e.event_type='context-consumed' AND e.consumer_run_id=?)
        ORDER BY r.operation_id LIMIT 257`).all(sessionId, runId) as Row[];
      if (rows.length > 256) throw new Error('agent-closure-run-limit');
      return Object.freeze(rows.map(row => parseRun(this.#db, row)));
    };
    if (this.#db.isTransaction) return read();
    this.#db.exec('BEGIN');
    try { const result = read(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }

  summary(filters: Omit<AgentClosureListFilters, 'limit'> = {}): AgentClosureSummary {
    this.#assertOpen();
    return summaryRows(this.#db, filters);
  }

  redactSession(sessionIdValue: string): AgentClosureRedactResult {
    this.#assertOpen();
    const sessionId = agentClosureToken(sessionIdValue, 'session-id');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const eventRow = this.#db.prepare(`SELECT COUNT(*) count FROM agent_closure_event
        WHERE operation_id IN (SELECT operation_id FROM agent_closure_run WHERE session_id=?)`)
        .get(sessionId) as Row;
      const expectedEvents = integer(eventRow.count, 'deleted-events');
      const expectedRuns = integer((this.#db.prepare(
        'SELECT COUNT(*) count FROM agent_closure_run WHERE session_id=?',
      ).get(sessionId) as Row).count, 'deleted-runs');
      const deletedEvents = Number(this.#db.prepare(`DELETE FROM agent_closure_event
        WHERE operation_id IN (SELECT operation_id FROM agent_closure_run WHERE session_id=?)`)
        .run(sessionId).changes);
      const deletedRuns = Number(this.#db.prepare(
        'DELETE FROM agent_closure_run WHERE session_id=?',
      ).run(sessionId).changes);
      if (deletedEvents !== expectedEvents || deletedRuns !== expectedRuns
        || Number((this.#db.prepare(
          'SELECT COUNT(*) count FROM agent_closure_run WHERE session_id=?',
        ).get(sessionId) as Row).count) !== 0) {
        throw new Error('agent-closure-redaction-postcondition-failed');
      }
      this.#db.exec('COMMIT;');
      return Object.freeze({ deletedRuns, deletedEvents });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #insertEvent(operationId: string, event: AgentClosureEvent): void {
    this.#db.prepare(`INSERT INTO agent_closure_event(
      event_id,operation_id,sequence,event_type,idempotency_key,occurred_at,
      artifact_digest,evidence_ref,source_revision,target_revision,consumer_run_id,context_block,
      reason_code,item_count,token_count,effect_outcome,skill_attribution_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.eventId, operationId, event.sequence, event.type, event.idempotencyKey,
      event.occurredAt, event.artifactDigest ?? null, event.evidenceRef ?? null,
      event.sourceRevision ?? null,
      event.targetRevision ?? null, event.consumerRunId ?? null, event.contextBlock ?? null,
      event.reasonCode ?? null, event.itemCount ?? null, event.tokenCount ?? null,
      event.effectOutcome ?? null,
      event.skillAttribution === undefined ? null : JSON.stringify(event.skillAttribution),
    );
  }

  #newEventId(): string {
    const compact = this.#randomId().replaceAll('-', '').toLowerCase();
    if (!/^[a-f0-9]{32}$/u.test(compact)) throw new Error('agent-closure-random-source-invalid');
    return `cevt_${compact}`;
  }

  #sameEventIntent(
    existing: AgentClosureEvent,
    event: AgentClosureEventInput,
  ): boolean {
    return existing.type === event.type
      && existing.artifactDigest === event.artifactDigest
      && existing.evidenceRef === event.evidenceRef
      && existing.sourceRevision === event.sourceRevision
      && existing.targetRevision === event.targetRevision
      && existing.consumerRunId === event.consumerRunId
      && existing.contextBlock === event.contextBlock
      && existing.reasonCode === event.reasonCode
      && existing.itemCount === event.itemCount
      && existing.tokenCount === event.tokenCount
      && existing.effectOutcome === event.effectOutcome
      && JSON.stringify(existing.skillAttribution) === JSON.stringify(event.skillAttribution);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('agent-closure-closed');
  }
}
