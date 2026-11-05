/** Host-only binding of an existing pristine AL projection to the original Manager claim.
 * No claim takeover, task creation, grant, Provider, Action or completion authority.
 */
import type { AgentLoopTaskRecord, AgentLoopProjectionStore } from './agent-loop-projection-store.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';
import { types as nodeTypes } from 'node:util';
import { isPristineShadowProjection, shadowJobSourceState } from './agent-loop-turnjob-shadow.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION,
  assertAgentLoopModelCorrectionPolicyBinding, agentLoopModelCorrectionPolicyDigest,
  type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';

export interface MaintenanceAgentLoopExecutionContext {
  readonly execution: MaintenanceExecutionRecord;
  readonly taskId: string;
  readonly ownerId: string;
  readonly signal: AbortSignal;
}
export interface MaintenanceAgentLoopExecutionPort {
  readonly store: AgentLoopProjectionStore;
  /** Host-only synchronous admission, checked before and inside the original Manager claim. */
  readonly canClaim?: (job: PublicMaintenanceJob) => boolean;
  /** Trusted host driver only. Returning does not prove Verify or authorize Manager success. */
  readonly execute: (input: MaintenanceAgentLoopExecutionContext) => Promise<void>;
}
export interface MaintenanceAgentLoopLifecycleBinding {
  readonly taskId: string;
  renew(leaseMs: number): void;
  fence(): void;
}
interface ContextBinding {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly lifecycleBinding?: MaintenanceAgentLoopLifecycleBinding;
}
const executionContexts = new WeakMap<object, ContextBinding>();
const activeContexts = new WeakMap<object, ContextBinding>();
const lifecycleBindings = new WeakMap<object, Readonly<{
  store: AgentLoopProjectionStore; ownerId: string; execution: MaintenanceExecutionRecord; taskId: string;
  adopt(policy: AgentLoopModelCorrectionPolicy, kind: 'model-only' | 'shadow-proposal'): void;
}>>();
function reject(): never { throw new Error('maintenance-agent-loop-binding-rejected'); }

/** Only the original Service issues this after binding its actual claim to the existing projection.
 * The Store and live signal remain opaque references; no JSON field is a capability.
 */
export function issueMaintenanceAgentLoopExecutionContext(input: Readonly<{
  store: AgentLoopProjectionStore; execution: MaintenanceExecutionRecord;
  taskId: string; ownerId: string; signal: AbortSignal;
  lifecycleBinding?: MaintenanceAgentLoopLifecycleBinding;
}>): MaintenanceAgentLoopExecutionContext {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) reject();
  for (let current: object | null = input; current !== null; current = Object.getPrototypeOf(current)) {
    if (nodeTypes.isProxy(current)) reject();
  }
  const property = Object.getOwnPropertyDescriptor(input, 'lifecycleBinding');
  if ('lifecycleBinding' in input && (!property?.enumerable || !Object.hasOwn(property, 'value'))) reject();
  const lifecycleBinding = property?.value as MaintenanceAgentLoopLifecycleBinding | undefined;
  const { store, execution, taskId, ownerId, signal } = input;
  if (!store || !signal || signal.aborted || execution.executorRoute !== 'agent-loop'
    || execution.leaseOwnerInstanceId !== ownerId || execution.job.status !== 'running'
    || execution.job.taskKind !== 'rolling_summary' || execution.cancelRequestedAt !== undefined
    || taskId !== `agentloop.maintenance.${execution.job.runId}`) reject();
  if (property) {
    const actual = lifecycleBinding && lifecycleBindings.get(lifecycleBinding);
    if (!actual || actual.store !== store || actual.ownerId !== ownerId || actual.taskId !== taskId
      || !sameMaintenanceAgentLoopClaim(actual.execution, execution)) reject();
  }
  const context = Object.freeze({ execution: Object.freeze({ ...execution, job: Object.freeze({ ...execution.job }) }),
    taskId, ownerId, signal });
  executionContexts.set(context, Object.freeze({ store, ownerId, ...(lifecycleBinding ? { lifecycleBinding } : {}) }));
  return context;
}

/** One actual context, one Store/owner, one consumption. A mismatched exchange also burns it. */
export function consumeMaintenanceAgentLoopExecutionContext(context: unknown,
  store: AgentLoopProjectionStore, ownerId: string): boolean {
  if (context === null || typeof context !== 'object') return false;
  const binding = executionContexts.get(context);
  if (!binding) return false;
  executionContexts.delete(context);
  if (binding.store !== store || binding.ownerId !== ownerId) return false;
  activeContexts.set(context, binding);
  return true;
}

/** The Service retains revocation ownership through the entire physical Provider tail. */
export function revokeMaintenanceAgentLoopExecutionContext(context: unknown): void {
  if (context !== null && typeof context === 'object') { executionContexts.delete(context); activeContexts.delete(context); }
}

/** Only the original consumed Service context may adopt its actual initial
 * correction CAS. This neither issues a MODEL permit nor authorizes any ACT. */
export function adoptMaintenanceAgentLoopModelCorrection(context: unknown, store: AgentLoopProjectionStore,
  ownerId: string, policy: AgentLoopModelCorrectionPolicy): void {
  adoptCorrectionContext(context, store, ownerId, policy, 'model-only');
}
/** Cleanup-only identity continuation after the independent proposal initial
 * COMMIT, before its live capability can be finalized. No dispatch permission. */
export function adoptMaintenanceAgentLoopCorrectionProposal(context: unknown, store: AgentLoopProjectionStore,
  ownerId: string, policy: AgentLoopModelCorrectionPolicy): void {
  adoptCorrectionContext(context, store, ownerId, policy, 'shadow-proposal');
}
function adoptCorrectionContext(context: unknown, store: AgentLoopProjectionStore,
  ownerId: string, policy: AgentLoopModelCorrectionPolicy, kind: 'model-only' | 'shadow-proposal'): void {
  try {
    if (!context || typeof context !== 'object') reject();
    const binding = activeContexts.get(context), actual = binding?.lifecycleBinding && lifecycleBindings.get(binding.lifecycleBinding);
    if (!binding || binding.store !== store || binding.ownerId !== ownerId || !actual
      || actual.store !== store || actual.ownerId !== ownerId) reject();
    actual.adopt(policy, kind);
  } catch { return reject(); }
}
/** Immutable actual-claim headers only. Heartbeats may change TTL/updatedAt, never this identity. */
export function sameMaintenanceAgentLoopClaim(left: MaintenanceExecutionRecord, right: MaintenanceExecutionRecord): boolean {
  const header = (value: MaintenanceExecutionRecord) => {
    const job = value.job;
    return [value.executorRoute, value.leaseOwnerInstanceId, job.runId, job.sessionId, job.taskKind,
      job.sourceRevision, job.policyVersion, job.parentRunId ?? null, job.trigger, job.mode,
      job.attempt, job.createdAt, job.startedAt];
  };
  return JSON.stringify(header(left)) === JSON.stringify(header(right));
}
function identity(record: AgentLoopTaskRecord): string {
  const task = record.envelope;
  return JSON.stringify({ taskId: task.taskId, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId,
    taskKind: task.taskKind, taskContractRef: task.taskContractRef, createdAt: task.createdAt,
    goal: task.goal, verifier: task.verifier, policyRef: task.budget.policyRef });
}

export function bindMaintenanceAgentLoopLifecycle(input: Readonly<{
  store: AgentLoopProjectionStore; execution: MaintenanceExecutionRecord; ownerId: string; nowMs: () => number;
  readExecution: () => MaintenanceExecutionRecord | null;
}>): MaintenanceAgentLoopLifecycleBinding {
  const { store, execution, ownerId, nowMs, readExecution } = input;
  const taskId = `agentloop.maintenance.${execution.job.runId}`;
  if (execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || execution.job.status !== 'running' || execution.job.taskKind !== 'rolling_summary'
    || execution.cancelRequestedAt !== undefined) reject();
  const first = store.read(taskId);
  if (!first || !isPristineShadowProjection(store, first) || shadowJobSourceState(first.envelope, {
    readTurnJob: () => null, readMaintenanceJob: () => execution.job,
  }) !== 'active') reject();
  let fixedIdentity = identity(first);
  let adoptedPolicy: AgentLoopModelCorrectionPolicy | undefined;
  const live = (allowCancellation = false) => {
    const claim = readExecution(), current = store.read(taskId), now = nowMs();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())
      || !claim || !sameMaintenanceAgentLoopClaim(execution, claim) || claim.job.status !== 'running'
      || !Number.isFinite(Date.parse(claim.leaseExpiresAt)) || Date.parse(claim.leaseExpiresAt) <= now
      || (!allowCancellation && claim.cancelRequestedAt !== undefined)
      || !current || current.fenced || current.ownerId !== ownerId || current.leaseExpiresAt === null
      || !Number.isFinite(Date.parse(current.leaseExpiresAt)) || Date.parse(current.leaseExpiresAt) <= now) reject();
    return { current, now };
  };
  const read = (allowCancellation = false) => {
    const { current } = live(allowCancellation);
    if (identity(current) !== fixedIdentity) reject();
    // Pure frame/attempt/hash continuity only. Expired correction policy must
    // not prevent the original Service from renewing/fencing its drained work.
    if (adoptedPolicy) { try { assertAgentLoopModelCorrectionPolicyBinding(adoptedPolicy, current); } catch { return reject(); } }
    return current;
  };
  read();
  const binding = Object.freeze({ taskId,
    renew(leaseMs: number): void {
      const current = read();
      store.renewLease({ taskId, expectedRevision: current.revision, ownerId, leaseMs });
    },
    /** Only after the host driver and its physical Provider scope have drained. Never reacquire an expired lease. */
    fence(): void {
      const current = read(true);
      store.fence({ taskId, expectedRevision: current.revision, ownerId, reasonCode: 'maintenance-agent-loop-stopped' });
    },
  });
  lifecycleBindings.set(binding, Object.freeze({ store, ownerId, execution, taskId,
    adopt(inputPolicy: AgentLoopModelCorrectionPolicy, kind: 'model-only' | 'shadow-proposal'): void {
      if (adoptedPolicy || execution.job.mode !== 'shadow') reject();
      // The initial grant already committed. Cancellation/close may arrive
      // before this synchronous observer; adopt only its identity so the
      // original drained-work fence remains possible, never a dispatch permit.
      const { current } = live(true);
      const policy = assertAgentLoopModelCorrectionPolicyBinding(inputPolicy, current);
      const actions = kind === 'shadow-proposal' ? 1 : 0, grant = current.envelope.budget.granted;
      if (current.revision !== 2 || current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'MODEL'
        || current.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF || policy.initialRevision !== 2
        || identity({ ...current, envelope: { ...current.envelope, taskContractRef: first.envelope.taskContractRef } }) !== fixedIdentity
        || grant.toolCalls !== actions || grant.writes !== actions || grant.highRiskActions !== 0 || grant.childTasks !== 0) reject();
      if (kind === 'shadow-proposal') {
        const claim = agentLoopMaintenanceClaimDigest(execution);
        const minimum = { modelCalls: 1, toolCalls: 0, writes: 0, inputTokens: 1, outputTokens: 1,
          costMicrousd: 1, wallMs: 1, highRiskActions: 0, childTasks: 0 };
        if (current.envelope.currentAttemptId !== `attempt.al.${claim.slice(7)}`
          || Object.keys(minimum).some(key => policy.requiredBudget[key as keyof typeof minimum] !== minimum[key as keyof typeof minimum])) reject();
      }
      const state = store.readModelCorrectionState({ taskId, expectedRevision: 2, policy });
      if (state.version !== AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION || state.status !== 'initial'
        || state.taskId !== taskId || state.taskRevision !== 2 || state.envelopeDigest !== current.envelopeDigest
        || state.policyDigest !== agentLoopModelCorrectionPolicyDigest(policy) || state.initialRevision !== 2
        || state.correctionsUsed !== 0 || state.readyRevision !== null || state.closedInvocationId !== null) reject();
      const confirmed = live(true);
      if (confirmed.current.envelopeDigest !== current.envelopeDigest || confirmed.current.revision !== 2) reject();
      // Publish the new identity only after every actual Store/claim check.
      fixedIdentity = identity(current); adoptedPolicy = policy;
    },
  }));
  return binding;
}
