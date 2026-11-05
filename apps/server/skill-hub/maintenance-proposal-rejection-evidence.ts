/** @author Codex @date 2026-10-27 @version 1.0
 * Original control-plane rejection history, not adoption, semantic failure or a Skill training label.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
    createAgentEvidenceProposalRejectionRecord, agentEvidenceRecordDigest,
    type AgentEvidenceProposalRejectionRecordV1,
} from '@jiuguan/skill-hub';
import { opaqueLearningToken } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import {
    MAINTENANCE_JOB_DB_FILE, type MaintenanceJobManager, type MaintenancePendingProposalRecord,
} from '../maintenance-job-manager.ts';
import { maintenanceValueDigest, type PublicMaintenanceJob } from '../maintenance-types.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export interface MaintenanceProposalRejectionEvidencePorts {
    readonly manager: Pick<MaintenanceJobManager, 'readRejectedProposalEvidence' | 'scanRejectedProposals'>;
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>;
    allowed(rawSessionId: string): boolean;
    onFailure?(): void;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonicalTime(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Only the original terminal proposal and its exact completed shadow job can describe a rejection. */
export function maintenanceProposalRejectionEvidenceRecord(
    proposal: MaintenancePendingProposalRecord, job: PublicMaintenanceJob,
): AgentEvidenceProposalRejectionRecordV1 {
    if (proposal.status !== 'rejected' || !Number.isSafeInteger(proposal.revision) || proposal.revision < 2
        || !canonicalTime(proposal.decidedAt)
        || !canonicalTime(proposal.createdAt) || proposal.updatedAt !== proposal.decidedAt
        || proposal.createdAt > proposal.decidedAt || typeof proposal.decisionReason !== 'string'
        || proposal.decisionReason.length < 1 || proposal.decisionReason.length > 120
        || proposal.receipt !== undefined || proposal.rollbackAnchor !== undefined
        || job.runId !== proposal.jobRunId || job.sessionId !== proposal.sessionId
        || job.taskKind !== proposal.taskKind || job.sourceRevision !== proposal.sourceRevision
        || job.status !== 'succeeded' || job.errorCode !== undefined || !canonicalTime(job.finishedAt)
        || job.finishedAt < proposal.createdAt || job.finishedAt > proposal.decidedAt
        || job.proposal?.disposition !== 'shadow'
        || `sha256:${job.proposal.digest}` !== proposal.proposalDigest
        || maintenanceValueDigest(proposal.proposal) !== proposal.proposalDigest
        || proposal.proposal.taskKind !== proposal.taskKind
        || proposal.context.sessionId !== proposal.sessionId
        || !('sourceRevision' in proposal.context)
        || proposal.context.sourceRevision !== proposal.sourceRevision) {
        throw new Error('maintenance-rejection-original-source-invalid');
    }
    return createAgentEvidenceProposalRejectionRecord({
        recordVersion: 'agent-evidence-proposal-rejection-v1', eventType: 'proposal-rejected',
        sessionId: opaqueLearningToken('session', proposal.sessionId),
        sourceType: 'maintenance-pending-proposal-v1',
        sourceRef: digest(['maintenance-proposal', proposal.proposalId]),
        sourceDigest: digest({ proposal, job }), artifactDigest: proposal.proposalDigest,
        producerRunId: opaqueLearningToken('run', proposal.jobRunId), taskKind: proposal.taskKind,
        proposalRevision: proposal.revision, occurredAt: proposal.decidedAt,
        decisionReasonDigest: digest(proposal.decisionReason), attributionKind: 'unattributed',
        manifestDigests: [], candidateDigests: [], executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

/** Re-read authoritative Manager history; no current Session identity, source acknowledgment or business repair. */
export async function reconcileMaintenanceProposalRejectionEvidence(
    input: MaintenanceProposalRejectionEvidencePorts, rawSessionId: string, limit = 64, cursor = 0,
) {
    let attempted = 0, delivered = 0, skipped = 0, failed = 0, nextCursor = cursor, hasMore = false;
    const allowed = () => input.allowed(rawSessionId) === true;
    try {
        if (!allowed()) throw new Error('evidence-access-denied');
        const batch = input.manager.scanRejectedProposals(rawSessionId, limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const candidate of batch.entries) {
            try {
                if (!allowed()) throw new Error('evidence-access-denied');
                const original = input.manager.readRejectedProposalEvidence(candidate.proposalId);
                if (!original || original.proposal.sessionId !== rawSessionId
                    || JSON.stringify(original.proposal) !== JSON.stringify(candidate)) {
                    throw new Error('maintenance-rejection-source-drift');
                }
                const record = maintenanceProposalRejectionEvidenceRecord(original.proposal, original.job);
                if (!allowed()) throw new Error('evidence-access-denied');
                const final = input.manager.readRejectedProposalEvidence(candidate.proposalId);
                if (!final || agentEvidenceRecordDigest(maintenanceProposalRejectionEvidenceRecord(final.proposal, final.job))
                    !== agentEvidenceRecordDigest(record)) throw new Error('maintenance-rejection-source-drift');
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

export function createMaintenanceProposalRejectionEvidenceScheduler(
    input: MaintenanceProposalRejectionEvidencePorts & { retryBaseMs?: number },
) {
    const scheduler = createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (sessionId, limit, cursor, allowed) => reconcileMaintenanceProposalRejectionEvidence(
            { ...input, allowed }, sessionId, limit, cursor),
    });
    return Object.freeze({
        ...scheduler,
        /** Manager-owned history remains recoverable even without a current Session database. */
        recoverRetained() {
            try {
                let cursor = 0;
                do {
                    const page = input.manager.scanRejectedProposals(undefined, 64, cursor);
                    if (page.failed !== 0) throw new Error('evidence-source-invalid');
                    for (const proposal of page.entries) scheduler.schedule(proposal.sessionId);
                    if (!page.hasMore) break;
                    if (page.nextCursor <= cursor) throw new Error('maintenance-rejection-recovery-cursor-invalid');
                    cursor = page.nextCursor;
                } while (true);
            } catch { try { input.onFailure?.(); } catch { /* Optional recovery diagnostics only. */ } }
        },
    });
}

/** Read-only discovery hint. The real Manager validates every record before anything is archived. */
export function hasRetainedMaintenanceProposalRejections(
    dataDir: string, isSessionDeleted: (rawSessionId: string) => boolean,
): boolean {
    const path = join(dataDir, MAINTENANCE_JOB_DB_FILE);
    if (!existsSync(path)) return false;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('maintenance-rejection-discovery-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        let cursor = 0;
        do {
            const rows = db.prepare(`SELECT rowid AS source_cursor,session_id FROM maintenance_pending_proposal
                WHERE status='rejected' AND rowid>? ORDER BY rowid LIMIT 64`).all(cursor) as {
                source_cursor: number; session_id: string;
            }[];
            for (const row of rows) {
                if (typeof row.session_id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(row.session_id)
                    && isSessionDeleted(row.session_id) === false) return true;
            }
            if (rows.length < 64) return false;
            const next = rows.at(-1)!.source_cursor;
            if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('maintenance-rejection-discovery-cursor-invalid');
            cursor = next;
        } while (true);
    } finally { db.close(); }
}
