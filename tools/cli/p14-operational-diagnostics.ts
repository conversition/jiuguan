#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_ADMISSION_DB_FILE,
  readAgentAdmissionFile,
} from '../../apps/server/agent-admission-ledger.ts';
import {
  MODEL_USAGE_DB_FILE,
  readModelUsageFile,
} from '../../apps/server/model-usage-ledger.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_DB_FILE,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from '../../apps/server/maintenance-job-manager.ts';
import {
  buildP14OperationalDiagnostics,
  type DiagnosticMaintenanceJob,
} from './p14-operational-diagnostics-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

type SqlRow = Record<string, unknown>;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`maintenance-${name}-invalid`);
  return Number(value);
}

function readMaintenanceJobs(path: string, sessionId: string,
  since: string | undefined,
  maintenanceCalls: Readonly<Record<string, number>>): DiagnosticMaintenanceJob[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('maintenance-job-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (pragma(db, 'application_id') !== MAINTENANCE_JOB_APPLICATION_ID
      || pragma(db, 'user_version') !== MAINTENANCE_JOB_SCHEMA_VERSION) {
      throw new Error('maintenance-job-metadata-mismatch');
    }
    const rows = db.prepare(`
      SELECT run_id,task_kind,status,error_code,
        CASE WHEN proposal_digest IS NULL THEN 0 ELSE 1 END AS has_proposal
      FROM maintenance_job WHERE session_id=?
        AND (? IS NULL OR COALESCE(finished_at,updated_at)>=?)
      ORDER BY created_at,run_id LIMIT 10000
    `).all(sessionId, since ?? null, since ?? null) as SqlRow[];
    return rows.map((row) => ({
      taskKind: String(row.task_kind),
      status: String(row.status),
      errorCode: row.error_code === null ? null : String(row.error_code),
      hasProposal: Number(row.has_proposal) === 1,
      modelCalls: maintenanceCalls[String(row.run_id)] ?? 0,
    }));
  } finally {
    db.close();
  }
}

function canonicalTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} 必须是 ISO 时间`);
  }
  return value;
}

function serverStart(dataDir: string): string {
  const path = join(dataDir, '.jiuguan-server.lock', 'owner.json');
  if (!existsSync(path)) throw new Error('managed-server-owner-missing');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('managed-server-owner-invalid');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (typeof parsed.acquiredAt !== 'string') throw new Error('managed-server-start-missing');
  return canonicalTimestamp(parsed.acquiredAt, 'managed server start');
}

function main(): void {
  const argv = process.argv.slice(2);
  const sessionId = option(argv, '--session');
  if (!sessionId) throw new Error('--session 必填；公开版不绑定任何私人会话');
  if (!/^session-[A-Za-z0-9._-]{1,220}$/u.test(sessionId)) throw new Error('--session 非法');
  const data = resolveOperationalDataDirectory({ explicit: option(argv, '--dir') });
  if (argv.includes('--since-server-start') && option(argv, '--since')) {
    throw new Error('--since 与 --since-server-start 不能同时使用');
  }
  const since = argv.includes('--since-server-start')
    ? serverStart(data.path)
    : option(argv, '--since') ? canonicalTimestamp(option(argv, '--since')!, '--since') : undefined;
  const usage = readModelUsageFile(join(data.path, MODEL_USAGE_DB_FILE), { sessionId, limit: 10_000 })
    .filter((row) => since === undefined || row.startedAt >= since);
  const maintenanceCalls: Record<string, number> = {};
  for (const row of usage.filter((entry) => entry.lane === 'maintenance' && entry.runId)) {
    maintenanceCalls[row.runId!] = (maintenanceCalls[row.runId!] ?? 0) + 1;
  }
  const admission = readAgentAdmissionFile(join(data.path, AGENT_ADMISSION_DB_FILE));
  const report = buildP14OperationalDiagnostics({
    sessionId,
    usage,
    leases: admission.runtimeLeases.filter((row) => row.sessionId === sessionId
      && (since === undefined || row.finishedAt >= since)),
    maintenanceJobs: readMaintenanceJobs(
      join(data.path, MAINTENANCE_JOB_DB_FILE), sessionId, since, maintenanceCalls,
    ),
    generatedAt: new Date().toISOString(),
    ...(since ? { since } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ...report, dataSource: data.source }, null,
    argv.includes('--compact') ? 0 : 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
