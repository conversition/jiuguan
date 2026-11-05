/** Original Worldbook apply control receipt; not file-replacement time, readback or later consumption. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_WORLDBOOK_APPLY_VERSION = 'agent-evidence-worldbook-apply-v1' as const;
export interface AgentEvidenceWorldbookApplyRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_WORLDBOOK_APPLY_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'worldbook-repair-applied';
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly capabilityId: 'maintenance.worldbook';
    readonly sourceType: 'maintenance-worldbook-skill-source-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly commitReceiptDigest: string;
    readonly producerRunId: string;
    readonly requestDigests: readonly string[];
    readonly occurredAt: string;
    readonly attributionKind: 'skill';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
type Input = Omit<AgentEvidenceWorldbookApplyRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'contentMode', 'capabilityId', 'sourceType',
    'sourceRef', 'sourceDigest', 'artifactDigest', 'commitReceiptDigest', 'producerRunId', 'requestDigests',
    'occurredAt', 'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, field: string) => string): string {
    const result = parse(value, `worldbookEvidence.${field}`);
    if (result !== value) throw new TypeError('worldbookEvidence noncanonical value');
    return result;
}
function digests(value: unknown, field: string, minimum: number, maximum: number, orderedSet: boolean): readonly string[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum
        || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('worldbookEvidence invalid digest list');
    const output: string[] = [];
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('worldbookEvidence data list required');
        const digest = canonical(descriptor.value, field, sha256Digest);
        if (orderedSet && i && output[i - 1]! >= digest) throw new TypeError('worldbookEvidence sorted unique digests required');
        output.push(digest);
    }
    return Object.freeze(output);
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'worldbookEvidence');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'worldbookEvidence');
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value'))
            throw new TypeError('worldbookEvidence data fields required');
    }
    if (!Object.is(value.learningWeight, 0)) throw new TypeError('worldbookEvidence weight must be zero');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_WORLDBOOK_APPLY_VERSION], 'version'),
        eventType: member(value.eventType, ['worldbook-repair-applied'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        contentMode: member(value.contentMode, ['nsf', 'nsfw'], 'contentMode'),
        capabilityId: member(value.capabilityId, ['maintenance.worldbook'], 'capabilityId'),
        sourceType: member(value.sourceType, ['maintenance-worldbook-skill-source-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        commitReceiptDigest: canonical(value.commitReceiptDigest, 'commitReceiptDigest', sha256Digest),
        producerRunId: canonical(value.producerRunId, 'producerRunId', stableToken),
        requestDigests: digests(value.requestDigests, 'requestDigests', 1, 256, false),
        occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['skill'], 'attributionKind'),
        manifestDigests: digests(value.manifestDigests, 'manifestDigests', 1, 64, true),
        candidateDigests: digests(value.candidateDigests, 'candidateDigests', 0, 64, true),
        executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
    });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidenceWorldbookApplyRecord(value: unknown): AgentEvidenceWorldbookApplyRecordV1 {
    const input = core(value, false);
    return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceWorldbookApplyRecord(value: unknown): AgentEvidenceWorldbookApplyRecordV1 {
    const input = core(value, true);
    const evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('worldbookEvidence identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
