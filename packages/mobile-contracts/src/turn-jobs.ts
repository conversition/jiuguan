import { isSafeOpaqueId } from './http.ts';

export const TURN_JOB_STATUSES = [
  'queued',
  'running',
  'recovering',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TurnJobStatus = (typeof TURN_JOB_STATUSES)[number];

export const TURN_JOB_ACTIONS = ['turn', 'regenerate'] as const;
export type TurnJobAction = (typeof TURN_JOB_ACTIONS)[number];

export interface PublicTurnJobResult {
  assistantMessageId?: number;
  revision?: string;
}

export interface PublicTurnJobError {
  code: string;
}

/** 无 prompt、凭据、Provider 细节或内部 lease 的任务公开投影。 */
export interface PublicTurnJob {
  runId: string;
  sessionId: string;
  action: TurnJobAction;
  requestId: string;
  status: TurnJobStatus;
  round?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  version: number;
  result?: PublicTurnJobResult;
  error?: PublicTurnJobError;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && ISO_RE.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

export function isTurnJobStatus(value: unknown): value is TurnJobStatus {
  return typeof value === 'string' && (TURN_JOB_STATUSES as readonly string[]).includes(value);
}

export function isTurnJobAction(value: unknown): value is TurnJobAction {
  return typeof value === 'string' && (TURN_JOB_ACTIONS as readonly string[]).includes(value);
}

export function isPublicTurnJob(value: unknown): value is PublicTurnJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, [
    'runId', 'sessionId', 'action', 'requestId', 'status', 'round',
    'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'cancelRequestedAt',
    'version', 'result', 'error',
  ])) return false;
  if (!isSafeOpaqueId(row.runId) || !isSafeOpaqueId(row.sessionId)
    || !isSafeOpaqueId(row.requestId) || !isTurnJobAction(row.action)
    || !isTurnJobStatus(row.status) || !isIsoTimestamp(row.createdAt)
    || !isIsoTimestamp(row.updatedAt) || !Number.isInteger(row.version)
    || (row.version as number) < 1) return false;
  if (row.round !== undefined && (!Number.isInteger(row.round) || (row.round as number) < 1)) return false;
  for (const key of ['startedAt', 'finishedAt', 'cancelRequestedAt'] as const) {
    if (row[key] !== undefined && !isIsoTimestamp(row[key])) return false;
  }
  if (row.result !== undefined) {
    if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) return false;
    const result = row.result as Record<string, unknown>;
    if (!exactKeys(result, ['assistantMessageId', 'revision'])) return false;
    if (result.assistantMessageId !== undefined
      && (!Number.isInteger(result.assistantMessageId) || (result.assistantMessageId as number) < 1)) return false;
    if (result.revision !== undefined && !isSafeOpaqueId(result.revision)) return false;
  }
  if (row.error !== undefined) {
    if (!row.error || typeof row.error !== 'object' || Array.isArray(row.error)) return false;
    const error = row.error as Record<string, unknown>;
    if (!exactKeys(error, ['code']) || !isSafeOpaqueId(error.code, 80)) return false;
  }
  if (row.status === 'succeeded' && (!row.startedAt || !row.finishedAt || row.error !== undefined)) return false;
  if ((row.status === 'failed' || row.status === 'cancelled') && !row.finishedAt) return false;
  if ((row.status === 'queued' || row.status === 'running' || row.status === 'recovering') && row.finishedAt !== undefined) return false;
  if (row.status !== 'succeeded' && row.result !== undefined) return false;
  if (row.status !== 'failed' && row.error !== undefined) return false;
  return true;
}
