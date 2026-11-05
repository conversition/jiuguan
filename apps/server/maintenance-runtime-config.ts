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
import { maintenanceExecutionPolicy } from './maintenance-execution-policy.ts';

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
  worldbook_repair: 'worldbook',
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
  const execution = maintenanceExecutionPolicy(taskKind);
  const summaryFullReplace = quality && taskKind === 'rolling_summary';
  // The schema ceiling is not an instruction to echo 16k characters. Keep the
  // verified Provider output reserve (6k) and give summaries more input room so
  // the complete baseline is visible; the model is expected to compact it.
  const outputTokens = quality ? 6_000 : 2_000;
  // NPC uses one bounded protocol-repair turn after a rejected typed proposal.
  // Its dynamic character/evidence schema and original evidence are replayed
  // with bounded rejection feedback, so the old 24k aggregate allowance could
  // close the lease before the already-authorized correction call. Keep this
  // task-specific: read/tool/write/call limits remain unchanged.
  const requestedInputTokens = summaryFullReplace
    ? 32_000
    : quality && taskKind === 'npc_state' ? 28_000
      : quality ? 24_000 : 10_000;
  if (context <= outputTokens) throw new Error('maintenance-provider-context-too-small');
  const inputTokens = Math.min(requestedInputTokens, context - outputTokens);
  return normalizeAgentBudgetProfile({
    autonomyProfile,
    lane: TASK_BUDGET_LANE[taskKind],
    // Logical steps are task-specific. maxModelCalls has exactly one extra
    // physical slot for AdmittedMaintenanceModel's sole transient retry.
    maxSteps: quality ? execution.maxSteps : MAINTENANCE_POLICY.maxSteps,
    maxModelCalls: quality ? execution.maxModelCalls : MAINTENANCE_POLICY.maxModelCalls,
    maxToolCalls: quality ? execution.maxToolCalls : MAINTENANCE_POLICY.maxToolCalls,
    maxWrites: MAINTENANCE_POLICY.maxWrites,
    agentInputBudgetTokens: inputTokens,
    agentOutputBudgetTokens: outputTokens,
    finalContextReserveTokens: 0,
    finalOutputReserveTokens: 0,
    providerContextWindowTokens: context,
    maxCostMicrousd: quality
      ? pricedTaskCostCeiling(inputTokens, outputTokens, 1_000_000, env)
      : MAINTENANCE_POLICY.maxCostMicrousd,
    maxWallMs: quality ? 120_000 : MAINTENANCE_POLICY.maxWallMs,
    maxToolResultChars: MAINTENANCE_POLICY.maxToolResultChars,
    // A rolling-summary proposal is a full replacement and may legally carry
    // a 16k summary plus its JSON envelope. Keep the protocol ceiling above the
    // schema ceiling even though the normal path terminates on propose_*.
    maxFinalChars: taskKind === 'rolling_summary' ? 20_000 : MAINTENANCE_POLICY.maxFinalChars,
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
