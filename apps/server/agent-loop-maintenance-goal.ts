/** A real claim selects a mode-specific goal; this metadata grants no execution or completion.
 * Shadow requires a canonical proposal, not a Summary domain write. Apply also requires the
 * original domain write/readback. Neither a model answer nor this pure selector supplies proof.
 */
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import { agentLoopMaintenanceClaimDigest } from './agent-loop-get-variables-authorization.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';

export const AGENT_LOOP_ROLLING_SUMMARY_GOAL_VERSION = 'agent-loop-rolling-summary-goal-v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_GOAL_PROFILES = Object.freeze({
  shadow: 'goal.maintenance.rolling_summary.shadow.v1',
  apply: 'goal.maintenance.rolling_summary.apply.v1',
} as const);
export type AgentLoopRollingSummaryGoalEvidence =
  | 'canonical-proposal' | 'al-action-provenance' | 'domain-write-readback';
export interface AgentLoopRollingSummaryGoalBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly policyVersion: string;
  readonly attempt: number;
  readonly ownerId: string;
  readonly parentRunId: string | null;
  readonly trigger: 'post-turn' | 'idle' | 'manual';
  readonly createdAt: string;
  readonly startedAt: string;
  readonly executorRoute: 'agent-loop';
}
export interface AgentLoopRollingSummaryGoal {
  readonly version: typeof AGENT_LOOP_ROLLING_SUMMARY_GOAL_VERSION;
  readonly goalProfileRef: typeof AGENT_LOOP_ROLLING_SUMMARY_GOAL_PROFILES[keyof typeof AGENT_LOOP_ROLLING_SUMMARY_GOAL_PROFILES];
  readonly mode: 'shadow' | 'apply';
  readonly claimDigest: string;
  readonly binding: AgentLoopRollingSummaryGoalBinding;
  readonly taskId: string;
  readonly attemptId: string;
  readonly taskKind: string;
  readonly contractRef: string;
  readonly contractRevision: string;
  readonly verifierSetRef: string;
  readonly verifierSetRevision: string;
  readonly requiredEvidence: readonly AgentLoopRollingSummaryGoalEvidence[];
  readonly proposalAction: Readonly<{
    readonly actionContractRef: 'action.maintenance.propose_rolling_summary.v1';
    /** Required by the original Harness state-admission semantics; not a granted budget. */
    readonly requiredUsage: Readonly<{ readonly toolCalls: 1; readonly writes: 1 }>;
    readonly authorizesExecution: false;
  }>;
  readonly requiresDomainWrite: boolean;
  readonly authorizesExecution: false;
  readonly authorizesCompletion: false;
}

const OPAQUE = /^[A-Za-z0-9._:-]{1,160}$/u;
const RUN = /^mjob_[a-f0-9]{32}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function reject(): never { throw new Error('agent-loop-rolling-summary-goal-invalid'); }
function record(value: unknown): object {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  return value;
}
/** Read only selected own data properties. Accessor/thenable values are never evaluated. */
function field(value: object, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) { if (optional) return undefined; return reject(); }
  if (!Object.hasOwn(descriptor, 'value')) reject();
  return descriptor.value;
}
function opaque(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE.test(value)) reject();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isSafeInteger(Date.parse(value))
    || new Date(value).toISOString() !== value) reject();
  return value;
}

/** Pure closed-mode selection only. Callers still need real source/capability/Store fences. */
export function resolveAgentLoopRollingSummaryGoal(input: Readonly<{
  execution: MaintenanceExecutionRecord; now: string;
}>): AgentLoopRollingSummaryGoal {
  try {
    const request = record(input), now = timestamp(field(request, 'now'));
    const execution = record(field(request, 'execution')), job = record(field(execution, 'job'));
    if (field(execution, 'executorRoute') !== 'agent-loop' || field(job, 'taskKind') !== 'rolling_summary'
      || field(job, 'status') !== 'running' || field(execution, 'cancelRequestedAt', true) !== undefined
      || field(job, 'finishedAt', true) !== undefined || field(job, 'errorCode', true) !== undefined) reject();
    const mode = field(job, 'mode');
    if (mode !== 'shadow' && mode !== 'apply') reject();
    const runId = opaque(field(job, 'runId')), sessionId = opaque(field(job, 'sessionId'));
    const sourceRevision = opaque(field(job, 'sourceRevision')), policyVersion = opaque(field(job, 'policyVersion'));
    if (!RUN.test(runId) || !HASH.test(sourceRevision)) reject();
    const ownerId = opaque(field(execution, 'leaseOwnerInstanceId'));
    const parent = field(job, 'parentRunId', true), parentRunId = parent === undefined ? null : opaque(parent);
    const attempt = field(job, 'attempt'), trigger = field(job, 'trigger');
    if (!Number.isSafeInteger(attempt) || Number(attempt) < 1
      || trigger !== 'post-turn' && trigger !== 'idle' && trigger !== 'manual') reject();
    const createdAt = timestamp(field(job, 'createdAt')), startedAt = timestamp(field(job, 'startedAt'));
    const updatedAt = timestamp(field(job, 'updatedAt')), leaseExpiresAt = timestamp(field(execution, 'leaseExpiresAt'));
    if (createdAt > startedAt || startedAt > now || updatedAt < createdAt || updatedAt > now || leaseExpiresAt <= now) reject();

    // The shared claim digest sees only this captured, selected data, not mutable caller objects.
    // Lease TTL and updatedAt are freshness checks, deliberately not immutable claim identity.
    const pinned: MaintenanceExecutionRecord = {
      executorRoute: 'agent-loop', leaseOwnerInstanceId: ownerId, leaseExpiresAt,
      job: { runId, sessionId, taskKind: 'rolling_summary', sourceRevision, policyVersion,
        parentRunId: parentRunId ?? undefined, trigger, mode, status: 'running',
        attempt: Number(attempt), createdAt, updatedAt, startedAt },
    };
    const claimDigest = agentLoopMaintenanceClaimDigest(pinned);
    const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
    const binding: AgentLoopRollingSummaryGoalBinding = Object.freeze({
      runId, sessionId, sourceRevision, policyVersion, attempt: Number(attempt), ownerId, parentRunId,
      trigger, createdAt, startedAt, executorRoute: 'agent-loop',
    });
    const requiredEvidence: readonly AgentLoopRollingSummaryGoalEvidence[] = Object.freeze([
      'canonical-proposal', 'al-action-provenance', ...(mode === 'apply' ? ['domain-write-readback' as const] : []),
    ]);
    return Object.freeze({
      version: AGENT_LOOP_ROLLING_SUMMARY_GOAL_VERSION,
      goalProfileRef: AGENT_LOOP_ROLLING_SUMMARY_GOAL_PROFILES[mode], mode, claimDigest, binding,
      taskId: `agentloop.maintenance.${runId}`, attemptId: `attempt.al.${claimDigest.slice(7)}`,
      taskKind: registration.taskKind, contractRef: registration.contractRef,
      contractRevision: registration.contractRevision, verifierSetRef: registration.verifierSetRef,
      verifierSetRevision: registration.verifierSetRevision, requiredEvidence,
      proposalAction: Object.freeze({ actionContractRef: 'action.maintenance.propose_rolling_summary.v1' as const,
        requiredUsage: Object.freeze({ toolCalls: 1 as const, writes: 1 as const }), authorizesExecution: false as const }),
      requiresDomainWrite: mode === 'apply', authorizesExecution: false, authorizesCompletion: false,
    });
  } catch { return reject(); }
}
