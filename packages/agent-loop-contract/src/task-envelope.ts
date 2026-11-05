import {
  AGENT_LOOP_VERIFICATION_DISPOSITIONS,
  normalizeAgentLoopPhase,
  normalizeAgentLoopTaskState,
  type AgentLoopPhase,
  type AgentLoopTaskState,
  type AgentLoopVerificationDisposition,
} from './index.ts';

/**
 * Durable, domain-neutral Task projection contract.
 *
 * This DTO does not provide persistence, CAS, reduction, scheduling, budget
 * accounting or verification authority. Those remain AL-1/AL-2 runtime work.
 */
export const AGENT_LOOP_TASK_ENVELOPE_VERSION =
  'agent-loop-task-envelope-v1' as const;

export const AGENT_LOOP_TODO_STATES = Object.freeze([
  'pending', 'in-progress', 'completed', 'blocked', 'cancelled',
] as const);
export type AgentLoopTodoState = typeof AGENT_LOOP_TODO_STATES[number];

export const AGENT_LOOP_BLOCKER_STATES = Object.freeze([
  'open', 'resolved',
] as const);
export type AgentLoopBlockerState = typeof AGENT_LOOP_BLOCKER_STATES[number];

export const AGENT_LOOP_CHILD_REQUIREMENTS = Object.freeze([
  'required', 'optional',
] as const);
export type AgentLoopChildRequirement = typeof AGENT_LOOP_CHILD_REQUIREMENTS[number];

export const AGENT_LOOP_CHILD_JOIN_STATES = Object.freeze([
  'pending', 'accepted', 'rejected',
] as const);
export type AgentLoopChildJoinState = typeof AGENT_LOOP_CHILD_JOIN_STATES[number];

export const AGENT_LOOP_ARTIFACT_STATES = Object.freeze([
  'declared', 'available', 'verified', 'invalidated',
] as const);
export type AgentLoopArtifactState = typeof AGENT_LOOP_ARTIFACT_STATES[number];

export const AGENT_LOOP_WAIT_KINDS = Object.freeze([
  'input', 'approval', 'event', 'child', 'verification',
] as const);
export type AgentLoopWaitKind = typeof AGENT_LOOP_WAIT_KINDS[number];

export const AGENT_LOOP_TASK_BUDGET_KEYS = Object.freeze([
  'modelCalls',
  'toolCalls',
  'writes',
  'inputTokens',
  'outputTokens',
  'costMicrousd',
  'wallMs',
  'highRiskActions',
  'childTasks',
] as const);
export type AgentLoopTaskBudgetKey = typeof AGENT_LOOP_TASK_BUDGET_KEYS[number];

export interface AgentLoopTaskGoalV1 {
  readonly summary: string;
  readonly sourceRefs: readonly string[];
}

export interface AgentLoopTaskPlanV1 {
  readonly planRef: string;
  readonly planRevision: string;
  readonly summary: string;
  readonly todoOrder: readonly string[];
}

export interface AgentLoopTaskTodoV1 {
  readonly todoId: string;
  readonly summary: string;
  readonly status: AgentLoopTodoState;
  readonly evidenceRefs: readonly string[];
}

export interface AgentLoopConfirmedFactV1 {
  readonly factId: string;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentLoopTaskBlockerV1 {
  readonly blockerId: string;
  readonly reasonCode: string;
  readonly status: AgentLoopBlockerState;
  readonly evidenceRefs: readonly string[];
}

export interface AgentLoopChildTaskProjectionV1 {
  readonly taskId: string;
  readonly requirement: AgentLoopChildRequirement;
  readonly state: AgentLoopTaskState;
  readonly taskRevision: number;
  readonly joinState: AgentLoopChildJoinState;
  readonly outcomeRef?: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentLoopTaskArtifactV1 {
  readonly artifactRef: string;
  readonly kind: string;
  readonly status: AgentLoopArtifactState;
  readonly evidenceRefs: readonly string[];
}

export type AgentLoopTaskBudgetVectorV1 = Readonly<
  Record<AgentLoopTaskBudgetKey, number>
>;

export interface AgentLoopTaskBudgetProjectionV1 {
  readonly policyRef: string;
  readonly granted: AgentLoopTaskBudgetVectorV1;
  readonly reserved: AgentLoopTaskBudgetVectorV1;
  readonly spent: AgentLoopTaskBudgetVectorV1;
}

export interface AgentLoopTaskWaitV1 {
  readonly waitId: string;
  readonly kind: AgentLoopWaitKind;
  readonly correlationRef: string;
  readonly expectedObservationContractRef: string;
  readonly resumePredicateRef: string;
  readonly since: string;
  readonly deadlineAt?: string;
}

export interface AgentLoopTaskVerifierBindingV1 {
  readonly verifierSetRef: string;
  readonly verifierSetRevision: string;
}

export interface AgentLoopTaskCompletionProjectionV1 {
  readonly candidateRef: string;
  readonly disposition?: AgentLoopVerificationDisposition;
  readonly verificationResultRef?: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentLoopTaskEnvelopeV1 {
  readonly contractVersion: typeof AGENT_LOOP_TASK_ENVELOPE_VERSION;
  readonly taskId: string;
  readonly rootTaskId: string;
  readonly parentTaskId?: string;
  readonly dependencyTaskIds: readonly string[];
  readonly currentAttemptId?: string;
  readonly taskContractRef: string;
  readonly taskKind: string;
  readonly state: AgentLoopTaskState;
  readonly phase: AgentLoopPhase;
  readonly goal: AgentLoopTaskGoalV1;
  readonly plan?: AgentLoopTaskPlanV1;
  readonly todos: readonly AgentLoopTaskTodoV1[];
  readonly confirmedFacts: readonly AgentLoopConfirmedFactV1[];
  readonly blockers: readonly AgentLoopTaskBlockerV1[];
  readonly children: readonly AgentLoopChildTaskProjectionV1[];
  readonly artifacts: readonly AgentLoopTaskArtifactV1[];
  readonly budget: AgentLoopTaskBudgetProjectionV1;
  readonly wait?: AgentLoopTaskWaitV1;
  readonly verifier: AgentLoopTaskVerifierBindingV1;
  readonly completion?: AgentLoopTaskCompletionProjectionV1;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const REASON_RE = /^[a-z][a-z0-9-]{0,79}$/u;
const MAX_ENVELOPE_CHARS = 131_072;

function fail(label: string): never {
  throw new Error(`agent-loop-task-envelope-${label}-invalid`);
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

function member<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail(label);
  return value as T;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return fail(label);
  return value;
}

function optionalToken(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : token(value, label);
}

function reason(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REASON_RE.test(value)) return fail(label);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > max) {
    return fail(label);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) return fail(label);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(label);
  return value as number;
}

function refList(
  value: unknown,
  label: string,
  options: Readonly<{ min?: number; max?: number; preserveOrder?: boolean }> = {},
): readonly string[] {
  const min = options.min ?? 0;
  const max = options.max ?? 64;
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(label);
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail(label);
    normalized.push(token(value[index], label));
  }
  if (new Set(normalized).size !== normalized.length) return fail(label);
  if (!options.preserveOrder) normalized.sort();
  return Object.freeze(normalized);
}

function recordList<T>(
  value: unknown,
  label: string,
  parse: (item: unknown, index: number) => T,
  max: number,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max) return fail(label);
  const normalized: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail(label);
    normalized.push(parse(value[index], index));
  }
  return Object.freeze(normalized);
}

function assertUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void {
  const ids = values.map(identity);
  if (new Set(ids).size !== ids.length) return fail(label);
}

function normalizeGoal(input: unknown): AgentLoopTaskGoalV1 {
  const value = exactRecord(input, ['summary', 'sourceRefs'], [], 'goal');
  return Object.freeze({
    summary: text(value.summary, 'goal-summary', 4_000),
    sourceRefs: refList(value.sourceRefs, 'goal-source-refs', { max: 32 }),
  });
}

function normalizePlan(input: unknown): AgentLoopTaskPlanV1 {
  const value = exactRecord(
    input,
    ['planRef', 'planRevision', 'summary', 'todoOrder'],
    [],
    'plan',
  );
  return Object.freeze({
    planRef: token(value.planRef, 'plan-ref'),
    planRevision: token(value.planRevision, 'plan-revision'),
    summary: text(value.summary, 'plan-summary', 4_000),
    todoOrder: refList(value.todoOrder, 'plan-todo-order', {
      max: 128,
      preserveOrder: true,
    }),
  });
}

function normalizeTodo(input: unknown): AgentLoopTaskTodoV1 {
  const value = exactRecord(
    input,
    ['todoId', 'summary', 'status', 'evidenceRefs'],
    [],
    'todo',
  );
  const status = member(value.status, AGENT_LOOP_TODO_STATES, 'todo-status');
  const evidenceRefs = refList(value.evidenceRefs, 'todo-evidence-refs');
  if (status === 'completed' && evidenceRefs.length === 0) return fail('todo-completed-evidence');
  return Object.freeze({
    todoId: token(value.todoId, 'todo-id'),
    summary: text(value.summary, 'todo-summary', 2_000),
    status,
    evidenceRefs,
  });
}

function normalizeFact(input: unknown): AgentLoopConfirmedFactV1 {
  const value = exactRecord(
    input,
    ['factId', 'statement', 'evidenceRefs'],
    [],
    'confirmed-fact',
  );
  return Object.freeze({
    factId: token(value.factId, 'confirmed-fact-id'),
    statement: text(value.statement, 'confirmed-fact-statement', 2_000),
    evidenceRefs: refList(value.evidenceRefs, 'confirmed-fact-evidence', {
      min: 1,
    }),
  });
}

function normalizeBlocker(input: unknown): AgentLoopTaskBlockerV1 {
  const value = exactRecord(
    input,
    ['blockerId', 'reasonCode', 'status', 'evidenceRefs'],
    [],
    'blocker',
  );
  const status = member(value.status, AGENT_LOOP_BLOCKER_STATES, 'blocker-status');
  const evidenceRefs = refList(value.evidenceRefs, 'blocker-evidence-refs');
  if (status === 'resolved' && evidenceRefs.length === 0) {
    return fail('blocker-resolved-evidence');
  }
  return Object.freeze({
    blockerId: token(value.blockerId, 'blocker-id'),
    reasonCode: reason(value.reasonCode, 'blocker-reason-code'),
    status,
    evidenceRefs,
  });
}

function normalizeChild(input: unknown): AgentLoopChildTaskProjectionV1 {
  const value = exactRecord(
    input,
    ['taskId', 'requirement', 'state', 'taskRevision', 'joinState', 'evidenceRefs'],
    ['outcomeRef'],
    'child',
  );
  const state = normalizeAgentLoopTaskState(value.state);
  const joinState = member(
    value.joinState,
    AGENT_LOOP_CHILD_JOIN_STATES,
    'child-join-state',
  );
  const outcomeRef = optionalToken(value.outcomeRef, 'child-outcome-ref');
  const evidenceRefs = refList(value.evidenceRefs, 'child-evidence-refs');
  const settled = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state);
  if (!settled && joinState !== 'pending') return fail('child-open-join');
  if (joinState === 'accepted'
    && (state !== 'COMPLETED' || outcomeRef === undefined || evidenceRefs.length === 0)) {
    return fail('child-accepted-outcome');
  }
  if (joinState === 'rejected'
    && (!settled || outcomeRef === undefined || evidenceRefs.length === 0)) {
    return fail('child-rejected-outcome');
  }
  if (joinState === 'pending' && outcomeRef !== undefined) {
    return fail('child-pending-outcome');
  }
  return Object.freeze({
    taskId: token(value.taskId, 'child-task-id'),
    requirement: member(
      value.requirement,
      AGENT_LOOP_CHILD_REQUIREMENTS,
      'child-requirement',
    ),
    state,
    taskRevision: nonNegativeInteger(value.taskRevision, 'child-task-revision'),
    joinState,
    ...(outcomeRef === undefined ? {} : { outcomeRef }),
    evidenceRefs,
  });
}

function normalizeArtifact(input: unknown): AgentLoopTaskArtifactV1 {
  const value = exactRecord(
    input,
    ['artifactRef', 'kind', 'status', 'evidenceRefs'],
    [],
    'artifact',
  );
  const status = member(
    value.status,
    AGENT_LOOP_ARTIFACT_STATES,
    'artifact-status',
  );
  const evidenceRefs = refList(value.evidenceRefs, 'artifact-evidence-refs');
  if (['verified', 'invalidated'].includes(status) && evidenceRefs.length === 0) {
    return fail('artifact-status-evidence');
  }
  return Object.freeze({
    artifactRef: token(value.artifactRef, 'artifact-ref'),
    kind: token(value.kind, 'artifact-kind'),
    status,
    evidenceRefs,
  });
}

function normalizeBudgetVector(
  input: unknown,
  label: string,
): AgentLoopTaskBudgetVectorV1 {
  const value = exactRecord(input, AGENT_LOOP_TASK_BUDGET_KEYS, [], label);
  return Object.freeze(Object.fromEntries(
    AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => [
      key,
      nonNegativeInteger(value[key], `${label}-${key}`),
    ]),
  ) as Record<AgentLoopTaskBudgetKey, number>);
}

function normalizeBudget(input: unknown): AgentLoopTaskBudgetProjectionV1 {
  const value = exactRecord(
    input,
    ['policyRef', 'granted', 'reserved', 'spent'],
    [],
    'budget',
  );
  return Object.freeze({
    policyRef: token(value.policyRef, 'budget-policy-ref'),
    granted: normalizeBudgetVector(value.granted, 'budget-granted'),
    reserved: normalizeBudgetVector(value.reserved, 'budget-reserved'),
    spent: normalizeBudgetVector(value.spent, 'budget-spent'),
  });
}

function normalizeWait(input: unknown): AgentLoopTaskWaitV1 {
  const value = exactRecord(
    input,
    [
      'waitId',
      'kind',
      'correlationRef',
      'expectedObservationContractRef',
      'resumePredicateRef',
      'since',
    ],
    ['deadlineAt'],
    'wait',
  );
  const since = timestamp(value.since, 'wait-since');
  const deadlineAt = value.deadlineAt === undefined
    ? undefined
    : timestamp(value.deadlineAt, 'wait-deadline');
  if (deadlineAt !== undefined && Date.parse(deadlineAt) < Date.parse(since)) {
    return fail('wait-time-order');
  }
  return Object.freeze({
    waitId: token(value.waitId, 'wait-id'),
    kind: member(value.kind, AGENT_LOOP_WAIT_KINDS, 'wait-kind'),
    correlationRef: token(value.correlationRef, 'wait-correlation-ref'),
    expectedObservationContractRef: token(
      value.expectedObservationContractRef,
      'wait-observation-contract-ref',
    ),
    resumePredicateRef: token(value.resumePredicateRef, 'wait-resume-predicate-ref'),
    since,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}

function normalizeVerifier(input: unknown): AgentLoopTaskVerifierBindingV1 {
  const value = exactRecord(
    input,
    ['verifierSetRef', 'verifierSetRevision'],
    [],
    'verifier',
  );
  return Object.freeze({
    verifierSetRef: token(value.verifierSetRef, 'verifier-set-ref'),
    verifierSetRevision: token(value.verifierSetRevision, 'verifier-set-revision'),
  });
}

function normalizeCompletion(
  input: unknown,
): AgentLoopTaskCompletionProjectionV1 {
  const value = exactRecord(
    input,
    ['candidateRef', 'evidenceRefs'],
    ['disposition', 'verificationResultRef'],
    'completion',
  );
  const disposition = value.disposition === undefined
    ? undefined
    : member(
      value.disposition,
      AGENT_LOOP_VERIFICATION_DISPOSITIONS,
      'completion-disposition',
    );
  const verificationResultRef = optionalToken(
    value.verificationResultRef,
    'completion-verification-result-ref',
  );
  const evidenceRefs = refList(value.evidenceRefs, 'completion-evidence-refs');
  if ((disposition === undefined) !== (verificationResultRef === undefined)) {
    return fail('completion-result-binding');
  }
  if (disposition === 'passed' && evidenceRefs.length === 0) {
    return fail('completion-passed-evidence');
  }
  return Object.freeze({
    candidateRef: token(value.candidateRef, 'completion-candidate-ref'),
    ...(disposition === undefined ? {} : { disposition }),
    ...(verificationResultRef === undefined ? {} : { verificationResultRef }),
    evidenceRefs,
  });
}

const ATTEMPT_REQUIRED_STATES = new Set<AgentLoopTaskState>([
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'WAITING_EVENT',
  'PAUSED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
]);

function assertPlanTodoBinding(
  plan: AgentLoopTaskPlanV1 | undefined,
  todos: readonly AgentLoopTaskTodoV1[],
): void {
  if (plan === undefined) {
    if (todos.length > 0) return fail('plan-required-for-todos');
    return;
  }
  const todoIds = todos.map((item) => item.todoId);
  if (plan.todoOrder.length !== todoIds.length) return fail('plan-todo-binding');
  const expected = new Set(todoIds);
  if (plan.todoOrder.some((todoId) => !expected.has(todoId))) {
    return fail('plan-todo-binding');
  }
}

function assertWaitBinding(
  state: AgentLoopTaskState,
  wait: AgentLoopTaskWaitV1 | undefined,
  children: readonly AgentLoopChildTaskProjectionV1[],
  completion: AgentLoopTaskCompletionProjectionV1 | undefined,
): void {
  const expectedKinds: Readonly<Partial<Record<AgentLoopTaskState, readonly AgentLoopWaitKind[]>>> = {
    WAITING_INPUT: ['input'],
    WAITING_APPROVAL: ['approval'],
    WAITING_EVENT: ['event', 'child', 'verification'],
  };
  const allowedKinds = expectedKinds[state];
  if (allowedKinds === undefined) {
    if (wait !== undefined) return fail('wait-state-binding');
    return;
  }
  if (wait === undefined || !allowedKinds.includes(wait.kind)) {
    return fail('wait-state-binding');
  }
  if (wait.kind === 'child') {
    const waitedChild = children.find((child) => child.taskId === wait.correlationRef);
    if (waitedChild?.joinState !== 'pending') return fail('wait-child-binding');
  }
  if (wait.kind === 'verification'
    && completion?.disposition !== 'inconclusive') {
    return fail('wait-verification-binding');
  }
}

function assertCompletedGate(
  state: AgentLoopTaskState,
  todos: readonly AgentLoopTaskTodoV1[],
  blockers: readonly AgentLoopTaskBlockerV1[],
  children: readonly AgentLoopChildTaskProjectionV1[],
  completion: AgentLoopTaskCompletionProjectionV1 | undefined,
): void {
  if (state !== 'COMPLETED') return;
  if (completion?.disposition !== 'passed'
    || completion.verificationResultRef === undefined
    || completion.evidenceRefs.length === 0) {
    return fail('completed-verification-gate');
  }
  if (todos.some((item) => ['pending', 'in-progress', 'blocked'].includes(item.status))) {
    return fail('completed-todo-gate');
  }
  if (blockers.some((item) => item.status === 'open')) {
    return fail('completed-blocker-gate');
  }
  if (children.some((item) => item.requirement === 'required'
    && item.joinState !== 'accepted')) {
    return fail('completed-child-gate');
  }
}

/**
 * Validate and normalize a durable task projection.
 *
 * `revision` and `budget` are observed facts only. This function does not
 * grant CAS, persistence, scheduling, verification or accounting authority.
 */
export function normalizeAgentLoopTaskEnvelope(
  input: unknown,
): AgentLoopTaskEnvelopeV1 {
  const value = exactRecord(
    input,
    [
      'contractVersion',
      'taskId',
      'rootTaskId',
      'dependencyTaskIds',
      'taskContractRef',
      'taskKind',
      'state',
      'phase',
      'goal',
      'todos',
      'confirmedFacts',
      'blockers',
      'children',
      'artifacts',
      'budget',
      'verifier',
      'revision',
      'createdAt',
      'updatedAt',
    ],
    ['parentTaskId', 'currentAttemptId', 'plan', 'wait', 'completion'],
    'root',
  );
  if (value.contractVersion !== AGENT_LOOP_TASK_ENVELOPE_VERSION) {
    return fail('version');
  }

  const taskId = token(value.taskId, 'task-id');
  const rootTaskId = token(value.rootTaskId, 'root-task-id');
  const parentTaskId = optionalToken(value.parentTaskId, 'parent-task-id');
  if (parentTaskId === undefined) {
    if (rootTaskId !== taskId) return fail('root-identity');
  } else if (rootTaskId === taskId || parentTaskId === taskId) {
    return fail('child-identity');
  }

  const dependencyTaskIds = refList(
    value.dependencyTaskIds,
    'dependency-task-ids',
    { max: 128 },
  );
  if (dependencyTaskIds.includes(taskId)) return fail('dependency-self-reference');

  const state = normalizeAgentLoopTaskState(value.state);
  const currentAttemptId = optionalToken(
    value.currentAttemptId,
    'current-attempt-id',
  );
  if (state === 'CREATED' && currentAttemptId !== undefined) {
    return fail('created-attempt-binding');
  }
  if (ATTEMPT_REQUIRED_STATES.has(state) && currentAttemptId === undefined) {
    return fail('attempt-required');
  }

  const plan = value.plan === undefined ? undefined : normalizePlan(value.plan);
  const todos = recordList(value.todos, 'todos', normalizeTodo, 128);
  assertUnique(todos, (item) => item.todoId, 'todo-identity');
  assertPlanTodoBinding(plan, todos);

  const confirmedFacts = recordList(
    value.confirmedFacts,
    'confirmed-facts',
    normalizeFact,
    256,
  );
  assertUnique(confirmedFacts, (item) => item.factId, 'confirmed-fact-identity');

  const blockers = recordList(value.blockers, 'blockers', normalizeBlocker, 128);
  assertUnique(blockers, (item) => item.blockerId, 'blocker-identity');

  const children = recordList(value.children, 'children', normalizeChild, 128);
  assertUnique(children, (item) => item.taskId, 'child-identity');
  if (children.some((child) => child.taskId === taskId)) {
    return fail('child-self-reference');
  }

  const artifacts = recordList(value.artifacts, 'artifacts', normalizeArtifact, 256);
  assertUnique(artifacts, (item) => item.artifactRef, 'artifact-identity');

  const wait = value.wait === undefined ? undefined : normalizeWait(value.wait);
  const completion = value.completion === undefined
    ? undefined
    : normalizeCompletion(value.completion);
  if (state === 'VERIFYING' && completion === undefined) {
    return fail('verifying-completion');
  }
  assertWaitBinding(state, wait, children, completion);
  assertCompletedGate(state, todos, blockers, children, completion);

  const createdAt = timestamp(value.createdAt, 'created-at');
  const updatedAt = timestamp(value.updatedAt, 'updated-at');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return fail('time-order');
  if (wait !== undefined
    && (Date.parse(wait.since) < Date.parse(createdAt)
      || Date.parse(wait.since) > Date.parse(updatedAt))) {
    return fail('wait-projection-time');
  }

  const normalized = Object.freeze({
    contractVersion: AGENT_LOOP_TASK_ENVELOPE_VERSION,
    taskId,
    rootTaskId,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    dependencyTaskIds,
    ...(currentAttemptId === undefined ? {} : { currentAttemptId }),
    taskContractRef: token(value.taskContractRef, 'task-contract-ref'),
    taskKind: token(value.taskKind, 'task-kind'),
    state,
    phase: normalizeAgentLoopPhase(value.phase),
    goal: normalizeGoal(value.goal),
    ...(plan === undefined ? {} : { plan }),
    todos,
    confirmedFacts,
    blockers,
    children,
    artifacts,
    budget: normalizeBudget(value.budget),
    ...(wait === undefined ? {} : { wait }),
    verifier: normalizeVerifier(value.verifier),
    ...(completion === undefined ? {} : { completion }),
    revision: nonNegativeInteger(value.revision, 'revision'),
    createdAt,
    updatedAt,
  } satisfies AgentLoopTaskEnvelopeV1);

  if (JSON.stringify(normalized).length > MAX_ENVELOPE_CHARS) {
    return fail('size');
  }
  return normalized;
}

export function isAgentLoopTaskEnvelope(
  input: unknown,
): input is AgentLoopTaskEnvelopeV1 {
  try {
    normalizeAgentLoopTaskEnvelope(input);
    return true;
  } catch {
    return false;
  }
}
