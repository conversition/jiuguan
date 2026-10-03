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
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

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
  const dayStart = input.nowMs - 24 * 60 * 60 * 1000;
  const dailyCount = input.existingJobs.filter((job) => Date.parse(job.updatedAt) >= dayStart
    && job.attempt > 0).length;
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
      newEventCount: taskKind === 'memory_consolidation' ? signalCount : 0,
      sampleCount: freshEntries.length,
      entitySignalCount: taskKind === 'npc_state' ? signalCount : 0,
      foregroundActive: input.foregroundActive,
      priorState: priorState(sameSource),
      sameSourceSucceeded: sameSourceJobs.some((job) => job.status === 'succeeded'),
      cooldownElapsedMs: elapsed,
      cooldownRequiredMs: COOLDOWN_MS[taskKind],
      sessionBudgetRemaining: Math.max(0, sessionLimit - dailyCount),
      dailyBudgetRemaining: Math.max(0, dailyLimit - dailyCount),
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
