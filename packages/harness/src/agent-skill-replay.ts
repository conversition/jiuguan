import { createHash } from 'node:crypto';

/**
 * Domain-neutral candidate-vs-incumbent replay for Agent Skills.
 *
 * Scenario inputs, run configuration and executor outputs are deliberately transient. The
 * persistable evidence returned by this module contains only immutable digests, bounded numeric
 * metrics, booleans/enums needed by the contract, and bounded reason codes.
 */

export const AGENT_SKILL_REPLAY_EVIDENCE_VERSION = 'agent-skill-replay-evidence-v1' as const;
export const AGENT_SKILL_REPLAY_CLASSES = Object.freeze(['fixture', 'operational'] as const);

export type AgentSkillReplayClass = (typeof AGENT_SKILL_REPLAY_CLASSES)[number];
export type AgentSkillReplayVariant = 'incumbent' | 'candidate';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,95}$/u;
const MAX_SCENARIOS = 1_000;
const MAX_REASON_CODES = 16;
const MAX_CALLS = 1_000_000;
const MAX_METRIC = 1_000_000_000_000;
const MAX_TOTAL = 1_000_000_000_000_000;
const MAX_LATENCY_MS = 86_400_000;
const BASIS_POINTS = 10_000;

const ARM_METRIC_KEYS = [
  'contractSuccess', 'modelCalls', 'toolCalls', 'invalidCalls', 'inputTokens',
  'outputTokens', 'costMicrousd', 'latencyMs', 'safetyFallbacks', 'reasonCodes',
] as const;
const EXECUTION_METRIC_KEYS = [
  'contractSucceeded', 'modelCalls', 'toolCalls', 'invalidCalls', 'inputTokens',
  'outputTokens', 'costMicrousd', 'latencyMs', 'safetyFallbacks',
] as const;
const THRESHOLD_KEYS = [
  'scenarioCountMin',
  'contractSuccessRateMinBps', 'contractSuccessRegressionMaxBps',
  'invalidCallRateMaxBps', 'invalidCallRateRegressionMaxBps',
  'costMicrousdMax', 'costIncreaseMicrousdMax',
  'domainScoreMinBps', 'domainScoreDeltaMinBps',
] as const;
const AGGREGATE_KEYS = [
  'contractSuccessRateBps', 'totalCalls', 'invalidCalls', 'invalidCallRateBps',
  'costMicrousd', 'domainScoreBps', 'safetyFallbacks',
] as const;
const DELTA_KEYS = [
  'contractSuccessRateBps', 'invalidCallRateBps', 'costMicrousd', 'domainScoreBps',
] as const;

export interface AgentSkillReplayScenario<TScenario> {
  /** Transient diagnostic identity. It is echoed by ports but is not persisted. */
  readonly scenarioId: string;
  /** Immutable identity of the redacted scenario revision. */
  readonly scenarioDigest: string;
  /** Transient domain payload; it may contain prompts and must never enter evidence. */
  readonly input: TScenario;
}

export interface AgentSkillReplayRunConfig<TRunConfig> {
  /** Caller-owned digest of the exact immutable run configuration. */
  readonly digest: string;
  /** Transient configuration passed by reference to both variants. */
  readonly value: TRunConfig;
}

export interface AgentSkillReplayExecutionMetrics {
  readonly contractSucceeded: boolean;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly invalidCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
  readonly latencyMs: number;
  /** Any safety fallback is a hard candidate failure; there is no configurable allowance. */
  readonly safetyFallbacks: number;
}

export interface AgentSkillReplayExecutionObservation<TOutput> {
  readonly scenarioId: string;
  readonly scenarioDigest: string;
  readonly runConfigDigest: string;
  readonly metrics: AgentSkillReplayExecutionMetrics;
  readonly reasonCodes: readonly string[];
  /** Transient executor/model result. It is available to the evaluator and then discarded. */
  readonly output: TOutput;
}

export interface AgentSkillReplayExecutionRequest<TScenario, TRunConfig> {
  readonly variant: AgentSkillReplayVariant;
  readonly bundleDigest: string;
  readonly runConfigDigest: string;
  readonly runConfig: TRunConfig;
  readonly scenario: AgentSkillReplayScenario<TScenario>;
}

export interface AgentSkillReplayExecutorPort<TScenario, TRunConfig, TOutput> {
  /** Implementations must treat request.runConfig and request.scenario as immutable. */
  execute(
    request: AgentSkillReplayExecutionRequest<TScenario, TRunConfig>,
  ): Promise<AgentSkillReplayExecutionObservation<TOutput>>;
}

export interface AgentSkillDomainEvaluationRequest<TScenario, TRunConfig, TOutput> {
  readonly runConfigDigest: string;
  readonly runConfig: TRunConfig;
  readonly scenario: AgentSkillReplayScenario<TScenario>;
  readonly incumbent: Readonly<{
    metrics: AgentSkillReplayExecutionMetrics;
    reasonCodes: readonly string[];
    output: TOutput;
  }>;
  readonly candidate: Readonly<{
    metrics: AgentSkillReplayExecutionMetrics;
    reasonCodes: readonly string[];
    output: TOutput;
  }>;
}

export interface AgentSkillDomainEvaluation {
  readonly scenarioId: string;
  readonly scenarioDigest: string;
  readonly runConfigDigest: string;
  readonly incumbentScoreBps: number;
  readonly candidateScoreBps: number;
  readonly reasonCodes: readonly string[];
}

/** Generic port: the harness knows nothing about how a domain score is produced. */
export interface AgentSkillDomainEvaluatorPort<TScenario, TRunConfig, TOutput> {
  readonly evaluatorDigest: string;
  /** Implementations must treat the shared run configuration and scenario as immutable. */
  evaluate(
    request: AgentSkillDomainEvaluationRequest<TScenario, TRunConfig, TOutput>,
  ): Promise<AgentSkillDomainEvaluation>;
}

export interface AgentSkillReplayThresholds {
  /** Minimum aligned scenario sample required before any evidence can pass. */
  readonly scenarioCountMin: number;
  readonly contractSuccessRateMinBps: number;
  readonly contractSuccessRegressionMaxBps: number;
  readonly invalidCallRateMaxBps: number;
  readonly invalidCallRateRegressionMaxBps: number;
  readonly costMicrousdMax: number;
  readonly costIncreaseMicrousdMax: number;
  readonly domainScoreMinBps: number;
  /** Signed minimum candidate-minus-incumbent domain score. */
  readonly domainScoreDeltaMinBps: number;
}

export interface AgentSkillReplayArmEvidence {
  readonly contractSuccess: 0 | 1;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly invalidCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
  readonly latencyMs: number;
  readonly safetyFallbacks: number;
  readonly reasonCodes: readonly string[];
}

export interface AgentSkillReplayDomainEvidence {
  readonly incumbentScoreBps: number;
  readonly candidateScoreBps: number;
  readonly reasonCodes: readonly string[];
}

export interface AgentSkillReplayScenarioEvidence {
  readonly scenarioDigest: string;
  readonly incumbent: AgentSkillReplayArmEvidence;
  readonly candidate: AgentSkillReplayArmEvidence;
  readonly domain: AgentSkillReplayDomainEvidence;
}

export interface AgentSkillReplayAggregateMetrics {
  readonly contractSuccessRateBps: number;
  readonly totalCalls: number;
  readonly invalidCalls: number;
  readonly invalidCallRateBps: number;
  readonly costMicrousd: number;
  readonly domainScoreBps: number;
  readonly safetyFallbacks: number;
}

export interface AgentSkillReplayDeltaMetrics {
  readonly contractSuccessRateBps: number;
  readonly invalidCallRateBps: number;
  readonly costMicrousd: number;
  readonly domainScoreBps: number;
}

export type AgentSkillReplayLifecycleGateReason =
  | 'operational-replay-passed'
  | 'fixture-evidence-not-promotable'
  | 'replay-thresholds-failed';

export interface AgentSkillReplaySummary {
  readonly scenarioCount: number;
  readonly incumbent: AgentSkillReplayAggregateMetrics;
  readonly candidate: AgentSkillReplayAggregateMetrics;
  readonly delta: AgentSkillReplayDeltaMetrics;
  readonly passed: boolean;
  /**
   * This only states evidence suitability. It does not invoke or mutate the Skill lifecycle.
   * Fixture evidence is always false, even when every quantitative threshold passes.
   */
  readonly lifecyclePromotionEligible: boolean;
  readonly lifecycleGateReasonCode: AgentSkillReplayLifecycleGateReason;
  readonly gateReasonCodes: readonly string[];
}

export interface AgentSkillReplayEvidenceV1 {
  readonly version: typeof AGENT_SKILL_REPLAY_EVIDENCE_VERSION;
  readonly evidenceClass: AgentSkillReplayClass;
  readonly incumbentDigest: string;
  readonly candidateDigest: string;
  readonly runConfigDigest: string;
  readonly evaluatorDigest: string;
  readonly scenarioSetDigest: string;
  readonly thresholds: AgentSkillReplayThresholds;
  readonly scenarios: readonly AgentSkillReplayScenarioEvidence[];
  readonly summary: AgentSkillReplaySummary;
}

export interface AgentSkillReplayComparisonInput<TScenario, TRunConfig, TOutput> {
  readonly evidenceClass: AgentSkillReplayClass;
  readonly incumbentDigest: string;
  readonly candidateDigest: string;
  readonly runConfig: AgentSkillReplayRunConfig<TRunConfig>;
  readonly scenarios: readonly AgentSkillReplayScenario<TScenario>[];
  readonly thresholds: AgentSkillReplayThresholds;
  readonly executor: AgentSkillReplayExecutorPort<TScenario, TRunConfig, TOutput>;
  readonly evaluator: AgentSkillDomainEvaluatorPort<TScenario, TRunConfig, TOutput>;
}

export interface AgentSkillReplayComparisonResult {
  readonly evidence: AgentSkillReplayEvidenceV1;
  readonly evidenceDigest: string;
}

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}-invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label}-invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label}-fields-invalid`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${label}-invalid`);
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new TypeError(`${label}-invalid`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label}-invalid`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label}-invalid`);
  return value;
}

function reasonCodes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) throw new TypeError(`${label}-invalid`);
  const output = value.map((entry, index) => token(entry, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new TypeError(`${label}-duplicate`);
  return Object.freeze(output.sort(compareText));
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function checkedAdd(left: number, right: number, label: string): number {
  const output = left + right;
  if (!Number.isSafeInteger(output) || output > MAX_TOTAL) throw new Error(`${label}-overflow`);
  return output;
}

function rateBps(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.floor((numerator * BASIS_POINTS) / denominator);
}

function normalizeThresholds(value: unknown): AgentSkillReplayThresholds {
  plain(value, 'skill-replay-thresholds');
  exact(value, THRESHOLD_KEYS, 'skill-replay-thresholds');
  return frozen({
    scenarioCountMin: boundedInteger(value.scenarioCountMin, 'scenario-count-min', 1, MAX_SCENARIOS),
    contractSuccessRateMinBps: boundedInteger(
      value.contractSuccessRateMinBps, 'contract-success-rate-min-bps', 0, BASIS_POINTS,
    ),
    contractSuccessRegressionMaxBps: boundedInteger(
      value.contractSuccessRegressionMaxBps, 'contract-success-regression-max-bps', 0, BASIS_POINTS,
    ),
    invalidCallRateMaxBps: boundedInteger(
      value.invalidCallRateMaxBps, 'invalid-call-rate-max-bps', 0, BASIS_POINTS,
    ),
    invalidCallRateRegressionMaxBps: boundedInteger(
      value.invalidCallRateRegressionMaxBps, 'invalid-call-rate-regression-max-bps', 0, BASIS_POINTS,
    ),
    costMicrousdMax: boundedInteger(value.costMicrousdMax, 'cost-microusd-max', 0, MAX_TOTAL),
    costIncreaseMicrousdMax: boundedInteger(
      value.costIncreaseMicrousdMax, 'cost-increase-microusd-max', 0, MAX_TOTAL,
    ),
    domainScoreMinBps: boundedInteger(value.domainScoreMinBps, 'domain-score-min-bps', 0, BASIS_POINTS),
    domainScoreDeltaMinBps: boundedInteger(
      value.domainScoreDeltaMinBps, 'domain-score-delta-min-bps', -BASIS_POINTS, BASIS_POINTS,
    ),
  });
}

function normalizeExecutionMetrics(value: unknown): AgentSkillReplayExecutionMetrics {
  plain(value, 'skill-replay-execution-metrics');
  exact(value, EXECUTION_METRIC_KEYS, 'skill-replay-execution-metrics');
  const modelCalls = boundedInteger(value.modelCalls, 'execution-model-calls', 0, MAX_CALLS);
  const toolCalls = boundedInteger(value.toolCalls, 'execution-tool-calls', 0, MAX_CALLS);
  const invalidCalls = boundedInteger(value.invalidCalls, 'execution-invalid-calls', 0, MAX_CALLS);
  if (invalidCalls > modelCalls + toolCalls) throw new TypeError('execution-invalid-calls-exceed-total');
  return frozen({
    contractSucceeded: booleanValue(value.contractSucceeded, 'execution-contract-succeeded'),
    modelCalls,
    toolCalls,
    invalidCalls,
    inputTokens: boundedInteger(value.inputTokens, 'execution-input-tokens', 0, MAX_METRIC),
    outputTokens: boundedInteger(value.outputTokens, 'execution-output-tokens', 0, MAX_METRIC),
    costMicrousd: boundedInteger(value.costMicrousd, 'execution-cost-microusd', 0, MAX_METRIC),
    latencyMs: boundedInteger(value.latencyMs, 'execution-latency-ms', 0, MAX_LATENCY_MS),
    safetyFallbacks: boundedInteger(value.safetyFallbacks, 'execution-safety-fallbacks', 0, MAX_CALLS),
  });
}

function normalizeExecutionObservation<TOutput>(
  value: unknown,
  scenario: AgentSkillReplayScenario<unknown>,
  runConfigDigest: string,
  variant: AgentSkillReplayVariant,
): AgentSkillReplayExecutionObservation<TOutput> {
  plain(value, `${variant}-execution`);
  exact(value, [
    'scenarioId', 'scenarioDigest', 'runConfigDigest', 'metrics', 'reasonCodes', 'output',
  ], `${variant}-execution`);
  if (value.scenarioId !== scenario.scenarioId || value.scenarioDigest !== scenario.scenarioDigest
    || value.runConfigDigest !== runConfigDigest) {
    throw new Error(`${variant}-execution-scenario-binding-invalid`);
  }
  return {
    scenarioId: scenario.scenarioId,
    scenarioDigest: scenario.scenarioDigest,
    runConfigDigest,
    metrics: normalizeExecutionMetrics(value.metrics),
    reasonCodes: reasonCodes(value.reasonCodes, `${variant}-execution-reason-codes`),
    output: value.output as TOutput,
  };
}

function normalizeDomainEvaluation(
  value: unknown,
  scenario: AgentSkillReplayScenario<unknown>,
  runConfigDigest: string,
): AgentSkillDomainEvaluation {
  plain(value, 'skill-replay-domain-evaluation');
  exact(value, [
    'scenarioId', 'scenarioDigest', 'runConfigDigest', 'incumbentScoreBps',
    'candidateScoreBps', 'reasonCodes',
  ], 'skill-replay-domain-evaluation');
  if (value.scenarioId !== scenario.scenarioId || value.scenarioDigest !== scenario.scenarioDigest
    || value.runConfigDigest !== runConfigDigest) {
    throw new Error('domain-evaluation-scenario-binding-invalid');
  }
  return frozen({
    scenarioId: scenario.scenarioId,
    scenarioDigest: scenario.scenarioDigest,
    runConfigDigest,
    incumbentScoreBps: boundedInteger(value.incumbentScoreBps, 'incumbent-domain-score-bps', 0, BASIS_POINTS),
    candidateScoreBps: boundedInteger(value.candidateScoreBps, 'candidate-domain-score-bps', 0, BASIS_POINTS),
    reasonCodes: reasonCodes(value.reasonCodes, 'domain-evaluation-reason-codes'),
  });
}

function executionEvidence<TOutput>(
  value: AgentSkillReplayExecutionObservation<TOutput>,
): AgentSkillReplayArmEvidence {
  return frozen({
    contractSuccess: value.metrics.contractSucceeded ? 1 as const : 0 as const,
    modelCalls: value.metrics.modelCalls,
    toolCalls: value.metrics.toolCalls,
    invalidCalls: value.metrics.invalidCalls,
    inputTokens: value.metrics.inputTokens,
    outputTokens: value.metrics.outputTokens,
    costMicrousd: value.metrics.costMicrousd,
    latencyMs: value.metrics.latencyMs,
    safetyFallbacks: value.metrics.safetyFallbacks,
    reasonCodes: value.reasonCodes,
  });
}

function normalizeArmEvidence(value: unknown, label: string): AgentSkillReplayArmEvidence {
  plain(value, label);
  exact(value, ARM_METRIC_KEYS, label);
  const modelCalls = boundedInteger(value.modelCalls, `${label}-model-calls`, 0, MAX_CALLS);
  const toolCalls = boundedInteger(value.toolCalls, `${label}-tool-calls`, 0, MAX_CALLS);
  const invalidCalls = boundedInteger(value.invalidCalls, `${label}-invalid-calls`, 0, MAX_CALLS);
  if (invalidCalls > modelCalls + toolCalls) throw new TypeError(`${label}-invalid-calls-exceed-total`);
  return frozen({
    contractSuccess: boundedInteger(value.contractSuccess, `${label}-contract-success`, 0, 1) as 0 | 1,
    modelCalls,
    toolCalls,
    invalidCalls,
    inputTokens: boundedInteger(value.inputTokens, `${label}-input-tokens`, 0, MAX_METRIC),
    outputTokens: boundedInteger(value.outputTokens, `${label}-output-tokens`, 0, MAX_METRIC),
    costMicrousd: boundedInteger(value.costMicrousd, `${label}-cost-microusd`, 0, MAX_METRIC),
    latencyMs: boundedInteger(value.latencyMs, `${label}-latency-ms`, 0, MAX_LATENCY_MS),
    safetyFallbacks: boundedInteger(value.safetyFallbacks, `${label}-safety-fallbacks`, 0, MAX_CALLS),
    reasonCodes: reasonCodes(value.reasonCodes, `${label}-reason-codes`),
  });
}

function normalizeDomainEvidence(value: unknown): AgentSkillReplayDomainEvidence {
  plain(value, 'skill-replay-domain-evidence');
  exact(value, ['incumbentScoreBps', 'candidateScoreBps', 'reasonCodes'], 'skill-replay-domain-evidence');
  return frozen({
    incumbentScoreBps: boundedInteger(value.incumbentScoreBps, 'evidence-incumbent-score-bps', 0, BASIS_POINTS),
    candidateScoreBps: boundedInteger(value.candidateScoreBps, 'evidence-candidate-score-bps', 0, BASIS_POINTS),
    reasonCodes: reasonCodes(value.reasonCodes, 'evidence-domain-reason-codes'),
  });
}

function normalizeScenarioEvidence(value: unknown): AgentSkillReplayScenarioEvidence {
  plain(value, 'skill-replay-scenario-evidence');
  exact(value, ['scenarioDigest', 'incumbent', 'candidate', 'domain'], 'skill-replay-scenario-evidence');
  return frozen({
    scenarioDigest: digest(value.scenarioDigest, 'evidence-scenario-digest'),
    incumbent: normalizeArmEvidence(value.incumbent, 'evidence-incumbent'),
    candidate: normalizeArmEvidence(value.candidate, 'evidence-candidate'),
    domain: normalizeDomainEvidence(value.domain),
  });
}

function scenarioSetDigest(scenarioDigests: readonly string[]): string {
  return sha256Json({
    version: 'agent-skill-replay-scenario-set-v1',
    scenarioDigests: [...scenarioDigests].sort(compareText),
  });
}

function aggregate(
  scenarios: readonly AgentSkillReplayScenarioEvidence[],
  variant: AgentSkillReplayVariant,
): AgentSkillReplayAggregateMetrics {
  let successes = 0;
  let totalCalls = 0;
  let invalidCalls = 0;
  let costMicrousd = 0;
  let domainScoreTotal = 0;
  let safetyFallbacks = 0;
  for (const scenario of scenarios) {
    const arm = scenario[variant];
    successes = checkedAdd(successes, arm.contractSuccess, 'contract-success-total');
    totalCalls = checkedAdd(totalCalls, arm.modelCalls + arm.toolCalls, 'call-total');
    invalidCalls = checkedAdd(invalidCalls, arm.invalidCalls, 'invalid-call-total');
    costMicrousd = checkedAdd(costMicrousd, arm.costMicrousd, 'cost-total');
    safetyFallbacks = checkedAdd(safetyFallbacks, arm.safetyFallbacks, 'safety-fallback-total');
    domainScoreTotal = checkedAdd(
      domainScoreTotal,
      variant === 'incumbent' ? scenario.domain.incumbentScoreBps : scenario.domain.candidateScoreBps,
      'domain-score-total',
    );
  }
  return frozen({
    contractSuccessRateBps: rateBps(successes, scenarios.length),
    totalCalls,
    invalidCalls,
    invalidCallRateBps: rateBps(invalidCalls, totalCalls),
    costMicrousd,
    domainScoreBps: Math.floor(domainScoreTotal / scenarios.length),
    safetyFallbacks,
  });
}

function gateReasons(
  incumbent: AgentSkillReplayAggregateMetrics,
  candidate: AgentSkillReplayAggregateMetrics,
  thresholds: AgentSkillReplayThresholds,
  scenarioCount: number,
): readonly string[] {
  const output: string[] = [];
  if (scenarioCount < thresholds.scenarioCountMin) output.push('candidate-scenario-count-below-min');
  if (candidate.contractSuccessRateBps < thresholds.contractSuccessRateMinBps) {
    output.push('candidate-contract-success-below-min');
  }
  if (incumbent.contractSuccessRateBps - candidate.contractSuccessRateBps
    > thresholds.contractSuccessRegressionMaxBps) {
    output.push('candidate-contract-success-regressed');
  }
  if (candidate.invalidCallRateBps > thresholds.invalidCallRateMaxBps) {
    output.push('candidate-invalid-call-rate-above-max');
  }
  if (candidate.invalidCallRateBps - incumbent.invalidCallRateBps
    > thresholds.invalidCallRateRegressionMaxBps) {
    output.push('candidate-invalid-call-rate-regressed');
  }
  if (candidate.costMicrousd > thresholds.costMicrousdMax) {
    output.push('candidate-cost-above-max');
  }
  if (candidate.costMicrousd - incumbent.costMicrousd > thresholds.costIncreaseMicrousdMax) {
    output.push('candidate-cost-increase-above-max');
  }
  if (candidate.domainScoreBps < thresholds.domainScoreMinBps) {
    output.push('candidate-domain-score-below-min');
  }
  if (candidate.domainScoreBps - incumbent.domainScoreBps < thresholds.domainScoreDeltaMinBps) {
    output.push('candidate-domain-score-delta-below-min');
  }
  if (candidate.safetyFallbacks !== 0) output.push('candidate-safety-fallback-observed');
  return Object.freeze(output.sort(compareText));
}

function buildSummary(
  evidenceClass: AgentSkillReplayClass,
  scenarios: readonly AgentSkillReplayScenarioEvidence[],
  thresholds: AgentSkillReplayThresholds,
): AgentSkillReplaySummary {
  const incumbent = aggregate(scenarios, 'incumbent');
  const candidate = aggregate(scenarios, 'candidate');
  const reasons = gateReasons(incumbent, candidate, thresholds, scenarios.length);
  const passed = reasons.length === 0;
  const lifecyclePromotionEligible = passed && evidenceClass === 'operational';
  return frozen({
    scenarioCount: scenarios.length,
    incumbent,
    candidate,
    delta: frozen({
      contractSuccessRateBps: candidate.contractSuccessRateBps - incumbent.contractSuccessRateBps,
      invalidCallRateBps: candidate.invalidCallRateBps - incumbent.invalidCallRateBps,
      costMicrousd: candidate.costMicrousd - incumbent.costMicrousd,
      domainScoreBps: candidate.domainScoreBps - incumbent.domainScoreBps,
    }),
    passed,
    lifecyclePromotionEligible,
    lifecycleGateReasonCode: !passed
      ? 'replay-thresholds-failed' as const
      : evidenceClass === 'operational'
        ? 'operational-replay-passed' as const
        : 'fixture-evidence-not-promotable' as const,
    gateReasonCodes: reasons,
  });
}

function normalizeAggregate(value: unknown, label: string): AgentSkillReplayAggregateMetrics {
  plain(value, label);
  exact(value, AGGREGATE_KEYS, label);
  const totalCalls = boundedInteger(value.totalCalls, `${label}-total-calls`, 0, MAX_TOTAL);
  const invalidCalls = boundedInteger(value.invalidCalls, `${label}-invalid-calls`, 0, MAX_TOTAL);
  if (invalidCalls > totalCalls) throw new TypeError(`${label}-invalid-calls-exceed-total`);
  return frozen({
    contractSuccessRateBps: boundedInteger(
      value.contractSuccessRateBps, `${label}-contract-success-rate-bps`, 0, BASIS_POINTS,
    ),
    totalCalls,
    invalidCalls,
    invalidCallRateBps: boundedInteger(value.invalidCallRateBps, `${label}-invalid-call-rate-bps`, 0, BASIS_POINTS),
    costMicrousd: boundedInteger(value.costMicrousd, `${label}-cost-microusd`, 0, MAX_TOTAL),
    domainScoreBps: boundedInteger(value.domainScoreBps, `${label}-domain-score-bps`, 0, BASIS_POINTS),
    safetyFallbacks: boundedInteger(value.safetyFallbacks, `${label}-safety-fallbacks`, 0, MAX_TOTAL),
  });
}

function normalizeDelta(value: unknown): AgentSkillReplayDeltaMetrics {
  plain(value, 'skill-replay-delta');
  exact(value, DELTA_KEYS, 'skill-replay-delta');
  return frozen({
    contractSuccessRateBps: boundedInteger(
      value.contractSuccessRateBps, 'delta-contract-success-rate-bps', -BASIS_POINTS, BASIS_POINTS,
    ),
    invalidCallRateBps: boundedInteger(
      value.invalidCallRateBps, 'delta-invalid-call-rate-bps', -BASIS_POINTS, BASIS_POINTS,
    ),
    costMicrousd: boundedInteger(value.costMicrousd, 'delta-cost-microusd', -MAX_TOTAL, MAX_TOTAL),
    domainScoreBps: boundedInteger(value.domainScoreBps, 'delta-domain-score-bps', -BASIS_POINTS, BASIS_POINTS),
  });
}

function normalizeSummary(value: unknown): AgentSkillReplaySummary {
  plain(value, 'skill-replay-summary');
  exact(value, [
    'scenarioCount', 'incumbent', 'candidate', 'delta', 'passed',
    'lifecyclePromotionEligible', 'lifecycleGateReasonCode', 'gateReasonCodes',
  ], 'skill-replay-summary');
  const lifecycleGateReasonCode = token(value.lifecycleGateReasonCode, 'lifecycle-gate-reason-code');
  if (![
    'operational-replay-passed', 'fixture-evidence-not-promotable', 'replay-thresholds-failed',
  ].includes(lifecycleGateReasonCode)) {
    throw new TypeError('lifecycle-gate-reason-code-invalid');
  }
  return frozen({
    scenarioCount: boundedInteger(value.scenarioCount, 'summary-scenario-count', 1, MAX_SCENARIOS),
    incumbent: normalizeAggregate(value.incumbent, 'summary-incumbent'),
    candidate: normalizeAggregate(value.candidate, 'summary-candidate'),
    delta: normalizeDelta(value.delta),
    passed: booleanValue(value.passed, 'summary-passed'),
    lifecyclePromotionEligible: booleanValue(
      value.lifecyclePromotionEligible, 'summary-lifecycle-promotion-eligible',
    ),
    lifecycleGateReasonCode: lifecycleGateReasonCode as AgentSkillReplayLifecycleGateReason,
    gateReasonCodes: reasonCodes(value.gateReasonCodes, 'summary-gate-reason-codes'),
  });
}

/** Strict parser for the prose-incapable persisted evidence envelope. */
export function parseAgentSkillReplayEvidence(value: unknown): AgentSkillReplayEvidenceV1 {
  plain(value, 'skill-replay-evidence');
  exact(value, [
    'version', 'evidenceClass', 'incumbentDigest', 'candidateDigest', 'runConfigDigest',
    'evaluatorDigest', 'scenarioSetDigest', 'thresholds', 'scenarios', 'summary',
  ], 'skill-replay-evidence');
  if (value.version !== AGENT_SKILL_REPLAY_EVIDENCE_VERSION) {
    throw new TypeError('skill-replay-evidence-version-invalid');
  }
  if (value.evidenceClass !== 'fixture' && value.evidenceClass !== 'operational') {
    throw new TypeError('skill-replay-evidence-class-invalid');
  }
  const incumbentDigest = digest(value.incumbentDigest, 'incumbent-digest');
  const candidateDigest = digest(value.candidateDigest, 'candidate-digest');
  if (incumbentDigest === candidateDigest) throw new TypeError('skill-replay-variants-must-differ');
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > MAX_SCENARIOS) {
    throw new TypeError('skill-replay-scenarios-invalid');
  }
  const scenarios = value.scenarios.map(normalizeScenarioEvidence)
    .sort((left, right) => compareText(left.scenarioDigest, right.scenarioDigest));
  if (new Set(scenarios.map((scenario) => scenario.scenarioDigest)).size !== scenarios.length) {
    throw new TypeError('skill-replay-scenario-identity-duplicate');
  }
  const expectedSetDigest = scenarioSetDigest(scenarios.map((scenario) => scenario.scenarioDigest));
  const actualSetDigest = digest(value.scenarioSetDigest, 'scenario-set-digest');
  if (actualSetDigest !== expectedSetDigest) throw new TypeError('skill-replay-scenario-set-digest-mismatch');
  const thresholds = normalizeThresholds(value.thresholds);
  const expectedSummary = buildSummary(value.evidenceClass, scenarios, thresholds);
  const suppliedSummary = normalizeSummary(value.summary);
  if (JSON.stringify(suppliedSummary) !== JSON.stringify(expectedSummary)) {
    throw new TypeError('skill-replay-summary-mismatch');
  }
  return frozen({
    version: AGENT_SKILL_REPLAY_EVIDENCE_VERSION,
    evidenceClass: value.evidenceClass,
    incumbentDigest,
    candidateDigest,
    runConfigDigest: digest(value.runConfigDigest, 'run-config-digest'),
    evaluatorDigest: digest(value.evaluatorDigest, 'evaluator-digest'),
    scenarioSetDigest: actualSetDigest,
    thresholds,
    scenarios: Object.freeze(scenarios),
    summary: expectedSummary,
  });
}

/** Stable across object-key order, scenario order and reason-code order after strict normalization. */
export function agentSkillReplayEvidenceDigest(value: unknown): string {
  return sha256Json(parseAgentSkillReplayEvidence(value));
}

function normalizeScenario<TScenario>(value: unknown, index: number): AgentSkillReplayScenario<TScenario> {
  plain(value, `skill-replay-scenario[${index}]`);
  exact(value, ['scenarioId', 'scenarioDigest', 'input'], `skill-replay-scenario[${index}]`);
  return frozen({
    scenarioId: token(value.scenarioId, `skill-replay-scenario[${index}].scenarioId`),
    scenarioDigest: digest(value.scenarioDigest, `skill-replay-scenario[${index}].scenarioDigest`),
    input: value.input as TScenario,
  });
}

/**
 * Runs both immutable Skill variants over the same normalized scenario objects and the exact same
 * runConfig reference. Ports must treat those shared values as immutable. Port observations must
 * echo the bound identities, so cross-run or reordered results fail closed instead of being
 * silently compared.
 */
export async function runAgentSkillReplayComparison<TScenario, TRunConfig, TOutput>(
  input: AgentSkillReplayComparisonInput<TScenario, TRunConfig, TOutput>,
): Promise<AgentSkillReplayComparisonResult> {
  plain(input, 'skill-replay-comparison');
  exact(input, [
    'evidenceClass', 'incumbentDigest', 'candidateDigest', 'runConfig', 'scenarios',
    'thresholds', 'executor', 'evaluator',
  ], 'skill-replay-comparison');
  if (input.evidenceClass !== 'fixture' && input.evidenceClass !== 'operational') {
    throw new TypeError('skill-replay-evidence-class-invalid');
  }
  const incumbentDigest = digest(input.incumbentDigest, 'incumbent-digest');
  const candidateDigest = digest(input.candidateDigest, 'candidate-digest');
  if (incumbentDigest === candidateDigest) throw new TypeError('skill-replay-variants-must-differ');
  plain(input.runConfig, 'skill-replay-run-config');
  exact(input.runConfig, ['digest', 'value'], 'skill-replay-run-config');
  const runConfigDigest = digest(input.runConfig.digest, 'run-config-digest');
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > MAX_SCENARIOS) {
    throw new TypeError('skill-replay-scenarios-invalid');
  }
  const scenarios = input.scenarios.map((scenario, index) => normalizeScenario<TScenario>(scenario, index))
    .sort((left, right) => compareText(left.scenarioId, right.scenarioId));
  if (new Set(scenarios.map((scenario) => scenario.scenarioId)).size !== scenarios.length
    || new Set(scenarios.map((scenario) => scenario.scenarioDigest)).size !== scenarios.length) {
    throw new TypeError('skill-replay-scenario-identity-duplicate');
  }
  const thresholds = normalizeThresholds(input.thresholds);
  if (!input.executor || typeof input.executor.execute !== 'function') {
    throw new TypeError('skill-replay-executor-port-invalid');
  }
  if (!input.evaluator || typeof input.evaluator.evaluate !== 'function') {
    throw new TypeError('skill-replay-evaluator-port-invalid');
  }
  const evaluatorDigest = digest(input.evaluator.evaluatorDigest, 'evaluator-digest');
  const rows: AgentSkillReplayScenarioEvidence[] = [];
  for (const scenario of scenarios) {
    const incumbent = normalizeExecutionObservation<TOutput>(await input.executor.execute({
      variant: 'incumbent',
      bundleDigest: incumbentDigest,
      runConfigDigest,
      runConfig: input.runConfig.value,
      scenario,
    }), scenario, runConfigDigest, 'incumbent');
    const candidate = normalizeExecutionObservation<TOutput>(await input.executor.execute({
      variant: 'candidate',
      bundleDigest: candidateDigest,
      runConfigDigest,
      runConfig: input.runConfig.value,
      scenario,
    }), scenario, runConfigDigest, 'candidate');
    const domain = normalizeDomainEvaluation(await input.evaluator.evaluate({
      runConfigDigest,
      runConfig: input.runConfig.value,
      scenario,
      incumbent: {
        metrics: incumbent.metrics,
        reasonCodes: incumbent.reasonCodes,
        output: incumbent.output,
      },
      candidate: {
        metrics: candidate.metrics,
        reasonCodes: candidate.reasonCodes,
        output: candidate.output,
      },
    }), scenario, runConfigDigest);
    rows.push(frozen({
      scenarioDigest: scenario.scenarioDigest,
      incumbent: executionEvidence(incumbent),
      candidate: executionEvidence(candidate),
      domain: frozen({
        incumbentScoreBps: domain.incumbentScoreBps,
        candidateScoreBps: domain.candidateScoreBps,
        reasonCodes: domain.reasonCodes,
      }),
    }));
  }
  rows.sort((left, right) => compareText(left.scenarioDigest, right.scenarioDigest));
  const evidence = parseAgentSkillReplayEvidence({
    version: AGENT_SKILL_REPLAY_EVIDENCE_VERSION,
    evidenceClass: input.evidenceClass,
    incumbentDigest,
    candidateDigest,
    runConfigDigest,
    evaluatorDigest,
    scenarioSetDigest: scenarioSetDigest(rows.map((row) => row.scenarioDigest)),
    thresholds,
    scenarios: rows,
    summary: buildSummary(input.evidenceClass, rows, thresholds),
  });
  return frozen({ evidence, evidenceDigest: agentSkillReplayEvidenceDigest(evidence) });
}

/**
 * Fail-closed suitability assertion for lifecycle callers. This returns only the evidence digest
 * and intentionally does not import or call the skill-hub state machine.
 */
export function assertOperationalAgentSkillReplayPromotionEvidence(value: unknown): string {
  const evidence = parseAgentSkillReplayEvidence(value);
  if (evidence.evidenceClass !== 'operational') {
    throw new Error('fixture-evidence-not-promotable');
  }
  if (!evidence.summary.passed || !evidence.summary.lifecyclePromotionEligible) {
    throw new Error('operational-replay-thresholds-failed');
  }
  return agentSkillReplayEvidenceDigest(evidence);
}
