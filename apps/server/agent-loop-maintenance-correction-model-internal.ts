/** Isolated, host-only Maintenance MODEL correction component.
 * The caller supplies an explicitly pre-granted MODEL task under the separate
 * correction contract. This does not implement Prepare, Runtime selection,
 * Summary ACT, completion, admission or a replacement Runner.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AGENT_LOOP_TASK_BUDGET_KEYS } from '@jiuguan/agent-loop-contract';
import type { AgentBudgetProfileV2 } from '../../packages/agent-policy/public/budget-profile.ts';
import type { AdmittedMaintenanceModelHandle } from './admitted-maintenance-model.ts';
import { agentLoopModelInvocationId, type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { assertAgentLoopMaintenancePreparedBinding } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { assertAgentLoopMaintenanceModelRecord, createAgentLoopMaintenanceModel,
  type AgentLoopMaintenanceModelSource } from './agent-loop-maintenance-model.ts';
import { deriveAgentLoopModelCallBudget } from './agent-loop-model-call-budget.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, assertAgentLoopModelCorrectionPolicyBinding,
  createAgentLoopModelCorrectionPolicy, normalizeAgentLoopModelCorrectionPolicy,
  agentLoopModelCorrectionPolicyDigest, type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import { consumeAgentLoopModelInvocationPermit, type AgentLoopModelAdmissionScope } from './agent-loop-model-invocation-permit.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import { assertAgentLoopCorrectionProposalModelCapability,
  type AgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';
import { isAgentLoopModelProtocolRejectionReason, readAgentLoopModelOutcome } from './agent-loop-model-outcome.ts';

export interface AgentLoopMaintenanceCorrectionModelCurrent {
  readonly execution: MaintenanceExecutionRecord;
  readonly source: AgentLoopMaintenanceModelSource;
}
export interface AgentLoopMaintenanceCorrectionModelOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  /** Actual Manager / loaded Session / policy / control readback. Must be synchronous. */
  readonly readCurrent: () => AgentLoopMaintenanceCorrectionModelCurrent | null;
  /** Trusted host port; creates one original admitted handle, never a raw Provider.
   * Install both assertions in the existing Gateway, including after async prep.
   * If construction throws before returning, this port owns its partial cleanup.
   */
  readonly createHandle: (input: Readonly<{
    execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceModelSource;
    record: AgentLoopTaskRecord; callBudgetProfile: AgentBudgetProfileV2;
    admissionScope: AgentLoopModelAdmissionScope;
    assertCurrent: () => void; assertDispatch: () => void;
  }>) => AdmittedMaintenanceModelHandle;
  /** Original full policy body is required for cold reconstruction, not a report/digest. */
  readonly policy?: AgentLoopModelCorrectionPolicy;
}

const REJECTED = 'agent-loop-maintenance-correction-model-rejected';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
function reject(): never { throw new Error(REJECTED); }
function sync(input: unknown): void {
  if (nodeTypes.isPromise(input)) { void Promise.prototype.then.call(input, () => undefined, () => undefined); reject(); }
}
function object(input: unknown): Record<string, unknown> {
  sync(input);
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
  return input as Record<string, unknown>;
}
function own(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = object(input), keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== 'string'
    || !required.includes(key) && !optional.includes(key))) reject();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
    sync(descriptor.value);
  }
  return value;
}
/** Reject getters, proxies, functions and cycles before a validator/hash can see them. */
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
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
        return data(descriptor.value, stack);
      }));
    }
    const value = object(input), result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') reject();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
      Object.defineProperty(result, key, { value: data(descriptor.value, stack), enumerable: true });
    }
    return Object.freeze(result);
  } finally { stack.delete(input); }
}
function digest(input: unknown): string {
  const canonical = (value: unknown): unknown => value !== null && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')}`;
}
function time(input: unknown): string {
  sync(input);
  if (typeof input !== 'string' || !Number.isSafeInteger(Date.parse(input)) || new Date(input).toISOString() !== input) reject();
  return input;
}

export function createAgentLoopMaintenanceCorrectionModelMechanism(options: AgentLoopMaintenanceCorrectionModelOptions & { readonly proposalCapability?: AgentLoopCorrectionProposalCapability }, kind: 'model-only' | 'shadow-proposal'): Readonly<{
  policy: AgentLoopModelCorrectionPolicy;
  modelCorrection: NonNullable<AgentLoopCoordinatorPorts['modelCorrection']>;
  decide: AgentLoopCoordinatorPorts['decide'];
}> {
  if (kind !== 'model-only' && kind !== 'shadow-proposal') reject();
  const proposal = kind === 'shadow-proposal';
  const selected = own(options, ['store', 'ownerId', 'clock', 'signal', 'readCurrent', 'createHandle',
    ...(proposal ? ['policy', 'proposalCapability'] : [])], proposal ? [] : ['policy']);
  const proposalCapability = proposal ? selected.proposalCapability as AgentLoopCorrectionProposalCapability : undefined;
  const { store, ownerId, clock, signal, readCurrent, createHandle } = options;
  if (!store || typeof store !== 'object' || nodeTypes.isProxy(store) || typeof ownerId !== 'string' || !TOKEN.test(ownerId)
    || typeof clock !== 'function' || typeof readCurrent !== 'function' || typeof createHandle !== 'function'
    || proposal && [clock, readCurrent, createHandle].some(value => nodeTypes.isProxy(value))
    || !signal || nodeTypes.isProxy(signal) || typeof signal.aborted !== 'boolean') reject();
  const at = () => time(clock());
  const capture = () => {
    const now = at();
    if (signal.aborted) reject();
    const result = readCurrent();
    if (nodeTypes.isPromise(result)) {
      void Promise.prototype.then.call(result, () => undefined, () => undefined);
      reject();
    }
    const raw = own(result, ['execution', 'source']);
    const execution = data(raw.execution) as MaintenanceExecutionRecord;
    const original = own(raw.source, ['job', 'snapshot', 'profile', 'sessionIdentity', 'hostDispatchGuarded']);
    if (original.hostDispatchGuarded !== true || !original.sessionIdentity || typeof original.sessionIdentity !== 'object'
      || nodeTypes.isProxy(original.sessionIdentity)) reject();
    const snapshot = own(original.snapshot, ['revision', 'state', 'userMessage'],
      ['proposalContext', 'providerProposalContext', 'strictContextUnavailableReason', 'readMemory']);
    // An optional read port is never invoked, hashed, persisted or dispatched here.
    const snapshotData = Object.fromEntries(Object.keys(snapshot).filter(key => key !== 'readMemory').map(key => [key, snapshot[key]]));
    const source = Object.freeze({ job: data(original.job), snapshot: data(snapshotData), profile: data(original.profile),
      sessionIdentity: original.sessionIdentity, hostDispatchGuarded: true }) as AgentLoopMaintenanceModelSource;
    const goal = resolveAgentLoopRollingSummaryGoal({ execution, now });
    if (execution.leaseOwnerInstanceId !== ownerId || digest(source.job) !== digest(execution.job)
      || source.snapshot.revision !== execution.job.sourceRevision) reject();
    const profile = resolveAgentLoopMaintenanceProfile(source), fixedSnapshot = validateAgentLoopMaintenanceSnapshot(source);
    if (profile.budgetProfile.maxModelCalls !== 1) reject();
    const deadlineMs = Date.parse(execution.job.startedAt!) + profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(deadlineMs) || !Number.isFinite(new Date(deadlineMs).getTime()) || Date.parse(now) >= deadlineMs) reject();
    return { execution, source, goal, profile, fixedSnapshot, deadlineMs, now };
  };
  const first = capture(), sessionIdentity = first.source.sessionIdentity;
  if (first.goal.mode !== 'shadow') reject();
  const sourceDigest = digest({ claimDigest: first.goal.claimDigest, profile: first.source.profile, snapshot: first.fixedSnapshot });
  /** Source-only assertion: safe inside the original AL writer transaction, no nested AL reads. */
  const freshSource = () => {
    const current = capture();
    if (current.source.sessionIdentity !== sessionIdentity || current.deadlineMs !== first.deadlineMs
      || digest({ claimDigest: current.goal.claimDigest, profile: current.source.profile, snapshot: current.fixedSnapshot }) !== sourceDigest) reject();
    return current;
  };
  const sourceGuard = () => { freshSource(); };
  const initial = store.read(first.goal.taskId), registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  if (!initial || initial.fenced || initial.ownerId !== ownerId || initial.envelope.state !== 'RUNNING'
    || initial.envelope.phase !== 'MODEL' || initial.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
    || initial.envelope.taskKind !== registration.taskKind || initial.envelope.currentAttemptId !== first.goal.attemptId
    || initial.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
    || initial.envelope.verifier.verifierSetRef !== registration.verifierSetRef
    || initial.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
    || digest(initial.envelope.goal.sourceRefs) !== digest([`maintenancejob.${first.execution.job.runId}`, `revision.${first.execution.job.sourceRevision}`])
    || !initial.leaseExpiresAt || time(initial.leaseExpiresAt) <= first.now || initial.envelope.budget.granted.modelCalls !== 2) reject();
  const grant = initial.envelope.budget.granted, ceiling = first.profile.budgetProfile;
  if (grant.toolCalls !== (proposal ? 1 : 0) || grant.writes !== (proposal ? 1 : 0)
    || grant.highRiskActions !== 0 || grant.childTasks !== 0
    || grant.inputTokens < 1 || grant.inputTokens > ceiling.agentInputBudgetTokens
    || grant.outputTokens < 1 || grant.outputTokens > ceiling.agentOutputBudgetTokens
    || grant.costMicrousd < 1 || grant.costMicrousd > ceiling.maxCostMicrousd
    || grant.wallMs < 1 || grant.wallMs > ceiling.maxWallMs
    || Date.parse(initial.envelope.updatedAt) + grant.wallMs < first.deadlineMs) reject();
  assertAgentLoopMaintenancePreparedBinding({ record: initial, execution: first.execution, source: first.source });
  const suppliedPolicy = Object.hasOwn(selected, 'policy');
  const policy = suppliedPolicy ? normalizeAgentLoopModelCorrectionPolicy(selected.policy)
    : createAgentLoopModelCorrectionPolicy({ record: initial, deadlineAt: new Date(first.deadlineMs).toISOString(),
      requiredBudget: { modelCalls: 1, toolCalls: 0, writes: 0, inputTokens: 1, outputTokens: 1,
        costMicrousd: 1, wallMs: 1, highRiskActions: 0, childTasks: 0 } });
  if (Date.parse(policy.deadlineAt) !== first.deadlineMs) reject();
  assertAgentLoopModelCorrectionPolicyBinding(policy, initial);
  if (!suppliedPolicy) {
    if ([initial.envelope.budget.spent, initial.envelope.budget.reserved]
      .some(vector => AGENT_LOOP_TASK_BUDGET_KEYS.some(key => vector[key] !== 0))) reject();
    store.bindModelCorrectionPolicy({ taskId: initial.envelope.taskId, ownerId,
      expectedRevision: initial.revision, policy }, sourceGuard);
  } else {
    const state = store.readModelCorrectionState({ taskId: initial.envelope.taskId, expectedRevision: initial.revision, policy });
    if (state.reasonCodes.includes('correction-not-live')) reject();
    // A valid blocked/unknown history may be reconstructed for inspection. It
    // grants no dispatch: decide still needs the original Core's fresh permit.
    sourceGuard();
  }
  const policyDigest = agentLoopModelCorrectionPolicyDigest(policy);
  if (proposal) assertAgentLoopCorrectionProposalModelCapability(proposalCapability, { store, ownerId, record: initial, policy });
  const advance: NonNullable<AgentLoopCoordinatorPorts['modelCorrection']>['advance'] = (input) => {
    const value = own(input, ['record', 'ownerId', 'policy', 'expectedSnapshotDigest']);
    const expected = data(value.record) as AgentLoopTaskRecord;
    if (value.ownerId !== ownerId || expected.envelope.taskId !== first.goal.taskId
      || agentLoopModelCorrectionPolicyDigest(value.policy) !== policyDigest) reject();
    freshSource();
    const current = store.read(first.goal.taskId);
    if (!current || digest(current) !== digest(expected)) reject();
    return store.commitModelCorrection({ taskId: first.goal.taskId, expectedRevision: expected.revision,
      ownerId, policy, expectedSnapshotDigest: value.expectedSnapshotDigest }, sourceGuard);
  };
  // Live continuity only. Never persist the brand, raw response or a recreated
  // history token; if precise feedback is lost, fail before a second dispatch.
  let initialFeedbackRejection: unknown;
  const decide: AgentLoopCoordinatorPorts['decide'] = async (input) => {
    // This component never invents a reservation/permit or reuses a handle.
    // The original Core's requireNew winner supplies the one-use entry permit.
    const step = own(input, ['envelope', 'revision'], ['invocationPermit']);
    const envelope = data(step.envelope) as Parameters<AgentLoopCoordinatorPorts['decide']>[0]['envelope'];
    const revision = step.revision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1 || envelope.taskId !== first.goal.taskId) reject();
    const current = freshSource();
    const record = store.read(first.goal.taskId);
    if (!record || record.revision !== revision || digest(record.envelope) !== digest(envelope)) reject();
    assertAgentLoopModelCorrectionPolicyBinding(policy, record);
    const callBudgetProfile = deriveAgentLoopModelCallBudget({ budget: record.envelope.budget,
      hostProfile: current.profile.budgetProfile, deadlineAtMs: first.deadlineMs, nowMs: Date.parse(at()) });
    const correctionRejectedModelOutcome = proposal && revision === policy.initialRevision + 2 ? initialFeedbackRejection : undefined;
    if (proposal && revision === policy.initialRevision + 2 && correctionRejectedModelOutcome === undefined) {
      const invocationId = agentLoopModelInvocationId({ taskId: first.goal.taskId,
        attemptId: policy.attemptId, expectedTaskRevision: policy.initialRevision });
      const refusal = store.readEvents(first.goal.taskId).find(event => event.eventId === `model-rejection:${invocationId}`);
      if (!refusal || refusal.taskId !== first.goal.taskId || refusal.kind !== 'model-protocol-rejected'
        || refusal.revision !== policy.initialRevision + 1 || !isAgentLoopModelProtocolRejectionReason(refusal.reasonCode)) reject();
      if (refusal.reasonCode === 'json-invalid') reject();
      if (refusal.reasonCode === 'proposal-invalid'
        && store.readModelSummaryValidationRejection({ taskId: first.goal.taskId, attemptId: policy.attemptId,
          modelRevision: policy.initialRevision }).status === 'recorded') reject();
    }
    const assertCurrent = () => {
      const latest = freshSource();
      assertAgentLoopMaintenanceModelRecord({ store, ownerId, clock, job: latest.execution.job,
        budgetProfile: callBudgetProfile, envelope, revision: Number(revision), modelCorrectionPolicy: policy,
        ...(proposal ? { correctionProposalCapability: proposalCapability } : {}),
        ...(correctionRejectedModelOutcome === undefined ? {} : { correctionRejectedModelOutcome }) });
    };
    assertCurrent();
    const nowMs = Date.parse(at());
    const admissionScope = consumeAgentLoopModelInvocationPermit(step.invocationPermit, { record, ownerId,
      deadlineMs: Math.min(first.deadlineMs, nowMs + callBudgetProfile.maxWallMs) });
    // Do not add an await or a fallible post-construction source operation here.
    // The original bridge claims the original handle and owns cleanup only after
    // that exclusive claim; a foreign/already-consumed handle must not be closed.
    const handle = createHandle({ execution: current.execution, source: current.source, record, callBudgetProfile,
      admissionScope, assertCurrent, assertDispatch: assertCurrent });
    if (nodeTypes.isPromise(handle)) {
      void Promise.prototype.then.call(handle, () => undefined, () => undefined);
      reject();
    }
    const bridge = createAgentLoopMaintenanceModel({ store, ownerId, clock, signal,
      execution: current.execution, fixedSource: current.source, handle, callBudgetProfile,
      readCurrent: () => {
        const latest = freshSource();
        return { execution: latest.execution, source: latest.source };
      }, harnessRunId: current.execution.job.runId, modelCorrectionPolicy: policy,
      ...(proposal ? { correctionProposalCapability: proposalCapability } : {}),
      ...(correctionRejectedModelOutcome === undefined ? {} : { correctionRejectedModelOutcome }) });
    const outcome = await bridge.decide(input);
    const modeled = readAgentLoopModelOutcome(outcome);
    if (proposal && revision === policy.initialRevision && (modeled?.protocolRejectionReason === 'json-invalid'
      || modeled?.protocolRejectionReason === 'proposal-invalid' && modeled.summaryValidationRejection)) initialFeedbackRejection = outcome;
    return outcome;
  };
  return Object.freeze({ policy, modelCorrection: Object.freeze({ policy, advance }), decide });
}
