/** @author Codex @date 2026-10-26 @version 1.0
 * P17-03.4a: bounded delivery of the original committed notification outbox.
 * Acknowledgement means Hub handoff, never client receipt or business completion.
 */
import { types as nodeTypes } from 'node:util';
import { createHash } from 'node:crypto';
import { agentLoopContinuationNotification } from './agent-loop-continuation.ts';
import { agentLoopProjectionEventDigest, type AgentLoopOutboxEntry, type AgentLoopProjectionStore } from './agent-loop-projection-store.ts';
import { readAgentLoopTaskOutcomeStatus } from './agent-loop-task-outcome.ts';
import type { AgentLoopSummaryApplyOutcomeReader } from './agent-loop-summary-apply-task-outcome.ts';
import type { TaskEventRecordRefV2 } from '@jiuguan/mobile-contracts';

export interface AgentLoopTaskEventEvidence {
    readonly eventDigest: string;
    readonly acceptedAt?: string;
    readonly currentAttemptIdAtRevision?: string;
    readonly attemptId?: string;
    readonly recordRefs?: readonly TaskEventRecordRefV2[];
    readonly kind?: string;
    readonly reasonCode?: string;
}

export interface AgentLoopTaskInvalidationInput {
    readonly taskId: string;
    readonly taskRevision: number;
}

export interface AgentLoopTaskInvalidationDrainerStats {
    readonly published: number;
    readonly acked: number;
    readonly errors: number;
    readonly skipped: number;
    /** Size of the most recently read page, not the total pending row count. */
    readonly pendingInLastBatch: number;
    readonly started: boolean;
    readonly closed: boolean;
}

export interface AgentLoopTaskInvalidationDrainer {
    start(): void;
    drainOnce(): Promise<AgentLoopTaskInvalidationDrainerStats>;
    whenIdle(): Promise<void>;
    stop(): Promise<void>;
    stats(): AgentLoopTaskInvalidationDrainerStats;
}

export interface AgentLoopTaskInvalidationDrainerOptions {
    readonly store: AgentLoopProjectionStore;
    readonly summaryApply?: AgentLoopSummaryApplyOutcomeReader;
    /** Synchronous Hub handoff. A block callback must return undefined. */
    readonly publish: (input: AgentLoopTaskInvalidationInput, evidence: AgentLoopTaskEventEvidence) => void;
    readonly pollIntervalMs?: number;
    readonly batchLimit?: number;
    /** Content-free host diagnostic; its failure cannot affect committed tasks. */
    readonly onError?: () => void;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error('agent-loop-task-invalidation-options-invalid');
    }
    return value;
}

function assertCommittedEntry(store: AgentLoopProjectionStore, entry: AgentLoopOutboxEntry,
    summaryApply?: AgentLoopSummaryApplyOutcomeReader): AgentLoopTaskEventEvidence {
    const current = store.read(entry.taskId);
    if (!current || current.revision < entry.revision) {
        throw new Error('agent-loop-task-invalidation-lineage-invalid');
    }
    const matching = store.readEvents(entry.taskId).filter((event) => event.eventId === entry.eventId);
    const event = matching[0];
    if (
        matching.length !== 1 ||
        !event ||
        event.taskId !== entry.taskId ||
        event.revision !== entry.revision ||
        event.eventDigest !== entry.eventDigest ||
        event.acceptedAt !== entry.createdAt
    ) {
        throw new Error('agent-loop-task-invalidation-lineage-invalid');
    }
    const envelopeDigest = `sha256:${createHash('sha256').update(JSON.stringify(current.envelope)).digest('hex')}`;
    if (envelopeDigest !== current.envelopeDigest) throw new Error('agent-loop-task-invalidation-lineage-invalid');
    // Reuse the authoritative Outcome reader, including its original terminal
    // digest checks and native Summary origin/readback. A current attempt alone
    // cannot identify the attempt responsible for a historical event.
    if (event.kind === 'task-completed' && !current.fenced) {
        const status = readAgentLoopTaskOutcomeStatus(store, entry.taskId, summaryApply);
        const outcome = status?.outcome;
        if (!outcome || outcome.source.revision !== current.revision || outcome.source.envelopeDigest !== envelopeDigest)
            throw new Error('agent-loop-task-invalidation-lineage-invalid');
        const terminal = outcome.axes.execution.evidence;
        if (outcome.axes.execution.state === 'completed' && outcome.identity.attemptId !== null
            && terminal.length === 1 && terminal[0]!.kind === 'task-event'
            && terminal[0]!.refId === event.eventId && terminal[0]!.sourceDigest === event.eventDigest
            && terminal[0]!.occurredAt === event.acceptedAt) {
            const recordRefs: TaskEventRecordRefV2[] = [];
            for (const original of [...outcome.axes.verification.evidence, ...outcome.axes.commit.evidence]) {
                const kind = original.kind;
                if (['completion-candidate', 'completion-verification', 'summary-write-intent', 'summary-write-readback'].includes(kind)
                    && original.occurredAt <= event.acceptedAt) {
                    recordRefs.push(Object.freeze({ ...original, kind: kind as TaskEventRecordRefV2['kind'] }));
                }
            }
            return Object.freeze({ eventDigest: event.eventDigest, acceptedAt: event.acceptedAt, kind: event.kind,
                attemptId: outcome.identity.attemptId, recordRefs: Object.freeze(recordRefs),
                ...(current.revision === entry.revision ? { currentAttemptIdAtRevision: outcome.identity.attemptId } : {}),
                ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }) });
        }
    }
    if (current.revision !== entry.revision) return Object.freeze({ eventDigest: event.eventDigest });
    if (agentLoopProjectionEventDigest({ eventId: event.eventId, taskId: event.taskId, revision: event.revision,
        kind: event.kind, reasonCode: event.reasonCode ?? null, envelopeDigest: current.envelopeDigest }) !== event.eventDigest) {
        throw new Error('agent-loop-task-invalidation-lineage-invalid');
    }
    return Object.freeze({ eventDigest: event.eventDigest, acceptedAt: event.acceptedAt, kind: event.kind,
        ...(current.envelope.currentAttemptId === undefined ? {} : { currentAttemptIdAtRevision: current.envelope.currentAttemptId }),
        ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }) });
}

/** One consumer for the original notification outbox, not a task executor.
 * Every batch yields before the next poll, including a failed head entry.
 */
export function createAgentLoopTaskInvalidationDrainer(
    options: AgentLoopTaskInvalidationDrainerOptions,
): AgentLoopTaskInvalidationDrainer {
    const pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 500, 200, 1000);
    const batchLimit = boundedInteger(options.batchLimit ?? 64, 1, 128);
    if (typeof options.publish !== 'function' || nodeTypes.isProxy(options.publish)) {
        throw new Error('agent-loop-task-invalidation-options-invalid');
    }
    const { store, publish } = options;
    let published = 0;
    let acked = 0;
    let errors = 0;
    let skipped = 0;
    let pendingInLastBatch = 0;
    let started = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let work: Promise<AgentLoopTaskInvalidationDrainerStats> | null = null;

    const stats = (): AgentLoopTaskInvalidationDrainerStats =>
        Object.freeze({ published, acked, errors, skipped, pendingInLastBatch, started, closed });
    const failed = (): void => {
        errors += 1;
        try {
            options.onError?.();
        } catch {
            // Notification diagnostics do not participate in task transactions.
        }
    };
    const deliver = (entry: AgentLoopOutboxEntry): void => {
        const evidence = assertCommittedEntry(store, entry, options.summaryApply);
        const notification = agentLoopContinuationNotification({
            taskId: entry.taskId,
            taskRevision: entry.revision,
        });
        const result: unknown = publish(
            Object.freeze({ taskId: notification.taskId, taskRevision: notification.taskRevision }), evidence,
        );
        if (nodeTypes.isPromise(result)) {
            void Promise.prototype.then.call(
                result,
                () => undefined,
                () => undefined,
            );
        }
        if (result !== undefined) throw new Error('agent-loop-task-invalidation-publish-not-synchronous');
        published += 1;
        // A crash or an ack failure here may repeat the hint, never the task.
        acked += store.ackOutbox({ seqs: [entry.seq] });
    };
    const drainBatch = (): AgentLoopTaskInvalidationDrainerStats => {
        if (closed) return stats();
        try {
            const page = store.readOutbox({ limit: batchLimit });
            pendingInLastBatch = page.entries.length;
            skipped += page.skipped;
            for (const entry of page.entries) {
                if (closed) break;
                deliver(entry);
            }
        } catch {
            failed();
        }
        return stats();
    };
    const drainOnce = (): Promise<AgentLoopTaskInvalidationDrainerStats> => {
        if (work) return work;
        if (closed) return Promise.resolve(stats());
        work = Promise.resolve()
            .then(drainBatch)
            .finally(() => {
                work = null;
            });
        return work;
    };
    const schedule = (delay: number): void => {
        if (!started || closed || timer) return;
        timer = setTimeout(() => {
            timer = null;
            void drainOnce().then(() => schedule(pollIntervalMs));
        }, delay);
        timer.unref?.();
    };
    const whenIdle = async (): Promise<void> => {
        if (work) await work;
    };
    return Object.freeze({
        start: (): void => {
            if (closed) throw new Error('agent-loop-task-invalidation-closed');
            if (started) return;
            started = true;
            schedule(0);
        },
        drainOnce,
        whenIdle,
        stop: (): Promise<void> => {
            closed = true;
            started = false;
            if (timer) clearTimeout(timer);
            timer = null;
            return whenIdle();
        },
        stats,
    });
}
