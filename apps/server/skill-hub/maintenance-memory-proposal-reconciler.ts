/** @author Codex @date 2026-10-14 @version 1.0
 * Replays task-owned initial evidence only, never models or current business projections.
 */
import type { AgentClosureStore } from '../agent-closure-store.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';

export function reconcileMaintenanceMemorySkillProposals(
    manager: Pick<MaintenanceJobManager, 'scanMemorySkillProvenance' | 'acknowledgeMemorySkillProvenance'>,
    closure: Pick<AgentClosureStore, 'begin' | 'record'>,
    allowed: (sessionId: string) => boolean,
    limit = 64,
    cursor = 0,
): Readonly<{ attempted: number; delivered: number; failed: number; nextCursor: number; hasMore: boolean }> {
    const batch = manager.scanMemorySkillProvenance(limit, cursor);
    let delivered = 0;
    let failed = batch.failed;
    for (const entry of batch.entries) {
        try {
            const requireOpen = () => {
                if (!allowed(entry.run.sessionId)) throw new Error('memory-skill-recovery-fenced');
            };
            requireOpen();
            closure.begin(entry.run);
            for (const event of entry.events) {
                requireOpen();
                closure.record(entry.run.operationId, event);
            }
            requireOpen();
            manager.acknowledgeMemorySkillProvenance(entry);
            delivered += 1;
        } catch {
            failed += 1;
        }
    }
    return Object.freeze({
        attempted: batch.attempted, delivered, failed,
        nextCursor: batch.nextCursor, hasMore: batch.hasMore
    });
}

/** Independent bounded delivery, even when forward live switches are now off. */
export function createMaintenanceMemorySkillProposalScheduler(input: {
    readonly manager: Parameters<typeof reconcileMaintenanceMemorySkillProposals>[0];
    readonly closure: Parameters<typeof reconcileMaintenanceMemorySkillProposals>[1];
    readonly allowed: (sessionId: string) => boolean;
    readonly onFailure?: () => void;
    readonly retryBaseMs?: number;
}) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let failures = 0;
    let cursor = 0;
    let sweepHadFailures = false;
    const schedule = (delay = 0): void => {
        if (closed || timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (closed) return;
            try {
                const scannedFrom = cursor;
                const result = reconcileMaintenanceMemorySkillProposals(
                    input.manager, input.closure, input.allowed, 64, cursor,
                );
                cursor = result.nextCursor;
                sweepHadFailures ||= result.failed > 0;
                if (result.hasMore) {
                    if (result.failed) throw new Error('memory-skill-recovery-page-pending');
                    schedule();
                    return;
                }
                // A successful tail page does not settle a failed earlier page in this sweep.
                if (sweepHadFailures) {
                    sweepHadFailures = false;
                    throw new Error('memory-skill-recovery-sweep-pending');
                }
                // Deleting delivered tail rows can reuse rowids while another page timer already exists.
                if (scannedFrom > 0) {
                    schedule();
                    return;
                }
                failures = 0;
            } catch {
                failures = Math.min(16, failures + 1);
                try { input.onFailure?.(); } catch { /* Diagnostics never obstruct recovery. */ }
                schedule(Math.min(60_000, (input.retryBaseMs ?? 1_000) * 2 ** (failures - 1)));
            }
        }, delay);
        timer.unref();
    };
    return Object.freeze({
        schedule: () => schedule(),
        close() {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    });
}
