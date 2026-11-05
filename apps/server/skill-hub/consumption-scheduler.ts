import type { AgentSkillConsumptionOutbox } from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import type { AgentClosureStore } from '../agent-closure-store.ts';
import { reconcileAgentSkillConsumptions } from './consumption-reconciler.ts';

/** Bounded local delivery, including restart recovery. Never runs a model or loads Skill bodies. */
export function createAgentSkillConsumptionScheduler(dependencies: {
  readonly closure: Pick<AgentClosureStore, 'begin' | 'record'>;
  readonly allowed: (sessionId: string) => boolean;
  readonly open: (sessionId: string) => { outbox: AgentSkillConsumptionOutbox; close(): void } | null;
  readonly onFailure?: () => void;
  readonly onDelivered?: (sessionId: string) => void;
  readonly retryBaseMs?: number;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  let closed = false;
  const schedule = (sessionId: string, delay = 0): void => {
    if (closed || timers.has(sessionId) || !dependencies.allowed(sessionId)) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (closed || !dependencies.allowed(sessionId)) { failures.delete(sessionId); return; }
      let source: ReturnType<typeof dependencies.open> = null;
      try {
        source = dependencies.open(sessionId);
        if (!source) { failures.delete(sessionId); return; }
        const result = reconcileAgentSkillConsumptions(source.outbox, dependencies.closure, 64);
        if (result.delivered) {
          try { dependencies.onDelivered?.(sessionId); } catch { /* committed consumption remains authoritative */ }
        }
        if (result.failed) throw new Error('skill-consumption-delivery-pending');
        failures.delete(sessionId);
        if (result.attempted === 64) schedule(sessionId);
      } catch {
        const attempts = Math.min(16, (failures.get(sessionId) ?? 0) + 1);
        failures.set(sessionId, attempts);
        try { dependencies.onFailure?.(); } catch { /* diagnostics never block recovery */ }
        schedule(sessionId, Math.min(60_000, (dependencies.retryBaseMs ?? 1_000) * 2 ** (attempts - 1)));
      } finally { try { source?.close(); } catch { /* No open handle is retained by the scheduler. */ } }
    }, delay);
    timer.unref();
    timers.set(sessionId, timer);
  };
  return Object.freeze({
    schedule: (sessionId: string) => schedule(sessionId),
    cancel(sessionId: string) {
      const timer = timers.get(sessionId);
      if (timer) clearTimeout(timer);
      timers.delete(sessionId); failures.delete(sessionId);
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); failures.clear();
    },
  });
}
