/** Real source-derived typed-ref metadata. Neither descriptors nor disk origin grant execution.
 * Bodies stay in the original Session/Manager. All live authority is re-read from
 * the original host and Managers; a reference is never parsed to choose a reader.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AgentLoopProjectionStore, type AgentLoopArtifactRefDescriptor, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MaintenanceJobManager, type MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { agentLoopMaintenanceBindingRef, agentLoopMaintenanceClaimDigest } from './agent-loop-get-variables-authorization.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { normalizeMaintenanceAgentLoopShadowProposal, parseMaintenanceAgentLoopShadowProposalPreparation,
  type MaintenanceAgentLoopShadowProposalRecord } from './maintenance-agent-loop-shadow-proposal.ts';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { normalizeAgentLoopActionDigest } from './agent-loop-action-receipt.ts';
import type { AgentLoopMaintenanceRollingSummaryProposalActionOptions } from './agent-loop-maintenance-rolling-summary-proposal-action.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, normalizeAgentLoopModelCorrectionPolicy,
  type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';

export type AgentLoopRollingSummaryArtifactSourceOptions = AgentLoopMaintenanceRollingSummaryProposalActionOptions;
export interface AgentLoopCorrectionRollingSummaryArtifactSourceOptions extends AgentLoopRollingSummaryArtifactSourceOptions {
  readonly policy: AgentLoopModelCorrectionPolicy;
  readonly modelRecord: AgentLoopTaskRecord;
  readonly modelOutcome: unknown;
  readonly actionRecord: AgentLoopTaskRecord;
  readonly actionOutcome: unknown;
  readonly observeRecord: AgentLoopTaskRecord;
  readonly rejectedModelOutcome?: unknown;
}
const REJECTED = 'agent-loop-rolling-summary-artifact-source-invalid';
function reject(): never { throw new Error(REJECTED); }
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function dataOnly(value: unknown, stack = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || stack.has(value)
    || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  stack.add(value);
  try {
    if (Array.isArray(value) && Reflect.ownKeys(value).length !== value.length + 1) reject();
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !property || !Object.hasOwn(property, 'value')
        || !property.enumerable && !(Array.isArray(value) && key === 'length')) reject();
      dataOnly(property.value, stack);
    }
  } finally { stack.delete(value); }
}
function at(clock: () => string): string {
  const value = clock();
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
  return value;
}
function sourceData(source: AgentLoopMaintenanceExecutionPrepareSource) {
  dataOnly(source.job); dataOnly(source.profile); dataOnly(source.snapshot);
  return { profile: resolveAgentLoopMaintenanceProfile(source), snapshot: validateAgentLoopMaintenanceSnapshot(source) };
}
/** Matches the actual proposal producer's source digest, not a caller's expected hash. */
export function agentLoopRollingSummarySourceDigest(source: AgentLoopMaintenanceExecutionPrepareSource): string {
  try { return digest(sourceData(source)); } catch { return reject(); }
}
function validatePair(execution: MaintenanceExecutionRecord, source: AgentLoopMaintenanceExecutionPrepareSource, allowApply = false): void {
  dataOnly(execution); sourceData(source);
  if (execution.executorRoute !== 'agent-loop' || execution.job.taskKind !== 'rolling_summary'
    || (execution.job.mode !== 'shadow' && !(allowApply && execution.job.mode === 'apply')) || execution.job.status !== 'running'
    || JSON.stringify(source.job) !== JSON.stringify(execution.job)
    || source.snapshot.revision !== execution.job.sourceRevision) reject();
}

/** Metadata only. A trusted Prepared grant must carry it through the original CAS. */
export function createAgentLoopMaintenanceExecutionBindingDescriptor(execution: MaintenanceExecutionRecord,
  source: AgentLoopMaintenanceExecutionPrepareSource): AgentLoopArtifactRefDescriptor {
  try {
    validatePair(execution, source, true);
    const refId = agentLoopMaintenanceBindingRef(execution, source);
    return Object.freeze({ refId, kind: 'session-artifact', ownerRef: `maintenancejob.${execution.job.runId}`,
      expectedDigest: `sha256:${refId.slice('execution.prepare:'.length)}`,
      expectedRevision: agentLoopMaintenanceClaimDigest(execution), policy: 'required', aclClass: 'restricted', expandBudgetTokens: 0 });
  } catch { return reject(); }
}

/** Pure metadata identity, shared with historical publication readback. No reader or grant. */
export function agentLoopRollingSummaryProposalArtifactRef(input: Readonly<{
  claimDigest: string; actionId: string; preparationDigest: string;
}>): string {
  try {
    normalizeAgentLoopActionObject(input, ['claimDigest', 'actionId', 'preparationDigest']);
    return `maintenance.proposal.artifact:${digest({ version: 'agent-loop-rolling-summary-proposal-artifact-v1',
      claimDigest: normalizeAgentLoopActionDigest(input.claimDigest), actionId: normalizeAgentLoopActionToken(input.actionId),
      preparationDigest: normalizeAgentLoopActionDigest(input.preparationDigest) }).slice(7)}`;
  } catch { return reject(); }
}

/** Pure artifact declaration from the real canonical body and its original storage origin.
 * The verifier must separately join the actual AL receipt; this builder supplies no proof brand.
 */
export function createAgentLoopRollingSummaryProposalArtifact(input: Readonly<{
  execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceExecutionPrepareSource;
  proposal: MaintenanceAgentLoopShadowProposalRecord; actionId: string;
}>) {
  try {
    normalizeAgentLoopActionObject(input, ['execution', 'source', 'proposal', 'actionId']);
    const { execution, source, proposal } = input;
    validatePair(execution, source); dataOnly(proposal);
    const actionId = normalizeAgentLoopActionToken(input.actionId), claimDigest = agentLoopMaintenanceClaimDigest(execution);
    const body = normalizeMaintenanceAgentLoopShadowProposal({ proposal: proposal.proposal, proposalContext: proposal.context });
    const expectedContext = sourceData(source).snapshot.proposalContext;
    if (!expectedContext) reject();
    const context = normalizeMaintenanceAgentLoopShadowProposal({ proposal: proposal.proposal, proposalContext: expectedContext });
    const preparation = parseMaintenanceAgentLoopShadowProposalPreparation(proposal.preparation, { job: execution.job,
      createdAt: proposal.createdAt, proposalDigest: body.proposalDigest, proposalContextDigest: body.proposalContextDigest });
    if (proposal.jobRunId !== execution.job.runId || proposal.sessionId !== execution.job.sessionId
      || proposal.sourceRevision !== execution.job.sourceRevision || proposal.taskKind !== 'rolling_summary'
      || proposal.status !== 'prepared' || proposal.revision !== 1 || proposal.updatedAt !== proposal.createdAt
      || proposal.proposalId !== `mprop_${execution.job.runId.slice(5)}` || proposal.proposalDigest !== body.proposalDigest
      || preparation.ownerInstanceId !== execution.leaseOwnerInstanceId || preparation.attempt !== execution.job.attempt
      || context.proposalContextDigest !== body.proposalContextDigest) reject();
    const artifactRef = agentLoopRollingSummaryProposalArtifactRef({ claimDigest, actionId, preparationDigest: preparation.preparationDigest });
    return Object.freeze({
      artifact: Object.freeze({ artifactRef, kind: 'agent-loop-rolling-summary-proposal', status: 'available' as const,
        evidenceRefs: Object.freeze([...new Set([claimDigest, proposal.proposalDigest,
          preparation.proposalContextDigest, preparation.preparationDigest])].sort()) }),
      descriptor: Object.freeze({ refId: artifactRef, kind: 'candidate' as const,
        ownerRef: `maintenancejob.${execution.job.runId}`, expectedDigest: preparation.preparationDigest,
        expectedRevision: claimDigest, policy: 'required' as const, aclClass: 'restricted' as const, expandBudgetTokens: 0 }),
    });
  } catch { return reject(); }
}

/** Fresh synchronous host/source binding shared by resolvers and verification, never a phase driver. */
export function createAgentLoopRollingSummaryArtifactSource(options: AgentLoopRollingSummaryArtifactSourceOptions) {
  return createArtifactSource(options, 'single-pass');
}
/** The independent corrected-shadow contract must supply its original live
 * MODEL/Action outcomes and exact snapshots. DTOs/refs are not authority. */
export function createAgentLoopCorrectionRollingSummaryArtifactSource(options: AgentLoopCorrectionRollingSummaryArtifactSourceOptions) {
  return createArtifactSource(options, 'correction');
}
function createArtifactSource(options: AgentLoopRollingSummaryArtifactSourceOptions | AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
  kind: 'single-pass' | 'correction') {
  try {
    const correction = kind === 'correction';
    let extra = options as AgentLoopCorrectionRollingSummaryArtifactSourceOptions;
    let correctionInert: ((value: unknown) => void) | undefined;
    if (kind !== 'single-pass' && kind !== 'correction') reject();
    if (correction && nodeTypes.isPromise(options)) { void Promise.prototype.then.call(options,()=>undefined,()=>undefined); reject(); }
    if (correction && nodeTypes.isProxy(options)) reject();
    normalizeAgentLoopActionObject(options, ['store', 'manager', 'ownerId', 'clock', 'signal', 'execution', 'fixedSource', 'readCurrent',
      ...(correction ? ['policy','modelRecord','modelOutcome','actionRecord','actionOutcome','observeRecord'] : [])],
      correction ? ['rejectedModelOutcome'] : []);
    if (correction) {
      const inert = (value: unknown, seen = new Set<object>()): void => {
        if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value,()=>undefined,()=>undefined); reject(); }
        if (value === null || typeof value !== 'object') { if (typeof value === 'function' || typeof value === 'symbol') reject(); return; }
        if (nodeTypes.isProxy(value) || seen.has(value) || !Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) reject();
        seen.add(value);
        try { for (const key of Reflect.ownKeys(value)) {
          const field = Object.getOwnPropertyDescriptor(value,key);
          if (typeof key !== 'string' || !field || !Object.hasOwn(field,'value')) reject();
          inert(field.value,seen);
        } } finally { seen.delete(value); }
      };
      correctionInert = inert;
      if ([extra.store,extra.manager,extra.clock,extra.signal,extra.readCurrent,extra.fixedSource].some(value => nodeTypes.isProxy(value))) reject();
      normalizeAgentLoopActionObject(extra.fixedSource,['job','profile','snapshot','sessionIdentity']);
      for (const value of [extra.policy,extra.modelRecord,extra.actionRecord,extra.observeRecord,extra.execution,
        extra.fixedSource.job,extra.fixedSource.profile,extra.fixedSource.snapshot]) inert(value);
      const pin = <T>(value: T): T => {
        const result = structuredClone(value);
        const freeze = (item: unknown): void => { if (item && typeof item === 'object') {
          for (const field of Object.values(item)) freeze(field); Object.freeze(item);
        } }; freeze(result); return result;
      };
      extra = Object.freeze({ ...extra, policy: normalizeAgentLoopModelCorrectionPolicy(extra.policy),
        modelRecord: pin(extra.modelRecord), actionRecord: pin(extra.actionRecord), observeRecord: pin(extra.observeRecord),
        execution: pin(extra.execution), fixedSource: Object.freeze({ job: pin(extra.fixedSource.job),
          profile: pin(extra.fixedSource.profile), snapshot: pin(extra.fixedSource.snapshot), sessionIdentity: extra.fixedSource.sessionIdentity }) });
      options = extra;
    }
    const { store, manager, ownerId, clock: rawClock, signal, readCurrent } = options;
    const clock = correction ? () => {
      const value: unknown = rawClock();
      if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value,()=>undefined,()=>undefined); reject(); }
      if (typeof value !== 'string') reject();
      return value;
    } : rawClock;
    if (!(store instanceof AgentLoopProjectionStore) || !(manager instanceof MaintenanceJobManager)
      || typeof clock !== 'function' || typeof readCurrent !== 'function' || !(signal instanceof AbortSignal) || signal.aborted) reject();
    validatePair(options.execution, options.fixedSource);
    const goal = resolveAgentLoopRollingSummaryGoal({ execution: options.execution, now: at(clock) });
    const fixed = sourceData(options.fixedSource), sourceDigest = digest(fixed);
    const identity = options.fixedSource.sessionIdentity;
    if (goal.mode !== 'shadow' || goal.binding.ownerId !== ownerId || !identity || typeof identity !== 'object'
      || fixed.profile.budgetProfile.maxModelCalls !== 1 || fixed.profile.budgetProfile.maxToolCalls < 1
      || fixed.profile.budgetProfile.maxWrites < 1) reject();
    const deadlineMs = Date.parse(goal.binding.startedAt) + fixed.profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(deadlineMs) || correction && (Date.parse(extra.policy.deadlineAt) > deadlineMs
      || Date.parse(extra.policy.deadlineAt) <= Date.parse(at(clock)))) reject();
    const capture = () => {
      if (signal.aborted || Date.parse(at(clock)) >= deadlineMs
        || correction && Date.parse(at(clock)) >= Date.parse(extra.policy.deadlineAt)) reject();
      const value = readCurrent();
      if (value !== null && typeof value === 'object') {
        let asynchronous = false;
        try { void Promise.prototype.then.call(value, () => undefined, () => undefined); asynchronous = true; }
        catch { /* Never invoke arbitrary thenables or getters. */ }
        if (asynchronous) reject();
      }
      if (correction && nodeTypes.isProxy(value)) reject();
      normalizeAgentLoopActionObject(value, ['execution', 'source']);
      if (!value) reject();
      normalizeAgentLoopActionObject(value.source, ['job', 'profile', 'snapshot', 'sessionIdentity']);
      if (correction) for (const item of [value.execution,value.source.job,value.source.profile,value.source.snapshot]) correctionInert!(item);
      validatePair(value.execution, value.source);
      const currentGoal = resolveAgentLoopRollingSummaryGoal({ execution: value.execution, now: at(clock) });
      const actual = manager.readExecution(goal.binding.runId);
      if (!actual || value.source.sessionIdentity !== identity || currentGoal.claimDigest !== goal.claimDigest
        || resolveAgentLoopRollingSummaryGoal({ execution: actual, now: at(clock) }).claimDigest !== goal.claimDigest
        || !manager.settings(goal.binding.sessionId).effectiveEnabled || digest(sourceData(value.source)) !== sourceDigest
        || signal.aborted || Date.parse(at(clock)) >= deadlineMs
        || correction && Date.parse(at(clock)) >= Date.parse(extra.policy.deadlineAt)) reject();
      return { execution: value.execution, source: value.source };
    };
    const completionLineage = (expectedRevision: number) => store.readModelCorrectionCompletionLineage({ taskId: goal.taskId, expectedRevision,
      ownerId, policy: extra.policy, modelRecord: extra.modelRecord, modelOutcome: extra.modelOutcome,
      actionRecord: extra.actionRecord, actionOutcome: extra.actionOutcome, observeRecord: extra.observeRecord,
      ...(Object.hasOwn(extra,'rejectedModelOutcome') ? {rejectedModelOutcome: extra.rejectedModelOutcome} : {}) });
    if (correction) {
      const current = store.read(goal.taskId);
      if (!current) reject();
      capture(); completionLineage(current.revision); capture();
    }
    return Object.freeze({
      /** Safe under the original AL writer lock: no nested AL Store transaction. */
      assertSourceCurrent(): void {
        try { capture(); } catch { return reject(); }
      },
      read(expectedRevision: number) {
      try {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) reject();
        const current = capture(), record = store.read(goal.taskId), now = at(clock);
        if (!record || record.revision !== expectedRevision || record.fenced || record.ownerId !== ownerId
          || !record.leaseExpiresAt || record.leaseExpiresAt <= now || record.envelope.state !== 'RUNNING'
          || !['MODEL', 'ACT', 'OBSERVE', 'VERIFY'].includes(record.envelope.phase)
          || record.envelope.currentAttemptId !== goal.attemptId || record.envelope.taskKind !== goal.taskKind
          || record.envelope.taskContractRef !== (correction ? AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF : goal.contractRef)
          || record.envelope.verifier.verifierSetRef !== goal.verifierSetRef
          || record.envelope.verifier.verifierSetRevision !== goal.verifierSetRevision
          || record.envelope.budget.policyRef !== 'agent.budget.maintenance'
          || JSON.stringify(record.envelope.goal.sourceRefs) !== JSON.stringify([
            `maintenancejob.${goal.binding.runId}`, `revision.${goal.binding.sourceRevision}`])) reject();
        const bindingDescriptor = createAgentLoopMaintenanceExecutionBindingDescriptor(current.execution, current.source);
        const bindings = record.envelope.artifacts.filter(item => item.kind === 'agent-loop-execution-binding');
        if (bindings.length !== 1 || bindings[0]!.artifactRef !== bindingDescriptor.refId
          || bindings[0]!.status !== 'declared' || !bindings[0]!.evidenceRefs.includes(goal.claimDigest)) reject();
        const lineage = correction ? completionLineage(expectedRevision) : undefined;
        capture();
        const latest = store.read(goal.taskId);
        if (!latest || latest.revision !== record.revision || latest.envelopeDigest !== record.envelopeDigest
          || latest.fenced || latest.ownerId !== ownerId || !latest.leaseExpiresAt || latest.leaseExpiresAt <= at(clock)) reject();
        return Object.freeze({ goal, record, ...current, sourceDigest, bindingDescriptor, ...(lineage ? { lineage } : {}) });
      } catch { return reject(); }
    } });
  } catch { return reject(); }
}
