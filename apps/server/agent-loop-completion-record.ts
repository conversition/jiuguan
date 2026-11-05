/** Content-free completion audit records. Persistence never grants completion authority. */
import { createHash } from 'node:crypto';
import type { AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { AGENT_LOOP_COMPLETION_GATE_VERSION, AGENT_LOOP_COMPLETION_REASON_CODES,
    type AgentLoopCompletionCandidate, type AgentLoopCompletionVerdictResult,
    type AgentLoopVerifierResult } from './agent-loop-completion-gate.ts';
import type { AgentLoopArtifactRefRecord } from './agent-loop-projection-store.ts';
import { normalizeAgentLoopActionObject as object, normalizeAgentLoopActionToken as token,
    normalizeAgentLoopActionDigest as digest } from './agent-loop-action-receipt.ts';

export const AGENT_LOOP_COMPLETION_CANDIDATE_RECORD_VERSION = 'agent-loop-completion-candidate-record-v1' as const;
export const AGENT_LOOP_COMPLETION_VERIFICATION_RECORD_VERSION = 'agent-loop-completion-verification-record-v1' as const;
export interface StoredAgentLoopCompletionCandidate extends AgentLoopCompletionCandidate {
    readonly recordVersion: typeof AGENT_LOOP_COMPLETION_CANDIDATE_RECORD_VERSION;
    readonly snapshotDigest: string;
    readonly frozenDigest: string;
    readonly envelopeDigest: string;
    readonly taskKind: string;
    readonly taskContractRef: string;
    readonly verifierSetRef: string;
    readonly verifierSetRevision: string;
    readonly artifacts: AgentLoopTaskEnvelopeV1['artifacts'];
    readonly artifactDescriptors: readonly AgentLoopArtifactRefRecord[];
    readonly missingArtifactRefs: readonly string[];
    readonly artifactsDigest: string;
    readonly eventsDigest: string;
    readonly observationsDigest: string;
    readonly receiptsDigest: string;
    readonly unknownEffectActionIds: readonly string[];
}
export interface StoredAgentLoopCompletionVerification {
    readonly recordVersion: typeof AGENT_LOOP_COMPLETION_VERIFICATION_RECORD_VERSION;
    readonly taskId: string;
    readonly candidateRef: string;
    readonly candidateDigest: string;
    readonly taskRevision: number;
    readonly verificationResultRef: string;
    readonly evaluation: AgentLoopCompletionVerdictResult;
    readonly verifiedAt: string;
    readonly verificationDigest: string;
}
export type AgentLoopCompletionSnapshot = Omit<StoredAgentLoopCompletionCandidate,
    'recordVersion' | 'candidateRef' | 'createdAt' | 'snapshotDigest' | 'frozenDigest'>;
function invalid(): never { throw new Error('agent-loop-completion-record-invalid'); }
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
}
export function agentLoopCompletionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
function time(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
    return value;
}
function revision(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(); return Number(value);
}
function list<T>(value: unknown, normalize: (value: unknown) => T, max: number): readonly T[] {
    if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) {
        const field = Object.getOwnPropertyDescriptor(value, String(i));
        if (!field || !Object.hasOwn(field, 'value')) invalid(); out.push(normalize(field.value));
    }
    return Object.freeze(out);
}
function refs(value: unknown, max = 256, unique = true): readonly string[] {
    const out = list(value, token, max); if (unique && new Set(out).size !== out.length) invalid(); return out;
}
function artifact(value: unknown): AgentLoopTaskEnvelopeV1['artifacts'][number] {
    const v = object(value, ['artifactRef', 'kind', 'status', 'evidenceRefs']);
    if (typeof v.status !== 'string' || !['declared', 'available', 'verified', 'invalidated'].includes(v.status)) invalid();
    return Object.freeze({ artifactRef: token(v.artifactRef), kind: token(v.kind),
        status: v.status as AgentLoopTaskEnvelopeV1['artifacts'][number]['status'], evidenceRefs: refs(v.evidenceRefs, 64) });
}
function descriptor(value: unknown): AgentLoopArtifactRefRecord {
    const v = object(value, ['refId', 'kind', 'ownerRef', 'expectedDigest', 'policy', 'aclClass', 'expandBudgetTokens',
        'taskRevision', 'registeredAt'], ['expectedRevision']);
    if (typeof v.kind !== 'string' || !['closure-receipt', 'evidence-ledger', 'candidate', 'session-artifact', 'memory-record', 'memory-fact', 'rolling-summary',
        'worldbook-asset', 'skill-package', 'tool-result'].includes(v.kind)
        || v.policy !== 'required' && v.policy !== 'optional'
        || typeof v.aclClass !== 'string' || !['task', 'session', 'owner', 'restricted'].includes(v.aclClass)
        || !Number.isSafeInteger(v.expandBudgetTokens) || Number(v.expandBudgetTokens) < 0 || Number(v.expandBudgetTokens) > 65_536) invalid();
    return Object.freeze({ refId: token(v.refId), kind: v.kind as AgentLoopArtifactRefRecord['kind'], ownerRef: token(v.ownerRef),
        expectedDigest: digest(v.expectedDigest), ...(v.expectedRevision === undefined ? {} : { expectedRevision: token(v.expectedRevision) }),
        policy: v.policy, aclClass: v.aclClass as AgentLoopArtifactRefRecord['aclClass'], expandBudgetTokens: Number(v.expandBudgetTokens),
        taskRevision: revision(v.taskRevision), registeredAt: time(v.registeredAt) });
}
const SNAPSHOT_FIELDS = ['taskId', 'attemptId', 'taskRevision', 'envelopeDigest', 'taskKind', 'taskContractRef',
    'verifierSetRef', 'verifierSetRevision', 'artifactRefs', 'artifacts', 'artifactDescriptors', 'missingArtifactRefs',
    'artifactsDigest', 'eventsDigest', 'observationsDigest', 'receiptsDigest', 'actionWatermark', 'unknownEffectActionIds'] as const;
function snapshot(input: unknown): AgentLoopCompletionSnapshot {
    const v = object(input, SNAPSHOT_FIELDS);
    const artifacts = list(v.artifacts, artifact, 256), artifactDescriptors = list(v.artifactDescriptors, descriptor, 4096);
    const artifactRefs = refs(v.artifactRefs), missingArtifactRefs = refs(v.missingArtifactRefs);
    const taskRevision = revision(v.taskRevision);
    if (new Set(artifacts.map(item => item.artifactRef)).size !== artifacts.length
        || new Set(artifactDescriptors.map(item => item.refId)).size !== artifactDescriptors.length
        || artifactDescriptors.some(item => item.taskRevision > taskRevision)
        || JSON.stringify(artifactRefs) !== JSON.stringify(artifacts.map(item => item.artifactRef))
        || JSON.stringify(missingArtifactRefs) !== JSON.stringify(artifactRefs.filter(ref => !artifactDescriptors.some(item => item.refId === ref)))
        || digest(v.artifactsDigest) !== agentLoopCompletionDigest({ artifacts, artifactDescriptors })) invalid();
    return Object.freeze({ taskId: token(v.taskId), attemptId: token(v.attemptId), taskRevision,
        envelopeDigest: digest(v.envelopeDigest), taskKind: token(v.taskKind), taskContractRef: token(v.taskContractRef),
        verifierSetRef: token(v.verifierSetRef), verifierSetRevision: token(v.verifierSetRevision), artifacts, artifactDescriptors,
        artifactRefs, missingArtifactRefs, artifactsDigest: digest(v.artifactsDigest), eventsDigest: digest(v.eventsDigest),
        observationsDigest: digest(v.observationsDigest), receiptsDigest: digest(v.receiptsDigest),
        actionWatermark: v.actionWatermark === null ? null : token(v.actionWatermark), unknownEffectActionIds: refs(v.unknownEffectActionIds, 4096) });
}
export function createStoredAgentLoopCompletionCandidate(input: AgentLoopCompletionSnapshot, createdAt: string): StoredAgentLoopCompletionCandidate {
    const normalized = snapshot(input), snapshotDigest = agentLoopCompletionDigest(normalized);
    const at = time(createdAt);
    if (normalized.artifactDescriptors.some(item => Date.parse(item.registeredAt) > Date.parse(at))) invalid();
    const base = Object.freeze({ recordVersion: AGENT_LOOP_COMPLETION_CANDIDATE_RECORD_VERSION,
        ...normalized, snapshotDigest, candidateRef: `completion-candidate:${snapshotDigest.slice(7)}`, createdAt: at });
    return Object.freeze({ ...base, frozenDigest: agentLoopCompletionDigest(base) });
}
export function normalizeStoredAgentLoopCompletionCandidate(input: unknown): StoredAgentLoopCompletionCandidate {
    const v = object(input, [...SNAPSHOT_FIELDS, 'recordVersion', 'snapshotDigest', 'candidateRef', 'createdAt', 'frozenDigest']);
    const base = createStoredAgentLoopCompletionCandidate(Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key, v[key]])) as unknown as AgentLoopCompletionSnapshot,
        time(v.createdAt));
    if (v.recordVersion !== base.recordVersion || v.candidateRef !== base.candidateRef || v.snapshotDigest !== base.snapshotDigest
        || v.frozenDigest !== base.frozenDigest) invalid();
    return base;
}
function verifierResult(input: unknown): AgentLoopVerifierResult {
    const v = object(input, ['verifierId', 'disposition', 'reasonCodes', 'evidenceRefs']);
    if (typeof v.disposition !== 'string' || !['passed', 'failed-repairable', 'failed-terminal', 'inconclusive'].includes(v.disposition)) invalid();
    const reasonCodes = refs(v.reasonCodes, 32), evidenceRefs = refs(v.evidenceRefs, 64);
    if (v.disposition === 'passed' ? evidenceRefs.length === 0 : reasonCodes.length === 0) invalid();
    return Object.freeze({ verifierId: token(v.verifierId), disposition: v.disposition as AgentLoopVerifierResult['disposition'], reasonCodes, evidenceRefs });
}
export function normalizeAgentLoopCompletionEvaluation(input: unknown): AgentLoopCompletionVerdictResult {
    const v = object(input, ['gateVersion', 'verdict', 'reasonCodes', 'evidenceRefs', 'verificationResultRef', 'verifierResults']);
    if (v.gateVersion !== AGENT_LOOP_COMPLETION_GATE_VERSION || typeof v.verdict !== 'string'
        || !['complete', 'repair', 'terminal-failure', 'inconclusive'].includes(v.verdict)) invalid();
    const reasonCodes = refs(v.reasonCodes, 32), evidenceRefs = refs(v.evidenceRefs, 2048), verifierResults = list(v.verifierResults, verifierResult, 32);
    if (reasonCodes.some(reason => !(AGENT_LOOP_COMPLETION_REASON_CODES as readonly string[]).includes(reason))
        || new Set(verifierResults.map(item => item.verifierId)).size !== verifierResults.length
        || JSON.stringify(evidenceRefs) !== JSON.stringify([...new Set(verifierResults.flatMap(item => [...item.evidenceRefs]))])
        || v.verdict === 'complete' && (reasonCodes.length !== 0 || evidenceRefs.length === 0 || !verifierResults.some(item => item.disposition === 'passed'))
        || v.verdict !== 'complete' && reasonCodes.length === 0) invalid();
    return Object.freeze({ gateVersion: AGENT_LOOP_COMPLETION_GATE_VERSION, verdict: v.verdict as AgentLoopCompletionVerdictResult['verdict'],
        reasonCodes: reasonCodes as AgentLoopCompletionVerdictResult['reasonCodes'], evidenceRefs,
        verificationResultRef: v.verificationResultRef === null ? null : token(v.verificationResultRef), verifierResults });
}
export function createStoredAgentLoopCompletionVerification(candidate: StoredAgentLoopCompletionCandidate,
    input: unknown, verifiedAt: string): StoredAgentLoopCompletionVerification {
    const evaluation = normalizeAgentLoopCompletionEvaluation(input), at = time(verifiedAt);
    if (evaluation.verificationResultRef !== null || Date.parse(at) < Date.parse(candidate.createdAt)
        || evaluation.verdict === 'complete' && (candidate.unknownEffectActionIds.length > 0 || candidate.missingArtifactRefs.length > 0)) invalid();
    const verificationResultRef = `verification:${agentLoopCompletionDigest({ candidateDigest: candidate.frozenDigest,
        evaluation: { ...evaluation, verificationResultRef: null }, verifiedAt: at }).slice(7)}`;
    const base = Object.freeze({ recordVersion: AGENT_LOOP_COMPLETION_VERIFICATION_RECORD_VERSION, taskId: candidate.taskId,
        candidateRef: candidate.candidateRef, candidateDigest: candidate.frozenDigest, taskRevision: candidate.taskRevision,
        verificationResultRef, evaluation: Object.freeze({ ...evaluation, verificationResultRef }), verifiedAt: at });
    return Object.freeze({ ...base, verificationDigest: agentLoopCompletionDigest(base) });
}
export function normalizeStoredAgentLoopCompletionVerification(input: unknown,
    candidate: StoredAgentLoopCompletionCandidate): StoredAgentLoopCompletionVerification {
    const v = object(input, ['recordVersion', 'taskId', 'candidateRef', 'candidateDigest', 'taskRevision', 'verificationResultRef',
        'evaluation', 'verifiedAt', 'verificationDigest']);
    const storedEvaluation = normalizeAgentLoopCompletionEvaluation(v.evaluation);
    if (storedEvaluation.verificationResultRef !== v.verificationResultRef) invalid();
    const base = createStoredAgentLoopCompletionVerification(candidate, { ...storedEvaluation, verificationResultRef: null }, time(v.verifiedAt));
    if (v.recordVersion !== base.recordVersion || v.taskId !== base.taskId || v.candidateRef !== base.candidateRef
        || v.candidateDigest !== base.candidateDigest || v.taskRevision !== base.taskRevision
        || v.verificationResultRef !== base.verificationResultRef || v.verificationDigest !== base.verificationDigest) invalid();
    return base;
}
