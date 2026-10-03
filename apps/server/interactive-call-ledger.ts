import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InteractiveCallAudit, InteractiveToolEffect } from '../../packages/harness/src/interactive-tools.ts';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';

export const INTERACTIVE_LEDGER_DB_FILE = 'interactive-harness.sqlite';
export const INTERACTIVE_LEDGER_SCHEMA_VERSION = 2;
export const INTERACTIVE_LEDGER_APPLICATION_ID = 0x4a47494c; // JGIL

type Row = Record<string, unknown>;

export interface InteractiveLedgerRow extends InteractiveCallAudit {
  /** null denotes v1 history whose session ownership cannot be proven. */
  readonly sessionId: string | null;
  readonly createdAt: string;
}

export interface InteractiveCallSessionBinding {
  readonly sessionId: string;
}

export interface InteractiveSessionDeleteResult {
  readonly deletedRows: number;
}

export class InteractiveCallIdentityConflictError extends Error {
  readonly name = 'InteractiveCallIdentityConflictError';
  constructor() { super('interactive-call-identity-conflict'); }
}

function safeToken(value: string, field: string, max = 200): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${field}-invalid`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}-invalid`);
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}-invalid`);
  return value;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('timestamp-invalid');
  return value;
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name];
  if (!Number.isInteger(value)) throw new Error(`interactive-ledger-${name}-invalid`);
  return value as number;
}

const EXACT_COLUMNS = Object.freeze([
  'run_id', 'step_index', 'tool_call_id', 'args_hash', 'input_revision', 'tool_name',
  'tool_version', 'effect', 'status', 'result_chars', 'result_digest', 'elapsed_ms',
  'error_code', 'created_at', 'session_id',
]);

function inspectV1Schema(db: DatabaseSync): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  const columns = (db.prepare('PRAGMA table_info(interactive_tool_call)').all() as Array<{ name: string }>)
    .map((row) => row.name);
  const indexes = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (tables.join(',') !== 'interactive_tool_call'
    || columns.join(',') !== EXACT_COLUMNS.slice(0, -1).join(',')
    || indexes.join(',') !== 'interactive_tool_call_run') {
    throw new Error('interactive-ledger-v1-schema-mismatch');
  }
}

function inspectV2Schema(db: DatabaseSync): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (tables.join(',') !== 'interactive_tool_call') {
    throw new Error('interactive-ledger-schema-tables-mismatch');
  }
  const columns = (db.prepare('PRAGMA table_info(interactive_tool_call)').all() as Array<{ name: string }>)
    .map((row) => row.name);
  if (columns.join(',') !== EXACT_COLUMNS.join(',')) {
    throw new Error('interactive-ledger-schema-columns-mismatch');
  }
  const indexes = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (indexes.join(',') !== 'interactive_tool_call_run,interactive_tool_call_session') {
    throw new Error('interactive-ledger-schema-indexes-mismatch');
  }
}

function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const appId = pragma(db, 'application_id');
  if (version > INTERACTIVE_LEDGER_SCHEMA_VERSION) throw new Error('interactive-ledger-too-new');
  if (version === INTERACTIVE_LEDGER_SCHEMA_VERSION) {
    if (appId !== INTERACTIVE_LEDGER_APPLICATION_ID) throw new Error('interactive-ledger-metadata-mismatch');
    inspectV2Schema(db);
    return;
  }
  if (version === 1) {
    if (appId !== INTERACTIVE_LEDGER_APPLICATION_ID) throw new Error('interactive-ledger-metadata-mismatch');
    inspectV1Schema(db);
    db.exec('BEGIN IMMEDIATE;');
    try {
      // v1 had no trustworthy session binding. Preserve every old row as
      // anonymous history instead of guessing ownership from run_id.
      db.exec(`
        ALTER TABLE interactive_tool_call ADD COLUMN session_id TEXT;
        CREATE INDEX interactive_tool_call_session
          ON interactive_tool_call(session_id, created_at, run_id)
          WHERE session_id IS NOT NULL;
        PRAGMA user_version = ${INTERACTIVE_LEDGER_SCHEMA_VERSION};
      `);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
    inspectV2Schema(db);
    return;
  }
  if (appId !== 0) throw new Error('interactive-ledger-application-id-mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${INTERACTIVE_LEDGER_APPLICATION_ID};
      CREATE TABLE interactive_tool_call (
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL CHECK(step_index >= 0),
        tool_call_id TEXT NOT NULL,
        args_hash TEXT NOT NULL CHECK(length(args_hash) = 64),
        input_revision TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_version TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('read','proposal','deterministic-compute')),
        status TEXT NOT NULL CHECK(status IN ('ok','rejected','failed')),
        result_chars INTEGER NOT NULL CHECK(result_chars >= 0),
        result_digest TEXT NOT NULL CHECK(length(result_digest) = 64),
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
        error_code TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY(run_id, step_index, tool_call_id, args_hash)
      );
      CREATE INDEX interactive_tool_call_run ON interactive_tool_call(run_id, step_index, tool_call_id);
      CREATE INDEX interactive_tool_call_session
        ON interactive_tool_call(session_id, created_at, run_id)
        WHERE session_id IS NOT NULL;
      PRAGMA user_version = ${INTERACTIVE_LEDGER_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
  inspectV2Schema(db);
}

function parseEffect(value: unknown): InteractiveToolEffect {
  if (value !== 'read' && value !== 'proposal' && value !== 'deterministic-compute') {
    throw new Error('effect-invalid');
  }
  return value;
}

function requireSessionId(value: unknown): string {
  if (!isSafeOpaqueId(value, 160)) throw new Error('session-id-invalid');
  return value;
}

function boundSessionId(
  entry: InteractiveCallAudit,
  binding?: InteractiveCallSessionBinding,
): string {
  const inline = (entry as InteractiveCallAudit & { readonly sessionId?: unknown }).sessionId;
  if (inline !== undefined && binding !== undefined && inline !== binding.sessionId) {
    throw new InteractiveCallIdentityConflictError();
  }
  return requireSessionId(binding?.sessionId ?? inline);
}

function parseRow(row: Row): InteractiveLedgerRow {
  const status = row.status;
  if (status !== 'ok' && status !== 'rejected' && status !== 'failed') throw new Error('status-invalid');
  if (row.tool_version !== '1') throw new Error('tool-version-invalid');
  return {
    sessionId: row.session_id === null ? null : requireSessionId(row.session_id),
    runId: safeToken(String(row.run_id), 'runId'),
    stepIndex: nonNegative(Number(row.step_index), 'stepIndex'),
    toolCallId: safeToken(String(row.tool_call_id), 'toolCallId'),
    argsHash: digest(String(row.args_hash), 'argsHash'),
    inputRevision: safeToken(String(row.input_revision), 'inputRevision'),
    toolName: safeToken(String(row.tool_name), 'toolName', 100),
    toolVersion: '1',
    effect: parseEffect(row.effect),
    status,
    resultChars: nonNegative(Number(row.result_chars), 'resultChars'),
    resultDigest: digest(String(row.result_digest), 'resultDigest'),
    elapsedMs: nonNegative(Number(row.elapsed_ms), 'elapsedMs'),
    ...(row.error_code == null ? {} : { errorCode: safeToken(String(row.error_code), 'errorCode', 100) }),
    createdAt: timestamp(String(row.created_at)),
  };
}

export class InteractiveCallLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  #closed = false;

  constructor(options: { dataDir: string; now?: () => string; busyTimeoutMs?: number }) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('interactive-ledger-data-dir-invalid');
    const path = join(dataDir, INTERACTIVE_LEDGER_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('interactive-ledger-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5_000};`);
      initialize(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL handled by parent directory. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  record(
    entry: InteractiveCallAudit | (InteractiveCallAudit & InteractiveCallSessionBinding),
    binding?: InteractiveCallSessionBinding,
  ): { replayed: boolean } {
    this.#assertOpen();
    const sessionId = boundSessionId(entry, binding);
    const runId = safeToken(entry.runId, 'runId');
    const stepIndex = nonNegative(entry.stepIndex, 'stepIndex');
    const toolCallId = safeToken(entry.toolCallId, 'toolCallId');
    const args = digest(entry.argsHash, 'argsHash');
    const prior = this.#db.prepare(
      'SELECT args_hash,session_id FROM interactive_tool_call WHERE run_id=? AND step_index=? AND tool_call_id=? LIMIT 1',
    ).get(runId, stepIndex, toolCallId) as { args_hash: string; session_id: string | null } | undefined;
    if (prior && (prior.args_hash !== args || prior.session_id !== sessionId)) {
      throw new InteractiveCallIdentityConflictError();
    }
    if (prior) return { replayed: true };
    this.#db.prepare(`
      INSERT INTO interactive_tool_call(
        run_id,step_index,tool_call_id,args_hash,input_revision,tool_name,tool_version,effect,status,
        result_chars,result_digest,elapsed_ms,error_code,created_at,session_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      runId, stepIndex, toolCallId, args,
      safeToken(entry.inputRevision, 'inputRevision'),
      safeToken(entry.toolName, 'toolName', 100),
      entry.toolVersion,
      parseEffect(entry.effect),
      entry.status,
      nonNegative(entry.resultChars, 'resultChars'),
      digest(entry.resultDigest, 'resultDigest'),
      nonNegative(entry.elapsedMs, 'elapsedMs'),
      entry.errorCode == null ? null : safeToken(entry.errorCode, 'errorCode', 100),
      timestamp(this.#now()),
      sessionId,
    );
    return { replayed: false };
  }

  list(runIdValue: string): InteractiveLedgerRow[] {
    this.#assertOpen();
    const runId = safeToken(runIdValue, 'runId');
    return (this.#db.prepare(
      'SELECT * FROM interactive_tool_call WHERE run_id=? ORDER BY step_index, tool_call_id',
    ).all(runId) as Row[]).map(parseRow);
  }

  deleteSession(sessionIdValue: string): InteractiveSessionDeleteResult {
    this.#assertOpen();
    const sessionId = requireSessionId(sessionIdValue);
    const result = this.#db.prepare(
      'DELETE FROM interactive_tool_call WHERE session_id=?',
    ).run(sessionId);
    return Object.freeze({ deletedRows: Number(result.changes) });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('interactive-ledger-closed');
  }
}
