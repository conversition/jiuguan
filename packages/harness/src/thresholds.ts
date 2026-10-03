/**
 * P13-04：候选评测阈值（草案）。
 *
 * ⚠️ 边界：以下全部是**候选**门槛，仅用于评测层自我度量与回归对比；
 * ADR-0015 只批准了独立后台 shadow lane；本评测文件仍不构成 apply、交互 Harness
 * 或真实 Provider A/B 的启用依据。
 */
import type { SuiteMetrics } from './evaluator.ts';
import type { ScenarioOutcome } from './evaluator.ts';
import type { BaselineComparison } from './baseline.ts';

export interface CandidateThresholds {
  /** 契约成功率（golden 套件按预期收敛）下限。 */
  readonly minContractSuccessRate: number;
  /** 有显式事实断言的场景，最终答复必须满足的比率。 */
  readonly minFactSupportRate: number;
  /** 越权写入（state 被预期外键污染）红线：必须为零。 */
  readonly maxUnauthorizedWriteCount: number;
  /** 模型异常（非协议失败）红线：必须为零（mock 下出现即脚手架缺陷）。 */
  readonly maxModelErrorCount: number;
  /**
   * 非预期循环耗尽率上限：只统计「期望收敛却耗尽」的场景（场景自身预期耗尽即
   * intentional，不计入）——golden 套件刻意包含耗尽场景，总耗尽率不是有效门槛。
   */
  readonly maxUnintendedExhaustionRate: number;
  /** P95 延迟上限（fake clock 单位；真实时钟评测时换算为 ms）。 */
  readonly maxLatencyP95Ms: number;
  readonly maxSuiteTokens: number;
  readonly maxSuiteCostMicrousd: number;
}

export const CANDIDATE_THRESHOLDS: CandidateThresholds = {
  minContractSuccessRate: 0.9,
  minFactSupportRate: 0.9,
  maxUnauthorizedWriteCount: 0,
  maxModelErrorCount: 0,
  maxUnintendedExhaustionRate: 0.1,
  maxLatencyP95Ms: 5_000,
  maxSuiteTokens: 10_000,
  /** mock/replay 套件不得产生真实费用。 */
  maxSuiteCostMicrousd: 0,
};

export interface ThresholdGate {
  readonly name: string;
  readonly ok: boolean;
  readonly actual: number;
  readonly threshold: number;
}

export interface ThresholdReport {
  readonly passed: boolean;
  readonly gates: readonly ThresholdGate[];
  /** 恒为 false：评测层永远不输出“可上线”，生产 lane 由服务端独立门禁。 */
  readonly productionEnabled: false;
}

export function evaluateCandidateThresholds(
  metrics: SuiteMetrics,
  outcomes: readonly ScenarioOutcome[],
  thresholds: CandidateThresholds = CANDIDATE_THRESHOLDS,
): ThresholdReport {
  const unauthorizedWriteCount = outcomes.filter((outcome) =>
    outcome.failures.some((failure) => failure.includes('不应存在'))).length;
  const modelErrorCount = outcomes.filter((outcome) =>
    outcome.result.status === 'model-error').length;
  // 非预期耗尽 = 以耗尽收尾且未通过自身预期（intentional 耗尽场景会通过预期检查）
  const unintendedExhaustion = outcomes.filter((outcome) =>
    outcome.result.status === 'budget-exhausted' && !outcome.passed).length;
  const unintendedExhaustionRate = outcomes.length === 0 ? 0 : unintendedExhaustion / outcomes.length;
  const gates: ThresholdGate[] = [
    {
      name: '事实支撑率 ≥ 下限',
      ok: metrics.factSupportRate >= thresholds.minFactSupportRate,
      actual: metrics.factSupportRate,
      threshold: thresholds.minFactSupportRate,
    },
    {
      name: '契约成功率 ≥ 下限',
      ok: metrics.contractSuccessRate >= thresholds.minContractSuccessRate,
      actual: metrics.contractSuccessRate,
      threshold: thresholds.minContractSuccessRate,
    },
    {
      name: '越权写入 = 0（红线）',
      ok: unauthorizedWriteCount <= thresholds.maxUnauthorizedWriteCount,
      actual: unauthorizedWriteCount,
      threshold: thresholds.maxUnauthorizedWriteCount,
    },
    {
      name: '模型异常 = 0（红线）',
      ok: modelErrorCount <= thresholds.maxModelErrorCount,
      actual: modelErrorCount,
      threshold: thresholds.maxModelErrorCount,
    },
    {
      name: '非预期循环耗尽率 ≤ 上限',
      ok: unintendedExhaustionRate <= thresholds.maxUnintendedExhaustionRate,
      actual: unintendedExhaustionRate,
      threshold: thresholds.maxUnintendedExhaustionRate,
    },
    {
      name: 'P95 延迟 ≤ 上限',
      ok: metrics.latencyP95Ms <= thresholds.maxLatencyP95Ms,
      actual: metrics.latencyP95Ms,
      threshold: thresholds.maxLatencyP95Ms,
    },
    {
      name: '套件 token ≤ 上限',
      ok: metrics.tokenTotal <= thresholds.maxSuiteTokens,
      actual: metrics.tokenTotal,
      threshold: thresholds.maxSuiteTokens,
    },
    {
      name: '套件费用 ≤ 上限',
      ok: metrics.costMicrousdTotal <= thresholds.maxSuiteCostMicrousd,
      actual: metrics.costMicrousdTotal,
      threshold: thresholds.maxSuiteCostMicrousd,
    },
  ];
  return { passed: gates.every((gate) => gate.ok), gates, productionEnabled: false };
}

export interface ComparisonThresholds {
  readonly minContractSuccessRateDelta: number;
  readonly minFactSupportRateDelta: number;
  readonly maxInvalidToolCallRateDelta: number;
  readonly maxLoopExhaustionRateDelta: number;
  readonly maxTokenMultiplier: number;
  readonly maxCostMultiplier: number;
  readonly maxLatencyP95Multiplier: number;
}

export const COMPARISON_THRESHOLDS: ComparisonThresholds = {
  minContractSuccessRateDelta: 0,
  minFactSupportRateDelta: 0,
  maxInvalidToolCallRateDelta: 0,
  maxLoopExhaustionRateDelta: 0,
  // Harness 允许用额外预算换取质量，但必须受控；正式值仍由 ADR-0015 冻结。
  maxTokenMultiplier: 2.5,
  maxCostMultiplier: 2.5,
  maxLatencyP95Multiplier: 2.5,
};

function ratio(candidate: number, incumbent: number): number {
  if (incumbent === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / incumbent;
}

/** P13-03 产出真实同场景 baseline 后使用；无 baseline 数据时不得伪造调用。 */
export function evaluateBaselineComparison(
  comparison: BaselineComparison,
  thresholds: ComparisonThresholds = COMPARISON_THRESHOLDS,
): ThresholdReport {
  const { candidate, incumbent, delta } = comparison;
  const gates: ThresholdGate[] = [
    {
      name: '契约成功率不得下降',
      ok: delta.contractSuccessRateDelta >= thresholds.minContractSuccessRateDelta,
      actual: delta.contractSuccessRateDelta,
      threshold: thresholds.minContractSuccessRateDelta,
    },
    {
      name: '事实支撑率不得下降',
      ok: delta.factSupportRateDelta >= thresholds.minFactSupportRateDelta,
      actual: delta.factSupportRateDelta,
      threshold: thresholds.minFactSupportRateDelta,
    },
    {
      name: '无效工具率不得上升',
      ok: delta.invalidToolCallRateDelta <= thresholds.maxInvalidToolCallRateDelta,
      actual: delta.invalidToolCallRateDelta,
      threshold: thresholds.maxInvalidToolCallRateDelta,
    },
    {
      name: '循环耗尽率不得上升',
      ok: delta.loopExhaustionRateDelta <= thresholds.maxLoopExhaustionRateDelta,
      actual: delta.loopExhaustionRateDelta,
      threshold: thresholds.maxLoopExhaustionRateDelta,
    },
    {
      name: '越权写入仍为零',
      ok: candidate.unauthorizedWriteCount === 0,
      actual: candidate.unauthorizedWriteCount,
      threshold: 0,
    },
    {
      name: 'token 倍率受控',
      ok: ratio(candidate.tokenTotal, incumbent.tokenTotal) <= thresholds.maxTokenMultiplier,
      actual: ratio(candidate.tokenTotal, incumbent.tokenTotal),
      threshold: thresholds.maxTokenMultiplier,
    },
    {
      name: '费用倍率受控',
      ok: ratio(candidate.costMicrousdTotal, incumbent.costMicrousdTotal) <= thresholds.maxCostMultiplier,
      actual: ratio(candidate.costMicrousdTotal, incumbent.costMicrousdTotal),
      threshold: thresholds.maxCostMultiplier,
    },
    {
      name: 'P95 延迟倍率受控',
      ok: ratio(candidate.latencyP95Ms, incumbent.latencyP95Ms) <= thresholds.maxLatencyP95Multiplier,
      actual: ratio(candidate.latencyP95Ms, incumbent.latencyP95Ms),
      threshold: thresholds.maxLatencyP95Multiplier,
    },
  ];
  return { passed: gates.every((gate) => gate.ok), gates, productionEnabled: false };
}
