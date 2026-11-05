import type { AgentSkillConsumptionOutbox } from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import type { AgentClosureStore } from '../agent-closure-store.ts';

/** Replays committed receipts only. Never retries an Agent, calls a model or reconstructs text. */
export function reconcileAgentSkillConsumptions(
  outbox: AgentSkillConsumptionOutbox,
  closure: Pick<AgentClosureStore, 'begin' | 'record'>,
  limit = 64,
): Readonly<{ attempted: number; delivered: number; failed: number }> {
  const entries = outbox.pending(limit);
  let delivered = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      closure.begin(entry.run);
      // Exact original receipts, including phase timestamps. Conflicting prior intent remains
      // pending; type presence alone never proves a matching validation. Legacy payloads still
      // require their original central prerequisites and are not fabricated during recovery.
      for (const prerequisite of entry.prerequisites ?? []) closure.record(entry.run.operationId, prerequisite);
      closure.record(entry.run.operationId, entry.event);
      // A crash before this ack repeats the same exact idempotency intent, never the model call.
      outbox.acknowledge(entry);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return Object.freeze({ attempted: entries.length, delivered, failed });
}
