/** Content-free historical apply-completion metadata. Normalizing a receipt
 * never issues a live completion, execution or Manager-success capability. */
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';
import { agentLoopSummaryWriteDigest } from './agent-loop-summary-write-origin.ts';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken,
  normalizeAgentLoopActionDigest } from './agent-loop-action-receipt.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';

export const MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_VERSION = 'maintenance-agent-loop-summary-apply-completion-v1' as const;
export const MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE = 'agentLoopSummaryApplyCompletion' as const;
export interface MaintenanceAgentLoopSummaryApplyCompletionInput {
  readonly version: typeof MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_VERSION;
  readonly runId: string; readonly taskId: string; readonly attemptId: string; readonly taskRevision: number;
  readonly taskUpdatedAt: string; readonly envelopeDigest: string; readonly candidateRef: string; readonly candidateDigest: string;
  readonly verificationResultRef: string; readonly verificationDigest: string; readonly ownerId: string;
  readonly claimDigest: string; readonly sourceDigest: string; readonly postSourceRevision: string;
  readonly actionId: string; readonly actionDigest: string; readonly actionWatermark: string;
  readonly actionRevision: number; readonly actionUpdatedAt: string;
  readonly originDigest: string; readonly intentDigest: string; readonly operationDigest: string;
  readonly readbackDigest: string; readonly historyDigest: string; readonly proposalDigest: string;
  readonly contextDigest: string; readonly budgetDigest: string; readonly bindingRef: string; readonly bindingDigest: string;
  readonly applyRef: string; readonly domainCommittedAt: string; readonly domainVerifiedAt: string;
}
export interface MaintenanceAgentLoopSummaryApplyCompletionReceipt extends MaintenanceAgentLoopSummaryApplyCompletionInput {
  readonly completedAt: string; readonly completionDigest: string;
}
const KEYS = ['version', 'runId', 'taskId', 'attemptId', 'taskRevision', 'taskUpdatedAt', 'envelopeDigest',
  'candidateRef', 'candidateDigest', 'verificationResultRef', 'verificationDigest', 'ownerId', 'claimDigest',
  'sourceDigest', 'postSourceRevision', 'actionId', 'actionDigest', 'actionWatermark', 'actionRevision', 'actionUpdatedAt',
  'originDigest', 'intentDigest', 'operationDigest', 'readbackDigest', 'historyDigest', 'proposalDigest', 'contextDigest',
  'budgetDigest', 'bindingRef', 'bindingDigest', 'applyRef', 'domainCommittedAt', 'domainVerifiedAt'] as const;
const DIGEST_KEYS = ['envelopeDigest', 'candidateDigest', 'verificationDigest', 'claimDigest', 'sourceDigest',
  'postSourceRevision', 'actionId', 'actionDigest', 'originDigest', 'intentDigest', 'operationDigest', 'readbackDigest',
  'historyDigest', 'proposalDigest', 'contextDigest', 'budgetDigest', 'bindingDigest'] as const;
function invalid(): never { throw new Error('maintenance-agent-loop-summary-apply-completion-input-invalid'); }
function exact(value: unknown, keys: readonly string[]) {
  const row = normalizeAgentLoopActionObject(value, keys);
  if (Reflect.ownKeys(row).some(key => !Object.getOwnPropertyDescriptor(row, key)?.enumerable)) invalid();
  return row;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function normalizeMaintenanceAgentLoopSummaryApplyCompletionInput(value: unknown): MaintenanceAgentLoopSummaryApplyCompletionInput {
  try {
    const row = exact(value, KEYS);
    for (const key of DIGEST_KEYS) normalizeAgentLoopActionDigest(row[key]);
    for (const key of ['runId', 'taskId', 'attemptId', 'candidateRef', 'verificationResultRef', 'ownerId', 'bindingRef', 'applyRef']) {
      normalizeAgentLoopActionToken(row[key]);
    }
    const taskUpdatedAt = time(row.taskUpdatedAt), actionUpdatedAt = time(row.actionUpdatedAt);
    const domainCommittedAt = time(row.domainCommittedAt), domainVerifiedAt = time(row.domainVerifiedAt);
    if (row.version !== MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_VERSION || typeof row.runId !== 'string'
      || !/^mjob_[a-f0-9]{32}$/u.test(row.runId) || row.taskId !== `agentloop.maintenance.${row.runId}`
      || row.taskRevision !== 6 || row.actionRevision !== 3 || row.attemptId !== `attempt.al.${String(row.claimDigest).slice(7)}`
      || !/^completion-candidate:[a-f0-9]{64}$/u.test(String(row.candidateRef))
      || !/^verification:[a-f0-9]{64}$/u.test(String(row.verificationResultRef))
      || row.actionWatermark !== `action-completed:${row.actionId}`
      || row.bindingRef !== `execution.prepare:${String(row.bindingDigest).slice(7)}`
      || !/^maintenance\.summary\.apply\.artifact:[a-f0-9]{64}$/u.test(String(row.applyRef))
      || actionUpdatedAt > domainCommittedAt || domainCommittedAt > domainVerifiedAt || domainVerifiedAt > taskUpdatedAt) invalid();
    return Object.freeze(Object.fromEntries(KEYS.map(key => [key, row[key]])) as unknown as MaintenanceAgentLoopSummaryApplyCompletionInput);
  } catch { return invalid(); }
}
/** Uses the original immutable claim digest. Terminal status and lease removal
 * do not change that binding; a historical receipt still grants no live rights. */
export function createMaintenanceAgentLoopSummaryApplyCompletionReceipt(input: Readonly<{
  completion: MaintenanceAgentLoopSummaryApplyCompletionInput; job: PublicMaintenanceJob; completedAt: string;
}>): MaintenanceAgentLoopSummaryApplyCompletionReceipt {
  try {
    exact(input, ['completion', 'job', 'completedAt']);
    agentLoopSummaryWriteDigest(input.job);
    const completion = normalizeMaintenanceAgentLoopSummaryApplyCompletionInput(input.completion);
    const { job } = input, completedAt = time(input.completedAt);
    if (job.taskKind !== 'rolling_summary' || job.mode !== 'apply' || !['running', 'succeeded'].includes(job.status)
      || job.runId !== completion.runId || !Number.isSafeInteger(job.attempt) || job.attempt < 1
      || !job.startedAt || time(job.createdAt) > time(job.startedAt) || job.startedAt > completion.actionUpdatedAt
      || time(job.updatedAt) > completedAt || completion.taskUpdatedAt > completedAt
      || agentLoopMaintenanceClaimDigest({ job, executorRoute: 'agent-loop', leaseOwnerInstanceId: completion.ownerId }) !== completion.claimDigest) invalid();
    const base = Object.freeze({ ...completion, completedAt });
    return Object.freeze({ ...base, completionDigest: agentLoopSummaryWriteDigest(base) });
  } catch { return invalid(); }
}
export function parseMaintenanceAgentLoopSummaryApplyCompletionReceipt(value: unknown,
  job: PublicMaintenanceJob): MaintenanceAgentLoopSummaryApplyCompletionReceipt {
  try {
    const row = exact(value, [...KEYS, 'completedAt', 'completionDigest']);
    const { completedAt, completionDigest, ...completion } = row;
    const expected = createMaintenanceAgentLoopSummaryApplyCompletionReceipt({
      completion: completion as unknown as MaintenanceAgentLoopSummaryApplyCompletionInput, job, completedAt: time(completedAt) });
    if (job.status !== 'succeeded' || job.updatedAt !== expected.completedAt || job.finishedAt !== expected.completedAt
      || job.errorCode !== undefined || completionDigest !== expected.completionDigest
      || agentLoopSummaryWriteDigest(row) !== agentLoopSummaryWriteDigest(expected)) invalid();
    return expected;
  } catch { return invalid(); }
}
