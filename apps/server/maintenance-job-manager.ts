import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import { captureMaintenanceProposalApprovalSource, MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE }
  from './maintenance-proposal-approval-source.ts';
import type { BudgetSnapshot } from '../../packages/harness/src/types.ts';
import { MaintenanceMemorySkillOutbox, MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE, inspectMaintenanceMemorySkillOutboxSchema,
  type MaintenanceMemorySkillOutboxEntry, type MaintenanceMemorySkillOutboxScan } from './maintenance-memory-skill-outbox.ts';
import { isMaintenanceMemorySkillProposalProof,
  type MaintenanceMemorySkillProposalProof } from './skill-hub/maintenance-memory-proposal-proof.ts';
import {
  createMaintenanceMemoryDirectProposal, inspectMaintenanceMemoryDirectProposalSchema,
  MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE, MaintenanceMemoryDirectProposalStore,
  type MaintenanceMemoryDirectPreparation, type MaintenanceMemoryDirectProposalRecord,
} from './maintenance-memory-direct-proposal.ts';
import type { MaintenanceCommitRequest } from './maintenance-proposal-committer.ts';
import {
  assertMaintenanceAgentLoopShadowSource, createMaintenanceAgentLoopShadowProposalPreparation,
  normalizeMaintenanceAgentLoopShadowProposal, parseMaintenanceAgentLoopShadowProposalPreparation,
  createMaintenanceAgentLoopShadowPublicationReceipt, normalizeMaintenanceAgentLoopShadowPublicationInput,
  parseMaintenanceAgentLoopShadowPublicationReceipt,
  type MaintenanceAgentLoopShadowProposalRecord, type MaintenanceAgentLoopShadowProposalPreparation,
  type MaintenanceAgentLoopShadowPublicationInput, type MaintenanceAgentLoopShadowPublicationReceipt,
} from './maintenance-agent-loop-shadow-proposal.ts';
import {
  MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE,
  normalizeMaintenanceAgentLoopSummaryApplyCompletionInput, createMaintenanceAgentLoopSummaryApplyCompletionReceipt,
  parseMaintenanceAgentLoopSummaryApplyCompletionReceipt,
  type MaintenanceAgentLoopSummaryApplyCompletionInput, type MaintenanceAgentLoopSummaryApplyCompletionReceipt,
} from './maintenance-agent-loop-summary-apply-completion.ts';
import {
  createMaintenanceSummarySkillProposalRecord, inspectMaintenanceSummarySkillSourceSchema,
  MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE, MaintenanceSummarySkillSourceStore,
  type MaintenanceSummaryDirectPreparation, type MaintenanceSummarySkillProposalRecord,
  type MaintenanceSummarySkillSourceEntry, type MaintenanceSummarySkillSourceScan,
} from './maintenance-summary-skill-source.ts';
import {
  isMaintenanceSummarySkillProposalProof, maintenanceSummarySkillDigest, type MaintenanceSummarySkillProposalProof,
} from './skill-hub/maintenance-summary-proposal-proof.ts';
import {
  inspectMaintenanceArcSkillSourceSchema, MAINTENANCE_ARC_SKILL_SOURCE_TABLE,
  MaintenanceArcSkillSourceStore, type MaintenanceArcSkillSourceEntry,
} from './maintenance-arc-skill-source.ts';
import {
  isMaintenanceArcSkillProposalProof, maintenanceArcSkillDigest, type MaintenanceArcSkillProposalProof,
} from './skill-hub/maintenance-arc-proposal-proof.ts';
import { maintenanceArcSkillProviderProposalContext } from './skill-hub/maintenance-arc-context.ts';
import { inspectMaintenanceNpcSkillSourceSchema, MAINTENANCE_NPC_SKILL_SOURCE_TABLE,
  MaintenanceNpcSkillSourceStore, type MaintenanceNpcSkillSourceEntry } from './maintenance-npc-skill-source.ts';
import { isMaintenanceNpcSkillResultProof, maintenanceNpcSkillDigest,
  type MaintenanceNpcSkillResultProof } from './skill-hub/maintenance-npc-result-proof.ts';
import { maintenanceNpcSkillProviderProposalContext } from './skill-hub/maintenance-npc-context.ts';
import {
  MAINTENANCE_POLICY_VERSION,
  normalizeNpcMaintenanceNoopTerminal,
  validateMaintenanceProposal,
  type NpcMaintenanceNoopTerminal,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
  type MaintenanceMode,
  type MaintenanceProposal,
  type MaintenanceStrictProposalContext,
  type MaintenanceSettings,
  type MaintenanceStatus,
  type MaintenanceTaskKind,
  type MaintenanceTrigger,
  type PublicMaintenanceJob,
} from './maintenance-types.ts';
import {
  MAINTENANCE_EXECUTION_CLAIM_VERSION,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from './maintenance-job-contract.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2,
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
  agentLoopMaintenanceCanaryRoutePlanV2JobDigest,
} from './agent-loop-maintenance-canary-route-plan-v2.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
  agentLoopMaintenanceProductionQueuedJobDigest,
  matchesAgentLoopMaintenanceProductionRouteJob,
} from './agent-loop-maintenance-production-route-contract.ts';

export {
  MAINTENANCE_EXECUTION_CLAIM_VERSION,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from './maintenance-job-contract.ts';

export const MAINTENANCE_JOB_DB_FILE = 'maintenance-jobs.sqlite';
export const MAINTENANCE_JOB_APPLICATION_ID = 0x4a474d4a; // JGMJ
export const MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE =
  'maintenance_production_route_receipt' as const;
export const MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION =
  'maintenance-production-route-receipt-v1' as const;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PRODUCTION_ROUTE_RECEIPT_BYTES = 16 * 1024;
const ADMISSION_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

type SqlRow = Record<string, unknown>;

export class MaintenanceDisabledError extends Error {
  readonly name = 'MaintenanceDisabledError';
}

export interface EnqueueMaintenanceInput {
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly sourceRevision: string;
  readonly policyVersion?: string;
  readonly parentRunId?: string;
  readonly trigger: MaintenanceTrigger;
  readonly mode?: MaintenanceMode;
}

export const MAINTENANCE_PRODUCTION_PROJECTION_RECOVERY_PAGE_SIZE = 64 as const;

export interface MaintenanceProductionProjectionRecoveryCursor {
  readonly createdAt: string;
  readonly runId: string;
}

export interface MaintenanceProductionProjectionRecoveryPage {
  readonly jobs: readonly PublicMaintenanceJob[];
  readonly nextCursor: MaintenanceProductionProjectionRecoveryCursor | null;
}

export interface MaintenanceExecutionRecord {
  readonly job: PublicMaintenanceJob;
  readonly executorRoute: MaintenanceExecutorRoute;
  readonly leaseOwnerInstanceId: string;
  readonly leaseExpiresAt: string;
  readonly cancelRequestedAt?: string;
}

/** Durable execution ownership, never inferred from a public job, mode, owner name or AL projection. */
export type MaintenanceExecutorRoute = 'legacy' | 'agent-loop';
export interface MaintenanceAgentLoopClaim {
  readonly executorRoute: 'agent-loop';
  readonly runId: string;
}
/**
 * Synchronous queued-job routing only. Returning null leaves the candidate
 * untouched; the selected route is persisted with status/attempt/lease in the
 * same SQLite transaction before either executor can observe ownership.
 */
export type MaintenanceQueuedRouteSelector = (
  job: Readonly<PublicMaintenanceJob>,
) => MaintenanceExecutorRoute | null;

export const MAINTENANCE_PRODUCTION_DISPATCH_DECISION_VERSION =
  'agent-loop-maintenance-production-dispatcher-v5' as const;

/** Versioned selector output for the real p14 job / p13b execution split.
 * It remains a dispatch decision only and carries no claim authority itself. */
export interface MaintenanceProductionQueuedRouteDecision {
  readonly dispatcherVersion: typeof MAINTENANCE_PRODUCTION_DISPATCH_DECISION_VERSION;
  /** Exact decision branch; fields that are meaningless for a branch must stay null. */
  readonly routeBasis:
    | 'ordinary-legacy'
    | 'control-off-legacy'
    | 'control-legacy'
    | 'audited-plan'
    | 'isolated-acceptance'
    | 'audited-canary';
  readonly executorRoute: MaintenanceExecutorRoute;
  readonly routePlanVersion: typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION;
  readonly routeContractVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.version;
  readonly routeContractDigest: string;
  readonly jobDigest: string;
  readonly admissionPolicyVersion:
    typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion;
  readonly executionPolicyVersion:
    typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion;
  /** Full pristine p14 header binding; null only for a direct Legacy-only scope. */
  readonly queuedJobDigest: string | null;
  /** Exact reader-issued proof used by this selector invocation; never reusable authority. */
  readonly sourcePolicyProofDigest: string | null;
  /** Recomputed v2 plan and the exact control window observed during selection. */
  readonly routePlanDigest: string | null;
  readonly routeControlGeneration: typeof AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2 | null;
  readonly routeControlState:
    'off' | 'canary-5' | 'canary-25' | 'canary-50' | 'on' | 'killed' | null;
  readonly routeControlRevision: number | null;
  /** Exact durable canary target/evidence locked by ControlStore at claim time. */
  readonly routeControlTargetSessionId: string | null;
  readonly routeControlEvidenceDigest: string | null;
  readonly windowSequence: number | null;
}

/** Immutable per-run production claim receipt. It is intentionally separate
 * from PublicMaintenanceJob so no operational authority leaks into public DTOs. */
export interface MaintenanceProductionRouteReceipt {
  readonly version: typeof MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION;
  readonly runId: string;
  readonly decision: Readonly<MaintenanceProductionQueuedRouteDecision>;
  readonly claimedAt: string;
  readonly receiptDigest: string;
}
export type MaintenanceProductionQueuedRouteSelector = (
  job: Readonly<PublicMaintenanceJob>,
) => MaintenanceProductionQueuedRouteDecision | null;

/**
 * One-use Manager commit continuation. A production coordinator must invoke it
 * synchronously while every outer authority fence is still held. Returning or
 * throwing without invoking it leaves the queued job unchanged.
 */
export type MaintenanceProductionClaimFinalize = (
  decision: MaintenanceProductionQueuedRouteDecision | null,
) => MaintenanceExecutionRecord | null;

/**
 * Internal synchronous scope owned by the production dispatcher. It may add
 * cross-store writer reservations around the one-use Manager finalize, but it
 * cannot manufacture a claim by returning an execution record of its own.
 */
export type MaintenanceProductionClaimCoordinator = (
  job: Readonly<PublicMaintenanceJob>,
  finalize: MaintenanceProductionClaimFinalize,
) => MaintenanceExecutionRecord | null;

// Internal capability seal for §13.88. The registration entrypoint remains
// exported only because the dispatcher lives in a separate module; production
// static tests require that module to be its sole caller. A structural callback
// can no longer invoke the production-v2 claim primitive.
const PRODUCTION_ROUTE_SELECTORS = new WeakMap<
  MaintenanceProductionQueuedRouteSelector,
  MaintenanceJobManager
>();
const PRODUCTION_ROUTE_SELECTOR_BY_MANAGER = new WeakMap<
  MaintenanceJobManager,
  MaintenanceProductionQueuedRouteSelector
>();
const PRODUCTION_CLAIM_COORDINATORS = new WeakMap<
  MaintenanceProductionQueuedRouteSelector,
  MaintenanceProductionClaimCoordinator
>();
const PRODUCTION_CLAIM_COORDINATOR_MANAGERS = new WeakMap<
  MaintenanceProductionClaimCoordinator,
  MaintenanceJobManager
>();
const MAINTENANCE_JOB_MANAGER_INSTANCES = new WeakSet<MaintenanceJobManager>();
const OPEN_MAINTENANCE_JOB_MANAGER_INSTANCES = new WeakSet<MaintenanceJobManager>();
const MAINTENANCE_JOB_MANAGER_DATABASE_IDENTITIES = new WeakMap<MaintenanceJobManager, string>();
// Process-local and monotonic by design. Old binaries do not participate, so
// deployments must drain-stop them before this fence can be relied upon.
const PRODUCTION_ROUTE_DATABASE_IDENTITIES = new Set<string>();

export type MaintenanceProductionQueuedJobReader = (runId: string) => unknown;
interface MaintenanceProductionQueuedJobReaderState {
  readonly resolveManager: () => unknown;
  readonly observeRead: (() => void) | null;
  boundManager: MaintenanceJobManager | null;
}
const PRODUCTION_QUEUED_JOB_READERS = new WeakMap<
  MaintenanceProductionQueuedJobReader,
  MaintenanceProductionQueuedJobReaderState
>();

/**
 * Namespace reserved for the single production-v2 dispatcher. This is broader
 * than the pristine route matcher on purpose: malformed/legacy variants of the
 * same p14 post-turn Summary admission must not be stolen by an older default,
 * explicit or canary-v1 claimer before production-v2 can fail them closed.
 */
function isMaintenanceProductionRouteNamespaceRow(row: SqlRow): boolean {
  const admission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
  return row.task_kind === admission.taskKind
    && row.policy_version === admission.policyVersion
    && row.trigger_kind === admission.trigger;
}

function exactMaintenanceJobManager(value: unknown): value is MaintenanceJobManager {
  return typeof value === 'object' && value !== null && !nodeTypes.isProxy(value)
    && value instanceof MaintenanceJobManager
    && Object.getPrototypeOf(value) === MaintenanceJobManager.prototype
    && MAINTENANCE_JOB_MANAGER_INSTANCES.has(value);
}

/** Internal exact-instance predicate for authority-bearing cross-module bindings. */
export function isMaintenanceJobManagerInstanceInternal(
  value: unknown,
): value is MaintenanceJobManager {
  return exactMaintenanceJobManager(value);
}

/** Internal lifecycle predicate; exact identity remains true after close. */
export function isOpenMaintenanceJobManagerInstanceInternal(
  value: unknown,
): value is MaintenanceJobManager {
  return exactMaintenanceJobManager(value)
    && OPEN_MAINTENANCE_JOB_MANAGER_INSTANCES.has(value);
}

function resolveProductionQueuedJobReaderManager(
  state: MaintenanceProductionQueuedJobReaderState,
): MaintenanceJobManager | null {
  try {
    const current = state.resolveManager();
    if (!exactMaintenanceJobManager(current)) return null;
    if (state.boundManager === null) state.boundManager = current;
    return state.boundManager === current ? current : null;
  } catch {
    return null;
  }
}

/**
 * Internal lazy Manager-bound read capability. The resolver permits the server
 * composition to be declared before its Manager is initialized; the first
 * exact resolution permanently binds the reader to that one Manager instance.
 */
export function createMaintenanceProductionQueuedJobReaderInternal(
  resolveManager: () => unknown,
  observeRead?: () => void,
): MaintenanceProductionQueuedJobReader {
  if (typeof resolveManager !== 'function' || nodeTypes.isProxy(resolveManager)
    || (observeRead !== undefined
      && (typeof observeRead !== 'function' || nodeTypes.isProxy(observeRead)))) {
    throw new Error('maintenance production queued job reader invalid');
  }
  const state: MaintenanceProductionQueuedJobReaderState = {
    resolveManager,
    observeRead: observeRead ?? null,
    boundManager: null,
  };
  const reader: MaintenanceProductionQueuedJobReader = Object.freeze((runId: string) => {
    const manager = resolveProductionQueuedJobReaderManager(state);
    if (!manager) return null;
    state.observeRead?.();
    return manager.get(runId);
  });
  PRODUCTION_QUEUED_JOB_READERS.set(reader, state);
  return reader;
}

export function isMaintenanceProductionQueuedJobReaderForManagerInternal(
  reader: unknown,
  manager: MaintenanceJobManager,
): reader is MaintenanceProductionQueuedJobReader {
  if (typeof reader !== 'function' || nodeTypes.isProxy(reader)
    || !exactMaintenanceJobManager(manager)) return false;
  const state = PRODUCTION_QUEUED_JOB_READERS.get(reader as MaintenanceProductionQueuedJobReader);
  return state !== undefined && resolveProductionQueuedJobReaderManager(state) === manager;
}

export function registerMaintenanceProductionQueuedRouteSelectorInternal(
  manager: MaintenanceJobManager,
  selector: MaintenanceProductionQueuedRouteSelector,
  coordinator: MaintenanceProductionClaimCoordinator,
): void {
  const databaseIdentity = MAINTENANCE_JOB_MANAGER_DATABASE_IDENTITIES.get(manager);
  if (!exactMaintenanceJobManager(manager)
    || typeof databaseIdentity !== 'string'
    || typeof selector !== 'function'
    || nodeTypes.isProxy(selector)
    || typeof coordinator !== 'function'
    || nodeTypes.isProxy(coordinator)
    || PRODUCTION_ROUTE_SELECTORS.has(selector)
    || PRODUCTION_CLAIM_COORDINATORS.has(selector)
    || PRODUCTION_CLAIM_COORDINATOR_MANAGERS.has(coordinator)
    || PRODUCTION_ROUTE_SELECTOR_BY_MANAGER.has(manager)) {
    throw new Error('maintenance production route selector registration invalid');
  }
  PRODUCTION_ROUTE_SELECTORS.set(selector, manager);
  PRODUCTION_ROUTE_SELECTOR_BY_MANAGER.set(manager, selector);
  PRODUCTION_CLAIM_COORDINATORS.set(selector, coordinator);
  PRODUCTION_CLAIM_COORDINATOR_MANAGERS.set(coordinator, manager);
  // Activation is intentionally monotonic for the lifetime of this process:
  // closing one Manager must never reopen an old claim path on another live
  // connection to the same SQLite database.
  PRODUCTION_ROUTE_DATABASE_IDENTITIES.add(databaseIdentity);
}

const PRODUCTION_ROUTE_DECISION_KEYS = Object.freeze([
  'admissionPolicyVersion', 'dispatcherVersion', 'executionPolicyVersion', 'executorRoute',
  'jobDigest', 'queuedJobDigest', 'routeContractDigest', 'routeContractVersion',
  'routeBasis', 'routeControlEvidenceDigest', 'routeControlGeneration',
  'routeControlRevision', 'routeControlState', 'routeControlTargetSessionId',
  'routePlanDigest', 'routePlanVersion',
  'sourcePolicyProofDigest', 'windowSequence',
]);
const PRODUCTION_ROUTE_HASH = /^sha256:[a-f0-9]{64}$/u;
const PRODUCTION_ROUTE_SESSION_ID = /^session-[0-9]{6,24}$/u;
const PRODUCTION_ROUTE_CONTROL_STATES = Object.freeze([
  'off', 'canary-5', 'canary-25', 'canary-50', 'on', 'killed',
] as const);
const ROUTE_INTRINSIC_PROMISE = Promise;
const ROUTE_INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const ROUTE_INTRINSIC_PROMISE_SPECIES =
  Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

/**
 * A selector is synchronous. Mark safely observable genuine rejected Promises
 * handled without awaiting them or touching a user then/species hook.
 */
function observeRejectedRoutePromise(value: unknown): void {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) return;
  const originalConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  const intrinsicConstructor = Object.getOwnPropertyDescriptor(
    ROUTE_INTRINSIC_PROMISE.prototype,
    'constructor',
  );
  const intrinsicSpecies =
    Object.getOwnPropertyDescriptor(ROUTE_INTRINSIC_PROMISE, Symbol.species);
  if (!intrinsicConstructor || !Object.hasOwn(intrinsicConstructor, 'value')
    || intrinsicConstructor.value !== ROUTE_INTRINSIC_PROMISE
    || !intrinsicSpecies || intrinsicSpecies.get !== ROUTE_INTRINSIC_PROMISE_SPECIES
    || intrinsicSpecies.set !== undefined) return;

  let shadowedConstructor = false;
  try {
    if (!originalConstructor
      && Object.getPrototypeOf(value) === ROUTE_INTRINSIC_PROMISE.prototype) {
      void ROUTE_INTRINSIC_PROMISE_THEN.call(
        value,
        () => undefined,
        () => undefined,
      );
      return;
    }
    if (!originalConstructor || originalConstructor.configurable
      || (Object.hasOwn(originalConstructor, 'value')
        && originalConstructor.writable === true)) {
      Object.defineProperty(value, 'constructor', {
        configurable: originalConstructor?.configurable ?? true,
        enumerable: originalConstructor?.enumerable ?? false,
        value: ROUTE_INTRINSIC_PROMISE,
        writable: originalConstructor && Object.hasOwn(originalConstructor, 'value')
          ? originalConstructor.writable
          : true,
      });
      shadowedConstructor = true;
    } else if (!Object.hasOwn(originalConstructor, 'value')
      || originalConstructor.value !== ROUTE_INTRINSIC_PROMISE) {
      return;
    }
    void ROUTE_INTRINSIC_PROMISE_THEN.call(
      value,
      () => undefined,
      () => undefined,
    );
  } catch {
    // The selector result remains rejected as an invalid synchronous decision.
  } finally {
    if (shadowedConstructor) {
      try {
        if (originalConstructor) Object.defineProperty(value, 'constructor', originalConstructor);
        else Reflect.deleteProperty(value, 'constructor');
      } catch {
        // Genuine non-Proxy Promises have ordinary property semantics.
      }
    }
  }
}

function normalizeProductionQueuedRouteDecision(
  value: unknown,
  job: Readonly<PublicMaintenanceJob>,
): Readonly<MaintenanceProductionQueuedRouteDecision> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || nodeTypes.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== PRODUCTION_ROUTE_DECISION_KEYS.length
      || keys.some((key) => typeof key !== 'string'
        || !PRODUCTION_ROUTE_DECISION_KEYS.includes(key))) return null;
    const decision: Record<string, unknown> = {};
    for (const key of PRODUCTION_ROUTE_DECISION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      decision[key] = descriptor.value;
    }
    const expectedJobDigest = agentLoopMaintenanceCanaryRoutePlanV2JobDigest(job);
    const expectedQueuedJobDigest =
      agentLoopMaintenanceProductionQueuedJobDigest(job);
    if (expectedJobDigest === null || typeof decision.jobDigest !== 'string') return null;
    const nullableHash = (input: unknown): input is string | null => (
      input === null || (typeof input === 'string' && PRODUCTION_ROUTE_HASH.test(input))
    );
    const emptyControlBinding = decision.routeControlGeneration === null
      && decision.routeControlRevision === null
      && decision.routeControlState === null
      && decision.routeControlTargetSessionId === null
      && decision.routeControlEvidenceDigest === null
      && decision.windowSequence === null
      && decision.routePlanDigest === null;
    const emptyAuditBinding = decision.queuedJobDigest === null
      && decision.sourcePolicyProofDigest === null
      && emptyControlBinding;
    const exactControlCoordinates =
      decision.routeControlGeneration === AGENT_LOOP_MAINTENANCE_CANARY_COHORT_EPOCH_V2
      && Number.isSafeInteger(decision.routeControlRevision)
      && (decision.routeControlRevision as number) >= 0
      && typeof decision.routeControlState === 'string'
      && PRODUCTION_ROUTE_CONTROL_STATES.includes(
        decision.routeControlState as (typeof PRODUCTION_ROUTE_CONTROL_STATES)[number],
      );
    const exactLockedRouteBinding = exactControlCoordinates
      && (decision.routeControlState === 'canary-5'
        ? typeof decision.routeControlTargetSessionId === 'string'
          && PRODUCTION_ROUTE_SESSION_ID.test(decision.routeControlTargetSessionId)
          && typeof decision.routeControlEvidenceDigest === 'string'
          && PRODUCTION_ROUTE_HASH.test(decision.routeControlEvidenceDigest)
        : decision.routeControlTargetSessionId === null
          && decision.routeControlEvidenceDigest === null);
    const exactPlanBinding = exactControlCoordinates
      && exactLockedRouteBinding
      && Number.isSafeInteger(decision.windowSequence)
      && (decision.windowSequence as number) >= 0
      && typeof decision.routePlanDigest === 'string'
      && PRODUCTION_ROUTE_HASH.test(decision.routePlanDigest);
    const exactClosedLegacyBinding = exactControlCoordinates
      && decision.routeControlState === 'off'
      && exactLockedRouteBinding
      && decision.windowSequence === null
      && decision.routePlanDigest === null;
    // `canary-5` may also produce Control Legacy for a non-target session.
    // The branded coordinator rechecks that target mismatch inside the exact
    // ControlStore writer fence before this structural decision is finalized.
    const exactDynamicControlLegacyBinding = exactControlCoordinates
      && exactLockedRouteBinding
      && Number.isSafeInteger(decision.windowSequence)
      && (decision.windowSequence as number) >= 0
      && decision.routePlanDigest === null
      && (decision.routeControlState !== 'canary-5'
        || decision.routeControlTargetSessionId !== job.sessionId);
    const exactDecisionBranch = (
      decision.routeBasis === 'ordinary-legacy'
        ? expectedQueuedJobDigest === null
          && decision.executorRoute === 'legacy'
          && emptyAuditBinding
        : decision.routeBasis === 'control-off-legacy'
          ? expectedQueuedJobDigest !== null
            && decision.executorRoute === 'legacy'
            && decision.queuedJobDigest === expectedQueuedJobDigest
            && decision.sourcePolicyProofDigest === null
            && exactClosedLegacyBinding
          : decision.routeBasis === 'control-legacy'
            ? expectedQueuedJobDigest !== null
              && decision.executorRoute === 'legacy'
              && decision.queuedJobDigest === expectedQueuedJobDigest
              && decision.sourcePolicyProofDigest === null
              && exactDynamicControlLegacyBinding
            : decision.routeBasis === 'audited-plan'
              ? expectedQueuedJobDigest !== null
                && decision.executorRoute === 'legacy'
                && decision.queuedJobDigest === expectedQueuedJobDigest
                && decision.sourcePolicyProofDigest !== null
                && exactPlanBinding
              : decision.routeBasis === 'isolated-acceptance'
                ? expectedQueuedJobDigest !== null
                  && decision.executorRoute === 'agent-loop'
                  && decision.queuedJobDigest === expectedQueuedJobDigest
                  && decision.sourcePolicyProofDigest !== null
                  && exactPlanBinding
                  && matchesAgentLoopMaintenanceProductionRouteJob(job)
                : decision.routeBasis === 'audited-canary'
                  ? expectedQueuedJobDigest !== null
                    && decision.executorRoute === 'agent-loop'
                    && decision.queuedJobDigest === expectedQueuedJobDigest
                    && decision.sourcePolicyProofDigest !== null
                    && exactPlanBinding
                    && decision.routeControlState === 'canary-5'
                    && decision.routeControlTargetSessionId === job.sessionId
                    && typeof decision.routeControlEvidenceDigest === 'string'
                    && PRODUCTION_ROUTE_HASH.test(decision.routeControlEvidenceDigest)
                    && matchesAgentLoopMaintenanceProductionRouteJob(job)
                  : false
    );
    if ((decision.executorRoute !== 'legacy' && decision.executorRoute !== 'agent-loop')
      || decision.dispatcherVersion !== MAINTENANCE_PRODUCTION_DISPATCH_DECISION_VERSION
      || decision.routePlanVersion !== AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION
      || decision.routeContractVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.version
      || decision.routeContractDigest !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST
      || decision.jobDigest !== expectedJobDigest
      || !nullableHash(decision.queuedJobDigest)
      || !nullableHash(decision.sourcePolicyProofDigest)
      || !nullableHash(decision.routePlanDigest)
      || !nullableHash(decision.routeControlEvidenceDigest)
      || (decision.routeControlState !== null
        && (typeof decision.routeControlState !== 'string'
          || !PRODUCTION_ROUTE_CONTROL_STATES.includes(
            decision.routeControlState as (typeof PRODUCTION_ROUTE_CONTROL_STATES)[number],
          )))
      || decision.admissionPolicyVersion
        !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion
      || decision.executionPolicyVersion
        !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion
      || !exactDecisionBranch) return null;
    return Object.freeze({ ...decision }) as unknown as Readonly<MaintenanceProductionQueuedRouteDecision>;
  } catch {
    return null;
  }
}

const PRODUCTION_ROUTE_RECEIPT_KEYS = Object.freeze([
  'claimedAt', 'decision', 'receiptDigest', 'runId', 'version',
]);

function canonicalProductionRouteReceiptJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProductionRouteReceiptJson).join(',')}]`;
  }
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new Error('maintenance production route receipt canonical value invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('maintenance production route receipt canonical object invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error('maintenance production route receipt canonical key invalid');
  }
  return `{${(keys as string[]).sort().map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error('maintenance production route receipt canonical descriptor invalid');
    }
    return `${JSON.stringify(key)}:${canonicalProductionRouteReceiptJson(descriptor.value)}`;
  }).join(',')}}`;
}

function productionRouteReceiptDigest(value: Readonly<{
  version: typeof MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION;
  runId: string;
  decision: Readonly<MaintenanceProductionQueuedRouteDecision>;
  claimedAt: string;
}>): string {
  return `sha256:${createHash('sha256')
    .update(canonicalProductionRouteReceiptJson(value), 'utf8').digest('hex')}`;
}

function createProductionRouteReceipt(
  runId: string,
  decision: Readonly<MaintenanceProductionQueuedRouteDecision>,
  claimedAt: string,
): Readonly<MaintenanceProductionRouteReceipt> {
  const unsigned = Object.freeze({
    version: MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION,
    runId,
    decision,
    claimedAt,
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: productionRouteReceiptDigest(unsigned),
  });
}

function productionRouteReceiptQueuedJob(row: SqlRow): Readonly<PublicMaintenanceJob> {
  const current = parseJob(row);
  return Object.freeze({
    runId: current.runId,
    sessionId: current.sessionId,
    taskKind: current.taskKind,
    sourceRevision: current.sourceRevision,
    policyVersion: current.policyVersion,
    ...(current.parentRunId === undefined ? {} : { parentRunId: current.parentRunId }),
    trigger: current.trigger,
    mode: current.mode,
    status: 'queued' as const,
    attempt: 0,
    createdAt: current.createdAt,
    updatedAt: current.createdAt,
  });
}

function parseProductionRouteReceiptRow(row: SqlRow): Readonly<MaintenanceProductionRouteReceipt> {
  try {
    if (typeof row.production_receipt_json !== 'string'
      || Buffer.byteLength(row.production_receipt_json, 'utf8')
        > MAX_PRODUCTION_ROUTE_RECEIPT_BYTES) {
      throw new Error('receipt-json-invalid');
    }
    const parsed = JSON.parse(row.production_receipt_json) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('receipt-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(parsed);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== PRODUCTION_ROUTE_RECEIPT_KEYS.length
      || keys.some((key) => typeof key !== 'string'
        || !PRODUCTION_ROUTE_RECEIPT_KEYS.includes(key))) {
      throw new Error('receipt-keys-invalid');
    }
    const receipt: Record<string, unknown> = {};
    for (const key of PRODUCTION_ROUTE_RECEIPT_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error('receipt-descriptor-invalid');
      }
      receipt[key] = descriptor.value;
    }
    const queuedJob = productionRouteReceiptQueuedJob(row);
    const runId = requireOpaque(receipt.runId, 'production receipt runId');
    const claimedAt = typeof receipt.claimedAt === 'string'
      ? canonicalTimestamp(receipt.claimedAt) : (() => { throw new Error('receipt-claimed-at-invalid'); })();
    const decision = normalizeProductionQueuedRouteDecision(receipt.decision, queuedJob);
    if (!decision || receipt.version !== MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION
      || runId !== queuedJob.runId
      || row.production_receipt_claimed_at !== claimedAt
      || row.production_receipt_digest !== receipt.receiptDigest
      || row.started_at !== claimedAt
      || row.executor_route !== decision?.executorRoute
      || row.attempt !== 1
      || typeof receipt.receiptDigest !== 'string'
      || !PRODUCTION_ROUTE_HASH.test(receipt.receiptDigest)) {
      throw new Error('receipt-binding-invalid');
    }
    const expectedDigest = productionRouteReceiptDigest(Object.freeze({
      version: MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION,
      runId,
      decision,
      claimedAt,
    }));
    if (receipt.receiptDigest !== expectedDigest) throw new Error('receipt-digest-invalid');
    return Object.freeze({
      version: MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_VERSION,
      runId,
      decision,
      claimedAt,
      receiptDigest: expectedDigest,
    });
  } catch {
    throw new Error('maintenance production route receipt corrupt');
  }
}

function executorRoute(value: unknown): MaintenanceExecutorRoute {
  if (value !== 'legacy' && value !== 'agent-loop') throw new Error('maintenance executor route invalid');
  return value;
}

export type MaintenanceProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'rolled_back';

/** Content-bounded control-plane view. Full proposal/context remain server-side only. */
export interface MaintenancePendingProposalSummary {
  readonly proposalId: string;
  readonly jobRunId: string;
  readonly sessionId: string;
  readonly taskKind: Extract<MaintenanceTaskKind,
    'memory_consolidation' | 'branch_index' | 'rolling_summary' | 'npc_state'>;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly diff: Readonly<Record<string, unknown>>;
  readonly status: MaintenanceProposalStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt?: string;
  readonly decisionReason?: string;
}

export interface MaintenancePendingProposalRecord extends MaintenancePendingProposalSummary {
  readonly proposal: MaintenanceProposal;
  readonly context: MaintenanceStrictProposalContext;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly rollbackAnchor?: Readonly<Record<string, unknown>>;
}

/** Private-server history; a durable receipt is not a live execution or publication grant. */
export interface MaintenanceAgentLoopShadowPublicationRecord {
  readonly job: PublicMaintenanceJob; readonly proposal: MaintenancePendingProposalRecord;
  readonly preparation: MaintenanceAgentLoopShadowProposalPreparation;
  readonly publication: MaintenanceAgentLoopShadowPublicationReceipt;
}
/** Historical business success only; this record cannot authorize AL execution. */
export interface MaintenanceAgentLoopSummaryApplyCompletionRecord {
  readonly job: PublicMaintenanceJob;
  readonly completion: MaintenanceAgentLoopSummaryApplyCompletionReceipt;
}

export interface MaintenanceJobManagerOptions {
  readonly dataDir: string;
  readonly now?: () => string;
  readonly randomId?: () => string;
  readonly busyTimeoutMs?: number;
  readonly onSkillProvenanceFailure?: () => void;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('maintenance clock invalid');
  }
  return value;
}

function requireOpaque(value: unknown, field: string, maxLength = 160): string {
  if (!isSafeOpaqueId(value, maxLength)) throw new Error(`${field} invalid`);
  return value;
}

function requireJsonObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} invalid`);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${field} too large`);
  return JSON.parse(text) as Record<string, unknown>;
}

function proposalTableSql(version: 5 | 6 | 7 = 5): string {
  const includeAgentLoopPreparation = version >= 6;
  return `
    CREATE TABLE maintenance_pending_proposal (
      proposal_id TEXT PRIMARY KEY,
      job_run_id TEXT NOT NULL UNIQUE REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      task_kind TEXT NOT NULL CHECK (task_kind IN (
        'memory_consolidation','branch_index','rolling_summary','npc_state'
      )),
      source_revision TEXT NOT NULL,
      proposal_digest TEXT NOT NULL,
      proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
      context_json TEXT NOT NULL CHECK (json_valid(context_json)),
      diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
      status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','stale','rolled_back'${includeAgentLoopPreparation ? ",'prepared'" : ''})),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decision_reason TEXT,
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      rollback_anchor_json TEXT CHECK (rollback_anchor_json IS NULL OR json_valid(rollback_anchor_json))${includeAgentLoopPreparation ? `,
      agent_loop_preparation_json TEXT CHECK (agent_loop_preparation_json IS NULL OR
        (json_valid(agent_loop_preparation_json) AND length(agent_loop_preparation_json)<=8192)),
      ${version === 7 ? `agent_loop_publication_json TEXT CHECK (agent_loop_publication_json IS NULL OR
        (json_valid(agent_loop_publication_json) AND length(agent_loop_publication_json)<=8192)),
      CHECK ((status='prepared' AND task_kind='rolling_summary' AND agent_loop_preparation_json IS NOT NULL
        AND agent_loop_publication_json IS NULL AND revision=1 AND created_at=updated_at
        AND decided_at IS NULL AND decision_reason IS NULL AND receipt_json IS NULL AND rollback_anchor_json IS NULL)
        OR (status<>'prepared' AND agent_loop_preparation_json IS NULL AND agent_loop_publication_json IS NULL)
        OR (status<>'prepared' AND task_kind='rolling_summary' AND agent_loop_preparation_json IS NOT NULL
          AND agent_loop_publication_json IS NOT NULL AND revision>=2))` : `CHECK ((status='prepared' AND task_kind='rolling_summary' AND agent_loop_preparation_json IS NOT NULL
        AND revision=1 AND created_at=updated_at AND decided_at IS NULL AND decision_reason IS NULL
        AND receipt_json IS NULL AND rollback_anchor_json IS NULL)
        OR (status<>'prepared' AND agent_loop_preparation_json IS NULL))`}` : ''}
    );
    CREATE INDEX maintenance_pending_by_session
      ON maintenance_pending_proposal(session_id,status,created_at);
  `;
}

function agentLoopPreparedGuardSql(): string {
  return `CREATE TRIGGER maintenance_agent_loop_prepared_immutable
    BEFORE UPDATE ON maintenance_pending_proposal
    WHEN OLD.status='prepared' OR NEW.status='prepared'
    BEGIN SELECT RAISE(ABORT,'maintenance-agent-loop-shadow-proposal-immutable'); END;`;
}

/** Frozen authentic v6 fixtures/migration source, never the current v7 DDL. */
export const MAINTENANCE_JOB_V6_PROPOSAL_SCHEMA_SQL = proposalTableSql(6);
export const MAINTENANCE_JOB_V6_PREPARED_GUARD_SQL = agentLoopPreparedGuardSql();

function agentLoopPublicationGuardSql(): string {
  return `CREATE TRIGGER maintenance_agent_loop_publication_immutable
    BEFORE UPDATE ON maintenance_pending_proposal
    WHEN (OLD.agent_loop_preparation_json IS NOT NULL OR NEW.agent_loop_preparation_json IS NOT NULL
      OR OLD.agent_loop_publication_json IS NOT NULL OR NEW.agent_loop_publication_json IS NOT NULL)
      AND NOT (NEW.proposal_id IS OLD.proposal_id AND NEW.job_run_id IS OLD.job_run_id
        AND NEW.session_id IS OLD.session_id AND NEW.task_kind IS OLD.task_kind
        AND NEW.source_revision IS OLD.source_revision AND NEW.proposal_digest IS OLD.proposal_digest
        AND NEW.proposal_json IS OLD.proposal_json AND NEW.context_json IS OLD.context_json
        AND NEW.diff_json IS OLD.diff_json AND NEW.created_at IS OLD.created_at
        AND NEW.agent_loop_preparation_json IS OLD.agent_loop_preparation_json
        AND ((OLD.status='prepared' AND NEW.status='pending' AND OLD.revision=1 AND NEW.revision=2
          AND OLD.agent_loop_publication_json IS NULL AND NEW.agent_loop_publication_json IS NOT NULL
          AND NEW.updated_at>=OLD.updated_at AND NEW.decided_at IS NULL AND NEW.decision_reason IS NULL
          AND NEW.receipt_json IS NULL AND NEW.rollback_anchor_json IS NULL)
        OR (OLD.status<>'prepared' AND NEW.status<>'prepared'
          AND OLD.agent_loop_publication_json IS NOT NULL
          AND NEW.agent_loop_publication_json IS OLD.agent_loop_publication_json)))
    BEGIN SELECT RAISE(ABORT,'maintenance-agent-loop-shadow-publication-immutable'); END;`;
}

function jobTableSql(includeExecutorRoute = true): string {
  return `
    CREATE TABLE maintenance_job (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_kind TEXT NOT NULL CHECK (task_kind IN (
        'memory_consolidation','branch_index','rolling_summary','npc_state','worldbook_repair'
      )),
      source_revision TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      parent_run_id TEXT,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('post-turn','idle','manual')),
      mode TEXT NOT NULL CHECK (mode IN ('shadow','apply')),
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','stale')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      cancel_requested_at TEXT,
      lease_owner_instance_id TEXT,
      lease_expires_at TEXT,
      error_code TEXT,
      budget_json TEXT CHECK (budget_json IS NULL OR json_valid(budget_json)),
      proposal_digest TEXT,
      proposal_disposition TEXT CHECK (proposal_disposition IS NULL OR proposal_disposition IN ('shadow','committed','stale')),
      diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
      ${includeExecutorRoute ? "executor_route TEXT NOT NULL DEFAULT 'legacy' CHECK (executor_route IN ('legacy','agent-loop'))," : ''}
      UNIQUE(session_id, task_kind, source_revision, policy_version)
    );
    CREATE UNIQUE INDEX maintenance_one_running_per_session
      ON maintenance_job(session_id) WHERE status = 'running';
    CREATE INDEX maintenance_job_status_created ON maintenance_job(status, created_at);
  `;
}

function outboxTableSql(): string {
  return `
    CREATE TABLE maintenance_outbox (
      outbox_id TEXT PRIMARY KEY,
      job_run_id TEXT NOT NULL UNIQUE REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      delivered_at TEXT
    );
    CREATE INDEX maintenance_outbox_pending ON maintenance_outbox(delivered_at, available_at);
  `;
}

function productionRouteReceiptTableDefinitionSql(): string {
  return `
    CREATE TABLE ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
      claimed_at TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK (
        json_valid(receipt_json) AND length(receipt_json)<=${MAX_PRODUCTION_ROUTE_RECEIPT_BYTES}
      )
    );`;
}

function productionRouteReceiptUpdateGuardSql(): string {
  return `CREATE TRIGGER maintenance_production_route_receipt_update_immutable
    BEFORE UPDATE ON ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE}
    BEGIN SELECT RAISE(ABORT,'maintenance-production-route-receipt-immutable'); END;`;
}

function productionRouteReceiptDeleteGuardSql(): string {
  return `CREATE TRIGGER maintenance_production_route_receipt_delete_immutable
    BEFORE DELETE ON ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE}
    WHEN EXISTS (SELECT 1 FROM maintenance_job WHERE run_id=OLD.run_id)
    BEGIN SELECT RAISE(ABORT,'maintenance-production-route-receipt-immutable'); END;`;
}

function productionRouteReceiptTableSql(): string {
  return `
    ${productionRouteReceiptTableDefinitionSql()}
    CREATE INDEX maintenance_production_route_receipt_claimed
      ON ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE}(claimed_at DESC,run_id DESC);
    ${productionRouteReceiptUpdateGuardSql()}
    ${productionRouteReceiptDeleteGuardSql()}
  `;
}

function readPragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row?.[name];
  if (!Number.isInteger(value)) throw new Error(`maintenance sqlite ${name} invalid`);
  return value as number;
}

function migrateMaintenanceJobV3(db: DatabaseSync): void {
  // task_kind is guarded by a SQLite CHECK, so adding worldbook_repair requires
  // the documented table-rebuild migration. Rebuild dependent tables in the
  // same transaction and verify every foreign key before publishing v3.
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
      ALTER TABLE maintenance_outbox RENAME TO maintenance_outbox_v2;
      ALTER TABLE maintenance_pending_proposal RENAME TO maintenance_pending_proposal_v2;
      ALTER TABLE maintenance_job RENAME TO maintenance_job_v2;
      DROP INDEX IF EXISTS maintenance_outbox_pending;
      DROP INDEX IF EXISTS maintenance_pending_by_session;
      DROP INDEX IF EXISTS maintenance_one_running_per_session;
      DROP INDEX IF EXISTS maintenance_job_status_created;
      ${jobTableSql(false)}
      ${outboxTableSql()}
      ${proposalTableSql()}
      INSERT INTO maintenance_job(
        run_id,session_id,task_kind,source_revision,policy_version,parent_run_id,
        trigger_kind,mode,status,attempt,created_at,updated_at,started_at,finished_at,
        cancel_requested_at,lease_owner_instance_id,lease_expires_at,error_code,budget_json,
        proposal_digest,proposal_disposition,diff_json
      )
      SELECT
        run_id,session_id,task_kind,source_revision,policy_version,parent_run_id,
        trigger_kind,mode,status,attempt,created_at,updated_at,started_at,finished_at,
        cancel_requested_at,lease_owner_instance_id,lease_expires_at,error_code,budget_json,
        proposal_digest,proposal_disposition,diff_json
      FROM maintenance_job_v2;
      INSERT INTO maintenance_outbox(outbox_id,job_run_id,available_at,claimed_at,delivered_at)
        SELECT outbox_id,job_run_id,available_at,claimed_at,delivered_at FROM maintenance_outbox_v2;
      INSERT INTO maintenance_pending_proposal(
        proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
        proposal_json,context_json,diff_json,status,revision,created_at,updated_at,
        decided_at,decision_reason,receipt_json,rollback_anchor_json
      )
      SELECT
        proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
        proposal_json,context_json,diff_json,status,revision,created_at,updated_at,
        decided_at,decision_reason,receipt_json,rollback_anchor_json
      FROM maintenance_pending_proposal_v2;
      DROP TABLE maintenance_pending_proposal_v2;
      DROP TABLE maintenance_outbox_v2;
      DROP TABLE maintenance_job_v2;
      PRAGMA user_version = 3;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error('maintenance v3 foreign key check failed');
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

function migrateMaintenanceJobV4(db: DatabaseSync): void {
  // v4 extends the durable approval queue to the two memory domains. Their
  // business writes remain impossible until an exact-session approval invokes
  // the typed committer; this migration only widens the proposal CHECK.
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
      ALTER TABLE maintenance_pending_proposal RENAME TO maintenance_pending_proposal_v3;
      DROP INDEX IF EXISTS maintenance_pending_by_session;
      ${proposalTableSql()}
      INSERT INTO maintenance_pending_proposal(
        proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
        proposal_json,context_json,diff_json,status,revision,created_at,updated_at,
        decided_at,decision_reason,receipt_json,rollback_anchor_json
      )
      SELECT
        proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
        proposal_json,context_json,diff_json,status,revision,created_at,updated_at,
        decided_at,decision_reason,receipt_json,rollback_anchor_json
      FROM maintenance_pending_proposal_v3;
      DROP TABLE maintenance_pending_proposal_v3;
      PRAGMA user_version = 4;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error('maintenance v4 foreign key check failed');
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

function inspectMaintenanceSkillSchemas(db: DatabaseSync, inspectMemoryOutbox = false): void {
  // Only migration validates this optional outbox at startup. On current-schema
  // reopen its original recovery scheduler owns degraded-schema isolation, so
  // optional evidence cannot prevent unrelated legacy maintenance from running.
  if (inspectMemoryOutbox && db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE)) {
    inspectMaintenanceMemorySkillOutboxSchema(db);
  }
  if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE)) {
    inspectMaintenanceMemoryDirectProposalSchema(db);
  }
  if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE)) {
    inspectMaintenanceSummarySkillSourceSchema(db);
  }
  if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_ARC_SKILL_SOURCE_TABLE)) {
    inspectMaintenanceArcSkillSourceSchema(db);
  }
  if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_NPC_SKILL_SOURCE_TABLE)) {
    inspectMaintenanceNpcSkillSourceSchema(db);
  }
}

function inspectMaintenanceExecutorSchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(maintenance_job)').all() as SqlRow[];
  const route = columns.find((column) => column.name === 'executor_route');
  if (!route || columns.at(-1) !== route || route.type !== 'TEXT' || route.notnull !== 1
    || route.dflt_value !== "'legacy'" || route.pk !== 0
    || db.prepare("SELECT 1 FROM maintenance_job WHERE executor_route IS NULL OR executor_route NOT IN ('legacy','agent-loop') LIMIT 1").get()) {
    throw new Error('maintenance executor schema invalid');
  }
}

function normalizeMaintenanceOwnedSql(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '')
    : '';
}

export function inspectMaintenanceProductionRouteReceiptSchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE) as SqlRow | undefined;
  const columns = db.prepare(
    `PRAGMA table_info(${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE})`,
  ).all() as SqlRow[];
  const foreignKeys = db.prepare(
    `PRAGMA foreign_key_list(${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE})`,
  ).all() as SqlRow[];
  const index = db.prepare(
    'SELECT sql FROM sqlite_master WHERE type=\'index\' AND name=\'maintenance_production_route_receipt_claimed\'',
  ).get() as SqlRow | undefined;
  const indexColumns = db.prepare(
    'PRAGMA index_info(maintenance_production_route_receipt_claimed)',
  ).all() as SqlRow[];
  const updateGuard = db.prepare(
    'SELECT sql FROM sqlite_master WHERE type=\'trigger\' AND name=\'maintenance_production_route_receipt_update_immutable\'',
  ).get() as SqlRow | undefined;
  const deleteGuard = db.prepare(
    'SELECT sql FROM sqlite_master WHERE type=\'trigger\' AND name=\'maintenance_production_route_receipt_delete_immutable\'',
  ).get() as SqlRow | undefined;
  const attached = db.prepare(`SELECT type,name FROM sqlite_master
    WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY type,name`)
    .all(MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE);
  const expectedAttached = [
    { type: 'index', name: 'maintenance_production_route_receipt_claimed' },
    { type: 'table', name: MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE },
    { type: 'trigger', name: 'maintenance_production_route_receipt_delete_immutable' },
    { type: 'trigger', name: 'maintenance_production_route_receipt_update_immutable' },
  ];
  if (JSON.stringify(columns.map(column => column.name))
      !== JSON.stringify(['run_id', 'claimed_at', 'receipt_digest', 'receipt_json'])
    || columns.some((column, position) => column.type !== 'TEXT'
      || column.notnull !== 1 || column.pk !== (position === 0 ? 1 : 0)
      || column.dflt_value !== null)
    || normalizeMaintenanceOwnedSql(table?.sql)
      !== normalizeMaintenanceOwnedSql(productionRouteReceiptTableDefinitionSql())
    || foreignKeys.length !== 1 || foreignKeys[0].table !== 'maintenance_job'
    || foreignKeys[0].from !== 'run_id' || foreignKeys[0].to !== 'run_id'
    || foreignKeys[0].on_delete !== 'CASCADE'
    || normalizeMaintenanceOwnedSql(index?.sql) !== normalizeMaintenanceOwnedSql(
      `CREATE INDEX maintenance_production_route_receipt_claimed
        ON ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE}(claimed_at DESC,run_id DESC)`,
    )
    || JSON.stringify(indexColumns.map(column => column.name))
      !== JSON.stringify(['claimed_at', 'run_id'])
    || normalizeMaintenanceOwnedSql(updateGuard?.sql)
      !== normalizeMaintenanceOwnedSql(productionRouteReceiptUpdateGuardSql())
    || normalizeMaintenanceOwnedSql(deleteGuard?.sql)
      !== normalizeMaintenanceOwnedSql(productionRouteReceiptDeleteGuardSql())
    || JSON.stringify(attached) !== JSON.stringify(expectedAttached)) {
    throw new Error('maintenance production route receipt schema invalid');
  }
  if (db.prepare(`SELECT 1
    FROM ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} r
    LEFT JOIN maintenance_job j ON j.run_id=r.run_id
    WHERE j.run_id IS NULL LIMIT 1`).get()) {
    throw new Error('maintenance production route receipt orphan invalid');
  }
  const rows = db.prepare(`SELECT
      r.receipt_json AS production_receipt_json,
      r.claimed_at AS production_receipt_claimed_at,
      r.receipt_digest AS production_receipt_digest,
      j.*
    FROM ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} r
    JOIN maintenance_job j ON j.run_id=r.run_id
    ORDER BY r.run_id`).all() as SqlRow[];
  for (const row of rows) parseProductionRouteReceiptRow(row);
}

function migrateMaintenanceJobV5(db: DatabaseSync): void {
  // Append only: preserve all existing job, outbox, proposal and optional Skill rows/FKs.
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec("ALTER TABLE maintenance_job ADD COLUMN executor_route TEXT NOT NULL DEFAULT 'legacy' CHECK (executor_route IN ('legacy','agent-loop')); ");
    inspectMaintenanceExecutorSchema(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('maintenance v5 foreign key check failed');
    db.exec('PRAGMA user_version = 5; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original migration failure */ }
    throw error;
  }
}

function inspectMaintenanceProposalSchema(db: DatabaseSync, version: 5 | 6 | 7): void {
  const agentLoopPreparation = version >= 6;
  const columns = db.prepare('PRAGMA table_info(maintenance_pending_proposal)').all() as SqlRow[];
  const expectedNames = ['proposal_id', 'job_run_id', 'session_id', 'task_kind', 'source_revision', 'proposal_digest',
    'proposal_json', 'context_json', 'diff_json', 'status', 'revision', 'created_at', 'updated_at',
    'decided_at', 'decision_reason', 'receipt_json', 'rollback_anchor_json',
    ...(agentLoopPreparation ? ['agent_loop_preparation_json'] : []),
    ...(version === 7 ? ['agent_loop_publication_json'] : [])];
  const normalizeSql = (value: unknown) => {
    if (typeof value !== 'string') return '';
    if (agentLoopPreparation) return value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '');
    // Frozen v5 databases may use compact punctuation or quote a renamed table.
    // Normalize SQL tokens, not enum/default string literals or their casing.
    const identifiers = [...expectedNames, 'maintenance_pending_proposal', 'maintenance_job', 'run_id'];
    const unquoted = value.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu,
      (quoted, identifier: string) => identifiers.includes(identifier.toLowerCase()) ? identifier : quoted);
    return (unquoted.match(/'(?:''|[^'])*'|[^']+/gu) ?? []).map(token => token.startsWith("'")
      ? token : token.replace(/\s+/gu, '').toLowerCase()).join('').replace(/;$/u, '');
  };
  const expectedSql = proposalTableSql(version).split('CREATE INDEX')[0].trim();
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='maintenance_pending_proposal'").get() as SqlRow | undefined;
  const keys = db.prepare('PRAGMA foreign_key_list(maintenance_pending_proposal)').all() as SqlRow[];
  const index = db.prepare('PRAGMA index_info(maintenance_pending_by_session)').all() as SqlRow[];
  const trigger = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'trigger\' AND name=?')
    .get(version === 7 ? 'maintenance_agent_loop_publication_immutable' : 'maintenance_agent_loop_prepared_immutable') as SqlRow | undefined;
  if (JSON.stringify(columns.map(column => column.name)) !== JSON.stringify(expectedNames)
    || columns.some((column, position) => column.type !== (column.name === 'revision' ? 'INTEGER' : 'TEXT')
      || column.pk !== (position === 0 ? 1 : 0)
      || column.notnull !== (position >= 1 && position <= 12 ? 1 : 0)
      || column.dflt_value !== (column.name === 'revision' ? '1' : null))
    || normalizeSql(table?.sql) !== normalizeSql(expectedSql)
    || keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'job_run_id'
    || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE'
    || JSON.stringify(index.map(row => row.name)) !== JSON.stringify(['session_id', 'status', 'created_at'])
    || agentLoopPreparation && normalizeSql(trigger?.sql) !== normalizeSql(version === 7
      ? agentLoopPublicationGuardSql() : agentLoopPreparedGuardSql())) {
    throw new Error('maintenance proposal schema invalid');
  }
}

function migrateMaintenanceJobV6(db: DatabaseSync): void {
  // Rebuild only the original approval queue. Optional Skill tables still reference
  // the unchanged original maintenance_job, never this renamed queue.
  inspectMaintenanceProposalSchema(db, 5);
  inspectMaintenanceExecutorSchema(db);
  inspectMaintenanceSkillSchemas(db, true);
  // Pin actual optional schema/rows as well as validating their original pure
  // inspectors. The outbox constructor's no-transaction contract stays intact.
  const skillSnapshot = () => JSON.stringify([MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE,
    MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE, MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE,
    MAINTENANCE_ARC_SKILL_SOURCE_TABLE, MAINTENANCE_NPC_SKILL_SOURCE_TABLE].map(table => {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name').all(table);
    return { table, schema, columns: db.prepare(`PRAGMA table_info(${table})`).all(),
      keys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
      rows: schema.some(row => row.type === 'table') ? db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() : [] };
  }));
  const originalSkills = skillSnapshot();
  const legacyColumns = 'proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,proposal_json,context_json,diff_json,status,revision,created_at,updated_at,decided_at,decision_reason,receipt_json,rollback_anchor_json';
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    if (skillSnapshot() !== originalSkills) throw new Error('maintenance v6 skill preservation failed');
    db.exec(`ALTER TABLE maintenance_pending_proposal RENAME TO maintenance_pending_proposal_v5;
      DROP INDEX maintenance_pending_by_session;
      ${proposalTableSql(6)}
      INSERT INTO maintenance_pending_proposal(${legacyColumns})
        SELECT ${legacyColumns} FROM maintenance_pending_proposal_v5;`);
    if (db.prepare(`SELECT ${legacyColumns} FROM maintenance_pending_proposal_v5
        EXCEPT SELECT ${legacyColumns} FROM maintenance_pending_proposal`).get()
      || db.prepare(`SELECT ${legacyColumns} FROM maintenance_pending_proposal
        EXCEPT SELECT ${legacyColumns} FROM maintenance_pending_proposal_v5`).get()
      || db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE agent_loop_preparation_json IS NOT NULL').get()) {
      throw new Error('maintenance v6 proposal preservation failed');
    }
    db.exec('DROP TABLE maintenance_pending_proposal_v5;');
    db.exec(agentLoopPreparedGuardSql());
    inspectMaintenanceProposalSchema(db, 6);
    inspectMaintenanceExecutorSchema(db);
    inspectMaintenanceSkillSchemas(db, true);
    if (skillSnapshot() !== originalSkills) throw new Error('maintenance v6 skill preservation failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('maintenance v6 foreign key check failed');
    db.exec('PRAGMA user_version=6; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve the original migration failure */ }
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON;'); }
}

function migrateMaintenanceJobV7(db: DatabaseSync): void {
  // Authentic v6 remains a separate frozen schema. Only the original pending
  // queue is rebuilt; all origin/body JSON bytes and every other table survive.
  inspectMaintenanceProposalSchema(db, 6);
  inspectMaintenanceExecutorSchema(db);
  inspectMaintenanceSkillSchemas(db, true);
  // A rebuild must not silently erase an operator/custom attached constraint.
  // Historical v6 owns exactly this index and its original immutable trigger.
  const attached = () => JSON.stringify(db.prepare(`SELECT type,name FROM sqlite_master
    WHERE tbl_name='maintenance_pending_proposal' AND type<>'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY type,name`).all());
  const expectedAttached = JSON.stringify([
    { type: 'index', name: 'maintenance_pending_by_session' },
    { type: 'trigger', name: 'maintenance_agent_loop_prepared_immutable' },
  ]);
  if (attached() !== expectedAttached) throw new Error('maintenance v7 attached proposal schema unsupported');
  const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
  const unchanged = () => {
    const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND tbl_name<>'maintenance_pending_proposal' ORDER BY type,name`).all();
    const tables = schema.filter(row => row.type === 'table').map(row => String(row.name));
    return JSON.stringify({ schema, tables: tables.map(table => ({ table,
      columns: db.prepare(`PRAGMA table_info(${quote(table)})`).all(),
      keys: db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all(),
      rows: db.prepare(`SELECT rowid,* FROM ${quote(table)} ORDER BY rowid`).all() })) });
  };
  const original = unchanged();
  const columns = 'rowid,proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,proposal_json,context_json,diff_json,status,revision,created_at,updated_at,decided_at,decision_reason,receipt_json,rollback_anchor_json,agent_loop_preparation_json';
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    inspectMaintenanceProposalSchema(db, 6);
    if (attached() !== expectedAttached) throw new Error('maintenance v7 attached proposal schema unsupported');
    if (unchanged() !== original) throw new Error('maintenance v7 unrelated preservation failed');
    db.exec(`ALTER TABLE maintenance_pending_proposal RENAME TO maintenance_pending_proposal_v6;
      DROP INDEX maintenance_pending_by_session;
      ${proposalTableSql(7)}
      INSERT INTO maintenance_pending_proposal(${columns})
        SELECT ${columns} FROM maintenance_pending_proposal_v6;`);
    if (db.prepare(`SELECT ${columns} FROM maintenance_pending_proposal_v6
        EXCEPT SELECT ${columns} FROM maintenance_pending_proposal`).get()
      || db.prepare(`SELECT ${columns} FROM maintenance_pending_proposal
        EXCEPT SELECT ${columns} FROM maintenance_pending_proposal_v6`).get()
      || db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE agent_loop_publication_json IS NOT NULL').get()) {
      throw new Error('maintenance v7 proposal preservation failed');
    }
    db.exec('DROP TABLE maintenance_pending_proposal_v6;');
    // A late trigger/index/schema failure still rolls back the whole v6 rebuild.
    db.exec(agentLoopPublicationGuardSql());
    inspectMaintenanceProposalSchema(db, 7);
    inspectMaintenanceExecutorSchema(db);
    inspectMaintenanceSkillSchemas(db, true);
    if (unchanged() !== original) throw new Error('maintenance v7 unrelated preservation failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('maintenance v7 foreign key check failed');
    db.exec('PRAGMA user_version=7; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve the original migration failure */ }
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON;'); }
}

function migrateMaintenanceJobV8(db: DatabaseSync): void {
  // v8 is append-only. Historical jobs receive no synthetic receipt: only a
  // production-v2 claim can insert one inside its winning claim transaction.
  inspectMaintenanceExecutorSchema(db);
  inspectMaintenanceProposalSchema(db, 7);
  inspectMaintenanceSkillSchemas(db, true);
  const reservedNames = [
    MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE,
    'maintenance_production_route_receipt_claimed',
    'maintenance_production_route_receipt_delete_immutable',
    'maintenance_production_route_receipt_update_immutable',
  ];
  if (db.prepare(`SELECT 1 FROM sqlite_master
    WHERE name IN (${reservedNames.map(() => '?').join(',')}) LIMIT 1`).get(...reservedNames)) {
    throw new Error('maintenance v8 production route receipt schema collision');
  }
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(productionRouteReceiptTableSql());
    inspectMaintenanceProductionRouteReceiptSchema(db);
    inspectMaintenanceExecutorSchema(db);
    inspectMaintenanceProposalSchema(db, 7);
    inspectMaintenanceSkillSchemas(db, true);
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('maintenance v8 foreign key check failed');
    }
    db.exec('PRAGMA user_version=8; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve the original migration failure */ }
    throw error;
  }
}

function initializeSchema(db: DatabaseSync): void {
  let version = readPragma(db, 'user_version');
  const applicationId = readPragma(db, 'application_id');
  if (version > MAINTENANCE_JOB_SCHEMA_VERSION) throw new Error('maintenance database too new');
  if (version < 4 && db.prepare(
    'SELECT 1 FROM sqlite_master WHERE name IN (?,?,?,?,?)',
  ).get(MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE, MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE,
    MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE, MAINTENANCE_ARC_SKILL_SOURCE_TABLE, MAINTENANCE_NPC_SKILL_SOURCE_TABLE)) {
    throw new Error('maintenance legacy skill schema invalid');
  }
  if (version !== 0) {
    if (applicationId !== MAINTENANCE_JOB_APPLICATION_ID) {
      throw new Error('maintenance database metadata mismatch');
    }
    if (version === 1) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(proposalTableSql());
        db.exec('PRAGMA user_version = 2;');
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
        throw error;
      }
      version = 2;
    }
    if (version === 2) {
      migrateMaintenanceJobV3(db);
      version = 3;
    }
    if (version === 3) { migrateMaintenanceJobV4(db); version = 4; }
    if (version === 4) { inspectMaintenanceSkillSchemas(db, true); migrateMaintenanceJobV5(db); version = 5; }
    if (version === 5) { migrateMaintenanceJobV6(db); version = 6; }
    if (version === 6) { migrateMaintenanceJobV7(db); version = 7; }
    if (version === 7) { migrateMaintenanceJobV8(db); version = 8; }
    if (version !== MAINTENANCE_JOB_SCHEMA_VERSION) throw new Error('maintenance database metadata mismatch');
    inspectMaintenanceExecutorSchema(db);
    inspectMaintenanceProposalSchema(db, 7);
    inspectMaintenanceProductionRouteReceiptSchema(db);
    inspectMaintenanceSkillSchemas(db);
    return;
  }
  if (applicationId !== 0) throw new Error('maintenance database application id mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${MAINTENANCE_JOB_APPLICATION_ID};
      CREATE TABLE maintenance_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        global_enabled INTEGER NOT NULL CHECK (global_enabled IN (0,1)),
        default_mode TEXT NOT NULL CHECK (default_mode IN ('shadow','apply')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE maintenance_session_settings (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        updated_at TEXT NOT NULL
      );
      ${jobTableSql()}
      ${outboxTableSql()}
      ${proposalTableSql(7)}
      ${agentLoopPublicationGuardSql()}
      ${productionRouteReceiptTableSql()}
      PRAGMA user_version = ${MAINTENANCE_JOB_SCHEMA_VERSION};
    `);
    inspectMaintenanceExecutorSchema(db);
    inspectMaintenanceProposalSchema(db, 7);
    inspectMaintenanceProductionRouteReceiptSchema(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('maintenance schema foreign key check failed');
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve */ }
    throw error;
  }
}

function parseProposalRow(row: SqlRow): MaintenancePendingProposalRecord {
  const taskKind = String(row.task_kind);
  if (taskKind !== 'memory_consolidation' && taskKind !== 'branch_index'
    && taskKind !== 'rolling_summary' && taskKind !== 'npc_state') {
    throw new Error('maintenance proposal task kind corrupt');
  }
  const status = String(row.status);
  if (!['pending', 'applied', 'rejected', 'stale', 'rolled_back'].includes(status)) {
    throw new Error('maintenance proposal status corrupt');
  }
  const proposal = requireJsonObject(
    JSON.parse(String(row.proposal_json)), 'proposal_json', MAX_PROPOSAL_BYTES,
  ) as unknown as MaintenanceProposal;
  if (proposal.taskKind !== row.task_kind || typeof proposal.payload !== 'object' || proposal.payload === null) {
    throw new Error('maintenance proposal payload corrupt');
  }
  const context = requireJsonObject(
    JSON.parse(String(row.context_json)), 'context_json', MAX_CONTEXT_BYTES,
  ) as unknown as MaintenanceStrictProposalContext;
  const diff = requireJsonObject(JSON.parse(String(row.diff_json)), 'diff_json', MAX_DIFF_BYTES);
  const receipt = row.receipt_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.receipt_json)), 'receipt_json', MAX_RECEIPT_BYTES);
  const rollbackAnchor = row.rollback_anchor_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.rollback_anchor_json)), 'rollback_anchor_json', MAX_RECEIPT_BYTES);
  return Object.freeze({
    proposalId: requireOpaque(row.proposal_id, 'proposal_id'),
    jobRunId: requireOpaque(row.job_run_id, 'job_run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    taskKind,
    sourceRevision: requireOpaque(row.source_revision, 'source_revision'),
    proposalDigest: requireOpaque(row.proposal_digest, 'proposal_digest'),
    proposal: structuredClone(proposal),
    context: structuredClone(context),
    diff: Object.freeze(diff),
    status: status as MaintenanceProposalStatus,
    revision: Number(row.revision),
    createdAt: canonicalTimestamp(String(row.created_at)),
    updatedAt: canonicalTimestamp(String(row.updated_at)),
    ...(row.decided_at == null ? {} : { decidedAt: canonicalTimestamp(String(row.decided_at)) }),
    ...(row.decision_reason == null ? {} : {
      decisionReason: requireOpaque(row.decision_reason, 'decision_reason', 120),
    }),
    ...(receipt ? { receipt: Object.freeze(receipt) } : {}),
    ...(rollbackAnchor ? { rollbackAnchor: Object.freeze(rollbackAnchor) } : {}),
  });
}

function proposalSummary(row: MaintenancePendingProposalRecord): MaintenancePendingProposalSummary {
  const { proposal: _proposal, context: _context, receipt: _receipt, rollbackAnchor: _anchor, ...summary } = row;
  return Object.freeze(summary);
}

function parseBudget(value: unknown): BudgetSnapshot | undefined {
  if (value == null) return undefined;
  const parsed = JSON.parse(String(value)) as BudgetSnapshot;
  const keys: Array<keyof BudgetSnapshot> = [
    'stepsUsed', 'modelCallsUsed', 'toolCallsUsed', 'writesUsed', 'tokensUsed',
    'wallMsUsed', 'inputTokens', 'outputTokens', 'costMicrousd',
  ];
  if (keys.some((key) => !Number.isSafeInteger(parsed[key]) || parsed[key] < 0)) {
    throw new Error('maintenance budget row invalid');
  }
  return parsed;
}

function summaryApplyCompletionFromRow(row: SqlRow, job: PublicMaintenanceJob): MaintenanceAgentLoopSummaryApplyCompletionReceipt | null {
  if (row.diff_json === null) return null;
  const diff = requireJsonObject(JSON.parse(String(row.diff_json)), 'diff_json', MAX_DIFF_BYTES);
  if (!Object.hasOwn(diff, MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE)) return null;
  const completion = parseMaintenanceAgentLoopSummaryApplyCompletionReceipt(diff[MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE], job);
  if (Object.keys(diff).length !== 1 || row.executor_route !== 'agent-loop' || row.task_kind !== 'rolling_summary'
    || row.mode !== 'apply' || row.status !== 'succeeded' || row.cancel_requested_at !== null || row.error_code !== null
    || row.lease_owner_instance_id !== null || row.lease_expires_at !== null
    || row.proposal_disposition !== 'committed' || row.proposal_digest !== completion.proposalDigest.slice(7)
    || row.diff_json !== JSON.stringify({ [MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE]: completion })) {
    throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
  }
  return completion;
}

function parseJob(row: SqlRow): PublicMaintenanceJob {
  if (!isMaintenanceTaskKind(row.task_kind) || !isMaintenanceTrigger(row.trigger_kind)
    || !isMaintenanceMode(row.mode)) throw new Error('maintenance enum row invalid');
  const status = row.status as MaintenanceStatus;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale'].includes(status)) {
    throw new Error('maintenance status row invalid');
  }
  const budget = parseBudget(row.budget_json);
  const diff = row.diff_json == null ? undefined
    : requireJsonObject(JSON.parse(String(row.diff_json)), 'diff_json', MAX_DIFF_BYTES);
  const job: PublicMaintenanceJob = {
    runId: requireOpaque(row.run_id, 'run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    taskKind: row.task_kind,
    sourceRevision: requireOpaque(row.source_revision, 'source_revision'),
    policyVersion: requireOpaque(row.policy_version, 'policy_version'),
    ...(row.parent_run_id == null ? {} : { parentRunId: requireOpaque(row.parent_run_id, 'parent_run_id') }),
    trigger: row.trigger_kind,
    mode: row.mode,
    status,
    attempt: Number(row.attempt),
    createdAt: canonicalTimestamp(String(row.created_at)),
    updatedAt: canonicalTimestamp(String(row.updated_at)),
    ...(row.started_at == null ? {} : { startedAt: canonicalTimestamp(String(row.started_at)) }),
    ...(row.finished_at == null ? {} : { finishedAt: canonicalTimestamp(String(row.finished_at)) }),
    ...(row.error_code == null ? {} : { errorCode: requireOpaque(row.error_code, 'error_code', 80) }),
    ...(budget ? { budget } : {}),
    ...(row.proposal_digest == null || row.proposal_disposition == null || diff === undefined ? {} : {
      proposal: {
        digest: requireOpaque(row.proposal_digest, 'proposal_digest'),
        disposition: row.proposal_disposition as 'shadow' | 'committed' | 'stale',
        diff,
      },
    }),
  };
  // Only this exact durable AL/apply namespace is private. Legacy/shadow diffs
  // retain their original public representation; no receipt IDs leak via get/list.
  if (row.executor_route === 'agent-loop' && row.mode === 'apply' && row.status === 'succeeded'
    && diff && Object.hasOwn(diff, MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE)) {
    summaryApplyCompletionFromRow(row, job);
    return { ...job, proposal: { ...job.proposal!, diff: {} } };
  }
  return job;
}

const PRODUCTION_ROUTE_RECEIPT_READ_SELECT = `SELECT
    r.receipt_json AS production_receipt_json,
    r.claimed_at AS production_receipt_claimed_at,
    r.receipt_digest AS production_receipt_digest,
    j.*
  FROM ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} r
  JOIN maintenance_job j ON j.run_id=r.run_id`;

/** Strict read-only receipt lookup usable with an already-open read-only SQLite handle. */
export function readMaintenanceProductionRouteReceipt(
  db: DatabaseSync,
  runIdValue: string,
): Readonly<MaintenanceProductionRouteReceipt> | null {
  const runId = requireOpaque(runIdValue, 'runId');
  const row = db.prepare(`${PRODUCTION_ROUTE_RECEIPT_READ_SELECT}
    WHERE r.run_id=?`).get(runId) as SqlRow | undefined;
  return row ? parseProductionRouteReceiptRow(row) : null;
}

/** Strict newest-first read-only receipt scan for one session. */
export function listMaintenanceProductionRouteReceipts(
  db: DatabaseSync,
  sessionIdValue: string,
  limit = 50,
): readonly Readonly<MaintenanceProductionRouteReceipt>[] {
  const sessionId = requireOpaque(sessionIdValue, 'sessionId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit invalid');
  const rows = db.prepare(`${PRODUCTION_ROUTE_RECEIPT_READ_SELECT}
    WHERE j.session_id=? ORDER BY r.claimed_at DESC,r.run_id DESC LIMIT ?`)
    .all(sessionId, limit) as SqlRow[];
  return Object.freeze(rows.map(parseProductionRouteReceiptRow));
}

export class MaintenanceJobManager {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #randomId: () => string;
  readonly #onSkillProvenanceFailure: () => void;
  readonly #directPreparations = new WeakMap<object, Readonly<{
    runId: string; owner: string; attempt: number; preparationDigest: string;
  }>>();
  readonly #summaryPreparations = new WeakMap<object, Readonly<{
    runId: string; owner: string; attempt: number; recordDigest: string;
  }>>();
  #closed = false;

  constructor(options: MaintenanceJobManagerOptions) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stats = lstatSync(dataDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('maintenance dataDir must be a directory');
    const path = join(dataDir, MAINTENANCE_JOB_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('maintenance database must be a regular file');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS};`);
      initializeSchema(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL handled by dataDir policy. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    try {
      const canonicalPath = realpathSync.native(path);
      // Stat the canonical target rather than a possible symlink inode so every
      // alias of one SQLite file enters the same process-local production fence.
      const databaseStats = lstatSync(canonicalPath, { bigint: true });
      const normalizedPath = process.platform === 'win32'
        ? canonicalPath.toLowerCase()
        : canonicalPath;
      // dev/ino/birth time unifies path aliases and hard links while avoiding a
      // stale fence if a deleted test database is recreated at the same path.
      const databaseIdentity = databaseStats.ino !== 0n
        ? `file:${databaseStats.dev}:${databaseStats.ino}:${databaseStats.birthtimeNs}`
        : `path:${normalizedPath}`;
      MAINTENANCE_JOB_MANAGER_DATABASE_IDENTITIES.set(this, databaseIdentity);
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
    this.#onSkillProvenanceFailure = options.onSkillProvenanceFailure ?? (() => {});
    const now = canonicalTimestamp(this.#now());
    this.#db.prepare(`
      INSERT OR IGNORE INTO maintenance_settings(singleton, global_enabled, default_mode, updated_at)
      VALUES(1, 0, 'shadow', ?)
    `).run(now);
    MAINTENANCE_JOB_MANAGER_INSTANCES.add(this);
    OPEN_MAINTENANCE_JOB_MANAGER_INSTANCES.add(this);
  }

  settings(sessionIdValue: string): MaintenanceSettings {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    const global = this.#db.prepare('SELECT * FROM maintenance_settings WHERE singleton=1').get() as SqlRow;
    const local = this.#db.prepare('SELECT enabled FROM maintenance_session_settings WHERE session_id=?')
      .get(sessionId) as SqlRow | undefined;
    const globalEnabled = global.global_enabled === 1;
    const sessionEnabled = local?.enabled !== 0;
    const defaultMode = String(global.default_mode);
    if (!isMaintenanceMode(defaultMode)) throw new Error('maintenance settings corrupt');
    return { globalEnabled, defaultMode, sessionEnabled, effectiveEnabled: globalEnabled && sessionEnabled };
  }

  setGlobalEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.#db.prepare('UPDATE maintenance_settings SET global_enabled=?, updated_at=? WHERE singleton=1')
      .run(enabled ? 1 : 0, canonicalTimestamp(this.#now()));
  }

  globalEnabled(): boolean {
    this.#assertOpen();
    const row = this.#db.prepare(
      'SELECT global_enabled FROM maintenance_settings WHERE singleton=1',
    ).get() as SqlRow;
    return row.global_enabled === 1;
  }

  setDefaultMode(mode: MaintenanceMode): void {
    this.#assertOpen();
    if (!isMaintenanceMode(mode)) throw new Error('mode invalid');
    this.#db.prepare('UPDATE maintenance_settings SET default_mode=?, updated_at=? WHERE singleton=1')
      .run(mode, canonicalTimestamp(this.#now()));
  }

  setSessionEnabled(sessionIdValue: string, enabled: boolean): void {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    this.#db.prepare(`
      INSERT INTO maintenance_session_settings(session_id, enabled, updated_at) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run(sessionId, enabled ? 1 : 0, canonicalTimestamp(this.#now()));
  }

  enqueue(input: EnqueueMaintenanceInput): { job: PublicMaintenanceJob; replayed: boolean } {
    this.#assertOpen();
    const sessionId = requireOpaque(input.sessionId, 'sessionId');
    if (!isMaintenanceTaskKind(input.taskKind)) throw new Error('taskKind invalid');
    if (!isMaintenanceTrigger(input.trigger)) throw new Error('trigger invalid');
    const sourceRevision = requireOpaque(input.sourceRevision, 'sourceRevision');
    const policyVersion = requireOpaque(input.policyVersion ?? MAINTENANCE_POLICY_VERSION, 'policyVersion');
    const parentRunId = input.parentRunId === undefined ? undefined : requireOpaque(input.parentRunId, 'parentRunId');
    const settings = this.settings(sessionId);
    if (!settings.effectiveEnabled) throw new MaintenanceDisabledError('maintenance disabled');
    const mode = input.mode ?? settings.defaultMode;
    if (!isMaintenanceMode(mode)) throw new Error('mode invalid');
    const now = canonicalTimestamp(this.#now());
    const uuid = this.#randomId().replaceAll('-', '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(uuid)) throw new Error('maintenance random source must return UUID');
    const runId = `mjob_${uuid}`;
    const outboxId = `mout_${uuid}`;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#db.prepare(`
        SELECT * FROM maintenance_job
        WHERE session_id=? AND task_kind=? AND source_revision=? AND policy_version=?
      `).get(sessionId, input.taskKind, sourceRevision, policyVersion) as SqlRow | undefined;
      if (existing) {
        this.#db.exec('COMMIT;');
        return { job: parseJob(existing), replayed: true };
      }
      this.#db.prepare(`
        INSERT INTO maintenance_job(
          run_id,session_id,task_kind,source_revision,policy_version,parent_run_id,
          trigger_kind,mode,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)
      `).run(runId, sessionId, input.taskKind, sourceRevision, policyVersion,
        parentRunId ?? null, input.trigger, mode, now, now);
      this.#db.prepare(`
        INSERT INTO maintenance_outbox(outbox_id,job_run_id,available_at) VALUES(?,?,?)
      `).run(outboxId, runId, now);
      const created = this.#getRow(runId);
      if (!created) throw new Error('maintenance job readback failed');
      this.#db.exec('COMMIT;');
      return { job: parseJob(created), replayed: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  claimNext(
    ownerValue: string,
    leaseMs = 30_000,
    canClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean = () => true,
    routeClaim?: MaintenanceAgentLoopClaim,
  ): MaintenanceExecutionRecord | null {
    this.#assertOpen();
    const owner = requireOpaque(ownerValue, 'owner');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('leaseMs invalid');
    let route: MaintenanceExecutorRoute = 'legacy', targetRunId: string | null = null;
    if (routeClaim !== undefined) {
      if (!routeClaim || typeof routeClaim !== 'object' || Array.isArray(routeClaim)
        || (Object.getPrototypeOf(routeClaim) !== Object.prototype && Object.getPrototypeOf(routeClaim) !== null)
        || Object.keys(routeClaim).length !== 2 || !Object.hasOwn(routeClaim, 'executorRoute')
        || !Object.hasOwn(routeClaim, 'runId') || routeClaim.executorRoute !== 'agent-loop') {
        throw new Error('maintenance executor claim invalid');
      }
      targetRunId = requireOpaque(routeClaim.runId, 'runId'); route = 'agent-loop';
    }
    return this.#claimNextWithRouting(owner, leaseMs, canClaim, targetRunId, () => route, 'explicit');
  }

  /**
   * Selects exactly one queued executor inside the Manager writer transaction.
   * This is a dispatch primitive, not an AL admission grant: callers must still
   * supply all lane/capability/source/bundle/publication gates.
   */
  claimNextRouted(
    ownerValue: string,
    leaseMs = 30_000,
    canClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean = () => true,
    selectRoute: MaintenanceQueuedRouteSelector,
  ): MaintenanceExecutionRecord | null {
    this.#assertOpen();
    const owner = requireOpaque(ownerValue, 'owner');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('leaseMs invalid');
    if (typeof selectRoute !== 'function') throw new Error('maintenance route selector invalid');
    return this.#claimNextWithRouting(owner, leaseMs, canClaim, null, selectRoute, 'canary-v1');
  }

  /**
   * Versioned p14/post-turn selector. Its structured decision distinguishes the
   * persisted admission policy from the p13b AL execution contract. Like the
   * v1 primitive, this method grants nothing until the same SQLite transaction
   * persists the winning executor route.
   */
  claimNextProductionRouted(
    ownerValue: string,
    leaseMs = 30_000,
    canClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean = () => true,
    selectRoute: MaintenanceProductionQueuedRouteSelector,
  ): MaintenanceExecutionRecord | null {
    this.#assertOpen();
    const owner = requireOpaque(ownerValue, 'owner');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('leaseMs invalid');
    const coordinator = PRODUCTION_CLAIM_COORDINATORS.get(selectRoute);
    if (typeof selectRoute !== 'function' || nodeTypes.isProxy(selectRoute)
      || PRODUCTION_ROUTE_SELECTORS.get(selectRoute) !== this
      || !coordinator
      || PRODUCTION_CLAIM_COORDINATOR_MANAGERS.get(coordinator) !== this) {
      throw new Error('maintenance production route selector invalid');
    }
    return this.#claimNextWithRouting(
      owner,
      leaseMs,
      canClaim,
      null,
      selectRoute,
      'production-v2',
      coordinator,
    );
  }

  #commitClaim(
    row: SqlRow,
    route: MaintenanceExecutorRoute,
    owner: string,
    leaseMs: number,
    productionDecision: Readonly<MaintenanceProductionQueuedRouteDecision> | null = null,
  ): MaintenanceExecutionRecord {
    // No awaited readback or public DTO may choose a route after this claim.
    const claimedAt = canonicalTimestamp(this.#now());
    const expires = new Date(Date.parse(claimedAt) + leaseMs).toISOString();
    const result = this.#db.prepare(`
      UPDATE maintenance_job SET status='running', attempt=attempt+1, started_at=COALESCE(started_at,?),
        updated_at=?, lease_owner_instance_id=?, lease_expires_at=?, executor_route=?
      WHERE run_id=? AND status='queued' AND executor_route='legacy' AND cancel_requested_at IS NULL
    `).run(claimedAt, claimedAt, owner, expires, route, String(row.run_id));
    if (result.changes !== 1) throw new Error('maintenance claim conflict');
    const outbox = this.#db.prepare(
      'UPDATE maintenance_outbox SET claimed_at=? WHERE job_run_id=?',
    ).run(claimedAt, String(row.run_id));
    if (outbox.changes !== 1) throw new Error('maintenance claim outbox conflict');
    let expectedReceipt: Readonly<MaintenanceProductionRouteReceipt> | null = null;
    if (productionDecision) {
      const queuedJob = Object.freeze({ ...parseJob(row) });
      const normalizedDecision = normalizeProductionQueuedRouteDecision(
        productionDecision,
        queuedJob,
      );
      if (!normalizedDecision || normalizedDecision.executorRoute !== route) {
        throw new Error('maintenance production route receipt decision invalid');
      }
      const receipt = createProductionRouteReceipt(
        requireOpaque(row.run_id, 'run_id'),
        normalizedDecision,
        claimedAt,
      );
      const receiptJson = JSON.stringify(receipt);
      if (Buffer.byteLength(receiptJson, 'utf8') > MAX_PRODUCTION_ROUTE_RECEIPT_BYTES) {
        throw new Error('maintenance production route receipt too large');
      }
      const inserted = this.#db.prepare(`INSERT INTO ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE}(
        run_id,claimed_at,receipt_digest,receipt_json
      ) VALUES(?,?,?,?)`).run(
        receipt.runId,
        receipt.claimedAt,
        receipt.receiptDigest,
        receiptJson,
      );
      if (inserted.changes !== 1) {
        throw new Error('maintenance production route receipt insert conflict');
      }
      expectedReceipt = receipt;
    }
    const claimed = this.#getRow(String(row.run_id));
    if (!claimed) throw new Error('maintenance claimed job missing');
    const execution: MaintenanceExecutionRecord = {
      job: parseJob(claimed),
      executorRoute: executorRoute(claimed.executor_route),
      leaseOwnerInstanceId: owner,
      leaseExpiresAt: expires,
      ...(claimed.cancel_requested_at == null ? {} : {
        cancelRequestedAt: canonicalTimestamp(String(claimed.cancel_requested_at)),
      }),
    };
    if (expectedReceipt) {
      const storedReceipt = readMaintenanceProductionRouteReceipt(
        this.#db,
        expectedReceipt.runId,
      );
      if (!storedReceipt || storedReceipt.receiptDigest !== expectedReceipt.receiptDigest
        || canonicalProductionRouteReceiptJson(storedReceipt)
          !== canonicalProductionRouteReceiptJson(expectedReceipt)) {
        throw new Error('maintenance production route receipt readback conflict');
      }
    }
    this.#db.exec('COMMIT;');
    return execution;
  }

  #claimNextWithRouting(
    owner: string,
    leaseMs: number,
    canClaim: (sessionId: string, taskKind: MaintenanceTaskKind) => boolean,
    targetRunId: string | null,
    selectRoute: (job: Readonly<PublicMaintenanceJob>) => unknown,
    routeContract: 'explicit' | 'canary-v1' | 'production-v2',
    productionCoordinator: MaintenanceProductionClaimCoordinator | null = null,
  ): MaintenanceExecutionRecord | null {
    const databaseIdentity = MAINTENANCE_JOB_MANAGER_DATABASE_IDENTITIES.get(this);
    const reserveProductionNamespace = routeContract !== 'production-v2'
      && typeof databaseIdentity === 'string'
      && PRODUCTION_ROUTE_DATABASE_IDENTITIES.has(databaseIdentity);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const now = canonicalTimestamp(this.#now());
      const candidatePage = this.#db.prepare(`
        SELECT j.* FROM maintenance_job j
        JOIN maintenance_outbox o ON o.job_run_id=j.run_id
        WHERE j.status='queued' AND j.executor_route='legacy' AND j.cancel_requested_at IS NULL
          AND o.delivered_at IS NULL AND o.available_at<=?
          AND (?=0 OR NOT (
            j.task_kind=? AND j.policy_version=? AND j.trigger_kind=?
          ))
          AND (? IS NULL OR j.run_id=?)
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_job active
            WHERE active.session_id=j.session_id AND active.status='running'
          )
          AND (? IS NULL OR j.created_at>? OR (j.created_at=? AND j.run_id>?))
        ORDER BY j.created_at,j.run_id LIMIT 100
      `);
      let cursorCreatedAt: string | null = null;
      let cursorRunId: string | null = null;
      let row: SqlRow | undefined;
      let route: MaintenanceExecutorRoute | undefined;
      let productionDecision: Readonly<MaintenanceProductionQueuedRouteDecision> | null = null;
      for (;;) {
        const candidates = candidatePage.all(
          now,
          reserveProductionNamespace ? 1 : 0,
          AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.taskKind,
          AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion,
          AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.trigger,
          targetRunId, targetRunId,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorRunId,
        ) as SqlRow[];
        for (const candidate of candidates) {
          let productionCoordinatorEntered = false;
          try {
            if (!isMaintenanceTaskKind(candidate.task_kind)) continue;
            if (reserveProductionNamespace
              && isMaintenanceProductionRouteNamespaceRow(candidate)) continue;
            const allowed: unknown = canClaim(requireOpaque(candidate.session_id, 'session_id'), candidate.task_kind);
            if (nodeTypes.isPromise(allowed)) {
              observeRejectedRoutePromise(allowed);
              continue;
            }
            if (allowed !== true) continue;
            const job = Object.freeze({ ...parseJob(candidate) });
            if (routeContract === 'production-v2'
              && isMaintenanceProductionRouteNamespaceRow(candidate)) {
              productionCoordinatorEntered = true;
              if (!productionCoordinator) {
                throw new Error('maintenance production claim coordinator invalid');
              }
              let active = true;
              let finalized = false;
              let committedExecution: MaintenanceExecutionRecord | null = null;
              const finalize: MaintenanceProductionClaimFinalize = decision => {
                if (!active || finalized) {
                  throw new Error('maintenance production claim finalize invalid');
                }
                finalized = true;
                const normalizedDecision = normalizeProductionQueuedRouteDecision(decision, job);
                if (!normalizedDecision) return null;
                committedExecution = this.#commitClaim(
                  candidate,
                  normalizedDecision.executorRoute,
                  owner,
                  leaseMs,
                  normalizedDecision,
                );
                return committedExecution;
              };
              try {
                const coordinated: unknown = productionCoordinator(job, finalize);
                if (nodeTypes.isPromise(coordinated)) {
                  observeRejectedRoutePromise(coordinated);
                }
              } catch (error) {
                // Once COMMIT succeeded, no outer fence cleanup error may hide
                // that durable fact or cause this invocation to scan/claim again.
                if (committedExecution) return committedExecution;
                throw error;
              } finally {
                active = false;
              }
              if (committedExecution) return committedExecution;
              // The reserved production candidate is exclusive. A coordinator
              // that declines or never invokes finalize grants no fallback for
              // this job, but must not starve later ordinary Legacy work.
              continue;
            }
            const selected: unknown = selectRoute(job);
            if (nodeTypes.isPromise(selected)) {
              observeRejectedRoutePromise(selected);
              continue;
            }
            const normalizedDecision = routeContract === 'production-v2'
              ? normalizeProductionQueuedRouteDecision(selected, job)
              : null;
            const selectedRoute = routeContract === 'production-v2'
              ? normalizedDecision?.executorRoute
              : selected;
            if (selectedRoute !== 'legacy' && selectedRoute !== 'agent-loop') continue;
            if (selectedRoute === 'agent-loop' && (job.taskKind !== 'rolling_summary'
              || (routeContract === 'explicit'
                && job.policyVersion
                  === AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion
                && job.trigger
                  === AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.trigger)
              || (routeContract === 'canary-v1'
                && (job.mode !== 'shadow' || job.policyVersion !== MAINTENANCE_POLICY_VERSION))
              || (routeContract === 'production-v2'
                && !matchesAgentLoopMaintenanceProductionRouteJob(job)))) continue;
            row = candidate;
            route = selectedRoute;
            productionDecision = normalizedDecision;
            break;
          } catch (error) {
            // A scoped finalize may have performed part of the Manager write
            // before storage failed. Abort the outer transaction instead of
            // swallowing that error and committing it with a later candidate.
            if (productionCoordinatorEntered) throw error;
            /* An ordinary selector/candidate failure grants no claim. */
          }
        }
        if (row || candidates.length < 100) break;
        const last = candidates[candidates.length - 1]!;
        cursorCreatedAt = canonicalTimestamp(String(last.created_at));
        cursorRunId = requireOpaque(last.run_id, 'run_id');
      }
      if (!row || !route) { this.#db.exec('COMMIT;'); return null; }
      if (reserveProductionNamespace && isMaintenanceProductionRouteNamespaceRow(row)) {
        throw new Error('maintenance production namespace claim conflict');
      }
      return this.#commitClaim(row, route, owner, leaseMs, productionDecision);
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  renewLease(runIdValue: string, ownerValue: string, leaseMs = 30_000,
    expectedExecutorRoute: MaintenanceExecutorRoute = 'legacy'): void {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const owner = requireOpaque(ownerValue, 'owner');
    const route = executorRoute(expectedExecutorRoute);
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error('leaseMs invalid');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const now = canonicalTimestamp(this.#now());
      const expires = new Date(Date.parse(now) + leaseMs).toISOString();
      const result = this.#db.prepare(`
      UPDATE maintenance_job SET updated_at=?, lease_expires_at=?
      WHERE run_id=? AND status='running' AND lease_owner_instance_id=?
        AND lease_expires_at>? AND cancel_requested_at IS NULL AND executor_route=?
      `).run(now, expires, runId, owner, now, route);
      if (result.changes !== 1) throw new Error('maintenance lease lost');
      this.#db.exec('COMMIT;');
    } catch (error) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } throw error; }
  }

  complete(input: {
    runId: string;
    owner: string;
    expectedExecutorRoute?: MaintenanceExecutorRoute;
    status: Extract<MaintenanceStatus, 'succeeded' | 'failed' | 'cancelled' | 'stale'>;
    errorCode?: string;
    budget?: BudgetSnapshot;
    proposal?: MaintenanceProposal;
    proposalContext?: MaintenanceStrictProposalContext;
    skillProposalProof?: MaintenanceMemorySkillProposalProof;
    summarySkillProof?: MaintenanceSummarySkillProposalProof;
    /** Omit only for the disabled legacy path; an explicitly absent proof is a hard failure. */
    arcSkillProof?: MaintenanceArcSkillProposalProof;
    /** Required live result, including the native no-applicable-evidence terminal. */
    npcSkillProof?: MaintenanceNpcSkillResultProof;
    npcNoop?: NpcMaintenanceNoopTerminal;
    disposition?: 'shadow' | 'committed' | 'stale';
    diff?: Record<string, unknown>;
  }): PublicMaintenanceJob {
    this.#assertOpen();
    const runId = requireOpaque(input.runId, 'runId');
    const owner = requireOpaque(input.owner, 'owner');
    const route = executorRoute(input.expectedExecutorRoute === undefined ? 'legacy' : input.expectedExecutorRoute);
    const arcSkillRequired = Object.hasOwn(input, 'arcSkillProof');
    const npcSkillRequired = Object.hasOwn(input, 'npcSkillProof');
    if (Object.hasOwn(input, 'npcNoop') && !npcSkillRequired) throw new Error('maintenance-npc-skill-provenance-invalid');
    // Route rejection precedes even optional proof/schema side effects. A public
    // job or matching owner string cannot borrow the other executor's lifecycle.
    const initialClaim = this.readExecution(runId);
    if (!initialClaim || initialClaim.executorRoute !== route || initialClaim.leaseOwnerInstanceId !== owner) {
      throw new Error('maintenance completion conflict');
    }
    if (route === 'agent-loop' && input.status === 'succeeded') {
      // No existing AL completion exit binds canonical artifacts/Verify to this
      // business lifecycle. A matching owner or proposed body is not that grant.
      throw new Error('maintenance-agent-loop-completion-unbound');
    }
    if (route !== 'legacy' && (input.skillProposalProof !== undefined || input.summarySkillProof !== undefined
      || arcSkillRequired || npcSkillRequired)) {
      throw new Error('maintenance Skill proof executor route invalid');
    }
    if (input.status === 'failed' && !input.errorCode) throw new Error('failed requires errorCode');
    if (input.status !== 'failed' && input.errorCode) throw new Error('errorCode only valid for failed');
    const errorCode = input.errorCode === undefined ? null : requireOpaque(input.errorCode, 'errorCode', 80);
    const budgetJson = input.budget === undefined ? null : JSON.stringify(input.budget);
    let digest: string | null = null;
    let disposition: string | null = null;
    let diffJson: string | null = null;
    let proposalJson: string | null = null;
    let contextJson: string | null = null;
    if (input.proposal !== undefined) {
      const canonical = JSON.stringify(input.proposal);
      digest = createHash('sha256').update(canonical).digest('hex');
      disposition = input.disposition ?? 'shadow';
      diffJson = JSON.stringify(requireJsonObject(input.diff ?? {}, 'diff', MAX_DIFF_BYTES));
      proposalJson = JSON.stringify(requireJsonObject(input.proposal, 'proposal', MAX_PROPOSAL_BYTES));
      if (input.proposalContext !== undefined) {
        contextJson = JSON.stringify(requireJsonObject(input.proposalContext, 'proposalContext', MAX_CONTEXT_BYTES));
      }
    }
    const now = canonicalTimestamp(this.#now());
    if (npcSkillRequired && (input.status !== 'succeeded' || !isMaintenanceNpcSkillResultProof(input.npcSkillProof)
      || initialClaim.cancelRequestedAt !== undefined || initialClaim.leaseExpiresAt <= now
      || input.npcSkillProof.validatedAt > now
      || !this.#npcProofMatchesClaim(input.npcSkillProof, initialClaim.job, digest, input.proposalContext,
        input.proposal, input.npcNoop, input.disposition)
      || input.npcSkillProof.terminalKind === 'noop' && input.diff !== undefined)) {
      throw new Error('maintenance-npc-skill-provenance-invalid');
    }
    if (arcSkillRequired && (input.status !== 'succeeded' || disposition !== 'shadow'
      || input.proposal?.taskKind !== 'branch_index' || !isMaintenanceArcSkillProposalProof(input.arcSkillProof)
      || initialClaim.job.mode !== 'shadow' || initialClaim.job.taskKind !== 'branch_index'
      || initialClaim.cancelRequestedAt !== undefined || initialClaim.leaseExpiresAt <= now
      || input.arcSkillProof.validatedAt > now
      || !this.#arcProofMatchesClaim(input.arcSkillProof, initialClaim.job, digest, input.proposalContext))) {
      throw new Error('maintenance-arc-skill-provenance-invalid');
    }
    let skillOutbox: MaintenanceMemorySkillOutbox | null = null;
    let summarySource: MaintenanceSummarySkillSourceStore | null = null;
    if (input.summarySkillProof !== undefined) {
      try {
        const claim = this.readExecution(runId);
        if (input.status !== 'succeeded' || !claim || claim.job.taskKind !== 'rolling_summary'
          || claim.job.status !== 'running' || claim.leaseOwnerInstanceId !== owner
          || claim.cancelRequestedAt !== undefined || claim.leaseExpiresAt <= now
          || !isMaintenanceSummarySkillProposalProof(input.summarySkillProof)
          || !this.#summaryProofMatchesClaim(input.summarySkillProof, claim.job, digest, input.proposalContext)) {
          throw new Error('maintenance summary provenance claim invalid');
        }
        summarySource = new MaintenanceSummarySkillSourceStore(this.#db, (id) => this.#readSkillJob(id));
      } catch { this.#reportSkillProvenanceFailure(); }
    }
    if (input.skillProposalProof !== undefined) {
      try {
        const claim = this.readExecution(runId);
        if (input.status !== 'succeeded' || !claim || claim.job.taskKind !== 'memory_consolidation'
          || claim.job.status !== 'running' || claim.leaseOwnerInstanceId !== owner
          || claim.cancelRequestedAt !== undefined || claim.leaseExpiresAt <= now
          || !isMaintenanceMemorySkillProposalProof(input.skillProposalProof)
          || !this.#skillProofMatchesClaim(input.skillProposalProof, claim.job, digest)) {
          throw new Error('maintenance skill provenance claim invalid');
        }
        skillOutbox = new MaintenanceMemorySkillOutbox(this.#db, (id) => this.#readSkillJob(id));
      } catch { this.#reportSkillProvenanceFailure(); }
    }
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const routeClaim = this.readExecution(runId);
      if (!routeClaim || routeClaim.executorRoute !== route || routeClaim.leaseOwnerInstanceId !== owner) {
        throw new Error('maintenance completion conflict');
      }
      if (arcSkillRequired && (!isMaintenanceArcSkillProposalProof(input.arcSkillProof)
        || routeClaim.job.mode !== 'shadow' || routeClaim.job.taskKind !== 'branch_index'
        || routeClaim.cancelRequestedAt !== undefined
        || routeClaim.leaseExpiresAt <= canonicalTimestamp(this.#now())
        || !this.#arcProofMatchesClaim(input.arcSkillProof, routeClaim.job, digest, input.proposalContext))) {
        throw new Error('maintenance-arc-skill-provenance-invalid');
      }
      if (npcSkillRequired && (!isMaintenanceNpcSkillResultProof(input.npcSkillProof)
        || routeClaim.cancelRequestedAt !== undefined || routeClaim.leaseExpiresAt <= canonicalTimestamp(this.#now())
        || !this.#npcProofMatchesClaim(input.npcSkillProof, routeClaim.job, digest, input.proposalContext,
          input.proposal, input.npcNoop, input.disposition))) {
        throw new Error('maintenance-npc-skill-provenance-invalid');
      }
      if (skillOutbox && input.skillProposalProof) {
        const current = this.readExecution(runId);
        if (!current || current.job.status !== 'running' || current.leaseOwnerInstanceId !== owner
          || current.cancelRequestedAt !== undefined || current.leaseExpiresAt <= canonicalTimestamp(this.#now())
          || !this.#skillProofMatchesClaim(input.skillProposalProof, current.job, digest)) {
          skillOutbox = null;
          this.#reportSkillProvenanceFailure();
        }
      }
      if (summarySource && input.summarySkillProof) {
        const current = this.readExecution(runId);
        if (!current || current.job.status !== 'running' || current.leaseOwnerInstanceId !== owner
          || current.cancelRequestedAt !== undefined || current.leaseExpiresAt <= canonicalTimestamp(this.#now())
          || !this.#summaryProofMatchesClaim(input.summarySkillProof, current.job, digest, input.proposalContext)) {
          summarySource = null;
          this.#reportSkillProvenanceFailure();
        }
      }
      const result = this.#db.prepare(`
        UPDATE maintenance_job SET status=?,updated_at=?,finished_at=?,error_code=?,budget_json=?,
          proposal_digest=?,proposal_disposition=?,diff_json=?,
          lease_owner_instance_id=NULL,lease_expires_at=NULL
        WHERE run_id=? AND status='running' AND lease_owner_instance_id=? AND executor_route=?
      `).run(input.status, now, now, errorCode, budgetJson, digest, disposition, diffJson, runId, owner, route);
      if (result.changes !== 1) throw new Error('maintenance completion conflict');
      this.#db.prepare('UPDATE maintenance_outbox SET delivered_at=? WHERE job_run_id=? AND delivered_at IS NULL')
        .run(now, runId);
      const row = this.#getRow(runId);
      if (!row) throw new Error('maintenance completed job missing');
      const pendingProposal = input.proposal;
      if (input.status === 'succeeded' && disposition === 'shadow' && proposalJson && contextJson
        && pendingProposal !== undefined
        && ['memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state']
          .includes(String(pendingProposal.taskKind))) {
        const proposalId = `mprop_${runId.slice('mjob_'.length)}`;
        this.#db.prepare(`
          INSERT INTO maintenance_pending_proposal(
            proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,
            proposal_json,context_json,diff_json,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)
          ON CONFLICT(job_run_id) DO NOTHING
        `).run(proposalId, runId, String(row.session_id), pendingProposal.taskKind,
          String(row.source_revision), `sha256:${digest}`, proposalJson, contextJson, diffJson, now, now);
      }
      const completed = parseJob(row);
      if (arcSkillRequired) {
        // Required evidence shares the original completion and pending-proposal transaction.
        // A schema/write/readback failure rolls back all three; there is no optional savepoint.
        const source = new MaintenanceArcSkillSourceStore(this.#db,
          (id) => this.#readArcSkillJob(id), (id) => this.getPendingProposal(id));
        source.insert(completed, input.arcSkillProof!, this.getProposalForJob(runId));
      }
      if (npcSkillRequired) {
        const source = new MaintenanceNpcSkillSourceStore(this.#db,
          (id) => this.#readNpcSkillJob(id), (id) => this.getProposalForJob(id));
        source.insert(completed, input.npcSkillProof!, input.npcNoop);
      }
      if (summarySource && input.summarySkillProof && input.proposal && input.proposalContext) {
        this.#db.exec('SAVEPOINT summary_skill_provenance;');
        try {
          const original = summarySource.read(runId);
          if (original) {
            if (original.record.status !== 'prepared' || original.source.proof.proofDigest
              !== input.summarySkillProof.proofDigest || disposition !== 'committed') {
              throw new Error('maintenance-summary-direct-completion-mismatch');
            }
          } else if (disposition === 'shadow') {
            summarySource.insert(completed, input.summarySkillProof, createMaintenanceSummarySkillProposalRecord(
              completed, input.proposal, input.proposalContext, input.summarySkillProof, 'pending', now,
            ));
          } else {
            throw new Error('maintenance-summary-direct-preparation-missing');
          }
          this.#db.exec('RELEASE summary_skill_provenance;');
        } catch {
          this.#db.exec('ROLLBACK TO summary_skill_provenance; RELEASE summary_skill_provenance;');
          this.#reportSkillProvenanceFailure();
        }
      }
      if (skillOutbox && input.skillProposalProof) {
        this.#db.exec('SAVEPOINT memory_skill_provenance;');
        try {
          skillOutbox.enqueue(completed, input.skillProposalProof, this.getProposalForJob(runId)?.proposalId);
          this.#db.exec('RELEASE memory_skill_provenance;');
        } catch {
          // Ordinary sidecar failures discard only evidence, never the already valid pending proposal.
          this.#db.exec('ROLLBACK TO memory_skill_provenance; RELEASE memory_skill_provenance;');
          this.#reportSkillProvenanceFailure();
        }
      }
      this.#db.exec('COMMIT;');
      return completed;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  requestCancel(runIdValue: string): { job: PublicMaintenanceJob; shouldAbort: boolean } {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#getRow(runId);
      if (!row) throw new Error('maintenance job not found');
      const job = parseJob(row);
      if (!['queued', 'running'].includes(job.status)) {
        this.#db.exec('COMMIT;'); return { job, shouldAbort: false };
      }
      const now = canonicalTimestamp(this.#now());
      if (job.status === 'queued') {
        this.#db.prepare(`
        UPDATE maintenance_job SET status='cancelled',cancel_requested_at=?,updated_at=?,finished_at=?
        WHERE run_id=? AND status='queued'
        `).run(now, now, now, runId);
        this.#db.prepare('UPDATE maintenance_outbox SET delivered_at=? WHERE job_run_id=?').run(now, runId);
      } else {
        this.#db.prepare(`
        UPDATE maintenance_job SET cancel_requested_at=?,updated_at=? WHERE run_id=? AND status='running'
        `).run(now, now, runId);
      }
      const requested = this.get(runId)!;
      this.#db.exec('COMMIT;');
      return { job: requested, shouldAbort: job.status === 'running' };
    } catch (error) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } throw error; }
  }

  /**
   * Recover leases whose executor cannot prove completion.  The job records
   * are returned so non-authoritative observers can repair their own ledgers
   * without querying private tables or guessing which rows changed.
   */
  recoverExpiredJobs(): PublicMaintenanceJob[] {
    this.#assertOpen();
    const now = canonicalTimestamp(this.#now());
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const candidates = (this.#db.prepare(`
        SELECT run_id FROM maintenance_job
        WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        ORDER BY run_id
      `).all(now) as SqlRow[]).map((row) => requireOpaque(row.run_id, 'runId'));
      if (candidates.length === 0) {
        this.#db.exec('COMMIT;');
        return [];
      }
      const update = this.#db.prepare(`
        UPDATE maintenance_job SET status='failed',updated_at=?,finished_at=?,
          error_code='restart-uncertain-no-replay',lease_owner_instance_id=NULL,lease_expires_at=NULL
        WHERE run_id=? AND status='running'
      `);
      const outbox = this.#db.prepare(`
        UPDATE maintenance_outbox SET delivered_at=?
        WHERE job_run_id=? AND delivered_at IS NULL
      `);
      const recovered: PublicMaintenanceJob[] = [];
      for (const runId of candidates) {
        if (update.run(now, now, runId).changes !== 1) {
          throw new Error('maintenance recovery conflict');
        }
        outbox.run(now, runId);
        const row = this.#getRow(runId);
        if (!row) throw new Error('maintenance recovered job missing');
        recovered.push(parseJob(row));
      }
      this.#db.exec('COMMIT;');
      return recovered;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  recoverExpired(): number {
    return this.recoverExpiredJobs().length;
  }

  get(runIdValue: string): PublicMaintenanceJob | null {
    this.#assertOpen();
    const row = this.#getRow(requireOpaque(runIdValue, 'runId'));
    return row ? parseJob(row) : null;
  }

  /** Current server-local claim metadata. A public/cached job is not lease ownership. */
  readExecution(runIdValue: string): MaintenanceExecutionRecord | null {
    this.#assertOpen();
    const row = this.#getRow(requireOpaque(runIdValue, 'runId'));
    if (!row || row.status !== 'running' || row.lease_owner_instance_id == null || row.lease_expires_at == null) return null;
    return Object.freeze({ job: Object.freeze(parseJob(row)),
      executorRoute: executorRoute(row.executor_route),
      leaseOwnerInstanceId: requireOpaque(row.lease_owner_instance_id, 'lease_owner_instance_id'),
      leaseExpiresAt: canonicalTimestamp(String(row.lease_expires_at)),
      ...(row.cancel_requested_at == null ? {} : { cancelRequestedAt: canonicalTimestamp(String(row.cancel_requested_at)) }),
    });
  }

  /** Retained Summary apply source identity only; never a live claim or execution grant. */
  readAgentLoopSummaryApplyOutcomeJob(runIdValue: string): PublicMaintenanceJob | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-summary-apply-outcome-storage-invalid');
    const row = this.#getRow(requireOpaque(runIdValue, 'runId'));
    if (!row || row.task_kind !== 'rolling_summary' || row.mode !== 'apply' || row.executor_route !== 'agent-loop') return null;
    return Object.freeze(parseJob(row));
  }

  readProductionRouteReceipt(
    runIdValue: string,
  ): Readonly<MaintenanceProductionRouteReceipt> | null {
    this.#assertOpen();
    return readMaintenanceProductionRouteReceipt(this.#db, runIdValue);
  }

  listProductionRouteReceipts(
    sessionIdValue: string,
    limit = 50,
  ): readonly Readonly<MaintenanceProductionRouteReceipt>[] {
    this.#assertOpen();
    return listMaintenanceProductionRouteReceipts(this.#db, sessionIdValue, limit);
  }

  list(sessionIdValue: string, limit = 50): PublicMaintenanceJob[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit invalid');
    return (this.#db.prepare(`
      SELECT * FROM maintenance_job WHERE session_id=? ORDER BY created_at DESC,run_id DESC LIMIT ?
    `).all(sessionId, limit) as SqlRow[]).map(parseJob);
  }

  /**
   * Exact input set for rolling admission budgets. This intentionally has no
   * row-count limit: active work plus every job that can affect either the
   * 24-hour attempt cap or the shorter scheduling reservation is selected by
   * time/status predicates instead of an arbitrary newest-N page.
   */
  listAdmissionBudgetWindow(sessionIdValue: string, nowMs: number): PublicMaintenanceJob[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs invalid');
    const windowStart = new Date(nowMs - ADMISSION_BUDGET_WINDOW_MS).toISOString();
    return (this.#db.prepare(`
      SELECT * FROM maintenance_job
      WHERE session_id=? AND (
        status IN ('queued','running')
        OR updated_at>?
      )
      ORDER BY created_at DESC,run_id DESC
    `).all(sessionId, windowStart) as SqlRow[]).map(parseJob);
  }

  listActiveForSession(sessionIdValue: string): PublicMaintenanceJob[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    return (this.#db.prepare(
      "SELECT * FROM maintenance_job WHERE session_id=? AND status IN ('queued','running') ORDER BY created_at,run_id",
    ).all(sessionId) as SqlRow[]).map(parseJob);
  }

  /**
   * Host startup repair only: scan the exact pristine p14 namespace in fixed
   * keyset pages. This grants no claim or route and deliberately ignores
   * availability time so a durable future job also receives its projection.
   */
  scanAgentLoopProductionProjectionRecovery(
    cursor: MaintenanceProductionProjectionRecoveryCursor | null = null,
  ): MaintenanceProductionProjectionRecoveryPage {
    this.#assertOpen();
    let cursorCreatedAt: string | null = null;
    let cursorRunId: string | null = null;
    if (cursor !== null) {
      if (typeof cursor !== 'object' || nodeTypes.isProxy(cursor)
        || Object.getPrototypeOf(cursor) !== Object.prototype) {
        throw new Error('maintenance production projection recovery cursor invalid');
      }
      const descriptors = Object.getOwnPropertyDescriptors(cursor);
      if (Reflect.ownKeys(descriptors).length !== 2
        || !Object.hasOwn(descriptors.createdAt ?? {}, 'value')
        || !Object.hasOwn(descriptors.runId ?? {}, 'value')) {
        throw new Error('maintenance production projection recovery cursor invalid');
      }
      cursorCreatedAt = canonicalTimestamp(String(descriptors.createdAt!.value));
      cursorRunId = requireOpaque(descriptors.runId!.value, 'runId');
    }
    const admission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
    const rows = this.#db.prepare(`
      SELECT * FROM maintenance_job
      WHERE status='queued' AND attempt=0 AND executor_route='legacy'
        AND cancel_requested_at IS NULL
        AND task_kind=? AND policy_version=? AND trigger_kind=? AND mode=?
        AND parent_run_id IS NOT NULL
        AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL
        AND budget_json IS NULL AND proposal_digest IS NULL
        AND proposal_disposition IS NULL AND diff_json IS NULL
        AND created_at=updated_at
        AND (? IS NULL OR created_at>? OR (created_at=? AND run_id>?))
      ORDER BY created_at,run_id LIMIT ?
    `).all(
      admission.taskKind,
      admission.policyVersion,
      admission.trigger,
      admission.mode,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorRunId,
      MAINTENANCE_PRODUCTION_PROJECTION_RECOVERY_PAGE_SIZE + 1,
    ) as SqlRow[];
    const pageRows = rows.slice(0, MAINTENANCE_PRODUCTION_PROJECTION_RECOVERY_PAGE_SIZE);
    const jobs: PublicMaintenanceJob[] = [];
    for (const row of pageRows) {
      try {
        const job = parseJob(row);
        if (matchesAgentLoopMaintenanceProductionRouteJob(job)) jobs.push(Object.freeze(job));
      } catch {
        // Advance past malformed reserved rows; the production dispatcher owns
        // their fail-closed handling and startup repair must not get stuck.
      }
    }
    const last = pageRows.at(-1);
    const nextCursor = rows.length > MAINTENANCE_PRODUCTION_PROJECTION_RECOVERY_PAGE_SIZE && last
      ? Object.freeze({
          createdAt: canonicalTimestamp(String(last.created_at)),
          runId: requireOpaque(last.run_id, 'run_id'),
        })
      : null;
    return Object.freeze({
      jobs: Object.freeze(jobs),
      nextCursor,
    });
  }

  deleteSession(sessionIdValue: string): void {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      this.#db.prepare('DELETE FROM maintenance_job WHERE session_id=?').run(sessionId);
      this.#db.prepare('DELETE FROM maintenance_session_settings WHERE session_id=?').run(sessionId);
      this.#db.exec('COMMIT;');
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ }
      throw error;
    }
  }

  listPendingProposals(sessionIdValue: string, limit = 20): MaintenancePendingProposalSummary[] {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit invalid');
    return (this.#db.prepare(`
      SELECT * FROM maintenance_pending_proposal
      WHERE session_id=? AND status<>'prepared' ORDER BY created_at DESC,proposal_id DESC LIMIT ?
    `).all(sessionId, limit) as SqlRow[]).map((row) => proposalSummary(parseProposalRow(row)));
  }

  /** Historical request proof linked to the current original queue state, never a new approval grant. */
  readArcSkillProvenance(runIdValue: string): MaintenanceArcSkillSourceEntry | null {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const ownsTransaction = !this.#db.isTransaction;
    if (ownsTransaction) this.#db.exec('BEGIN;');
    try {
      const entry = MaintenanceArcSkillSourceStore.openExisting(this.#db,
        (id) => this.#readArcSkillJob(id), (id) => this.getPendingProposal(id))?.read(runId) ?? null;
      if (ownsTransaction) this.#db.exec('COMMIT;');
      return entry;
    } catch (error) {
      if (ownsTransaction) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } }
      throw error;
    }
  }

  /** Committed original Arc source and proposal in one Manager read snapshot. */
  readArcCommitSource(runId: string): Readonly<{
    source: MaintenanceArcSkillSourceEntry; proposal: MaintenancePendingProposalRecord;
  }> | null {
    this.#assertOpen();
    if (this.#db.isTransaction) throw new Error('arc-commit-source-uncommitted-read');
    this.#db.exec('BEGIN;');
    try {
      const source = this.readArcSkillProvenance(runId);
      if (!source) return null;
      const proposal = this.getPendingProposal(source.record.proposalId);
      if (!proposal) throw new Error('arc-commit-source-proposal-missing');
      return Object.freeze({ source, proposal });
    } finally { if (this.#db.isTransaction) this.#db.exec('ROLLBACK;'); }
  }

  /** Source rows also cover commits whose later Manager approval update failed. */
  scanArcCommitSources(sessionIdValue?: string, limit = 8, cursor = 0): Readonly<{
    entries: readonly Readonly<{ runId: string; sessionId: string }>[];
    attempted: number; nextCursor: number; hasMore: boolean;
  }> {
    this.#assertOpen();
    if (this.#db.isTransaction) throw new Error('arc-commit-source-uncommitted-read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error('arc-commit-source-page-invalid');
    const sessionId = sessionIdValue === undefined ? null : requireOpaque(sessionIdValue, 'sessionId');
    if (!this.#db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_ARC_SKILL_SOURCE_TABLE))
      return Object.freeze({ entries: [], attempted: 0, nextCursor: cursor, hasMore: false });
    inspectMaintenanceArcSkillSourceSchema(this.#db);
    const rows = this.#db.prepare(`SELECT rowid AS cursor,run_id,session_id FROM maintenance_arc_skill_source
      WHERE rowid>?${sessionId === null ? '' : ' AND session_id=?'} ORDER BY rowid LIMIT ?`)
      .all(...(sessionId === null ? [cursor, limit + 1] : [cursor, sessionId, limit + 1])) as SqlRow[];
    let nextCursor = cursor;
    const entries = rows.slice(0, limit).map(row => {
      const position = Number(row.cursor);
      if (!Number.isSafeInteger(position) || position <= nextCursor) throw new Error('arc-commit-source-cursor-invalid');
      nextCursor = position;
      return Object.freeze({ runId: requireOpaque(row.run_id, 'runId'), sessionId: requireOpaque(row.session_id, 'sessionId') });
    });
    return Object.freeze({ entries: Object.freeze(entries), attempted: entries.length, nextCursor, hasMore: rows.length > limit });
  }

  /** Committed original Npc source and proposal in one Manager read snapshot. */
  readNpcCommitSource(runId: string): Readonly<{
    source: MaintenanceNpcSkillSourceEntry; proposal: MaintenancePendingProposalRecord | null;
  }> | null {
    this.#assertOpen();
    if (this.#db.isTransaction) throw new Error('npc-commit-source-uncommitted-read');
    this.#db.exec('BEGIN;');
    try {
      const source = this.readNpcSkillProvenance(runId);
      if (!source) return null;
      if (source.record.terminalKind === 'noop') return Object.freeze({ source, proposal: null });
      const proposal = this.getPendingProposal(source.record.proposalId);
      if (!proposal) throw new Error('npc-commit-source-proposal-missing');
      return Object.freeze({ source, proposal });
    } finally { if (this.#db.isTransaction) this.#db.exec('ROLLBACK;'); }
  }

  /** Source rows also cover commits whose later Manager approval update failed. */
  scanNpcCommitSources(sessionIdValue?: string, limit = 8, cursor = 0): Readonly<{
    entries: readonly Readonly<{ runId: string; sessionId: string }>[];
    attempted: number; nextCursor: number; hasMore: boolean;
  }> {
    this.#assertOpen();
    if (this.#db.isTransaction) throw new Error('npc-commit-source-uncommitted-read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error('npc-commit-source-page-invalid');
    const sessionId = sessionIdValue === undefined ? null : requireOpaque(sessionIdValue, 'sessionId');
    if (!this.#db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_NPC_SKILL_SOURCE_TABLE))
      return Object.freeze({ entries: [], attempted: 0, nextCursor: cursor, hasMore: false });
    inspectMaintenanceNpcSkillSourceSchema(this.#db);
    const rows = this.#db.prepare(`SELECT rowid AS cursor,run_id,session_id FROM maintenance_npc_skill_source
      WHERE rowid>?${sessionId === null ? '' : ' AND session_id=?'} ORDER BY rowid LIMIT ?`)
      .all(...(sessionId === null ? [cursor, limit + 1] : [cursor, sessionId, limit + 1])) as SqlRow[];
    let nextCursor = cursor;
    const entries = rows.slice(0, limit).map(row => {
      const position = Number(row.cursor);
      if (!Number.isSafeInteger(position) || position <= nextCursor) throw new Error('npc-commit-source-cursor-invalid');
      nextCursor = position;
      return Object.freeze({ runId: requireOpaque(row.run_id, 'runId'), sessionId: requireOpaque(row.session_id, 'sessionId') });
    });
    return Object.freeze({ entries: Object.freeze(entries), attempted: entries.length, nextCursor, hasMore: rows.length > limit });
  }

  /** Reads historical NPC request proof, including typed no-op, without replaying a job or granting approval. */
  readNpcSkillProvenance(runIdValue: string): MaintenanceNpcSkillSourceEntry | null {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const ownsTransaction = !this.#db.isTransaction;
    if (ownsTransaction) this.#db.exec('BEGIN;');
    try {
      const entry = MaintenanceNpcSkillSourceStore.openExisting(this.#db,
        (id) => this.#readNpcSkillJob(id), (id) => this.getProposalForJob(id))?.read(runId) ?? null;
      if (ownsTransaction) this.#db.exec('COMMIT;');
      return entry;
    } catch (error) {
      if (ownsTransaction) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } }
      throw error;
    }
  }

  pendingMemorySkillProvenance(limit = 64): readonly MaintenanceMemorySkillOutboxEntry[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('memory-skill-outbox-limit-invalid');
    return MaintenanceMemorySkillOutbox.openExisting(this.#db, (id) => this.#readSkillJob(id))?.pending(limit) ?? [];
  }

  scanMemorySkillProvenance(limit = 64, cursor = 0): MaintenanceMemorySkillOutboxScan {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('memory-skill-outbox-limit-invalid');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('memory-skill-outbox-cursor-invalid');
    return MaintenanceMemorySkillOutbox.openExisting(this.#db, (id) => this.#readSkillJob(id))?.scan(limit, cursor)
      ?? { entries: [], attempted: 0, failed: 0, nextCursor: 0, hasMore: false };
  }

  readMemorySkillProvenance(runIdValue: string): MaintenanceMemorySkillOutboxEntry | null {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    return MaintenanceMemorySkillOutbox.openExisting(this.#db, (id) => this.#readSkillJob(id))?.read(runId) ?? null;
  }

  scanAllMemorySkillProvenance(limit = 64, cursor = 0): MaintenanceMemorySkillOutboxScan {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('memory-skill-outbox-limit-invalid');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('memory-skill-outbox-cursor-invalid');
    return MaintenanceMemorySkillOutbox.openExisting(this.#db, (id) => this.#readSkillJob(id))?.scanAll(limit, cursor)
      ?? { entries: [], attempted: 0, failed: 0, nextCursor: 0, hasMore: false };
  }

  acknowledgeMemorySkillProvenance(entry: MaintenanceMemorySkillOutboxEntry): void {
    this.#assertOpen();
    const outbox = MaintenanceMemorySkillOutbox.openExisting(this.#db, (id) => this.#readSkillJob(id));
    if (!outbox) throw new Error('maintenance skill provenance missing');
    outbox.acknowledge(entry, canonicalTimestamp(this.#now()));
  }

  getPendingProposal(proposalIdValue: string): MaintenancePendingProposalRecord | null {
    this.#assertOpen();
    const proposalId = requireOpaque(proposalIdValue, 'proposalId');
    const row = this.#db.prepare("SELECT * FROM maintenance_pending_proposal WHERE proposal_id=? AND status<>'prepared'")
      .get(proposalId) as SqlRow | undefined;
    return row ? parseProposalRow(row) : null;
  }

  /** Original committed rejection history only. Cursor counts examined rows, including corrupt records. */
  scanRejectedProposals(sessionIdValue?: string, limit = 64, cursor = 0): Readonly<{
    entries: readonly MaintenancePendingProposalRecord[];
    attempted: number; failed: number; nextCursor: number; hasMore: boolean;
  }> {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-rejection-uncommitted-read');
    const sessionId = sessionIdValue === undefined ? null : requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256
      || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('maintenance-rejection-scan-invalid');
    const rows = this.#db.prepare(`
      SELECT rowid AS rejection_cursor,* FROM maintenance_pending_proposal
      WHERE status='rejected' AND rowid>?${sessionId === null ? '' : ' AND session_id=?'}
      ORDER BY rowid LIMIT ?
    `).all(...(sessionId === null ? [cursor, limit + 1] : [cursor, sessionId, limit + 1])) as SqlRow[];
    const entries: MaintenancePendingProposalRecord[] = [];
    let failed = 0, nextCursor = cursor;
    for (const row of rows.slice(0, limit)) {
      const position = Number(row.rejection_cursor);
      if (!Number.isSafeInteger(position) || position <= nextCursor) throw new Error('maintenance-rejection-cursor-invalid');
      nextCursor = position;
      try { entries.push(parseProposalRow(row)); } catch { failed += 1; }
    }
    return Object.freeze({ entries: Object.freeze(entries), attempted: Math.min(rows.length, limit),
      failed, nextCursor, hasMore: rows.length > limit });
  }

  /** Snapshot of original rejection and producer, never an uncommitted control transition. */
  readRejectedProposalEvidence(proposalIdValue: string): Readonly<{
    proposal: MaintenancePendingProposalRecord; job: PublicMaintenanceJob;
  }> | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-rejection-uncommitted-read');
    const proposalId = requireOpaque(proposalIdValue, 'proposalId');
    this.#db.exec('BEGIN;');
    try {
      const proposal = this.getPendingProposal(proposalId);
      if (!proposal || proposal.status !== 'rejected') return null;
      const job = this.get(proposal.jobRunId);
      return job ? Object.freeze({ proposal, job }) : null;
    } finally { if (this.#db.isTransaction) this.#db.exec('ROLLBACK;'); }
  }

  getProposalForJob(runIdValue: string): MaintenancePendingProposalRecord | null {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const row = this.#db.prepare("SELECT * FROM maintenance_pending_proposal WHERE job_run_id=? AND status<>'prepared'")
      .get(runId) as SqlRow | undefined;
    return row ? parseProposalRow(row) : null;
  }

  /** Applied approval history and retained original approvals after rollback. Failed rows still advance the cursor. */
  scanApprovedProposals(sessionIdValue?: string, limit = 64, cursor = 0): Readonly<{
    entries: readonly MaintenancePendingProposalRecord[];
    attempted: number; failed: number; nextCursor: number; hasMore: boolean;
  }> {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-approval-uncommitted-read');
    const sessionId = sessionIdValue === undefined ? null : requireOpaque(sessionIdValue, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256
      || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('maintenance-approval-scan-invalid');
    const rows = this.#db.prepare(`
      SELECT rowid AS approval_cursor,* FROM maintenance_pending_proposal
      WHERE status IN ('applied','rolled_back') AND rowid>?${sessionId === null ? '' : ' AND session_id=?'}
      ORDER BY rowid LIMIT ?
    `).all(...(sessionId === null ? [cursor, limit + 1] : [cursor, sessionId, limit + 1])) as SqlRow[];
    const entries: MaintenancePendingProposalRecord[] = [];
    let failed = 0, nextCursor = cursor;
    for (const row of rows.slice(0, limit)) {
      const position = Number(row.approval_cursor);
      if (!Number.isSafeInteger(position) || position <= nextCursor) throw new Error('maintenance-approval-cursor-invalid');
      nextCursor = position;
      try { entries.push(parseProposalRow(row)); } catch { failed += 1; }
    }
    return Object.freeze({ entries: Object.freeze(entries), attempted: Math.min(rows.length, limit),
      failed, nextCursor, hasMore: rows.length > limit });
  }

  /** Original Manager snapshot only; a rollback with no retained approval remains unknown. */
  readApprovedProposalEvidence(proposalIdValue: string): Readonly<{
    proposal: MaintenancePendingProposalRecord; job: PublicMaintenanceJob;
  }> | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-approval-uncommitted-read');
    const proposalId = requireOpaque(proposalIdValue, 'proposalId');
    this.#db.exec('BEGIN;');
    try {
      const proposal = this.getPendingProposal(proposalId);
      if (!proposal || !['applied', 'rolled_back'].includes(proposal.status)) return null;
      const job = this.get(proposal.jobRunId);
      return job ? Object.freeze({ proposal, job }) : null;
    } finally { if (this.#db.isTransaction) this.#db.exec('ROLLBACK;'); }
  }

  /** Host-only storage primitive. The callback must assert the real source under
   * this original Manager writer lock. This is not an AL Action/proof producer. */
  stageAgentLoopShadowProposal(input: {
    runId: string; owner: string; expectedAttempt: number; proposal: MaintenanceProposal;
    proposalContext: MaintenanceStrictProposalContext;
  }, authorizeCommit: () => void): MaintenanceAgentLoopShadowProposalRecord {
    this.#assertOpen();
    let selected: { runId: string; owner: string; expectedAttempt: number;
      body: ReturnType<typeof normalizeMaintenanceAgentLoopShadowProposal> };
    try {
      if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
      const keys = Reflect.ownKeys(input), expected = ['runId', 'owner', 'expectedAttempt', 'proposal', 'proposalContext'];
      if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
        || !Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) throw new Error();
      selected = { runId: requireOpaque(input.runId, 'runId'), owner: requireOpaque(input.owner, 'owner'),
        expectedAttempt: input.expectedAttempt,
        body: normalizeMaintenanceAgentLoopShadowProposal({ proposal: input.proposal, proposalContext: input.proposalContext }) };
    } catch { throw new Error('maintenance-agent-loop-shadow-proposal-input-invalid'); }
    if (typeof authorizeCommit !== 'function') throw new Error('maintenance-agent-loop-shadow-proposal-authorization-invalid');
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-shadow-proposal-storage-invalid');
    const { runId, owner, expectedAttempt, body } = selected;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const initial = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      if (body.context.sessionId !== initial.execution.job.sessionId
        || body.context.sourceRevision !== initial.execution.job.sourceRevision) {
        throw new Error('maintenance-agent-loop-shadow-proposal-input-invalid');
      }
      assertMaintenanceAgentLoopShadowSource(authorizeCommit);
      const fresh = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      if (fresh.now < initial.now || JSON.stringify(fresh.execution.job) !== JSON.stringify(initial.execution.job)) {
        throw new Error('maintenance-agent-loop-shadow-proposal-claim-invalid');
      }
      const existing = this.#db.prepare('SELECT * FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId) as SqlRow | undefined;
      let result: MaintenanceAgentLoopShadowProposalRecord;
      if (existing) {
        const prior = this.#readAgentLoopShadowProposal(runId);
        if (!prior || prior.preparation.ownerInstanceId !== owner || prior.preparation.attempt !== expectedAttempt
          || prior.proposalDigest !== body.proposalDigest || prior.preparation.proposalContextDigest !== body.proposalContextDigest
          || JSON.stringify(prior.proposal) !== JSON.stringify(body.proposal)
          || JSON.stringify(prior.context) !== JSON.stringify(body.context)) {
          throw new Error('maintenance-agent-loop-shadow-proposal-conflict');
        }
        result = prior;
      } else {
        const preparation = createMaintenanceAgentLoopShadowProposalPreparation({ job: fresh.execution.job,
          ownerInstanceId: owner, createdAt: fresh.now, proposalDigest: body.proposalDigest,
          proposalContextDigest: body.proposalContextDigest });
        this.#db.prepare(`INSERT INTO maintenance_pending_proposal(
          proposal_id,job_run_id,session_id,task_kind,source_revision,proposal_digest,proposal_json,context_json,
          diff_json,status,revision,created_at,updated_at,agent_loop_preparation_json
        ) VALUES(?,?,?,'rolling_summary',?,?,?,?,?,'prepared',1,?,?,?)`).run(
          `mprop_${runId.slice(5)}`, runId, fresh.execution.job.sessionId, fresh.execution.job.sourceRevision,
          body.proposalDigest, JSON.stringify(body.proposal), JSON.stringify(body.context), JSON.stringify(body.diff),
          fresh.now, fresh.now, JSON.stringify(preparation));
        const inserted = this.#readAgentLoopShadowProposal(runId);
        if (!inserted) throw new Error('maintenance-agent-loop-shadow-proposal-storage-invalid');
        result = inserted;
      }
      // A second read-only assertion covers the actual prepared insert/readback,
      // not just an earlier intention to store it. Any failure rolls it back.
      assertMaintenanceAgentLoopShadowSource(authorizeCommit);
      const committedClaim = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      if (committedClaim.now < fresh.now
        || JSON.stringify(committedClaim.execution.job) !== JSON.stringify(initial.execution.job)) {
        throw new Error('maintenance-agent-loop-shadow-proposal-claim-invalid');
      }
      this.#db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve the original storage failure */ }
      throw error;
    }
  }

  /** Private-server canonical prepared body readback. Storage origin is never
   * AL Action provenance or an execution/completion authorization. */
  readAgentLoopShadowProposal(runIdValue: string): MaintenanceAgentLoopShadowProposalRecord | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-shadow-proposal-storage-invalid');
    return this.#readAgentLoopShadowProposal(requireOpaque(runIdValue, 'runId'));
  }

  #readAgentLoopShadowProposal(runId: string): MaintenanceAgentLoopShadowProposalRecord | null {
    const row = this.#db.prepare("SELECT * FROM maintenance_pending_proposal WHERE job_run_id=? AND status='prepared'")
      .get(runId) as SqlRow | undefined;
    if (!row) return null;
    try {
      const jobRow = this.#getRow(runId);
      if (!jobRow || jobRow.executor_route !== 'agent-loop'
        || typeof row.proposal_json !== 'string' || Buffer.byteLength(row.proposal_json, 'utf8') > MAX_PROPOSAL_BYTES
        || typeof row.context_json !== 'string' || Buffer.byteLength(row.context_json, 'utf8') > MAX_CONTEXT_BYTES
        || row.agent_loop_publication_json !== null || typeof row.agent_loop_preparation_json !== 'string'
        || Buffer.byteLength(row.agent_loop_preparation_json, 'utf8') > 8192) throw new Error();
      const job = parseJob(jobRow);
      const body = normalizeMaintenanceAgentLoopShadowProposal({ proposal: JSON.parse(row.proposal_json),
        proposalContext: JSON.parse(row.context_json) });
      const createdAt = canonicalTimestamp(String(row.created_at));
      const preparation = parseMaintenanceAgentLoopShadowProposalPreparation(JSON.parse(row.agent_loop_preparation_json),
        { job, createdAt, proposalDigest: body.proposalDigest, proposalContextDigest: body.proposalContextDigest });
      if (row.proposal_id !== `mprop_${runId.slice(5)}` || row.job_run_id !== runId || row.session_id !== job.sessionId
        || row.task_kind !== 'rolling_summary' || row.source_revision !== job.sourceRevision || row.revision !== 1
        || row.updated_at !== createdAt || row.decided_at !== null || row.decision_reason !== null
        || row.receipt_json !== null || row.rollback_anchor_json !== null || row.proposal_digest !== body.proposalDigest
        || body.context.sessionId !== job.sessionId || body.context.sourceRevision !== job.sourceRevision
        || row.proposal_json !== JSON.stringify(body.proposal) || row.context_json !== JSON.stringify(body.context)
        || row.diff_json !== JSON.stringify(body.diff) || row.agent_loop_preparation_json !== JSON.stringify(preparation)) throw new Error();
      return Object.freeze({ proposalId: String(row.proposal_id), jobRunId: runId, sessionId: job.sessionId,
        taskKind: 'rolling_summary', sourceRevision: job.sourceRevision, proposalDigest: body.proposalDigest,
        proposal: body.proposal, context: body.context, diff: body.diff, status: 'prepared', revision: 1,
        createdAt, updatedAt: createdAt, preparation });
    } catch { throw new Error('maintenance-agent-loop-shadow-proposal-storage-invalid'); }
  }

  /** Mechanical trusted host port, not an input-DTO capability issuer. Both
   * synchronous read-only assertions must keep the original live source valid;
   * they must not execute SQL writes or transaction control on this connection. */
  completeAgentLoopSummaryApply(input: {
    runId: string; owner: string; expectedAttempt: number; completion: MaintenanceAgentLoopSummaryApplyCompletionInput;
  }, authorizeCommit: () => void): MaintenanceAgentLoopSummaryApplyCompletionRecord {
    this.#assertOpen();
    let selected: { runId: string; owner: string; expectedAttempt: number; completion: MaintenanceAgentLoopSummaryApplyCompletionInput };
    try {
      if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
      const keys = Reflect.ownKeys(input), expected = ['runId', 'owner', 'expectedAttempt', 'completion'];
      if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')
        || !Object.getOwnPropertyDescriptor(input, key)?.enumerable)
        || !Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) throw new Error();
      selected = { runId: requireOpaque(input.runId, 'runId'), owner: requireOpaque(input.owner, 'owner'),
        expectedAttempt: input.expectedAttempt, completion: normalizeMaintenanceAgentLoopSummaryApplyCompletionInput(input.completion) };
      if (selected.completion.runId !== selected.runId || selected.completion.ownerId !== selected.owner) throw new Error();
    } catch { throw new Error('maintenance-agent-loop-summary-apply-completion-input-invalid'); }
    if (typeof authorizeCommit !== 'function') throw new Error('maintenance-agent-loop-summary-apply-completion-authorization-invalid');
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
    const { runId, owner, expectedAttempt, completion } = selected;
    const assertSource = () => {
      try { assertMaintenanceAgentLoopShadowSource(authorizeCommit); }
      catch { throw new Error('maintenance-agent-loop-summary-apply-completion-authorization-invalid'); }
    };
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const initial = this.#requireAgentLoopSummaryApplyClaim(runId, owner, expectedAttempt);
      const initialJobRow = this.#getRow(runId)!;
      const initialOutbox = this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId) as SqlRow | undefined;
      if (!initialOutbox || initialOutbox.claimed_at === null || initialOutbox.delivered_at !== null
        || initialJobRow.proposal_digest !== null || initialJobRow.proposal_disposition !== null || initialJobRow.diff_json !== null
        || this.#db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId)) {
        throw new Error('maintenance-agent-loop-summary-apply-completion-conflict');
      }
      // Validate the actual immutable claim before calling any host assertion.
      createMaintenanceAgentLoopSummaryApplyCompletionReceipt({ completion, job: initial.execution.job, completedAt: initial.now });
      const unchanged = () => {
        if (JSON.stringify(this.#getRow(runId)) !== JSON.stringify(initialJobRow)
          || JSON.stringify(this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId)) !== JSON.stringify(initialOutbox)
          || this.#db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId)) {
          throw new Error('maintenance-agent-loop-summary-apply-completion-conflict');
        }
      };
      assertSource();
      const beforeWrite = this.#requireAgentLoopSummaryApplyClaim(runId, owner, expectedAttempt);
      if (beforeWrite.now < initial.now || JSON.stringify(beforeWrite.execution) !== JSON.stringify(initial.execution)) {
        throw new Error('maintenance-agent-loop-summary-apply-completion-conflict');
      }
      unchanged();
      assertSource();
      const finalClaim = this.#requireAgentLoopSummaryApplyClaim(runId, owner, expectedAttempt);
      if (finalClaim.now < beforeWrite.now || JSON.stringify(finalClaim.execution) !== JSON.stringify(initial.execution)) {
        throw new Error('maintenance-agent-loop-summary-apply-completion-conflict');
      }
      unchanged();
      const receipt = createMaintenanceAgentLoopSummaryApplyCompletionReceipt({ completion, job: initial.execution.job, completedAt: finalClaim.now });
      const diffJson = JSON.stringify({ [MAINTENANCE_AGENT_LOOP_SUMMARY_APPLY_COMPLETION_NAMESPACE]: receipt });
      if (Buffer.byteLength(diffJson, 'utf8') > MAX_DIFF_BYTES) throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
      // No host callback or await after the final live-claim/source fence.
      const updated = this.#db.prepare(`UPDATE maintenance_job
        SET status='succeeded',updated_at=?,finished_at=?,error_code=NULL,proposal_digest=?,proposal_disposition='committed',diff_json=?,
          lease_owner_instance_id=NULL,lease_expires_at=NULL
        WHERE run_id=? AND status='running' AND executor_route='agent-loop' AND mode='apply' AND task_kind='rolling_summary'
          AND lease_owner_instance_id=? AND attempt=? AND cancel_requested_at IS NULL AND lease_expires_at>?`)
        .run(receipt.completedAt, receipt.completedAt, receipt.proposalDigest.slice(7), diffJson, runId, owner, expectedAttempt, finalClaim.now);
      if (updated.changes !== 1) throw new Error('maintenance-agent-loop-summary-apply-completion-conflict');
      const delivered = this.#db.prepare(`UPDATE maintenance_outbox SET delivered_at=? WHERE job_run_id=? AND delivered_at IS NULL`)
        .run(receipt.completedAt, runId);
      if (delivered.changes !== 1) throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
      const result = this.#readAgentLoopSummaryApplyCompletion(runId), now = canonicalTimestamp(this.#now());
      const expectedJob = { ...initialJobRow, status: 'succeeded', updated_at: receipt.completedAt, finished_at: receipt.completedAt,
        error_code: null, proposal_digest: receipt.proposalDigest.slice(7), proposal_disposition: 'committed', diff_json: diffJson,
        lease_owner_instance_id: null, lease_expires_at: null };
      if (!result || JSON.stringify(result.completion) !== JSON.stringify(receipt) || now < finalClaim.now
        || now >= initial.execution.leaseExpiresAt || !this.settings(initial.execution.job.sessionId).effectiveEnabled
        || JSON.stringify(this.#getRow(runId)) !== JSON.stringify(expectedJob)
        || JSON.stringify(this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId))
          !== JSON.stringify({ ...initialOutbox, delivered_at: receipt.completedAt })
        || this.#db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId)) {
        throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
      }
      this.#db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* success receipt, job and outbox always roll back together */ }
      throw error;
    }
  }

  /** Strict history only. Missing legacy history is not repaired or promoted. */
  readAgentLoopSummaryApplyCompletion(runIdValue: string): MaintenanceAgentLoopSummaryApplyCompletionRecord | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid');
    return this.#readAgentLoopSummaryApplyCompletion(requireOpaque(runIdValue, 'runId'));
  }

  #readAgentLoopSummaryApplyCompletion(runId: string): MaintenanceAgentLoopSummaryApplyCompletionRecord | null {
    const row = this.#getRow(runId);
    if (!row) return null;
    try {
      const job = parseJob(row), completion = summaryApplyCompletionFromRow(row, job);
      if (!completion) return null;
      const outbox = this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId) as SqlRow | undefined;
      if (!outbox || outbox.claimed_at === null || outbox.delivered_at !== completion.completedAt
        || canonicalTimestamp(String(outbox.claimed_at)) > completion.actionUpdatedAt
        || this.#db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId)) throw new Error();
      return Object.freeze({ job: Object.freeze(job), completion });
    } catch { throw new Error('maintenance-agent-loop-summary-apply-completion-storage-invalid'); }
  }

  #requireAgentLoopSummaryApplyClaim(runId: string, owner: string, expectedAttempt: number): {
    execution: MaintenanceExecutionRecord; now: string;
  } {
    const now = canonicalTimestamp(this.#now()), execution = this.readExecution(runId);
    if (!execution || execution.executorRoute !== 'agent-loop' || execution.job.taskKind !== 'rolling_summary'
      || execution.job.mode !== 'apply' || execution.job.status !== 'running' || execution.leaseOwnerInstanceId !== owner
      || execution.job.attempt !== expectedAttempt || execution.cancelRequestedAt !== undefined || execution.leaseExpiresAt <= now
      || execution.job.finishedAt !== undefined || execution.job.errorCode !== undefined || !execution.job.startedAt
      || execution.job.startedAt > now || execution.job.createdAt > execution.job.startedAt
      || !this.settings(execution.job.sessionId).effectiveEnabled) {
      throw new Error('maintenance-agent-loop-summary-apply-completion-claim-invalid');
    }
    return { execution, now };
  }

  /** Host-only business publication primitive. Opaque verifier authorization is
   * supplied by the host, never reconstructed from this input DTO or disk origin.
   * Both source assertions run while the original Manager claim is still live. */
  publishAgentLoopShadowProposal(input: {
    runId: string; owner: string; expectedAttempt: number; publication: MaintenanceAgentLoopShadowPublicationInput;
  }, authorizeCommit: (prepared: MaintenanceAgentLoopShadowProposalRecord) => void): MaintenanceAgentLoopShadowPublicationRecord {
    this.#assertOpen();
    let selected: { runId: string; owner: string; expectedAttempt: number; publication: MaintenanceAgentLoopShadowPublicationInput };
    try {
      if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
      const keys = Reflect.ownKeys(input), expected = ['runId', 'owner', 'expectedAttempt', 'publication'];
      if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
        || !Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) throw new Error();
      selected = { runId: requireOpaque(input.runId, 'runId'), owner: requireOpaque(input.owner, 'owner'),
        expectedAttempt: input.expectedAttempt, publication: normalizeMaintenanceAgentLoopShadowPublicationInput(input.publication) };
      if (selected.publication.runId !== selected.runId) throw new Error();
    } catch { throw new Error('maintenance-agent-loop-shadow-publication-input-invalid'); }
    if (typeof authorizeCommit !== 'function') throw new Error('maintenance-agent-loop-shadow-publication-authorization-invalid');
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
    const { runId, owner, expectedAttempt } = selected;
    const assertSource = (prepared: MaintenanceAgentLoopShadowProposalRecord) => {
      try { assertMaintenanceAgentLoopShadowSource(() => authorizeCommit(prepared)); }
      catch { throw new Error('maintenance-agent-loop-shadow-publication-authorization-invalid'); }
    };
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const initial = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      const initialJobRow = this.#getRow(runId)!;
      const prepared = this.#readAgentLoopShadowProposal(runId);
      if (!prepared || prepared.preparation.ownerInstanceId !== owner || prepared.preparation.attempt !== expectedAttempt) {
        throw new Error('maintenance-agent-loop-shadow-publication-conflict');
      }
      const outbox = this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId) as SqlRow | undefined;
      if (!outbox || outbox.claimed_at === null || outbox.delivered_at !== null) {
        throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
      }
      assertSource(prepared);
      const beforeWrite = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      if (beforeWrite.now < initial.now || JSON.stringify(beforeWrite.execution) !== JSON.stringify(initial.execution)
        || JSON.stringify(this.#readAgentLoopShadowProposal(runId)) !== JSON.stringify(prepared)) {
        throw new Error('maintenance-agent-loop-shadow-publication-conflict');
      }
      const publication = createMaintenanceAgentLoopShadowPublicationReceipt({ publication: selected.publication,
        preparation: prepared.preparation, publishedAt: beforeWrite.now });
      const changed = this.#db.prepare(`UPDATE maintenance_pending_proposal
        SET status='pending',revision=2,updated_at=?,agent_loop_publication_json=?
        WHERE job_run_id=? AND status='prepared' AND revision=1 AND agent_loop_publication_json IS NULL`)
        .run(publication.publishedAt, JSON.stringify(publication), runId);
      if (changed.changes !== 1) throw new Error('maintenance-agent-loop-shadow-publication-conflict');
      // The queue row is not externally visible until COMMIT. Revalidate its
      // actual body/origin/receipt before the last live source assertion.
      const staged = this.#readAgentLoopShadowPublication(runId, false);
      if (!staged || JSON.stringify(staged.preparation) !== JSON.stringify(prepared.preparation)
        || JSON.stringify(staged.proposal.proposal) !== JSON.stringify(prepared.proposal)
        || JSON.stringify(staged.proposal.context) !== JSON.stringify(prepared.context)
        || JSON.stringify(staged.publication) !== JSON.stringify(publication)) {
        throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
      }
      assertSource(prepared);
      const finalClaim = this.#requireAgentLoopShadowClaim(runId, owner, expectedAttempt);
      if (finalClaim.now < beforeWrite.now || JSON.stringify(finalClaim.execution) !== JSON.stringify(initial.execution)
        || JSON.stringify(this.#readAgentLoopShadowPublication(runId, false)) !== JSON.stringify(staged)) {
        throw new Error('maintenance-agent-loop-shadow-publication-conflict');
      }
      // There are no host callbacks or awaited work after this live-claim fence.
      const updated = this.#db.prepare(`UPDATE maintenance_job
        SET status='succeeded',updated_at=?,finished_at=?,error_code=NULL,
          proposal_digest=?,proposal_disposition='shadow',diff_json=?,
          lease_owner_instance_id=NULL,lease_expires_at=NULL
        WHERE run_id=? AND status='running' AND executor_route='agent-loop'
          AND lease_owner_instance_id=? AND attempt=? AND cancel_requested_at IS NULL AND lease_expires_at>?`)
        .run(publication.publishedAt, publication.publishedAt, prepared.proposalDigest.slice('sha256:'.length),
          JSON.stringify(prepared.diff), runId, owner, expectedAttempt, finalClaim.now);
      if (updated.changes !== 1) throw new Error('maintenance-agent-loop-shadow-publication-conflict');
      const delivered = this.#db.prepare(`UPDATE maintenance_outbox SET delivered_at=?
        WHERE job_run_id=? AND delivered_at IS NULL`).run(publication.publishedAt, runId);
      if (delivered.changes !== 1) throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
      const result = this.#readAgentLoopShadowPublication(runId, true);
      const now = canonicalTimestamp(this.#now());
      const expectedJobRow = { ...initialJobRow, status: 'succeeded', updated_at: publication.publishedAt,
        finished_at: publication.publishedAt, error_code: null, proposal_digest: prepared.proposalDigest.slice('sha256:'.length),
        proposal_disposition: 'shadow', diff_json: JSON.stringify(prepared.diff), lease_owner_instance_id: null, lease_expires_at: null };
      const expectedOutbox = { ...outbox, delivered_at: publication.publishedAt };
      if (!result || JSON.stringify(result.publication) !== JSON.stringify(publication)
        || now < finalClaim.now || now >= initial.execution.leaseExpiresAt
        || !this.settings(initial.execution.job.sessionId).effectiveEnabled
        || JSON.stringify(this.#getRow(runId)) !== JSON.stringify(expectedJobRow)
        || JSON.stringify(this.#db.prepare('SELECT * FROM maintenance_outbox WHERE job_run_id=?').get(runId)) !== JSON.stringify(expectedOutbox)) {
        throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
      }
      this.#db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* publication/job/outbox always roll back together */ }
      throw error;
    }
  }

  /** Private historical reader. It never revives a Manager claim or AL Action. */
  readAgentLoopShadowPublication(runIdValue: string): MaintenanceAgentLoopShadowPublicationRecord | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid');
    return this.#readAgentLoopShadowPublication(requireOpaque(runIdValue, 'runId'), true);
  }

  #readAgentLoopShadowPublication(runId: string, requireSucceeded: boolean): MaintenanceAgentLoopShadowPublicationRecord | null {
    const row = this.#db.prepare(`SELECT * FROM maintenance_pending_proposal
      WHERE job_run_id=? AND status<>'prepared' AND agent_loop_publication_json IS NOT NULL`).get(runId) as SqlRow | undefined;
    if (!row) return null;
    try {
      const jobRow = this.#getRow(runId);
      if (!jobRow || jobRow.executor_route !== 'agent-loop'
        || typeof row.proposal_json !== 'string' || Buffer.byteLength(row.proposal_json, 'utf8') > MAX_PROPOSAL_BYTES
        || typeof row.context_json !== 'string' || Buffer.byteLength(row.context_json, 'utf8') > MAX_CONTEXT_BYTES
        || typeof row.agent_loop_preparation_json !== 'string' || Buffer.byteLength(row.agent_loop_preparation_json, 'utf8') > 8192
        || typeof row.agent_loop_publication_json !== 'string' || Buffer.byteLength(row.agent_loop_publication_json, 'utf8') > 8192) throw new Error();
      const job = parseJob(jobRow), body = normalizeMaintenanceAgentLoopShadowProposal({
        proposal: JSON.parse(row.proposal_json), proposalContext: JSON.parse(row.context_json) });
      const createdAt = canonicalTimestamp(String(row.created_at));
      const preparation = parseMaintenanceAgentLoopShadowProposalPreparation(JSON.parse(row.agent_loop_preparation_json),
        { job, createdAt, proposalDigest: body.proposalDigest, proposalContextDigest: body.proposalContextDigest });
      const publication = parseMaintenanceAgentLoopShadowPublicationReceipt(JSON.parse(row.agent_loop_publication_json), preparation);
      const proposal = parseProposalRow(row);
      if (row.proposal_id !== `mprop_${runId.slice(5)}` || row.job_run_id !== runId || row.session_id !== job.sessionId
        || row.task_kind !== 'rolling_summary' || row.source_revision !== job.sourceRevision
        || !Number.isSafeInteger(row.revision) || (row.revision as number) < 2
        || proposal.updatedAt < publication.publishedAt || publication.publishedAt < createdAt
        || row.proposal_digest !== body.proposalDigest || body.context.sessionId !== job.sessionId
        || body.context.sourceRevision !== job.sourceRevision || row.proposal_json !== JSON.stringify(body.proposal)
        || row.context_json !== JSON.stringify(body.context) || row.diff_json !== JSON.stringify(body.diff)
        || row.agent_loop_preparation_json !== JSON.stringify(preparation)
        || row.agent_loop_publication_json !== JSON.stringify(publication)
        || proposal.status === 'pending' && (proposal.revision !== 2 || proposal.updatedAt !== publication.publishedAt
          || row.decided_at !== null || row.decision_reason !== null || row.receipt_json !== null || row.rollback_anchor_json !== null)
        || proposal.status !== 'pending' && proposal.revision < 3) throw new Error();
      if (requireSucceeded && (job.status !== 'succeeded' || jobRow.cancel_requested_at !== null
        || jobRow.lease_owner_instance_id !== null || jobRow.lease_expires_at !== null || jobRow.error_code !== null
        || job.finishedAt !== publication.publishedAt || job.updatedAt !== publication.publishedAt
        || jobRow.proposal_digest !== body.proposalDigest.slice('sha256:'.length)
        || jobRow.proposal_disposition !== 'shadow' || jobRow.diff_json !== JSON.stringify(body.diff))) throw new Error();
      return Object.freeze({ job: Object.freeze(job), proposal, preparation, publication });
    } catch { throw new Error('maintenance-agent-loop-shadow-publication-storage-invalid'); }
  }

  #requireAgentLoopShadowClaim(runId: string, owner: string, expectedAttempt: number): {
    execution: MaintenanceExecutionRecord; now: string;
  } {
    const now = canonicalTimestamp(this.#now()), execution = this.readExecution(runId);
    if (!execution || execution.executorRoute !== 'agent-loop' || execution.job.taskKind !== 'rolling_summary'
      || execution.job.mode !== 'shadow' || execution.job.status !== 'running'
      || execution.leaseOwnerInstanceId !== owner || execution.job.attempt !== expectedAttempt
      || execution.cancelRequestedAt !== undefined || execution.leaseExpiresAt <= now
      || !execution.job.startedAt || execution.job.startedAt > now || execution.job.createdAt > execution.job.startedAt
      || !this.settings(execution.job.sessionId).effectiveEnabled) {
      throw new Error('maintenance-agent-loop-shadow-proposal-claim-invalid');
    }
    return { execution, now };
  }

  /** Optional evaluation preparation never grants a write or creates an operator approval. */
  prepareMemoryDirectProposal(input: {
    runId: string;
    owner: string;
    proposal: MaintenanceProposal;
    proposalContext: MaintenanceStrictProposalContext;
    skillProposalProof: MaintenanceMemorySkillProposalProof;
  }): MaintenanceMemoryDirectPreparation | null {
    this.#assertOpen();
    const runId = requireOpaque(input.runId, 'runId');
    const owner = requireOpaque(input.owner, 'owner');
    this.#requireMemoryDirectClaim(runId, owner);
    const transactionOpen = (): boolean => this.#db.isTransaction;
    if (transactionOpen() !== false) throw new Error('maintenance-memory-direct-outer-transaction');
    let transactionStarted = false;
    try {
      const proof = input.skillProposalProof;
      const claim = this.#requireMemoryDirectClaim(runId, owner);
      const digest = createHash('sha256').update(JSON.stringify(input.proposal)).digest('hex');
      if (!isMaintenanceMemorySkillProposalProof(proof) || !this.#skillProofMatchesClaim(proof, claim.job, digest)) {
        throw new Error('maintenance-memory-direct-proof-invalid');
      }
      // Reject an ineligible payload before lazy schema creation; the in-transaction record is validated again.
      createMaintenanceMemoryDirectProposal(claim.job, input.proposal, input.proposalContext,
        proof, canonicalTimestamp(this.#now()));
      const store = new MaintenanceMemoryDirectProposalStore(this.#db, (id) => this.#readSkillJob(id));
      const outbox = new MaintenanceMemorySkillOutbox(this.#db, (id) => this.#readSkillJob(id));
      this.#db.exec('BEGIN IMMEDIATE;');
      transactionStarted = true;
      const current = this.#requireMemoryDirectClaim(runId, owner, proof.attempt);
      if (transactionOpen() !== true) throw new Error('maintenance-memory-direct-transaction-required');
      if (!this.#skillProofMatchesClaim(proof, current.job, digest) || this.getProposalForJob(runId)) {
        throw new Error('maintenance-memory-direct-proof-invalid');
      }
      const record = createMaintenanceMemoryDirectProposal(current.job, input.proposal, input.proposalContext,
        proof, canonicalTimestamp(this.#now()));
      store.insert(record);
      outbox.enqueueDirect(current.job, proof, record);
      this.#db.exec('COMMIT;');
      transactionStarted = false;
      if (transactionOpen() !== false) throw new Error('maintenance-memory-direct-outer-transaction');
      const handle = Object.freeze({}) as MaintenanceMemoryDirectPreparation;
      this.#directPreparations.set(handle, Object.freeze({
        runId, owner, attempt: current.job.attempt, preparationDigest: record.preparationDigest,
      }));
      return handle;
    } catch (error) {
      if (transactionStarted && transactionOpen() === true) {
        this.#db.exec('ROLLBACK;');
      }
      if (error instanceof Error && error.message === 'maintenance-memory-direct-claim-invalid') throw error;
      this.#reportSkillProvenanceFailure();
      return null;
    }
  }

  /** Consume once, immediately before the synchronous Session write and after any asynchronous load. */
  authorizeMemoryDirectProposal(handle: MaintenanceMemoryDirectPreparation,
    request: MaintenanceCommitRequest): void {
    this.#assertOpen();
    const binding = typeof handle === 'object' && handle !== null ? this.#directPreparations.get(handle) : undefined;
    if (typeof handle === 'object' && handle !== null) this.#directPreparations.delete(handle);
    if (!binding || request.runId !== binding.runId || this.#db.isTransaction !== false) {
      throw new Error('maintenance-memory-direct-preparation-invalid');
    }
    const claim = this.#requireMemoryDirectClaim(binding.runId, binding.owner, binding.attempt);
    const direct = this.getMemoryDirectProposal(binding.runId);
    const source = this.readMemorySkillProvenance(binding.runId);
    if (!direct || direct.preparationDigest !== binding.preparationDigest
      || source?.payloadVersion !== 'maintenance-memory-skill-outbox-v2'
      || source.preparationDigest !== binding.preparationDigest || source.proof.proofDigest !== direct.proofDigest
      || request.sessionId !== claim.job.sessionId || request.taskKind !== 'memory_consolidation'
      || request.expectedRevision !== direct.sourceRevision
      || JSON.stringify(request.proposal) !== JSON.stringify(direct.proposal)
      || JSON.stringify(request.context) !== JSON.stringify(direct.context)) {
      throw new Error('maintenance-memory-direct-preparation-invalid');
    }
  }

  getMemoryDirectProposal(runIdValue: string): MaintenanceMemoryDirectProposalRecord | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('maintenance-memory-direct-uncommitted-read');
    const runId = requireOpaque(runIdValue, 'runId');
    return MaintenanceMemoryDirectProposalStore.openExisting(this.#db,
      (id) => this.#readSkillJob(id))?.read(runId) ?? null;
  }

  getMemoryWriteProposalForJob(runIdValue: string):
    MaintenancePendingProposalRecord | MaintenanceMemoryDirectProposalRecord | null {
    const manual = this.getProposalForJob(runIdValue);
    const direct = this.getMemoryDirectProposal(runIdValue);
    if (manual && direct) throw new Error('maintenance-memory-write-proposal-kind-conflict');
    return manual ?? direct;
  }

  /** Summary's own immutable source; Memory proof/outbox contracts never authorize this task. */
  prepareSummaryDirectProposal(input: {
    runId: string;
    owner: string;
    proposal: MaintenanceProposal;
    proposalContext: MaintenanceStrictProposalContext;
    summarySkillProof: MaintenanceSummarySkillProposalProof;
  }): MaintenanceSummaryDirectPreparation | null {
    this.#assertOpen();
    const runId = requireOpaque(input.runId, 'runId');
    const owner = requireOpaque(input.owner, 'owner');
    this.#requireSummaryDirectClaim(runId, owner);
    const transactionOpen = (): boolean => this.#db.isTransaction;
    if (transactionOpen() !== false) throw new Error('maintenance-summary-direct-outer-transaction');
    let started = false;
    try {
      const proof = input.summarySkillProof;
      const claim = this.#requireSummaryDirectClaim(runId, owner);
      const digest = createHash('sha256').update(JSON.stringify(input.proposal)).digest('hex');
      if (!isMaintenanceSummarySkillProposalProof(proof)
        || !this.#summaryProofMatchesClaim(proof, claim.job, digest, input.proposalContext)) {
        throw new Error('maintenance-summary-direct-proof-invalid');
      }
      createMaintenanceSummarySkillProposalRecord(claim.job, input.proposal, input.proposalContext,
        proof, 'prepared', canonicalTimestamp(this.#now()));
      const store = new MaintenanceSummarySkillSourceStore(this.#db, (id) => this.#readSkillJob(id));
      this.#db.exec('BEGIN IMMEDIATE;');
      started = true;
      const current = this.#requireSummaryDirectClaim(runId, owner, proof.attempt);
      if (this.getProposalForJob(runId) || store.read(runId)
        || !this.#summaryProofMatchesClaim(proof, current.job, digest, input.proposalContext)) {
        throw new Error('maintenance-summary-direct-proof-invalid');
      }
      const record = createMaintenanceSummarySkillProposalRecord(current.job, input.proposal, input.proposalContext,
        proof, 'prepared', canonicalTimestamp(this.#now()));
      store.insert(current.job, proof, record);
      this.#db.exec('COMMIT;');
      started = false;
      if (transactionOpen() !== false) throw new Error('maintenance-summary-direct-outer-transaction');
      const handle = Object.freeze({}) as MaintenanceSummaryDirectPreparation;
      this.#summaryPreparations.set(handle, Object.freeze({
        runId, owner, attempt: current.job.attempt, recordDigest: record.recordDigest,
      }));
      return handle;
    } catch (error) {
      if (started && transactionOpen() === true) this.#db.exec('ROLLBACK;');
      // An optional metadata outage cannot hide a simultaneously revoked execution claim.
      this.#requireSummaryDirectClaim(runId, owner);
      if (error instanceof Error && error.message === 'maintenance-summary-direct-claim-invalid') throw error;
      this.#reportSkillProvenanceFailure();
      return null;
    }
  }

  authorizeSummaryDirectProposal(handle: MaintenanceSummaryDirectPreparation, request: MaintenanceCommitRequest): void {
    this.#assertOpen();
    const binding = typeof handle === 'object' && handle !== null ? this.#summaryPreparations.get(handle) : undefined;
    if (typeof handle === 'object' && handle !== null) this.#summaryPreparations.delete(handle);
    if (!binding || request.runId !== binding.runId || this.#db.isTransaction !== false) {
      throw new Error('maintenance-summary-direct-preparation-invalid');
    }
    const claim = this.#requireSummaryDirectClaim(binding.runId, binding.owner, binding.attempt);
    const record = this.getSummarySkillProposal(binding.runId);
    const source = this.readSummarySkillProvenance(binding.runId);
    if (!record || record.status !== 'prepared' || record.recordDigest !== binding.recordDigest
      || source?.recordDigest !== binding.recordDigest || source.proof.proofDigest !== record.proofDigest
      || request.sessionId !== claim.job.sessionId || request.taskKind !== 'rolling_summary'
      || request.expectedRevision !== record.sourceRevision
      || JSON.stringify(request.proposal) !== JSON.stringify(record.proposal)
      || JSON.stringify(request.context) !== JSON.stringify(record.context)) {
      throw new Error('maintenance-summary-direct-preparation-invalid');
    }
  }

  getSummarySkillProposal(runIdValue: string): MaintenanceSummarySkillProposalRecord | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('summary-skill-source-uncommitted-read');
    const runId = requireOpaque(runIdValue, 'runId');
    return MaintenanceSummarySkillSourceStore.openExisting(this.#db, (id) => this.#readSkillJob(id))
      ?.read(runId)?.record ?? null;
  }

  readSummarySkillProvenance(runIdValue: string): MaintenanceSummarySkillSourceEntry | null {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('summary-skill-source-uncommitted-read');
    const runId = requireOpaque(runIdValue, 'runId');
    return MaintenanceSummarySkillSourceStore.openExisting(this.#db, (id) => this.#readSkillJob(id))
      ?.read(runId)?.source ?? null;
  }

  scanAllSummarySkillProvenance(limit = 64, cursor = 0): MaintenanceSummarySkillSourceScan {
    this.#assertOpen();
    if (this.#db.isTransaction !== false) throw new Error('summary-skill-source-uncommitted-read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('summary-skill-source-limit-invalid');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('summary-skill-source-cursor-invalid');
    return MaintenanceSummarySkillSourceStore.openExisting(this.#db, (id) => this.#readSkillJob(id))
      ?.scanAll(limit, cursor) ?? { entries: [], attempted: 0, failed: 0, nextCursor: 0, hasMore: false };
  }

  acknowledgeSummarySkillProvenance(entry: MaintenanceSummarySkillSourceEntry): void {
    this.#assertOpen();
    const store = MaintenanceSummarySkillSourceStore.openExisting(this.#db, (id) => this.#readSkillJob(id));
    if (!store) throw new Error('summary-skill-source-missing');
    store.acknowledge(entry, canonicalTimestamp(this.#now()));
  }

  rejectPendingProposal(input: {
    proposalId: string;
    expectedRevision: number;
    reason: string;
  }): MaintenancePendingProposalSummary {
    this.#assertOpen();
    const proposalId = requireOpaque(input.proposalId, 'proposalId');
    const reason = requireOpaque(input.reason, 'reason', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('maintenance-proposal-revision-invalid');
    }
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`
      UPDATE maintenance_pending_proposal
      SET status='rejected',revision=revision+1,updated_at=?,decided_at=?,decision_reason=?
      WHERE proposal_id=? AND status='pending' AND revision=?
    `).run(now, now, reason, proposalId, input.expectedRevision);
    if (result.changes !== 1) throw new Error('maintenance-proposal-revision-conflict');
    return proposalSummary(this.getPendingProposal(proposalId)!);
  }

  markProposalApplied(input: {
    proposalId: string;
    expectedRevision: number;
    receipt: Record<string, unknown>;
    rollbackAnchor: Record<string, unknown>;
    decisionReason?: string;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'pending',
      to: 'applied',
      reason: input.decisionReason ?? 'operator-approved',
      receipt: input.receipt,
      rollbackAnchor: input.rollbackAnchor,
    });
  }

  markProposalStale(input: {
    proposalId: string;
    expectedRevision: number;
    reason?: string;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'pending',
      to: 'stale',
      reason: input.reason ?? 'source-revision-stale',
    });
  }

  markProposalRolledBack(input: {
    proposalId: string;
    expectedRevision: number;
    receipt: Record<string, unknown>;
  }): MaintenancePendingProposalSummary {
    return this.#transitionProposal({
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      from: 'applied',
      to: 'rolled_back',
      reason: 'operator-rollback',
      receipt: input.receipt,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    OPEN_MAINTENANCE_JOB_MANAGER_INSTANCES.delete(this);
    this.#db.close();
  }

  #getRow(runId: string): SqlRow | undefined {
    return this.#db.prepare('SELECT * FROM maintenance_job WHERE run_id=?').get(runId) as SqlRow | undefined;
  }

  #readSkillJob(runId: string): PublicMaintenanceJob {
    const row = this.#getRow(runId);
    if (!row) throw new Error('maintenance skill job missing');
    return parseJob(row);
  }

  #readArcSkillJob(runId: string): PublicMaintenanceJob {
    const row = this.#getRow(runId);
    if (!row || row.executor_route !== 'legacy' || row.cancel_requested_at !== null
      || row.lease_owner_instance_id !== null || row.lease_expires_at !== null) {
      throw new Error('arc-skill-source-link-invalid');
    }
    return parseJob(row);
  }

  #arcProofMatchesClaim(proof: MaintenanceArcSkillProposalProof, job: PublicMaintenanceJob,
    proposalDigest: string | null, context: MaintenanceStrictProposalContext | undefined): boolean {
    try {
      return proof.runId === job.runId && proof.sessionId === job.sessionId && proof.attempt === job.attempt
        && proof.parentRunId === (job.parentRunId ?? job.runId) && proof.sourceRevision === job.sourceRevision
        && proof.policyVersion === job.policyVersion && proof.proposalDigest === `sha256:${proposalDigest}`
        && proof.admittedAt >= (job.startedAt ?? job.createdAt)
        && context !== undefined && 'allowedArcIds' in context
        && context.sessionId === job.sessionId && context.sourceRevision === job.sourceRevision
        && proof.proposalContextDigest === maintenanceArcSkillDigest(context)
        && proof.providerProposalContextDigest === maintenanceArcSkillDigest(maintenanceArcSkillProviderProposalContext(context));
    } catch { return false; }
  }

  #readNpcSkillJob(runId: string): PublicMaintenanceJob {
    const row = this.#getRow(runId);
    if (!row || row.executor_route !== 'legacy' || row.cancel_requested_at !== null
      || row.lease_owner_instance_id !== null || row.lease_expires_at !== null) throw new Error('npc-skill-source-link-invalid');
    return parseJob(row);
  }

  #npcProofMatchesClaim(proof: MaintenanceNpcSkillResultProof, job: PublicMaintenanceJob,
    proposalDigest: string | null, context: MaintenanceStrictProposalContext | undefined,
    proposal: MaintenanceProposal | undefined, noop: NpcMaintenanceNoopTerminal | undefined,
    disposition: 'shadow' | 'committed' | 'stale' | undefined): boolean {
    try {
      if (job.taskKind !== 'npc_state' || job.mode !== 'shadow' || job.status !== 'running'
        || proof.runId !== job.runId || proof.sessionId !== job.sessionId || proof.attempt !== job.attempt
        || proof.parentRunId !== (job.parentRunId ?? job.runId) || proof.sourceRevision !== job.sourceRevision
        || proof.policyVersion !== job.policyVersion || proof.admittedAt < (job.startedAt ?? job.createdAt)
        || context === undefined || !('allowedCharacterIds' in context)
        || context.sessionId !== job.sessionId || context.sourceRevision !== job.sourceRevision
        || proof.proposalContextDigest !== maintenanceNpcSkillDigest(context)
        || proof.providerProposalContextDigest !== maintenanceNpcSkillDigest(maintenanceNpcSkillProviderProposalContext(context))) return false;
      if (proof.terminalKind === 'proposal') return noop === undefined && proposal?.taskKind === 'npc_state'
        && (disposition === undefined || disposition === 'shadow') && proof.terminalDigest === `sha256:${proposalDigest}`
        && JSON.stringify(validateMaintenanceProposal('npc_state', proposal.payload, context)) === JSON.stringify(proposal);
      return proof.terminalKind === 'noop' && proposal === undefined && disposition === undefined && proposalDigest === null
        && noop !== undefined && Array.isArray(context.completionTargetIds) && context.completionTargetIds.length > 0
        && maintenanceNpcSkillDigest(noop) === proof.terminalDigest
        && JSON.stringify(normalizeNpcMaintenanceNoopTerminal(noop, context)) === JSON.stringify(noop);
    } catch { return false; }
  }

  #requireMemoryDirectClaim(runId: string, owner: string, attempt?: number): MaintenanceExecutionRecord {
    const claim = this.readExecution(runId);
    if (!claim || claim.job.taskKind !== 'memory_consolidation' || claim.job.mode !== 'apply'
      || claim.executorRoute !== 'legacy'
      || claim.job.status !== 'running' || claim.leaseOwnerInstanceId !== owner
      || claim.cancelRequestedAt !== undefined || claim.leaseExpiresAt <= canonicalTimestamp(this.#now())
      || (attempt !== undefined && claim.job.attempt !== attempt)
      || !this.settings(claim.job.sessionId).effectiveEnabled) {
      throw new Error('maintenance-memory-direct-claim-invalid');
    }
    return claim;
  }

  #skillProofMatchesClaim(proof: MaintenanceMemorySkillProposalProof, job: PublicMaintenanceJob,
    proposalDigest: string | null): boolean {
    return proof.runId === job.runId && proof.sessionId === job.sessionId && proof.attempt === job.attempt
      && proof.parentRunId === (job.parentRunId ?? job.runId) && proof.sourceRevision === job.sourceRevision
      && proof.policyVersion === job.policyVersion && proof.proposalDigest === `sha256:${proposalDigest}`;
  }

  #requireSummaryDirectClaim(runId: string, owner: string, attempt?: number): MaintenanceExecutionRecord {
    const claim = this.readExecution(runId);
    if (!claim || claim.job.taskKind !== 'rolling_summary' || claim.job.mode !== 'apply'
      || claim.executorRoute !== 'legacy'
      || claim.job.status !== 'running' || claim.leaseOwnerInstanceId !== owner
      || claim.cancelRequestedAt !== undefined || claim.leaseExpiresAt <= canonicalTimestamp(this.#now())
      || (attempt !== undefined && claim.job.attempt !== attempt)
      || !this.settings(claim.job.sessionId).effectiveEnabled) {
      throw new Error('maintenance-summary-direct-claim-invalid');
    }
    return claim;
  }

  #summaryProofMatchesClaim(proof: MaintenanceSummarySkillProposalProof, job: PublicMaintenanceJob,
    proposalDigest: string | null, context: MaintenanceStrictProposalContext | undefined): boolean {
    return proof.runId === job.runId && proof.sessionId === job.sessionId && proof.attempt === job.attempt
      && proof.parentRunId === (job.parentRunId ?? job.runId) && proof.sourceRevision === job.sourceRevision
      && proof.policyVersion === job.policyVersion && proof.proposalDigest === `sha256:${proposalDigest}`
      && context !== undefined && proof.proposalContextDigest === maintenanceSummarySkillDigest(context);
  }

  #reportSkillProvenanceFailure(): void {
    try { this.#onSkillProvenanceFailure(); } catch { /* Diagnostics cannot change business completion. */ }
  }

  #transitionProposal(input: {
    proposalId: string;
    expectedRevision: number;
    from: MaintenanceProposalStatus;
    to: MaintenanceProposalStatus;
    reason: string;
    receipt?: Record<string, unknown>;
    rollbackAnchor?: Record<string, unknown>;
  }): MaintenancePendingProposalSummary {
    this.#assertOpen();
    const proposalId = requireOpaque(input.proposalId, 'proposalId');
    const reason = requireOpaque(input.reason, 'reason', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('maintenance-proposal-revision-invalid');
    }
    let receipt = input.receipt === undefined ? null : requireJsonObject(input.receipt, 'receipt', MAX_RECEIPT_BYTES);
    const anchorJson = input.rollbackAnchor === undefined ? null
      : JSON.stringify(requireJsonObject(input.rollbackAnchor, 'rollbackAnchor', MAX_RECEIPT_BYTES));
    const ownsTransaction = input.to === 'rolled_back' && this.#db.isTransaction === false;
    if (ownsTransaction) this.#db.exec('BEGIN IMMEDIATE;');
    try {
      if (input.to === 'rolled_back' && receipt !== null) {
        // No caller may inject the reserved metadata. Capture under the same lock as the original CAS.
        const { [MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE]: _discarded, ...businessReceipt } = receipt;
        receipt = businessReceipt;
        try {
          const original = this.getPendingProposal(proposalId);
          const job = original ? this.get(original.jobRunId) : null;
          if (original?.status === input.from && original.revision === input.expectedRevision && job) {
            const approval = captureMaintenanceProposalApprovalSource(original, job);
            if (approval) {
              const retained = { ...businessReceipt, [MAINTENANCE_PROPOSAL_APPROVAL_SOURCE_NAMESPACE]: approval };
              receipt = requireJsonObject(retained, 'receipt', MAX_RECEIPT_BYTES);
            }
          }
        } catch { /* Optional evidence cannot reverse a committed domain rollback. Missing history stays unknown. */ }
      }
      const receiptJson = receipt === null ? null : JSON.stringify(receipt);
      const now = canonicalTimestamp(this.#now());
      const result = this.#db.prepare(`
      UPDATE maintenance_pending_proposal
      SET status=?,revision=revision+1,updated_at=?,decided_at=?,decision_reason=?,
        receipt_json=COALESCE(?,receipt_json),
        rollback_anchor_json=COALESCE(?,rollback_anchor_json)
      WHERE proposal_id=? AND status=? AND revision=?
    `).run(input.to, now, now, reason, receiptJson, anchorJson,
      proposalId, input.from, input.expectedRevision);
      if (result.changes !== 1) throw new Error('maintenance-proposal-revision-conflict');
      const summary = proposalSummary(this.getPendingProposal(proposalId)!);
      if (ownsTransaction) this.#db.exec('COMMIT;');
      return summary;
    } catch (error) {
      if (ownsTransaction && this.#db.isTransaction) this.#db.exec('ROLLBACK;');
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MaintenanceJobManager closed');
  }
}
