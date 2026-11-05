/** Original Closure observation, not an independent quality verdict or a learning signal. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_REPORTED_EFFECT_VERSION = 'agent-evidence-reported-effect-v1' as const;
export interface AgentEvidenceReportedEffectRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_REPORTED_EFFECT_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'reported-effect-observed';
    readonly sessionId: string;
    readonly capabilityId: string;
    readonly sourceType: 'agent-closure-effect-observed-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly consumerRunId: string;
    readonly occurredAt: string;
    readonly reportedOutcome: 'positive' | 'negative' | 'neutral' | 'inconclusive';
    readonly independentOutcome: 'unknown';
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
type Input = Omit<AgentEvidenceReportedEffectRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'capabilityId', 'sourceType', 'sourceRef', 'sourceDigest',
    'artifactDigest', 'consumerRunId', 'occurredAt', 'reportedOutcome', 'independentOutcome', 'attributionKind',
    'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, label: string) => string): string {
    const result = parse(value, `reportedEffect.${field}`);
    if (result !== value) throw new TypeError('reportedEffect noncanonical value');
    return result;
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'reportedEffect');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'reportedEffect');
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
            throw new TypeError('reportedEffect data fields required');
    }
    for (const list of [value.manifestDigests, value.candidateDigests])
        if (!Array.isArray(list) || list.length !== 0 || Reflect.ownKeys(list).length !== 1)
            throw new TypeError('reportedEffect attribution invalid');
    if (!Object.is(value.learningWeight, 0)) throw new TypeError('reportedEffect weight invalid');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_REPORTED_EFFECT_VERSION], 'version'),
        eventType: member(value.eventType, ['reported-effect-observed'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        capabilityId: canonical(value.capabilityId, 'capabilityId', stableToken),
        sourceType: member(value.sourceType, ['agent-closure-effect-observed-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        consumerRunId: canonical(value.consumerRunId, 'consumerRunId', stableToken),
        occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        reportedOutcome: member(value.reportedOutcome, ['positive', 'negative', 'neutral', 'inconclusive'], 'reportedOutcome'),
        independentOutcome: member(value.independentOutcome, ['unknown'], 'independentOutcome'),
        attributionKind: member(value.attributionKind, ['unattributed'], 'attributionKind'),
        manifestDigests: [], candidateDigests: [], executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
    });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidenceReportedEffectRecord(value: unknown): AgentEvidenceReportedEffectRecordV1 {
    const input = core(value, false); return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceReportedEffectRecord(value: unknown): AgentEvidenceReportedEffectRecordV1 {
    const input = core(value, true), evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('reportedEffect identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
