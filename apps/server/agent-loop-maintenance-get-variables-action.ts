/** One trusted, fixed-snapshot get_variables read. No model, loop, domain writer or completion.
 * The host supplies actual Manager/Session/policy readback; a shadow ref is not authority.
 * Result text exists only during this call. AL receives content-free metadata, never a payloadRef.
 */
import { createHash } from 'node:crypto';
import { normalizeAgentLoopDecision } from '@jiuguan/agent-loop-contract';
import { boundToolResult } from '../../packages/harness/public/tool-result-contract.ts';
import { AgentLoopActionGateway, type AgentLoopActionRequest, type AgentLoopUsageVector } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { createAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { agentLoopActionId, agentLoopDecisionDigest, type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { createAgentLoopGetVariablesActionPersistence } from './agent-loop-get-variables-action-persistence.ts';
import { assertAgentLoopMaintenancePreparedBinding, type AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { maintenanceExecutionPolicy } from './maintenance-execution-policy.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import { MaintenanceToolRegistry } from './maintenance-tool-registry.ts';

export interface AgentLoopMaintenanceGetVariablesActionOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly signal: AbortSignal;
  readonly execution: MaintenanceExecutionRecord;
  readonly fixedSource: AgentLoopMaintenanceExecutionPrepareSource;
  /** Synchronous trusted host fence: actual claim, loaded Session, policy/control and rebuilt snapshot. */
  readonly readCurrent: () => Readonly<{
    execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceExecutionPrepareSource;
  }> | null;
}
const REJECTED = 'agent-loop-maintenance-get-variables-action-rejected';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const ZERO = Object.freeze({ modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0,
  outputTokens: 0, costMicrousd: 0, wallMs: 0, highRiskActions: 0 });
function reject(): never { throw new Error(REJECTED); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function at(clock: () => string): string { const value = clock(); if (!timestamp(value)) reject(); return value; }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function rawDigest(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function digest(value: unknown): string { return rawDigest(canonical(value)); }
function jobHeader(job: MaintenanceExecutionRecord['job']) {
  return { runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind, sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? null, trigger: job.trigger, mode: job.mode,
    status: job.status, attempt: job.attempt, createdAt: job.createdAt, startedAt: job.startedAt ?? null };
}
function executionHeader(execution: MaintenanceExecutionRecord) {
  return { job: jobHeader(execution.job), ownerId: execution.leaseOwnerInstanceId, executorRoute: execution.executorRoute };
}
function executionCurrent(execution: MaintenanceExecutionRecord, ownerId: string, now: string): void {
  const job = execution?.job;
  if (!job || execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== ownerId
    || job.status !== 'running' || job.taskKind !== 'rolling_summary' || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || !timestamp(job.createdAt) || !timestamp(job.startedAt) || job.finishedAt !== undefined
    || execution.cancelRequestedAt !== undefined || !timestamp(execution.leaseExpiresAt)
    || Date.parse(execution.leaseExpiresAt) <= Date.parse(now)) reject();
}
function sourceIdentity(source: AgentLoopMaintenanceExecutionPrepareSource) {
  return { job: jobHeader(source.job), profile: resolveAgentLoopMaintenanceProfile(source),
    snapshot: validateAgentLoopMaintenanceSnapshot(source) };
}

export function createAgentLoopMaintenanceGetVariablesAction(options: AgentLoopMaintenanceGetVariablesActionOptions): Readonly<{
  act: AgentLoopCoordinatorPorts['act'];
}> {
  if (!options || !options.store || typeof options.ownerId !== 'string' || !TOKEN.test(options.ownerId) || typeof options.clock !== 'function'
    || typeof options.readCurrent !== 'function' || !options.signal || options.signal.aborted) reject();
  try {
  const { store, ownerId, clock, signal, readCurrent } = options;
  executionCurrent(options.execution, ownerId, at(clock));
  const initial = structuredClone(sourceIdentity(options.fixedSource));
  if (digest(initial.job) !== digest(jobHeader(options.execution.job))
    || !options.fixedSource.sessionIdentity || typeof options.fixedSource.sessionIdentity !== 'object'
    || initial.profile.budgetProfile.maxModelCalls !== 1 || initial.profile.budgetProfile.maxToolCalls < 1) reject();
  const sessionIdentity = options.fixedSource.sessionIdentity;
  const fixedSourceDigest = digest(initial), fixedExecutionDigest = digest(executionHeader(options.execution));
  const taskId = `agentloop.maintenance.${initial.job.runId}`, record = store.read(taskId);
  if (!record) reject();
  const expectedRevision = record.revision, envelopeDigest = record.envelopeDigest;
  const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  const deadlineMs = Date.parse(initial.job.startedAt ?? '') + initial.profile.budgetProfile.maxWallMs;
  if (!Number.isSafeInteger(deadlineMs)) reject();
  const readRecord = (): AgentLoopTaskRecord => {
    const current = store.read(taskId), now = at(clock);
    if (!current || current.fenced || current.ownerId !== ownerId || current.revision !== expectedRevision
      || current.envelopeDigest !== envelopeDigest || !timestamp(current.leaseExpiresAt)
      || Date.parse(current.leaseExpiresAt) <= Date.parse(now) || current.envelope.phase !== 'ACT'
      || current.envelope.state !== 'RUNNING' || !current.envelope.currentAttemptId
      || current.envelope.taskId !== taskId || current.envelope.taskKind !== registration.taskKind
      || current.envelope.taskContractRef !== registration.contractRef
      || current.envelope.verifier.verifierSetRef !== registration.verifierSetRef
      || current.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
      || current.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`
      || digest(current.envelope.goal.sourceRefs) !== digest([`maintenancejob.${initial.job.runId}`, `revision.${initial.job.sourceRevision}`])) reject();
    return current;
  };
  const fresh = (): AgentLoopTaskRecord => {
    if (signal.aborted || Date.parse(at(clock)) >= deadlineMs) reject();
    const value = readCurrent();
    if (value !== null && typeof value === 'object') {
      let asynchronous = false;
      try { void Promise.prototype.then.call(value, () => undefined, () => undefined); asynchronous = true; }
      catch { /* Never assimilate a foreign thenable or permit an asynchronous source guard. */ }
      if (asynchronous) reject();
    }
    if (!value || value.source.sessionIdentity !== sessionIdentity) reject();
    executionCurrent(value.execution, ownerId, at(clock));
    if (digest(executionHeader(value.execution)) !== fixedExecutionDigest
      || digest(sourceIdentity(value.source)) !== fixedSourceDigest
      || digest(jobHeader(value.source.job)) !== digest(jobHeader(value.execution.job))) reject();
    const current = readRecord();
    assertAgentLoopMaintenancePreparedBinding({ record: current, execution: value.execution, source: value.source });
    if (signal.aborted) reject();
    return current;
  };
  assertAgentLoopMaintenancePreparedBinding({ record: readRecord(), execution: options.execution, source: options.fixedSource });
  fresh();
  let used = false;

  return Object.freeze({
    async act(input: Parameters<AgentLoopCoordinatorPorts['act']>[0]) {
      if (used) reject();
      used = true;
      try {
        const current = fresh(), decision = normalizeAgentLoopDecision(input.decision), original = input.actionRequest;
        if (decision.kind !== 'act' || decision.actionContractRef !== AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT
          || original.contractVersion !== 'agent-loop-action-request-v1' || decision.expectedTaskRevision + 1 !== expectedRevision
          || original.expectedTaskRevision !== expectedRevision || original.taskId !== taskId || decision.taskId !== taskId
          || original.attemptId !== current.envelope.currentAttemptId || decision.attemptId !== original.attemptId
          || decision.taskContractRef !== registration.contractRef || original.actionContractRef !== decision.actionContractRef
          || original.harnessRunId !== initial.job.runId || original.harnessRunId !== decision.harnessRunId
          || original.decisionId !== decision.decisionId || original.decisionDigest !== agentLoopDecisionDigest(decision)
          || digest(original.args) !== digest(decision.args) || !timestamp(original.requestedAt)
          || Date.parse(original.requestedAt) > Date.parse(at(clock)) || Date.parse(original.requestedAt) < Date.parse(initial.job.startedAt ?? '')
          || original.actionId !== agentLoopActionId({ taskId, attemptId: original.attemptId,
            expectedTaskRevision: expectedRevision, decisionDigest: original.decisionDigest })) reject();
        if (!store.readEvents(taskId).some(event => event.eventId === `action-started:${original.actionId}`
          && event.taskId === taskId && event.revision === expectedRevision && event.kind === 'action-started' && event.reasonCode === 'act')) reject();

        const budget = current.envelope.budget;
        const remainingWall = budget.granted.wallMs - budget.reserved.wallMs - budget.spent.wallMs;
        const timeoutMs = Math.min(10_000, remainingWall, deadlineMs - Date.parse(at(clock)));
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) reject();
        const registry = new MaintenanceToolRegistry({ capabilities: new Set(['variables.read']),
          maxResultChars: initial.profile.budgetProfile.maxToolResultChars, timeoutMs,
          maxEvidenceReads: maintenanceExecutionPolicy('rolling_summary').maxEvidenceReads,
          proposalContext: initial.snapshot.proposalContext });
        const tool = registry.toolsFor('rolling_summary').get('get_variables');
        if (!tool) reject();
        const validated = tool.validate(decision.args);
        if (!validated.ok) reject();
        const request: AgentLoopActionRequest = Object.freeze({ actionId: original.actionId, taskId,
          attemptId: original.attemptId, harnessRunId: original.harnessRunId, decisionId: original.decisionId,
          expectedTaskRevision: expectedRevision, decisionDigest: original.decisionDigest,
          actionContractRef: decision.actionContractRef, taskContractRef: registration.contractRef,
          taskKind: registration.taskKind, args: structuredClone(decision.args), requestedAt: original.requestedAt,
          authorityRevision: `authority:${digest({ execution: fixedExecutionDigest, source: fixedSourceDigest }).slice(7)}` });
        const persistence = createAgentLoopGetVariablesActionPersistence({ store, ownerId, request });
        const sourceRef = `tool.get_variables:${digest({ actionId: request.actionId, source: fixedSourceDigest }).slice(7)}`;
        const evidenceRefs = Object.freeze([`snapshot:${fixedSourceDigest.slice(7)}`, initial.job.sourceRevision]);
        const gateway = new AgentLoopActionGateway({ ...persistence, clock,
          contracts: { resolve: value => value.taskKind === registration.taskKind && value.taskContractRef === registration.contractRef
            ? { actionContractRefs: [AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT] } : null },
          policy: { evaluate: value => {
            try {
              fresh();
              if (value.request.actionId !== request.actionId || value.request.authorityRevision !== request.authorityRevision) reject();
              return { decision: 'allow', reasonCodes: [], contentMode: initial.profile.contentMode };
            } catch { return { decision: 'deny', reasonCodes: ['get-variables-source-unavailable'] }; }
          } },
          approvals: { find: () => null },
          execute: async () => {
            // Registry invokes its definition before its own timeout checks. This is the
            // actual synchronous admission fence immediately before that invocation.
            fresh();
            const startedMs = Date.parse(at(clock));
            let resultText: string | undefined;
            let failureCode: string | undefined;
            try {
              const outcome = await tool.execute(validated.value, { state: structuredClone(initial.snapshot.state), signal,
                call: { runId: initial.job.runId, stepIndex: expectedRevision, toolCallId: request.actionId,
                  inputRevision: initial.job.sourceRevision } });
              if (!outcome.ok) failureCode = 'tool-result-unavailable';
              else if (registry.diagnostics().evidenceReadLimitExceeded) failureCode = 'evidence-read-limit-reached';
              else {
                const bounded = boundToolResult(outcome.result, initial.profile.budgetProfile.maxToolResultChars);
                if (bounded.metadata.state !== 'complete') failureCode = 'tool-result-partial';
                else resultText = bounded.text;
              }
            } catch { failureCode = signal.aborted ? 'tool-cancelled' : 'tool-failed'; }
            const finishedMs = Date.parse(at(clock)), wallMs = finishedMs - startedMs;
            if (!Number.isSafeInteger(wallMs) || wallMs < 0) reject();
            try { fresh(); } catch { failureCode = signal.aborted ? 'tool-cancelled' : 'source-changed'; }
            if (wallMs > timeoutMs) failureCode = 'tool-wall-budget-exceeded';
            const complete = failureCode === undefined && resultText !== undefined;
            // A true attempted read has known toolCalls even if its result is unusable.
            // No raw exception/failed body becomes a prompt, receipt ref or AL payload.
            const payloadDigest = rawDigest(failureCode === undefined && resultText !== undefined ? resultText
              : JSON.stringify({ status: 'unknown', reasonCode: failureCode ?? 'tool-result-unavailable' }));
            resultText = undefined;
            const usage: AgentLoopUsageVector = Object.freeze({ ...ZERO, toolCalls: 1, wallMs });
            return { receiptRef: `receipt:${request.actionId}`, sourceKind: 'tool', sourceRef, payloadDigest,
              completeness: complete ? 'complete' : 'unknown', evidenceRefs, usage };
          },
        });
        const outcome = await gateway.run(request, { ...ZERO, toolCalls: 1, wallMs: timeoutMs });
        // A receipt ref/replayed status alone cannot mint another result or Decision.
        if (outcome.status !== 'executed') reject();
        return createAgentLoopActionOutcome({ actionRequest: { ...request, contractVersion: 'agent-loop-action-request-v1' }, clock,
          result: { ...outcome.observation, usageDelta: outcome.usage } });
      } catch { return reject(); }
    },
  });
  } catch { return reject(); }
}
