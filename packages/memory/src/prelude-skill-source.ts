/** Retained Prelude request series and bounded tool provenance, never live source or replay authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { agentClosureDigest, agentClosureToken } from '../../agent-closure/index.ts';
import { POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION }
    from '../../agent-policy/public/interactive-policy.ts';
import { parsePreludeSourceManifest } from '../../harness/public/prelude-source.ts';

export const PRELUDE_SKILL_SOURCE_RECEIPT_VERSION = 'prelude-skill-source-receipt-v1' as const;
export interface PreludeSkillSourceReceiptV1 {
    readonly version: typeof PRELUDE_SKILL_SOURCE_RECEIPT_VERSION;
    readonly manifest: ReturnType<typeof parsePreludeSourceManifest>;
    readonly sessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly policyVersion: string;
    readonly requestDigests: readonly string[];
    readonly artifactDigest: string;
    readonly receiptDigest: string;
}
const FIELDS = ['version', 'manifest', 'sessionId', 'runId', 'sourceRevision', 'policyVersion',
    'requestDigests', 'artifactDigest'] as const;
const POLICIES: readonly string[] = [POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION];
function invalid(): never { throw new Error('prelude-skill-source-receipt-invalid'); }
function ownData(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string')
        || JSON.stringify([...keys].sort()) !== JSON.stringify([...fields].sort())) invalid();
    for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    return input as Record<string, unknown>;
}
function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function requests(value: unknown, length?: number): readonly string[] {
    if (!value || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length < 1 || (length !== undefined && value.length !== length)
        || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        return agentClosureDigest(descriptor.value, 'prelude-source-request');
    }));
}
/** Preserve the original ordered series identity; a final request cannot stand in for the series. */
export function preludeSkillSourceEvidenceDigest(requestDigests: readonly string[]): string {
    return digest(['prelude-dispatch-series-v1', requests(requestDigests)]);
}
export function createPreludeSkillSourceReceipt(
    input: Omit<PreludeSkillSourceReceiptV1, 'receiptDigest'>,
): PreludeSkillSourceReceiptV1 {
    try {
        const value = ownData(input, FIELDS);
        if (value.version !== PRELUDE_SKILL_SOURCE_RECEIPT_VERSION
            || typeof value.policyVersion !== 'string' || !POLICIES.includes(value.policyVersion)) invalid();
        const manifest = parsePreludeSourceManifest(value.manifest);
        const core = {
            version: PRELUDE_SKILL_SOURCE_RECEIPT_VERSION, manifest,
            sessionId: agentClosureToken(value.sessionId, 'prelude-source-session'),
            runId: agentClosureToken(value.runId, 'prelude-source-run'),
            sourceRevision: agentClosureToken(value.sourceRevision, 'prelude-source-revision'),
            policyVersion: value.policyVersion,
            requestDigests: requests(value.requestDigests, manifest.steps.length),
            artifactDigest: agentClosureDigest(value.artifactDigest, 'prelude-source-artifact'),
        };
        return Object.freeze({ ...core, receiptDigest: digest(core) });
    } catch { invalid(); }
}
/** Historical validation does not reconstruct text, restore a source window or call a model. */
export function parsePreludeSkillSourceReceipt(input: unknown): PreludeSkillSourceReceiptV1 {
    try {
        const value = ownData(input, [...FIELDS, 'receiptDigest']);
        const parsed = createPreludeSkillSourceReceipt({
            version: value.version as PreludeSkillSourceReceiptV1['version'], manifest: value.manifest as PreludeSkillSourceReceiptV1['manifest'],
            sessionId: value.sessionId as string, runId: value.runId as string, sourceRevision: value.sourceRevision as string,
            policyVersion: value.policyVersion as string, requestDigests: value.requestDigests as readonly string[],
            artifactDigest: value.artifactDigest as string,
        });
        if (agentClosureDigest(value.receiptDigest, 'prelude-source-receipt') !== parsed.receiptDigest) invalid();
        return parsed;
    } catch { invalid(); }
}
