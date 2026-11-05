/** @author Codex @date 2026-10-16 @version 1.0
 * Fair retained-receipt delivery; a cursor is progress, never model or business replay authority.
 */
export interface EvidenceRecoveryPage {
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}


interface Sweep {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    wake: boolean;
    cursor: number;
    failures: number;
    hadFailures: boolean;
}


export function createEvidenceRecoveryScheduler(input: {
    allowed(rawSessionId: string): boolean;
    reconcile(rawSessionId: string, limit: number, cursor: number,
        allowed: (rawSessionId: string) => boolean): Promise<EvidenceRecoveryPage>;
    onFailure?(): void;
    retryBaseMs?: number;
    /** False stops this sweep after failure; a later explicit schedule may start a new one. */
    retryOnFailure?: boolean;
}) {
    const base = input.retryBaseMs ?? 1_000;
    if (!Number.isSafeInteger(base) || base < 1 || base > 60_000) throw new Error('evidence-retry-base-invalid');
    const sessions = new Map<string, Sweep>();
    let closed = false;
    const allowed = (id: string): boolean => {
        try { return input.allowed(id) === true; }
        catch { return false; }
    };
    const current = (id: string, state: Sweep): boolean => !closed && sessions.get(id) === state && allowed(id);
    const queue = (id: string, state: Sweep, delay: number): void => {
        if (!current(id, state)) {
            if (input.retryOnFailure === false && sessions.get(id) === state) sessions.delete(id);
            return;
        }
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            state.running = true;
            void run(id, state);
        }, delay);
        state.timer.unref();
    };
    const run = async (id: string, state: Sweep): Promise<void> => {
        let delay: number | null = null;
        let stoppedForFailure = false;
        try {
            const page = await input.reconcile(id, 64, state.cursor,
                (candidate) => candidate === id && current(id, state));
            if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < state.cursor
                || page.hasMore && page.nextCursor === state.cursor) {
                throw new Error('evidence-recovery-cursor-invalid');
            }
            state.cursor = page.nextCursor;
            state.hadFailures ||= page.failed > 0;
            if (page.hasMore) delay = 0;
            else if (state.hadFailures) throw new Error('evidence-recovery-sweep-pending');
            else state.failures = 0;
        } catch {
            state.cursor = 0;
            state.hadFailures = false;
            state.failures = Math.min(16, state.failures + 1);
            if (input.retryOnFailure === false) {
                state.wake = false;
                delay = null;
                stoppedForFailure = true;
            } else delay = Math.min(60_000, base * 2 ** (state.failures - 1));
            try { input.onFailure?.(); } catch { /* Observation cannot change committed receipt bytes. */ }
        } finally {
            state.running = false;
            if (stoppedForFailure) {
                if (sessions.get(id) === state) sessions.delete(id);
                return;
            }
            if (!current(id, state)) {
                if (input.retryOnFailure === false && sessions.get(id) === state) sessions.delete(id);
                return;
            }
            if (state.wake && delay === null) {
                state.wake = false;
                state.cursor = 0;
                delay = 0;
            }
            if (delay !== null) queue(id, state, delay);
            else sessions.delete(id);
        }
    };
    return Object.freeze({
        schedule(id: string) {
            if (closed || !allowed(id)) return;
            const existing = sessions.get(id);
            if (existing) { existing.wake = true; return; }
            const state: Sweep = {
                timer: null, running: false, wake: false, cursor: 0, failures: 0, hadFailures: false,
            };
            sessions.set(id, state);
            queue(id, state, 0);
        },
        cancel(id: string) {
            const state = sessions.get(id);
            if (state?.timer) clearTimeout(state.timer);
            sessions.delete(id);
        },
        close() {
            closed = true;
            for (const state of sessions.values()) if (state.timer) clearTimeout(state.timer);
            sessions.clear();
        },
    });
}
