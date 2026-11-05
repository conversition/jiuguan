/** Independent, pure correction metadata. No claim, grant, lease, permit,
 * dispatch or retry is issued here. Original single-pass contracts are untouched.
 * The original Store must validate history and consume this policy at most once.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopTaskEnvelope,
  type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import type { AgentLoopTaskRecord } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF = 'contract.agent-loop.model-correction.once.v1' as const;
export const AGENT_LOOP_MODEL_CORRECTION_POLICY_VERSION = 'agent-loop-model-correction-policy-v1' as const;
export const AGENT_LOOP_MODEL_CORRECTION_POLICY_REF = 'policy.agent-loop.model-correction.once.v1' as const;
export const AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION = 'agent-loop-model-correction-state-v1' as const;
export interface AgentLoopModelCorrectionPolicy {
  readonly version: typeof AGENT_LOOP_MODEL_CORRECTION_POLICY_VERSION;
  readonly policyRef: typeof AGENT_LOOP_MODEL_CORRECTION_POLICY_REF;
  readonly taskContractRef: typeof AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF;
  readonly maxCorrections: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly initialRevision: number;
  readonly initialEnvelopeDigest: string;
  readonly immutableFrameDigest: string;
  readonly deadlineAt: string;
  readonly requiredBudget: AgentLoopTaskEnvelopeV1['budget']['granted'];
}
export interface AgentLoopModelCorrectionState {
  readonly version: typeof AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly envelopeDigest: string;
  readonly policyDigest: string | null;
  readonly initialRevision: number | null;
  readonly correctionsUsed: 0 | 1;
  readonly invocationAllowed: boolean;
  readonly readyRevision: number | null;
  readonly status: 'initial' | 'rejected' | 'ready' | 'blocked';
  readonly closedInvocationId: string | null;
  readonly snapshotDigest: string;
  readonly reasonCodes: readonly string[];
}

const POLICY_KEYS = Object.freeze(['version', 'policyRef', 'taskContractRef', 'maxCorrections', 'taskId', 'attemptId',
  'initialRevision', 'initialEnvelopeDigest', 'immutableFrameDigest', 'deadlineAt', 'requiredBudget']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
function invalid(): never { throw new Error('agent-loop-model-correction-invalid'); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  return input as Record<string, unknown>;
}
function own(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = object(input), actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid();
  }
  return value;
}
function selected(input: unknown, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(object(input), key);
  if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid();
  return field.value;
}
function dataOnly(input: unknown, stack = new Set<object>()): void {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'function' || typeof input === 'symbol') invalid();
    return;
  }
  if (nodeTypes.isProxy(input) || stack.has(input)) invalid();
  if (!Array.isArray(input)) object(input);
  stack.add(input);
  try { for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') invalid();
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !Object.hasOwn(field, 'value')) invalid();
    dataOnly(field.value, stack);
  } } finally { stack.delete(input); }
}
function token(input: unknown): string { if (typeof input !== 'string' || !TOKEN.test(input)) invalid(); return input; }
function digest(input: unknown): string { if (typeof input !== 'string' || !HASH.test(input)) invalid(); return input; }
function time(input: unknown): string {
  if (typeof input !== 'string' || !Number.isSafeInteger(Date.parse(input)) || new Date(input).toISOString() !== input) invalid();
  return input;
}
function hash(input: unknown): string {
  const canonical = (value: unknown): unknown => value !== null && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')}`;
}
function envelopeOf(record: AgentLoopTaskRecord): AgentLoopTaskEnvelopeV1 {
  const raw = selected(record, 'envelope'); dataOnly(raw);
  return normalizeAgentLoopTaskEnvelope(raw);
}

export function normalizeAgentLoopModelCorrectionPolicy(input: unknown): AgentLoopModelCorrectionPolicy {
  try {
    const value = own(input, POLICY_KEYS);
    if (value.version !== AGENT_LOOP_MODEL_CORRECTION_POLICY_VERSION || value.policyRef !== AGENT_LOOP_MODEL_CORRECTION_POLICY_REF
      || value.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF || value.maxCorrections !== 1
      || !Number.isSafeInteger(value.initialRevision) || Number(value.initialRevision) < 1) invalid();
    const required = own(value.requiredBudget, AGENT_LOOP_TASK_BUDGET_KEYS);
    for (const key of AGENT_LOOP_TASK_BUDGET_KEYS) {
      const minimum = ['inputTokens', 'outputTokens', 'costMicrousd', 'wallMs'].includes(key) ? 1 : 0;
      if (!Number.isSafeInteger(required[key]) || Number(required[key]) < minimum
        || key === 'modelCalls' && required[key] !== 1
        || ['toolCalls', 'writes', 'highRiskActions', 'childTasks'].includes(key) && required[key] !== 0) invalid();
    }
    const requiredBudget = Object.freeze(Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, Number(required[key])]))) as AgentLoopModelCorrectionPolicy['requiredBudget'];
    return Object.freeze({ version: AGENT_LOOP_MODEL_CORRECTION_POLICY_VERSION, policyRef: AGENT_LOOP_MODEL_CORRECTION_POLICY_REF,
      taskContractRef: AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, maxCorrections: 1, taskId: token(value.taskId), attemptId: token(value.attemptId),
      initialRevision: Number(value.initialRevision), initialEnvelopeDigest: digest(value.initialEnvelopeDigest),
      immutableFrameDigest: digest(value.immutableFrameDigest), deadlineAt: time(value.deadlineAt), requiredBudget });
  } catch { return invalid(); }
}
export function agentLoopModelCorrectionPolicyDigest(input: unknown): string {
  return hash(normalizeAgentLoopModelCorrectionPolicy(input));
}
/** Selected immutable task/budget frame only. Owner, lease, phase, state, current
 * revision/time, attempt and accumulated/reserved usage are deliberately absent.
 * The policy separately pins its original attempt and initial full envelope hash.
 */
export function agentLoopModelCorrectionFrameDigest(record: AgentLoopTaskRecord): string {
  try {
    const envelope = envelopeOf(record);
    return hash({ taskId: envelope.taskId, rootTaskId: envelope.rootTaskId, parentTaskId: envelope.parentTaskId ?? null,
      dependencyTaskIds: envelope.dependencyTaskIds, taskKind: envelope.taskKind, taskContractRef: envelope.taskContractRef,
      verifier: envelope.verifier, goal: envelope.goal, createdAt: envelope.createdAt,
      budget: { policyRef: envelope.budget.policyRef, granted: envelope.budget.granted } });
  } catch { return invalid(); }
}
/** Pure initial metadata builder. It neither establishes that this is the
 * first invocation nor validates live owner/source/history: the Store does.
 */
export function createAgentLoopModelCorrectionPolicy(input: Readonly<{
  record: AgentLoopTaskRecord; deadlineAt: string; requiredBudget: AgentLoopModelCorrectionPolicy['requiredBudget'];
}>): AgentLoopModelCorrectionPolicy {
  try {
    const value = own(input, ['record', 'deadlineAt', 'requiredBudget']), record = value.record as AgentLoopTaskRecord;
    const envelope = envelopeOf(record), revision = selected(record, 'revision'), envelopeDigest = digest(selected(record, 'envelopeDigest'));
    if (selected(record, 'fenced') !== false || envelope.state !== 'RUNNING' || envelope.phase !== 'MODEL'
      || envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF || !envelope.currentAttemptId
      || revision !== envelope.revision || envelopeDigest !== `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`
      || envelope.budget.granted.modelCalls !== 2
      || [envelope.budget.spent, envelope.budget.reserved].some(vector => AGENT_LOOP_TASK_BUDGET_KEYS.some(key => vector[key] !== 0))) invalid();
    const deadlineAt = time(value.deadlineAt);
    if (deadlineAt <= envelope.updatedAt) invalid();
    return normalizeAgentLoopModelCorrectionPolicy({ version: AGENT_LOOP_MODEL_CORRECTION_POLICY_VERSION,
      policyRef: AGENT_LOOP_MODEL_CORRECTION_POLICY_REF, taskContractRef: AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF,
      maxCorrections: 1, taskId: envelope.taskId, attemptId: envelope.currentAttemptId, initialRevision: revision,
      initialEnvelopeDigest: envelopeDigest, immutableFrameDigest: agentLoopModelCorrectionFrameDigest(record),
      deadlineAt, requiredBudget: value.requiredBudget });
  } catch { return invalid(); }
}
/** Metadata continuity check, not a live lease/source or retry authorization.
 * The original Store must still verify spend/history and the pinned full hash.
 */
export function assertAgentLoopModelCorrectionPolicyBinding(input: unknown, record: AgentLoopTaskRecord): AgentLoopModelCorrectionPolicy {
  try {
    const policy = normalizeAgentLoopModelCorrectionPolicy(input), envelope = envelopeOf(record);
    if (policy.taskId !== envelope.taskId || policy.attemptId !== envelope.currentAttemptId
      || envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
      || policy.immutableFrameDigest !== agentLoopModelCorrectionFrameDigest(record)
      || envelope.revision < policy.initialRevision || envelope.budget.granted.modelCalls !== 2
      || selected(record, 'revision') !== envelope.revision
      || selected(record, 'envelopeDigest') !== `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`) invalid();
    if (envelope.revision === policy.initialRevision && selected(record, 'envelopeDigest') !== policy.initialEnvelopeDigest) invalid();
    return policy;
  } catch { return invalid(); }
}
