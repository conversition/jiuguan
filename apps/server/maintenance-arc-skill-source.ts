/** Historical Arc Skill request evidence joined to the original approval queue. */
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken }
  from '../../packages/agent-closure/index.ts';
import type { MaintenancePendingProposalRecord, MaintenanceProposalStatus } from './maintenance-job-manager.ts';
import { validateMaintenanceProposal, type PublicMaintenanceJob } from './maintenance-types.ts';
import { maintenanceArcSkillProviderProposalContext } from './skill-hub/maintenance-arc-context.ts';
import {
  isMaintenanceArcSkillProposalProof, maintenanceArcSkillDigest, parseMaintenanceArcSkillProposalProof,
  type MaintenanceArcSkillProposalProof,
} from './skill-hub/maintenance-arc-proposal-proof.ts';

export const MAINTENANCE_ARC_SKILL_SOURCE_TABLE = 'maintenance_arc_skill_source';
const MAX_RECORD_BYTES = 32_768;
const SOURCE_VERSION = 'maintenance-arc-skill-source-v1' as const;

/** Metadata only. Proposal, context and business receipts stay in their original stores. */
export interface MaintenanceArcSkillSourceRecord {
  readonly version: typeof SOURCE_VERSION;
  readonly jobRunId: string;
  readonly sessionId: string;
  readonly taskKind: 'branch_index';
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly proposalCreatedAt: string;
  readonly jobCreatedAt: string;
  readonly proof: MaintenanceArcSkillProposalProof;
  readonly recordDigest: string;
}

export interface MaintenanceArcSkillSourceEntry {
  readonly record: MaintenanceArcSkillSourceRecord;
  /** Current native approval state, not a claim about current source or Arc quality. */
  readonly proposal: {
    readonly proposalId: string;
    readonly status: MaintenanceProposalStatus;
    readonly revision: number;
    readonly updatedAt: string;
    readonly decidedAt?: string;
    readonly receiptDigest?: string;
    readonly rollbackAnchorDigest?: string;
  };
}

function schemaSql(): string {
  return `CREATE TABLE ${MAINTENANCE_ARC_SKILL_SOURCE_TABLE} (
    run_id TEXT PRIMARY KEY REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, proposal_id TEXT NOT NULL UNIQUE,
    record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(length(record_json)<=${MAX_RECORD_BYTES})
  )`;
}

function normalizedSql(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '') : '';
}

/** Pure inspector used by the original Manager's startup and migration boundaries. */
export function inspectMaintenanceArcSkillSourceSchema(db: DatabaseSync): void {
  const table = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?')
    .get(MAINTENANCE_ARC_SKILL_SOURCE_TABLE);
  const columns = db.prepare(`PRAGMA table_info(${MAINTENANCE_ARC_SKILL_SOURCE_TABLE})`).all();
  const keys = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_ARC_SKILL_SOURCE_TABLE})`).all();
  const expected = [
    ['run_id', 'TEXT', 0, 1, null], ['session_id', 'TEXT', 1, 0, null],
    ['proposal_id', 'TEXT', 1, 0, null], ['record_digest', 'TEXT', 1, 0, null],
    ['record_json', 'TEXT', 1, 0, null],
  ];
  if (table?.type !== 'table' || normalizedSql(table.sql) !== normalizedSql(schemaSql())
    || JSON.stringify(columns.map(row => [row.name, row.type, row.notnull, row.pk, row.dflt_value]))
      !== JSON.stringify(expected)
    || keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'run_id'
    || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE') {
    throw new Error('arc-skill-source-schema-invalid');
  }
}

export function parseMaintenanceArcSkillSourceRecord(value: unknown): MaintenanceArcSkillSourceRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RECORD_BYTES) throw new Error();
    const row = value as MaintenanceArcSkillSourceRecord;
    const proof = parseMaintenanceArcSkillProposalProof(row.proof);
    const metadata = {
      version: row.version,
      jobRunId: agentClosureToken(row.jobRunId, 'arc-job-run-id'),
      sessionId: agentClosureToken(row.sessionId, 'arc-session-id'),
      taskKind: row.taskKind,
      proposalId: agentClosureToken(row.proposalId, 'arc-proposal-id'),
      proposalDigest: agentClosureDigest(row.proposalDigest, 'arc-proposal-digest'),
      proposalCreatedAt: agentClosureTimestamp(row.proposalCreatedAt, 'arc-proposal-created-at'),
      jobCreatedAt: agentClosureTimestamp(row.jobCreatedAt, 'arc-job-created-at'),
      proof,
    };
    const result = Object.freeze({ ...metadata, recordDigest: maintenanceArcSkillDigest(metadata) });
    if (row.version !== SOURCE_VERSION || row.taskKind !== 'branch_index'
      || !/^mjob_[a-f0-9]{32}$/u.test(row.jobRunId)
      || row.proposalId !== `mprop_${row.jobRunId.slice(5)}`
      || proof.runId !== row.jobRunId || proof.sessionId !== row.sessionId
      || proof.proposalDigest !== row.proposalDigest || row.proposalCreatedAt < row.jobCreatedAt
      || proof.admittedAt < row.jobCreatedAt || proof.validatedAt > row.proposalCreatedAt
      || JSON.stringify(result) !== JSON.stringify(value)) throw new Error();
    return result;
  } catch { throw new Error('arc-skill-source-corrupt'); }
}

function assertLink(record: MaintenanceArcSkillSourceRecord, job: PublicMaintenanceJob,
  pending: MaintenancePendingProposalRecord | null): asserts pending is MaintenancePendingProposalRecord {
  try {
    const proof = record.proof;
    if (!pending || job.runId !== record.jobRunId || job.sessionId !== record.sessionId
      || job.taskKind !== 'branch_index' || job.mode !== 'shadow' || job.status !== 'succeeded'
      || job.proposal?.disposition !== 'shadow' || `sha256:${job.proposal.digest}` !== record.proposalDigest
      || job.createdAt !== record.jobCreatedAt || job.finishedAt !== record.proposalCreatedAt
      || job.attempt !== proof.attempt || job.policyVersion !== proof.policyVersion
      || (job.parentRunId ?? job.runId) !== proof.parentRunId || job.sourceRevision !== proof.sourceRevision
      || proof.admittedAt < (job.startedAt ?? job.createdAt)
      || pending.proposalId !== record.proposalId || pending.jobRunId !== job.runId
      || pending.sessionId !== job.sessionId || pending.taskKind !== 'branch_index'
      || pending.sourceRevision !== proof.sourceRevision || pending.proposalDigest !== record.proposalDigest
      || pending.createdAt !== record.proposalCreatedAt || pending.updatedAt < pending.createdAt
      || !Number.isSafeInteger(pending.revision) || pending.revision < 1
      || pending.proposal.taskKind !== 'branch_index' || !('allowedArcIds' in pending.context)
      || pending.context.sessionId !== job.sessionId || pending.context.sourceRevision !== job.sourceRevision
      || maintenanceArcSkillDigest(pending.proposal) !== proof.proposalDigest
      || maintenanceArcSkillDigest(pending.context) !== proof.proposalContextDigest
      || maintenanceArcSkillDigest(maintenanceArcSkillProviderProposalContext(pending.context))
        !== proof.providerProposalContextDigest
      || JSON.stringify(validateMaintenanceProposal('branch_index', pending.proposal.payload, pending.context))
        !== JSON.stringify(pending.proposal)
      || pending.status === 'pending' && (pending.revision !== 1 || pending.decidedAt !== undefined
        || pending.receipt !== undefined || pending.rollbackAnchor !== undefined)
      || pending.status !== 'pending' && (pending.revision < 2 || pending.decidedAt === undefined)
      || pending.decidedAt !== undefined && (pending.decidedAt < pending.createdAt
        || pending.decidedAt > pending.updatedAt)
      || ['applied', 'rolled_back'].includes(pending.status)
        && (pending.receipt === undefined || pending.rollbackAnchor === undefined)) throw new Error();
  } catch { throw new Error('arc-skill-source-link-invalid'); }
}

/** Uses the original Manager DB; no alternate queue, state machine, or approval authority. */
export class MaintenanceArcSkillSourceStore {
  static openExisting(db: DatabaseSync, readJob: (runId: string) => PublicMaintenanceJob,
    readProposal: (proposalId: string) => MaintenancePendingProposalRecord | null): MaintenanceArcSkillSourceStore | null {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_ARC_SKILL_SOURCE_TABLE)
      ? new MaintenanceArcSkillSourceStore(db, readJob, readProposal, false) : null;
  }

  constructor(private readonly db: DatabaseSync,
    private readonly readJob: (runId: string) => PublicMaintenanceJob,
    private readonly readProposal: (proposalId: string) => MaintenancePendingProposalRecord | null,
    create = true) {
    if (create) {
      // Schema creation is part of the required job/pending/source transaction too.
      if (!db.isTransaction) throw new Error('arc-skill-source-transaction-required');
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_ARC_SKILL_SOURCE_TABLE)) {
        db.exec(schemaSql());
      }
    }
    inspectMaintenanceArcSkillSourceSchema(db);
  }

  insert(job: PublicMaintenanceJob, proof: MaintenanceArcSkillProposalProof,
    pending: MaintenancePendingProposalRecord | null): void {
    if (!this.db.isTransaction) throw new Error('arc-skill-source-transaction-required');
    if (!isMaintenanceArcSkillProposalProof(proof)) throw new Error('arc-skill-source-live-proof-required');
    if (!pending || pending.status !== 'pending' || JSON.stringify(this.readJob(job.runId)) !== JSON.stringify(job)) {
      throw new Error('arc-skill-source-link-invalid');
    }
    const metadata = {
      version: SOURCE_VERSION, jobRunId: job.runId, sessionId: job.sessionId, taskKind: 'branch_index' as const,
      proposalId: pending.proposalId, proposalDigest: pending.proposalDigest,
      proposalCreatedAt: pending.createdAt, jobCreatedAt: job.createdAt, proof,
    };
    const record = parseMaintenanceArcSkillSourceRecord({ ...metadata, recordDigest: maintenanceArcSkillDigest(metadata) });
    assertLink(record, job, this.readProposal(record.proposalId));
    this.db.prepare(`INSERT INTO ${MAINTENANCE_ARC_SKILL_SOURCE_TABLE}
      (run_id,session_id,proposal_id,record_digest,record_json) VALUES(?,?,?,?,?)`)
      .run(job.runId, job.sessionId, record.proposalId, record.recordDigest, JSON.stringify(record));
    if (this.read(job.runId)?.record.recordDigest !== record.recordDigest) {
      throw new Error('arc-skill-source-storage-mismatch');
    }
  }

  /** Caller owns a single read/write transaction for row, job and native proposal consistency. */
  read(runId: string): MaintenanceArcSkillSourceEntry | null {
    if (!this.db.isTransaction) throw new Error('arc-skill-source-transaction-required');
    const row = this.db.prepare(`SELECT * FROM ${MAINTENANCE_ARC_SKILL_SOURCE_TABLE} WHERE run_id=?`).get(runId);
    if (!row) return null;
    let record: MaintenanceArcSkillSourceRecord;
    try {
      if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json, 'utf8') > MAX_RECORD_BYTES) {
        throw new Error();
      }
      record = parseMaintenanceArcSkillSourceRecord(JSON.parse(row.record_json));
      if (row.run_id !== record.jobRunId || row.session_id !== record.sessionId
        || row.proposal_id !== record.proposalId || row.record_digest !== record.recordDigest) throw new Error();
    } catch { throw new Error('arc-skill-source-corrupt'); }
    const job = this.readJob(record.jobRunId), pending = this.readProposal(record.proposalId);
    assertLink(record, job, pending);
    return Object.freeze({ record, proposal: Object.freeze({
      proposalId: pending.proposalId, status: pending.status, revision: pending.revision,
      updatedAt: pending.updatedAt,
      ...(pending.decidedAt ? { decidedAt: pending.decidedAt } : {}),
      ...(pending.receipt ? { receiptDigest: maintenanceArcSkillDigest(pending.receipt) } : {}),
      ...(pending.rollbackAnchor ? { rollbackAnchorDigest: maintenanceArcSkillDigest(pending.rollbackAnchor) } : {}),
    }) });
  }
}
