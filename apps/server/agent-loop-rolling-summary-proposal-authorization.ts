/** Independent shadow rolling-summary authority. Only its original Prepare CAS can
 * mint the one-use capability; declarations and persisted evidence never grant execution.
 */
import { createAgentLoopRollingSummaryAuthorizationMechanism } from './agent-loop-rolling-summary-authorization-internal.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';

export interface AgentLoopRollingSummaryProposalAuthorization {
  readonly contractVersion: 'agent-loop-rolling-summary-proposal-authorization-v1';
}
export interface AgentLoopRollingSummaryProposalPreparedAuthorization {
  readonly contractVersion: 'agent-loop-rolling-summary-proposal-prepared-authorization-v1';
}
export interface AgentLoopRollingSummaryProposalCapability {
  readonly contractVersion: 'agent-loop-rolling-summary-proposal-capability-v1';
}
const mechanism = createAgentLoopRollingSummaryAuthorizationMechanism({
  mode: 'shadow', actionContractRef: AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
  authorizationVersion: 'agent-loop-rolling-summary-proposal-authorization-v1',
  preparedVersion: 'agent-loop-rolling-summary-proposal-prepared-authorization-v1',
  capabilityVersion: 'agent-loop-rolling-summary-proposal-capability-v1',
  error: 'agent-loop-rolling-summary-proposal-authorization-invalid',
});
export const issueAgentLoopRollingSummaryProposalAuthorization = mechanism.issue;
export const agentLoopRollingSummaryProposalAuthorizationEvidence = mechanism.evidence;
export const prepareAgentLoopRollingSummaryProposalAuthorization = mechanism.prepare;
export const assertAgentLoopRollingSummaryProposalPreparedAuthorization = mechanism.assertPrepared;
export const finalizeAgentLoopRollingSummaryProposalAuthorization = mechanism.finalize;
export const consumeAgentLoopRollingSummaryProposalCapability = mechanism.consume;
export const revokeAgentLoopRollingSummaryProposalCapability = mechanism.revoke;
