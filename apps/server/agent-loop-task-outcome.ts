/** HC-4a: original AL Task/Attempt evidence, not a Closure/Turn identity guess. */
import { normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { agentLoopCompletionDigest } from './agent-loop-completion-record.ts';
import { AgentLoopProjectionStore, type AgentLoopTaskOutcomeSnapshot } from './agent-loop-projection-store.ts';
import { AgentLoopSummaryApplyOutcomeReader, type AgentLoopSummaryApplyCommitProjection }
    from './agent-loop-summary-apply-task-outcome.ts';
import type { AgentLoopTaskStatus } from './agent-loop-task-status.ts';

export const AGENT_LOOP_TASK_OUTCOME_VERSION = 'agent-loop-task-outcome-v1' as const;
export interface AgentLoopTaskOutcomeEvidenceRef {
    readonly kind: 'task-projection' | 'completion-candidate' | 'completion-verification' | 'task-event'
        | 'summary-origin' | 'summary-write-intent' | 'summary-write-readback' | 'summary-rollback';
    readonly refId: string;
    readonly sourceDigest: string;
    readonly occurredAt: string;
}
type Axis<State extends string> = Readonly<{
    state: State;
    evidence: readonly AgentLoopTaskOutcomeEvidenceRef[];
}>;
export interface AgentLoopTaskOutcomeV1 {
    readonly version: typeof AGENT_LOOP_TASK_OUTCOME_VERSION;
    readonly identity: Readonly<{
        source: 'agent-loop-projection'; taskId: string; rootTaskId: string;
        parentTaskId: string | null; attemptId: string | null; parentTurnId: null;
    }>;
    readonly taskKind: string;
    readonly source: Readonly<{ revision: number; envelopeDigest: string; digest: string }>;
    readonly axes: Readonly<{
        execution: Axis<'completed' | 'failed' | 'cancelled' | 'unknown'>;
        verification: Axis<'validated' | 'unknown'>;
        commit: Axis<'unknown' | 'committed' | 'rolled-back'>;
        adoption: Axis<'unknown'> & Readonly<{ validity: 'not-checked' }>;
        effect: Axis<'unknown'> & Readonly<{
            independentOutcome: 'unknown'; reportedOutcomes: readonly never[];
        }>;
    }>;
    readonly learningWeight: 0;
    readonly authorizesExecution: false;
    readonly authorizesCompletion: false;
    readonly authorizesPromotion: false;
}
export type AgentLoopTaskOutcomeStatus = Readonly<AgentLoopTaskStatus & { outcome: AgentLoopTaskOutcomeV1 }>;

// Capture the original private-field-backed reader: an arbitrary DTO, override or
// Proxy cannot claim that it performed the Store's terminal provenance checks.
const READ_SNAPSHOT = AgentLoopProjectionStore.prototype.readTaskOutcomeSnapshot;
const READ_SUMMARY_APPLY = AgentLoopSummaryApplyOutcomeReader.prototype.read;
const EMPTY_REFS: readonly AgentLoopTaskOutcomeEvidenceRef[] = Object.freeze([]);
function axis<State extends string>(state: State,
    evidence: readonly AgentLoopTaskOutcomeEvidenceRef[] = EMPTY_REFS): Axis<State> {
    return Object.freeze({ state, evidence: Object.freeze([...evidence]) });
}
function ref(kind: AgentLoopTaskOutcomeEvidenceRef['kind'], refId: string,
    sourceDigest: string, occurredAt: string): AgentLoopTaskOutcomeEvidenceRef {
    return Object.freeze({ kind, refId, sourceDigest, occurredAt });
}

function projectionDigest(snapshot: AgentLoopTaskOutcomeSnapshot): string {
    const { record, completion } = snapshot;
    return agentLoopCompletionDigest({ envelopeDigest: record.envelopeDigest,
        revision: record.revision, fenced: record.fenced,
        completion: !record.fenced && completion !== null ? {
            candidateDigest: completion.candidate.frozenDigest,
            verificationDigest: completion.verification.verificationDigest,
            requested: completion.requested, completed: completion.completed,
        } : null });
}

/** Private projection: only original Store and native source readers supply these facts. */
function project(snapshot: AgentLoopTaskOutcomeSnapshot,
    commit?: AgentLoopSummaryApplyCommitProjection): AgentLoopTaskOutcomeStatus {
    const { record, completion } = snapshot;
    const { envelope } = record;
    const verified = !record.fenced && completion !== null;
    const executionState = record.fenced ? 'unknown'
        : envelope.state === 'COMPLETED' ? 'completed'
            : envelope.state === 'FAILED' ? 'failed'
                : envelope.state === 'CANCELLED' ? 'cancelled' : 'unknown';
    // A later DAG accounting revision may update the projection timestamp. The
    // original completed event, when proven, remains the execution time/ref.
    const execution = axis(executionState, executionState === 'unknown' ? EMPTY_REFS
        : verified && executionState === 'completed' ? [ref('task-event', completion.completed.eventId,
            completion.completed.eventDigest, completion.completed.acceptedAt)]
            : [ref('task-projection', envelope.taskId, record.envelopeDigest, envelope.updatedAt)]);
    const verification = verified ? axis('validated', [
        ref('completion-candidate', completion.candidate.candidateRef,
            completion.candidate.frozenDigest, completion.candidate.createdAt),
        ref('completion-verification', completion.verification.verificationResultRef,
            completion.verification.verificationDigest, completion.verification.verifiedAt),
        ref('task-event', completion.completed.eventId,
            completion.completed.eventDigest, completion.completed.acceptedAt),
    ]) : axis('unknown');
    const outcome: AgentLoopTaskOutcomeV1 = Object.freeze({
        version: AGENT_LOOP_TASK_OUTCOME_VERSION,
        identity: Object.freeze({ source: 'agent-loop-projection', taskId: envelope.taskId,
            rootTaskId: envelope.rootTaskId, parentTaskId: envelope.parentTaskId ?? null,
            attemptId: envelope.currentAttemptId ?? null, parentTurnId: null }),
        taskKind: envelope.taskKind,
        source: Object.freeze({ revision: record.revision, envelopeDigest: record.envelopeDigest,
            digest: commit?.sourceDigest ? agentLoopCompletionDigest({ projectionDigest: projectionDigest(snapshot),
                summaryApplyDigest: commit.sourceDigest }) : projectionDigest(snapshot) }),
        axes: Object.freeze({ execution, verification,
            commit: commit ? axis(commit.state, commit.evidence) : axis('unknown'),
            adoption: Object.freeze({ ...axis('unknown'), validity: 'not-checked' }),
            effect: Object.freeze({ ...axis('unknown'), independentOutcome: 'unknown',
                reportedOutcomes: Object.freeze([]) }) }),
        learningWeight: 0, authorizesExecution: false, authorizesCompletion: false, authorizesPromotion: false,
    });
    return Object.freeze({ taskId: envelope.taskId, taskRevision: record.revision,
        state: envelope.state, phase: envelope.phase, fenced: record.fenced, outcome });
}

/** Same account-wide metadata read authority as the existing task-status reader.
 * The HTTP host authorizes first. No session ACL/Turn relation is guessed from an
 * opaque TaskId. The optional native Summary source is independently read twice
 * around original AL snapshots; no cross-Store atomicity is claimed. Without it,
 * a single original Store read transaction supplies the original v1 result;
 * no timestamp is synthesized, and no Provider, domain writer, scheduler or
 * completion grant is invoked.
 */
export function readAgentLoopTaskOutcomeStatus(
    store: AgentLoopProjectionStore,
    taskIdInput: unknown,
    summaryApply?: AgentLoopSummaryApplyOutcomeReader,
): AgentLoopTaskOutcomeStatus | null {
    let taskId: string;
    try { taskId = normalizeAgentLoopActionToken(taskIdInput); }
    catch { throw new Error('agent-loop-task-id-invalid'); }
    try {
        const snapshot = READ_SNAPSHOT.call(store, taskId);
        if (snapshot === null) return null;
        if (summaryApply === undefined) return project(snapshot);
        const commit = READ_SUMMARY_APPLY.call(summaryApply, store, snapshot);
        const current = READ_SNAPSHOT.call(store, taskId);
        if (current === null || projectionDigest(current) !== projectionDigest(snapshot)) throw new Error();
        const after = READ_SUMMARY_APPLY.call(summaryApply, store, current);
        if (agentLoopCompletionDigest(commit) !== agentLoopCompletionDigest(after)) throw new Error();
        return project(current, after);
    } catch {
        throw new Error('agent-loop-task-status-unavailable');
    }
}
