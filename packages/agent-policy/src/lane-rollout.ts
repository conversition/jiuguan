import { createHash } from 'node:crypto';

export const AGENT_ROLLOUT_LANES = Object.freeze(['interactive', 'learning', 'maintenance'] as const);
export type AgentRolloutLane = (typeof AGENT_ROLLOUT_LANES)[number];
export const AGENT_ROLLOUT_STATES = Object.freeze([
  'off', 'shadow', 'test-session', 'canary-5', 'canary-25', 'canary-50', 'on', 'killed',
] as const);
export type AgentRolloutState = (typeof AGENT_ROLLOUT_STATES)[number];

export const AGENT_ROLLOUT_POLICY_VERSION = 'p14-lane-rollout-v2' as const;
export const AGENT_LANE_OBSERVATION_VERSION = 'p14-lane-observation-v2' as const;
export const AGENT_LANE_QUALITY_KILL_REASONS = Object.freeze([
  'provider-error-rate-exceeded',
  'invalid-call-rate-exceeded',
  'p95-latency-exceeded',
] as const);
export const AGENT_LANE_PERMANENT_KILL_REASONS = Object.freeze([
  'player-sovereignty-violation',
  'unauthorized-or-stale-write',
  'duplicate-write',
  'sensitive-audit-violation',
] as const);
/**
 * Per-lane default size of one operator-authorized Provider-call window.
 *
 * A qualifying sample is de-duplicated by `lane + sessionId + parentRunId`, so a window must be
 * large enough to produce `canaryMinSamples` samples at the observed call/sample ratio. Live
 * evidence (2026-09-30) was 2/4 interactive, 3/6 learning and 2/13 maintenance, i.e. ~0.50 and
 * ~0.15 samples per call. The former flat ceiling of 24 calls could therefore yield at most
 * ~12 samples for interactive/learning and ~4 for maintenance, so no lane could ever reach the
 * 20-sample gate inside a single authorized window — promotion was structurally unreachable and
 * every lane needed several manual renewals. Sizes below are `canaryMinSamples / observedRatio`
 * plus ~20% headroom, so one window is sufficient while safety counters stay permanent.
 */
export const AGENT_TEST_SESSION_WINDOW_CALLS: Readonly<Record<AgentRolloutLane, number>> =
  Object.freeze({ interactive: 48, learning: 48, maintenance: 144 });

export const AGENT_ROLLOUT_THRESHOLDS = Object.freeze({
  version: AGENT_ROLLOUT_POLICY_VERSION,
  canaryMinSamples: 20,
  /** Legacy flat fallback. Prefer `testSessionWindowCalls(lane)`; only used when evidence omits a window size. */
  testSessionMaxProviderCalls: 24,
  globalMinSamples: 100,
  globalMinObservationDays: 7,
  providerErrorRateMax: 0.10,
  invalidCallRateMax: 0.02,
  p95LatencyMaxMs: Object.freeze({ interactive: 15_000, learning: 30_000, maintenance: 45_000 }),
});

/** Authoritative default window size for a lane. Callers may still narrow it per window. */
export function testSessionWindowCalls(lane: AgentRolloutLane): number {
  if (!AGENT_ROLLOUT_LANES.includes(lane)) throw new TypeError('lane invalid');
  return AGENT_TEST_SESSION_WINDOW_CALLS[lane];
}

export interface AgentLaneEvidence {
  readonly observationVersion: typeof AGENT_LANE_OBSERVATION_VERSION;
  readonly operationalEvaluationPassed: boolean;
  readonly qualifyingSamples: number;
  readonly observationDays: number;
  readonly providerCalls: number;
  readonly providerErrors: number;
  readonly invalidCalls: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly playerSovereigntyViolations: number;
  readonly unauthorizedOrStaleWrites: number;
  readonly duplicateWrites: number;
  readonly sensitiveAuditViolations: number;
  /**
   * Calls that returned an upstream result in the current operator-authorized window.
   * Provider failures are counted separately so zero-usage transport failures remain observable
   * without consuming operator-authorized call quota.
   */
  readonly authorizationWindowCalls?: number;
  readonly authorizationWindowReservedCalls?: number;
  readonly authorizationWindowProviderErrors?: number;
  readonly authorizationWindowInvalidCalls?: number;
  readonly authorizationWindowQualifyingSamples?: number;
  readonly authorizationWindowP50LatencyMs?: number;
  readonly authorizationWindowP95LatencyMs?: number;
  readonly authorizationWindowMaxCalls?: number;
  readonly authorizationWindowSequence?: number;
}

export interface AgentLaneDecision {
  readonly policyVersion: typeof AGENT_ROLLOUT_POLICY_VERSION;
  readonly lane: AgentRolloutLane;
  readonly desiredState: AgentRolloutState;
  readonly hostCeiling: AgentRolloutState;
  readonly effectiveState: AgentRolloutState;
  readonly bucket: number;
  readonly allowed: boolean;
  readonly shouldKill: boolean;
  readonly reasonCodes: readonly string[];
}

const ORDER: Readonly<Record<Exclude<AgentRolloutState, 'killed'>, number>> = Object.freeze({
  off: 0, shadow: 1, 'test-session': 2, 'canary-5': 3, 'canary-25': 4, 'canary-50': 5, on: 6,
});

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} invalid`);
  return value;
}

export function stableAgentLaneBucket(lane: AgentRolloutLane, sessionId: string): number {
  if (!AGENT_ROLLOUT_LANES.includes(lane) || typeof sessionId !== 'string' || sessionId.length < 1
    || sessionId.length > 240) throw new TypeError('lane bucket input invalid');
  const digest = createHash('sha256').update(`${AGENT_ROLLOUT_POLICY_VERSION}\0${lane}\0${sessionId}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

export function narrowAgentRolloutState(
  desired: AgentRolloutState,
  ceiling: AgentRolloutState,
): AgentRolloutState {
  if (!AGENT_ROLLOUT_STATES.includes(desired) || !AGENT_ROLLOUT_STATES.includes(ceiling)) {
    throw new TypeError('lane rollout state invalid');
  }
  if (desired === 'killed' || ceiling === 'killed') return 'killed';
  return ORDER[desired] <= ORDER[ceiling] ? desired : ceiling;
}

function canaryPercent(state: AgentRolloutState): number | null {
  if (state === 'canary-5') return 5;
  if (state === 'canary-25') return 25;
  if (state === 'canary-50') return 50;
  return null;
}

export function evaluateAgentLaneRollout(input: {
  lane: AgentRolloutLane;
  sessionId: string;
  desiredState: AgentRolloutState;
  hostCeiling: AgentRolloutState;
  evidence: AgentLaneEvidence;
}): AgentLaneDecision {
  const { lane, sessionId, desiredState, hostCeiling } = input;
  if (!AGENT_ROLLOUT_LANES.includes(lane)) throw new TypeError('lane invalid');
  if (input.evidence.observationVersion !== AGENT_LANE_OBSERVATION_VERSION) {
    throw new TypeError('observationVersion invalid');
  }
  const evidence = Object.freeze({
    observationVersion: input.evidence.observationVersion,
    operationalEvaluationPassed: input.evidence.operationalEvaluationPassed === true,
    qualifyingSamples: count(input.evidence.qualifyingSamples, 'qualifyingSamples'),
    observationDays: count(input.evidence.observationDays, 'observationDays'),
    providerCalls: count(input.evidence.providerCalls, 'providerCalls'),
    providerErrors: count(input.evidence.providerErrors, 'providerErrors'),
    invalidCalls: count(input.evidence.invalidCalls, 'invalidCalls'),
    p50LatencyMs: count(input.evidence.p50LatencyMs, 'p50LatencyMs'),
    p95LatencyMs: count(input.evidence.p95LatencyMs, 'p95LatencyMs'),
    playerSovereigntyViolations: count(input.evidence.playerSovereigntyViolations, 'playerSovereigntyViolations'),
    unauthorizedOrStaleWrites: count(input.evidence.unauthorizedOrStaleWrites, 'unauthorizedOrStaleWrites'),
    duplicateWrites: count(input.evidence.duplicateWrites, 'duplicateWrites'),
    sensitiveAuditViolations: count(input.evidence.sensitiveAuditViolations, 'sensitiveAuditViolations'),
    authorizationWindowCalls: count(
      input.evidence.authorizationWindowCalls ?? input.evidence.providerCalls,
      'authorizationWindowCalls',
    ),
    authorizationWindowReservedCalls: count(
      input.evidence.authorizationWindowReservedCalls ?? 0,
      'authorizationWindowReservedCalls',
    ),
    authorizationWindowProviderErrors: count(
      input.evidence.authorizationWindowProviderErrors ?? input.evidence.providerErrors,
      'authorizationWindowProviderErrors',
    ),
    authorizationWindowInvalidCalls: count(
      input.evidence.authorizationWindowInvalidCalls ?? input.evidence.invalidCalls,
      'authorizationWindowInvalidCalls',
    ),
    authorizationWindowQualifyingSamples: count(
      input.evidence.authorizationWindowQualifyingSamples ?? input.evidence.qualifyingSamples,
      'authorizationWindowQualifyingSamples',
    ),
    authorizationWindowP50LatencyMs: count(
      input.evidence.authorizationWindowP50LatencyMs ?? input.evidence.p50LatencyMs,
      'authorizationWindowP50LatencyMs',
    ),
    authorizationWindowP95LatencyMs: count(
      input.evidence.authorizationWindowP95LatencyMs ?? input.evidence.p95LatencyMs,
      'authorizationWindowP95LatencyMs',
    ),
    authorizationWindowMaxCalls: input.evidence.authorizationWindowMaxCalls === undefined
      ? undefined
      : count(input.evidence.authorizationWindowMaxCalls, 'authorizationWindowMaxCalls'),
    authorizationWindowSequence: input.evidence.authorizationWindowSequence === undefined
      ? undefined
      : count(input.evidence.authorizationWindowSequence, 'authorizationWindowSequence'),
  });
  // The control store already reports the real size of the current operator-authorized window.
  // Honor it rather than a global constant, otherwise a deliberately widened window is silently
  // clamped back to the legacy value and the lane can never collect enough samples to promote.
  const windowMaxCalls = evidence.authorizationWindowMaxCalls ?? testSessionWindowCalls(lane);
  const reasons: string[] = [];
  const providerAttempts = evidence.authorizationWindowCalls
    + evidence.authorizationWindowProviderErrors;
  const providerErrorRate = providerAttempts === 0
    ? 0 : evidence.authorizationWindowProviderErrors / providerAttempts;
  const invalidCallRate = evidence.authorizationWindowCalls === 0
    ? 0 : evidence.authorizationWindowInvalidCalls / evidence.authorizationWindowCalls;
  const enoughProviderAttempts = providerAttempts >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples;
  const enoughAuthorizedCalls = evidence.authorizationWindowCalls
    >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples;
  if (evidence.playerSovereigntyViolations > 0) reasons.push('player-sovereignty-violation');
  if (evidence.unauthorizedOrStaleWrites > 0) reasons.push('unauthorized-or-stale-write');
  if (evidence.duplicateWrites > 0) reasons.push('duplicate-write');
  if (evidence.sensitiveAuditViolations > 0) reasons.push('sensitive-audit-violation');
  if (enoughProviderAttempts && providerErrorRate > AGENT_ROLLOUT_THRESHOLDS.providerErrorRateMax) {
    reasons.push('provider-error-rate-exceeded');
  }
  if (enoughAuthorizedCalls && invalidCallRate > AGENT_ROLLOUT_THRESHOLDS.invalidCallRateMax) {
    reasons.push('invalid-call-rate-exceeded');
  }
  if (enoughAuthorizedCalls
    && evidence.authorizationWindowP95LatencyMs > AGENT_ROLLOUT_THRESHOLDS.p95LatencyMaxMs[lane]) {
    reasons.push('p95-latency-exceeded');
  }
  const shouldKill = reasons.length > 0;
  const effectiveState = shouldKill ? 'killed' : narrowAgentRolloutState(desiredState, hostCeiling);
  const bucket = stableAgentLaneBucket(lane, sessionId);
  if (effectiveState === 'killed') reasons.push('lane-killed');
  else if (effectiveState === 'off') reasons.push('lane-off');
  else if (effectiveState === 'shadow') reasons.push('lane-shadow-only');
  else if (!evidence.operationalEvaluationPassed) reasons.push('operational-evaluation-required');
  else if (effectiveState === 'test-session') {
    reasons.push(evidence.authorizationWindowQualifyingSamples >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
      || providerAttempts + evidence.authorizationWindowReservedCalls >= windowMaxCalls
      ? 'test-session-review-required'
      : 'test-session-admitted');
  }
  else {
    const percent = canaryPercent(effectiveState);
    if (percent !== null
      && evidence.authorizationWindowQualifyingSamples < AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples) {
      reasons.push('canary-sample-gate');
    } else if (percent !== null && bucket >= percent) {
      reasons.push('outside-stable-canary-bucket');
    } else if (effectiveState === 'on'
      && evidence.qualifyingSamples < AGENT_ROLLOUT_THRESHOLDS.globalMinSamples
      && evidence.observationDays < AGENT_ROLLOUT_THRESHOLDS.globalMinObservationDays) {
      reasons.push('global-evidence-gate');
    } else reasons.push('lane-admitted');
  }
  const allowed = !shouldKill && (
    (effectiveState === 'test-session'
      && evidence.operationalEvaluationPassed
      && evidence.authorizationWindowQualifyingSamples < AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
      && providerAttempts + evidence.authorizationWindowReservedCalls < windowMaxCalls)
    || (canaryPercent(effectiveState) !== null
      && evidence.operationalEvaluationPassed
      && evidence.authorizationWindowQualifyingSamples >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
      && bucket < canaryPercent(effectiveState)!)
    || (effectiveState === 'on'
      && evidence.operationalEvaluationPassed
      && (evidence.qualifyingSamples >= AGENT_ROLLOUT_THRESHOLDS.globalMinSamples
        || evidence.observationDays >= AGENT_ROLLOUT_THRESHOLDS.globalMinObservationDays))
  );
  return Object.freeze({
    policyVersion: AGENT_ROLLOUT_POLICY_VERSION,
    lane, desiredState, hostCeiling, effectiveState, bucket, allowed, shouldKill,
    reasonCodes: Object.freeze(reasons),
  });
}
