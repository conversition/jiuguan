/** Pre-ACT successful correction slot only; original Registry/Gateway/Manager
 * stages one shadow proposal. No MODEL, publication, Verify or completion. */
import { createAgentLoopMaintenanceRollingSummaryProposalActionMechanism,
  type AgentLoopMaintenanceCorrectionProposalActionOptions as Options } from './agent-loop-maintenance-rolling-summary-proposal-action-internal.ts';
export type AgentLoopMaintenanceCorrectionProposalActionOptions = Options;
export function createAgentLoopMaintenanceCorrectionProposalAction(options: AgentLoopMaintenanceCorrectionProposalActionOptions) {
  return createAgentLoopMaintenanceRollingSummaryProposalActionMechanism(options, 'correction-proposal');
}
