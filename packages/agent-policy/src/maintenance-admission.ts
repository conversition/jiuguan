import { createHash } from 'node:crypto';

export const MAINTENANCE_ADMISSION_POLICY_VERSION = 'p14-maintenance-admission-v3' as const;
export const MAINTENANCE_ADMISSION_POLICY_VERSIONS = Object.freeze([
  'p14-maintenance-admission-v1', 'p14-maintenance-admission-v2', MAINTENANCE_ADMISSION_POLICY_VERSION,
] as const);
export type MaintenanceAdmissionPolicyVersion = (typeof MAINTENANCE_ADMISSION_POLICY_VERSIONS)[number];
/**
 * The exact persisted batch shape before worldbook_repair joined the scheduler.
 * This is intentionally kept separate from MAINTENANCE_ADMISSION_TASKS: callers
 * may use it to verify historical audit rows, but must never use it to create a
 * new, incomplete admission batch.
 */
export const LEGACY_MAINTENANCE_ADMISSION_TASKS = Object.freeze([
  'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state',
] as const);
export const MAINTENANCE_ADMISSION_TASKS = Object.freeze([
  // 顺序即轮转优先级；worldbook_repair 放在最后 —— 世界书修正不是每回合都需要，
  // 只在其它维护任务都不 eligible 时才轮到它。
  'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state', 'worldbook_repair',
] as const);
export type MaintenanceAdmissionTask = (typeof MAINTENANCE_ADMISSION_TASKS)[number];
export type MaintenancePriorState = 'none' | 'queued' | 'running' | 'succeeded' | 'terminal';
export type MaintenanceAdmissionVerdict = 'would-admit' | 'would-deny';
export const MAINTENANCE_ADMISSION_REASON_CODES = Object.freeze([
  'unstable-revision', 'foreground-active', 'duplicate-active', 'duplicate-succeeded',
  'duplicate-source-digest',
  'session-budget-exhausted', 'daily-budget-exhausted', 'cooldown-active',
  'new-events-present', 'sample-threshold-met', 'entity-signal-present',
  'no-material-change', 'lower-priority-this-turn',
] as const);
export type MaintenanceAdmissionReasonCode = (typeof MAINTENANCE_ADMISSION_REASON_CODES)[number];

export interface MaintenanceAdmissionFacts {
  readonly taskKind: MaintenanceAdmissionTask;
  readonly sourceDigest: string;
  readonly recentSuccessDigest: string | null;
  readonly observationDigest: string;
  readonly hasStableRevision: boolean;
  readonly newEventCount: number;
  readonly sampleCount: number;
  readonly entitySignalCount: number;
  readonly foregroundActive: boolean;
  readonly priorState: MaintenancePriorState;
  readonly sameSourceSucceeded: boolean;
  readonly cooldownElapsedMs: number;
  readonly cooldownRequiredMs: number;
  readonly sessionBudgetRemaining: number;
  readonly dailyBudgetRemaining: number;
}

export interface MaintenanceAdmissionDecision {
  readonly policyVersion: MaintenanceAdmissionPolicyVersion;
  readonly taskKind: MaintenanceAdmissionTask;
  readonly verdict: MaintenanceAdmissionVerdict;
  readonly reasonCodes: readonly MaintenanceAdmissionReasonCode[];
  readonly factsDigest: string;
}

export interface MaintenanceAdmissionAudit {
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly round: number;
  readonly sourceRevision: string;
  readonly facts: MaintenanceAdmissionFacts;
  readonly decision: MaintenanceAdmissionDecision;
  readonly createdAt: string;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const FACT_KEYS = new Set<keyof MaintenanceAdmissionFacts>([
  'taskKind', 'sourceDigest', 'recentSuccessDigest', 'observationDigest', 'hasStableRevision', 'newEventCount',
  'sampleCount', 'entitySignalCount', 'foregroundActive', 'priorState', 'sameSourceSucceeded',
  'cooldownElapsedMs', 'cooldownRequiredMs', 'sessionBudgetRemaining', 'dailyBudgetRemaining',
]);

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value as number;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
  return value;
}

export function normalizeMaintenanceAdmissionFacts(input: MaintenanceAdmissionFacts): MaintenanceAdmissionFacts {
  plain(input, 'maintenanceFacts');
  for (const key of Object.keys(input)) {
    if (!FACT_KEYS.has(key as keyof MaintenanceAdmissionFacts)) throw new TypeError(`maintenanceFacts contains unsupported field: ${key}`);
  }
  if (!MAINTENANCE_ADMISSION_TASKS.includes(input.taskKind)) throw new TypeError('taskKind is invalid');
  if (!['none', 'queued', 'running', 'succeeded', 'terminal'].includes(input.priorState)) throw new TypeError('priorState is invalid');
  if (typeof input.hasStableRevision !== 'boolean' || typeof input.foregroundActive !== 'boolean'
    || typeof input.sameSourceSucceeded !== 'boolean') throw new TypeError('maintenance boolean fact is invalid');
  return Object.freeze({
    taskKind: input.taskKind,
    sourceDigest: sha(input.sourceDigest, 'sourceDigest'),
    recentSuccessDigest: input.recentSuccessDigest === null
      ? null : sha(input.recentSuccessDigest, 'recentSuccessDigest'),
    observationDigest: sha(input.observationDigest, 'observationDigest'),
    hasStableRevision: input.hasStableRevision,
    newEventCount: count(input.newEventCount, 'newEventCount'),
    sampleCount: count(input.sampleCount, 'sampleCount'),
    entitySignalCount: count(input.entitySignalCount, 'entitySignalCount'),
    foregroundActive: input.foregroundActive,
    priorState: input.priorState,
    sameSourceSucceeded: input.sameSourceSucceeded,
    cooldownElapsedMs: count(input.cooldownElapsedMs, 'cooldownElapsedMs'),
    cooldownRequiredMs: count(input.cooldownRequiredMs, 'cooldownRequiredMs'),
    sessionBudgetRemaining: count(input.sessionBudgetRemaining, 'sessionBudgetRemaining'),
    dailyBudgetRemaining: count(input.dailyBudgetRemaining, 'dailyBudgetRemaining'),
  });
}

export function maintenanceAdmissionFactsDigest(input: MaintenanceAdmissionFacts): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(normalizeMaintenanceAdmissionFacts(input)), 'utf8').digest('hex')}`;
}

function preliminary(
  facts: MaintenanceAdmissionFacts,
  policyVersion: MaintenanceAdmissionPolicyVersion,
): { eligible: boolean; reasons: MaintenanceAdmissionReasonCode[] } {
  const reasons: MaintenanceAdmissionReasonCode[] = [];
  if (!facts.hasStableRevision) reasons.push('unstable-revision');
  if (facts.foregroundActive) reasons.push('foreground-active');
  if (facts.priorState === 'queued' || facts.priorState === 'running') reasons.push('duplicate-active');
  if (facts.sameSourceSucceeded || facts.priorState === 'succeeded') reasons.push('duplicate-succeeded');
  if (facts.recentSuccessDigest === facts.sourceDigest) reasons.push('duplicate-source-digest');
  if (facts.sessionBudgetRemaining === 0) reasons.push('session-budget-exhausted');
  if (facts.dailyBudgetRemaining === 0) reasons.push('daily-budget-exhausted');
  if (facts.cooldownElapsedMs < facts.cooldownRequiredMs) reasons.push('cooldown-active');
  const signal = facts.taskKind === 'memory_consolidation'
    ? facts.newEventCount > 0
    : facts.taskKind === 'branch_index'
      ? policyVersion === 'p14-maintenance-admission-v1'
        ? facts.newEventCount > 0 || facts.sampleCount >= 2
        : facts.sampleCount > 0
      : facts.taskKind === 'rolling_summary'
        ? facts.sampleCount >= 4
        // 世界书冲突通常由剧情推进暴露：有新的已提交事件才值得复核设定是否互相矛盾。
        : facts.taskKind === 'worldbook_repair'
          ? facts.newEventCount > 0
          : facts.entitySignalCount > 0;
  if (facts.newEventCount > 0) reasons.push('new-events-present');
  const sampleThreshold = facts.taskKind === 'rolling_summary'
    ? 4 : policyVersion === 'p14-maintenance-admission-v1' ? 2 : 1;
  if (facts.sampleCount >= sampleThreshold) reasons.push('sample-threshold-met');
  if (facts.entitySignalCount > 0) reasons.push('entity-signal-present');
  if (!signal) reasons.push('no-material-change');
  const hardDeny = reasons.some((reason) => [
    'unstable-revision', 'foreground-active', 'duplicate-active', 'duplicate-succeeded',
    'duplicate-source-digest',
    'session-budget-exhausted', 'daily-budget-exhausted', 'cooldown-active', 'no-material-change',
  ].includes(reason));
  return { eligible: !hardDeny, reasons };
}

/** At most one maintenance task is admitted per accepted turn; priority rotates deterministically. */
export function evaluateMaintenanceAdmissionBatch(
  round: number,
  inputs: readonly MaintenanceAdmissionFacts[],
  policyVersion: MaintenanceAdmissionPolicyVersion = MAINTENANCE_ADMISSION_POLICY_VERSION,
): readonly MaintenanceAdmissionDecision[] {
  if (!Number.isSafeInteger(round) || round < 1) throw new TypeError('round must be a positive safe integer');
  if (!Array.isArray(inputs) || inputs.length !== MAINTENANCE_ADMISSION_TASKS.length) {
    throw new TypeError('maintenance batch must contain every task exactly once');
  }
  if (!MAINTENANCE_ADMISSION_POLICY_VERSIONS.includes(policyVersion)) {
    throw new TypeError('maintenance policyVersion is invalid');
  }
  const normalized = inputs.map(normalizeMaintenanceAdmissionFacts);
  if (new Set(normalized.map((facts) => facts.taskKind)).size !== MAINTENANCE_ADMISSION_TASKS.length) {
    throw new TypeError('maintenance batch must contain every task exactly once');
  }
  const rotation = (round - 1) % MAINTENANCE_ADMISSION_TASKS.length;
  const priority = [...MAINTENANCE_ADMISSION_TASKS.slice(rotation), ...MAINTENANCE_ADMISSION_TASKS.slice(0, rotation)];
  const evaluated = new Map(normalized.map((facts) => [facts.taskKind, preliminary(facts, policyVersion)]));
  const admittedTask = priority.find((task) => evaluated.get(task)!.eligible);
  return Object.freeze(normalized.map((facts) => {
    const result = evaluated.get(facts.taskKind)!;
    const admitted = result.eligible && facts.taskKind === admittedTask;
    const reasonCodes = [...result.reasons];
    if (result.eligible && !admitted) reasonCodes.push('lower-priority-this-turn');
    return Object.freeze({
      policyVersion,
      taskKind: facts.taskKind,
      verdict: admitted ? 'would-admit' as const : 'would-deny' as const,
      reasonCodes: Object.freeze(reasonCodes),
      factsDigest: maintenanceAdmissionFactsDigest(facts),
    });
  }));
}

/**
 * Read-only verifier for four-task batches that were durably written before
 * worldbook_repair existed. It replays the original four-way rotation instead
 * of inventing a fifth decision, so historical evidence remains attributable.
 */
export function evaluateLegacyMaintenanceAdmissionBatch(
  round: number,
  inputs: readonly MaintenanceAdmissionFacts[],
  policyVersion: MaintenanceAdmissionPolicyVersion,
): readonly MaintenanceAdmissionDecision[] {
  if (!Number.isSafeInteger(round) || round < 1) throw new TypeError('round must be a positive safe integer');
  if (!MAINTENANCE_ADMISSION_POLICY_VERSIONS.includes(policyVersion)
    || policyVersion === MAINTENANCE_ADMISSION_POLICY_VERSION) {
    throw new TypeError('legacy maintenance policyVersion must be v1 or v2');
  }
  if (!Array.isArray(inputs) || inputs.length !== LEGACY_MAINTENANCE_ADMISSION_TASKS.length) {
    throw new TypeError('legacy maintenance batch must contain the four historical tasks exactly once');
  }
  const normalized = inputs.map(normalizeMaintenanceAdmissionFacts);
  const taskSet = new Set(normalized.map((facts) => facts.taskKind));
  if (taskSet.size !== LEGACY_MAINTENANCE_ADMISSION_TASKS.length
    || LEGACY_MAINTENANCE_ADMISSION_TASKS.some((task) => !taskSet.has(task))) {
    throw new TypeError('legacy maintenance batch must contain the four historical tasks exactly once');
  }
  const rotation = (round - 1) % LEGACY_MAINTENANCE_ADMISSION_TASKS.length;
  const priority = [
    ...LEGACY_MAINTENANCE_ADMISSION_TASKS.slice(rotation),
    ...LEGACY_MAINTENANCE_ADMISSION_TASKS.slice(0, rotation),
  ];
  const evaluated = new Map(normalized.map((facts) => [facts.taskKind, preliminary(facts, policyVersion)]));
  const admittedTask = priority.find((task) => evaluated.get(task)!.eligible);
  return Object.freeze(normalized.map((facts) => {
    const result = evaluated.get(facts.taskKind)!;
    const admitted = result.eligible && facts.taskKind === admittedTask;
    const reasonCodes = [...result.reasons];
    if (result.eligible && !admitted) reasonCodes.push('lower-priority-this-turn');
    return Object.freeze({
      policyVersion,
      taskKind: facts.taskKind,
      verdict: admitted ? 'would-admit' as const : 'would-deny' as const,
      reasonCodes: Object.freeze(reasonCodes),
      factsDigest: maintenanceAdmissionFactsDigest(facts),
    });
  }));
}
