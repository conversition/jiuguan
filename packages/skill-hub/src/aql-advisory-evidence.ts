/** Original AQL advisory receipt; no story adoption, execution authority or quality verdict. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, safeInteger, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_AQL_ADVISORY_VERSION = 'agent-evidence-aql-advisory-v1' as const;
export interface AgentEvidenceAqlAdvisoryRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_AQL_ADVISORY_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'aql-advisory-recorded';
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly capabilityId: 'interactive.aqlReplan';
    readonly sourceType: 'aql-replan-skill-source-receipt-v1';
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
type Input = Omit<AgentEvidenceAqlAdvisoryRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'contentMode', 'capabilityId', 'sourceType',
    'sourceRef', 'sourceDigest', 'artifactDigest', 'requestDigest', 'producerRunId', 'round', 'occurredAt',
    'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight', 'adoption', 'authorizesExecution', 'authorizesPromotion'];
function canonical(value: unknown, field: string, parse: (value: unknown, field: string) => string): string {
    const result = parse(value, `aqlEvidence.${field}`);
    if (result !== value) throw new TypeError('aqlEvidence noncanonical value');
    return result;
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'aqlEvidence');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'aqlEvidence');
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value'))
            throw new TypeError('aqlEvidence data fields required');
    }
    const manifests = value.manifestDigests, candidates = value.candidateDigests;
    if (value.authorizesExecution !== false || value.authorizesPromotion !== false
        || !Array.isArray(manifests) || manifests.length !== 1 || Reflect.ownKeys(manifests).length !== 2
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(manifests, '0') ?? {}, 'value')
        || !Array.isArray(candidates) || candidates.length !== 0 || Reflect.ownKeys(candidates).length !== 1
        || !Object.is(value.learningWeight, 0) || Object.is(value.round, -0))
        throw new TypeError('aqlEvidence attribution invalid');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_AQL_ADVISORY_VERSION], 'version'),
        eventType: member(value.eventType, ['aql-advisory-recorded'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        contentMode: member(value.contentMode, ['nsf', 'nsfw'], 'contentMode'),
        capabilityId: member(value.capabilityId, ['interactive.aqlReplan'], 'capabilityId'),
        sourceType: member(value.sourceType, ['aql-replan-skill-source-receipt-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        requestDigest: canonical(value.requestDigest, 'requestDigest', sha256Digest),
        producerRunId: canonical(value.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(value.round, 'round', 1), occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['skill'], 'attributionKind'),
        manifestDigests: [canonical(manifests[0], 'manifestDigest', sha256Digest)], candidateDigests: [],
        executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
        adoption: member(value.adoption, ['not-applicable'], 'adoption'), authorizesExecution: false, authorizesPromotion: false,
    });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidenceAqlAdvisoryRecord(value: unknown): AgentEvidenceAqlAdvisoryRecordV1 {
    const input = core(value, false);
    return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceAqlAdvisoryRecord(value: unknown): AgentEvidenceAqlAdvisoryRecordV1 {
    const input = core(value, true);
    const evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('aqlEvidence identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
