import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import type { BudgetSnapshot } from '../../packages/harness/src/types.ts';
import {
  MAINTENANCE_POLICY_VERSION,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
  type MaintenanceMode,
  type MaintenanceProposal,
  type MaintenanceStrictProposalContext,
  type MaintenanceSettings,
  type MaintenanceStatus,
  type MaintenanceTaskKind,
  type MaintenanceTrigger,
  type PublicMaintenanceJob,
} from './maintenance-types.ts';

export const MAINTENANCE_JOB_DB_FILE = 'maintenance-jobs.sqlite';
export const MAINTENANCE_JOB_SCHEMA_VERSION = 2;
export const MAINTENANCE_JOB_APPLICATION_ID = 0x4a474d4a; // JGMJ
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

type SqlRow = Record<string, unknown>;

export class MaintenanceDisabledError extends Error {
  readonly name = 'MaintenanceDisabledError';
}

export interface EnqueueMaintenanceInput {
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly sourceRevision: string;
  readonly policyVersion?: string;
  readonly parentRunId?: string;
  readonly trigger: MaintenanceTrigger;
  readonly mode?: MaintenanceMode;
}

export interface MaintenanceExecutionRecord {
  readonly job: PublicMaintenanceJob;
  readonly leaseOwnerInstanceId: string;
  readonly leaseExpiresAt: string;
  readonly cancelRequestedAt?: string;
}

export type MaintenanceProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'rolled_back';

/** Content-bounded control-plane view. Full proposal/context remain server-side only. */
export interface MaintenancePendingProposalSummary {
  readonly proposalId: string;
  readonly jobRunId: string;
  readonly sessionId: string;
  readonly taskKind: Extract<MaintenanceTaskKind, 'branch_index' | 'npc_state'>;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly diff: Readonly<Record<string, unknown>>;
  readonly status: MaintenanceProposalStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt?: string;
  readonly decisionReason?: string;
}

export interface MaintenancePendingProposalRecord extends MaintenancePendingProposalSummary {
  readonly proposal: MaintenanceProposal;
  readonly context: MaintenanceStrictProposalContext;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly rollbackAnchor?: Readonly<Record<string, unknown>>;
}

export interface MaintenanceJobManagerOptions {
  readonly dataDir: string;
  readonly now?: () => string;
  readonly randomId?: () => string;
  readonly busyTimeoutMs?: number;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('maintenance clock invalid');
  }
  return value;
}

function requireOpaque(value: unknown, field: string, maxLength = 160): string {
  if (!isSafeOpaqueId(value, maxLength)) throw new Error(`${field} invalid`);
  return value;
}

function requireJsonObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} invalid`);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${field} too large`);
  return JSON.parse(text) as Record<string, unknown>;
}

function proposalTableSql(): string {
  return `
    CREATE TABLE maintenance_pending_proposal (
      proposal_id TEXT PRIMARY KEY,
      job_run_id TEXT NOT NULL UNIQUE REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      task_kind TEXT NOT NULL CHECK (task_kind IN ('branch_index','npc_state')),
      source_revision TEXT NOT NULL,
      proposal_digest TEXT NOT NULL,
      proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
      context_json TEXT NOT NULL CHECK (json_valid(context_json)),
      diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
      status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','stale','rolled_back')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decision_reason TEXT,
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      rollback_anchor_json TEXT CHECK (rollback_anchor_json IS NULL OR json_valid(rollback_anchor_json))
    );
    CREATE INDEX maintenance_pending_by_session
      ON maintenance_pending_proposal(session_id,status,created_at);
  `;
}

function readPragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row?.[name];
  if (!Number.isInteger(value)) throw new Error(`maintenance sqlite ${name} invalid`);
  return value as number;
}

function initializeSchema(db: DatabaseSync): void {
  const version = readPragma(db, 'user_version');
  const applicationId = readPragma(db, 'application_id');
  if (version > MAINTENANCE_JOB_SCHEMA_VERSION) throw new Error('maintenance database too new');
  if (version !== 0) {
    if (applicationId !== MAINTENANCE_JOB_APPLICATION_ID) {
      throw new Error('maintenance database metadata mismatch');
    }
    if (version === MAINTENANCE_JOB_SCHEMA_VERSION) return;
    if (version === 1) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(proposalTableSql());
        db.exec(`PRAGMA user_version = ${MAINTENANCE_JOB_SCHEMA_VERSION};`);
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
        throw error;
      }
      return;
    }
    throw new Error('maintenance database metadata mismatch');
  }
  if (applicationId !== 0) throw new Error('maintenance database application id mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${MAINTENANCE_JOB_APPLICATION_ID};
      CREATE TABLE maintenance_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        global_enabled INTEGER NOT NULL CHECK (global_enabled IN (0,1)),
        default_mode TEXT NOT NULL CHECK (default_mode IN ('shadow','apply')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE maintenance_session_settings (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE maintenance_job (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_kind TEXT NOT NULL CHECK (task_kind IN ('memory_consolidation','branch_index','rolling_summary','npc_state')),
        source_revision TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        parent_run_id TEXT,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('post-turn','idle','manual')),
        mode TEXT NOT NULL CHECK (mode IN ('shadow','apply')),
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','stale')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancel_requested_at TEXT,
        lease_owner_instance_id TEXT,
        lease_expires_at TEXT,
        error_code TEXT,
        budget_json TEXT CHECK (budget_json IS NULL OR json_valid(budget_json)),
        proposal_digest TEXT,
        proposal_disposition TEXT CHECK (proposal_disposition IS NULL OR proposal_disposition IN ('shadow','committed','stale')),
        diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
        UNIQUE(session_id, task_kind, source_revision, policy_version)
      );
      CREATE UNIQUE INDEX maintenance_one_running_per_session
        ON maintenance_job(session_id) WHERE status = 'running';
      CREATE INDEX maintenance_job_status_created ON maintenance_job(status, created_at);
      CREATE TABLE maintenance_outbox (
        outbox_id TEXT PRIMARY KEY,
        job_run_id TEXT NOT NULL UNIQUE REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        delivered_at TEXT
      );
      CREATE INDEX maintenance_outbox_pending ON maintenance_outbox(delivered_at, available_at);
      ${proposalTableSql()}
      PRAGMA user_version = ${MAINTENANCE_JOB_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
    throw error;
  }
}

function parseProposalRow(row: SqlRow): MaintenancePendingProposalRecord {
  if (row.task_kind !== 'branch_index' && row.task_kind !== 'npc_state') {
    throw new Error('maintenance proposal task kind corrupt');
  }
  const status = String(row.status);
  if (!['pending', 'applied', 'rejected', 'stale', 'rolled_back'].includes(status)) {
    throw new Error('maintenance proposal status corrupt');
  }
  const proposal = requireJsonObject(
    JSON.parse(String(row.proposal_json)), 'proposal_json', MAX_PROPOSAL_BYTES,
  ) as unknown as MaintenanceProposal;
  if (proposal.taskKind !== row.task_kind || typeof proposal.payload !== 'object' || proposal.payload === null) {
    throw new Error('maintenance proposal payload corrupt');
  }
  const context = requireJsonObject(
    JSON.parse(String(row.context_json)), 'context_json', MAX_CONTEXT_BYTES,
  ) as unknown as MaintenanceStrictProposalContext;
  const diff = requireJsonObject(JSON.parse(String(row.diff_json)), 'diff_json', MAX_DIFF_BYTES);
  const receipt = row.receipt_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.receipt_json)), 'receipt_json', MAX_RECEIPT_BYTES);
  const rollbackAnchor = row.rollback_anchor_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.rollback_anchor_json)), 'rollback_anchor_json', MAX_RECEIPT_BYTES);
  return Object.freeze({
    proposalId: requireOpaque(row.proposal_id, 'proposal_id'),
    jobRunId: requireOpaque(row.job_run_id, 'job_run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    taskKind: row.task_kind,
    sourceRevision: requireOpaque(row.source_revision, 'source_revision'),
    proposalDigest: requireOpaque(row.proposal_digest, 'proposal_digest'),
    proposal: structuredClone(proposal),
    context: structuredClone(context),
    diff: Object.freeze(diff),
    status: status as MaintenanceProposalStatus,
    revision: Number(row.revision),
    createdAt: canonicalTimestamp(String(row.created_at)),
    updatedAt: canonicalTimestamp(String(row.updated_at)),
    ...(row.decided_at == null ? {} : { decidedAt: canonicalTimestamp(String(row.decided_at)) }),
    ...(row.decision_reason == null ? {} : {
      decisionReason: requireOpaque(row.decision_reason, 'decision_reason', 120),
    }),
    ...(receipt ? { receipt: Object.freeze(receipt) } : {}),
    ...(rollbackAnchor ? { rollbackAnchor: Object.freeze(rollbackAnchor) } : {}),
  });
}

function proposalSummary(row: MaintenancePendingProposalRecord): MaintenancePendingProposalSummary {
  const { proposal: _proposal, context: _context, receipt: _receipt, rollbackAnchor: _anchor, ...summary } = row;
  return Object.freeze(summary);
}

function parseBudget(value: unknown): BudgetSnapshot | undefined {
  if (value == null) return undefined;
  const parsed = JSON.parse(String(value)) as BudgetSnapshot;
  const keys: Array<keyof BudgetSnapshot> = [
    'stepsUsed', 'modelCallsUsed', 'toolCallsUsed', 'writesUsed', 'tokensUsed',
    'wallMsUsed', 'inputTokens', 'outputTokens', 'costMicrousd',
  ];
  if (keys.some((key) => !Number.isSafeInteger(parsed[key]) || parsed[key] < 0)) {
    throw new Error('maintenance budget row invalid');
  }
  return parsed;
}

function parseJob(row: SqlRow): PublicMaintenanceJob {
  if (!isMaintenanceTaskKind(row.task_kind) || !isMaintenanceTrigger(row.trigger_kind)
    || !isMaintenanceMode(row.mode)) throw new Error('maintenance enum row invalid');
  const status = row.status as MaintenanceStatus;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale'].includes(status)) {
    throw new Error('maintenance status row invalid');
  }
  const budget = parseBudget(row.budget_json);
  const diff = row.diff_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.diff_json)), 'diff_json', MAX_DIFF_BYTES);
  return {
    runId: requireOpaque(row.run_id, 'run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    taskKind: row.task_kind,
    sourceRevision: requireOpaque(row.source_revision, 'source_revision'),
    policyVersion: requireOpaque(row.policy_version, 'policy_version'),
    ...(row.parent_run_id == null ? {} : { parentRunId: requireOpaque(row.parent_run_id, 'parent_run_id') }),
    trigger: row.trigger_kind,
    mode: row.mode,
    status,
    attempt: Number(row.attempt),
    createdAt: canonicalTimestamp(String(row.created_at)),
    updatedAt: canonicalTimestamp(String(row.updated_at)),
    ...(row.started_at == null ? {} : { startedAt: canonicalTimestamp(String(row.started_at)) }),
    ...(row.finished_at == null ? {} : { finishedAt: canonicalTimestamp(String(row.finished_at)) }),
    ...(row.error_code == null ? {} : { errorCode: requireOpaque(row.error_code, 'error_code', 80) }),
    ...(budget ? { budget } : {}),
    ...(row.proposal_digest == null || row.proposal_disposition == null || diff === undefined ? {} : {
      proposal: {
        digest: requireOpaque(row.proposal_digest, 'proposal_digest'),
        disposition: row.proposal_disposition as 'shadow' | 'committed' | 'stale',
        diff,
      },
    }),
  };
}

export class MaintenanceJobManager {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #randomId: () => string;
  #closed = false;

  constructor(options: MaintenanceJobManagerOptions) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stats = lstatSync(dataDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('maintenance dataDir must be a directory');
    const path = join(dataDir, MAINTENANCE_JOB_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('maintenance database must be a regular file');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS};`);
      initializeSchema(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL handled by dataDir policy. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
    const now = canonicalTimestamp(this.#now());
    this.#db.prepare(`
      INSERT OR IGNORE INTO maintenance_settings(singleton, global_enabled, default_mode, updated_at)
      VALUES(1, 0, 'shadow', ?)
    `).run(now);
  }

  settings(sessionIdValue: string): MaintenanceSettings {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    const global = this.#db.prepare('SELECT * FROM maintenance_settings WHERE singleton=1').get() as SqlRow;
    const local = this.#db.prepare('SELECT enabled FROM maintenance_session_settings WHERE session_id=?')
      .get(sessionId) as SqlRow | undefined;
    const globalEnabled = global.global_enabled === 1;
    const sessionEnabled = local?.enabled !== 0;
    const defaultMode = String(global.default_mode);
    if (!isMaintenanceMode(defaultMode)) throw new Error('maintenance settings corrupt');
    return { globalEnabled, defaultMode, sessionEnabled, effectiveEnabled: globalEnabled && sessionEnabled };
  }

  setGlobalEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.#db.prepare('UPDATE maintenance_settings SET global_enabled=?, updated_at=? WHERE singleton=1')
      .run(enabled ? 1 : 0, canonicalTimestamp(this.#now()));
  }

  globalEnabled(): boolean {
    this.#assertOpen();
    const row = this.#db.prepare(
      'SELECT global_enabled FROM maintenance_settings WHERE singleton=1',
    ).get() as SqlRow;
    return row.global_enabled === 1;
  }

  setDefaultMode(mode: MaintenanceMode): void {
    this.#assertOpen();
    if (!isMaintenanceMode(mode)) throw new Error('mode invalid');
    this.#db.prepare('UPDATE maintenance_settings SET default_mode=?, updated_at=? WHERE singleton=1')
      .run(mode, canonicalTimestamp(this.#now()));
  }

  setSessionEnabled(sessionIdValue: string, enabled: boolean): void {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    this.#db.prepare(`
      INSERT INTO maintenance_session_settings(session_id, enabled, updated_at) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run(sessionId, enabled ? 1 : 0, canonicalTimestamp(this.#now()));
  }

  enqueue(input: EnqueueMaintenanceInput): { job: PublicMaintenanceJob; replayed: boolean } {
    this.#assertOpen();
    const sessionId = requireOpaque(input.sessionId, 'sessionId');
    if (!isMaintenanceTaskKind(input.taskKind)) throw new Error('taskKind invalid');
    if (!isMaintenanceTrigger(input.trigger)) throw new Error('trigger invalid');
    const sourceRevision = requireOpaque(input.sourceRevision, 'sourceRevision');
    const policyVersion = requireOpaque(input.policyVersion ?? MAINTENANCE_POLICY_VERSION, 'policyVersion');
    const parentRunId = input.parentRunId === undefined ? undefined : requireOpaque(input.parentRunId, 'parentRunId');
    const settings = this.settings(sessionId);
    if (!settings.effectiveEnabled) throw new MaintenanceDisabledError('maintenance disabled');
    const mode = input.mode ?? settings.defaultMode;
    if (!isMaintenanceMode(mode)) throw new Error('mode invalid');
    const now = canonicalTimestamp(this.#now());
    const uuid = this.#randomId().replaceAll('-', '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(uuid)) throw new Error('maintenance random source must return UUID');
    const runId = `mjob_${uuid}`;
    const outboxId = `mout_${uuid}`;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#db.prepare(`
        SELECT * FROM maintenance_job
        WHERE session_id=? AND task_kind=? AND source_revision=? AND policy_version=?
      `).get(sessionId, input.taskKind, sourceRevision, policyVersion) as SqlRow | undefined;
      if (existing) {
        this.#db.exec('COMMIT;');
        return { job: parseJob(existing), replayed: true };
      }
      this.#db.prepare(`
        INSERT INTO maintenance_job(
          run_id,session_id,task_kind,source_revision,policy_version,parent_run_id,
          trigger_kind,mode,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)
      `).run(runId, sessionId, input.taskKind, sourceRevision, policyVersion,
        parentRunId ?? null, input.trigger, mode, now, now);
      this.#db.prepare(`
        INSERT INTO maintenance_outbox(outbox_id,job_run_id,available_at) VALUES(?,?,?)
      `).run(outboxId, runId, now);
      const created = this.#getRow(runId);
      if (!created) throw new Error('maintenance job readback failed');
      this.#db.exec('COMMIT;');
      return { job: parseJob(created), replayed: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  claimNext(
    ownerValue: string,
    leaseMs = 30_000,
    canClaim: (sessionId: string) => boolean = () => true,
  ): MaintenanceExecutionRecord | null {
    this.#assertOpen();
    const owner = requireOpaque(ownerValue, 'owner');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('leaseMs invalid');
    const now = canonicalTimestamp(this.#now());
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const candidates = this.#db.prepare(`
        SELECT j.* FROM maintenance_job j
        JOIN maintenance_outbox o ON o.job_run_id=j.run_id
        WHERE j.status='queued' AND o.delivered_at IS NULL AND o.available_at<=?
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_job active
            WHERE active.session_id=j.session_id AND active.status='running'
          )
        ORDER BY j.created_at,j.run_id LIMIT 100
      `).all(now) as SqlRow[];
      const row = candidates.find((candidate) => {
        try { return canClaim(requireOpaque(candidate.session_id, 'session_id')); }
        catch { return false; }
      });
      if (!row) { this.#db.exec('COMMIT;'); return null; }
      const result = this.#db.prepare(`
        UPDATE maintenance_job SET status='running', attempt=attempt+1, started_at=COALESCE(started_at,?),
          updated_at=?, lease_owner_instance_id=?, lease_expires_at=?
        WHERE run_id=? AND status='queued'
      `).run(now, now, owner, expires, String(row.run_id));
      if (result.changes !== 1) throw new Error('maintenance claim conflict');
      this.#db.prepare('UPDATE maintenance_outbox SET claimed_at=? WHERE job_run_id=?')
        .run(now, String(row.run_id));
      const claimed = this.#getRow(String(row.run_id));
      if (!claimed) throw new Error('maintenance claimed job missing');
      this.#db.exec('COMMIT;');
      return {
        job: parseJob(claimed),
        leaseOwnerInstanceId: owner,
        leaseExpiresAt: expires,
        ...(claimed.cancel_requested_at == null ? {} : {
          cancelRequestedAt: canonicalTimestamp(String(claimed.cancel_requested_at)),
        }),
      };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  renewLease(runIdValue: string, ownerValue: string, leaseMs = 30_000): void {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const owner = requireOpaque(ownerValue, 'owner');
    const now = canonicalTimestamp(this.#now());
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = this.#db.prepare(`
      UPDATE maintenance_job SET updated_at=?, lease_expires_at=?
      WHERE run_id=? AND status='running' AND lease_owner_instance_id=?
    `).run(now, expires, runId, owner);
    if (result.changes !== 1) throw new Error('maintenance lease lost');
  }

  complete(input: {
    runId: string;
    owner: string;
    status: Extract<MaintenanceStatus, 'succeeded' | 'failed' | 'cancelled' | 'stale'>;
    errorCode?: string;
    budget?: BudgetSnapshot;
    proposal?: MaintenanceProposal;
    proposalContext?: MaintenanceStrictProposalContext;
    disposition?: 'shadow' | 'committed' | 'stale';
    diff?: Record<string, unknown>;
  }): PublicMaintenanceJob {
    this.#assertOpen();
    const runId = requireOpaque(input.runId, 'runId');
    const owner = requireOpaque(input.owner, 'owner');
    if (input.status === 'failed' && !input.errorCode) throw new Error('failed requires errorCode');
    if (input.status !== 'failed' && input.errorCode) throw new Error('errorCode only valid for failed');
    const errorCode = input.errorCode === undefined ? null : requireOpaque(input.errorCode, 'errorCode', 80);
    const budgetJson = input.budget === undefined ? null : JSON.stringify(input.budget);
    let digest: string | null = null;
    let disposition: string | null = null;
    let diffJson: string | null = null;
    let proposalJson: string | null = null;
    let contextJson: string | null = null;
    if (input.proposal !== undefined) {
      const canonical = JSON.stringify(input.proposal);
      digest = createHash('sha256').update(canonical).digest('hex');
      disposition = input.disposition ?? 'shadow';
      diffJson = JSON.stringify(requireJsonObject(input.diff ?? {}, 'diff', MAX_DIFF_BYTES));
      proposalJson = JSON.stringify(requireJsonObject(input.proposal, 'proposal', MAX_PROPOSAL_BYTES));
      if (input.proposalContext !== undefined) {
        contextJson = JSON.stringify(requireJsonObject(input.proposalContext, 'proposalContext', MAX_CONTEXT_BYTES));
      }
    }
    const now = canonicalTimestamp(this.#now());
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.#db.prepare(`
        UPDATE maintenance_job SET status=?,updated_at=?,finished_at=?,error_code=?,budget_json=?,
          proposal_digest=?,proposal_disposition=?,diff_json=?,
          lease_owner_instance_id=NULL,lease_expires_at=NULL
        WHERE run_id=? AND status='running' AND lease_owner_instance_id=?
      `).run(input.status, now, now, errorCode, budgetJson, digest, disposition, diffJson, runId, owner);
      if (result.changes !== 1) throw new Error('maintenance completion conflict');
      this.#db.prepare('UPDATE maintenance_outbox SET delivered_at=? WHERE job_run_id=? AND delivered_at IS NULL')
        .run(now, runId);
      const row = this.#getRow(runId);
      if (!row) throw new Error('maintenance completed job missing');
      if (input.status === 'succeeded' && disposition === 'shadow' && proposalJson && contextJson
        && (input.proposal?.taskKind === 'branch_index' || input.proposal?.taskKind === 'npc_state')) {
        const proposalId = `mprop_${runId.slice('mjob_'.length)}`;
        this.#db.prepare(`
          INSERT INTO maintenance_pending_proposal(
            proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
            proposal_json,context_json,diff_json,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)
          ON CONFLICT(job_run_id) DO NOTHING
        `).run(proposalId, runId, String(row.session_id), input.proposal.taskKind,
          String(row.source_revision), `sha256:${digest}`, proposalJson, contextJson, diffJson, now, now);
      }
      this.#db.exec('COMMIT;');
      return parseJob(row);
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  requestCancel(runIdValue: string): { job: PublicMaintenanceJob; shouldAbort: boolean } {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const row = this.#getRow(runId);
    if (!row) throw new Error('maintenance job not found');
    const job = parseJob(row);
    if (!['queued', 'running'].includes(job.status)) return { job, shouldAbort: false };
    const now = canonicalTimestamp(this.#now());
    if (job.status === 'queued') {
      this.#db.prepare(`
        UPDATE maintenance_job SET status='cancelled',cancel_requested_at=?,updated_at=?,finished_at=?
        WHERE run_id=? AND status='queued'
      `).run(now, now, now, runId);
      this.#db.prepare('UPDATE maintenance_outbox SET delivered_at=? WHERE job_run_id=?').run(now, runId);
    } else {
      this.#db.prepare(`
        UPDATE maintenance_job SET cancel_requested_at=?,updated_at=? WHERE run_id=? AND status='running'
      `).run(now, now, runId);
    }
    return { job: this.get(runId)!, shouldAbort: job.status === 'running' };
  }

  recoverExpired(): number {
    this.#assertOpen();
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`
      UPDATE maintenance_job SET status='failed',updated_at=?,finished_at=?,
        error_code='restart-uncertain-no-replay',lease_owner_instance_id=NULL,lease_expires_at=NULL
      WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)
    `).run(now, now, now);
    this.#db.prepare(`
      UPDATE maintenance_outbox SET delivered_at=?
      WHERE delivered_at IS NULL AND job_run_id IN (
        SELECT run_id FROM maintenance_job WHERE status='failed' AND error_code='restart-uncertain-no-replay'
      )
    `).run(now);
    return Number(result.changes);
  }

  get(runIdValue: string): PublicMaintenanceJob | null {
    this.#assertOpen();
    const row = this.#getRow(requireOpaque(runIdValue, 'runId'));
    return row ? parseJob(row) : null;
  }

  list(sessionIdValue: string, limit = 50): PublicMaintenanceJob[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit invalid');
    return (this.#db.prepare(`
      SELECT * FROM maintenance_job WHERE session_id=? ORDER BY created_at DESC,run_id DESC LIMIT ?
    `).all(sessionId, limit) as SqlRow[]).map(parseJob);
  }

  listActiveForSession(sessionIdValue: string): PublicMaintenanceJob[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    return (this.#db.prepare(
      "SELECT * FROM maintenance_job WHERE session_id=? AND status IN ('queued','running') ORDER BY created_at,run_id",
    ).all(sessionId) as SqlRow[]).map(parseJob);
  }

  deleteSession(sessionIdValue: string): void {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      this.#db.prepare('DELETE FROM maintenance_job WHERE session_id=?').run(sessionId);
      this.#db.prepare('DELETE FROM maintenance_session_settings WHERE session_id=?').run(sessionId);
      this.#db.exec('COMMIT;');
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  listPendingProposals(sessionIdValue: string, limit = 20): MaintenancePendingProposalSummary[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit invalid');
    return (this.#db.prepare(`
      SELECT * FROM maintenance_pending_proposal
      WHERE session_id=? ORDER BY created_at DESC,proposal_id DESC LIMIT ?
    `).all(sessionId, limit) as SqlRow[]).map((row) => proposalSummary(parseProposalRow(row)));
  }

  getPendingProposal(proposalIdValue: string): MaintenancePendingProposalRecord | null {
    this.#assertOpen();
    const proposalId = requireOpaque(proposalIdValue, 'proposalId');
    const row = this.#db.prepare('SELECT * FROM maintenance_pending_proposal WHERE proposal_id=?')
      .get(proposalId) as SqlRow | undefined;
    return row ? parseProposalRow(row) : null;
  }

  rejectPendingProposal(input: {
    proposalId: string;
    expectedRevision: number;
    reason: string;
  }): MaintenancePendingProposalSummary {
    this.#assertOpen();
    const proposalId = requireOpaque(input.proposalId, 'proposalId');
    const reason = requireOpaque(input.reason, 'reason', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('maintenance-proposal-revision-invalid');
    }
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`
      UPDATE maintenance_pending_proposal
      SET status='rejected',revision=revision+1,updated_at=?,decided_at=?,decision_reason=?
      WHERE proposal_id=? AND status='pending' AND revision=?
    `).run(now, now, reason, proposalId, input.expectedRevision);
    if (result.changes !== 1) throw new Error('maintenance-proposal-revision-conflict');
    return proposalSummary(this.getPendingProposal(proposalId)!);
  }

  markProposalApplied(input: {
    proposalId: string;
    expectedRevision: number;
    receipt: Record<string, unknown>;
    rollbackAnchor: Record<string, unknown>;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'pending',
      to: 'applied',
      reason: 'operator-approved',
      receipt: input.receipt,
      rollbackAnchor: input.rollbackAnchor,
    });
  }

  markProposalStale(input: {
    proposalId: string;
    expectedRevision: number;
    reason?: string;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'pending',
      to: 'stale',
      reason: input.reason ?? 'source-revision-stale',
    });
  }

  markProposalRolledBack(input: {
    proposalId: string;
    expectedRevision: number;
    receipt: Record<string, unknown>;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'applied',
      to: 'rolled_back',
      reason: 'operator-rollback',
      receipt: input.receipt,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #getRow(runId: string): SqlRow | undefined {
    return this.#db.prepare('SELECT * FROM maintenance_job WHERE run_id=?').get(runId) as SqlRow | undefined;
  }

  #transitionProposal(input: {
    proposalId: string;
    expectedRevision: number;
    from: MaintenanceProposalStatus;
    to: MaintenanceProposalStatus;
    reason: string;
    receipt?: Record<string, unknown>;
    rollbackAnchor?: Record<string, unknown>;
  }): MaintenancePendingProposalSummary {
    this.#assertOpen();
    const proposalId = requireOpaque(input.proposalId, 'proposalId');
    const reason = requireOpaque(input.reason, 'reason', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('maintenance-proposal-revision-invalid');
    }
    const receiptJson = input.receipt === undefined ? null
      : JSON.stringify(requireJsonObject(input.receipt, 'receipt', MAX_RECEIPT_BYTES));
    const anchorJson = input.rollbackAnchor === undefined ? null
      : JSON.stringify(requireJsonObject(input.rollbackAnchor, 'rollbackAnchor', MAX_RECEIPT_BYTES));
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`
      UPDATE maintenance_pending_proposal
      SET status=?,revision=revision+1,updated_at=?,decided_at=?,decision_reason=?,
        receipt_json=COALESCE(?,receipt_json),
        rollback_anchor_json=COALESCE(?,rollback_anchor_json)
      WHERE proposal_id=? AND status=? AND revision=?
    `).run(input.to, now, now, reason, receiptJson, anchorJson,
      proposalId, input.from, input.expectedRevision);
    if (result.changes !== 1) throw new Error('maintenance-proposal-revision-conflict');
    return proposalSummary(this.getPendingProposal(proposalId)!);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MaintenanceJobManager closed');
  }
}
