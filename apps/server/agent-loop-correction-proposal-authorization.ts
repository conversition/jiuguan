/** Independent initial shadow-correction proposal preauthorization. Only a real
 * same-CAS initial grant can finalize this in-memory brand. Its one-use ACT
 * exchange requires the original successful-slot lineage and live
 * MODEL brands. It never dispatches an Action. Disk evidence grants nothing. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopTaskEnvelope, normalizeAgentLoopDecision } from '@jiuguan/agent-loop-contract';
import { AgentLoopProjectionStore, agentLoopProjectionEventDigest,
  type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type { AgentLoopMaintenanceCorrectionPrepareCurrent } from './agent-loop-maintenance-correction-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import { createAgentLoopMaintenanceExecutionBindingDescriptor } from './agent-loop-rolling-summary-artifacts.ts';
import { agentLoopMaintenanceBindingRef } from './agent-loop-get-variables-authorization.ts';
import { isPristineShadowProjection } from './agent-loop-turnjob-shadow.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, assertAgentLoopModelCorrectionPolicyBinding,
  agentLoopModelCorrectionPolicyDigest, type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';

export interface AgentLoopCorrectionProposalAuthorization {
  readonly contractVersion: 'agent-loop-correction-proposal-authorization-v1';
}
export interface AgentLoopCorrectionProposalCapability {
  readonly contractVersion: 'agent-loop-correction-proposal-capability-v1';
}
export interface AgentLoopCorrectionProposalAuthorizationOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  readonly readCurrent: () => AgentLoopMaintenanceCorrectionPrepareCurrent | null;
}
type Budget = AgentLoopTaskRecord['envelope']['budget'];
interface AuthorizationData {
  readonly options: AgentLoopCorrectionProposalAuthorizationOptions;
  readonly initial: AgentLoopTaskRecord;
  readonly sessionIdentity: object;
  readonly sourceDigest: string;
  readonly bindingRef: string;
  readonly descriptor: ReturnType<typeof createAgentLoopMaintenanceExecutionBindingDescriptor>;
  readonly attemptId: string;
  readonly claimDigest: string;
  readonly deadlineAt: string;
  readonly budget: Budget;
  readonly evidenceDigest: string;
}
interface CapabilityData { readonly authorization: AuthorizationData; readonly record: AgentLoopTaskRecord;
  readonly policy: AgentLoopModelCorrectionPolicy; }
const authorizations = new WeakMap<object, AuthorizationData>();
const capabilities = new WeakMap<object, CapabilityData>();
const finalized = new WeakMap<AgentLoopProjectionStore, Set<string>>();
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function reject(): never { throw new Error('agent-loop-correction-proposal-authorization-invalid'); }
function sync(value: unknown): void {
  if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value, () => undefined, () => undefined); reject(); }
}
function own(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  sync(input);
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
  const keys = Reflect.ownKeys(input);
  if (required.some(key => !Object.hasOwn(input, key)) || keys.some(key => typeof key !== 'string'
    || !required.includes(key) && !optional.includes(key))) reject();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) reject();
    sync(field.value);
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
        const field = Object.getOwnPropertyDescriptor(input, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) reject();
        return data(field.value, stack);
      }));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !field?.enumerable || !Object.hasOwn(field, 'value')) reject();
      Object.defineProperty(result, key, { value: data(field.value, stack), enumerable: true });
    }
    return Object.freeze(result);
  } finally { stack.delete(input); }
}
function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function at(options: AgentLoopCorrectionProposalAuthorizationOptions): string {
  let stopped: boolean;
  try { stopped = aborted.call(options.signal); } catch { return reject(); }
  const now = options.clock();
  sync(now);
  if (stopped || typeof now !== 'string' || !Number.isSafeInteger(Date.parse(now))
    || new Date(now).toISOString() !== now) reject();
  return now;
}
function capture(options: AgentLoopCorrectionProposalAuthorizationOptions) {
  const before = at(options), raw = own(options.readCurrent(), ['execution', 'source']);
  const execution = data(raw.execution) as AgentLoopMaintenanceCorrectionPrepareCurrent['execution'];
  const original = own(raw.source, ['job', 'snapshot', 'profile', 'sessionIdentity'], ['hostDispatchGuarded']);
  if (!original.sessionIdentity || typeof original.sessionIdentity !== 'object' || nodeTypes.isProxy(original.sessionIdentity)
    || Object.hasOwn(original, 'hostDispatchGuarded') && original.hostDispatchGuarded !== true) reject();
  const snapshot = own(original.snapshot, ['revision', 'state', 'userMessage'],
    ['proposalContext', 'providerProposalContext', 'strictContextUnavailableReason', 'readMemory']);
  const source = { job: data(original.job), profile: data(original.profile), sessionIdentity: original.sessionIdentity,
    snapshot: data(Object.fromEntries(Object.keys(snapshot).filter(key => key !== 'readMemory').map(key => [key, snapshot[key]])))
  } as AgentLoopMaintenanceCorrectionPrepareCurrent['source'];
  const profile = resolveAgentLoopMaintenanceProfile(source), fixedSnapshot = validateAgentLoopMaintenanceSnapshot(source);
  const now = at(options), goal = resolveAgentLoopRollingSummaryGoal({ execution, now });
  const deadlineMs = Date.parse(goal.binding.startedAt) + profile.budgetProfile.maxWallMs;
  if (now < before || goal.mode !== 'shadow' || goal.binding.ownerId !== options.ownerId
    || hash(source.job) !== hash(execution.job) || source.snapshot.revision !== execution.job.sourceRevision
    || profile.budgetProfile.maxModelCalls !== 1 || profile.budgetProfile.maxToolCalls < 1 || profile.budgetProfile.maxWrites < 1
    || !Number.isSafeInteger(deadlineMs) || !Number.isFinite(new Date(deadlineMs).getTime()) || Date.parse(now) >= deadlineMs) reject();
  return { execution, source, goal, profile, now, deadlineAt: new Date(deadlineMs).toISOString(),
    sourceDigest: hash({ claim: goal.claimDigest, profile, snapshot: fixedSnapshot }) };
}
function fresh(entry: AuthorizationData) {
  const current = capture(entry.options);
  if (current.source.sessionIdentity !== entry.sessionIdentity || current.sourceDigest !== entry.sourceDigest
    || current.deadlineAt !== entry.deadlineAt || current.goal.attemptId !== entry.attemptId
    || agentLoopMaintenanceBindingRef(current.execution, current.source) !== entry.bindingRef) reject();
  return current;
}
function actual(entry: AuthorizationData, supplied: AgentLoopTaskRecord): AgentLoopTaskRecord {
  const safe = data(supplied) as AgentLoopTaskRecord, record = entry.options.store.read(entry.initial.envelope.taskId);
  if (!record || hash(record) !== hash(safe) || record.fenced || record.ownerId !== entry.options.ownerId
    || !record.leaseExpiresAt || record.leaseExpiresAt <= at(entry.options)
    || record.envelopeDigest !== hash(record.envelope)) reject();
  return record;
}

export function issueAgentLoopCorrectionProposalAuthorization(
  options: AgentLoopCorrectionProposalAuthorizationOptions,
): AgentLoopCorrectionProposalAuthorization {
  own(options, ['store', 'ownerId', 'clock', 'signal', 'readCurrent']);
  if (nodeTypes.isProxy(options.store) || !(options.store instanceof AgentLoopProjectionStore)
    || typeof options.ownerId !== 'string' || !TOKEN.test(options.ownerId)
    || typeof options.clock !== 'function' || nodeTypes.isProxy(options.clock)
    || typeof options.readCurrent !== 'function' || nodeTypes.isProxy(options.readCurrent)
    || !options.signal || nodeTypes.isProxy(options.signal)) reject();
  const fixedOptions = Object.freeze({ ...options }), source = capture(fixedOptions), record = options.store.read(source.goal.taskId);
  if (!record || record.revision !== 1 || record.ownerId !== options.ownerId || !record.leaseExpiresAt
    || record.leaseExpiresAt <= source.now || !isPristineShadowProjection(options.store, record)
    || record.envelope.taskKind !== source.goal.taskKind || record.envelope.taskContractRef !== source.goal.contractRef
    || record.envelope.verifier.verifierSetRef !== source.goal.verifierSetRef
    || record.envelope.verifier.verifierSetRevision !== source.goal.verifierSetRevision
    || hash(record.envelope.goal.sourceRefs) !== hash([`maintenancejob.${source.goal.binding.runId}`,
      `revision.${source.goal.binding.sourceRevision}`])) reject();
  const zero = Object.freeze(Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, 0]))) as Budget['granted'];
  const profile = source.profile.budgetProfile;
  const budget = Object.freeze({ policyRef: record.envelope.budget.policyRef, reserved: zero, spent: zero,
    granted: Object.freeze({ ...zero, modelCalls: 2, toolCalls: 1, writes: 1, inputTokens: profile.agentInputBudgetTokens,
      outputTokens: profile.agentOutputBudgetTokens, costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs }) });
  const descriptor = createAgentLoopMaintenanceExecutionBindingDescriptor(source.execution, source.source);
  const evidenceDigest = hash({ version: 'agent-loop-correction-proposal-authorization-v1', ownerId: options.ownerId,
    initialDigest: record.envelopeDigest, sourceDigest: source.sourceDigest, deadlineAt: source.deadlineAt, budget, descriptor });
  const result = Object.freeze({ contractVersion: 'agent-loop-correction-proposal-authorization-v1' as const });
  authorizations.set(result, Object.freeze({ options: fixedOptions, initial: record, sessionIdentity: source.source.sessionIdentity,
    sourceDigest: source.sourceDigest, bindingRef: descriptor.refId, descriptor, attemptId: source.goal.attemptId,
    claimDigest: source.goal.claimDigest, deadlineAt: source.deadlineAt, budget, evidenceDigest }));
  return result;
}
export function agentLoopCorrectionProposalAuthorizationEvidence(value: unknown, record: AgentLoopTaskRecord, ownerId: string): string {
  sync(value);
  const entry = value !== null && typeof value === 'object' ? authorizations.get(value) : undefined;
  if (!entry || ownerId !== entry.options.ownerId) reject();
  fresh(entry); const current = actual(entry, record);
  if (current.revision !== 1 || current.envelopeDigest !== entry.initial.envelopeDigest
    || !isPristineShadowProjection(entry.options.store, current)) reject();
  return entry.evidenceDigest;
}
function verifyInitial(entry: AuthorizationData, supplied: AgentLoopTaskRecord, inputPolicy: unknown) {
  fresh(entry); const record = actual(entry, supplied), task = record.envelope;
  const policy = assertAgentLoopModelCorrectionPolicyBinding(inputPolicy, record);
  if (record.revision !== 2 || task.phase !== 'MODEL' || task.state !== 'RUNNING'
    || task.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF || task.currentAttemptId !== entry.attemptId
    || task.budget.policyRef !== entry.budget.policyRef
    || ['granted', 'reserved', 'spent'].some(vector => AGENT_LOOP_TASK_BUDGET_KEYS.some(key =>
      task.budget[vector as keyof Pick<Budget, 'granted' | 'reserved' | 'spent'>][key]
        !== entry.budget[vector as keyof Pick<Budget, 'granted' | 'reserved' | 'spent'>][key]))
    || policy.initialRevision !== 2
    || policy.initialEnvelopeDigest !== record.envelopeDigest || policy.deadlineAt !== entry.deadlineAt) reject();
  const minimum = { modelCalls: 1, toolCalls: 0, writes: 0, inputTokens: 1, outputTokens: 1,
    costMicrousd: 1, wallMs: 1, highRiskActions: 0, childTasks: 0 };
  if (AGENT_LOOP_TASK_BUDGET_KEYS.some(key => policy.requiredBudget[key] !== minimum[key])) reject();
  const artifact = task.artifacts[0];
  if (task.artifacts.length !== 1 || !artifact || artifact.kind !== 'agent-loop-execution-binding' || artifact.status !== 'declared'
    || artifact.artifactRef !== entry.bindingRef || !artifact.evidenceRefs.includes(entry.evidenceDigest)
    || !artifact.evidenceRefs.includes(entry.claimDigest)) reject();
  const expected = normalizeAgentLoopTaskEnvelope({ ...entry.initial.envelope, taskContractRef: AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF,
    currentAttemptId: entry.attemptId, state: 'RUNNING', phase: 'MODEL', budget: entry.budget,
    artifacts: [artifact], revision: 2, updatedAt: task.updatedAt });
  if (hash(expected) !== record.envelopeDigest) reject();
  const state = entry.options.store.readModelCorrectionState({ taskId: task.taskId, expectedRevision: 2, policy });
  if (state.status !== 'initial' || !state.invocationAllowed || state.correctionsUsed !== 0) reject();
  const refs = entry.options.store.readRefs(task.taskId), ref = refs[0];
  if (refs.length !== 1 || !ref || ref.taskRevision !== 2 || ref.registeredAt !== task.updatedAt
    || Object.keys(entry.descriptor).some(key => ref[key as keyof typeof ref] !== entry.descriptor[key as keyof typeof entry.descriptor])) reject();
  const events = entry.options.store.readEvents(task.taskId), event = events[1];
  if (events.length !== 5 || !event || event.eventId !== `ref-registered:${entry.bindingRef}` || event.kind !== 'ref-registered'
    || event.revision !== 2 || event.reasonCode !== undefined || event.acceptedAt !== task.updatedAt
    || event.eventDigest !== agentLoopProjectionEventDigest({ taskId: task.taskId, revision: 2, eventId: event.eventId,
      kind: 'ref-registered', reasonCode: null, envelopeDigest: record.envelopeDigest })) reject();
  fresh(entry); actual(entry, record);
  return Object.freeze({ record, policy });
}
/** Burn the initial brand before validation. A failed handoff cannot be retried
 * or reconstructed from the committed descriptor, policy hash or serialized DTO. */
export function finalizeAgentLoopCorrectionProposalAuthorization(value: unknown,
  input: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>): AgentLoopCorrectionProposalCapability {
  sync(value);
  const entry = value !== null && typeof value === 'object' ? authorizations.get(value) : undefined;
  if (value !== null && typeof value === 'object') authorizations.delete(value);
  if (!entry) reject();
  const selected = own(input, ['record', 'policy']), initial = verifyInitial(entry, selected.record as AgentLoopTaskRecord, selected.policy);
  // Multiple genuine declarations before the same CAS are not multiple live
  // handoffs. Revoking/loss of the returned brand never clears this tombstone.
  const key = `${entry.initial.envelope.taskId}:${entry.initial.envelopeDigest}`;
  const previous = finalized.get(entry.options.store) ?? new Set<string>();
  if (previous.has(key)) reject();
  previous.add(key); finalized.set(entry.options.store, previous);
  const result = Object.freeze({ contractVersion: 'agent-loop-correction-proposal-capability-v1' as const });
  capabilities.set(result, Object.freeze({ authorization: entry, ...initial }));
  return result;
}
/** Non-consuming initial-r2 continuity only; neither a MODEL permit nor an ACT
 * exchange. A reservation, later revision, changed source or reopen is refused. */
export function assertAgentLoopCorrectionProposalInitialCapability(value: unknown,
  input: Readonly<{ store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>): void {
  sync(value);
  const entry = value !== null && typeof value === 'object' ? capabilities.get(value) : undefined;
  if (!entry) reject();
  own(input, ['store', 'ownerId', 'record', 'policy']);
  if (input.store !== entry.authorization.options.store || input.ownerId !== entry.authorization.options.ownerId
    || agentLoopModelCorrectionPolicyDigest(input.policy) !== agentLoopModelCorrectionPolicyDigest(entry.policy)) reject();
  verifyInitial(entry.authorization, input.record, input.policy);
}

/** Non-consuming MODEL continuity under the same initial capability. Only the
 * original Core's separate invocation permit can enter a fresh physical call;
 * this assertion neither issues a permit nor consumes ACT's one-use exchange. */
export function assertAgentLoopCorrectionProposalModelCapability(value: unknown,
  input: Readonly<{ store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>): void {
  sync(value);
  const entry = value !== null && typeof value === 'object' ? capabilities.get(value) : undefined;
  if (!entry) reject();
  own(input, ['store', 'ownerId', 'record', 'policy']);
  const authorization = entry.authorization;
  if (input.store !== authorization.options.store || input.ownerId !== authorization.options.ownerId
    || agentLoopModelCorrectionPolicyDigest(input.policy) !== agentLoopModelCorrectionPolicyDigest(entry.policy)) reject();
  fresh(authorization); const record = actual(authorization, input.record), task = record.envelope;
  assertAgentLoopModelCorrectionPolicyBinding(entry.policy, record);
  if (task.phase !== 'MODEL' || task.state !== 'RUNNING' || record.revision !== 2 && record.revision !== 4
    || task.currentAttemptId !== authorization.attemptId || hash(task.artifacts) !== hash(entry.record.envelope.artifacts)
    || hash(task.budget.granted) !== hash(authorization.budget.granted) || task.budget.policyRef !== authorization.budget.policyRef
    || Object.values(task.budget.reserved).some(amount => amount !== 0)) reject();
  const state = input.store.readModelCorrectionState({ taskId: task.taskId, expectedRevision: record.revision, policy: entry.policy });
  const first = record.revision === 2, spent = task.budget.spent;
  if (state.version !== 'agent-loop-model-correction-state-v1' || state.taskId !== task.taskId || state.taskRevision !== record.revision
    || state.envelopeDigest !== record.envelopeDigest || state.policyDigest !== agentLoopModelCorrectionPolicyDigest(entry.policy)
    || state.initialRevision !== 2 || state.reasonCodes.length !== 1 || state.reasonCodes[0] !== `correction-${state.status}`
    || (first ? state.correctionsUsed !== 0 || state.readyRevision !== null || state.closedInvocationId !== null
        || Object.values(spent).some(amount => amount !== 0)
      : state.correctionsUsed !== 1 || state.readyRevision !== 4
        || state.closedInvocationId !== (state.status === 'ready' ? agentLoopModelInvocationId({ taskId: task.taskId,
          attemptId: authorization.attemptId, expectedTaskRevision: 2 }) : null) || spent.modelCalls !== 1
        || spent.inputTokens <= 0 || spent.outputTokens <= 0
        || ['toolCalls', 'writes', 'highRiskActions', 'childTasks'].some(key => spent[key as keyof typeof spent] !== 0))) reject();
  const events = input.store.readEvents(task.taskId), refs = input.store.readRefs(task.taskId);
  const invocationId = agentLoopModelInvocationId({ taskId: task.taskId, attemptId: authorization.attemptId, expectedTaskRevision: record.revision });
  const reserved = events.find(event => event.eventId === `model-invocation:${invocationId}`);
  if (refs.length !== 1 || !refs[0] || refs[0].taskRevision !== 2 || refs[0].registeredAt !== entry.record.envelope.updatedAt
    || Object.keys(authorization.descriptor).some(key => refs[0]![key as keyof typeof refs[0]] !== authorization.descriptor[key as keyof typeof authorization.descriptor])
    || events.some(event => event.kind.startsWith('action-') || event.eventId.startsWith('action-'))
    || input.store.readQuarantine().some(row => row.task_id === task.taskId)) reject();
  if (reserved) {
    if (reserved.kind !== 'model-invocation-reserved' || reserved.revision !== record.revision || reserved.reasonCode !== undefined
      || reserved.eventDigest !== agentLoopProjectionEventDigest({ taskId: task.taskId, revision: record.revision,
        eventId: reserved.eventId, kind: 'model-invocation-reserved', reasonCode: null, envelopeDigest: record.envelopeDigest })
      || state.status !== 'blocked' || state.invocationAllowed) reject();
  } else if (state.status !== (first ? 'initial' : 'ready') || !state.invocationAllowed) reject();
  const validationEvents = events.filter(event => event.kind.startsWith('model-summary-validation-rejected-')
    || event.eventId.startsWith('summary-validation-'));
  if (validationEvents.length) {
    if (first || validationEvents.length !== 1) reject();
    // Only a Store-verified fact for the original rejected invocation can
    // extend this exact history shape; arbitrary extra events still fail.
    const detail = input.store.readModelSummaryValidationRejection({ taskId: task.taskId,
      attemptId: authorization.attemptId, modelRevision: 2 });
    const event = validationEvents[0]!;
    if (detail.status !== 'recorded' || !detail.rejection
      || detail.invocationId !== agentLoopModelInvocationId({ taskId: task.taskId,
        attemptId: authorization.attemptId, expectedTaskRevision: 2 })
      || event.kind !== 'model-summary-validation-rejected-v1' || event.revision !== 3
      || !event.eventId.startsWith('summary-validation-v1:') || event.reasonCode !== detail.rejection.code) reject();
  }
  if (events.length !== (first ? 5 : 9) + (reserved ? 1 : 0) + validationEvents.length) reject();
  fresh(authorization); const final = actual(authorization, record);
  if (capabilities.get(value as object) !== entry || final.envelopeDigest !== record.envelopeDigest
    || final.revision !== record.revision || at(authorization.options) >= entry.policy.deadlineAt) reject();
}
/** Burn first, including wrong owner/Store, malformed data, cancellation and
 * SQL failures. A true result belongs only to this live caller; it is not a
 * serializable authority or an Action result. The original Action hold must
 * still provide physical once-only execution when an adapter is installed. */
export function consumeAgentLoopCorrectionProposalCapability(value: unknown, input: Readonly<{
  store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord;
  policy: AgentLoopModelCorrectionPolicy; modelRecord: AgentLoopTaskRecord;
  modelOutcome: unknown; decision: unknown; rejectedModelOutcome?: unknown;
}>): boolean {
  const entry = value !== null && typeof value === 'object' ? capabilities.get(value) : undefined;
  if (value !== null && typeof value === 'object') capabilities.delete(value);
  try {
    sync(value);
    if (!entry) return false;
    own(input, ['store', 'ownerId', 'record', 'policy', 'modelRecord', 'modelOutcome', 'decision'], ['rejectedModelOutcome']);
    const authorization = entry.authorization;
    if (input.store !== authorization.options.store || input.ownerId !== authorization.options.ownerId
      || agentLoopModelCorrectionPolicyDigest(input.policy) !== agentLoopModelCorrectionPolicyDigest(entry.policy)) return false;
    const decision = normalizeAgentLoopDecision(data(input.decision));
    const modelRecord = data(input.modelRecord) as AgentLoopTaskRecord;
    const source = fresh(authorization), current = actual(authorization, input.record);
    assertAgentLoopModelCorrectionPolicyBinding(entry.policy, current);
    if (current.envelope.phase !== 'ACT' || current.envelope.state !== 'RUNNING'
      || hash(current.envelope.artifacts) !== hash(entry.record.envelope.artifacts)
      || decision.kind !== 'act' || decision.taskId !== current.envelope.taskId
      || decision.attemptId !== authorization.attemptId || decision.taskContractRef !== entry.policy.taskContractRef
      || decision.harnessRunId !== source.goal.binding.runId
      || decision.actionContractRef !== 'action.maintenance.propose_rolling_summary.v1') return false;
    const read = () => authorization.options.store.readModelCorrectionActionLineage({
      taskId: current.envelope.taskId, expectedRevision: current.revision, ownerId: authorization.options.ownerId,
      policy: entry.policy, modelRecord, modelOutcome: input.modelOutcome,
      ...(Object.hasOwn(input, 'rejectedModelOutcome') ? { rejectedModelOutcome: input.rejectedModelOutcome } : {}),
    });
    const first = read();
    const match = (lineage: ReturnType<typeof read>) => {
      if (lineage.version !== 'agent-loop-model-correction-action-lineage-v1'
        || lineage.taskId !== current.envelope.taskId || lineage.taskRevision !== current.revision
        || lineage.envelopeDigest !== current.envelopeDigest
        || lineage.policyDigest !== agentLoopModelCorrectionPolicyDigest(entry.policy)
        || lineage.decisionDigest !== hash(decision) || lineage.modelRevision !== decision.expectedTaskRevision
        || (lineage.modelRevision === 2 ? lineage.taskRevision !== 3 || lineage.modelCallsUsed !== 1
          : lineage.modelRevision !== 4 || lineage.taskRevision !== 5 || lineage.modelCallsUsed !== 2)) reject();
    };
    match(first);
    // The fresh source callback is outside the AL transaction and must not
    // reopen/reacquire anything. A second original snapshot read catches any
    // intervening task/history change before returning this one-use decision.
    fresh(authorization); actual(authorization, current);
    const final = read(); match(final);
    if (hash(first) !== hash(final) || aborted.call(authorization.options.signal)) return false;
    return true;
  } catch { return false; }
}
export function revokeAgentLoopCorrectionProposalCapability(value: unknown): void {
  if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value, () => undefined, () => undefined); return; }
  if (value !== null && typeof value === 'object') capabilities.delete(value);
}
