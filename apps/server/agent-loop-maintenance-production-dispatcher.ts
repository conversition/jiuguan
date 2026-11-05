// §13.88/§13.90 exact-instance, non-authorizing production-route dispatcher envelope.
//
// The server wires exactly one instance into its existing Maintenance pump.
// The synchronous selector acquires the exact source-policy proof and computes
// a versioned route decision inside MaintenanceJobManager's existing SQLite writer
// transaction. In proof-bound mode the Manager transaction encloses the
// Admission, Session and Control/Quota/Assets writer reservations in that one
// fixed order; the Manager claim is committed by the innermost continuation
// before the reservations unwind in reverse order.
//
// The ordinary proof-bound construction remains Legacy-only. Separately
// branded exact-Runtime ports open either isolated acceptance or the one
// production canary-5 route; larger rollout states remain Legacy. This keeps
// readiness out of caller-authored booleans while preserving one
// Manager -> dispatcher -> single-pump handoff.
import { types as nodeTypes } from 'node:util';
import type { PublicMaintenanceJob } from '@jiuguan/mobile-contracts';
import { MemoryDb } from '../../packages/memory/public/db.ts';
import {
  AgentAdmissionLedger,
  isAgentAdmissionLedgerInstanceInternal,
  type MaintenanceAdmissionRow,
} from './agent-admission-ledger.ts';
import {
  AgentControlStore,
  isAgentControlStoreInstanceInternal,
  type AgentControlFenceSnapshot,
} from './agent-control-store.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
  agentLoopMaintenanceCanaryRoutePlanV2JobDigest,
  planAgentLoopMaintenanceCanaryRouteV2,
  type AgentLoopMaintenanceCanaryRoutePlanV2Input,
} from './agent-loop-maintenance-canary-route-plan-v2.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES,
  type AgentLoopMaintenanceCanaryRouteState,
} from './agent-loop-maintenance-canary-route-plan.ts';
import {
  agentLoopMaintenanceCanarySourcePolicyAdmissionDigest,
  agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest,
  isAgentLoopMaintenanceCanarySourcePolicyReaderForAdmissionLedgerInternal,
  isAgentLoopMaintenanceCanarySourcePolicyReaderForManager,
  readAgentLoopMaintenanceCanarySourcePolicyProofSessionEvidenceInternal,
  type AgentLoopMaintenanceCanarySourcePolicyProof,
  type AgentLoopMaintenanceCanarySourcePolicyReader,
} from './agent-loop-maintenance-canary-source-policy.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
  matchesAgentLoopMaintenanceProductionRouteJob,
} from './agent-loop-maintenance-production-route-contract.ts';
import {
  isAgentLoopMaintenanceIsolatedCanaryExecutionPort,
  isAgentLoopMaintenanceIsolatedCanaryExecutionPortForManager,
  isAgentLoopMaintenanceProductionCanaryExecutionPort,
  isAgentLoopMaintenanceProductionCanaryExecutionPortForManager,
  type AgentLoopMaintenanceIsolatedCanaryExecutionPort,
  type AgentLoopMaintenanceProductionCanaryExecutionPort,
} from './agent-loop-runtime.ts';
import {
  MAINTENANCE_PRODUCTION_DISPATCH_DECISION_VERSION,
  MaintenanceJobManager,
  registerMaintenanceProductionQueuedRouteSelectorInternal,
  type MaintenanceExecutionRecord,
  type MaintenanceProductionClaimCoordinator,
  type MaintenanceProductionQueuedRouteDecision,
  type MaintenanceProductionQueuedRouteSelector,
} from './maintenance-job-manager.ts';
import type { MaintenanceTaskKind } from './maintenance-types.ts';

const MAINTENANCE_JOB_MANAGER_PROTOTYPE = MaintenanceJobManager.prototype;
const PRODUCTION_CLAIM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  MAINTENANCE_JOB_MANAGER_PROTOTYPE,
  'claimNextProductionRouted',
);
if (!PRODUCTION_CLAIM_DESCRIPTOR
  || !Object.hasOwn(PRODUCTION_CLAIM_DESCRIPTOR, 'value')
  || typeof PRODUCTION_CLAIM_DESCRIPTOR.value !== 'function'
  || PRODUCTION_CLAIM_DESCRIPTOR.get !== undefined
  || PRODUCTION_CLAIM_DESCRIPTOR.set !== undefined) {
  throw new Error('agent-loop-maintenance-production-manager-intrinsic-invalid');
}
const CLAIM_NEXT_PRODUCTION_ROUTED = PRODUCTION_CLAIM_DESCRIPTOR.value as
  MaintenanceJobManager['claimNextProductionRouted'];

export const AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER_VERSION =
  MAINTENANCE_PRODUCTION_DISPATCH_DECISION_VERSION;

/**
 * Synchronous route controls and safety facts only. There is intentionally no
 * readiness, authority or `canClaim` field for a caller to self-report.
 */
export interface AgentLoopMaintenanceProductionRouteSnapshot {
  readonly routeControl: Readonly<{
    readonly generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
    readonly state: AgentLoopMaintenanceCanaryRouteState;
    readonly revision: number;
    readonly targetSessionId: string | null;
    readonly evidenceDigest: string | null;
  }>;
  readonly safety: Readonly<{
    readonly maintenanceAllowed: boolean;
    readonly capabilityAllowed: boolean;
    readonly operationalEvidenceMatches: boolean;
    readonly quota: 'ready' | 'exhausted' | 'unknown';
    readonly remainingProviderCalls: number;
    readonly windowSequence: number;
  }>;
}

export type AgentLoopMaintenanceProductionRouteSnapshotReader = (
  job: Readonly<PublicMaintenanceJob>,
) => AgentLoopMaintenanceProductionRouteSnapshot;

export interface AgentLoopMaintenanceProductionDispatcherDecision
  extends MaintenanceProductionQueuedRouteDecision {
  readonly dispatcherVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER_VERSION;
  readonly queuedJobDigest: string | null;
  readonly sourcePolicyProofDigest: string | null;
  readonly routePlanDigest: string | null;
  readonly routeControlGeneration: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2 | null;
  readonly routeControlState: AgentLoopMaintenanceCanaryRouteState | null;
  readonly routeControlRevision: number | null;
  readonly windowSequence: number | null;
}

export interface AgentLoopMaintenanceProductionDispatcherOptions {
  readonly manager: MaintenanceJobManager;
  readonly admissionLedger: AgentAdmissionLedger;
  readonly controlStore: AgentControlStore;
  readonly resolveSessionMemory: (sessionId: string) => MemoryDb | null;
  readonly sourcePolicyReader: AgentLoopMaintenanceCanarySourcePolicyReader;
  readonly readRouteSnapshot: AgentLoopMaintenanceProductionRouteSnapshotReader;
}

/**
 * Production-isomorphic acceptance only.  The port is issued by the exact
 * open Runtime and cannot be replaced by a structural callback.  Keeping this
 * as a distinct construction makes accidental server activation statically
 * visible and leaves the ordinary proof-bound path Legacy-only.
 */
export interface AgentLoopMaintenanceIsolatedCanaryDispatcherOptions
  extends AgentLoopMaintenanceProductionDispatcherOptions {
  readonly mode: 'isolated-canary-acceptance';
  readonly agentLoop: AgentLoopMaintenanceIsolatedCanaryExecutionPort;
}

/**
 * The only live production Canary admitted by this dispatcher.  Its exact
 * Runtime port is separately branded from the isolated acceptance port, and
 * the selector below further caps AL routing to the durable canary-5 state.
 */
export interface AgentLoopMaintenanceProductionCanaryDispatcherOptions
  extends AgentLoopMaintenanceProductionDispatcherOptions {
  readonly mode: 'production-canary-5';
  readonly agentLoop: AgentLoopMaintenanceProductionCanaryExecutionPort;
}

/** Code-owned migration mode: exact p14 work stays on Legacy without reading
 * AL routing proof/readiness/quota state. Shared Legacy execution gates remain
 * mandatory. A later AL rollout requires a proof-bound construction. */
export interface AgentLoopMaintenanceClosedLegacyDispatcherOptions {
  readonly manager: MaintenanceJobManager;
  readonly mode: 'closed-legacy';
  readonly routeControl: Readonly<{
    readonly generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
    readonly state: 'off';
    readonly revision: number;
  }>;
}

export type AgentLoopMaintenanceProductionDispatcherFactoryOptions =
  | AgentLoopMaintenanceProductionDispatcherOptions
  | AgentLoopMaintenanceIsolatedCanaryDispatcherOptions
  | AgentLoopMaintenanceProductionCanaryDispatcherOptions
  | AgentLoopMaintenanceClosedLegacyDispatcherOptions;

export interface AgentLoopMaintenanceProductionDispatcher {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER_VERSION;
  claimNext(
    this: AgentLoopMaintenanceProductionDispatcher,
    owner: string,
    leaseMs: number,
    commonCanClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean,
  ): MaintenanceExecutionRecord | null;
}

const DISPATCHERS = new WeakSet<object>();
const DISPATCHER_MANAGERS = new WeakMap<object, MaintenanceJobManager>();
type AgentLoopMaintenanceCanaryExecutionPort =
  | AgentLoopMaintenanceIsolatedCanaryExecutionPort
  | AgentLoopMaintenanceProductionCanaryExecutionPort;
const DISPATCHER_AGENT_LOOP_PORTS = new WeakMap<
  object,
  AgentLoopMaintenanceCanaryExecutionPort
>();
const ROUTE_SNAPSHOT_READER_STORES = new WeakMap<
  AgentLoopMaintenanceProductionRouteSnapshotReader,
  AgentControlStore
>();
const OPTION_KEYS = Object.freeze([
  'admissionLedger', 'controlStore', 'manager', 'readRouteSnapshot',
  'resolveSessionMemory', 'sourcePolicyReader',
]);
const CANARY_OPTION_KEYS = Object.freeze([
  'admissionLedger', 'agentLoop', 'controlStore', 'manager', 'mode', 'readRouteSnapshot',
  'resolveSessionMemory', 'sourcePolicyReader',
]);
const CLOSED_OPTION_KEYS = Object.freeze(['manager', 'mode', 'routeControl']);
const SNAPSHOT_KEYS = Object.freeze(['routeControl', 'safety']);
const ROUTE_CONTROL_KEYS = Object.freeze([
  'evidenceDigest', 'generation', 'revision', 'state', 'targetSessionId',
]);
const CLOSED_ROUTE_CONTROL_KEYS = Object.freeze(['generation', 'revision', 'state']);
const SAFETY_KEYS = Object.freeze([
  'capabilityAllowed', 'maintenanceAllowed', 'operationalEvidenceMatches', 'quota',
  'remainingProviderCalls', 'windowSequence',
]);
const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const EVIDENCE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

function exactAdmissionLedger(value: unknown): value is AgentAdmissionLedger {
  return isAgentAdmissionLedgerInstanceInternal(value) && !nodeTypes.isProxy(value)
    && value instanceof AgentAdmissionLedger
    && Object.getPrototypeOf(value) === AgentAdmissionLedger.prototype
    && !Object.hasOwn(value, 'withMaintenanceClaimFence')
    && !Object.hasOwn(value, 'readMaintenanceAuthority');
}

function exactControlStore(value: unknown): value is AgentControlStore {
  return isAgentControlStoreInstanceInternal(value) && !nodeTypes.isProxy(value)
    && value instanceof AgentControlStore
    && Object.getPrototypeOf(value) === AgentControlStore.prototype
    && !Object.hasOwn(value, 'withClaimFence')
    && !Object.hasOwn(value, 'authorityCoordinate');
}

function exactSessionMemory(value: unknown): value is MemoryDb {
  return typeof value === 'object' && value !== null && !nodeTypes.isProxy(value)
    && value instanceof MemoryDb
    && Object.getPrototypeOf(value) === MemoryDb.prototype
    && !Object.hasOwn(value, 'withSessionClaimFence')
    && !Object.hasOwn(value, 'readSessionAuthority');
}

function sameAuthority(
  first: Readonly<{ generation: string; revision: number }>,
  second: Readonly<{ generation: string; revision: number }>,
): boolean {
  return first.generation === second.generation && first.revision === second.revision;
}

function admissionProofRows(
  rows: readonly MaintenanceAdmissionRow[],
): readonly object[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    decisionId: row.decisionId,
    parentRunId: row.parentRunId,
    sessionId: row.sessionId,
    sourceRevision: row.sourceRevision,
    factsTaskKind: row.facts.taskKind,
    decisionTaskKind: row.decision.taskKind,
    policyVersion: row.decision.policyVersion,
    verdict: row.decision.verdict,
    factsDigest: row.decision.factsDigest,
    sourceDigest: row.facts.sourceDigest,
    observationDigest: row.facts.observationDigest,
    createdAt: row.createdAt,
  })));
}

function routeSnapshotFromControlFence(
  snapshot: AgentControlFenceSnapshot,
): AgentLoopMaintenanceProductionRouteSnapshot {
  const quota = snapshot.currentQuota;
  const remainingProviderCalls = quota.maxProviderCalls
    - quota.providerCalls
    - quota.providerErrors
    - quota.reservedProviderCalls;
  const maintenanceAllowed = snapshot.maintenanceLane.desiredState !== 'off'
    && snapshot.maintenanceLane.desiredState !== 'killed';
  const memoryCapability = snapshot.maintenanceCapabilities.find(
    (capability) => capability.capabilityId === 'maintenance.memory',
  );
  return Object.freeze({
    routeControl: Object.freeze({
      generation: snapshot.maintenanceRoute.cohortGeneration,
      state: snapshot.maintenanceRoute.state,
      revision: snapshot.maintenanceRoute.revision,
      targetSessionId: snapshot.maintenanceRoute.targetSessionId,
      evidenceDigest: snapshot.maintenanceRoute.evidenceDigest,
    }),
    safety: Object.freeze({
      maintenanceAllowed,
      capabilityAllowed: memoryCapability?.killedReason === null,
      operationalEvidenceMatches: snapshot.maintenanceRoute.evidenceDigest !== null
        && snapshot.maintenanceRoute.evidenceDigest
          === snapshot.maintenanceOperationalEvidenceDigest,
      quota: quota.status === 'active' && remainingProviderCalls > 0
        ? 'ready'
        : 'exhausted',
      remainingProviderCalls,
      windowSequence: quota.windowSequence,
    }),
  });
}

/** Exact module-issued dispatcher identity; structural lookalikes grant nothing. */
export function isAgentLoopMaintenanceProductionDispatcher(
  value: unknown,
): value is AgentLoopMaintenanceProductionDispatcher {
  return typeof value === 'object' && value !== null && DISPATCHERS.has(value);
}

/** Exact module brand plus the Manager instance captured at construction. */
export function isAgentLoopMaintenanceProductionDispatcherForManager(
  value: unknown,
  manager: MaintenanceJobManager,
): value is AgentLoopMaintenanceProductionDispatcher {
  return isAgentLoopMaintenanceProductionDispatcher(value)
    && DISPATCHER_MANAGERS.get(value) === manager;
}

/** Whether this dispatcher can ever return an AgentLoop-owned claim. */
export function agentLoopMaintenanceProductionDispatcherRequiresAgentLoopPort(
  value: unknown,
): boolean {
  return isAgentLoopMaintenanceProductionDispatcher(value)
    && DISPATCHER_AGENT_LOOP_PORTS.has(value);
}

/** Exact dispatcher/Runtime-port binding consumed by the single Harness pump. */
export function isAgentLoopMaintenanceProductionDispatcherForAgentLoopPort(
  value: unknown,
  port: unknown,
): port is AgentLoopMaintenanceCanaryExecutionPort {
  return isAgentLoopMaintenanceProductionDispatcher(value)
    && DISPATCHER_AGENT_LOOP_PORTS.get(value) === port
    && (isAgentLoopMaintenanceIsolatedCanaryExecutionPort(port)
      || isAgentLoopMaintenanceProductionCanaryExecutionPort(port));
}

function observeOrdinaryPromise(value: unknown): void {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) return;
  const originalConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  const intrinsicConstructor = Object.getOwnPropertyDescriptor(
    INTRINSIC_PROMISE.prototype,
    'constructor',
  );
  const intrinsicSpecies = Object.getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species);
  if (!intrinsicConstructor || !Object.hasOwn(intrinsicConstructor, 'value')
    || intrinsicConstructor.value !== INTRINSIC_PROMISE
    || !intrinsicSpecies || intrinsicSpecies.get !== INTRINSIC_PROMISE_SPECIES
    || intrinsicSpecies.set !== undefined) return;

  let shadowedConstructor = false;
  try {
    if (!originalConstructor && Object.getPrototypeOf(value) === INTRINSIC_PROMISE.prototype) {
      void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
      return;
    }
    if (!originalConstructor || originalConstructor.configurable
      || (Object.hasOwn(originalConstructor, 'value') && originalConstructor.writable === true)) {
      Object.defineProperty(value, 'constructor', {
        configurable: originalConstructor?.configurable ?? true,
        enumerable: originalConstructor?.enumerable ?? false,
        value: INTRINSIC_PROMISE,
        writable: originalConstructor && Object.hasOwn(originalConstructor, 'value')
          ? originalConstructor.writable
          : true,
      });
      shadowedConstructor = true;
    } else if (!Object.hasOwn(originalConstructor, 'value')
      || originalConstructor.value !== INTRINSIC_PROMISE) return;
    void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
  } catch {
    // The value is already rejected as an invalid synchronous dependency.
  } finally {
    if (shadowedConstructor) {
      try {
        if (originalConstructor) Object.defineProperty(value, 'constructor', originalConstructor);
        else Reflect.deleteProperty(value, 'constructor');
      } catch {
        // Native non-Proxy Promises have ordinary property semantics.
      }
    }
  }
}

function synchronous(value: unknown): boolean {
  if (!nodeTypes.isPromise(value)) return true;
  observeOrdinaryPromise(value);
  return false;
}

function exactOwnData(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
      || !synchronous(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'
      || !keys.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined
        || !synchronous(descriptor.value)) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeSnapshot(value: unknown): AgentLoopMaintenanceProductionRouteSnapshot | null {
  const input = exactOwnData(value, SNAPSHOT_KEYS);
  if (!input) return null;
  const routeControl = exactOwnData(input.routeControl, ROUTE_CONTROL_KEYS);
  const safety = exactOwnData(input.safety, SAFETY_KEYS);
  if (!routeControl || !safety
    || routeControl.generation !== AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2
    || typeof routeControl.state !== 'string'
    || !AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_STATES.includes(
      routeControl.state as AgentLoopMaintenanceCanaryRouteState,
    )
    || !safeInteger(routeControl.revision)
    || (routeControl.state === 'canary-5'
      ? (typeof routeControl.targetSessionId !== 'string'
        || !SESSION_ID_RE.test(routeControl.targetSessionId)
        || typeof routeControl.evidenceDigest !== 'string'
        || !EVIDENCE_DIGEST_RE.test(routeControl.evidenceDigest))
      : (routeControl.targetSessionId !== null || routeControl.evidenceDigest !== null))
    || (safety.maintenanceAllowed !== true && safety.maintenanceAllowed !== false)
    || (safety.capabilityAllowed !== true && safety.capabilityAllowed !== false)
    || (safety.operationalEvidenceMatches !== true
      && safety.operationalEvidenceMatches !== false)
    || (safety.quota !== 'ready' && safety.quota !== 'exhausted' && safety.quota !== 'unknown')
    || !safeInteger(safety.remainingProviderCalls)
    || !safeInteger(safety.windowSequence)) return null;
  return Object.freeze({
    routeControl: Object.freeze({
      generation: AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
      state: routeControl.state as AgentLoopMaintenanceCanaryRouteState,
      revision: routeControl.revision as number,
      targetSessionId: routeControl.targetSessionId as string | null,
      evidenceDigest: routeControl.evidenceDigest as string | null,
    }),
    safety: Object.freeze({
      maintenanceAllowed: safety.maintenanceAllowed as boolean,
      capabilityAllowed: safety.capabilityAllowed as boolean,
      operationalEvidenceMatches: safety.operationalEvidenceMatches as boolean,
      quota: safety.quota as 'ready' | 'exhausted' | 'unknown',
      remainingProviderCalls: safety.remainingProviderCalls as number,
      windowSequence: safety.windowSequence as number,
    }),
  });
}

function sameSnapshot(
  first: AgentLoopMaintenanceProductionRouteSnapshot,
  second: AgentLoopMaintenanceProductionRouteSnapshot,
): boolean {
  return first.routeControl.generation === second.routeControl.generation
    && first.routeControl.state === second.routeControl.state
    && first.routeControl.revision === second.routeControl.revision
    && first.routeControl.targetSessionId === second.routeControl.targetSessionId
    && first.routeControl.evidenceDigest === second.routeControl.evidenceDigest
    && first.safety.maintenanceAllowed === second.safety.maintenanceAllowed
    && first.safety.capabilityAllowed === second.safety.capabilityAllowed
    && first.safety.operationalEvidenceMatches === second.safety.operationalEvidenceMatches
    && first.safety.quota === second.safety.quota
    && first.safety.remainingProviderCalls === second.safety.remainingProviderCalls
    && first.safety.windowSequence === second.safety.windowSequence;
}

function routePlanControl(
  snapshot: AgentLoopMaintenanceProductionRouteSnapshot,
): AgentLoopMaintenanceCanaryRoutePlanV2Input['routeControl'] {
  return Object.freeze({
    generation: snapshot.routeControl.generation,
    state: snapshot.routeControl.state,
    revision: snapshot.routeControl.revision,
  });
}

function routePlanSafety(
  snapshot: AgentLoopMaintenanceProductionRouteSnapshot,
): AgentLoopMaintenanceCanaryRoutePlanV2Input['safety'] {
  return Object.freeze({
    maintenanceAllowed: snapshot.safety.maintenanceAllowed,
    capabilityAllowed: snapshot.safety.capabilityAllowed,
    quota: snapshot.safety.quota,
    remainingProviderCalls: snapshot.safety.remainingProviderCalls,
    windowSequence: snapshot.safety.windowSequence,
  });
}

function productionCanaryTargetSelected(
  snapshot: AgentLoopMaintenanceProductionRouteSnapshot,
  job: Readonly<PublicMaintenanceJob>,
): boolean {
  return snapshot.routeControl.state === 'canary-5'
    && snapshot.routeControl.targetSessionId === job.sessionId;
}

function controlLegacyRouteAllowed(
  snapshot: AgentLoopMaintenanceProductionRouteSnapshot,
  job: Readonly<PublicMaintenanceJob>,
): boolean {
  return planAgentLoopMaintenanceCanaryRouteV2({
    job,
    routeControl: routePlanControl(snapshot),
    safety: routePlanSafety(snapshot),
    readiness: {
      sourcePolicy: false,
      runtimeBundle: false,
      publication: false,
      operationalEvidence: false,
    },
  }).plannedRoute === 'legacy';
}

/**
 * Internal exact-store route reader.  An optional comparison callback exists
 * only to preserve fail-closed boundary tests and migration adapters: its
 * value must normalize to the same snapshot, while the returned authority is
 * always the canonical snapshot captured from `controlStore` itself.
 */
export function createAgentLoopMaintenanceProductionRouteSnapshotReaderInternal(
  controlStore: AgentControlStore,
  compare?: (job: Readonly<PublicMaintenanceJob>) => unknown,
): AgentLoopMaintenanceProductionRouteSnapshotReader {
  if (!exactControlStore(controlStore)
    || (compare !== undefined && typeof compare !== 'function')) {
    throw new Error('agent-loop-maintenance-production-route-reader-invalid');
  }
  const reader: AgentLoopMaintenanceProductionRouteSnapshotReader = Object.freeze(
    (job: Readonly<PublicMaintenanceJob>) => {
      const canonical = controlStore.withClaimFence(routeSnapshotFromControlFence);
      if (compare !== undefined) {
        const observed = normalizeSnapshot(compare(job));
        if (!observed || !sameSnapshot(canonical, observed)) {
          throw new Error('agent-loop-maintenance-production-route-snapshot-mismatch');
        }
      }
      return canonical;
    },
  );
  ROUTE_SNAPSHOT_READER_STORES.set(reader, controlStore);
  return reader;
}

function isProductionRouteSnapshotReaderForStore(
  value: unknown,
  controlStore: AgentControlStore,
): value is AgentLoopMaintenanceProductionRouteSnapshotReader {
  return typeof value === 'function'
    && ROUTE_SNAPSHOT_READER_STORES.get(
      value as AgentLoopMaintenanceProductionRouteSnapshotReader,
    ) === controlStore;
}

function decision(
  routeBasis: AgentLoopMaintenanceProductionDispatcherDecision['routeBasis'],
  executorRoute: 'legacy' | 'agent-loop',
  jobDigest: string,
  audit: Readonly<{
    queuedJobDigest: string;
    sourcePolicyProofDigest: string | null;
    routePlanDigest: string | null;
    routeControlGeneration: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
    routeControlState: AgentLoopMaintenanceCanaryRouteState;
    routeControlRevision: number;
    routeControlTargetSessionId: string | null;
    routeControlEvidenceDigest: string | null;
    windowSequence: number | null;
  }> | null,
): AgentLoopMaintenanceProductionDispatcherDecision {
  return Object.freeze({
    routeBasis,
    executorRoute,
    routePlanVersion: AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
    routeContractVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.version,
    routeContractDigest: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
    jobDigest,
    admissionPolicyVersion:
      AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion,
    executionPolicyVersion:
      AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion,
    dispatcherVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER_VERSION,
    queuedJobDigest: audit?.queuedJobDigest ?? null,
    sourcePolicyProofDigest: audit?.sourcePolicyProofDigest ?? null,
    routePlanDigest: audit?.routePlanDigest ?? null,
    routeControlGeneration: audit?.routeControlGeneration ?? null,
    routeControlState: audit?.routeControlState ?? null,
    routeControlRevision: audit?.routeControlRevision ?? null,
    routeControlTargetSessionId: audit?.routeControlTargetSessionId ?? null,
    routeControlEvidenceDigest: audit?.routeControlEvidenceDigest ?? null,
    windowSequence: audit?.windowSequence ?? null,
  });
}

/**
 * Captures dependencies without reading Manager, Session or ledger state.
 * Closed-Legacy mode copies one exact code-owned `off` control at construction;
 * proof-bound mode remains lazy. `claimNext` invokes one Manager routed-claim.
 */
export function createAgentLoopMaintenanceProductionDispatcher(
  unsafeOptions: AgentLoopMaintenanceProductionDispatcherFactoryOptions,
): AgentLoopMaintenanceProductionDispatcher {
  const activeInput = exactOwnData(unsafeOptions, OPTION_KEYS);
  const canaryInput = activeInput
    ? null
    : exactOwnData(unsafeOptions, CANARY_OPTION_KEYS);
  const isolatedCanaryInput = canaryInput?.mode === 'isolated-canary-acceptance'
    ? canaryInput : null;
  const productionCanaryInput = canaryInput?.mode === 'production-canary-5'
    ? canaryInput : null;
  const closedInput = activeInput || canaryInput
    ? null
    : exactOwnData(unsafeOptions, CLOSED_OPTION_KEYS);
  const input = activeInput ?? canaryInput ?? closedInput;
  if (!input || nodeTypes.isProxy(input.manager)
    || !(input.manager instanceof MaintenanceJobManager)
    || Object.getPrototypeOf(input.manager) !== MAINTENANCE_JOB_MANAGER_PROTOTYPE
    || Object.hasOwn(input.manager, 'claimNextProductionRouted')) {
    throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
  }
  const manager = input.manager as MaintenanceJobManager;
  let admissionLedger: AgentAdmissionLedger | null = null;
  let controlStore: AgentControlStore | null = null;
  let resolveSessionMemory: ((sessionId: string) => MemoryDb | null) | null = null;
  let sourcePolicyReader: AgentLoopMaintenanceCanarySourcePolicyReader | null = null;
  let readRouteSnapshot: AgentLoopMaintenanceProductionRouteSnapshotReader | null = null;
  let agentLoop: AgentLoopMaintenanceCanaryExecutionPort | null = null;
  let closedRouteControl: Readonly<{
    generation: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2;
    state: 'off';
    revision: number;
  }> | null = null;
  const proofBoundInput = activeInput ?? canaryInput;
  if (proofBoundInput) {
    if (!isAgentLoopMaintenanceCanarySourcePolicyReaderForManager(
      proofBoundInput.sourcePolicyReader,
      manager,
    )
      || !exactAdmissionLedger(proofBoundInput.admissionLedger)
      || !isAgentLoopMaintenanceCanarySourcePolicyReaderForAdmissionLedgerInternal(
        proofBoundInput.sourcePolicyReader,
        proofBoundInput.admissionLedger,
      )
      || !exactControlStore(proofBoundInput.controlStore)
      || typeof proofBoundInput.resolveSessionMemory !== 'function'
      || nodeTypes.isProxy(proofBoundInput.resolveSessionMemory)
      || !isProductionRouteSnapshotReaderForStore(
        proofBoundInput.readRouteSnapshot,
        proofBoundInput.controlStore,
      )) {
      throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
    }
    if (canaryInput && !isolatedCanaryInput && !productionCanaryInput) {
      throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
    }
    if (isolatedCanaryInput
      && (!isAgentLoopMaintenanceIsolatedCanaryExecutionPortForManager(
        isolatedCanaryInput.agentLoop,
        manager,
      ) || isAgentLoopMaintenanceProductionCanaryExecutionPort(
        isolatedCanaryInput.agentLoop,
      ))) {
      throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
    }
    if (productionCanaryInput
      && (!isAgentLoopMaintenanceProductionCanaryExecutionPortForManager(
        productionCanaryInput.agentLoop,
        manager,
      ) || isAgentLoopMaintenanceIsolatedCanaryExecutionPort(
        productionCanaryInput.agentLoop,
      ))) {
      throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
    }
    admissionLedger = proofBoundInput.admissionLedger;
    controlStore = proofBoundInput.controlStore;
    resolveSessionMemory = proofBoundInput.resolveSessionMemory as (sessionId: string) => MemoryDb | null;
    sourcePolicyReader = proofBoundInput.sourcePolicyReader as
      AgentLoopMaintenanceCanarySourcePolicyReader;
    readRouteSnapshot = proofBoundInput.readRouteSnapshot;
    agentLoop = canaryInput
      ? canaryInput.agentLoop as AgentLoopMaintenanceCanaryExecutionPort
      : null;
  } else {
    const routeControl = exactOwnData(closedInput?.routeControl, CLOSED_ROUTE_CONTROL_KEYS);
    if (closedInput?.mode !== 'closed-legacy' || !routeControl
      || routeControl.generation !== AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2
      || routeControl.state !== 'off'
      || !safeInteger(routeControl.revision)) {
      throw new Error('agent-loop-maintenance-production-dispatcher-options-invalid');
    }
    closedRouteControl = Object.freeze({
      generation: routeControl.generation,
      state: 'off',
      revision: routeControl.revision,
    });
  }

  interface AuditedSelectionEvidence {
    readonly kind: 'audited';
    readonly proof: AgentLoopMaintenanceCanarySourcePolicyProof;
    readonly routeSnapshot: AgentLoopMaintenanceProductionRouteSnapshot;
    readonly routePlanDigest: string;
  }
  interface ControlLegacySelectionEvidence {
    readonly kind: 'control-legacy';
    readonly routeSnapshot: AgentLoopMaintenanceProductionRouteSnapshot;
  }
  type SelectionEvidence = AuditedSelectionEvidence | ControlLegacySelectionEvidence;
  // A selected decision is useful to Manager only when it is the exact object
  // issued by this invocation.  Keep the non-serializable source proof and the
  // full route snapshot in a private, per-dispatcher side table until the
  // deepest claim fence consumes them.
  const selectionEvidence = new WeakMap<object, SelectionEvidence>();

  const selectRoute: MaintenanceProductionQueuedRouteSelector = candidate => {
    const jobDigest = agentLoopMaintenanceCanaryRoutePlanV2JobDigest(candidate);
    if (!jobDigest) return null;

    // Non-production work preserves the ordinary path without borrowing an
    // audit proof; non-pristine rows in the reserved p14 namespace fail closed.
    if (!matchesAgentLoopMaintenanceProductionRouteJob(candidate)) {
      const admission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
      const reservedProductionNamespace = candidate.taskKind === admission.taskKind
        && candidate.policyVersion === admission.policyVersion
        && candidate.trigger === admission.trigger;
      return reservedProductionNamespace
        ? null
        : decision('ordinary-legacy', 'legacy', jobDigest, null);
    }

    const queuedJobDigest = agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(candidate);
    if (!queuedJobDigest) return null;
    if (closedRouteControl) {
      return decision('control-off-legacy', 'legacy', jobDigest, {
        queuedJobDigest,
        sourcePolicyProofDigest: null,
        routePlanDigest: null,
        routeControlGeneration: closedRouteControl.generation,
        routeControlState: closedRouteControl.state,
        routeControlRevision: closedRouteControl.revision,
        routeControlTargetSessionId: null,
        routeControlEvidenceDigest: null,
        windowSequence: null,
      });
    }
    if (!sourcePolicyReader || !readRouteSnapshot) return null;

    try {
      const before = normalizeSnapshot(readRouteSnapshot(candidate));
      if (!before) return null;
      // Production Canary is deliberately capped at one stable 5% cohort.
      // Every other durable route state is a dynamic Control-owned Legacy
      // decision: it reads no source proof and is finalized later while the
      // exact same ControlStore writer fence is held inside the Manager TX.
      if (productionCanaryInput && !productionCanaryTargetSelected(before, candidate)) {
        if (!controlLegacyRouteAllowed(before, candidate)) return null;
        const after = normalizeSnapshot(readRouteSnapshot(candidate));
        if (!after || !sameSnapshot(before, after)) return null;
        const selected = decision('control-legacy', 'legacy', jobDigest, {
          queuedJobDigest,
          sourcePolicyProofDigest: null,
          routePlanDigest: null,
          routeControlGeneration: before.routeControl.generation,
          routeControlState: before.routeControl.state,
          routeControlRevision: before.routeControl.revision,
          routeControlTargetSessionId: before.routeControl.targetSessionId,
          routeControlEvidenceDigest: before.routeControl.evidenceDigest,
          windowSequence: before.safety.windowSequence,
        });
        selectionEvidence.set(selected, Object.freeze({
          kind: 'control-legacy' as const,
          routeSnapshot: before,
        }));
        return selected;
      }
      const observedProof = sourcePolicyReader.read(candidate.runId);
      const proof = observedProof && sourcePolicyReader.isProof(observedProof)
        ? observedProof : null;
      // A null proof conflates AL-specific unreadiness with global release,
      // Session and maintenance safety gates. Until a branded failure class
      // exists, production-scope work must block instead of falling back.
      if (!proof) return null;
      if (proof.bindings.routePlanJobDigest !== jobDigest
        || proof.bindings.queuedJobDigest !== queuedJobDigest) return null;
      const after = normalizeSnapshot(readRouteSnapshot(candidate));
      if (!after || !sameSnapshot(before, after)) return null;

      const plan = planAgentLoopMaintenanceCanaryRouteV2({
        job: candidate,
        routeControl: routePlanControl(before),
        safety: routePlanSafety(before),
        readiness: {
          sourcePolicy: true,
          runtimeBundle: agentLoop !== null,
          publication: agentLoop !== null,
          operationalEvidence: agentLoop !== null
            && (!productionCanaryInput || before.safety.operationalEvidenceMatches),
        },
      });
      if (plan.plannedRoute === 'blocked') return null;
      if (plan.plannedRoute === 'agent-loop') {
        if (!agentLoop || agentLoop.canClaim(candidate) !== true) return null;
      } else if (plan.plannedRoute !== 'legacy') return null;
      const selected = decision(
        plan.plannedRoute === 'agent-loop'
          ? productionCanaryInput ? 'audited-canary' : 'isolated-acceptance'
          : 'audited-plan',
        plan.plannedRoute,
        jobDigest,
        {
        queuedJobDigest,
        sourcePolicyProofDigest: proof.proofDigest,
        routePlanDigest: plan.planDigest,
        routeControlGeneration: before.routeControl.generation,
        routeControlState: before.routeControl.state,
        routeControlRevision: before.routeControl.revision,
        routeControlTargetSessionId: before.routeControl.targetSessionId,
        routeControlEvidenceDigest: before.routeControl.evidenceDigest,
        windowSequence: before.safety.windowSequence,
        },
      );
      selectionEvidence.set(selected, Object.freeze({
        kind: 'audited' as const,
        proof,
        routeSnapshot: before,
        routePlanDigest: plan.planDigest,
      }));
      return selected;
    } catch {
      return null;
    }
  };
  let coordinatorActive = false;
  const coordinator: MaintenanceProductionClaimCoordinator = (candidate, finalize) => {
    // The code-owned closed migration branch remains direct Legacy. It never
    // borrows AL-only Admission/Session/Control authority merely to stay off.
    if (closedRouteControl) return finalize(selectRoute(candidate));
    if (!controlStore || coordinatorActive) return null;

    coordinatorActive = true;
    let finalizeEntered = false;
    try {
      // The production mode has one AL-enabled state only.  For every other
      // durable state, take the exact decision produced above and commit it
      // while the same ControlStore writer reservation is nested inside the
      // Manager transaction.  This path deliberately does not read source
      // policy, Admission or Session state: it grants only Legacy ownership.
      if (productionCanaryInput && readRouteSnapshot) {
        const observedControl = normalizeSnapshot(readRouteSnapshot(candidate));
        if (!observedControl) return null;
        if (!productionCanaryTargetSelected(observedControl, candidate)) {
          const selected = selectRoute(candidate);
          if (!selected) return null;
          const evidence = selectionEvidence.get(selected);
          if (!evidence || evidence.kind !== 'control-legacy') return null;
          return controlStore.withClaimFence(controlSnapshot => {
            const lockedRouteSnapshot = routeSnapshotFromControlFence(controlSnapshot);
            if (!sameSnapshot(evidence.routeSnapshot, lockedRouteSnapshot)
              || productionCanaryTargetSelected(lockedRouteSnapshot, candidate)
              || !controlLegacyRouteAllowed(lockedRouteSnapshot, candidate)
              || selected.routeBasis !== 'control-legacy'
              || selected.executorRoute !== 'legacy'
              || selected.sourcePolicyProofDigest !== null
              || selected.routePlanDigest !== null
              || selected.routeControlGeneration
                !== lockedRouteSnapshot.routeControl.generation
              || selected.routeControlState !== lockedRouteSnapshot.routeControl.state
              || selected.routeControlRevision
                !== lockedRouteSnapshot.routeControl.revision
              || selected.routeControlTargetSessionId
                !== lockedRouteSnapshot.routeControl.targetSessionId
              || selected.routeControlEvidenceDigest
                !== lockedRouteSnapshot.routeControl.evidenceDigest
              || selected.windowSequence !== lockedRouteSnapshot.safety.windowSequence) {
              throw new Error('agent-loop-maintenance-claim-control-snapshot-drift');
            }
            finalizeEntered = true;
            return finalize(selected);
          });
        }
      }

      if (!admissionLedger || !resolveSessionMemory || !candidate.parentRunId) return null;
      const memory = resolveSessionMemory(candidate.sessionId);
      if (!exactSessionMemory(memory)) return null;

      // The existing source reader computes the real Session snapshot through
      // the public MemoryDb connection. Do that before the private Session
      // writer reservation, then bind the result to monotonic coordinates on
      // both sides. Re-entering that writer path from inside the Session fence
      // would self-contend instead of strengthening the proof.
      const admissionBefore = admissionLedger.readMaintenanceAuthority();
      const sessionBefore = memory.readSessionAuthority();
      const controlBefore = controlStore.authorityCoordinate();
      const selected = selectRoute(candidate);
      if (!selected) return null;
      const evidence = selectionEvidence.get(selected);
      if (!evidence || evidence.kind !== 'audited' || !sourcePolicyReader) return null;
      const sessionEvidence =
        readAgentLoopMaintenanceCanarySourcePolicyProofSessionEvidenceInternal(
          sourcePolicyReader,
          evidence.proof,
        );
      if (!sessionEvidence
        || sessionEvidence.sessionIdentity !== memory
        || sessionEvidence.sourceRevision !== candidate.sourceRevision) return null;
      const admissionAfter = admissionLedger.readMaintenanceAuthority();
      const sessionAfter = memory.readSessionAuthority();
      const controlAfter = controlStore.authorityCoordinate();
      if (!sameAuthority(admissionBefore, admissionAfter)
        || !sameAuthority(sessionBefore, sessionAfter)
        || !sameAuthority(controlBefore, controlAfter)) return null;

      return admissionLedger.withMaintenanceClaimFence(
        candidate.sessionId,
        [candidate.parentRunId],
        admissionSnapshot => {
          return memory.withSessionClaimFence(sessionSnapshot => (
            controlStore!.withClaimFence(controlSnapshot => {
              // All proof inputs were bracketed by these coordinates before
              // acquisition. Equality with the frozen values closes every
              // pre-lock race; the reservations close every post-lock race
              // until the Manager commit completes at the deepest point.
              if (!sameAuthority(admissionSnapshot.authority, admissionAfter)
                || !sameAuthority(sessionSnapshot.authority, sessionAfter)
                || !sameAuthority(controlSnapshot.authority, controlAfter)
                || !sameAuthority(
                  admissionSnapshot.authority,
                  admissionLedger!.readMaintenanceAuthority(),
                ) || !sameAuthority(
                  sessionSnapshot.authority,
                  memory.readSessionAuthority(),
                ) || !sameAuthority(
                  controlSnapshot.authority,
                  controlStore!.authorityCoordinate(),
                )) throw new Error('agent-loop-maintenance-claim-authority-drift');

              const admissionDigest =
                agentLoopMaintenanceCanarySourcePolicyAdmissionDigest(
                  admissionProofRows(admissionSnapshot.admissions),
                  candidate,
                );
              // Re-read the entire branded source policy while all four writer
              // reservations are held. This closes process-local release,
              // session, maintenance, foreground and skill-conflict gates in
              // addition to the durable Admission/Session facts below.
              const lockedProof = sourcePolicyReader!.read(candidate.runId);
              const lockedSessionEvidence = lockedProof
                && sourcePolicyReader!.isProof(lockedProof)
                ? readAgentLoopMaintenanceCanarySourcePolicyProofSessionEvidenceInternal(
                    sourcePolicyReader!,
                    lockedProof,
                  )
                : null;
              const lockedRouteSnapshot = routeSnapshotFromControlFence(controlSnapshot);
              const lockedPlan = planAgentLoopMaintenanceCanaryRouteV2({
                job: candidate,
                routeControl: routePlanControl(lockedRouteSnapshot),
                safety: routePlanSafety(lockedRouteSnapshot),
                readiness: {
                  sourcePolicy: true,
                  runtimeBundle: agentLoop !== null,
                  publication: agentLoop !== null,
                  operationalEvidence: agentLoop !== null
                    && (!productionCanaryInput
                      || lockedRouteSnapshot.safety.operationalEvidenceMatches),
                },
              });
              const lockedExecutorRoute = lockedPlan.plannedRoute === 'agent-loop'
                ? 'agent-loop'
                : lockedPlan.plannedRoute === 'legacy'
                  ? 'legacy'
                  : null;
              if (admissionDigest !== evidence.proof.bindings.admissionDigest
                || sessionSnapshot.databaseSnapshot.databaseRevision
                  !== sessionEvidence.databaseRevision
                || !sameSnapshot(evidence.routeSnapshot, lockedRouteSnapshot)
                || lockedExecutorRoute === null
                || lockedExecutorRoute !== selected.executorRoute
                || (lockedExecutorRoute === 'agent-loop'
                  && (!agentLoop || agentLoop.canClaim(candidate) !== true))
                || lockedPlan.planDigest !== evidence.routePlanDigest
                || selected.routePlanDigest !== evidence.routePlanDigest
                || selected.sourcePolicyProofDigest !== evidence.proof.proofDigest
                || selected.routeControlTargetSessionId
                  !== lockedRouteSnapshot.routeControl.targetSessionId
                || selected.routeControlEvidenceDigest
                  !== lockedRouteSnapshot.routeControl.evidenceDigest
                || !lockedProof
                || lockedProof.proofDigest !== evidence.proof.proofDigest
                || !lockedSessionEvidence
                || lockedSessionEvidence.sessionIdentity !== memory
                || lockedSessionEvidence.sourceRevision !== candidate.sourceRevision
                || lockedSessionEvidence.databaseRevision !== sessionEvidence.databaseRevision
                || lockedSessionEvidence.databaseRevision
                  !== sessionSnapshot.databaseSnapshot.databaseRevision) {
                throw new Error('agent-loop-maintenance-claim-business-snapshot-drift');
              }

              finalizeEntered = true;
              return finalize(selected);
            })
          ));
        },
      );
    } catch (error) {
      // Lock acquisition, schema validation and pre-finalize callback failures
      // decline this candidate with zero Manager write. Once finalize starts,
      // only Manager may decide whether a partial write must abort or a durable
      // COMMIT must be returned despite an outer cleanup failure.
      if (finalizeEntered) throw error;
      return null;
    } finally {
      coordinatorActive = false;
    }
  };
  registerMaintenanceProductionQueuedRouteSelectorInternal(manager, selectRoute, coordinator);

  const dispatcher: AgentLoopMaintenanceProductionDispatcher = Object.freeze({
    version: AGENT_LOOP_MAINTENANCE_PRODUCTION_DISPATCHER_VERSION,
    claimNext(
      this: AgentLoopMaintenanceProductionDispatcher,
      owner: string,
      leaseMs: number,
      commonCanClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean,
    ) {
      if (this !== dispatcher || !DISPATCHERS.has(this)) {
        throw new Error('agent-loop-maintenance-production-dispatcher-receiver-invalid');
      }
      if (typeof commonCanClaim !== 'function' || nodeTypes.isProxy(commonCanClaim)) {
        throw new Error('agent-loop-maintenance-production-common-claim-invalid');
      }
      return CLAIM_NEXT_PRODUCTION_ROUTED.call(
        manager,
        owner,
        leaseMs,
        commonCanClaim,
        selectRoute,
      );
    },
  });
  DISPATCHERS.add(dispatcher);
  DISPATCHER_MANAGERS.set(dispatcher, manager);
  if (agentLoop) DISPATCHER_AGENT_LOOP_PORTS.set(dispatcher, agentLoop);
  return dispatcher;
}
