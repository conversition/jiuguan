import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION,
  P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID,
} from '../../packages/operational-replay-contract/index.ts';

const EVIDENCE_DIRECTORY = 'p14-evidence';
const BINDING_FILE = 'binding.json';
const LANES = Object.freeze(['interactive', 'learning', 'maintenance'] as const);
const LANE_SET = new Set<string>(LANES);
const DIGEST_DIRECTORY_RE = /^[a-f0-9]{64}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const BOUND_SESSION_RE = /^session-[0-9]{6,24}$/u;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]+$/u;
const SOURCE_REPLAY_DIRECTORY_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T)([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{3})Z$/u;
const MAX_BINDING_BYTES = 16 * 1024;
const MAX_SOURCE_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SOURCE_REPLAY_FILES = Object.freeze([
  'binding.json',
  'bridge-accounting.json',
  'evaluation.json',
  'run.json',
  'suite.json',
] as const);
const SOURCE_REPLAY_VERSION = 'p14-replay-evidence-v1';
const SOURCE_RUN_VERSION = 'p14-replay-run-v1';
const SOURCE_EVALUATION_VERSION = 'p14-lane-eval-v1';
const SOURCE_TARGET_CASES = 8;
const SOURCE_TARGET_TASKS = new Map<string, 'npc_state' | 'branch_index'>([
  ['q9-09-npc-objective-v1', 'npc_state'],
  ['q9-10-npc-objective-v2', 'npc_state'],
  ['q9-11-npc-belief-v1', 'npc_state'],
  ['q9-12-npc-belief-v2', 'npc_state'],
  ['q9-13-npc-knowledge-v1', 'npc_state'],
  ['q9-14-npc-knowledge-v2', 'npc_state'],
  ['q9-07-multi-arc-conflict-v1', 'branch_index'],
  ['q9-08-multi-arc-conflict-v2', 'branch_index'],
]);
const SOURCE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SOURCE_METRIC_KEYS = Object.freeze([
  'modelCalls', 'toolCalls', 'writes', 'inputTokens', 'outputTokens',
  'latencyMs', 'costMicrousd', 'safetyViolations', 'invalidCalls',
] as const);
const SOURCE_SHARED_LANE_REPORT_KEYS = Object.freeze([
  'version', 'lane', 'scenarioCount', 'exactOutcomeRate', 'reasonRecallRate',
  'invalidCallRate', 'p95LatencyMs', 'safetyViolations', 'passed',
  'releaseEligible', 'gateReason',
] as const);
const SOURCE_INTERACTIVE_REPORT_KEYS = Object.freeze([
  'admissionPrecision', 'newEvidenceRate', 'factualCorrectionRate',
  'criticRepairRate', 'criticFalseEditRate',
] as const);
const SOURCE_LEARNING_REPORT_KEYS = Object.freeze([
  'attributionAccuracy', 'selectionRate', 'styleAcceptanceRate',
  'completeStyleConsistencyRate',
] as const);
const SOURCE_MAINTENANCE_REPORT_KEYS = Object.freeze([
  'proposalAccuracy', 'conflictResolutionRate', 'restartRecoveryRate',
  'staleWriteViolations', 'duplicateWriteViolations', 'beliefObjectiveContamination',
] as const);

type EvidenceLane = typeof LANES[number];
type BindingVersion =
  | 'p14-operational-evidence-binding-v1'
  | 'p14-maintenance-canary-binding-v1'
  | 'p14-maintenance-canary-binding-v2';

interface EvidenceBinding {
  readonly version: BindingVersion;
  readonly lane: EvidenceLane;
  readonly sessionId: string;
  readonly suiteDigest: string;
}

interface MaintenanceSourceBinding extends EvidenceBinding {
  readonly version: 'p14-operational-evidence-binding-v1';
  readonly lane: 'maintenance';
  readonly accountingDigest: string;
}

interface PathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface TreeEntry {
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
  readonly identity: PathIdentity;
  readonly bindingText?: string;
}

interface PlannedEvidenceDirectory {
  readonly path: string;
  readonly relativePath: string;
  readonly identity: PathIdentity;
  readonly entries: readonly TreeEntry[];
  readonly binding: EvidenceBinding;
}

interface EvidencePlan {
  readonly root: string;
  readonly rootIdentity: PathIdentity;
  readonly tree: readonly TreeEntry[];
  readonly directories: readonly PlannedEvidenceDirectory[];
}

export type P14EvidenceCleanupErrorCode =
  | 'p14-evidence-cleanup-input-invalid'
  | 'p14-evidence-cleanup-unsafe-layout'
  | 'p14-evidence-cleanup-binding-invalid'
  | 'p14-evidence-cleanup-ambiguous-layout'
  | 'p14-evidence-cleanup-io';

export class P14EvidenceCleanupError extends Error {
  readonly name = 'P14EvidenceCleanupError';

  constructor(readonly code: P14EvidenceCleanupErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface P14EvidenceCleanupInput {
  readonly dataDir: string;
  readonly sessionId: string;
  /** @internal Deterministic seam proving that ownership changes abort before deletion. */
  readonly injectBeforeApply?: () => void;
}

export interface P14EvidenceCleanupResult {
  readonly sessionId: string;
  readonly scannedBindings: number;
  readonly removedEvidenceDirectories: readonly Readonly<{
    lane: EvidenceLane;
    suiteDigest: string;
    bindingVersion: BindingVersion;
  }>[];
}

function fail(code: P14EvidenceCleanupErrorCode, cause?: unknown): P14EvidenceCleanupError {
  return new P14EvidenceCleanupError(code, cause === undefined ? undefined : { cause });
}

function identity(stats: Stats): PathIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function safeOpaqueId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && OPAQUE_ID_RE.test(value);
}

/** Strict mirror of the two immutable binding writers; no best-effort legacy inference. */
function parseBinding(value: unknown): EvidenceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  const lane = record.lane;
  const sessionId = record.sessionId;
  const suiteDigest = record.suiteDigest;
  if ((version !== 'p14-operational-evidence-binding-v1'
      && version !== 'p14-maintenance-canary-binding-v1'
      && version !== 'p14-maintenance-canary-binding-v2')
    || typeof lane !== 'string' || !LANE_SET.has(lane)
    || typeof sessionId !== 'string' || !BOUND_SESSION_RE.test(sessionId)
    || typeof suiteDigest !== 'string' || !SHA256_RE.test(suiteDigest)
    || record.evidenceClass !== 'operational') {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }

  if (version === 'p14-maintenance-canary-binding-v1') {
    if (lane !== 'maintenance' || !exactKeys(record, [
      'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass',
    ])) throw fail('p14-evidence-cleanup-binding-invalid');
  } else if (version === 'p14-maintenance-canary-binding-v2') {
    if (lane !== 'maintenance' || !exactKeys(record, [
      'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass', 'accountingDigest',
    ]) || typeof record.accountingDigest !== 'string'
      || !SHA256_RE.test(record.accountingDigest)) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
  } else {
    const hasAccountingDigest = Object.hasOwn(record, 'accountingDigest');
    if (!exactKeys(record, [
      'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass', 'activated',
      ...(hasAccountingDigest ? ['accountingDigest'] : []),
    ]) || record.activated !== false
      || (hasAccountingDigest && (lane !== 'maintenance'
        || typeof record.accountingDigest !== 'string'
        || !SHA256_RE.test(record.accountingDigest)))) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
  }

  return Object.freeze({
    version,
    lane: lane as EvidenceLane,
    sessionId,
    suiteDigest,
  });
}

function parseMaintenanceSourceBinding(value: unknown): MaintenanceSourceBinding {
  const binding = parseBinding(value);
  const record = value as Record<string, unknown>;
  if (binding.version !== 'p14-operational-evidence-binding-v1'
    || binding.lane !== 'maintenance'
    || !exactKeys(record, [
      'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass',
      'accountingDigest', 'activated',
    ])
    || typeof record.accountingDigest !== 'string'
    || !SHA256_RE.test(record.accountingDigest)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return Object.freeze({
    ...binding,
    version: 'p14-operational-evidence-binding-v1',
    lane: 'maintenance',
    accountingDigest: record.accountingDigest,
  });
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw fail('p14-evidence-cleanup-unsafe-layout');
  }
}

function assertNoSymlinkAncestors(pathValue: string): void {
  const path = resolve(pathValue);
  const filesystemRoot = parse(path).root;
  let current = filesystemRoot;
  const rootStats = lstatSync(filesystemRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw fail('p14-evidence-cleanup-unsafe-layout');
  }
  for (const segment of relative(filesystemRoot, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw fail('p14-evidence-cleanup-unsafe-layout');
    }
  }
}

function inspectTree(root: string): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      assertContained(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw fail('p14-evidence-cleanup-unsafe-layout');
      const relativePath = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (stats.isDirectory()) {
        entries.push(Object.freeze({
          relativePath,
          kind: 'directory' as const,
          identity: identity(stats),
        }));
        visit(path, relativePath);
        continue;
      }
      if (!stats.isFile()) throw fail('p14-evidence-cleanup-unsafe-layout');
      let bindingText: string | undefined;
      if (entry.name === BINDING_FILE) {
        if (stats.size < 2 || stats.size > MAX_BINDING_BYTES) {
          throw fail('p14-evidence-cleanup-binding-invalid');
        }
        bindingText = readFileSync(path, 'utf8');
      }
      entries.push(Object.freeze({
        relativePath,
        kind: 'file' as const,
        identity: identity(stats),
        ...(bindingText === undefined ? {} : { bindingText }),
      }));
    }
  };
  visit(root, '');
  return Object.freeze(entries);
}

function sameEntry(left: TreeEntry, right: TreeEntry): boolean {
  return left.relativePath === right.relativePath && left.kind === right.kind
    && sameIdentity(left.identity, right.identity)
    && left.bindingText === right.bindingText;
}

function isDefaultSourceReplayDirectoryName(value: string): boolean {
  const match = SOURCE_REPLAY_DIRECTORY_RE.exec(value);
  if (!match) return false;
  const iso = `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso;
}

function readSourceJson(root: string, entry: TreeEntry): unknown {
  if (entry.kind !== 'file' || entry.identity.size < 2
    || entry.identity.size > MAX_SOURCE_EVIDENCE_BYTES) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  try {
    return JSON.parse(readFileSync(join(root, ...entry.relativePath.split('/')), 'utf8')) as unknown;
  } catch (error) {
    throw fail('p14-evidence-cleanup-binding-invalid', error);
  }
}

interface ParsedSourceSuite {
  readonly value: Readonly<Record<string, unknown>>;
  readonly suiteDigest: string;
  readonly sourceArtifactDigest: string;
  readonly toolSetDigest: string;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly scenarios: ReadonlyMap<string, Readonly<{
    sourceDigest: string;
    taskKind: string;
    evaluationLane: 'interactive' | 'learning' | 'maintenance';
  }>>;
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return value as Record<string, unknown>;
}

function sourceToken(value: unknown): string {
  if (typeof value !== 'string' || !SOURCE_TOKEN_RE.test(value)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return value;
}

function sourceDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return value;
}

function sourceCount(value: unknown, maximum = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return Number(value);
}

function sourceRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return value;
}

function sourceEvaluationLane(
  value: unknown,
): 'interactive' | 'learning' | 'maintenance' {
  const lane = sourceToken(value);
  if (lane === 'interactive') return lane;
  if (lane === 'preference' || lane === 'style') return 'learning';
  if (lane === 'arc' || lane === 'npc' || lane === 'maintenance') return 'maintenance';
  throw fail('p14-evidence-cleanup-binding-invalid');
}

function validateSourceMetrics(value: unknown): void {
  const record = sourceRecord(value);
  if (!exactKeys(record, SOURCE_METRIC_KEYS)) throw fail('p14-evidence-cleanup-binding-invalid');
  for (const key of SOURCE_METRIC_KEYS) {
    sourceCount(record[key], key === 'latencyMs' ? 86_400_000 : 1_000_000_000);
  }
}

function sourceCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sourceCanonical).join(',')}]`;
  const record = sourceRecord(value);
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${sourceCanonical(record[key])}`
  )).join(',')}}`;
}

function sourceCanonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(sourceCanonical(value), 'utf8').digest('hex')}`;
}

function parseSourceSuite(value: unknown): ParsedSourceSuite {
  const record = sourceRecord(value);
  if (!exactKeys(record, [
    'version', 'suiteId', 'evidenceClass', 'sourceArtifactDigest', 'capturedAt', 'provider', 'scenarios',
  ]) || record.version !== SOURCE_REPLAY_VERSION
    || record.suiteId !== P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID
    || record.evidenceClass !== 'operational'
    || typeof record.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(record.capturedAt))
    || new Date(record.capturedAt).toISOString() !== record.capturedAt) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const providerRecord = sourceRecord(record.provider);
  if (!exactKeys(providerRecord, [
    'providerIdDigest', 'modelId', 'temperatureMilli', 'maxOutputTokens',
    'budgetProfileDigest', 'toolSetDigest',
  ])) throw fail('p14-evidence-cleanup-binding-invalid');
  sourceDigest(providerRecord.providerIdDigest);
  sourceToken(providerRecord.modelId);
  sourceCount(providerRecord.temperatureMilli, 2_000);
  sourceCount(providerRecord.maxOutputTokens, 1_000_000);
  sourceDigest(providerRecord.budgetProfileDigest);
  const toolSetDigest = sourceDigest(providerRecord.toolSetDigest);
  if (!Array.isArray(record.scenarios)
    || record.scenarios.length < 30 || record.scenarios.length > 50) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const scenarioMap = new Map<string, {
    sourceDigest: string;
    taskKind: string;
    evaluationLane: 'interactive' | 'learning' | 'maintenance';
  }>();
  const sourceDigests = new Set<string>();
  for (const raw of record.scenarios) {
    const scenario = sourceRecord(raw);
    if (!exactKeys(scenario, [
      'scenarioId', 'sourceDigest', 'sourceRevision', 'labels', 'expectedReasonCodes',
      'typedOutcome', 'metrics',
    ])) throw fail('p14-evidence-cleanup-binding-invalid');
    const scenarioId = sourceToken(scenario.scenarioId);
    if (scenarioMap.has(scenarioId)) throw fail('p14-evidence-cleanup-binding-invalid');
    const digest = sourceDigest(scenario.sourceDigest);
    if (sourceDigests.has(digest)) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    sourceDigests.add(digest);
    sourceToken(scenario.sourceRevision);
    if (!Array.isArray(scenario.labels) || scenario.labels.length === 0
      || scenario.labels.some((label) => typeof label !== 'string')
      || !Array.isArray(scenario.expectedReasonCodes)
      || scenario.expectedReasonCodes.some((reason) => typeof reason !== 'string')) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const outcome = sourceRecord(scenario.typedOutcome);
    if (!exactKeys(outcome, ['lane', 'stage', 'verdict', 'taskKind'])) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const evaluationLane = sourceEvaluationLane(outcome.lane);
    sourceToken(outcome.stage);
    sourceToken(outcome.verdict);
    const taskKind = sourceToken(outcome.taskKind);
    validateSourceMetrics(scenario.metrics);
    scenarioMap.set(scenarioId, Object.freeze({
      sourceDigest: digest,
      taskKind,
      evaluationLane,
    }));
  }
  if ([...SOURCE_TARGET_TASKS].some(([scenarioId, taskKind]) => (
    scenarioMap.get(scenarioId)?.taskKind !== taskKind
  ))) throw fail('p14-evidence-cleanup-binding-invalid');
  const sourceArtifactDigest = sourceDigest(record.sourceArtifactDigest);
  return Object.freeze({
    value: record,
    suiteDigest: `sha256:${createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex')}`,
    sourceArtifactDigest,
    toolSetDigest,
    provider: providerRecord,
    scenarios: scenarioMap,
  });
}

function parseSourceRun(value: unknown, suite: ParsedSourceSuite): Readonly<Record<string, unknown>> {
  const record = sourceRecord(value);
  if (!exactKeys(record, ['version', 'suiteDigest', 'provider', 'results'])
    || record.version !== SOURCE_RUN_VERSION || record.suiteDigest !== suite.suiteDigest
    || !isDeepStrictEqual(record.provider, suite.provider)
    || !Array.isArray(record.results) || record.results.length !== suite.scenarios.size) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const resultIds = new Set<string>();
  for (const raw of record.results) {
    const result = sourceRecord(raw);
    if (!exactKeys(result, ['scenarioId', 'reasonCodes', 'typedOutcome', 'metrics'])) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const scenarioId = sourceToken(result.scenarioId);
    if (!suite.scenarios.has(scenarioId) || resultIds.has(scenarioId)
      || !Array.isArray(result.reasonCodes)) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const outcome = sourceRecord(result.typedOutcome);
    if (!exactKeys(outcome, ['lane', 'stage', 'verdict', 'taskKind'])) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    validateSourceMetrics(result.metrics);
    resultIds.add(scenarioId);
  }
  return record;
}

function validateSourceEvaluation(
  value: unknown,
  suite: ParsedSourceSuite,
  run: Readonly<Record<string, unknown>>,
): void {
  const record = sourceRecord(value);
  if (!exactKeys(record, [
    'version', 'suiteDigest', 'evidenceClass', 'interactive', 'learning', 'maintenance',
  ]) || record.version !== SOURCE_EVALUATION_VERSION || record.suiteDigest !== suite.suiteDigest
    || record.evidenceClass !== 'operational') {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  for (const lane of ['interactive', 'learning', 'maintenance'] as const) {
    const report = sourceRecord(record[lane]);
    const laneKeys = lane === 'interactive'
      ? SOURCE_INTERACTIVE_REPORT_KEYS
      : lane === 'learning'
        ? SOURCE_LEARNING_REPORT_KEYS
        : SOURCE_MAINTENANCE_REPORT_KEYS;
    if (!exactKeys(report, [...SOURCE_SHARED_LANE_REPORT_KEYS, ...laneKeys])
      || report.version !== SOURCE_EVALUATION_VERSION || report.lane !== lane
      || typeof report.passed !== 'boolean'
      || typeof report.releaseEligible !== 'boolean'
      || !['passed-operational', 'fixture-evidence-never-unlocks', 'threshold-failed']
        .includes(String(report.gateReason))) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    sourceCount(report.scenarioCount, suite.scenarios.size);
    sourceRate(report.exactOutcomeRate);
    sourceRate(report.reasonRecallRate);
    sourceRate(report.invalidCallRate);
    sourceCount(report.p95LatencyMs, 86_400_000);
    sourceCount(report.safetyViolations);
    for (const key of laneKeys) {
      if (lane === 'maintenance' && [
        'staleWriteViolations', 'duplicateWriteViolations', 'beliefObjectiveContamination',
      ].includes(key)) {
        sourceCount(report[key]);
      } else {
        sourceRate(report[key]);
      }
    }
  }
  const maintenance = sourceRecord(record.maintenance);
  const maintenanceScenarioIds = new Set(
    [...suite.scenarios].filter(([, scenario]) => scenario.evaluationLane === 'maintenance')
      .map(([scenarioId]) => scenarioId),
  );
  let maintenanceSafetyViolations = 0;
  for (const raw of run.results as readonly unknown[]) {
    const result = sourceRecord(raw);
    if (maintenanceScenarioIds.has(String(result.scenarioId))) {
      maintenanceSafetyViolations += sourceCount(
        sourceRecord(result.metrics).safetyViolations,
      );
    }
  }
  if (maintenance.passed !== true || maintenance.releaseEligible !== true
    || maintenance.gateReason !== 'passed-operational' || maintenance.safetyViolations !== 0
    || maintenance.scenarioCount !== maintenanceScenarioIds.size
    || maintenance.safetyViolations !== maintenanceSafetyViolations
    || maintenance.staleWriteViolations !== 0 || maintenance.duplicateWriteViolations !== 0
    || maintenance.beliefObjectiveContamination !== 0
    || sourceRecord(record.interactive).releaseEligible !== false
    || sourceRecord(record.learning).releaseEligible !== false) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
}

function accountingCounts(value: unknown, bridge: boolean): Record<string, number | string> {
  const record = sourceRecord(value);
  const keys = bridge
    ? ['sessionId', 'providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd']
    : ['providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd', 'providerErrors', 'invalidCalls'];
  if (!exactKeys(record, keys)) throw fail('p14-evidence-cleanup-binding-invalid');
  const parsed: Record<string, number | string> = {};
  if (bridge) parsed.sessionId = sourceToken(record.sessionId);
  for (const key of keys.filter((key) => key !== 'sessionId')) parsed[key] = sourceCount(record[key]);
  return parsed;
}

function validateSourceAccounting(
  value: unknown,
  suite: ParsedSourceSuite,
  run: Readonly<Record<string, unknown>>,
  expectedSessionId: string,
): string {
  const record = sourceRecord(value);
  if (!exactKeys(record, [
    'version', 'lane', 'suiteId', 'sessionId', 'suiteDigest', 'runDigest',
    'sourceArtifactDigest', 'toolSetDigest', 'sourceManifest', 'toolSetManifest',
    'replayAccounting', 'bridgeAccounting', 'accountingDigest',
  ]) || record.version !== P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION
    || record.lane !== 'maintenance'
    || record.suiteId !== P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID
    || record.sessionId !== expectedSessionId
    || record.suiteDigest !== suite.suiteDigest
    || record.runDigest !== sourceCanonicalDigest(run)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  if (!Array.isArray(record.sourceManifest)
    || !Array.isArray(record.toolSetManifest)
    || record.sourceManifest.length !== SOURCE_TARGET_CASES
    || record.toolSetManifest.length !== SOURCE_TARGET_CASES) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const sourceIds = new Set<string>();
  for (const raw of record.sourceManifest) {
    const entry = sourceRecord(raw);
    if (!exactKeys(entry, ['scenarioId', 'sourceDigest'])) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const scenarioId = sourceToken(entry.scenarioId);
    const digest = sourceDigest(entry.sourceDigest);
    if (sourceIds.has(scenarioId) || !SOURCE_TARGET_TASKS.has(scenarioId)
      || suite.scenarios.get(scenarioId)?.sourceDigest !== digest) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    sourceIds.add(scenarioId);
  }
  const toolIds = new Set<string>();
  for (const raw of record.toolSetManifest) {
    const entry = sourceRecord(raw);
    if (!exactKeys(entry, ['scenarioId', 'taskKind', 'proposalContextDigest', 'toolSetDigest'])) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    const scenarioId = sourceToken(entry.scenarioId);
    if (toolIds.has(scenarioId) || !sourceIds.has(scenarioId)
      || entry.taskKind !== SOURCE_TARGET_TASKS.get(scenarioId)
      || suite.scenarios.get(scenarioId)?.taskKind !== entry.taskKind) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
    sourceDigest(entry.proposalContextDigest);
    sourceDigest(entry.toolSetDigest);
    toolIds.add(scenarioId);
  }
  if (record.sourceArtifactDigest !== suite.sourceArtifactDigest
    || record.sourceArtifactDigest !== sourceCanonicalDigest(record.sourceManifest)
    || record.toolSetDigest !== suite.toolSetDigest
    || record.toolSetDigest !== sourceCanonicalDigest(record.toolSetManifest)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const replay = accountingCounts(record.replayAccounting, false);
  const bridge = accountingCounts(record.bridgeAccounting, true);
  if (replay.providerCalls !== SOURCE_TARGET_CASES || replay.providerErrors !== 0
    || replay.invalidCalls !== 0
    || bridge.sessionId !== expectedSessionId || bridge.providerCalls !== SOURCE_TARGET_CASES
    || bridge.inputTokens !== replay.inputTokens || bridge.outputTokens !== replay.outputTokens
    || Number(bridge.costMicrousd) < Number(replay.costMicrousd)
    || Number(bridge.costMicrousd) > P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  const accountingDigest = sourceDigest(record.accountingDigest);
  const { accountingDigest: _ignored, ...base } = record;
  if (accountingDigest !== sourceCanonicalDigest(base)) {
    throw fail('p14-evidence-cleanup-binding-invalid');
  }
  return accountingDigest;
}

function planMaintenanceSourceReplay(
  root: string,
  directoryName: string,
  directoryEntry: TreeEntry,
  contents: readonly TreeEntry[],
): PlannedEvidenceDirectory {
  const byName = new Map(contents.map((entry) => [
    entry.relativePath.slice(directoryName.length + 1), entry,
  ]));
  let binding: MaintenanceSourceBinding;
  try {
    binding = parseMaintenanceSourceBinding(readSourceJson(root, byName.get(BINDING_FILE)!));
    const suite = parseSourceSuite(readSourceJson(root, byName.get('suite.json')!));
    const run = parseSourceRun(readSourceJson(root, byName.get('run.json')!), suite);
    validateSourceEvaluation(readSourceJson(root, byName.get('evaluation.json')!), suite, run);
    const accountingDigest = validateSourceAccounting(
      readSourceJson(root, byName.get('bridge-accounting.json')!),
      suite,
      run,
      binding.sessionId,
    );
    if (binding.suiteDigest !== suite.suiteDigest
      || binding.accountingDigest !== accountingDigest) {
      throw fail('p14-evidence-cleanup-binding-invalid');
    }
  } catch (error) {
    if (error instanceof P14EvidenceCleanupError) throw error;
    throw fail('p14-evidence-cleanup-binding-invalid', error);
  }
  return Object.freeze({
    path: join(root, directoryName),
    relativePath: directoryName,
    identity: directoryEntry.identity,
    entries: Object.freeze(contents.map((entry) => Object.freeze({
      ...entry,
      relativePath: entry.relativePath.slice(directoryName.length + 1),
    }))),
    binding,
  });
}

function validateAndPlan(root: string, rootStats: Stats): EvidencePlan {
  const tree = inspectTree(root);
  const byPath = new Map(tree.map((entry) => [entry.relativePath, entry]));
  const directories: PlannedEvidenceDirectory[] = [];
  const sourceReplayDirectories: string[] = [];

  // A binding outside <lane>/<digest>/binding.json is accepted only as the
  // fifth member of an exact, direct-child Maintenance operational v2 replay.
  for (const entry of tree) {
    if (!entry.relativePath.endsWith('/' + BINDING_FILE)
      && entry.relativePath !== BINDING_FILE) continue;
    const parts = entry.relativePath.split('/');
    if (parts.length === 3 && LANE_SET.has(parts[0]!)
      && DIGEST_DIRECTORY_RE.test(parts[1]!) && parts[2] === BINDING_FILE) continue;
    if (parts.length === 2 && !LANE_SET.has(parts[0]!)
      && isDefaultSourceReplayDirectoryName(parts[0]!)
      && parts[1] === BINDING_FILE) {
      const directoryName = parts[0]!;
      const prefix = `${directoryName}/`;
      const contents = tree.filter((candidate) => candidate.relativePath.startsWith(prefix));
      const names = contents.map((candidate) => candidate.relativePath.slice(prefix.length)).sort();
      if (contents.length !== SOURCE_REPLAY_FILES.length
        || contents.some((candidate) => (
          candidate.kind !== 'file' || candidate.relativePath.slice(prefix.length).includes('/')
        ))
        || names.some((name, index) => name !== SOURCE_REPLAY_FILES[index])) {
        throw fail('p14-evidence-cleanup-ambiguous-layout');
      }
      sourceReplayDirectories.push(directoryName);
      continue;
    }
    throw fail('p14-evidence-cleanup-ambiguous-layout');
  }

  for (const lane of LANES) {
    const laneEntry = byPath.get(lane);
    if (!laneEntry) continue;
    if (laneEntry.kind !== 'directory') throw fail('p14-evidence-cleanup-ambiguous-layout');
    const directChildren = tree.filter((entry) => {
      const parts = entry.relativePath.split('/');
      return parts[0] === lane && parts.length === 2;
    });
    for (const child of directChildren) {
      const digest = child.relativePath.split('/')[1]!;
      if (child.kind !== 'directory' || !DIGEST_DIRECTORY_RE.test(digest)) {
        throw fail('p14-evidence-cleanup-ambiguous-layout');
      }
      const prefix = `${lane}/${digest}/`;
      const contents = tree.filter((entry) => entry.relativePath.startsWith(prefix));
      if (contents.length === 0 || contents.some((entry) => (
        entry.kind !== 'file' || entry.relativePath.slice(prefix.length).includes('/')
      ))) throw fail('p14-evidence-cleanup-ambiguous-layout');
      const bindingEntry = byPath.get(prefix + BINDING_FILE);
      if (!bindingEntry || bindingEntry.kind !== 'file' || bindingEntry.bindingText === undefined) {
        throw fail('p14-evidence-cleanup-ambiguous-layout');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(bindingEntry.bindingText) as unknown; }
      catch (error) { throw fail('p14-evidence-cleanup-binding-invalid', error); }
      const binding = parseBinding(parsed);
      if (binding.lane !== lane || binding.suiteDigest !== `sha256:${digest}`) {
        throw fail('p14-evidence-cleanup-binding-invalid');
      }
      directories.push(Object.freeze({
        path: join(root, lane, digest),
        relativePath: `${lane}/${digest}`,
        identity: child.identity,
        entries: Object.freeze(contents.map((entry) => Object.freeze({
          ...entry,
          relativePath: entry.relativePath.slice(prefix.length),
        }))),
        binding,
      }));
    }
  }

  for (const directoryName of sourceReplayDirectories) {
    const directoryEntry = byPath.get(directoryName);
    if (!directoryEntry || directoryEntry.kind !== 'directory') {
      throw fail('p14-evidence-cleanup-ambiguous-layout');
    }
    const prefix = `${directoryName}/`;
    const contents = tree.filter((entry) => entry.relativePath.startsWith(prefix));
    directories.push(planMaintenanceSourceReplay(
      root,
      directoryName,
      directoryEntry,
      contents,
    ));
  }

  return Object.freeze({
    root,
    rootIdentity: identity(rootStats),
    tree,
    directories: Object.freeze(directories),
  });
}

function inspectPlan(dataDir: string): EvidencePlan | null {
  const root = join(dataDir, EVIDENCE_DIRECTORY);
  if (!existsSync(root)) return null;
  assertContained(dataDir, root);
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw fail('p14-evidence-cleanup-unsafe-layout');
  }
  return validateAndPlan(root, rootStats);
}

function samePlan(left: EvidencePlan, right: EvidencePlan): boolean {
  return left.root === right.root && sameIdentity(left.rootIdentity, right.rootIdentity)
    && left.tree.length === right.tree.length
    && left.tree.every((entry, index) => sameEntry(entry, right.tree[index]!));
}

function assertDirectoryCurrent(plan: PlannedEvidenceDirectory): void {
  const stats = lstatSync(plan.path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(identity(stats), plan.identity)) {
    throw fail('p14-evidence-cleanup-unsafe-layout');
  }
  const current = inspectTree(plan.path);
  if (current.length !== plan.entries.length
    || current.some((entry, index) => !sameEntry(entry, plan.entries[index]!))) {
    throw fail('p14-evidence-cleanup-unsafe-layout');
  }
}

/**
 * Deletes only immutable P14 import/canary envelopes and strict Maintenance v2
 * source replay envelopes whose binding names the deleted session. Unbound raw
 * replay folders are left untouched. The complete layout is validated twice
 * before the first removal.
 */
export function cleanupDeletedSessionP14Evidence(
  input: P14EvidenceCleanupInput,
): P14EvidenceCleanupResult {
  if (!input || typeof input.dataDir !== 'string' || input.dataDir.trim() === ''
    || !safeOpaqueId(input.sessionId, 160)) {
    throw fail('p14-evidence-cleanup-input-invalid');
  }
  const dataDir = resolve(input.dataDir);
  if (dataDir === parse(dataDir).root || !basename(dataDir)) {
    throw fail('p14-evidence-cleanup-input-invalid');
  }
  try {
    assertNoSymlinkAncestors(dataDir);
    const plan = inspectPlan(dataDir);
    if (!plan) {
      return Object.freeze({
        sessionId: input.sessionId,
        scannedBindings: 0,
        removedEvidenceDirectories: Object.freeze([]),
      });
    }
    const matches = plan.directories.filter((candidate) => (
      candidate.binding.sessionId === input.sessionId
    ));

    input.injectBeforeApply?.();

    const current = inspectPlan(dataDir);
    if (!current || !samePlan(plan, current)) {
      throw fail('p14-evidence-cleanup-unsafe-layout');
    }

    const removed: P14EvidenceCleanupResult['removedEvidenceDirectories'][number][] = [];
    for (const candidate of matches) {
      assertDirectoryCurrent(candidate);
      rmSync(candidate.path, { recursive: true, force: false });
      if (existsSync(candidate.path)) throw fail('p14-evidence-cleanup-io');
      removed.push(Object.freeze({
        lane: candidate.binding.lane,
        suiteDigest: candidate.binding.suiteDigest,
        bindingVersion: candidate.binding.version,
      }));
    }
    return Object.freeze({
      sessionId: input.sessionId,
      scannedBindings: plan.directories.length,
      removedEvidenceDirectories: Object.freeze(removed),
    });
  } catch (error) {
    if (error instanceof P14EvidenceCleanupError) throw error;
    throw fail('p14-evidence-cleanup-io', error);
  }
}
