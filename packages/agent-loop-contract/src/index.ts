/**
 * Domain-neutral AgentLoop contracts.
 *
 * This package intentionally knows nothing about HTTP, SQLite, Provider
 * transports or any concrete Agent. Domain adapters keep their execution
 * truth; these contracts only describe orchestration commands and evidence.
 */
export const AGENT_LOOP_CONTRACT_VERSION = 'agent-loop-v1' as const;
export const AGENT_LOOP_RUN_IDENTITY_VERSION = 'agent-loop-run-identity-v1' as const;
export const AGENT_LOOP_DECISION_VERSION = 'agent-loop-decision-v1' as const;
export const AGENT_LOOP_ACTION_REQUEST_VERSION = 'agent-loop-action-request-v1' as const;
export const AGENT_LOOP_OBSERVATION_VERSION = 'agent-loop-observation-v1' as const;
export const AGENT_LOOP_VERIFICATION_RESULT_VERSION = 'agent-loop-verification-result-v1' as const;
export const AGENT_LOOP_TRANSITION_VERSION = 'agent-loop-transition-v1' as const;

export const AGENT_LOOP_TASK_STATES = Object.freeze([
  'CREATED',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'WAITING_EVENT',
  'PAUSED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const);
export type AgentLoopTaskState = typeof AGENT_LOOP_TASK_STATES[number];

export const AGENT_LOOP_PHASES = Object.freeze([
  'PREPARE', 'MODEL', 'ACT', 'OBSERVE', 'VERIFY',
] as const);
export type AgentLoopPhase = typeof AGENT_LOOP_PHASES[number];

export const AGENT_LOOP_DECISION_KINDS = Object.freeze([
  'act', 'delegate', 'ask_user', 'wait_event', 'request_complete',
] as const);
export type AgentLoopDecisionKind = typeof AGENT_LOOP_DECISION_KINDS[number];

export const AGENT_LOOP_OBSERVATION_SOURCES = Object.freeze([
  'user',
  'tool',
  'environment',
  'approval',
  'domain-readback',
  'child-task',
  'timer',
  'external-event',
  'verifier',
  'provider',
] as const);
export type AgentLoopObservationSource = typeof AGENT_LOOP_OBSERVATION_SOURCES[number];

export const AGENT_LOOP_COMPLETENESS = Object.freeze([
  'complete', 'partial', 'unknown',
] as const);
export type AgentLoopCompleteness = typeof AGENT_LOOP_COMPLETENESS[number];

export const AGENT_LOOP_VERIFICATION_DISPOSITIONS = Object.freeze([
  'passed', 'failed-repairable', 'failed-terminal', 'inconclusive',
] as const);
export type AgentLoopVerificationDisposition =
  typeof AGENT_LOOP_VERIFICATION_DISPOSITIONS[number];

export const AGENT_LOOP_TRANSITION_ACTORS = Object.freeze([
  'runtime', 'user', 'system', 'verifier',
] as const);
export type AgentLoopTransitionActor = typeof AGENT_LOOP_TRANSITION_ACTORS[number];

export const AGENT_LOOP_TRANSITION_CAUSE_KINDS = Object.freeze([
  'decision', 'observation', 'verification', 'command', 'runtime-error',
] as const);
export type AgentLoopTransitionCauseKind =
  typeof AGENT_LOOP_TRANSITION_CAUSE_KINDS[number];

export const AGENT_LOOP_TRANSITION_REASONS = Object.freeze([
  'task-started',
  'waiting-input',
  'waiting-approval',
  'waiting-event',
  'input-received',
  'approval-resolved',
  'event-observed',
  'user-paused',
  'system-paused',
  'user-resumed',
  'system-resumed',
  'completion-requested',
  'verification-event-pending',
  'verification-passed',
  'verification-repairable',
  'verification-failed',
  'execution-failed',
  'deadline-exceeded',
  'user-cancelled',
  'system-cancelled',
  'new-attempt',
] as const);
export type AgentLoopTransitionReason = typeof AGENT_LOOP_TRANSITION_REASONS[number];

export type AgentLoopJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentLoopJsonValue[]
  | AgentLoopJsonObject;

export interface AgentLoopJsonObject {
  readonly [key: string]: AgentLoopJsonValue;
}

/**
 * Three deliberately separate identities:
 * - taskId: durable orchestration objective;
 * - attemptId: one retry/reopen generation of that task;
 * - harnessRunId: one bounded model/tool execution inside the attempt.
 */
export interface AgentLoopRunIdentityV1 {
  readonly contractVersion: typeof AGENT_LOOP_RUN_IDENTITY_VERSION;
  readonly taskId: string;
  readonly attemptId: string;
  readonly harnessRunId: string;
  readonly expectedTaskRevision: number;
}

interface AgentLoopDecisionBase {
  readonly contractVersion: typeof AGENT_LOOP_DECISION_VERSION;
  readonly decisionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly harnessRunId: string;
  readonly kind: AgentLoopDecisionKind;
  readonly expectedTaskRevision: number;
  readonly taskContractRef: string;
}

export interface AgentLoopActDecisionV1 extends AgentLoopDecisionBase {
  readonly kind: 'act';
  readonly actionContractRef: string;
  readonly args: AgentLoopJsonObject;
}

export interface AgentLoopDelegateDecisionV1 extends AgentLoopDecisionBase {
  readonly kind: 'delegate';
  readonly childTaskContractRef: string;
  readonly taskKind: string;
  readonly objective: string;
}

export interface AgentLoopAskUserDecisionV1 extends AgentLoopDecisionBase {
  readonly kind: 'ask_user';
  readonly question: string;
  readonly responseContractRef: string;
}

export interface AgentLoopWaitEventDecisionV1 extends AgentLoopDecisionBase {
  readonly kind: 'wait_event';
  readonly observationContractRef: string;
  readonly correlationRef: string;
}

export interface AgentLoopRequestCompleteDecisionV1 extends AgentLoopDecisionBase {
  readonly kind: 'request_complete';
  readonly summary: string;
  readonly artifactRefs: readonly string[];
}

export type AgentLoopDecisionV1 =
  | AgentLoopActDecisionV1
  | AgentLoopDelegateDecisionV1
  | AgentLoopAskUserDecisionV1
  | AgentLoopWaitEventDecisionV1
  | AgentLoopRequestCompleteDecisionV1;

export interface AgentLoopActionRequestV1 {
  readonly contractVersion: typeof AGENT_LOOP_ACTION_REQUEST_VERSION;
  readonly actionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly harnessRunId: string;
  readonly decisionId: string;
  readonly expectedTaskRevision: number;
  readonly decisionDigest: string;
  readonly actionContractRef: string;
  readonly args: AgentLoopJsonObject;
  readonly requestedAt: string;
}

export interface AgentLoopUsageDeltaV1 {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly writes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
  readonly wallMs: number;
  readonly highRiskActions: number;
}

export interface AgentLoopObservationEnvelopeV1 {
  readonly contractVersion: typeof AGENT_LOOP_OBSERVATION_VERSION;
  readonly observationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly observedForTaskRevision: number;
  readonly sourceKind: AgentLoopObservationSource;
  readonly sourceRef: string;
  readonly causalActionId?: string;
  readonly correlationRef?: string;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly payloadDigest: string;
  readonly payloadRef?: string;
  readonly completeness: AgentLoopCompleteness;
  readonly evidenceRefs: readonly string[];
  readonly usageDelta?: AgentLoopUsageDeltaV1;
}

export interface AgentLoopVerificationResultV1 {
  readonly contractVersion: typeof AGENT_LOOP_VERIFICATION_RESULT_VERSION;
  readonly verificationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly taskRevision: number;
  readonly verifierSetRef: string;
  readonly verifierSetRevision: string;
  readonly disposition: AgentLoopVerificationDisposition;
  readonly verifiedAt: string;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly repairTodoRefs: readonly string[];
}

export interface AgentLoopTaskTransitionV1 {
  readonly contractVersion: typeof AGENT_LOOP_TRANSITION_VERSION;
  readonly transitionId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly from: AgentLoopTaskState;
  readonly to: AgentLoopTaskState;
  readonly actor: AgentLoopTransitionActor;
  readonly reasonCode: AgentLoopTransitionReason;
  readonly causeKind: AgentLoopTransitionCauseKind;
  readonly causeRef: string;
  readonly currentAttemptId?: string;
  readonly newAttemptId?: string;
  readonly occurredAt: string;
}

export interface AgentLoopTransitionAuthorityV1 {
  /** Must come from authenticated runtime context, never from model output. */
  readonly actor: AgentLoopTransitionActor;
  /** Required when a verifier result is the authority for the state change. */
  readonly verificationResult?: AgentLoopVerificationResultV1;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const REASON_RE = /^[a-z][a-z0-9-]{0,79}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const JSON_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@#/-]{0,79}$/u;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 512;
const MAX_JSON_KEYS = 256;
const MAX_JSON_ARRAY = 128;
const MAX_JSON_STRING = 4_096;
const MAX_JSON_CHARS = 16_384;

function fail(label: string): never {
  throw new Error(`agent-loop-${label}-invalid`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail(label);
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== 'string')) return fail(label);
  const keys = ownKeys as string[];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) return fail(label);
  }
  if (required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => !allowed.has(key))) return fail(label);
  return record;
}

function dataProperty(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || descriptor.get || descriptor.set) return fail(label);
  return descriptor.value;
}

function member<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail(label);
  return value as T;
}

function token(value: unknown, label: string, max = 240): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || !TOKEN_RE.test(value)) return fail(label);
  return value;
}

function reason(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REASON_RE.test(value)) return fail(label);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) return fail(label);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) return fail(label);
  return value;
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(label);
  return value as number;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 1_000_000_000) return fail(label);
  return value as number;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return fail(label);
  return value;
}

function refList(
  value: unknown,
  label: string,
  options: { readonly max?: number; readonly min?: number; readonly reasonCodes?: boolean } = {},
): readonly string[] {
  const max = options.max ?? 32;
  const min = options.min ?? 0;
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(label);
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail(label);
    normalized.push(options.reasonCodes ? reason(value[index], label) : token(value[index], label));
  }
  if (new Set(normalized).size !== normalized.length) return fail(label);
  return Object.freeze(normalized);
}

interface JsonStats {
  nodes: number;
  keys: number;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  depth: number,
  stats: JsonStats,
): AgentLoopJsonValue {
  stats.nodes += 1;
  if (depth > MAX_JSON_DEPTH || stats.nodes > MAX_JSON_NODES) return fail(label);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail(label);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING) return fail(label);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) return fail(label);
    const normalized: AgentLoopJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return fail(label);
      normalized.push(normalizeJsonValue(value[index], label, depth + 1, stats));
    }
    return Object.freeze(normalized);
  }
  const source = plainRecord(value, label);
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some((key) => typeof key !== 'string')) return fail(label);
  const keys = (ownKeys as string[]).sort();
  stats.keys += keys.length;
  if (stats.keys > MAX_JSON_KEYS) return fail(label);
  const normalized: Record<string, AgentLoopJsonValue> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) return fail(label);
    if (!JSON_KEY_RE.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      return fail(label);
    }
    Object.defineProperty(normalized, key, {
      value: normalizeJsonValue(source[key], label, depth + 1, stats),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(normalized);
}

function jsonObject(value: unknown, label: string): AgentLoopJsonObject {
  const normalized = normalizeJsonValue(value, label, 0, { nodes: 0, keys: 0 });
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    return fail(label);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    return fail(label);
  }
  if (serialized.length > MAX_JSON_CHARS) return fail(label);
  return normalized as AgentLoopJsonObject;
}

function optionalToken(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : token(value, label);
}

function normalizeDecisionBase(record: Record<string, unknown>): {
  readonly decisionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly harnessRunId: string;
  readonly expectedTaskRevision: number;
  readonly taskContractRef: string;
} {
  if (record.contractVersion !== AGENT_LOOP_DECISION_VERSION) {
    return fail('decision-version');
  }
  return {
    decisionId: token(record.decisionId, 'decision-id'),
    taskId: token(record.taskId, 'decision-task-id'),
    attemptId: token(record.attemptId, 'decision-attempt-id'),
    harnessRunId: token(record.harnessRunId, 'decision-harness-run-id'),
    expectedTaskRevision: revision(record.expectedTaskRevision, 'decision-task-revision'),
    taskContractRef: token(record.taskContractRef, 'decision-task-contract-ref'),
  };
}

export function normalizeAgentLoopRunIdentity(input: unknown): AgentLoopRunIdentityV1 {
  const value = exactRecord(input, [
    'contractVersion',
    'taskId',
    'attemptId',
    'harnessRunId',
    'expectedTaskRevision',
  ], [], 'run-identity');
  if (value.contractVersion !== AGENT_LOOP_RUN_IDENTITY_VERSION) {
    return fail('run-identity-version');
  }
  return Object.freeze({
    contractVersion: AGENT_LOOP_RUN_IDENTITY_VERSION,
    taskId: token(value.taskId, 'run-identity-task-id'),
    attemptId: token(value.attemptId, 'run-identity-attempt-id'),
    harnessRunId: token(value.harnessRunId, 'run-identity-harness-run-id'),
    expectedTaskRevision: revision(
      value.expectedTaskRevision,
      'run-identity-task-revision',
    ),
  });
}

export function isAgentLoopRunIdentity(value: unknown): value is AgentLoopRunIdentityV1 {
  try {
    normalizeAgentLoopRunIdentity(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAgentLoopDecision(input: unknown): AgentLoopDecisionV1 {
  const header = plainRecord(input, 'decision');
  const kind = member(
    dataProperty(header, 'kind', 'decision-kind'),
    AGENT_LOOP_DECISION_KINDS,
    'decision-kind',
  );
  const common = [
    'contractVersion',
    'decisionId',
    'taskId',
    'attemptId',
    'harnessRunId',
    'kind',
    'expectedTaskRevision',
    'taskContractRef',
  ] as const;
  if (kind === 'act') {
    const value = exactRecord(input, [
      ...common, 'actionContractRef', 'args',
    ], [], 'decision-act');
    return Object.freeze({
      contractVersion: AGENT_LOOP_DECISION_VERSION,
      kind,
      ...normalizeDecisionBase(value),
      actionContractRef: token(value.actionContractRef, 'decision-action-contract-ref'),
      args: jsonObject(value.args, 'decision-action-args'),
    });
  }
  if (kind === 'delegate') {
    const value = exactRecord(input, [
      ...common, 'childTaskContractRef', 'taskKind', 'objective',
    ], [], 'decision-delegate');
    return Object.freeze({
      contractVersion: AGENT_LOOP_DECISION_VERSION,
      kind,
      ...normalizeDecisionBase(value),
      childTaskContractRef: token(value.childTaskContractRef, 'decision-child-contract-ref'),
      taskKind: token(value.taskKind, 'decision-child-task-kind'),
      objective: text(value.objective, 'decision-objective', 2_000),
    });
  }
  if (kind === 'ask_user') {
    const value = exactRecord(input, [
      ...common, 'question', 'responseContractRef',
    ], [], 'decision-ask-user');
    return Object.freeze({
      contractVersion: AGENT_LOOP_DECISION_VERSION,
      kind,
      ...normalizeDecisionBase(value),
      question: text(value.question, 'decision-question', 2_000),
      responseContractRef: token(value.responseContractRef, 'decision-response-contract-ref'),
    });
  }
  if (kind === 'wait_event') {
    const value = exactRecord(input, [
      ...common, 'observationContractRef', 'correlationRef',
    ], [], 'decision-wait-event');
    return Object.freeze({
      contractVersion: AGENT_LOOP_DECISION_VERSION,
      kind,
      ...normalizeDecisionBase(value),
      observationContractRef: token(
        value.observationContractRef,
        'decision-observation-contract-ref',
      ),
      correlationRef: token(value.correlationRef, 'decision-correlation-ref'),
    });
  }
  const value = exactRecord(input, [
    ...common, 'summary', 'artifactRefs',
  ], [], 'decision-request-complete');
  return Object.freeze({
    contractVersion: AGENT_LOOP_DECISION_VERSION,
    kind,
    ...normalizeDecisionBase(value),
    summary: text(value.summary, 'decision-summary', 4_000),
    artifactRefs: refList(value.artifactRefs, 'decision-artifact-refs'),
  });
}

export function isAgentLoopDecision(value: unknown): value is AgentLoopDecisionV1 {
  try {
    normalizeAgentLoopDecision(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAgentLoopActionRequest(input: unknown): AgentLoopActionRequestV1 {
  const value = exactRecord(input, [
    'contractVersion',
    'actionId',
    'taskId',
    'attemptId',
    'harnessRunId',
    'decisionId',
    'expectedTaskRevision',
    'decisionDigest',
    'actionContractRef',
    'args',
    'requestedAt',
  ], [], 'action-request');
  if (value.contractVersion !== AGENT_LOOP_ACTION_REQUEST_VERSION) {
    return fail('action-request-version');
  }
  return Object.freeze({
    contractVersion: AGENT_LOOP_ACTION_REQUEST_VERSION,
    actionId: token(value.actionId, 'action-request-id'),
    taskId: token(value.taskId, 'action-request-task-id'),
    attemptId: token(value.attemptId, 'action-request-attempt-id'),
    harnessRunId: token(value.harnessRunId, 'action-request-harness-run-id'),
    decisionId: token(value.decisionId, 'action-request-decision-id'),
    expectedTaskRevision: revision(value.expectedTaskRevision, 'action-request-task-revision'),
    decisionDigest: digest(value.decisionDigest, 'action-request-decision-digest'),
    actionContractRef: token(value.actionContractRef, 'action-request-contract-ref'),
    args: jsonObject(value.args, 'action-request-args'),
    requestedAt: timestamp(value.requestedAt, 'action-requested-at'),
  });
}

export function isAgentLoopActionRequest(
  value: unknown,
): value is AgentLoopActionRequestV1 {
  try {
    normalizeAgentLoopActionRequest(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeUsageDelta(input: unknown): AgentLoopUsageDeltaV1 {
  const value = exactRecord(input, [
    'modelCalls',
    'toolCalls',
    'writes',
    'inputTokens',
    'outputTokens',
    'costMicrousd',
    'wallMs',
    'highRiskActions',
  ], [], 'observation-usage');
  return Object.freeze({
    modelCalls: count(value.modelCalls, 'observation-model-calls'),
    toolCalls: count(value.toolCalls, 'observation-tool-calls'),
    writes: count(value.writes, 'observation-writes'),
    inputTokens: count(value.inputTokens, 'observation-input-tokens'),
    outputTokens: count(value.outputTokens, 'observation-output-tokens'),
    costMicrousd: count(value.costMicrousd, 'observation-cost'),
    wallMs: count(value.wallMs, 'observation-wall-ms'),
    highRiskActions: count(value.highRiskActions, 'observation-high-risk-actions'),
  });
}

export function normalizeAgentLoopObservation(
  input: unknown,
): AgentLoopObservationEnvelopeV1 {
  const value = exactRecord(input, [
    'contractVersion',
    'observationId',
    'taskId',
    'attemptId',
    'observedForTaskRevision',
    'sourceKind',
    'sourceRef',
    'observedAt',
    'ingestedAt',
    'payloadDigest',
    'completeness',
    'evidenceRefs',
  ], [
    'causalActionId',
    'correlationRef',
    'payloadRef',
    'usageDelta',
  ], 'observation');
  if (value.contractVersion !== AGENT_LOOP_OBSERVATION_VERSION) {
    return fail('observation-version');
  }
  const observedAt = timestamp(value.observedAt, 'observation-observed-at');
  const ingestedAt = timestamp(value.ingestedAt, 'observation-ingested-at');
  if (Date.parse(ingestedAt) < Date.parse(observedAt)) return fail('observation-time-order');
  const sourceKind = member(
    value.sourceKind,
    AGENT_LOOP_OBSERVATION_SOURCES,
    'observation-source',
  );
  const causalActionId = optionalToken(
    value.causalActionId,
    'observation-causal-action-id',
  );
  const correlationRef = optionalToken(
    value.correlationRef,
    'observation-correlation-ref',
  );
  if (sourceKind === 'tool' && causalActionId === undefined) {
    return fail('observation-tool-causal-action');
  }
  if (['approval', 'external-event', 'timer', 'child-task'].includes(sourceKind)
    && correlationRef === undefined) {
    return fail('observation-correlation-required');
  }
  if (sourceKind === 'domain-readback'
    && causalActionId === undefined && correlationRef === undefined) {
    return fail('observation-readback-cause');
  }
  return Object.freeze({
    contractVersion: AGENT_LOOP_OBSERVATION_VERSION,
    observationId: token(value.observationId, 'observation-id'),
    taskId: token(value.taskId, 'observation-task-id'),
    attemptId: token(value.attemptId, 'observation-attempt-id'),
    observedForTaskRevision: revision(
      value.observedForTaskRevision,
      'observation-task-revision',
    ),
    sourceKind,
    sourceRef: token(value.sourceRef, 'observation-source-ref'),
    ...(causalActionId === undefined ? {} : {
      causalActionId,
    }),
    ...(correlationRef === undefined ? {} : {
      correlationRef,
    }),
    observedAt,
    ingestedAt,
    payloadDigest: digest(value.payloadDigest, 'observation-payload-digest'),
    ...(value.payloadRef === undefined ? {} : {
      payloadRef: optionalToken(value.payloadRef, 'observation-payload-ref'),
    }),
    completeness: member(
      value.completeness,
      AGENT_LOOP_COMPLETENESS,
      'observation-completeness',
    ),
    evidenceRefs: refList(value.evidenceRefs, 'observation-evidence-refs'),
    ...(value.usageDelta === undefined ? {} : {
      usageDelta: normalizeUsageDelta(value.usageDelta),
    }),
  });
}

export function isAgentLoopObservation(
  value: unknown,
): value is AgentLoopObservationEnvelopeV1 {
  try {
    normalizeAgentLoopObservation(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAgentLoopVerificationResult(
  input: unknown,
): AgentLoopVerificationResultV1 {
  const value = exactRecord(input, [
    'contractVersion',
    'verificationId',
    'taskId',
    'attemptId',
    'taskRevision',
    'verifierSetRef',
    'verifierSetRevision',
    'disposition',
    'verifiedAt',
    'reasonCodes',
    'evidenceRefs',
    'repairTodoRefs',
  ], [], 'verification-result');
  if (value.contractVersion !== AGENT_LOOP_VERIFICATION_RESULT_VERSION) {
    return fail('verification-result-version');
  }
  const disposition = member(
    value.disposition,
    AGENT_LOOP_VERIFICATION_DISPOSITIONS,
    'verification-disposition',
  );
  const reasonCodes = refList(value.reasonCodes, 'verification-reason-codes', {
    max: 32,
    reasonCodes: true,
  });
  const evidenceRefs = refList(value.evidenceRefs, 'verification-evidence-refs', {
    max: 64,
  });
  const repairTodoRefs = refList(value.repairTodoRefs, 'verification-repair-todos', {
    max: 64,
  });
  if (disposition === 'passed' && (evidenceRefs.length === 0 || repairTodoRefs.length > 0)) {
    return fail('verification-passed-evidence');
  }
  if (disposition === 'failed-repairable'
    && (reasonCodes.length === 0 || repairTodoRefs.length === 0)) {
    return fail('verification-repair');
  }
  if (['failed-terminal', 'inconclusive'].includes(disposition) && reasonCodes.length === 0) {
    return fail('verification-reason-required');
  }
  if (disposition === 'failed-terminal' && repairTodoRefs.length > 0) {
    return fail('verification-terminal-repair');
  }
  return Object.freeze({
    contractVersion: AGENT_LOOP_VERIFICATION_RESULT_VERSION,
    verificationId: token(value.verificationId, 'verification-id'),
    taskId: token(value.taskId, 'verification-task-id'),
    attemptId: token(value.attemptId, 'verification-attempt-id'),
    taskRevision: revision(value.taskRevision, 'verification-task-revision'),
    verifierSetRef: token(value.verifierSetRef, 'verification-set-ref'),
    verifierSetRevision: token(value.verifierSetRevision, 'verification-set-revision'),
    disposition,
    verifiedAt: timestamp(value.verifiedAt, 'verification-at'),
    reasonCodes,
    evidenceRefs,
    repairTodoRefs,
  });
}

export function isAgentLoopVerificationResult(
  value: unknown,
): value is AgentLoopVerificationResultV1 {
  try {
    normalizeAgentLoopVerificationResult(value);
    return true;
  } catch {
    return false;
  }
}

export const AGENT_LOOP_TERMINAL_TASK_STATES = Object.freeze([
  'COMPLETED', 'CANCELLED',
] as const satisfies readonly AgentLoopTaskState[]);

export const AGENT_LOOP_ALLOWED_TRANSITIONS = Object.freeze({
  CREATED: Object.freeze(['RUNNING', 'CANCELLED'] as const),
  RUNNING: Object.freeze([
    'WAITING_INPUT',
    'WAITING_APPROVAL',
    'WAITING_EVENT',
    'PAUSED',
    'VERIFYING',
    'FAILED',
    'CANCELLED',
  ] as const),
  WAITING_INPUT: Object.freeze(['RUNNING', 'FAILED', 'CANCELLED'] as const),
  WAITING_APPROVAL: Object.freeze(['RUNNING', 'FAILED', 'CANCELLED'] as const),
  WAITING_EVENT: Object.freeze(['RUNNING', 'FAILED', 'CANCELLED'] as const),
  PAUSED: Object.freeze(['RUNNING', 'CANCELLED'] as const),
  VERIFYING: Object.freeze([
    'RUNNING', 'WAITING_EVENT', 'COMPLETED', 'FAILED', 'CANCELLED',
  ] as const),
  COMPLETED: Object.freeze([] as const),
  FAILED: Object.freeze(['RUNNING'] as const),
  CANCELLED: Object.freeze([] as const),
} as const satisfies Readonly<Record<AgentLoopTaskState, readonly AgentLoopTaskState[]>>);

export const AGENT_LOOP_ALLOWED_PHASE_TRANSITIONS = Object.freeze({
  PREPARE: Object.freeze(['MODEL'] as const),
  MODEL: Object.freeze(['ACT'] as const),
  ACT: Object.freeze(['OBSERVE'] as const),
  OBSERVE: Object.freeze(['PREPARE', 'VERIFY'] as const),
  VERIFY: Object.freeze(['PREPARE'] as const),
} as const satisfies Readonly<Record<AgentLoopPhase, readonly AgentLoopPhase[]>>);

export function normalizeAgentLoopTaskState(value: unknown): AgentLoopTaskState {
  return member(value, AGENT_LOOP_TASK_STATES, 'task-state');
}

export function normalizeAgentLoopPhase(value: unknown): AgentLoopPhase {
  return member(value, AGENT_LOOP_PHASES, 'loop-phase');
}

export function assertAgentLoopPhaseTransition(
  fromInput: unknown,
  toInput: unknown,
): void {
  const from = normalizeAgentLoopPhase(fromInput);
  const to = normalizeAgentLoopPhase(toInput);
  const targets = AGENT_LOOP_ALLOWED_PHASE_TRANSITIONS[from] as readonly AgentLoopPhase[];
  if (!targets.includes(to)) return fail('phase-transition');
}

function normalizeTransitionAuthority(input: unknown): AgentLoopTransitionAuthorityV1 {
  const value = exactRecord(input, ['actor'], ['verificationResult'], 'transition-authority');
  return Object.freeze({
    actor: member(value.actor, AGENT_LOOP_TRANSITION_ACTORS, 'transition-authority-actor'),
    ...(value.verificationResult === undefined ? {} : {
      verificationResult: normalizeAgentLoopVerificationResult(value.verificationResult),
    }),
  });
}

function assertActorReason(
  transition: AgentLoopTaskTransitionV1,
  actors: readonly AgentLoopTransitionActor[],
  reasons: readonly AgentLoopTransitionReason[],
): void {
  if (!actors.includes(transition.actor) || !reasons.includes(transition.reasonCode)) {
    return fail('transition-policy');
  }
}

function assertPausingPair(transition: AgentLoopTaskTransitionV1): void {
  if ((transition.actor === 'user' && transition.reasonCode === 'user-paused')
    || (transition.actor === 'system' && transition.reasonCode === 'system-paused')) return;
  return fail('transition-pause-policy');
}

function assertResumingPair(transition: AgentLoopTaskTransitionV1): void {
  if ((transition.actor === 'user' && transition.reasonCode === 'user-resumed')
    || (transition.actor === 'system' && transition.reasonCode === 'system-resumed')) return;
  return fail('transition-resume-policy');
}

function assertCancellationPair(transition: AgentLoopTaskTransitionV1): void {
  if ((transition.actor === 'user' && transition.reasonCode === 'user-cancelled')
    || (transition.actor === 'system' && transition.reasonCode === 'system-cancelled')) return;
  return fail('transition-cancel-policy');
}

function assertAttemptBinding(transition: AgentLoopTaskTransitionV1): void {
  const hasCurrent = transition.currentAttemptId !== undefined;
  const hasNew = transition.newAttemptId !== undefined;
  if (transition.from === 'CREATED' && transition.to === 'RUNNING') {
    if (hasCurrent || !hasNew) return fail('transition-new-attempt');
    return;
  }
  if (transition.from === 'FAILED' && transition.to === 'RUNNING') {
    if (!hasCurrent || !hasNew || transition.currentAttemptId === transition.newAttemptId) {
      return fail('transition-reopened-attempt');
    }
    return;
  }
  if (transition.from === 'CREATED' && transition.to === 'CANCELLED') {
    if (hasCurrent || hasNew) return fail('transition-created-attempt');
    return;
  }
  if (!hasCurrent || hasNew) return fail('transition-current-attempt');
}

function expectedVerificationDisposition(
  transition: AgentLoopTaskTransitionV1,
): AgentLoopVerificationDisposition | null {
  if (transition.from !== 'VERIFYING') return null;
  if (transition.to === 'COMPLETED') return 'passed';
  if (transition.to === 'RUNNING') return 'failed-repairable';
  if (transition.to === 'WAITING_EVENT') return 'inconclusive';
  if (transition.to === 'FAILED' && transition.actor === 'verifier') return 'failed-terminal';
  return null;
}

function assertVerificationAuthority(
  transition: AgentLoopTaskTransitionV1,
  result: AgentLoopVerificationResultV1 | undefined,
): void {
  const expectedDisposition = expectedVerificationDisposition(transition);
  if (expectedDisposition === null) {
    if (result !== undefined) return fail('transition-unexpected-verification');
    return;
  }
  if (!result || result.disposition !== expectedDisposition
    || result.taskId !== transition.taskId
    || result.attemptId !== transition.currentAttemptId
    || result.taskRevision !== transition.expectedRevision
    || transition.causeKind !== 'verification'
    || transition.causeRef !== result.verificationId
    || Date.parse(result.verifiedAt) > Date.parse(transition.occurredAt)) {
    return fail('transition-verification-binding');
  }
}

function assertTransitionCause(transition: AgentLoopTaskTransitionV1): void {
  let expected: AgentLoopTransitionCauseKind;
  if (transition.to === 'CANCELLED' || transition.to === 'PAUSED'
    || transition.from === 'PAUSED'
    || (transition.from === 'CREATED' && transition.to === 'RUNNING')
    || (transition.from === 'FAILED' && transition.to === 'RUNNING')) {
    expected = 'command';
  } else if (transition.from.startsWith('WAITING_') && transition.to === 'RUNNING') {
    expected = 'observation';
  } else if (transition.from === 'RUNNING' && (
    transition.to.startsWith('WAITING_') || transition.to === 'VERIFYING'
  )) {
    expected = 'decision';
  } else if (transition.from === 'VERIFYING' && [
    'RUNNING', 'WAITING_EVENT', 'COMPLETED', 'FAILED',
  ].includes(transition.to) && transition.actor === 'verifier') {
    expected = 'verification';
  } else {
    expected = 'runtime-error';
  }
  if (transition.causeKind !== expected) return fail('transition-cause-kind');
}

function assertTransitionPolicy(transition: AgentLoopTaskTransitionV1): void {
  const targets = AGENT_LOOP_ALLOWED_TRANSITIONS[transition.from] as readonly AgentLoopTaskState[];
  if (!targets.includes(transition.to)) return fail('transition-edge');

  if (transition.to === 'CANCELLED') {
    assertCancellationPair(transition);
    return;
  }
  if (transition.to === 'PAUSED') {
    assertPausingPair(transition);
    return;
  }
  if (transition.from === 'PAUSED' && transition.to === 'RUNNING') {
    assertResumingPair(transition);
    return;
  }
  if (transition.from === 'CREATED' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['runtime', 'system'], ['task-started']);
    return;
  }
  if (transition.from === 'FAILED' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['user', 'system'], ['new-attempt']);
    return;
  }
  if (transition.from === 'WAITING_INPUT' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['runtime', 'system'], ['input-received']);
    return;
  }
  if (transition.from === 'WAITING_APPROVAL' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['runtime', 'system'], ['approval-resolved']);
    return;
  }
  if (transition.from === 'WAITING_EVENT' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['runtime', 'system'], ['event-observed']);
    return;
  }
  if (transition.from === 'RUNNING' && transition.to === 'WAITING_INPUT') {
    assertActorReason(transition, ['runtime', 'system'], ['waiting-input']);
    return;
  }
  if (transition.from === 'RUNNING' && transition.to === 'WAITING_APPROVAL') {
    assertActorReason(transition, ['runtime', 'system'], ['waiting-approval']);
    return;
  }
  if (transition.from === 'RUNNING' && transition.to === 'WAITING_EVENT') {
    assertActorReason(transition, ['runtime', 'system'], ['waiting-event']);
    return;
  }
  if (transition.from === 'VERIFYING' && transition.to === 'WAITING_EVENT') {
    assertActorReason(
      transition,
      ['verifier'],
      ['verification-event-pending'],
    );
    return;
  }
  if (transition.from === 'RUNNING' && transition.to === 'VERIFYING') {
    assertActorReason(transition, ['runtime', 'system'], ['completion-requested']);
    return;
  }
  if (transition.from === 'VERIFYING' && transition.to === 'COMPLETED') {
    assertActorReason(transition, ['verifier'], ['verification-passed']);
    return;
  }
  if (transition.from === 'VERIFYING' && transition.to === 'RUNNING') {
    assertActorReason(transition, ['verifier'], ['verification-repairable']);
    return;
  }
  if (transition.from === 'VERIFYING' && transition.to === 'FAILED') {
    if (transition.actor === 'verifier' && transition.reasonCode === 'verification-failed') return;
    if (transition.actor === 'system' && transition.reasonCode === 'execution-failed') return;
    return fail('transition-verification-failed-policy');
  }
  if (transition.to === 'FAILED') {
    assertActorReason(
      transition,
      ['runtime', 'system'],
      ['execution-failed', 'deadline-exceeded'],
    );
    return;
  }
  return fail('transition-policy');
}

/**
 * Normalizes a transition and checks it against a separately supplied trusted actor.
 * The authority argument must be derived from the authenticated runtime boundary,
 * not copied from model output. Idempotent replay is intentionally an AL-2 reducer concern.
 */
export function normalizeAgentLoopTaskTransition(
  input: unknown,
  authorityInput: unknown,
): AgentLoopTaskTransitionV1 {
  const value = exactRecord(input, [
    'contractVersion',
    'transitionId',
    'taskId',
    'expectedRevision',
    'from',
    'to',
    'actor',
    'reasonCode',
    'causeKind',
    'causeRef',
    'occurredAt',
  ], ['currentAttemptId', 'newAttemptId'], 'transition');
  if (value.contractVersion !== AGENT_LOOP_TRANSITION_VERSION) {
    return fail('transition-version');
  }
  const authority = normalizeTransitionAuthority(authorityInput);
  const actor = member(value.actor, AGENT_LOOP_TRANSITION_ACTORS, 'transition-actor');
  if (authority.actor !== actor) return fail('transition-actor-authority');
  const transition = Object.freeze({
    contractVersion: AGENT_LOOP_TRANSITION_VERSION,
    transitionId: token(value.transitionId, 'transition-id'),
    taskId: token(value.taskId, 'transition-task-id'),
    expectedRevision: revision(value.expectedRevision, 'transition-expected-revision'),
    from: normalizeAgentLoopTaskState(value.from),
    to: normalizeAgentLoopTaskState(value.to),
    actor,
    reasonCode: member(
      value.reasonCode,
      AGENT_LOOP_TRANSITION_REASONS,
      'transition-reason',
    ),
    causeKind: member(
      value.causeKind,
      AGENT_LOOP_TRANSITION_CAUSE_KINDS,
      'transition-cause-kind',
    ),
    causeRef: token(value.causeRef, 'transition-cause-ref'),
    ...(value.currentAttemptId === undefined ? {} : {
      currentAttemptId: token(value.currentAttemptId, 'transition-current-attempt-id'),
    }),
    ...(value.newAttemptId === undefined ? {} : {
      newAttemptId: token(value.newAttemptId, 'transition-new-attempt-id'),
    }),
    occurredAt: timestamp(value.occurredAt, 'transition-occurred-at'),
  } satisfies AgentLoopTaskTransitionV1);
  assertAttemptBinding(transition);
  assertTransitionPolicy(transition);
  assertTransitionCause(transition);
  assertVerificationAuthority(transition, authority.verificationResult);
  return transition;
}

export function isAgentLoopTaskTransition(
  value: unknown,
  authority: unknown,
): value is AgentLoopTaskTransitionV1 {
  try {
    normalizeAgentLoopTaskTransition(value, authority);
    return true;
  } catch {
    return false;
  }
}

export const AGENT_LOOP_LEGACY_COMPLETION_MODES = Object.freeze([
  'legacy', 'agent-loop',
] as const);
export type AgentLoopLegacyCompletionMode =
  typeof AGENT_LOOP_LEGACY_COMPLETION_MODES[number];
export type LegacyHarnessCompletionReason =
  | 'completed-final'
  | 'completed-terminal-tool';

/**
 * Opt-in bridge for one migrated route. Returning request_complete never marks a
 * task complete; the coordinator must still enter VERIFYING and satisfy its verifier set.
 */
export function adaptLegacyHarnessCompletion(
  input: unknown,
): AgentLoopRequestCompleteDecisionV1 | null {
  const value = exactRecord(input, [
    'mode',
    'terminationReason',
    'finalAnswer',
  ], [
    'decisionId',
    'taskId',
    'attemptId',
    'harnessRunId',
    'expectedTaskRevision',
    'taskContractRef',
  ], 'legacy-completion');
  const mode = member(
    value.mode,
    AGENT_LOOP_LEGACY_COMPLETION_MODES,
    'legacy-completion-mode',
  );
  const terminationReason = member(value.terminationReason, [
    'completed-final', 'completed-terminal-tool',
  ] as const, 'legacy-completion-reason');
  const finalAnswer = text(value.finalAnswer, 'legacy-completion-final-answer', 4_000);
  if (terminationReason === 'completed-terminal-tool' && finalAnswer !== 'tool-complete') {
    return fail('legacy-terminal-tool-answer');
  }
  if (mode === 'legacy') return null;
  const expectedTaskRevision = revision(
    value.expectedTaskRevision,
    'legacy-completion-task-revision',
  );
  const taskContractRef = token(
    value.taskContractRef,
    'legacy-completion-task-contract-ref',
  );
  return normalizeAgentLoopDecision({
    contractVersion: AGENT_LOOP_DECISION_VERSION,
    decisionId: token(value.decisionId, 'legacy-completion-decision-id'),
    taskId: token(value.taskId, 'legacy-completion-task-id'),
    attemptId: token(value.attemptId, 'legacy-completion-attempt-id'),
    harnessRunId: token(value.harnessRunId, 'legacy-completion-harness-run-id'),
    kind: 'request_complete',
    expectedTaskRevision,
    taskContractRef,
    summary: finalAnswer,
    artifactRefs: [],
  }) as AgentLoopRequestCompleteDecisionV1;
}
