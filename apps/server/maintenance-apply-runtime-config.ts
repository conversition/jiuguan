export const MAINTENANCE_APPLY_ACK = 'p14-maintenance-apply-v1' as const;

export interface MaintenanceApplyRuntimeConfig {
  readonly enabled: boolean;
  readonly sessionAllowlist: ReadonlySet<string>;
}

function exactSessions(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set<string>();
  if (raw.length > 16_384) throw new Error('JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST 过大');
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 256 || values.some((value) => value === '*' || value.length > 240
    || /[\u0000-\u001f]/u.test(value))) {
    throw new Error('JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST 必须是最多 256 个精确会话 ID，禁止通配符');
  }
  return new Set(values);
}

/** Independent business-write gate; local admin authority alone never grants apply. */
export function parseMaintenanceApplyRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MaintenanceApplyRuntimeConfig {
  const mode = (env.JG_MAINTENANCE_APPLY ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({ enabled: false, sessionAllowlist: new Set<string>() });
  if (mode !== 'approval') throw new Error('JG_MAINTENANCE_APPLY 只允许 off 或 approval');
  if (env.JG_MAINTENANCE_APPLY_ACK !== MAINTENANCE_APPLY_ACK) {
    throw new Error(`JG_MAINTENANCE_APPLY=approval 需要 JG_MAINTENANCE_APPLY_ACK=${MAINTENANCE_APPLY_ACK}`);
  }
  const sessionAllowlist = exactSessions(env.JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST);
  if (sessionAllowlist.size === 0) throw new Error('approval 需要非空 JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST');
  return Object.freeze({ enabled: true, sessionAllowlist });
}

export function maintenanceApplyAllowsSession(config: MaintenanceApplyRuntimeConfig, sessionId: string): boolean {
  return config.enabled && config.sessionAllowlist.has(sessionId);
}

export type MaintenanceProposalApplyTaskKind = 'branch_index' | 'npc_state';

/**
 * Public control availability follows the same exact-session business-write gate
 * for every proposal kind whose typed committer and rollback path are complete.
 */
export function maintenanceProposalApplySupported(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
  taskKind: MaintenanceProposalApplyTaskKind,
): boolean {
  return (taskKind === 'branch_index' || taskKind === 'npc_state')
    && maintenanceApplyAllowsSession(config, sessionId);
}
