/** @author Codex @date 2026-10-26 @version 1.0
 * Single-task readback only. Event hints never become task state or execution authority.
 */
import {
    normalizeAgentLoopPhase,
    normalizeAgentLoopTaskState,
    type AgentLoopPhase,
    type AgentLoopTaskState,
} from '../../../packages/agent-loop-contract/index.ts';
import {
    ClientRuntimeError,
    parseTaskInvalidation,
    type EventEnvelope,
} from '../../../packages/client-runtime/public/events.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';
import { authFetch } from './authClient.ts';

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const TASK_STATUS_IDLE_TIMEOUT_MS = 12_000;
const TASK_STATUS_FIELDS = Object.freeze(['taskId', 'taskRevision', 'state', 'phase', 'fenced', 'explanation'] as const);

export interface AgentLoopTaskStatus {
    readonly taskId: string;
    readonly taskRevision: number;
    readonly state: AgentLoopTaskState;
    readonly phase: AgentLoopPhase;
    readonly fenced: boolean;
    readonly explanation: Readonly<{ waitKind: 'input' | 'approval' | 'event' | 'child' | 'verification' | null;
        openBlockers: number; blockerReasons: readonly ('child-failed' | 'child-cancelled' | 'child-artifact-conflict' | 'other')[];
        evidenceCount: number; deadlineAt: string | null }>;
}

export type TaskStatusSnapshot = Readonly<{
    status: 'loading' | 'current' | 'not-found' | 'unavailable' | 'forbidden';
    task: Readonly<AgentLoopTaskStatus> | null;
}>;

export interface AgentLoopTaskReader {
    refresh(): Promise<void>;
    onEvent(event: EventEnvelope): Promise<void>;
    unavailable(): void;
    stop(): void;
}

function requireTaskId(value: string): string {
    if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw new Error('任务 ID 非法');
    return value;
}

/** Own data properties only: no private payload, inherited fallback or getter evaluation. */
export function parseAgentLoopTaskStatus(value: unknown, expectedTaskId: string): Readonly<AgentLoopTaskStatus> {
    requireTaskId(expectedTaskId);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务状态响应不符合当前协议');
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
        (prototype !== Object.prototype && prototype !== null) ||
        Reflect.ownKeys(descriptors).length !== TASK_STATUS_FIELDS.length ||
        TASK_STATUS_FIELDS.some((key) => {
            const descriptor = descriptors[key];
            return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
        })
    ) {
        throw new Error('任务状态响应不符合当前协议');
    }
    const taskId: unknown = descriptors.taskId!.value;
    const taskRevision: unknown = descriptors.taskRevision!.value;
    const state: unknown = descriptors.state!.value;
    const phase: unknown = descriptors.phase!.value;
    const fenced: unknown = descriptors.fenced!.value;
    const explanation: unknown = descriptors.explanation!.value;
    if (
        taskId !== expectedTaskId ||
        typeof taskRevision !== 'number' ||
        !Number.isSafeInteger(taskRevision) ||
        taskRevision < 1 ||
        typeof fenced !== 'boolean'
    ) {
        throw new Error('任务状态响应不符合当前协议');
    }
    if (!explanation || typeof explanation !== 'object' || Array.isArray(explanation)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(explanation))) throw new Error('任务状态响应不符合当前协议');
    const fields = Object.getOwnPropertyDescriptors(explanation);
    const keys = ['waitKind', 'openBlockers', 'blockerReasons', 'evidenceCount', 'deadlineAt'] as const;
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) {
        throw new Error('任务状态响应不符合当前协议');
    }
    const waitKind = fields.waitKind!.value, openBlockers = fields.openBlockers!.value, blockerReasons = fields.blockerReasons!.value,
        evidenceCount = fields.evidenceCount!.value, deadlineAt = fields.deadlineAt!.value;
    if (!Array.isArray(blockerReasons) || Object.getPrototypeOf(blockerReasons) !== Array.prototype
        || blockerReasons.length > 4) throw new Error('任务状态响应不符合当前协议');
    const reasonFields = Object.getOwnPropertyDescriptors(blockerReasons);
    if (Reflect.ownKeys(reasonFields).length !== blockerReasons.length + 1) throw new Error('任务状态响应不符合当前协议');
    const reasons: AgentLoopTaskStatus['explanation']['blockerReasons'][number][] = [];
    for (let i = 0; i < blockerReasons.length; i++) {
        const descriptor = reasonFields[String(i)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
            || !['child-failed', 'child-cancelled', 'child-artifact-conflict', 'other'].includes(descriptor.value)) {
            throw new Error('任务状态响应不符合当前协议');
        }
        reasons.push(descriptor.value as AgentLoopTaskStatus['explanation']['blockerReasons'][number]);
    }
    if (![null, 'input', 'approval', 'event', 'child', 'verification'].includes(waitKind)
        || !Number.isSafeInteger(openBlockers) || openBlockers < 0 || !Number.isSafeInteger(evidenceCount) || evidenceCount < 0
        || new Set(reasons).size !== reasons.length || (openBlockers === 0) !== (reasons.length === 0)
        || (deadlineAt !== null && (typeof deadlineAt !== 'string' || !Number.isFinite(Date.parse(deadlineAt)) || new Date(deadlineAt).toISOString() !== deadlineAt))
        || (fenced && (waitKind !== null || openBlockers !== 0 || evidenceCount !== 0 || deadlineAt !== null))) {
        throw new Error('任务状态响应不符合当前协议');
    }
    return Object.freeze({
        taskId: expectedTaskId,
        taskRevision,
        state: normalizeAgentLoopTaskState(state),
        phase: normalizeAgentLoopPhase(phase),
        fenced,
        explanation: Object.freeze({ waitKind, openBlockers, blockerReasons: Object.freeze(reasons), evidenceCount, deadlineAt }),
    });
}

function stoppedError(): Error {
    const error = new Error('任务状态读取已停止');
    error.name = 'AbortError';
    return error;
}

/** A UI lifetime closure, not a task cache, event source, poller or retry owner. */
export function createAgentLoopTaskReader(
    taskId: string,
    onSnapshot: (snapshot: TaskStatusSnapshot) => void,
    options: { fetchImpl?: typeof fetch } = {},
): AgentLoopTaskReader {
    requireTaskId(taskId);
    const query = new URLSearchParams({ taskId, explain: '1' });
    const url = `/api/agent-loop/task-status?${query.toString()}`;
    const execute = options.fetchImpl ?? authFetch;
    let stopped = false;
    let dirty = false;
    let generation = 0;
    let controller: AbortController | null = null;
    let flight: Promise<void> | null = null;

    const publish = (status: TaskStatusSnapshot['status'], task: Readonly<AgentLoopTaskStatus> | null = null) => {
        if (!stopped) onSnapshot(Object.freeze({ status, task }));
    };
    const read = async (signal: AbortSignal): Promise<TaskStatusSnapshot> => {
        const response = await fetchWithInactivityTimeout(
            (requestSignal) => execute(url, { method: 'GET', cache: 'no-store', signal: requestSignal }),
            TASK_STATUS_IDLE_TIMEOUT_MS,
            signal,
        );
        if (response.status === 401 || response.status === 403) {
            throw new ClientRuntimeError('credential_unavailable', { details: { status: response.status } });
        }
        if (response.status === 404) return Object.freeze({ status: 'not-found', task: null });
        if (!response.ok) throw new Error(`任务状态暂不可用（HTTP ${response.status}）`);
        return Object.freeze({ status: 'current', task: parseAgentLoopTaskStatus(await response.json(), taskId) });
    };
    const drain = async (): Promise<void> => {
        try {
            while (dirty) {
                if (stopped) throw stoppedError();
                dirty = false;
                const readGeneration = generation;
                controller = new AbortController();
                publish('loading');
                if (stopped) throw stoppedError();
                let snapshot: TaskStatusSnapshot;
                try {
                    snapshot = await read(controller.signal);
                } catch (error) {
                    if (stopped) throw stoppedError();
                    if (generation !== readGeneration) {
                        if (dirty) continue;
                        throw stoppedError();
                    }
                    if (error instanceof ClientRuntimeError && error.code === 'credential_unavailable') {
                        dirty = false;
                        publish('forbidden');
                        throw error;
                    }
                    if (dirty) continue;
                    publish('unavailable');
                    throw error;
                }
                if (stopped) throw stoppedError();
                // A new invalidation makes even a successful in-flight response an obsolete read.
                if (dirty) continue;
                if (generation !== readGeneration) throw stoppedError();
                publish(snapshot.status, snapshot.task);
            }
        } finally {
            controller = null;
            flight = null;
        }
    };
    const refresh = (): Promise<void> => {
        if (stopped) return Promise.reject(stoppedError());
        dirty = true;
        if (flight) return flight;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const pending = new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        flight = pending;
        void drain().then(resolve, reject);
        return pending;
    };

    return Object.freeze({
        refresh,
        onEvent(event: EventEnvelope): Promise<void> {
            const hint = parseTaskInvalidation(event);
            return hint?.taskId === taskId ? refresh() : Promise.resolve();
        },
        unavailable(): void {
            if (stopped) return;
            generation += 1;
            dirty = false;
            controller?.abort();
            publish('unavailable');
        },
        stop(): void {
            stopped = true;
            dirty = false;
            generation += 1;
            controller?.abort();
        },
    });
}
