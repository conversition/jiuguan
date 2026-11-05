/** Original MODEL-only initial correction Prepare. No Action capability,
 * Provider, Runtime selection or production permission is added by this API. */
import { createAgentLoopMaintenanceCorrectionPrepareMechanism,
  type AgentLoopMaintenanceCorrectionPrepareOptions } from './agent-loop-maintenance-correction-prepare-internal.ts';

export type { AgentLoopMaintenanceCorrectionPrepareCurrent, AgentLoopMaintenanceCorrectionPrepareResult,
  AgentLoopMaintenanceCorrectionPrepareOptions } from './agent-loop-maintenance-correction-prepare-internal.ts';

export function createAgentLoopMaintenanceCorrectionPrepare(options: AgentLoopMaintenanceCorrectionPrepareOptions) {
  return createAgentLoopMaintenanceCorrectionPrepareMechanism(options, 'model-only');
}
