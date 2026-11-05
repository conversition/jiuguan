/** A compiled draft proof records one successful request, not proposal activation or story effect. */
import { createHash } from 'node:crypto';
import {
    agentClosureDigest, agentClosureTimestamp, normalizeAgentSkillClosureAttribution,
    type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';
import {
    normalizeStyleCompileSkillSourceSnapshot, type StyleCompileSkillSourceSnapshotV1,
} from './style-compile-context.ts';

const PROOFS = new WeakSet<object>();
const USED = new WeakSet<object>();
const FIELDS = Object.freeze([
    'version', 'source', 'requestDigest', 'draftDigest', 'bodyDigest', 'attribution',
    'admittedAt', 'executedAt', 'validatedAt', 'proofDigest',
]);

export interface StyleCompileSkillOutputProofV1 {
    readonly version: 'style-compile-skill-proof-v1';
    readonly source: StyleCompileSkillSourceSnapshotV1;
    readonly requestDigest: string;
    /** Full normalized draft, including name, description, keywords, body and bodyDigest. */
    readonly draftDigest: string;
    readonly bodyDigest: string;
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly proofDigest: string;
}

export function styleCompileSkillProofDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Structural validation supports recovery but never grants the live, process-local brand. */
export function normalizeStyleCompileSkillOutputProof(value: unknown): StyleCompileSkillOutputProofV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== FIELDS.length
        || FIELDS.some((key) => !Object.hasOwn(value, key))) throw new Error('style-compile-skill-proof-invalid');
    const row = value as StyleCompileSkillOutputProofV1;
    if (row.version !== 'style-compile-skill-proof-v1') throw new Error('style-compile-skill-proof-invalid');
    const metadata = {
        version: row.version,
        source: normalizeStyleCompileSkillSourceSnapshot(row.source),
        requestDigest: agentClosureDigest(row.requestDigest, 'style-request-digest'),
        draftDigest: agentClosureDigest(row.draftDigest, 'style-draft-digest'),
        bodyDigest: agentClosureDigest(row.bodyDigest, 'style-body-digest'),
        attribution: normalizeAgentSkillClosureAttribution(row.attribution),
        admittedAt: agentClosureTimestamp(row.admittedAt, 'style-admitted-at'),
        executedAt: agentClosureTimestamp(row.executedAt, 'style-executed-at'),
        validatedAt: agentClosureTimestamp(row.validatedAt, 'style-validated-at'),
    };
    const proof = Object.freeze({ ...metadata, proofDigest: styleCompileSkillProofDigest(metadata) });
    if (metadata.admittedAt > metadata.executedAt || metadata.executedAt > metadata.validatedAt
        || metadata.admittedAt < metadata.source.executionStartedAt || metadata.validatedAt >= metadata.source.leaseExpiresAt
        || metadata.attribution.selectedManifestDigests.length !== 1
        || metadata.attribution.activeCandidateDigests.length !== 0
        || metadata.attribution.validatorOutcome !== 'not-required'
        || JSON.stringify(proof) !== JSON.stringify(value)) throw new Error('style-compile-skill-proof-corrupt');
    return proof;
}

export function sealStyleCompileSkillOutputProof(
    metadata: Omit<StyleCompileSkillOutputProofV1, 'proofDigest'>,
): StyleCompileSkillOutputProofV1 {
    const proof = normalizeStyleCompileSkillOutputProof({
        ...metadata, proofDigest: styleCompileSkillProofDigest(metadata),
    });
    PROOFS.add(proof);
    return proof;
}

/** Copies and recovered metadata cannot regain the one-shot actual-response authority. */
export function takeStyleCompileSkillOutputProof(value: unknown): StyleCompileSkillOutputProofV1 | null {
    if (!value || typeof value !== 'object' || !PROOFS.has(value) || USED.has(value)) return null;
    USED.add(value);
    return value as StyleCompileSkillOutputProofV1;
}
