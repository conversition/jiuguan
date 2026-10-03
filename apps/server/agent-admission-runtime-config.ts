export interface AgentAdmissionRuntimeConfig {
  readonly mode: 'off' | 'shadow' | 'quality-beta';
  readonly enabled: boolean;
  readonly executionEnabled: boolean;
  readonly sessionAllowlist: ReadonlySet<string>;
}

const QUALITY_BETA_ACK = 'p14-quality-beta-v1';

function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set<string>();
  if (raw.length > 16_384) throw new Error('JG_AGENT_ADMISSION_SESSION_ALLOWLIST 过大');
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 256 || values.some((value) => value === '*' || value.length > 240
    || /[\u0000-\u001f]/u.test(value))) {
    throw new Error('JG_AGENT_ADMISSION_SESSION_ALLOWLIST 必须是最多 256 个精确会话 ID，禁止通配符');
  }
  return new Set(values);
}

/**
 * Q3 host ceiling. `quality-beta` is deliberately difficult to enable: it requires an
 * exact acknowledgement and a non-empty, wildcard-free session allowlist. Re-parse at
 * every new turn boundary to make the environment-backed global kill switch fail closed.
 */
export function parseAgentAdmissionRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentAdmissionRuntimeConfig {
  const mode = (env.JG_AGENT_ADMISSION ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off', enabled: false, executionEnabled: false, sessionAllowlist: new Set<string>(),
  });
  if (mode === 'shadow') return Object.freeze({
    mode: 'shadow', enabled: true, executionEnabled: false, sessionAllowlist: new Set<string>(),
  });
  if (mode !== 'quality-beta') throw new Error('JG_AGENT_ADMISSION 只允许 off、shadow 或 quality-beta');
  if (env.JG_AGENT_ADMISSION_ACK !== QUALITY_BETA_ACK) {
    throw new Error(`JG_AGENT_ADMISSION=quality-beta 需要 JG_AGENT_ADMISSION_ACK=${QUALITY_BETA_ACK}`);
  }
  const sessionAllowlist = parseAllowlist(env.JG_AGENT_ADMISSION_SESSION_ALLOWLIST);
  if (sessionAllowlist.size === 0) {
    throw new Error('quality-beta 需要非空 JG_AGENT_ADMISSION_SESSION_ALLOWLIST');
  }
  return Object.freeze({ mode: 'quality-beta', enabled: true, executionEnabled: true, sessionAllowlist });
}

export function agentAdmissionAllowsSession(
  config: AgentAdmissionRuntimeConfig,
  sessionId: string,
): boolean {
  return config.executionEnabled && config.sessionAllowlist.has(sessionId);
}
