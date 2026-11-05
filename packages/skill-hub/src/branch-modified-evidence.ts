/** Submitted text differs from an explicitly referenced branch; no inferred edit time or quality. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, safeInteger, sha256Digest, stableToken } from './internal.ts';
export const AGENT_EVIDENCE_BRANCH_MODIFIED_VERSION = 'agent-evidence-branch-modified-v1' as const;
export interface AgentEvidenceBranchModifiedRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_BRANCH_MODIFIED_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'branch-selection-modified-submitted';
    readonly sessionId: string;
    readonly cardId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly sourceType: 'session-branch-selection-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly producerRunId: string | null;
    readonly round: number;
    readonly occurredAt: string;
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
type Input = Omit<AgentEvidenceBranchModifiedRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'cardId', 'contentMode', 'sourceType', 'sourceRef',
    'sourceDigest', 'artifactDigest', 'producerRunId', 'round', 'occurredAt', 'attributionKind',
    'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, label: string) => string): string {
    const result = parse(value, `branchModified.${field}`);
    if (result !== value) throw new TypeError('branchModified noncanonical value');
    return result;
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'branchModified');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'branchModified');
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
            throw new TypeError('branchModified data fields required');
    }
    for (const list of [value.manifestDigests, value.candidateDigests])
        if (!Array.isArray(list) || list.length !== 0 || Reflect.ownKeys(list).length !== 1)
            throw new TypeError('branchModified attribution invalid');
    if (!Object.is(value.learningWeight, 0) || Object.is(value.round, -0)) throw new TypeError('branchModified weight invalid');
    return deepFreeze({ recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_BRANCH_MODIFIED_VERSION], 'version'),
        eventType: member(value.eventType, ['branch-selection-modified-submitted'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken), cardId: canonical(value.cardId, 'cardId', stableToken),
        contentMode: member(value.contentMode, ['nsf', 'nsfw'], 'contentMode'),
        sourceType: member(value.sourceType, ['session-branch-selection-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken), sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        producerRunId: value.producerRunId === null ? null : canonical(value.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(value.round, 'round', 2), occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['unattributed'], 'attributionKind'),
        manifestDigests: [], candidateDigests: [], executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0 });
}
function identity(input: Input): string {
    return digestCanonical({ recordVersion: input.recordVersion, eventType: input.eventType,
        sessionId: input.sessionId, sourceType: input.sourceType, sourceRef: input.sourceRef });
}
export function createAgentEvidenceBranchModifiedRecord(value: unknown): AgentEvidenceBranchModifiedRecordV1 {
    const input = core(value, false); return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceBranchModifiedRecord(value: unknown): AgentEvidenceBranchModifiedRecordV1 {
    const input = core(value, true), evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('branchModified identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
