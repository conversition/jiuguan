/** Original deterministic Scene Skill consumption; no inferred card identity or quality verdict. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, safeInteger, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_SCENE_CONSUMPTION_VERSION = 'agent-evidence-scene-consumption-v1' as const;
export interface AgentEvidenceSceneConsumptionRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_SCENE_CONSUMPTION_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'scene-skill-consumed';
    readonly sessionId: string;
    readonly contentMode: 'nsfw';
    readonly capabilityId: 'maintenance.nsfwScene';
    readonly sourceType: 'nsfw-scene-skill-receipt-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly requestDigest: string;
    readonly consumerRunId: string;
    readonly round: number;
    readonly occurredAt: string;
    readonly attributionKind: 'skill';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
type Input = Omit<AgentEvidenceSceneConsumptionRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'contentMode', 'capabilityId', 'sourceType',
    'sourceRef', 'sourceDigest', 'artifactDigest', 'requestDigest', 'consumerRunId', 'round', 'occurredAt',
    'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, field: string) => string): string {
    const result = parse(value, `sceneEvidence.${field}`);
    if (result !== value) throw new TypeError('sceneEvidence noncanonical value');
    return result;
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'sceneEvidence');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'sceneEvidence');
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value'))
            throw new TypeError('sceneEvidence data fields required');
    }
    const manifests = value.manifestDigests, candidates = value.candidateDigests;
    if (!Array.isArray(manifests) || manifests.length !== 1 || Reflect.ownKeys(manifests).length !== 2
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(manifests, '0') ?? {}, 'value')
        || !Array.isArray(candidates) || candidates.length !== 0 || Reflect.ownKeys(candidates).length !== 1
        || !Object.is(value.learningWeight, 0) || Object.is(value.round, -0))
        throw new TypeError('sceneEvidence attribution invalid');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_SCENE_CONSUMPTION_VERSION], 'version'),
        eventType: member(value.eventType, ['scene-skill-consumed'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        contentMode: member(value.contentMode, ['nsfw'], 'contentMode'),
        capabilityId: member(value.capabilityId, ['maintenance.nsfwScene'], 'capabilityId'),
        sourceType: member(value.sourceType, ['nsfw-scene-skill-receipt-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        requestDigest: canonical(value.requestDigest, 'requestDigest', sha256Digest),
        consumerRunId: canonical(value.consumerRunId, 'consumerRunId', stableToken),
        round: safeInteger(value.round, 'round', 1), occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['skill'], 'attributionKind'),
        manifestDigests: [canonical(manifests[0], 'manifestDigest', sha256Digest)], candidateDigests: [],
        executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
    });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidenceSceneConsumptionRecord(value: unknown): AgentEvidenceSceneConsumptionRecordV1 {
    const input = core(value, false);
    return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceSceneConsumptionRecord(value: unknown): AgentEvidenceSceneConsumptionRecordV1 {
    const input = core(value, true);
    const evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('sceneEvidence identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
