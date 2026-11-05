/** @author Codex @date 2026-10-28 @version 1.0
 * Live identity and strict durable parsing are separate trust boundaries.
 */
import { createHash } from 'node:crypto';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken,
    normalizeAgentSkillClosureAttribution, type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';

const PROOFS = new WeakSet<object>();

export const MAINTENANCE_NPC_SKILL_RESULT_PROOF_VERSION =
    'maintenance-npc-skill-result-v1' as const;

export interface MaintenanceNpcSkillResultProof {
    readonly proofVersion: typeof MAINTENANCE_NPC_SKILL_RESULT_PROOF_VERSION;
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly sourceDigest: string;
    readonly proposalContextDigest: string;
    readonly providerProposalContextDigest: string;
    readonly attempt: number;
    readonly terminalKind: 'proposal' | 'noop';
    readonly terminalDigest: string;
    readonly policyVersion: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly requestDigests: readonly string[];
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly proofDigest: string;
}

export function maintenanceNpcSkillDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Parsing disk metadata never grants the brand needed to enqueue fresh live evidence. */
export function parseMaintenanceNpcSkillResultProof(value: unknown): MaintenanceNpcSkillResultProof {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('npc-skill-proof-invalid');
    const row = value as MaintenanceNpcSkillResultProof;
    if (row.proofVersion !== MAINTENANCE_NPC_SKILL_RESULT_PROOF_VERSION
        || (row.terminalKind !== 'proposal' && row.terminalKind !== 'noop')
        || !Number.isSafeInteger(row.attempt) || row.attempt < 1
        || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
        || !Array.isArray(row.requestDigests) || row.requestDigests.length < 1 || row.requestDigests.length > 256) {
        throw new Error('npc-skill-proof-invalid');
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
        terminalKind: row.terminalKind,
        terminalDigest: agentClosureDigest(row.terminalDigest, 'terminal-digest'),
        policyVersion: agentClosureToken(row.policyVersion, 'policy-version'),
        contentMode: row.contentMode,
        admittedAt: agentClosureTimestamp(row.admittedAt, 'admitted-at'),
        executedAt: agentClosureTimestamp(row.executedAt, 'executed-at'),
        validatedAt: agentClosureTimestamp(row.validatedAt, 'validated-at'),
        requestDigests: Object.freeze(row.requestDigests.map((item) => agentClosureDigest(item, 'request-digest'))),
        attribution: normalizeAgentSkillClosureAttribution(row.attribution),
    };
    const normalized = Object.freeze({ ...metadata, proofDigest: maintenanceNpcSkillDigest(metadata) });
    if (metadata.admittedAt > metadata.executedAt || metadata.executedAt > metadata.validatedAt
        || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('npc-skill-proof-corrupt');
    return normalized;
}

/** Trusted producer only; storage/replay callers cannot mint a live proof by deserialization. */
export function sealMaintenanceNpcSkillResultProof(
    metadata: Omit<MaintenanceNpcSkillResultProof, 'proofDigest'>,
): MaintenanceNpcSkillResultProof {
    const proof = parseMaintenanceNpcSkillResultProof({
        ...metadata, proofDigest: maintenanceNpcSkillDigest(metadata),
    });
    PROOFS.add(proof);
    return proof;
}

export function isMaintenanceNpcSkillResultProof(value: unknown): value is MaintenanceNpcSkillResultProof {
    return typeof value === 'object' && value !== null && PROOFS.has(value);
}
