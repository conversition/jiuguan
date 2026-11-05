/** Content-free view of the original task's terminal evidence; never a Turn association. */
import { authFetch } from './authClient.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';

export type TaskOutcomeAxis<T extends string> = Readonly<{ state: T; evidenceCount: number }>;
export interface TaskOutcomeView {
    readonly execution: TaskOutcomeAxis<'completed' | 'failed' | 'cancelled' | 'unknown'>;
    readonly verification: TaskOutcomeAxis<'validated' | 'unknown'>;
    readonly commit: TaskOutcomeAxis<'committed' | 'rolled-back' | 'unknown'>;
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const KINDS = ['task-projection', 'completion-candidate', 'completion-verification', 'task-event',
    'summary-origin', 'summary-write-intent', 'summary-write-readback', 'summary-rollback'];
function axis<T extends string>(input: unknown, allowed: readonly T[]): TaskOutcomeAxis<T> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('task-outcome-invalid');
    const row = input as Record<string, unknown>;
    if (typeof row.state !== 'string' || !allowed.includes(row.state as T) || !Array.isArray(row.evidence)
        || row.evidence.length > 32 || (row.state === 'unknown' ? row.evidence.length !== 0 : row.evidence.length === 0)) {
        throw new Error('task-outcome-invalid');
    }
    for (const value of row.evidence) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task-outcome-invalid');
        const item = value as Record<string, unknown>;
        if (!KINDS.includes(String(item.kind)) || typeof item.refId !== 'string' || !TOKEN.test(item.refId)
            || typeof item.sourceDigest !== 'string' || !DIGEST.test(item.sourceDigest)
            || typeof item.occurredAt !== 'string' || !Number.isFinite(Date.parse(item.occurredAt))
            || new Date(item.occurredAt).toISOString() !== item.occurredAt) throw new Error('task-outcome-invalid');
    }
    return Object.freeze({ state: row.state as T, evidenceCount: row.evidence.length });
}
export async function readTaskOutcome(taskId: string, expectedRevision: number, signal: AbortSignal,
    fetcher: typeof authFetch = authFetch): Promise<TaskOutcomeView> {
    if (!TOKEN.test(taskId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('task-outcome-input-invalid');
    const url = `/api/agent-loop/task-status?${new URLSearchParams({ taskId, outcomes: '1' })}`;
    const response = await fetchWithInactivityTimeout(
        requestSignal => fetcher(url, { method: 'GET', cache: 'no-store', signal: requestSignal }), 12_000, signal);
    if (!response.ok) throw new Error(`task-outcome-http-${response.status}`);
    const row = await response.json() as Record<string, any>;
    const value = row?.outcome;
    if (row?.taskId !== taskId || row?.taskRevision !== expectedRevision || row?.fenced !== false
        || !value || value.version !== 'agent-loop-task-outcome-v1'
        || value.identity?.source !== 'agent-loop-projection' || value.identity?.taskId !== taskId
        || value.source?.revision !== expectedRevision || !DIGEST.test(value.source?.digest)
        || !value.axes || value.authorizesExecution !== false || value.authorizesCompletion !== false
        || value.authorizesPromotion !== false) throw new Error('task-outcome-stale-or-invalid');
    return Object.freeze({
        execution: axis(value.axes.execution, ['completed', 'failed', 'cancelled', 'unknown'] as const),
        verification: axis(value.axes.verification, ['validated', 'unknown'] as const),
        commit: axis(value.axes.commit, ['committed', 'rolled-back', 'unknown'] as const),
    });
}
