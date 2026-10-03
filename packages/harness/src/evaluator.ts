/**
 * P13-A：场景评测器与指标（路线文档 §4.3/4.4）。
 *
 * golden 场景：需要/不需要查询记忆、世界书冲突、变量非法变更、工具结果提示注入、
 * 重复空转调用、预算耗尽、malformed tool call、取消。
 * 指标：契约成功率、无效工具率、循环耗尽率、P50/P95 延迟、最终状态差异。
 */
import { runBoundedLoop, createTrace } from './engine.ts';
import { createTempSqliteStore } from './store.ts';
import type {
  HarnessBudgetPolicy,
  HarnessClock,
  HarnessModel,
  HarnessResult,
  HarnessTool,
  HarnessUsage,
  ToolContext,
} from './types.ts';

export interface FakeClock {
  nowMs(): number;
  advance(ms?: number): void;
}

export function createFakeClock(stepMs = 10): FakeClock & HarnessClock {
  let current = 0;
  return {
    nowMs() { return current; },
    advance(ms = stepMs) { current += ms; },
  };
}

/** 脚本化 mock 模型：按序返回预置输出（transcript replay，无真实 Provider）。 */
export function createScriptedModel(
  script: string[],
  name = 'scripted',
  usage: HarnessUsage = { inputTokens: 8, outputTokens: 8, costMicrousd: 0 },
): HarnessModel {
  let index = 0;
  return {
    name,
    async complete({ signal }) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const output = script[Math.min(index, script.length - 1)]!;
      index += 1;
      return { content: output, usage };
    },
  };
}

// ── 内置类型化工具（评测域，非生产域） ──────────────────────────────────

const ALLOWED_VARIABLE_KEYS = ['mood', 'location'] as const;

export function buildEvaluationTools(): ReadonlyMap<string, HarnessTool<never>> {
  const tools = [
    {
      name: 'query_memory',
      description: '查询记忆',
      validate: (args: unknown) => typeof args === 'object' && args !== null && typeof (args as { key?: unknown }).key === 'string'
        ? { ok: true, value: args as { key: string } }
        : { ok: false, error: '需要 string key' },
      execute: async (value: unknown, context: ToolContext) => {
        const key = (value as { key: string }).key;
        const memory = (context.state.memory ?? {}) as Record<string, string>;
        const hit = memory[key];
        context.state.queryCount = ((context.state.queryCount as number) ?? 0) + 1;
        return { ok: true, result: hit ? `记忆[${key}]=${hit}` : `记忆[${key}] 无记录` };
      },
    },
    {
      name: 'search_worldbook',
      description: '检索世界书',
      validate: (args: unknown) => typeof args === 'object' && args !== null && typeof (args as { q?: unknown }).q === 'string'
        ? { ok: true, value: args as { q: string } }
        : { ok: false, error: '需要 string q' },
      execute: async (value: unknown) => {
        const q = (value as { q: string }).q;
        return { ok: true, result: `世界书命中 2 条且互相冲突：${q} 属于 A 阵营 / ${q} 属于 B 阵营` };
      },
    },
    {
      name: 'update_variable',
      description: '更新剧情变量（key 白名单，value 必须 string）',
      validate: (args: unknown) => {
        const record = args as { key?: unknown; value?: unknown };
        if (typeof args !== 'object' || args === null) return { ok: false, error: 'args 必须是对象' };
        if (typeof record.key !== 'string' || !(ALLOWED_VARIABLE_KEYS as readonly string[]).includes(record.key)) {
          return { ok: false, error: `key 必须在白名单 ${ALLOWED_VARIABLE_KEYS.join('/')}` };
        }
        if (typeof record.value !== 'string' || record.value.length > 80) {
          return { ok: false, error: 'value 必须是不超过 80 字符的 string' };
        }
        return { ok: true, value: record as { key: string; value: string } };
      },
      execute: async (value: unknown, context: ToolContext) => {
        const { key, value: variableValue } = value as { key: string; value: string };
        context.state[key] = variableValue;
        return { ok: true, result: `${key}=${variableValue}` };
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.name, tool as unknown as HarnessTool<never>]));
}

// ── 场景与套件 ──────────────────────────────────────────────────────────

export interface EvaluationScenario {
  readonly id: string;
  readonly userMessage: string;
  readonly modelScript: string[];
  readonly seededState: Record<string, unknown>;
  readonly budget: HarnessBudgetPolicy;
  /** 预置取消信号（S8 取消场景）。 */
  readonly signal?: AbortSignal;
  readonly expect: {
    readonly status: HarnessResult['status'];
    readonly stateIncludes?: Record<string, unknown>;
    readonly stateExcludes?: readonly string[];
    readonly finalIncludes?: readonly string[];
    readonly minInvalidToolSteps?: number;
    readonly maxModelCalls?: number;
  };
}

export interface ScenarioOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly result: HarnessResult;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly factChecks: number;
  readonly factFailures: number;
}

export async function runScenario(scenario: EvaluationScenario): Promise<ScenarioOutcome> {
  const clock = createFakeClock();
  const failures: string[] = [];
  // P13-A 默认运行域：一次性 temp SQLite + scripted mock/replay，绝不连接用户 DB。
  const store = createTempSqliteStore(scenario.seededState);
  let result: HarnessResult;
  try {
    result = await runBoundedLoop({
      model: createScriptedModel(scenario.modelScript),
      tools: buildEvaluationTools(),
      budget: scenario.budget,
      clock,
      system: '你是剧情引擎的评测模型。只输出 {"tool":{...}} 或 {"final":"..."} 的 JSON。',
      userMessage: scenario.userMessage,
      seededState: {},
      store,
      ...(scenario.signal ? { signal: scenario.signal } : {}),
    });
  } finally {
    store.dispose();
  }
  if (result.status !== scenario.expect.status) {
    failures.push(`status=${result.status}（期望 ${scenario.expect.status}）`);
  }
  for (const [key, value] of Object.entries(scenario.expect.stateIncludes ?? {})) {
    if (result.state[key] !== value) failures.push(`state.${key}=${JSON.stringify(result.state[key])}（期望 ${JSON.stringify(value)}）`);
  }
  for (const key of scenario.expect.stateExcludes ?? []) {
    if (key in result.state) failures.push(`state.${key} 不应存在（状态被污染）`);
  }
  for (const fact of scenario.expect.finalIncludes ?? []) {
    if (!result.finalAnswer?.includes(fact)) failures.push(`final 缺少事实：${fact}`);
  }
  const invalidSteps = result.trace.filter((step) => step.kind === 'tool-invalid' && step.detail.includes(':')).length;
  if (scenario.expect.minInvalidToolSteps !== undefined && invalidSteps < scenario.expect.minInvalidToolSteps) {
    failures.push(`invalid tool steps=${invalidSteps}（期望 ≥${scenario.expect.minInvalidToolSteps}）`);
  }
  if (scenario.expect.maxModelCalls !== undefined && result.budget.modelCallsUsed > scenario.expect.maxModelCalls) {
    failures.push(`modelCalls=${result.budget.modelCallsUsed}（期望 ≤${scenario.expect.maxModelCalls}）`);
  }
  const expectedFacts = scenario.expect.finalIncludes ?? [];
  const factFailures = failures.filter((failure) => failure.startsWith('final 缺少事实：')).length;
  return {
    id: scenario.id,
    passed: failures.length === 0,
    result,
    failures,
    latencyMs: result.budget.wallMsUsed,
    factChecks: expectedFacts.length,
    factFailures,
  };
}

export interface SuiteMetrics {
  readonly total: number;
  readonly passed: number;
  readonly contractSuccessRate: number;
  readonly invalidToolCallRate: number;
  readonly loopExhaustionRate: number;
  readonly factSupportRate: number;
  readonly tokenTotal: number;
  readonly costMicrousdTotal: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

export function summarize(outcomes: ScenarioOutcome[]): SuiteMetrics {
  const total = outcomes.length;
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const withInvalid = outcomes.filter((outcome) =>
    outcome.result.trace.some((step) => step.kind === 'tool-invalid')).length;
  const exhausted = outcomes.filter((outcome) => outcome.result.status === 'budget-exhausted').length;
  const factChecked = outcomes.reduce((sum, outcome) => sum + outcome.factChecks, 0);
  const factFailures = outcomes.reduce((sum, outcome) => sum + outcome.factFailures, 0);
  const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number): number =>
    latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]!;
  return {
    total,
    passed,
    contractSuccessRate: total === 0 ? 0 : passed / total,
    invalidToolCallRate: total === 0 ? 0 : withInvalid / total,
    loopExhaustionRate: total === 0 ? 0 : exhausted / total,
    factSupportRate: factChecked === 0 ? 1 : (factChecked - factFailures) / factChecked,
    tokenTotal: outcomes.reduce((sum, outcome) => sum + outcome.result.budget.tokensUsed, 0),
    costMicrousdTotal: outcomes.reduce((sum, outcome) => sum + outcome.result.budget.costMicrousd, 0),
    latencyP50Ms: percentile(0.5),
    latencyP95Ms: percentile(0.95),
  };
}

export { createTrace };
