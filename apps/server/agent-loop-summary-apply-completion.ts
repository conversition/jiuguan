/** Apply business-first completion, separate from shadow publication. Live
 * authority is private and one-use. Committed history permits AL metadata only;
 * it never reads a Session, dispatches work or recreates execution authority. */
import { AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MaintenanceJobManager } from './maintenance-job-manager.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_VERIFIER_IDS as IDS,
  createAgentLoopRollingSummaryApplyLiveVerificationSource,
  type AgentLoopRollingSummaryApplyVerificationOptions } from './agent-loop-rolling-summary-apply-verification.ts';
import { agentLoopRollingSummaryApplyArtifactRef } from './agent-loop-rolling-summary-apply-artifacts.ts';
import { agentLoopSummaryWriteDigest as hash } from './agent-loop-summary-write-origin.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT as APPLY,
  normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { isPreparedFrozenAgentLoopCompletion, revokeFrozenAgentLoopCompletion } from './agent-loop-frozen-completion.ts';
import { issueAgentLoopCompletionRequest } from './agent-loop-completion-request.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_VERSION as VERSION,
  normalizeMaintenanceAgentLoopSummaryApplyCompletionInput,
  type MaintenanceAgentLoopSummaryApplyCompletionInput } from './maintenance-agent-loop-summary-apply-completion.ts';
import type { AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';

type Completion = NonNullable<AgentLoopCoordinatorPorts['completion']>;
const ERROR = 'agent-loop-summary-apply-completion-rejected';
function reject(): never { throw new Error(ERROR); }
function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
function recordData(value: unknown): void {
  normalizeAgentLoopActionObject(value, ['envelope', 'envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
  hash(value); // Reject nested getters/thenables before reading any caller field.
}
function at(clock: () => string): string {
  const value = clock();
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
  return value;
}
export interface AgentLoopSummaryApplyCompletionReconcileOptions {
  readonly store: AgentLoopProjectionStore; readonly manager: MaintenanceJobManager;
  readonly ownerId: string; readonly clock: () => string; readonly runId: string; readonly taskId: string;
  /** Explicit expired metadata lease takeover, not an execution/continuation grant. */
  readonly leaseMs?: number;
}

/** No live-domain reader participates. Manager's independent committed receipt
 * must join the original immutable AL audit/Action/typed-ref history. */
function history(input: AgentLoopSummaryApplyCompletionReconcileOptions) {
  const { store, manager, runId, taskId } = input;
  const committed = manager.readAgentLoopSummaryApplyCompletion(runId);
  if (!committed || taskId !== `agentloop.maintenance.${runId}` || committed.completion.taskId !== taskId) reject();
  const p = committed.completion, registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  const candidate = store.readCompletionCandidate({ taskId, candidateRef: p.candidateRef });
  const verification = store.readCompletionVerification({ taskId, verificationResultRef: p.verificationResultRef });
  const record = store.read(taskId);
  if (!candidate || !verification || !record || candidate.taskRevision !== p.taskRevision
    || candidate.envelopeDigest !== p.envelopeDigest || candidate.frozenDigest !== p.candidateDigest
    || candidate.attemptId !== p.attemptId || candidate.actionWatermark !== p.actionWatermark
    || candidate.taskKind !== registration.taskKind || candidate.taskContractRef !== registration.contractRef
    || candidate.verifierSetRef !== registration.verifierSetRef || candidate.verifierSetRevision !== registration.verifierSetRevision
    || candidate.missingArtifactRefs.length || candidate.unknownEffectActionIds.length
    || verification.candidateRef !== p.candidateRef || verification.candidateDigest !== p.candidateDigest
    || verification.verificationDigest !== p.verificationDigest || verification.taskRevision !== p.taskRevision
    || verification.evaluation.verdict !== 'complete' || verification.verifiedAt > p.completedAt
    || p.completedAt > at(input.clock) || p.domainVerifiedAt > verification.verifiedAt) reject();
  const expected = {
    [IDS.artifact]: [...new Set([p.claimDigest, p.proposalDigest, p.contextDigest, p.bindingRef, p.applyRef, p.postSourceRevision])],
    [IDS.action]: [p.actionWatermark, `obs:${p.actionId}`, p.actionDigest, p.budgetDigest, `act-updated-at:${p.actionUpdatedAt}`],
    [IDS.domain]: [p.originDigest, p.intentDigest, p.operationDigest, p.readbackDigest],
  };
  const results = verification.evaluation.verifierResults;
  if (results.length !== 3 || Object.entries(expected).some(([id, refs]) => {
    const matches = results.filter(result => result.verifierId === id);
    return matches.length !== 1 || matches[0]!.disposition !== 'passed' || matches[0]!.reasonCodes.length !== 0
      || !same(matches[0]!.evidenceRefs, refs);
  })) reject();
  const action = store.readActionReceipt({ taskId, actionId: p.actionId });
  const actionEvidence = [p.claimDigest, p.originDigest, p.proposalDigest, p.contextDigest, p.sourceDigest,
    p.budgetDigest, p.intentDigest, p.operationDigest, p.readbackDigest, p.postSourceRevision, `act-updated-at:${p.actionUpdatedAt}`];
  if (!action || action.status !== 'observed' || action.actionContractRef !== APPLY || action.ownerId !== p.ownerId
    || action.attemptId !== p.attemptId || action.actionDigest !== p.actionDigest || action.expectedRevision !== p.actionRevision
    || action.appliedRevision !== 4 || action.receiptRef !== `receipt:${p.actionId}` || action.observationId !== `obs:${p.actionId}`
    || !action.result || !action.startedAt || !action.completedAt || !action.settledAt || !action.observedAt
    || action.releasedAt !== undefined || action.result.completeness !== 'complete' || action.result.sourceKind !== 'domain-readback'
    || action.result.sourceRef !== `maintenance.summary:${runId}` || action.result.payloadDigest !== p.readbackDigest
    || !same(action.result.evidenceRefs, actionEvidence) || action.result.usage.toolCalls !== 1 || action.result.usage.writes !== 1
    || p.domainVerifiedAt > action.completedAt || action.observedAt > candidate.createdAt) reject();
  if (p.applyRef !== agentLoopRollingSummaryApplyArtifactRef({ claimDigest: p.claimDigest, actionId: p.actionId,
    originDigest: p.originDigest, intentDigest: p.intentDigest, readbackDigest: p.readbackDigest,
    postSourceRevision: p.postSourceRevision, actionUpdatedAt: p.actionUpdatedAt })) reject();
  const artifacts = candidate.artifacts, descriptors = candidate.artifactDescriptors;
  const binding = artifacts.filter(item => item.kind === 'agent-loop-execution-binding');
  const apply = artifacts.filter(item => item.kind === 'agent-loop-rolling-summary-apply');
  if (artifacts.length !== 2 || descriptors.length !== 2 || binding.length !== 1 || apply.length !== 1
    || binding[0]!.artifactRef !== p.bindingRef || binding[0]!.status !== 'declared'
    || !binding[0]!.evidenceRefs.includes(p.claimDigest) || apply[0]!.artifactRef !== p.applyRef
    || apply[0]!.status !== 'available' || !same(apply[0]!.evidenceRefs, [...new Set(actionEvidence)].sort())) reject();
  for (const [refId, kind, expectedDigest, expectedRevision, taskRevision] of [
    [p.bindingRef, 'session-artifact', p.bindingDigest, p.claimDigest, 2],
    [p.applyRef, 'memory-record', p.readbackDigest, p.postSourceRevision, 5],
  ] as const) {
    const refs = descriptors.filter(ref => ref.refId === refId);
    if (refs.length !== 1 || refs[0]!.kind !== kind || refs[0]!.expectedDigest !== expectedDigest
      || refs[0]!.expectedRevision !== expectedRevision || refs[0]!.ownerRef !== `maintenancejob.${runId}`
      || refs[0]!.taskRevision !== taskRevision || refs[0]!.policy !== 'required' || refs[0]!.aclClass !== 'restricted'
      || refs[0]!.expandBudgetTokens !== 0) reject();
  }
  return { committed, candidate, verification, record };
}

export function reconcileAgentLoopSummaryApplyCompletion(input: AgentLoopSummaryApplyCompletionReconcileOptions): Readonly<{
  status: 'completed' | 'already-completed'; record: AgentLoopTaskRecord;
}> {
  try {
    normalizeAgentLoopActionObject(input, ['store', 'manager', 'ownerId', 'clock', 'runId', 'taskId'], ['leaseMs']);
    if (!(input.store instanceof AgentLoopProjectionStore) || !(input.manager instanceof MaintenanceJobManager)
      || typeof input.clock !== 'function' || input.leaseMs !== undefined
      && (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 86_400_000)) reject();
    normalizeAgentLoopActionToken(input.ownerId); normalizeAgentLoopActionToken(input.runId); normalizeAgentLoopActionToken(input.taskId);
    const { store, manager, ownerId, taskId } = input, pinned = history(input), p = pinned.committed.completion;
    const committedDigest = hash(pinned.committed);
    const assertCommitted = () => {
      const current = manager.readAgentLoopSummaryApplyCompletion(input.runId);
      if (!current || hash(current) !== committedDigest || current.completion.completedAt > at(input.clock)) reject();
    };
    if (pinned.record.envelope.state === 'COMPLETED') {
      const record = store.assertCompletedCandidate({ taskId, candidateRef: p.candidateRef,
        verificationResultRef: p.verificationResultRef, taskUpdatedAt: p.taskUpdatedAt });
      assertCommitted(); return Object.freeze({ status: 'already-completed', record });
    }
    if (pinned.record.fenced || pinned.record.envelope.state !== 'RUNNING' || pinned.record.envelope.phase !== 'VERIFY'
      || pinned.record.revision !== p.taskRevision || pinned.record.envelopeDigest !== p.envelopeDigest
      || pinned.record.envelope.updatedAt !== p.taskUpdatedAt) reject();
    store.assertFrozenCandidateSnapshot({ taskId, candidateRef: p.candidateRef });
    const now = at(input.clock), expiry = pinned.record.leaseExpiresAt;
    if (expiry !== null && (!Number.isSafeInteger(Date.parse(expiry)) || new Date(expiry).toISOString() !== expiry)) reject();
    if (input.leaseMs !== undefined && (expiry === null || expiry <= now)) {
      assertCommitted(); store.claimLease({ taskId, expectedRevision: p.taskRevision, ownerId, leaseMs: input.leaseMs });
    }
    store.assertCompletionCandidateCurrent({ taskId, ownerId, expectedRevision: p.taskRevision, candidateRef: p.candidateRef });
    assertCommitted();
    const record = store.completeVerifiedCandidate({ taskId, ownerId, expectedRevision: p.taskRevision,
      candidateRef: p.candidateRef, verificationResultRef: p.verificationResultRef }, assertCommitted);
    return Object.freeze({ status: 'completed', record });
  } catch { return reject(); }
}

export function createAgentLoopSummaryApplyCompletion(options: AgentLoopRollingSummaryApplyVerificationOptions): Readonly<{
  coordinatorCompletion: Completion; verify: AgentLoopCoordinatorPorts['verify']; repair: NonNullable<AgentLoopCoordinatorPorts['repair']>;
}> {
  const source = createAgentLoopRollingSummaryApplyLiveVerificationSource(options);
  const { store, manager, ownerId, clock } = options, expectedAttempt = options.execution.job.attempt;
  const outcomes = new WeakMap<object, Readonly<{ record: AgentLoopTaskRecord; completion: MaintenanceAgentLoopSummaryApplyCompletionInput }>>();
  const coordinatorCompletion: Completion = Object.freeze({
    request(input: Parameters<NonNullable<Completion['request']>>[0]) {
      try {
        normalizeAgentLoopActionObject(input, ['record', 'ownerId', 'actionWatermark']);
        recordData(input.record);
        const evidence = source.read(input.record.revision), record = store.read(evidence.taskId);
        if (!record || input.ownerId !== ownerId || record.envelope.phase !== 'OBSERVE'
          || record.envelopeDigest !== input.record.envelopeDigest || record.revision !== input.record.revision
          || input.actionWatermark !== evidence.actionWatermark) reject();
        return issueAgentLoopCompletionRequest({ store, record, ownerId, actionWatermark: evidence.actionWatermark,
          assertSourceCurrent: () => source.assertSourceCurrentAtCommit(evidence) });
      } catch { return reject(); }
    },
    async evaluate(input: Parameters<Completion['evaluate']>[0]) {
      let outcome: Awaited<ReturnType<Completion['evaluate']>> | undefined;
      try {
        normalizeAgentLoopActionObject(input, ['envelope', 'revision', 'attemptId', 'actionWatermark', 'repairAttempts']);
        hash(input.envelope);
        const evidence = source.read(input.revision), record = store.read(evidence.taskId);
        if (!record || record.envelope.phase !== 'VERIFY' || !same(record.envelope, input.envelope)
          || input.attemptId !== evidence.attemptId || input.actionWatermark !== evidence.actionWatermark
          || input.repairAttempts !== 0) reject();
        const candidate = store.freezeCompletionCandidate({ taskId: evidence.taskId, ownerId, expectedRevision: input.revision });
        outcome = await source.prepare({ candidateRef: candidate.candidateRef, expectedRevision: input.revision,
          repairAttempts: input.repairAttempts, maxRepairAttempts: 0 });
        if (outcome.verdict !== 'complete') return outcome;
        if (!isPreparedFrozenAgentLoopCompletion(outcome) || !outcome.verificationResultRef) reject();
        const current = source.read(input.revision), actual = store.assertCompletionCandidateCurrent({ taskId: evidence.taskId,
          ownerId, expectedRevision: input.revision, candidateRef: candidate.candidateRef });
        const verification = store.readCompletionVerification({ taskId: evidence.taskId, verificationResultRef: outcome.verificationResultRef });
        if (!same(current, evidence) || !verification || actual.frozenDigest !== candidate.frozenDigest
          || verification.candidateDigest !== candidate.frozenDigest) reject();
        const completion = normalizeMaintenanceAgentLoopSummaryApplyCompletionInput({ version: VERSION,
          runId: evidence.runId, taskId: evidence.taskId, attemptId: evidence.attemptId, taskRevision: input.revision,
          taskUpdatedAt: record.envelope.updatedAt, envelopeDigest: record.envelopeDigest,
          candidateRef: candidate.candidateRef, candidateDigest: candidate.frozenDigest,
          verificationResultRef: verification.verificationResultRef, verificationDigest: verification.verificationDigest,
          ownerId, claimDigest: evidence.claimDigest, sourceDigest: evidence.sourceDigest, postSourceRevision: evidence.postSourceRevision,
          actionId: evidence.actionId, actionDigest: evidence.actionDigest, actionWatermark: evidence.actionWatermark,
          actionRevision: evidence.actionRevision, actionUpdatedAt: evidence.actionUpdatedAt,
          originDigest: evidence.originDigest, intentDigest: evidence.intentDigest, operationDigest: evidence.operationDigest,
          readbackDigest: evidence.readbackDigest, historyDigest: evidence.historyDigest, proposalDigest: evidence.proposalDigest,
          contextDigest: evidence.contextDigest, budgetDigest: evidence.budgetDigest, bindingRef: evidence.bindingDescriptor.refId,
          bindingDigest: evidence.bindingDescriptor.expectedDigest, applyRef: evidence.applyDescriptor.refId,
          domainCommittedAt: evidence.domainCommittedAt, domainVerifiedAt: evidence.domainVerifiedAt });
        outcomes.set(outcome, Object.freeze({ record, completion }));
        return outcome;
      } catch { if (outcome) revokeFrozenAgentLoopCompletion(outcome); return reject(); }
    },
    commitVerified(input: Parameters<NonNullable<Completion['commitVerified']>>[0]) {
      const outcome = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'evaluation')?.value : undefined;
      const data = outcome && typeof outcome === 'object' ? outcomes.get(outcome) : undefined;
      if (outcome && typeof outcome === 'object') outcomes.delete(outcome);
      const genuine = isPreparedFrozenAgentLoopCompletion(outcome); revokeFrozenAgentLoopCompletion(outcome);
      try {
        normalizeAgentLoopActionObject(input, ['evaluation', 'record', 'ownerId']);
        recordData(input.record);
        if (!data || !genuine || input.ownerId !== ownerId || input.record.revision !== data.record.revision
          || input.record.ownerId !== ownerId || input.record.fenced || input.record.fenceReason !== null
          || input.record.envelopeDigest !== data.record.envelopeDigest || !same(input.record.envelope, data.record.envelope)) reject();
        const p = data.completion;
        manager.completeAgentLoopSummaryApply({ runId: p.runId, owner: ownerId, expectedAttempt, completion: p }, () => {
          const current = source.read(p.taskRevision);
          if (current.historyDigest !== p.historyDigest || current.postSourceRevision !== p.postSourceRevision) reject();
          const candidate = store.assertCompletionCandidateCurrent({ taskId: p.taskId, ownerId,
            expectedRevision: p.taskRevision, candidateRef: p.candidateRef });
          const verification = store.readCompletionVerification({ taskId: p.taskId, verificationResultRef: p.verificationResultRef });
          if (candidate.frozenDigest !== p.candidateDigest || !verification || verification.verificationDigest !== p.verificationDigest) reject();
          source.assertSourceCurrentAtCommit(current);
        });
        return reconcileAgentLoopSummaryApplyCompletion({ store, manager, ownerId, clock, runId: p.runId, taskId: p.taskId }).record;
      } catch { return reject(); }
    },
  });
  return Object.freeze({ coordinatorCompletion,
    // A committed domain write must never acquire another repair/dispatch grant.
    repair: Object.freeze({ commit: () => reject() }),
    verify: async (input: Parameters<AgentLoopCoordinatorPorts['verify']>[0]) => {
      normalizeAgentLoopActionObject(input, ['envelope', 'revision', 'actionId']); hash(input.envelope);
      const evidence = source.read(input.revision), record = store.read(evidence.taskId);
      if (!record || record.envelope.phase !== 'VERIFY' || !same(record.envelope, input.envelope)
        || input.actionId !== evidence.actionId) reject();
      return Object.freeze({ disposition: 'passed' as const, reasonCodes: Object.freeze([]) });
    } });
}
