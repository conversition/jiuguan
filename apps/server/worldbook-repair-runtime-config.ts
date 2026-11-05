import {
  parseRuntimeSessionScope,
  runtimeSessionScopeAllows,
  type RuntimeSessionScope,
} from './managed-local-session-scope.ts';

export const WORLDBOOK_REPAIR_RUNTIME_ACK = 'p14-worldbook-repair-test-session-v1' as const;

export interface WorldbookRepairRuntimeConfig {
  readonly mode: 'off' | 'test-session';
  readonly enabled: boolean;
  readonly sessionAllowlist: ReadonlySet<string>;
  readonly sessionScope: RuntimeSessionScope;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u;

function exactSessionAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set<string>();
  if (raw.length > 16_384) throw new Error('JG_WORLDBOOK_REPAIR_SESSION_IDS 过大');
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 256 || values.some((value) => value === '*' || !SESSION_ID_RE.test(value))) {
    throw new Error('JG_WORLDBOOK_REPAIR_SESSION_IDS 必须是最多 256 个精确会话 ID，禁止通配符');
  }
  return new Set(values);
}

/**
 * Independent forward-write ceiling for Worldbook repair. It is deliberately
 * separate from Maintenance lane admission: a model proposal does not imply
 * authority to approve or apply an asset mutation.
 */
export function parseWorldbookRepairRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorldbookRepairRuntimeConfig {
  const killSwitch = (env.JG_WORLDBOOK_REPAIR_KILL_SWITCH ?? '0').trim();
  if (killSwitch !== '0' && killSwitch !== '1') {
    throw new Error('JG_WORLDBOOK_REPAIR_KILL_SWITCH 只允许 0 或 1');
  }
  if (killSwitch === '1') return Object.freeze({
    mode: 'off', enabled: false, sessionAllowlist: new Set<string>(), sessionScope: 'exact',
  });
  const mode = (env.JG_WORLDBOOK_REPAIR ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off', enabled: false, sessionAllowlist: new Set<string>(), sessionScope: 'exact',
  });
  if (mode !== 'test-session') {
    throw new Error('JG_WORLDBOOK_REPAIR 只允许 off 或 test-session');
  }
  if (env.JG_WORLDBOOK_REPAIR_ACK !== WORLDBOOK_REPAIR_RUNTIME_ACK) {
    throw new Error(
      `JG_WORLDBOOK_REPAIR=test-session 需要 JG_WORLDBOOK_REPAIR_ACK=${WORLDBOOK_REPAIR_RUNTIME_ACK}`,
    );
  }
  const sessionAllowlist = exactSessionAllowlist(env.JG_WORLDBOOK_REPAIR_SESSION_IDS);
  const sessionScope = parseRuntimeSessionScope(env);
  if (sessionAllowlist.size === 0 && sessionScope === 'exact') {
    throw new Error('test-session 需要非空 JG_WORLDBOOK_REPAIR_SESSION_IDS 或显式 managed-local scope');
  }
  return Object.freeze({ mode: 'test-session', enabled: true, sessionAllowlist, sessionScope });
}

/** Used only by create/approve/apply; reject/revert remain recovery-capable. */
export function worldbookRepairForwardAllowsSession(
  config: WorldbookRepairRuntimeConfig,
  sessionId: string,
): boolean {
  return config.enabled
    && runtimeSessionScopeAllows(config.sessionScope, config.sessionAllowlist, sessionId);
}
