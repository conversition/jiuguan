/** @author Codex @date 2026-10-14 @version 1.0
 * Summary live identity is separate from Memory and never established by parsing disk metadata.
 */
import { createHash } from 'node:crypto';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken,
    normalizeAgentSkillClosureAttribution, type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';

const PROOFS = new WeakSet<object>();

export const MAINTENANCE_SUMMARY_SKILL_PROPOSAL_PROOF_VERSION =
    'maintenance-summary-skill-proposal-v1' as const;

export interface MaintenanceSummarySkillProposalProof {
    readonly proofVersion: typeof MAINTENANCE_SUMMARY_SKILL_PROPOSAL_PROOF_VERSION;
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly sourceDigest: string;
    readonly proposalContextDigest: string;
    readonly attempt: number;
    readonly proposalDigest: string;
    readonly policyVersion: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly requestDigests: readonly string[];
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly proofDigest: string;
}

export function maintenanceSummarySkillDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Parsing is validation only; deserialization cannot grant the process-local live brand. */
export function parseMaintenanceSummarySkillProposalProof(value: unknown): MaintenanceSummarySkillProposalProof {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary-skill-proof-invalid');
    const row = value as MaintenanceSummarySkillProposalProof;
    if (row.proofVersion !== MAINTENANCE_SUMMARY_SKILL_PROPOSAL_PROOF_VERSION
        || !Number.isSafeInteger(row.attempt) || row.attempt < 1
        || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
        || !Array.isArray(row.requestDigests) || row.requestDigests.length < 1 || row.requestDigests.length > 256) {
        throw new Error('summary-skill-proof-invalid');
    }
    const metadata = {
        proofVersion: row.proofVersion,
        runId: agentClosureToken(row.runId, 'run-id'),
        parentRunId: agentClosureToken(row.parentRunId, 'parent-run-id'),
        sessionId: agentClosureToken(row.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(row.sourceRevision, 'source-revision'),
        sourceDigest: agentClosureDigest(row.sourceDigest, 'source-digest'),
        proposalContextDigest: agentClosureDigest(row.proposalContextDigest, 'proposal-context-digest'),
        attempt: row.attempt,
        proposalDigest: agentClosureDigest(row.proposalDigest, 'proposal-digest'),
        policyVersion: agentClosureToken(row.policyVersion, 'policy-version'),
        contentMode: row.contentMode,
        admittedAt: agentClosureTimestamp(row.admittedAt, 'admitted-at'),
        executedAt: agentClosureTimestamp(row.executedAt, 'executed-at'),
        validatedAt: agentClosureTimestamp(row.validatedAt, 'validated-at'),
        requestDigests: Object.freeze(row.requestDigests.map((item) => agentClosureDigest(item, 'request-digest'))),
        attribution: normalizeAgentSkillClosureAttribution(row.attribution),
    };
    const normalized = Object.freeze({ ...metadata, proofDigest: maintenanceSummarySkillDigest(metadata) });
    if (metadata.admittedAt > metadata.executedAt || metadata.executedAt > metadata.validatedAt
        || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('summary-skill-proof-corrupt');
    return normalized;
}

/** Only the trusted Summary producer issues a fresh live proof; durable recovery must use another contract. */
export function sealMaintenanceSummarySkillProposalProof(
    metadata: Omit<MaintenanceSummarySkillProposalProof, 'proofDigest'>,
): MaintenanceSummarySkillProposalProof {
    const proof = parseMaintenanceSummarySkillProposalProof({
        ...metadata, proofDigest: maintenanceSummarySkillDigest(metadata),
    });
    PROOFS.add(proof);
    return proof;
}

export function isMaintenanceSummarySkillProposalProof(value: unknown): value is MaintenanceSummarySkillProposalProof {
    return typeof value === 'object' && value !== null && PROOFS.has(value);
}
