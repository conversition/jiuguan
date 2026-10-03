/**
 * P13-03：与单轮 `game_turn` 的 baseline 对比脚手架。
 *
 * 形状：同一场景集分别经过「候选 Harness 循环执行器」与「现行单轮执行器」，
 * 输出两侧指标与差值。评测层默认两侧都注入 mock/replay——**真实 Provider A/B
 * 必须显式启用**（涉及费用与真实上游调用），本模块用硬门控保证不会意外触发。
 * 现行 `game_turn` 的同场景 replay 只保存稳定场景 id 与聚合计数，不保存 prompt、正文、
 * 工具参数或思维链；真实 Provider A/B 仍需另行批准费用。
 */
import type { EvaluationScenario, ScenarioOutcome } from './evaluator.ts';
import type { SuiteMetrics } from './evaluator.ts';

export const REAL_PROVIDER_AB_ENABLED = false;

/** 真实 Provider A/B 的显式启用闸：未获用户明确同意（费用）前调用即抛错。 */
export function requireRealProviderConsent(consent: {
  readonly realProviderAb: boolean;
  readonly costApproved: boolean;
}): void {
  if (!REAL_PROVIDER_AB_ENABLED || !consent.realProviderAb || !consent.costApproved) {
    throw new Error(
      '真实 Provider A/B 未启用：需要用户显式同意费用并设置 consent.realProviderAb=true。'
      + ' 评测层默认只允许 mock/replay。',
    );
  }
}

export interface ExecutorMetrics {
  readonly executor: string;
  readonly contractSuccessRate: number;
  readonly factSupportRate: number;
  readonly invalidToolCallRate: number;
  readonly loopExhaustionRate: number;
  readonly unauthorizedWriteCount: number;
  readonly modelCallTotal: number;
  readonly toolCallTotal: number;
  readonly tokenTotal: number;
  readonly costMicrousdTotal: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

export interface BaselineComparison {
  readonly candidate: ExecutorMetrics;
  readonly incumbent: ExecutorMetrics;
  readonly delta: {
    readonly contractSuccessRateDelta: number;
    readonly factSupportRateDelta: number;
    readonly invalidToolCallRateDelta: number;
    readonly loopExhaustionRateDelta: number;
    readonly modelCallDelta: number;
    readonly toolCallDelta: number;
    readonly tokenDelta: number;
    readonly costMicrousdDelta: number;
    readonly latencyP95DeltaMs: number;
  };
}

export interface BaselineExecutor {
  readonly name: string;
  run(scenarios: readonly EvaluationScenario[]): Promise<ExecutorMetrics>;
}

export interface SingleTurnReplayArtifact {
  readonly version: 1;
  readonly executor: 'single-turn-game_turn';
  readonly redacted: true;
  readonly sourceArtifactDigest: string;
  readonly cases: readonly {
    readonly scenarioId: string;
    readonly contractValid: boolean;
    readonly factChecks: number;
    readonly factFailures: number;
    readonly modelCalls: number;
    readonly toolCalls: 0;
    readonly tokens: number;
    readonly costMicrousd: number;
    readonly latencyMs: number;
  }[];
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.join('\0') === [...keys].sort().join('\0');
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * 读取 P13-03 脱敏 replay。形状严格拒绝额外字段，防止 prompt/正文/路径被误提交进评测产物。
 */
export function parseSingleTurnReplay(
  value: unknown,
  expectedScenarioIds: readonly string[],
): SingleTurnReplayArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('single-turn-replay-invalid');
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ['version', 'executor', 'redacted', 'sourceArtifactDigest', 'cases'])
    || root.version !== 1 || root.executor !== 'single-turn-game_turn' || root.redacted !== true
    || typeof root.sourceArtifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(root.sourceArtifactDigest)
    || !Array.isArray(root.cases)) throw new Error('single-turn-replay-invalid');
  const seen = new Set<string>();
  const cases = root.cases.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('single-turn-replay-case-invalid');
    const row = item as Record<string, unknown>;
    if (!exactKeys(row, [
      'scenarioId', 'contractValid', 'factChecks', 'factFailures', 'modelCalls',
      'toolCalls', 'tokens', 'costMicrousd', 'latencyMs',
    ]) || typeof row.scenarioId !== 'string' || row.scenarioId.length < 2 || row.scenarioId.length > 80
      || /[\u0000-\u001f\u007f]/.test(row.scenarioId)
      || seen.has(row.scenarioId) || typeof row.contractValid !== 'boolean'
      || !integer(row.factChecks) || !integer(row.factFailures) || row.factFailures > row.factChecks
      || !integer(row.modelCalls) || row.modelCalls < 1 || row.modelCalls > 2
      || row.toolCalls !== 0 || !integer(row.tokens) || !integer(row.costMicrousd)
      || !integer(row.latencyMs)) throw new Error('single-turn-replay-case-invalid');
    seen.add(row.scenarioId);
    return Object.freeze({
      scenarioId: row.scenarioId,
      contractValid: row.contractValid,
      factChecks: row.factChecks,
      factFailures: row.factFailures,
      modelCalls: row.modelCalls,
      toolCalls: 0 as const,
      tokens: row.tokens,
      costMicrousd: row.costMicrousd,
      latencyMs: row.latencyMs,
    });
  });
  if (cases.length !== expectedScenarioIds.length
    || expectedScenarioIds.some((id) => !seen.has(id))) throw new Error('single-turn-replay-scenario-mismatch');
  return Object.freeze({
    version: 1,
    executor: 'single-turn-game_turn',
    redacted: true,
    sourceArtifactDigest: root.sourceArtifactDigest,
    cases: Object.freeze(cases),
  });
}

export function metricsFromSingleTurnReplay(artifact: SingleTurnReplayArtifact): ExecutorMetrics {
  const total = artifact.cases.length;
  const factChecks = artifact.cases.reduce((sum, row) => sum + row.factChecks, 0);
  const factFailures = artifact.cases.reduce((sum, row) => sum + row.factFailures, 0);
  const latencies = artifact.cases.map((row) => row.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number): number =>
    latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]!;
  return {
    executor: artifact.executor,
    contractSuccessRate: total === 0 ? 0 : artifact.cases.filter((row) => row.contractValid).length / total,
    factSupportRate: factChecks === 0 ? 1 : (factChecks - factFailures) / factChecks,
    invalidToolCallRate: 0,
    loopExhaustionRate: 0,
    unauthorizedWriteCount: 0,
    modelCallTotal: artifact.cases.reduce((sum, row) => sum + row.modelCalls, 0),
    toolCallTotal: 0,
    tokenTotal: artifact.cases.reduce((sum, row) => sum + row.tokens, 0),
    costMicrousdTotal: artifact.cases.reduce((sum, row) => sum + row.costMicrousd, 0),
    latencyP50Ms: percentile(0.5),
    latencyP95Ms: percentile(0.95),
  };
}

function metricsFromOutcomes(
  executor: string,
  outcomes: readonly ScenarioOutcome[],
): ExecutorMetrics {
  const total = outcomes.length;
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const factChecks = outcomes.reduce((sum, outcome) => sum + outcome.factChecks, 0);
  const factFailures = outcomes.reduce((sum, outcome) => sum + outcome.factFailures, 0);
  const invalidToolScenarios = outcomes.filter((outcome) =>
    outcome.result.trace.some((step) => step.kind === 'tool-invalid')).length;
  const exhausted = outcomes.filter((outcome) => outcome.result.status === 'budget-exhausted').length;
  const unauthorized = outcomes.filter((outcome) =>
    outcome.failures.some((failure) => failure.includes('不应存在'))).length;
  const modelCallTotal = outcomes.reduce((sum, outcome) => sum + outcome.result.budget.modelCallsUsed, 0);
  const toolCallTotal = outcomes.reduce((sum, outcome) => sum + outcome.result.budget.toolCallsUsed, 0);
  const tokenTotal = outcomes.reduce((sum, outcome) => sum + outcome.result.budget.tokensUsed, 0);
  const costMicrousdTotal = outcomes.reduce((sum, outcome) => sum + outcome.result.budget.costMicrousd, 0);
  const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number): number =>
    latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]!;
  return {
    executor,
    contractSuccessRate: total === 0 ? 0 : passed / total,
    factSupportRate: factChecks === 0 ? 1 : (factChecks - factFailures) / factChecks,
    invalidToolCallRate: total === 0 ? 0 : invalidToolScenarios / total,
    loopExhaustionRate: total === 0 ? 0 : exhausted / total,
    unauthorizedWriteCount: unauthorized,
    modelCallTotal,
    toolCallTotal,
    tokenTotal,
    costMicrousdTotal,
    latencyP50Ms: percentile(0.5),
    latencyP95Ms: percentile(0.95),
  };
}

export function metricsFromSuite(
  executor: string,
  outcomes: readonly ScenarioOutcome[],
): ExecutorMetrics {
  return metricsFromOutcomes(executor, outcomes);
}

/** 现行单轮执行器基线指标（从既有评测产物换算；两侧共用同一 ScenarioOutcome 语义）。 */
export function compareAgainstBaseline(
  candidateOutcomes: readonly ScenarioOutcome[],
  incumbentOutcomes: readonly ScenarioOutcome[],
): BaselineComparison {
  const candidate = metricsFromOutcomes('harness-loop', candidateOutcomes);
  const incumbent = metricsFromOutcomes('single-turn', incumbentOutcomes);
  return {
    candidate,
    incumbent,
    delta: {
      contractSuccessRateDelta: candidate.contractSuccessRate - incumbent.contractSuccessRate,
      factSupportRateDelta: candidate.factSupportRate - incumbent.factSupportRate,
      invalidToolCallRateDelta: candidate.invalidToolCallRate - incumbent.invalidToolCallRate,
      loopExhaustionRateDelta: candidate.loopExhaustionRate - incumbent.loopExhaustionRate,
      modelCallDelta: candidate.modelCallTotal - incumbent.modelCallTotal,
      toolCallDelta: candidate.toolCallTotal - incumbent.toolCallTotal,
      tokenDelta: candidate.tokenTotal - incumbent.tokenTotal,
      costMicrousdDelta: candidate.costMicrousdTotal - incumbent.costMicrousdTotal,
      latencyP95DeltaMs: candidate.latencyP95Ms - incumbent.latencyP95Ms,
    },
  };
}

/** 防御性占位：SuiteMetrics 级别的快速对比（报告用）。 */
export function suiteDelta(candidate: SuiteMetrics, incumbent: SuiteMetrics): {
  contractSuccessRateDelta: number;
  loopExhaustionRateDelta: number;
  latencyP95DeltaMs: number;
  tokenDelta: number;
  costMicrousdDelta: number;
} {
  return {
    contractSuccessRateDelta: candidate.contractSuccessRate - incumbent.contractSuccessRate,
    loopExhaustionRateDelta: candidate.loopExhaustionRate - incumbent.loopExhaustionRate,
    latencyP95DeltaMs: candidate.latencyP95Ms - incumbent.latencyP95Ms,
    tokenDelta: candidate.tokenTotal - incumbent.tokenTotal,
    costMicrousdDelta: candidate.costMicrousdTotal - incumbent.costMicrousdTotal,
  };
}
