/** Independent apply rolling-summary authority. Only its original Prepare CAS can
 * mint the one-use capability; declarations and persisted evidence never grant execution.
 */
import { createAgentLoopRollingSummaryAuthorizationMechanism } from './agent-loop-rolling-summary-authorization-internal.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';

export interface AgentLoopRollingSummaryApplyAuthorization {
  readonly contractVersion: 'agent-loop-rolling-summary-apply-authorization-v1';
}
export interface AgentLoopRollingSummaryApplyPreparedAuthorization {
  readonly contractVersion: 'agent-loop-rolling-summary-apply-prepared-authorization-v1';
}
export interface AgentLoopRollingSummaryApplyCapability {
  readonly contractVersion: 'agent-loop-rolling-summary-apply-capability-v1';
}
const mechanism = createAgentLoopRollingSummaryAuthorizationMechanism({
  mode: 'apply', actionContractRef: AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT,
  authorizationVersion: 'agent-loop-rolling-summary-apply-authorization-v1',
  preparedVersion: 'agent-loop-rolling-summary-apply-prepared-authorization-v1',
  capabilityVersion: 'agent-loop-rolling-summary-apply-capability-v1',
  error: 'agent-loop-rolling-summary-apply-authorization-invalid',
});
export const issueAgentLoopRollingSummaryApplyAuthorization = mechanism.issue;
export const agentLoopRollingSummaryApplyAuthorizationEvidence = mechanism.evidence;
export const prepareAgentLoopRollingSummaryApplyAuthorization = mechanism.prepare;
export const assertAgentLoopRollingSummaryApplyPreparedAuthorization = mechanism.assertPrepared;
export const finalizeAgentLoopRollingSummaryApplyAuthorization = mechanism.finalize;
/** Non-consuming MODEL selection; never a second execution/admission grant. */
export const assertAgentLoopRollingSummaryApplyModelCapability = mechanism.assertModelCapability;
export const consumeAgentLoopRollingSummaryApplyCapability = mechanism.consume;
export const revokeAgentLoopRollingSummaryApplyCapability = mechanism.revoke;
