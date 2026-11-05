import { createHash, createHmac, randomBytes } from 'node:crypto';

export const AGENT_SKILL_SHADOW_PILOT_ACK = 'agent-skill-shadow-pilot-v1' as const;
export const AGENT_SKILL_SHADOW_ALL_ACK = 'agent-skill-shadow-all-v1' as const;

export type AgentSkillShadowRuntimeMode = 'off' | 'pilot' | 'all';

export type AgentSkillShadowRuntimeReason =
  | 'agent-skill-shadow-not-configured'
  | 'agent-skill-shadow-explicitly-off'
  | 'agent-skill-shadow-enabled'
  | 'agent-skill-shadow-mode-invalid'
  | 'agent-skill-shadow-ack-invalid'
  | 'agent-skill-shadow-session-allowlist-required'
  | 'agent-skill-shadow-session-allowlist-forbidden'
  | 'agent-skill-shadow-session-allowlist-empty'
  | 'agent-skill-shadow-session-allowlist-too-large'
  | 'agent-skill-shadow-session-id-invalid'
  | 'agent-skill-shadow-session-id-wildcard'
  | 'agent-skill-shadow-session-id-duplicate'
  | 'agent-skill-shadow-skill-allowlist-required'
  | 'agent-skill-shadow-skill-allowlist-empty'
  | 'agent-skill-shadow-skill-allowlist-too-large'
  | 'agent-skill-shadow-skill-id-invalid'
  | 'agent-skill-shadow-skill-id-wildcard'
  | 'agent-skill-shadow-skill-id-duplicate';

export interface PublicAgentSkillShadowRuntimeSummary {
  readonly mode: AgentSkillShadowRuntimeMode;
  readonly configured: boolean;
  readonly valid: boolean;
  readonly enabled: boolean;
  /** Stable machine-readable reason code. */
  readonly reason: AgentSkillShadowRuntimeReason;
  /** Zero means unrestricted only when mode is `all`; IDs are deliberately absent. */
  readonly sessionCount: number;
  readonly skillCount: number;
  readonly revision: string;
}

export interface AgentSkillShadowRuntimeConfig {
  readonly mode: AgentSkillShadowRuntimeMode;
  readonly configured: boolean;
  readonly valid: boolean;
  readonly enabled: boolean;
  readonly reasonCode: AgentSkillShadowRuntimeReason;
  readonly configRevision: string;
  /** Exact immutable allowlist. It is intentionally not part of the public summary. */
  readonly allowedSkillIds: readonly string[];
  readonly publicSummary: PublicAgentSkillShadowRuntimeSummary;
  /** Pilot membership is exact; `all` accepts every syntactically valid session ID. */
  allowsSession(sessionId: string): boolean;
}

const CONFIG_REVISION_VERSION = 'agent-skill-shadow-runtime-config-v1' as const;
const SESSION_ALLOWLIST_ENV = 'JG_AGENT_SKILL_SHADOW_SESSION_ALLOWLIST' as const;
const SKILL_ALLOWLIST_ENV = 'JG_AGENT_SKILL_SHADOW_SKILL_ALLOWLIST' as const;
const MAX_SESSION_IDS = 256;
const MAX_SKILL_IDS = 64;
const MAX_LIST_CHARS = 65_536;
const SKILL_ID_RE = /^skill:sha256:[a-f0-9]{64}$/u;
// Public readers can enumerate session IDs elsewhere, so never expose a plain hash of the exact
// allowlists. This process-local key preserves change detection without creating a membership oracle.
const PUBLIC_CONFIG_REVISION_KEY = randomBytes(32);

class ConfigParseError extends Error {
  constructor(readonly reasonCode: AgentSkillShadowRuntimeReason) {
    super(reasonCode);
    this.name = 'AgentSkillShadowRuntimeConfigParseError';
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function publicConfigRevision(configRevision: string): string {
  return `hmac-sha256:${createHmac('sha256', PUBLIC_CONFIG_REVISION_KEY)
    .update(configRevision, 'utf8').digest('hex')}`;
}

function canonicalRevision(input: Readonly<{
  mode: AgentSkillShadowRuntimeMode;
  configured: boolean;
  valid: boolean;
  reasonCode: AgentSkillShadowRuntimeReason;
  sessionIds: readonly string[];
  skillIds: readonly string[];
}>): string {
  // Every array is sorted before this boundary and object key order is fixed here.
  return sha256(JSON.stringify({
    version: CONFIG_REVISION_VERSION,
    mode: input.mode,
    configured: input.configured,
    valid: input.valid,
    reasonCode: input.reasonCode,
    sessionIds: input.sessionIds,
    skillIds: input.skillIds,
  }));
}

function exactSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 240
    && value === value.normalize('NFC')
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.includes('*');
}

function listValues(
  raw: string | undefined,
  options: Readonly<{
    requiredReason: AgentSkillShadowRuntimeReason;
    emptyReason: AgentSkillShadowRuntimeReason;
    tooLargeReason: AgentSkillShadowRuntimeReason;
    wildcardReason: AgentSkillShadowRuntimeReason;
    invalidReason: AgentSkillShadowRuntimeReason;
    duplicateReason: AgentSkillShadowRuntimeReason;
    maximum: number;
    valid: (value: string) => boolean;
  }>,
): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) throw new ConfigParseError(options.requiredReason);
  if (raw.length > MAX_LIST_CHARS) throw new ConfigParseError(options.tooLargeReason);
  const values = raw.split(',').map((value) => value.trim());
  if (values.some((value) => value.length === 0)) throw new ConfigParseError(options.emptyReason);
  if (values.length > options.maximum) throw new ConfigParseError(options.tooLargeReason);
  if (values.some((value) => value.includes('*'))) throw new ConfigParseError(options.wildcardReason);
  if (values.some((value) => !options.valid(value))) throw new ConfigParseError(options.invalidReason);
  if (new Set(values).size !== values.length) throw new ConfigParseError(options.duplicateReason);
  return Object.freeze([...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function sessionIds(raw: string | undefined): readonly string[] {
  return listValues(raw, {
    requiredReason: 'agent-skill-shadow-session-allowlist-required',
    emptyReason: 'agent-skill-shadow-session-allowlist-empty',
    tooLargeReason: 'agent-skill-shadow-session-allowlist-too-large',
    wildcardReason: 'agent-skill-shadow-session-id-wildcard',
    invalidReason: 'agent-skill-shadow-session-id-invalid',
    duplicateReason: 'agent-skill-shadow-session-id-duplicate',
    maximum: MAX_SESSION_IDS,
    valid: exactSessionId,
  });
}

function skillIds(raw: string | undefined): readonly string[] {
  return listValues(raw, {
    requiredReason: 'agent-skill-shadow-skill-allowlist-required',
    emptyReason: 'agent-skill-shadow-skill-allowlist-empty',
    tooLargeReason: 'agent-skill-shadow-skill-allowlist-too-large',
    wildcardReason: 'agent-skill-shadow-skill-id-wildcard',
    invalidReason: 'agent-skill-shadow-skill-id-invalid',
    duplicateReason: 'agent-skill-shadow-skill-id-duplicate',
    maximum: MAX_SKILL_IDS,
    valid: (value) => SKILL_ID_RE.test(value),
  });
}

function createConfig(input: Readonly<{
  mode: AgentSkillShadowRuntimeMode;
  configured: boolean;
  valid: boolean;
  reasonCode: AgentSkillShadowRuntimeReason;
  sessionIds?: readonly string[];
  skillIds?: readonly string[];
}>): AgentSkillShadowRuntimeConfig {
  const exactSessions = input.sessionIds ?? Object.freeze([]);
  const exactSkills = input.skillIds ?? Object.freeze([]);
  const sessionSet = new Set(exactSessions);
  const enabled = input.valid && input.mode !== 'off';
  const configRevision = canonicalRevision({
    mode: input.mode,
    configured: input.configured,
    valid: input.valid,
    reasonCode: input.reasonCode,
    sessionIds: exactSessions,
    skillIds: exactSkills,
  });
  const publicSummary: PublicAgentSkillShadowRuntimeSummary = Object.freeze({
    mode: input.mode,
    configured: input.configured,
    valid: input.valid,
    enabled,
    reason: input.reasonCode,
    sessionCount: input.mode === 'all' ? 0 : exactSessions.length,
    skillCount: exactSkills.length,
    revision: publicConfigRevision(configRevision),
  });
  return Object.freeze({
    mode: input.mode,
    configured: input.configured,
    valid: input.valid,
    enabled,
    reasonCode: input.reasonCode,
    configRevision,
    allowedSkillIds: exactSkills,
    publicSummary,
    allowsSession(sessionId: string): boolean {
      if (!enabled || typeof sessionId !== 'string' || !exactSessionId(sessionId)) return false;
      return input.mode === 'all' || sessionSet.has(sessionId);
    },
  });
}

function invalidConfig(
  configured: boolean,
  reasonCode: AgentSkillShadowRuntimeReason,
): AgentSkillShadowRuntimeConfig {
  return createConfig({ mode: 'off', configured, valid: false, reasonCode });
}

/**
 * Parse the opt-in Agent Skill selector shadow ceiling without ever throwing into server startup.
 * `1` is only a spelling alias for `pilot`: ACK and both exact allowlists remain mandatory.
 * This module does not wire the selector, read the catalog or authorize Prompt consumption.
 */
export function parseAgentSkillShadowRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentSkillShadowRuntimeConfig {
  const rawMode = env.JG_AGENT_SKILL_SHADOW;
  const configured = rawMode !== undefined;
  if (rawMode === undefined) {
    return createConfig({
      mode: 'off', configured: false, valid: true,
      reasonCode: 'agent-skill-shadow-not-configured',
    });
  }
  const normalizedMode = rawMode.trim().toLowerCase();
  if (normalizedMode === 'off' || normalizedMode === '0' || normalizedMode === 'false') {
    return createConfig({
      mode: 'off', configured: true, valid: true,
      reasonCode: 'agent-skill-shadow-explicitly-off',
    });
  }
  const mode = normalizedMode === '1' ? 'pilot' : normalizedMode;
  if (mode !== 'pilot' && mode !== 'all') {
    return invalidConfig(true, 'agent-skill-shadow-mode-invalid');
  }

  const expectedAck = mode === 'pilot' ? AGENT_SKILL_SHADOW_PILOT_ACK : AGENT_SKILL_SHADOW_ALL_ACK;
  if (env.JG_AGENT_SKILL_SHADOW_ACK !== expectedAck) {
    return invalidConfig(true, 'agent-skill-shadow-ack-invalid');
  }

  try {
    const exactSkills = skillIds(env[SKILL_ALLOWLIST_ENV]);
    if (mode === 'all') {
      if (env[SESSION_ALLOWLIST_ENV]?.trim()) {
        throw new ConfigParseError('agent-skill-shadow-session-allowlist-forbidden');
      }
      return createConfig({
        mode, configured: true, valid: true,
        reasonCode: 'agent-skill-shadow-enabled',
        skillIds: exactSkills,
      });
    }
    const exactSessions = sessionIds(env[SESSION_ALLOWLIST_ENV]);
    return createConfig({
      mode, configured: true, valid: true,
      reasonCode: 'agent-skill-shadow-enabled',
      sessionIds: exactSessions,
      skillIds: exactSkills,
    });
  } catch (error) {
    return invalidConfig(
      true,
      error instanceof ConfigParseError ? error.reasonCode : 'agent-skill-shadow-mode-invalid',
    );
  }
}

export function agentSkillShadowAllowsSession(
  config: AgentSkillShadowRuntimeConfig,
  sessionId: string,
): boolean {
  return config.allowsSession(sessionId);
}

export function agentSkillShadowAllowedSkillIds(
  config: AgentSkillShadowRuntimeConfig,
): readonly string[] {
  return config.allowedSkillIds;
}

export function publicAgentSkillShadowRuntimeSummary(
  config: AgentSkillShadowRuntimeConfig,
): PublicAgentSkillShadowRuntimeSummary {
  return config.publicSummary;
}
