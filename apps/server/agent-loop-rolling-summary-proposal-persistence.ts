/** Exact proposal-staging adapter. Shared persistence does not authorize execution. */
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { createAgentLoopRollingSummaryActionPersistence,
    type AgentLoopRollingSummaryActionPersistence } from './agent-loop-rolling-summary-action-persistence.ts';

export type AgentLoopRollingSummaryProposalPersistence = AgentLoopRollingSummaryActionPersistence;
export function createAgentLoopRollingSummaryProposalPersistence(
    options: Parameters<typeof createAgentLoopRollingSummaryActionPersistence>[0],
): AgentLoopRollingSummaryProposalPersistence {
    return createAgentLoopRollingSummaryActionPersistence(options, AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT);
}
