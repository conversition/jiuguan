/** Original MODEL-only correction component. Fixed model2/tool0/write0; this
 * wrapper never selects the independent proposal capability or ACT route. */
import { createAgentLoopMaintenanceCorrectionModelMechanism,
  type AgentLoopMaintenanceCorrectionModelOptions } from './agent-loop-maintenance-correction-model-internal.ts';
export type { AgentLoopMaintenanceCorrectionModelCurrent,
  AgentLoopMaintenanceCorrectionModelOptions } from './agent-loop-maintenance-correction-model-internal.ts';

export function createAgentLoopMaintenanceCorrectionModel(options: AgentLoopMaintenanceCorrectionModelOptions) {
  return createAgentLoopMaintenanceCorrectionModelMechanism(options, 'model-only');
}
