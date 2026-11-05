/** Initial rolling-summary AL execution Prepare; no Client, Ticket, Provider or domain write. */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS, type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { normalizeAgentBudgetProfile } from '../../packages/agent-policy/public/budget-profile.ts';
import { createAgentLoopMaintenancePrepare, validateAgentLoopMaintenanceSnapshot, resolveAgentLoopMaintenanceProfile,
  type AgentLoopMaintenancePrepareSource } from './agent-loop-prepare.ts';
import { createAgentLoopPreparedExecution } from './agent-loop-prepared-execution.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import { isPristineShadowProjection } from './agent-loop-turnjob-shadow.ts';
import { agentLoopMaintenanceClaimDigest as claimDigest, agentLoopMaintenanceBindingRef as bindingRef,
  agentLoopGetVariablesAuthorizationEvidence, type AgentLoopGetVariablesAuthorization } from './agent-loop-get-variables-authorization.ts';
import { agentLoopRollingSummaryProposalAuthorizationEvidence,
  type AgentLoopRollingSummaryProposalAuthorization } from './agent-loop-rolling-summary-proposal-authorization.ts';
import { agentLoopRollingSummaryApplyAuthorizationEvidence,
  type AgentLoopRollingSummaryApplyAuthorization } from './agent-loop-rolling-summary-apply-authorization.ts';
import { createAgentLoopMaintenanceExecutionBindingDescriptor } from './agent-loop-rolling-summary-artifacts.ts';

export interface AgentLoopMaintenanceExecutionPrepareSource extends AgentLoopMaintenancePrepareSource {
  readonly sessionIdentity: object;
}
export interface AgentLoopMaintenanceExecutionPrepareOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  /** Host-only optional initial read authorization. Omitted preserves the original model1/tool0 grant. */
  readonly getVariablesAuthorization?: AgentLoopGetVariablesAuthorization;
  /** Independent shadow proposal grant; mutually exclusive with the read-only authorization. */
  readonly rollingSummaryProposalAuthorization?: AgentLoopRollingSummaryProposalAuthorization;
  /** Independent apply grant; exactly one action authorization may be selected. */
  readonly rollingSummaryApplyAuthorization?: AgentLoopRollingSummaryApplyAuthorization;
  /** Fresh actual Manager/loaded Session/profile/control readback, guarded by the shared host fence. */
  readonly readCurrent: () => Readonly<{
    execution: MaintenanceExecutionRecord; source: AgentLoopMaintenanceExecutionPrepareSource;
  }> | null;
}
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function reject(): never { throw new Error('agent-loop-maintenance-execution-prepare-rejected'); }

/** This initial-Prepare version's durable binding survives the gap before MODEL construction/dispatch.
 * Other already-authorized attempts retain the generic Model contract; this check grants nothing.
 */
export function assertAgentLoopMaintenancePreparedBinding(input: Readonly<{
  record: AgentLoopTaskRecord; execution: MaintenanceExecutionRecord; source: AgentLoopMaintenancePrepareSource;
}>): void {
  const { record, execution, source } = input;
  const bindings = record.envelope.artifacts.filter((artifact) => artifact.kind === 'agent-loop-execution-binding');
  if (!record.envelope.currentAttemptId?.startsWith('attempt.al.') && bindings.length === 0) return;
  if (record.ownerId !== execution.leaseOwnerInstanceId || execution.executorRoute !== 'agent-loop'
    || record.envelope.currentAttemptId !== `attempt.al.${claimDigest(execution).slice(7)}`
    || bindings.length !== 1 || bindings[0]!.status !== 'declared'
    || bindings[0]!.artifactRef !== bindingRef(execution, source)) reject();
}

export function createAgentLoopMaintenanceExecutionPrepare(options: AgentLoopMaintenanceExecutionPrepareOptions) {
  const { store, ownerId, clock, readCurrent } = options;
  return Object.freeze({
    async prepare(input: Readonly<{ envelope: AgentLoopTaskEnvelopeV1; revision: number }>) {
      const getVariablesAuthorization = options.getVariablesAuthorization;
      const rollingSummaryProposalAuthorization = options.rollingSummaryProposalAuthorization;
      const rollingSummaryApplyAuthorization = options.rollingSummaryApplyAuthorization;
      if ([getVariablesAuthorization, rollingSummaryProposalAuthorization, rollingSummaryApplyAuthorization]
        .filter(value => value !== undefined).length > 1) reject();
      const summaryAuthorization = rollingSummaryProposalAuthorization !== undefined || rollingSummaryApplyAuthorization !== undefined;
      const initial = store.read(input.envelope.taskId);
      if (!initial || initial.revision !== input.revision
        || JSON.stringify(initial.envelope) !== JSON.stringify(input.envelope)) reject();
      const first = readCurrent();
      if (!first || first.execution.executorRoute !== 'agent-loop') reject();
      const sessionIdentity = first.source.sessionIdentity;
      const header = (value: NonNullable<ReturnType<typeof readCurrent>>) => {
        const { execution, source } = value, job = execution.job;
        const now = Date.parse(clock());
        if (execution.executorRoute !== 'agent-loop' || job.status !== 'running' || job.taskKind !== 'rolling_summary'
          || execution.leaseOwnerInstanceId !== ownerId || !Number.isSafeInteger(job.attempt) || job.attempt < 1
          || !Number.isFinite(now) || !execution.leaseExpiresAt || Date.parse(execution.leaseExpiresAt) <= now
          || !Number.isFinite(Date.parse(execution.leaseExpiresAt)) || execution.cancelRequestedAt !== undefined
          || source.sessionIdentity !== sessionIdentity || !sessionIdentity || typeof sessionIdentity !== 'object'
          || JSON.stringify(source.job) !== JSON.stringify(job)
          || source.snapshot.revision !== job.sourceRevision) reject();
        // TTL / updatedAt may legitimately renew. Selected immutable claim fields may not.
        return claimDigest(execution);
      };
      const initialClaimDigest = header(first);
      const profile = normalizeAgentBudgetProfile(first.source.profile.budgetProfile);
      if (profile.maxModelCalls !== 1) reject();
      const deadlineAtMs = Date.parse(first.execution.job.startedAt ?? '') + profile.maxWallMs;
      if (!Number.isSafeInteger(deadlineAtMs) || !Number.isFinite(new Date(deadlineAtMs).getTime())) reject();
      const profileDigest = digest(first.source.profile);
      const fixedInputDigest = digest(validateAgentLoopMaintenanceSnapshot(first.source));
      const read = () => {
        const current = readCurrent();
        if (!current || header(current) !== initialClaimDigest || digest(current.source.profile) !== profileDigest
          || digest(validateAgentLoopMaintenanceSnapshot(current.source)) !== fixedInputDigest
          || Date.parse(clock()) >= deadlineAtMs) reject();
        return current.source;
      };
      const preview = createAgentLoopMaintenancePrepare({ store, ownerId, clock, readSource: (runId) => {
        const source = read();
        if (source.job.runId !== runId) reject();
        return source;
      } });
      const candidate = await preview.preview({ taskId: initial.envelope.taskId, revision: input.revision });
      if (!candidate || candidate.envelopeDigest !== initial.envelopeDigest) reject();
      const actionEvidence = rollingSummaryApplyAuthorization !== undefined
        ? agentLoopRollingSummaryApplyAuthorizationEvidence(rollingSummaryApplyAuthorization, initial, ownerId)
        : rollingSummaryProposalAuthorization !== undefined
        ? agentLoopRollingSummaryProposalAuthorizationEvidence(rollingSummaryProposalAuthorization, initial, ownerId)
        : getVariablesAuthorization === undefined ? undefined
          : agentLoopGetVariablesAuthorizationEvidence(getVariablesAuthorization, initial, ownerId);
      const zero = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => [key, 0])) as unknown as AgentLoopTaskEnvelopeV1['budget']['granted'];
      const granted = { ...zero, modelCalls: 1, inputTokens: profile.agentInputBudgetTokens,
        outputTokens: profile.agentOutputBudgetTokens, costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs,
        ...(actionEvidence ? { toolCalls: 1 } : {}),
        ...(summaryAuthorization ? { writes: 1 } : {}) };
      return createAgentLoopPreparedExecution({ record: initial, ownerId,
        attemptId: `attempt.al.${initialClaimDigest.slice(7)}`,
        budget: { policyRef: initial.envelope.budget.policyRef, granted, reserved: zero, spent: zero },
        artifact: { artifactRef: bindingRef(first.execution, first.source),
          kind: 'agent-loop-execution-binding', status: 'declared',
          evidenceRefs: [initialClaimDigest, candidate.requestDigest, candidate.profileDigest, candidate.sourceDigest,
            candidate.fixedInputDigest, candidate.toolSetDigest, ...(actionEvidence ? [actionEvidence] : [])] },
        ...(getVariablesAuthorization ? { getVariablesAuthorization } : {}),
        ...(rollingSummaryProposalAuthorization ? { rollingSummaryProposalAuthorization } : {}),
        ...(rollingSummaryApplyAuthorization ? { rollingSummaryApplyAuthorization } : {}),
        ...(summaryAuthorization ? { artifactRefs: Object.freeze([
          createAgentLoopMaintenanceExecutionBindingDescriptor(first.execution, first.source),
        ]) } : {}),
        authorizeCommit: () => {
          read();
          const current = store.read(initial.envelope.taskId);
          if (!current || !isPristineShadowProjection(store, current)) reject();
          return true;
        },
      });
    },
  });
}
