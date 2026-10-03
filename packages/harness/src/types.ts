/** P13 有界 Harness 的可注入核心；生产仅能由已接受 ADR 的服务端 lane 复用。 */

export interface HarnessClock { nowMs(): number; }

export interface HarnessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 可选的微美元整数；mock/replay 默认 0。 */
  readonly costMicrousd: number;
}

export interface HarnessModelCompletion {
  readonly content: string;
  readonly usage: HarnessUsage;
}

export interface HarnessModel {
  readonly name: string;
  complete(input: {
    readonly system: string;
    readonly messages: readonly HarnessMessage[];
    /** 适配器必须把该值下传为本次请求的最大输出 token。 */
    readonly maxOutputTokens: number;
    readonly signal: AbortSignal;
  }): Promise<HarnessModelCompletion>;
}

export interface HarnessMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
}

export interface HarnessTool<S = unknown> {
  readonly name: string;
  readonly description: string;
  validate(args: unknown): { ok: true; value: S } | { ok: false; error: string };
  execute(value: S, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolContext {
  /** 每次工具调用得到隔离草稿；只有成功且预算允许时才提交。 */
  readonly state: Record<string, unknown>;
  readonly signal: AbortSignal;
  /** P13-C 调用账本身份；工具不得自行改写这些字段。 */
  readonly call?: {
    readonly runId: string;
    readonly stepIndex: number;
    readonly toolCallId: string;
    readonly inputRevision: string;
  };
}

export type ToolOutcome =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly error: string };

export interface ToolCall { readonly name: string; readonly args: unknown; }

export type TraceKind =
  | 'store-load' | 'model' | 'model-invalid' | 'model-error'
  | 'tool-ok' | 'tool-invalid' | 'tool-error' | 'final'
  | 'cancelled' | 'budget-exhausted' | 'store-commit';

export interface TraceStep {
  readonly index: number;
  readonly kind: TraceKind;
  /** 仅允许稳定错误码/计数；不得放 prompt、模型正文、工具结果或思维链。 */
  readonly detail: string;
  readonly atMs: number;
}

export interface TraceRecorder {
  push(step: Omit<TraceStep, 'index' | 'atMs'>): void;
  readonly steps: readonly TraceStep[];
}

export interface HarnessBudgetPolicy {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  /** 独立输入预算；旧调用方省略时按 maxTokens 兼容。 */
  readonly maxInputTokens?: number;
  /** 独立输出预算；旧调用方省略时按 maxTokens 兼容。 */
  readonly maxOutputTokens?: number;
  readonly maxTokens: number;
  readonly maxCostMicrousd: number;
  readonly maxWallMs: number;
  readonly maxWrites: number;
  readonly maxToolResultChars: number;
  readonly maxFinalChars: number;
  readonly maxTraceSteps: number;
}

export interface BudgetSnapshot extends HarnessUsage {
  readonly stepsUsed: number;
  readonly modelCallsUsed: number;
  readonly toolCallsUsed: number;
  readonly writesUsed: number;
  readonly tokensUsed: number;
  readonly wallMsUsed: number;
}

export interface BudgetLedger {
  readonly policy: HarnessBudgetPolicy;
  snapshot(clock: HarnessClock): BudgetSnapshot;
  /** 只报告已实际越过的连续硬预算；次数类在对应 consume 点判定。 */
  hardLimitReason(clock: HarnessClock): HarnessBudgetLimit | null;
  /**
   * 报告下一次有成本动作已没有可用额度；恰好花完的当前结果仍然有效，
   * 但调用方必须在下一次 Provider 调用前停止。
   */
  exhaustedLimitReason(clock: HarnessClock): HarnessBudgetLimit | null;
  canContinue(clock: HarnessClock): boolean;
  consumeStep(clock: HarnessClock): boolean;
  consumeModel(clock: HarnessClock): boolean;
  consumeTool(clock: HarnessClock): boolean;
  consumeWrite(clock: HarnessClock): boolean;
  addUsage(usage: HarnessUsage, clock: HarnessClock): boolean;
  remainingTokens(): number;
  remainingInputTokens(): number;
  remainingOutputTokens(): number;
}

export type HarnessBudgetLimit =
  | 'step'
  | 'model-call'
  | 'tool-call'
  | 'write'
  | 'input-token'
  | 'output-token'
  | 'token'
  | 'cost'
  | 'wall-time';

export type HarnessTerminationReason =
  | 'completed-final'
  | 'completed-terminal-tool'
  | 'external-cancelled'
  | `budget-${HarnessBudgetLimit}-exhausted`
  | 'provider-rate-limited'
  | 'provider-timeout'
  | 'provider-upstream-unavailable'
  | 'provider-transport-failed'
  | 'provider-stream-failed'
  | 'provider-stream-incomplete'
  | 'model-failed'
  | 'invalid-model-completion'
  | 'invalid-model-usage'
  | 'invalid-protocol-limit'
  | 'store-commit-failed';

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateBudgetPolicy(policy: HarnessBudgetPolicy): void {
  for (const key of [
    'maxSteps', 'maxModelCalls', 'maxToolCalls', 'maxTokens', 'maxCostMicrousd', 'maxWallMs',
    'maxWrites', 'maxToolResultChars', 'maxFinalChars', 'maxTraceSteps',
  ] as const) {
    const value = policy[key];
    if (!nonNegativeInteger(value)) throw new Error(`invalid-budget:${key}`);
  }
  for (const key of ['maxInputTokens', 'maxOutputTokens'] as const) {
    const value = policy[key];
    if (value !== undefined && !nonNegativeInteger(value)) throw new Error(`invalid-budget:${key}`);
  }
  if (policy.maxSteps === 0 || policy.maxModelCalls === 0 || policy.maxWallMs === 0
    || policy.maxTokens === 0 || policy.maxToolResultChars === 0
    || policy.maxInputTokens === 0 || policy.maxOutputTokens === 0
    || policy.maxFinalChars === 0 || policy.maxTraceSteps === 0) {
    throw new Error('invalid-budget:required-limit-is-zero');
  }
}

export function createBudgetLedger(policy: HarnessBudgetPolicy, clock: HarnessClock): BudgetLedger {
  validateBudgetPolicy(policy);
  const maxInputTokens = policy.maxInputTokens ?? policy.maxTokens;
  const maxOutputTokens = policy.maxOutputTokens ?? policy.maxTokens;
  const startMs = clock.nowMs();
  let stepsUsed = 0;
  let modelCallsUsed = 0;
  let toolCallsUsed = 0;
  let writesUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicrousd = 0;
  const wall = () => Math.max(0, clock.nowMs() - startMs);
  const tokens = () => inputTokens + outputTokens;
  // 冻结优先级，保证同一次完成同时越过多个上限时仍产生唯一、可回放的原因。
  const hardLimitReason = (): HarnessBudgetLimit | null => {
    if (wall() > policy.maxWallMs) return 'wall-time';
    if (costMicrousd > policy.maxCostMicrousd) return 'cost';
    if (inputTokens > maxInputTokens) return 'input-token';
    if (outputTokens > maxOutputTokens) return 'output-token';
    if (tokens() > policy.maxTokens) return 'token';
    return null;
  };
  const exhaustedLimitReason = (): HarnessBudgetLimit | null => {
    if (wall() >= policy.maxWallMs) return 'wall-time';
    // maxCostMicrousd=0 is the explicit free/mock profile. It may execute only
    // while reported cost remains zero; a positive spend is caught by hardLimitReason.
    if (policy.maxCostMicrousd > 0 && costMicrousd >= policy.maxCostMicrousd) return 'cost';
    if (inputTokens >= maxInputTokens) return 'input-token';
    if (outputTokens >= maxOutputTokens) return 'output-token';
    if (tokens() >= policy.maxTokens) return 'token';
    return null;
  };
  const within = () => hardLimitReason() === null;
  return {
    policy,
    snapshot: () => ({ stepsUsed, modelCallsUsed, toolCallsUsed, writesUsed,
      inputTokens, outputTokens, costMicrousd, tokensUsed: tokens(), wallMsUsed: wall() }),
    hardLimitReason,
    exhaustedLimitReason,
    canContinue: () => within() && stepsUsed < policy.maxSteps,
    consumeStep: () => {
      if (!within() || stepsUsed >= policy.maxSteps) return false;
      stepsUsed += 1;
      return true;
    },
    consumeModel: () => {
      if (!within() || modelCallsUsed >= policy.maxModelCalls) return false;
      modelCallsUsed += 1;
      return true;
    },
    consumeTool: () => {
      if (!within() || toolCallsUsed >= policy.maxToolCalls) return false;
      toolCallsUsed += 1;
      return true;
    },
    consumeWrite: () => {
      if (!within() || writesUsed >= policy.maxWrites) return false;
      writesUsed += 1;
      return true;
    },
    addUsage: (usage) => {
      if (![usage.inputTokens, usage.outputTokens, usage.costMicrousd].every(nonNegativeInteger)) return false;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      costMicrousd += usage.costMicrousd;
      return within();
    },
    remainingTokens: () => Math.max(0, policy.maxTokens - tokens()),
    remainingInputTokens: () => Math.max(0, maxInputTokens - inputTokens),
    remainingOutputTokens: () => Math.max(
      0,
      Math.min(maxOutputTokens - outputTokens, policy.maxTokens - tokens()),
    ),
  };
}

export interface HarnessResult {
  readonly status: 'final-answer' | 'budget-exhausted' | 'model-error' | 'cancelled';
  /** 稳定的一等终止合同；调用方不得再通过反扫 trace 推断。 */
  readonly terminationReason: HarnessTerminationReason;
  readonly finalAnswer: string | null;
  readonly state: Record<string, unknown>;
  readonly trace: readonly TraceStep[];
  readonly budget: BudgetSnapshot;
  /** 只有 final-answer 才允许为 true。 */
  readonly committed: boolean;
}
