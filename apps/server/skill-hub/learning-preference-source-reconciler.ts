/** @author Codex @date 2026-10-14 @version 1.0
 * Replays original committed learning telemetry only; never creates a proposal, profile or consumption.
 */
import type {
    LearningPreferenceSkillSourceEntry, LearningPreferenceSkillSourceOutbox,
} from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';
import {
    parsePreferenceClearTombstone, preferenceEpochOf, type LearningEventRecord,
} from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentLearningLedger } from '../agent-learning-ledger.ts';

export interface LearningPreferenceSourceRecoveryHandle {
    readonly outbox: Pick<LearningPreferenceSkillSourceOutbox,
        'scan' | 'readCurrentEvent' | 'acknowledge' | 'invalidate'>;
    preferenceClearTombstones(): readonly LearningEventRecord[];
    close(): void;
}

export interface LearningPreferenceSourceRecoveryPorts {
    readonly ledger: Pick<AgentLearningLedger, 'append'>;
    readonly allowed: (rawSessionId: string) => boolean;
    readonly open: (rawSessionId: string) => LearningPreferenceSourceRecoveryHandle | null
        | Promise<LearningPreferenceSourceRecoveryHandle | null>;
    readonly now?: () => string;
}

export interface LearningPreferenceSourceRecoveryResult {
    readonly attempted: number;
    readonly delivered: number;
    readonly skipped: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

class InvalidatedPreferenceSource extends Error {
    constructor(readonly reasonCode: string) { super(reasonCode); }
}


function assertCurrentSource(input: LearningPreferenceSourceRecoveryPorts,
    handle: LearningPreferenceSourceRecoveryHandle, entry: LearningPreferenceSkillSourceEntry,
    rawSessionId: string): void {
    if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
    if (entry.rawSessionId !== rawSessionId) throw new Error('preference-source-recovery-session-drift');
    const current = handle.outbox.readCurrentEvent(entry);
    if (current === null) throw new InvalidatedPreferenceSource('preference-source-history-invalidated');
    if (current.eventId !== entry.learningEvent.eventId || current.payloadDigest !== entry.learningEvent.payloadDigest
        || current.createdAt !== entry.learningEvent.createdAt) {
        throw new Error('preference-source-recovery-event-drift');
    }
    if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
}


function currentPreferenceFence(handle: LearningPreferenceSourceRecoveryHandle,
    entry: LearningPreferenceSkillSourceEntry): LearningEventRecord | null {
    const epoch = preferenceEpochOf(entry.learningEvent);
    if (epoch === null) throw new Error('preference-source-recovery-epoch-invalid');
    const identity = entry.learningEvent;
    const matching = handle.preferenceClearTombstones().filter((event) => {
        const fence = parsePreferenceClearTombstone(event);
        return fence && fence.identity.sessionId === identity.sessionId && fence.identity.cardId === identity.cardId
            && fence.identity.contentMode === identity.contentMode;
    });
    if (matching.length === 0 && epoch === 0) return null;
    if (matching.length !== 1 || parsePreferenceClearTombstone(matching[0])!.preferenceEpoch < epoch) {
        throw new Error('preference-source-recovery-fence-unavailable');
    }
    return matching[0];
}


function assertCurrentPreferenceFence(input: LearningPreferenceSourceRecoveryPorts,
    handle: LearningPreferenceSourceRecoveryHandle, entry: LearningPreferenceSkillSourceEntry,
    rawSessionId: string, expected: LearningEventRecord | null): void {
    if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
    if (entry.rawSessionId !== rawSessionId) throw new Error('preference-source-recovery-session-drift');
    const current = currentPreferenceFence(handle, entry);
    if (current?.eventId !== expected?.eventId || current?.payloadDigest !== expected?.payloadDigest
        || current?.createdAt !== expected?.createdAt) {
        throw new Error('preference-source-recovery-clear-fence-drift');
    }
    if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
}


function assertCentralAccepted(result: ReturnType<AgentLearningLedger['append']>): void {
    if (result.discardedStale || result.discardedDeletedSession) {
        throw new InvalidatedPreferenceSource(result.discardedStale
            ? 'preference-source-central-epoch-stale' : 'preference-source-central-session-deleted');
    }
}


/** Source corruption remains retryable; proven history/epoch invalidation cannot restore discarded evidence. */
export async function reconcileLearningPreferenceSkillSources(input: LearningPreferenceSourceRecoveryPorts,
    rawSessionId: string, limit = 64, cursor = 0): Promise<LearningPreferenceSourceRecoveryResult> {
    let handle: LearningPreferenceSourceRecoveryHandle | null = null;
    let attempted = 0;
    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    let nextCursor = 0;
    let hasMore = false;
    const now = input.now ?? (() => new Date().toISOString());
    try {
        if (input.allowed(rawSessionId) !== true) {
            return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
        }
        handle = await input.open(rawSessionId);
        if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
        if (!handle) return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
        const batch = handle.outbox.scan(limit, cursor);
        attempted = batch.attempted;
        failed = batch.failed;
        nextCursor = batch.nextCursor;
        hasMore = batch.hasMore;
        for (const entry of batch.entries) {
            try {
                if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
                if (entry.rawSessionId !== rawSessionId) throw new Error('preference-source-recovery-session-drift');
                const current = (): void => assertCurrentSource(input, handle!, entry, rawSessionId);
                const fence = currentPreferenceFence(handle, entry);
                const currentFence = (): void => {
                    assertCurrentPreferenceFence(input, handle!, entry, rawSessionId, fence);
                };
                currentFence();
                if (fence) {
                    // A committed clear must recover even when it deliberately removed the source event.
                    const result = input.ledger.append(fence);
                    currentFence();
                    assertCentralAccepted(result);
                }
                if (entry.state === 'invalidated') { skipped += 1; continue; }
                current();
                currentFence();
                assertCentralAccepted(input.ledger.append(entry.learningEvent));
                current();
                currentFence();
                handle.outbox.acknowledge(entry, now());
                currentFence();
                delivered += 1;
            } catch (error) {
                if (error instanceof InvalidatedPreferenceSource && input.allowed(rawSessionId) === true) {
                    try {
                        // A new corrupt row cannot be hidden by a previously observed stale state.
                        handle.outbox.readCurrentEvent(entry);
                        if (input.allowed(rawSessionId) !== true) throw new Error('preference-source-recovery-fenced');
                        handle.outbox.invalidate(entry, now(), error.reasonCode);
                        skipped += 1;
                    } catch { failed += 1; }
                } else failed += 1;
            }
        }
    } catch { failed += 1; }
    finally {
        try { handle?.close(); } catch { failed += 1; }
    }
    return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
}

interface SessionSweep {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    wakeRequested: boolean;
    cursor: number;
    failures: number;
    sweepHadFailures: boolean;
}


/** Fair retained-row replay restores a missing central ledger without changing original source timestamps. */
export function createLearningPreferenceSkillSourceScheduler(input: LearningPreferenceSourceRecoveryPorts & {
    readonly onFailure?: () => void;
    readonly retryBaseMs?: number;
}) {
    const retryBaseMs = input.retryBaseMs ?? 1_000;
    if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 60_000) {
        throw new Error('preference-source-retry-base-invalid');
    }
    const sessions = new Map<string, SessionSweep>();
    let closed = false;
    const isAllowed = (sessionId: string): boolean => {
        try { return input.allowed(sessionId) === true; }
        catch { return false; }
    };
    const eligible = (sessionId: string, state: SessionSweep): boolean => !closed
        && sessions.get(sessionId) === state && isAllowed(sessionId);
    const queue = (sessionId: string, state: SessionSweep, delay: number): void => {
        if (!eligible(sessionId, state) || state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            state.running = true;
            void run(sessionId, state);
        }, delay);
        state.timer.unref();
    };
    const run = async (sessionId: string, state: SessionSweep): Promise<void> => {
        let nextDelay: number | null = null;
        try {
            const result = await reconcileLearningPreferenceSkillSources({
                ...input, allowed: (id) => id === sessionId && eligible(sessionId, state),
            }, sessionId, 64, state.cursor);
            state.cursor = result.nextCursor;
            state.sweepHadFailures ||= result.failed > 0;
            if (result.hasMore) nextDelay = 0;
            else if (state.sweepHadFailures) {
                state.sweepHadFailures = false;
                throw new Error('preference-source-recovery-sweep-pending');
            } else state.failures = 0;
        } catch {
            state.failures = Math.min(16, state.failures + 1);
            nextDelay = Math.min(60_000, retryBaseMs * 2 ** (state.failures - 1));
            try { input.onFailure?.(); } catch { /* Diagnostics cannot alter committed learning telemetry. */ }
        } finally {
            state.running = false;
            if (!eligible(sessionId, state)) return;
            if (state.wakeRequested && nextDelay === null) {
                state.wakeRequested = false;
                state.cursor = 0;
                nextDelay = 0;
            }
            if (nextDelay !== null) queue(sessionId, state, nextDelay);
            else sessions.delete(sessionId);
        }
    };
    return Object.freeze({
        schedule(rawSessionId: string) {
            if (closed || !isAllowed(rawSessionId)) return;
            let state = sessions.get(rawSessionId);
            if (!state) {
                state = {
                    timer: null, running: false, wakeRequested: false, cursor: 0,
                    failures: 0, sweepHadFailures: false,
                };
                sessions.set(rawSessionId, state);
            } else if (state.running || state.cursor > 0) state.wakeRequested = true;
            if (!state.running) queue(rawSessionId, state, 0);
        },
        cancel(rawSessionId: string) {
            const state = sessions.get(rawSessionId);
            if (state?.timer) clearTimeout(state.timer);
            sessions.delete(rawSessionId);
        },
        close() {
            closed = true;
            for (const state of sessions.values()) if (state.timer) clearTimeout(state.timer);
            sessions.clear();
        },
    });
}
