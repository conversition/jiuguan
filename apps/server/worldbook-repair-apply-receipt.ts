/** Original control transaction receipt; never reconstruct file-replacement time or post-commit readback. */
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import { maintenanceWorldbookSkillDigest } from './skill-hub/maintenance-worldbook-proposal-proof.ts';
import type { WorldbookSkillNativeBinding } from './maintenance-worldbook-skill-source.ts';

export const WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE = 'worldbook_repair_apply_receipt';
export interface WorldbookRepairApplyReceipt {
  readonly version: 'worldbook-repair-apply-receipt-v1';
  readonly proposalId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly proposalDigest: string;
  readonly nativeBindingDigest: string;
  readonly artifactDigest: string;
  readonly appliedRevision: string;
  readonly appliedControlRevision: number;
  /** Time recorded by the original successful apply/reconciliation control transaction. */
  readonly appliedAt: string;
  readonly receiptDigest: string;
}
const SCHEMA = `CREATE TABLE worldbook_repair_apply_receipt (
  proposal_id TEXT PRIMARY KEY REFERENCES worldbook_repair_proposal(proposal_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, receipt_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(length(receipt_json)<=4096)
)`;
const sql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '') : '';
export function inspectWorldbookRepairApplyReceiptSchema(db: DatabaseSync): void {
  const table = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE);
  if (table?.type !== 'table' || sql(table.sql) !== sql(SCHEMA)) throw new Error('worldbook-apply-receipt-schema-invalid');
}
export function prepareWorldbookRepairApplyReceipt(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('worldbook-apply-receipt-transaction-required');
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE)) db.exec(SCHEMA);
  inspectWorldbookRepairApplyReceiptSchema(db);
}
function parse(value: unknown): WorldbookRepairApplyReceipt {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const row = value as WorldbookRepairApplyReceipt;
    const metadata = {
      version: row.version,
      proposalId: agentClosureToken(row.proposalId, 'proposalId'),
      operationId: agentClosureToken(row.operationId, 'operationId'),
      sessionId: agentClosureToken(row.sessionId, 'sessionId'),
      proposalDigest: agentClosureDigest(row.proposalDigest, 'proposalDigest'),
      nativeBindingDigest: agentClosureDigest(row.nativeBindingDigest, 'nativeBindingDigest'),
      artifactDigest: agentClosureDigest(row.artifactDigest, 'artifactDigest'),
      appliedRevision: agentClosureDigest(row.appliedRevision, 'appliedRevision'),
      appliedControlRevision: row.appliedControlRevision,
      appliedAt: agentClosureTimestamp(row.appliedAt, 'appliedAt'),
    };
    const result = Object.freeze({ ...metadata, receiptDigest: maintenanceWorldbookSkillDigest(metadata) });
    if (row.version !== 'worldbook-repair-apply-receipt-v1'
      || !Number.isSafeInteger(row.appliedControlRevision) || row.appliedControlRevision < 2
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096
      || JSON.stringify(value) !== JSON.stringify(result)) throw new Error();
    return result;
  } catch { throw new Error('worldbook-apply-receipt-corrupt'); }
}
export function insertWorldbookRepairApplyReceipt(db: DatabaseSync, native: WorldbookSkillNativeBinding, artifactDigest: string): void {
  if (!db.isTransaction || native.status !== 'applied' || !native.appliedRevision)
    throw new Error('worldbook-apply-receipt-transaction-required');
  inspectWorldbookRepairApplyReceiptSchema(db);
  const metadata = { version: 'worldbook-repair-apply-receipt-v1', proposalId: native.proposalId,
    operationId: native.operationId, sessionId: native.sessionId, proposalDigest: native.proposalDigest,
    nativeBindingDigest: native.nativeBindingDigest, artifactDigest, appliedRevision: native.appliedRevision,
    appliedControlRevision: native.revision, appliedAt: native.updatedAt };
  const receipt = parse({ ...metadata, receiptDigest: maintenanceWorldbookSkillDigest(metadata) });
  db.prepare(`INSERT INTO worldbook_repair_apply_receipt (proposal_id,session_id,receipt_digest,receipt_json) VALUES(?,?,?,?)`)
    .run(receipt.proposalId, receipt.sessionId, receipt.receiptDigest, JSON.stringify(receipt));
  const reread = readWorldbookRepairApplyReceipt(db, native, artifactDigest);
  if (reread?.receiptDigest !== receipt.receiptDigest) throw new Error('worldbook-apply-receipt-storage-mismatch');
}
export function readWorldbookRepairApplyReceipt(db: DatabaseSync, native: WorldbookSkillNativeBinding, artifactDigest: string): WorldbookRepairApplyReceipt | null {
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE)) return null;
  inspectWorldbookRepairApplyReceiptSchema(db);
  const row = db.prepare('SELECT * FROM worldbook_repair_apply_receipt WHERE proposal_id=?').get(native.proposalId);
  if (!row) return null;
  const receipt = parse(JSON.parse(String(row.receipt_json)));
  if (row.proposal_id !== receipt.proposalId || row.session_id !== receipt.sessionId || row.receipt_digest !== receipt.receiptDigest
    || receipt.proposalId !== native.proposalId || receipt.operationId !== native.operationId || receipt.sessionId !== native.sessionId
    || receipt.proposalDigest !== native.proposalDigest || receipt.nativeBindingDigest !== native.nativeBindingDigest
    || receipt.artifactDigest !== artifactDigest || receipt.appliedRevision !== native.appliedRevision
    || receipt.appliedAt < native.createdAt || receipt.appliedAt > native.updatedAt
    || (native.status === 'applied' ? receipt.appliedAt !== native.updatedAt || receipt.appliedControlRevision !== native.revision
      : native.status !== 'reverted' || receipt.appliedControlRevision + 1 !== native.revision))
    throw new Error('worldbook-apply-receipt-link-invalid');
  return receipt;
}
