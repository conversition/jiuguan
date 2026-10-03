import {
  normalizeAgentBudgetProfile,
  type AgentBudgetLane,
  type AgentBudgetProfileV2,
} from '../../packages/agent-policy/src/budget-profile.ts';
import type { AgentTaskKind } from '../../packages/agent-policy/src/admission.ts';
import { resolveSafePromptInputBudget } from '../../packages/prompt/src/assembly.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';

type CalibratedTaskKind = Extract<AgentTaskKind,
  'interactive_prelude' | 'critic_revision' | 'preference_extract' | 'style_compile' | 'aql_replan'>;

function optionalPositiveRate(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000_000) {
    throw new Error(`${name} 必须是 1..1000000000 的微美元/百万 token 整数`);
  }
  return parsed;
}

/** Rate-card maximum plus 25% calibration headroom; never below the frozen task floor. */
export function pricedTaskCostCeiling(
  inputTokens: number,
  outputTokens: number,
  floorMicrousd: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  for (const [label, value] of [
    ['inputTokens', inputTokens], ['outputTokens', outputTokens], ['floorMicrousd', floorMicrousd],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}-invalid`);
  }
  const inputRate = optionalPositiveRate(
    env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK,
    'JG_HARNESS_INPUT_MICROUSD_PER_MTOK',
  );
  const outputRate = optionalPositiveRate(
    env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK,
    'JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK',
  );
  if ((inputRate === undefined) !== (outputRate === undefined)) {
    throw new Error('Agent 费率必须同时配置 input/output');
  }
  if (inputRate === undefined || outputRate === undefined) return floorMicrousd;
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(numerator) || numerator < 0) throw new Error('Agent 费用上限计算溢出');
  return Math.max(floorMicrousd, Math.ceil(Math.ceil(numerator / 1_000_000) * 1.25));
}

/**
 * 工具结果按「字符」裁剪，却按「token」计入 Prelude 输入预算，两者换算系数并不相等。
 * estimateTokens 对中文按 1.5 token/字计价，因此旧的 24_576 字符上限在中文负载下约合
 * 36,864 tokens —— 超过整个 Prelude 输入预算（28,000）本身。模型只要读一次记忆或世界书，
 * 租约就会在下一次调用前被判 input-budget-exhausted，多步循环永远拿不到第二个 step。
 * 这里按预算反推每个结果的字符上限，使若干次并行读取之后仍留有继续循环的余量。
 */
const MAX_CONCURRENT_READS = 4; // 与 harness 的 MAX_PARALLEL_READS 保持一致
const CJK_TOKENS_PER_CHAR = 1.5; // 与 packages/prompt estimateTokens 的中文系数一致

export function toolResultCharCeiling(inputTokens: number): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error('toolResultCharCeiling-invalid');
  }
  return Math.max(1_024, Math.floor(inputTokens / MAX_CONCURRENT_READS / CJK_TOKENS_PER_CHAR));
}

const TASK_SPEC: Readonly<Record<CalibratedTaskKind, Readonly<{
  lane: AgentBudgetLane;
  inputTokens: number;
  outputTokens: number;
  maxModelCalls: number;
  maxSteps: number;
  maxWallMs: number;
  floorCostMicrousd: number;
}>>> = Object.freeze({
  interactive_prelude: Object.freeze({
    lane: 'interactive', inputTokens: 28_000, outputTokens: 4_000,
    maxModelCalls: 3, maxSteps: 6, maxWallMs: 120_000, floorCostMicrousd: 1_500_000,
  }),
  critic_revision: Object.freeze({
    lane: 'critic', inputTokens: 24_000, outputTokens: 6_000,
    maxModelCalls: 1, maxSteps: 1, maxWallMs: 60_000, floorCostMicrousd: 1_500_000,
  }),
  preference_extract: Object.freeze({
    lane: 'preference', inputTokens: 4_000, outputTokens: 800,
    maxModelCalls: 1, maxSteps: 1, maxWallMs: 30_000, floorCostMicrousd: 300_000,
  }),
  style_compile: Object.freeze({
    lane: 'style', inputTokens: 24_000, outputTokens: 6_000,
    maxModelCalls: 1, maxSteps: 1, maxWallMs: 60_000, floorCostMicrousd: 800_000,
  }),
  aql_replan: Object.freeze({
    lane: 'interactive', inputTokens: 4_000, outputTokens: 300,
    maxModelCalls: 1, maxSteps: 1, maxWallMs: 30_000, floorCostMicrousd: 300_000,
  }),
});

/** Explicit per-task ceilings; optional Agent work can no longer inherit another task's budget. */
export function agentTaskBudgetProfile(
  taskKind: CalibratedTaskKind,
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Readonly<{ maxOutputTokens?: number }> = {},
  runtimeProfile?: ModelRuntimeProfile,
): AgentBudgetProfileV2 {
  const spec = TASK_SPEC[taskKind];
  const context = resolveSafePromptInputBudget(env, runtimeProfile);
  const requestedOutput = overrides.maxOutputTokens ?? spec.outputTokens;
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1
    || requestedOutput > spec.outputTokens) throw new Error('maxOutputTokens-invalid');
  const outputTokens = requestedOutput;
  const inputTokens = Math.min(spec.inputTokens, context.modelContextTokens - outputTokens);
  return normalizeAgentBudgetProfile({
    autonomyProfile: 'quality-beta',
    lane: spec.lane,
    maxSteps: spec.maxSteps,
    maxModelCalls: spec.maxModelCalls,
    maxToolCalls: taskKind === 'interactive_prelude' ? 12 : 0,
    maxWrites: 0,
    agentInputBudgetTokens: inputTokens,
    agentOutputBudgetTokens: outputTokens,
    finalContextReserveTokens: context.modelContextTokens,
    finalOutputReserveTokens: context.reservedOutputTokens,
    providerContextWindowTokens: context.modelContextTokens,
    maxCostMicrousd: pricedTaskCostCeiling(
      inputTokens,
      outputTokens,
      spec.floorCostMicrousd,
      env,
    ),
    maxWallMs: spec.maxWallMs,
    maxToolResultChars: taskKind === 'interactive_prelude' ? toolResultCharCeiling(inputTokens) : 0,
    maxFinalChars: taskKind === 'style_compile' || taskKind === 'critic_revision' ? 32_768 : 8_192,
    maxTraceSteps: taskKind === 'interactive_prelude' ? 96 : 8,
  });
}
