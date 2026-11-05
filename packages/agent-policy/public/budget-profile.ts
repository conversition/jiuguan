/** Public budget integrity helpers; runtime authorization remains in the server Broker. */
export { agentBudgetProfileDigest, normalizeAgentBudgetProfile, assertAgentBudgetWithinHostCeiling } from '../src/budget-profile.ts';
export type { AgentBudgetProfileV2 } from '../src/budget-profile.ts';
export { AGENT_GATEWAY_BUDGET_PROFILE_V3, normalizeAgentGatewayBudgetProfileV3, agentGatewayBudgetProfileDigestV3 }
  from '../src/budget-profile.ts';
export type { AgentGatewayBudgetProfileV3 } from '../src/budget-profile.ts';
