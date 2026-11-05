/** Public integrity helper; issuing or consuming a Lease remains server-owned. */
export {
    AGENT_TASK_KINDS,
    agentToolSetDigest,
    admissionLimitsFromBudgetProfile,
    admissionLimitsFromGatewayBudgetProfileV3,
    admissionRequestDigest,
    normalizeAdmissionRequest,
} from '../src/admission.ts';
/** Pure lane decision only; activation, quota and durable evidence stay host-owned. */
export { evaluateAgentLaneRollout, narrowAgentRolloutState } from '../src/lane-rollout.ts';
