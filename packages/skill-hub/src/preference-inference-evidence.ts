/** Original Preference inference receipt; no confirmed preference or quality verdict. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, safeInteger, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_PREFERENCE_INFERENCE_VERSION = 'agent-evidence-preference-inference-v1' as const;
export interface AgentEvidencePreferenceInferenceRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_PREFERENCE_INFERENCE_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'preference-inference-recorded';
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly capabilityId: 'learning.preference';
    readonly sourceType: 'learning-preference-skill-source-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly requestDigest: string;
    readonly producerRunId: string;
    readonly round: number;
    readonly occurredAt: string;
    readonly attributionKind: 'skill';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
    readonly adoption: 'not-applicable';
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
}
type Input = Omit<AgentEvidencePreferenceInferenceRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'contentMode', 'capabilityId', 'sourceType',
    'sourceRef', 'sourceDigest', 'artifactDigest', 'requestDigest', 'producerRunId', 'round', 'occurredAt',
    'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight', 'adoption', 'authorizesExecution', 'authorizesPromotion'];
function canonical(value: unknown, field: string, parse: (value: unknown, field: string) => string): string {
    const result = parse(value, `preferenceEvidence.${field}`);
    if (result !== value) throw new TypeError('preferenceEvidence noncanonical value');
    return result;
}
function digests(value: unknown, field: string, minimum: number, maximum: number, orderedSet: boolean): readonly string[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum
        || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('preferenceEvidence invalid digest list');
    const output: string[] = [];
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('preferenceEvidence data list required');
        const digest = canonical(descriptor.value, field, sha256Digest);
        if (orderedSet && i && output[i - 1]! >= digest) throw new TypeError('preferenceEvidence sorted unique digests required');
        output.push(digest);
    }
    return Object.freeze(output);
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'preferenceEvidence');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'preferenceEvidence');
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value'))
            throw new TypeError('preferenceEvidence data fields required');
    }

    if (value.authorizesExecution !== false || value.authorizesPromotion !== false
        || !Object.is(value.learningWeight, 0) || Object.is(value.round, -0))
        throw new TypeError('preferenceEvidence attribution invalid');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_PREFERENCE_INFERENCE_VERSION], 'version'),
        eventType: member(value.eventType, ['preference-inference-recorded'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        contentMode: member(value.contentMode, ['nsf', 'nsfw'], 'contentMode'),
        capabilityId: member(value.capabilityId, ['learning.preference'], 'capabilityId'),
        sourceType: member(value.sourceType, ['learning-preference-skill-source-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        requestDigest: canonical(value.requestDigest, 'requestDigest', sha256Digest),
        producerRunId: canonical(value.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(value.round, 'round', 1), occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['skill'], 'attributionKind'),
        manifestDigests: digests(value.manifestDigests, 'manifestDigests', 1, 64, true),
        candidateDigests: digests(value.candidateDigests, 'candidateDigests', 0, 64, true),
        executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
        adoption: member(value.adoption, ['not-applicable'], 'adoption'), authorizesExecution: false, authorizesPromotion: false,
    });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidencePreferenceInferenceRecord(value: unknown): AgentEvidencePreferenceInferenceRecordV1 {
    const input = core(value, false);
    return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidencePreferenceInferenceRecord(value: unknown): AgentEvidencePreferenceInferenceRecordV1 {
    const input = core(value, true);
    const evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('preferenceEvidence identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
