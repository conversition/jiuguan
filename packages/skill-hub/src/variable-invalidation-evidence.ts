/** Original rollback of one exact Skill-linked variable application, never a quality verdict. */
import { assertPlainRecord, assertExactKeys, deepFreeze, digestCanonical, isoTimestamp,
    member, safeInteger, sha256Digest, stableToken } from './internal.ts';

export const AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION = 'agent-evidence-variable-invalidation-v1' as const;
export interface AgentEvidenceVariableInvalidationRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'variable-patch-invalidated';
    readonly sessionId: string;
    readonly sourceType: 'variable-patch-apply-invalidation-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly appliedEvidenceId: string;
    readonly appliedRecordDigest: string;
    readonly applyReceiptDigest: string;
    readonly rollbackKind: 'round-delete' | 'regenerate-state-only';
    readonly producerRunId: string;
    readonly round: number;
    readonly occurredAt: string;
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
type Input = Omit<AgentEvidenceVariableInvalidationRecordV1, 'evidenceId'>;
const KEYS = ['recordVersion', 'eventType', 'sessionId', 'sourceType', 'sourceRef', 'sourceDigest',
    'artifactDigest', 'appliedEvidenceId', 'appliedRecordDigest', 'applyReceiptDigest', 'rollbackKind',
    'producerRunId', 'round', 'occurredAt', 'attributionKind', 'manifestDigests', 'candidateDigests',
    'executionClass', 'effectOutcome', 'learningWeight'];
function canonical(value: unknown, field: string, parse: (value: unknown, label: string) => string): string {
    const result = parse(value, `variableInvalidation.${field}`);
    if (result !== value) throw new TypeError('variableInvalidation noncanonical value');
    return result;
}
function core(value: unknown, stored: boolean): Input {
    assertPlainRecord(value, 'variableInvalidation');
    const keys = new Set(stored ? [...KEYS, 'evidenceId'] : KEYS);
    assertExactKeys(value, keys, keys, 'variableInvalidation');
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
            throw new TypeError('variableInvalidation data fields required');
    }
    for (const list of [value.manifestDigests, value.candidateDigests])
        if (!Array.isArray(list) || list.length !== 0 || Reflect.ownKeys(list).length !== 1)
            throw new TypeError('variableInvalidation attribution invalid');
    if (!Object.is(value.learningWeight, 0) || Object.is(value.round, -0))
        throw new TypeError('variableInvalidation weight invalid');
    return deepFreeze({
        recordVersion: member(value.recordVersion, [AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION], 'version'),
        eventType: member(value.eventType, ['variable-patch-invalidated'], 'eventType'),
        sessionId: canonical(value.sessionId, 'sessionId', stableToken),
        sourceType: member(value.sourceType, ['variable-patch-apply-invalidation-v1'], 'sourceType'),
        sourceRef: canonical(value.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonical(value.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonical(value.artifactDigest, 'artifactDigest', sha256Digest),
        appliedEvidenceId: canonical(value.appliedEvidenceId, 'appliedEvidenceId', sha256Digest),
        appliedRecordDigest: canonical(value.appliedRecordDigest, 'appliedRecordDigest', sha256Digest),
        applyReceiptDigest: canonical(value.applyReceiptDigest, 'applyReceiptDigest', sha256Digest),
        rollbackKind: member(value.rollbackKind, ['round-delete', 'regenerate-state-only'], 'rollbackKind'),
        producerRunId: canonical(value.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(value.round, 'round', 1), occurredAt: canonical(value.occurredAt, 'occurredAt', isoTimestamp),
        attributionKind: member(value.attributionKind, ['unattributed'], 'attributionKind'),
        manifestDigests: [], candidateDigests: [], executionClass: member(value.executionClass, ['unknown'], 'executionClass'),
        effectOutcome: member(value.effectOutcome, ['unknown'], 'effectOutcome'), learningWeight: 0,
    });
}
export function variableInvalidationEvidenceId(sessionId: string, sourceRef: string): string {
    return digestCanonical({ recordVersion: AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION,
        eventType: 'variable-patch-invalidated', sessionId: canonical(sessionId, 'sessionId', stableToken),
        sourceType: 'variable-patch-apply-invalidation-v1', sourceRef: canonical(sourceRef, 'sourceRef', stableToken) });
}
function identity(input: Input): string { return variableInvalidationEvidenceId(input.sessionId, input.sourceRef); }
export function createAgentEvidenceVariableInvalidationRecord(value: unknown): AgentEvidenceVariableInvalidationRecordV1 {
    const input = core(value, false); return deepFreeze({ ...input, evidenceId: identity(input) });
}
export function normalizeAgentEvidenceVariableInvalidationRecord(value: unknown): AgentEvidenceVariableInvalidationRecordV1 {
    const input = core(value, true), evidenceId = (value as Record<string, unknown>).evidenceId;
    if (evidenceId !== identity(input)) throw new TypeError('variableInvalidation identity mismatch');
    return deepFreeze({ ...input, evidenceId: evidenceId as string });
}
