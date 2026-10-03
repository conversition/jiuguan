import type { InteractiveVariableSpec } from '../../packages/harness/src/interactive-tools.ts';
import { INTERACTIVE_POLICY } from '../../packages/harness/src/interactive-tools.ts';
import {
  normalizeAgentBudgetProfile,
  type AgentAutonomyProfile,
  type AgentBudgetProfileV2,
} from '../../packages/agent-policy/src/budget-profile.ts';
import { resolveSafePromptInputBudget } from '../../packages/prompt/src/assembly.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';

export interface InteractiveRuntimeConfig {
  readonly lane: 'off' | 'shadow' | 'on';
  readonly enabled: boolean;
  readonly inputMicrousdPerMillionTokens?: number;
  readonly outputMicrousdPerMillionTokens?: number;
  readonly variableSpecs: readonly InteractiveVariableSpec[];
  readonly budgetProfile?: AgentBudgetProfileV2;
}

/** Q1 only defines the host ceilings. Q3 will select a non-legacy profile per admitted session. */
export function interactiveBudgetProfileForAutonomy(
  autonomyProfile: AgentAutonomyProfile,
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeProfile?: ModelRuntimeProfile,
): AgentBudgetProfileV2 {
  const finalBudget = resolveSafePromptInputBudget(env, runtimeProfile);
  const quality = autonomyProfile === 'quality-beta';
  const finalOutputReserveTokens = quality
    ? Math.max(6_144, Math.ceil(finalBudget.modelContextTokens * 0.25))
    : finalBudget.reservedOutputTokens;
  // Interactive Prelude 与最终正文是两次独立请求，但 Prelude 自身的输入+输出
  // 仍必须落在 Provider context window 内。默认 32K context 不能硬塞 32K+4K，
  // 否则 quality-beta 会在拿到 admission 后、真正调用模型前同步失败并被静默降级。
  const agentOutputBudgetTokens = quality ? 4_000 : 1_200;
  const agentInputBudgetTokens = quality
    ? Math.min(32_000, finalBudget.modelContextTokens - agentOutputBudgetTokens)
    : 14_800;
  return normalizeAgentBudgetProfile({
    autonomyProfile,
    lane: 'interactive',
    maxSteps: quality ? 6 : INTERACTIVE_POLICY.maxSteps,
    maxModelCalls: quality ? 3 : INTERACTIVE_POLICY.maxModelCalls,
    maxToolCalls: quality ? 12 : INTERACTIVE_POLICY.maxToolCalls,
    maxWrites: INTERACTIVE_POLICY.maxWrites,
    // The legacy pair sums to the former 16K shared ledger, preserving P13-C requests.
    agentInputBudgetTokens,
    agentOutputBudgetTokens,
    finalContextReserveTokens: finalBudget.modelContextTokens,
    finalOutputReserveTokens,
    providerContextWindowTokens: finalBudget.modelContextTokens,
    maxCostMicrousd: quality ? 250_000 : INTERACTIVE_POLICY.maxCostMicrousd,
    maxWallMs: quality ? 120_000 : INTERACTIVE_POLICY.maxWallMs,
    maxToolResultChars: quality ? 24_576 : INTERACTIVE_POLICY.maxToolResultChars,
    maxFinalChars: INTERACTIVE_POLICY.maxFinalChars,
    maxTraceSteps: quality ? 96 : INTERACTIVE_POLICY.maxTraceSteps,
  });
}

/**
 * 前台滚动摘要是主回合的可选前置请求。输入包含滑出窗口、旧长期摘要和锚点，
 * 生产样本可稳定超过 8K tokens；不得沿用早期 4K 试验值，否则 Provider 已完成
 * 后会被本地 Gateway 按预算丢弃，继而让下一步完整 Skill 装配陷入上下文冲突。
 */
export function foregroundSummaryBudgetProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeProfile?: ModelRuntimeProfile,
): AgentBudgetProfileV2 {
  const base = interactiveBudgetProfileForAutonomy('quality-beta', env, runtimeProfile);
  const inputRate = Number(env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK);
  const outputRate = Number(env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK);
  const configuredCostCeiling = Number.isSafeInteger(inputRate) && inputRate > 0
    && Number.isSafeInteger(outputRate) && outputRate > 0
    ? Math.ceil((12_000 * inputRate + 700 * outputRate) / 1_000_000)
    : 0;
  return normalizeAgentBudgetProfile({
    ...base,
    lane: 'style',
    maxSteps: 1,
    maxModelCalls: 1,
    maxToolCalls: 0,
    maxWrites: 0,
    agentInputBudgetTokens: Math.min(base.agentInputBudgetTokens, 12_000),
    agentOutputBudgetTokens: Math.min(base.agentOutputBudgetTokens, 700),
    // 当前测试会话费率下硬上界为 635K microusd；保留固定余量，并在费率
    // 提高时同步抬升 ceiling，避免再次出现 token 预算允许但 cost 预算事后丢弃。
    maxCostMicrousd: Math.max(base.maxCostMicrousd, 750_000, configuredCostCeiling),
  });
}

function positiveRate(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000_000) {
    throw new Error(`${name} 必须是 1..1000000000 的微美元/百万 token 整数`);
  }
  return parsed;
}

function variablePolicy(raw: string | undefined): readonly InteractiveVariableSpec[] {
  if (!raw?.trim()) return Object.freeze([]);
  if (raw.length > 32_768) throw new Error('JG_HARNESS_VARIABLE_POLICY_JSON 过大');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('JG_HARNESS_VARIABLE_POLICY_JSON 不是合法 JSON'); }
  if (!Array.isArray(value) || value.length > 100) throw new Error('JG_HARNESS_VARIABLE_POLICY_JSON 必须是最多 100 项数组');
  const seen = new Set<string>();
  const specs = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('变量策略项非法');
    const row = item as Record<string, unknown>;
    const allowed = ['path', 'type', 'mutable', 'min', 'max', 'allowedValues', 'maxLength'];
    if (Object.keys(row).some((key) => !allowed.includes(key))
      || typeof row.path !== 'string' || !/^[a-zA-Z_一-鿿][a-zA-Z0-9_.:一-鿿-]{0,239}$/.test(row.path)
      || seen.has(row.path)
      || (row.type !== 'number' && row.type !== 'string' && row.type !== 'boolean')
      || row.mutable !== true) throw new Error('变量策略项非法');
    seen.add(row.path);
    if (row.type === 'number') {
      if (typeof row.min !== 'number' || !Number.isFinite(row.min)
        || typeof row.max !== 'number' || !Number.isFinite(row.max) || row.min > row.max
        || Object.hasOwn(row, 'allowedValues') || Object.hasOwn(row, 'maxLength')) {
        throw new Error('number 变量策略必须提供有限 min/max');
      }
      return Object.freeze({ path: row.path, type: row.type, mutable: true, min: row.min, max: row.max });
    }
    if (row.type === 'string') {
      const allowedValues = Array.isArray(row.allowedValues)
        && row.allowedValues.length > 0 && row.allowedValues.length <= 100
        && row.allowedValues.every((entry) => typeof entry === 'string' && entry.length <= 1_000)
        ? [...new Set(row.allowedValues as string[])]
        : undefined;
      const maxLength = Number.isSafeInteger(row.maxLength) && Number(row.maxLength) >= 1 && Number(row.maxLength) <= 4_000
        ? Number(row.maxLength)
        : undefined;
      if ((!allowedValues && !maxLength) || Object.hasOwn(row, 'min') || Object.hasOwn(row, 'max')) {
        throw new Error('string 变量策略必须提供 allowedValues 或 maxLength');
      }
      return Object.freeze({
        path: row.path, type: row.type, mutable: true,
        ...(allowedValues ? { allowedValues: Object.freeze(allowedValues) } : {}),
        ...(maxLength ? { maxLength } : {}),
      });
    }
    if (Object.keys(row).some((key) => !['path', 'type', 'mutable'].includes(key))) {
      throw new Error('boolean 变量策略不得携带范围字段');
    }
    return Object.freeze({ path: row.path, type: row.type, mutable: true });
  });
  return Object.freeze(specs);
}

/**
 * P13-C 宿主上限：默认 off；shadow 不改变 game_turn，on 才允许证据与 staged patch 进入提交链。
 * on 需要显式策略确认；变量写入另需逐路径策略 JSON，缺省为空（只读）。
 */
export function parseInteractiveRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InteractiveRuntimeConfig {
  const lane = (env.JG_HARNESS_INTERACTIVE ?? 'off').trim().toLowerCase();
  if (lane === 'off') return Object.freeze({ lane: 'off', enabled: false, variableSpecs: Object.freeze([]) });
  if (lane !== 'shadow' && lane !== 'on') throw new Error('JG_HARNESS_INTERACTIVE 只允许 off、shadow 或 on');
  if (lane === 'on' && env.JG_HARNESS_INTERACTIVE_ACK !== 'p13c-v1') {
    throw new Error('JG_HARNESS_INTERACTIVE=on 需要 JG_HARNESS_INTERACTIVE_ACK=p13c-v1');
  }
  return Object.freeze({
    lane,
    enabled: true,
    inputMicrousdPerMillionTokens: positiveRate(
      env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK,
      'JG_HARNESS_INPUT_MICROUSD_PER_MTOK',
    ),
    outputMicrousdPerMillionTokens: positiveRate(
      env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK,
      'JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK',
    ),
    variableSpecs: variablePolicy(env.JG_HARNESS_VARIABLE_POLICY_JSON),
    // Existing P13-C switches stay legacy until Q3 adds Router + session allowlist enforcement.
    budgetProfile: interactiveBudgetProfileForAutonomy('legacy', env),
  });
}

export function interactiveProviderEligible(
  config: InteractiveRuntimeConfig,
  capabilities: { readonly stream: boolean; readonly tools: boolean } | undefined,
): boolean {
  return config.enabled && capabilities?.stream === true && capabilities.tools === true;
}
