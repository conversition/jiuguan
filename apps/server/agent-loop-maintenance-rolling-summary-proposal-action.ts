/** Original single-pass proposal host. The closed correction branch does not
 * change this factory's one-MODEL contract or grant. */
import { createAgentLoopMaintenanceRollingSummaryProposalActionMechanism,
  type AgentLoopMaintenanceRollingSummaryProposalActionOptions as Options } from './agent-loop-maintenance-rolling-summary-proposal-action-internal.ts';
export type AgentLoopMaintenanceRollingSummaryProposalActionOptions = Options;
export function createAgentLoopMaintenanceRollingSummaryProposalAction(options: AgentLoopMaintenanceRollingSummaryProposalActionOptions) {
  return createAgentLoopMaintenanceRollingSummaryProposalActionMechanism(options, 'single-pass');
}
