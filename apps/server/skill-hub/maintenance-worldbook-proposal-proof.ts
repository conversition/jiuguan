/** @author Codex @date 2026-10-14 @version 1.0
 * Live identity and strict durable parsing are separate trust boundaries.
 */
import { createHash } from 'node:crypto';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken,
    normalizeAgentSkillClosureAttribution, type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';

const PROOFS = new WeakSet<object>();

export const MAINTENANCE_WORLDBOOK_SKILL_PROPOSAL_PROOF_VERSION =
    'maintenance-worldbook-skill-proposal-v1' as const;

export interface MaintenanceWorldbookSkillProposalProof {
    readonly proofVersion: typeof MAINTENANCE_WORLDBOOK_SKILL_PROPOSAL_PROOF_VERSION;
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly sourceDigest: string;
    readonly proposalContextDigest: string;
    readonly providerProposalContextDigest: string;
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

export function maintenanceWorldbookSkillDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Parsing disk metadata never grants the brand needed to enqueue fresh live evidence. */
export function parseMaintenanceWorldbookSkillProposalProof(value: unknown): MaintenanceWorldbookSkillProposalProof {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worldbook-skill-proof-invalid');
    const row = value as MaintenanceWorldbookSkillProposalProof;
    if (row.proofVersion !== MAINTENANCE_WORLDBOOK_SKILL_PROPOSAL_PROOF_VERSION
        || !Number.isSafeInteger(row.attempt) || row.attempt < 1
        || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
        || !Array.isArray(row.requestDigests) || row.requestDigests.length < 1 || row.requestDigests.length > 256) {
        throw new Error('worldbook-skill-proof-invalid');
    }
    const metadata = {
        proofVersion: row.proofVersion,
        runId: agentClosureToken(row.runId, 'run-id'),
        parentRunId: agentClosureToken(row.parentRunId, 'parent-run-id'),
        sessionId: agentClosureToken(row.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(row.sourceRevision, 'source-revision'),
        sourceDigest: agentClosureDigest(row.sourceDigest, 'source-digest'),
        proposalContextDigest: agentClosureDigest(row.proposalContextDigest, 'proposal-context-digest'),
        providerProposalContextDigest: agentClosureDigest(row.providerProposalContextDigest, 'provider-proposal-context-digest'),
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
    const normalized = Object.freeze({ ...metadata, proofDigest: maintenanceWorldbookSkillDigest(metadata) });
    if (metadata.admittedAt > metadata.executedAt || metadata.executedAt > metadata.validatedAt
        || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('worldbook-skill-proof-corrupt');
    return normalized;
}

/** Trusted producer only; storage/replay callers cannot mint a live proof by deserialization. */
export function sealMaintenanceWorldbookSkillProposalProof(
    metadata: Omit<MaintenanceWorldbookSkillProposalProof, 'proofDigest'>,
): MaintenanceWorldbookSkillProposalProof {
    const proof = parseMaintenanceWorldbookSkillProposalProof({
        ...metadata, proofDigest: maintenanceWorldbookSkillDigest(metadata),
    });
    PROOFS.add(proof);
    return proof;
}

export function isMaintenanceWorldbookSkillProposalProof(value: unknown): value is MaintenanceWorldbookSkillProposalProof {
    return typeof value === 'object' && value !== null && PROOFS.has(value);
}
