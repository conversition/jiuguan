/** Shared inert validation only. Each closed wrapper owns a separate mechanism
 * instance/WeakMap; constructing another instance cannot mint a Store grant. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopTaskEnvelope,
  type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord, AgentLoopArtifactRefDescriptor } from './agent-loop-projection-store.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';

export interface PreparedModelCorrectionData {
  readonly taskId: string; readonly expectedRevision: number; readonly initialEnvelopeDigest: string;
  readonly ownerId: string; readonly attemptId: string; readonly budget: AgentLoopTaskEnvelopeV1['budget'];
  readonly artifact: AgentLoopTaskEnvelopeV1['artifacts'][number]; readonly deadlineAt: string;
  readonly requiredBudget: AgentLoopTaskEnvelopeV1['budget']['granted']; readonly authorizeCommit: () => unknown;
}
export interface PreparedModelCorrectionInput {
  readonly store: AgentLoopProjectionStore; readonly record: AgentLoopTaskRecord; readonly ownerId: string;
  readonly attemptId: string; readonly budget: AgentLoopTaskEnvelopeV1['budget'];
  readonly artifact: AgentLoopTaskEnvelopeV1['artifacts'][number]; readonly deadlineAt: string;
  readonly requiredBudget: AgentLoopTaskEnvelopeV1['budget']['granted']; readonly authorizeCommit: () => unknown;
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const TASK = /^agentloop\.maintenance\.mjob_[a-f0-9]{32}$/u;
const ATTEMPT = /^attempt\.al\.[a-f0-9]{64}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

export function createPreparedModelCorrectionMechanism(kind: 'model-only' | 'proposal') {
  if (kind !== 'model-only' && kind !== 'proposal') throw new Error('agent-loop-prepared-model-correction-invalid');
  const version = kind === 'model-only' ? 'agent-loop-prepared-model-correction-v1' as const
    : 'agent-loop-prepared-model-correction-proposal-v1' as const;
  const error = kind === 'model-only' ? 'agent-loop-prepared-model-correction-invalid'
    : 'agent-loop-prepared-model-correction-proposal-invalid';
  const entries = new WeakMap<object, Readonly<{ store: AgentLoopProjectionStore;
    data: PreparedModelCorrectionData & { readonly artifactRef?: AgentLoopArtifactRefDescriptor } }>>();
  function reject(): never { throw new Error(error); }
  function sync(value: unknown): unknown {
    if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value, () => undefined, () => undefined); reject(); }
    return value;
  }
  function own(input: unknown, keys: readonly string[]): Record<string, unknown> {
    sync(input);
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) reject();
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
      sync(property.value);
    }
    return input as Record<string, unknown>;
  }
  function data(input: unknown, stack = new Set<object>()): unknown {
    sync(input);
    if (input === undefined || input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || stack.has(input)) reject();
    stack.add(input);
    try {
      if (Array.isArray(input)) {
        if (Reflect.ownKeys(input).length !== input.length + 1) reject();
        return Object.freeze(Array.from({ length: input.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
          return data(property.value, stack);
        }));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string') reject();
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
        Object.defineProperty(result, key, { value: data(property.value, stack), enumerable: true });
      }
      return Object.freeze(result);
    } finally { stack.delete(input); }
  }
  function time(value: unknown): string {
    sync(value);
    if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
    return value;
  }
  function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
  function vector(input: unknown): AgentLoopTaskEnvelopeV1['budget']['granted'] {
    const value = own(input, AGENT_LOOP_TASK_BUDGET_KEYS);
    if (AGENT_LOOP_TASK_BUDGET_KEYS.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) reject();
    return Object.freeze(Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, Number(value[key])]))) as AgentLoopTaskEnvelopeV1['budget']['granted'];
  }
  function initialRecord(input: unknown, ownerId: string): AgentLoopTaskRecord {
    const value = own(input, ['envelope', 'envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
    let envelope: AgentLoopTaskEnvelopeV1;
    try { envelope = normalizeAgentLoopTaskEnvelope(data(value.envelope)); } catch { return reject(); }
    const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
    if (value.fenced !== false || value.fenceReason !== null || value.ownerId !== ownerId || value.revision !== 1
      || envelope.revision !== 1 || !TASK.test(envelope.taskId) || envelope.rootTaskId !== envelope.taskId
      || envelope.parentTaskId !== undefined || envelope.state !== 'CREATED' || envelope.phase !== 'PREPARE'
      || envelope.currentAttemptId !== undefined || envelope.plan !== undefined || envelope.wait !== undefined || envelope.completion !== undefined
      || envelope.taskKind !== registration.taskKind || envelope.taskContractRef !== registration.contractRef
      || envelope.verifier.verifierSetRef !== registration.verifierSetRef || envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
      || envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
      || [envelope.dependencyTaskIds, envelope.todos, envelope.confirmedFacts, envelope.blockers, envelope.children, envelope.artifacts].some(items => items.length !== 0)
      || [envelope.budget.granted, envelope.budget.reserved, envelope.budget.spent].some(v => AGENT_LOOP_TASK_BUDGET_KEYS.some(key => v[key] !== 0))
      || typeof value.envelopeDigest !== 'string' || !HASH.test(value.envelopeDigest) || value.envelopeDigest !== hash(envelope)) reject();
    const leaseExpiresAt = time(value.leaseExpiresAt);
    if (leaseExpiresAt <= envelope.updatedAt) reject();
    return Object.freeze({ envelope, envelopeDigest: value.envelopeDigest, ownerId, leaseExpiresAt,
      fenced: false, fenceReason: null, revision: 1 });
  }
  function descriptor(input: unknown, current: AgentLoopTaskRecord, attemptId: string,
    artifact: AgentLoopTaskEnvelopeV1['artifacts'][number]): AgentLoopArtifactRefDescriptor {
    const value = own(input, ['refId', 'kind', 'ownerRef', 'expectedDigest', 'expectedRevision', 'policy', 'aclClass', 'expandBudgetTokens']);
    const claim = `sha256:${attemptId.slice('attempt.al.'.length)}`;
    if (value.refId !== artifact.artifactRef || !/^execution\.prepare:[a-f0-9]{64}$/u.test(artifact.artifactRef)
      || value.kind !== 'session-artifact' || value.ownerRef !== `maintenancejob.${current.envelope.taskId.slice('agentloop.maintenance.'.length)}`
      || value.expectedDigest !== `sha256:${artifact.artifactRef.slice('execution.prepare:'.length)}`
      || value.expectedRevision !== claim || value.policy !== 'required' || value.aclClass !== 'restricted'
      || value.expandBudgetTokens !== 0 || !artifact.evidenceRefs.includes(claim)) reject();
    return Object.freeze({ refId: value.refId, kind: 'session-artifact', ownerRef: value.ownerRef,
      expectedDigest: value.expectedDigest, expectedRevision: value.expectedRevision, policy: 'required', aclClass: 'restricted', expandBudgetTokens: 0 });
  }
  function create(input: PreparedModelCorrectionInput & { readonly artifactRef?: AgentLoopArtifactRefDescriptor }) {
    const value = own(input, ['store', 'record', 'ownerId', 'attemptId', 'budget', 'artifact', 'deadlineAt', 'requiredBudget', 'authorizeCommit',
      ...(kind === 'proposal' ? ['artifactRef'] : [])]);
    if (!value.store || typeof value.store !== 'object' || nodeTypes.isProxy(value.store)
      || typeof value.ownerId !== 'string' || !TOKEN.test(value.ownerId)
      || typeof value.attemptId !== 'string' || !ATTEMPT.test(value.attemptId)
      || typeof value.authorizeCommit !== 'function' || nodeTypes.isProxy(value.authorizeCommit)) reject();
    const current = initialRecord(value.record, value.ownerId), rawBudget = own(value.budget, ['policyRef', 'granted', 'reserved', 'spent']);
    const granted = vector(rawBudget.granted), reserved = vector(rawBudget.reserved), spent = vector(rawBudget.spent);
    const actions = kind === 'proposal' ? 1 : 0;
    if (rawBudget.policyRef !== current.envelope.budget.policyRef || granted.modelCalls !== 2
      || granted.toolCalls !== actions || granted.writes !== actions || granted.highRiskActions !== 0 || granted.childTasks !== 0
      || ['inputTokens', 'outputTokens', 'costMicrousd', 'wallMs'].some(key => granted[key as keyof typeof granted] < 1)
      || [reserved, spent].some(v => AGENT_LOOP_TASK_BUDGET_KEYS.some(key => v[key] !== 0))) reject();
    const requiredBudget = vector(value.requiredBudget);
    if (requiredBudget.modelCalls !== 1
      || ['inputTokens', 'outputTokens', 'costMicrousd', 'wallMs'].some(key => requiredBudget[key as keyof typeof requiredBudget] < 1)
      || ['toolCalls', 'writes', 'highRiskActions', 'childTasks'].some(key => requiredBudget[key as keyof typeof requiredBudget] !== 0)
      || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => requiredBudget[key] > granted[key])) reject();
    const artifactValue = own(value.artifact, ['artifactRef', 'kind', 'status', 'evidenceRefs']);
    if (artifactValue.kind !== 'agent-loop-execution-binding' || artifactValue.status !== 'declared') reject();
    const deadlineAt = time(value.deadlineAt);
    if (deadlineAt <= current.envelope.updatedAt) reject();
    const budget = Object.freeze({ policyRef: current.envelope.budget.policyRef, granted, reserved, spent });
    let artifact: AgentLoopTaskEnvelopeV1['artifacts'][number];
    try { artifact = normalizeAgentLoopTaskEnvelope({ ...current.envelope, state: 'RUNNING', phase: 'MODEL',
      currentAttemptId: value.attemptId, budget, artifacts: [data(artifactValue)], revision: 2 }).artifacts[0]!; }
    catch { return reject(); }
    const artifactRef = kind === 'proposal' ? descriptor(value.artifactRef, current, value.attemptId, artifact) : undefined;
    const result = Object.freeze({ contractVersion: version });
    entries.set(result, Object.freeze({ store: value.store as AgentLoopProjectionStore, data: Object.freeze({
      taskId: current.envelope.taskId, expectedRevision: current.revision, initialEnvelopeDigest: current.envelopeDigest,
      ownerId: value.ownerId, attemptId: value.attemptId, budget, artifact, deadlineAt, requiredBudget,
      authorizeCommit: value.authorizeCommit as () => unknown, ...(artifactRef ? { artifactRef } : {}),
    }) }));
    return result;
  }
  function consume(value: unknown, current: AgentLoopTaskRecord, ownerId: string, store: AgentLoopProjectionStore) {
    sync(value);
    if (!value || typeof value !== 'object') reject();
    const entry = entries.get(value); entries.delete(value);
    if (!entry || entry.store !== store || entry.data.ownerId !== ownerId) reject();
    const captured = initialRecord(current, ownerId), prepared = entry.data;
    if (captured.envelope.taskId !== prepared.taskId || captured.revision !== prepared.expectedRevision
      || captured.envelopeDigest !== prepared.initialEnvelopeDigest) reject();
    return prepared;
  }
  return Object.freeze({ create, consume });
}
