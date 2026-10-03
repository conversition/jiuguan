import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';

export const SESSION_DELETION_JOURNAL_DB_FILE = 'session-deletions.sqlite';
export const SESSION_DELETION_JOURNAL_SCHEMA_VERSION = 1;
export const SESSION_DELETION_JOURNAL_APPLICATION_ID = 0x4a475344; // JGSD
export const SESSION_DELETION_PRIVACY_DIRECTORY_VERSION = 'privacy-v1';

export const SESSION_DELETION_PHASES = Object.freeze([
  'prepared', 'privacy-committed', 'cleanup-pending', 'complete',
] as const);
export const SESSION_DELETION_STEP_STATUSES = Object.freeze([
  'pending', 'running', 'succeeded', 'failed',
] as const);

export type SessionDeletionPhase = (typeof SESSION_DELETION_PHASES)[number];
export type SessionDeletionStepStatus = (typeof SESSION_DELETION_STEP_STATUSES)[number];

export interface SessionDeletionIdentity {
  readonly sessionId: string;
  readonly operationId: string;
  readonly sourceRevision: string;
}
export interface SessionDeletionJournalRow extends SessionDeletionIdentity {
  readonly phase: SessionDeletionPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly privacyCommittedAt: string | null;
  readonly cleanupPendingAt: string | null;
  readonly completedAt: string | null;
}
export interface SessionDeletionStepRow {
  readonly sessionId: string;
  readonly stepId: string;
  readonly status: SessionDeletionStepStatus;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SessionDeletionStepEventRow {
  readonly sessionId: string;
  readonly stepId: string;
  readonly eventSequence: number;
  readonly status: SessionDeletionStepStatus;
  readonly attemptCount: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

export class SessionDeletionIdentityConflictError extends Error {
  readonly name = 'SessionDeletionIdentityConflictError';
  constructor() { super('session-deletion-identity-conflict'); }
}
export class SessionDeletionPhaseConflictError extends Error {
  readonly name = 'SessionDeletionPhaseConflictError';
  constructor(message = 'session-deletion-phase-conflict') { super(message); }
}
export class SessionDeletionStepConflictError extends Error {
  readonly name = 'SessionDeletionStepConflictError';
  constructor(message = 'session-deletion-step-conflict') { super(message); }
}

type SqlRow = Record<string, unknown>;
const REVISION_RE = /^sha256:[a-f0-9]{64}$/u;
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/u;
const PHASE_RANK = new Map<SessionDeletionPhase, number>(
  SESSION_DELETION_PHASES.map((value, index) => [value, index]),
);
const EXACT_COLUMNS = Object.freeze({
  session_deletion: Object.freeze([
    'session_id', 'operation_id', 'source_revision', 'phase', 'created_at', 'updated_at',
    'privacy_committed_at', 'cleanup_pending_at', 'completed_at',
  ]),
  session_deletion_step: Object.freeze([
    'session_id', 'step_id', 'status', 'attempt_count', 'last_error_code', 'created_at', 'updated_at',
  ]),
  session_deletion_step_event: Object.freeze([
    'session_id', 'step_id', 'event_sequence', 'status', 'attempt_count', 'error_code', 'created_at',
  ]),
});
const EXACT_INDEXES = Object.freeze(['session_deletion_pending']);
const EXACT_TRIGGERS = Object.freeze([
  'session_deletion_identity_immutable',
  'session_deletion_no_delete',
  'session_deletion_phase_monotonic',
  'session_deletion_step_event_no_delete',
  'session_deletion_step_event_no_update',
  'session_deletion_step_no_delete',
]);

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`session-deletion-journal-${name}-invalid`);
  return Number(value);
}
function userTables(db: DatabaseSync): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}
function inspectExactSchema(db: DatabaseSync): void {
  if (userTables(db).join(',') !== Object.keys(EXACT_COLUMNS).sort().join(',')) {
    throw new Error('session-deletion-journal-schema-tables-mismatch');
  }
  for (const [table, expected] of Object.entries(EXACT_COLUMNS)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name);
    if (actual.join(',') !== expected.join(',')) {
      throw new Error('session-deletion-journal-schema-columns-mismatch');
    }
  }
  const indexes = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (indexes.join(',') !== EXACT_INDEXES.join(',')) {
    throw new Error('session-deletion-journal-schema-indexes-mismatch');
  }
  const triggers = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (triggers.join(',') !== EXACT_TRIGGERS.join(',')) {
    throw new Error('session-deletion-journal-schema-triggers-mismatch');
  }
  const stepForeignKeys = (db.prepare(
    'PRAGMA foreign_key_list(session_deletion_step)',
  ).all() as Array<{ table: string; from: string; to: string; on_delete: string }>);
  if (stepForeignKeys.length !== 1 || stepForeignKeys[0]?.table !== 'session_deletion'
    || stepForeignKeys[0]?.from !== 'session_id' || stepForeignKeys[0]?.to !== 'session_id'
    || stepForeignKeys[0]?.on_delete !== 'RESTRICT') {
    throw new Error('session-deletion-journal-schema-foreign-keys-mismatch');
  }
  const eventForeignKeys = (db.prepare(
    'PRAGMA foreign_key_list(session_deletion_step_event)',
  ).all() as Array<{ table: string; from: string; to: string; on_delete: string }>);
  const eventMappings = eventForeignKeys
    .map((row) => [row.table, row.from, row.to, row.on_delete].join(':'))
    .sort();
  if (eventMappings.join(',') !== [
    'session_deletion_step:session_id:session_id:RESTRICT',
    'session_deletion_step:step_id:step_id:RESTRICT',
  ].join(',')) {
    throw new Error('session-deletion-journal-schema-foreign-keys-mismatch');
  }
}
function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const applicationId = pragma(db, 'application_id');
  if (version > SESSION_DELETION_JOURNAL_SCHEMA_VERSION) {
    throw new Error('session-deletion-journal-too-new');
  }
  if (version !== 0) {
    if (version !== SESSION_DELETION_JOURNAL_SCHEMA_VERSION
      || applicationId !== SESSION_DELETION_JOURNAL_APPLICATION_ID) {
      throw new Error('session-deletion-journal-metadata-mismatch');
    }
    inspectExactSchema(db);
    return;
  }
  if (applicationId !== 0) throw new Error('session-deletion-journal-application-id-mismatch');
  if (userTables(db).length > 0) throw new Error('session-deletion-journal-uninitialized-not-empty');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${SESSION_DELETION_JOURNAL_APPLICATION_ID};
      CREATE TABLE session_deletion (
        session_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        source_revision TEXT NOT NULL CHECK(length(source_revision) = 71),
        phase TEXT NOT NULL CHECK(phase IN ('prepared','privacy-committed','cleanup-pending','complete')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        privacy_committed_at TEXT,
        cleanup_pending_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX session_deletion_pending ON session_deletion(phase,created_at,session_id);
      CREATE TABLE session_deletion_step (
        session_id TEXT NOT NULL REFERENCES session_deletion(session_id) ON DELETE RESTRICT,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,step_id)
      );
      CREATE TABLE session_deletion_step_event (
        session_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK(event_sequence >= 1),
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        error_code TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,step_id,event_sequence),
        FOREIGN KEY(session_id,step_id)
          REFERENCES session_deletion_step(session_id,step_id) ON DELETE RESTRICT
      );
      CREATE TRIGGER session_deletion_no_delete
      BEFORE DELETE ON session_deletion
      BEGIN SELECT RAISE(ABORT, 'session deletion fence is immutable'); END;
      CREATE TRIGGER session_deletion_identity_immutable
      BEFORE UPDATE OF session_id,operation_id,source_revision,created_at ON session_deletion
      BEGIN SELECT RAISE(ABORT, 'session deletion identity is immutable'); END;
      CREATE TRIGGER session_deletion_phase_monotonic
      BEFORE UPDATE OF phase ON session_deletion
      WHEN CASE OLD.phase WHEN 'prepared' THEN 0 WHEN 'privacy-committed' THEN 1
        WHEN 'cleanup-pending' THEN 2 ELSE 3 END
        >= CASE NEW.phase WHEN 'prepared' THEN 0 WHEN 'privacy-committed' THEN 1
        WHEN 'cleanup-pending' THEN 2 ELSE 3 END
        OR CASE NEW.phase WHEN 'prepared' THEN 0 WHEN 'privacy-committed' THEN 1
        WHEN 'cleanup-pending' THEN 2 ELSE 3 END
        > CASE OLD.phase WHEN 'prepared' THEN 0 WHEN 'privacy-committed' THEN 1
        WHEN 'cleanup-pending' THEN 2 ELSE 3 END + 1
      BEGIN SELECT RAISE(ABORT, 'session deletion phase is not monotonic'); END;
      CREATE TRIGGER session_deletion_step_no_delete
      BEFORE DELETE ON session_deletion_step
      BEGIN SELECT RAISE(ABORT, 'session deletion step is immutable'); END;
      CREATE TRIGGER session_deletion_step_event_no_update
      BEFORE UPDATE ON session_deletion_step_event
      BEGIN SELECT RAISE(ABORT, 'session deletion step event is immutable'); END;
      CREATE TRIGGER session_deletion_step_event_no_delete
      BEFORE DELETE ON session_deletion_step_event
      BEGIN SELECT RAISE(ABORT, 'session deletion step event is immutable'); END;
      PRAGMA user_version = ${SESSION_DELETION_JOURNAL_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
  inspectExactSchema(db);
}

function deletionIdentity(input: SessionDeletionIdentity): SessionDeletionIdentity {
  if (!isSafeOpaqueId(input.sessionId, 160)) throw new Error('session-deletion-session-id-invalid');
  if (!isSafeOpaqueId(input.operationId, 200)) throw new Error('session-deletion-operation-id-invalid');
  if (typeof input.sourceRevision !== 'string' || !REVISION_RE.test(input.sourceRevision)) {
    throw new Error('session-deletion-source-revision-invalid');
  }
  return Object.freeze({
    sessionId: input.sessionId,
    operationId: input.operationId,
    sourceRevision: input.sourceRevision,
  });
}
function safeStepId(value: unknown): string {
  if (!isSafeOpaqueId(value, 120)) throw new Error('session-deletion-step-id-invalid');
  return value;
}
function safeErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !ERROR_CODE_RE.test(value)) {
    throw new Error('session-deletion-error-code-invalid');
  }
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error('session-deletion-timestamp-invalid');
  }
  return value;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field}-invalid`);
  return Number(value);
}
function parsePhase(value: unknown): SessionDeletionPhase {
  if (!SESSION_DELETION_PHASES.includes(value as SessionDeletionPhase)) {
    throw new Error('session-deletion-phase-invalid');
  }
  return value as SessionDeletionPhase;
}
function parseStepStatus(value: unknown): SessionDeletionStepStatus {
  if (!SESSION_DELETION_STEP_STATUSES.includes(value as SessionDeletionStepStatus)) {
    throw new Error('session-deletion-step-status-invalid');
  }
  return value as SessionDeletionStepStatus;
}
function safeSessionId(value: unknown): string {
  if (!isSafeOpaqueId(value, 160)) throw new Error('session-deletion-session-id-invalid');
  return value;
}
function parseDeletionRow(row: SqlRow): SessionDeletionJournalRow {
  const identity = deletionIdentity({
    sessionId: String(row.session_id),
    operationId: String(row.operation_id),
    sourceRevision: String(row.source_revision),
  });
  const result = {
    ...identity,
    phase: parsePhase(row.phase),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    privacyCommittedAt: nullableTimestamp(row.privacy_committed_at),
    cleanupPendingAt: nullableTimestamp(row.cleanup_pending_at),
    completedAt: nullableTimestamp(row.completed_at),
  } satisfies SessionDeletionJournalRow;
  const rank = PHASE_RANK.get(result.phase)!;
  if ((rank >= 1) !== (result.privacyCommittedAt !== null)
    || (rank >= 2) !== (result.cleanupPendingAt !== null)
    || (rank >= 3) !== (result.completedAt !== null)) {
    throw new Error('session-deletion-journal-phase-timestamps-invalid');
  }
  return Object.freeze(result);
}
function parseStepRow(row: SqlRow): SessionDeletionStepRow {
  return Object.freeze({
    sessionId: safeSessionId(row.session_id),
    stepId: safeStepId(row.step_id),
    status: parseStepStatus(row.status),
    attemptCount: nonNegativeInteger(row.attempt_count, 'session-deletion-step-attempt-count'),
    lastErrorCode: row.last_error_code === null ? null : safeErrorCode(row.last_error_code),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}
function parseStepEventRow(row: SqlRow): SessionDeletionStepEventRow {
  return Object.freeze({
    sessionId: safeSessionId(row.session_id),
    stepId: safeStepId(row.step_id),
    eventSequence: nonNegativeInteger(row.event_sequence, 'session-deletion-step-event-sequence'),
    status: parseStepStatus(row.status),
    attemptCount: nonNegativeInteger(row.attempt_count, 'session-deletion-step-attempt-count'),
    errorCode: row.error_code === null ? null : safeErrorCode(row.error_code),
    createdAt: timestamp(row.created_at),
  });
}

export function sessionDeletionPrivacyDirectory(dataDirValue: string): string {
  if (typeof dataDirValue !== 'string' || dataDirValue.trim() === '') {
    throw new Error('session-deletion-data-dir-invalid');
  }
  const dataDir = resolve(dataDirValue);
  if (dataDir === parse(dataDir).root) throw new Error('session-deletion-data-dir-invalid');
  const name = basename(dataDir);
  if (!name || name === '.' || name === '..') throw new Error('session-deletion-data-dir-invalid');
  return join(dirname(dataDir), `.${name}.${SESSION_DELETION_PRIVACY_DIRECTORY_VERSION}`);
}
export function sessionDeletionJournalPath(dataDir: string): string {
  return join(sessionDeletionPrivacyDirectory(dataDir), SESSION_DELETION_JOURNAL_DB_FILE);
}

export class SessionDeletionJournal {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  #closed = false;

  constructor(options: { readonly dataDir: string; readonly now?: () => string; readonly busyTimeoutMs?: number }) {
    const privacyDirectory = sessionDeletionPrivacyDirectory(options.dataDir);
    mkdirSync(privacyDirectory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(privacyDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('session-deletion-privacy-directory-invalid');
    }
    const path = join(privacyDirectory, SESSION_DELETION_JOURNAL_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('session-deletion-journal-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
      if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
        throw new Error('session-deletion-busy-timeout-invalid');
      }
      this.#db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
      initialize(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL inherited from the private directory. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  prepare(input: SessionDeletionIdentity): Readonly<{ row: SessionDeletionJournalRow; replayed: boolean }> {
    this.#assertOpen();
    const identity = deletionIdentity(input);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#findByEitherIdentity(identity.sessionId, identity.operationId);
      if (existing) {
        this.#assertIdentity(existing, identity);
        this.#db.exec('COMMIT;');
        return Object.freeze({ row: existing, replayed: true });
      }
      const createdAt = timestamp(this.#now());
      this.#db.prepare(`
        INSERT INTO session_deletion(
          session_id,operation_id,source_revision,phase,created_at,updated_at,
          privacy_committed_at,cleanup_pending_at,completed_at
        ) VALUES(?,?,?,'prepared',?,?,NULL,NULL,NULL)
      `).run(identity.sessionId, identity.operationId, identity.sourceRevision, createdAt, createdAt);
      const row = this.#requireIdentity(identity);
      this.#db.exec('COMMIT;');
      return Object.freeze({ row, replayed: false });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  advance(input: SessionDeletionIdentity & { readonly phase: Exclude<SessionDeletionPhase, 'prepared'> }):
  Readonly<{ row: SessionDeletionJournalRow; replayed: boolean }> {
    this.#assertOpen();
    const identity = deletionIdentity(input);
    const target = parsePhase(input.phase);
    if (target === 'prepared') throw new SessionDeletionPhaseConflictError();
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#requireIdentity(identity);
      const currentRank = PHASE_RANK.get(existing.phase)!;
      const targetRank = PHASE_RANK.get(target)!;
      if (targetRank <= currentRank) {
        this.#db.exec('COMMIT;');
        return Object.freeze({ row: existing, replayed: true });
      }
      if (targetRank !== currentRank + 1) throw new SessionDeletionPhaseConflictError();
      if (target === 'complete') {
        const outstanding = this.#db.prepare(
          "SELECT COUNT(*) AS count FROM session_deletion_step WHERE session_id=? AND status<>'succeeded'",
        ).get(identity.sessionId) as { count: number | bigint };
        if (Number(outstanding.count) > 0) {
          throw new SessionDeletionPhaseConflictError('session-deletion-steps-incomplete');
        }
      }
      const changedAt = timestamp(this.#now());
      const phaseColumn = target === 'privacy-committed'
        ? 'privacy_committed_at'
        : target === 'cleanup-pending' ? 'cleanup_pending_at' : 'completed_at';
      this.#db.prepare(
        `UPDATE session_deletion SET phase=?,updated_at=?,${phaseColumn}=? WHERE session_id=? AND phase=?`,
      ).run(target, changedAt, changedAt, identity.sessionId, existing.phase);
      const row = this.#requireIdentity(identity);
      this.#db.exec('COMMIT;');
      return Object.freeze({ row, replayed: false });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  ensureStep(input: SessionDeletionIdentity & { readonly stepId: string }):
  Readonly<{ row: SessionDeletionStepRow; replayed: boolean }> {
    this.#assertOpen();
    const identity = deletionIdentity(input);
    const id = safeStepId(input.stepId);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const deletion = this.#requireIdentity(identity);
      const existing = this.#step(identity.sessionId, id);
      if (existing) {
        this.#db.exec('COMMIT;');
        return Object.freeze({ row: existing, replayed: true });
      }
      if (deletion.phase === 'complete') throw new SessionDeletionStepConflictError();
      const createdAt = timestamp(this.#now());
      this.#db.prepare(`
        INSERT INTO session_deletion_step(
          session_id,step_id,status,attempt_count,last_error_code,created_at,updated_at
        ) VALUES(?,?,'pending',0,NULL,?,?)
      `).run(identity.sessionId, id, createdAt, createdAt);
      this.#appendStepEvent(identity.sessionId, id, 'pending', 0, null, createdAt);
      const row = this.#step(identity.sessionId, id)!;
      this.#db.exec('COMMIT;');
      return Object.freeze({ row, replayed: false });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  startStep(input: SessionDeletionIdentity & { readonly stepId: string }):
  Readonly<{ row: SessionDeletionStepRow; replayed: boolean }> {
    this.#assertOpen();
    const identity = deletionIdentity(input);
    const id = safeStepId(input.stepId);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const deletion = this.#requireIdentity(identity);
      const existing = this.#step(identity.sessionId, id);
      if (!existing) throw new SessionDeletionStepConflictError('session-deletion-step-not-prepared');
      if (existing.status === 'running' || existing.status === 'succeeded') {
        this.#db.exec('COMMIT;');
        return Object.freeze({ row: existing, replayed: true });
      }
      if (deletion.phase === 'complete') throw new SessionDeletionStepConflictError();
      const attemptCount = existing.attemptCount + 1;
      const changedAt = timestamp(this.#now());
      this.#db.prepare(`
        UPDATE session_deletion_step
        SET status='running',attempt_count=?,last_error_code=NULL,updated_at=?
        WHERE session_id=? AND step_id=?
      `).run(attemptCount, changedAt, identity.sessionId, id);
      this.#appendStepEvent(identity.sessionId, id, 'running', attemptCount, null, changedAt);
      const row = this.#step(identity.sessionId, id)!;
      this.#db.exec('COMMIT;');
      return Object.freeze({ row, replayed: false });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  finishStep(input: SessionDeletionIdentity & {
    readonly stepId: string;
    readonly status: 'succeeded' | 'failed';
    readonly errorCode?: string;
  }): Readonly<{ row: SessionDeletionStepRow; replayed: boolean }> {
    this.#assertOpen();
    const identity = deletionIdentity(input);
    const id = safeStepId(input.stepId);
    let nextError: string | null = null;
    if (input.status === 'failed') nextError = safeErrorCode(input.errorCode);
    else if (input.errorCode !== undefined) throw new Error('session-deletion-error-code-unexpected');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      this.#requireIdentity(identity);
      const existing = this.#step(identity.sessionId, id);
      if (!existing) throw new SessionDeletionStepConflictError('session-deletion-step-not-prepared');
      if (existing.status === input.status
        && (input.status === 'succeeded' || existing.lastErrorCode === nextError)) {
        this.#db.exec('COMMIT;');
        return Object.freeze({ row: existing, replayed: true });
      }
      if (existing.status !== 'running') throw new SessionDeletionStepConflictError();
      const changedAt = timestamp(this.#now());
      this.#db.prepare(`
        UPDATE session_deletion_step
        SET status=?,last_error_code=?,updated_at=?
        WHERE session_id=? AND step_id=?
      `).run(input.status, nextError, changedAt, identity.sessionId, id);
      this.#appendStepEvent(
        identity.sessionId, id, input.status, existing.attemptCount, nextError, changedAt,
      );
      const row = this.#step(identity.sessionId, id)!;
      this.#db.exec('COMMIT;');
      return Object.freeze({ row, replayed: false });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  get(sessionIdValue: string): SessionDeletionJournalRow | null {
    this.#assertOpen();
    return this.#findBySession(safeSessionId(sessionIdValue));
  }
  listPending(): SessionDeletionJournalRow[] {
    this.#assertOpen();
    return (this.#db.prepare(
      "SELECT * FROM session_deletion WHERE phase<>'complete' ORDER BY created_at,session_id",
    ).all() as SqlRow[]).map(parseDeletionRow);
  }
  isBlocked(sessionIdValue: string): boolean {
    return this.get(sessionIdValue) !== null;
  }
  isPrivacyCommitted(sessionIdValue: string): boolean {
    const row = this.get(sessionIdValue);
    return row !== null && PHASE_RANK.get(row.phase)! >= PHASE_RANK.get('privacy-committed')!;
  }
  listSteps(sessionIdValue: string): SessionDeletionStepRow[] {
    this.#assertOpen();
    const sessionId = safeSessionId(sessionIdValue);
    return (this.#db.prepare(
      'SELECT * FROM session_deletion_step WHERE session_id=? ORDER BY step_id',
    ).all(sessionId) as SqlRow[]).map(parseStepRow);
  }
  listStepEvents(sessionIdValue: string, stepIdValue?: string): SessionDeletionStepEventRow[] {
    this.#assertOpen();
    const sessionId = safeSessionId(sessionIdValue);
    const rows = stepIdValue === undefined
      ? this.#db.prepare(
        'SELECT * FROM session_deletion_step_event WHERE session_id=? ORDER BY step_id,event_sequence',
      ).all(sessionId)
      : this.#db.prepare(`
        SELECT * FROM session_deletion_step_event
        WHERE session_id=? AND step_id=? ORDER BY event_sequence
      `).all(sessionId, safeStepId(stepIdValue));
    return (rows as SqlRow[]).map(parseStepEventRow);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #findBySession(sessionId: string): SessionDeletionJournalRow | null {
    const row = this.#db.prepare(
      'SELECT * FROM session_deletion WHERE session_id=?',
    ).get(sessionId) as SqlRow | undefined;
    return row ? parseDeletionRow(row) : null;
  }
  #findByEitherIdentity(sessionId: string, operationId: string): SessionDeletionJournalRow | null {
    const rows = this.#db.prepare(`
      SELECT * FROM session_deletion WHERE session_id=? OR operation_id=? ORDER BY session_id
    `).all(sessionId, operationId) as SqlRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new SessionDeletionIdentityConflictError();
    return parseDeletionRow(rows[0]!);
  }
  #requireIdentity(identity: SessionDeletionIdentity): SessionDeletionJournalRow {
    const row = this.#findByEitherIdentity(identity.sessionId, identity.operationId);
    if (!row) throw new SessionDeletionPhaseConflictError('session-deletion-not-prepared');
    this.#assertIdentity(row, identity);
    return row;
  }
  #assertIdentity(row: SessionDeletionJournalRow, identity: SessionDeletionIdentity): void {
    if (row.sessionId !== identity.sessionId || row.operationId !== identity.operationId
      || row.sourceRevision !== identity.sourceRevision) {
      throw new SessionDeletionIdentityConflictError();
    }
  }
  #step(sessionId: string, id: string): SessionDeletionStepRow | null {
    const row = this.#db.prepare(
      'SELECT * FROM session_deletion_step WHERE session_id=? AND step_id=?',
    ).get(sessionId, id) as SqlRow | undefined;
    return row ? parseStepRow(row) : null;
  }
  #appendStepEvent(
    sessionId: string,
    id: string,
    status: SessionDeletionStepStatus,
    attemptCount: number,
    code: string | null,
    createdAt: string,
  ): void {
    const prior = this.#db.prepare(`
      SELECT MAX(event_sequence) AS sequence
      FROM session_deletion_step_event WHERE session_id=? AND step_id=?
    `).get(sessionId, id) as { sequence: number | null };
    const sequence = prior.sequence === null ? 1 : Number(prior.sequence) + 1;
    this.#db.prepare(`
      INSERT INTO session_deletion_step_event(
        session_id,step_id,event_sequence,status,attempt_count,error_code,created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(sessionId, id, sequence, status, attemptCount, code, createdAt);
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('session-deletion-journal-closed');
  }
}
