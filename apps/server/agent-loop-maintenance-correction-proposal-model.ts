/** Independent corrected-shadow proposal MODEL wrapper. A genuine initial
 * proposal cap and its original full policy are mandatory; no new grant/runner. */
import { createAgentLoopMaintenanceCorrectionModelMechanism,
  type AgentLoopMaintenanceCorrectionModelOptions } from './agent-loop-maintenance-correction-model-internal.ts';
import type { AgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';
import type { AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';

export interface AgentLoopMaintenanceCorrectionProposalModelOptions extends Omit<AgentLoopMaintenanceCorrectionModelOptions, 'policy'> {
  readonly policy: AgentLoopModelCorrectionPolicy;
  readonly proposalCapability: AgentLoopCorrectionProposalCapability;
}
export function createAgentLoopMaintenanceCorrectionProposalModel(options: AgentLoopMaintenanceCorrectionProposalModelOptions) {
  return createAgentLoopMaintenanceCorrectionModelMechanism(options, 'shadow-proposal');
}
