import {
  CONTEXT_COMPILER_LIMITS,
  CONTEXT_COMPILER_POLICY_VERSION,
} from '../../packages/harness/src/context-compiler.ts';
import {
  normalizeAgentBudgetProfile,
  type AgentBudgetProfileV2,
} from '../../packages/agent-policy/src/budget-profile.ts';
import { interactiveBudgetProfileForAutonomy } from './interactive-runtime-config.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/src/model-runtime-profile.ts';

export interface ContextCompilerRuntimeConfig {
  readonly mode: 'off' | 'test-session';
  readonly enabled: boolean;
  readonly sessionAllowlist: ReadonlySet<string>;
  readonly budgetProfile?: AgentBudgetProfileV2;
}

/**
 * The compile call is one bounded elastic-context pass, not a second game turn. Its allowance is
 * derived from the frozen ModelRuntimeProfile instead of a flat constant: on a 32K window the old
 * 12K/2K pair could not even hold the elastic blocks it exists to compress, so any over-limit
 * input was partitioned into multiple batches and then abandoned outright (`batches.length !== 1`).
 */
const OUTPUT_SHARE_OF_WINDOW = 0.125;
const MIN_OUTPUT_TOKENS = 2_000;
const MAX_WALL_MS = 30_000;

function positiveRate(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000_000) {
    throw new Error(`${name} 必须是 1..1000000000 的微美元/百万 token 整数`);
  }
  return parsed;
}

function exactSessionAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return new Set<string>();
  if (raw.length > 16_384) throw new Error('JG_CONTEXT_COMPILER_SESSION_IDS 过大');
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 256 || values.some((value) => value === '*' || value.length > 240
    || /[\u0000-\u001f]/u.test(value))) {
    throw new Error('JG_CONTEXT_COMPILER_SESSION_IDS 必须是最多 256 个精确会话 ID，禁止通配符');
  }
  return new Set(values);
}

/** Independent host ceiling for the read-only, single-call Context Compiler lane. */
export function contextCompilerBudgetProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeProfile?: ModelRuntimeProfile,
): AgentBudgetProfileV2 {
  const base = interactiveBudgetProfileForAutonomy('quality-beta', env, runtimeProfile);
  const inputRate = positiveRate(
    env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK,
    'JG_HARNESS_INPUT_MICROUSD_PER_MTOK',
  );
  const outputRate = positiveRate(
    env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK,
    'JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK',
  );
  // Derived from the same frozen window the final turn uses, bounded only by the structural rails.
  const maxOutputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(
      CONTEXT_COMPILER_LIMITS.maxOutputTokensCeiling,
      Math.floor(base.providerContextWindowTokens * OUTPUT_SHARE_OF_WINDOW),
    ),
  );
  const maxInputTokens = Math.min(
    base.providerContextWindowTokens - maxOutputTokens,
    CONTEXT_COMPILER_LIMITS.maxBatchTokens,
  );
  const pricedMaximum = Math.ceil(
    ((maxInputTokens * inputRate) + (maxOutputTokens * outputRate)) / 1_000_000,
  );
  const maxCostMicrousd = Math.ceil(pricedMaximum * 1.25);
  return normalizeAgentBudgetProfile({
    ...base,
    lane: 'interactive',
    maxSteps: 1,
    maxModelCalls: 1,
    maxToolCalls: 0,
    maxWrites: 0,
    agentInputBudgetTokens: maxInputTokens,
    agentOutputBudgetTokens: maxOutputTokens,
    maxCostMicrousd,
    maxWallMs: MAX_WALL_MS,
    maxToolResultChars: 0,
    maxFinalChars: 32_768,
    maxTraceSteps: 8,
  });
}

/**
 * Defaults off. `test-session` requires a policy ACK and exact, wildcard-free sessions.
 * The dedicated kill switch is re-read at every turn boundary and wins over all other fields.
 */
export function parseContextCompilerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeProfile?: ModelRuntimeProfile,
): ContextCompilerRuntimeConfig {
  const killSwitch = (env.JG_CONTEXT_COMPILER_KILL_SWITCH ?? '0').trim();
  if (killSwitch !== '0' && killSwitch !== '1') {
    throw new Error('JG_CONTEXT_COMPILER_KILL_SWITCH 只允许 0 或 1');
  }
  if (killSwitch === '1') return Object.freeze({
    mode: 'off', enabled: false, sessionAllowlist: new Set<string>(),
  });
  const mode = (env.JG_CONTEXT_COMPILER ?? 'off').trim().toLowerCase();
  if (mode === 'off') return Object.freeze({
    mode: 'off', enabled: false, sessionAllowlist: new Set<string>(),
  });
  if (mode !== 'test-session') {
    throw new Error('JG_CONTEXT_COMPILER 只允许 off 或 test-session');
  }
  if (env.JG_CONTEXT_COMPILER_ACK !== CONTEXT_COMPILER_POLICY_VERSION) {
    throw new Error(
      `JG_CONTEXT_COMPILER=test-session 需要 JG_CONTEXT_COMPILER_ACK=${CONTEXT_COMPILER_POLICY_VERSION}`,
    );
  }
  const sessionAllowlist = exactSessionAllowlist(env.JG_CONTEXT_COMPILER_SESSION_IDS);
  if (sessionAllowlist.size === 0) {
    throw new Error('test-session 需要非空 JG_CONTEXT_COMPILER_SESSION_IDS');
  }
  return Object.freeze({
    mode: 'test-session',
    enabled: true,
    sessionAllowlist,
    budgetProfile: contextCompilerBudgetProfile(env, runtimeProfile),
  });
}

export function contextCompilerAllowsSession(
  config: ContextCompilerRuntimeConfig,
  sessionId: string,
): boolean {
  return config.enabled && config.sessionAllowlist.has(sessionId);
}
