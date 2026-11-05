/** @author Codex @date 2026-10-14 @version 1.0
 * Independent recovery of pending/direct proposals joined to stored business history, never current facts.
 */
import type { AgentClosureStore } from '../agent-closure-store.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import {
    buildMaintenanceMemoryWriteJoin, type MaintenanceMemoryWriteJoinOutbox,
    type MemoryWriteJoinPacket
} from '../maintenance-memory-write-join.ts';
import type { MemorySummaryMaintenanceCommitter } from '../memory-summary-maintenance-committer.ts';

export interface MaintenanceMemoryWriteRecoveryPorts {
    readonly manager: Pick<MaintenanceJobManager, 'scanAllMemorySkillProvenance'
        | 'readMemorySkillProvenance' | 'getProposalForJob'>
        & Partial<Pick<MaintenanceJobManager, 'getMemoryWriteProposalForJob'>>;
    readonly closure: Pick<AgentClosureStore, 'begin' | 'record'>;
    readonly allowed: (sessionId: string) => boolean;
    readonly open: (sessionId: string) => MemoryWriteRecoveryHandle | null
        | Promise<MemoryWriteRecoveryHandle | null>;
    readonly now?: () => string;
}

export interface MemoryWriteRecoveryHandle {
    readonly committer: Pick<MemorySummaryMaintenanceCommitter, 'readMemoryWriteEvidence'>;
    readonly outbox: Pick<MaintenanceMemoryWriteJoinOutbox, 'stage' | 'delivered' | 'acknowledge'>;
    close(): void;
}

/** A control-DB failure after Session COMMIT must not suppress recovery of that committed domain write. */
export function withMaintenanceMemoryWriteWake<T>(work: () => T, wake: () => void): T {
    try { return work(); }
    finally {
        try { wake(); } catch { /* Recovery scheduling never changes the business result. */ }
    }
}

export async function reconcileMaintenanceMemoryWrites(input: MaintenanceMemoryWriteRecoveryPorts,
    limit = 64, cursor = 0) {
    const batch = input.manager.scanAllMemorySkillProvenance(limit, cursor);
    let delivered = 0;
    let skipped = 0;
    let failed = batch.failed;
    for (const entry of batch.entries) {
        let handle: MemoryWriteRecoveryHandle | null = null;
        try {
            const requireOpen = (): void => {
                if (!input.allowed(entry.run.sessionId)) throw new Error('memory-write-recovery-fenced');
            };
            requireOpen();
            const readProposal = () => input.manager.getMemoryWriteProposalForJob
                ? input.manager.getMemoryWriteProposalForJob(entry.run.runId)
                : input.manager.getProposalForJob(entry.run.runId);
            if (!readProposal()) { skipped += 1; continue; }
            handle = await input.open(entry.run.sessionId);
            requireOpen();
            if (!handle) throw new Error('memory-write-recovery-session-unavailable');
            const current = (): MemoryWriteJoinPacket | null => {
                requireOpen();
                const source = input.manager.readMemorySkillProvenance(entry.run.runId);
                const proposal = readProposal();
                if (!source || source.payloadDigest !== entry.payloadDigest || !proposal) {
                    throw new Error('memory-write-recovery-source-drift');
                }
                const evidence = handle!.committer.readMemoryWriteEvidence(entry.run.runId);
                if (!evidence) {
                    // Preparation is not a business outcome; even a failed job can already have committed history.
                    if (['pending', 'rejected', 'stale', 'prepared'].includes(proposal.status)) {
                        return null;
                    }
                    throw new Error('memory-write-recovery-history-unavailable');
                }
                return buildMaintenanceMemoryWriteJoin(source, proposal, evidence);
            };
            const expected = current();
            if (!expected) { skipped += 1; continue; }
            const source = input.manager.readMemorySkillProvenance(entry.run.runId)!;
            const proposal = readProposal()!;
            const evidence = handle.committer.readMemoryWriteEvidence(entry.run.runId)!;
            const packet = handle.outbox.stage(source, proposal, evidence);
            const requireSame = (): void => {
                if (current()?.packetDigest !== packet.packetDigest || packet.packetDigest !== expected.packetDigest) {
                    throw new Error('memory-write-recovery-business-drift');
                }
            };
            requireSame();
            if (handle.outbox.delivered(packet)) { skipped += 1; continue; }
            input.closure.begin(packet.run);
            for (const event of packet.events) {
                requireSame();
                input.closure.record(packet.run.operationId, event);
            }
            requireSame();
            handle.outbox.acknowledge(packet, (input.now ?? (() => new Date().toISOString()))());
            delivered += 1;
        } catch {
            failed += 1;
        } finally {
            try { handle?.close(); } catch { failed += 1; }
        }
    }
    return Object.freeze({
        attempted: batch.attempted, delivered, skipped, failed,
        nextCursor: batch.nextCursor, hasMore: batch.hasMore
    });
}

/** A source ack does not remove write candidates. One fair bounded sweep also sees later approvals. */
export function createMaintenanceMemoryWriteScheduler(input: MaintenanceMemoryWriteRecoveryPorts & {
    readonly onFailure?: () => void;
    readonly retryBaseMs?: number;
}) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let running = false;
    let wakeRequested = false;
    let cursor = 0;
    let failures = 0;
    let sweepHadFailures = false;
    const schedule = (delay = 0): void => {
        if (closed) return;
        if (running) { wakeRequested = true; return; }
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            running = true;
            void run();
        }, delay);
        timer.unref();
    };
    const run = async (): Promise<void> => {
        let nextDelay: number | null = null;
        try {
            const result = await reconcileMaintenanceMemoryWrites({
                ...input,
                allowed: (id) => !closed && input.allowed(id)
            }, 64, cursor);
            cursor = result.nextCursor;
            sweepHadFailures ||= result.failed > 0;
            if (result.hasMore) nextDelay = 0;
            else if (sweepHadFailures) {
                sweepHadFailures = false;
                throw new Error('memory-write-recovery-sweep-pending');
            } else failures = 0;
        } catch {
            failures = Math.min(16, failures + 1);
            nextDelay = Math.min(60_000, (input.retryBaseMs ?? 1_000) * 2 ** (failures - 1));
            try { input.onFailure?.(); } catch { /* Diagnostics never obstruct recovery. */ }
        } finally {
            running = false;
            if (wakeRequested && nextDelay === null) {
                wakeRequested = false;
                // scanAll retains delivered rows: only an explicit wakeup starts another full sweep.
                cursor = 0;
                nextDelay = 0;
            }
            if (nextDelay !== null) schedule(nextDelay);
        }
    };
    return Object.freeze({
        schedule: () => {
            // Low-rowid approvals between pages must survive the already queued tail timer.
            if (timer && cursor > 0) wakeRequested = true;
            schedule();
        }, close() {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
        }
    });
}
