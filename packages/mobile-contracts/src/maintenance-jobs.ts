import { isSafeOpaqueId } from './http.ts';

export const MAINTENANCE_TASK_KINDS = [
  'memory_consolidation',
  'branch_index',
  'rolling_summary',
  'npc_state',
] as const;
export type MaintenanceTaskKind = typeof MAINTENANCE_TASK_KINDS[number];
export const MAINTENANCE_TRIGGERS = ['post-turn', 'idle', 'manual'] as const;
export type MaintenanceTrigger = typeof MAINTENANCE_TRIGGERS[number];
export const MAINTENANCE_MODES = ['shadow', 'apply'] as const;
export type MaintenanceMode = typeof MAINTENANCE_MODES[number];
export const MAINTENANCE_STATUSES = [
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale',
] as const;
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number];

export interface PublicMaintenanceBudget {
  readonly stepsUsed: number;
  readonly modelCallsUsed: number;
  readonly toolCallsUsed: number;
  readonly writesUsed: number;
  readonly tokensUsed: number;
  readonly wallMsUsed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}

export interface PublicMaintenanceJob {
  readonly runId: string;
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly sourceRevision: string;
  readonly policyVersion: string;
  readonly parentRunId?: string;
  readonly trigger: MaintenanceTrigger;
  readonly mode: MaintenanceMode;
  readonly status: MaintenanceStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly budget?: PublicMaintenanceBudget;
  readonly proposal?: {
    readonly digest: string;
    readonly disposition: 'shadow' | 'committed' | 'stale';
    readonly diff: Record<string, unknown>;
  };
}

export interface MaintenanceSettings {
  readonly globalEnabled: boolean;
  readonly defaultMode: MaintenanceMode;
  readonly sessionEnabled: boolean;
  readonly effectiveEnabled: boolean;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const exact = (row: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(row).every((key) => allowed.has(key));
};
const iso = (value: unknown): value is string => typeof value === 'string' && ISO_RE.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function isMaintenanceTaskKind(value: unknown): value is MaintenanceTaskKind {
  return typeof value === 'string' && (MAINTENANCE_TASK_KINDS as readonly string[]).includes(value);
}
export function isMaintenanceTrigger(value: unknown): value is MaintenanceTrigger {
  return typeof value === 'string' && (MAINTENANCE_TRIGGERS as readonly string[]).includes(value);
}
export function isMaintenanceMode(value: unknown): value is MaintenanceMode {
  return typeof value === 'string' && (MAINTENANCE_MODES as readonly string[]).includes(value);
}
export function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  return typeof value === 'string' && (MAINTENANCE_STATUSES as readonly string[]).includes(value);
}

export function isMaintenanceSettings(value: unknown): value is MaintenanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exact(row, ['globalEnabled', 'defaultMode', 'sessionEnabled', 'effectiveEnabled'])
    && typeof row.globalEnabled === 'boolean' && isMaintenanceMode(row.defaultMode)
    && typeof row.sessionEnabled === 'boolean' && typeof row.effectiveEnabled === 'boolean'
    && row.effectiveEnabled === (row.globalEnabled && row.sessionEnabled);
}

export function isPublicMaintenanceJob(value: unknown): value is PublicMaintenanceJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exact(row, [
    'runId', 'sessionId', 'taskKind', 'sourceRevision', 'policyVersion', 'parentRunId',
    'trigger', 'mode', 'status', 'attempt', 'createdAt', 'updatedAt', 'startedAt',
    'finishedAt', 'errorCode', 'budget', 'proposal',
  ])) return false;
  if (!isSafeOpaqueId(row.runId) || !isSafeOpaqueId(row.sessionId)
    || !isMaintenanceTaskKind(row.taskKind) || !isSafeOpaqueId(row.sourceRevision)
    || !isSafeOpaqueId(row.policyVersion) || !isMaintenanceTrigger(row.trigger)
    || !isMaintenanceMode(row.mode) || !isMaintenanceStatus(row.status)
    || !integer(row.attempt) || !iso(row.createdAt) || !iso(row.updatedAt)) return false;
  if (row.parentRunId !== undefined && !isSafeOpaqueId(row.parentRunId)) return false;
  if (row.errorCode !== undefined && !isSafeOpaqueId(row.errorCode, 80)) return false;
  for (const key of ['startedAt', 'finishedAt'] as const) {
    if (row[key] !== undefined && !iso(row[key])) return false;
  }
  if (row.budget !== undefined) {
    if (!row.budget || typeof row.budget !== 'object' || Array.isArray(row.budget)) return false;
    const budget = row.budget as Record<string, unknown>;
    const keys = ['stepsUsed', 'modelCallsUsed', 'toolCallsUsed', 'writesUsed', 'tokensUsed',
      'wallMsUsed', 'inputTokens', 'outputTokens', 'costMicrousd'] as const;
    if (!exact(budget, keys) || keys.some((key) => !integer(budget[key]))) return false;
  }
  if (row.proposal !== undefined) {
    if (!row.proposal || typeof row.proposal !== 'object' || Array.isArray(row.proposal)) return false;
    const proposal = row.proposal as Record<string, unknown>;
    if (!exact(proposal, ['digest', 'disposition', 'diff']) || !isSafeOpaqueId(proposal.digest)
      || !['shadow', 'committed', 'stale'].includes(String(proposal.disposition))
      || !proposal.diff || typeof proposal.diff !== 'object' || Array.isArray(proposal.diff)) return false;
    try {
      if (JSON.stringify(proposal.diff).length > 65_536) return false;
    } catch { return false; }
  }
  if (['queued', 'running'].includes(row.status as string) && row.finishedAt !== undefined) return false;
  if (['succeeded', 'failed', 'cancelled', 'stale'].includes(row.status as string) && !row.finishedAt) return false;
  if (row.status === 'running' && !row.startedAt) return false;
  return true;
}
