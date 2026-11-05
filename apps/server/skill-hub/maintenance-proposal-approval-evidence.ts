/** @author Codex @date 2026-10-27 @version 1.0
 * Original control-plane approval history, not adoption, semantic failure or a Skill training label.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
    agentEvidenceRecordDigest,
} from '@jiuguan/skill-hub';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import {
    MAINTENANCE_JOB_DB_FILE, type MaintenanceJobManager,
} from '../maintenance-job-manager.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';
import { MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE } from '../maintenance-proposal-approval-source.ts';

export interface MaintenanceProposalApprovalEvidencePorts {
    readonly manager: Pick<MaintenanceJobManager, 'readApprovedProposalEvidence' | 'scanApprovedProposals'>;
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>;
    allowed(rawSessionId: string): boolean;
    onFailure?(): void;
}

export { maintenanceProposalApprovalEvidenceRecord } from '../maintenance-proposal-approval-source.ts';
import { maintenanceProposalApprovalEvidenceRecord } from '../maintenance-proposal-approval-source.ts';

/** Re-read authoritative Manager history; no current Session identity, source acknowledgment or business repair. */
export async function reconcileMaintenanceProposalApprovalEvidence(
    input: MaintenanceProposalApprovalEvidencePorts, rawSessionId: string, limit = 64, cursor = 0,
) {
    let attempted = 0, delivered = 0, skipped = 0, failed = 0, nextCursor = cursor, hasMore = false;
    const allowed = () => input.allowed(rawSessionId) === true;
    try {
        if (!allowed()) throw new Error('evidence-access-denied');
        const batch = input.manager.scanApprovedProposals(rawSessionId, limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const candidate of batch.entries) {
            try {
                if (!allowed()) throw new Error('evidence-access-denied');
                const original = input.manager.readApprovedProposalEvidence(candidate.proposalId);
                if (!original || original.proposal.sessionId !== rawSessionId
                    || JSON.stringify(original.proposal) !== JSON.stringify(candidate)) {
                    throw new Error('maintenance-approval-source-drift');
                }
                const record = maintenanceProposalApprovalEvidenceRecord(original.proposal, original.job);
                if (!record) { skipped += 1; continue; }
                if (!allowed()) throw new Error('evidence-access-denied');
                const final = input.manager.readApprovedProposalEvidence(candidate.proposalId);
                const confirmed = final ? maintenanceProposalApprovalEvidenceRecord(final.proposal, final.job) : null;
                if (!confirmed || agentEvidenceRecordDigest(confirmed) !== agentEvidenceRecordDigest(record)) throw new Error('maintenance-approval-source-drift');
                if (!allowed()) throw new Error('evidence-access-denied');
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                delivered += 1;
            } catch { failed += 1; break; }
        }
        if (failed === 0 && !allowed()) throw new Error('evidence-access-denied');
        if (failed === 0) { nextCursor = batch.nextCursor; hasMore = batch.hasMore; }
    } catch { failed += 1; }
    return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
}

export function createMaintenanceProposalApprovalEvidenceScheduler(
    input: MaintenanceProposalApprovalEvidencePorts & { retryBaseMs?: number },
) {
    const scheduler = createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (sessionId, limit, cursor, allowed) => reconcileMaintenanceProposalApprovalEvidence(
            { ...input, allowed }, sessionId, limit, cursor),
    });
    return Object.freeze({
        ...scheduler,
        /** Manager-owned history remains recoverable even without a current Session database. */
        recoverRetained() {
            try {
                let cursor = 0;
                do {
                    const page = input.manager.scanApprovedProposals(undefined, 64, cursor);
                    if (page.failed !== 0) throw new Error('evidence-source-invalid');
                    for (const proposal of page.entries) scheduler.schedule(proposal.sessionId);
                    if (!page.hasMore) break;
                    if (page.nextCursor <= cursor) throw new Error('maintenance-approval-recovery-cursor-invalid');
                    cursor = page.nextCursor;
                } while (true);
            } catch { try { input.onFailure?.(); } catch { /* Optional recovery diagnostics only. */ } }
        },
    });
}

/** Read-only discovery hint. The real Manager validates every record before anything is archived. */
export function hasRetainedMaintenanceProposalApprovals(
    dataDir: string, isSessionDeleted: (rawSessionId: string) => boolean,
): boolean {
    const path = join(dataDir, MAINTENANCE_JOB_DB_FILE);
    if (!existsSync(path)) return false;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('maintenance-approval-discovery-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        let cursor = 0;
        do {
            const rows = db.prepare(`SELECT rowid AS source_cursor,session_id,status,decision_reason,receipt_json FROM maintenance_pending_proposal
                WHERE status IN ('applied','rolled_back') AND rowid>? ORDER BY rowid LIMIT 64`).all(cursor) as {
                source_cursor: number; session_id: string; status: string; decision_reason: string | null; receipt_json: string | null;
            }[];
            for (const row of rows) {
                let candidate = row.status === 'applied' && ['operator-approved', 'guarded-auto-approved'].includes(row.decision_reason ?? '');
                if (row.status === 'rolled_back') {
                    try { candidate = Object.hasOwn(JSON.parse(row.receipt_json ?? '{}'), MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE); }
                    catch { candidate = false; }
                }
                if (!candidate) continue;
                if (typeof row.session_id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(row.session_id)
                    && isSessionDeleted(row.session_id) === false) return true;
            }
            if (rows.length < 64) return false;
            const next = rows.at(-1)!.source_cursor;
            if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('maintenance-approval-discovery-cursor-invalid');
            cursor = next;
        } while (true);
    } finally { db.close(); }
}

