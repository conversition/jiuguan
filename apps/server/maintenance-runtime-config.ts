import type { MaintenanceCostEstimator } from './maintenance-model-adapter.ts';
import {
  normalizeAgentBudgetProfile,
  type AgentAutonomyProfile,
  type AgentBudgetLane,
  type AgentBudgetProfileV2,
} from '../../packages/agent-policy/src/budget-profile.ts';
import { MAINTENANCE_POLICY, type MaintenanceTaskKind } from './maintenance-types.ts';
import { resolveSafePromptInputBudget } from '../../packages/prompt/src/assembly.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';
import { pricedTaskCostCeiling } from './agent-task-budget-profiles.ts';

export interface MaintenanceRuntimeConfig {
  readonly lane: 'off' | 'shadow';
  readonly enabled: boolean;
  readonly inputMicrousdPerMillionTokens?: number;
  readonly outputMicrousdPerMillionTokens?: number;
}

function positiveRate(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000_000) {
    throw new Error(`${name} 必须是 1..1000000000 的微美元/百万 token 整数`);
  }
  return parsed;
}

const TASK_BUDGET_LANE: Readonly<Record<MaintenanceTaskKind, AgentBudgetLane>> = Object.freeze({
  memory_consolidation: 'preference',
  branch_index: 'arc',
  rolling_summary: 'style',
  npc_state: 'npc',
});

/** Q1 host ceilings only; Q8 will select non-legacy profiles after maintenance admission. */
export function maintenanceBudgetProfileForAutonomy(
  autonomyProfile: AgentAutonomyProfile,
  taskKind: MaintenanceTaskKind,
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeProfile?: ModelRuntimeProfile,
): AgentBudgetProfileV2 {
  const context = resolveSafePromptInputBudget(env, runtimeProfile).modelContextTokens;
  const quality = autonomyProfile === 'quality-beta';
  return normalizeAgentBudgetProfile({
    autonomyProfile,
    lane: TASK_BUDGET_LANE[taskKind],
    maxSteps: quality ? 4 : MAINTENANCE_POLICY.maxSteps,
    // 真实工具协议至少需要：读取 -> 提案 -> 最终确认。两次调用会在有效提案
    // 已生成后仍被 budget-exhausted 丢弃，造成 100% 浪费。
    maxModelCalls: quality ? 3 : MAINTENANCE_POLICY.maxModelCalls,
    maxToolCalls: quality ? 4 : MAINTENANCE_POLICY.maxToolCalls,
    maxWrites: MAINTENANCE_POLICY.maxWrites,
    agentInputBudgetTokens: quality ? Math.min(24_000, context - 6_000) : 10_000,
    agentOutputBudgetTokens: quality ? 6_000 : 2_000,
    finalContextReserveTokens: 0,
    finalOutputReserveTokens: 0,
    providerContextWindowTokens: context,
    maxCostMicrousd: quality
      ? pricedTaskCostCeiling(24_000, 6_000, 1_000_000, env)
      : MAINTENANCE_POLICY.maxCostMicrousd,
    maxWallMs: quality ? 60_000 : MAINTENANCE_POLICY.maxWallMs,
    maxToolResultChars: MAINTENANCE_POLICY.maxToolResultChars,
    maxFinalChars: MAINTENANCE_POLICY.maxFinalChars,
    maxTraceSteps: MAINTENANCE_POLICY.maxTraceSteps,
  });
}

/**
 * P13-B 首次生产接线只接受显式 shadow。off 是默认且覆盖持久开关；apply 必须等
 * 领域 committer 与观察期完成后由后续 ADR 放行。
 */
export function parseMaintenanceRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MaintenanceRuntimeConfig {
  const raw = (env.JG_HARNESS_BACKGROUND ?? 'off').trim().toLowerCase();
  if (raw === 'off') return Object.freeze({ lane: 'off', enabled: false });
  if (raw !== 'shadow') {
    throw new Error('JG_HARNESS_BACKGROUND 首版只允许 off 或 shadow');
  }
  return Object.freeze({
    lane: 'shadow',
    enabled: true,
    inputMicrousdPerMillionTokens: positiveRate(
      env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK,
      'JG_HARNESS_INPUT_MICROUSD_PER_MTOK',
    ),
    outputMicrousdPerMillionTokens: positiveRate(
      env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK,
      'JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK',
    ),
  });
}

export function maintenanceCostEstimator(config: MaintenanceRuntimeConfig): MaintenanceCostEstimator {
  if (!config.enabled
    || config.inputMicrousdPerMillionTokens === undefined
    || config.outputMicrousdPerMillionTokens === undefined) {
    return () => { throw new Error('maintenance-provider-cost-unavailable'); };
  }
  return ({ inputTokens, outputTokens }) => {
    const numerator = inputTokens * config.inputMicrousdPerMillionTokens!
      + outputTokens * config.outputMicrousdPerMillionTokens!;
    if (!Number.isSafeInteger(numerator) || numerator < 0) {
      throw new Error('maintenance-provider-cost-overflow');
    }
    return Math.ceil(numerator / 1_000_000);
  };
}
