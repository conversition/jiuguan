/**
 * Read-only, non-authorizing §13.83 Canary readiness audit.
 *
 * This module deliberately accepts observations as data only. It never accepts
 * or invokes a Runtime factory, publication callback, Store, Manager, Provider
 * client or source reader. A source observation, a static deployment
 * declaration and synthetic local-chain evidence remain different from the
 * four production readiness proofs that a future single dispatcher must own.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  isPublicMaintenanceJob,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH,
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION,
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES,
  type AgentLoopMaintenanceCanaryJobHeader,
  type AgentLoopMaintenanceCanaryRouteState,
} from './agent-loop-maintenance-canary-route-plan.ts';
import {
  AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE as ACCEPTED_CONTRACT,
} from './agent-loop-maintenance-execution-support.ts';
import { MAINTENANCE_POLICY_VERSION } from './maintenance-types.ts';

export const AGENT_LOOP_MAINTENANCE_CANARY_READINESS_AUDIT_VERSION =
  'agent-loop-maintenance-canary-readiness-audit-v1' as const;

export type AgentLoopMaintenanceCanarySourcePolicyObservation =
  | 'not-assessed'
  | 'read-only-source-policy-observation';
export type AgentLoopMaintenanceCanaryRuntimeBundleObservation =
  | 'not-assessed'
  | 'static-correction-proposal-declaration';
export type AgentLoopMaintenanceCanaryPublicationObservation =
  | 'not-assessed'
  | 'static-required-publication-declaration';
export type AgentLoopMaintenanceCanaryOperationalPrerequisite =
  | 'none'
  | 'synthetic-prerequisite';

export interface AgentLoopMaintenanceCanaryObservation<T extends string> {
  readonly classification: T;
  /** A redacted content digest only. This is an audit reference, never a capability. */
  readonly evidenceDigest: string | null;
}

export interface AgentLoopMaintenanceCanaryReadinessAuditInput {
  readonly job: AgentLoopMaintenanceCanaryJobHeader;
  readonly routeControl: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH;
    state: AgentLoopMaintenanceCanaryRouteState;
    revision: number;
  }>;
  readonly windowSequence: number;
  readonly observations: Readonly<{
    sourcePolicy: AgentLoopMaintenanceCanaryObservation<AgentLoopMaintenanceCanarySourcePolicyObservation>;
    runtimeBundle: AgentLoopMaintenanceCanaryObservation<AgentLoopMaintenanceCanaryRuntimeBundleObservation>;
    publication: AgentLoopMaintenanceCanaryObservation<AgentLoopMaintenanceCanaryPublicationObservation>;
    operationalPrerequisite: AgentLoopMaintenanceCanaryObservation<AgentLoopMaintenanceCanaryOperationalPrerequisite>;
  }>;
}

export type AgentLoopMaintenanceCanaryReadinessReason =
  | 'production-single-route-selector-missing'
  | 'source-policy-not-assessed'
  | 'source-policy-observation-non-authorizing'
  | 'runtime-bundle-not-assessed'
  | 'runtime-bundle-context-not-instantiated'
  | 'publication-not-assessed'
  | 'publication-context-not-instantiated'
  | 'operational-evidence-missing'
  | 'synthetic-prerequisite-not-operational-evidence';

export interface AgentLoopMaintenanceCanaryReadinessAudit {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CANARY_READINESS_AUDIT_VERSION;
  readonly routePlanVersion: typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION;
  readonly contractVersion: typeof ACCEPTED_CONTRACT.version;
  readonly scope: typeof ACCEPTED_CONTRACT.scope;
  readonly bindings: Readonly<{
    jobDigest: string;
    cohortGeneration: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH;
    routeControlState: AgentLoopMaintenanceCanaryRouteState;
    routeControlRevision: number;
    windowSequence: number;
  }>;
  readonly layers: Readonly<{
    sourcePolicy: Readonly<{
      observation: AgentLoopMaintenanceCanarySourcePolicyObservation;
      evidenceDigest: string | null;
      productionReady: false;
    }>;
    runtimeBundle: Readonly<{
      observation: AgentLoopMaintenanceCanaryRuntimeBundleObservation;
      evidenceDigest: string | null;
      factoryInvoked: false;
      contextBoundBundleInstantiated: false;
      productionReady: false;
    }>;
    publication: Readonly<{
      observation: AgentLoopMaintenanceCanaryPublicationObservation;
      evidenceDigest: string | null;
      callbackInvoked: false;
      contextBoundPublicationInstantiated: false;
      productionReady: false;
    }>;
    operationalEvidence: Readonly<{
      observation: AgentLoopMaintenanceCanaryOperationalPrerequisite;
      evidenceClass: 'none' | 'synthetic';
      evidenceDigest: string | null;
      productionReady: false;
    }>;
  }>;
  readonly productionReadiness: Readonly<{
    sourcePolicy: false;
    runtimeBundle: false;
    publication: false;
    operationalEvidence: false;
  }>;
  readonly reasonCodes: readonly AgentLoopMaintenanceCanaryReadinessReason[];
  readonly preflight: Readonly<{
    status: 'blocked';
    missing: readonly [
      'production-single-route-selector',
      'source-policy-readiness',
      'runtime-bundle-readiness',
      'publication-readiness',
      'operational-canary-evidence',
    ];
  }>;
  readonly auditDigest: string;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
}

const INPUT_KEYS = Object.freeze(['job', 'observations', 'routeControl', 'windowSequence']);
const JOB_KEYS = Object.freeze([
  'attempt', 'createdAt', 'errorCode', 'finishedAt', 'mode', 'parentRunId', 'policyVersion',
  'runId', 'sessionId', 'sourceRevision', 'startedAt', 'status', 'taskKind', 'trigger', 'updatedAt',
]);
const ROUTE_CONTROL_KEYS = Object.freeze(['generation', 'revision', 'state']);
const OBSERVATION_KEYS = Object.freeze([
  'operationalPrerequisite', 'publication', 'runtimeBundle', 'sourcePolicy',
]);
const LAYER_KEYS = Object.freeze(['classification', 'evidenceDigest']);
const HASH = /^sha256:[a-f0-9]{64}$/u;
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

function invalid(): never {
  throw new Error('agent-loop-maintenance-canary-readiness-audit-input-invalid');
}

function observeOrdinaryPromise(value: unknown): void {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== INTRINSIC_PROMISE.prototype
    || Object.getOwnPropertyDescriptor(value, 'constructor')) return;
  const constructor = Object.getOwnPropertyDescriptor(INTRINSIC_PROMISE.prototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species);
  if (!constructor || !Object.hasOwn(constructor, 'value') || constructor.value !== INTRINSIC_PROMISE
    || !species || species.get !== INTRINSIC_PROMISE_SPECIES || species.set !== undefined) return;
  void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
}

function exactOwnData(
  input: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)) invalid();
    if (nodeTypes.isPromise(input)) { observeOrdinaryPromise(input); invalid(); }
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
      observeOrdinaryPromise(descriptor.value);
      if (nodeTypes.isPromise(descriptor.value)) invalid();
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

function rawDigest(serialized: string): string {
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

function digest(value: unknown): string {
  return rawDigest(JSON.stringify(value));
}

/** Kept byte-compatible with the §13.82 planner's selected job binding. */
function jobDigest(job: PublicMaintenanceJob): string {
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

function observation<T extends string>(
  input: unknown,
  allowed: readonly T[],
  empty: T,
): Readonly<{ classification: T; evidenceDigest: string | null }> {
  const value = exactOwnData(input, LAYER_KEYS);
  if (typeof value.classification !== 'string' || !allowed.includes(value.classification as T)) invalid();
  const classification = value.classification as T;
  if (classification === empty) {
    if (value.evidenceDigest !== null) invalid();
  } else if (typeof value.evidenceDigest !== 'string' || !HASH.test(value.evidenceDigest)) invalid();
  return Object.freeze({ classification, evidenceDigest: value.evidenceDigest as string | null });
}

/**
 * Assemble a redacted readiness audit. The four production readiness fields are
 * constants, not derived from caller observations. A new contract version is
 * required before genuine operational evidence or a context-bound bundle may
 * become production-ready.
 */
export function auditAgentLoopMaintenanceCanaryReadiness(
  unsafeInput: AgentLoopMaintenanceCanaryReadinessAuditInput,
): AgentLoopMaintenanceCanaryReadinessAudit {
  const input = exactOwnData(unsafeInput, INPUT_KEYS);
  const rawJob = exactOwnData(input.job, JOB_KEYS, [
    'errorCode', 'finishedAt', 'parentRunId', 'startedAt',
  ]);
  const routeControl = exactOwnData(input.routeControl, ROUTE_CONTROL_KEYS);
  const rawObservations = exactOwnData(input.observations, OBSERVATION_KEYS);
  if (!isPublicMaintenanceJob(rawJob)
    || rawJob.taskKind !== ACCEPTED_CONTRACT.scope.taskKind
    || rawJob.mode !== ACCEPTED_CONTRACT.scope.mode
    || rawJob.policyVersion !== MAINTENANCE_POLICY_VERSION
    || rawJob.status !== 'queued' || rawJob.attempt !== 0
    || routeControl.generation !== AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH
    || typeof routeControl.state !== 'string'
    || !AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES.includes(
      routeControl.state as AgentLoopMaintenanceCanaryRouteState,
    )
    || !safeInteger(routeControl.revision)
    || !safeInteger(input.windowSequence)) invalid();

  const sourcePolicy = observation(rawObservations.sourcePolicy,
    ['not-assessed', 'read-only-source-policy-observation'] as const, 'not-assessed');
  const runtimeBundle = observation(rawObservations.runtimeBundle,
    ['not-assessed', 'static-correction-proposal-declaration'] as const, 'not-assessed');
  const publication = observation(rawObservations.publication,
    ['not-assessed', 'static-required-publication-declaration'] as const, 'not-assessed');
  const operational = observation(rawObservations.operationalPrerequisite,
    ['none', 'synthetic-prerequisite'] as const, 'none');

  const bindings = Object.freeze({
    jobDigest: jobDigest(rawJob),
    cohortGeneration: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH,
    routeControlState: routeControl.state as AgentLoopMaintenanceCanaryRouteState,
    routeControlRevision: routeControl.revision as number,
    windowSequence: input.windowSequence as number,
  });
  const layers = Object.freeze({
    sourcePolicy: Object.freeze({
      observation: sourcePolicy.classification,
      evidenceDigest: sourcePolicy.evidenceDigest,
      productionReady: false as const,
    }),
    runtimeBundle: Object.freeze({
      observation: runtimeBundle.classification,
      evidenceDigest: runtimeBundle.evidenceDigest,
      factoryInvoked: false as const,
      contextBoundBundleInstantiated: false as const,
      productionReady: false as const,
    }),
    publication: Object.freeze({
      observation: publication.classification,
      evidenceDigest: publication.evidenceDigest,
      callbackInvoked: false as const,
      contextBoundPublicationInstantiated: false as const,
      productionReady: false as const,
    }),
    operationalEvidence: Object.freeze({
      observation: operational.classification,
      evidenceClass: operational.classification === 'synthetic-prerequisite' ? 'synthetic' as const : 'none' as const,
      evidenceDigest: operational.evidenceDigest,
      productionReady: false as const,
    }),
  });
  const reasonCodes = Object.freeze([
    'production-single-route-selector-missing' as const,
    sourcePolicy.classification === 'not-assessed'
      ? 'source-policy-not-assessed' as const
      : 'source-policy-observation-non-authorizing' as const,
    runtimeBundle.classification === 'not-assessed'
      ? 'runtime-bundle-not-assessed' as const
      : 'runtime-bundle-context-not-instantiated' as const,
    publication.classification === 'not-assessed'
      ? 'publication-not-assessed' as const
      : 'publication-context-not-instantiated' as const,
    operational.classification === 'none'
      ? 'operational-evidence-missing' as const
      : 'synthetic-prerequisite-not-operational-evidence' as const,
  ]);
  const stable = {
    version: AGENT_LOOP_MAINTENANCE_CANARY_READINESS_AUDIT_VERSION,
    routePlanVersion: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION,
    contractVersion: ACCEPTED_CONTRACT.version,
    scope: Object.freeze({ ...ACCEPTED_CONTRACT.scope }),
    bindings,
    layers,
    productionReadiness: Object.freeze({
      sourcePolicy: false as const,
      runtimeBundle: false as const,
      publication: false as const,
      operationalEvidence: false as const,
    }),
    reasonCodes,
    preflight: Object.freeze({
      status: 'blocked' as const,
      missing: Object.freeze([
        'production-single-route-selector',
        'source-policy-readiness',
        'runtime-bundle-readiness',
        'publication-readiness',
        'operational-canary-evidence',
      ] as const),
    }),
    claimAuthorized: false as const,
    executionAuthorized: false as const,
    completionAuthorized: false as const,
    publicationAuthorized: false as const,
    canaryAuthorized: false as const,
    productionEligible: false as const,
  };
  return Object.freeze({ ...stable, auditDigest: digest(stable) });
}
