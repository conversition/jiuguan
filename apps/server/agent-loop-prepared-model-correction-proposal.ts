/** Independent initial corrected-shadow proposal grant. Its private brand is
 * disjoint from MODEL-only and legacy grants; budget/ref metadata is no ACT cap. */
import { createPreparedModelCorrectionMechanism, type PreparedModelCorrectionData,
  type PreparedModelCorrectionInput } from './agent-loop-prepared-model-correction-internal.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord, AgentLoopArtifactRefDescriptor } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_PREPARED_MODEL_CORRECTION_PROPOSAL_VERSION = 'agent-loop-prepared-model-correction-proposal-v1' as const;
export interface AgentLoopPreparedModelCorrectionProposal {
  readonly contractVersion: typeof AGENT_LOOP_PREPARED_MODEL_CORRECTION_PROPOSAL_VERSION;
}
export interface AgentLoopPreparedModelCorrectionProposalData extends PreparedModelCorrectionData {
  readonly artifactRef: AgentLoopArtifactRefDescriptor;
}
export interface AgentLoopPreparedModelCorrectionProposalInput extends PreparedModelCorrectionInput {
  readonly artifactRef: AgentLoopArtifactRefDescriptor;
}
const mechanism = createPreparedModelCorrectionMechanism('proposal');
export function createAgentLoopPreparedModelCorrectionProposal(input: AgentLoopPreparedModelCorrectionProposalInput): AgentLoopPreparedModelCorrectionProposal {
  return mechanism.create(input) as AgentLoopPreparedModelCorrectionProposal;
}
/** Burn on actual consumption, even for wrong owner, record or same-db Store. */
export function consumeAgentLoopPreparedModelCorrectionProposal(value: unknown, current: AgentLoopTaskRecord,
  ownerId: string, store: AgentLoopProjectionStore): AgentLoopPreparedModelCorrectionProposalData {
  return mechanism.consume(value, current, ownerId, store) as AgentLoopPreparedModelCorrectionProposalData;
}
