import { createHash } from 'node:crypto';
import {
  isPublicMaintenanceJob,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';
import {
  agentLaneRolloutBucket,
  type AgentLaneRuntimeConfig,
} from './agent-lane-runtime-config.ts';
import {
  AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE as ACCEPTED_CONTRACT,
} from './agent-loop-maintenance-execution-support.ts';
import { MAINTENANCE_POLICY_VERSION } from './maintenance-types.ts';

/**
 * Offline route plan only. It never grants a Manager claim, Provider call or
 * publication. A later production dispatcher must bind this plan to the
 * Manager's single queued -> running transaction.
 */
export const AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION =
  'agent-loop-maintenance-canary-route-plan-v1' as const;
export const AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH =
  'agent-loop-maintenance-correction-canary-epoch-v1' as const;

export const AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES = Object.freeze([
  'off', 'canary-5', 'canary-25', 'canary-50', 'on', 'killed',
] as const);
export type AgentLoopMaintenanceCanaryRouteState =
  (typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES)[number];
export type AgentLoopMaintenanceCanaryPlannedRoute = 'legacy' | 'agent-loop' | 'blocked';

export type AgentLoopMaintenanceCanaryJobHeader = Pick<PublicMaintenanceJob,
  'runId' | 'sessionId' | 'taskKind' | 'sourceRevision' | 'policyVersion' | 'parentRunId'
  | 'trigger' | 'mode' | 'status' | 'attempt' | 'createdAt' | 'updatedAt'
  | 'startedAt' | 'finishedAt' | 'errorCode'>;

export interface AgentLoopMaintenanceCanaryRoutePlanInput {
  /** Header-only job projection; body, budget and proposal are intentionally outside this planner. */
  readonly job: AgentLoopMaintenanceCanaryJobHeader;
  readonly routeControl: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH;
    state: AgentLoopMaintenanceCanaryRouteState;
    revision: number;
  }>;
  readonly safety: Readonly<{
    maintenanceAllowed: boolean;
    capabilityAllowed: boolean;
    quota: 'ready' | 'exhausted' | 'unknown';
    remainingProviderCalls: number;
    windowSequence: number;
  }>;
  readonly readiness: Readonly<{
    sourcePolicy: boolean;
    runtimeBundle: boolean;
    publication: boolean;
    operationalEvidence: boolean;
  }>;
}

export type AgentLoopMaintenanceCanaryRouteReason =
  | 'candidate-selected'
  | 'job-not-pristine'
  | 'maintenance-safety-blocked'
  | 'capability-safety-blocked'
  | 'quota-exhausted'
  | 'quota-unknown'
  | 'scope-not-selected'
  | 'route-control-off'
  | 'route-control-killed'
  | 'outside-stable-route-bucket'
  | 'source-policy-not-ready'
  | 'runtime-bundle-not-ready'
  | 'publication-not-ready'
  | 'operational-evidence-not-ready'
  | 'input-invalid';

export type AgentLoopMaintenanceCanaryPreflightMissing =
  | 'production-single-route-selector'
  | 'source-policy-readiness'
  | 'runtime-bundle-readiness'
  | 'publication-readiness'
  | 'operational-canary-evidence';

export interface AgentLoopMaintenanceCanaryRoutePlan {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION;
  readonly contractVersion: typeof ACCEPTED_CONTRACT.version;
  readonly scope: typeof ACCEPTED_CONTRACT.scope;
  readonly cohort: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH;
    bucket: number | null;
    threshold: number;
  }>;
  readonly plannedRoute: AgentLoopMaintenanceCanaryPlannedRoute;
  readonly reasonCodes: readonly AgentLoopMaintenanceCanaryRouteReason[];
  readonly bindings: Readonly<{
    readonly jobDigest: string | null;
    routeControlRevision: number | null;
    windowSequence: number | null;
  }>;
  readonly preflight: Readonly<{
    status: 'blocked';
    missing: readonly AgentLoopMaintenanceCanaryPreflightMissing[];
  }>;
  readonly planDigest: string;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
}

const INPUT_KEYS = Object.freeze(['job', 'readiness', 'routeControl', 'safety']);
const JOB_KEYS = Object.freeze([
  'attempt', 'createdAt', 'errorCode', 'finishedAt', 'mode', 'parentRunId', 'policyVersion',
  'runId', 'sessionId', 'sourceRevision', 'startedAt', 'status', 'taskKind', 'trigger', 'updatedAt',
]);
const ROUTE_CONTROL_KEYS = Object.freeze(['generation', 'revision', 'state']);
const SAFETY_KEYS = Object.freeze([
  'capabilityAllowed', 'maintenanceAllowed', 'quota', 'remainingProviderCalls', 'windowSequence',
]);
const READINESS_KEYS = Object.freeze([
  'operationalEvidence', 'publication', 'runtimeBundle', 'sourcePolicy',
]);
const ROUTE_THRESHOLDS: Readonly<Record<AgentLoopMaintenanceCanaryRouteState, number>> =
  Object.freeze({ off: 0, 'canary-5': 5, 'canary-25': 25, 'canary-50': 50, on: 100, killed: 0 });
const REQUIRED_MODEL_CALLS = ACCEPTED_CONTRACT.limits.maxModelCalls;
const HASH_IDENTITY_PREFIX = `${AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION}\0${ACCEPTED_CONTRACT.version}\0${AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH}`;
const ROUTE_BUCKET_RUNTIME = Object.freeze({
  managed: false,
  ceilings: Object.freeze({ interactive: 'off', learning: 'off', maintenance: 'off' }),
  cohort: 'per-session',
}) satisfies AgentLaneRuntimeConfig;

function invalid(): never {
  throw new Error('agent-loop-maintenance-canary-route-plan-input-invalid');
}

function exactOwnData(
  input: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string')) invalid();
    const sorted = (ownKeys as string[]).sort();
    const allowed = new Set(keys), optional = new Set(optionalKeys);
    if (sorted.some((key) => !allowed.has(key))
      || keys.some((key) => !optional.has(key) && !sorted.includes(key))) invalid();
    const output: Record<string, unknown> = {};
    for (const key of sorted) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) invalid();
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    invalid();
  }
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function freezePlan(
  input: Omit<AgentLoopMaintenanceCanaryRoutePlan, 'planDigest'>,
): AgentLoopMaintenanceCanaryRoutePlan {
  const stable = {
    ...input,
    scope: Object.freeze({ ...input.scope }),
    cohort: Object.freeze({ ...input.cohort }),
    reasonCodes: Object.freeze([...input.reasonCodes]),
    bindings: Object.freeze({ ...input.bindings }),
    preflight: Object.freeze({
      ...input.preflight,
      missing: Object.freeze([...input.preflight.missing]),
    }),
  };
  return Object.freeze({ ...stable, planDigest: digest(stable) });
}

function blockedFallback(reason: AgentLoopMaintenanceCanaryRouteReason): AgentLoopMaintenanceCanaryRoutePlan {
  return freezePlan({
    version: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION,
    contractVersion: ACCEPTED_CONTRACT.version,
    scope: ACCEPTED_CONTRACT.scope,
    cohort: {
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH,
      bucket: null,
      threshold: 0,
    },
    plannedRoute: 'blocked',
    reasonCodes: [reason],
    bindings: { jobDigest: null, routeControlRevision: null, windowSequence: null },
    preflight: {
      status: 'blocked',
      missing: [
        'production-single-route-selector',
        'source-policy-readiness',
        'runtime-bundle-readiness',
        'publication-readiness',
        'operational-canary-evidence',
      ],
    },
    claimAuthorized: false,
    executionAuthorized: false,
    completionAuthorized: false,
    canaryAuthorized: false,
    productionEligible: false,
  });
}

/**
 * Strict planner. Structural input errors are fixed-message failures so callers
 * cannot accidentally treat untrusted/coercive objects as route authority.
 */
export function planAgentLoopMaintenanceCanaryRoute(
  unsafeInput: AgentLoopMaintenanceCanaryRoutePlanInput,
): AgentLoopMaintenanceCanaryRoutePlan {
  const input = exactOwnData(unsafeInput, INPUT_KEYS);
  const job = exactOwnData(input.job, JOB_KEYS, [
    'errorCode', 'finishedAt', 'parentRunId', 'startedAt',
  ]);
  const routeControl = exactOwnData(input.routeControl, ROUTE_CONTROL_KEYS);
  const safety = exactOwnData(input.safety, SAFETY_KEYS);
  const readiness = exactOwnData(input.readiness, READINESS_KEYS);

  if (!isPublicMaintenanceJob(job)
    || routeControl.generation !== AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH
    || typeof routeControl.state !== 'string'
    || !AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES.includes(
      routeControl.state as AgentLoopMaintenanceCanaryRouteState,
    )
    || !safeInteger(routeControl.revision)
    || !boolean(safety.maintenanceAllowed) || !boolean(safety.capabilityAllowed)
    || (safety.quota !== 'ready' && safety.quota !== 'exhausted' && safety.quota !== 'unknown')
    || !safeInteger(safety.remainingProviderCalls) || !safeInteger(safety.windowSequence)
    || !READINESS_KEYS.every((key) => boolean(readiness[key]))) invalid();

  const state = routeControl.state as AgentLoopMaintenanceCanaryRouteState;
  const threshold = ROUTE_THRESHOLDS[state];
  const bucket = agentLaneRolloutBucket(ROUTE_BUCKET_RUNTIME, 'maintenance', job.sessionId,
    `${HASH_IDENTITY_PREFIX}\0${job.sessionId}`);
  const jobDigest = digest({
    runId: job.runId,
    sessionId: job.sessionId,
    taskKind: job.taskKind,
    sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion,
    mode: job.mode,
    status: job.status,
    attempt: job.attempt,
    createdAt: job.createdAt,
  });
  const reasons: AgentLoopMaintenanceCanaryRouteReason[] = [];
  let plannedRoute: AgentLoopMaintenanceCanaryPlannedRoute;

  if (job.status !== 'queued' || job.attempt !== 0) {
    reasons.push('job-not-pristine'); plannedRoute = 'blocked';
  } else if (!safety.maintenanceAllowed) {
    reasons.push('maintenance-safety-blocked'); plannedRoute = 'blocked';
  } else if (!safety.capabilityAllowed) {
    reasons.push('capability-safety-blocked'); plannedRoute = 'blocked';
  } else if (safety.quota === 'unknown') {
    reasons.push('quota-unknown'); plannedRoute = 'blocked';
  } else if (safety.quota === 'exhausted' || safety.remainingProviderCalls < REQUIRED_MODEL_CALLS) {
    reasons.push('quota-exhausted'); plannedRoute = 'blocked';
  } else if (job.taskKind !== ACCEPTED_CONTRACT.scope.taskKind
    || job.mode !== ACCEPTED_CONTRACT.scope.mode
    || job.policyVersion !== MAINTENANCE_POLICY_VERSION) {
    reasons.push('scope-not-selected'); plannedRoute = 'legacy';
  } else if (state === 'off') {
    reasons.push('route-control-off'); plannedRoute = 'legacy';
  } else if (state === 'killed') {
    reasons.push('route-control-killed'); plannedRoute = 'legacy';
  } else if (bucket >= threshold) {
    reasons.push('outside-stable-route-bucket'); plannedRoute = 'legacy';
  } else {
    if (!readiness.sourcePolicy) reasons.push('source-policy-not-ready');
    if (!readiness.runtimeBundle) reasons.push('runtime-bundle-not-ready');
    if (!readiness.publication) reasons.push('publication-not-ready');
    if (!readiness.operationalEvidence) reasons.push('operational-evidence-not-ready');
    if (reasons.length === 0) {
      reasons.push('candidate-selected'); plannedRoute = 'agent-loop';
    } else plannedRoute = 'legacy';
  }

  const missing: AgentLoopMaintenanceCanaryPreflightMissing[] = ['production-single-route-selector'];
  if (!readiness.sourcePolicy) missing.push('source-policy-readiness');
  if (!readiness.runtimeBundle) missing.push('runtime-bundle-readiness');
  if (!readiness.publication) missing.push('publication-readiness');
  if (!readiness.operationalEvidence) missing.push('operational-canary-evidence');
  return freezePlan({
    version: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION,
    contractVersion: ACCEPTED_CONTRACT.version,
    scope: ACCEPTED_CONTRACT.scope,
    cohort: {
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH,
      bucket,
      threshold,
    },
    plannedRoute,
    reasonCodes: reasons,
    bindings: {
      jobDigest,
      routeControlRevision: routeControl.revision as number,
      windowSequence: safety.windowSequence as number,
    },
    preflight: { status: 'blocked', missing },
    claimAuthorized: false,
    executionAuthorized: false,
    completionAuthorized: false,
    canaryAuthorized: false,
    productionEligible: false,
  });
}

/** Safe host-facing facade: malformed/exceptional input blocks both routes. */
export function planAgentLoopMaintenanceCanaryRouteOrBlocked(
  input: AgentLoopMaintenanceCanaryRoutePlanInput,
): AgentLoopMaintenanceCanaryRoutePlan {
  try { return planAgentLoopMaintenanceCanaryRoute(input); }
  catch { return blockedFallback('input-invalid'); }
}
