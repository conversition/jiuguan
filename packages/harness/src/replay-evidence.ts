import { createHash } from 'node:crypto';

export const P14_REPLAY_VERSION = 'p14-replay-evidence-v1' as const;
export const P14_REPLAY_LABELS = Object.freeze([
  'ordinary-no-agent', 'distant-fact', 'worldbook-conflict', 'multi-arc-conflict',
  'npc-objective', 'npc-belief', 'npc-knowledge', 'player-sovereignty',
  'initial-preference', 'edited-branch', 'style-compile', 'critic-repairable',
  'critic-unrepairable', 'stale', 'cancel', 'duplicate', 'restart',
] as const);
export type P14ReplayLabel = (typeof P14_REPLAY_LABELS)[number];

const LANES = ['interactive', 'preference', 'style', 'arc', 'npc', 'maintenance'] as const;
const STAGES = ['admission', 'proposal', 'apply', 'recovery'] as const;
const VERDICTS = [
  'skip', 'admit', 'deny', 'valid', 'invalid', 'shadow', 'committed',
  'stale', 'cancelled', 'deduped', 'recovered', 'failed',
] as const;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SHA_RE = /^sha256:[a-f0-9]{64}$/u;

export interface P14ReplayScenario {
  readonly scenarioId: string;
  readonly sourceDigest: string;
  readonly sourceRevision: string;
  readonly labels: readonly P14ReplayLabel[];
  readonly expectedReasonCodes: readonly string[];
  readonly typedOutcome: Readonly<{
    lane: (typeof LANES)[number];
    stage: (typeof STAGES)[number];
    verdict: (typeof VERDICTS)[number];
    taskKind: string;
  }>;
  readonly metrics: Readonly<{
    modelCalls: number;
    toolCalls: number;
    writes: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costMicrousd: number;
    safetyViolations: number;
    invalidCalls: number;
  }>;
}

export interface P14ReplayEvidence {
  readonly version: typeof P14_REPLAY_VERSION;
  readonly suiteId: string;
  readonly evidenceClass: 'fixture' | 'operational';
  readonly sourceArtifactDigest: string;
  readonly capturedAt: string;
  readonly provider: Readonly<{
    providerIdDigest: string;
    modelId: string;
    temperatureMilli: number;
    maxOutputTokens: number;
    budgetProfileDigest: string;
    toolSetDigest: string;
  }>;
  readonly scenarios: readonly P14ReplayScenario[];
}

export interface P14ReplaySummary {
  readonly suiteDigest: string;
  readonly evidenceClass: P14ReplayEvidence['evidenceClass'];
  readonly scenarioCount: number;
  readonly byLane: Readonly<Record<string, number>>;
  readonly byVerdict: Readonly<Record<string, number>>;
  readonly totals: Readonly<P14ReplayScenario['metrics']>;
}

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}-invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}-invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}-fields-invalid`);
  }
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

function count(value: unknown, label: string, max = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${label}-invalid`);
  }
  return value as number;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value as T[number];
}

function tokens(value: unknown, label: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}-invalid`);
  const parsed = value.map((entry) => token(entry, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label}-duplicate`);
  return Object.freeze(parsed);
}

function parseScenario(value: unknown): P14ReplayScenario {
  plain(value, 'replay-scenario');
  exact(value, [
    'scenarioId', 'sourceDigest', 'sourceRevision', 'labels', 'expectedReasonCodes',
    'typedOutcome', 'metrics',
  ], 'replay-scenario');
  const labels = tokens(value.labels, 'replay-label', P14_REPLAY_LABELS.length)
    .map((entry) => enumValue(entry, P14_REPLAY_LABELS, 'replay-label'));
  if (labels.length < 1) throw new Error('replay-label-empty');
  plain(value.typedOutcome, 'replay-outcome');
  exact(value.typedOutcome, ['lane', 'stage', 'verdict', 'taskKind'], 'replay-outcome');
  plain(value.metrics, 'replay-metrics');
  exact(value.metrics, [
    'modelCalls', 'toolCalls', 'writes', 'inputTokens', 'outputTokens',
    'latencyMs', 'costMicrousd', 'safetyViolations', 'invalidCalls',
  ], 'replay-metrics');
  return Object.freeze({
    scenarioId: token(value.scenarioId, 'scenario-id'),
    sourceDigest: digest(value.sourceDigest, 'source-digest'),
    sourceRevision: token(value.sourceRevision, 'source-revision'),
    labels: Object.freeze(labels),
    expectedReasonCodes: tokens(value.expectedReasonCodes, 'reason-code', 16),
    typedOutcome: Object.freeze({
      lane: enumValue(value.typedOutcome.lane, LANES, 'outcome-lane'),
      stage: enumValue(value.typedOutcome.stage, STAGES, 'outcome-stage'),
      verdict: enumValue(value.typedOutcome.verdict, VERDICTS, 'outcome-verdict'),
      taskKind: token(value.typedOutcome.taskKind, 'outcome-task'),
    }),
    metrics: Object.freeze({
      modelCalls: count(value.metrics.modelCalls, 'model-calls', 64),
      toolCalls: count(value.metrics.toolCalls, 'tool-calls', 256),
      writes: count(value.metrics.writes, 'writes', 256),
      inputTokens: count(value.metrics.inputTokens, 'input-tokens'),
      outputTokens: count(value.metrics.outputTokens, 'output-tokens'),
      latencyMs: count(value.metrics.latencyMs, 'latency-ms', 86_400_000),
      costMicrousd: count(value.metrics.costMicrousd, 'cost-microusd'),
      safetyViolations: count(value.metrics.safetyViolations, 'safety-violations', 1_000),
      invalidCalls: count(value.metrics.invalidCalls, 'invalid-calls', 1_000),
    }),
  });
}

/** Strict, prose-incapable replay envelope shared by all Q9 evaluators. */
export function parseP14ReplayEvidence(value: unknown): P14ReplayEvidence {
  plain(value, 'replay-evidence');
  exact(value, [
    'version', 'suiteId', 'evidenceClass', 'sourceArtifactDigest', 'capturedAt', 'provider', 'scenarios',
  ], 'replay-evidence');
  if (value.version !== P14_REPLAY_VERSION) throw new Error('replay-version-invalid');
  if (value.evidenceClass !== 'fixture' && value.evidenceClass !== 'operational') {
    throw new Error('replay-evidence-class-invalid');
  }
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))
    || new Date(value.capturedAt).toISOString() !== value.capturedAt) {
    throw new Error('replay-captured-at-invalid');
  }
  plain(value.provider, 'replay-provider');
  exact(value.provider, [
    'providerIdDigest', 'modelId', 'temperatureMilli', 'maxOutputTokens',
    'budgetProfileDigest', 'toolSetDigest',
  ], 'replay-provider');
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 30 || value.scenarios.length > 50) {
    throw new Error('replay-scenario-count-invalid');
  }
  const scenarios = value.scenarios.map(parseScenario);
  if (new Set(scenarios.map((entry) => entry.scenarioId)).size !== scenarios.length
    || new Set(scenarios.map((entry) => entry.sourceDigest)).size !== scenarios.length) {
    throw new Error('replay-scenario-identity-duplicate');
  }
  const covered = new Set(scenarios.flatMap((entry) => entry.labels));
  if (P14_REPLAY_LABELS.some((label) => !covered.has(label))) throw new Error('replay-coverage-incomplete');
  return Object.freeze({
    version: P14_REPLAY_VERSION,
    suiteId: token(value.suiteId, 'suite-id'),
    evidenceClass: value.evidenceClass,
    sourceArtifactDigest: digest(value.sourceArtifactDigest, 'source-artifact-digest'),
    capturedAt: value.capturedAt,
    provider: Object.freeze({
      providerIdDigest: digest(value.provider.providerIdDigest, 'provider-id-digest'),
      modelId: token(value.provider.modelId, 'model-id'),
      temperatureMilli: count(value.provider.temperatureMilli, 'temperature-milli', 2_000),
      maxOutputTokens: count(value.provider.maxOutputTokens, 'max-output-tokens', 1_000_000),
      budgetProfileDigest: digest(value.provider.budgetProfileDigest, 'budget-profile-digest'),
      toolSetDigest: digest(value.provider.toolSetDigest, 'tool-set-digest'),
    }),
    scenarios: Object.freeze(scenarios),
  });
}

export function p14ReplaySuiteDigest(input: P14ReplayEvidence): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parseP14ReplayEvidence(input)), 'utf8').digest('hex')}`;
}

export function summarizeP14ReplayEvidence(input: P14ReplayEvidence): P14ReplaySummary {
  const suite = parseP14ReplayEvidence(input);
  const byLane: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  const totals = {
    modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0,
    latencyMs: 0, costMicrousd: 0, safetyViolations: 0, invalidCalls: 0,
  };
  for (const scenario of suite.scenarios) {
    byLane[scenario.typedOutcome.lane] = (byLane[scenario.typedOutcome.lane] ?? 0) + 1;
    byVerdict[scenario.typedOutcome.verdict] = (byVerdict[scenario.typedOutcome.verdict] ?? 0) + 1;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += scenario.metrics[key];
  }
  return Object.freeze({
    suiteDigest: p14ReplaySuiteDigest(suite),
    evidenceClass: suite.evidenceClass,
    scenarioCount: suite.scenarios.length,
    byLane: Object.freeze(byLane),
    byVerdict: Object.freeze(byVerdict),
    totals: Object.freeze(totals),
  });
}
