/** Exact domain-apply receipt adapter, not a writer or trusted apply host.
 * A started/unknown write keeps its hold and can never re-enter through legacy
 * Gateway reconciliation with a receipt ref and fabricated zero usage. */
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { createAgentLoopRollingSummaryActionPersistence,
    type AgentLoopRollingSummaryActionPersistence } from './agent-loop-rolling-summary-action-persistence.ts';

export type AgentLoopRollingSummaryApplyPersistence = AgentLoopRollingSummaryActionPersistence;
export function createAgentLoopRollingSummaryApplyPersistence(
    options: Parameters<typeof createAgentLoopRollingSummaryActionPersistence>[0],
): AgentLoopRollingSummaryApplyPersistence {
    return createAgentLoopRollingSummaryActionPersistence(options, AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT);
}
