import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArcMaintenanceAction,
  ArcMaintenanceProposal,
  ArcMaintenanceStatus,
} from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';

export const ARC_PROJECTION_DB_FILE = 'arc-maintenance-projection.sqlite';
export const ARC_PROJECTION_SCHEMA_VERSION = 1;
export const ARC_PROJECTION_APPLICATION_ID = 0x4a474150; // JGAP

export interface ArcDerivedProjection {
  readonly sessionId: string;
  readonly actionCount: number;
  readonly statuses: Readonly<Record<string, ArcMaintenanceStatus>>;
  readonly mergedInto: Readonly<Record<string, string>>;
  readonly chapterBoundaries: readonly Readonly<{
    arcIds: readonly string[];
    boundaryRound: number;
    sourceRefs: readonly string[];
  }>[];
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly sourceConflicts: readonly Readonly<{
    arcIds: readonly string[];
    sourceRefs: readonly string[];
  }>[];
  readonly projectionDigest: string;
}

export interface ArcProjectionReceipt {
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly provenanceDigest: string;
  readonly deduped: boolean;
  readonly projection: ArcDerivedProjection;
}

export interface ArcProjectionRollbackResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly rolledBack: boolean;
  readonly projection: ArcDerivedProjection;
}

export type ArcProjectionCommitResult =
  | { readonly status: 'committed'; readonly receipt: ArcProjectionReceipt }
  | {
    readonly status: 'stale';
    readonly staleReason: 'source-revision-stale' | 'arc-projection-stale';
    readonly actualRevision: string;
    readonly actualProjectionDigest?: string;
    readonly actionCount: 0;
  };

type SqlRow = Record<string, unknown>;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ARC_ID_RE = /^arc:sha256:[a-f0-9]{64}$/u;

export interface ArcProjectionRecoveryInput {
  readonly runId: string;
  /** Resolve only after finding durable evidence, so never-applicable legacy proposals remain rejectable. */
  readonly proposal: ArcMaintenanceProposal | (() => ArcMaintenanceProposal);
  readonly provenanceDigest: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

/** The retained projection is a historical receipt, not the current overlay head. */
function parseReceiptProjection(value: unknown, sessionId: string): ArcDerivedProjection {
  const invalid = (): never => { throw new Error('arc-maintenance-receipt-corrupt'); };
  const record = (candidate: unknown): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid();
    return candidate as Record<string, unknown>;
  };
  const exact = (candidate: Record<string, unknown>, keys: readonly string[]) => {
    if (canonical(Object.keys(candidate).sort()) !== canonical([...keys].sort())) invalid();
  };
  const references = (candidate: unknown, pattern: RegExp, minimum: number): boolean =>
    Array.isArray(candidate) && candidate.length >= minimum
      && candidate.every((item) => typeof item === 'string' && pattern.test(item))
      && new Set(candidate).size === candidate.length;
  const row = record(value);
  exact(row, ['sessionId', 'actionCount', 'statuses', 'mergedInto', 'chapterBoundaries',
    'dependencies', 'sourceConflicts', 'projectionDigest']);
  if (row.sessionId !== sessionId || !Number.isSafeInteger(row.actionCount) || Number(row.actionCount) < 1
    || typeof row.projectionDigest !== 'string' || !DIGEST_RE.test(row.projectionDigest)) invalid();
  if (Object.entries(record(row.statuses)).some(([id, status]) => !ARC_ID_RE.test(id)
    || !['open', 'closed', 'dormant'].includes(status as string))) invalid();
  if (Object.entries(record(row.mergedInto)).some(([id, target]) => !ARC_ID_RE.test(id)
    || typeof target !== 'string' || !ARC_ID_RE.test(target) || id === target)) invalid();
  if (Object.entries(record(row.dependencies)).some(([id, targets]) => !ARC_ID_RE.test(id)
    || !references(targets, ARC_ID_RE, 1) || (targets as string[]).includes(id))) invalid();
  if (!Array.isArray(row.chapterBoundaries) || !Array.isArray(row.sourceConflicts)) invalid();
  for (const value of row.chapterBoundaries as unknown[]) {
    const boundary = record(value);
    exact(boundary, ['arcIds', 'boundaryRound', 'sourceRefs']);
    if (!references(boundary.arcIds, ARC_ID_RE, 1) || !references(boundary.sourceRefs, TOKEN_RE, 1)
      || !Number.isSafeInteger(boundary.boundaryRound) || Number(boundary.boundaryRound) < 1) invalid();
  }
  for (const value of row.sourceConflicts as unknown[]) {
    const conflict = record(value);
    exact(conflict, ['arcIds', 'sourceRefs']);
    if (!references(conflict.arcIds, ARC_ID_RE, 1) || !references(conflict.sourceRefs, TOKEN_RE, 2)) invalid();
  }
  const { projectionDigest, ...body } = row;
  if (sha256(body) !== projectionDigest) invalid();
  return Object.freeze(row) as unknown as ArcDerivedProjection;
}

function initialize(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as SqlRow).user_version);
  const applicationId = Number((db.prepare('PRAGMA application_id').get() as SqlRow).application_id);
  if (version > ARC_PROJECTION_SCHEMA_VERSION) throw new Error('arc projection database too new');
  if (version !== 0) {
    if (version !== ARC_PROJECTION_SCHEMA_VERSION || applicationId !== ARC_PROJECTION_APPLICATION_ID) {
      throw new Error('arc projection database metadata mismatch');
    }
    return;
  }
  if (applicationId !== 0) throw new Error('arc projection database application id mismatch');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      PRAGMA application_id = ${ARC_PROJECTION_APPLICATION_ID};
      CREATE TABLE arc_projection_action (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        proposal_digest TEXT NOT NULL,
        provenance_digest TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0),
        action_kind TEXT NOT NULL,
        action_json TEXT NOT NULL CHECK (json_valid(action_json)),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, action_index)
      );
      CREATE INDEX arc_projection_action_session ON arc_projection_action(session_id, id);
      CREATE TABLE arc_projection_receipt (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        proposal_digest TEXT NOT NULL,
        provenance_digest TEXT NOT NULL,
        projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX arc_projection_receipt_session ON arc_projection_receipt(session_id, created_at);
      PRAGMA user_version = ${ARC_PROJECTION_SCHEMA_VERSION};
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

function applyActions(sessionId: string, actions: readonly ArcMaintenanceAction[]): ArcDerivedProjection {
  const statuses: Record<string, ArcMaintenanceStatus> = {};
  const mergedInto: Record<string, string> = {};
  const dependencies: Record<string, readonly string[]> = {};
  const chapterBoundaries: Array<{
    arcIds: readonly string[]; boundaryRound: number; sourceRefs: readonly string[];
  }> = [];
  const sourceConflicts: Array<{ arcIds: readonly string[]; sourceRefs: readonly string[] }> = [];
  for (const action of actions) {
    if (action.kind === 'set_status') statuses[action.arcId] = action.status;
    else if (action.kind === 'merge') {
      for (const arcId of action.arcIds) if (arcId !== action.targetArcId) mergedInto[arcId] = action.targetArcId;
    } else if (action.kind === 'chapter_boundary') {
      chapterBoundaries.push({
        arcIds: [...action.arcIds], boundaryRound: action.boundaryRound, sourceRefs: [...action.sourceRefs],
      });
    } else if (action.kind === 'order_dependencies') {
      dependencies[action.arcId] = [...action.dependencyArcIds];
    } else {
      sourceConflicts.push({ arcIds: [...action.arcIds], sourceRefs: [...action.sourceRefs] });
    }
  }
  const body = {
    sessionId,
    actionCount: actions.length,
    statuses: Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b))),
    mergedInto: Object.fromEntries(Object.entries(mergedInto).sort(([a], [b]) => a.localeCompare(b))),
    chapterBoundaries,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    sourceConflicts,
  };
  return Object.freeze({ ...body, projectionDigest: sha256(body) });
}

function parseActions(rows: SqlRow[]): ArcMaintenanceAction[] {
  return rows.map((row) => JSON.parse(String(row.action_json)) as ArcMaintenanceAction);
}

export interface ArcProjectionStoreOptions {
  readonly dataDir: string;
  readonly now?: () => string;
}

/** Dedicated, disposable projection store. It never reads or writes memory_arc or chat messages. */
export class ArcProjectionStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  #closed = false;

  constructor(options: ArcProjectionStoreOptions) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('arc projection dataDir invalid');
    const path = join(dataDir, ARC_PROJECTION_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('arc projection database invalid');
    }
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date().toISOString());
    initialize(this.#db);
  }

  commit(input: {
    readonly runId: string;
    readonly proposal: ArcMaintenanceProposal;
    readonly provenanceDigest: string;
    readonly expectedProjectionDigest: string;
    readonly currentRevision: () => string;
  }): ArcProjectionCommitResult {
    this.#assertOpen();
    if (!TOKEN_RE.test(input.runId) || !DIGEST_RE.test(input.provenanceDigest)
      || !DIGEST_RE.test(input.expectedProjectionDigest)) {
      throw new Error('arc-maintenance-commit-binding-invalid');
    }
    const prior = this.recover(input);
    if (prior) return prior;
    let actualRevision = input.currentRevision();
    if (typeof actualRevision !== 'string') throw new Error('arc-maintenance-current-revision-invalid');
    if (actualRevision !== input.proposal.sourceRevision) {
      return {
        status: 'stale', staleReason: 'source-revision-stale', actualRevision, actionCount: 0,
      };
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      actualRevision = input.currentRevision();
      if (typeof actualRevision !== 'string') throw new Error('arc-maintenance-current-revision-invalid');
      if (actualRevision !== input.proposal.sourceRevision) {
        this.#db.exec('ROLLBACK');
        return {
          status: 'stale', staleReason: 'source-revision-stale', actualRevision, actionCount: 0,
        };
      }
      const actualProjection = this.#readProjection(input.proposal.sessionId);
      if (actualProjection.projectionDigest !== input.expectedProjectionDigest) {
        this.#db.exec('ROLLBACK');
        return {
          status: 'stale',
          staleReason: 'arc-projection-stale',
          actualRevision,
          actualProjectionDigest: actualProjection.projectionDigest,
          actionCount: 0,
        };
      }
      const createdAt = this.#now();
      const insert = this.#db.prepare(
        `INSERT INTO arc_projection_action
          (session_id,run_id,source_revision,proposal_digest,provenance_digest,action_index,action_kind,action_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      input.proposal.actions.forEach((action, index) => insert.run(
        input.proposal.sessionId, input.runId, input.proposal.sourceRevision,
        input.proposal.proposalDigest, input.provenanceDigest, index, action.kind,
        JSON.stringify(action), createdAt,
      ));
      const projection = this.#readProjection(input.proposal.sessionId);
      this.#db.prepare(
        `INSERT INTO arc_projection_receipt
          (run_id,session_id,source_revision,proposal_digest,provenance_digest,projection_json,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        input.runId, input.proposal.sessionId, input.proposal.sourceRevision,
        input.proposal.proposalDigest, input.provenanceDigest, JSON.stringify(projection), createdAt,
      );
      this.#db.exec('COMMIT');
      return {
        status: 'committed',
        receipt: {
          runId: input.runId, sessionId: input.proposal.sessionId,
          sourceRevision: input.proposal.sourceRevision,
          proposalDigest: input.proposal.proposalDigest,
          provenanceDigest: input.provenanceDigest, deduped: false, projection,
        },
      };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  /** Read one exact durable commit without consulting current source or writing/replaying actions. */
  recover(input: ArcProjectionRecoveryInput): Extract<ArcProjectionCommitResult, { status: 'committed' }> | null {
    const result = this.#readCommit(input, false);
    return result ? { status: 'committed', receipt: result.receipt } : null;
  }

  /** Original commit time belongs to the native receipt/actions, never the later approval clock. */
  readCommitEvidence(input: ArcProjectionRecoveryInput): Readonly<{ receipt: ArcProjectionReceipt; committedAt: string }> | null {
    return this.#readCommit(input, true);
  }

  #readCommit(input: ArcProjectionRecoveryInput, includeTime: boolean): Readonly<{
    receipt: ArcProjectionReceipt; committedAt: string;
  }> | null {
    this.#assertOpen();
    if (!TOKEN_RE.test(input.runId) || !DIGEST_RE.test(input.provenanceDigest)) {
      throw new Error('arc-maintenance-recovery-binding-invalid');
    }
    // Both tables must be observed in the same read snapshot. A receipt-less write is uncertainty,
    // never evidence that the proposal is safe to reject or apply again.
    this.#db.exec('BEGIN');
    try {
      const receipt = this.#receipt(input.runId);
      const actions = this.#db.prepare(`SELECT session_id,source_revision,proposal_digest,provenance_digest,
        action_index,action_kind,action_json,created_at FROM arc_projection_action WHERE run_id=? ORDER BY action_index`)
        .all(input.runId) as SqlRow[];
      if (!receipt) {
        if (actions.length !== 0) throw new Error('arc-maintenance-recovery-incomplete');
        this.#db.exec('COMMIT');
        return null;
      }
      const proposal = typeof input.proposal === 'function' ? input.proposal() : input.proposal;
      if (!proposal || proposal.version !== 'arc-maintenance-proposal-v1'
        || !TOKEN_RE.test(proposal.sessionId) || !DIGEST_RE.test(proposal.sourceRevision)
        || !DIGEST_RE.test(proposal.proposalDigest) || !Array.isArray(proposal.actions)
        || proposal.actions.length < 1 || proposal.actions.length > 32
        || sha256({ version: proposal.version, sessionId: proposal.sessionId,
          sourceRevision: proposal.sourceRevision, actions: proposal.actions }) !== proposal.proposalDigest) {
        throw new Error('arc-maintenance-recovery-binding-invalid');
      }
      if (receipt.sessionId !== proposal.sessionId || receipt.sourceRevision !== proposal.sourceRevision
        || receipt.proposalDigest !== proposal.proposalDigest || receipt.provenanceDigest !== input.provenanceDigest) {
        throw new Error('arc-maintenance-operation-intent-conflict');
      }
      if (actions.length !== proposal.actions.length || receipt.projection.actionCount < actions.length) {
        throw new Error('arc-maintenance-recovery-incomplete');
      }
      let committedAt = '';
      if (includeTime) {
        const row = this.#db.prepare('SELECT created_at FROM arc_projection_receipt WHERE run_id=?').get(input.runId);
        if (typeof row?.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
          || new Date(row.created_at).toISOString() !== row.created_at
          || actions.some(action => action.created_at !== row.created_at))
          throw new Error('arc-maintenance-commit-time-invalid');
        committedAt = row.created_at;
      }
      for (const [index, action] of actions.entries()) {
        if (action.session_id !== proposal.sessionId || action.source_revision !== proposal.sourceRevision
          || action.proposal_digest !== proposal.proposalDigest || action.provenance_digest !== input.provenanceDigest
          || action.action_index !== index || action.action_kind !== proposal.actions[index]!.kind) {
          throw new Error('arc-maintenance-operation-intent-conflict');
        }
        let payload: unknown;
        try { payload = JSON.parse(String(action.action_json)); }
        catch { throw new Error('arc-maintenance-receipt-corrupt'); }
        if (canonical(payload) !== canonical(proposal.actions[index])) throw new Error('arc-maintenance-receipt-corrupt');
      }
      this.#db.exec('COMMIT');
      return Object.freeze({ receipt: Object.freeze({ ...receipt, deduped: true }), committedAt });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the read failure */ }
      throw error;
    }
  }

  read(sessionId: string): ArcDerivedProjection {
    this.#assertOpen();
    return this.#readProjection(sessionId);
  }

  rebuild(sessionId: string): ArcDerivedProjection {
    return this.read(sessionId);
  }

  /** Idempotently remove one derived run and rebuild from the remaining append-only actions. */
  rollbackRun(runId: string, expectedSessionId: string): ArcProjectionRollbackResult {
    this.#assertOpen();
    if (!TOKEN_RE.test(runId) || !TOKEN_RE.test(expectedSessionId)) {
      throw new Error('arc-maintenance-rollback-binding-invalid');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.#db.prepare(
        'SELECT session_id FROM arc_projection_receipt WHERE run_id=?',
      ).get(runId) as SqlRow | undefined;
      if (receipt && String(receipt.session_id) !== expectedSessionId) {
        throw new Error('arc-maintenance-rollback-session-conflict');
      }
      this.#db.prepare('DELETE FROM arc_projection_receipt WHERE run_id=?').run(runId);
      const deleted = this.#db.prepare(
        'DELETE FROM arc_projection_action WHERE run_id=? AND session_id=?',
      ).run(runId, expectedSessionId);
      const projection = this.#readProjection(expectedSessionId);
      this.#db.exec('COMMIT');
      return Object.freeze({
        runId,
        sessionId: expectedSessionId,
        rolledBack: Number(deleted.changes) > 0,
        projection,
      });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.#assertOpen();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM arc_projection_receipt WHERE session_id=?').run(sessionId);
      this.#db.prepare('DELETE FROM arc_projection_action WHERE session_id=?').run(sessionId);
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #readProjection(sessionId: string): ArcDerivedProjection {
    const rows = this.#db.prepare(
      'SELECT action_json FROM arc_projection_action WHERE session_id=? ORDER BY id',
    ).all(sessionId) as SqlRow[];
    return applyActions(sessionId, parseActions(rows));
  }

  #receipt(runId: string): ArcProjectionReceipt | null {
    const row = this.#db.prepare(
      `SELECT run_id,session_id,source_revision,proposal_digest,provenance_digest,projection_json
       FROM arc_projection_receipt WHERE run_id=?`,
    ).get(runId) as SqlRow | undefined;
    if (!row) return null;
    if (row.run_id !== runId || typeof row.session_id !== 'string' || !TOKEN_RE.test(row.session_id)
      || typeof row.source_revision !== 'string' || !DIGEST_RE.test(row.source_revision)
      || typeof row.proposal_digest !== 'string' || !DIGEST_RE.test(row.proposal_digest)
      || typeof row.provenance_digest !== 'string' || !DIGEST_RE.test(row.provenance_digest)
      || typeof row.projection_json !== 'string') throw new Error('arc-maintenance-receipt-corrupt');
    let projection: unknown;
    try { projection = JSON.parse(row.projection_json); }
    catch { throw new Error('arc-maintenance-receipt-corrupt'); }
    return {
      runId: String(row.run_id), sessionId: String(row.session_id),
      sourceRevision: String(row.source_revision), proposalDigest: String(row.proposal_digest),
      provenanceDigest: String(row.provenance_digest), deduped: false,
      projection: parseReceiptProjection(projection, row.session_id),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('ArcProjectionStore closed');
  }
}
