import {
  parseP14ReplayEvidence,
  p14ReplaySuiteDigest,
  type P14ReplayEvidence,
  type P14ReplayScenario,
} from './replay-evidence.ts';

export const P14_REPLAY_RUN_VERSION = 'p14-replay-run-v1' as const;
export const P14_LANE_EVAL_VERSION = 'p14-lane-eval-v1' as const;
export const P14_LANE_THRESHOLDS = Object.freeze({
  version: P14_LANE_EVAL_VERSION,
  shared: Object.freeze({ exactOutcomeRateMin: 0.95, reasonRecallRateMin: 0.95, invalidCallRateMax: 0.02 }),
  interactive: Object.freeze({ admissionPrecisionMin: 0.95, newEvidenceRateMin: 0.95,
    factualCorrectionRateMin: 0.95, criticRepairRateMin: 0.95, criticFalseEditRateMax: 0,
    p95LatencyMaxMs: 15_000 }),
  learning: Object.freeze({ attributionAccuracyMin: 0.95, selectionRateMin: 0.8,
    styleAcceptanceRateMin: 0.8, completeStyleConsistencyRateMin: 1,
    p95LatencyMaxMs: 30_000 }),
  maintenance: Object.freeze({ proposalAccuracyMin: 0.95, conflictResolutionRateMin: 0.95,
    restartRecoveryRateMin: 1, writeViolationMax: 0, contaminationMax: 0,
    p95LatencyMaxMs: 45_000 }),
});

export interface P14ReplayResult {
  readonly scenarioId: string;
  readonly reasonCodes: readonly string[];
  readonly typedOutcome: P14ReplayScenario['typedOutcome'];
  readonly metrics: P14ReplayScenario['metrics'];
}

export interface P14ReplayRun {
  readonly version: typeof P14_REPLAY_RUN_VERSION;
  readonly suiteDigest: string;
  readonly provider: P14ReplayEvidence['provider'];
  readonly results: readonly P14ReplayResult[];
}

interface SharedLaneReport {
  readonly version: typeof P14_LANE_EVAL_VERSION;
  readonly lane: 'interactive' | 'learning' | 'maintenance';
  readonly scenarioCount: number;
  readonly exactOutcomeRate: number;
  readonly reasonRecallRate: number;
  readonly invalidCallRate: number;
  readonly p95LatencyMs: number;
  readonly safetyViolations: number;
  readonly passed: boolean;
  readonly releaseEligible: boolean;
  readonly gateReason: 'passed-operational' | 'fixture-evidence-never-unlocks' | 'threshold-failed';
}

export interface InteractiveLaneReport extends SharedLaneReport {
  readonly lane: 'interactive';
  readonly admissionPrecision: number;
  readonly newEvidenceRate: number;
  readonly factualCorrectionRate: number;
  readonly criticRepairRate: number;
  readonly criticFalseEditRate: number;
}

export interface LearningLaneReport extends SharedLaneReport {
  readonly lane: 'learning';
  readonly attributionAccuracy: number;
  readonly selectionRate: number;
  readonly styleAcceptanceRate: number;
  readonly completeStyleConsistencyRate: number;
}

export interface MaintenanceLaneReport extends SharedLaneReport {
  readonly lane: 'maintenance';
  readonly proposalAccuracy: number;
  readonly conflictResolutionRate: number;
  readonly restartRecoveryRate: number;
  readonly staleWriteViolations: number;
  readonly duplicateWriteViolations: number;
  readonly beliefObjectiveContamination: number;
}

export interface P14LaneEvaluation {
  readonly version: typeof P14_LANE_EVAL_VERSION;
  readonly suiteDigest: string;
  readonly evidenceClass: P14ReplayEvidence['evidenceClass'];
  readonly interactive: InteractiveLaneReport;
  readonly learning: LearningLaneReport;
  readonly maintenance: MaintenanceLaneReport;
}

const SHA_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const OUTCOME_LANES = new Set(['interactive', 'preference', 'style', 'arc', 'npc', 'maintenance']);
const OUTCOME_STAGES = new Set(['admission', 'proposal', 'apply', 'recovery']);
const OUTCOME_VERDICTS = new Set([
  'skip', 'admit', 'deny', 'valid', 'invalid', 'shadow', 'committed',
  'stale', 'cancelled', 'deduped', 'recovered', 'failed',
]);
const METRIC_KEYS = [
  'modelCalls', 'toolCalls', 'writes', 'inputTokens', 'outputTokens',
  'latencyMs', 'costMicrousd', 'safetyViolations', 'invalidCalls',
] as const;

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}-invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}-fields-invalid`);
  }
}

function boundedInteger(value: unknown, label: string, max = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${label}-invalid`);
  }
  return value as number;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameOutcome(left: P14ReplayScenario['typedOutcome'], right: P14ReplayScenario['typedOutcome']): boolean {
  return left.lane === right.lane && left.stage === right.stage
    && left.verdict === right.verdict && left.taskKind === right.taskKind;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function shared(
  suite: P14ReplayEvidence,
  lane: SharedLaneReport['lane'],
  scenarios: readonly P14ReplayScenario[],
  results: ReadonlyMap<string, P14ReplayResult>,
  domainPassed: boolean,
): SharedLaneReport {
  const rows = scenarios.map((scenario) => ({ scenario, result: results.get(scenario.scenarioId)! }));
  const exactOutcomeRate = rate(rows.filter(({ scenario, result }) => sameOutcome(
    scenario.typedOutcome, result.typedOutcome,
  )).length, rows.length);
  const reasonRecallRate = rate(rows.filter(({ scenario, result }) => scenario.expectedReasonCodes.every(
    (reason) => result.reasonCodes.includes(reason),
  )).length, rows.length);
  const toolCalls = rows.reduce((sum, row) => sum + row.result.metrics.toolCalls, 0);
  const invalidCalls = rows.reduce((sum, row) => sum + row.result.metrics.invalidCalls, 0);
  const safetyViolations = rows.reduce((sum, row) => sum + row.result.metrics.safetyViolations, 0);
  const invalidCallRate = toolCalls === 0 ? (invalidCalls === 0 ? 0 : 1) : invalidCalls / toolCalls;
  const p95LatencyMs = p95(rows.map((row) => row.result.metrics.latencyMs));
  const passed = rows.length > 0
    && exactOutcomeRate >= P14_LANE_THRESHOLDS.shared.exactOutcomeRateMin
    && reasonRecallRate >= P14_LANE_THRESHOLDS.shared.reasonRecallRateMin
    && invalidCallRate <= P14_LANE_THRESHOLDS.shared.invalidCallRateMax
    && p95LatencyMs <= P14_LANE_THRESHOLDS[lane].p95LatencyMaxMs
    && safetyViolations === 0 && domainPassed;
  return Object.freeze({
    version: P14_LANE_EVAL_VERSION,
    lane,
    scenarioCount: rows.length,
    exactOutcomeRate,
    reasonRecallRate,
    invalidCallRate,
    p95LatencyMs,
    safetyViolations,
    passed,
    releaseEligible: passed && suite.evidenceClass === 'operational',
    gateReason: !passed ? 'threshold-failed'
      : suite.evidenceClass === 'operational' ? 'passed-operational' : 'fixture-evidence-never-unlocks',
  });
}

function label(scenario: P14ReplayScenario, value: string): boolean {
  return scenario.labels.includes(value as never);
}

function successful(result: P14ReplayResult): boolean {
  return ['admit', 'valid', 'shadow', 'committed', 'deduped', 'recovered'].includes(result.typedOutcome.verdict);
}

export function parseP14ReplayRun(suiteInput: P14ReplayEvidence, value: unknown): P14ReplayRun {
  const suite = parseP14ReplayEvidence(suiteInput);
  plain(value, 'replay-run');
  exact(value, ['version', 'suiteDigest', 'provider', 'results'], 'replay-run');
  plain(value.provider, 'replay-run-provider');
  exact(value.provider, [
    'providerIdDigest', 'modelId', 'temperatureMilli', 'maxOutputTokens',
    'budgetProfileDigest', 'toolSetDigest',
  ], 'replay-run-provider');
  if (value.version !== P14_REPLAY_RUN_VERSION || value.suiteDigest !== p14ReplaySuiteDigest(suite)
    || typeof value.suiteDigest !== 'string' || !SHA_RE.test(value.suiteDigest)
    || JSON.stringify(value.provider) !== JSON.stringify(suite.provider)
    || !Array.isArray(value.results) || value.results.length !== suite.scenarios.length) {
    throw new Error('replay-run-binding-invalid');
  }
  const expected = new Set(suite.scenarios.map((scenario) => scenario.scenarioId));
  const seen = new Set<string>();
  const results: P14ReplayResult[] = [];
  for (const raw of value.results) {
    plain(raw, 'replay-run-result');
    exact(raw, ['scenarioId', 'reasonCodes', 'typedOutcome', 'metrics'], 'replay-run-result');
    if (typeof raw.scenarioId !== 'string' || !expected.has(raw.scenarioId) || seen.has(raw.scenarioId)
      || !TOKEN_RE.test(raw.scenarioId) || !Array.isArray(raw.reasonCodes)
      || raw.reasonCodes.length > 16 || raw.reasonCodes.some((reason) => (
        typeof reason !== 'string' || !TOKEN_RE.test(reason)
      )) || new Set(raw.reasonCodes).size !== raw.reasonCodes.length) {
      throw new Error('replay-run-result-invalid');
    }
    plain(raw.typedOutcome, 'replay-run-outcome');
    exact(raw.typedOutcome, ['lane', 'stage', 'verdict', 'taskKind'], 'replay-run-outcome');
    if (typeof raw.typedOutcome.lane !== 'string' || !OUTCOME_LANES.has(raw.typedOutcome.lane)
      || typeof raw.typedOutcome.stage !== 'string' || !OUTCOME_STAGES.has(raw.typedOutcome.stage)
      || typeof raw.typedOutcome.verdict !== 'string' || !OUTCOME_VERDICTS.has(raw.typedOutcome.verdict)
      || typeof raw.typedOutcome.taskKind !== 'string' || !TOKEN_RE.test(raw.typedOutcome.taskKind)) {
      throw new Error('replay-run-outcome-invalid');
    }
    plain(raw.metrics, 'replay-run-metrics');
    const rawMetrics = raw.metrics;
    exact(rawMetrics, METRIC_KEYS, 'replay-run-metrics');
    const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [
      key,
      boundedInteger(rawMetrics[key], `replay-run-${key}`, key === 'latencyMs' ? 86_400_000 : undefined),
    ])) as unknown as P14ReplayScenario['metrics'];
    seen.add(raw.scenarioId);
    results.push(Object.freeze({
      scenarioId: raw.scenarioId,
      reasonCodes: Object.freeze([...raw.reasonCodes] as string[]),
      typedOutcome: Object.freeze({ ...raw.typedOutcome }) as P14ReplayScenario['typedOutcome'],
      metrics: Object.freeze(metrics),
    }));
  }
  return Object.freeze({
    version: P14_REPLAY_RUN_VERSION,
    suiteDigest: value.suiteDigest,
    provider: suite.provider,
    results: Object.freeze(results),
  });
}

function validateRun(suite: P14ReplayEvidence, input: P14ReplayRun): ReadonlyMap<string, P14ReplayResult> {
  const run = parseP14ReplayRun(suite, input);
  return new Map(run.results.map((result) => [result.scenarioId, result]));
}

export function buildFixtureReplayRun(input: P14ReplayEvidence): P14ReplayRun {
  const suite = parseP14ReplayEvidence(input);
  return Object.freeze({
    version: P14_REPLAY_RUN_VERSION,
    suiteDigest: p14ReplaySuiteDigest(suite),
    provider: suite.provider,
    results: Object.freeze(suite.scenarios.map((scenario) => Object.freeze({
      scenarioId: scenario.scenarioId,
      reasonCodes: scenario.expectedReasonCodes,
      typedOutcome: scenario.typedOutcome,
      metrics: scenario.metrics,
    }))),
  });
}

export function evaluateP14Lanes(input: P14ReplayEvidence, run: P14ReplayRun): P14LaneEvaluation {
  const suite = parseP14ReplayEvidence(input);
  const results = validateRun(suite, run);
  const interactiveScenarios = suite.scenarios.filter((scenario) => scenario.typedOutcome.lane === 'interactive');
  const learningScenarios = suite.scenarios.filter((scenario) => ['preference', 'style'].includes(
    scenario.typedOutcome.lane,
  ));
  const maintenanceScenarios = suite.scenarios.filter((scenario) => ['arc', 'npc', 'maintenance'].includes(
    scenario.typedOutcome.lane,
  ));

  const interactiveRows = interactiveScenarios.map((scenario) => ({ scenario, result: results.get(scenario.scenarioId)! }));
  const admittedExpected = interactiveRows.filter(({ scenario }) => ['admit', 'valid'].includes(scenario.typedOutcome.verdict));
  const admittedActual = interactiveRows.filter(({ result }) => ['admit', 'valid'].includes(result.typedOutcome.verdict));
  const admissionPrecision = rate(admittedActual.filter(({ scenario, result }) => sameOutcome(
    scenario.typedOutcome, result.typedOutcome,
  )).length, admittedActual.length);
  const evidenceRows = interactiveRows.filter(({ scenario }) => label(scenario, 'distant-fact') || label(scenario, 'worldbook-conflict'));
  const newEvidenceRate = rate(evidenceRows.filter(({ result }) => result.metrics.toolCalls > 0 && successful(result)).length, evidenceRows.length);
  const factualCorrectionRate = rate(evidenceRows.filter(({ result }) => successful(result)).length, evidenceRows.length);
  const repairRows = interactiveRows.filter(({ scenario }) => label(scenario, 'critic-repairable'));
  const criticRepairRate = rate(repairRows.filter(({ result }) => successful(result)).length, repairRows.length);
  const noRepairRows = interactiveRows.filter(({ scenario }) => label(scenario, 'critic-unrepairable'));
  const criticFalseEditRate = rate(noRepairRows.filter(({ result }) => successful(result)).length, noRepairRows.length);
  const interactiveDomainPassed = admittedExpected.length > 0
    && admissionPrecision >= P14_LANE_THRESHOLDS.interactive.admissionPrecisionMin
    && newEvidenceRate >= P14_LANE_THRESHOLDS.interactive.newEvidenceRateMin
    && factualCorrectionRate >= P14_LANE_THRESHOLDS.interactive.factualCorrectionRateMin
    && criticRepairRate >= P14_LANE_THRESHOLDS.interactive.criticRepairRateMin
    && criticFalseEditRate <= P14_LANE_THRESHOLDS.interactive.criticFalseEditRateMax;
  const interactive = Object.freeze({
    ...shared(suite, 'interactive', interactiveScenarios, results, interactiveDomainPassed),
    lane: 'interactive' as const,
    admissionPrecision, newEvidenceRate, factualCorrectionRate, criticRepairRate, criticFalseEditRate,
  });

  const learningRows = learningScenarios.map((scenario) => ({ scenario, result: results.get(scenario.scenarioId)! }));
  const attributionRows = learningRows.filter(({ scenario }) => label(scenario, 'initial-preference') || label(scenario, 'edited-branch'));
  const attributionAccuracy = rate(attributionRows.filter(({ scenario, result }) => sameOutcome(
    scenario.typedOutcome, result.typedOutcome,
  )).length, attributionRows.length);
  const selectionRate = rate(attributionRows.filter(({ result }) => successful(result)).length, attributionRows.length);
  const styleRows = learningRows.filter(({ scenario }) => label(scenario, 'style-compile'));
  const styleAcceptanceRate = rate(styleRows.filter(({ result }) => successful(result)).length, styleRows.length);
  const completeStyleConsistencyRate = rate(styleRows.filter(({ result }) => result.metrics.safetyViolations === 0
    && result.reasonCodes.includes('style-evidence-threshold')).length, styleRows.length);
  const learningDomainPassed = attributionAccuracy >= P14_LANE_THRESHOLDS.learning.attributionAccuracyMin
    && selectionRate >= P14_LANE_THRESHOLDS.learning.selectionRateMin
    && styleAcceptanceRate >= P14_LANE_THRESHOLDS.learning.styleAcceptanceRateMin
    && completeStyleConsistencyRate >= P14_LANE_THRESHOLDS.learning.completeStyleConsistencyRateMin;
  const learning = Object.freeze({
    ...shared(suite, 'learning', learningScenarios, results, learningDomainPassed),
    lane: 'learning' as const,
    attributionAccuracy, selectionRate, styleAcceptanceRate, completeStyleConsistencyRate,
  });

  const maintenanceRows = maintenanceScenarios.map((scenario) => ({ scenario, result: results.get(scenario.scenarioId)! }));
  const proposalRows = maintenanceRows.filter(({ scenario }) => scenario.typedOutcome.stage === 'proposal');
  const proposalAccuracy = rate(proposalRows.filter(({ scenario, result }) => sameOutcome(
    scenario.typedOutcome, result.typedOutcome,
  )).length, proposalRows.length);
  const conflictRows = maintenanceRows.filter(({ scenario }) => label(scenario, 'multi-arc-conflict'));
  const conflictResolutionRate = rate(conflictRows.filter(({ result }) => successful(result)).length, conflictRows.length);
  const restartRows = maintenanceRows.filter(({ scenario }) => label(scenario, 'restart'));
  const restartRecoveryRate = rate(restartRows.filter(({ result }) => result.typedOutcome.verdict === 'recovered').length, restartRows.length);
  const staleWriteViolations = maintenanceRows.filter(({ scenario, result }) => label(scenario, 'stale') && result.metrics.writes > 0).length;
  const duplicateWriteViolations = maintenanceRows.filter(({ scenario, result }) => label(scenario, 'duplicate') && result.metrics.writes > 0).length;
  const beliefObjectiveContamination = maintenanceRows.filter(({ scenario, result }) => (
    label(scenario, 'npc-belief') || label(scenario, 'npc-objective')
  ) && result.metrics.safetyViolations > 0).length;
  const maintenanceDomainPassed = proposalAccuracy >= P14_LANE_THRESHOLDS.maintenance.proposalAccuracyMin
    && conflictResolutionRate >= P14_LANE_THRESHOLDS.maintenance.conflictResolutionRateMin
    && restartRecoveryRate >= P14_LANE_THRESHOLDS.maintenance.restartRecoveryRateMin
    && staleWriteViolations <= P14_LANE_THRESHOLDS.maintenance.writeViolationMax
    && duplicateWriteViolations <= P14_LANE_THRESHOLDS.maintenance.writeViolationMax
    && beliefObjectiveContamination <= P14_LANE_THRESHOLDS.maintenance.contaminationMax;
  const maintenance = Object.freeze({
    ...shared(suite, 'maintenance', maintenanceScenarios, results, maintenanceDomainPassed),
    lane: 'maintenance' as const,
    proposalAccuracy, conflictResolutionRate, restartRecoveryRate,
    staleWriteViolations, duplicateWriteViolations, beliefObjectiveContamination,
  });

  return Object.freeze({
    version: P14_LANE_EVAL_VERSION,
    suiteDigest: p14ReplaySuiteDigest(suite),
    evidenceClass: suite.evidenceClass,
    interactive,
    learning,
    maintenance,
  });
}
