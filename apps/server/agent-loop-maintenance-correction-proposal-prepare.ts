/** Independent shadow correction-proposal initial Prepare only. The original
 * Store atomically pins model2/tool1/write1 without doubling total ceilings.
 * Its live proposal capability is finalized only after that real COMMIT; this
 * factory does not run MODEL/Action, publish, Verify or complete any job. */
import { createAgentLoopMaintenanceCorrectionPrepareMechanism,
  type AgentLoopMaintenanceCorrectionPrepareOptions } from './agent-loop-maintenance-correction-prepare-internal.ts';

export type { AgentLoopMaintenanceCorrectionProposalPrepareResult } from './agent-loop-maintenance-correction-prepare-internal.ts';

export function createAgentLoopMaintenanceCorrectionProposalPrepare(options: AgentLoopMaintenanceCorrectionPrepareOptions) {
  return createAgentLoopMaintenanceCorrectionPrepareMechanism(options, 'shadow-proposal');
}
