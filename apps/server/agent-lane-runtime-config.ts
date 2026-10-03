import {
  AGENT_ROLLOUT_LANES,
  AGENT_ROLLOUT_STATES,
  type AgentRolloutLane,
  type AgentRolloutState,
} from '../../packages/agent-policy/src/lane-rollout.ts';

export const AGENT_LANE_ROLLOUT_ACK = 'p14-lane-rollout-v2' as const;

export interface AgentLaneRuntimeConfig {
  readonly managed: boolean;
  readonly ceilings: Readonly<Record<AgentRolloutLane, AgentRolloutState>>;
}

/**
 * Unset preserves the pre-Q9 host behavior. Once configured, every lane must be
 * present and the host value is a hard ceiling that the persistent store can only narrow.
 */
export function parseAgentLaneRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentLaneRuntimeConfig {
  const raw = env.JG_AGENT_LANE_ROLLOUT?.trim();
  if (!raw) return Object.freeze({
    managed: false,
    ceilings: Object.freeze({ interactive: 'on', learning: 'on', maintenance: 'on' }),
  });
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
  return Object.freeze({ managed: true, ceilings });
}
