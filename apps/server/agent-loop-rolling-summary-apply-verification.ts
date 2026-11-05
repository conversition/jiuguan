/** Apply-specific evidence join and required verifiers. Bodies stay in the
 * original Session. The original source remains audit-only; the separate host
 * source can prepare a purpose-restricted live outcome, never direct AL commit. */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopTaskEnvelope } from '@jiuguan/agent-loop-contract';
import { agentLoopActionDigest } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT as APPLY, normalizeAgentLoopActionDigest,
  normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { createAgentLoopMaintenanceExecutionBindingDescriptor } from './agent-loop-rolling-summary-artifacts.ts';
import { createAgentLoopRollingSummaryApplyArtifact } from './agent-loop-rolling-summary-apply-artifacts.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import type { AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { AgentLoopProjectionStore, agentLoopProjectionEventDigest, type AgentLoopArtifactRefDescriptor,
  type AgentLoopArtifactRefRecord, type AgentLoopTaskEvent } from './agent-loop-projection-store.ts';
import { MaintenanceJobManager, type MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { MaintenanceModelHostEnvironment } from './maintenance-model-host-guard.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import { isRollingSummaryApplyContext, validateMaintenanceProposal } from './maintenance-types.ts';
import { summaryWriteDigest } from './maintenance-summary-write-receipt.ts';
import { agentLoopSummaryWriteDigest } from './agent-loop-summary-write-origin.ts';
import { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';
import { AgentLoopVerifierRegistry, type AgentLoopCompletionCandidate, type AgentLoopVerifierRunner } from './agent-loop-completion-gate.ts';
import { evaluateFrozenAgentLoopCompletion, prepareFrozenAgentLoopCompletion, restrictFrozenAgentLoopDirectCommit,
  type AgentLoopCompletionDecision, type AgentLoopFrozenCompletionInput } from './agent-loop-frozen-completion.ts';
import type { StoredAgentLoopCompletionVerification } from './agent-loop-completion-record.ts';
import type { AgentLoopRefResolver } from './agent-loop-continuation.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';

export const AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFICATION_VERSION = 'agent-loop-rolling-summary-apply-verification-v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFIER_IDS = Object.freeze({
  artifact: 'verify.maintenance.rolling_summary.apply.artifact.v1',
  action: 'verify.maintenance.rolling_summary.apply.action.v1',
  domain: 'verify.maintenance.rolling_summary.apply.domain.v1',
} as const);
type Reason = 'input-invalid' | 'source-stale' | 'domain-invalid' | 'action-invalid' | 'artifacts-invalid' | 'candidate-invalid';
export class AgentLoopRollingSummaryApplyVerificationError extends Error {
  readonly code: string;
  constructor(reason: Reason) {
    const code = `agent-loop-rolling-summary-apply-verification-${reason}`;
    super(code); this.name = 'AgentLoopRollingSummaryApplyVerificationError'; this.code = code;
  }
}
function reject(reason: Reason): never { throw new AgentLoopRollingSummaryApplyVerificationError(reason); }
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function same(left: unknown, right: unknown): boolean { return agentLoopSummaryWriteDigest(left) === agentLoopSummaryWriteDigest(right); }
function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject('input-invalid');
  return value;
}
function synchronous(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    try { void Promise.prototype.then.call(value, () => undefined, () => undefined); } catch { return; }
    reject('source-stale');
  }
}
function descriptorFields(value: AgentLoopArtifactRefDescriptor): AgentLoopArtifactRefDescriptor {
  return { refId: value.refId, kind: value.kind, ownerRef: value.ownerRef, expectedDigest: value.expectedDigest,
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision }),
    policy: value.policy, aclClass: value.aclClass, expandBudgetTokens: value.expandBudgetTokens };
}
function uniqueEvent(events: readonly AgentLoopTaskEvent[], eventId: string, kind: string, revision: number, reason?: string) {
  const found = events.filter(event => event.eventId === eventId);
  if (found.length !== 1 || found[0]!.kind !== kind || found[0]!.revision !== revision
    || found[0]!.reasonCode !== reason) reject('action-invalid');
  return found[0]!;
}
function actualDescriptor(expected: AgentLoopArtifactRefDescriptor, refs: readonly AgentLoopArtifactRefRecord[],
  phase: AgentLoopTaskEvent, events: readonly AgentLoopTaskEvent[]) {
  const found = refs.filter(ref => ref.refId === expected.refId);
  if (found.length !== 1 || !same(descriptorFields(found[0]!), expected) || found[0]!.taskRevision !== phase.revision) reject('artifacts-invalid');
  const event = uniqueEvent(events, `ref-registered:${expected.refId}`, 'ref-registered', phase.revision);
  // Public registerRef at the same revision AFTER the CAS cannot backfill its lineage.
  if (event.acceptedAt !== found[0]!.registeredAt || event.acceptedAt !== phase.acceptedAt
    || events.indexOf(event) + 1 !== events.indexOf(phase)) reject('artifacts-invalid');
  return found[0]!;
}
export interface AgentLoopRollingSummaryApplyVerificationOptions {
  readonly store: AgentLoopProjectionStore; readonly manager: MaintenanceJobManager; readonly ownerId: string;
  readonly clock: () => string; readonly signal: AbortSignal; readonly execution: MaintenanceExecutionRecord;
  readonly fixedSource: AgentLoopMaintenanceExecutionPrepareSource;
  /** Original trusted host liveness read, reporting the ACTUAL post-write token. */
  readonly readLive: () => MaintenanceModelHostEnvironment | null;
  readonly committer: MemorySummaryMaintenanceCommitter;
}
export interface AgentLoopRollingSummaryApplyVerificationEvidence {
  readonly version: typeof AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFICATION_VERSION;
  readonly taskId: string; readonly taskRevision: number; readonly envelopeDigest: string; readonly attemptId: string;
  readonly mode: 'apply'; readonly claimDigest: string; readonly runId: string; readonly sessionId: string;
  readonly sourceRevision: string; readonly sourceDigest: string; readonly postSourceRevision: string; readonly currentSourceRevision: string;
  readonly actionId: string; readonly actionRevision: number; readonly actionDigest: string; readonly actionWatermark: string; readonly observationId: string;
  readonly originDigest: string; readonly intentDigest: string; readonly readbackDigest: string; readonly historyDigest: string;
  readonly proposalDigest: string; readonly contextDigest: string;
  readonly operationDigest: string; readonly budgetDigest: string; readonly actionUpdatedAt: string;
  readonly domainCommittedAt: string; readonly domainVerifiedAt: string;
  readonly bindingDescriptor: AgentLoopArtifactRefRecord; readonly applyDescriptor: AgentLoopArtifactRefRecord;
  readonly canonicalEvidenceRefs: readonly string[]; readonly actionEvidenceRefs: readonly string[]; readonly domainEvidenceRefs: readonly string[];
}
export interface AgentLoopRollingSummaryApplyVerification {
  read(expectedRevision: number): AgentLoopRollingSummaryApplyVerificationEvidence;
  readonly resolvers: Readonly<{ 'session-artifact': AgentLoopRefResolver; 'memory-record': AgentLoopRefResolver }>;
  readonly registry: AgentLoopVerifierRegistry; readonly runners: Readonly<Record<string, AgentLoopVerifierRunner>>;
  evaluate(input: Readonly<{ candidateRef: string; expectedRevision: number; repairAttempts?: number; maxRepairAttempts?: number }>): Promise<StoredAgentLoopCompletionVerification>;
}

export function createAgentLoopRollingSummaryApplyVerificationSource(
  options: AgentLoopRollingSummaryApplyVerificationOptions,
): AgentLoopRollingSummaryApplyVerification {
  const source = createApplyVerificationSource(options);
  return Object.freeze({ read: source.read, resolvers: source.resolvers, registry: source.registry,
    runners: source.runners, evaluate: source.evaluate });
}

/** Internal trusted-host seam. The original runners must execute again; stored
 * audits cannot issue this outcome. It is restricted BEFORE becoming visible. */
export function createAgentLoopRollingSummaryApplyLiveVerificationSource(options: AgentLoopRollingSummaryApplyVerificationOptions) {
  return createApplyVerificationSource(options);
}

function createApplyVerificationSource(options: AgentLoopRollingSummaryApplyVerificationOptions): AgentLoopRollingSummaryApplyVerification & Readonly<{
  prepare(input: Parameters<AgentLoopRollingSummaryApplyVerification['evaluate']>[0]): Promise<AgentLoopCompletionDecision>;
  assertSourceCurrentAtCommit(evidence: AgentLoopRollingSummaryApplyVerificationEvidence): void;
}> {
  try {
    normalizeAgentLoopActionObject(options, ['store', 'manager', 'ownerId', 'clock', 'signal', 'execution', 'fixedSource', 'readLive', 'committer']);
    const { store, manager, ownerId, clock, signal, readLive, committer } = options;
    if (!(store instanceof AgentLoopProjectionStore) || !(manager instanceof MaintenanceJobManager)
      || !(committer instanceof MemorySummaryMaintenanceCommitter) || !(signal instanceof AbortSignal)
      || typeof readLive !== 'function' || typeof clock !== 'function') reject('input-invalid');
    normalizeAgentLoopActionObject(options.fixedSource, ['job', 'profile', 'snapshot', 'sessionIdentity']);
    agentLoopSummaryWriteDigest(options.execution);
    agentLoopSummaryWriteDigest({ job: options.fixedSource.job, profile: options.fixedSource.profile, snapshot: options.fixedSource.snapshot });
    const execution = structuredClone(options.execution), identity = options.fixedSource.sessionIdentity;
    const source = { ...structuredClone({ job: options.fixedSource.job, profile: options.fixedSource.profile, snapshot: options.fixedSource.snapshot }), sessionIdentity: identity };
    const fixed = { profile: resolveAgentLoopMaintenanceProfile(source), snapshot: validateAgentLoopMaintenanceSnapshot(source) };
    // Select immutable historical claim metadata, not liveness from a captured
    // DTO's old TTL. Every actual read/commit below checks the renewed Manager
    // and live host against the REAL clock and original total deadline.
    time(clock());
    const goal = resolveAgentLoopRollingSummaryGoal({ execution, now: time(execution.job.updatedAt) });
    const sourceDigest = agentLoopSummaryWriteDigest(fixed), context = fixed.snapshot.proposalContext;
    if (goal.mode !== 'apply' || !goal.requiresDomainWrite || goal.binding.ownerId !== ownerId
      || !identity || typeof identity !== 'object' || !same(source.job, execution.job) || !isRollingSummaryApplyContext(context)
      || fixed.profile.budgetProfile.maxModelCalls !== 1 || fixed.profile.budgetProfile.maxToolCalls < 1
      || fixed.profile.budgetProfile.maxWrites < 1) reject('input-invalid');
    const taskId = goal.taskId, registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
    const deadline = Date.parse(goal.binding.startedAt) + fixed.profile.budgetProfile.maxWallMs;
    // The host's selected job header and Manager DTO can have different key
    // order. Preserve the ORIGINAL source bytes, not a re-serialized Manager job.
    const binding = createAgentLoopMaintenanceExecutionBindingDescriptor({ ...execution, job: source.job }, source);
    let lastNow = '';
    const at = () => { const now = time(clock()); if (now < lastNow) reject('source-stale'); lastNow = now; return now; };
    // No AL Store access: safe under the original Frozen writer lock too.
    const capture = (expectedToken?: string) => {
      if (signal.aborted || Date.parse(at()) >= deadline) reject('source-stale');
      const value = readLive(); synchronous(value);
      normalizeAgentLoopActionObject(value, ['execution', 'sessionIdentity', 'sourceRevision', 'contentMode',
        'providerId', 'modelId', 'runtimeProfile', 'budgetProfile']);
      if (!value || value.sessionIdentity !== identity) reject('source-stale');
      agentLoopSummaryWriteDigest({ execution: value.execution, runtimeProfile: value.runtimeProfile, budgetProfile: value.budgetProfile });
      const token = normalizeAgentLoopActionDigest(value.sourceRevision);
      const profile = resolveAgentLoopMaintenanceProfile({ ...source, job: value.execution.job,
        profile: { providerId: value.providerId, modelId: value.modelId, runtimeProfile: value.runtimeProfile,
          budgetProfile: value.budgetProfile, policyVersion: value.execution.job.policyVersion, contentMode: value.contentMode } });
      const actual = manager.readExecution(goal.binding.runId), now = at();
      if (!actual || !manager.settings(goal.binding.sessionId).effectiveEnabled || !same(profile, fixed.profile)
        || resolveAgentLoopRollingSummaryGoal({ execution: actual, now }).claimDigest !== goal.claimDigest
        || resolveAgentLoopRollingSummaryGoal({ execution: value.execution, now }).claimDigest !== goal.claimDigest
        || expectedToken !== undefined && token !== expectedToken || signal.aborted || Date.parse(at()) >= deadline) reject('source-stale');
      return token;
    };
    const domain = () => {
      try {
        const artifact = committer.readAgentLoopSummaryWriteArtifact(goal.binding.runId);
        if (!artifact || artifact.evidence.state !== 'applied' || !artifact.evidence.readback) reject('domain-invalid');
        const { evidence, proposal } = artifact, { origin, intent, readback } = evidence;
        if (!readback) reject('domain-invalid');
        const validated = validateMaintenanceProposal('rolling_summary', proposal.payload, context);
        const current = committer.readSummaryRetrievalLineage({ summaryDigest: intent.summaryDigest,
          throughRound: intent.throughRound, historyEpoch: intent.historyEpoch });
        const { origin: _origin, ...history } = evidence;
        if (!current || !same(current, history) || !same(validated, proposal)
          || summaryWriteDigest(proposal) !== origin.proposalDigest || summaryWriteDigest(context) !== origin.contextDigest
          || origin.runId !== goal.binding.runId || origin.sessionId !== goal.binding.sessionId || origin.taskId !== taskId
          || origin.attemptId !== goal.attemptId || origin.ownerId !== ownerId || origin.claimAttempt !== goal.binding.attempt
          || origin.claimDigest !== goal.claimDigest || origin.sourceRevision !== goal.binding.sourceRevision
          || origin.sourceDigest !== sourceDigest || origin.actionContractRef !== APPLY
          || intent.committedAt < origin.authorizedAt || intent.committedAt >= origin.authorizationExpiresAt) reject('domain-invalid');
        return { evidence, proposal, origin, intent, readback, historyDigest: agentLoopSummaryWriteDigest(artifact) };
      } catch (error) { if (error instanceof AgentLoopRollingSummaryApplyVerificationError) throw error; return reject('domain-invalid'); }
    };
    const readEvidence = (expectedRevision: number, allowSourceDrift = false): AgentLoopRollingSummaryApplyVerificationEvidence => {
      try {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) reject('input-invalid');
        const liveToken = capture(), record = store.read(taskId), now = at();
        if (!record || record.revision !== expectedRevision || record.fenced || record.ownerId !== ownerId
          || !record.leaseExpiresAt || record.leaseExpiresAt <= now || record.envelope.state !== 'RUNNING'
          || !['OBSERVE', 'VERIFY'].includes(record.envelope.phase) || record.envelope.currentAttemptId !== goal.attemptId
          || record.envelope.taskKind !== registration.taskKind || record.envelope.taskContractRef !== registration.contractRef
          || record.envelope.verifier.verifierSetRef !== registration.verifierSetRef
          || record.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
          || record.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
          || digest(record.envelope) !== record.envelopeDigest || record.envelope.updatedAt > now
          || !same(record.envelope.goal.sourceRefs, [`maintenancejob.${goal.binding.runId}`, `revision.${goal.binding.sourceRevision}`])) reject('source-stale');
        const history = domain(), { origin, intent, readback, proposal } = history;
        const events = store.readEvents(taskId), refs = store.readRefs(taskId), observations = store.readObservations(taskId);
        const started = events.filter(event => event.kind === 'action-started'), completed = events.filter(event => event.kind === 'action-completed');
        if (started.length !== 1 || completed.length !== 1 || events.some(event => event.kind === 'action-reconciled')) reject('action-invalid');
        const actionId = origin.actionId, receipt = store.readActionReceipt({ taskId, actionId });
        if (!receipt || receipt.status !== 'observed' || receipt.actionContractRef !== APPLY || receipt.taskId !== taskId
          || receipt.ownerId !== ownerId || receipt.attemptId !== goal.attemptId || receipt.expectedRevision !== origin.taskRevision
          || receipt.expectedRevision !== 3 || receipt.appliedRevision !== 4 || !receipt.result || !receipt.startedAt
          || !receipt.completedAt || !receipt.settledAt || !receipt.observedAt || receipt.releasedAt !== undefined
          || receipt.receiptRef !== `receipt:${actionId}` || receipt.observationId !== `obs:${actionId}`) reject('action-invalid');
        const actionRevision = receipt.expectedRevision, appliedRevision = receipt.appliedRevision;
        const actionWatermark = `action-completed:${actionId}`;
        const start = uniqueEvent(events, `action-started:${actionId}`, 'action-started', actionRevision, 'act');
        const completedEvent = uniqueEvent(events, actionWatermark, 'action-completed', appliedRevision, 'act');
        const observedEvent = uniqueEvent(events, `observation:${receipt.observationId}`, 'observation-applied', appliedRevision);
        const phase = uniqueEvent(events, `phase:${taskId}:${appliedRevision}:ACT-OBSERVE`, 'phase-advanced', appliedRevision + 1, 'act');
        const actPhase = uniqueEvent(events, `phase:${taskId}:${actionRevision - 1}:MODEL-ACT`, 'phase-advanced', actionRevision, 'act');
        const initialPhase = uniqueEvent(events, `phase:${taskId}:1:PREPARE-MODEL`, 'phase-advanced', 2);
        if (expectedRevision !== (record.envelope.phase === 'OBSERVE' ? 5 : 6)
          || started[0]!.eventId !== start.eventId || completed[0]!.eventId !== actionWatermark
          || start.acceptedAt > receipt.createdAt || completedEvent.acceptedAt < receipt.observedAt
          || observedEvent.acceptedAt !== receipt.observedAt || initialPhase.acceptedAt > receipt.startedAt
          || actPhase.acceptedAt > start.acceptedAt || receipt.createdAt > receipt.startedAt
          || receipt.startedAt > receipt.completedAt || receipt.completedAt > receipt.settledAt
          || receipt.settledAt > receipt.observedAt || receipt.observedAt > phase.acceptedAt
          || origin.authorizedAt < receipt.startedAt || readback.verifiedAt > receipt.completedAt
          || origin.authorizationExpiresAt > new Date(Date.parse(origin.authorizedAt) + receipt.estimate.wallMs).toISOString()) reject('action-invalid');
        const actionUpdatedRef = receipt.result.evidenceRefs[10], postSourceRevision = normalizeAgentLoopActionDigest(receipt.result.evidenceRefs[9]);
        if (typeof actionUpdatedRef !== 'string' || !actionUpdatedRef.startsWith('act-updated-at:')) reject('action-invalid');
        const actionUpdatedAt = time(actionUpdatedRef.slice('act-updated-at:'.length));
        const actionDigest = agentLoopActionDigest({ actionId, taskId, attemptId: goal.attemptId,
          expectedTaskRevision: actionRevision, actionContractRef: APPLY, args: proposal.payload });
        const expectedRefs = [goal.claimDigest, origin.originDigest, origin.proposalDigest, origin.contextDigest,
          origin.sourceDigest, origin.budgetDigest, intent.intentDigest, intent.operationDigest, readback.readbackDigest,
          postSourceRevision, actionUpdatedRef];
        if (receipt.actionDigest !== actionDigest || origin.actionDigest !== actionDigest
          || receipt.result.sourceKind !== 'domain-readback' || receipt.result.sourceRef !== `maintenance.summary:${goal.binding.runId}`
          || receipt.result.completeness !== 'complete' || receipt.result.payloadDigest !== readback.readbackDigest
          || !same(receipt.result.evidenceRefs, expectedRefs) || !allowSourceDrift && liveToken !== postSourceRevision) reject('action-invalid');
        const sidecar = events.filter(event => event.kind.startsWith('action-receipt-')), receiptKey = digest(actionId).slice(7);
        if (sidecar.length !== 5) reject('action-invalid');
        for (const stage of ['reserved', 'started', 'completed', 'settled', 'observed'] as const) {
          const event = uniqueEvent(events, `action-receipt:${receiptKey}:${stage}`, `action-receipt-${stage}`,
            stage === 'observed' ? appliedRevision : actionRevision);
          const timestamp = stage === 'reserved' ? receipt.createdAt : stage === 'started' ? receipt.startedAt
            : stage === 'completed' ? receipt.completedAt : stage === 'settled' ? receipt.settledAt : receipt.observedAt;
          if (event.acceptedAt !== timestamp) reject('action-invalid');
        }
        const usage = receipt.result.usage, budget = record.envelope.budget, profile = fixed.profile.budgetProfile;
        const estimate = receipt.estimate;
        const zero = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, 0]));
        const granted = { ...zero, modelCalls: 1, toolCalls: 1, writes: 1, inputTokens: profile.agentInputBudgetTokens,
          outputTokens: profile.agentOutputBudgetTokens, costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs };
        if (!same(budget.granted, granted) || usage.toolCalls !== 1 || usage.writes !== 1 || usage.modelCalls !== 0
          || usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.costMicrousd !== 0 || usage.highRiskActions !== 0
          || estimate.modelCalls !== 0 || estimate.toolCalls !== 1 || estimate.writes !== 1
          || estimate.inputTokens !== 0 || estimate.outputTokens !== 0 || estimate.costMicrousd !== 0 || estimate.highRiskActions !== 0
          || estimate.wallMs < 1 || estimate.wallMs > 10_000 || usage.wallMs > estimate.wallMs
          || budget.spent.modelCalls !== 1 || budget.spent.toolCalls !== 1 || budget.spent.writes !== 1
          || budget.spent.inputTokens < 1 || budget.spent.outputTokens < 1 || budget.spent.highRiskActions !== 0 || budget.spent.childTasks !== 0
          || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => budget.reserved[key] !== 0 || budget.spent[key] > budget.granted[key])) reject('action-invalid');
        // Reverse ONLY this settled native Action's actual usage, then prove the
        // entire prior ACT Envelope against its original durable event digest.
        // This is not a guessed model receipt or unconditional subtraction of 1.
        const spent = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key,
          budget.spent[key] - (key === 'childTasks' ? 0 : usage[key])]));
        if (Object.values(spent).some(value => !Number.isSafeInteger(value) || value < 0)) reject('action-invalid');
        const bindings = record.envelope.artifacts.filter(artifact => artifact.kind === 'agent-loop-execution-binding');
        if (bindings.length !== 1 || bindings[0]!.artifactRef !== binding.refId || bindings[0]!.status !== 'declared'
          || !bindings[0]!.evidenceRefs.includes(goal.claimDigest)) reject('artifacts-invalid');
        const act = normalizeAgentLoopTaskEnvelope({ ...record.envelope, phase: 'ACT', revision: actionRevision,
          updatedAt: actionUpdatedAt, budget: { ...budget, spent }, artifacts: bindings });
        if (actionUpdatedAt > actPhase.acceptedAt || actionUpdatedAt < record.envelope.createdAt
          || estimate.wallMs > budget.granted.wallMs - act.budget.spent.wallMs
          || agentLoopSummaryWriteDigest(act.budget) !== origin.budgetDigest
          || [actPhase, start].some(event => agentLoopProjectionEventDigest({ eventId: event.eventId, taskId,
            revision: event.revision, kind: event.kind, reasonCode: event.reasonCode ?? null,
            envelopeDigest: digest(act) }) !== event.eventDigest)) reject('action-invalid');
        const modelId = agentLoopModelInvocationId({ taskId, attemptId: goal.attemptId, expectedTaskRevision: 2 });
        const model = observations.filter(item => item.observationId === `model-usage:${modelId}`);
        const tool = observations.filter(item => item.observationId === receipt.observationId);
        const reservation = uniqueEvent(events, `model-invocation:${modelId}`, 'model-invocation-reserved', 2);
        if (observations.length !== 2 || model.length !== 1 || tool.length !== 1
          || model[0]!.sourceKind !== 'provider' || model[0]!.attemptId !== goal.attemptId || model[0]!.observedForTaskRevision !== 2
          || model[0]!.classification !== 'applied' || model[0]!.appliedRevision !== 3 || model[0]!.completeness !== 'complete'
          || reservation.acceptedAt > model[0]!.ingestedAt || model[0]!.ingestedAt > receipt.startedAt
          || tool[0]!.sourceKind !== 'domain-readback' || tool[0]!.attemptId !== goal.attemptId || tool[0]!.observedForTaskRevision !== 3
          || tool[0]!.classification !== 'applied' || tool[0]!.appliedRevision !== 4 || tool[0]!.completeness !== 'complete'
          || tool[0]!.satisfiesVerification !== true || tool[0]!.ingestedAt !== receipt.observedAt
          || tool[0]!.reasonCodes.length > 0 || model[0]!.reasonCodes.length > 0) reject('action-invalid');
        const declared = createAgentLoopRollingSummaryApplyArtifact({ execution, source, origin, intent, readback, actionId,
          postSourceRevision, actionUpdatedAt });
        const artifacts = record.envelope.artifacts;
        if (artifacts.length !== 2 || refs.length !== 2
          || !same(artifacts.filter(item => item.kind === 'agent-loop-rolling-summary-apply'), [declared.artifact])) reject('artifacts-invalid');
        const bindingDescriptor = actualDescriptor(binding, refs, initialPhase, events);
        const applyDescriptor = actualDescriptor(declared.descriptor, refs, phase, events);
        capture(liveToken);
        if (domain().historyDigest !== history.historyDigest || !same(store.readRefs(taskId), refs)
          || !same(store.readObservations(taskId), observations) || !same(store.readActionReceipt({ taskId, actionId }), receipt)
          || !same(store.readEvents(taskId), events)) reject('source-stale');
        const latest = store.read(taskId);
        if (!latest || latest.envelopeDigest !== record.envelopeDigest || latest.revision !== expectedRevision
          || latest.fenced || latest.ownerId !== ownerId || !latest.leaseExpiresAt || latest.leaseExpiresAt <= at()) reject('source-stale');
        capture(liveToken);
        return Object.freeze({ version: AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFICATION_VERSION,
          taskId, taskRevision: expectedRevision, envelopeDigest: record.envelopeDigest, attemptId: goal.attemptId,
          mode: 'apply', claimDigest: goal.claimDigest, runId: goal.binding.runId, sessionId: goal.binding.sessionId,
          sourceRevision: goal.binding.sourceRevision, sourceDigest, postSourceRevision, currentSourceRevision: liveToken,
          actionId, actionRevision, actionDigest, actionWatermark, observationId: receipt.observationId,
          originDigest: origin.originDigest, intentDigest: intent.intentDigest, readbackDigest: readback.readbackDigest,
          historyDigest: history.historyDigest, proposalDigest: origin.proposalDigest, contextDigest: origin.contextDigest,
          operationDigest: intent.operationDigest, budgetDigest: origin.budgetDigest, actionUpdatedAt,
          domainCommittedAt: intent.committedAt, domainVerifiedAt: readback.verifiedAt,
          bindingDescriptor, applyDescriptor,
          canonicalEvidenceRefs: Object.freeze([...new Set([goal.claimDigest, origin.proposalDigest, origin.contextDigest,
            bindingDescriptor.refId, applyDescriptor.refId, postSourceRevision])]),
          actionEvidenceRefs: Object.freeze([actionWatermark, receipt.observationId, actionDigest, origin.budgetDigest, actionUpdatedRef]),
          domainEvidenceRefs: Object.freeze([origin.originDigest, intent.intentDigest, intent.operationDigest, readback.readbackDigest]) });
      } catch (error) { if (error instanceof AgentLoopRollingSummaryApplyVerificationError) throw error; return reject('source-stale'); }
    };
    const read = (revision: number) => readEvidence(revision);
    const candidateEvidence = (candidate: AgentLoopCompletionCandidate) => {
      try {
        if (!candidate || typeof candidate !== 'object') reject('candidate-invalid');
        // Strict own data before any field is read; Stored candidate extras too.
        agentLoopSummaryWriteDigest(candidate);
        const required = ['candidateRef', 'taskId', 'attemptId', 'taskRevision', 'artifactRefs', 'actionWatermark', 'createdAt'];
        normalizeAgentLoopActionObject(candidate, required, Object.keys(candidate).filter(key => !required.includes(key)));
        if (candidate.taskId !== taskId) reject('candidate-invalid');
        const actual = store.assertCompletionCandidateCurrent({ taskId, ownerId, expectedRevision: candidate.taskRevision,
          candidateRef: candidate.candidateRef });
        if (actual.attemptId !== candidate.attemptId || actual.createdAt !== candidate.createdAt
          || actual.actionWatermark !== candidate.actionWatermark || !same(actual.artifactRefs, candidate.artifactRefs)
          || actual.unknownEffectActionIds.length > 0 || actual.missingArtifactRefs.length > 0) reject('candidate-invalid');
        const evidence = read(candidate.taskRevision);
        if (evidence.envelopeDigest !== actual.envelopeDigest || evidence.attemptId !== actual.attemptId
          || evidence.actionWatermark !== actual.actionWatermark || actual.artifactDescriptors.length !== 2
          || !same(actual.artifactDescriptors.filter(item => item.refId === evidence.bindingDescriptor.refId), [evidence.bindingDescriptor])
          || !same(actual.artifactDescriptors.filter(item => item.refId === evidence.applyDescriptor.refId), [evidence.applyDescriptor])) reject('candidate-invalid');
        return evidence;
      } catch (error) { if (error instanceof AgentLoopRollingSummaryApplyVerificationError) throw error; return reject('candidate-invalid'); }
    };
    const resolve = (kind: 'session-artifact' | 'memory-record'): AgentLoopRefResolver => request => {
      try {
        normalizeAgentLoopActionObject(request, ['refId', 'kind', 'ownerRef', 'expectedDigest'], ['expectedRevision']);
        normalizeAgentLoopActionDigest(request.expectedDigest);
        if (request.expectedRevision !== undefined) normalizeAgentLoopActionToken(request.expectedRevision);
        const record = store.read(taskId); if (!record) return Object.freeze({ status: 'missing' });
        const evidence = readEvidence(record.revision, true), expected = kind === 'session-artifact' ? evidence.bindingDescriptor : evidence.applyDescriptor;
        if (request.kind !== kind || request.refId !== expected.refId || request.ownerRef !== expected.ownerRef) return Object.freeze({ status: 'forbidden' });
        // Return actual source-derived values, never caller expectations. An
        // unrelated Session tail change lets Continuation classify stale.
        return Object.freeze({ status: 'found', digest: expected.expectedDigest,
          revision: kind === 'memory-record' ? evidence.currentSourceRevision : expected.expectedRevision });
      } catch { return Object.freeze({ status: 'forbidden' }); }
    };
    const kinds = Object.freeze({ artifact: 'artifact-integrity', action: 'deterministic', domain: 'domain-readback' } as const);
    const registry = new AgentLoopVerifierRegistry();
    registry.register({ taskKind: registration.taskKind, contractRevision: registration.contractRevision,
      verifierSetRef: registration.verifierSetRef, verifierSetRevision: registration.verifierSetRevision,
      verifiers: (['artifact', 'action', 'domain'] as const).map(part => ({ verifierId: AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFIER_IDS[part],
        version: '1.0.0', kind: kinds[part], requirement: 'required' })) });
    Object.freeze(registry);
    const runners = Object.freeze(Object.fromEntries((['artifact', 'action', 'domain'] as const).map(part => {
      const runner: AgentLoopVerifierRunner = async ({ candidate, declaration }) => {
        try {
          if (declaration.verifierId !== AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFIER_IDS[part] || declaration.version !== '1.0.0'
            || declaration.requirement !== 'required' || declaration.kind !== kinds[part]) reject('input-invalid');
          const evidence = candidateEvidence(candidate);
          return Object.freeze({ disposition: 'passed' as const, reasonCodes: Object.freeze([]), evidenceRefs: part === 'artifact'
            ? evidence.canonicalEvidenceRefs : part === 'action' ? evidence.actionEvidenceRefs : evidence.domainEvidenceRefs });
        } catch (error) { return Object.freeze({ disposition: 'inconclusive' as const, reasonCodes: Object.freeze([
          error instanceof AgentLoopRollingSummaryApplyVerificationError ? error.code : 'agent-loop-rolling-summary-apply-verification-source-stale']), evidenceRefs: Object.freeze([]) }); }
      };
      return [AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFIER_IDS[part], runner];
    })) as Readonly<Record<string, AgentLoopVerifierRunner>>);
    const evaluationInput = (input: Parameters<AgentLoopRollingSummaryApplyVerification['evaluate']>[0]): AgentLoopFrozenCompletionInput => {
      normalizeAgentLoopActionObject(input, ['candidateRef', 'expectedRevision'], ['repairAttempts', 'maxRepairAttempts']);
      const candidateRef = normalizeAgentLoopActionToken(input.candidateRef), expectedRevision = input.expectedRevision;
      const repairAttempts = input.repairAttempts ?? store.readRepairState({ taskId, expectedRevision }).attempts;
      if (!Number.isSafeInteger(repairAttempts) || repairAttempts !== 0 || (input.maxRepairAttempts ?? 0) !== 0) reject('input-invalid');
      const baseline = read(expectedRevision);
      if (store.read(taskId)?.envelope.phase !== 'VERIFY') reject('candidate-invalid');
      return { store, ownerId, taskId, candidateRef, expectedRevision, registry,
        contractBinding: { taskKind: registration.taskKind, taskContractRef: registration.contractRef, contractRevision: registration.contractRevision },
        runners, repairAttempts, maxRepairAttempts: 0, clock, signal,
        assertSourceCurrent: candidate => {
          if (candidate.candidateRef !== candidateRef || candidate.taskRevision !== expectedRevision) reject('candidate-invalid');
          const current = candidateEvidence(candidate);
          if (current.historyDigest !== baseline.historyDigest || current.postSourceRevision !== baseline.postSourceRevision) reject('source-stale');
        },
        assertSourceCurrentAtCommit: () => {
          capture(baseline.postSourceRevision);
          if (domain().historyDigest !== baseline.historyDigest) reject('domain-invalid');
          capture(baseline.postSourceRevision);
        } };
    };
    return Object.freeze({ read, resolvers: Object.freeze({ 'session-artifact': resolve('session-artifact'), 'memory-record': resolve('memory-record') }), registry, runners,
      async evaluate(input: Parameters<AgentLoopRollingSummaryApplyVerification['evaluate']>[0]) {
        return evaluateFrozenAgentLoopCompletion(evaluationInput(input));
      },
      async prepare(input: Parameters<AgentLoopRollingSummaryApplyVerification['evaluate']>[0]) {
        const outcome = await prepareFrozenAgentLoopCompletion(evaluationInput(input));
        restrictFrozenAgentLoopDirectCommit(outcome);
        return outcome;
      },
      assertSourceCurrentAtCommit(evidence: AgentLoopRollingSummaryApplyVerificationEvidence) {
        // No AL transaction/read here: safe in the original AL writer lock.
        capture(evidence.postSourceRevision);
        if (domain().historyDigest !== evidence.historyDigest) reject('domain-invalid');
        capture(evidence.postSourceRevision);
      } });
  } catch (error) { if (error instanceof AgentLoopRollingSummaryApplyVerificationError) throw error; return reject('input-invalid'); }
}
