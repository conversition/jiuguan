/** @author Codex @date 2026-10-14 @version 1.0
 * Independent Summary task/source and immutable business-history delivery; never model execution.
 */
import type { AgentClosureStore } from '../agent-closure-store.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import {
    buildMaintenanceSummaryWriteJoin, type MaintenanceSummaryWriteJoinOutbox, type SummaryWriteJoinPacket,
} from '../maintenance-summary-write-join.ts';
import type { MemorySummaryMaintenanceCommitter } from '../memory-summary-maintenance-committer.ts';

export interface SummaryWriteRecoveryHandle {
    readonly committer: Pick<MemorySummaryMaintenanceCommitter, 'readSummaryWriteEvidence'>;
    readonly outbox: Pick<MaintenanceSummaryWriteJoinOutbox, 'stage' | 'delivered' | 'acknowledge'>;
    close(): void;
}

export interface MaintenanceSummaryWriteRecoveryPorts {
    readonly manager: Pick<MaintenanceJobManager, 'scanAllSummarySkillProvenance' | 'readSummarySkillProvenance'
        | 'getSummarySkillProposal' | 'acknowledgeSummarySkillProvenance'>
    & Partial<Pick<MaintenanceJobManager, 'getProposalForJob'>>;
    readonly closure: Pick<AgentClosureStore, 'begin' | 'record'>;
    readonly allowed: (sessionId: string) => boolean;
    readonly open: (sessionId: string) => SummaryWriteRecoveryHandle | null
        | Promise<SummaryWriteRecoveryHandle | null>;
    readonly now?: () => string;
}


/** A separate control-DB completion failure cannot suppress recovery of an already committed Summary. */
export function withMaintenanceSummaryWriteWake<T>(work: () => T, wake: () => void): T {
    try { return work(); }
    finally {
        try { wake(); } catch { /* Scheduling never changes the authorized business outcome. */ }
    }
}


export async function reconcileMaintenanceSummaryWrites(input: MaintenanceSummaryWriteRecoveryPorts,
    limit = 64, cursor = 0) {
    const batch = input.manager.scanAllSummarySkillProvenance(limit, cursor);
    let delivered = 0;
    let skipped = 0;
    let failed = batch.failed;
    for (const entry of batch.entries) {
        let handle: SummaryWriteRecoveryHandle | null = null;
        try {
            const requireOpen = (): void => {
                if (!input.allowed(entry.run.sessionId)) throw new Error('summary-write-recovery-fenced');
            };
            const sourceOnly = (): SummaryWriteJoinPacket => {
                requireOpen();
                const source = input.manager.readSummarySkillProvenance(entry.run.runId);
                const record = input.manager.getSummarySkillProposal(entry.run.runId);
                if (!source || source.payloadDigest !== entry.payloadDigest || !record) {
                    throw new Error('summary-write-recovery-source-drift');
                }
                return buildMaintenanceSummaryWriteJoin(source, record, null);
            };
            const initial = sourceOnly();
            input.closure.begin(initial.run);
            for (const event of initial.events) {
                if (sourceOnly().packetDigest !== initial.packetDigest) {
                    throw new Error('summary-write-recovery-source-drift');
                }
                input.closure.record(initial.run.operationId, event);
            }
            if (sourceOnly().packetDigest !== initial.packetDigest) {
                throw new Error('summary-write-recovery-source-drift');
            }
            input.manager.acknowledgeSummarySkillProvenance(entry);
            handle = await input.open(entry.run.sessionId);
            requireOpen();
            if (!handle) throw new Error('summary-write-recovery-session-unavailable');
            const current = (): SummaryWriteJoinPacket => {
                const sourcePacket = sourceOnly();
                if (sourcePacket.packetDigest !== initial.packetDigest) {
                    throw new Error('summary-write-recovery-source-drift');
                }
                const source = input.manager.readSummarySkillProvenance(entry.run.runId)!;
                const record = input.manager.getSummarySkillProposal(entry.run.runId)!;
                return buildMaintenanceSummaryWriteJoin(source, record,
                    handle!.committer.readSummaryWriteEvidence(entry.run.runId),
                    record.status === 'pending' ? input.manager.getProposalForJob?.(entry.run.runId) : null);
            };
            const expected = current();
            const source = input.manager.readSummarySkillProvenance(entry.run.runId)!;
            const record = input.manager.getSummarySkillProposal(entry.run.runId)!;
            const history = handle.committer.readSummaryWriteEvidence(entry.run.runId);
            const staged = handle.outbox.stage(source, record, history,
                record.status === 'pending' ? input.manager.getProposalForJob?.(entry.run.runId) : null);
            const requireSame = (): void => {
                if (current().packetDigest !== staged.packetDigest || staged.packetDigest !== expected.packetDigest) {
                    throw new Error('summary-write-recovery-business-drift');
                }
            };
            requireSame();
            if (handle.outbox.delivered(staged)) { skipped += 1; continue; }
            for (const event of staged.events.slice(3)) {
                requireSame();
                input.closure.record(staged.run.operationId, event);
            }
            requireSame();
            handle.outbox.acknowledge(staged, (input.now ?? (() => new Date().toISOString()))());
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


/** Retained/acked sources remain candidates for later approvals; one wake performs one fair bounded sweep. */
export function createMaintenanceSummaryWriteScheduler(input: MaintenanceSummaryWriteRecoveryPorts & {
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
            if (closed) return;
            running = true;
            void run();
        }, delay);
        timer.unref();
    };
    const run = async (): Promise<void> => {
        let nextDelay: number | null = null;
        try {
            const result = await reconcileMaintenanceSummaryWrites({
                ...input,
                allowed: (sessionId) => !closed && input.allowed(sessionId)
            }, 64, cursor);
            cursor = result.nextCursor;
            sweepHadFailures ||= result.failed > 0;
            if (result.hasMore) nextDelay = 0;
            else if (sweepHadFailures) {
                sweepHadFailures = false;
                cursor = 0;
                throw new Error('summary-write-recovery-sweep-pending');
            } else failures = 0;
        } catch {
            failures = Math.min(16, failures + 1);
            nextDelay = Math.min(60_000, (input.retryBaseMs ?? 1_000) * 2 ** (failures - 1));
            try { input.onFailure?.(); } catch { /* Diagnostics never obstruct recovery. */ }
        } finally {
            running = false;
            if (wakeRequested && nextDelay === null) {
                wakeRequested = false;
                cursor = 0;
                nextDelay = 0;
            }
            if (nextDelay !== null) schedule(nextDelay);
        }
    };
    return Object.freeze({
        schedule: (_sessionId?: string) => {
            if (timer && cursor > 0) wakeRequested = true;
            schedule();
        },
        close() {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    });
}
