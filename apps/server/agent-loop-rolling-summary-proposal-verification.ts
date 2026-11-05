/** Actual shadow proposal + AL provenance verification, never a phase driver or completion grant.
 * Bodies remain in the original Manager/Session. Only the original gate evaluates and only
 * the original projection Store freezes/persists verification audit records.
 */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS } from '@jiuguan/agent-loop-contract';
import { agentLoopActionDigest } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
  normalizeAgentLoopActionDigest, normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import { createAgentLoopRollingSummaryArtifactSource, createAgentLoopRollingSummaryProposalArtifact,
  createAgentLoopCorrectionRollingSummaryArtifactSource, type AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
  type AgentLoopRollingSummaryArtifactSourceOptions } from './agent-loop-rolling-summary-artifacts.ts';
import { normalizeMaintenanceAgentLoopShadowProposal } from './maintenance-agent-loop-shadow-proposal.ts';
import { AgentLoopVerifierRegistry, type AgentLoopCompletionCandidate, type AgentLoopVerifierRunner } from './agent-loop-completion-gate.ts';
import { evaluateFrozenAgentLoopCompletion, prepareFrozenAgentLoopCompletion, commitFrozenAgentLoopCompletion,
  restrictFrozenAgentLoopDirectCommit, type AgentLoopFrozenCompletionInput } from './agent-loop-frozen-completion.ts';
import type { AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import type { StoredAgentLoopCompletionCandidate, StoredAgentLoopCompletionVerification } from './agent-loop-completion-record.ts';
import type { AgentLoopArtifactRefDescriptor, AgentLoopArtifactRefRecord, AgentLoopTaskEvent } from './agent-loop-projection-store.ts';
import type { AgentLoopRefResolver, AgentLoopRefResolverRequest, AgentLoopRefResolution } from './agent-loop-continuation.ts';
import { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF } from './agent-loop-model-correction.ts';

export const AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_VERSION = 'agent-loop-rolling-summary-proposal-verification-v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS = Object.freeze({
  artifact: 'verify.maintenance.rolling_summary.shadow.artifact.v1',
  action: 'verify.maintenance.rolling_summary.shadow.action.v1',
} as const);
export const AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_ERRORS = Object.freeze([
  'agent-loop-rolling-summary-proposal-verification-input-invalid',
  'agent-loop-rolling-summary-proposal-verification-source-stale',
  'agent-loop-rolling-summary-proposal-verification-proposal-invalid',
  'agent-loop-rolling-summary-proposal-verification-action-invalid',
  'agent-loop-rolling-summary-proposal-verification-artifacts-invalid',
  'agent-loop-rolling-summary-proposal-verification-candidate-invalid',
] as const);
type Code = typeof AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_ERRORS[number];
type Reason = 'input-invalid' | 'source-stale' | 'proposal-invalid' | 'action-invalid' | 'artifacts-invalid' | 'candidate-invalid';
export class AgentLoopRollingSummaryProposalVerificationError extends Error {
  constructor(readonly code: Code) {
    if (!(AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_ERRORS as readonly string[]).includes(code)) throw new Error('verification-error-code-invalid');
    super(code); this.name = 'AgentLoopRollingSummaryProposalVerificationError';
  }
}
function reject(reason: Reason): never {
  throw new AgentLoopRollingSummaryProposalVerificationError(`agent-loop-rolling-summary-proposal-verification-${reason}`);
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function candidateData(input: AgentLoopCompletionCandidate): AgentLoopCompletionCandidate {
  try {
    const required = ['candidateRef', 'taskId', 'attemptId', 'taskRevision', 'artifactRefs', 'actionWatermark', 'createdAt'];
    if (!input || typeof input !== 'object') reject('candidate-invalid');
    normalizeAgentLoopActionObject(input, required, Object.keys(input).filter(key => !required.includes(key)));
    if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 1 || !Array.isArray(input.artifactRefs)
      || input.artifactRefs.length > 256 || Reflect.ownKeys(input.artifactRefs).length !== input.artifactRefs.length + 1
      || typeof input.createdAt !== 'string' || !Number.isSafeInteger(Date.parse(input.createdAt))
      || new Date(input.createdAt).toISOString() !== input.createdAt) reject('candidate-invalid');
    const refs: string[] = [];
    for (let index = 0; index < input.artifactRefs.length; index++) {
      const property = Object.getOwnPropertyDescriptor(input.artifactRefs, String(index));
      if (!property || !Object.hasOwn(property, 'value')) reject('candidate-invalid');
      refs.push(normalizeAgentLoopActionToken(property.value));
    }
    if (new Set(refs).size !== refs.length) reject('candidate-invalid');
    return Object.freeze({ candidateRef: normalizeAgentLoopActionToken(input.candidateRef),
      taskId: normalizeAgentLoopActionToken(input.taskId), attemptId: normalizeAgentLoopActionToken(input.attemptId),
      taskRevision: input.taskRevision, artifactRefs: Object.freeze(refs),
      actionWatermark: input.actionWatermark === null ? null : normalizeAgentLoopActionToken(input.actionWatermark), createdAt: input.createdAt });
  } catch { return reject('candidate-invalid'); }
}
function descriptorFields(value: AgentLoopArtifactRefDescriptor): AgentLoopArtifactRefDescriptor {
  return { refId: value.refId, kind: value.kind, ownerRef: value.ownerRef, expectedDigest: value.expectedDigest,
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision }),
    policy: value.policy, aclClass: value.aclClass, expandBudgetTokens: value.expandBudgetTokens };
}
function uniqueEvent(events: readonly AgentLoopTaskEvent[], eventId: string, kind: string, revision: number,
  reason?: string): AgentLoopTaskEvent {
  const found = events.filter(event => event.eventId === eventId);
  if (found.length !== 1 || found[0]!.kind !== kind || found[0]!.revision !== revision
    || (reason === undefined ? found[0]!.reasonCode !== undefined : found[0]!.reasonCode !== reason)) reject('action-invalid');
  return found[0]!;
}

export interface AgentLoopRollingSummaryProposalVerificationEvidence {
  readonly version: typeof AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_VERSION;
  readonly taskId: string; readonly taskRevision: number; readonly envelopeDigest: string; readonly attemptId: string;
  readonly goalProfileRef: 'goal.maintenance.rolling_summary.shadow.v1'; readonly mode: 'shadow'; readonly claimDigest: string;
  readonly runId: string; readonly sessionId: string; readonly sourceRevision: string; readonly policyVersion: string;
  readonly jobAttempt: number; readonly ownerId: string; readonly sourceDigest: string;
  readonly proposalRef: string; readonly proposalDigest: string; readonly proposalContextDigest: string;
  readonly preparationDigest: string; readonly proposalRecordDigest: string;
  readonly actionId: string; readonly actionRevision: number; readonly actionDigest: string;
  readonly observationId: string; readonly actionWatermark: string;
  readonly bindingDescriptor: AgentLoopArtifactRefRecord; readonly proposalDescriptor: AgentLoopArtifactRefRecord;
  readonly canonicalEvidenceRefs: readonly string[]; readonly actionEvidenceRefs: readonly string[];
}
export interface AgentLoopRollingSummaryProposalVerification {
  read(expectedRevision: number): AgentLoopRollingSummaryProposalVerificationEvidence;
  readonly resolvers: Readonly<{ 'session-artifact': AgentLoopRefResolver; candidate: AgentLoopRefResolver }>;
  readonly registry: AgentLoopVerifierRegistry;
  readonly runners: Readonly<Record<string, AgentLoopVerifierRunner>>;
  /** Component-only trusted Core port. Do not select for the real Service until
   * Manager publication commits first and a separate published-origin guard exists.
   * The live prepared reader here deliberately cannot authorize post-publication recovery.
   */
  readonly coordinatorCompletion: NonNullable<AgentLoopCoordinatorPorts['completion']>;
  evaluate(input: Readonly<{ candidateRef: string; expectedRevision: number; repairAttempts?: number;
    maxRepairAttempts?: number }>): Promise<StoredAgentLoopCompletionVerification>;
}

/** No source ID is ever parsed out of a ref to select a domain reader. */
export function createAgentLoopRollingSummaryProposalVerification(
  options: AgentLoopRollingSummaryArtifactSourceOptions,
): AgentLoopRollingSummaryProposalVerification {
  return createProposalVerification(options, 'single-pass');
}
/** Separate live corrected-shadow ingress; the old factory remains exact. */
export function createAgentLoopCorrectionRollingSummaryProposalVerification(
  options: AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
): AgentLoopRollingSummaryProposalVerification {
  return createProposalVerification(options, 'correction');
}
function createProposalVerification(options: AgentLoopRollingSummaryArtifactSourceOptions | AgentLoopCorrectionRollingSummaryArtifactSourceOptions,
  kind: 'single-pass' | 'correction'): AgentLoopRollingSummaryProposalVerification {
  const correction = kind === 'correction';
  if (kind !== 'single-pass' && kind !== 'correction') return reject('input-invalid');
  let source: ReturnType<typeof createAgentLoopRollingSummaryArtifactSource>;
  try { source = correction ? createAgentLoopCorrectionRollingSummaryArtifactSource(options as AgentLoopCorrectionRollingSummaryArtifactSourceOptions)
    : createAgentLoopRollingSummaryArtifactSource(options); }
  catch { return reject('source-stale'); }
  const { store, manager, ownerId, clock, signal } = options;
  const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  const taskId = `agentloop.maintenance.${options.execution.job.runId}`;
  const readSource = (revision: number) => {
    try { return source.read(revision); } catch { return reject('source-stale'); }
  };
  const actualDescriptor = (expected: AgentLoopArtifactRefDescriptor, refs: readonly AgentLoopArtifactRefRecord[],
    phase: AgentLoopTaskEvent, events: readonly AgentLoopTaskEvent[]): AgentLoopArtifactRefRecord => {
    const found = refs.filter(ref => ref.refId === expected.refId);
    if (found.length !== 1 || !same(descriptorFields(found[0]!), descriptorFields(expected))
      || found[0]!.taskRevision !== phase.revision) reject('artifacts-invalid');
    const event = uniqueEvent(events, `ref-registered:${expected.refId}`, 'ref-registered', phase.revision);
    // Original commit writes this sole descriptor event immediately before its phase event.
    // A public same-revision registerRef after that CAS cannot backfill this lineage.
    if (event.acceptedAt !== found[0]!.registeredAt || event.acceptedAt !== phase.acceptedAt
      || events.indexOf(event) + 1 !== events.indexOf(phase)) reject('artifacts-invalid');
    return found[0]!;
  };
  const read = (expectedRevision: number): AgentLoopRollingSummaryProposalVerificationEvidence => {
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) reject('input-invalid');
      const live = readSource(expectedRevision), { goal, record, execution } = live;
      const lineage = live.lineage;
      if (goal.mode !== 'shadow' || goal.requiresDomainWrite || record.envelope.phase !== 'OBSERVE' && record.envelope.phase !== 'VERIFY'
        || digest(record.envelope) !== record.envelopeDigest) reject('source-stale');
      let proposal: ReturnType<typeof manager.readAgentLoopShadowProposal>;
      try { proposal = manager.readAgentLoopShadowProposal(goal.binding.runId); } catch { return reject('proposal-invalid'); }
      if (!proposal || !live.source.snapshot.proposalContext) reject('proposal-invalid');
      let body: ReturnType<typeof normalizeMaintenanceAgentLoopShadowProposal>;
      try {
        body = normalizeMaintenanceAgentLoopShadowProposal({ proposal: proposal.proposal,
          proposalContext: live.source.snapshot.proposalContext });
      } catch { return reject('proposal-invalid'); }
      if (proposal.jobRunId !== goal.binding.runId || proposal.sessionId !== goal.binding.sessionId
        || proposal.sourceRevision !== goal.binding.sourceRevision || proposal.taskKind !== 'rolling_summary'
        || proposal.status !== 'prepared' || proposal.revision !== 1 || proposal.updatedAt !== proposal.createdAt
        || proposal.preparation.mode !== 'shadow' || proposal.preparation.policyVersion !== goal.binding.policyVersion
        || proposal.preparation.ownerInstanceId !== ownerId || proposal.preparation.attempt !== goal.binding.attempt
        || proposal.proposalDigest !== body.proposalDigest || proposal.preparation.proposalContextDigest !== body.proposalContextDigest
        || !same(proposal.proposal, body.proposal) || !same(proposal.context, body.context)) reject('proposal-invalid');

      const events = store.readEvents(taskId), observations = store.readObservations(taskId), refs = store.readRefs(taskId);
      const started = events.filter(event => event.kind === 'action-started');
      const completed = events.filter(event => event.kind === 'action-completed');
      if (started.length !== 1 || completed.length !== 1 || events.some(event => event.kind === 'action-reconciled')) reject('action-invalid');
      const start = started[0]!, actionId = start.eventId.slice('action-started:'.length);
      if (start.eventId !== `action-started:${actionId}`) reject('action-invalid');
      const receipt = store.readActionReceipt({ taskId, actionId });
      if (!receipt || receipt.status !== 'observed' || receipt.actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
        || receipt.taskId !== taskId || receipt.ownerId !== ownerId || receipt.attemptId !== goal.attemptId
        || receipt.expectedRevision !== start.revision || receipt.expectedRevision < 3
        || receipt.appliedRevision !== receipt.expectedRevision + 1 || !receipt.result || !receipt.startedAt
        || !receipt.completedAt || !receipt.settledAt || !receipt.observedAt || receipt.releasedAt !== undefined
        || receipt.receiptRef !== `receipt:${actionId}` || receipt.observationId !== `obs:${actionId}`) reject('action-invalid');
      const actionRevision = receipt.expectedRevision, appliedRevision = receipt.appliedRevision;
      if (correction && (!lineage || actionRevision !== lineage.actionRevision || actionId !== lineage.actionId
        || ![lineage.observeRevision,lineage.observeRevision+1].includes(expectedRevision)
        || actionRevision !== (lineage.modelCallsUsed === 1 ? 3 : 5))) reject('action-invalid');
      const actionWatermark = `action-completed:${actionId}`;
      const startedEvent = uniqueEvent(events, start.eventId, 'action-started', actionRevision, 'act');
      const completedEvent = uniqueEvent(events, actionWatermark, 'action-completed', appliedRevision, 'act');
      const observedEvent = uniqueEvent(events, `observation:${receipt.observationId}`, 'observation-applied', appliedRevision);
      const observedPhase = uniqueEvent(events, `phase:${taskId}:${appliedRevision}:ACT-OBSERVE`, 'phase-advanced', appliedRevision + 1, 'act');
      uniqueEvent(events, `phase:${taskId}:${actionRevision - 1}:MODEL-ACT`, 'phase-advanced', actionRevision, 'act');
      const initialPhase = uniqueEvent(events, `phase:${taskId}:${correction ? 1 : actionRevision - 2}:PREPARE-MODEL`,
        'phase-advanced', correction ? 2 : actionRevision - 1);
      if (completed[0]!.eventId !== actionWatermark || appliedRevision + 1 > expectedRevision
        || proposal.createdAt < receipt.startedAt || proposal.createdAt > receipt.completedAt
        || initialPhase.acceptedAt > receipt.startedAt || startedEvent.acceptedAt > receipt.createdAt
        || completedEvent.acceptedAt < receipt.observedAt || observedEvent.acceptedAt !== receipt.observedAt) reject('action-invalid');
      const actualDigest = agentLoopActionDigest({ actionId, taskId, attemptId: goal.attemptId,
        expectedTaskRevision: actionRevision, actionContractRef: AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
        args: body.proposal.payload });
      if (receipt.actionDigest !== actualDigest || receipt.result.sourceKind !== 'tool'
        || receipt.result.sourceRef !== `maintenance.proposal:${goal.binding.runId}`
        || receipt.result.completeness !== 'complete' || receipt.result.payloadDigest !== proposal.preparation.preparationDigest
        || !same(receipt.result.evidenceRefs, [goal.claimDigest, body.proposalDigest, body.proposalContextDigest,
          proposal.preparation.preparationDigest, `snapshot:${live.sourceDigest.slice(7)}`])) reject('action-invalid');
      const receiptKey = digest(actionId).slice(7);
      const sidecarEvents = events.filter(event => event.kind.startsWith('action-receipt-'));
      if (sidecarEvents.length !== 5) reject('action-invalid');
      for (const stage of ['reserved', 'started', 'completed', 'settled'] as const) {
        const event = uniqueEvent(events, `action-receipt:${receiptKey}:${stage}`, `action-receipt-${stage}`, actionRevision);
        const timestamp = stage === 'reserved' ? receipt.createdAt : stage === 'started' ? receipt.startedAt
          : stage === 'completed' ? receipt.completedAt : receipt.settledAt;
        if (event.acceptedAt !== timestamp) reject('action-invalid');
      }
      if (uniqueEvent(events, `action-receipt:${receiptKey}:observed`, 'action-receipt-observed', appliedRevision).acceptedAt !== receipt.observedAt) reject('action-invalid');
      const usage = receipt.result.usage, budget = record.envelope.budget;
      if (usage.toolCalls !== 1 || usage.writes !== 1 || usage.modelCalls !== 0 || usage.inputTokens !== 0
        || usage.outputTokens !== 0 || usage.costMicrousd !== 0 || usage.highRiskActions !== 0
        || budget.granted.modelCalls !== (correction ? 2 : 1) || budget.granted.toolCalls !== 1 || budget.granted.writes !== 1
        || budget.spent.modelCalls !== (correction ? lineage!.modelCallsUsed : 1) || budget.spent.toolCalls !== 1 || budget.spent.writes !== 1
        || budget.spent.inputTokens < 1 || budget.spent.outputTokens < 1 || budget.spent.wallMs < usage.wallMs
        || ['highRiskActions', 'childTasks'].some(key => budget.spent[key as keyof typeof budget.spent] !== 0
          || budget.granted[key as keyof typeof budget.granted] !== 0)
        || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => budget.reserved[key] !== 0 || budget.spent[key] > budget.granted[key])) reject('action-invalid');
      const tool = observations.filter(item => item.observationId === receipt.observationId);
      const modelId = agentLoopModelInvocationId({ taskId, attemptId: goal.attemptId, expectedTaskRevision: actionRevision - 1 });
      const model = observations.filter(item => item.observationId === `model-usage:${modelId}`);
      const modelReservation = uniqueEvent(events, `model-invocation:${modelId}`, 'model-invocation-reserved', actionRevision - 1);
      if (observations.length !== (correction ? lineage!.modelCallsUsed + 1 : 2) || tool.length !== 1 || model.length !== 1 || tool[0]!.sourceKind !== 'tool'
        || tool[0]!.attemptId !== goal.attemptId || tool[0]!.observedForTaskRevision !== actionRevision
        || tool[0]!.classification !== 'applied' || tool[0]!.appliedRevision !== appliedRevision
        || tool[0]!.completeness !== 'complete' || tool[0]!.satisfiesVerification !== true
        || model[0]!.sourceKind !== 'provider' || model[0]!.attemptId !== goal.attemptId
        || model[0]!.observedForTaskRevision !== actionRevision - 1 || model[0]!.classification !== 'applied'
        || model[0]!.appliedRevision !== actionRevision || model[0]!.completeness !== 'complete'
        || modelReservation.acceptedAt > model[0]!.ingestedAt || model[0]!.ingestedAt > receipt.startedAt
        || tool[0]!.ingestedAt !== receipt.observedAt
        || tool[0]!.reasonCodes.length > 0 || model[0]!.reasonCodes.length > 0) reject('action-invalid');

      let declared: ReturnType<typeof createAgentLoopRollingSummaryProposalArtifact>;
      try { declared = createAgentLoopRollingSummaryProposalArtifact({ execution, source: live.source, proposal, actionId }); }
      catch { return reject('artifacts-invalid'); }
      const artifacts = record.envelope.artifacts;
      const available = artifacts.filter(item => item.kind === 'agent-loop-rolling-summary-proposal');
      if (artifacts.length !== 2 || available.length !== 1 || refs.length !== 2 || !same(available[0], declared.artifact)) reject('artifacts-invalid');
      const bindingDescriptor = actualDescriptor(live.bindingDescriptor, refs, initialPhase, events);
      const proposalDescriptor = actualDescriptor(declared.descriptor, refs, observedPhase, events);
      const latest = readSource(expectedRevision);
      const finalProposal = manager.readAgentLoopShadowProposal(goal.binding.runId);
      if (latest.record.envelopeDigest !== record.envelopeDigest || !finalProposal || digest(finalProposal) !== digest(proposal)
        || !same(store.readRefs(taskId), refs) || !same(store.readObservations(taskId), observations)
        || !same(store.readActionReceipt({ taskId, actionId }), receipt)
        || !same(store.readEvents(taskId), events)
        || readSource(expectedRevision).record.envelopeDigest !== record.envelopeDigest) reject('source-stale');
      return Object.freeze({ version: AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFICATION_VERSION,
        taskId, taskRevision: expectedRevision, envelopeDigest: record.envelopeDigest, attemptId: goal.attemptId,
        goalProfileRef: 'goal.maintenance.rolling_summary.shadow.v1', mode: 'shadow', claimDigest: goal.claimDigest,
        runId: goal.binding.runId, sessionId: goal.binding.sessionId, sourceRevision: goal.binding.sourceRevision,
        policyVersion: goal.binding.policyVersion, jobAttempt: goal.binding.attempt, ownerId, sourceDigest: live.sourceDigest,
        proposalRef: declared.artifact.artifactRef, proposalDigest: body.proposalDigest,
        proposalContextDigest: body.proposalContextDigest, preparationDigest: proposal.preparation.preparationDigest,
        proposalRecordDigest: digest(proposal), actionId, actionRevision, actionDigest: actualDigest,
        observationId: receipt.observationId, actionWatermark, bindingDescriptor, proposalDescriptor,
        canonicalEvidenceRefs: Object.freeze([goal.claimDigest, body.proposalDigest, body.proposalContextDigest,
          proposal.preparation.preparationDigest, bindingDescriptor.refId, proposalDescriptor.refId]),
        actionEvidenceRefs: Object.freeze([actionWatermark, receipt.observationId, actualDigest, `snapshot:${live.sourceDigest.slice(7)}`,
          ...(correction ? [lineage!.policyDigest] : [])]),
      });
    } catch (error) {
      if (error instanceof AgentLoopRollingSummaryProposalVerificationError) throw error;
      return reject('source-stale');
    }
  };
  const candidateEvidence = (candidate: AgentLoopCompletionCandidate): AgentLoopRollingSummaryProposalVerificationEvidence => {
    try {
      candidate = candidateData(candidate);
      if (!candidate || candidate.taskId !== taskId) reject('candidate-invalid');
      const actual = store.assertCompletionCandidateCurrent({ taskId, ownerId, expectedRevision: candidate.taskRevision,
        candidateRef: candidate.candidateRef });
      if (actual.attemptId !== candidate.attemptId || actual.createdAt !== candidate.createdAt
        || actual.actionWatermark !== candidate.actionWatermark || !same(actual.artifactRefs, candidate.artifactRefs)
        || actual.unknownEffectActionIds.length > 0 || actual.missingArtifactRefs.length > 0) reject('candidate-invalid');
      const evidence = read(candidate.taskRevision);
      if (evidence.envelopeDigest !== actual.envelopeDigest || evidence.attemptId !== actual.attemptId
        || evidence.actionWatermark !== actual.actionWatermark
        || !same(actual.artifactDescriptors.filter(item => item.refId === evidence.bindingDescriptor.refId), [evidence.bindingDescriptor])
        || !same(actual.artifactDescriptors.filter(item => item.refId === evidence.proposalDescriptor.refId), [evidence.proposalDescriptor])) reject('candidate-invalid');
      return evidence;
    } catch (error) {
      if (error instanceof AgentLoopRollingSummaryProposalVerificationError) throw error;
      return reject('candidate-invalid');
    }
  };

  const resolve = (kind: 'session-artifact' | 'candidate'): AgentLoopRefResolver => (request: AgentLoopRefResolverRequest): AgentLoopRefResolution => {
    try {
      normalizeAgentLoopActionObject(request, ['refId', 'kind', 'ownerRef', 'expectedDigest'], ['expectedRevision']);
      normalizeAgentLoopActionDigest(request.expectedDigest);
      if (request.expectedRevision !== undefined) normalizeAgentLoopActionToken(request.expectedRevision);
      const current = store.read(taskId);
      if (!current) return Object.freeze({ status: 'missing' });
      const live = readSource(current.revision);
      const expected = kind === 'session-artifact' ? live.bindingDescriptor : read(current.revision).proposalDescriptor;
      const refs = store.readRefs(taskId), found = refs.filter(item => item.refId === expected.refId);
      if (request.kind !== kind || request.refId !== expected.refId || request.ownerRef !== expected.ownerRef) return Object.freeze({ status: 'forbidden' });
      if (found.length !== 1 || !same(descriptorFields(found[0]!), descriptorFields(expected))) return Object.freeze({ status: 'missing' });
      if (kind === 'session-artifact') {
        const events = store.readEvents(taskId), phases = events.filter(event => event.kind === 'phase-advanced'
          && event.eventId.endsWith(':PREPARE-MODEL'));
        if (phases.length !== 1 || phases[0]!.revision > current.revision) return Object.freeze({ status: 'forbidden' });
        const phase = uniqueEvent(events, `phase:${taskId}:${phases[0]!.revision - 1}:PREPARE-MODEL`, 'phase-advanced', phases[0]!.revision);
        actualDescriptor(expected, refs, phase, events);
      }
      // Never echo requested expectations. Continuation compares these actual source-derived values.
      return Object.freeze({ status: 'found', digest: expected.expectedDigest, revision: expected.expectedRevision });
    } catch { return Object.freeze({ status: 'forbidden' }); }
  };
  const registry = new AgentLoopVerifierRegistry();
  registry.register({ taskKind: registration.taskKind, contractRevision: registration.contractRevision,
    verifierSetRef: registration.verifierSetRef, verifierSetRevision: registration.verifierSetRevision,
    verifiers: [{ verifierId: AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.artifact, version: '1.0.0', kind: 'artifact-integrity', requirement: 'required' },
      { verifierId: AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.action, version: '1.0.0', kind: 'deterministic', requirement: 'required' }] });
  Object.freeze(registry);
  const runner = (part: 'artifact' | 'action'): AgentLoopVerifierRunner => async ({ candidate, declaration }) => {
    try {
      if (declaration.verifierId !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS[part] || declaration.version !== '1.0.0'
        || declaration.requirement !== 'required' || declaration.kind !== (part === 'artifact' ? 'artifact-integrity' : 'deterministic')) reject('input-invalid');
      const evidence = candidateEvidence(candidate);
      return Object.freeze({ disposition: 'passed', reasonCodes: Object.freeze([]),
        evidenceRefs: part === 'artifact' ? evidence.canonicalEvidenceRefs : evidence.actionEvidenceRefs });
    } catch (error) {
      const code = error instanceof AgentLoopRollingSummaryProposalVerificationError ? error.code
        : 'agent-loop-rolling-summary-proposal-verification-source-stale';
      return Object.freeze({ disposition: 'inconclusive', reasonCodes: Object.freeze([code]), evidenceRefs: Object.freeze([]) });
    }
  };
  const runners: Readonly<Record<string, AgentLoopVerifierRunner>> = Object.freeze({
    [AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.artifact]: runner('artifact'),
    [AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_VERIFIER_IDS.action]: runner('action'),
  });
  const evaluationInput = (input: Readonly<{ candidateRef: string; expectedRevision: number;
    repairAttempts?: number; maxRepairAttempts?: number }>): AgentLoopFrozenCompletionInput => {
      let candidateRef: string, expectedRevision: number, repairAttempts: number, maxRepairAttempts: number;
      try {
        normalizeAgentLoopActionObject(input, ['candidateRef', 'expectedRevision'], ['repairAttempts', 'maxRepairAttempts']);
        candidateRef = normalizeAgentLoopActionToken(input.candidateRef); expectedRevision = input.expectedRevision;
        repairAttempts = input.repairAttempts === undefined
          ? store.readRepairState({ taskId, expectedRevision }).attempts : input.repairAttempts;
        maxRepairAttempts = input.maxRepairAttempts === undefined ? 0 : input.maxRepairAttempts;
        if (![expectedRevision, repairAttempts, maxRepairAttempts].every(Number.isSafeInteger)
          || expectedRevision < 1 || repairAttempts < 0 || maxRepairAttempts !== 0) reject('input-invalid');
      } catch { return reject('input-invalid'); }
      const baseline = read(expectedRevision);
      if (store.read(taskId)?.envelope.phase !== 'VERIFY') reject('candidate-invalid');
      const assertCurrent = (candidate: StoredAgentLoopCompletionCandidate) => {
        if (candidate.candidateRef !== candidateRef || candidate.taskRevision !== expectedRevision) reject('candidate-invalid');
        const evidence = candidateEvidence(candidate);
        if (evidence.proposalRecordDigest !== baseline.proposalRecordDigest || evidence.actionDigest !== baseline.actionDigest) reject('candidate-invalid');
      };
      return { store, ownerId, taskId, candidateRef, expectedRevision,
        registry, contractBinding: { taskKind: registration.taskKind, taskContractRef: correction ? AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF : registration.contractRef,
          contractRevision: registration.contractRevision }, runners, repairAttempts, maxRepairAttempts, clock, signal,
        assertSourceCurrent: assertCurrent,
        // The original AL writer lock is already held. Do not nest AL Store reads/transactions.
        assertSourceCurrentAtCommit: () => {
          source.assertSourceCurrent();
          const proposal = manager.readAgentLoopShadowProposal(baseline.runId);
          if (!proposal || digest(proposal) !== baseline.proposalRecordDigest
            || proposal.proposalDigest !== baseline.proposalDigest
            || proposal.preparation.proposalContextDigest !== baseline.proposalContextDigest
            || proposal.preparation.preparationDigest !== baseline.preparationDigest
            || proposal.preparation.ownerInstanceId !== ownerId || proposal.preparation.attempt !== baseline.jobAttempt) reject('proposal-invalid');
          source.assertSourceCurrent();
        },
      };
  };
  const coordinatorCompletion: NonNullable<AgentLoopCoordinatorPorts['completion']> = Object.freeze({
    async evaluate(input: Parameters<NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate']>[0]) {
      try {
        normalizeAgentLoopActionObject(input, ['envelope', 'revision', 'attemptId', 'actionWatermark', 'repairAttempts']);
        const actual = store.read(taskId), evidence = read(input.revision);
        if (!actual || actual.envelope.state !== 'RUNNING' || actual.envelope.phase !== 'VERIFY'
          || actual.revision !== input.revision || !same(actual.envelope, input.envelope)
          || input.attemptId !== evidence.attemptId || input.actionWatermark !== evidence.actionWatermark
          || input.repairAttempts !== store.readRepairState({ taskId, expectedRevision: input.revision }).attempts) reject('candidate-invalid');
        const candidate = store.freezeCompletionCandidate({ taskId, ownerId, expectedRevision: input.revision });
        const outcome = await prepareFrozenAgentLoopCompletion(evaluationInput({ candidateRef: candidate.candidateRef,
          expectedRevision: input.revision, repairAttempts: input.repairAttempts, maxRepairAttempts: 0 }));
        // A new corrected-shadow verifier outcome must never escape with an
        // AL-first terminal consumer. Only the separate publication exchange
        // can add its own live authority and commit Manager business truth.
        if (correction) restrictFrozenAgentLoopDirectCommit(outcome);
        return outcome;
      } catch { return reject('candidate-invalid'); }
    },
    commitVerified(input: Parameters<NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['commitVerified']>>[0]) {
      try {
        normalizeAgentLoopActionObject(input, ['evaluation', 'record', 'ownerId']);
        // The private exchange also burns a genuine outcome presented with a
        // wrong owner/record; this adapter must not short-circuit that consumption.
        return commitFrozenAgentLoopCompletion(input.evaluation, { store, record: input.record, ownerId: input.ownerId });
      } catch { return reject('candidate-invalid'); }
    },
  });
  return Object.freeze({ read, resolvers: Object.freeze({ 'session-artifact': resolve('session-artifact'), candidate: resolve('candidate') }),
    registry, runners, coordinatorCompletion,
    async evaluate(input: Readonly<{ candidateRef: string; expectedRevision: number; repairAttempts?: number; maxRepairAttempts?: number }>) {
      return evaluateFrozenAgentLoopCompletion(evaluationInput(input));
    },
  });
}
