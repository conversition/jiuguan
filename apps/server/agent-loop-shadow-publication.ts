/** Business-first shadow publication. Neither stored audit nor storage origin
 * mints live publication authority. Historical recovery is metadata-only and
 * never calls a model, tool, Session, continuation or business writer.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MaintenanceJobManager } from './maintenance-job-manager.ts';
import { createAgentLoopRollingSummaryProposalVerification, createAgentLoopCorrectionRollingSummaryProposalVerification,
  AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS } from './agent-loop-rolling-summary-proposal-verification.ts';
import { createAgentLoopRollingSummaryArtifactSource, agentLoopRollingSummaryProposalArtifactRef,
  createAgentLoopCorrectionRollingSummaryArtifactSource, type AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
  type AgentLoopRollingSummaryArtifactSourceOptions } from './agent-loop-rolling-summary-artifacts.ts';
import { agentLoopMaintenanceClaimDigest } from './agent-loop-get-variables-authorization.ts';
import { agentLoopActionDigest } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT, normalizeAgentLoopActionObject,
  normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { isPreparedFrozenAgentLoopCompletion, revokeFrozenAgentLoopCompletion,
  restrictFrozenAgentLoopDirectCommit } from './agent-loop-frozen-completion.ts';
import type { AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { issueAgentLoopCompletionRequest } from './agent-loop-completion-request.ts';
import type { MaintenanceAgentLoopShadowPublicationInput } from './maintenance-agent-loop-shadow-proposal.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { normalizeAgentLoopRepairPolicy } from './agent-loop-repair-budget.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF } from './agent-loop-model-correction.ts';
import { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';

type Completion = NonNullable<AgentLoopCoordinatorPorts['completion']>;
const REJECTED = 'agent-loop-shadow-publication-rejected';
function reject(): never { throw new Error(REJECTED); }
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`; }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function correctionRecordData(input: unknown, seen = new Set<object>()): void {
  if (nodeTypes.isPromise(input)) { void Promise.prototype.then.call(input,()=>undefined,()=>undefined); reject(); }
  if (input === null || typeof input !== 'object') { if (typeof input === 'function' || typeof input === 'symbol') reject(); return; }
  if (nodeTypes.isProxy(input) || seen.has(input) || !Array.isArray(input) && ![Object.prototype,null].includes(Object.getPrototypeOf(input))) reject();
  seen.add(input);
  try { for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input,key);
    if (typeof key !== 'string' || !property || !Object.hasOwn(property,'value')) reject();
    correctionRecordData(property.value,seen);
  } } finally { seen.delete(input); }
}
function at(clock: () => string): string {
  const value = clock();
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
  return value;
}
export interface AgentLoopShadowPublicationReconcileOptions {
  readonly store: AgentLoopProjectionStore; readonly manager: MaintenanceJobManager;
  readonly ownerId: string; readonly clock: () => string; readonly runId: string; readonly taskId: string;
  /** Explicit trusted metadata-only takeover, never an execution grant. Omitted means no reacquisition. */
  readonly leaseMs?: number;
}

/** Fixed original readers. A ref is never parsed to select a reader. */
function history(input: AgentLoopShadowPublicationReconcileOptions, kind: 'single-pass' | 'correction') {
  const { store, manager, runId, taskId } = input;
  const published = manager.readAgentLoopShadowPublication(runId);
  if (!published || taskId !== `agentloop.maintenance.${runId}` || published.publication.taskId !== taskId) reject();
  const p = published.publication, registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  const candidate = store.readCompletionCandidate({ taskId, candidateRef: p.candidateRef });
  const verification = store.readCompletionVerification({ taskId, verificationResultRef: p.verificationResultRef });
  const record = store.read(taskId);
  const claimDigest = agentLoopMaintenanceClaimDigest({ job: published.job,
    executorRoute: 'agent-loop', leaseOwnerInstanceId: published.preparation.ownerInstanceId });
  if (!candidate || !verification || !record || p.claimDigest !== claimDigest || p.attemptId !== `attempt.al.${claimDigest.slice(7)}`
    || candidate.taskRevision !== p.taskRevision || candidate.envelopeDigest !== p.envelopeDigest
    || candidate.frozenDigest !== p.candidateDigest || candidate.attemptId !== p.attemptId
    || candidate.actionWatermark !== p.actionWatermark || candidate.taskKind !== registration.taskKind
    || candidate.taskContractRef !== (kind === 'correction' ? AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF : registration.contractRef)
    || candidate.verifierSetRef !== registration.verifierSetRef
    || candidate.verifierSetRevision !== registration.verifierSetRevision || candidate.missingArtifactRefs.length
    || candidate.unknownEffectActionIds.length || verification.candidateRef !== p.candidateRef
    || verification.candidateDigest !== p.candidateDigest || verification.verificationDigest !== p.verificationDigest
    || verification.taskRevision !== p.taskRevision || verification.evaluation.verdict !== 'complete'
    || verification.verifiedAt > p.publishedAt || p.publishedAt > at(input.clock)
    || p.actionWatermark !== `action-completed:${p.actionId}`) reject();
  const results = verification.evaluation.verifierResults;
  const ids = Object.values(AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS);
  if (results.length !== ids.length || ids.some(id => !results.some(result => result.verifierId === id
    && result.disposition === 'passed' && result.evidenceRefs.length > 0))) reject();
  const action = store.readActionReceipt({ taskId, actionId: p.actionId });
  if (!action || action.status !== 'observed' || action.actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
    || action.attemptId !== p.attemptId || action.ownerId !== published.preparation.ownerInstanceId
    || action.actionDigest !== p.actionDigest || action.result?.completeness !== 'complete'
    || action.result.sourceRef !== `maintenance.proposal:${runId}` || action.result.payloadDigest !== p.preparationDigest
    || !same(action.result.evidenceRefs, [p.claimDigest, p.proposalDigest, p.proposalContextDigest,
      p.preparationDigest, `snapshot:${p.sourceDigest.slice(7)}`])
    || agentLoopActionDigest({ actionId: p.actionId, taskId, attemptId: p.attemptId,
      expectedTaskRevision: action.expectedRevision, actionContractRef: action.actionContractRef,
      args: published.proposal.proposal.payload }) !== p.actionDigest) reject();
  const proposalRef = agentLoopRollingSummaryProposalArtifactRef({ claimDigest, actionId: p.actionId, preparationDigest: p.preparationDigest });
  const descriptors = candidate.artifactDescriptors, artifacts = candidate.artifacts;
  const binding = artifacts.filter(value => value.kind === 'agent-loop-execution-binding');
  const proposal = artifacts.filter(value => value.kind === 'agent-loop-rolling-summary-proposal');
  if (artifacts.length !== 2 || descriptors.length !== 2 || binding.length !== 1 || proposal.length !== 1
    || !binding[0]!.artifactRef.startsWith('execution.prepare:') || binding[0]!.status !== 'declared'
    || !binding[0]!.evidenceRefs.includes(claimDigest) || proposal[0]!.artifactRef !== proposalRef || proposal[0]!.status !== 'available'
    || !same(proposal[0]!.evidenceRefs, [...new Set([claimDigest, p.proposalDigest, p.proposalContextDigest, p.preparationDigest])].sort())) reject();
  for (const artifact of artifacts) {
    const refs = descriptors.filter(ref => ref.refId === artifact.artifactRef);
    const isBinding = artifact === binding[0];
    if (refs.length !== 1 || refs[0]!.kind !== (isBinding ? 'session-artifact' : 'candidate')
      || refs[0]!.ownerRef !== `maintenancejob.${runId}` || refs[0]!.expectedRevision !== claimDigest
      || refs[0]!.expectedDigest !== (isBinding ? `sha256:${artifact.artifactRef.slice('execution.prepare:'.length)}` : p.preparationDigest)
      || refs[0]!.policy !== 'required' || refs[0]!.aclClass !== 'restricted' || refs[0]!.expandBudgetTokens !== 0) reject();
  }
  if (kind === 'correction') {
    const corrected = p.taskRevision === 8, actionRevision = corrected ? 5 : 3, used = corrected ? 2 : 1;
    const budget = record.envelope.budget, events = store.readEvents(taskId), observations = store.readObservations(taskId);
    if (![6,8].includes(p.taskRevision) || action.expectedRevision !== actionRevision || action.appliedRevision !== actionRevision + 1
      || record.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
      || record.revision !== p.taskRevision && record.revision !== p.taskRevision + 2
      || record.envelope.currentAttemptId !== p.attemptId || budget.granted.modelCalls !== 2
      || budget.granted.toolCalls !== 1 || budget.granted.writes !== 1
      || budget.spent.modelCalls !== used || budget.spent.toolCalls !== 1 || budget.spent.writes !== 1
      || budget.spent.inputTokens < used || budget.spent.outputTokens < used
      || Object.values(budget.reserved).some(value => value !== 0)
      || budget.granted.highRiskActions !== 0 || budget.granted.childTasks !== 0
      || budget.spent.highRiskActions !== 0 || budget.spent.childTasks !== 0
      || observations.length !== used + 1) reject();
    const policies = events.filter(event => event.kind === 'model-correction-policy-bound');
    if (policies.length !== 1 || policies[0]!.revision !== 2 || policies[0]!.reasonCode !== 'correction-once'
      || !/^model-correction-policy:[a-f0-9]{64}$/u.test(policies[0]!.eventId)) reject();
    const policyDigest = `sha256:${policies[0]!.eventId.slice('model-correction-policy:'.length)}`;
    const select = (id: string, eventKind: string, revision: number, reason?: string) => {
      const rows = events.filter(event => event.eventId === id);
      if (rows.length !== 1 || rows[0]!.kind !== eventKind || rows[0]!.revision !== revision || rows[0]!.reasonCode !== reason) reject();
      return rows[0]!;
    };
    const phase = select(`phase:${taskId}:1:PREPARE-MODEL`,'phase-advanced',2);
    const prepared = events.filter(event => event.kind === 'model-correction-prepared');
    if (prepared.length !== 1 || prepared[0]!.revision !== 2 || events.indexOf(phase)+1 !== events.indexOf(prepared[0]!)
      || events.indexOf(prepared[0]!)+1 !== events.indexOf(policies[0]!)
      || phase.acceptedAt !== prepared[0]!.acceptedAt || phase.acceptedAt !== policies[0]!.acceptedAt) reject();
    const reservations = events.filter(event => event.kind === 'model-invocation-reserved');
    if (reservations.length !== used || events.filter(event => event.kind === 'model-correction-ready').length !== (corrected ? 1 : 0)
      || events.filter(event => event.kind === 'model-protocol-rejected').length !== (corrected ? 1 : 0)) reject();
    for (const revision of corrected ? [2,4] : [2]) {
      const invocation = agentLoopModelInvocationId({ taskId,attemptId:p.attemptId,expectedTaskRevision:revision });
      select(`model-invocation:${invocation}`,'model-invocation-reserved',revision);
      const model = observations.filter(value => value.observationId === `model-usage:${invocation}`);
      if (model.length !== 1 || model[0]!.sourceKind !== 'provider' || model[0]!.completeness !== 'complete'
        || model[0]!.classification !== 'applied' || model[0]!.appliedRevision !== revision+1
        || model[0]!.observedForTaskRevision !== revision || model[0]!.attemptId !== p.attemptId) reject();
      if (corrected && revision === 2) {
        const rejected = events.filter(event => event.eventId === `model-rejection:${invocation}`);
        if (rejected.length !== 1 || rejected[0]!.kind !== 'model-protocol-rejected' || rejected[0]!.revision !== 3) reject();
        select(`model-correction-ready:${invocation.slice(7)}`,'model-correction-ready',4,'correction-once');
      }
    }
    const bound = events.filter(event => event.kind === 'model-decision-bound');
    if (bound.length !== 1 || bound[0]!.revision !== actionRevision || bound[0]!.reasonCode !== 'act') reject();
    select(`action-started:${p.actionId}`,'action-started',actionRevision,'act');
    select(p.actionWatermark,'action-completed',actionRevision+1,'act');
    select(`phase:${taskId}:${actionRevision+1}:ACT-OBSERVE`,'phase-advanced',actionRevision+2,'act');
    const artifactResult = results.find(result => result.verifierId === AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.artifact)!;
    const actionResult = results.find(result => result.verifierId === AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.action)!;
    if (!same(artifactResult.evidenceRefs,[claimDigest,p.proposalDigest,p.proposalContextDigest,p.preparationDigest,binding[0]!.artifactRef,proposalRef])
      || !same(actionResult.evidenceRefs,[p.actionWatermark,action.observationId,p.actionDigest,`snapshot:${p.sourceDigest.slice(7)}`,policyDigest])) reject();
  }
  return { published, candidate, verification, record };
}

/** Reconciles only a real already-committed Manager publication. Old signals and
 * Session/profile readers deliberately do not participate in historical truth.
 */
export function reconcileAgentLoopShadowPublication(input: AgentLoopShadowPublicationReconcileOptions): Readonly<{
  status: 'completed' | 'already-completed'; record: AgentLoopTaskRecord;
}> {
  return reconcilePublication(input,'single-pass');
}
/** Historical truth only. Never reloads Session, brands, policy or execution. */
export function reconcileAgentLoopCorrectionShadowPublication(input: AgentLoopShadowPublicationReconcileOptions): Readonly<{
  status: 'completed' | 'already-completed'; record: AgentLoopTaskRecord;
}> {
  return reconcilePublication(input,'correction');
}
function reconcilePublication(input: AgentLoopShadowPublicationReconcileOptions,kind:'single-pass'|'correction'): Readonly<{
  status:'completed'|'already-completed';record:AgentLoopTaskRecord;
}> {
  try {
    if (kind === 'correction') {
      if (nodeTypes.isPromise(input)) { void Promise.prototype.then.call(input,()=>undefined,()=>undefined); reject(); }
      if (nodeTypes.isProxy(input)) reject();
    }
    normalizeAgentLoopActionObject(input, ['store', 'manager', 'ownerId', 'clock', 'runId', 'taskId'], ['leaseMs']);
    if (!(input.store instanceof AgentLoopProjectionStore) || !(input.manager instanceof MaintenanceJobManager)
      || typeof input.clock !== 'function' || input.leaseMs !== undefined
      && (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 86_400_000)) reject();
    normalizeAgentLoopActionToken(input.ownerId); normalizeAgentLoopActionToken(input.runId); normalizeAgentLoopActionToken(input.taskId);
    const { store, manager, ownerId, taskId } = input;
    const pinned = history(input,kind), p = pinned.published.publication, publishedDigest = digest(pinned.published);
    const assertPublished = () => {
      const actual = manager.readAgentLoopShadowPublication(input.runId);
      if (!actual || digest(actual) !== publishedDigest || actual.publication.publishedAt > at(input.clock)) reject();
    };
    if (pinned.record.envelope.state === 'COMPLETED') {
      const record = store.assertCompletedCandidate({ taskId, candidateRef: p.candidateRef,
        verificationResultRef: p.verificationResultRef, taskUpdatedAt: p.taskUpdatedAt });
      assertPublished(); return Object.freeze({ status: 'already-completed', record });
    }
    if (pinned.record.fenced || pinned.record.envelope.state !== 'RUNNING' || pinned.record.envelope.phase !== 'VERIFY'
      || pinned.record.revision !== p.taskRevision || pinned.record.envelopeDigest !== p.envelopeDigest
      || pinned.record.envelope.updatedAt !== p.taskUpdatedAt) reject();
    // Reject a stale full snapshot before even attempting a metadata lease CAS.
    store.assertFrozenCandidateSnapshot({ taskId, candidateRef: p.candidateRef });
    const now = at(input.clock), currentExpiry = pinned.record.leaseExpiresAt;
    if (currentExpiry !== null && (!Number.isSafeInteger(Date.parse(currentExpiry))
      || new Date(currentExpiry).toISOString() !== currentExpiry)) reject();
    if (input.leaseMs !== undefined && (currentExpiry === null || currentExpiry <= now)) {
      // Only the original metadata CAS; no continuation or Model/ACT port is entered.
      assertPublished();
      store.claimLease({ taskId, expectedRevision: p.taskRevision, ownerId, leaseMs: input.leaseMs });
    }
    store.assertCompletionCandidateCurrent({ taskId, ownerId, expectedRevision: p.taskRevision, candidateRef: p.candidateRef });
    assertPublished();
    const record = store.completeVerifiedCandidate({ taskId, ownerId, expectedRevision: p.taskRevision,
      candidateRef: p.candidateRef, verificationResultRef: p.verificationResultRef }, assertPublished);
    return Object.freeze({ status: 'completed', record });
  } catch { return reject(); }
}

const publications = new WeakMap<object, Readonly<{ factory: object; record: AgentLoopTaskRecord;
  publication: MaintenanceAgentLoopShadowPublicationInput; preparedDigest: string }>>();

/** Independent live publication capability. Calling this factory or providing
 * an old audit does not issue it: its actual closed verifier must run first.
 */
export function createAgentLoopShadowPublication(options: AgentLoopRollingSummaryArtifactSourceOptions): Readonly<{
  coordinatorCompletion: Completion;
  verify: AgentLoopCoordinatorPorts['verify'];
  repair: NonNullable<AgentLoopCoordinatorPorts['repair']>;
}> {
  return createPublication(options,'single-pass');
}
export function createAgentLoopCorrectionShadowPublication(options: AgentLoopCorrectionRollingSummaryArtifactSourceOptions): ReturnType<typeof createAgentLoopShadowPublication> {
  return createPublication(options,'correction');
}
function createPublication(options: AgentLoopRollingSummaryArtifactSourceOptions | AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
  kind:'single-pass'|'correction'): ReturnType<typeof createAgentLoopShadowPublication> {
  const correction = kind === 'correction';
  const verifier = correction ? createAgentLoopCorrectionRollingSummaryProposalVerification(options as AgentLoopCorrectionRollingSummaryArtifactSourceOptions)
    : createAgentLoopRollingSummaryProposalVerification(options);
  const source = correction ? createAgentLoopCorrectionRollingSummaryArtifactSource(options as AgentLoopCorrectionRollingSummaryArtifactSourceOptions)
    : createAgentLoopRollingSummaryArtifactSource(options);
  const factory = Object.freeze({}), { store, manager, ownerId, clock } = options;
  const expectedAttempt = options.execution.job.attempt;
  const coordinatorCompletion: Completion = Object.freeze({
    request(input: Parameters<NonNullable<Completion['request']>>[0]) {
      try {
        normalizeAgentLoopActionObject(input, ['record', 'ownerId', 'actionWatermark']);
        if (correction) correctionRecordData(input.record);
        const record = store.read(input.record.envelope.taskId), evidence = verifier.read(input.record.revision);
        if (!record || input.ownerId !== ownerId || record.envelope.state !== 'RUNNING'
          || record.envelope.phase !== 'OBSERVE' || record.revision !== input.record.revision
          || record.envelopeDigest !== input.record.envelopeDigest || record.ownerId !== ownerId
          || input.actionWatermark !== evidence.actionWatermark) reject();
        const assertSourceCurrent = () => {
          // Safe inside the AL writer lock: no nested AL query transaction and
          // no frozen candidate before the original VERIFY stage.
          source.assertSourceCurrent();
          const actual = manager.readAgentLoopShadowProposal(evidence.runId);
          if (!actual || digest(actual) !== evidence.proposalRecordDigest) reject();
          source.assertSourceCurrent();
        };
        return issueAgentLoopCompletionRequest({ store, record, ownerId,
          actionWatermark: evidence.actionWatermark, assertSourceCurrent });
      } catch { return reject(); }
    },
    async evaluate(input: Parameters<Completion['evaluate']>[0]) {
      const outcome = await verifier.coordinatorCompletion.evaluate(input);
      if (outcome.verdict !== 'complete') return outcome;
      try {
        if (!isPreparedFrozenAgentLoopCompletion(outcome) || !outcome.verificationResultRef) reject();
        const evidence = verifier.read(input.revision), record = store.read(input.envelope.taskId);
        const candidate = store.assertCompletionCandidateCurrent({ taskId: evidence.taskId, ownerId,
          expectedRevision: input.revision, candidateRef: outcome.candidateRef });
        const verification = store.readCompletionVerification({ taskId: evidence.taskId, verificationResultRef: outcome.verificationResultRef });
        const prepared = manager.readAgentLoopShadowProposal(evidence.runId);
        if (!record || !verification || !prepared || verification.candidateDigest !== candidate.frozenDigest
          || digest(prepared) !== evidence.proposalRecordDigest || record.envelope.state !== 'RUNNING') reject();
        source.assertSourceCurrent();
        publications.set(outcome, Object.freeze({ factory, record, preparedDigest: digest(prepared), publication: Object.freeze({
          version: 'maintenance-agent-loop-shadow-publication-v1', runId: evidence.runId, taskId: evidence.taskId,
          attemptId: evidence.attemptId, taskRevision: input.revision, taskUpdatedAt: record.envelope.updatedAt,
          envelopeDigest: record.envelopeDigest, candidateRef: candidate.candidateRef, candidateDigest: candidate.frozenDigest,
          verificationResultRef: verification.verificationResultRef, verificationDigest: verification.verificationDigest,
          actionId: evidence.actionId, actionDigest: evidence.actionDigest, actionWatermark: evidence.actionWatermark,
          claimDigest: evidence.claimDigest, sourceDigest: evidence.sourceDigest, preparationDigest: evidence.preparationDigest,
          proposalDigest: evidence.proposalDigest, proposalContextDigest: evidence.proposalContextDigest,
        }) }));
        // Move out of the AL-only completion scope immediately, not only when
        // publication starts. The same genuine object cannot complete AL first.
        restrictFrozenAgentLoopDirectCommit(outcome);
        return outcome;
      } catch { revokeFrozenAgentLoopCompletion(outcome); return reject(); }
    },
    commitVerified(input: Parameters<NonNullable<Completion['commitVerified']>>[0]) {
      if (correction && nodeTypes.isProxy(input)) return reject();
      const outcome = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'evaluation')?.value : undefined;
      const data = outcome && typeof outcome === 'object' ? publications.get(outcome) : undefined;
      if (outcome && typeof outcome === 'object') publications.delete(outcome);
      const genuine = isPreparedFrozenAgentLoopCompletion(outcome);
      revokeFrozenAgentLoopCompletion(outcome);
      try {
        normalizeAgentLoopActionObject(input, ['evaluation', 'record', 'ownerId']);
        if (correction) correctionRecordData(input.record);
        if (!data || !genuine || data.factory !== factory || input.ownerId !== ownerId
          || input.record.revision !== data.record.revision || input.record.envelopeDigest !== data.record.envelopeDigest
          || input.record.envelope.taskId !== data.publication.taskId) reject();
        const p = data.publication;
        manager.publishAgentLoopShadowProposal({ runId: p.runId, owner: ownerId,
          expectedAttempt, publication: p }, actual => {
          // Manager owns this transaction; only its private reader may supply body/origin.
          source.assertSourceCurrent();
          if (digest(actual) !== data.preparedDigest) reject();
          const candidate = store.assertCompletionCandidateCurrent({ taskId: p.taskId, ownerId,
            expectedRevision: p.taskRevision, candidateRef: p.candidateRef });
          const verification = store.readCompletionVerification({ taskId: p.taskId, verificationResultRef: p.verificationResultRef });
          if (candidate.frozenDigest !== p.candidateDigest || !verification || verification.verificationDigest !== p.verificationDigest) reject();
          source.assertSourceCurrent();
        });
        // Manager business truth is committed first. Failure below is recoverable
        // metadata, never a reason to fail/retry/retract the already-published job.
        return (correction ? reconcileAgentLoopCorrectionShadowPublication : reconcileAgentLoopShadowPublication)({ store, manager, ownerId, clock, runId: p.runId, taskId: p.taskId }).record;
      } catch { return reject(); }
    },
  });
  const repair: NonNullable<AgentLoopCoordinatorPorts['repair']> = Object.freeze({
    commit(input: Parameters<NonNullable<AgentLoopCoordinatorPorts['repair']>['commit']>[0]) {
      if (correction) return reject(); // No repair grant or second execution path.
      normalizeAgentLoopActionObject(input, ['record', 'ownerId', 'expectedSnapshotDigest']);
      const record = store.read(input.record.envelope.taskId), evidence = verifier.read(input.record.revision);
      if (!record || input.ownerId !== ownerId || record.envelope.state !== 'RUNNING' || record.envelope.phase !== 'VERIFY'
        || record.revision !== input.record.revision || !same(record, input.record)) reject();
      // The original shadow route has no second Model/Action grant. A repair
      // request can only fail at max0, or remain inconclusive for unknown work.
      const policy = normalizeAgentLoopRepairPolicy({ version: 'agent-loop-repair-policy-v1',
        policyRef: 'policy.rolling-summary-shadow.no-repair.v1', taskKind: record.envelope.taskKind,
        taskContractRef: record.envelope.taskContractRef, verifierSetRef: record.envelope.verifier.verifierSetRef,
        verifierSetRevision: record.envelope.verifier.verifierSetRevision, maxAttempts: 0,
        requiredBudget: { modelCalls: 1, toolCalls: 0, writes: 0, inputTokens: 1, outputTokens: 1,
          costMicrousd: 0, wallMs: 1, highRiskActions: 0, childTasks: 0 } });
      return store.commitRepairAttempt({ taskId: record.envelope.taskId, ownerId, expectedRevision: record.revision,
        expectedSnapshotDigest: input.expectedSnapshotDigest, policy }, () => {
        source.assertSourceCurrent();
        const actual = manager.readAgentLoopShadowProposal(evidence.runId);
        if (!actual || digest(actual) !== evidence.proposalRecordDigest) reject();
        source.assertSourceCurrent();
      });
    },
  });
  return Object.freeze({ coordinatorCompletion, repair, verify: async (input: Parameters<AgentLoopCoordinatorPorts['verify']>[0]) => {
    const record = store.read(input.envelope.taskId), evidence = verifier.read(input.revision);
    if (!record || record.envelope.phase !== 'VERIFY' || !same(record.envelope, input.envelope)
      || input.actionId !== evidence.actionId) reject();
    return Object.freeze({ disposition: 'passed' as const, reasonCodes: Object.freeze([]) });
  } });
}
