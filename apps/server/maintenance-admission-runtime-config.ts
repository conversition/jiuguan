export interface MaintenanceAdmissionRuntimeConfig {
  readonly mode: 'off' | 'shadow' | 'enforce';
  readonly enabled: boolean;
  readonly executionEnabled: boolean;
  readonly sessionAllowlist: ReadonlySet<string>;
  readonly sessionBudgetLimit: number;
  readonly dailyBudgetLimit: number;
}

export const MAINTENANCE_ENFORCE_ACK = 'p14-maintenance-enforce-v2' as const;
export const DEFAULT_MAINTENANCE_SESSION_BUDGET_24H = 16 as const;
export const DEFAULT_MAINTENANCE_DAILY_BUDGET_24H = 32 as const;
export const MAX_MAINTENANCE_DAILY_BUDGET_24H = 32 as const;

function parseBudgetLimit(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error(`${name} 必须是 1-${MAX_MAINTENANCE_DAILY_BUDGET_24H} 的十进制整数`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MAINTENANCE_DAILY_BUDGET_24H) {
    throw new Error(`${name} 必须是 1-${MAX_MAINTENANCE_DAILY_BUDGET_24H} 的十进制整数`);
  }
  return parsed;
}

function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set<string>();
  if (raw.length > 16_384) throw new Error('JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST 过大');
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 256 || values.some((value) => value === '*' || value.length > 240
    || /[\u0000-\u001f]/u.test(value))) {
    throw new Error('JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST 必须是最多 256 个精确会话 ID，禁止通配符');
  }
  return new Set(values);
}

/**
 * Q8 host ceiling. Enforce only authorizes queue selection for exact sessions;
 * it does not authorize maintenance proposal apply or expand Provider/tool rights.
 */
export function parseMaintenanceAdmissionRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MaintenanceAdmissionRuntimeConfig {
  const sessionBudgetLimit = parseBudgetLimit(
    env.JG_MAINTENANCE_SESSION_BUDGET_24H,
    'JG_MAINTENANCE_SESSION_BUDGET_24H',
    DEFAULT_MAINTENANCE_SESSION_BUDGET_24H,
  );
  const dailyBudgetLimit = parseBudgetLimit(
    env.JG_MAINTENANCE_DAILY_BUDGET_24H,
    'JG_MAINTENANCE_DAILY_BUDGET_24H',
    DEFAULT_MAINTENANCE_DAILY_BUDGET_24H,
  );
  if (sessionBudgetLimit > dailyBudgetLimit) {
    throw new Error('JG_MAINTENANCE_SESSION_BUDGET_24H 不得超过 JG_MAINTENANCE_DAILY_BUDGET_24H');
  }
  const mode = (env.JG_MAINTENANCE_ADMISSION ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off',
    enabled: false,
    executionEnabled: false,
    sessionAllowlist: new Set<string>(),
    sessionBudgetLimit,
    dailyBudgetLimit,
  });
  if (mode === 'shadow') return Object.freeze({
    mode: 'shadow',
    enabled: true,
    executionEnabled: false,
    sessionAllowlist: new Set<string>(),
    sessionBudgetLimit,
    dailyBudgetLimit,
  });
  if (mode !== 'enforce') {
    throw new Error('JG_MAINTENANCE_ADMISSION 只允许 off、shadow 或 enforce');
  }
  if (env.JG_MAINTENANCE_ADMISSION_ACK !== MAINTENANCE_ENFORCE_ACK) {
    throw new Error(
      'JG_MAINTENANCE_ADMISSION=enforce 需要 JG_MAINTENANCE_ADMISSION_ACK=' + MAINTENANCE_ENFORCE_ACK,
    );
  }
  const sessionAllowlist = parseAllowlist(env.JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST);
  if (sessionAllowlist.size === 0) {
    throw new Error('enforce 需要非空 JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST');
  }
  return Object.freeze({
    mode: 'enforce',
    enabled: true,
    executionEnabled: true,
    sessionAllowlist,
    sessionBudgetLimit,
    dailyBudgetLimit,
  });
}

export function maintenanceAdmissionAllowsSession(
  config: MaintenanceAdmissionRuntimeConfig,
  sessionId: string,
): boolean {
  return config.executionEnabled && config.sessionAllowlist.has(sessionId);
}
