import {
  MANAGED_LOCAL_SESSION_SCOPE_VERSION,
  parseRuntimeSessionScope,
  runtimeSessionScopeAllows,
  type RuntimeSessionScope,
} from './managed-local-session-scope.ts';

export const MAINTENANCE_APPLY_ACK = 'p14-maintenance-apply-v1' as const;
export const MAINTENANCE_GUARDED_AUTO_ACK = 'p14-npc-guarded-auto-v1' as const;
export const MAINTENANCE_APPLY_SCOPE_ACK = 'p14-maintenance-apply-managed-local-v1' as const;

export type MaintenanceApplyMode = 'off' | 'approval' | 'guarded-auto';

export interface MaintenanceApplyRuntimeConfig {
  readonly mode: MaintenanceApplyMode;
  readonly enabled: boolean;
  /** Only NPC proposals classified by the pure safety policy may use this path. */
  readonly guardedAutoEnabled: boolean;
  /** Exact operator-approval entries retained for legacy sessions. */
  readonly approvalSessionAllowlist: ReadonlySet<string>;
  /** Explicitly acknowledged operator-approval scope; managed-local never includes opaque/legacy ids. */
  readonly approvalSessionScope: RuntimeSessionScope;
  readonly sessionAllowlist: ReadonlySet<string>;
  /** Managed scope is consumed only by the NPC guarded-auto predicate below. */
  readonly npcSessionScope: RuntimeSessionScope;
}

export interface MaintenanceApplyRuntimeOptions {
  /** Sessions with a validated on-disk NPC activation marker. */
  readonly npcActivationSessions?: ReadonlySet<string>;
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

function parseApprovalSessionScope(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeSessionScope {
  const raw = env.JG_MAINTENANCE_APPLY_SCOPE?.trim();
  const acknowledgement = env.JG_MAINTENANCE_APPLY_SCOPE_ACK?.trim();
  if (!raw) {
    if (acknowledgement) {
      throw new Error('JG_MAINTENANCE_APPLY_SCOPE_ACK 不能脱离显式 apply scope 使用');
    }
    return 'exact';
  }
  if (raw !== MANAGED_LOCAL_SESSION_SCOPE_VERSION) {
    throw new Error(`JG_MAINTENANCE_APPLY_SCOPE 只允许 ${MANAGED_LOCAL_SESSION_SCOPE_VERSION}`);
  }
  if (acknowledgement !== MAINTENANCE_APPLY_SCOPE_ACK) {
    throw new Error(
      `JG_MAINTENANCE_APPLY_SCOPE=${MANAGED_LOCAL_SESSION_SCOPE_VERSION} 需要 `
      + `JG_MAINTENANCE_APPLY_SCOPE_ACK=${MAINTENANCE_APPLY_SCOPE_ACK}`,
    );
  }
  if (parseRuntimeSessionScope(env) !== MANAGED_LOCAL_SESSION_SCOPE_VERSION) {
    throw new Error('Maintenance apply managed-local scope 需要启用受管本机会话边界');
  }
  return MANAGED_LOCAL_SESSION_SCOPE_VERSION;
}

/** Independent business-write gate; local admin authority alone never grants apply. */
export function parseMaintenanceApplyRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: MaintenanceApplyRuntimeOptions = {},
): MaintenanceApplyRuntimeConfig {
  const mode = (env.JG_MAINTENANCE_APPLY ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off', enabled: false, guardedAutoEnabled: false, sessionAllowlist: new Set<string>(),
    approvalSessionAllowlist: new Set<string>(),
    approvalSessionScope: 'exact',
    npcSessionScope: 'exact',
  });
  if (mode !== 'approval' && mode !== 'guarded-auto') {
    throw new Error('JG_MAINTENANCE_APPLY 只允许 off、approval 或 guarded-auto');
  }
  if (env.JG_MAINTENANCE_APPLY_ACK !== MAINTENANCE_APPLY_ACK) {
    throw new Error(`JG_MAINTENANCE_APPLY=${mode} 需要 JG_MAINTENANCE_APPLY_ACK=${MAINTENANCE_APPLY_ACK}`);
  }
  if (mode === 'guarded-auto'
    && env.JG_MAINTENANCE_GUARDED_AUTO_ACK !== MAINTENANCE_GUARDED_AUTO_ACK) {
    throw new Error(
      `JG_MAINTENANCE_APPLY=guarded-auto 需要 JG_MAINTENANCE_GUARDED_AUTO_ACK=${MAINTENANCE_GUARDED_AUTO_ACK}`,
    );
  }
  const configuredSessions = exactSessions(env.JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST);
  const approvalSessionScope = parseApprovalSessionScope(env);
  const npcSessionScope = mode === 'guarded-auto' ? parseRuntimeSessionScope(env) : 'exact';
  if (configuredSessions.size === 0
    && approvalSessionScope !== MANAGED_LOCAL_SESSION_SCOPE_VERSION
    && !(mode === 'guarded-auto' && npcSessionScope === 'managed-local-v1')) {
    throw new Error(`${mode} 需要非空 JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST`);
  }
  // Guarded auto is a production write gate. A committed launcher profile is only
  // configuration; it cannot substitute for the backup-bound activation ceremony.
  const sessionAllowlist = mode === 'guarded-auto'
    ? new Set([...configuredSessions].filter((sessionId) => options.npcActivationSessions?.has(sessionId)))
    : configuredSessions;
  return Object.freeze({
    mode,
    enabled: configuredSessions.size > 0 || sessionAllowlist.size > 0
      || approvalSessionScope === MANAGED_LOCAL_SESSION_SCOPE_VERSION
      || npcSessionScope === 'managed-local-v1',
    guardedAutoEnabled: mode === 'guarded-auto'
      && (sessionAllowlist.size > 0 || npcSessionScope === 'managed-local-v1'),
    sessionAllowlist,
    approvalSessionAllowlist: configuredSessions,
    approvalSessionScope,
    npcSessionScope,
  });
}

export function maintenanceApplyAllowsSession(config: MaintenanceApplyRuntimeConfig, sessionId: string): boolean {
  return config.enabled
    && runtimeSessionScopeAllows(
      config.approvalSessionScope,
      config.approvalSessionAllowlist,
      sessionId,
    );
}

function maintenanceAutomaticApplyAllowsSession(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
): boolean {
  // Autonomous memory/summary commits require the stronger guarded-auto mode,
  // then reuse the separately acknowledged apply scope. A bare managed-local
  // host scope is insufficient: only JG_MAINTENANCE_APPLY_SCOPE=managed-local-v1
  // (or an exact allowlist entry) can authorize a business write.
  return config.mode === 'guarded-auto'
    && maintenanceApplyAllowsSession(config, sessionId);
}

export function maintenanceGuardedAutoAllowsSession(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
): boolean {
  return config.guardedAutoEnabled && config.sessionAllowlist.has(sessionId);
}

/**
 * NPC-only just-in-time apply scope. Canonical identity is only the host ceiling;
 * the server must still prove the DB is local/existing and acquire a revision-bound
 * backup before invoking the typed committer.
 */
export function maintenanceGuardedAutoAllowsNpcSession(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
): boolean {
  return config.mode === 'guarded-auto'
    && config.guardedAutoEnabled
    && runtimeSessionScopeAllows(config.npcSessionScope, config.sessionAllowlist, sessionId);
}

export type MaintenanceProposalApplyTaskKind =
  | 'memory_consolidation'
  | 'branch_index'
  | 'rolling_summary'
  | 'npc_state';

/**
 * Autonomous memory/summary commits require both guarded-auto acknowledgement
 * and the independently acknowledged apply scope. Canonical managed-local identity
 * alone is never sufficient; a managed-local automatic write is possible only when
 * JG_MAINTENANCE_APPLY_SCOPE explicitly grants that business-write boundary.
 *
 * The server uses this same predicate when selecting the job mode and again
 * immediately before commit so a queued/stale apply mode cannot widen scope.
 */
export function maintenanceMemorySummaryApplyMode(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
  taskKind: MaintenanceProposalApplyTaskKind,
): 'shadow' | 'apply' {
  // branch_index（剧情弧）的提案只更新可重建投影（arc_projection），不触碰正文、世界书或
  // 角色权威事实，且写入具备 rollbackRun 回滚路径；它与 memory/summary 同属可自动落库的低风险
  // 维护产物。人工逐条点批在生产里不可行，因此纳入自动写入范围 —— 但仍受 guarded-auto +
  // 独立 acknowledge 的 apply scope 双重约束，任一条不满足即回退 shadow（只产提案不落库）。
  if (taskKind !== 'memory_consolidation' && taskKind !== 'rolling_summary'
    && taskKind !== 'branch_index') return 'shadow';
  return config.mode === 'guarded-auto'
    && maintenanceAutomaticApplyAllowsSession(config, sessionId)
    ? 'apply'
    : 'shadow';
}

/** Final mutation-boundary counterpart to `maintenanceMemorySummaryApplyMode`. */
export function assertMaintenanceMemorySummaryCommitAllowed(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
  taskKind: MaintenanceProposalApplyTaskKind,
): void {
  if (maintenanceMemorySummaryApplyMode(config, sessionId, taskKind) !== 'apply') {
    throw new Error('maintenance-apply-session-not-allowed');
  }
}

/**
 * Public control availability follows the explicitly acknowledged approval scope
 * for every proposal kind whose typed committer and rollback path are complete.
 */
export function maintenanceProposalApplySupported(
  config: MaintenanceApplyRuntimeConfig,
  sessionId: string,
  taskKind: MaintenanceProposalApplyTaskKind,
): boolean {
  // Guarded automatic apply remains NPC-only outside exact entries. The dedicated
  // apply scope may broaden operator-approved writes without broadening autonomous
  // memory/summary commits.
  if (config.mode === 'guarded-auto') {
    return taskKind === 'npc_state'
      ? maintenanceGuardedAutoAllowsNpcSession(config, sessionId)
      : maintenanceApplyAllowsSession(config, sessionId)
        && (taskKind === 'memory_consolidation' || taskKind === 'branch_index'
          || taskKind === 'rolling_summary');
  }
  return maintenanceApplyAllowsSession(config, sessionId)
    && (taskKind === 'memory_consolidation' || taskKind === 'branch_index'
      || taskKind === 'rolling_summary' || taskKind === 'npc_state');
}
