/** Historical Skill evidence in the original Worldbook control transaction. */
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import type { WorldbookRepairStatus } from './worldbook-repair-control.ts';
import { isMaintenanceWorldbookSkillProposalProof, maintenanceWorldbookSkillDigest,
  parseMaintenanceWorldbookSkillProposalProof, type MaintenanceWorldbookSkillProposalProof,
} from './skill-hub/maintenance-worldbook-proposal-proof.ts';

export const MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE = 'maintenance_worldbook_skill_source';
const MAX_BYTES = 32_768;
const VERSION = 'maintenance-worldbook-skill-source-v1' as const;
export interface WorldbookSkillNativeBinding {
  readonly proposalId: string; readonly operationId: string; readonly sessionId: string;
  readonly proposalDigest: string; readonly outerProposalDigest: string; readonly sourceRevision: string;
  readonly nativeBindingDigest: string; readonly createdAt: string;
  readonly status: WorldbookRepairStatus; readonly revision: number; readonly updatedAt: string;
  readonly appliedRevision?: string;
}
export interface MaintenanceWorldbookSkillSourceRecord {
  readonly version: typeof VERSION;
  readonly proposalId: string; readonly operationId: string; readonly sessionId: string;
  readonly proposalDigest: string; readonly sourceRevision: string; readonly nativeBindingDigest: string;
  readonly createdAt: string; readonly proof: MaintenanceWorldbookSkillProposalProof; readonly recordDigest: string;
}
export interface MaintenanceWorldbookSkillSourceEntry {
  readonly record: MaintenanceWorldbookSkillSourceRecord;
  /** Original native state, not a current source or quality assertion. */
  readonly proposal: { readonly status: WorldbookRepairStatus; readonly revision: number;
    readonly updatedAt: string; readonly appliedRevision?: string };
}
function schemaSql(): string {
  return `CREATE TABLE ${MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE} (
    proposal_id TEXT PRIMARY KEY REFERENCES worldbook_repair_proposal(proposal_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
    record_digest TEXT NOT NULL, record_json TEXT NOT NULL CHECK(length(record_json)<=${MAX_BYTES})
  )`;
}
const sql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '') : '';
export function inspectMaintenanceWorldbookSkillSourceSchema(db: DatabaseSync): void {
  const row = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE);
  const columns = db.prepare(`PRAGMA table_info(${MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE})`).all();
  const keys = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE})`).all();
  if (row?.type !== 'table' || sql(row.sql) !== sql(schemaSql())
    || JSON.stringify(columns.map(c => [c.name, c.type, c.notnull, c.pk, c.dflt_value])) !== JSON.stringify([
      ['proposal_id', 'TEXT', 0, 1, null], ['operation_id', 'TEXT', 1, 0, null], ['session_id', 'TEXT', 1, 0, null],
      ['record_digest', 'TEXT', 1, 0, null], ['record_json', 'TEXT', 1, 0, null],
    ]) || keys.length !== 1 || keys[0].table !== 'worldbook_repair_proposal' || keys[0].from !== 'proposal_id'
      || keys[0].to !== 'proposal_id' || keys[0].on_delete !== 'CASCADE') throw new Error('worldbook-skill-source-schema-invalid');
}
export function parseMaintenanceWorldbookSkillSourceRecord(value: unknown): MaintenanceWorldbookSkillSourceRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw new Error();
    const row = value as MaintenanceWorldbookSkillSourceRecord;
    const metadata = { version: row.version,
      proposalId: agentClosureToken(row.proposalId, 'worldbook-proposal-id'),
      operationId: agentClosureToken(row.operationId, 'worldbook-operation-id'),
      sessionId: agentClosureToken(row.sessionId, 'worldbook-session-id'),
      proposalDigest: agentClosureDigest(row.proposalDigest, 'worldbook-proposal-digest'),
      sourceRevision: agentClosureDigest(row.sourceRevision, 'worldbook-source-revision'),
      nativeBindingDigest: agentClosureDigest(row.nativeBindingDigest, 'worldbook-native-binding-digest'),
      createdAt: agentClosureTimestamp(row.createdAt, 'worldbook-created-at'),
      proof: parseMaintenanceWorldbookSkillProposalProof(row.proof),
    };
    const result = Object.freeze({ ...metadata, recordDigest: maintenanceWorldbookSkillDigest(metadata) });
    if (row.version !== VERSION || row.operationId !== `worldbook-repair:${metadata.proof.runId}`
      || row.sessionId !== metadata.proof.sessionId || metadata.proof.validatedAt > row.createdAt
      || JSON.stringify(result) !== JSON.stringify(value)) throw new Error();
    return result;
  } catch { throw new Error('worldbook-skill-source-corrupt'); }
}
function assertLink(record: MaintenanceWorldbookSkillSourceRecord, native: WorldbookSkillNativeBinding | null): asserts native is WorldbookSkillNativeBinding {
  if (!native || record.proposalId !== native.proposalId || record.operationId !== native.operationId
    || record.sessionId !== native.sessionId || record.proposalDigest !== native.proposalDigest
    || record.sourceRevision !== native.sourceRevision || record.createdAt !== native.createdAt
    || record.nativeBindingDigest !== native.nativeBindingDigest
    || record.proof.proposalDigest !== native.outerProposalDigest) throw new Error('worldbook-skill-source-link-invalid');
}
export class MaintenanceWorldbookSkillSourceStore {
  static openExisting(db: DatabaseSync, readNative: (id: string) => WorldbookSkillNativeBinding | null): MaintenanceWorldbookSkillSourceStore | null {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE)
      ? new MaintenanceWorldbookSkillSourceStore(db, readNative, false) : null;
  }
  constructor(private readonly db: DatabaseSync, private readonly readNative: (id: string) => WorldbookSkillNativeBinding | null, create = true) {
    if (create) {
      if (!db.isTransaction) throw new Error('worldbook-skill-source-transaction-required');
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE)) db.exec(schemaSql());
    }
    inspectMaintenanceWorldbookSkillSourceSchema(db);
  }
  insert(proposalId: string, proof: MaintenanceWorldbookSkillProposalProof): void {
    if (!this.db.isTransaction) throw new Error('worldbook-skill-source-transaction-required');
    if (!isMaintenanceWorldbookSkillProposalProof(proof)) throw new Error('worldbook-skill-source-live-proof-required');
    const native = this.readNative(proposalId);
    if (!native || native.status !== 'pending' || native.revision !== 1) throw new Error('worldbook-skill-source-link-invalid');
    const metadata = { version: VERSION, proposalId, operationId: native.operationId, sessionId: native.sessionId,
      proposalDigest: native.proposalDigest, sourceRevision: native.sourceRevision,
      nativeBindingDigest: native.nativeBindingDigest, createdAt: native.createdAt, proof };
    const record = parseMaintenanceWorldbookSkillSourceRecord({ ...metadata, recordDigest: maintenanceWorldbookSkillDigest(metadata) });
    assertLink(record, native);
    this.db.prepare(`INSERT INTO ${MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE}
      (proposal_id,operation_id,session_id,record_digest,record_json) VALUES(?,?,?,?,?)`)
      .run(proposalId, record.operationId, record.sessionId, record.recordDigest, JSON.stringify(record));
    if (this.read(proposalId)?.record.recordDigest !== record.recordDigest) throw new Error('worldbook-skill-source-storage-mismatch');
  }
  read(proposalId: string): MaintenanceWorldbookSkillSourceEntry | null {
    if (!this.db.isTransaction) throw new Error('worldbook-skill-source-transaction-required');
    const row = this.db.prepare(`SELECT * FROM ${MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE} WHERE proposal_id=?`).get(proposalId);
    if (!row) return null;
    let record: MaintenanceWorldbookSkillSourceRecord;
    try {
      if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json, 'utf8') > MAX_BYTES) throw new Error();
      record = parseMaintenanceWorldbookSkillSourceRecord(JSON.parse(row.record_json));
      if (row.proposal_id !== record.proposalId || row.operation_id !== record.operationId
        || row.session_id !== record.sessionId || row.record_digest !== record.recordDigest) throw new Error();
    } catch { throw new Error('worldbook-skill-source-corrupt'); }
    const native = this.readNative(proposalId);
    assertLink(record, native);
    return Object.freeze({ record, proposal: Object.freeze({ status: native.status, revision: native.revision,
      updatedAt: native.updatedAt, ...(native.appliedRevision ? { appliedRevision: native.appliedRevision } : {}) }) });
  }
}
