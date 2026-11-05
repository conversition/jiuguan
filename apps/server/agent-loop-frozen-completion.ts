/** P17-02.5a: durable, source-bound completion evaluation, not a Runtime driver.
 * Only the original gate evaluates; only the original Store freezes/persists.
 * Stored records remain audit metadata. Only prepareFrozenAgentLoopCompletion,
 * after this invocation's real evaluation, can issue a one-use live outcome.
 * No persisted JSON or generic gate DTO can reconstruct that private authority.
 */
import { AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type { StoredAgentLoopCompletionCandidate, StoredAgentLoopCompletionVerification } from './agent-loop-completion-record.ts';
import { AgentLoopVerifierRegistry, evaluateAgentLoopCompletion, type AgentLoopVerifierRunner } from './agent-loop-completion-gate.ts';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { assertAgentLoopTurnCompletionBirthBinding,
    assertAgentLoopTurnCompletionVerifierSet } from './agent-loop-turn-completion-policy.ts';

export const AGENT_LOOP_FROZEN_COMPLETION_ERROR_CODES = Object.freeze([
    'agent-loop-frozen-completion-input-invalid', 'agent-loop-frozen-completion-binding-mismatch',
    'agent-loop-frozen-completion-source-stale', 'agent-loop-frozen-completion-aborted',
] as const);
type ErrorCode = typeof AGENT_LOOP_FROZEN_COMPLETION_ERROR_CODES[number];
export class AgentLoopFrozenCompletionError extends Error {
    constructor(readonly code: ErrorCode) {
        if (!(AGENT_LOOP_FROZEN_COMPLETION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('agent-loop-frozen-completion-error-code-invalid');
        }
        super(code); this.name = 'AgentLoopFrozenCompletionError';
    }
}
function reject(code: ErrorCode): never { throw new AgentLoopFrozenCompletionError(code); }

export interface AgentLoopFrozenCompletionInput {
    readonly store: AgentLoopProjectionStore;
    readonly ownerId: string;
    readonly taskId: string;
    readonly candidateRef: string;
    readonly expectedRevision: number;
    readonly registry: AgentLoopVerifierRegistry;
    /** Trusted host registration, explicitly joined to the real task contract. */
    readonly contractBinding: Readonly<{ taskKind: string; taskContractRef: string; contractRevision: string }>;
    readonly runners: Readonly<Record<string, AgentLoopVerifierRunner>>;
    readonly repairAttempts: number;
    readonly maxRepairAttempts: number;
    readonly clock: () => string;
    /** Must assert actual domain/claim/session freshness, not return an allow boolean. */
    readonly assertSourceCurrent: (candidate: StoredAgentLoopCompletionCandidate) => void | Promise<void>;
    /** Original writer lock holds here. Must be synchronous; no Promise/allow boolean. */
    readonly assertSourceCurrentAtCommit: (candidate: StoredAgentLoopCompletionCandidate) => void;
    readonly signal?: AbortSignal;
}

export interface AgentLoopCompletionDecision {
    readonly verdict: 'complete' | 'repair' | 'terminal-failure' | 'inconclusive';
    readonly candidateRef: string;
    readonly evidenceRefs: readonly string[];
    readonly verificationResultRef: string | null;
    readonly reasonCodes: readonly string[];
}
interface VerifiedCompletionData {
    readonly selected: AgentLoopFrozenCompletionInput;
    readonly candidate: StoredAgentLoopCompletionCandidate;
    readonly verification: StoredAgentLoopCompletionVerification;
    readonly authorizeCommit: () => void;
}
const verifiedOutcomes = new WeakMap<object, VerifiedCompletionData>();
const directCommitRevoked = new WeakSet<object>();

/** Read-only brand check. Copies and stored audit records never match. */
export function isPreparedFrozenAgentLoopCompletion(value: unknown): boolean {
    return value !== null && typeof value === 'object' && verifiedOutcomes.has(value);
}

/** Revocation only. Does not turn an AL metadata outcome into publication authority. */
export function revokeFrozenAgentLoopCompletion(value: unknown): void {
    if (value !== null && typeof value === 'object') verifiedOutcomes.delete(value);
}

/** Revocation-only purpose restriction. Core can still recognize the genuine
 * evaluation, but the ordinary AL-only terminal consumer can no longer use it.
 * This does not issue publication authority; that lives in a separate host map.
 */
export function restrictFrozenAgentLoopDirectCommit(value: unknown): void {
    if (value !== null && typeof value === 'object' && verifiedOutcomes.has(value)) directCommitRevoked.add(value);
}

/** The only evaluation algorithm. Its source assertion is pinned before any await. */
async function evaluateFrozen(input: AgentLoopFrozenCompletionInput): Promise<VerifiedCompletionData> {
    let selected: AgentLoopFrozenCompletionInput;
    try {
        normalizeAgentLoopActionObject(input, ['store', 'ownerId', 'taskId', 'candidateRef', 'expectedRevision', 'registry',
            'contractBinding', 'runners', 'repairAttempts', 'maxRepairAttempts', 'clock', 'assertSourceCurrent', 'assertSourceCurrentAtCommit'], ['signal']);
        const binding = normalizeAgentLoopActionObject(input.contractBinding, ['taskKind', 'taskContractRef', 'contractRevision']);
        if (!(input.store instanceof AgentLoopProjectionStore) || !(input.registry instanceof AgentLoopVerifierRegistry)
            || typeof input.assertSourceCurrent !== 'function' || typeof input.assertSourceCurrentAtCommit !== 'function'
            || typeof input.clock !== 'function'
            || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
            || !Number.isSafeInteger(input.repairAttempts) || input.repairAttempts < 0
            || !Number.isSafeInteger(input.maxRepairAttempts) || input.maxRepairAttempts < 0
            || input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error();
        const runners = Object.freeze(Object.fromEntries(Object.entries(normalizeAgentLoopActionObject(input.runners,
            [], Object.keys(input.runners))).map(([id, runner]) => {
                normalizeAgentLoopActionToken(id);
                if (typeof runner !== 'function') throw new Error();
                return [id, runner as AgentLoopVerifierRunner];
            })));
        selected = Object.freeze({ store: input.store, registry: input.registry,
            ownerId: normalizeAgentLoopActionToken(input.ownerId), taskId: normalizeAgentLoopActionToken(input.taskId),
            candidateRef: normalizeAgentLoopActionToken(input.candidateRef), expectedRevision: input.expectedRevision,
            contractBinding: Object.freeze({ taskKind: normalizeAgentLoopActionToken(binding.taskKind),
                taskContractRef: normalizeAgentLoopActionToken(binding.taskContractRef), contractRevision: normalizeAgentLoopActionToken(binding.contractRevision) }),
            runners, repairAttempts: input.repairAttempts, maxRepairAttempts: input.maxRepairAttempts,
            clock: input.clock, assertSourceCurrent: input.assertSourceCurrent,
            assertSourceCurrentAtCommit: input.assertSourceCurrentAtCommit, signal: input.signal });
    } catch { return reject('agent-loop-frozen-completion-input-invalid'); }
    const { store, registry, ownerId, taskId, candidateRef, expectedRevision, contractBinding, signal } = selected;
    const scope = Object.freeze({ taskId, ownerId, candidateRef, expectedRevision });
    const assertNotAborted = () => { if (signal?.aborted) reject('agent-loop-frozen-completion-aborted'); };
    const assertSource = async (candidate: StoredAgentLoopCompletionCandidate) => {
        assertNotAborted();
        try { if (await selected.assertSourceCurrent(candidate) !== undefined) throw new Error(); }
        catch { return reject('agent-loop-frozen-completion-source-stale'); }
        assertNotAborted();
    };
    assertNotAborted();
    const candidate = store.assertCompletionCandidateCurrent(scope);
    // Caller numbers are not repair authority. They must describe the original
    // lifetime event projection, including a policy pinned by a previous repair.
    const repair = store.readRepairState({ taskId, expectedRevision });
    if (selected.repairAttempts !== repair.attempts
        || repair.maxAttempts !== null && selected.maxRepairAttempts !== repair.maxAttempts) {
        reject('agent-loop-frozen-completion-binding-mismatch');
    }
    if (candidate.taskKind !== contractBinding.taskKind || candidate.taskContractRef !== contractBinding.taskContractRef) {
        reject('agent-loop-frozen-completion-binding-mismatch');
    }
    const verifierSet = registry.resolve({ taskKind: candidate.taskKind,
        contractRevision: contractBinding.contractRevision, verifierSetRevision: candidate.verifierSetRevision });
    try {
        const policy = assertAgentLoopTurnCompletionBirthBinding({
            envelope: {
                taskId: candidate.taskId,
                taskKind: candidate.taskKind,
                taskContractRef: candidate.taskContractRef,
                verifier: {
                    verifierSetRef: candidate.verifierSetRef,
                    verifierSetRevision: candidate.verifierSetRevision,
                },
            },
            birthEvent: store.readEvents(taskId)[0] ?? null,
        });
        if (policy) {
            if (contractBinding.contractRevision !== policy.contractRevision) throw new Error();
            assertAgentLoopTurnCompletionVerifierSet({
                policy,
                verifierSet,
                maxRepairAttempts: selected.maxRepairAttempts,
            });
        }
    } catch {
        return reject('agent-loop-frozen-completion-binding-mismatch');
    }
    await assertSource(candidate);
    // The domain check was awaited: reacquire the Store writer lock and fresh TTL.
    store.assertCompletionCandidateCurrent(scope);
    const current = store.read(taskId);
    if (!current || current.revision !== expectedRevision || current.envelopeDigest !== candidate.envelopeDigest) {
        reject('agent-loop-frozen-completion-binding-mismatch');
    }
    const events = store.readEvents(taskId);
    const evaluation = await evaluateAgentLoopCompletion({ candidate, currentRevision: current.revision,
        binding: { taskId: current.envelope.taskId, attemptId: current.envelope.currentAttemptId!,
            artifactRefs: current.envelope.artifacts.map(item => item.artifactRef),
            actionWatermark: [...events].reverse().find(item => item.kind === 'action-completed')?.eventId ?? null,
            verifierSetRef: current.envelope.verifier.verifierSetRef, verifierSetRevision: current.envelope.verifier.verifierSetRevision },
        envelope: current.envelope, verifierSet, runners: selected.runners,
        unknownEffectActionIds: candidate.unknownEffectActionIds, repairAttempts: selected.repairAttempts,
        maxRepairAttempts: selected.maxRepairAttempts, clock: selected.clock });
    assertNotAborted();
    await assertSource(candidate);
    // Final write repeats owner/TTL/fence/revision/full snapshot validation inside
    // its own original Store transaction, plus a final synchronous domain check.
    // No microtask gap or writer-lock wait can borrow an old source assertion.
    assertNotAborted();
    const authorizeCommit = () => {
        assertNotAborted();
        try {
            const result: unknown = selected.assertSourceCurrentAtCommit(candidate);
            if (result !== undefined) {
                // Observe an accidentally returned native Promise's rejection,
                // without awaiting it or reading/assimilating an arbitrary then.
                if (result !== null && typeof result === 'object') {
                    try { void Promise.prototype.then.call(result, () => undefined, () => undefined); }
                    catch { /* A plain thenable is not executed. */ }
                }
                throw new Error();
            }
        }
        catch { return reject('agent-loop-frozen-completion-source-stale'); }
        assertNotAborted();
    };
    const verification = store.recordCompletionVerification({ ...scope, evaluation }, authorizeCommit);
    return Object.freeze({ selected, candidate, verification, authorizeCommit });
}

/** Audit-only compatibility API. It intentionally issues no live outcome. */
export async function evaluateFrozenAgentLoopCompletion(input: AgentLoopFrozenCompletionInput): Promise<StoredAgentLoopCompletionVerification> {
    return (await evaluateFrozen(input)).verification;
}

/** No issuer accepts a StoredVerification: the original runners must run here. */
export async function prepareFrozenAgentLoopCompletion(input: AgentLoopFrozenCompletionInput): Promise<AgentLoopCompletionDecision> {
    const data = await evaluateFrozen(input), { verification, candidate } = data;
    const outcome: AgentLoopCompletionDecision = Object.freeze({ verdict: verification.evaluation.verdict,
        candidateRef: candidate.candidateRef, evidenceRefs: verification.evaluation.evidenceRefs,
        verificationResultRef: verification.verificationResultRef, reasonCodes: verification.evaluation.reasonCodes });
    if (outcome.verdict === 'complete') verifiedOutcomes.set(outcome, data);
    return outcome;
}

/** Consumed even on failure. Only metadata terminalization, never Manager publication,
 * Action/Model dispatch, budget, lease acquisition or recovery authority.
 */
export function commitFrozenAgentLoopCompletion(outcome: unknown, input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord;
}>): AgentLoopTaskRecord {
    const data = outcome !== null && typeof outcome === 'object' ? verifiedOutcomes.get(outcome) : undefined;
    if (outcome !== null && typeof outcome === 'object') verifiedOutcomes.delete(outcome);
    if (!data || directCommitRevoked.has(outcome as object)) return reject('agent-loop-frozen-completion-binding-mismatch');
    try {
        normalizeAgentLoopActionObject(input, ['store', 'ownerId', 'record']);
        const record = normalizeAgentLoopActionObject(input.record,
            ['envelope', 'envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
        const envelope = record.envelope;
        if (!envelope || typeof envelope !== 'object') throw new Error();
        const own = (key: string) => {
            const property = Object.getOwnPropertyDescriptor(envelope, key);
            if (!property || !Object.hasOwn(property, 'value')) throw new Error();
            return property.value;
        };
        if (input.store !== data.selected.store || input.ownerId !== data.selected.ownerId
            || record.ownerId !== input.ownerId || record.fenced !== false
            || record.revision !== data.candidate.taskRevision || record.envelopeDigest !== data.candidate.envelopeDigest
            || own('taskId') !== data.candidate.taskId || own('currentAttemptId') !== data.candidate.attemptId
            || own('state') !== 'RUNNING' || own('phase') !== 'VERIFY'
            || data.verification.candidateDigest !== data.candidate.frozenDigest) throw new Error();
    } catch { return reject('agent-loop-frozen-completion-binding-mismatch'); }
    return data.selected.store.completeVerifiedCandidate({ taskId: data.candidate.taskId,
        ownerId: data.selected.ownerId, expectedRevision: data.candidate.taskRevision,
        candidateRef: data.candidate.candidateRef, verificationResultRef: data.verification.verificationResultRef }, data.authorizeCommit);
}
