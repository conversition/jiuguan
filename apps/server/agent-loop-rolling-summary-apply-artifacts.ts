/** Apply-owned typed-ref metadata only. No capability, reader selection, body
 * storage or completion authority is issued by this pure builder.
 */
import type { AgentLoopActionArtifactBundle } from './agent-loop-action-outcome.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { AgentLoopMaintenanceExecutionPrepareSource } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopRollingSummaryGoal } from './agent-loop-maintenance-goal.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot } from './agent-loop-prepare.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT, normalizeAgentLoopActionObject,
  normalizeAgentLoopActionDigest } from './agent-loop-action-receipt.ts';
import { parseAgentLoopSummaryWriteOrigin, agentLoopSummaryWriteDigest,
  type AgentLoopSummaryWriteOrigin } from './agent-loop-summary-write-origin.ts';
import { parseSummaryWriteIntent, parseSummaryWriteReadback, summaryWriteDigest,
  type SummaryWriteIntent, type SummaryWriteVerifiedReadback } from './maintenance-summary-write-receipt.ts';

export const AGENT_LOOP_ROLLING_SUMMARY_APPLY_ARTIFACT_VERSION = 'agent-loop-rolling-summary-apply-artifact-v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_APPLY_ARTIFACT_KIND = 'agent-loop-rolling-summary-apply' as const;
const REJECTED = 'agent-loop-rolling-summary-apply-artifact-invalid';
function reject(): never { throw new Error(REJECTED); }

/** Shared pure identity for live production and already-committed metadata
 * recovery. It neither proves native history nor registers an artifact. */
export function agentLoopRollingSummaryApplyArtifactRef(input: Readonly<{
  claimDigest: string; actionId: string; originDigest: string; intentDigest: string;
  readbackDigest: string; postSourceRevision: string; actionUpdatedAt: string;
}>): string {
  normalizeAgentLoopActionObject(input, ['claimDigest', 'actionId', 'originDigest', 'intentDigest', 'readbackDigest', 'postSourceRevision', 'actionUpdatedAt']);
  for (const key of ['claimDigest', 'actionId', 'originDigest', 'intentDigest', 'readbackDigest', 'postSourceRevision'] as const) normalizeAgentLoopActionDigest(input[key]);
  if (typeof input.actionUpdatedAt !== 'string' || !Number.isSafeInteger(Date.parse(input.actionUpdatedAt))
    || new Date(input.actionUpdatedAt).toISOString() !== input.actionUpdatedAt) reject();
  return `maintenance.summary.apply.artifact:${agentLoopSummaryWriteDigest({ version: AGENT_LOOP_ROLLING_SUMMARY_APPLY_ARTIFACT_VERSION,
    claimDigest: input.claimDigest, actionId: input.actionId, originDigest: input.originDigest, intentDigest: input.intentDigest,
    readbackDigest: input.readbackDigest, postSourceRevision: input.postSourceRevision, actionUpdatedAt: input.actionUpdatedAt }).slice(7)}`;
}

/** Recomputable from original claim/domain metadata. The actual verifier must
 * separately join the original AL receipt, native current Summary and same-CAS refs.
 */
export function createAgentLoopRollingSummaryApplyArtifact(input: Readonly<{
  execution: MaintenanceExecutionRecord;
  source: AgentLoopMaintenanceExecutionPrepareSource;
  origin: AgentLoopSummaryWriteOrigin;
  intent: SummaryWriteIntent;
  readback: SummaryWriteVerifiedReadback;
  actionId: string;
  postSourceRevision: string;
  actionUpdatedAt: string;
}>): AgentLoopActionArtifactBundle {
  try {
    normalizeAgentLoopActionObject(input, ['execution', 'source', 'origin', 'intent', 'readback', 'actionId', 'postSourceRevision', 'actionUpdatedAt']);
    normalizeAgentLoopActionObject(input.source, ['job', 'profile', 'snapshot', 'sessionIdentity']);
    // Reject accessors, toJSON hooks, foreign objects and asynchronous metadata
    // before the legacy byte-preserving Summary parsers inspect selected fields.
    agentLoopSummaryWriteDigest({ origin: input.origin, intent: input.intent, readback: input.readback,
      job: input.source.job, profile: input.source.profile, snapshot: input.source.snapshot });
    const origin = parseAgentLoopSummaryWriteOrigin(input.origin), intent = parseSummaryWriteIntent(input.intent);
    const readback = parseSummaryWriteReadback(input.readback);
    const actionId = normalizeAgentLoopActionDigest(input.actionId);
    const postSourceRevision = normalizeAgentLoopActionDigest(input.postSourceRevision);
    const actionUpdatedAt = input.actionUpdatedAt;
    if (typeof actionUpdatedAt !== 'string' || !Number.isSafeInteger(Date.parse(actionUpdatedAt))
      || new Date(actionUpdatedAt).toISOString() !== actionUpdatedAt) reject();
    const jobProperty = Object.getOwnPropertyDescriptor(input.execution, 'job');
    if (!jobProperty || !Object.hasOwn(jobProperty, 'value') || !jobProperty.value || typeof jobProperty.value !== 'object') reject();
    const updatedAtProperty = Object.getOwnPropertyDescriptor(jobProperty.value, 'updatedAt');
    if (!updatedAtProperty || !Object.hasOwn(updatedAtProperty, 'value')) reject();
    // This pure selector recomputes metadata through a legitimate lease renewal.
    // Its caller still has to assert the actual current clock/lease separately.
    const goal = resolveAgentLoopRollingSummaryGoal({ execution: input.execution, now: updatedAtProperty.value });
    const source = { profile: resolveAgentLoopMaintenanceProfile(input.source),
      snapshot: validateAgentLoopMaintenanceSnapshot(input.source) };
    if (goal.mode !== 'apply' || !goal.requiresDomainWrite || !input.source.sessionIdentity
      || typeof input.source.sessionIdentity !== 'object'
      || agentLoopSummaryWriteDigest(input.source.job) !== agentLoopSummaryWriteDigest(input.execution.job)
      || source.snapshot.revision !== goal.binding.sourceRevision
      || origin.actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT
      || origin.runId !== goal.binding.runId || origin.sessionId !== goal.binding.sessionId || origin.taskId !== goal.taskId
      || origin.attemptId !== goal.attemptId || origin.claimAttempt !== goal.binding.attempt
      || origin.ownerId !== goal.binding.ownerId || origin.claimDigest !== goal.claimDigest
      || actionUpdatedAt < goal.binding.startedAt || actionUpdatedAt > origin.authorizedAt
      || origin.actionId !== actionId || origin.sourceRevision !== goal.binding.sourceRevision
      || origin.sourceDigest !== agentLoopSummaryWriteDigest(source) || !source.snapshot.proposalContext
      || origin.contextDigest !== summaryWriteDigest(source.snapshot.proposalContext)
      || intent.runId !== origin.runId || intent.sessionId !== origin.sessionId
      || intent.sourceRevision !== origin.sourceRevision || intent.proposalDigest !== origin.proposalDigest
      || intent.committedAt < origin.authorizedAt || intent.committedAt >= origin.authorizationExpiresAt
      || readback.runId !== intent.runId || readback.sessionId !== intent.sessionId
      || readback.sourceRevision !== intent.sourceRevision || readback.proposalDigest !== intent.proposalDigest
      || readback.intentDigest !== intent.intentDigest || readback.targetRevision !== intent.targetRevision
      || readback.committedAt !== intent.committedAt || readback.truthVersion !== intent.truthVersion
      || readback.historyEpoch !== intent.historyEpoch || readback.throughRound !== intent.throughRound
      || readback.summaryDigest !== intent.summaryDigest
      || readback.projectionDigest !== summaryWriteDigest({ operationDigest: intent.operationDigest,
        throughRound: intent.throughRound, summaryDigest: intent.summaryDigest,
        truthVersion: intent.truthVersion, historyEpoch: intent.historyEpoch })) reject();
    const artifactRef = agentLoopRollingSummaryApplyArtifactRef({ claimDigest: goal.claimDigest,
      actionId, originDigest: origin.originDigest, intentDigest: intent.intentDigest,
      readbackDigest: readback.readbackDigest, postSourceRevision, actionUpdatedAt });
    const evidenceRefs = Object.freeze([...new Set([goal.claimDigest, origin.originDigest, origin.proposalDigest,
      origin.contextDigest, origin.sourceDigest, origin.budgetDigest, intent.intentDigest,
      intent.operationDigest, readback.readbackDigest, postSourceRevision, `act-updated-at:${actionUpdatedAt}`])].sort());
    return Object.freeze({
      artifact: Object.freeze({ artifactRef, kind: AGENT_LOOP_ROLLING_SUMMARY_APPLY_ARTIFACT_KIND,
        status: 'available' as const, evidenceRefs }),
      descriptor: Object.freeze({ refId: artifactRef, kind: 'memory-record' as const,
        ownerRef: `maintenancejob.${goal.binding.runId}`, expectedDigest: readback.readbackDigest,
        expectedRevision: postSourceRevision, policy: 'required' as const, aclClass: 'restricted' as const, expandBudgetTokens: 0 }),
    });
  } catch { return reject(); }
}
