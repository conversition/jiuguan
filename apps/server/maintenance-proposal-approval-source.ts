/** Original approval history. Rollback preserves only a body-free projection, never a second business receipt. */
import { createHash } from 'node:crypto';
import {
    createAgentEvidenceProposalApprovalRecord, normalizeAgentEvidenceProposalApprovalRecord,
    type AgentEvidenceProposalApprovalRecordV1,
} from '@jiuguan/skill-hub';
import { opaqueLearningToken } from '../../packages/memory/public/learning-outbox.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';
import { maintenanceValueDigest, type PublicMaintenanceJob } from './maintenance-types.ts';

export const MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE = 'maintenanceProposalApprovalSource' as const;
const VERSION = 'maintenance-proposal-approval-source-v1';
export interface MaintenanceProposalApprovalSource {
    readonly version: typeof VERSION;
    readonly approval: AgentEvidenceProposalApprovalRecordV1;
    readonly appliedReceiptDigest: string;
}
function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function canonicalTime(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function source(proposal: MaintenancePendingProposalRecord, job: PublicMaintenanceJob,
    approval: { revision: number; occurredAt: string; decisionReasonDigest: string; appliedReceiptDigest: string },
): AgentEvidenceProposalApprovalRecordV1 {
    if (!Number.isSafeInteger(approval.revision) || approval.revision < 2
        || !canonicalTime(approval.occurredAt) || !canonicalTime(proposal.createdAt)
        || proposal.createdAt > approval.occurredAt || !object(proposal.rollbackAnchor)
        || !/^sha256:[a-f0-9]{64}$/u.test(approval.appliedReceiptDigest)
        || ![digest('operator-approved'), ...(proposal.taskKind === 'npc_state' ? [digest('guarded-auto-approved')] : [])]
            .includes(approval.decisionReasonDigest)
        || job.runId !== proposal.jobRunId || job.sessionId !== proposal.sessionId
        || job.taskKind !== proposal.taskKind || job.sourceRevision !== proposal.sourceRevision
        || job.status !== 'succeeded' || job.errorCode !== undefined || !canonicalTime(job.finishedAt)
        || job.finishedAt < proposal.createdAt || job.finishedAt > approval.occurredAt
        || job.proposal?.disposition !== 'shadow' || `sha256:${job.proposal.digest}` !== proposal.proposalDigest
        || maintenanceValueDigest(proposal.proposal) !== proposal.proposalDigest
        || proposal.proposal.taskKind !== proposal.taskKind || proposal.context.sessionId !== proposal.sessionId
        || !('sourceRevision' in proposal.context) || proposal.context.sourceRevision !== proposal.sourceRevision) {
        throw new Error('maintenance-approval-original-source-invalid');
    }
    // These fields survive the applied -> rolled_back CAS unchanged. Mutable lifecycle and replacement receipt do not.
    const original = {
        proposalId: proposal.proposalId, jobRunId: proposal.jobRunId, sessionId: proposal.sessionId,
        taskKind: proposal.taskKind, sourceRevision: proposal.sourceRevision, proposalDigest: proposal.proposalDigest,
        diff: proposal.diff, createdAt: proposal.createdAt, proposal: proposal.proposal, context: proposal.context,
        rollbackAnchor: proposal.rollbackAnchor,
    };
    return createAgentEvidenceProposalApprovalRecord({
        recordVersion: 'agent-evidence-proposal-approval-v1', eventType: 'proposal-approved',
        sessionId: opaqueLearningToken('session', proposal.sessionId), sourceType: 'maintenance-proposal-approval-v1',
        sourceRef: digest(['maintenance-proposal', proposal.proposalId]),
        sourceDigest: digest({ proposal: original, job, approval }), artifactDigest: proposal.proposalDigest,
        producerRunId: opaqueLearningToken('run', proposal.jobRunId), taskKind: proposal.taskKind,
        proposalRevision: approval.revision, occurredAt: approval.occurredAt,
        decisionReasonDigest: approval.decisionReasonDigest, attributionKind: 'unattributed',
        manifestDigests: [], candidateDigests: [], executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

/** Called under the Manager writer transaction before its rollback CAS overwrites original approval fields. */
export function captureMaintenanceProposalApprovalSource(
    proposal: MaintenancePendingProposalRecord, job: PublicMaintenanceJob,
): MaintenanceProposalApprovalSource | null {
    if (proposal.status !== 'applied' || !['operator-approved', 'guarded-auto-approved'].includes(proposal.decisionReason ?? '')) return null;
    if (!canonicalTime(proposal.decidedAt) || proposal.updatedAt !== proposal.decidedAt || !object(proposal.receipt)
        || Object.hasOwn(proposal.receipt, MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE)) {
        throw new Error('maintenance-approval-original-source-invalid');
    }
    const appliedReceiptDigest = digest(proposal.receipt);
    const approval = source(proposal, job, { revision: proposal.revision, occurredAt: proposal.decidedAt,
        decisionReasonDigest: digest(proposal.decisionReason), appliedReceiptDigest });
    return Object.freeze({ version: VERSION, approval, appliedReceiptDigest });
}

/** Absence is historical unknown. Malformed retained metadata is rejected, never repaired from the rollback clock. */
export function maintenanceProposalApprovalEvidenceRecord(
    proposal: MaintenancePendingProposalRecord, job: PublicMaintenanceJob,
): AgentEvidenceProposalApprovalRecordV1 | null {
    if (proposal.status === 'applied') return captureMaintenanceProposalApprovalSource(proposal, job)?.approval ?? null;
    if (proposal.status !== 'rolled_back' || !object(proposal.receipt)
        || !Object.hasOwn(proposal.receipt, MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE)) return null;
    const retained = proposal.receipt[MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE];
    if (!object(retained) || Object.keys(retained).sort().join(',') !== 'appliedReceiptDigest,approval,version'
        || retained.version !== VERSION || typeof retained.appliedReceiptDigest !== 'string') {
        throw new Error('maintenance-approval-retained-source-invalid');
    }
    const approval = normalizeAgentEvidenceProposalApprovalRecord(retained.approval);
    if (!canonicalTime(proposal.decidedAt) || proposal.updatedAt !== proposal.decidedAt
        || proposal.decisionReason !== 'operator-rollback' || approval.occurredAt > proposal.decidedAt
        || approval.proposalRevision + 1 !== proposal.revision) throw new Error('maintenance-approval-retained-source-invalid');
    const expected = source(proposal, job, { revision: approval.proposalRevision, occurredAt: approval.occurredAt,
        decisionReasonDigest: approval.decisionReasonDigest, appliedReceiptDigest: retained.appliedReceiptDigest });
    if (JSON.stringify(expected) !== JSON.stringify(approval)) throw new Error('maintenance-approval-retained-source-mismatch');
    return expected;
}
