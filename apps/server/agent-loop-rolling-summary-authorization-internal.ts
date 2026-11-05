/** Internal shared mechanics only. Each trusted mode wrapper owns separate WeakMaps.
 * A fresh instance or copied audit metadata cannot mint either trusted wrapper grant.
 */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopDecision,
  type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { normalizeAgentLoopArtifactRefDescriptor, type AgentLoopProjectionStore, type AgentLoopTaskRecord,
  type AgentLoopArtifactRefDescriptor } from './agent-loop-projection-store.ts';
import type { AgentLoopMaintenanceExecutionPrepareOptions } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot,
  type AgentLoopMaintenancePrepareSource } from './agent-loop-prepare.ts';
import { agentLoopMaintenanceBindingRef } from './agent-loop-get-variables-authorization.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { isPristineShadowProjection, MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';


export function createAgentLoopRollingSummaryAuthorizationMechanism<
  A extends string, P extends string, C extends string,
>(config: Readonly<{
  mode: 'shadow' | 'apply';
  actionContractRef: 'action.maintenance.propose_rolling_summary.v1' | 'action.maintenance.apply_rolling_summary.v1';
  authorizationVersion: A; preparedVersion: P; capabilityVersion: C; error: string;
}>) {
  if (config.mode === 'shadow'
    ? config.actionContractRef !== 'action.maintenance.propose_rolling_summary.v1'
    : config.actionContractRef !== 'action.maintenance.apply_rolling_summary.v1') throw new Error(config.error);
  interface Authorization { readonly contractVersion: A; }
  interface PreparedAuthorization { readonly contractVersion: P; }
  interface Capability { readonly contractVersion: C; }
  type ReadCurrent = AgentLoopMaintenanceExecutionPrepareOptions['readCurrent'];
  type Budget = AgentLoopTaskEnvelopeV1['budget'];
  type Artifact = AgentLoopTaskEnvelopeV1['artifacts'][number];
  interface AuthorizationData {
    readonly store: AgentLoopProjectionStore;
    readonly ownerId: string;
    readonly clock: () => string;
    readonly signal: AbortSignal;
    readonly readCurrent: ReadCurrent;
    readonly taskId: string;
    readonly initialRevision: number;
    readonly initialDigest: string;
    readonly attemptId: string;
    readonly sessionIdentity: object;
    readonly claimDigest: string;
    readonly goalDigest: string;
    readonly profileDigest: string;
    readonly snapshotDigest: string;
    readonly deadlineMs: number;
    readonly bindingRef: string;
    readonly evidenceDigest: string;
    readonly budget: Budget;
    readonly runId: string;
  }
  interface CapabilityData {
    readonly authorization: AuthorizationData;
    readonly modelRevision: number;
    readonly artifactsDigest: string;
  }
  const authorizations = new WeakMap<object, AuthorizationData>();
  const prepared = new WeakMap<object, AuthorizationData>();
  const capabilities = new WeakMap<object, CapabilityData>();
  const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
  const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  function reject(): never { throw new Error(config.error); }
  function object(value: unknown): value is object { return value !== null && typeof value === 'object'; }
  function record(value: unknown): Record<string, unknown> {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) reject();
    return value as Record<string, unknown>;
  }
  /** Snapshot/profile data must not evaluate a getter/toJSON hook during shared validation. */
  function dataOnly(value: unknown, stack = new Set<object>()): void {
    if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!object(value) || stack.has(value)) reject();
    stack.add(value);
    try {
      if (!Array.isArray(value)) record(value);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') reject();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject();
        dataOnly(descriptor.value, stack);
      }
    } finally { stack.delete(value); }
  }
  function at(clock: () => string): Readonly<{ text: string; ms: number }> {
    const text = clock();
    if (typeof text !== 'string') reject();
    const ms = Date.parse(text);
    if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== text) reject();
    return { text, ms };
  }

  function capture(input: Readonly<{ ownerId: string; clock: () => string; signal: AbortSignal; readCurrent: ReadCurrent }>) {
    if (!input || typeof input.ownerId !== 'string' || !TOKEN.test(input.ownerId) || typeof input.clock !== 'function'
      || typeof input.readCurrent !== 'function' || !input.signal || input.signal.aborted) reject();
    const value = input.readCurrent();
    if (object(value)) {
      let asynchronous = false;
      try { void Promise.prototype.then.call(value, () => undefined, () => undefined); asynchronous = true; }
      catch { /* Native Promises are rejected without assimilating a foreign thenable. */ }
      if (asynchronous) reject();
    }
    const current = record(value), execution = record(current.execution), source = record(current.source);
    const now = at(input.clock);
    const goal = resolveAgentLoopRollingSummaryGoal({
      execution: execution as unknown as Parameters<typeof resolveAgentLoopRollingSummaryGoal>[0]['execution'], now: now.text,
    });
    if (goal.mode !== config.mode || goal.binding.ownerId !== input.ownerId || !object(source.sessionIdentity)) reject();
    dataOnly(source.job); dataOnly(source.profile); dataOnly(source.snapshot);
    if (JSON.stringify(source.job) !== JSON.stringify(execution.job)) reject();
    const typedSource = source as unknown as AgentLoopMaintenancePrepareSource;
    const profile = resolveAgentLoopMaintenanceProfile(typedSource), snapshot = validateAgentLoopMaintenanceSnapshot(typedSource);
    if (profile.budgetProfile.maxModelCalls !== 1 || profile.budgetProfile.maxToolCalls < 1
      || profile.budgetProfile.maxWrites < 1 || profile.budgetProfile.maxToolResultChars < 1
      || snapshot.revision !== goal.binding.sourceRevision) reject();
    const deadlineMs = Date.parse(goal.binding.startedAt) + profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(deadlineMs) || !Number.isFinite(new Date(deadlineMs).getTime())
      || now.ms >= deadlineMs || input.signal.aborted) reject();
    return { execution: execution as unknown as Parameters<typeof resolveAgentLoopRollingSummaryGoal>[0]['execution'],
      source: typedSource, sessionIdentity: source.sessionIdentity, at: now.ms, goal, profile, deadlineMs,
      goalDigest: digest(goal), profileDigest: digest(profile), snapshotDigest: digest(snapshot) };
  }
  function fresh(data: AuthorizationData): void {
    const current = capture(data);
    if (current.sessionIdentity !== data.sessionIdentity || current.goal.claimDigest !== data.claimDigest
      || current.goalDigest !== data.goalDigest || current.profileDigest !== data.profileDigest
      || current.snapshotDigest !== data.snapshotDigest || current.deadlineMs !== data.deadlineMs) reject();
  }
  function actualRecord(data: AuthorizationData, supplied: AgentLoopTaskRecord): AgentLoopTaskRecord {
    const current = data.store.read(data.taskId), now = at(data.clock);
    if (!current || current.fenced || current.ownerId !== data.ownerId || current.envelope.taskId !== data.taskId
      || current.revision !== supplied.revision || current.envelopeDigest !== supplied.envelopeDigest
      || JSON.stringify(current.envelope) !== JSON.stringify(supplied.envelope)
      || !current.leaseExpiresAt || !Number.isFinite(Date.parse(current.leaseExpiresAt))
      || new Date(current.leaseExpiresAt).toISOString() !== current.leaseExpiresAt
      || Date.parse(current.leaseExpiresAt) <= now.ms || data.signal.aborted) reject();
    return current;
  }
  function binding(data: AuthorizationData, record: AgentLoopTaskRecord): void {
    const values = record.envelope.artifacts.filter(value => value.kind === 'agent-loop-execution-binding');
    if (values.length !== 1 || values[0]!.artifactRef !== data.bindingRef || values[0]!.status !== 'declared'
      || !values[0]!.evidenceRefs.includes(data.evidenceDigest) || record.envelope.currentAttemptId !== data.attemptId
      || JSON.stringify(record.envelope.budget.granted) !== JSON.stringify(data.budget.granted)
      || record.envelope.budget.policyRef !== data.budget.policyRef) reject();
  }
  function exactBindingDescriptor(data: AuthorizationData, ref: AgentLoopArtifactRefDescriptor): void {
    if (ref.refId !== data.bindingRef || ref.kind !== 'session-artifact'
      || ref.ownerRef !== `maintenancejob.${data.runId}` || ref.expectedRevision !== data.claimDigest
      || ref.expectedDigest !== `sha256:${data.bindingRef.slice('execution.prepare:'.length)}`
      || ref.policy !== 'required' || ref.aclClass !== 'restricted' || ref.expandBudgetTokens !== 0) reject();
  }

  function issue(input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; clock: () => string; signal: AbortSignal; readCurrent: ReadCurrent;
  }>): Authorization {
    try {
      const fixed = capture(input), record = input.store.read(fixed.goal.taskId);
      const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
      if (!record || record.fenced || record.ownerId !== input.ownerId || !isPristineShadowProjection(input.store, record)
        || record.envelope.taskKind !== fixed.goal.taskKind || record.envelope.taskContractRef !== fixed.goal.contractRef
        || record.envelope.verifier.verifierSetRef !== fixed.goal.verifierSetRef
        || record.envelope.verifier.verifierSetRevision !== fixed.goal.verifierSetRevision
        || record.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
        || digest(record.envelope.goal.sourceRefs) !== digest([`maintenancejob.${fixed.goal.binding.runId}`,
          `revision.${fixed.goal.binding.sourceRevision}`]) || !record.leaseExpiresAt
        || new Date(record.leaseExpiresAt).toISOString() !== record.leaseExpiresAt
        || Date.parse(record.leaseExpiresAt) <= fixed.at) reject();
      const zero = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, 0])) as unknown as Budget['granted'];
      const profile = fixed.profile.budgetProfile;
      const budget: Budget = Object.freeze({ policyRef: record.envelope.budget.policyRef,
        granted: Object.freeze({ ...zero, modelCalls: 1, toolCalls: 1, writes: 1,
          inputTokens: profile.agentInputBudgetTokens, outputTokens: profile.agentOutputBudgetTokens,
          costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs }),
        reserved: Object.freeze({ ...zero }), spent: Object.freeze({ ...zero }) });
      const evidenceDigest = digest({ version: config.authorizationVersion,
        taskId: fixed.goal.taskId, initialRevision: record.revision, envelopeDigest: record.envelopeDigest,
        ownerId: input.ownerId, actionContractRef: config.actionContractRef,
        claimDigest: fixed.goal.claimDigest, goalDigest: fixed.goalDigest, profileDigest: fixed.profileDigest,
        snapshotDigest: fixed.snapshotDigest, deadlineMs: fixed.deadlineMs, budget });
      const value: Authorization = Object.freeze({
        contractVersion: config.authorizationVersion,
      });
      authorizations.set(value, Object.freeze({ store: input.store, ownerId: input.ownerId, clock: input.clock,
        signal: input.signal, readCurrent: input.readCurrent, taskId: fixed.goal.taskId, initialRevision: record.revision,
        initialDigest: record.envelopeDigest, attemptId: fixed.goal.attemptId, sessionIdentity: fixed.sessionIdentity,
        claimDigest: fixed.goal.claimDigest, goalDigest: fixed.goalDigest, profileDigest: fixed.profileDigest,
        snapshotDigest: fixed.snapshotDigest, deadlineMs: fixed.deadlineMs,
        bindingRef: agentLoopMaintenanceBindingRef(fixed.execution, fixed.source), evidenceDigest, budget,
        runId: fixed.goal.binding.runId }));
      return value;
    } catch { return reject(); }
  }

  /** Audit-only digest. A clone/serialized declaration is never an executable authorization. */
  function evidence(value: unknown,
    record: AgentLoopTaskRecord, ownerId: string): string {
    try {
      const data = object(value) ? authorizations.get(value) : undefined;
      if (!data || ownerId !== data.ownerId || record.revision !== data.initialRevision
        || record.envelopeDigest !== data.initialDigest) reject();
      fresh(data); actualRecord(data, record); return data.evidenceDigest;
    } catch { return reject(); }
  }

  /** Initial authorization is burned even on a rejected binding. */
  function prepare(value: unknown, input: Readonly<{
    record: AgentLoopTaskRecord; ownerId: string; attemptId: string; budget: Budget; artifact: Artifact;
    artifactRef: AgentLoopArtifactRefDescriptor;
  }>): PreparedAuthorization {
    const data = object(value) ? authorizations.get(value) : undefined;
    if (object(value)) authorizations.delete(value);
    try {
      if (!data || input.ownerId !== data.ownerId || input.attemptId !== data.attemptId
        || input.record.revision !== data.initialRevision || input.record.envelopeDigest !== data.initialDigest
        || JSON.stringify(input.budget) !== JSON.stringify(data.budget)
        || input.artifact.artifactRef !== data.bindingRef || input.artifact.kind !== 'agent-loop-execution-binding'
        || input.artifact.status !== 'declared' || !input.artifact.evidenceRefs.includes(data.evidenceDigest)) reject();
      exactBindingDescriptor(data, normalizeAgentLoopArtifactRefDescriptor(input.artifactRef));
      fresh(data); actualRecord(data, input.record);
      const valuePrepared: PreparedAuthorization = Object.freeze({
        contractVersion: config.preparedVersion,
      });
      prepared.set(valuePrepared, data); return valuePrepared;
    } catch { return reject(); }
  }

  /** Mandatory synchronous original source/lease fence inside consumed Prepare, before its CAS. */
  function assertPrepared(value: unknown,
    record: AgentLoopTaskRecord, ownerId: string): void {
    try {
      const data = object(value) ? prepared.get(value) : undefined;
      if (!data || ownerId !== data.ownerId || record.revision !== data.initialRevision
        || record.envelopeDigest !== data.initialDigest) reject();
      fresh(data); actualRecord(data, record);
    } catch { return reject(); }
  }

  /** Called only after the original consumed PreparedExecution CAS and exact committed-grant check. */
  function finalize(value: unknown,
    committed: AgentLoopTaskRecord): Capability {
    const data = object(value) ? prepared.get(value) : undefined;
    if (object(value)) prepared.delete(value);
    try {
      if (!data) reject();
      fresh(data); const current = actualRecord(data, committed);
      if (current.revision !== data.initialRevision + 1 || current.envelope.phase !== 'MODEL'
        || current.envelope.state !== 'RUNNING' || JSON.stringify(current.envelope.budget) !== JSON.stringify(data.budget)) reject();
      binding(data, current);
      const actualRefs = data.store.readRefs(data.taskId).filter(ref => ref.refId === data.bindingRef);
      if (actualRefs.length !== 1 || actualRefs[0]!.taskRevision !== current.revision) reject();
      exactBindingDescriptor(data, actualRefs[0]!);
      // The original bundled writer emits ref metadata before its phase event in
      // one transaction. A later standalone same-revision registration is not the
      // consumed Prepare CAS and must never repair a missing capability handoff.
      const events = data.store.readEvents(data.taskId);
      const refIndex = events.findIndex(event => event.eventId === `ref-registered:${data.bindingRef}`
        && event.kind === 'ref-registered' && event.revision === current.revision);
      const phaseIndex = events.findIndex(event => event.eventId === `phase:${data.taskId}:${data.initialRevision}:PREPARE-MODEL`
        && event.kind === 'phase-advanced' && event.revision === current.revision);
      if (refIndex < 0 || phaseIndex <= refIndex || events[refIndex]!.acceptedAt !== events[phaseIndex]!.acceptedAt
        || actualRefs[0]!.registeredAt !== events[phaseIndex]!.acceptedAt) reject();
      const capability: Capability = Object.freeze({
        contractVersion: config.capabilityVersion,
      });
      capabilities.set(capability, Object.freeze({ authorization: data, modelRevision: current.revision,
        artifactsDigest: digest(current.envelope.artifacts) }));
      return capability;
    } catch { return reject(); }
  }

  /** Read-only MODEL selection only. The same live capability remains owned by
   * its original Runtime and must still be consumed exactly once by apply ACT.
   * No audit DTO, new factory instance or successful assertion issues a grant.
   */
  function assertModelCapability(value: unknown, input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord;
  }>): void {
    try {
      const entry = object(value) ? capabilities.get(value) : undefined;
      if (config.mode !== 'apply' || !entry) reject();
      const data = entry.authorization;
      record(input); record(input.record); dataOnly(input.record.envelope);
      if (input.store !== data.store || input.ownerId !== data.ownerId || data.initialRevision !== 1
        || entry.modelRevision !== 2) reject();
      fresh(data); const current = actualRecord(data, input.record);
      if (current.revision !== entry.modelRevision || current.envelope.phase !== 'MODEL'
        || current.envelope.state !== 'RUNNING' || digest(current.envelope.artifacts) !== entry.artifactsDigest
        || JSON.stringify(current.envelope.budget) !== JSON.stringify(data.budget)) reject();
      binding(data, current);
      const refs = data.store.readRefs(data.taskId);
      if (refs.length !== 1 || refs[0]!.taskRevision !== entry.modelRevision) reject();
      exactBindingDescriptor(data, refs[0]!);
      const events = data.store.readEvents(data.taskId);
      const refEvents = events.filter(event => event.eventId === `ref-registered:${data.bindingRef}`);
      const phases = events.filter(event => event.eventId === `phase:${data.taskId}:1:PREPARE-MODEL`);
      if (refEvents.length !== 1 || phases.length !== 1 || refEvents[0]!.kind !== 'ref-registered'
        || phases[0]!.kind !== 'phase-advanced' || refEvents[0]!.revision !== entry.modelRevision
        || phases[0]!.revision !== entry.modelRevision || events.indexOf(refEvents[0]!) + 1 !== events.indexOf(phases[0]!)
        || refEvents[0]!.acceptedAt !== phases[0]!.acceptedAt || refs[0]!.registeredAt !== phases[0]!.acceptedAt) reject();
      fresh(data); const finalRecord = actualRecord(data, current), now = at(data.clock);
      if (now.ms >= data.deadlineMs || Date.parse(finalRecord.leaseExpiresAt!) <= now.ms || data.signal.aborted) reject();
    } catch { return reject(); }
  }

  /** Burn first: wrong route, source, model result, clone, abort or replay cannot retry this capability. */
  function consume(value: unknown, input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord; decision: unknown;
  }>): boolean {
    const entry = object(value) ? capabilities.get(value) : undefined;
    if (object(value)) capabilities.delete(value);
    if (!entry) return false;
    try {
      const data = entry.authorization;
      if (input.store !== data.store || input.ownerId !== data.ownerId) return false;
      fresh(data); const current = actualRecord(data, input.record), task = current.envelope;
      const decision = normalizeAgentLoopDecision(input.decision);
      if (current.revision !== entry.modelRevision + 1 || task.phase !== 'ACT' || task.state !== 'RUNNING'
        || task.currentAttemptId !== data.attemptId || digest(task.artifacts) !== entry.artifactsDigest
        || decision.kind !== 'act' || decision.actionContractRef !== config.actionContractRef
        || decision.taskId !== task.taskId || decision.attemptId !== data.attemptId
        || decision.expectedTaskRevision !== entry.modelRevision || decision.taskContractRef !== task.taskContractRef
        || decision.harnessRunId !== data.runId) return false;
      binding(data, current);
      const budget = task.budget;
      if (budget.spent.modelCalls !== 1 || budget.spent.toolCalls !== 0
        || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => budget.reserved[key] !== 0 || budget.spent[key] > budget.granted[key])
        || ['writes', 'highRiskActions', 'childTasks'].some(key => budget.spent[key as keyof typeof budget.spent] !== 0)) return false;
      return true;
    } catch { return false; }
  }

  function revoke(value: unknown): void {
    if (object(value)) capabilities.delete(value);
  }


  return Object.freeze({ issue, evidence, prepare, assertPrepared, finalize, assertModelCapability, consume, revoke });
}
