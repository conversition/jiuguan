/**
 * @author Codex
 * @date 2026-10-26
 * @version 1.0
 * P17-03.4a: authenticated, content-free readback of the original task projection.
 * The HTTP host must apply its central read authorization before calling this reader.
 * No goal, summary, ref payload, execution capability or completion authority leaves this boundary.
 */
import type { AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import type { AgentLoopProjectionStore } from './agent-loop-projection-store.ts';

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;

export interface AgentLoopTaskStatus {
    readonly taskId: string;
    readonly taskRevision: number;
    readonly state: AgentLoopTaskEnvelopeV1['state'];
    readonly phase: AgentLoopTaskEnvelopeV1['phase'];
    readonly fenced: boolean;
}

export interface AgentLoopTaskExplanation {
    readonly waitKind: 'input' | 'approval' | 'event' | 'child' | 'verification' | null;
    readonly openBlockers: number;
    /** Closed, content-free categories; unregistered reason codes never leave the server. */
    readonly blockerReasons: readonly ('child-failed' | 'child-cancelled' | 'child-artifact-conflict' | 'other')[];
    /** Number of references in the task projection, not verified evidence. */
    readonly evidenceCount: number;
    readonly deadlineAt: string | null;
}

/** Missing and corrupt projections remain distinct; storage diagnostics are never public payloads. */
export function readAgentLoopTaskStatus(
    store: Pick<AgentLoopProjectionStore, 'read'>,
    taskIdInput: unknown,
): Readonly<AgentLoopTaskStatus> | null {
    return readStatus(store, taskIdInput, false);
}

export function readAgentLoopTaskExplanation(
    store: Pick<AgentLoopProjectionStore, 'read'>, taskIdInput: unknown,
): Readonly<AgentLoopTaskStatus & { explanation: AgentLoopTaskExplanation }> | null {
    return readStatus(store, taskIdInput, true) as Readonly<AgentLoopTaskStatus & { explanation: AgentLoopTaskExplanation }> | null;
}

function readStatus(store: Pick<AgentLoopProjectionStore, 'read'>, taskIdInput: unknown, explain: boolean) {
    if (typeof taskIdInput !== 'string' || !TASK_ID_PATTERN.test(taskIdInput)) {
        throw new Error('agent-loop-task-id-invalid');
    }
    try {
        const record = store.read(taskIdInput);
        if (record === null) return null;
        const status = {
            taskId: record.envelope.taskId,
            taskRevision: record.revision,
            state: record.envelope.state,
            phase: record.envelope.phase,
            fenced: record.fenced,
        };
        if (!explain) return Object.freeze(status);
        const task = record.envelope;
        const explanation: AgentLoopTaskExplanation = record.fenced
            ? { waitKind: null, openBlockers: 0, blockerReasons: Object.freeze([]), evidenceCount: 0, deadlineAt: null }
            : { waitKind: task.wait?.kind ?? null,
                openBlockers: task.blockers.filter(blocker => blocker.status === 'open').length,
                blockerReasons: Object.freeze([...new Set(task.blockers.filter(blocker => blocker.status === 'open')
                    .map(blocker => (['child-failed', 'child-cancelled', 'child-artifact-conflict'] as const)
                        .find(reason => reason === blocker.reasonCode) ?? 'other' as const))].sort()),
                evidenceCount: task.blockers.reduce((sum, blocker) => sum + blocker.evidenceRefs.length, 0)
                    + task.artifacts.reduce((sum, artifact) => sum + artifact.evidenceRefs.length, 0)
                    + (task.completion?.evidenceRefs.length ?? 0),
                deadlineAt: task.wait?.deadlineAt ?? null };
        return Object.freeze({ ...status, explanation: Object.freeze(explanation) });
    } catch {
        throw new Error('agent-loop-task-status-unavailable');
    }
}
