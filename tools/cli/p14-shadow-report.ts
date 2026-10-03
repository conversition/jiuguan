#!/usr/bin/env node
import { existsSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TurnObservationStore, type TurnObservationRecord } from '../../packages/memory/src/turn-observation.ts';
import { isMaintenanceTaskKind, type MaintenanceTaskKind } from '../../apps/server/maintenance-types.ts';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import {
  AGENT_ADMISSION_DB_FILE,
  readAgentAdmissionFile,
  type AgentAdmissionRow,
  type MaintenanceAdmissionRow,
} from '../../apps/server/agent-admission-ledger.ts';
import {
  MODEL_USAGE_DB_FILE,
  readModelUsageFile,
  type ModelUsageRow,
} from '../../apps/server/model-usage-ledger.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_DB_FILE,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from '../../apps/server/maintenance-job-manager.ts';
import { scanSessionDbs } from './quality.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

export const P14_SHADOW_REPORT_VERSION = 'p14-shadow-report-v1' as const;
export type EvidenceClass = 'operational' | 'fixture';

export interface MaintenanceReportJob {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly sourceRevision: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
  readonly hasProposal: boolean;
}

export interface P14ShadowReportInput {
  readonly observations: readonly TurnObservationRecord[];
  readonly usageRows: readonly ModelUsageRow[];
  readonly interactiveAdmissions: readonly AgentAdmissionRow[];
  readonly maintenanceAdmissions: readonly MaintenanceAdmissionRow[];
  readonly maintenanceJobs: readonly MaintenanceReportJob[];
  readonly evidenceClass: EvidenceClass;
  readonly generatedAt: string;
}

type CountMap = Readonly<Record<string, number>>;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function counts(values: readonly string[]): CountMap {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}

function acceptedKey(sessionId: string, runId: string | null | undefined): string | null {
  return runId ? `${sessionId}\0${runId}` : null;
}

function maintenanceDecisionKey(input: {
  sessionId: string;
  parentRunId: string | null | undefined;
  taskKind: string;
  sourceRevision: string;
}): string | null {
  return input.parentRunId
    ? `${input.sessionId}\0${input.parentRunId}\0${input.taskKind}\0${input.sourceRevision}`
    : null;
}

export function buildP14ShadowReport(input: P14ShadowReportInput) {
  if (!Number.isFinite(Date.parse(input.generatedAt)) || new Date(input.generatedAt).toISOString() !== input.generatedAt) {
    throw new Error('generatedAt-invalid');
  }
  const generatedAtMs = Date.parse(input.generatedAt);
  const observations = input.observations.filter((observation) => Date.parse(observation.createdAt) <= generatedAtMs);
  const accepted = new Set(observations.flatMap((observation) => {
    const key = acceptedKey(observation.sessionId, observation.runId);
    return key ? [key] : [];
  }));
  const acceptedObservations = new Map(observations.flatMap((observation) => {
    const key = acceptedKey(observation.sessionId, observation.runId);
    return key ? [[key, observation] as const] : [];
  }));
  const jobs = input.maintenanceJobs.filter((job) => {
    const key = acceptedKey(job.sessionId, job.parentRunId);
    return key !== null && accepted.has(key);
  });
  const jobByRun = new Map(jobs.map((job) => [job.runId, job]));
  const usage = input.usageRows.filter((row) => {
    if (!row.sessionId) return false;
    const direct = acceptedKey(row.sessionId, row.runId);
    const parent = acceptedKey(row.sessionId, row.parentRunId);
    return (direct !== null && accepted.has(direct))
      || (parent !== null && accepted.has(parent))
      || (row.runId !== undefined && jobByRun.has(row.runId));
  });
  const interactive = input.interactiveAdmissions.filter((row) => accepted.has(acceptedKey(row.sessionId, row.runId)!));
  const maintenance = input.maintenanceAdmissions.filter((row) => accepted.has(acceptedKey(row.sessionId, row.parentRunId)!));
  const providerRows = usage.filter((row) => row.usageSource === 'provider' && row.usage !== null);
  const costRows = usage.filter((row) => row.costMicrousd !== undefined);
  const cachedRows = providerRows.filter((row) => row.usage?.cached_input_tokens !== undefined);
  const cacheWriteRows = providerRows.filter((row) => row.usage?.cache_write_tokens !== undefined);
  const reasoningRows = providerRows.filter((row) => row.usage?.reasoning_tokens !== undefined);
  const admittedInteractive = interactive.filter((row) => row.decision.verdict === 'would-admit');
  const admittedWithEvidence = admittedInteractive.filter((row) => {
    const observation = acceptedObservations.get(acceptedKey(row.sessionId, row.runId)!);
    return (observation?.harnessEvidenceCount ?? 0) > 0;
  }).length;
  const decisionByTask = new Map(maintenance.map((row) => [maintenanceDecisionKey({
    sessionId: row.sessionId,
    parentRunId: row.parentRunId,
    taskKind: row.facts.taskKind,
    sourceRevision: row.sourceRevision,
  })!, row]));
  let assessedMaintenanceCalls = 0;
  let wastedMaintenanceCalls = 0;
  let unassessedMaintenanceCalls = 0;
  let modelInvokedJobs = 0;
  let validProposalJobs = 0;
  let effectiveProposalJobs = 0;
  const maintenanceUsageByRun = new Map<string, number>();
  for (const row of usage.filter((entry) => entry.lane === 'maintenance' && entry.runId)) {
    maintenanceUsageByRun.set(row.runId!, (maintenanceUsageByRun.get(row.runId!) ?? 0) + 1);
  }
  for (const job of jobs) {
    const modelCalls = maintenanceUsageByRun.get(job.runId) ?? 0;
    if (modelCalls > 0) modelInvokedJobs += 1;
    const validProposal = job.status === 'succeeded' && job.hasProposal;
    if (validProposal) validProposalJobs += 1;
    const decision = decisionByTask.get(maintenanceDecisionKey(job)!);
    if (!decision) {
      unassessedMaintenanceCalls += modelCalls;
      continue;
    }
    assessedMaintenanceCalls += modelCalls;
    const effective = decision.decision.verdict === 'would-admit' && validProposal;
    if (effective) effectiveProposalJobs += 1;
    if (!effective) wastedMaintenanceCalls += modelCalls;
  }
  const shadowSampleKeys = new Set([
    ...interactive.map((row) => acceptedKey(row.sessionId, row.runId)!),
    ...maintenance.map((row) => acceptedKey(row.sessionId, row.parentRunId)!),
  ]);
  const successfulObservations = observations.filter((row) => {
    const key = acceptedKey(row.sessionId, row.runId);
    return key !== null && shadowSampleKeys.has(key);
  });
  const observedDays = new Set(successfulObservations.map((row) => row.createdAt.slice(0, 10))).size;
  const successfulSamples = successfulObservations.length;
  const sampleThresholdMet = observedDays >= 7 || successfulSamples >= 100;
  const operationalReady = input.evidenceClass === 'operational' && sampleThresholdMet;
  return Object.freeze({
    reportVersion: P14_SHADOW_REPORT_VERSION,
    generatedAt: input.generatedAt,
    evidenceClass: input.evidenceClass,
    acceptedTurns: Object.freeze({ total: observations.length, successfulSamples, observedDays }),
    usage: Object.freeze({
      modelCalls: usage.length,
      turnFinalCalls: usage.filter((row) => row.lane === 'turn_final').length,
      extraLaneCalls: usage.filter((row) => row.lane !== 'turn_final').length,
      byLane: counts(usage.map((row) => row.lane)),
      provider: Object.freeze({
        availableCalls: providerRows.length,
        unavailableCalls: usage.length - providerRows.length,
        promptTokens: providerRows.reduce((sum, row) => sum + row.usage!.prompt_tokens, 0),
        completionTokens: providerRows.reduce((sum, row) => sum + row.usage!.completion_tokens, 0),
        totalTokens: providerRows.reduce((sum, row) => sum + row.usage!.total_tokens, 0),
      }),
      cache: Object.freeze({
        cachedInputKnownCalls: cachedRows.length,
        cachedInputTokens: cachedRows.reduce((sum, row) => sum + row.usage!.cached_input_tokens!, 0),
        cacheWriteKnownCalls: cacheWriteRows.length,
        cacheWriteTokens: cacheWriteRows.reduce((sum, row) => sum + row.usage!.cache_write_tokens!, 0),
        reasoningKnownCalls: reasoningRows.length,
        reasoningTokens: reasoningRows.reduce((sum, row) => sum + row.usage!.reasoning_tokens!, 0),
      }),
      cost: Object.freeze({
        knownCalls: costRows.length,
        unavailableCalls: usage.length - costRows.length,
        totalMicrousd: costRows.reduce((sum, row) => sum + row.costMicrousd!, 0),
      }),
    }),
    interactiveAdmission: Object.freeze({
      decisions: interactive.length,
      wouldAdmit: admittedInteractive.length,
      wouldDeny: interactive.length - admittedInteractive.length,
      reasonCounts: counts(interactive.flatMap((row) => row.decision.reasonCodes)),
      admittedWithNewEvidence: admittedWithEvidence,
      newEvidenceRate: ratio(admittedWithEvidence, admittedInteractive.length),
    }),
    maintenanceAdmission: Object.freeze({
      batches: new Set(maintenance.map((row) => `${row.sessionId}\0${row.parentRunId}\0${row.round}\0${row.sourceRevision}`)).size,
      decisions: maintenance.length,
      wouldAdmit: maintenance.filter((row) => row.decision.verdict === 'would-admit').length,
      wouldDeny: maintenance.filter((row) => row.decision.verdict === 'would-deny').length,
      reasonCounts: counts(maintenance.flatMap((row) => row.decision.reasonCodes)),
    }),
    maintenanceOutcome: Object.freeze({
      jobs: jobs.length,
      modelInvokedJobs,
      validProposalJobs,
      effectiveProposalJobs,
      assessedModelCalls: assessedMaintenanceCalls,
      unassessedModelCalls: unassessedMaintenanceCalls,
      wastedModelCalls: wastedMaintenanceCalls,
      wasteRate: ratio(wastedMaintenanceCalls, assessedMaintenanceCalls),
    }),
    releaseGate: Object.freeze({
      operator: 'or' as const,
      minimumObservedDays: 7,
      minimumSuccessfulSamples: 100,
      sampleThresholdMet,
      operationalReady,
      status: operationalReady ? 'ready' as const
        : input.evidenceClass === 'fixture' ? 'fixture-evidence-never-unlocks' as const
          : 'insufficient-operational-evidence' as const,
    }),
  });
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`maintenance-report-${name}-invalid`);
  return Number(value);
}

function readMaintenanceReportJobs(file: string): MaintenanceReportJob[] {
  if (!existsSync(file)) return [];
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('maintenance-report-file-invalid');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (pragma(db, 'application_id') !== MAINTENANCE_JOB_APPLICATION_ID
      || pragma(db, 'user_version') !== MAINTENANCE_JOB_SCHEMA_VERSION) {
      throw new Error('maintenance-report-metadata-mismatch');
    }
    const rows = db.prepare(`
      SELECT run_id,parent_run_id,session_id,task_kind,source_revision,status,
        CASE WHEN proposal_digest IS NOT NULL AND proposal_disposition IS NOT NULL THEN 1 ELSE 0 END AS has_proposal
      FROM maintenance_job ORDER BY created_at,run_id LIMIT 10000
    `).all() as Record<string, unknown>[];
    return rows.map((row) => {
      if (!isMaintenanceTaskKind(row.task_kind)
        || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale'].includes(String(row.status))) {
        throw new Error('maintenance-report-row-invalid');
      }
      const runId = String(row.run_id);
      const parentRunId = row.parent_run_id === null ? null : String(row.parent_run_id);
      const sessionId = String(row.session_id);
      const sourceRevision = String(row.source_revision);
      if (!isSafeOpaqueId(runId) || (parentRunId !== null && !isSafeOpaqueId(parentRunId))
        || !isSafeOpaqueId(sessionId) || !isSafeOpaqueId(sourceRevision)) {
        throw new Error('maintenance-report-identity-invalid');
      }
      return {
        runId,
        parentRunId,
        sessionId,
        taskKind: row.task_kind,
        sourceRevision,
        status: row.status as MaintenanceReportJob['status'],
        hasProposal: row.has_proposal === 1,
      };
    });
  } finally {
    db.close();
  }
}

function readObservations(dataDir: string): TurnObservationRecord[] {
  const rows: TurnObservationRecord[] = [];
  for (const file of scanSessionDbs(dataDir)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='turn_observation'").get();
      if (table) rows.push(...new TurnObservationStore(db).list());
    } finally {
      db.close();
    }
  }
  return rows;
}

export function buildP14ShadowReportFromDataDir(input: {
  dataDir: string;
  evidenceClass?: EvidenceClass;
  generatedAt?: string;
}) {
  const dataDir = resolve(input.dataDir);
  const admission = readAgentAdmissionFile(join(dataDir, AGENT_ADMISSION_DB_FILE));
  return buildP14ShadowReport({
    observations: readObservations(dataDir),
    usageRows: readModelUsageFile(join(dataDir, MODEL_USAGE_DB_FILE), { limit: 10_000 }),
    interactiveAdmissions: admission.interactive,
    maintenanceAdmissions: admission.maintenance,
    maintenanceJobs: readMaintenanceReportJobs(join(dataDir, MAINTENANCE_JOB_DB_FILE)),
    evidenceClass: input.evidenceClass ?? 'operational',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

function main(): void {
  const argv = process.argv.slice(2);
  const evidence = option(argv, '--evidence-class') ?? 'operational';
  if (evidence !== 'operational' && evidence !== 'fixture') throw new Error('--evidence-class 只允许 operational 或 fixture');
  const data = resolveOperationalDataDirectory({ explicit: option(argv, '--dir') });
  const report = buildP14ShadowReportFromDataDir({
    dataDir: data.path,
    evidenceClass: evidence,
    ...(option(argv, '--now') ? { generatedAt: option(argv, '--now') } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ...report, dataSource: data.source }, null,
    argv.includes('--compact') ? 0 : 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
