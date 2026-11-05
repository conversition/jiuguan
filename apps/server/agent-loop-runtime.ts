/** P17-02.3e-e2d: one Store, one Kernel and one Coordinator.
 * Metadata stays read-only. A Service capability binds two default steps; an additional
 * post-CAS one-use host capability binds one exact read, shadow-proposal OR apply ACT.
 * Only an explicit route-owned shadow/apply host may request and verify completion afterwards.
 * A separate explicit correction MODEL-only host shares this Coordinator and
 * physical scope, and stops before ACT even when its second Decision is valid.
 * An independently branded correction-proposal host may instead execute one
 * original proposal ACT. Only its optional explicit publication host continues
 * through the original OBSERVE/VERIFY and business-first completion exchange.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeAgentLoopTaskEnvelope, type AgentLoopTaskEnvelopeV1, type AgentLoopDecisionV1 } from '@jiuguan/agent-loop-contract';
import type { PublicMaintenanceJob, PublicTurnJob } from '@jiuguan/mobile-contracts';
import { AgentLoopCoordinator, agentLoopModelInvocationId, agentLoopActionId, agentLoopDecisionDigest,
  type AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import { consumeAgentLoopGetVariablesCapability, revokeAgentLoopGetVariablesCapability,
  type AgentLoopGetVariablesCapability } from './agent-loop-get-variables-authorization.ts';
import { consumeAgentLoopRollingSummaryProposalCapability, revokeAgentLoopRollingSummaryProposalCapability,
  type AgentLoopRollingSummaryProposalCapability } from './agent-loop-rolling-summary-proposal-authorization.ts';
import { revokeAgentLoopRollingSummaryApplyCapability,
  type AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';
import { assertAgentLoopCorrectionProposalInitialCapability, consumeAgentLoopCorrectionProposalCapability,
  revokeAgentLoopCorrectionProposalCapability, type AgentLoopCorrectionProposalCapability } from './agent-loop-correction-proposal-authorization.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { readAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { readAgentLoopPreparedExecutionArtifactRefs } from './agent-loop-prepared-execution.ts';
import { consumeAgentLoopCompletionRequest, revokeAgentLoopCompletionRequest,
  type AgentLoopCompletionRequest } from './agent-loop-completion-request.ts';
import { revokeFrozenAgentLoopCompletion } from './agent-loop-frozen-completion.ts';
import { describeAgentLoopMaintenanceExecutionSupport, describeAgentLoopMaintenanceCorrectionSupport,
  selectAgentLoopMaintenanceExecutionRoute, type AgentLoopMaintenanceExecutionSupport,
  type AgentLoopMaintenanceCorrectionSupport } from './agent-loop-maintenance-execution-support.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION,
  matchesAgentLoopMaintenanceProductionRouteJob,
} from './agent-loop-maintenance-production-route-contract.ts';
import { agentLoopMaintenanceCanaryRoutePlanV2JobDigest } from './agent-loop-maintenance-canary-route-plan-v2.ts';
import { agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest } from './agent-loop-maintenance-canary-source-policy.ts';
import type { createAgentLoopShadowPublication } from './agent-loop-shadow-publication.ts';
import type { createAgentLoopSummaryApplyCompletion } from './agent-loop-summary-apply-completion.ts';
import { withProviderWorkSettlement } from '../../packages/proxy/public/provider-runtime.ts';
import { consumeMaintenanceAgentLoopExecutionContext, sameMaintenanceAgentLoopClaim,
  adoptMaintenanceAgentLoopModelCorrection, adoptMaintenanceAgentLoopCorrectionProposal,
  type MaintenanceAgentLoopExecutionContext,
  type MaintenanceAgentLoopExecutionPort } from './agent-loop-maintenance-lifecycle.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, assertAgentLoopModelCorrectionPolicyBinding,
  agentLoopModelCorrectionPolicyDigest, type AgentLoopModelCorrectionPolicy } from './agent-loop-model-correction.ts';
import type { createAgentLoopMaintenanceCorrectionModel } from './agent-loop-maintenance-correction-model.ts';
import {
  MaintenanceJobManager,
  isMaintenanceJobManagerInstanceInternal,
  isOpenMaintenanceJobManagerInstanceInternal,
  type MaintenanceExecutionRecord,
} from './maintenance-job-manager.ts';
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';
import { readAgentLoopModelOutcome } from './agent-loop-model-outcome.ts';
import { createAgentLoopRpReadonlyRuntimeScope,
  type AgentLoopRpReadonlyExecutionConfig } from './agent-loop-rp-runtime.ts';
import { createAgentLoopRpChildJoinRuntimeScope } from './agent-loop-rp-child-join.ts';
import {
  AGENT_LOOP_HOOKS,
  AGENT_LOOP_HOOK_PHASES,
  AgentLoopExtensionKernel,
  type AgentLoopExtension,
  type AgentLoopExtensionHookOutcome,
} from './agent-loop-extension-kernel.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord, AgentLoopTaskSuspendRequest,
  AgentLoopTaskResumeRequest, AgentLoopTaskResumeEvidence, AgentLoopTaskResumeResult } from './agent-loop-projection-store.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { createAgentLoopMaintenancePrepare, type AgentLoopMaintenancePrepareOptions } from './agent-loop-prepare.ts';
import {
  buildShadowMaintenanceJobEnvelope,
  buildShadowTurnJobEnvelope,
  handleMaintenanceJobPhase,
  handleTurnJobPhase,
  isPristineShadowProjection,
  shadowJobSourceState,
  type AgentLoopShadowSourceReaders,
  type ShadowJobPhaseOutcome,
  type ShadowTurnJobProjectionV1,
} from './agent-loop-turnjob-shadow.ts';

export const AGENT_LOOP_SERVER_COMPOSITION_VERSION = 'agent-loop-server-composition-v1' as const;
export const AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION =
  'agent-loop-server-composition-capability-manifest-v2' as const;
export const AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION =
  'agent-loop-maintenance-execution-profile-v1' as const;
export const AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION =
  'agent-loop-maintenance-runtime-context-observation-v1' as const;
export const AGENT_LOOP_MAINTENANCE_ISOLATED_CANARY_EXECUTION_PORT_VERSION =
  'agent-loop-maintenance-isolated-canary-execution-port-v1' as const;
export const AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_EXECUTION_PORT_VERSION =
  'agent-loop-maintenance-production-canary-execution-port-v1' as const;
export const AGENT_LOOP_RUNTIME_QUEUE_LIMIT = 128;
/** The existing Kernel contract is the only lifecycle order, not a second phase table. */
export const AGENT_LOOP_SERVER_LIFECYCLE_ORDER = AGENT_LOOP_HOOKS;
const EXECUTION_DISABLED = 'agent-loop-production-execution-disabled';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

type TurnPhase = 'queued' | 'running' | 'settled';
type MaintenancePhase = 'enqueued' | 'settled';
type Event = Readonly<{ family: 'turn'; runId: string; phase: TurnPhase }>
  | Readonly<{ family: 'maintenance'; runId: string; phase: MaintenancePhase }>;
type Source = Readonly<{ family: 'turn'; job: PublicTurnJob }>
  | Readonly<{ family: 'maintenance'; job: PublicMaintenanceJob }>;

export interface AgentLoopCorrectionProposalActionInput {
  readonly record: AgentLoopTaskRecord;
  readonly policy: AgentLoopModelCorrectionPolicy;
  readonly modelRecord: AgentLoopTaskRecord;
  readonly modelOutcome: unknown;
  readonly decision: AgentLoopDecisionV1;
  readonly rejectedModelOutcome?: unknown;
}
export interface AgentLoopCorrectionProposalPublicationInput {
  readonly observeRecord: AgentLoopTaskRecord;
  readonly policy: AgentLoopModelCorrectionPolicy;
  readonly modelRecord: AgentLoopTaskRecord;
  readonly modelOutcome: unknown;
  readonly actionRecord: AgentLoopTaskRecord;
  readonly actionOutcome: unknown;
  readonly rejectedModelOutcome?: unknown;
}
export type AgentLoopCorrectionProposalHostBundle = ReturnType<typeof createAgentLoopMaintenanceCorrectionModel> & Readonly<{
  proposalCapability: AgentLoopCorrectionProposalCapability;
  createAction(input: AgentLoopCorrectionProposalActionInput): Readonly<{ act: AgentLoopCoordinatorPorts['act'] }>;
  publication?(input: AgentLoopCorrectionProposalPublicationInput): ReturnType<typeof createAgentLoopShadowPublication>;
}>;
export type AgentLoopMaintenanceCorrectionProposalFactory = (
  context: MaintenanceAgentLoopExecutionContext,
  step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0],
  lifetime: Readonly<{
    assertActive(): void;
    onPrepared(result: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>): void;
  }>,
) => Promise<AgentLoopCorrectionProposalHostBundle>;

/** A construction-time route choice, never a per-job selector or authority.
 * The factory stays lazy; `publication: required` is enforced on its returned
 * context-bound bundle before the first MODEL/ACT step. */
export interface AgentLoopMaintenanceExecutionProfile {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION;
  readonly route: 'correction-proposal';
  readonly publication: 'required';
  readonly correctionProposal: AgentLoopMaintenanceCorrectionProposalFactory;
}

/**
 * Post-ACT, pre-OBSERVE fact issued only by the exact Runtime that consumed the
 * genuine Service context. It is deliberately not a capability or readiness
 * token: public fields contain fixed versions and hashes, never identities,
 * content, functions, signals or host capabilities.
 */
export interface AgentLoopMaintenanceRuntimeContextObservation {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION;
  readonly compositionVersion: typeof AGENT_LOOP_SERVER_COMPOSITION_VERSION;
  readonly classification: 'runtime-instance-issued-context-observation';
  readonly observed: Readonly<{
    claimedContext: true;
    runtimeBundleValidated: true;
    actionClosed: true;
    publicationInstantiated: true;
    publicationValidated: true;
    timing: 'post-action-pre-observe';
  }>;
  readonly bindings: Readonly<{
    claimDigest: string;
    routePlanJobDigest: string;
    queuedJobDigest: string;
    routeContractVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION;
    routeContractDigest: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST;
    admissionPolicyVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion;
    executionPolicyVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion;
    acceptanceVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion;
    executionContractVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.contractVersion;
    executionProfileVersion: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION;
    route: 'correction-proposal';
    publication: 'required';
  }>;
  readonly redactions: Readonly<{
    contentIncluded: false;
    capabilityIncluded: false;
    identityIncluded: false;
  }>;
  readonly preClaimReady: false;
  readonly replayAuthorized: false;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
  readonly observationDigest: string;
}

interface RuntimeContextObservationBinding {
  readonly runtime: object;
  readonly context: object;
  readonly active: Set<AgentLoopMaintenanceRuntimeContextObservation>;
}

const RUNTIME_CONTEXT_OBSERVATION_BINDINGS =
  new WeakMap<object, RuntimeContextObservationBinding>();
const RUNTIME_CONTEXT_OBSERVATIONS =
  new WeakMap<object, Set<AgentLoopMaintenanceRuntimeContextObservation>>();

/**
 * One-use exact-Runtime exchange for the independent offline rehearsal. A
 * copied/cross-Runtime/already-consumed value returns null and grants nothing.
 */
export function consumeAgentLoopMaintenanceRuntimeContextObservation(
  runtime: unknown,
  evidence: unknown,
): AgentLoopMaintenanceRuntimeContextObservation | null {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function')
    || !evidence || typeof evidence !== 'object') return null;
  const binding = RUNTIME_CONTEXT_OBSERVATION_BINDINGS.get(evidence);
  const active = RUNTIME_CONTEXT_OBSERVATIONS.get(runtime as object);
  if (!binding || binding.runtime !== runtime || binding.active !== active
    || !active?.has(evidence as AgentLoopMaintenanceRuntimeContextObservation)) return null;
  active.delete(evidence as AgentLoopMaintenanceRuntimeContextObservation);
  RUNTIME_CONTEXT_OBSERVATION_BINDINGS.delete(evidence);
  return evidence as AgentLoopMaintenanceRuntimeContextObservation;
}

function contextObservationDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/** Rebuild the pristine p14 job header from the immutable first claim. */
function claimedRoutePlanJobBindings(
  context: MaintenanceAgentLoopExecutionContext,
): Readonly<{ routePlanJobDigest: string; queuedJobDigest: string }> | null {
  const execution = context.execution, job = execution.job;
  if (execution.executorRoute !== 'agent-loop' || job.status !== 'running'
    || job.attempt !== 1 || typeof job.startedAt !== 'string'
    || job.updatedAt !== job.startedAt || typeof job.parentRunId !== 'string'
    || Object.hasOwn(job, 'finishedAt') || Object.hasOwn(job, 'errorCode')
    || Object.hasOwn(job, 'budget') || Object.hasOwn(job, 'proposal')) return null;
  const candidate = Object.freeze({
    runId: job.runId,
    sessionId: job.sessionId,
    taskKind: job.taskKind,
    sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion,
    parentRunId: job.parentRunId,
    trigger: job.trigger,
    mode: job.mode,
    status: 'queued' as const,
    attempt: 0 as const,
    createdAt: job.createdAt,
    updatedAt: job.createdAt,
  });
  if (!matchesAgentLoopMaintenanceProductionRouteJob(candidate)) return null;
  const routePlanJobDigest = agentLoopMaintenanceCanaryRoutePlanV2JobDigest(candidate);
  const queuedJobDigest = agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(candidate);
  return routePlanJobDigest && queuedJobDigest
    ? Object.freeze({ routePlanJobDigest, queuedJobDigest })
    : null;
}

function createRuntimeContextObservation(
  context: MaintenanceAgentLoopExecutionContext,
): AgentLoopMaintenanceRuntimeContextObservation | null {
  const jobBindings = claimedRoutePlanJobBindings(context);
  if (!jobBindings) return null;
  const stable = {
    version: AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION,
    compositionVersion: AGENT_LOOP_SERVER_COMPOSITION_VERSION,
    classification: 'runtime-instance-issued-context-observation' as const,
    observed: Object.freeze({
      claimedContext: true as const,
      runtimeBundleValidated: true as const,
      actionClosed: true as const,
      publicationInstantiated: true as const,
      publicationValidated: true as const,
      timing: 'post-action-pre-observe' as const,
    }),
    bindings: Object.freeze({
      claimDigest: agentLoopMaintenanceClaimDigest(context.execution),
      routePlanJobDigest: jobBindings.routePlanJobDigest,
      queuedJobDigest: jobBindings.queuedJobDigest,
      routeContractVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION,
      routeContractDigest: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
      admissionPolicyVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion,
      executionPolicyVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion,
      acceptanceVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion,
      executionContractVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.contractVersion,
      executionProfileVersion: AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION,
      route: 'correction-proposal' as const,
      publication: 'required' as const,
    }),
    redactions: Object.freeze({
      contentIncluded: false as const,
      capabilityIncluded: false as const,
      identityIncluded: false as const,
    }),
    preClaimReady: false as const,
    replayAuthorized: false as const,
    claimAuthorized: false as const,
    executionAuthorized: false as const,
    completionAuthorized: false as const,
    publicationAuthorized: false as const,
    canaryAuthorized: false as const,
    productionEligible: false as const,
  };
  return Object.freeze({ ...stable, observationDigest: contextObservationDigest(stable) });
}

function bindRuntimeContextObservation(
  runtime: AgentLoopServerComposition,
  context: MaintenanceAgentLoopExecutionContext,
  active: Set<AgentLoopMaintenanceRuntimeContextObservation>,
): AgentLoopMaintenanceRuntimeContextObservation | null {
  const evidence = createRuntimeContextObservation(context);
  if (!evidence) return null;
  active.add(evidence);
  RUNTIME_CONTEXT_OBSERVATION_BINDINGS.set(evidence, Object.freeze({ runtime, context, active }));
  return evidence;
}

function revokeRuntimeContextObservation(
  evidence: AgentLoopMaintenanceRuntimeContextObservation | undefined,
): void {
  if (!evidence) return;
  const binding = RUNTIME_CONTEXT_OBSERVATION_BINDINGS.get(evidence);
  binding?.active.delete(evidence);
  RUNTIME_CONTEXT_OBSERVATION_BINDINGS.delete(evidence);
}

function revokeRuntimeContextObservations(runtime: AgentLoopServerComposition): void {
  const active = RUNTIME_CONTEXT_OBSERVATIONS.get(runtime);
  RUNTIME_CONTEXT_OBSERVATIONS.delete(runtime);
  if (!active) return;
  for (const evidence of active) RUNTIME_CONTEXT_OBSERVATION_BINDINGS.delete(evidence);
  active.clear();
}

export interface AgentLoopServerCompositionOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  readonly readers: AgentLoopShadowSourceReaders;
  /** Separately selected readonly leaf scope. Default Runtime and Maintenance/Canary surfaces remain unchanged. */
  readonly rpReadonlyExecution?: AgentLoopRpReadonlyExecutionConfig;
  /** Synchronous source/permission readback for metadata-only suspension. Absent means unavailable. */
  readonly taskSuspension?: Readonly<{
    assertAccess(record: AgentLoopTaskRecord, operation: 'suspend' | 'resume'): void;
    readEvidence(request: AgentLoopTaskResumeRequest, record: AgentLoopTaskRecord): AgentLoopTaskResumeEvidence | null;
  }>;
  /** Isolated acceptance only. When present, this exact Manager replaces both
   * maintenance source and execution reads inside the Runtime. Ordinary
   * Runtime composition remains unchanged and cannot issue a Canary port. */
  readonly isolatedCanaryManager?: MaintenanceJobManager;
  /** Read-only preview only. Never admits, advances or dispatches a model. */
  readonly maintenancePrepareSource?: AgentLoopMaintenancePrepareOptions['readSource'];
  /** Lazy actual host ports. No admission switch, replacement Coordinator or authority-bearing DTO. */
  readonly maintenanceExecution?: Readonly<{
    /** Explicit mutually exclusive profile. Existing single-pass ports may be
     * installed beside it but are inactive while this profile is selected. */
    executionProfile?: AgentLoopMaintenanceExecutionProfile;
    /** Best-effort synchronous handoff to an offline evidence binder. It never
     * participates in execution and any thrown/async result is ignored. */
    observeCorrectionProposalEvidence?: (
      evidence: AgentLoopMaintenanceRuntimeContextObservation,
    ) => void;
    readExecution(runId: string): MaintenanceExecutionRecord | null;
    prepare(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]): ReturnType<AgentLoopCoordinatorPorts['prepare']>;
    decide(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['decide']>[0]): ReturnType<AgentLoopCoordinatorPorts['decide']>;
    /** Explicit shadow MODEL-only route, mutually exclusive with all Action
     * hosts. Real initial Prepare commits before this returns its model bundle.
     * Both callbacks are synchronous; assertActive is AL-read-free for Store TX. */
    modelCorrection?(context: MaintenanceAgentLoopExecutionContext,
      step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0], lifetime: Readonly<{
        assertActive(): void;
        onPrepared(result: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>): void;
      }>): Promise<ReturnType<typeof createAgentLoopMaintenanceCorrectionModel>>;
    /** Independent shadow-only correction + one proposal ACT. Publication is
     * separately explicit in its returned bundle; absence still stops at OBSERVE. */
    correctionProposal?: AgentLoopMaintenanceCorrectionProposalFactory;
    /** Trusted host ports only, not an ENV/DTO enable switch. The Prepare brand remains mandatory. */
    getVariables?: Readonly<{
      prepare(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]): ReturnType<AgentLoopCoordinatorPorts['prepare']>;
      act(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['act']>[0]): ReturnType<AgentLoopCoordinatorPorts['act']>;
    }>;
    /** Separate shadow-only initial write grant. A publication host may coexist with
     * the read route: only a trusted shadow claim selects the proposal completion route. */
    rollingSummaryProposal?: Readonly<{
      prepare(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]): ReturnType<AgentLoopCoordinatorPorts['prepare']>;
      act(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['act']>[0]): ReturnType<AgentLoopCoordinatorPorts['act']>;
      publication?(context: MaintenanceAgentLoopExecutionContext, step: Readonly<{
        envelope: AgentLoopTaskEnvelopeV1; revision: number;
      }>): ReturnType<typeof createAgentLoopShadowPublication>;
    }>;
    /** Apply has a separate trusted MODEL mapping and retains its Prepare brand
     * until the native Action consumes it. Completion is separately explicit. */
    rollingSummaryApply?: Readonly<{
      prepare(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]): ReturnType<AgentLoopCoordinatorPorts['prepare']>;
      decide(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['decide']>[0], capability: AgentLoopRollingSummaryApplyCapability): ReturnType<AgentLoopCoordinatorPorts['decide']>;
      act(context: MaintenanceAgentLoopExecutionContext, step: Parameters<AgentLoopCoordinatorPorts['act']>[0], capability: AgentLoopRollingSummaryApplyCapability): ReturnType<AgentLoopCoordinatorPorts['act']>;
      completion?(context: MaintenanceAgentLoopExecutionContext, step: Readonly<{
        envelope: AgentLoopTaskEnvelopeV1; revision: number;
      }>): ReturnType<typeof createAgentLoopSummaryApplyCompletion>;
    }>;
  }>;
}
export interface AgentLoopServerCompositionStats {
  readonly version: typeof AGENT_LOOP_SERVER_COMPOSITION_VERSION;
  readonly accepted: number;
  readonly dropped: number;
  readonly errors: number;
  readonly skipped: number;
  readonly created: number;
  readonly settled: number;
  readonly probes: number;
  readonly blockedProbes: number;
  readonly prepareCandidates: number;
  readonly prepareErrors: number;
  readonly pending: number;
  readonly active: 0 | 1;
  readonly closed: boolean;
}
export interface AgentLoopTaskSuspensionPort {
  suspendTask(input: Omit<AgentLoopTaskSuspendRequest, 'ownerId'>): AgentLoopTaskRecord;
  resumeTask(input: Omit<AgentLoopTaskResumeRequest, 'ownerId' | 'leaseMs'>): AgentLoopTaskResumeResult;
}
const TASK_SUSPENSION_PORTS = new WeakMap<object, AgentLoopTaskSuspensionPort>();
export function createAgentLoopTaskSuspensionPort(runtime: unknown): AgentLoopTaskSuspensionPort {
  const port = runtime && typeof runtime === 'object' ? TASK_SUSPENSION_PORTS.get(runtime) : undefined;
  if (!port) throw new Error('agent-loop-suspension-unavailable');
  return port;
}

export interface AgentLoopServerComposition {
  observeTurnJobPhase(input: Readonly<{ runId: string; phase: TurnPhase }>): void;
  observeMaintenanceJobPhase(input: Readonly<{ runId: string; phase: MaintenancePhase }>): void;
  /** Internal Service capability only; production Service admission is separately fixed closed. */
  executeMaintenance(context: MaintenanceAgentLoopExecutionContext): Promise<void>;
  /** Installed implementation only: no source/Policy readiness, legacy parity,
   * first-response guarantee, admission, execution or Canary authority. */
  inspectMaintenanceExecutionSupport(input: Readonly<{
    taskKind: string; mode: 'shadow' | 'apply'; protocol: 'single-pass' | 'legacy-bounded';
  }>): AgentLoopMaintenanceExecutionSupport;
  /** Distinct lazy correction factory declaration, never bundle/publication
   * readiness or an invocation of that factory. The original inspector is unchanged. */
  inspectMaintenanceCorrectionSupport(input: Readonly<{
    taskKind: string; mode: 'shadow' | 'apply'; protocol: 'correction-once' | 'legacy-bounded';
  }>): AgentLoopMaintenanceCorrectionSupport;
  whenIdle(): Promise<void>;
  /** Stop new admission, then join accepted metadata and physical execution tails. Does not close the Service/Store. */
  close(): Promise<void>;
  stats(): AgentLoopServerCompositionStats;
}

/**
 * Exact-Runtime execution bridge for the isolated production-isomorphic
 * acceptance harness. It is deliberately distinct from ordinary structural
 * Maintenance ports so a caller cannot manufacture Canary admission.
 */
export interface AgentLoopMaintenanceIsolatedCanaryExecutionPort
  extends MaintenanceAgentLoopExecutionPort {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_ISOLATED_CANARY_EXECUTION_PORT_VERSION;
  readonly scope: 'isolated-canary-acceptance';
  readonly store: AgentLoopProjectionStore;
  readonly canClaim: (job: PublicMaintenanceJob) => boolean;
  readonly execute: (context: MaintenanceAgentLoopExecutionContext) => Promise<void>;
}

/**
 * Exact Runtime/Manager execution bridge for the first production cohort.
 * Binding is a one-time operation on a pristine Runtime and is deliberately
 * distinct from the isolated acceptance port.
 */
export interface AgentLoopMaintenanceProductionCanaryExecutionPort
  extends MaintenanceAgentLoopExecutionPort {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_EXECUTION_PORT_VERSION;
  readonly scope: 'production-canary-5';
  readonly store: AgentLoopProjectionStore;
  readonly canClaim: (job: PublicMaintenanceJob) => boolean;
  readonly execute: (context: MaintenanceAgentLoopExecutionContext) => Promise<void>;
}

/**
 * Exact-instance construction fact only. This does not inspect a lazy host
 * result and is never a capability, readiness grant or rollout authority.
 */
export interface AgentLoopServerCompositionCapabilityManifest {
  readonly version: typeof AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION;
  readonly compositionVersion: typeof AGENT_LOOP_SERVER_COMPOSITION_VERSION;
  readonly classification: 'runtime-instance-issued-construction-manifest';
  readonly routeContract: Readonly<{
    version: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION;
    digest: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST;
    acceptanceVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion;
    contractVersion: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.contractVersion;
  }>;
  readonly captured: Readonly<{
    executionProfile: Readonly<{
      version: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION;
      route: 'correction-proposal';
      publication: 'required';
    }> | null;
    readExecution: boolean;
    correctionProposalFactory: boolean;
    publicationRequiredByRuntime: boolean;
  }>;
  readonly readiness: Readonly<{
    runtimeBundle: Readonly<{
      status: 'correction-proposal-factory-not-captured' | 'context-bound-bundle-not-instantiated';
      contextBoundBundleInstantiated: false;
      productionReady: false;
    }>;
    publication: Readonly<{
      status: 'runtime-does-not-require-publication' | 'context-bound-publication-not-instantiated';
      contextBoundPublicationInstantiated: false;
      productionReady: false;
    }>;
  }>;
  readonly structurallyReady: boolean;
  readonly reasonCodes: readonly (
    | 'correction-proposal-factory-not-captured'
    | 'context-bound-runtime-bundle-not-instantiated'
    | 'runtime-does-not-require-publication'
    | 'context-bound-publication-not-instantiated'
  )[];
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
}

const CAPABILITY_MANIFEST_BY_RUNTIME = new WeakMap<object, AgentLoopServerCompositionCapabilityManifest>();
const CAPABILITY_MANIFEST_OWNER = new WeakMap<object, object>();
const STORE_BY_RUNTIME = new WeakMap<object, AgentLoopProjectionStore>();
const ISOLATED_CANARY_MANAGER_BY_RUNTIME = new WeakMap<object, MaintenanceJobManager>();
const ISOLATED_CANARY_EXECUTION_PORTS = new WeakSet<object>();
const RUNTIME_BY_ISOLATED_CANARY_EXECUTION_PORT =
  new WeakMap<object, AgentLoopServerComposition>();
const MANAGER_BY_ISOLATED_CANARY_EXECUTION_PORT =
  new WeakMap<object, MaintenanceJobManager>();
interface ProductionCanaryRuntimeBindingState {
  readonly ownerId: string;
  readonly clock: () => string;
  manager: MaintenanceJobManager | null;
  onProjectionReady: ((input: Readonly<{ runId: string }>) => void) | null;
  bound: boolean;
  closed: boolean;
}
const PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME =
  new WeakMap<object, ProductionCanaryRuntimeBindingState>();
const PRODUCTION_CANARY_MANAGER_BY_RUNTIME =
  new WeakMap<object, MaintenanceJobManager>();
const PRODUCTION_CANARY_RUNTIME_BY_MANAGER =
  new WeakMap<object, AgentLoopServerComposition>();
const PRODUCTION_CANARY_EXECUTION_PORTS = new WeakSet<object>();
const PRODUCTION_CANARY_EXECUTION_PORT_BY_RUNTIME =
  new WeakMap<object, AgentLoopMaintenanceProductionCanaryExecutionPort>();
const RUNTIME_BY_PRODUCTION_CANARY_EXECUTION_PORT =
  new WeakMap<object, AgentLoopServerComposition>();
const MANAGER_BY_PRODUCTION_CANARY_EXECUTION_PORT =
  new WeakMap<object, MaintenanceJobManager>();

function runtimeOwnsProjectionLease(
  runtime: AgentLoopServerComposition,
  record: AgentLoopTaskRecord,
): boolean {
  const binding = PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME.get(runtime);
  if (!binding || record.ownerId !== binding.ownerId || record.leaseExpiresAt === null) return false;
  const now = Date.parse(binding.clock());
  const expiresAt = Date.parse(record.leaseExpiresAt);
  return Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt > now;
}

function objectIdentity(value: unknown): object | null {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? value as object : null;
}

function createCapabilityManifest(input: Readonly<{
  executionProfile: Readonly<{
    version: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION;
    route: 'correction-proposal';
    publication: 'required';
  }> | null;
  readExecution: boolean;
  correctionProposalFactory: boolean;
  publicationRequiredByRuntime: boolean;
}>): AgentLoopServerCompositionCapabilityManifest {
  const routeContract = Object.freeze({
    version: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION,
    digest: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
    acceptanceVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion,
    contractVersion: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.contractVersion,
  });
  const executionProfile = input.executionProfile ? Object.freeze({
    version: input.executionProfile.version,
    route: input.executionProfile.route,
    publication: input.executionProfile.publication,
  }) : null;
  const captured = Object.freeze({
    executionProfile,
    readExecution: input.readExecution,
    correctionProposalFactory: input.correctionProposalFactory,
    publicationRequiredByRuntime: input.publicationRequiredByRuntime,
  });
  const readiness = Object.freeze({
    runtimeBundle: Object.freeze({
      status: input.correctionProposalFactory
        ? 'context-bound-bundle-not-instantiated' as const
        : 'correction-proposal-factory-not-captured' as const,
      contextBoundBundleInstantiated: false as const,
      productionReady: false as const,
    }),
    publication: Object.freeze({
      status: input.publicationRequiredByRuntime
        ? 'context-bound-publication-not-instantiated' as const
        : 'runtime-does-not-require-publication' as const,
      contextBoundPublicationInstantiated: false as const,
      productionReady: false as const,
    }),
  });
  const reasonCodes = Object.freeze([
    ...(!input.correctionProposalFactory ? ['correction-proposal-factory-not-captured' as const] : []),
    'context-bound-runtime-bundle-not-instantiated' as const,
    ...(input.publicationRequiredByRuntime
      ? [] : ['runtime-does-not-require-publication' as const]),
    'context-bound-publication-not-instantiated' as const,
  ]);
  const structurallyReady = input.executionProfile !== null
    && input.readExecution
    && input.correctionProposalFactory
    && input.publicationRequiredByRuntime;
  return Object.freeze({
    version: AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION,
    compositionVersion: AGENT_LOOP_SERVER_COMPOSITION_VERSION,
    classification: 'runtime-instance-issued-construction-manifest' as const,
    routeContract,
    captured,
    readiness,
    structurallyReady,
    reasonCodes,
    claimAuthorized: false as const,
    executionAuthorized: false as const,
    completionAuthorized: false as const,
    publicationAuthorized: false as const,
    canaryAuthorized: false as const,
    productionEligible: false as const,
  });
}

/** Read the immutable construction fact for this exact open Runtime instance. */
export function readAgentLoopServerCompositionCapabilityManifest(
  runtime: unknown,
): AgentLoopServerCompositionCapabilityManifest | null {
  const identity = objectIdentity(runtime);
  return identity ? CAPABILITY_MANIFEST_BY_RUNTIME.get(identity) ?? null : null;
}

/** Reject copied/fabricated manifests and manifests issued by another Runtime. */
export function isAgentLoopServerCompositionCapabilityManifest(
  runtime: unknown,
  manifest: unknown,
): manifest is AgentLoopServerCompositionCapabilityManifest {
  const runtimeIdentity = objectIdentity(runtime), manifestIdentity = objectIdentity(manifest);
  return !!runtimeIdentity && !!manifestIdentity
    && CAPABILITY_MANIFEST_BY_RUNTIME.get(runtimeIdentity) === manifestIdentity
    && CAPABILITY_MANIFEST_OWNER.get(manifestIdentity) === runtimeIdentity;
}

function bindCapabilityManifest(
  runtime: AgentLoopServerComposition,
  manifest: AgentLoopServerCompositionCapabilityManifest,
): void {
  CAPABILITY_MANIFEST_BY_RUNTIME.set(runtime, manifest);
  CAPABILITY_MANIFEST_OWNER.set(manifest, runtime);
}

function revokeCapabilityManifest(runtime: AgentLoopServerComposition): void {
  const manifest = CAPABILITY_MANIFEST_BY_RUNTIME.get(runtime);
  CAPABILITY_MANIFEST_BY_RUNTIME.delete(runtime);
  if (manifest) CAPABILITY_MANIFEST_OWNER.delete(manifest);
}

function isOpenIsolatedCanaryRuntime(
  runtime: AgentLoopServerComposition,
  store: AgentLoopProjectionStore,
  manager: MaintenanceJobManager,
): boolean {
  const manifest = CAPABILITY_MANIFEST_BY_RUNTIME.get(runtime);
  return STORE_BY_RUNTIME.get(runtime) === store
    && ISOLATED_CANARY_MANAGER_BY_RUNTIME.get(runtime) === manager
    && isOpenMaintenanceJobManagerInstanceInternal(manager)
    && !!manifest
    && isAgentLoopServerCompositionCapabilityManifest(runtime, manifest)
    && manifest.structurallyReady
    && manifest.captured.executionProfile?.route === 'correction-proposal'
    && manifest.captured.executionProfile.publication === 'required'
    && manifest.captured.correctionProposalFactory
    && manifest.captured.publicationRequiredByRuntime
    && runtime.stats().closed === false;
}

/** Exact process-local brand; structural copies and Proxies grant nothing. */
export function isAgentLoopMaintenanceIsolatedCanaryExecutionPort(
  value: unknown,
): value is AgentLoopMaintenanceIsolatedCanaryExecutionPort {
  return typeof value === 'object' && value !== null
    && ISOLATED_CANARY_EXECUTION_PORTS.has(value)
    && RUNTIME_BY_ISOLATED_CANARY_EXECUTION_PORT.has(value);
}

/** Exact process-local port/Manager identity; matching job bytes grant nothing. */
export function isAgentLoopMaintenanceIsolatedCanaryExecutionPortForManager(
  value: unknown,
  manager: MaintenanceJobManager,
): value is AgentLoopMaintenanceIsolatedCanaryExecutionPort {
  if (!isOpenMaintenanceJobManagerInstanceInternal(manager)
    || !isAgentLoopMaintenanceIsolatedCanaryExecutionPort(value)
    || MANAGER_BY_ISOLATED_CANARY_EXECUTION_PORT.get(value) !== manager) return false;
  const runtime = RUNTIME_BY_ISOLATED_CANARY_EXECUTION_PORT.get(value);
  const store = runtime ? STORE_BY_RUNTIME.get(runtime) : undefined;
  return !!runtime && !!store && isOpenIsolatedCanaryRuntime(runtime, store, manager);
}

/**
 * Issue an isolated-Canary port only from the exact open Runtime whose branded
 * construction manifest captured the correction-proposal/required-publication
 * profile. No manifest field alone is accepted as authority.
 */
export function createAgentLoopMaintenanceIsolatedCanaryExecutionPort(
  runtime: AgentLoopServerComposition,
  manager: MaintenanceJobManager,
): AgentLoopMaintenanceIsolatedCanaryExecutionPort {
  const store = STORE_BY_RUNTIME.get(runtime);
  if (!store || !isMaintenanceJobManagerInstanceInternal(manager)
    || !isOpenIsolatedCanaryRuntime(runtime, store, manager)) {
    throw new Error('agent-loop-maintenance-isolated-canary-execution-port-invalid');
  }
  const port: AgentLoopMaintenanceIsolatedCanaryExecutionPort = Object.freeze({
    version: AGENT_LOOP_MAINTENANCE_ISOLATED_CANARY_EXECUTION_PORT_VERSION,
    scope: 'isolated-canary-acceptance' as const,
    store,
    canClaim: (job: PublicMaintenanceJob): boolean => {
      if (!isOpenIsolatedCanaryRuntime(runtime, store, manager)
        || !matchesAgentLoopMaintenanceProductionRouteJob(job)) return false;
      try {
        const expectedDigest = agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(job);
        const current = manager.get(job.runId);
        if (!expectedDigest || !current
          || agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(current) !== expectedDigest) return false;
        const record = store.read(`agentloop.maintenance.${job.runId}`);
        const active = !!record
          && !record.fenced
          && runtimeOwnsProjectionLease(runtime, record)
          && isPristineShadowProjection(store, record)
          && shadowJobSourceState(record.envelope, {
            readTurnJob: () => null,
            readMaintenanceJob: (runId: string) => runId === job.runId ? manager.get(runId) : null,
          }) === 'active';
        const after = manager.get(job.runId);
        return active && !!after
          && agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(after) === expectedDigest
          && isOpenIsolatedCanaryRuntime(runtime, store, manager);
      } catch {
        return false;
      }
    },
    execute: (context: MaintenanceAgentLoopExecutionContext): Promise<void> => {
      try {
        const current = manager.readExecution(context.execution.job.runId);
        if (!current || !sameMaintenanceAgentLoopClaim(context.execution, current)
          || current.executorRoute !== 'agent-loop'
          || !isOpenIsolatedCanaryRuntime(runtime, store, manager)) {
          return Promise.reject(new Error(EXECUTION_DISABLED));
        }
      } catch {
        return Promise.reject(new Error(EXECUTION_DISABLED));
      }
      return runtime.executeMaintenance(context);
    },
  });
  ISOLATED_CANARY_EXECUTION_PORTS.add(port);
  RUNTIME_BY_ISOLATED_CANARY_EXECUTION_PORT.set(port, runtime);
  MANAGER_BY_ISOLATED_CANARY_EXECUTION_PORT.set(port, manager);
  return port;
}

function pristineProductionCanaryRuntime(
  runtime: AgentLoopServerComposition,
): boolean {
  const stats = runtime.stats();
  return stats.closed === false
    && stats.accepted === 0
    && stats.dropped === 0
    && stats.errors === 0
    && stats.skipped === 0
    && stats.created === 0
    && stats.settled === 0
    && stats.probes === 0
    && stats.blockedProbes === 0
    && stats.prepareCandidates === 0
    && stats.prepareErrors === 0
    && stats.pending === 0
    && stats.active === 0;
}

function isOpenProductionCanaryRuntime(
  runtime: AgentLoopServerComposition,
  store: AgentLoopProjectionStore,
  manager: MaintenanceJobManager,
): boolean {
  const manifest = CAPABILITY_MANIFEST_BY_RUNTIME.get(runtime);
  const binding = PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME.get(runtime);
  return STORE_BY_RUNTIME.get(runtime) === store
    && binding?.bound === true
    && binding.closed === false
    && binding.manager === manager
    && PRODUCTION_CANARY_MANAGER_BY_RUNTIME.get(runtime) === manager
    && PRODUCTION_CANARY_RUNTIME_BY_MANAGER.get(manager) === runtime
    && isOpenMaintenanceJobManagerInstanceInternal(manager)
    && !!manifest
    && isAgentLoopServerCompositionCapabilityManifest(runtime, manifest)
    && manifest.structurallyReady
    && manifest.captured.executionProfile?.route === 'correction-proposal'
    && manifest.captured.executionProfile.publication === 'required'
    && manifest.captured.correctionProposalFactory
    && manifest.captured.publicationRequiredByRuntime
    && runtime.stats().closed === false;
}

/** Exact process-local brand; structural copies, Proxies and closed bindings grant nothing. */
export function isAgentLoopMaintenanceProductionCanaryExecutionPort(
  value: unknown,
): value is AgentLoopMaintenanceProductionCanaryExecutionPort {
  if (typeof value !== 'object' || value === null
    || !PRODUCTION_CANARY_EXECUTION_PORTS.has(value)) return false;
  const runtime = RUNTIME_BY_PRODUCTION_CANARY_EXECUTION_PORT.get(value);
  const manager = MANAGER_BY_PRODUCTION_CANARY_EXECUTION_PORT.get(value);
  const store = runtime ? STORE_BY_RUNTIME.get(runtime) : undefined;
  return !!runtime && !!manager && !!store
    && PRODUCTION_CANARY_EXECUTION_PORT_BY_RUNTIME.get(runtime) === value
    && isOpenProductionCanaryRuntime(runtime, store, manager);
}

/** Exact process-local port/Manager identity; matching job bytes grant nothing. */
export function isAgentLoopMaintenanceProductionCanaryExecutionPortForManager(
  value: unknown,
  manager: MaintenanceJobManager,
): value is AgentLoopMaintenanceProductionCanaryExecutionPort {
  return isOpenMaintenanceJobManagerInstanceInternal(manager)
    && isAgentLoopMaintenanceProductionCanaryExecutionPort(value)
    && MANAGER_BY_PRODUCTION_CANARY_EXECUTION_PORT.get(value) === manager;
}

/**
 * One-shot late binding for the existing production Runtime. The Runtime must
 * still be pristine and its exact construction manifest must already prove the
 * correction-proposal/required-publication profile. Once bound, both internal
 * maintenance reads are forced through this Manager until Runtime close.
 */
export function bindAgentLoopMaintenanceProductionCanaryExecutionPort(
  runtime: AgentLoopServerComposition,
  manager: MaintenanceJobManager,
  onProjectionReady?: (input: Readonly<{ runId: string }>) => void,
): AgentLoopMaintenanceProductionCanaryExecutionPort {
  const store = STORE_BY_RUNTIME.get(runtime);
  const manifest = CAPABILITY_MANIFEST_BY_RUNTIME.get(runtime);
  const binding = PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME.get(runtime);
  if (!store || !binding || binding.bound || binding.closed
    || (onProjectionReady !== undefined
      && (typeof onProjectionReady !== 'function' || nodeTypes.isProxy(onProjectionReady)))
    || ISOLATED_CANARY_MANAGER_BY_RUNTIME.has(runtime)
    || PRODUCTION_CANARY_MANAGER_BY_RUNTIME.has(runtime)
    || PRODUCTION_CANARY_RUNTIME_BY_MANAGER.has(manager)
    || !isOpenMaintenanceJobManagerInstanceInternal(manager)
    || !manifest
    || !isAgentLoopServerCompositionCapabilityManifest(runtime, manifest)
    || !manifest.structurallyReady
    || !pristineProductionCanaryRuntime(runtime)) {
    throw new Error('agent-loop-maintenance-production-canary-execution-port-invalid');
  }

  binding.bound = true;
  binding.manager = manager;
  binding.onProjectionReady = onProjectionReady ?? null;
  PRODUCTION_CANARY_MANAGER_BY_RUNTIME.set(runtime, manager);
  PRODUCTION_CANARY_RUNTIME_BY_MANAGER.set(manager, runtime);
  const port: AgentLoopMaintenanceProductionCanaryExecutionPort = Object.freeze({
    version: AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_EXECUTION_PORT_VERSION,
    scope: 'production-canary-5' as const,
    store,
    canClaim: (job: PublicMaintenanceJob): boolean => {
      if (!isOpenProductionCanaryRuntime(runtime, store, manager)
        || !matchesAgentLoopMaintenanceProductionRouteJob(job)) return false;
      try {
        const expectedDigest = agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(job);
        const current = manager.get(job.runId);
        if (!expectedDigest || !current
          || agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(current) !== expectedDigest) return false;
        const record = store.read(`agentloop.maintenance.${job.runId}`);
        const active = !!record
          && !record.fenced
          && runtimeOwnsProjectionLease(runtime, record)
          && isPristineShadowProjection(store, record)
          && shadowJobSourceState(record.envelope, {
            readTurnJob: () => null,
            readMaintenanceJob: (runId: string) => runId === job.runId ? manager.get(runId) : null,
          }) === 'active';
        const after = manager.get(job.runId);
        return active && !!after
          && agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(after) === expectedDigest
          && isOpenProductionCanaryRuntime(runtime, store, manager);
      } catch {
        return false;
      }
    },
    execute: (context: MaintenanceAgentLoopExecutionContext): Promise<void> => {
      try {
        const current = manager.readExecution(context.execution.job.runId);
        if (!current || !sameMaintenanceAgentLoopClaim(context.execution, current)
          || current.executorRoute !== 'agent-loop'
          || !isOpenProductionCanaryRuntime(runtime, store, manager)) {
          return Promise.reject(new Error(EXECUTION_DISABLED));
        }
      } catch {
        return Promise.reject(new Error(EXECUTION_DISABLED));
      }
      return runtime.executeMaintenance(context);
    },
  });
  PRODUCTION_CANARY_EXECUTION_PORTS.add(port);
  PRODUCTION_CANARY_EXECUTION_PORT_BY_RUNTIME.set(runtime, port);
  RUNTIME_BY_PRODUCTION_CANARY_EXECUTION_PORT.set(port, runtime);
  MANAGER_BY_PRODUCTION_CANARY_EXECUTION_PORT.set(port, manager);
  return port;
}

function denyWrite(_input: unknown): never { throw new Error(EXECUTION_DISABLED); }
async function denyExecution(): Promise<never> { throw new Error(EXECUTION_DISABLED); }

const PROFILE_INTRINSIC_PROMISE = Promise;
const PROFILE_INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const PROFILE_INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
function observeRejectedProfilePromise(input: unknown): void {
  if (!nodeTypes.isPromise(input) || nodeTypes.isProxy(input)) return;
  const originalConstructor = Object.getOwnPropertyDescriptor(input, 'constructor');
  const constructor = Object.getOwnPropertyDescriptor(PROFILE_INTRINSIC_PROMISE.prototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(PROFILE_INTRINSIC_PROMISE, Symbol.species);
  if (!constructor || !Object.hasOwn(constructor, 'value') || constructor.value !== PROFILE_INTRINSIC_PROMISE
    || !species || species.get !== PROFILE_INTRINSIC_PROMISE_SPECIES || species.set !== undefined) return;

  let shadowedConstructor = false;
  try {
    if (!originalConstructor && Object.getPrototypeOf(input) === PROFILE_INTRINSIC_PROMISE.prototype) {
      void PROFILE_INTRINSIC_PROMISE_THEN.call(input, () => undefined, () => undefined);
      return;
    }
    if (!originalConstructor || originalConstructor.configurable
      || (Object.hasOwn(originalConstructor, 'value') && originalConstructor.writable === true)) {
      // Promise.prototype.then consults constructor/@@species. Temporarily
      // pinning the intrinsic constructor observes safely reachable genuine
      // Promise subclasses/foreign-realm Promises without invoking their hooks.
      Object.defineProperty(input, 'constructor', {
        configurable: originalConstructor?.configurable ?? true,
        enumerable: originalConstructor?.enumerable ?? false,
        value: PROFILE_INTRINSIC_PROMISE,
        writable: originalConstructor && Object.hasOwn(originalConstructor, 'value')
          ? originalConstructor.writable
          : true,
      });
      shadowedConstructor = true;
    } else if (!Object.hasOwn(originalConstructor, 'value')
      || originalConstructor.value !== PROFILE_INTRINSIC_PROMISE) {
      return;
    }
    void PROFILE_INTRINSIC_PROMISE_THEN.call(input, () => undefined, () => undefined);
  } catch {
    // The value remains invalid synchronous profile data.
  } finally {
    if (shadowedConstructor) {
      try {
        if (originalConstructor) Object.defineProperty(input, 'constructor', originalConstructor);
        else Reflect.deleteProperty(input, 'constructor');
      } catch {
        // Genuine non-Proxy Promises have ordinary property semantics.
      }
    }
  }
}
function invalidExecutionProfile(): never { throw new Error('agent-loop-composition-options-invalid'); }
function executionProfileOf(input: unknown): AgentLoopMaintenanceExecutionProfile {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) invalidExecutionProfile();
  if (nodeTypes.isPromise(input)) { observeRejectedProfilePromise(input); invalidExecutionProfile(); }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidExecutionProfile();
  const keys = ['version', 'route', 'publication', 'correctionProposal'] as const;
  const actual = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key as typeof keys[number]))) {
    invalidExecutionProfile();
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidExecutionProfile();
  }
  const value = input as Record<string, unknown>, factory = descriptors.correctionProposal!.value;
  if (value.version !== AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION
    || value.route !== 'correction-proposal' || value.publication !== 'required') invalidExecutionProfile();
  if (nodeTypes.isPromise(factory)) { observeRejectedProfilePromise(factory); invalidExecutionProfile(); }
  if (typeof factory !== 'function' || nodeTypes.isProxy(factory)) invalidExecutionProfile();
  return Object.freeze({
    version: AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION,
    route: 'correction-proposal',
    publication: 'required',
    correctionProposal: factory as AgentLoopMaintenanceCorrectionProposalFactory,
  });
}

function isolatedCanaryManagerOption(
  options: AgentLoopServerCompositionOptions,
): MaintenanceJobManager | null {
  if (nodeTypes.isProxy(options)) throw new Error('agent-loop-composition-options-invalid');
  let property: PropertyDescriptor | undefined;
  try {
    property = Object.getOwnPropertyDescriptor(options, 'isolatedCanaryManager');
    for (let prototype = Object.getPrototypeOf(options); prototype !== null;
      prototype = Object.getPrototypeOf(prototype)) {
      if (nodeTypes.isProxy(prototype)
        || Object.hasOwn(prototype, 'isolatedCanaryManager')) {
        throw new Error('agent-loop-composition-options-invalid');
      }
    }
  } catch {
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (!property) return null;
  if (!property.enumerable || !Object.hasOwn(property, 'value')
    || property.get !== undefined || property.set !== undefined) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (nodeTypes.isPromise(property.value)) {
    observeRejectedProfilePromise(property.value);
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (!isOpenMaintenanceJobManagerInstanceInternal(property.value)) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  return property.value;
}

/** Fixed declarations only: there is no extension injection or guard-disable production option. */
function assemblyExtensions(allowed: (hook: string, context: Readonly<Record<string, unknown>>) => boolean): AgentLoopExtension[] {
  return AGENT_LOOP_HOOKS.flatMap((hook) => AGENT_LOOP_HOOK_PHASES.map((phase): AgentLoopExtension => ({
    declaration: {
      id: `host.assembly.${hook}.${phase}`, version: '1.0.0', hook, phase,
      dependsOn: [], readSet: ['taskId', 'revision', 'taskKind'], writeSet: [],
      requiresAuthorities: [], requirement: 'required', timeoutMs: 1_000,
    },
    run: async (input) => hook !== 'task-create' && phase === 'before' && !allowed(hook, input)
      ? { kind: 'short-circuit', reasonCode: EXECUTION_DISABLED } : { kind: 'allow' },
  })));
}

function createContext(envelope: AgentLoopTaskEnvelopeV1): Readonly<Record<string, unknown>> {
  return Object.freeze({ taskId: envelope.taskId, revision: envelope.revision,
    taskKind: envelope.taskKind, state: envelope.state, phase: envelope.phase,
    taskContractRef: envelope.taskContractRef, grantedAuthorities: Object.freeze([]) });
}
function assertReadOnlyHook(outcome: AgentLoopExtensionHookOutcome): void {
  if (!outcome.ok || outcome.shortCircuit || outcome.patches.length > 0 || outcome.observations.length > 0) {
    throw new Error('agent-loop-task-create-hook-rejected');
  }
}
function active(source: Source): boolean {
  return source.job.status === 'queued' || source.job.status === 'running';
}
function terminal(source: Source): boolean {
  return source.job.status === 'succeeded' || source.job.status === 'failed' || source.job.status === 'cancelled'
    || (source.family === 'maintenance' && source.job.status === 'stale');
}
/** Ephemeral immutable header check only, not an execution/admission authority or persisted DTO copy. */
function sourceIdentity(source: Source): string {
  const common = [source.family, source.job.runId, source.job.sessionId, source.job.createdAt];
  return JSON.stringify(source.family === 'turn'
    ? [...common, source.job.action, source.job.requestId]
    : [...common, source.job.taskKind, source.job.sourceRevision, source.job.policyVersion,
      source.job.mode, source.job.trigger, source.job.parentRunId ?? null]);
}
function projectionOf(source: Source): ShadowTurnJobProjectionV1 {
  return source.family === 'turn'
    ? buildShadowTurnJobEnvelope({ job: source.job, now: source.job.createdAt })
    : buildShadowMaintenanceJobEnvelope({ job: source.job, now: source.job.createdAt });
}
/** Header-only lookup also accepts terminal sources; the projection builders intentionally do not. */
function sourceTaskId(source: Source): string { return `agentloop.${source.family}.${source.job.runId}`; }

export function createAgentLoopServerComposition(options: AgentLoopServerCompositionOptions): AgentLoopServerComposition {
  if (!RUN_ID.test(options.ownerId) || typeof options.clock !== 'function'
    || typeof options.readers.readTurnJob !== 'function' || typeof options.readers.readMaintenanceJob !== 'function') {
    throw new Error('agent-loop-composition-options-invalid');
  }
  const isolatedCanaryManager = isolatedCanaryManagerOption(options);
  const productionCanaryBinding: ProductionCanaryRuntimeBindingState = {
    ownerId: options.ownerId,
    clock: options.clock,
    manager: null,
    onProjectionReady: null,
    bound: false,
    closed: false,
  };
  const forcedMaintenanceManager = (): MaintenanceJobManager | null =>
    isolatedCanaryManager ?? productionCanaryBinding.manager;
  const { store, ownerId, clock } = options;
  const readers: AgentLoopShadowSourceReaders = Object.freeze({
    readTurnJob: options.readers.readTurnJob,
    readMaintenanceJob: (runId: string) => {
      const manager = forcedMaintenanceManager();
      if (!manager) return options.readers.readMaintenanceJob(runId);
      try { return manager.get(runId); }
      catch { return null; }
    },
  });
  const executionConfig = options.maintenanceExecution;
  if (executionConfig && nodeTypes.isProxy(executionConfig)) throw new Error('agent-loop-composition-options-invalid');
  if (executionConfig) {
    let prototype = Object.getPrototypeOf(executionConfig);
    while (prototype !== null) {
      if (nodeTypes.isProxy(prototype) || Object.hasOwn(prototype, 'modelCorrection')
        || Object.hasOwn(prototype, 'correctionProposal')
        || Object.hasOwn(prototype, 'executionProfile')
        || Object.hasOwn(prototype, 'observeCorrectionProposalEvidence')) {
        throw new Error('agent-loop-composition-options-invalid');
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  }
  const correctionProperty = executionConfig ? Object.getOwnPropertyDescriptor(executionConfig, 'modelCorrection') : undefined;
  const correctionProposalProperty = executionConfig ? Object.getOwnPropertyDescriptor(executionConfig, 'correctionProposal') : undefined;
  const executionProfileProperty = executionConfig
    ? Object.getOwnPropertyDescriptor(executionConfig, 'executionProfile') : undefined;
  const contextObservationProperty = executionConfig
    ? Object.getOwnPropertyDescriptor(executionConfig, 'observeCorrectionProposalEvidence') : undefined;
  if (correctionProperty && (!correctionProperty.enumerable || !Object.hasOwn(correctionProperty, 'value')
    || typeof correctionProperty.value !== 'function' || nodeTypes.isProxy(correctionProperty.value))) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (correctionProposalProperty && (!correctionProposalProperty.enumerable || !Object.hasOwn(correctionProposalProperty, 'value')
    || typeof correctionProposalProperty.value !== 'function' || nodeTypes.isProxy(correctionProposalProperty.value))) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (executionProfileProperty && (!executionProfileProperty.enumerable
    || !Object.hasOwn(executionProfileProperty, 'value'))) throw new Error('agent-loop-composition-options-invalid');
  if (contextObservationProperty && (!contextObservationProperty.enumerable
    || !Object.hasOwn(contextObservationProperty, 'value'))) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (contextObservationProperty && nodeTypes.isPromise(contextObservationProperty.value)) {
    observeRejectedProfilePromise(contextObservationProperty.value);
    throw new Error('agent-loop-composition-options-invalid');
  }
  if (contextObservationProperty && (typeof contextObservationProperty.value !== 'function'
    || nodeTypes.isProxy(contextObservationProperty.value))) {
    throw new Error('agent-loop-composition-options-invalid');
  }
  const executionProfile = executionProfileProperty
    ? executionProfileOf(executionProfileProperty.value) : null;
  const observeCorrectionProposalEvidence = contextObservationProperty?.value as
    ((evidence: AgentLoopMaintenanceRuntimeContextObservation) => void) | undefined;
  if (executionProfile && (correctionProperty || correctionProposalProperty)) {
    throw new Error('agent-loop-composition-action-route-conflict');
  }
  if (correctionProperty && correctionProposalProperty) throw new Error('agent-loop-composition-action-route-conflict');
  if (!executionProfile && (correctionProperty || correctionProposalProperty) && (options.maintenanceExecution?.getVariables || options.maintenanceExecution?.rollingSummaryProposal
    || options.maintenanceExecution?.rollingSummaryApply)) throw new Error('agent-loop-composition-action-route-conflict');
  if (options.maintenanceExecution?.getVariables && options.maintenanceExecution.rollingSummaryProposal
    && typeof options.maintenanceExecution.rollingSummaryProposal.publication !== 'function') {
    throw new Error('agent-loop-composition-action-route-conflict');
  }
  const applyHost = options.maintenanceExecution?.rollingSummaryApply;
  if (applyHost && (typeof applyHost.prepare !== 'function' || typeof applyHost.decide !== 'function'
    || typeof applyHost.act !== 'function')) throw new Error('agent-loop-composition-options-invalid');
  const selectedModelCorrection: NonNullable<
    AgentLoopServerCompositionOptions['maintenanceExecution']
  >['modelCorrection'] = executionProfile ? undefined : correctionProperty?.value;
  const selectedCorrectionProposal: AgentLoopMaintenanceCorrectionProposalFactory | undefined = executionProfile
    ? executionProfile.correctionProposal
    : correctionProposalProperty?.value as AgentLoopMaintenanceCorrectionProposalFactory | undefined;
  const publicationRequiredByRuntime = executionProfile?.publication === 'required';
  const host = executionConfig ? Object.freeze({ ...executionConfig,
    readExecution: (runId: string) => {
      const manager = forcedMaintenanceManager();
      if (!manager) return executionConfig.readExecution(runId);
      try { return manager.readExecution(runId); }
      catch { return null; }
    },
    ...(executionProfile ? { executionProfile } : {}),
    ...(executionConfig.getVariables ? { getVariables: Object.freeze({ ...executionConfig.getVariables }) } : {}),
    ...(executionConfig.rollingSummaryProposal
      ? { rollingSummaryProposal: Object.freeze({ ...executionConfig.rollingSummaryProposal }) } : {}),
    ...(applyHost ? { rollingSummaryApply: Object.freeze({ ...applyHost }) } : {}) }) : null;
  // Capture only the existing frozen assembly, never live business/source state.
  const installedRoutes = Object.freeze({ getVariables: !!host?.getVariables,
    rollingSummaryProposal: !!host?.rollingSummaryProposal, rollingSummaryApply: !!host?.rollingSummaryApply });
  // The old single-pass inspector must not advertise this distinct two-call
  // route as its default one-call probe or as legacy-bounded completion.
  const executionSupportHost = Object.freeze({ available: host !== null && !selectedModelCorrection && !selectedCorrectionProposal, ...installedRoutes,
    baseReady: !!host && typeof executionConfig?.readExecution === 'function'
      && typeof host.prepare === 'function' && typeof host.decide === 'function',
    getVariablesReady: !!host?.getVariables && typeof host.getVariables.prepare === 'function' && typeof host.getVariables.act === 'function',
    rollingSummaryProposalReady: !!host?.rollingSummaryProposal && typeof host.rollingSummaryProposal.prepare === 'function'
      && typeof host.rollingSummaryProposal.act === 'function',
    rollingSummaryProposalPublication: typeof host?.rollingSummaryProposal?.publication === 'function',
    rollingSummaryApplyReady: !!host?.rollingSummaryApply && typeof host.rollingSummaryApply.prepare === 'function'
      && typeof host.rollingSummaryApply.decide === 'function' && typeof host.rollingSummaryApply.act === 'function',
    rollingSummaryApplyCompletion: typeof host?.rollingSummaryApply?.completion === 'function' });
  // Own functions were captured by the original frozen assembly. The lazy
  // return bundle (including optional publication) is deliberately not invoked.
  const correctionSupportHost = Object.freeze({ available: host !== null,
    readExecutionReady: typeof executionConfig?.readExecution === 'function',
    modelCorrection: typeof selectedModelCorrection === 'function',
    correctionProposal: typeof selectedCorrectionProposal === 'function' });
  type ActionScope = { actionId: string; decision: AgentLoopDecisionV1; decisionDigest: string;
    state: 'authorized' | 'reserved' | 'executing' | 'returned' | 'observed' | 'completed' | 'closed';
    receipt: ReturnType<typeof readAgentLoopActionOutcome>; observedRecord?: AgentLoopTaskRecord; outcome?: unknown };
  type Scope = { context: MaintenanceAgentLoopExecutionContext; stage: 'PREPARE' | 'MODEL' | 'ACT' | 'OBSERVE' | 'VERIFY' | null;
    route: 'read' | 'proposal' | 'apply' | 'correction' | 'correction-proposal' | null;
    revision: number; receipt: ReturnType<typeof readAgentLoopModelOutcome>;
    initialCorrection?: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>;
    correctionNotificationAttempted?: boolean;
    correction?: ReturnType<typeof createAgentLoopMaintenanceCorrectionModel>;
    correctionProposalCapability?: AgentLoopCorrectionProposalCapability;
    correctionProposalAction?: Readonly<{ act: AgentLoopCoordinatorPorts['act'] }>;
    correctionModelRecord?: AgentLoopTaskRecord;
    correctionModelOutcome?: unknown;
    correctionRejectedOutcome?: unknown;
    correctionActionRecord?: AgentLoopTaskRecord;
    correctionPublication?: ReturnType<typeof createAgentLoopShadowPublication>;
    runtimeContextObservation?: AgentLoopMaintenanceRuntimeContextObservation;
    publication?: ReturnType<typeof createAgentLoopShadowPublication>;
    applyCompletion?: ReturnType<typeof createAgentLoopSummaryApplyCompletion>;
    completionRequest?: AgentLoopCompletionRequest;
    evaluation?: Awaited<ReturnType<NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate']>>;
    preparedRefs?: ReturnType<typeof readAgentLoopPreparedExecutionArtifactRefs>;
    capability?: AgentLoopGetVariablesCapability; proposalCapability?: AgentLoopRollingSummaryProposalCapability;
    applyCapability?: AgentLoopRollingSummaryApplyCapability; action?: ActionScope };
  const executionScope = new AsyncLocalStorage<Scope | undefined>();
  const executions = new Map<string, Scope>();
  const executionWork = new Set<Promise<void>>();
  const activeRuntimeContextObservations = new Set<AgentLoopMaintenanceRuntimeContextObservation>();
  let isClosed = false;
  const rpChildJoinScope = options.rpReadonlyExecution ? createAgentLoopRpChildJoinRuntimeScope({
    store, ownerId, clock, closed: () => isClosed,
    track: work => {
      const tail = work.then(() => undefined, () => undefined);
      executionWork.add(tail);
      void tail.finally(() => executionWork.delete(tail));
    },
  }) : null;
  const rpReadonlyScope = options.rpReadonlyExecution ? createAgentLoopRpReadonlyRuntimeScope({
    store, ownerId, clock, config: options.rpReadonlyExecution, closed: () => isClosed,
    track: work => {
      const tail = work.then(() => undefined, () => undefined);
      executionWork.add(tail);
      void tail.finally(() => executionWork.delete(tail));
    },
  }) : null;
  const actionHostFor = (scope: Scope) => scope.route === 'read' ? host?.getVariables
    : scope.route === 'proposal' ? host?.rollingSummaryProposal : scope.route === 'apply' ? host?.rollingSummaryApply : undefined;
  // Share only the mechanical invocation surface, never the two factories'
  // independent private authorities or their business/source identities.
  const closedCompletionFor = (scope: Scope) => scope.route === 'proposal' ? scope.publication
    : scope.route === 'apply' ? scope.applyCompletion
      : scope.route === 'correction-proposal' ? scope.correctionPublication : undefined;
  const scopeFor = (taskId: unknown, revision: unknown, allowSettlement = false): Scope => {
    const scope = executionScope.getStore();
    if (!scope || !host || executions.get(scope.context.taskId) !== scope || scope.stage === null
      || scope.context.taskId !== taskId || scope.revision !== revision
      || (!allowSettlement && (isClosed || scope.context.signal.aborted))) return denyWrite(null);
    const claim = host.readExecution(scope.context.execution.job.runId), record = store.read(scope.context.taskId);
    const now = Date.parse(clock());
    if (!Number.isFinite(now) || !claim || !sameMaintenanceAgentLoopClaim(scope.context.execution, claim)
      || claim.executorRoute !== 'agent-loop' || claim.leaseOwnerInstanceId !== ownerId || claim.job.status !== 'running'
      || !Number.isFinite(Date.parse(claim.leaseExpiresAt)) || Date.parse(claim.leaseExpiresAt) <= now
      || (!allowSettlement && claim.cancelRequestedAt !== undefined)
      || !record || record.fenced || record.ownerId !== ownerId || record.revision !== revision
      || record.envelope.phase !== scope.stage || !record.leaseExpiresAt
      || !Number.isFinite(Date.parse(record.leaseExpiresAt)) || Date.parse(record.leaseExpiresAt) <= now) return denyWrite(null);
    return scope;
  };
  const correctionPolicyFor = (scope: Scope, input: unknown) => {
    if ((scope.route !== 'correction' && scope.route !== 'correction-proposal') || !scope.initialCorrection
      || agentLoopModelCorrectionPolicyDigest(input) !== agentLoopModelCorrectionPolicyDigest(scope.initialCorrection.policy)) return denyWrite(input);
    return scope.initialCorrection.policy;
  };
  const correctionData = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (nodeTypes.isPromise(input)) { void Promise.prototype.then.call(input, () => undefined, () => undefined); return denyWrite(input); }
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return denyWrite(input);
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return denyWrite(input);
    for (const key of keys) { const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return denyWrite(input); }
    return input as Record<string, unknown>;
  };
  const hookAllowed = (hook: string, context: Readonly<Record<string, unknown>>): boolean => {
    if (!['prepare', 'model', 'action', 'state', 'verify'].includes(hook)) return false;
    if (rpChildJoinScope?.owns()) return hook === 'prepare'
      && rpChildJoinScope.allowsHook(context.taskId, context.revision);
    if (rpReadonlyScope?.owns()) return rpReadonlyScope.allowsHook(context.taskId, context.revision);
    try { const scope = scopeFor(context.taskId, context.revision);
      if (hook === 'state' || hook === 'verify') return !!closedCompletionFor(scope)
        && scope.action?.state === 'closed' && scope.stage === (hook === 'state' ? 'OBSERVE' : 'VERIFY');
      return hook === 'action' ? scope.stage === 'ACT' && scope.action?.state === 'authorized'
        : scope.stage === (hook === 'prepare' ? 'PREPARE' : 'MODEL'); }
    catch { return false; }
  };
  const payload = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return denyWrite(input);
    return input as Record<string, unknown>;
  };
  const settlementScope = (value: Record<string, unknown>, observation: unknown): Scope => {
    const scope = scopeFor(value.taskId ?? payload(observation).taskId, value.expectedRevision, true);
    const actual = scope.receipt?.observation;
    if (scope.stage !== 'MODEL' || !actual || observation !== actual || value.ownerId !== ownerId) return denyWrite(value);
    if (Object.hasOwn(value, 'modelOutcome')) {
      const property = Object.getOwnPropertyDescriptor(value, 'modelOutcome');
      if (!property?.enumerable || !Object.hasOwn(property, 'value')
        || readAgentLoopModelOutcome(property.value) !== scope.receipt) return denyWrite(value);
    }
    const eventId = actual.correlationRef;
    if (!store.readEvents(scope.context.taskId).some(event => event.eventId === eventId
      && event.kind === 'model-invocation-reserved' && event.revision === scope.revision)) return denyWrite(value);
    return scope;
  };
  const kernel = new AgentLoopExtensionKernel();
  kernel.register(assemblyExtensions(hookAllowed));
  const suspensionConfig = options.taskSuspension === undefined ? null
    : correctionData(options.taskSuspension, ['assertAccess', 'readEvidence']);
  if (suspensionConfig && Object.values(suspensionConfig).some(fn => typeof fn !== 'function' || nodeTypes.isProxy(fn)))
    throw new Error('agent-loop-composition-options-invalid');
  const suspensionHost = suspensionConfig ? Object.freeze({ ...suspensionConfig }) as NonNullable<AgentLoopServerCompositionOptions['taskSuspension']> : null;
  const suspensionAccess = (record: AgentLoopTaskRecord, operation: 'suspend' | 'resume') => {
    if (isClosed || !suspensionHost || executions.has(record.envelope.taskId)) throw new Error('agent-loop-suspension-unavailable');
    const result = suspensionHost.assertAccess(record, operation);
    if (isClosed || executions.has(record.envelope.taskId)) throw new Error('agent-loop-suspension-unavailable');
    return result;
  };
  // Writers require this invocation's private async scope, not just a matching task ID.
  const ports: AgentLoopCoordinatorPorts = Object.freeze({
    clock,
    ...(suspensionHost ? { suspension: Object.freeze({
      suspend: (request: AgentLoopTaskSuspendRequest) => store.suspendTask(request, record => suspensionAccess(record, 'suspend')),
      resume: (request: AgentLoopTaskResumeRequest) => store.resumeTask(request, record => suspensionAccess(record, 'resume'),
        record => suspensionHost.readEvidence(request, record)),
    }) } : {}),
    ...(rpChildJoinScope ? { childResults: rpChildJoinScope.childResults } : {}),
    taskStore: Object.freeze({
      read: (taskId: string) => rpReadonlyScope?.owns()
        ? rpReadonlyScope.ports.taskStore.read(taskId) : store.read(taskId),
      readEvents: (taskId: string) => rpReadonlyScope?.owns()
        ? rpReadonlyScope.ports.taskStore.readEvents(taskId) : store.readEvents(taskId),
      readModelCorrectionState: (input: Parameters<AgentLoopProjectionStore['readModelCorrectionState']>[0]) => {
        const value = correctionData(input, ['taskId', 'expectedRevision', 'policy']);
        const scope = scopeFor(value.taskId, value.expectedRevision, true);
        if (scope.stage !== 'MODEL' || !scope.correction) return denyWrite(input);
        correctionPolicyFor(scope, value.policy);
        return store.readModelCorrectionState(input);
      },
      readRepairState: (input: Readonly<{ taskId: string; expectedRevision: number }>) => rpReadonlyScope?.owns()
        ? rpReadonlyScope.ports.taskStore.readRepairState!(input) : store.readRepairState(input),
      readObservations: (taskId: string) => rpReadonlyScope?.owns()
        ? rpReadonlyScope.ports.taskStore.readObservations(taskId) : store.readObservations(taskId),
      readRefs: (taskId: string) => rpReadonlyScope?.owns()
        ? rpReadonlyScope.ports.taskStore.readRefs!(taskId) : store.readRefs(taskId),
      commit: (input: unknown) => {
        if (rpChildJoinScope?.owns()) return rpChildJoinScope.commit(input);
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.taskStore.commit(input);
        const value = payload(input);
        if (value.providerObservation !== undefined) {
          const scope = settlementScope(value, value.providerObservation);
          if (scope.route === 'correction' || scope.route === 'correction-proposal') correctionPolicyFor(scope, value.modelCorrectionPolicy);
        }
        else {
          const activeScope = executionScope.getStore();
          const scope = scopeFor(value.taskId, value.expectedRevision, activeScope?.stage === 'ACT');
          const next = payload(value.envelope);
          if (scope.stage === 'ACT') {
            if (scope.route === 'correction-proposal') correctionPolicyFor(scope, value.modelCorrectionPolicy);
            const action = scope.action, event = payload(value.event), previous = action?.observedRecord;
            const bundle = action?.receipt?.artifactBundle;
            if (!action || action.state !== 'completed' || !previous || value.ownerId !== ownerId
              || next.phase !== 'OBSERVE' || next.revision !== scope.revision + 1
              || event.eventId !== `phase:${scope.context.taskId}:${scope.revision}:ACT-OBSERVE`
              || event.kind !== 'phase-advanced' || event.reasonCode !== 'act'
              || JSON.stringify(value.artifactRefs) !== JSON.stringify(bundle ? [bundle.descriptor] : undefined)
              || JSON.stringify(next) !== JSON.stringify(normalizeAgentLoopTaskEnvelope({ ...previous.envelope,
                ...(bundle ? { artifacts: [...previous.envelope.artifacts, bundle.artifact] } : {}),
                phase: 'OBSERVE', revision: scope.revision + 1, updatedAt: next.updatedAt }))) return denyWrite(input);
            const result = store.commit(input);
            action.state = 'closed'; scope.revision = result.revision;
            return result;
          }
          if (scope.stage !== 'PREPARE' || value.ownerId !== ownerId || value.requirePristinePrepare !== true
            || next.taskId !== scope.context.taskId || next.phase !== 'MODEL') return denyWrite(input);
          if (scope.route === 'proposal' || scope.route === 'apply') {
            const captured = scope.preparedRefs;
            if (!captured || JSON.stringify(value.artifactRefs) !== JSON.stringify(captured.artifactRefs)
              || JSON.stringify(next.artifacts) !== JSON.stringify(captured.artifacts)) return denyWrite(input);
          } else if (value.artifactRefs !== undefined) return denyWrite(input);
        }
        return store.commit(input);
      },
      annotate: (input: unknown) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.taskStore.annotate(input);
        const value = payload(input), activeScope = executionScope.getStore();
        const scope = scopeFor(value.taskId, value.expectedRevision, activeScope?.stage === 'ACT' && activeScope.action?.state === 'observed');
        const event = payload(value.event);
        if (scope.stage === 'ACT') {
          if (scope.route === 'correction-proposal') correctionPolicyFor(scope, value.modelCorrectionPolicy);
          const action = scope.action;
          if (!action || value.ownerId !== ownerId || event.reasonCode !== 'act') return denyWrite(input);
          if (action.state === 'authorized' && value.requireNew === true
            && event.kind === 'action-started' && event.eventId === `action-started:${action.actionId}`) {
            const result = store.annotate(input); action.state = 'reserved'; return result;
          }
          if (action.state === 'observed' && value.requireNew === undefined
            && event.kind === 'action-completed' && event.eventId === `action-completed:${action.actionId}`) {
            const result = store.annotate(input); action.state = 'completed'; return result;
          }
          return denyWrite(input);
        }
        const attemptId = store.read(scope.context.taskId)?.envelope.currentAttemptId;
        if (scope.stage !== 'MODEL' || value.ownerId !== ownerId || value.requireNew !== true || !attemptId
          || event.kind !== 'model-invocation-reserved' || event.eventId !== `model-invocation:${agentLoopModelInvocationId({
            taskId: scope.context.taskId, attemptId, expectedTaskRevision: scope.revision })}`) return denyWrite(input);
        if (scope.route === 'correction' || scope.route === 'correction-proposal') {
          if (!scope.correction) return denyWrite(input);
          correctionPolicyFor(scope, value.modelCorrectionPolicy);
        }
        return store.annotate(input);
      },
      ingestObservation: (input: unknown) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.taskStore.ingestObservation(input);
        const value = payload(input), activeScope = executionScope.getStore();
        if (activeScope?.stage === 'ACT') {
          if (Object.hasOwn(value, 'modelOutcome')) return denyWrite(input);
          const scope = scopeFor(payload(value.observation).taskId, value.expectedRevision, true), action = scope.action;
          if (!action || action.state !== 'returned' || !action.receipt || value.ownerId !== ownerId
            || value.observation !== action.receipt.observation) return denyWrite(input);
          const result = store.ingestObservation(input);
          if (result.classification === 'applied' && result.record.revision === scope.revision + 1) {
            action.state = 'observed'; action.observedRecord = result.record; scope.revision = result.record.revision;
          }
          return result;
        }
        const scope = settlementScope(value, value.observation);
        const result = store.ingestObservation(input);
        if ((scope.route === 'correction' || scope.route === 'correction-proposal') && result.classification === 'applied'
          && result.record.revision === scope.revision + 1) scope.revision = result.record.revision;
        return result;
      },
    }),
    hooks: Object.freeze({ runHook: (input: Parameters<AgentLoopExtensionKernel['runHook']>[0]) => kernel.runHook(input) }),
    prepare: async (step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]) => {
      if (rpChildJoinScope?.owns()) return rpChildJoinScope.prepare(step);
      if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.prepare(step);
      if (!host || !executionScope.getStore()) return denyExecution();
      const scope = scopeFor(step.envelope.taskId, step.revision);
      if (scope.stage !== 'PREPARE' || !host || scope.route === 'correction' || scope.route === 'correction-proposal') return denyExecution();
      const output = await (actionHostFor(scope)?.prepare ?? host.prepare)(scope.context, step);
      scope.preparedRefs = readAgentLoopPreparedExecutionArtifactRefs(output);
      return output;
    },
    decide: async (step: Parameters<AgentLoopCoordinatorPorts['decide']>[0]) => {
      if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.decide(step);
      if (!host || !executionScope.getStore()) return denyExecution();
      const scope = scopeFor(step.envelope.taskId, step.revision);
      if (scope.stage !== 'MODEL' || !host || !step.invocationPermit) return denyExecution();
      if (scope.route === 'correction' || scope.route === 'correction-proposal') {
        if (!scope.correction) return denyExecution();
        scope.receipt = null;
        const modelRecord = store.read(scope.context.taskId);
        if (!modelRecord || modelRecord.revision !== step.revision) return denyExecution();
        const output = await scope.correction.decide(step);
        scope.receipt = readAgentLoopModelOutcome(output);
        if (scope.route === 'correction-proposal') {
          scope.correctionModelRecord = modelRecord;
          scope.correctionModelOutcome = output;
          if (modelRecord.revision === 2 && scope.receipt?.protocolRejectionReason) scope.correctionRejectedOutcome = output;
        }
        return output;
      }
      // MODEL may assert the original apply brand without consuming it. Only
      // the selected native apply Action exchanges that same object at ACT.
      const output = scope.route === 'apply'
        ? await (() => {
          if (!host.rollingSummaryApply || !scope.applyCapability) return denyExecution();
          return host.rollingSummaryApply.decide(scope.context, step, scope.applyCapability);
        })()
        : await host.decide(scope.context, step);
      scope.receipt = readAgentLoopModelOutcome(output);
      return output;
    },
    modelCorrectionFor: (input: Readonly<{ record: AgentLoopTaskRecord; ownerId: string }>) => {
      // Lookup is local and permits post-Abort known accounting; actual reserve,
      // advance and dispatch independently require the live guarded scope.
      const scope = executionScope.getStore();
      if (!scope || executions.get(scope.context.taskId) !== scope
        || (scope.route !== 'correction' && scope.route !== 'correction-proposal')
        || (scope.stage !== 'MODEL' && !(scope.route === 'correction-proposal' && scope.stage === 'ACT'
          && scope.action && ['authorized', 'reserved', 'executing', 'returned', 'observed', 'completed'].includes(scope.action.state)))
        || !scope.correction || !scope.initialCorrection
        || input.ownerId !== ownerId || input.record.envelope.taskId !== scope.context.taskId
        || input.record.revision !== scope.revision) return denyWrite(input);
      const policy = correctionPolicyFor(scope, scope.correction.policy);
      return Object.freeze({ policy, advance: (step: Readonly<{ record: AgentLoopTaskRecord; ownerId: string;
        policy: AgentLoopModelCorrectionPolicy; expectedSnapshotDigest: string }>) => {
        const current = scopeFor(step.record.envelope.taskId, step.record.revision);
        if (current !== scope || scope.stage !== 'MODEL' || step.ownerId !== ownerId || !scope.correction) return denyWrite(step);
        correctionPolicyFor(scope, step.policy);
        const result = scope.correction.modelCorrection.advance(step);
        if (nodeTypes.isPromise(result)) { void Promise.prototype.then.call(result, () => undefined, () => undefined); return denyWrite(result); }
        if (!result || typeof result !== 'object' || nodeTypes.isProxy(result)) return denyWrite(result);
        const revision = Object.getOwnPropertyDescriptor(result, 'revision'), digest = Object.getOwnPropertyDescriptor(result, 'envelopeDigest');
        const actual = store.read(scope.context.taskId);
        if (!actual || actual.revision !== scope.revision + 1 || !revision || !Object.hasOwn(revision, 'value')
          || revision.value !== actual.revision || !digest || !Object.hasOwn(digest, 'value') || digest.value !== actual.envelopeDigest) return denyWrite(result);
        // Original Core still verifies live lease, unchanged budget and ready history.
        scope.revision = actual.revision;
        return result;
      } });
    },
    act: async (step: Parameters<AgentLoopCoordinatorPorts['act']>[0]) => {
      if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.act(step);
      if (!executionScope.getStore()) return denyExecution();
      const request = step.actionRequest, scope = scopeFor(request.taskId, request.expectedTaskRevision), action = scope.action;
      const actionHost = actionHostFor(scope);
      if (!actionHost && !(scope.route === 'correction-proposal' && scope.correctionProposalAction)) return denyExecution();
      const current = store.read(request.taskId);
      if (scope.stage !== 'ACT' || !action || action.state !== 'reserved' || step.decision !== action.decision
        || request.actionId !== action.actionId || request.decisionDigest !== action.decisionDigest
        || request.attemptId !== current?.envelope.currentAttemptId || request.decisionId !== action.decision.decisionId
        || request.harnessRunId !== action.decision.harnessRunId || action.decision.kind !== 'act'
        || request.actionContractRef !== (scope.route === 'read' ? 'action.maintenance.get_variables.v1'
          : scope.route === 'proposal' || scope.route === 'correction-proposal' ? 'action.maintenance.propose_rolling_summary.v1'
            : AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT)
        || scope.route === 'apply' && !scope.applyCapability || request.args !== action.decision.args) return denyExecution();
      action.state = 'executing';
      let output: Awaited<ReturnType<AgentLoopCoordinatorPorts['act']>>;
      if (scope.route === 'correction-proposal') {
        if (!scope.correctionProposalAction
          || action.decision.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
          || current?.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF) return denyExecution();
        output = await scope.correctionProposalAction.act(step);
      } else if (scope.route === 'apply') {
        const applyHost = host?.rollingSummaryApply, capability = scope.applyCapability;
        if (!applyHost || !capability) return denyExecution();
        try { output = await applyHost.act(scope.context, step, capability); }
        finally { revokeAgentLoopRollingSummaryApplyCapability(capability); }
      } else {
        const legacyHost = scope.route === 'read' ? host?.getVariables : host?.rollingSummaryProposal;
        if (!legacyHost) return denyExecution();
        output = await legacyHost.act(scope.context, step);
      }
      const receipt = readAgentLoopActionOutcome(output);
      if (!receipt || receipt.observation.taskId !== request.taskId || receipt.observation.attemptId !== request.attemptId
        || receipt.observation.causalActionId !== request.actionId || receipt.observation.observationId !== `obs:${request.actionId}`
        || receipt.observation.observedForTaskRevision !== request.expectedTaskRevision
        || receipt.observation.observedAt !== request.requestedAt) return denyExecution();
      action.receipt = receipt; action.state = 'returned';
      if (scope.route === 'correction-proposal') action.outcome = output;
      return output;
    },
    verify: async (step: Parameters<AgentLoopCoordinatorPorts['verify']>[0]) => {
      if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.verify(step);
      if (!host || !executionScope.getStore()) return denyExecution();
      const scope = scopeFor(step.envelope.taskId, step.revision);
      const completion = closedCompletionFor(scope);
      if (scope.stage !== 'VERIFY' || !completion
        || scope.action?.state !== 'closed' || step.actionId !== scope.action.actionId) return denyExecution();
      return completion.verify(step);
    },
    repair: Object.freeze({
      commit: (input: Parameters<NonNullable<AgentLoopCoordinatorPorts['repair']>['commit']>[0]) => {
        if (!host || !executionScope.getStore()) return denyWrite(input);
        const scope = scopeFor(input.record.envelope.taskId, input.record.revision);
        const completion = closedCompletionFor(scope);
        if (scope.stage !== 'VERIFY' || !completion
          || input.ownerId !== ownerId || scope.action?.state !== 'closed') return denyWrite(input);
        return completion.repair.commit(input);
      },
    }),
    completion: Object.freeze({
      request: (input: Parameters<NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['request']>>[0]) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.completion.request(input);
        if (!host || !executionScope.getStore()) return denyWrite(input);
        const scope = scopeFor(input.record.envelope.taskId, input.record.revision);
        const completion = closedCompletionFor(scope);
        if (scope.stage !== 'OBSERVE' || !completion || scope.completionRequest
          || input.ownerId !== ownerId || scope.action?.state !== 'closed'
          || input.actionWatermark !== `action-completed:${scope.action.actionId}`) return denyWrite(input);
        const request = completion.coordinatorCompletion.request!(input);
        scope.completionRequest = request as AgentLoopCompletionRequest;
        return request;
      },
      commitRequested: (input: Parameters<NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['commitRequested']>>[0]) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.completion.commitRequested(input);
        if (!host || !executionScope.getStore()) return denyWrite(input);
        const scope = scopeFor(input.record.envelope.taskId, input.record.revision);
        if (scope.stage !== 'OBSERVE' || !closedCompletionFor(scope)
          || input.request !== scope.completionRequest || input.ownerId !== ownerId
          || scope.action?.state !== 'closed' || input.actionWatermark !== `action-completed:${scope.action.actionId}`) return denyWrite(input);
        return consumeAgentLoopCompletionRequest(input.request, { store, record: input.record,
          ownerId, actionWatermark: input.actionWatermark });
      },
      evaluate: async (input: Parameters<NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate']>[0]) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.completion.evaluate(input);
        if (!host || !executionScope.getStore()) return denyExecution();
        const scope = scopeFor(input.envelope.taskId, input.revision);
        const completion = closedCompletionFor(scope);
        if (scope.stage !== 'VERIFY' || !completion
          || scope.evaluation || scope.action?.state !== 'closed'
          || input.actionWatermark !== `action-completed:${scope.action.actionId}`) return denyExecution();
        const evaluation = await completion.coordinatorCompletion.evaluate(input);
        scope.evaluation = evaluation;
        return evaluation;
      },
      commitVerified: (input: Parameters<NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['commitVerified']>>[0]) => {
        if (rpReadonlyScope?.owns()) return rpReadonlyScope.ports.completion.commitVerified(input);
        if (!host || !executionScope.getStore()) return denyWrite(input);
        const scope = scopeFor(input.record.envelope.taskId, input.record.revision);
        const completion = closedCompletionFor(scope);
        if (scope.stage !== 'VERIFY' || !completion || scope.action?.state !== 'closed'
          || input.evaluation !== scope.evaluation || input.ownerId !== ownerId) return denyWrite(input);
        return completion.coordinatorCompletion.commitVerified!(input);
      },
    }),
  });
  const coordinator = new AgentLoopCoordinator(ports);
  const preparePreview = options.maintenancePrepareSource ? createAgentLoopMaintenancePrepare({
    store, ownerId, clock, readSource: options.maintenancePrepareSource,
  }) : null;
  const pending = new Map<string, Event>();
  let inFlight: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let isActive: 0 | 1 = 0;
  let accepted = 0, dropped = 0, errors = 0, skipped = 0;
  let created = 0, settled = 0, probes = 0, blockedProbes = 0;
  let prepareCandidates = 0, prepareErrors = 0;

  const readSource = (event: Event): Source | null => {
    if (event.family === 'turn') {
      const job = readers.readTurnJob(event.runId);
      return job && job.runId === event.runId ? { family: 'turn', job } : null;
    }
    const job = readers.readMaintenanceJob(event.runId);
    return job && job.runId === event.runId ? { family: 'maintenance', job } : null;
  };
  const apply = (event: Event, source: Source): ShadowJobPhaseOutcome => {
    const existing = store.read(sourceTaskId(source));
    // A progressed AL record is no longer a legacy metadata projection, even
    // after its execution scope has drained. Do not re-project or re-fence it.
    if (existing && !isPristineShadowProjection(store, existing)) return Object.freeze({ projected: false, fenced: false });
    const now = clock();
    if (source.family === 'turn' && event.family === 'turn') {
      return handleTurnJobPhase(store, { job: source.job, phase: terminal(source) ? 'settled' : event.phase, ownerId, now });
    }
    if (source.family === 'maintenance' && event.family === 'maintenance') {
      return handleMaintenanceJobPhase(store, { job: source.job, phase: terminal(source) ? 'settled' : event.phase, ownerId, now });
    }
    throw new Error('agent-loop-shadow-family-mismatch');
  };
  const settleIfCurrent = (event: Event, identity?: string): void => {
    const source = readSource(event);
    if (!source || !terminal(source) || executions.has(sourceTaskId(source))
      || (identity !== undefined && sourceIdentity(source) !== identity)) return;
    if (apply(event, source).fenced) settled += 1;
  };
  const currentActive = (event: Event, identity: string, projection: ShadowTurnJobProjectionV1): Source | null => {
    const source = readSource(event);
    if (!source || !active(source) || executions.has(projection.taskId) || sourceIdentity(source) !== identity) return null;
    const state = shadowJobSourceState(projection.envelope, {
      readTurnJob: () => source.family === 'turn' ? source.job : null,
      readMaintenanceJob: () => source.family === 'maintenance' ? source.job : null,
    });
    return state === 'active' ? source : null;
  };

  const processEvent = async (event: Event): Promise<void> => {
    if (event.family === 'turn' && event.phase === 'queued') { skipped += 1; return; }
    const source = readSource(event);
    if (!source) { skipped += 1; return; }
    // The original Service owns an active claim's cleanup. Metadata must neither
    // borrow its async capability nor fence its still-settling receipt.
    const existing = store.read(sourceTaskId(source));
    if (executions.has(sourceTaskId(source)) || (existing && !isPristineShadowProjection(store, existing))) { skipped += 1; return; }
    if (terminal(source) || event.phase === 'settled') {
      if (apply(event, source).fenced) settled += 1;
      return;
    }
    if (!active(source)) { skipped += 1; return; }
    const projection = projectionOf(source);
    const identity = sourceIdentity(source);
    if (store.read(projection.taskId)) {
      apply(event, source); // Existing creation is idempotent; do not repeat hooks or probe.
      skipped += 1;
      return;
    }
    // This before hook really precedes the metadata write; it is not an
    // after-the-fact notification labelled "before".
    assertReadOnlyHook(await kernel.runHook({ hook: 'task-create', phase: 'before', context: createContext(projection.envelope) }));
    const fresh = currentActive(event, identity, projection);
    if (!fresh) { settleIfCurrent(event, identity); skipped += 1; return; }
    if (store.read(projection.taskId)) { apply(event, fresh); skipped += 1; return; }
    apply(event, fresh);
    const record = store.read(projection.taskId);
    if (!record || record.ownerId !== ownerId || record.fenced || !isPristineShadowProjection(store, record)) {
      skipped += 1; return;
    }
    created += 1;
    assertReadOnlyHook(await kernel.runHook({ hook: 'task-create', phase: 'after', context: createContext(record.envelope) }));
    const after = currentActive(event, identity, projection);
    const latest = store.read(projection.taskId);
    if (!after || !latest || latest.fenced || latest.ownerId !== ownerId || !isPristineShadowProjection(store, latest)) {
      settleIfCurrent(event, identity); skipped += 1; return;
    }
    probes += 1;
    const result = await coordinator.step({ taskId: projection.taskId, ownerId });
    if (result.outcome !== 'blocked' || result.nextPhase !== null
      || store.read(projection.taskId)?.revision !== latest.revision) {
      throw new Error('agent-loop-disabled-probe-advanced');
    }
    // Preview the real Context Builder without calling the Coordinator's
    // prepare port (which would advance revision/phase). No candidate grants
    // execution: all production write/model/action guards remain fixed deny.
    let candidate = null;
    if (preparePreview && source.family === 'maintenance') {
      try { candidate = await preparePreview.preview({ taskId: projection.taskId, revision: latest.revision }); }
      catch { prepareErrors += 1; }
    }
    const completedSource = currentActive(event, identity, projection);
    const completed = store.read(projection.taskId);
    if (!completedSource || !completed || completed.fenced || completed.ownerId !== ownerId
      || !isPristineShadowProjection(store, completed)) {
      settleIfCurrent(event, identity); skipped += 1; return;
    }
    blockedProbes += 1;
    if (candidate) prepareCandidates += 1;
    const readyCallback = productionCanaryBinding.onProjectionReady;
    const readyManager = productionCanaryBinding.manager;
    if (source.family === 'maintenance' && readyCallback && readyManager && !isClosed) {
      const readySource = currentActive(event, identity, projection);
      const ready = store.read(projection.taskId);
      if (readySource?.family === 'maintenance'
        && readySource.job.status === 'queued'
        && matchesAgentLoopMaintenanceProductionRouteJob(readySource.job)
        && ready && !ready.fenced && ready.ownerId === ownerId
        && isPristineShadowProjection(store, ready)
        && isOpenProductionCanaryRuntime(runtime, store, readyManager)) {
        try {
          const result: unknown = readyCallback(
            Object.freeze({ runId: readySource.job.runId }),
          );
          observeRejectedProfilePromise(result);
        } catch {
          // A missed wake is repaired by startup reconciliation or the next
          // durable queue wake; observation must never fail the projection.
        }
      }
    }
  };

  const startDrain = (): void => {
    if (inFlight) return;
    inFlight = Promise.resolve().then(async () => {
      while (pending.size > 0) {
        const first = pending.entries().next().value;
        if (!first) break;
        const [key, event] = first;
        pending.delete(key);
        isActive = 1;
        try { await executionScope.run(undefined, () => processEvent(event)); }
        catch { errors += 1; } // Content/Provider errors never escape into either legacy Manager.
        finally { isActive = 0; }
      }
    }).finally(() => {
      inFlight = null;
      // An observer microtask can enqueue after the loop saw an empty Map but
      // before this finally runs. Accepted metadata must still drain on close.
      if (pending.size > 0) startDrain();
    });
  };
  const enqueue = (event: Event): void => {
    if (isClosed || typeof event.runId !== 'string' || !RUN_ID.test(event.runId)) { dropped += 1; return; }
    const allowed = event.family === 'turn' ? ['queued', 'running', 'settled'] : ['enqueued', 'settled'];
    if (!allowed.includes(event.phase)) { dropped += 1; return; }
    const key = `${event.family}:${event.runId}`;
    const previous = pending.get(key);
    if (!previous && pending.size + isActive >= AGENT_LOOP_RUNTIME_QUEUE_LIMIT) { dropped += 1; return; }
    accepted += 1;
    // A late running/enqueued notification cannot erase a queued terminal one.
    if (previous?.phase !== 'settled') pending.set(key, Object.freeze({ ...event }));
    startDrain();
  };
  const whenIdle = async (): Promise<void> => {
    while (inFlight || executionWork.size > 0) {
      await Promise.allSettled([...(inFlight ? [inFlight] : []), ...executionWork]);
    }
  };
  const executeMaintenance = (context: MaintenanceAgentLoopExecutionContext): Promise<void> => {
    // Consume even a rejected genuine capability: no retry/replay or copied DTO authority.
    const genuine = consumeMaintenanceAgentLoopExecutionContext(context, store, ownerId);
    if (!genuine || isClosed || !host || context.ownerId !== ownerId || executions.has(context.taskId)) {
      return Promise.reject(new Error(EXECUTION_DISABLED));
    }
    const first = store.read(context.taskId);
    if (!first || !isPristineShadowProjection(store, first)
      || context.taskId !== `agentloop.maintenance.${context.execution.job.runId}`) return Promise.reject(new Error(EXECUTION_DISABLED));
    if ((selectedModelCorrection || selectedCorrectionProposal) && context.execution.job.mode !== 'shadow') {
      return Promise.reject(new Error(EXECUTION_DISABLED));
    }
    const route = selectedCorrectionProposal ? 'correction-proposal'
      : selectedModelCorrection ? 'correction'
        : selectAgentLoopMaintenanceExecutionRoute(context.execution.job.mode, installedRoutes);
    const scope: Scope = { context, stage: 'PREPARE', route, revision: first.revision, receipt: null };
    executions.set(context.taskId, scope);
    const work = Promise.resolve().then(() => executionScope.run(scope, () => withProviderWorkSettlement(async () => {
      scopeFor(context.taskId, scope.revision);
      if (scope.route === 'correction-proposal') {
        if (!selectedCorrectionProposal) return denyExecution();
        const assertActive = () => {
          if (executionScope.getStore() !== scope || executions.get(context.taskId) !== scope
            || scope.route !== 'correction-proposal' || !['PREPARE', 'MODEL', 'ACT', 'OBSERVE', 'VERIFY'].includes(scope.stage ?? '')
            || isClosed || context.signal.aborted) return denyWrite(null);
        };
        const stepWithHeartbeat = async () => {
          // Resolved host Promises only yield microtasks. Let the original Service
          // heartbeat timers run between these finite stages, then recheck authority.
          await new Promise<void>(resolve => setImmediate(resolve));
          assertActive();
          scopeFor(context.taskId, scope.revision);
          return coordinator.step({ taskId: context.taskId, ownerId });
        };
        const onPrepared = (input: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>) => {
          // Adoption records the committed fact for Service cleanup; it does
          // not require or create the still-unissued live proposal capability.
          if (executionScope.getStore() !== scope || executions.get(context.taskId) !== scope
            || scope.route !== 'correction-proposal' || scope.stage !== 'PREPARE' || scope.correctionNotificationAttempted) return denyWrite(input);
          scope.correctionNotificationAttempted = true;
          const value = correctionData(input, ['record', 'policy']), actual = store.read(context.taskId);
          const policy = assertAgentLoopModelCorrectionPolicyBinding(value.policy, value.record as AgentLoopTaskRecord);
          if (!actual || actual.fenced || actual.ownerId !== ownerId || actual.revision !== 2
            || actual.envelope.state !== 'RUNNING' || actual.envelope.phase !== 'MODEL'
            || actual.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
            || policy.initialRevision !== 2 || policy.taskId !== context.taskId || policy.initialEnvelopeDigest !== actual.envelopeDigest) return denyWrite(input);
          const state = store.readModelCorrectionState({ taskId: context.taskId, expectedRevision: 2, policy });
          if (state.status !== 'initial') return denyWrite(input);
          adoptMaintenanceAgentLoopCorrectionProposal(context, store, ownerId, policy);
          scope.initialCorrection = Object.freeze({ record: actual, policy });
          scope.stage = 'MODEL'; scope.revision = actual.revision;
        };
        const result = await selectedCorrectionProposal(context, { envelope: first.envelope, revision: first.revision },
          Object.freeze({ assertActive, onPrepared }));
        // Capture an own-data brand for revocation even when another bundle
        // field is malformed. Never invoke a getter or inspect a Proxy/Promise.
        if (result && typeof result === 'object' && !nodeTypes.isProxy(result) && !nodeTypes.isPromise(result)) {
          const capability = Object.getOwnPropertyDescriptor(result, 'proposalCapability');
          if (capability && Object.hasOwn(capability, 'value')) scope.correctionProposalCapability = capability.value;
        }
        const publicationProperty = result && typeof result === 'object' && !nodeTypes.isProxy(result) && !nodeTypes.isPromise(result)
          ? Object.getOwnPropertyDescriptor(result, 'publication') : undefined;
        if (publicationRequiredByRuntime && !publicationProperty) return denyWrite(result);
        const bundle = correctionData(result, ['policy', 'modelCorrection', 'decide', 'proposalCapability', 'createAction',
          ...(publicationProperty ? ['publication'] : [])]);
        scope.correctionProposalCapability = bundle.proposalCapability as AgentLoopCorrectionProposalCapability;
        const correction = correctionData(bundle.modelCorrection, ['policy', 'advance']);
        if (publicationProperty && nodeTypes.isPromise(bundle.publication)) {
          observeRejectedProfilePromise(bundle.publication);
        }
        if (typeof bundle.decide !== 'function' || nodeTypes.isProxy(bundle.decide)
          || typeof bundle.createAction !== 'function' || nodeTypes.isProxy(bundle.createAction)
          || publicationProperty && (typeof bundle.publication !== 'function' || nodeTypes.isProxy(bundle.publication))
          || typeof correction.advance !== 'function' || nodeTypes.isProxy(correction.advance)
          || !scope.initialCorrection) return denyWrite(result);
        const createAction = bundle.createAction as AgentLoopCorrectionProposalHostBundle['createAction'];
        const createPublication = publicationProperty ? bundle.publication as NonNullable<AgentLoopCorrectionProposalHostBundle['publication']> : undefined;
        correctionPolicyFor(scope, bundle.policy); correctionPolicyFor(scope, correction.policy);
        scope.correction = Object.freeze({ policy: scope.initialCorrection.policy,
          modelCorrection: Object.freeze({ policy: scope.initialCorrection.policy, advance: correction.advance as NonNullable<AgentLoopCoordinatorPorts['modelCorrection']>['advance'] }),
          decide: bundle.decide as AgentLoopCoordinatorPorts['decide'] });
        assertActive(); scopeFor(context.taskId, scope.revision);
        assertAgentLoopCorrectionProposalInitialCapability(scope.correctionProposalCapability, {
          store, ownerId, record: scope.initialCorrection.record, policy: scope.initialCorrection.policy });
        // A finite branch, never a retry loop: MODEL1, optional ready+MODEL2, one ACT.
        let modeled = await stepWithHeartbeat();
        if (modeled.outcome === 'blocked' && modeled.record?.envelope.phase === 'MODEL') {
          scope.revision = modeled.record.revision;
          assertActive(); scopeFor(context.taskId, scope.revision);
          const rejected = store.readModelCorrectionState({ taskId: context.taskId, expectedRevision: scope.revision,
            policy: scope.initialCorrection.policy });
          if (rejected.status !== 'rejected' || rejected.correctionsUsed !== 0 || !rejected.closedInvocationId) return;
          const ready = await stepWithHeartbeat();
          if (ready.outcome !== 'model-correction-ready' || !ready.record) return;
          scope.revision = ready.record.revision;
          assertActive(); scopeFor(context.taskId, scope.revision);
          modeled = await stepWithHeartbeat();
        }
        if (modeled.outcome !== 'advanced' || modeled.nextPhase !== 'ACT' || !modeled.record
          || modeled.decision?.kind !== 'act' || modeled.decision.actionContractRef !== 'action.maintenance.propose_rolling_summary.v1'
          || modeled.decision.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
          || !scope.correctionModelRecord || !scope.correctionModelOutcome) return;
        scope.revision = modeled.record.revision;
        assertActive();
        const actionInput: AgentLoopCorrectionProposalActionInput = Object.freeze({ record: modeled.record,
          policy: scope.initialCorrection.policy, modelRecord: scope.correctionModelRecord,
          modelOutcome: scope.correctionModelOutcome, decision: modeled.decision,
          ...(scope.correctionRejectedOutcome ? { rejectedModelOutcome: scope.correctionRejectedOutcome } : {}) });
        if (!consumeAgentLoopCorrectionProposalCapability(scope.correctionProposalCapability,
          { store, ownerId, ...actionInput })) return denyWrite(actionInput);
        scope.correctionActionRecord = modeled.record;
        const actionBundle = correctionData(createAction(actionInput), ['act']);
        if (typeof actionBundle.act !== 'function' || nodeTypes.isProxy(actionBundle.act)) return denyWrite(actionBundle);
        scope.correctionProposalAction = Object.freeze({ act: actionBundle.act as AgentLoopCoordinatorPorts['act'] });
        scope.stage = 'ACT';
        const decisionDigest = agentLoopDecisionDigest(modeled.decision);
        scope.action = { decision: modeled.decision, decisionDigest, state: 'authorized', receipt: null,
          actionId: agentLoopActionId({ taskId: context.taskId, attemptId: modeled.record.envelope.currentAttemptId!,
            expectedTaskRevision: modeled.record.revision, decisionDigest }) };
        assertActive(); scopeFor(context.taskId, scope.revision);
        const acted = await stepWithHeartbeat();
        if (createPublication && acted.outcome === 'acted' && acted.nextPhase === 'OBSERVE' && acted.record
          && scope.action.state === 'closed' && scope.action.outcome && !context.signal.aborted && !isClosed) {
          scope.stage = 'OBSERVE'; scope.revision = acted.record.revision;
          assertActive(); scopeFor(context.taskId, scope.revision);
          const publication = correctionData(createPublication(Object.freeze({ observeRecord: acted.record,
            policy: scope.initialCorrection.policy, modelRecord: scope.correctionModelRecord,
            modelOutcome: scope.correctionModelOutcome, actionRecord: scope.correctionActionRecord,
            actionOutcome: scope.action.outcome,
            ...(scope.correctionRejectedOutcome ? { rejectedModelOutcome: scope.correctionRejectedOutcome } : {}) })),
          ['coordinatorCompletion', 'repair', 'verify']);
          const completion = correctionData(publication.coordinatorCompletion, ['request', 'evaluate', 'commitVerified']);
          const repair = correctionData(publication.repair, ['commit']);
          for (const fn of [publication.verify, completion.request, completion.evaluate, completion.commitVerified, repair.commit]) {
            if (typeof fn !== 'function' || nodeTypes.isProxy(fn)) return denyWrite(publication);
          }
          scope.correctionPublication = Object.freeze({ verify: publication.verify as AgentLoopCoordinatorPorts['verify'],
            repair: Object.freeze({ commit: repair.commit as NonNullable<AgentLoopCoordinatorPorts['repair']>['commit'] }),
            coordinatorCompletion: Object.freeze({ request: completion.request as NonNullable<AgentLoopCoordinatorPorts['completion']>['request'],
              evaluate: completion.evaluate as NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate'],
              commitVerified: completion.commitVerified as NonNullable<AgentLoopCoordinatorPorts['completion']>['commitVerified'] }) });
          // The combined fact exists only after the real Action is closed and
          // the returned publication instance has passed every own-function
          // check. It says nothing about the following OBSERVE/VERIFY result.
          assertActive(); scopeFor(context.taskId, scope.revision);
          if (executionProfile && !scope.runtimeContextObservation) {
            const evidence = bindRuntimeContextObservation(
              runtime,
              context,
              activeRuntimeContextObservations,
            );
            if (evidence) {
              scope.runtimeContextObservation = evidence;
              try {
                const observedEvidence = observeCorrectionProposalEvidence?.(evidence);
                if (nodeTypes.isPromise(observedEvidence)) {
                  observeRejectedProfilePromise(observedEvidence);
                }
              } catch {
                // Observation is best-effort and cannot alter business execution.
              }
            }
          }
          const observed = await stepWithHeartbeat();
          if (observed.outcome === 'observed' && observed.nextPhase === 'VERIFY' && observed.record
            && !context.signal.aborted && !isClosed) {
            scope.stage = 'VERIFY'; scope.revision = observed.record.revision;
            assertActive(); scopeFor(context.taskId, scope.revision);
            await stepWithHeartbeat();
          }
        }
        return; // Only the explicit same-route host may complete; never another MODEL/ACT.
      }
      if (scope.route === 'correction') {
        if (!selectedModelCorrection) return denyExecution();
        // Source-only lifetime assertion: no AL read or nested transaction.
        const assertActive = () => {
          if (executionScope.getStore() !== scope || executions.get(context.taskId) !== scope
            || scope.route !== 'correction' || !['PREPARE', 'MODEL'].includes(scope.stage ?? '')
            || isClosed || context.signal.aborted) return denyWrite(null);
        };
        const onPrepared = (input: Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }>) => {
          // Adopt an already-committed fact even if cancellation/close just
          // arrived: this permits cleanup, never a MODEL dispatch after stop.
          if (executionScope.getStore() !== scope || executions.get(context.taskId) !== scope
            || scope.route !== 'correction' || scope.stage !== 'PREPARE' || scope.correctionNotificationAttempted) return denyWrite(input);
          scope.correctionNotificationAttempted = true;
          const value = correctionData(input, ['record', 'policy']), actual = store.read(context.taskId);
          const policy = assertAgentLoopModelCorrectionPolicyBinding(value.policy, value.record as AgentLoopTaskRecord);
          if (!actual || actual.fenced || actual.ownerId !== ownerId || actual.revision !== 2
            || actual.envelope.state !== 'RUNNING' || actual.envelope.phase !== 'MODEL'
            || actual.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
            || policy.initialRevision !== 2 || policy.taskId !== context.taskId || policy.initialEnvelopeDigest !== actual.envelopeDigest) return denyWrite(input);
          const state = store.readModelCorrectionState({ taskId: context.taskId, expectedRevision: 2, policy });
          if (state.status !== 'initial') return denyWrite(input);
          adoptMaintenanceAgentLoopModelCorrection(context, store, ownerId, policy);
          scope.initialCorrection = Object.freeze({ record: actual, policy });
          scope.stage = 'MODEL'; scope.revision = actual.revision;
        };
        const result = await selectedModelCorrection(context, { envelope: first.envelope, revision: first.revision },
          Object.freeze({ assertActive, onPrepared }));
        const bundle = correctionData(result, ['policy', 'modelCorrection', 'decide']);
        const correction = correctionData(bundle.modelCorrection, ['policy', 'advance']);
        if (typeof bundle.decide !== 'function' || nodeTypes.isProxy(bundle.decide)
          || typeof correction.advance !== 'function' || nodeTypes.isProxy(correction.advance)
          || !scope.initialCorrection) return denyWrite(result);
        correctionPolicyFor(scope, bundle.policy); correctionPolicyFor(scope, correction.policy);
        scope.correction = Object.freeze({ policy: scope.initialCorrection.policy,
          modelCorrection: Object.freeze({ policy: scope.initialCorrection.policy, advance: correction.advance as NonNullable<AgentLoopCoordinatorPorts['modelCorrection']>['advance'] }),
          decide: bundle.decide as AgentLoopCoordinatorPorts['decide'] });
        assertActive(); scopeFor(context.taskId, scope.revision);
        const initialState = store.readModelCorrectionState({ taskId: context.taskId, expectedRevision: scope.revision,
          policy: scope.initialCorrection.policy });
        if (scope.revision !== 2 || initialState.status !== 'initial' || !initialState.invocationAllowed) return denyWrite(result);
        // No generic retry loop: at most MODEL1, metadata-only ready, MODEL2.
        const modeled = await coordinator.step({ taskId: context.taskId, ownerId });
        if (modeled.outcome !== 'blocked' || !modeled.record || modeled.record.envelope.phase !== 'MODEL') return;
        scope.revision = modeled.record.revision;
        assertActive(); scopeFor(context.taskId, scope.revision);
        const rejected = store.readModelCorrectionState({ taskId: context.taskId, expectedRevision: scope.revision,
          policy: scope.initialCorrection.policy });
        if (rejected.status !== 'rejected' || rejected.correctionsUsed !== 0 || !rejected.closedInvocationId) return;
        const ready = await coordinator.step({ taskId: context.taskId, ownerId });
        if (ready.outcome !== 'model-correction-ready' || !ready.record) return;
        scope.revision = ready.record.revision;
        assertActive(); scopeFor(context.taskId, scope.revision);
        await coordinator.step({ taskId: context.taskId, ownerId });
        return; // Even a valid Action Decision is only intent; no ACT capability.
      }
      const prepared = await coordinator.step({ taskId: context.taskId, ownerId });
      scope.capability = prepared.getVariablesCapability;
      scope.proposalCapability = prepared.rollingSummaryProposalCapability;
      scope.applyCapability = prepared.rollingSummaryApplyCapability;
      if (prepared.outcome !== 'advanced' || prepared.nextPhase !== 'MODEL' || !prepared.record
        || context.signal.aborted || isClosed) return;
      scope.stage = 'MODEL'; scope.revision = prepared.record.revision;
      scopeFor(context.taskId, scope.revision);
      // Never race this continuation against Abort: its real receipt must settle before fencing.
      const modeled = await coordinator.step({ taskId: context.taskId, ownerId });
      if (modeled.outcome === 'advanced' && modeled.nextPhase === 'ACT' && modeled.record
        && modeled.decision?.kind === 'act'
        && !context.signal.aborted && !isClosed
        && ((scope.route === 'read' && modeled.decision.actionContractRef === 'action.maintenance.get_variables.v1'
          && consumeAgentLoopGetVariablesCapability(scope.capability, { store, ownerId,
            record: modeled.record, decision: modeled.decision }))
          || (scope.route === 'proposal' && modeled.decision.actionContractRef === 'action.maintenance.propose_rolling_summary.v1'
            && consumeAgentLoopRollingSummaryProposalCapability(scope.proposalCapability, { store, ownerId,
              record: modeled.record, decision: modeled.decision }))
          || (scope.route === 'apply' && modeled.decision.actionContractRef === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT
            && scope.applyCapability !== undefined))) {
        scope.stage = 'ACT'; scope.revision = modeled.record.revision;
        const decisionDigest = agentLoopDecisionDigest(modeled.decision);
        scope.action = { decision: modeled.decision, decisionDigest, state: 'authorized', receipt: null,
          actionId: agentLoopActionId({ taskId: context.taskId, attemptId: modeled.record.envelope.currentAttemptId!,
            expectedTaskRevision: modeled.record.revision, decisionDigest }) };
        scopeFor(context.taskId, scope.revision);
        const acted = await coordinator.step({ taskId: context.taskId, ownerId });
        if (((scope.route === 'proposal' && host.rollingSummaryProposal?.publication)
          || (scope.route === 'apply' && host.rollingSummaryApply?.completion))
          && acted.outcome === 'acted' && acted.nextPhase === 'OBSERVE' && acted.record
          && scope.action.state === 'closed' && !context.signal.aborted && !isClosed) {
          scope.stage = 'OBSERVE'; scope.revision = acted.record.revision;
          scopeFor(context.taskId, scope.revision);
          const completion = scope.route === 'proposal'
            ? host.rollingSummaryProposal!.publication!(context, { envelope: acted.record.envelope, revision: acted.record.revision })
            : host.rollingSummaryApply!.completion!(context, { envelope: acted.record.envelope, revision: acted.record.revision });
          // This factory is a synchronous host seam. Observe an accidental
          // rejected native Promise without inspecting/assimilating thenables.
          if (completion !== null && typeof completion === 'object') {
            let asynchronous = false;
            try { void Promise.prototype.then.call(completion, () => undefined, () => undefined); asynchronous = true; }
            catch { /* The real host bundle is not a Promise. */ }
            if (asynchronous) return denyWrite(completion);
          }
          if (!completion || typeof completion.verify !== 'function' || !completion.coordinatorCompletion
            || !completion.repair || typeof completion.repair.commit !== 'function'
            || typeof completion.coordinatorCompletion.request !== 'function'
            || typeof completion.coordinatorCompletion.evaluate !== 'function'
            || typeof completion.coordinatorCompletion.commitVerified !== 'function') return denyWrite(completion);
          if (scope.route === 'proposal') scope.publication = completion;
          else scope.applyCompletion = completion;
          const observed = await coordinator.step({ taskId: context.taskId, ownerId });
          if (observed.outcome === 'observed' && observed.nextPhase === 'VERIFY' && observed.record
            && !context.signal.aborted && !isClosed) {
            scope.stage = 'VERIFY'; scope.revision = observed.record.revision;
            scopeFor(context.taskId, scope.revision);
            await coordinator.step({ taskId: context.taskId, ownerId });
          }
        }
      }
      scope.stage = null; // One exact ACT; only its explicit route-owned completion may request/Verify. Never a second MODEL.
    }))).finally(() => {
      scope.stage = null;
      try {
        revokeRuntimeContextObservation(scope.runtimeContextObservation);
        revokeAgentLoopGetVariablesCapability(scope.capability);
        revokeAgentLoopRollingSummaryProposalCapability(scope.proposalCapability);
        revokeAgentLoopRollingSummaryApplyCapability(scope.applyCapability);
        revokeAgentLoopCorrectionProposalCapability(scope.correctionProposalCapability);
        revokeAgentLoopCompletionRequest(scope.completionRequest);
        revokeFrozenAgentLoopCompletion(scope.evaluation);
        coordinator.forget(context.taskId);
      } finally {
        // Cleanup failure must not strand a settled Promise in the close/drain set.
        executions.delete(context.taskId); executionWork.delete(work);
      }
    });
    executionWork.add(work);
    return work;
  };
  const suspensionPort: AgentLoopTaskSuspensionPort = Object.freeze({
    suspendTask: (input: Omit<AgentLoopTaskSuspendRequest, 'ownerId'>) => {
      if (nodeTypes.isProxy(input)) throw new Error('agent-loop-suspension-unavailable');
      normalizeAgentLoopActionObject(input, ['taskId', 'expectedRevision', 'attemptId'], ['wait', 'pauseId']);
      if (isClosed || !suspensionHost) throw new Error('agent-loop-suspension-unavailable');
      return coordinator.suspendTask({ ...input, ownerId });
    },
    resumeTask: (input: Omit<AgentLoopTaskResumeRequest, 'ownerId' | 'leaseMs'>) => {
      if (nodeTypes.isProxy(input)) throw new Error('agent-loop-suspension-unavailable');
      normalizeAgentLoopActionObject(input, ['taskId', 'expectedRevision', 'attemptId', 'suspensionId', 'eventRef']);
      if (isClosed || !suspensionHost) throw new Error('agent-loop-suspension-unavailable');
      return coordinator.resumeTask({ ...input, ownerId, leaseMs: 60_000 });
    },
  });
  const runtime: AgentLoopServerComposition = Object.freeze({
    observeTurnJobPhase: (input: Readonly<{ runId: string; phase: TurnPhase }>) => enqueue({ family: 'turn', runId: input.runId, phase: input.phase }),
    observeMaintenanceJobPhase: (input: Readonly<{ runId: string; phase: MaintenancePhase }>) => enqueue({ family: 'maintenance', runId: input.runId, phase: input.phase }),
    executeMaintenance,
    inspectMaintenanceExecutionSupport: (input: Parameters<AgentLoopServerComposition['inspectMaintenanceExecutionSupport']>[0]) => describeAgentLoopMaintenanceExecutionSupport(input,
      { ...executionSupportHost, closed: isClosed }),
    inspectMaintenanceCorrectionSupport: (input: Parameters<AgentLoopServerComposition['inspectMaintenanceCorrectionSupport']>[0]) => describeAgentLoopMaintenanceCorrectionSupport(input,
      { ...correctionSupportHost, closed: isClosed }),
    whenIdle,
    close: (): Promise<void> => {
      isClosed = true;
      productionCanaryBinding.closed = true;
      const productionManager = productionCanaryBinding.manager;
      productionCanaryBinding.manager = null;
      productionCanaryBinding.onProjectionReady = null;
      const productionPort = PRODUCTION_CANARY_EXECUTION_PORT_BY_RUNTIME.get(runtime);
      if (productionPort) {
        PRODUCTION_CANARY_EXECUTION_PORTS.delete(productionPort);
        RUNTIME_BY_PRODUCTION_CANARY_EXECUTION_PORT.delete(productionPort);
        MANAGER_BY_PRODUCTION_CANARY_EXECUTION_PORT.delete(productionPort);
      }
      PRODUCTION_CANARY_EXECUTION_PORT_BY_RUNTIME.delete(runtime);
      PRODUCTION_CANARY_MANAGER_BY_RUNTIME.delete(runtime);
      if (productionManager
        && PRODUCTION_CANARY_RUNTIME_BY_MANAGER.get(productionManager) === runtime) {
        PRODUCTION_CANARY_RUNTIME_BY_MANAGER.delete(productionManager);
      }
      PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME.delete(runtime);
      revokeRuntimeContextObservations(runtime);
      revokeCapabilityManifest(runtime);
      TASK_SUSPENSION_PORTS.delete(runtime);
      STORE_BY_RUNTIME.delete(runtime);
      ISOLATED_CANARY_MANAGER_BY_RUNTIME.delete(runtime);
      return closePromise ??= whenIdle();
    },
    stats: (): AgentLoopServerCompositionStats => Object.freeze({
      version: AGENT_LOOP_SERVER_COMPOSITION_VERSION, accepted, dropped, errors, skipped,
      created, settled, probes, blockedProbes, prepareCandidates, prepareErrors,
      pending: pending.size, active: isActive, closed: isClosed,
    }),
  });
  RUNTIME_CONTEXT_OBSERVATIONS.set(runtime, activeRuntimeContextObservations);
  if (suspensionHost) TASK_SUSPENSION_PORTS.set(runtime, suspensionPort);
  rpReadonlyScope?.bind(runtime, taskId => coordinator.step({ taskId, ownerId }), taskId => coordinator.forget(taskId));
  rpChildJoinScope?.bind(runtime, coordinator);
  STORE_BY_RUNTIME.set(runtime, store);
  PRODUCTION_CANARY_BINDING_STATE_BY_RUNTIME.set(runtime, productionCanaryBinding);
  if (isolatedCanaryManager) {
    ISOLATED_CANARY_MANAGER_BY_RUNTIME.set(runtime, isolatedCanaryManager);
  }
  bindCapabilityManifest(runtime, createCapabilityManifest({
    executionProfile: executionProfile ? Object.freeze({
      version: executionProfile.version,
      route: executionProfile.route,
      publication: executionProfile.publication,
    }) : null,
    readExecution: correctionSupportHost.readExecutionReady,
    correctionProposalFactory: correctionSupportHost.correctionProposal,
    publicationRequiredByRuntime,
  }));
  return runtime;
}
