/** @author Codex @date 2026-10-14 @version 1.0
 * Replays only committed original Memory adoption; never loads Skill bodies or retries a Provider.
 */
import type {
    MemoryConsumptionEntry, MemoryConsumptionOutbox,
} from '../../../packages/memory/public/maintenance-memory-consumption-outbox.ts';
import type { AgentClosureStore } from '../agent-closure-store.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { buildMaintenanceMemoryWriteJoin } from '../maintenance-memory-write-join.ts';
import type { MemorySummaryMaintenanceCommitter } from '../memory-summary-maintenance-committer.ts';

export interface MemoryConsumptionRecoveryHandle {
    readonly outbox: Pick<MemoryConsumptionOutbox, 'scan' | 'consumerIsCurrent' | 'acknowledge' | 'invalidate'>;
    readonly committer: Pick<MemorySummaryMaintenanceCommitter, 'readMemoryWriteEvidence'>;
    close(): void;
}

export interface MaintenanceMemoryConsumptionRecoveryPorts {
    readonly manager: Pick<MaintenanceJobManager, 'readMemorySkillProvenance' | 'getMemoryWriteProposalForJob'>;
    readonly closure: Pick<AgentClosureStore, 'begin' | 'record'>;
    readonly allowed: (sessionId: string) => boolean;
    readonly open: (sessionId: string) => MemoryConsumptionRecoveryHandle | null
        | Promise<MemoryConsumptionRecoveryHandle | null>;
    readonly now?: () => string;
    readonly onDelivered?: (sessionId: string) => void;
}

class InvalidatedConsumption extends Error {
    constructor(readonly reasonCode: string) { super(reasonCode); }
}

function assertCurrentSource(input: MaintenanceMemoryConsumptionRecoveryPorts,
    handle: MemoryConsumptionRecoveryHandle, entry: MemoryConsumptionEntry): void {
    if (input.allowed(entry.run.sessionId) !== true) throw new Error('memory-consumption-recovery-fenced');
    const source = input.manager.readMemorySkillProvenance(entry.run.runId);
    const proposal = input.manager.getMemoryWriteProposalForJob(entry.run.runId);
    if (!source || !proposal || source.payloadDigest !== entry.sourcePayloadDigest
        || source.proof.proofDigest !== entry.proofDigest || source.proof.contentMode !== entry.contentMode
        || JSON.stringify(source.run) !== JSON.stringify(entry.run)) {
        throw new Error('memory-consumption-recovery-source-drift');
    }
    const evidence = handle.committer.readMemoryWriteEvidence(entry.run.runId);
    if (!evidence) throw new Error('memory-consumption-recovery-history-unavailable');
    const packet = buildMaintenanceMemoryWriteJoin(source, proposal, evidence);
    if (packet.intentDigest !== entry.intentDigest
        || JSON.stringify(source.proof.attribution) !== JSON.stringify(entry.event.skillAttribution)) {
        throw new Error('memory-consumption-recovery-proof-drift');
    }
    if (evidence.state === 'rolled_back') {
        throw new InvalidatedConsumption('memory-consumption-source-rolled-back');
    }
    if (packet.packetDigest !== entry.writeJoinDigest || packet.readbackDigest === null
        || packet.rollbackDigest !== null || packet.readbackDigest !== entry.event.artifactDigest
        || JSON.stringify(packet.events) !== JSON.stringify(entry.prerequisites)) {
        throw new Error('memory-consumption-recovery-write-drift');
    }
    if (!handle.outbox.consumerIsCurrent(entry)) {
        throw new InvalidatedConsumption('memory-consumption-consumer-invalidated');
    }
    if (input.allowed(entry.run.sessionId) !== true) throw new Error('memory-consumption-recovery-fenced');
}

/** Every central write and ack is fenced again; source/consumer drift never becomes a repaired success. */
export async function reconcileMaintenanceMemoryConsumptions(input: MaintenanceMemoryConsumptionRecoveryPorts,
    sessionId: string, limit = 64, cursor = 0) {
    if (input.allowed(sessionId) !== true) {
        return Object.freeze({ attempted: 0, delivered: 0, skipped: 0, failed: 0, nextCursor: 0, hasMore: false });
    }
    let handle: MemoryConsumptionRecoveryHandle | null = null;
    let attempted = 0;
    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    let nextCursor = 0;
    let hasMore = false;
    try {
        handle = await input.open(sessionId);
        if (input.allowed(sessionId) !== true) throw new Error('memory-consumption-recovery-fenced');
        if (!handle) return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
        const batch = handle.outbox.scan(limit, cursor);
        attempted = batch.attempted;
        failed = batch.failed;
        nextCursor = batch.nextCursor;
        hasMore = batch.hasMore;
        for (const entry of batch.entries) {
            try {
                if (entry.run.sessionId !== sessionId) throw new Error('memory-consumption-recovery-session-drift');
                const current = (): void => assertCurrentSource(input, handle!, entry);
                current();
                input.closure.begin(entry.run);
                for (const event of [...entry.prerequisites, entry.event]) {
                    current();
                    input.closure.record(entry.run.operationId, event);
                }
                current();
                handle.outbox.acknowledge(entry, (input.now ?? (() => new Date().toISOString()))());
                delivered += 1;
                try { input.onDelivered?.(sessionId); } catch { /* committed receipt remains authoritative */ }
            } catch (error) {
                if (error instanceof InvalidatedConsumption && input.allowed(sessionId) === true) {
                    try {
                        handle.outbox.invalidate(entry, (input.now ?? (() => new Date().toISOString()))(),
                            error.reasonCode);
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

/** Fair retained-row sweeps are per Session and resume after transient central/ack failures. */
export function createMaintenanceMemoryConsumptionScheduler(input: MaintenanceMemoryConsumptionRecoveryPorts & {
    readonly onFailure?: () => void;
    readonly retryBaseMs?: number;
}) {
    const retryBaseMs = input.retryBaseMs ?? 1_000;
    if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 60_000) {
        throw new Error('memory-consumption-retry-base-invalid');
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
            const result = await reconcileMaintenanceMemoryConsumptions({
                ...input, allowed: (id) => id === sessionId && eligible(sessionId, state),
            }, sessionId, 64, state.cursor);
            state.cursor = result.nextCursor;
            state.sweepHadFailures ||= result.failed > 0;
            if (result.hasMore) nextDelay = 0;
            else if (state.sweepHadFailures) {
                state.sweepHadFailures = false;
                throw new Error('memory-consumption-recovery-sweep-pending');
            } else state.failures = 0;
        } catch {
            state.failures = Math.min(16, state.failures + 1);
            nextDelay = Math.min(60_000, retryBaseMs * 2 ** (state.failures - 1));
            try { input.onFailure?.(); } catch { /* Diagnostics cannot hold a Session transaction open. */ }
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
        schedule(sessionId: string) {
            if (closed || !isAllowed(sessionId)) return;
            let state = sessions.get(sessionId);
            if (!state) {
                state = {
                    timer: null, running: false, wakeRequested: false, cursor: 0,
                    failures: 0, sweepHadFailures: false,
                };
                sessions.set(sessionId, state);
            } else if (state.running || state.cursor > 0) state.wakeRequested = true;
            if (!state.running) queue(sessionId, state, 0);
        },
        cancel(sessionId: string) {
            const state = sessions.get(sessionId);
            if (state?.timer) clearTimeout(state.timer);
            sessions.delete(sessionId);
        },
        close() {
            closed = true;
            for (const state of sessions.values()) if (state.timer) clearTimeout(state.timer);
            sessions.clear();
        },
    });
}
