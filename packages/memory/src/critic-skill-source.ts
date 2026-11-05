/** Retained provenance for one actual Critic repair, never source or replay authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { agentClosureDigest, agentClosureToken } from '../../agent-closure/index.ts';
import { parseCriticInputManifest, type CriticInputManifestV1 } from '../../harness/public/critic-input.ts';

export const CRITIC_SKILL_SOURCE_RECEIPT_VERSION = 'critic-skill-source-receipt-v1' as const;

export interface CriticSkillSourceReceiptV1 {
    readonly version: typeof CRITIC_SKILL_SOURCE_RECEIPT_VERSION;
    readonly manifest: CriticInputManifestV1;
    readonly sessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly policyVersion: string;
    /** Original unsanitized owner identity, distinct from manifest.draftDigest. */
    readonly draftDigest: string;
    readonly decisionDigest: string;
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly artifactDigest: string;
    readonly receiptDigest: string;
}

const FIELDS = ['version', 'manifest', 'sessionId', 'runId', 'sourceRevision', 'policyVersion',
    'draftDigest', 'decisionDigest', 'requestDigest', 'responseDigest', 'artifactDigest'] as const;

function invalid(): never { throw new Error('critic-skill-source-receipt-invalid'); }

function ownData(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string')
        || JSON.stringify([...keys].sort()) !== JSON.stringify([...fields].sort())) invalid();
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    }
    return input as Record<string, unknown>;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Preserve the original Critic evidence identity; the manifest attests a separate sanitized input. */
export function criticSkillSourceEvidenceDigest(input: Pick<CriticSkillSourceReceiptV1,
    'draftDigest' | 'decisionDigest' | 'responseDigest'>): string {
    return digest(['critic-revision-v1',
        agentClosureDigest(input.draftDigest, 'critic-source-draft'),
        agentClosureDigest(input.decisionDigest, 'critic-source-decision'),
        agentClosureDigest(input.responseDigest, 'critic-source-response')]);
}

export function createCriticSkillSourceReceipt(
    input: Omit<CriticSkillSourceReceiptV1, 'receiptDigest'>,
): CriticSkillSourceReceiptV1 {
    try {
        const value = ownData(input, FIELDS);
        if (value.version !== CRITIC_SKILL_SOURCE_RECEIPT_VERSION
            || value.policyVersion !== 'p14-precommit-critic-v2') invalid();
        const core = {
            version: CRITIC_SKILL_SOURCE_RECEIPT_VERSION,
            manifest: parseCriticInputManifest(value.manifest),
            sessionId: agentClosureToken(value.sessionId, 'critic-source-session'),
            runId: agentClosureToken(value.runId, 'critic-source-run'),
            sourceRevision: agentClosureToken(value.sourceRevision, 'critic-source-revision'),
            policyVersion: 'p14-precommit-critic-v2',
            draftDigest: agentClosureDigest(value.draftDigest, 'critic-source-draft'),
            decisionDigest: agentClosureDigest(value.decisionDigest, 'critic-source-decision'),
            requestDigest: agentClosureDigest(value.requestDigest, 'critic-source-request'),
            responseDigest: agentClosureDigest(value.responseDigest, 'critic-source-response'),
            artifactDigest: agentClosureDigest(value.artifactDigest, 'critic-source-artifact'),
        };
        return Object.freeze({ ...core, receiptDigest: digest(core) });
    } catch { invalid(); }
}

/** Historical metadata is validated against its own immutable digest, never current configuration. */
export function parseCriticSkillSourceReceipt(input: unknown): CriticSkillSourceReceiptV1 {
    try {
        const value = ownData(input, [...FIELDS, 'receiptDigest']);
        const receipt = createCriticSkillSourceReceipt({
            version: value.version as CriticSkillSourceReceiptV1['version'],
            manifest: value.manifest as CriticInputManifestV1,
            sessionId: value.sessionId as string, runId: value.runId as string,
            sourceRevision: value.sourceRevision as string, policyVersion: value.policyVersion as string,
            draftDigest: value.draftDigest as string, decisionDigest: value.decisionDigest as string,
            requestDigest: value.requestDigest as string, responseDigest: value.responseDigest as string,
            artifactDigest: value.artifactDigest as string,
        });
        if (agentClosureDigest(value.receiptDigest, 'critic-source-receipt') !== receipt.receiptDigest) invalid();
        return receipt;
    } catch { invalid(); }
}
