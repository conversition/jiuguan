import { createHash } from 'node:crypto';

export const AGENT_BUDGET_PROFILE_VERSION = 'p14-agent-budget-v2' as const;

export const AGENT_AUTONOMY_PROFILES = Object.freeze([
  'legacy',
  'balanced',
  'quality-beta',
] as const);

export const AGENT_BUDGET_LANES = Object.freeze([
  'interactive',
  'preference',
  'style',
  'arc',
  'npc',
  'critic',
] as const);

export type AgentAutonomyProfile = (typeof AGENT_AUTONOMY_PROFILES)[number];
export type AgentBudgetLane = (typeof AGENT_BUDGET_LANES)[number];

/**
 * One normalized ceiling shared by Router, Ticket, Gateway and a bounded runner.
 * Input/output fields are aggregate Agent-lane allowances. The interactive lane
 * uses them for Prelude/Director. Final reserves are separate so optional work
 * can never silently consume the final game_turn's required context/output.
 */
export interface AgentBudgetProfileV2 {
  readonly version: typeof AGENT_BUDGET_PROFILE_VERSION;
  readonly autonomyProfile: AgentAutonomyProfile;
  readonly lane: AgentBudgetLane;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxWrites: number;
  readonly agentInputBudgetTokens: number;
  readonly agentOutputBudgetTokens: number;
  readonly finalContextReserveTokens: number;
  readonly finalOutputReserveTokens: number;
  readonly providerContextWindowTokens: number;
  readonly maxCostMicrousd: number;
  readonly maxWallMs: number;
  readonly maxToolResultChars: number;
  readonly maxFinalChars: number;
  readonly maxTraceSteps: number;
}

export type AgentBudgetProfileInput = Omit<AgentBudgetProfileV2, 'version'> & {
  readonly version?: typeof AGENT_BUDGET_PROFILE_VERSION;
};

export type AgentBudgetFeasibilityReason =
  | 'agent-request-exceeds-provider-context'
  | 'final-reserve-insufficient'
  | 'provider-context-insufficient';

export type AgentBudgetFeasibility = Readonly<{
  ok: true;
  requiredFinalContextTokens: number;
  effectiveFinalOutputTokens: number;
}> | Readonly<{
  ok: false;
  reason: AgentBudgetFeasibilityReason;
  requiredFinalContextTokens: number;
  effectiveFinalOutputTokens: number;
}>;

const PROFILE_KEYS = new Set<keyof AgentBudgetProfileV2>([
  'version', 'autonomyProfile', 'lane', 'maxSteps', 'maxModelCalls', 'maxToolCalls', 'maxWrites',
  'agentInputBudgetTokens', 'agentOutputBudgetTokens', 'finalContextReserveTokens',
  'finalOutputReserveTokens', 'providerContextWindowTokens', 'maxCostMicrousd', 'maxWallMs',
  'maxToolResultChars', 'maxFinalChars', 'maxTraceSteps',
]);

const UPPER_BOUND_FIELDS = Object.freeze([
  'maxSteps', 'maxModelCalls', 'maxToolCalls', 'maxWrites', 'agentInputBudgetTokens',
  'agentOutputBudgetTokens', 'providerContextWindowTokens', 'maxCostMicrousd', 'maxWallMs',
  'maxToolResultChars', 'maxFinalChars', 'maxTraceSteps',
] as const satisfies readonly (keyof AgentBudgetProfileV2)[]);

const MINIMUM_RESERVE_FIELDS = Object.freeze([
  'finalContextReserveTokens', 'finalOutputReserveTokens',
] as const satisfies readonly (keyof AgentBudgetProfileV2)[]);

const PROFILE_RANK: Readonly<Record<AgentAutonomyProfile, number>> = Object.freeze({
  legacy: 0,
  balanced: 1,
  'quality-beta': 2,
});

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function safeAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new TypeError(`${label} exceeds safe integer range`);
  return sum;
}

export function normalizeAgentBudgetProfile(input: AgentBudgetProfileInput): AgentBudgetProfileV2 {
  assertPlainRecord(input, 'agentBudgetProfile');
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key as keyof AgentBudgetProfileV2)) {
      throw new TypeError(`agentBudgetProfile contains unsupported field: ${key}`);
    }
  }
  const version = input.version ?? AGENT_BUDGET_PROFILE_VERSION;
  if (version !== AGENT_BUDGET_PROFILE_VERSION) throw new TypeError('agentBudgetProfile.version is invalid');
  const normalized: AgentBudgetProfileV2 = {
    version,
    autonomyProfile: enumValue(input.autonomyProfile, AGENT_AUTONOMY_PROFILES, 'autonomyProfile'),
    lane: enumValue(input.lane, AGENT_BUDGET_LANES, 'lane'),
    maxSteps: safeInteger(input.maxSteps, 'maxSteps'),
    maxModelCalls: safeInteger(input.maxModelCalls, 'maxModelCalls'),
    maxToolCalls: safeInteger(input.maxToolCalls, 'maxToolCalls'),
    maxWrites: safeInteger(input.maxWrites, 'maxWrites'),
    agentInputBudgetTokens: safeInteger(input.agentInputBudgetTokens, 'agentInputBudgetTokens'),
    agentOutputBudgetTokens: safeInteger(input.agentOutputBudgetTokens, 'agentOutputBudgetTokens'),
    finalContextReserveTokens: safeInteger(input.finalContextReserveTokens, 'finalContextReserveTokens'),
    finalOutputReserveTokens: safeInteger(input.finalOutputReserveTokens, 'finalOutputReserveTokens'),
    providerContextWindowTokens: safeInteger(input.providerContextWindowTokens, 'providerContextWindowTokens', 1),
    maxCostMicrousd: safeInteger(input.maxCostMicrousd, 'maxCostMicrousd'),
    maxWallMs: safeInteger(input.maxWallMs, 'maxWallMs'),
    maxToolResultChars: safeInteger(input.maxToolResultChars, 'maxToolResultChars'),
    maxFinalChars: safeInteger(input.maxFinalChars, 'maxFinalChars'),
    maxTraceSteps: safeInteger(input.maxTraceSteps, 'maxTraceSteps'),
  };
  if (normalized.maxModelCalls === 0 && (
    normalized.maxSteps !== 0 || normalized.agentInputBudgetTokens !== 0 || normalized.agentOutputBudgetTokens !== 0
  )) throw new TypeError('zero-call budget must not reserve Agent steps or tokens');
  if (normalized.maxModelCalls > 0 && (
    normalized.maxSteps === 0 || normalized.agentInputBudgetTokens === 0 || normalized.agentOutputBudgetTokens === 0
    || normalized.maxWallMs === 0 || normalized.maxTraceSteps === 0
  )) throw new TypeError('active Agent budget requires steps, tokens, wall time and trace capacity');
  if (normalized.maxToolCalls === 0 && normalized.maxWrites > 0) {
    throw new TypeError('write budget requires at least one tool call');
  }
  if (normalized.maxWrites > normalized.maxToolCalls) {
    throw new TypeError('maxWrites must not exceed maxToolCalls');
  }
  if (normalized.finalOutputReserveTokens > normalized.finalContextReserveTokens) {
    throw new TypeError('finalOutputReserveTokens must not exceed finalContextReserveTokens');
  }
  if (normalized.finalContextReserveTokens > normalized.providerContextWindowTokens) {
    throw new TypeError('finalContextReserveTokens must not exceed providerContextWindowTokens');
  }
  if (safeAdd(normalized.agentInputBudgetTokens, normalized.agentOutputBudgetTokens, 'Agent request budget')
    > normalized.providerContextWindowTokens) {
    throw new TypeError('Agent request budget exceeds providerContextWindowTokens');
  }
  return Object.freeze(normalized);
}

export function serializeAgentBudgetProfile(input: AgentBudgetProfileInput): string {
  return JSON.stringify(normalizeAgentBudgetProfile(input));
}

export function agentBudgetProfileDigest(input: AgentBudgetProfileInput): string {
  return `sha256:${createHash('sha256').update(serializeAgentBudgetProfile(input), 'utf8').digest('hex')}`;
}

/**
 * Validates a requested per-run profile against its immutable host ceiling.
 * Upper-bound fields may only decrease. Final reserves may only increase.
 */
export function assertAgentBudgetWithinHostCeiling(
  hostInput: AgentBudgetProfileInput,
  requestedInput: AgentBudgetProfileInput,
): AgentBudgetProfileV2 {
  const host = normalizeAgentBudgetProfile(hostInput);
  const requested = normalizeAgentBudgetProfile(requestedInput);
  if (requested.lane !== host.lane) throw new TypeError('budget-profile-escalation:lane');
  if (PROFILE_RANK[requested.autonomyProfile] > PROFILE_RANK[host.autonomyProfile]) {
    throw new TypeError('budget-profile-escalation:autonomyProfile');
  }
  for (const field of UPPER_BOUND_FIELDS) {
    if (requested[field] > host[field]) throw new TypeError(`budget-profile-escalation:${field}`);
  }
  for (const field of MINIMUM_RESERVE_FIELDS) {
    if (requested[field] < host[field]) throw new TypeError(`budget-profile-escalation:${field}`);
  }
  return requested;
}

export function evaluateFinalTurnBudget(
  profileInput: AgentBudgetProfileInput,
  input: Readonly<{ estimatedFinalInputTokens: number; requestedFinalOutputTokens: number }>,
): AgentBudgetFeasibility {
  const profile = normalizeAgentBudgetProfile(profileInput);
  assertPlainRecord(input, 'finalTurnBudget');
  const estimatedFinalInputTokens = safeInteger(
    input.estimatedFinalInputTokens, 'estimatedFinalInputTokens',
  );
  const requestedFinalOutputTokens = safeInteger(
    input.requestedFinalOutputTokens, 'requestedFinalOutputTokens',
  );
  const effectiveFinalOutputTokens = Math.max(
    profile.finalOutputReserveTokens,
    requestedFinalOutputTokens,
  );
  const requiredFinalContextTokens = safeAdd(
    estimatedFinalInputTokens,
    effectiveFinalOutputTokens,
    'requiredFinalContextTokens',
  );
  const result = { requiredFinalContextTokens, effectiveFinalOutputTokens };
  if (safeAdd(profile.agentInputBudgetTokens, profile.agentOutputBudgetTokens, 'Agent request budget')
    > profile.providerContextWindowTokens) {
    return Object.freeze({ ok: false, reason: 'agent-request-exceeds-provider-context', ...result });
  }
  if (requiredFinalContextTokens > profile.providerContextWindowTokens) {
    return Object.freeze({ ok: false, reason: 'provider-context-insufficient', ...result });
  }
  if (requiredFinalContextTokens > profile.finalContextReserveTokens) {
    return Object.freeze({ ok: false, reason: 'final-reserve-insufficient', ...result });
  }
  return Object.freeze({ ok: true, ...result });
}
