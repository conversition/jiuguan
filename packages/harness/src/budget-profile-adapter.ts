import {
  normalizeAgentBudgetProfile,
  type AgentBudgetProfileInput,
  type AgentBudgetProfileV2,
} from '../../agent-policy/src/budget-profile.ts';
import type { HarnessBudgetPolicy } from './types.ts';

/**
 * Freeze the cross-layer V2 contract once, then derive the legacy Harness ledger shape.
 * `maxTokens` is deliberately an internal aggregate adapter; it is no longer a source of
 * truth and must never be used to infer final-turn capacity.
 */
export function freezeAgentBudgetProfile(input: AgentBudgetProfileInput): AgentBudgetProfileV2 {
  return normalizeAgentBudgetProfile(input);
}

export function harnessPolicyFromAgentBudgetProfile(
  input: AgentBudgetProfileInput,
): Readonly<HarnessBudgetPolicy> {
  const profile = normalizeAgentBudgetProfile(input);
  if (profile.maxModelCalls < 1 || profile.maxSteps < 1
    || profile.agentInputBudgetTokens < 1 || profile.agentOutputBudgetTokens < 1) {
    throw new TypeError('inactive Agent budget cannot run a Harness');
  }
  const maxTokens = profile.agentInputBudgetTokens + profile.agentOutputBudgetTokens;
  if (!Number.isSafeInteger(maxTokens)) throw new TypeError('Agent token budget exceeds safe integer range');
  return Object.freeze({
    maxSteps: profile.maxSteps,
    maxModelCalls: profile.maxModelCalls,
    maxToolCalls: profile.maxToolCalls,
    maxInputTokens: profile.agentInputBudgetTokens,
    maxOutputTokens: profile.agentOutputBudgetTokens,
    maxTokens,
    maxCostMicrousd: profile.maxCostMicrousd,
    maxWallMs: profile.maxWallMs,
    maxWrites: profile.maxWrites,
    maxToolResultChars: profile.maxToolResultChars,
    maxFinalChars: profile.maxFinalChars,
    maxTraceSteps: profile.maxTraceSteps,
  });
}
