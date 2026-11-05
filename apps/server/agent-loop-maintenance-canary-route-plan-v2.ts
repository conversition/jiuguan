import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  isPublicMaintenanceJob,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';
import {
  agentLaneRolloutBucket,
  type AgentLaneRuntimeConfig,
} from './agent-lane-runtime-config.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES,
  type AgentLoopMaintenanceCanaryPlannedRoute,
  type AgentLoopMaintenanceCanaryRouteState,
} from './agent-loop-maintenance-canary-route-plan.ts';
import {
  AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE as ACCEPTED_CONTRACT,
} from './agent-loop-maintenance-execution-support.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT as PRODUCTION_ROUTE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
  matchesAgentLoopMaintenanceProductionRouteJob,
} from './agent-loop-maintenance-production-route-contract.ts';

/**
 * Version two selects the real p14/post-turn production job shape while
 * retaining p13b only as the AL execution contract. It is still an offline
 * plan: no Manager claim, Provider call, publication or production authority.
 */
export const AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION =
  'agent-loop-maintenance-canary-route-plan-v2' as const;
export const AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2 =
  'agent-loop-maintenance-correction-canary-epoch-v2' as const;
export const AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD = 5 as const;

export type AgentLoopMaintenanceCanaryJobHeaderV2 = Pick<PublicMaintenanceJob,
  'runId' | 'sessionId' | 'taskKind' | 'sourceRevision' | 'policyVersion' | 'parentRunId'
  | 'trigger' | 'mode' | 'status' | 'attempt' | 'createdAt' | 'updatedAt'
  | 'startedAt' | 'finishedAt' | 'errorCode'>;

export interface AgentLoopMaintenanceCanaryRoutePlanV2Input {
  readonly job: AgentLoopMaintenanceCanaryJobHeaderV2;
  readonly routeControl: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
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

export type AgentLoopMaintenanceCanaryRouteReasonV2 =
  | 'candidate-selected'
  | 'job-not-pristine'
  | 'maintenance-safety-blocked'
  | 'capability-safety-blocked'
  | 'quota-exhausted'
  | 'quota-unknown'
  | 'production-contract-not-selected'
  | 'route-control-off'
  | 'route-control-killed'
  | 'outside-stable-route-bucket'
  | 'source-policy-not-ready'
  | 'runtime-bundle-not-ready'
  | 'publication-not-ready'
  | 'operational-evidence-not-ready'
  | 'input-invalid';

export type AgentLoopMaintenanceCanaryPreflightMissingV2 =
  | 'production-single-route-selector'
  | 'source-policy-readiness'
  | 'runtime-bundle-readiness'
  | 'publication-readiness'
  | 'operational-canary-evidence';

export interface AgentLoopMaintenanceCanaryRoutePlanV2 {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION;
  readonly routeContract: Readonly<{
    version: typeof PRODUCTION_ROUTE_CONTRACT.version;
    digest: string;
    admissionPolicyVersion: typeof PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion;
    executionPolicyVersion: typeof PRODUCTION_ROUTE_CONTRACT.execution.policyVersion;
    acceptanceVersion: typeof PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion;
    executionContractVersion: typeof PRODUCTION_ROUTE_CONTRACT.execution.contractVersion;
  }>;
  readonly scope: Readonly<{
    taskKind: typeof PRODUCTION_ROUTE_CONTRACT.jobAdmission.taskKind;
    mode: typeof PRODUCTION_ROUTE_CONTRACT.jobAdmission.mode;
    trigger: typeof PRODUCTION_ROUTE_CONTRACT.jobAdmission.trigger;
    protocol: typeof PRODUCTION_ROUTE_CONTRACT.execution.protocol;
    route: typeof PRODUCTION_ROUTE_CONTRACT.execution.route;
  }>;
  readonly cohort: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
    bucket: number | null;
    threshold: number;
  }>;
  readonly plannedRoute: AgentLoopMaintenanceCanaryPlannedRoute;
  readonly reasonCodes: readonly AgentLoopMaintenanceCanaryRouteReasonV2[];
  readonly bindings: Readonly<{
    jobDigest: string | null;
    routeControlRevision: number | null;
    windowSequence: number | null;
  }>;
  readonly preflight: Readonly<{
    status: 'blocked';
    missing: readonly AgentLoopMaintenanceCanaryPreflightMissingV2[];
  }>;
  readonly planDigest: string;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
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
  Object.freeze({
    off: 0,
    'canary-5': AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD,
    'canary-25': 25,
    'canary-50': 50,
    on: 100,
    killed: 0,
  });
const REQUIRED_MODEL_CALLS = ACCEPTED_CONTRACT.limits.maxModelCalls;
const HASH_IDENTITY_PREFIX =
  `${AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION}\0${AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST}\0${AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2}`;
const ROUTE_BUCKET_RUNTIME = Object.freeze({
  managed: false,
  ceilings: Object.freeze({ interactive: 'off', learning: 'off', maintenance: 'off' }),
  cohort: 'per-session',
}) satisfies AgentLaneRuntimeConfig;

/** Shared pure selector; each caller retains its existing session-id contract. */
export function agentLoopMaintenanceCanaryRouteBucketV2(sessionId: string): number {
  return agentLaneRolloutBucket(
    ROUTE_BUCKET_RUNTIME,
    'maintenance',
    sessionId,
    `${HASH_IDENTITY_PREFIX}\0${sessionId}`,
  );
}

function invalid(): never {
  throw new Error('agent-loop-maintenance-canary-route-plan-v2-input-invalid');
}

function exactOwnData(
  input: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || nodeTypes.isProxy(input)) invalid();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string')) invalid();
    const actual = ownKeys as string[];
    const optional = new Set(optionalKeys);
    if (actual.some((key) => !keys.includes(key))
      || keys.some((key) => !optional.has(key) && !actual.includes(key))) invalid();
    const output: Record<string, unknown> = {};
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
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

function jobBindingDigest(job: Pick<PublicMaintenanceJob,
  'runId' | 'sessionId' | 'taskKind' | 'sourceRevision' | 'policyVersion'
  | 'mode' | 'status' | 'attempt' | 'createdAt'>): string {
  return digest({
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
}

/**
 * Recompute the exact v2/§13.84 job binding for any structurally valid planner
 * candidate. This is an identity check only, never a route or claim grant;
 * AL eligibility remains separately constrained by the production job matcher.
 */
export function agentLoopMaintenanceCanaryRoutePlanV2JobDigest(
  input: unknown,
): string | null {
  try {
    const job = exactOwnData(input, JOB_KEYS, [
      'errorCode', 'finishedAt', 'parentRunId', 'startedAt',
    ]);
    return isPublicMaintenanceJob(job) ? jobBindingDigest(job) : null;
  } catch {
    return null;
  }
}

function routeContractBinding(): AgentLoopMaintenanceCanaryRoutePlanV2['routeContract'] {
  return Object.freeze({
    version: PRODUCTION_ROUTE_CONTRACT.version,
    digest: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
    admissionPolicyVersion: PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion,
    executionPolicyVersion: PRODUCTION_ROUTE_CONTRACT.execution.policyVersion,
    acceptanceVersion: PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion,
    executionContractVersion: PRODUCTION_ROUTE_CONTRACT.execution.contractVersion,
  });
}

function routeScope(): AgentLoopMaintenanceCanaryRoutePlanV2['scope'] {
  return Object.freeze({
    taskKind: PRODUCTION_ROUTE_CONTRACT.jobAdmission.taskKind,
    mode: PRODUCTION_ROUTE_CONTRACT.jobAdmission.mode,
    trigger: PRODUCTION_ROUTE_CONTRACT.jobAdmission.trigger,
    protocol: PRODUCTION_ROUTE_CONTRACT.execution.protocol,
    route: PRODUCTION_ROUTE_CONTRACT.execution.route,
  });
}

function freezePlan(
  input: Omit<AgentLoopMaintenanceCanaryRoutePlanV2, 'planDigest'>,
): AgentLoopMaintenanceCanaryRoutePlanV2 {
  const stable = {
    ...input,
    routeContract: Object.freeze({ ...input.routeContract }),
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

function blockedFallback(
  reason: AgentLoopMaintenanceCanaryRouteReasonV2,
): AgentLoopMaintenanceCanaryRoutePlanV2 {
  return freezePlan({
    version: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
    routeContract: routeContractBinding(),
    scope: routeScope(),
    cohort: {
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
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
    publicationAuthorized: false,
    canaryAuthorized: false,
    productionEligible: false,
  });
}

function pristine(job: Record<string, unknown>): boolean {
  return job.status === 'queued' && job.attempt === 0
    && job.createdAt === job.updatedAt
    && !Object.hasOwn(job, 'startedAt')
    && !Object.hasOwn(job, 'finishedAt')
    && !Object.hasOwn(job, 'errorCode');
}

export function planAgentLoopMaintenanceCanaryRouteV2(
  unsafeInput: AgentLoopMaintenanceCanaryRoutePlanV2Input,
): AgentLoopMaintenanceCanaryRoutePlanV2 {
  const input = exactOwnData(unsafeInput, INPUT_KEYS);
  const job = exactOwnData(input.job, JOB_KEYS, [
    'errorCode', 'finishedAt', 'parentRunId', 'startedAt',
  ]);
  const routeControl = exactOwnData(input.routeControl, ROUTE_CONTROL_KEYS);
  const safety = exactOwnData(input.safety, SAFETY_KEYS);
  const readiness = exactOwnData(input.readiness, READINESS_KEYS);

  if (!isPublicMaintenanceJob(job)
    || routeControl.generation !== AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2
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
  const bucket = agentLoopMaintenanceCanaryRouteBucketV2(job.sessionId);
  // Kept byte-compatible with v1 and the §13.84 source-policy proof.
  const jobDigest = jobBindingDigest(job);
  const reasons: AgentLoopMaintenanceCanaryRouteReasonV2[] = [];
  let plannedRoute: AgentLoopMaintenanceCanaryPlannedRoute;

  if (!pristine(job)) {
    reasons.push('job-not-pristine'); plannedRoute = 'blocked';
  } else if (!safety.maintenanceAllowed) {
    reasons.push('maintenance-safety-blocked'); plannedRoute = 'blocked';
  } else if (!safety.capabilityAllowed) {
    reasons.push('capability-safety-blocked'); plannedRoute = 'blocked';
  } else if (safety.quota === 'unknown') {
    reasons.push('quota-unknown'); plannedRoute = 'blocked';
  } else if (safety.quota === 'exhausted' || safety.remainingProviderCalls < REQUIRED_MODEL_CALLS) {
    reasons.push('quota-exhausted'); plannedRoute = 'blocked';
  } else if (!matchesAgentLoopMaintenanceProductionRouteJob(job)) {
    reasons.push('production-contract-not-selected'); plannedRoute = 'legacy';
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

  const missing: AgentLoopMaintenanceCanaryPreflightMissingV2[] =
    ['production-single-route-selector'];
  if (!readiness.sourcePolicy) missing.push('source-policy-readiness');
  if (!readiness.runtimeBundle) missing.push('runtime-bundle-readiness');
  if (!readiness.publication) missing.push('publication-readiness');
  if (!readiness.operationalEvidence) missing.push('operational-canary-evidence');
  return freezePlan({
    version: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
    routeContract: routeContractBinding(),
    scope: routeScope(),
    cohort: {
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
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
    publicationAuthorized: false,
    canaryAuthorized: false,
    productionEligible: false,
  });
}

export function planAgentLoopMaintenanceCanaryRouteV2OrBlocked(
  input: AgentLoopMaintenanceCanaryRoutePlanV2Input,
): AgentLoopMaintenanceCanaryRoutePlanV2 {
  try { return planAgentLoopMaintenanceCanaryRouteV2(input); }
  catch { return blockedFallback('input-invalid'); }
}
