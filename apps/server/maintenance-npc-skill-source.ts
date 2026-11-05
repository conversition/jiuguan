/** Historical NPC Skill results linked to the original job and, when present, approval queue. */
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import type { MaintenancePendingProposalRecord, MaintenanceProposalStatus } from './maintenance-job-manager.ts';
import { validateMaintenanceProposal, type NpcMaintenanceNoopTerminal, type PublicMaintenanceJob } from './maintenance-types.ts';
import { isMaintenanceNpcSkillResultProof, maintenanceNpcSkillDigest, parseMaintenanceNpcSkillResultProof,
  type MaintenanceNpcSkillResultProof } from './skill-hub/maintenance-npc-result-proof.ts';

export const MAINTENANCE_NPC_SKILL_SOURCE_TABLE = 'maintenance_npc_skill_source';
const MAX_RECORD_BYTES = 32_768;
const SOURCE_VERSION = 'maintenance-npc-skill-source-v1' as const;
interface SourceBase {
  readonly version: typeof SOURCE_VERSION;
  readonly jobRunId: string;
  readonly sessionId: string;
  readonly taskKind: 'npc_state';
  readonly jobCreatedAt: string;
  readonly completedAt: string;
  readonly proof: MaintenanceNpcSkillResultProof;
  readonly recordDigest: string;
}
export type MaintenanceNpcSkillSourceRecord = SourceBase & ({
  readonly terminalKind: 'proposal'; readonly proposalId: string; readonly proposalDigest: string;
  readonly proposalCreatedAt: string;
} | {
  readonly terminalKind: 'noop'; readonly noop: NpcMaintenanceNoopTerminal;
});
export interface MaintenanceNpcSkillSourceEntry {
  readonly record: MaintenanceNpcSkillSourceRecord;
  /** Native current queue state; null for a typed no-op, never implied application or source freshness. */
  readonly proposal: {
    readonly proposalId: string; readonly status: MaintenanceProposalStatus; readonly revision: number;
    readonly updatedAt: string; readonly decidedAt?: string; readonly receiptDigest?: string;
    readonly rollbackAnchorDigest?: string;
  } | null;
}
function schemaSql(): string {
  return `CREATE TABLE ${MAINTENANCE_NPC_SKILL_SOURCE_TABLE} (
    run_id TEXT PRIMARY KEY REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, terminal_kind TEXT NOT NULL CHECK(terminal_kind IN ('proposal','noop')),
    proposal_id TEXT UNIQUE, record_digest TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(length(record_json)<=${MAX_RECORD_BYTES})
  )`;
}
function normalizedSql(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '') : '';
}
export function inspectMaintenanceNpcSkillSourceSchema(db: DatabaseSync): void {
  const table = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(MAINTENANCE_NPC_SKILL_SOURCE_TABLE);
  const columns = db.prepare(`PRAGMA table_info(${MAINTENANCE_NPC_SKILL_SOURCE_TABLE})`).all();
  const keys = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_NPC_SKILL_SOURCE_TABLE})`).all();
  if (table?.type !== 'table' || normalizedSql(table.sql) !== normalizedSql(schemaSql())
    || JSON.stringify(columns.map(row => [row.name, row.type, row.notnull, row.pk, row.dflt_value])) !== JSON.stringify([
      ['run_id', 'TEXT', 0, 1, null], ['session_id', 'TEXT', 1, 0, null], ['terminal_kind', 'TEXT', 1, 0, null],
      ['proposal_id', 'TEXT', 0, 0, null], ['record_digest', 'TEXT', 1, 0, null], ['record_json', 'TEXT', 1, 0, null],
    ]) || keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'run_id'
    || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE') throw new Error('npc-skill-source-schema-invalid');
}
/** The only stored terminal payload is this content-free native no-op shape. Context remains a digest. */
function parseNoop(value: NpcMaintenanceNoopTerminal): NpcMaintenanceNoopTerminal {
  if (!value || value.reasonCode !== 'no-applicable-evidence' || !Array.isArray(value.examinedCharacterIds)
    || value.examinedCharacterIds.length < 1 || value.examinedCharacterIds.length > 64
    || new Set(value.examinedCharacterIds).size !== value.examinedCharacterIds.length) throw new Error();
  const result = Object.freeze({ reasonCode: 'no-applicable-evidence' as const,
    examinedCharacterIds: Object.freeze(value.examinedCharacterIds.map(id => agentClosureToken(id, 'npc-character-id')).sort()),
    evidenceSetDigest: agentClosureDigest(value.evidenceSetDigest, 'npc-evidence-set-digest') });
  if (JSON.stringify(result) !== JSON.stringify(value)) throw new Error();
  return result;
}
export function parseMaintenanceNpcSkillSourceRecord(value: unknown): MaintenanceNpcSkillSourceRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RECORD_BYTES) throw new Error();
    const row = value as MaintenanceNpcSkillSourceRecord;
    const proof = parseMaintenanceNpcSkillResultProof(row.proof);
    const metadata = {
      version: row.version, jobRunId: agentClosureToken(row.jobRunId, 'npc-job-run-id'),
      sessionId: agentClosureToken(row.sessionId, 'npc-session-id'), taskKind: row.taskKind,
      jobCreatedAt: agentClosureTimestamp(row.jobCreatedAt, 'npc-job-created-at'),
      completedAt: agentClosureTimestamp(row.completedAt, 'npc-completed-at'),
      terminalKind: row.terminalKind,
      ...(row.terminalKind === 'proposal' ? {
        proposalId: agentClosureToken(row.proposalId, 'npc-proposal-id'),
        proposalDigest: agentClosureDigest(row.proposalDigest, 'npc-proposal-digest'),
        proposalCreatedAt: agentClosureTimestamp(row.proposalCreatedAt, 'npc-proposal-created-at'),
      } : { noop: parseNoop(row.noop) }), proof,
    };
    const result = Object.freeze({ ...metadata, recordDigest: maintenanceNpcSkillDigest(metadata) });
    if (row.version !== SOURCE_VERSION || row.taskKind !== 'npc_state' || !/^mjob_[a-f0-9]{32}$/u.test(row.jobRunId)
      || row.terminalKind !== proof.terminalKind || proof.runId !== row.jobRunId || proof.sessionId !== row.sessionId
      || proof.admittedAt < row.jobCreatedAt || proof.validatedAt > row.completedAt || row.completedAt < row.jobCreatedAt
      || (row.terminalKind === 'proposal'
        ? row.proposalId !== `mprop_${row.jobRunId.slice(5)}` || row.proposalDigest !== proof.terminalDigest
          || row.proposalCreatedAt !== row.completedAt
        : maintenanceNpcSkillDigest(row.noop) !== proof.terminalDigest)
      || JSON.stringify(result) !== JSON.stringify(value)) throw new Error();
    return result as MaintenanceNpcSkillSourceRecord;
  } catch { throw new Error('npc-skill-source-corrupt'); }
}
function assertLink(record: MaintenanceNpcSkillSourceRecord, job: PublicMaintenanceJob,
  pending: MaintenancePendingProposalRecord | null): void {
  try {
    const proof = record.proof;
    if (job.runId !== record.jobRunId || job.sessionId !== record.sessionId || job.taskKind !== 'npc_state'
      || job.mode !== 'shadow' || job.status !== 'succeeded' || job.createdAt !== record.jobCreatedAt
      || job.finishedAt !== record.completedAt || job.attempt !== proof.attempt || job.policyVersion !== proof.policyVersion
      || (job.parentRunId ?? job.runId) !== proof.parentRunId || job.sourceRevision !== proof.sourceRevision
      || proof.admittedAt < (job.startedAt ?? job.createdAt)) throw new Error();
    if (record.terminalKind === 'noop') {
      if (pending !== null || job.proposal !== undefined) throw new Error();
      return;
    }
    if (!pending || job.proposal?.disposition !== 'shadow' || `sha256:${job.proposal.digest}` !== record.proposalDigest
      || pending.proposalId !== record.proposalId || pending.jobRunId !== job.runId || pending.sessionId !== job.sessionId
      || pending.taskKind !== 'npc_state' || pending.sourceRevision !== proof.sourceRevision
      || pending.proposalDigest !== record.proposalDigest || pending.createdAt !== record.proposalCreatedAt
      || pending.updatedAt < pending.createdAt || !Number.isSafeInteger(pending.revision) || pending.revision < 1
      || pending.proposal.taskKind !== 'npc_state' || !('allowedCharacterIds' in pending.context)
      || pending.context.sessionId !== job.sessionId || pending.context.sourceRevision !== job.sourceRevision
      || maintenanceNpcSkillDigest(pending.proposal) !== proof.terminalDigest
      || maintenanceNpcSkillDigest(pending.context) !== proof.proposalContextDigest
      || maintenanceNpcSkillDigest(pending.context) !== proof.providerProposalContextDigest
      || JSON.stringify(validateMaintenanceProposal('npc_state', pending.proposal.payload, pending.context))
        !== JSON.stringify(pending.proposal)
      || pending.status === 'pending' && (pending.revision !== 1 || pending.decidedAt !== undefined
        || pending.receipt !== undefined || pending.rollbackAnchor !== undefined)
      || pending.status !== 'pending' && (pending.revision < 2 || pending.decidedAt === undefined)
      || pending.decidedAt !== undefined && (pending.decidedAt < pending.createdAt || pending.decidedAt > pending.updatedAt)
      || ['applied', 'rolled_back'].includes(pending.status)
        && (pending.receipt === undefined || pending.rollbackAnchor === undefined)) throw new Error();
  } catch { throw new Error('npc-skill-source-link-invalid'); }
}
export class MaintenanceNpcSkillSourceStore {
  static openExisting(db: DatabaseSync, readJob: (runId: string) => PublicMaintenanceJob,
    readProposal: (runId: string) => MaintenancePendingProposalRecord | null): MaintenanceNpcSkillSourceStore | null {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_NPC_SKILL_SOURCE_TABLE)
      ? new MaintenanceNpcSkillSourceStore(db, readJob, readProposal, false) : null;
  }
  constructor(private readonly db: DatabaseSync, private readonly readJob: (runId: string) => PublicMaintenanceJob,
    private readonly readProposal: (runId: string) => MaintenancePendingProposalRecord | null, create = true) {
    if (create) {
      if (!db.isTransaction) throw new Error('npc-skill-source-transaction-required');
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_NPC_SKILL_SOURCE_TABLE)) db.exec(schemaSql());
    }
    inspectMaintenanceNpcSkillSourceSchema(db);
  }
  insert(job: PublicMaintenanceJob, proof: MaintenanceNpcSkillResultProof, noop?: NpcMaintenanceNoopTerminal): void {
    if (!this.db.isTransaction) throw new Error('npc-skill-source-transaction-required');
    if (!isMaintenanceNpcSkillResultProof(proof)) throw new Error('npc-skill-source-live-proof-required');
    const pending = this.readProposal(job.runId);
    if (JSON.stringify(this.readJob(job.runId)) !== JSON.stringify(job)
      || proof.terminalKind === 'proposal' && (!pending || pending.status !== 'pending' || noop !== undefined)
      || proof.terminalKind === 'noop' && (pending !== null || noop === undefined)) throw new Error('npc-skill-source-link-invalid');
    const metadata = {
      version: SOURCE_VERSION, jobRunId: job.runId, sessionId: job.sessionId, taskKind: 'npc_state' as const,
      jobCreatedAt: job.createdAt, completedAt: job.finishedAt!, terminalKind: proof.terminalKind,
      ...(proof.terminalKind === 'proposal' ? { proposalId: pending!.proposalId,
        proposalDigest: pending!.proposalDigest, proposalCreatedAt: pending!.createdAt } : { noop }), proof,
    };
    const record = parseMaintenanceNpcSkillSourceRecord({ ...metadata, recordDigest: maintenanceNpcSkillDigest(metadata) });
    assertLink(record, job, pending);
    this.db.prepare(`INSERT INTO ${MAINTENANCE_NPC_SKILL_SOURCE_TABLE}
      (run_id,session_id,terminal_kind,proposal_id,record_digest,record_json) VALUES(?,?,?,?,?,?)`)
      .run(job.runId, job.sessionId, record.terminalKind, record.terminalKind === 'proposal' ? record.proposalId : null,
        record.recordDigest, JSON.stringify(record));
    if (this.read(job.runId)?.record.recordDigest !== record.recordDigest) throw new Error('npc-skill-source-storage-mismatch');
  }
  read(runId: string): MaintenanceNpcSkillSourceEntry | null {
    if (!this.db.isTransaction) throw new Error('npc-skill-source-transaction-required');
    const row = this.db.prepare(`SELECT * FROM ${MAINTENANCE_NPC_SKILL_SOURCE_TABLE} WHERE run_id=?`).get(runId);
    if (!row) return null;
    let record: MaintenanceNpcSkillSourceRecord;
    try {
      if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json, 'utf8') > MAX_RECORD_BYTES) throw new Error();
      record = parseMaintenanceNpcSkillSourceRecord(JSON.parse(row.record_json));
      if (row.run_id !== record.jobRunId || row.session_id !== record.sessionId || row.terminal_kind !== record.terminalKind
        || row.proposal_id !== (record.terminalKind === 'proposal' ? record.proposalId : null)
        || row.record_digest !== record.recordDigest) throw new Error();
    } catch { throw new Error('npc-skill-source-corrupt'); }
    const job = this.readJob(record.jobRunId), pending = this.readProposal(record.jobRunId);
    assertLink(record, job, pending);
    return Object.freeze({ record, proposal: pending ? Object.freeze({
      proposalId: pending.proposalId, status: pending.status, revision: pending.revision, updatedAt: pending.updatedAt,
      ...(pending.decidedAt ? { decidedAt: pending.decidedAt } : {}),
      ...(pending.receipt ? { receiptDigest: maintenanceNpcSkillDigest(pending.receipt) } : {}),
      ...(pending.rollbackAnchor ? { rollbackAnchorDigest: maintenanceNpcSkillDigest(pending.rollbackAnchor) } : {}),
    }) : null });
  }
}
