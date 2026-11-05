/** One shadow proposal ACT through the original Registry/Gateway/Manager.
 * Canonical bodies stay only in the original Manager's private prepared row.
 * No Summary write, approval publication, Verify, completion, retry or scheduler.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeAgentLoopDecision } from '@jiuguan/agent-loop-contract';
import { AgentLoopActionGateway, type AgentLoopActionRequest, type AgentLoopUsageVector } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { createAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { agentLoopActionId, agentLoopDecisionDigest, type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { createAgentLoopRollingSummaryProposalPersistence } from './agent-loop-rolling-summary-proposal-persistence.ts';
import { assertAgentLoopMaintenancePreparedBinding, type AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import { agentLoopProjectionEventDigest, type AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { maintenanceExecutionPolicy } from './maintenance-execution-policy.ts';
import type { MaintenanceExecutionRecord, MaintenanceJobManager } from './maintenance-job-manager.ts';
import { MaintenanceToolRegistry } from './maintenance-tool-registry.ts';
import { normalizeMaintenanceAgentLoopShadowProposal } from './maintenance-agent-loop-shadow-proposal.ts';
import type { MaintenanceProposal } from './maintenance-types.ts';
import { createAgentLoopRollingSummaryProposalArtifact } from './agent-loop-rolling-summary-artifacts.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';

export interface AgentLoopMaintenanceRollingSummaryProposalActionOptions {
  readonly store: AgentLoopProjectionStore;
  readonly manager: MaintenanceJobManager;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  readonly execution: MaintenanceExecutionRecord;
  readonly fixedSource: AgentLoopMaintenanceExecutionPrepareSource;
  /** Actual synchronous claim / loaded Session / source / control readback. */
  readonly readCurrent: () => Readonly<{
    execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceExecutionPrepareSource;
  }> | null;
}
export interface AgentLoopMaintenanceCorrectionProposalActionOptions extends AgentLoopMaintenanceRollingSummaryProposalActionOptions {
  readonly record: AgentLoopTaskRecord;
  readonly policy: AgentLoopModelCorrectionPolicy;
  readonly modelRecord: AgentLoopTaskRecord;
  readonly modelOutcome: unknown;
  readonly decision: unknown;
  readonly rejectedModelOutcome?: unknown;
}
const REJECTED = 'agent-loop-maintenance-rolling-summary-proposal-action-rejected';
const ZERO = Object.freeze({ modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0,
  outputTokens: 0, costMicrousd: 0, wallMs: 0, highRiskActions: 0 });
function reject(): never { throw new Error(REJECTED); }
function at(clock: () => string): string {
  const value = clock();
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
  return value;
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function sourceIdentity(source: AgentLoopMaintenanceExecutionPrepareSource) {
  return { profile: resolveAgentLoopMaintenanceProfile(source), snapshot: validateAgentLoopMaintenanceSnapshot(source) };
}

export function createAgentLoopMaintenanceRollingSummaryProposalActionMechanism(
  options: AgentLoopMaintenanceRollingSummaryProposalActionOptions | AgentLoopMaintenanceCorrectionProposalActionOptions,
  kind: 'single-pass' | 'correction-proposal',
): Readonly<{ act: AgentLoopCoordinatorPorts['act'] }> {
  try {
    if (kind !== 'single-pass' && kind !== 'correction-proposal') reject();
    const corrected = kind === 'correction-proposal';
    const extra = options as AgentLoopMaintenanceCorrectionProposalActionOptions;
    if (corrected) {
      if (!options || typeof options !== 'object' || nodeTypes.isProxy(options)) reject();
      const required = ['store','manager','ownerId','clock','signal','execution','fixedSource','readCurrent',
        'record','policy','modelRecord','modelOutcome','decision'];
      for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !required.includes(key) && key !== 'rejectedModelOutcome') reject();
        const property = Object.getOwnPropertyDescriptor(options,key);
        if (!property?.enumerable || !Object.hasOwn(property,'value')) reject();
        if (nodeTypes.isPromise(property.value)) { void Promise.prototype.then.call(property.value,()=>undefined,()=>undefined); reject(); }
      }
      if (required.some(key => !Object.hasOwn(options,key))) reject();
      const inert = (value: unknown, seen = new Set<object>()): void => {
        if (value === null || typeof value !== 'object') { if (typeof value === 'function' || typeof value === 'symbol') reject(); return; }
        if (nodeTypes.isPromise(value)) { void Promise.prototype.then.call(value,()=>undefined,()=>undefined); reject(); }
        if (nodeTypes.isProxy(value) || seen.has(value) || !Array.isArray(value)
          && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) reject();
        seen.add(value);
        try { for (const key of Reflect.ownKeys(value)) {
          const field = Object.getOwnPropertyDescriptor(value,key);
          if (typeof key !== 'string' || !field || !Object.hasOwn(field,'value')) reject();
          inert(field.value,seen);
        } } finally { seen.delete(value); }
      };
      for (const value of [extra.record,extra.policy,extra.modelRecord,extra.decision]) inert(value);
    }
    const { store, manager, ownerId, clock, signal, readCurrent } = options;
    if (!store || !manager || typeof readCurrent !== 'function' || !signal || signal.aborted) reject();
    const goal = resolveAgentLoopRollingSummaryGoal({ execution: options.execution, now: at(clock) });
    if (goal.mode !== 'shadow' || goal.binding.ownerId !== ownerId || !options.fixedSource.sessionIdentity
      || typeof options.fixedSource.sessionIdentity !== 'object') reject();
    const initial = structuredClone(sourceIdentity(options.fixedSource)), fixedSourceDigest = digest(initial);
    if (digest(options.fixedSource.job) !== digest(options.execution.job)
      || initial.profile.budgetProfile.maxModelCalls !== 1 || initial.profile.budgetProfile.maxToolCalls < 1
      || initial.profile.budgetProfile.maxWrites < 1) reject();
    const sessionIdentity = options.fixedSource.sessionIdentity, taskId = goal.taskId;
    const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary, record = store.read(taskId);
    if (!record) reject();
    const expectedRevision = record.revision, envelopeDigest = record.envelopeDigest;
    const taskContractRef = corrected ? AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF : registration.contractRef;
    const readLineage = () => store.readModelCorrectionActionLineage({ taskId, expectedRevision, ownerId,
      policy: extra.policy, modelRecord: extra.modelRecord, modelOutcome: extra.modelOutcome,
      ...(Object.hasOwn(extra,'rejectedModelOutcome') ? { rejectedModelOutcome: extra.rejectedModelOutcome } : {}) });
    const lineage = corrected ? readLineage() : undefined;
    const capturedDecision = corrected ? normalizeAgentLoopDecision(extra.decision) : undefined;
    if (corrected && (!lineage || extra.record.revision !== expectedRevision || extra.record.envelopeDigest !== envelopeDigest
      || extra.record.ownerId !== ownerId || digest(extra.record.envelope) !== digest(record.envelope)
      || capturedDecision?.kind !== 'act' || agentLoopDecisionDigest(capturedDecision) !== lineage.decisionDigest
      || capturedDecision.actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
      || expectedRevision !== (lineage.modelCallsUsed === 1 ? 3 : 5))) reject();
    const capturedBudget = corrected ? digest(record.envelope.budget) : undefined;
    const capturedEvents = corrected ? store.readEvents(taskId) : undefined;
    // The strict successful slot reader is pre-ACT ONLY. Once Core appends its
    // start watermark, continuity is checked against this captured exact prefix
    // plus only this Action's original receipt events; it never broadens lineage.
    const assertActionTail = () => {
      if (!lineage || !capturedEvents) return;
      const events = store.readEvents(taskId);
      if (events.length < capturedEvents.length || digest(events.slice(0,capturedEvents.length)) !== digest(capturedEvents)) reject();
      const suffix = events.slice(capturedEvents.length), stages = ['reserved','started','completed','settled'];
      if (suffix.length > stages.length + 1) reject();
      for (const [index,event] of suffix.entries()) {
        const stage = stages[index-1];
        if (event.taskId !== taskId || event.revision !== expectedRevision
          || event.eventDigest !== agentLoopProjectionEventDigest({ ...event, reasonCode: event.reasonCode ?? null, envelopeDigest })
          || index === 0 && (event.eventId !== `action-started:${lineage.actionId}` || event.kind !== 'action-started' || event.reasonCode !== 'act')
          || index > 0 && (event.eventId !== `action-receipt:${digest(lineage.actionId).slice(7)}:${stage}`
            || event.kind !== `action-receipt-${stage}` || event.reasonCode !== undefined)) reject();
      }
    };
    const deadlineMs = Date.parse(goal.binding.startedAt) + initial.profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(deadlineMs)) reject();
    const readRecord = (): AgentLoopTaskRecord => {
      const current = store.read(taskId), now = at(clock);
      if (!current || current.fenced || current.ownerId !== ownerId || current.revision !== expectedRevision
        || current.envelopeDigest !== envelopeDigest || !current.leaseExpiresAt || current.leaseExpiresAt <= now
        || current.envelope.phase !== 'ACT' || current.envelope.state !== 'RUNNING'
        || current.envelope.currentAttemptId !== goal.attemptId || current.envelope.taskKind !== registration.taskKind
        || current.envelope.taskContractRef !== taskContractRef
        || current.envelope.verifier.verifierSetRef !== registration.verifierSetRef
        || current.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
        || current.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
        || current.envelope.budget.granted.modelCalls !== (corrected ? 2 : 1) || current.envelope.budget.granted.toolCalls !== 1
        || current.envelope.budget.granted.writes !== 1
        || digest(current.envelope.goal.sourceRefs) !== digest([
          `maintenancejob.${goal.binding.runId}`, `revision.${goal.binding.sourceRevision}`])) reject();
      if (corrected && (digest(current.envelope.budget) !== capturedBudget
        || current.envelope.budget.spent.modelCalls !== lineage!.modelCallsUsed
        || current.envelope.budget.spent.toolCalls !== 0 || current.envelope.budget.spent.writes !== 0
        || Object.values(current.envelope.budget.reserved).some(value => value !== 0))) reject();
      assertActionTail();
      return current;
    };
    const fresh = (): AgentLoopTaskRecord => {
      if (signal.aborted || Date.parse(at(clock)) >= deadlineMs) reject();
      const value = readCurrent();
      if (value !== null && typeof value === 'object') {
        let asynchronous = false;
        try { void Promise.prototype.then.call(value, () => undefined, () => undefined); asynchronous = true; }
        catch { /* Never assimilate a foreign thenable or use async authorization. */ }
        if (asynchronous) reject();
      }
      if (!value || value.source.sessionIdentity !== sessionIdentity) reject();
      const currentGoal = resolveAgentLoopRollingSummaryGoal({ execution: value.execution, now: at(clock) });
      const actual = manager.readExecution(goal.binding.runId);
      if (!actual || currentGoal.mode !== 'shadow' || currentGoal.claimDigest !== goal.claimDigest
        || resolveAgentLoopRollingSummaryGoal({ execution: actual, now: at(clock) }).claimDigest !== goal.claimDigest
        || digest(value.source.job) !== digest(value.execution.job)
        || digest(sourceIdentity(value.source)) !== fixedSourceDigest) reject();
      const current = readRecord();
      assertAgentLoopMaintenancePreparedBinding({ record: current, execution: value.execution, source: value.source });
      if (signal.aborted) reject();
      return current;
    };
    assertAgentLoopMaintenancePreparedBinding({ record: readRecord(), execution: options.execution, source: options.fixedSource });
    fresh();
    if (corrected && digest(readLineage()) !== digest(lineage)) reject();
    let used = false;
    return Object.freeze({ async act(input: Parameters<AgentLoopCoordinatorPorts['act']>[0]) {
      if (used) reject();
      used = true;
      try {
        const current = fresh(), decision = normalizeAgentLoopDecision(input.decision), original = input.actionRequest;
        if (decision.kind !== 'act' || decision.actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
          || original.contractVersion !== 'agent-loop-action-request-v1' || decision.expectedTaskRevision + 1 !== expectedRevision
          || original.expectedTaskRevision !== expectedRevision || original.taskId !== taskId || decision.taskId !== taskId
          || original.attemptId !== current.envelope.currentAttemptId || decision.attemptId !== original.attemptId
          || decision.taskContractRef !== taskContractRef || original.actionContractRef !== decision.actionContractRef
          || corrected && (agentLoopDecisionDigest(decision) !== lineage!.decisionDigest || original.actionId !== lineage!.actionId)
          || original.harnessRunId !== goal.binding.runId || decision.harnessRunId !== goal.binding.runId
          || original.decisionId !== decision.decisionId || original.decisionDigest !== agentLoopDecisionDigest(decision)
          || digest(original.args) !== digest(decision.args)
          || typeof original.requestedAt !== 'string' || !Number.isSafeInteger(Date.parse(original.requestedAt))
          || new Date(original.requestedAt).toISOString() !== original.requestedAt
          || original.requestedAt > at(clock) || original.requestedAt < goal.binding.startedAt
          || original.actionId !== agentLoopActionId({ taskId, attemptId: original.attemptId,
            expectedTaskRevision: expectedRevision, decisionDigest: original.decisionDigest })) reject();
        if (!store.readEvents(taskId).some(event => event.eventId === `action-started:${original.actionId}`
          && event.taskId === taskId && event.revision === expectedRevision && event.kind === 'action-started' && event.reasonCode === 'act')) reject();
        const remainingWall = current.envelope.budget.granted.wallMs - current.envelope.budget.reserved.wallMs - current.envelope.budget.spent.wallMs;
        const timeoutMs = Math.min(10_000, remainingWall, deadlineMs - Date.parse(at(clock)));
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) reject();
        const registry = new MaintenanceToolRegistry({ capabilities: new Set(['maintenance.propose']),
          maxResultChars: initial.profile.budgetProfile.maxToolResultChars, timeoutMs,
          maxEvidenceReads: maintenanceExecutionPolicy('rolling_summary').maxEvidenceReads,
          proposalContext: initial.snapshot.proposalContext });
        const tool = registry.toolsFor('rolling_summary').get('propose_rolling_summary');
        if (!tool) reject();
        const validated = tool.validate(decision.args);
        if (!validated.ok) reject();
        const request: AgentLoopActionRequest = Object.freeze({ actionId: original.actionId, taskId,
          attemptId: original.attemptId, harnessRunId: original.harnessRunId, decisionId: original.decisionId,
          expectedTaskRevision: expectedRevision, decisionDigest: original.decisionDigest,
          actionContractRef: decision.actionContractRef, taskContractRef,
          taskKind: registration.taskKind, args: structuredClone(decision.args), requestedAt: original.requestedAt,
          authorityRevision: `authority:${digest({ claim: goal.claimDigest, source: fixedSourceDigest }).slice(7)}` });
        const persistence = createAgentLoopRollingSummaryProposalPersistence({ store, ownerId, request });
        const sourceRef = `maintenance.proposal:${goal.binding.runId}`;
        const gateway = new AgentLoopActionGateway({ ...persistence, clock,
          contracts: { resolve: value => value.taskKind === registration.taskKind && value.taskContractRef === taskContractRef
            ? { actionContractRefs: [AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT] } : null },
          policy: { evaluate: value => {
            try {
              fresh();
              if (value.request.actionId !== request.actionId || value.request.authorityRevision !== request.authorityRevision) reject();
              return { decision: 'allow', reasonCodes: [], contentMode: initial.profile.contentMode };
            } catch { return { decision: 'deny', reasonCodes: ['rolling-summary-proposal-source-unavailable'] }; }
          } }, approvals: { find: () => null },
          execute: async () => {
            fresh();
            const startedMs = Date.parse(at(clock));
            let payloadDigest: string | undefined, evidenceRefs: readonly string[] = [], failureCode: string | undefined;
            try {
              const state = structuredClone(initial.snapshot.state);
              const outcome = await tool.execute(validated.value, { state, signal,
                call: { runId: goal.binding.runId, stepIndex: expectedRevision, toolCallId: request.actionId,
                  inputRevision: goal.binding.sourceRevision } });
              if (!outcome.ok || outcome.result !== 'proposal-accepted' || state.proposal === undefined) reject();
              fresh();
              if (Date.parse(at(clock)) - startedMs > timeoutMs) reject();
              const canonical = normalizeMaintenanceAgentLoopShadowProposal({ proposal: state.proposal as MaintenanceProposal,
                proposalContext: initial.snapshot.proposalContext! });
              if (digest(canonical.proposal) !== digest(validated.value)) reject();
              const staged = manager.stageAgentLoopShadowProposal({ runId: goal.binding.runId, owner: ownerId,
                expectedAttempt: goal.binding.attempt, proposal: canonical.proposal, proposalContext: canonical.context }, () => { fresh(); });
              const persisted = manager.readAgentLoopShadowProposal(goal.binding.runId);
              if (!persisted || digest(persisted) !== digest(staged)) reject();
              fresh();
              payloadDigest = persisted.preparation.preparationDigest;
              evidenceRefs = Object.freeze([goal.claimDigest, persisted.proposalDigest,
                persisted.preparation.proposalContextDigest, persisted.preparation.preparationDigest, `snapshot:${fixedSourceDigest.slice(7)}`]);
            } catch { failureCode = signal.aborted ? 'proposal-cancelled' : 'proposal-result-unavailable'; }
            const wallMs = Date.parse(at(clock)) - startedMs;
            if (!Number.isSafeInteger(wallMs) || wallMs < 0) reject();
            try { fresh(); } catch { failureCode = signal.aborted ? 'proposal-cancelled' : 'source-changed'; }
            if (wallMs > timeoutMs) failureCode = 'proposal-wall-budget-exceeded';
            const complete = failureCode === undefined && payloadDigest !== undefined;
            const usage: AgentLoopUsageVector = Object.freeze({ ...ZERO, toolCalls: 1, writes: 1, wallMs });
            return { receiptRef: `receipt:${request.actionId}`, sourceKind: 'tool', sourceRef,
              payloadDigest: complete ? payloadDigest! : digest({ status: 'unknown', reasonCode: failureCode ?? 'proposal-result-unavailable' }),
              completeness: complete ? 'complete' : 'unknown', evidenceRefs: complete ? evidenceRefs : [], usage };
          },
        });
        const outcome = await gateway.run(request, { ...ZERO, toolCalls: 1, writes: 1, wallMs: timeoutMs });
        if (outcome.status !== 'executed') reject();
        let artifactBundle: ReturnType<typeof createAgentLoopRollingSummaryProposalArtifact> | undefined;
        if (outcome.observation.completeness === 'complete') {
          fresh();
          const actual = readCurrent(), proposal = manager.readAgentLoopShadowProposal(goal.binding.runId);
          if (!actual || !proposal || resolveAgentLoopRollingSummaryGoal({ execution: actual.execution, now: at(clock) }).claimDigest !== goal.claimDigest) reject();
          artifactBundle = createAgentLoopRollingSummaryProposalArtifact({ execution: actual.execution,
            source: actual.source, proposal, actionId: request.actionId });
          if (artifactBundle.descriptor.expectedDigest !== outcome.observation.payloadDigest) reject();
          fresh();
        }
        return createAgentLoopActionOutcome({ actionRequest: { ...request, contractVersion: 'agent-loop-action-request-v1' }, clock,
          result: { ...outcome.observation, usageDelta: outcome.usage }, ...(artifactBundle ? { artifactBundle } : {}) });
      } catch { return reject(); }
    } });
  } catch { return reject(); }
}
