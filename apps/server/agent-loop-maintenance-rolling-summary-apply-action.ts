/** One genuine Prepare-authorized apply ACT through the ORIGINAL Gateway and
 * Session Summary committer. No second Model/Action, Manager publication,
 * completion, recovery dispatch or production admission. */
import { normalizeAgentLoopDecision, AGENT_LOOP_TASK_BUDGET_KEYS } from '@jiuguan/agent-loop-contract';
import { AgentLoopActionGateway, agentLoopActionDigest, type AgentLoopActionRequest } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT as APPLY, normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { createAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { createAgentLoopRollingSummaryApplyArtifact } from './agent-loop-rolling-summary-apply-artifacts.ts';
import { agentLoopActionId, agentLoopDecisionDigest, type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { createAgentLoopRollingSummaryApplyPersistence } from './agent-loop-rolling-summary-apply-persistence.ts';
import { consumeAgentLoopRollingSummaryApplyCapability, revokeAgentLoopRollingSummaryApplyCapability,
  type AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';
import { assertAgentLoopMaintenancePreparedBinding, type AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import type { MaintenanceExecutionRecord, MaintenanceJobManager } from './maintenance-job-manager.ts';
import type { MaintenanceModelHostEnvironment } from './maintenance-model-host-guard.ts';
import { MaintenanceToolRegistry } from './maintenance-tool-registry.ts';
import { maintenanceExecutionPolicy } from './maintenance-execution-policy.ts';
import { isRollingSummaryApplyContext, validateMaintenanceProposal } from './maintenance-types.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import { parseSummaryWriteReadback, summaryWriteDigest } from './maintenance-summary-write-receipt.ts';
import { createAgentLoopSummaryWriteOrigin, agentLoopSummaryWriteDigest } from './agent-loop-summary-write-origin.ts';

export interface AgentLoopMaintenanceRollingSummaryApplyActionOptions {
  readonly store: AgentLoopProjectionStore;
  readonly manager: MaintenanceJobManager;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  readonly execution: MaintenanceExecutionRecord;
  readonly fixedSource: AgentLoopMaintenanceExecutionPrepareSource;
  /** Fresh complete source/profile/control readback, before any domain write. */
  readonly readCurrent: () => Readonly<{ execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceExecutionPrepareSource }> | null;
  /** Same claim/Session/profile/content/control/business grant, but reports the
   * ACTUAL new source token. Never a skip-source execution permission. */
  readonly readLive: () => MaintenanceModelHostEnvironment | null;
  readonly committer: MemorySummaryMaintenanceCommitter;
  readonly capability: AgentLoopRollingSummaryApplyCapability;
}
const REJECTED = 'agent-loop-maintenance-rolling-summary-apply-action-rejected';
const ZERO = Object.freeze({ modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0,
  outputTokens: 0, costMicrousd: 0, wallMs: 0, highRiskActions: 0 });
function reject(): never { throw new Error(REJECTED); }
function synchronous(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    try { void Promise.prototype.then.call(value, () => undefined, () => undefined); }
    catch { return; } // Never read/assimilate a foreign then getter.
    reject();
  }
}
function sourceIdentity(source: AgentLoopMaintenanceExecutionPrepareSource) {
  normalizeAgentLoopActionObject(source, ['job', 'profile', 'snapshot', 'sessionIdentity']);
  agentLoopSummaryWriteDigest({ job: source.job, profile: source.profile, snapshot: source.snapshot });
  return { profile: resolveAgentLoopMaintenanceProfile(source), snapshot: validateAgentLoopMaintenanceSnapshot(source) };
}
function liveProfile(value: MaintenanceModelHostEnvironment) {
  return { providerId: value.providerId, modelId: value.modelId, runtimeProfile: value.runtimeProfile,
    budgetProfile: value.budgetProfile, policyVersion: value.execution.job.policyVersion, contentMode: value.contentMode };
}

export function createAgentLoopMaintenanceRollingSummaryApplyAction(
  options: AgentLoopMaintenanceRollingSummaryApplyActionOptions,
): Readonly<{ act: AgentLoopCoordinatorPorts['act'] }> {
  const receivedCapability: unknown = options && typeof options === 'object'
    ? Object.getOwnPropertyDescriptor(options, 'capability')?.value : undefined;
  try {
    const { store, manager, ownerId, clock, signal, readCurrent, readLive, committer, capability } = options;
    if (!store || !manager || !signal || signal.aborted || typeof readCurrent !== 'function'
      || typeof readLive !== 'function' || !(committer instanceof MemorySummaryMaintenanceCommitter)) reject();
    let lastNow = '';
    const at = () => {
      const value = clock();
      if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value))
        || new Date(value).toISOString() !== value || value < lastNow) reject();
      lastNow = value; return value;
    };
    const goal = resolveAgentLoopRollingSummaryGoal({ execution: options.execution, now: at() });
    const initial = structuredClone(sourceIdentity(options.fixedSource)), fixedSourceDigest = agentLoopSummaryWriteDigest(initial);
    const sessionIdentity = options.fixedSource.sessionIdentity, registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
    if (goal.mode !== 'apply' || goal.binding.ownerId !== ownerId || !sessionIdentity || typeof sessionIdentity !== 'object'
      || agentLoopSummaryWriteDigest(options.fixedSource.job) !== agentLoopSummaryWriteDigest(options.execution.job)
      || !isRollingSummaryApplyContext(initial.snapshot.proposalContext)
      || initial.profile.budgetProfile.maxModelCalls !== 1 || initial.profile.budgetProfile.maxToolCalls < 1
      || initial.profile.budgetProfile.maxWrites < 1) reject();
    const first = store.read(goal.taskId); if (!first) reject();
    const revision = first.revision, envelopeDigest = first.envelopeDigest;
    const deadlineMs = Date.parse(goal.binding.startedAt) + initial.profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(deadlineMs)) reject();
    const readRecord = (): AgentLoopTaskRecord => {
      const current = store.read(goal.taskId), now = at();
      if (signal.aborted || Date.parse(now) >= deadlineMs || !current || current.fenced || current.ownerId !== ownerId
        || current.revision !== revision || current.envelopeDigest !== envelopeDigest || !current.leaseExpiresAt || current.leaseExpiresAt <= now
        || current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'ACT' || current.envelope.currentAttemptId !== goal.attemptId
        || current.envelope.taskKind !== registration.taskKind || current.envelope.taskContractRef !== registration.contractRef
        || current.envelope.verifier.verifierSetRef !== registration.verifierSetRef
        || current.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
        || current.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
        || current.envelope.budget.granted.modelCalls !== 1 || current.envelope.budget.granted.toolCalls !== 1 || current.envelope.budget.granted.writes !== 1
        || current.envelope.budget.spent.modelCalls !== 1 || current.envelope.budget.spent.toolCalls !== 0 || current.envelope.budget.spent.writes !== 0
        || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => current.envelope.budget.reserved[key] !== 0
          || current.envelope.budget.spent[key] > current.envelope.budget.granted[key])
        || summaryWriteDigest(current.envelope.goal.sourceRefs) !== summaryWriteDigest([
          `maintenancejob.${goal.binding.runId}`, `revision.${goal.binding.sourceRevision}`])) reject();
      return current;
    };
    const live = (): MaintenanceModelHostEnvironment => {
      readRecord();
      const value = readLive(); synchronous(value);
      if (!value || value.sessionIdentity !== sessionIdentity || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceRevision)) reject();
      const profile = resolveAgentLoopMaintenanceProfile({ ...options.fixedSource, job: value.execution.job, profile: liveProfile(value) });
      if (agentLoopSummaryWriteDigest(profile) !== agentLoopSummaryWriteDigest(initial.profile)) reject();
      const actual = manager.readExecution(goal.binding.runId), now = at();
      if (!actual || resolveAgentLoopRollingSummaryGoal({ execution: actual, now }).claimDigest !== goal.claimDigest
        || resolveAgentLoopRollingSummaryGoal({ execution: value.execution, now }).claimDigest !== goal.claimDigest
        || !manager.settings(goal.binding.sessionId).effectiveEnabled) reject();
      readRecord(); return value;
    };
    const fresh = () => {
      const current = readCurrent(); synchronous(current);
      if (!current || current.source.sessionIdentity !== sessionIdentity
        || resolveAgentLoopRollingSummaryGoal({ execution: current.execution, now: at() }).claimDigest !== goal.claimDigest
        || agentLoopSummaryWriteDigest(current.source.job) !== agentLoopSummaryWriteDigest(current.execution.job)
        || agentLoopSummaryWriteDigest(sourceIdentity(current.source)) !== fixedSourceDigest) reject();
      const actual = live(); if (actual.sourceRevision !== goal.binding.sourceRevision) reject();
      assertAgentLoopMaintenancePreparedBinding({ record: readRecord(), execution: current.execution, source: current.source });
    };
    fresh(); let used = false;
    return Object.freeze({ async act(input: Parameters<AgentLoopCoordinatorPorts['act']>[0]) {
      if (used) reject(); used = true;
      try {
        const decision = normalizeAgentLoopDecision(input.decision), original = input.actionRequest;
        normalizeAgentLoopActionObject(original, ['contractVersion', 'actionId', 'taskId', 'attemptId', 'harnessRunId',
          'decisionId', 'expectedTaskRevision', 'decisionDigest', 'actionContractRef', 'args', 'requestedAt']);
        // A failed exchange burns the genuine Prepare capability as well as this host object.
        if (!consumeAgentLoopRollingSummaryApplyCapability(capability, { store, ownerId, record: readRecord(), decision })) reject();
        fresh();
        if (decision.kind !== 'act' || decision.actionContractRef !== APPLY || original.contractVersion !== 'agent-loop-action-request-v1'
          || decision.expectedTaskRevision + 1 !== revision || original.expectedTaskRevision !== revision
          || original.taskId !== goal.taskId || decision.taskId !== goal.taskId || original.attemptId !== goal.attemptId || decision.attemptId !== goal.attemptId
          || original.harnessRunId !== goal.binding.runId || decision.harnessRunId !== goal.binding.runId
          || original.actionContractRef !== APPLY || decision.taskContractRef !== registration.contractRef
          || original.decisionId !== decision.decisionId || original.decisionDigest !== agentLoopDecisionDigest(decision)
          || agentLoopSummaryWriteDigest(original.args) !== agentLoopSummaryWriteDigest(decision.args)
          || original.requestedAt < goal.binding.startedAt || original.requestedAt > at()
          || new Date(original.requestedAt).toISOString() !== original.requestedAt
          || original.actionId !== agentLoopActionId({ taskId: goal.taskId, attemptId: goal.attemptId,
            expectedTaskRevision: revision, decisionDigest: original.decisionDigest })) reject();
        if (!store.readEvents(goal.taskId).some(event => event.eventId === `action-started:${original.actionId}`
          && event.revision === revision && event.kind === 'action-started' && event.reasonCode === 'act')) reject();
        const context = initial.snapshot.proposalContext!;
        const registry = new MaintenanceToolRegistry({ capabilities: new Set(['maintenance.propose']),
          maxResultChars: initial.profile.budgetProfile.maxToolResultChars,
          maxEvidenceReads: maintenanceExecutionPolicy('rolling_summary').maxEvidenceReads,
          timeoutMs: Math.max(1, Math.min(10_000, deadlineMs - Date.parse(at()))), proposalContext: context });
        const tool = registry.toolsFor('rolling_summary').get('propose_rolling_summary');
        if (!tool) reject(); const validated = tool.validate(decision.args); if (!validated.ok) reject();
        const canonical = normalizeAgentLoopActionObject(validated.value, ['taskKind', 'payload']);
        if (canonical.taskKind !== 'rolling_summary') reject();
        const proposal = validateMaintenanceProposal('rolling_summary', canonical.payload, context);
        if (summaryWriteDigest(proposal.payload) !== summaryWriteDigest(decision.args)) reject();
        const pending = Object.freeze({ jobRunId: goal.binding.runId, sessionId: goal.binding.sessionId,
          taskKind: 'rolling_summary' as const, sourceRevision: goal.binding.sourceRevision, proposal, context });
        const record = readRecord(), wallMs = Math.min(10_000, deadlineMs - Date.parse(at()),
          record.envelope.budget.granted.wallMs - record.envelope.budget.spent.wallMs);
        if (!Number.isSafeInteger(wallMs) || wallMs < 1) reject();
        const estimate = Object.freeze({ ...ZERO, toolCalls: 1, writes: 1, wallMs });
        const request: AgentLoopActionRequest = Object.freeze({ ...original, taskKind: registration.taskKind,
          taskContractRef: registration.contractRef, args: structuredClone(decision.args),
          authorityRevision: `authority:${agentLoopSummaryWriteDigest({ claim: goal.claimDigest, source: fixedSourceDigest }).slice(7)}` });
        const actionDigest = agentLoopActionDigest(request);
        const started = () => {
          readRecord(); const receipt = store.readActionReceipt({ taskId: goal.taskId, actionId: request.actionId });
          if (!receipt || receipt.status !== 'started' || receipt.actionContractRef !== APPLY || receipt.actionDigest !== actionDigest
            || receipt.ownerId !== ownerId || receipt.expectedRevision !== revision || receipt.attemptId !== goal.attemptId
            || agentLoopSummaryWriteDigest(receipt.estimate) !== agentLoopSummaryWriteDigest(estimate)) reject();
        };
        const persistence = createAgentLoopRollingSummaryApplyPersistence({ store, ownerId, request });
        let artifactBundle: ReturnType<typeof createAgentLoopRollingSummaryApplyArtifact> | undefined;
        const gateway = new AgentLoopActionGateway({ ...persistence, clock: at,
          contracts: { resolve: value => value.taskKind === registration.taskKind && value.taskContractRef === registration.contractRef
            ? { actionContractRefs: [APPLY] } : null },
          policy: { evaluate: () => { try { fresh(); return { decision: 'allow', reasonCodes: [], contentMode: initial.profile.contentMode }; }
            catch { return { decision: 'deny', reasonCodes: ['rolling-summary-apply-source-unavailable'] }; } } },
          approvals: { find: () => null },
          execute: async () => {
            const began = at(); fresh(); started(); const currentLive = live(), currentRecord = readRecord();
            const expiresAt = new Date(Math.min(deadlineMs, Date.parse(began) + wallMs, Date.parse(currentRecord.leaseExpiresAt!),
              Date.parse(currentLive.execution.leaseExpiresAt))).toISOString();
            const origin = createAgentLoopSummaryWriteOrigin({ version: 'agent-loop-summary-write-origin-v1',
              runId: goal.binding.runId, sessionId: goal.binding.sessionId, taskId: goal.taskId, attemptId: goal.attemptId,
              taskRevision: revision, actionId: request.actionId, actionDigest, actionContractRef: APPLY, ownerId,
              claimAttempt: goal.binding.attempt, claimDigest: goal.claimDigest, sourceRevision: goal.binding.sourceRevision,
              sourceDigest: fixedSourceDigest, proposalDigest: summaryWriteDigest(proposal), contextDigest: summaryWriteDigest(context),
              budgetDigest: agentLoopSummaryWriteDigest(currentRecord.envelope.budget), authorizedAt: began, authorizationExpiresAt: expiresAt });
            let complete = false, payloadDigest = agentLoopSummaryWriteDigest({ status: 'unknown', actionId: request.actionId });
            let evidenceRefs: readonly string[] = [];
            let artifactInput: Omit<Parameters<typeof createAgentLoopRollingSummaryApplyArtifact>[0], 'postSourceRevision'> | undefined;
            try {
              const committed = committer.commitAgentLoopSummary(pending, origin, stage => {
                started(); if (stage === 'before-write') fresh(); else live(); started();
              });
              started(); live();
              if (committed.status !== 'committed') reject();
              const evidence = committer.readAgentLoopSummaryWriteEvidence(goal.binding.runId);
              if (!evidence || evidence.state !== 'applied' || !evidence.readback
                || agentLoopSummaryWriteDigest(evidence.origin) !== agentLoopSummaryWriteDigest(origin)) reject();
              const readback = parseSummaryWriteReadback(evidence.readback), returned = parseSummaryWriteReadback(committed.receipt.readback);
              if (readback.status !== 'verified' || returned.status !== 'verified' || readback.readbackDigest !== returned.readbackDigest
                || readback.intentDigest !== evidence.intent.intentDigest || readback.proposalDigest !== origin.proposalDigest
                || readback.sourceRevision !== origin.sourceRevision || readback.runId !== origin.runId || readback.sessionId !== origin.sessionId) reject();
              started(); live();
              payloadDigest = readback.readbackDigest;
              evidenceRefs = Object.freeze([goal.claimDigest, origin.originDigest, origin.proposalDigest, origin.contextDigest,
                origin.sourceDigest, origin.budgetDigest, evidence.intent.intentDigest, evidence.intent.operationDigest, readback.readbackDigest]);
              artifactInput = { execution: options.execution, source: options.fixedSource, origin,
                intent: evidence.intent, readback, actionId: request.actionId, actionUpdatedAt: first.envelope.updatedAt };
              complete = true;
            } catch { /* Business may have COMMITted: never compensate/retry or invent verified readback. */ }
            try {
              started(); const finalLive = live();
              if (complete && artifactInput) {
                artifactBundle = createAgentLoopRollingSummaryApplyArtifact({ ...artifactInput, postSourceRevision: finalLive.sourceRevision });
                evidenceRefs = Object.freeze([...evidenceRefs, finalLive.sourceRevision, `act-updated-at:${first.envelope.updatedAt}`]);
              }
            } catch { complete = false; }
            // Include the final live/hold checks in actual execution usage. The
            // writer's origin expiry also enforces this step's wall deadline.
            const elapsed = Date.parse(at()) - Date.parse(began);
            if (!Number.isSafeInteger(elapsed) || elapsed < 0) reject();
            if (elapsed > wallMs) complete = false;
            if (!complete) artifactBundle = undefined;
            return { receiptRef: `receipt:${request.actionId}`, sourceKind: 'domain-readback',
              sourceRef: `maintenance.summary:${goal.binding.runId}`, payloadDigest: complete ? payloadDigest
                : agentLoopSummaryWriteDigest({ status: 'unknown', actionId: request.actionId }),
              completeness: complete ? 'complete' : 'unknown', evidenceRefs: complete ? evidenceRefs : [],
              usage: Object.freeze({ ...ZERO, toolCalls: 1, writes: 1, wallMs: elapsed }) };
          },
        });
        const outcome = await gateway.run(request, estimate);
        if (outcome.status !== 'executed') reject();
        if (outcome.observation.completeness === 'complete') {
          if (!artifactBundle || live().sourceRevision !== artifactBundle.descriptor.expectedRevision) reject();
        } else artifactBundle = undefined;
        // No old-source check after business COMMIT; retain actual usage/unknown
        // for the original Reducer. This is not a completion/verifier receipt.
        const result = createAgentLoopActionOutcome({ actionRequest: { ...request, contractVersion: 'agent-loop-action-request-v1' }, clock: at,
          result: { ...outcome.observation, usageDelta: outcome.usage }, ...(artifactBundle ? { artifactBundle } : {}) });
        // Outcome construction samples its Observation clock. A deadline or
        // source change at that final sample must not hand a complete bundle to
        // Core. Keep the actual durable receipt/unknown effect; never re-enter
        // the writer. There is no unchecked clock read or await after this fence.
        if (outcome.observation.completeness === 'complete'
          && (!artifactBundle || live().sourceRevision !== artifactBundle.descriptor.expectedRevision)) reject();
        return result;
      } catch { return reject(); }
      finally { revokeAgentLoopRollingSummaryApplyCapability(capability); }
    } });
  } catch { revokeAgentLoopRollingSummaryApplyCapability(receivedCapability); return reject(); }
}
