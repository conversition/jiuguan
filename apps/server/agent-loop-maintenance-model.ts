/** A single admitted rolling-summary MODEL step. No Client, Runner, tool execution or domain write.
 * Construction is host-only; the opaque Session and configured Gateway guard are not model authority.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeAgentLoopDecision, type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import type { PublicMaintenanceJob } from '@jiuguan/mobile-contracts';
import { agentBudgetProfileDigest, assertAgentBudgetWithinHostCeiling, type AgentBudgetProfileV2 } from '../../packages/agent-policy/public/budget-profile.ts';
import type { AdmittedModelLeaseAudit, AdmittedModelLeaseOutcome } from './admitted-model-gateway.ts';
import { estimateAdmittedRequestInputTokens } from './admitted-model-gateway.ts';
import { resolveMaintenanceModelToolSurface, type AdmittedMaintenanceModelHandle } from './admitted-maintenance-model.ts';
import { agentLoopModelInvocationId, type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { createAgentLoopModelOutcome, readAgentLoopModelOutcome, isAgentLoopModelProtocolRejectionReason,
  AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION,
  type AgentLoopModelProtocolRejectionReason, type AgentLoopSummaryValidationRejection } from './agent-loop-model-outcome.ts';
import { assertAgentLoopMaintenancePreparedBinding } from './agent-loop-maintenance-execution-prepare.ts';
import {
  resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot,
  type AgentLoopMaintenancePrepareSource,
} from './agent-loop-prepare.ts';
import { agentLoopProjectionEventDigest, type AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION,
  normalizeAgentLoopModelCorrectionPolicy, assertAgentLoopModelCorrectionPolicyBinding,
  agentLoopModelCorrectionPolicyDigest, type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { maintenanceSystemPrompt } from './maintenance-harness-service.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';
import { maintenanceHarnessRequest } from './maintenance-model-adapter.ts';
import { MaintenanceToolRegistry } from './maintenance-tool-registry.ts';
import { validateMaintenanceProposal } from './maintenance-types.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { assertAgentLoopRollingSummaryApplyModelCapability, revokeAgentLoopRollingSummaryApplyCapability,
  type AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';
import { assertAgentLoopCorrectionProposalModelCapability,
  type AgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';

export const AGENT_LOOP_MAINTENANCE_MODEL_VERSION = 'agent-loop-maintenance-model-v1' as const;
/** Declarations only: these refs do not register/authorize an Action Gateway route. */
export const AGENT_LOOP_MAINTENANCE_MODEL_ACTION_REFS = Object.freeze({
  query_memory: 'action.maintenance.query_memory.v1',
  get_worldbook: 'action.maintenance.get_worldbook.v1',
  get_variables: 'action.maintenance.get_variables.v1',
  propose_rolling_summary: 'action.maintenance.propose_rolling_summary.v1',
});
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

export interface AgentLoopMaintenanceModelSource extends AgentLoopMaintenancePrepareSource {
  /** Exact loaded Session object; never serialized, persisted or supplied by Provider output. */
  readonly sessionIdentity: object;
  /** Host attestation of an actual Gateway authorizeDispatch installation, not an execution grant. */
  readonly hostDispatchGuarded: true;
}
export interface AgentLoopMaintenanceModelOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly execution: MaintenanceExecutionRecord;
  readonly fixedSource: AgentLoopMaintenanceModelSource;
  readonly handle: AdmittedMaintenanceModelHandle;
  /** Per-invocation remaining cap; the source profile stays the original stable Prepare ceiling. */
  readonly callBudgetProfile?: AgentBudgetProfileV2;
  readonly readCurrent: (runId: string) => Readonly<{
    execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceModelSource;
  }> | null | Promise<Readonly<{ execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceModelSource }> | null>;
  readonly signal: AbortSignal;
  readonly harnessRunId: string;
  /** Explicit host selection only. Inspection never consumes ACT's one-use capability. */
  readonly rollingSummaryApplyCapability?: AgentLoopRollingSummaryApplyCapability;
  /** Independent model-only contract. Metadata never grants a call or an Action. */
  readonly modelCorrectionPolicy?: AgentLoopModelCorrectionPolicy;
  /** Independent shadow-correction selection. The original policy and scoped
   * consumer remain mandatory; this does not consume ACT's one-use capability. */
  readonly correctionProposalCapability?: AgentLoopCorrectionProposalCapability;
  /** Original initial JSON/Summary refusal, never a history DTO or a grant. */
  readonly correctionRejectedModelOutcome?: unknown;
}

function reject(): never { throw new Error('agent-loop-maintenance-model-rejected'); }
function assertInertPrototypeChain(options: object): void {
  for (let current: object | null = options; current !== null; current = Object.getPrototypeOf(current)) {
    if (nodeTypes.isProxy(current)) reject();
  }
}
function correctionPolicyOf(options: object): AgentLoopModelCorrectionPolicy | undefined {
  assertInertPrototypeChain(options);
  if (!('modelCorrectionPolicy' in options)) return undefined;
  const property = Object.getOwnPropertyDescriptor(options, 'modelCorrectionPolicy');
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
  try { return normalizeAgentLoopModelCorrectionPolicy(property.value); } catch { return reject(); }
}
function correctionProposalOf(options: object): Readonly<{ capability: unknown }> | undefined {
  assertInertPrototypeChain(options);
  if (!('correctionProposalCapability' in options)) return undefined;
  const property = Object.getOwnPropertyDescriptor(options, 'correctionProposalCapability');
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
  if (nodeTypes.isPromise(property.value)) {
    void Promise.prototype.then.call(property.value, () => undefined, () => undefined); reject();
  }
  return Object.freeze({ capability: property.value });
}
function correctionFeedbackOf(options: object): Readonly<{ outcome: unknown; kind: 'json-invalid' }
  | { outcome: unknown; kind: 'summary'; rejection: AgentLoopSummaryValidationRejection }> | undefined {
  assertInertPrototypeChain(options);
  if (!('correctionRejectedModelOutcome' in options)) return undefined;
  const property = Object.getOwnPropertyDescriptor(options, 'correctionRejectedModelOutcome');
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject();
  // WeakMap recognition does not inspect foreign objects, Promise constructors
  // or thenables. Explicit invalid selection must not become a generic fallback.
  const model = readAgentLoopModelOutcome(property.value);
  if (!model || model.decision !== null) reject();
  if (model.protocolRejectionReason === 'json-invalid' && model.summaryValidationRejection === undefined)
    return Object.freeze({ outcome: property.value, kind: 'json-invalid' });
  if (model.protocolRejectionReason !== 'proposal-invalid' || !model.summaryValidationRejection) reject();
  return Object.freeze({ outcome: property.value, kind: 'summary', rejection: model.summaryValidationRejection });
}
function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown> : null;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = plain(value);
  if (!row) return reject();
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}
function ticketHash(ticketId: string): string {
  return `sha256:${createHash('sha256').update(ticketId, 'utf8').digest('hex')}`;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function now(clock: () => string): string {
  const value = clock();
  if (!timestamp(value)) return reject();
  return value;
}
function jobHeader(job: MaintenanceExecutionRecord['job']) {
  return { runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind, sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? null, trigger: job.trigger,
    mode: job.mode, status: job.status, attempt: job.attempt, createdAt: job.createdAt };
}
function executionHeader(execution: MaintenanceExecutionRecord) {
  return { job: jobHeader(execution.job), owner: execution.leaseOwnerInstanceId, executorRoute: execution.executorRoute };
}
function assertExecution(execution: MaintenanceExecutionRecord, at: string, expectedOwnerId: string): void {
  const job = execution.job;
  if (execution.executorRoute !== 'agent-loop' || job.taskKind !== 'rolling_summary'
    || job.status !== 'running' || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || !TOKEN.test(execution.leaseOwnerInstanceId) || execution.leaseOwnerInstanceId !== expectedOwnerId
    || !timestamp(execution.leaseExpiresAt)
    || Date.parse(execution.leaseExpiresAt) <= Date.parse(at) || execution.cancelRequestedAt !== undefined) reject();
}
function sourceIdentity(source: AgentLoopMaintenanceModelSource) {
  if (source.hostDispatchGuarded !== true || source.sessionIdentity === null || typeof source.sessionIdentity !== 'object') reject();
  const profile = resolveAgentLoopMaintenanceProfile(source);
  const snapshot = validateAgentLoopMaintenanceSnapshot(source);
  return { profile, snapshot, job: jobHeader(source.job) };
}

export interface AgentLoopMaintenanceModelRecordOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly job: PublicMaintenanceJob;
  readonly budgetProfile: AgentBudgetProfileV2;
  readonly envelope: AgentLoopTaskEnvelopeV1;
  readonly revision: number;
  /** Only a host pre-handle read may omit the marker; this never issues or authorizes a call. */
  readonly requireReservation?: boolean;
  readonly modelCorrectionPolicy?: AgentLoopModelCorrectionPolicy;
  readonly correctionProposalCapability?: AgentLoopCorrectionProposalCapability;
  readonly correctionRejectedModelOutcome?: unknown;
}

/** Shared read-only MODEL binding/cap validation; not a Session/source/Manager execution grant. */
export function assertAgentLoopMaintenanceModelRecord(options: AgentLoopMaintenanceModelRecordOptions): AgentLoopTaskRecord {
  const correctionPolicy = correctionPolicyOf(options);
  const proposalSelection = correctionProposalOf(options);
  const correctionFeedback = correctionFeedbackOf(options);
  if (proposalSelection && !correctionPolicy || correctionFeedback && (!proposalSelection || !correctionPolicy)) reject();
  const { store, ownerId, clock, job, budgetProfile, envelope, revision } = options;
  const current = store.read(envelope.taskId), at = now(clock), registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  if (!current || current.fenced || current.ownerId !== ownerId || current.revision !== revision
    || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(at)
    || current.envelope.phase !== 'MODEL' || current.envelope.state !== 'RUNNING'
    || !current.envelope.currentAttemptId || hash(current.envelope) !== hash(envelope)
    || current.envelope.taskId !== `agentloop.maintenance.${job.runId}`
    || current.envelope.taskKind !== registration.taskKind
    || current.envelope.taskContractRef !== (correctionPolicy ? AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF : registration.contractRef)
    || current.envelope.verifier.verifierSetRef !== registration.verifierSetRef
    || current.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
    || current.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
    || hash(current.envelope.goal.sourceRefs) !== hash([`maintenancejob.${job.runId}`, `revision.${job.sourceRevision}`])) reject();
  const remaining = (key: 'modelCalls' | 'inputTokens' | 'outputTokens' | 'costMicrousd' | 'wallMs') => current.envelope.budget.granted[key]
    - current.envelope.budget.reserved[key] - current.envelope.budget.spent[key];
  // AL authority must contain the fixed Gateway ceilings, not merely the
  // host-base estimate: asynchronous preparation may add admitted context.
  if (remaining('modelCalls') < 1 || remaining('inputTokens') < budgetProfile.agentInputBudgetTokens
    || remaining('outputTokens') < budgetProfile.agentOutputBudgetTokens
    || remaining('costMicrousd') < budgetProfile.maxCostMicrousd
    || remaining('wallMs') < budgetProfile.maxWallMs) reject();
  if (correctionPolicy) {
    try { assertAgentLoopModelCorrectionPolicyBinding(correctionPolicy, current); } catch { return reject(); }
    const budget = current.envelope.budget;
    if (job.mode !== 'shadow' || budgetProfile.maxModelCalls !== 1 || budget.granted.modelCalls !== 2
      || current.envelope.currentAttemptId !== `attempt.al.${agentLoopMaintenanceClaimDigest({ job,
        executorRoute: 'agent-loop', leaseOwnerInstanceId: ownerId }).slice(7)}`
      || budget.granted.toolCalls !== (proposalSelection ? 1 : 0) || budget.granted.writes !== (proposalSelection ? 1 : 0)
      || budget.granted.highRiskActions !== 0 || budget.granted.childTasks !== 0
      || Date.parse(at) >= Date.parse(correctionPolicy.deadlineAt)) reject();
    const state = store.readModelCorrectionState({ taskId: envelope.taskId, expectedRevision: revision, policy: correctionPolicy,
      ...(correctionFeedback?.kind === 'json-invalid' ? { modelOutcome: correctionFeedback.outcome } : {}) });
    if (state.version !== AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION || state.taskId !== envelope.taskId
      || state.taskRevision !== revision || state.envelopeDigest !== current.envelopeDigest
      || state.policyDigest !== agentLoopModelCorrectionPolicyDigest(correctionPolicy)
      || state.initialRevision !== correctionPolicy.initialRevision || state.reasonCodes.length !== 1
      || state.reasonCodes.some(reason => reason !== `correction-${state.status}`)) reject();
    const first = revision === correctionPolicy.initialRevision;
    if (correctionFeedback) {
      if (first || revision !== correctionPolicy.initialRevision + 2) reject();
      if (correctionFeedback.kind === 'summary') {
        const history = store.readModelSummaryValidationRejection({ taskId: envelope.taskId,
          attemptId: correctionPolicy.attemptId, modelRevision: correctionPolicy.initialRevision,
          modelOutcome: correctionFeedback.outcome });
        if (history.status !== 'recorded' || !history.rejection || history.rejection.version !== correctionFeedback.rejection.version
          || history.rejection.code !== correctionFeedback.rejection.code) reject();
      }
    }
    if (first ? state.correctionsUsed !== 0 || state.readyRevision !== null || state.closedInvocationId !== null
        || [budget.spent, budget.reserved].some(vector => Object.values(vector).some(amount => amount !== 0))
      : revision !== correctionPolicy.initialRevision + 2 || state.correctionsUsed !== 1 || state.readyRevision !== revision
        || budget.spent.modelCalls !== 1 || budget.spent.inputTokens <= 0 || budget.spent.outputTokens <= 0
        || ['toolCalls', 'writes', 'highRiskActions', 'childTasks'].some(key => budget.spent[key as keyof typeof budget.spent] !== 0)
        || Object.values(budget.reserved).some(amount => amount !== 0)) reject();
    const invocationId = agentLoopModelInvocationId({ taskId: envelope.taskId,
      attemptId: current.envelope.currentAttemptId, expectedTaskRevision: revision });
    const events = store.readEvents(envelope.taskId);
    // A blocked state after our canonical reserve is expected; a blocked state
    // caused by any prior Action or quarantined observation is never a slot.
    if (events.some(event => event.kind.startsWith('action-') || event.eventId.startsWith('action-'))
      || store.readQuarantine().some(row => row.task_id === envelope.taskId)) reject();
    const reservation = events.find(event => event.eventId === `model-invocation:${invocationId}`);
    if (reservation) {
      if (reservation.taskId !== envelope.taskId || reservation.revision !== revision || reservation.kind !== 'model-invocation-reserved'
        || reservation.reasonCode !== undefined || reservation.eventDigest !== agentLoopProjectionEventDigest({
          eventId: reservation.eventId, taskId: envelope.taskId, revision, kind: 'model-invocation-reserved',
          reasonCode: null, envelopeDigest: current.envelopeDigest })
        || state.status !== 'blocked' || state.invocationAllowed) reject();
    } else if (options.requireReservation !== false || !state.invocationAllowed || state.status !== (first ? 'initial' : 'ready')) reject();
    if (proposalSelection) assertAgentLoopCorrectionProposalModelCapability(proposalSelection.capability, { store, ownerId, record: current, policy: correctionPolicy });
  } else if (options.requireReservation !== false) {
    const invocationId = agentLoopModelInvocationId({ taskId: envelope.taskId,
      attemptId: current.envelope.currentAttemptId, expectedTaskRevision: revision });
    if (!store.readEvents(envelope.taskId).some((event) => event.taskId === envelope.taskId && event.revision === revision
      && event.kind === 'model-invocation-reserved' && event.eventId === `model-invocation:${invocationId}`)) reject();
  }
  return current;
}

export function createAgentLoopMaintenanceModel(options: AgentLoopMaintenanceModelOptions): Readonly<{
  decide: AgentLoopCoordinatorPorts['decide'];
}> {
  if (!options || typeof options !== 'object' || nodeTypes.isProxy(options)) reject();
  assertInertPrototypeChain(options);
  const selectionProperty = options && typeof options === 'object'
    ? Object.getOwnPropertyDescriptor(options, 'rollingSummaryApplyCapability') : undefined;
  // An inherited/accessor declaration is an invalid explicit selection, never
  // a way to fall back to the old unselected mapping. Do not evaluate a getter.
  const selectedApply = !!options && typeof options === 'object' && 'rollingSummaryApplyCapability' in options;
  const applyCapability: unknown = selectionProperty && Object.hasOwn(selectionProperty, 'value') ? selectionProperty.value : undefined;
  let correctionPolicy: AgentLoopModelCorrectionPolicy | undefined;
  let proposalSelection: ReturnType<typeof correctionProposalOf>;
  let correctionFeedback: ReturnType<typeof correctionFeedbackOf>;
  try {
    correctionPolicy = correctionPolicyOf(options);
    proposalSelection = correctionProposalOf(options);
    correctionFeedback = correctionFeedbackOf(options);
    if (correctionPolicy && selectedApply || proposalSelection && (!correctionPolicy || selectedApply)
      || correctionFeedback && (!proposalSelection || !correctionPolicy || selectedApply)) reject();
  } catch { if (selectedApply) revokeAgentLoopRollingSummaryApplyCapability(applyCapability); return reject(); }
  if (!options || typeof options.ownerId !== 'string' || !TOKEN.test(options.ownerId)
    || typeof options.harnessRunId !== 'string' || !TOKEN.test(options.harnessRunId)
    || typeof options.clock !== 'function' || typeof options.readCurrent !== 'function'
    || !options.store || !options.signal || !options.handle) {
    if (selectedApply) revokeAgentLoopRollingSummaryApplyCapability(applyCapability);
    reject();
  }
  const { store, ownerId, clock, signal, handle, harnessRunId, readCurrent } = options;
  // Claim before taking ownership of cleanup. A rejected claim may belong to a
  // running legacy consumer and must never close that consumer's lease.
  const consumer = (() => {
    try { return handle.claimAgentLoopConsumer(); }
    catch (error) { if (selectedApply) revokeAgentLoopRollingSummaryApplyCapability(applyCapability); throw error; }
  })();
  try {
  const at = now(clock);
  assertExecution(options.execution, at, ownerId);
  const fixed = sourceIdentity(options.fixedSource);
  const assertApplySelection = (record: AgentLoopTaskRecord) => {
    if (!selectedApply) return;
    if (!selectionProperty || !Object.hasOwn(selectionProperty, 'value') || fixed.job.mode !== 'apply') reject();
    assertAgentLoopRollingSummaryApplyModelCapability(applyCapability, { store, ownerId, record });
  };
  if (hash(fixed.job) !== hash(jobHeader(options.execution.job)) || fixed.profile.budgetProfile.maxModelCalls !== 1
    || handle.taskKind !== 'rolling_summary' || handle.model.name !== fixed.profile.modelId
    || harnessRunId !== options.execution.job.runId) reject();
  const initialRecord = store.read(`agentloop.maintenance.${options.execution.job.runId}`);
  if (!initialRecord) reject();
  assertApplySelection(initialRecord);
  if (proposalSelection) assertAgentLoopCorrectionProposalModelCapability(proposalSelection.capability,
    { store, ownerId, record: initialRecord, policy: correctionPolicy! });
  assertAgentLoopMaintenancePreparedBinding({ record: initialRecord,
    execution: options.execution, source: options.fixedSource });
  // Pin only validated data. A later mutation of a caller-owned object cannot move this binding.
  const pinned = structuredClone(fixed);
  const expected = hash(pinned), expectedExecution = hash(executionHeader(options.execution));
  const sessionIdentity = options.fixedSource.sessionIdentity;
  const job = pinned.job, snapshot = pinned.snapshot;
  if (correctionPolicy) {
    // A direct bridge caller cannot bypass the host wrapper's lifetime ceiling.
    const grant = initialRecord.envelope.budget.granted, ceiling = pinned.profile.budgetProfile;
    if (grant.inputTokens > ceiling.agentInputBudgetTokens || grant.outputTokens > ceiling.agentOutputBudgetTokens
      || grant.costMicrousd > ceiling.maxCostMicrousd || grant.wallMs > ceiling.maxWallMs) reject();
  }
  const callBudgetProfile = assertAgentBudgetWithinHostCeiling(pinned.profile.budgetProfile,
    options.callBudgetProfile ?? pinned.profile.budgetProfile);
  if (callBudgetProfile.maxModelCalls !== 1) reject();
  const profile = { ...pinned.profile, budgetProfile: callBudgetProfile };
  const surface = resolveMaintenanceModelToolSurface('rolling_summary', snapshot.proposalContext);
  const binding = consumer.binding;
  const scoped = binding.agentLoopInvocationId !== undefined;
  if ((selectedApply || correctionPolicy) && !scoped) reject();
  if (scoped && (binding.agentLoopTaskId !== initialRecord.envelope.taskId
    || binding.agentLoopAttemptId !== initialRecord.envelope.currentAttemptId
    || binding.agentLoopExpectedTaskRevision !== initialRecord.revision || binding.agentLoopOwnerId !== ownerId
    || binding.agentLoopEnvelopeDigest !== initialRecord.envelopeDigest
    || binding.agentLoopInvocationId !== agentLoopModelInvocationId({ taskId: initialRecord.envelope.taskId,
      attemptId: initialRecord.envelope.currentAttemptId!, expectedTaskRevision: initialRecord.revision })
    || !Number.isSafeInteger(binding.agentLoopDeadlineMs)
    || !timestamp(options.execution.job.startedAt)
    || binding.agentLoopDeadlineMs! <= Date.parse(at)
    || binding.agentLoopDeadlineMs! > Date.parse(options.execution.job.startedAt ?? '') + pinned.profile.budgetProfile.maxWallMs)) reject();
  // The invocation may have a narrower remaining-wall deadline, never a later
  // lifetime deadline. Every fresh/return guard still checks the pinned policy.
  if (correctionPolicy && binding.agentLoopDeadlineMs! > Date.parse(correctionPolicy.deadlineAt)) reject();
  if (binding.runId !== job.runId || binding.parentRunId !== (job.parentRunId ?? job.runId)
    || binding.sessionId !== job.sessionId || binding.sourceRevision !== job.sourceRevision
    || binding.lane !== 'maintenance' || binding.taskKind !== 'rolling_summary'
    || binding.policyVersion !== job.policyVersion || binding.modelId !== profile.modelId
    || binding.contentMode !== profile.contentMode
    || binding.budgetProfileDigest !== agentBudgetProfileDigest(profile.budgetProfile)
    || binding.toolSetDigest !== surface.toolSetDigest || binding.leaseIdDigest !== ticketHash(handle.ticketId)
    || binding.jobAttempt !== job.attempt || binding.jobMode !== job.mode || binding.jobTrigger !== job.trigger
    || binding.jobCreatedAt !== job.createdAt) reject();
  const system = maintenanceSystemPrompt('rolling_summary');
  const messages: Array<Parameters<typeof maintenanceHarnessRequest>[1]['messages'][number]> = [{ role: 'user', content: snapshot.userMessage }];
  if (correctionPolicy) {
    assertAgentLoopMaintenanceModelRecord({ store, ownerId, clock, job: options.execution.job,
      budgetProfile: profile.budgetProfile, envelope: initialRecord.envelope, revision: initialRecord.revision, modelCorrectionPolicy: correctionPolicy,
      ...(proposalSelection ? { correctionProposalCapability: proposalSelection.capability as AgentLoopCorrectionProposalCapability } : {}),
      ...(correctionFeedback ? { correctionRejectedModelOutcome: correctionFeedback.outcome } : {}) });
    if (initialRecord.revision === correctionPolicy.initialRevision + 2) {
      const invocationId = agentLoopModelInvocationId({ taskId: initialRecord.envelope.taskId,
        attemptId: correctionPolicy.attemptId, expectedTaskRevision: correctionPolicy.initialRevision });
      const refusal = store.readEvents(initialRecord.envelope.taskId).find(event => event.eventId === `model-rejection:${invocationId}`);
      if (!refusal || refusal.kind !== 'model-protocol-rejected' || refusal.taskId !== initialRecord.envelope.taskId
        || refusal.revision !== correctionPolicy.initialRevision + 1 || !isAgentLoopModelProtocolRejectionReason(refusal.reasonCode)) reject();
      if (correctionFeedback?.kind === 'json-invalid') messages.push({ role: 'user', content: '协议错误：仅可返回合法 tool 或 final JSON。' });
      else if (correctionFeedback?.kind === 'summary') messages.push({ role: 'tool', toolCallId: 'propose_rolling_summary',
        content: `UNTRUSTED_TOOL_RESULT\n${correctionFeedback.rejection.code}` });
      else messages.push({ role: 'user', content: `协议纠正（agent-loop-maintenance-correction-feedback-v1）：上一次模型输出因 ${refusal.reasonCode} 被拒绝。仅可返回一个已注册工具的 native tool call 或严格 JSON tool envelope；不得返回正文、Markdown、解释或 final，不得改变当前 sessionId/sourceRevision 或证据引用。` });
    }
  }
  const modelInput = { system, messages,
    maxOutputTokens: profile.budgetProfile.agentOutputBudgetTokens, signal };
  const baseRequest = maintenanceHarnessRequest(profile.modelId, modelInput, [...surface.tools]);
  const estimatedInput = estimateAdmittedRequestInputTokens(baseRequest);
  if (estimatedInput > profile.budgetProfile.agentInputBudgetTokens) reject();
  const registry = new MaintenanceToolRegistry({
    capabilities: new Set(['memory.read', 'worldbook.read', 'variables.read', 'maintenance.propose']),
    maxResultChars: profile.budgetProfile.maxToolResultChars, timeoutMs: 10_000, maxEvidenceReads: 1,
    proposalContext: snapshot.proposalContext,
  });
  const tools = registry.toolsFor('rolling_summary');
  let used = false;
  const recordJob = structuredClone(options.execution.job);
  const checkRecord = (envelope: AgentLoopTaskEnvelopeV1, revision: number): AgentLoopTaskRecord =>
    assertAgentLoopMaintenanceModelRecord({ store, ownerId, clock, job: recordJob,
      budgetProfile: profile.budgetProfile, envelope, revision,
      ...(correctionPolicy ? { modelCorrectionPolicy: correctionPolicy } : {}),
      ...(proposalSelection ? { correctionProposalCapability: proposalSelection.capability as AgentLoopCorrectionProposalCapability } : {}),
      ...(correctionFeedback ? { correctionRejectedModelOutcome: correctionFeedback.outcome } : {}) });
  const fresh = async (envelope: AgentLoopTaskEnvelopeV1, revision: number): Promise<void> => {
    if (signal.aborted) reject();
    if (selectedApply) assertApplySelection(checkRecord(envelope, revision));
    const current = await readCurrent(job.runId);
    if (!current || current.source.sessionIdentity !== sessionIdentity) reject();
    assertExecution(current.execution, now(clock), ownerId);
    if (hash(executionHeader(current.execution)) !== expectedExecution || hash(sourceIdentity(current.source)) !== expected) reject();
    const currentRecord = checkRecord(envelope, revision);
    if (scoped && (binding.agentLoopTaskId !== envelope.taskId || binding.agentLoopAttemptId !== envelope.currentAttemptId
      || binding.agentLoopExpectedTaskRevision !== revision || binding.agentLoopEnvelopeDigest !== currentRecord.envelopeDigest
      || binding.agentLoopDeadlineMs! <= Date.parse(now(clock)))) reject();
    if (correctionPolicy && Date.parse(now(clock)) >= Date.parse(correctionPolicy.deadlineAt)) reject();
    assertAgentLoopMaintenancePreparedBinding({ record: currentRecord,
      execution: current.execution, source: current.source });
    assertApplySelection(currentRecord);
    if (signal.aborted) reject();
  };
  assertApplySelection(initialRecord);

  return Object.freeze({
    async decide(input: Parameters<AgentLoopCoordinatorPorts['decide']>[0]) {
      if (used) { if (selectedApply) revokeAgentLoopRollingSummaryApplyCapability(applyCapability); reject(); }
      used = true;
      let selectionHandedOff = false;
      try {
      let decision: unknown = null;
      let protocolRejectionReason: AgentLoopModelProtocolRejectionReason | undefined;
      let summaryValidationRejection: AgentLoopSummaryValidationRejection | undefined;
      let outcome: AdmittedModelLeaseOutcome = 'cancelled';
      const envelope = input.envelope, revision = input.revision;
      const attemptId = envelope.currentAttemptId;
      try {
        if (!attemptId) reject();
        checkRecord(envelope, revision);
        await fresh(envelope, revision);
        outcome = 'provider_error';
        const completion = await consumer.model.complete(modelInput);
        outcome = 'completed';
        await fresh(envelope, revision);
        // Only explicit local parse/validation returns classify a protocol stop.
        // Arbitrary thrown errors (including the native adapter's earlier parse
        // failures) never acquire a reason by matching their message or code.
        const parsedOutput: { reason: AgentLoopModelProtocolRejectionReason;
          summaryValidationRejection?: AgentLoopSummaryValidationRejection } | { name: string; args: unknown } = (() => {
          if (typeof completion.content !== 'string') reject();
          if (completion.content.length > 131_072) return { reason: 'size-invalid' };
          let value: unknown;
          try { value = JSON.parse(completion.content); }
          catch (error) { if (error instanceof SyntaxError) return { reason: 'json-invalid' }; throw error; }
          const parsed = plain(value), tool = plain(parsed?.tool);
          if (!parsed || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'tool') || !tool
            || Object.keys(tool).length !== 2 || !Object.hasOwn(tool, 'name') || !Object.hasOwn(tool, 'args')
            || typeof tool.name !== 'string') return { reason: 'envelope-invalid' };
          if (!Object.hasOwn(AGENT_LOOP_MAINTENANCE_MODEL_ACTION_REFS, tool.name)
            || !surface.toolNames.includes(tool.name)) return { reason: 'tool-unsupported' };
          const registered = tools.get(tool.name);
          if (!registered) reject();
          const validated = registered.validate(tool.args);
          if (!validated.ok) {
            if (tool.name !== 'propose_rolling_summary') return { reason: 'args-invalid' };
            // Use only the registered validator's closed result; never inspect
            // error text or re-run validation of the rejected raw payload.
            const code = validated.rejectionCode;
            return { reason: 'proposal-invalid',
              ...(code === undefined || code === 'through-round-mismatch' ? {
                summaryValidationRejection: { version: AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION,
                  code: code === undefined ? 'schema-rejected' : code },
              } : {}) };
          }
          if ((selectedApply || proposalSelection) && tool.name !== 'propose_rolling_summary') return { reason: 'tool-unsupported' };
          const args = tool.name === 'propose_rolling_summary'
            ? validateMaintenanceProposal('rolling_summary', tool.args, snapshot.proposalContext).payload
            : JSON.parse(JSON.stringify(validated.value));
          return { name: tool.name, args };
        })();
        if ('reason' in parsedOutput) {
          protocolRejectionReason = parsedOutput.reason;
          summaryValidationRejection = parsedOutput.summaryValidationRejection;
        }
        else {
          const { name, args } = parsedOutput;
          if (selectedApply) assertApplySelection(checkRecord(envelope, revision));
          const actionContractRef = selectedApply ? AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT
            : AGENT_LOOP_MAINTENANCE_MODEL_ACTION_REFS[name as keyof typeof AGENT_LOOP_MAINTENANCE_MODEL_ACTION_REFS];
          decision = normalizeAgentLoopDecision({ contractVersion: 'agent-loop-decision-v1',
            decisionId: `model-decision:${hash({ taskId: envelope.taskId, attemptId, revision, tool: name, args })}`,
            taskId: envelope.taskId, attemptId, harnessRunId, kind: 'act', expectedTaskRevision: revision,
            taskContractRef: envelope.taskContractRef, actionContractRef, args });
          if (selectedApply) assertApplySelection(checkRecord(envelope, revision));
        }
      } catch {
        decision = null;
        protocolRejectionReason = undefined;
        summaryValidationRejection = undefined;
        if (signal.aborted) outcome = 'cancelled';
      } finally {
        try { consumer.finish(outcome); } catch { decision = null; protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
      }
      // Invalid task identity cannot be used to mint an Observation, even for unknown usage.
      if (!attemptId || !Number.isSafeInteger(revision) || revision < 1) reject();
      const audit = consumer.receipt();
      const invocationId = agentLoopModelInvocationId({ taskId: envelope.taskId, attemptId, expectedTaskRevision: revision });
      const bound = audit !== null && audit.runId === job.runId && audit.parentRunId === (job.parentRunId ?? job.runId)
        && audit.sessionId === job.sessionId && audit.sourceRevision === job.sourceRevision && audit.lane === 'maintenance'
        && audit.taskKind === 'rolling_summary' && audit.policyVersion === job.policyVersion && audit.modelId === profile.modelId
        && audit.budgetProfileDigest === agentBudgetProfileDigest(profile.budgetProfile) && audit.toolSetDigest === surface.toolSetDigest
        && audit.leaseIdDigest === binding.leaseIdDigest;
      // Only the original Gateway's post-settlement terminal combinations prove
      // accounting. A known zero principal is not an unknown/unattempted call,
      // but still cannot qualify a Decision under the single-pass contract.
      const accountingKnown = bound && audit.status === 'closed' && audit.modelCallsUsed === 1 && audit.authorizationCallsUsed === 1
        && audit.providerErrorAttemptsUsed === 0
        && (audit.outcome === 'completed' && audit.reasonCode === undefined
          || audit.outcome === 'budget_exhausted' && (audit.reasonCode === 'gateway-input-budget-exhausted'
            || audit.reasonCode === 'gateway-output-budget-exhausted' || audit.reasonCode === 'gateway-cost-budget-exhausted')
          || audit.outcome === 'expired' && audit.reasonCode === 'gateway-wall-budget-exhausted'
          || audit.outcome === 'cancelled' && audit.reasonCode === 'gateway-provider-call-cancelled')
        && typeof audit.lastRequestDigest === 'string' && HASH.test(audit.lastRequestDigest)
        && [audit.inputTokensUsed, audit.outputTokensUsed, audit.costMicrousdUsed, audit.wallMsUsed]
          .every((value) => Number.isSafeInteger(value) && value >= 0);
      const decisionEligible = accountingKnown && audit.inputTokensUsed > 0 && audit.outputTokensUsed > 0;
      if (protocolRejectionReason !== undefined) {
        // Only the actual scoped host carries the original invocation deadline.
        // Legacy-compatible unscoped components retain ordinary known failure.
        if (!scoped || !decisionEligible || audit.outcome !== 'completed' || audit.reasonCode !== undefined) {
          protocolRejectionReason = undefined; summaryValidationRejection = undefined;
        }
        else {
          // Only rejected protocol output takes this extra source/lease/Session
          // readback, after finish callbacks. Failure preserves actual accounting
          // but removes the stop classification, never authorizing another MODEL.
          try { await fresh(envelope, revision); }
          catch { protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
        }
      }
      const at = now(clock), observedAt = audit && timestamp(audit.finishedAt) ? audit.finishedAt : at;
      // Parsing/validation is synchronous but still consumes time after the last source readback.
      // Preserve a known receipt on expiry; never publish a late Decision or lose actual usage.
      if (scoped && Date.parse(at) >= binding.agentLoopDeadlineMs!) { decision = null; protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
      if (correctionPolicy && Date.parse(at) >= Date.parse(correctionPolicy.deadlineAt)) { decision = null; protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
      if (signal.aborted) { protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
      const payload = audit ? { leaseIdDigest: audit.leaseIdDigest, requestDigest: audit.lastRequestDigest ?? null,
        modelCalls: audit.modelCallsUsed, authorizationCalls: audit.authorizationCallsUsed,
        inputTokens: audit.inputTokensUsed, outputTokens: audit.outputTokensUsed, costMicrousd: audit.costMicrousdUsed,
        wallMs: audit.wallMsUsed, outcome: audit.outcome ?? null, reasonCode: audit.reasonCode ?? null }
        : { invocationId, outcome: 'unknown' };
      if (selectedApply && decision !== null) {
        try { assertApplySelection(checkRecord(envelope, revision)); }
        catch { decision = null; }
      }
      if (proposalSelection) {
        try { checkRecord(envelope, revision); }
        catch { decision = null; protocolRejectionReason = undefined; summaryValidationRejection = undefined; }
      }
      const result = createAgentLoopModelOutcome({ decision: decisionEligible ? decision : null,
        ...(protocolRejectionReason === undefined ? {} : { protocolRejectionReason }),
        ...(protocolRejectionReason !== 'proposal-invalid' || summaryValidationRejection === undefined
          ? {} : { summaryValidationRejection }), observation: {
        contractVersion: 'agent-loop-observation-v1', observationId: `model-usage:${invocationId}`,
        taskId: envelope.taskId, attemptId, observedForTaskRevision: revision, sourceKind: 'provider',
        sourceRef: audit ? `gateway-lease:${audit.leaseIdDigest}` : `model-invocation:${invocationId}`,
        correlationRef: `model-invocation:${invocationId}`, observedAt,
        ingestedAt: new Date(Math.max(Date.parse(at), Date.parse(observedAt))).toISOString(),
        payloadDigest: hash(payload), completeness: accountingKnown ? 'complete' : 'unknown',
        evidenceRefs: audit?.lastRequestDigest ? [audit.leaseIdDigest, audit.lastRequestDigest] : [],
        ...(accountingKnown ? { usageDelta: { modelCalls: 1, toolCalls: 0, writes: 0,
          inputTokens: audit.inputTokensUsed, outputTokens: audit.outputTokensUsed,
          costMicrousd: audit.costMicrousdUsed, wallMs: audit.wallMsUsed, highRiskActions: 0 } } : {}),
      } });
      selectionHandedOff = selectedApply && decisionEligible && decision !== null;
      return result;
      } finally {
        if (selectedApply && !selectionHandedOff) revokeAgentLoopRollingSummaryApplyCapability(applyCapability);
      }
    },
  });
  } catch {
    if (selectedApply) revokeAgentLoopRollingSummaryApplyCapability(applyCapability);
    try { consumer.finish('cancelled'); } catch { /* Reject without exposing source or audit sink errors. */ }
    return reject();
  }
}
