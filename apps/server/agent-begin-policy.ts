import type { AgentLaneEvidence, AgentRolloutState } from '../../packages/agent-policy/src/lane-rollout.ts';
import {
  evaluateAgentLaneRollout,
  type AgentLaneDecision,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import type { AgentLane } from '../../packages/agent-policy/src/admission.ts';

export interface AgentTicketBeginPolicyInput {
  readonly lane: AgentLane;
  readonly sessionId: string;
  readonly desiredState: AgentRolloutState;
  readonly hostCeiling: AgentRolloutState;
  readonly managed: boolean;
  readonly reservedModelCalls: number;
  readonly evidence: AgentLaneEvidence;
}

export function rolloutLaneForAdmission(lane: AgentLane): AgentRolloutLane {
  return lane === 'critic' ? 'interactive' : lane;
}

/**
 * Re-evaluates begin authority without counting this ticket's own already-durable reservation as
 * earlier traffic. Every other reservation remains visible, and malformed subtraction fails
 * closed through the policy evaluator's normal numeric validation.
 */
export function evaluateAgentTicketBeginPolicy(
  input: AgentTicketBeginPolicyInput,
): AgentLaneDecision {
  if (!Number.isSafeInteger(input.reservedModelCalls) || input.reservedModelCalls < 0) {
    throw new TypeError('reservedModelCalls invalid');
  }
  const reserved = input.evidence.authorizationWindowReservedCalls ?? 0;
  const evidence = Object.freeze({
    ...input.evidence,
    authorizationWindowReservedCalls: Math.max(0, reserved - input.reservedModelCalls),
  });
  return evaluateAgentLaneRollout({
    lane: rolloutLaneForAdmission(input.lane),
    sessionId: input.sessionId,
    desiredState: input.managed ? input.desiredState : 'on',
    hostCeiling: input.managed ? input.hostCeiling : 'on',
    evidence,
  });
}
