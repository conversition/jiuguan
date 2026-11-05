import { createHash } from 'node:crypto';
import type { TurnObservationRecord } from '../../packages/memory/src/turn-observation.ts';
import {
  MAINTENANCE_ADMISSION_POLICY_VERSION,
  MAINTENANCE_ADMISSION_TASKS,
  evaluateMaintenanceAdmissionBatch,
  type MaintenanceAdmissionAudit,
  type MaintenanceAdmissionFacts,
  type MaintenanceAdmissionTask,
  type MaintenancePriorState,
} from '../../packages/agent-policy/src/maintenance-admission.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';
import {
  DEFAULT_MAINTENANCE_DAILY_BUDGET_24H,
  DEFAULT_MAINTENANCE_SESSION_BUDGET_24H,
  MAX_MAINTENANCE_DAILY_BUDGET_24H,
} from './maintenance-admission-runtime-config.ts';

const COOLDOWN_MS: Readonly<Record<MaintenanceAdmissionTask, number>> = Object.freeze({
  memory_consolidation: 60_000,
  branch_index: 120_000,
  rolling_summary: 300_000,
  npc_state: 120_000,
  // 世界书修正改动的是用户资产，冷却给得最保守：两次修正之间至少隔 30 分钟。
  worldbook_repair: 1_800_000,
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MAINTENANCE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A terminal non-success briefly keeps its reservation so a broken Provider
 * cannot be retried once per turn without bound. It does not poison the full
 * 24-hour success budget: the task cooldown remains the first retry guard and
 * this shared hold is the burst guard across task kinds.
 */
export const MAINTENANCE_TERMINAL_RETRY_HOLD_MS = 15 * 60 * 1000;

export interface MaintenanceSessionBudgetSnapshot {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly nextSlotAt: string | null;
  readonly successfulUsed: number;
  readonly activeUsed: number;
  readonly transientTerminalUsed: number;
}

export interface MaintenanceDailyAttemptBudgetSnapshot {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly nextSlotAt: string | null;
  readonly attemptedUsed: number;
  readonly activeUsed: number;
}

interface BudgetReservation {
  readonly kind: 'successful' | 'active' | 'transient-terminal';
  readonly releaseAtMs: number | null;
}

function maintenanceBudgetReservation(
  job: PublicMaintenanceJob,
  nowMs: number,
): BudgetReservation | null {
  if (job.status === 'queued' || job.status === 'running') {
    // Active work owns a slot until it reaches a terminal state, even if a
    // stalled job happens to be older than the rolling success window.
    return { kind: 'active', releaseAtMs: null };
  }
  const updatedAtMs = Date.parse(job.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return null;
  if (job.status === 'succeeded') {
    const releaseAtMs = updatedAtMs + MAINTENANCE_BUDGET_WINDOW_MS;
    return releaseAtMs > nowMs ? { kind: 'successful', releaseAtMs } : null;
  }
  if (job.attempt > 0) {
    const releaseAtMs = updatedAtMs + MAINTENANCE_TERMINAL_RETRY_HOLD_MS;
    return releaseAtMs > nowMs ? { kind: 'transient-terminal', releaseAtMs } : null;
  }
  return null;
}

/**
 * Shared source of truth for admission and read-side status projection.
 * Successful and active work consume the formal budget; failed/cancelled/stale
 * attempts consume only a short retry reservation.
 */
export function maintenanceSessionBudgetSnapshot(input: {
  readonly existingJobs: readonly PublicMaintenanceJob[];
  readonly nowMs: number;
  readonly limit: number;
}): MaintenanceSessionBudgetSnapshot {
  if (!Array.isArray(input.existingJobs)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1
    || input.limit > MAX_MAINTENANCE_DAILY_BUDGET_24H) {
    throw new TypeError('maintenance budget snapshot input is invalid');
  }
  const reservations = input.existingJobs
    .map((job) => maintenanceBudgetReservation(job, input.nowMs))
    .filter((reservation): reservation is BudgetReservation => reservation !== null);
  const used = reservations.length;
  const remaining = Math.max(0, input.limit - used);
  let nextSlotAt: string | null = null;
  if (remaining === 0) {
    // If usage is above the limit, more than one reservation may have to
    // expire before a slot is actually available.
    const releasesNeeded = used - input.limit + 1;
    const finiteReleases = reservations
      .map((reservation) => reservation.releaseAtMs)
      .filter((releaseAtMs): releaseAtMs is number => releaseAtMs !== null)
      .sort((left, right) => left - right);
    const releaseAtMs = finiteReleases[releasesNeeded - 1];
    if (releaseAtMs !== undefined) nextSlotAt = new Date(releaseAtMs).toISOString();
  }
  return Object.freeze({
    used,
    limit: input.limit,
    remaining,
    nextSlotAt,
    successfulUsed: reservations.filter((reservation) => reservation.kind === 'successful').length,
    activeUsed: reservations.filter((reservation) => reservation.kind === 'active').length,
    transientTerminalUsed: reservations
      .filter((reservation) => reservation.kind === 'transient-terminal').length,
  });
}

/**
 * Hard 24-hour safety cap for Provider attempts. Unlike the releasable session
 * scheduling budget above, a failed/cancelled/stale attempted job stays here
 * for the complete rolling day. Queued and running jobs reserve capacity so a
 * backlog cannot oversubscribe the cap before execution starts.
 */
export function maintenanceDailyAttemptBudgetSnapshot(input: {
  readonly existingJobs: readonly PublicMaintenanceJob[];
  readonly nowMs: number;
  readonly limit: number;
}): MaintenanceDailyAttemptBudgetSnapshot {
  if (!Array.isArray(input.existingJobs)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1
    || input.limit > MAX_MAINTENANCE_DAILY_BUDGET_24H) {
    throw new TypeError('maintenance daily attempt budget snapshot input is invalid');
  }
  const reservations = input.existingJobs.flatMap((job): Array<{
    kind: 'attempted' | 'active';
    releaseAtMs: number | null;
  }> => {
    if (job.status === 'queued' || job.status === 'running') {
      return [{ kind: 'active', releaseAtMs: null }];
    }
    if (job.attempt < 1) return [];
    // Terminal updatedAt is the conservative settlement/cost anchor. A long
    // running attempt must not regain daily capacity immediately on finish.
    const settledAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(settledAtMs)) return [];
    const releaseAtMs = settledAtMs + MAINTENANCE_BUDGET_WINDOW_MS;
    return releaseAtMs > input.nowMs ? [{ kind: 'attempted', releaseAtMs }] : [];
  });
  const used = reservations.length;
  const remaining = Math.max(0, input.limit - used);
  let nextSlotAt: string | null = null;
  if (remaining === 0) {
    const releasesNeeded = used - input.limit + 1;
    const finiteReleases = reservations
      .map((reservation) => reservation.releaseAtMs)
      .filter((releaseAtMs): releaseAtMs is number => releaseAtMs !== null)
      .sort((left, right) => left - right);
    const releaseAtMs = finiteReleases[releasesNeeded - 1];
    if (releaseAtMs !== undefined) nextSlotAt = new Date(releaseAtMs).toISOString();
  }
  return Object.freeze({
    used,
    limit: input.limit,
    remaining,
    nextSlotAt,
    attemptedUsed: reservations.filter((reservation) => reservation.kind === 'attempted').length,
    activeUsed: reservations.filter((reservation) => reservation.kind === 'active').length,
  });
}

export interface MaintenanceDomainEvidenceEntry {
  readonly round: number;
  readonly digest: string;
  readonly signalCount: number;
}

export type MaintenanceDomainEvidence = Readonly<Record<
  MaintenanceAdmissionTask,
  readonly MaintenanceDomainEvidenceEntry[]
>>;

function sourceDigest(taskKind: MaintenanceAdmissionTask, entries: readonly MaintenanceDomainEvidenceEntry[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    taskKind,
    entries: entries.map((entry) => [entry.round, entry.digest, entry.signalCount]),
  }), 'utf8').digest('hex')}`;
}

function priorState(job: PublicMaintenanceJob | undefined): MaintenancePriorState {
  if (!job) return 'none';
  if (job.status === 'queued' || job.status === 'running' || job.status === 'succeeded') return job.status;
  return 'terminal';
}

export function buildMaintenanceAdmissionAudits(input: {
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly observation: TurnObservationRecord;
  readonly domainEvidence: MaintenanceDomainEvidence;
  readonly foregroundActive: boolean;
  readonly existingJobs: readonly PublicMaintenanceJob[];
  readonly priorAdmissions?: readonly {
    parentRunId: string;
    round: number;
    sourceRevision: string;
    facts: Pick<MaintenanceAdmissionFacts, 'taskKind' | 'sourceDigest'>;
  }[];
  readonly nowMs: number;
  readonly sessionBudgetLimit?: number;
  readonly dailyBudgetLimit?: number;
}): readonly MaintenanceAdmissionAudit[] {
  const sessionLimit = input.sessionBudgetLimit ?? DEFAULT_MAINTENANCE_SESSION_BUDGET_24H;
  const dailyLimit = input.dailyBudgetLimit ?? DEFAULT_MAINTENANCE_DAILY_BUDGET_24H;
  if (!input.domainEvidence || typeof input.domainEvidence !== 'object'
    || Object.keys(input.domainEvidence).length !== MAINTENANCE_ADMISSION_TASKS.length
    || MAINTENANCE_ADMISSION_TASKS.some((task) => !Array.isArray(input.domainEvidence[task]))) {
    throw new TypeError('maintenance domain evidence is invalid');
  }
  const domainEntries = Object.values(input.domainEvidence).flat();
  if (!Number.isSafeInteger(sessionLimit) || sessionLimit < 1
    || sessionLimit > MAX_MAINTENANCE_DAILY_BUDGET_24H
    || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1
    || dailyLimit > MAX_MAINTENANCE_DAILY_BUDGET_24H
    || sessionLimit > dailyLimit
    || domainEntries.length > 2_048
    || domainEntries.some((entry) => !Number.isSafeInteger(entry.round) || entry.round < 1
      || !DIGEST_RE.test(entry.digest) || !Number.isSafeInteger(entry.signalCount) || entry.signalCount < 1)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new TypeError('maintenance shadow input is invalid');
  }
  const sessionBudget = maintenanceSessionBudgetSnapshot({
    existingJobs: input.existingJobs,
    nowMs: input.nowMs,
    limit: sessionLimit,
  });
  const dailyBudget = maintenanceDailyAttemptBudgetSnapshot({
    existingJobs: input.existingJobs,
    nowMs: input.nowMs,
    limit: dailyLimit,
  });
  const facts = MAINTENANCE_ADMISSION_TASKS.map((taskKind): MaintenanceAdmissionFacts => {
    const sameSourceJobs = input.existingJobs.filter((job) => job.taskKind === taskKind
      && job.sourceRevision === input.sourceRevision);
    const sameSource = sameSourceJobs.find((job) => job.status === 'queued' || job.status === 'running')
      ?? sameSourceJobs.find((job) => job.status === 'succeeded')
      ?? sameSourceJobs[0];
    const latestSuccess = input.existingJobs
      .filter((job) => job.taskKind === taskKind && job.status === 'succeeded')
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const latestAttempt = input.existingJobs
      .filter((job) => job.taskKind === taskKind && job.attempt > 0)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const latestAttemptAudit = latestAttempt
      ? input.priorAdmissions?.find((entry) => entry.parentRunId === latestAttempt.parentRunId
        && entry.sourceRevision === latestAttempt.sourceRevision
        && entry.facts.taskKind === taskKind)
      : undefined;
    const afterRound = latestAttempt ? (latestAttemptAudit?.round ?? Number.MAX_SAFE_INTEGER) : 0;
    const freshEntries = [...input.domainEvidence[taskKind]]
      .filter((entry) => entry.round > afterRound)
      .sort((left, right) => left.round - right.round || left.digest.localeCompare(right.digest));
    const recentSuccessDigest = latestSuccess
      ? input.priorAdmissions?.find((entry) => entry.parentRunId === latestSuccess.parentRunId
        && entry.sourceRevision === latestSuccess.sourceRevision
        && entry.facts.taskKind === taskKind)?.facts.sourceDigest ?? null
      : null;
    const elapsed = latestAttempt
      ? Math.max(0, input.nowMs - Date.parse(latestAttempt.updatedAt))
      : Number.MAX_SAFE_INTEGER;
    const signalCount = freshEntries.reduce((sum, entry) => sum + entry.signalCount, 0);
    return {
      taskKind,
      sourceDigest: sourceDigest(taskKind, freshEntries),
      recentSuccessDigest,
      observationDigest: input.observation.payloadDigest,
      hasStableRevision: /^sha256:[a-f0-9]{64}$/u.test(input.sourceRevision),
      // Worldbook repair is event-driven just like memory consolidation. Its
      // evidence/dedupe cursor remains task-local, so admitting one task cannot
      // consume the other task's newly committed story events.
      newEventCount: taskKind === 'memory_consolidation' || taskKind === 'worldbook_repair'
        ? signalCount : 0,
      sampleCount: freshEntries.length,
      entitySignalCount: taskKind === 'npc_state' ? signalCount : 0,
      foregroundActive: input.foregroundActive,
      priorState: priorState(sameSource),
      sameSourceSucceeded: sameSourceJobs.some((job) => job.status === 'succeeded'),
      cooldownElapsedMs: elapsed,
      cooldownRequiredMs: COOLDOWN_MS[taskKind],
      sessionBudgetRemaining: sessionBudget.remaining,
      dailyBudgetRemaining: dailyBudget.remaining,
    };
  });
  const decisions = evaluateMaintenanceAdmissionBatch(input.observation.round, facts);
  const createdAt = new Date(input.nowMs).toISOString();
  return Object.freeze(facts.map((taskFacts, index) => Object.freeze({
    parentRunId: input.parentRunId,
    sessionId: input.sessionId,
    round: input.observation.round,
    sourceRevision: input.sourceRevision,
    facts: taskFacts,
    decision: decisions[index]!,
    createdAt,
  })));
}
