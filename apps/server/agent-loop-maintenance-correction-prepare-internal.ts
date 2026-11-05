/** Server-internal shared source capture / original preview for the two fixed
 * correction Prepare contracts. No arbitrary grant, route or writer callback.
 * Public wrappers select one literal kind; the model-only branch is unchanged.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { createAgentLoopMaintenancePrepare, resolveAgentLoopMaintenanceProfile,
  validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { agentLoopMaintenanceBindingRef } from './agent-loop-get-variables-authorization.ts';
import { createAgentLoopPreparedModelCorrection } from './agent-loop-prepared-model-correction.ts';
import type { AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import { createAgentLoopPreparedModelCorrectionProposal } from './agent-loop-prepared-model-correction-proposal.ts';
import { createAgentLoopMaintenanceExecutionBindingDescriptor } from './agent-loop-rolling-summary-artifacts.ts';
import { issueAgentLoopCorrectionProposalAuthorization, agentLoopCorrectionProposalAuthorizationEvidence,
  finalizeAgentLoopCorrectionProposalAuthorization,
  type AgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';

export interface AgentLoopMaintenanceCorrectionPrepareCurrent {
  readonly execution: MaintenanceExecutionRecord;
  readonly source: AgentLoopMaintenanceExecutionPrepareSource & { readonly hostDispatchGuarded?: true };
}
export interface AgentLoopMaintenanceCorrectionPrepareResult {
  readonly record: AgentLoopTaskRecord;
  readonly policy: AgentLoopModelCorrectionPolicy;
}
export interface AgentLoopMaintenanceCorrectionProposalPrepareResult extends AgentLoopMaintenanceCorrectionPrepareResult {
  readonly proposalCapability: AgentLoopCorrectionProposalCapability;
}
export interface AgentLoopMaintenanceCorrectionPrepareOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  /** Actual synchronous Manager / loaded Session / current policy/control readback. */
  readonly readCurrent: () => AgentLoopMaintenanceCorrectionPrepareCurrent | null;
  /** Trusted synchronous post-COMMIT observer. Failure cannot roll back the
   * already committed initial grant; it never authorizes Model/Action itself. */
  readonly onPrepared?: (result: AgentLoopMaintenanceCorrectionPrepareResult) => void;
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
function reject(): never { throw new Error('agent-loop-maintenance-correction-prepare-rejected'); }
function sync(value: unknown): unknown {
  if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value, () => undefined, () => undefined); reject(); }
  return value;
}
function own(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  sync(input);
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
  const keys = Reflect.ownKeys(input);
  if (required.some(key => !Object.hasOwn(input, key)) || keys.some(key => typeof key !== 'string'
    || !required.includes(key) && !optional.includes(key))) reject();
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
function time(input: unknown): string {
  sync(input);
  if (typeof input !== 'string' || !Number.isSafeInteger(Date.parse(input)) || new Date(input).toISOString() !== input) reject();
  return input;
}
function digest(input: unknown): string {
  const canonical = (value: unknown): unknown => value !== null && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')}`;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

export function createAgentLoopMaintenanceCorrectionPrepareMechanism(options: AgentLoopMaintenanceCorrectionPrepareOptions,
  kind: 'model-only'): Readonly<{
  prepare(input: Readonly<{ taskId: string; revision: number }>): Promise<AgentLoopMaintenanceCorrectionPrepareResult>;
}>;
export function createAgentLoopMaintenanceCorrectionPrepareMechanism(options: AgentLoopMaintenanceCorrectionPrepareOptions,
  kind: 'shadow-proposal'): Readonly<{
  prepare(input: Readonly<{ taskId: string; revision: number }>): Promise<AgentLoopMaintenanceCorrectionProposalPrepareResult>;
}>;
export function createAgentLoopMaintenanceCorrectionPrepareMechanism(options: AgentLoopMaintenanceCorrectionPrepareOptions,
  kind: 'model-only' | 'shadow-proposal'): Readonly<{
  prepare(input: Readonly<{ taskId: string; revision: number }>): Promise<AgentLoopMaintenanceCorrectionPrepareResult | AgentLoopMaintenanceCorrectionProposalPrepareResult>;
}> {
  if (kind !== 'model-only' && kind !== 'shadow-proposal') reject();
  const selected = own(options, ['store', 'ownerId', 'clock', 'signal', 'readCurrent'], ['onPrepared']);
  const { store, ownerId, clock, signal, readCurrent } = options;
  const onPrepared = selected.onPrepared;
  if (Object.hasOwn(selected, 'onPrepared') && (typeof onPrepared !== 'function' || nodeTypes.isProxy(onPrepared))) reject();
  if (!store || typeof store !== 'object' || nodeTypes.isProxy(store) || typeof ownerId !== 'string' || !TOKEN.test(ownerId)
    || typeof clock !== 'function' || nodeTypes.isProxy(clock) || typeof readCurrent !== 'function' || nodeTypes.isProxy(readCurrent)
    || !signal || nodeTypes.isProxy(signal)) reject();
  const stop = () => { try { if (aborted.call(signal)) reject(); } catch { return reject(); } };
  stop();
  const capture = () => {
    stop(); const before = time(clock());
    const raw = own(readCurrent(), ['execution', 'source']), execution = data(raw.execution) as MaintenanceExecutionRecord;
    const original = own(raw.source, ['job', 'snapshot', 'profile', 'sessionIdentity'], ['hostDispatchGuarded']);
    if (!original.sessionIdentity || typeof original.sessionIdentity !== 'object' || nodeTypes.isProxy(original.sessionIdentity)
      || Object.hasOwn(original, 'hostDispatchGuarded') && original.hostDispatchGuarded !== true) reject();
    const snapshot = own(original.snapshot, ['revision', 'state', 'userMessage'],
      ['proposalContext', 'providerProposalContext', 'strictContextUnavailableReason', 'readMemory']);
    const selectedSnapshot = Object.fromEntries(Object.keys(snapshot).filter(key => key !== 'readMemory').map(key => [key, snapshot[key]]));
    const source = Object.freeze({ job: data(original.job), snapshot: data(selectedSnapshot), profile: data(original.profile),
      sessionIdentity: original.sessionIdentity }) as AgentLoopMaintenanceExecutionPrepareSource;
    const profile = resolveAgentLoopMaintenanceProfile(source), fixedSnapshot = validateAgentLoopMaintenanceSnapshot(source);
    const now = time(clock()); stop(); if (now < before) reject();
    const goal = resolveAgentLoopRollingSummaryGoal({ execution, now });
    const deadline = Date.parse(goal.binding.startedAt) + profile.budgetProfile.maxWallMs;
    if (goal.mode !== 'shadow' || goal.binding.ownerId !== ownerId || digest(source.job) !== digest(execution.job)
      || source.snapshot.revision !== execution.job.sourceRevision || profile.budgetProfile.maxModelCalls !== 1
      || !Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime()) || deadline <= Date.parse(now)) reject();
    return { execution, source, profile, goal, deadlineAt: new Date(deadline).toISOString(), fixedSnapshot };
  };
  return Object.freeze({ async prepare(input: Readonly<{ taskId: string; revision: number }>) {
    const value = own(input, ['taskId', 'revision']);
    if (typeof value.taskId !== 'string' || !TOKEN.test(value.taskId) || value.revision !== 1) reject();
    const first = capture(), sessionIdentity = first.source.sessionIdentity;
    if (value.taskId !== first.goal.taskId) reject();
    const sourceDigest = digest({ claim: first.goal.claimDigest, profile: first.source.profile, snapshot: first.fixedSnapshot });
    // Deliberately contains no AL read: safe inside the original Store writer transaction.
    const read = () => {
      const current = capture();
      if (current.source.sessionIdentity !== sessionIdentity || current.deadlineAt !== first.deadlineAt
        || digest({ claim: current.goal.claimDigest, profile: current.source.profile, snapshot: current.fixedSnapshot }) !== sourceDigest) reject();
      return current;
    };
    const preview = createAgentLoopMaintenancePrepare({ store, ownerId, clock,
      readSource: runId => { const current = read(); if (current.goal.binding.runId !== runId) reject(); return current.source; } });
    const candidate = await preview.preview({ taskId: value.taskId, revision: 1 });
    if (!candidate || candidate.taskId !== first.goal.taskId || candidate.revision !== 1) reject();
    read();
    const record = store.read(first.goal.taskId);
    if (!record || record.envelopeDigest !== candidate.envelopeDigest || record.revision !== 1) reject();
    const profile = first.profile.budgetProfile;
    const zero = { modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0,
      wallMs: 0, highRiskActions: 0, childTasks: 0 };
    const authorization = kind === 'shadow-proposal' ? issueAgentLoopCorrectionProposalAuthorization({
      store, ownerId, clock, signal, readCurrent: () => {
        const current = read(); return { execution: current.execution, source: current.source };
      },
    }) : undefined;
    const evidence = authorization === undefined ? undefined
      : agentLoopCorrectionProposalAuthorizationEvidence(authorization, record, ownerId);
    const selected = { store, record, ownerId, attemptId: first.goal.attemptId,
      budget: { policyRef: record.envelope.budget.policyRef, granted: { ...zero, modelCalls: 2,
        toolCalls: kind === 'shadow-proposal' ? 1 : 0, writes: kind === 'shadow-proposal' ? 1 : 0,
        inputTokens: profile.agentInputBudgetTokens, outputTokens: profile.agentOutputBudgetTokens,
        costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs }, reserved: zero, spent: zero },
      artifact: { artifactRef: agentLoopMaintenanceBindingRef(first.execution, first.source), kind: 'agent-loop-execution-binding', status: 'declared' as const,
        evidenceRefs: [first.goal.claimDigest, candidate.requestDigest, candidate.profileDigest, candidate.sourceDigest,
          candidate.fixedInputDigest, candidate.toolSetDigest, ...(evidence === undefined ? [] : [evidence])] },
      deadlineAt: first.deadlineAt, requiredBudget: { ...zero, modelCalls: 1, inputTokens: 1, outputTokens: 1, costMicrousd: 1, wallMs: 1 },
      authorizeCommit: () => { read(); },
    };
    const result = kind === 'model-only'
      ? store.commitModelCorrectionPrepare({ taskId: first.goal.taskId, expectedRevision: 1, ownerId,
        prepared: createAgentLoopPreparedModelCorrection(selected) })
      : store.commitModelCorrectionProposalPrepare({ taskId: first.goal.taskId, expectedRevision: 1, ownerId,
        prepared: createAgentLoopPreparedModelCorrectionProposal({ ...selected,
          artifactRef: createAgentLoopMaintenanceExecutionBindingDescriptor(first.execution, first.source) }) });
    if (typeof onPrepared === 'function') {
      // No await/thenable assimilation between the real COMMIT and lifecycle
      // adoption. A failed observer leaves the durable evidence intact.
      const observed: unknown = onPrepared(result);
      sync(observed); if (observed !== undefined) reject();
    }
    if (authorization === undefined) return result;
    // Failure after COMMIT withholds the opaque capability; it never pretends
    // that the already persisted initial grant/policy was rolled back.
    return Object.freeze({ ...result, proposalCapability: finalizeAgentLoopCorrectionProposalAuthorization(authorization, result) });
  } });
}
