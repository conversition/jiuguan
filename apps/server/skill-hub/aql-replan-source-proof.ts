/** One successful AQL Skill request; never evidence of story adoption or independent quality. */
import { createHash } from 'node:crypto';
import {
    agentClosureDigest, agentClosureTimestamp, normalizeAgentSkillClosureAttribution,
    type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';
import {
    normalizeAqlReplanSkillSourceSnapshot, type AqlReplanSkillSourceSnapshotV1,
} from './aql-replan-context.ts';

export interface AqlReplanSkillOutputProofV1 {
    readonly version: 'aql-replan-skill-proof-v1';
    readonly source: AqlReplanSkillSourceSnapshotV1;
    readonly requestDigest: string;
    /** The original Session trim/slice output, without its text. */
    readonly outputDigest: string;
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly proofDigest: string;
}
const FIELDS = Object.freeze(['version', 'source', 'requestDigest', 'outputDigest', 'attribution',
    'admittedAt', 'executedAt', 'validatedAt', 'proofDigest']);
const PROOFS = new WeakSet<object>(), USED = new WeakSet<object>();
export function aqlReplanSkillProofDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
export function normalizeAqlReplanSkillOutputProof(value: unknown): AqlReplanSkillOutputProofV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('aql-replan-skill-proof-invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== FIELDS.length || FIELDS.some((key) => {
        const field = descriptors[key];
        return !field || !field.enumerable || !Object.hasOwn(field, 'value');
    })) throw new Error('aql-replan-skill-proof-invalid');
    const row = value as AqlReplanSkillOutputProofV1;
    if (row.version !== 'aql-replan-skill-proof-v1') throw new Error('aql-replan-skill-proof-invalid');
    const base = {
        version: row.version, source: normalizeAqlReplanSkillSourceSnapshot(row.source),
        requestDigest: agentClosureDigest(row.requestDigest, 'aql-skill-request'),
        outputDigest: agentClosureDigest(row.outputDigest, 'aql-skill-output'),
        attribution: normalizeAgentSkillClosureAttribution(row.attribution),
        admittedAt: agentClosureTimestamp(row.admittedAt, 'aql-skill-admitted-at'),
        executedAt: agentClosureTimestamp(row.executedAt, 'aql-skill-executed-at'),
        validatedAt: agentClosureTimestamp(row.validatedAt, 'aql-skill-validated-at'),
    };
    const proof = Object.freeze({ ...base, proofDigest: aqlReplanSkillProofDigest(base) });
    if (base.admittedAt > base.executedAt || base.executedAt > base.validatedAt
        || base.attribution.selectedManifestDigests.length !== 1
        || base.attribution.activeCandidateDigests.length !== 0 || base.attribution.validatorOutcome !== 'not-required'
        || JSON.stringify(proof) !== JSON.stringify(value)) throw new Error('aql-replan-skill-proof-corrupt');
    return proof;
}
export function sealAqlReplanSkillOutputProof(input: Omit<AqlReplanSkillOutputProofV1, 'proofDigest'>) {
    const normalized = normalizeAqlReplanSkillOutputProof({ ...input, proofDigest: aqlReplanSkillProofDigest(input) });
    // Keep the captured source identity for the immediate native receipt write.
    // Structural normalization alone remains metadata-only on recovery.
    const proof = Object.freeze({ ...normalized, source: input.source });
    PROOFS.add(proof);
    return proof;
}
/** Copies and durable metadata never regain this one-use execution brand. */
export function takeAqlReplanSkillOutputProof(value: unknown): AqlReplanSkillOutputProofV1 | null {
    if (!value || typeof value !== 'object' || !PROOFS.has(value) || USED.has(value)) return null;
    USED.add(value);
    return value as AqlReplanSkillOutputProofV1;
}
