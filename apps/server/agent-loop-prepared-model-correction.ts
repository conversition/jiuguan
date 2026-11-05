/** Independent one-use initial MODEL-only grant. Not an Action capability,
 * policy/retry permit, legacy PreparedExecution or serialized authorization. */
import { createPreparedModelCorrectionMechanism, type PreparedModelCorrectionData,
  type PreparedModelCorrectionInput } from './agent-loop-prepared-model-correction-internal.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_PREPARED_MODEL_CORRECTION_VERSION = 'agent-loop-prepared-model-correction-v1' as const;
export interface AgentLoopPreparedModelCorrection {
  readonly contractVersion: typeof AGENT_LOOP_PREPARED_MODEL_CORRECTION_VERSION;
}
export interface AgentLoopPreparedModelCorrectionData extends PreparedModelCorrectionData {}
export interface AgentLoopPreparedModelCorrectionInput extends PreparedModelCorrectionInput {}
const mechanism = createPreparedModelCorrectionMechanism('model-only');
export function createAgentLoopPreparedModelCorrection(input: AgentLoopPreparedModelCorrectionInput): AgentLoopPreparedModelCorrection {
  return mechanism.create(input) as AgentLoopPreparedModelCorrection;
}
/** Burn before owner/current/actual Store checks; the Store still verifies its
 * live lease, pristine full tail and synchronous source assertions. */
export function consumeAgentLoopPreparedModelCorrection(value: unknown, current: AgentLoopTaskRecord,
  ownerId: string, store: AgentLoopProjectionStore): AgentLoopPreparedModelCorrectionData {
  return mechanism.consume(value, current, ownerId, store);
}
