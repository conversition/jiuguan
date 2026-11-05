/** Original NPC operation write, distinct from batch COMMIT time, approval and later readback. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_NPC_OPERATION_VERSION = 'agent-evidence-npc-operation-v1' as const;
export interface AgentEvidenceNpcOperationRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_NPC_OPERATION_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'npc-operation-committed';
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly capabilityId: 'maintenance.npc';
    readonly sourceType: 'maintenance-npc-skill-source-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly operationKind: 'character' | 'identity';
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
type Input = Omit<AgentEvidenceNpcOperationRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'contentMode', 'capabilityId', 'sourceType',
    'sourceRef', 'sourceDigest', 'artifactDigest', 'operationKind', 'producerRunId', 'requestDigests',
    'occurredAt', 'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, field: string) => string): string {
    const result = parse(value, `npcEvidence.${field}`);
    if (result !== value) throw new TypeError('npcEvidence noncanonical value');
    return result;
}
function digests(value: unknown, field: string, minimum: number, maximum: number, orderedSet: boolean): readonly string[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum
        || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('npcEvidence invalid digest list');
    const output: string[] = [];
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('npcEvidence data list required');
        const digest = canonical(descriptor.value, field, sha256Digest);
        if (orderedSet && i && output[i - 1]! >= digest) throw new TypeError('npcEvidence sorted unique digests required');
        output.push(digest);
    }
    return Object.freeze(output);
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'npcEvidence');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'npcEvidence');
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value'))
            throw new TypeError('npcEvidence data fields required');
    }
    if (!Object.is(value.learningWeight, 0)) throw new TypeError('npcEvidence weight must be zero');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_NPC_OPERATION_VERSION], 'version'),
        eventType: member(value.eventType, ['npc-operation-committed'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        contentMode: member(value.contentMode, ['nsf', 'nsfw'], 'contentMode'),
        capabilityId: member(value.capabilityId, ['maintenance.npc'], 'capabilityId'),
        sourceType: member(value.sourceType, ['maintenance-npc-skill-source-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        operationKind: member(value.operationKind, ['character', 'identity'], 'operationKind'),
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
export function createAgentEvidenceNpcOperationRecord(value: unknown): AgentEvidenceNpcOperationRecordV1 {
    const input = core(value, false);
    return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceNpcOperationRecord(value: unknown): AgentEvidenceNpcOperationRecordV1 {
    const input = core(value, true);
    const evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('npcEvidence identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
