import {
  AGENT_ROLLOUT_LANES,
  AGENT_ROLLOUT_STATES,
  stableAgentLaneBucket,
  type AgentRolloutLane,
  type AgentRolloutState,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import {
  MANAGED_LOCAL_SESSION_SCOPE_VERSION,
  isCanonicalManagedLocalSessionId,
  parseRuntimeSessionScope,
} from './managed-local-session-scope.ts';

export const AGENT_LANE_ROLLOUT_ACK = 'p14-lane-rollout-v2' as const;
export const MANAGED_LOCAL_ROLLOUT_COHORT_VERSION = 'managed-local-opt-in-v1' as const;
export const MANAGED_LOCAL_ROLLOUT_COHORT_ACK = 'p14-managed-local-rollout-cohort-v1' as const;

export type AgentLaneRolloutCohort = 'per-session' | typeof MANAGED_LOCAL_ROLLOUT_COHORT_VERSION;

export interface AgentLaneRuntimeConfig {
  readonly managed: boolean;
  readonly ceilings: Readonly<Record<AgentRolloutLane, AgentRolloutState>>;
  readonly cohort: AgentLaneRolloutCohort;
}

// Opaque rollout identity, not a session/resource authority. Its lane buckets are deliberately
// inside canary-5 for the current rollout policy. This lets an operator who explicitly opted a
// managed-local installation into canary execution get one stable result across new sessions.
// Evidence, kill, capability, reservation, Provider-window and formal-write gates still run.
const MANAGED_LOCAL_OPT_IN_BUCKET_IDENTITY = 'managed-local-opt-in-v1:cohort-4160';

function parseRolloutCohort(
  env: Readonly<Record<string, string | undefined>>,
  laneConfigManaged: boolean,
): AgentLaneRolloutCohort {
  const raw = env.JG_MANAGED_LOCAL_ROLLOUT_COHORT?.trim();
  const acknowledgement = env.JG_MANAGED_LOCAL_ROLLOUT_COHORT_ACK?.trim();
  if (!raw) {
    if (acknowledgement) {
      throw new Error('JG_MANAGED_LOCAL_ROLLOUT_COHORT_ACK 不能脱离显式 cohort 使用');
    }
    return 'per-session';
  }
  if (raw !== MANAGED_LOCAL_ROLLOUT_COHORT_VERSION) {
    throw new Error(
      `JG_MANAGED_LOCAL_ROLLOUT_COHORT 只允许 ${MANAGED_LOCAL_ROLLOUT_COHORT_VERSION}`,
    );
  }
  if (acknowledgement !== MANAGED_LOCAL_ROLLOUT_COHORT_ACK) {
    throw new Error(
      `JG_MANAGED_LOCAL_ROLLOUT_COHORT=${MANAGED_LOCAL_ROLLOUT_COHORT_VERSION} 需要 `
      + `JG_MANAGED_LOCAL_ROLLOUT_COHORT_ACK=${MANAGED_LOCAL_ROLLOUT_COHORT_ACK}`,
    );
  }
  if (!laneConfigManaged
    || parseRuntimeSessionScope(env) !== MANAGED_LOCAL_SESSION_SCOPE_VERSION) {
    throw new Error('managed-local rollout cohort 需要版本化 managed-local scope 与 lane ceiling');
  }
  return MANAGED_LOCAL_ROLLOUT_COHORT_VERSION;
}

/**
 * Resolves only the stable canary bucket identity. This is a cohort-inclusion override, not a
 * lane or safety bypass; callers must continue evaluating every other rollout/write gate.
 */
export function agentLaneRolloutBucketIdentity(
  config: AgentLaneRuntimeConfig,
  scopeSessionId: string,
  perSessionIdentity: string = scopeSessionId,
): string {
  if (config.cohort === MANAGED_LOCAL_ROLLOUT_COHORT_VERSION
    && isCanonicalManagedLocalSessionId(scopeSessionId)) {
    return MANAGED_LOCAL_OPT_IN_BUCKET_IDENTITY;
  }
  return perSessionIdentity;
}

/** Public diagnostics need only the numeric bucket, never the opaque cohort identity. */
export function agentLaneRolloutBucket(
  config: AgentLaneRuntimeConfig,
  lane: AgentRolloutLane,
  scopeSessionId: string,
  perSessionIdentity: string = scopeSessionId,
): number {
  return stableAgentLaneBucket(
    lane,
    agentLaneRolloutBucketIdentity(config, scopeSessionId, perSessionIdentity),
  );
}

/**
 * Unset preserves the pre-Q9 host behavior. Once configured, every lane must be
 * present and the host value is a hard ceiling that the persistent store can only narrow.
 */
export function parseAgentLaneRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentLaneRuntimeConfig {
  const raw = env.JG_AGENT_LANE_ROLLOUT?.trim();
  if (!raw) {
    const cohort = parseRolloutCohort(env, false);
    return Object.freeze({
      managed: false,
      ceilings: Object.freeze({ interactive: 'on', learning: 'on', maintenance: 'on' }),
      cohort,
    });
  }
  if (raw.length > 1_024) throw new Error('JG_AGENT_LANE_ROLLOUT 过大');
  const parsed = new Map<AgentRolloutLane, AgentRolloutState>();
  for (const item of raw.split(',')) {
    const [lane, state, ...extra] = item.split('=').map((value) => value.trim());
    if (extra.length > 0 || !AGENT_ROLLOUT_LANES.includes(lane as AgentRolloutLane)
      || !AGENT_ROLLOUT_STATES.includes(state as AgentRolloutState) || parsed.has(lane as AgentRolloutLane)) {
      throw new Error('JG_AGENT_LANE_ROLLOUT 格式非法');
    }
    parsed.set(lane as AgentRolloutLane, state as AgentRolloutState);
  }
  if (AGENT_ROLLOUT_LANES.some((lane) => !parsed.has(lane))) {
    throw new Error('JG_AGENT_LANE_ROLLOUT 必须显式包含全部 lane');
  }
  const ceilings = Object.freeze(Object.fromEntries(parsed) as Record<AgentRolloutLane, AgentRolloutState>);
  if (Object.values(ceilings).some((state) => !['off', 'shadow'].includes(state))
    && env.JG_AGENT_LANE_ROLLOUT_ACK !== AGENT_LANE_ROLLOUT_ACK) {
    throw new Error(`高于 shadow 需要 JG_AGENT_LANE_ROLLOUT_ACK=${AGENT_LANE_ROLLOUT_ACK}`);
  }
  return Object.freeze({ managed: true, ceilings, cohort: parseRolloutCohort(env, true) });
}
