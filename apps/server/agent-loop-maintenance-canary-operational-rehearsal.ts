/**
 * §13.87 independent offline rehearsal join.
 *
 * Construction binds one exact open Runtime manifest, one reader-branded
 * source-policy proof and one internally recomputed v2 route plan. The later
 * `observe` call consumes exactly one Runtime-issued post-ACT/pre-OBSERVE
 * observation and seals a redacted receipt. Neither the join nor its receipt
 * authorizes a claim, execution, publication, replay, Canary or production.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION,
  AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION,
  AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION,
  AGENT_LOOP_SERVER_COMPOSITION_VERSION,
  consumeAgentLoopMaintenanceRuntimeContextObservation,
  isAgentLoopServerCompositionCapabilityManifest,
  readAgentLoopServerCompositionCapabilityManifest,
  type AgentLoopMaintenanceRuntimeContextObservation,
  type AgentLoopServerComposition,
} from './agent-loop-runtime.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION,
  planAgentLoopMaintenanceCanaryRouteV2,
  type AgentLoopMaintenanceCanaryRoutePlanV2,
  type AgentLoopMaintenanceCanaryRoutePlanV2Input,
} from './agent-loop-maintenance-canary-route-plan-v2.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION,
  agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest,
  isAgentLoopMaintenanceCanarySourcePolicyReader,
  type AgentLoopMaintenanceCanarySourcePolicyProof,
  type AgentLoopMaintenanceCanarySourcePolicyReader,
} from './agent-loop-maintenance-canary-source-policy.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST,
} from './agent-loop-maintenance-production-route-contract.ts';

export const AGENT_LOOP_MAINTENANCE_CANARY_OPERATIONAL_REHEARSAL_VERSION =
  'agent-loop-maintenance-canary-operational-rehearsal-v1' as const;

export interface AgentLoopMaintenanceCanaryOperationalRehearsalInput {
  readonly runtime: AgentLoopServerComposition;
  readonly sourcePolicyReader: AgentLoopMaintenanceCanarySourcePolicyReader;
  readonly sourcePolicyProof: AgentLoopMaintenanceCanarySourcePolicyProof;
  readonly routePlanInput: AgentLoopMaintenanceCanaryRoutePlanV2Input;
}

export interface AgentLoopMaintenanceCanaryOperationalRehearsalReceipt {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CANARY_OPERATIONAL_REHEARSAL_VERSION;
  readonly classification: 'exact-runtime-offline-operational-rehearsal-non-authorizing';
  readonly sourcePolicy: Readonly<{
    version: typeof AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION;
    proofDigest: string;
    sourcePolicyVerified: true;
    historicalCompatibility: AgentLoopMaintenanceCanarySourcePolicyProof['compatibility'];
  }>;
  readonly routePlan: Readonly<{
    version: typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION;
    planDigest: string;
    plannedRoute: 'agent-loop';
    reasonCodes: readonly ['candidate-selected'];
    preflight: Readonly<{
      status: 'blocked';
      missing: readonly ['production-single-route-selector'];
    }>;
  }>;
  readonly routeContract: AgentLoopMaintenanceCanaryRoutePlanV2['routeContract'];
  readonly runtime: Readonly<{
    manifestVersion: typeof AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION;
    compositionVersion: typeof AGENT_LOOP_SERVER_COMPOSITION_VERSION;
    contextObservationVersion: typeof AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION;
    executionProfile: Readonly<{
      version: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION;
      route: 'correction-proposal';
      publication: 'required';
    }>;
  }>;
  readonly bindings: Readonly<{
    sourcePolicyProofDigest: string;
    routePlanJobDigest: string;
    queuedJobDigest: string;
    routePlanDigest: string;
    routeContractDigest: string;
    runtimeContextObservationDigest: string;
    claimDigest: string;
  }>;
  readonly observed: Readonly<{
    sourcePolicyProofBranded: true;
    runtimeManifestBranded: true;
    runtimeContextObservationConsumed: true;
    claimedContext: true;
    runtimeBundleValidated: true;
    actionClosed: true;
    publicationInstantiated: true;
    publicationValidated: true;
    timing: 'post-action-pre-observe';
  }>;
  /** The planner input is a rehearsal prerequisite, not production readiness. */
  readonly readiness: Readonly<{
    productionSingleRouteSelector: false;
    sourcePolicy: false;
    runtimeBundle: false;
    publication: false;
    operationalEvidence: false;
  }>;
  readonly preClaimReady: false;
  readonly replayAuthorized: false;
  readonly admissionAuthorized: false;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
  readonly receiptDigest: string;
}

export interface AgentLoopMaintenanceCanaryOperationalRehearsal {
  observe(evidence: unknown): void;
  read(): AgentLoopMaintenanceCanaryOperationalRehearsalReceipt | null;
  isEvidence(value: unknown): value is AgentLoopMaintenanceCanaryOperationalRehearsalReceipt;
}

const INPUT_KEYS = Object.freeze([
  'routePlanInput', 'runtime', 'sourcePolicyProof', 'sourcePolicyReader',
]);
const READER_KEYS = Object.freeze(['isProof', 'read']);
const ROUTE_PLAN_INPUT_KEYS = Object.freeze(['job', 'readiness', 'routeControl', 'safety']);
const READINESS_KEYS = Object.freeze([
  'operationalEvidence', 'publication', 'runtimeBundle', 'sourcePolicy',
]);
const HASH = /^sha256:[a-f0-9]{64}$/u;

function invalidInput(): never {
  throw new Error('agent-loop-maintenance-canary-operational-rehearsal-input-invalid');
}

function invalidObservation(): never {
  throw new Error('agent-loop-maintenance-canary-operational-rehearsal-observation-invalid');
}

function exactOwnData(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || nodeTypes.isProxy(input) || nodeTypes.isPromise(input)) invalidInput();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'
      || !keys.includes(key))) invalidInput();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) invalidInput();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    invalidInput();
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function allAuthorityFalse(value: Readonly<{
  claimAuthorized: boolean;
  executionAuthorized: boolean;
  completionAuthorized: boolean;
  publicationAuthorized: boolean;
  canaryAuthorized: boolean;
  productionEligible: boolean;
}>): boolean {
  return value.claimAuthorized === false
    && value.executionAuthorized === false
    && value.completionAuthorized === false
    && value.publicationAuthorized === false
    && value.canaryAuthorized === false
    && value.productionEligible === false;
}

function exactSingle<T>(value: readonly T[], expected: T): boolean {
  return value.length === 1 && value[0] === expected;
}

function validateConstruction(
  unsafeInput: AgentLoopMaintenanceCanaryOperationalRehearsalInput,
): Readonly<{
  runtime: AgentLoopServerComposition;
  proof: AgentLoopMaintenanceCanarySourcePolicyProof;
  plan: AgentLoopMaintenanceCanaryRoutePlanV2;
  queuedJobDigest: string;
  manifest: NonNullable<ReturnType<typeof readAgentLoopServerCompositionCapabilityManifest>>;
}> {
  const input = exactOwnData(unsafeInput, INPUT_KEYS);
  const runtime = input.runtime as AgentLoopServerComposition;
  const reader = input.sourcePolicyReader as AgentLoopMaintenanceCanarySourcePolicyReader;
  const proof = input.sourcePolicyProof as AgentLoopMaintenanceCanarySourcePolicyProof;
  const routePlanInput = input.routePlanInput as AgentLoopMaintenanceCanaryRoutePlanV2Input;
  if (!isAgentLoopMaintenanceCanarySourcePolicyReader(reader)) invalidInput();
  const readerData = exactOwnData(reader, READER_KEYS);
  if (typeof readerData.read !== 'function' || nodeTypes.isProxy(readerData.read)
    || typeof readerData.isProof !== 'function' || nodeTypes.isProxy(readerData.isProof)) invalidInput();

  let branded = false;
  try {
    branded = Reflect.apply(readerData.isProof as (value: unknown) => boolean, reader, [proof]) === true;
  } catch {
    invalidInput();
  }
  if (!branded) invalidInput();

  const planInput = exactOwnData(routePlanInput, ROUTE_PLAN_INPUT_KEYS);
  const readiness = exactOwnData(planInput.readiness, READINESS_KEYS);
  if (!READINESS_KEYS.every((key) => readiness[key] === true)) invalidInput();

  let plan: AgentLoopMaintenanceCanaryRoutePlanV2;
  try {
    plan = planAgentLoopMaintenanceCanaryRouteV2(routePlanInput);
  } catch {
    invalidInput();
  }
  const queuedJobDigest = agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(planInput.job);
  const manifest = readAgentLoopServerCompositionCapabilityManifest(runtime);
  if (!manifest || !isAgentLoopServerCompositionCapabilityManifest(runtime, manifest)) invalidInput();
  const profile = manifest.captured.executionProfile;

  if (proof.version !== AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION
    || proof.classification !== 'reader-instance-issued-source-policy-read-only'
    || proof.sourcePolicyVerified !== true || proof.readinessAuditAccepted !== false
    || !allAuthorityFalse(proof)
    || proof.productionSource.taskKind !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.taskKind
    || proof.productionSource.mode !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.mode
    || proof.productionSource.trigger !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.trigger
    || proof.productionSource.policyVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion
    || proof.compatibility.routePlanVersion !== 'agent-loop-maintenance-canary-route-plan-v1'
    || proof.compatibility.routePlanPolicyVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion
    || proof.compatibility.routePlanCompatible !== false
    || proof.compatibility.reason !== 'production-policy-not-selected-by-route-plan-v1'
    || !HASH.test(proof.proofDigest)
    || plan.version !== AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_V2_VERSION
    || plan.plannedRoute !== 'agent-loop'
    || !exactSingle(plan.reasonCodes, 'candidate-selected')
    || plan.preflight.status !== 'blocked'
    || !exactSingle(plan.preflight.missing, 'production-single-route-selector')
    || !allAuthorityFalse(plan)
    || !plan.bindings.jobDigest
    || proof.bindings.routePlanJobDigest !== plan.bindings.jobDigest
    || !queuedJobDigest
    || proof.bindings.queuedJobDigest !== queuedJobDigest
    || !HASH.test(plan.planDigest)
    || manifest.version !== AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION
    || manifest.compositionVersion !== AGENT_LOOP_SERVER_COMPOSITION_VERSION
    || manifest.classification !== 'runtime-instance-issued-construction-manifest'
    || !manifest.structurallyReady || !allAuthorityFalse(manifest)
    || manifest.routeContract.version !== plan.routeContract.version
    || manifest.routeContract.digest !== plan.routeContract.digest
    || manifest.routeContract.acceptanceVersion !== plan.routeContract.acceptanceVersion
    || manifest.routeContract.contractVersion !== plan.routeContract.executionContractVersion
    || plan.routeContract.digest !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST
    || plan.routeContract.admissionPolicyVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission.policyVersion
    || plan.routeContract.executionPolicyVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.policyVersion
    || plan.routeContract.acceptanceVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.acceptanceVersion
    || plan.routeContract.executionContractVersion !== AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.execution.contractVersion
    || plan.scope.route !== 'correction-proposal'
    || !profile
    || profile.version !== AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION
    || profile.route !== plan.scope.route || profile.publication !== 'required'
    || manifest.captured.readExecution !== true
    || manifest.captured.correctionProposalFactory !== true
    || manifest.captured.publicationRequiredByRuntime !== true) invalidInput();

  return Object.freeze({ runtime, proof, plan, queuedJobDigest, manifest });
}

function validRuntimeObservation(
  value: AgentLoopMaintenanceRuntimeContextObservation,
  plan: AgentLoopMaintenanceCanaryRoutePlanV2,
  queuedJobDigest: string,
): boolean {
  return value.version === AGENT_LOOP_MAINTENANCE_RUNTIME_CONTEXT_OBSERVATION_VERSION
    && value.compositionVersion === AGENT_LOOP_SERVER_COMPOSITION_VERSION
    && value.classification === 'runtime-instance-issued-context-observation'
    && value.observed.claimedContext === true
    && value.observed.runtimeBundleValidated === true
    && value.observed.actionClosed === true
    && value.observed.publicationInstantiated === true
    && value.observed.publicationValidated === true
    && value.observed.timing === 'post-action-pre-observe'
    && value.bindings.routePlanJobDigest === plan.bindings.jobDigest
    && value.bindings.queuedJobDigest === queuedJobDigest
    && value.bindings.routeContractVersion === plan.routeContract.version
    && value.bindings.routeContractDigest === plan.routeContract.digest
    && value.bindings.admissionPolicyVersion === plan.routeContract.admissionPolicyVersion
    && value.bindings.executionPolicyVersion === plan.routeContract.executionPolicyVersion
    && value.bindings.acceptanceVersion === plan.routeContract.acceptanceVersion
    && value.bindings.executionContractVersion === plan.routeContract.executionContractVersion
    && value.bindings.executionProfileVersion === AGENT_LOOP_MAINTENANCE_EXECUTION_PROFILE_VERSION
    && value.bindings.route === plan.scope.route
    && value.bindings.publication === 'required'
    && HASH.test(value.bindings.claimDigest)
    && value.redactions.contentIncluded === false
    && value.redactions.capabilityIncluded === false
    && value.redactions.identityIncluded === false
    && value.preClaimReady === false
    && value.replayAuthorized === false
    && allAuthorityFalse(value)
    && HASH.test(value.observationDigest)
    && Object.isFrozen(value)
    && Object.isFrozen(value.observed)
    && Object.isFrozen(value.bindings)
    && Object.isFrozen(value.redactions);
}

function freezeReceipt(
  proof: AgentLoopMaintenanceCanarySourcePolicyProof,
  plan: AgentLoopMaintenanceCanaryRoutePlanV2,
  queuedJobDigest: string,
  observation: AgentLoopMaintenanceRuntimeContextObservation,
): AgentLoopMaintenanceCanaryOperationalRehearsalReceipt {
  const routeContract = Object.freeze({ ...plan.routeContract });
  const stable = {
    version: AGENT_LOOP_MAINTENANCE_CANARY_OPERATIONAL_REHEARSAL_VERSION,
    classification: 'exact-runtime-offline-operational-rehearsal-non-authorizing' as const,
    sourcePolicy: Object.freeze({
      version: proof.version,
      proofDigest: proof.proofDigest,
      sourcePolicyVerified: true as const,
      historicalCompatibility: Object.freeze({ ...proof.compatibility }),
    }),
    routePlan: Object.freeze({
      version: plan.version,
      planDigest: plan.planDigest,
      plannedRoute: 'agent-loop' as const,
      reasonCodes: Object.freeze(['candidate-selected'] as const),
      preflight: Object.freeze({
        status: 'blocked' as const,
        missing: Object.freeze(['production-single-route-selector'] as const),
      }),
    }),
    routeContract,
    runtime: Object.freeze({
      manifestVersion: AGENT_LOOP_SERVER_COMPOSITION_CAPABILITY_MANIFEST_VERSION,
      compositionVersion: observation.compositionVersion,
      contextObservationVersion: observation.version,
      executionProfile: Object.freeze({
        version: observation.bindings.executionProfileVersion,
        route: observation.bindings.route,
        publication: observation.bindings.publication,
      }),
    }),
    bindings: Object.freeze({
      sourcePolicyProofDigest: proof.proofDigest,
      routePlanJobDigest: plan.bindings.jobDigest!,
      queuedJobDigest,
      routePlanDigest: plan.planDigest,
      routeContractDigest: plan.routeContract.digest,
      runtimeContextObservationDigest: observation.observationDigest,
      claimDigest: observation.bindings.claimDigest,
    }),
    observed: Object.freeze({
      sourcePolicyProofBranded: true as const,
      runtimeManifestBranded: true as const,
      runtimeContextObservationConsumed: true as const,
      claimedContext: observation.observed.claimedContext,
      runtimeBundleValidated: observation.observed.runtimeBundleValidated,
      actionClosed: observation.observed.actionClosed,
      publicationInstantiated: observation.observed.publicationInstantiated,
      publicationValidated: observation.observed.publicationValidated,
      timing: observation.observed.timing,
    }),
    readiness: Object.freeze({
      productionSingleRouteSelector: false as const,
      sourcePolicy: false as const,
      runtimeBundle: false as const,
      publication: false as const,
      operationalEvidence: false as const,
    }),
    preClaimReady: false as const,
    replayAuthorized: false as const,
    admissionAuthorized: false as const,
    claimAuthorized: false as const,
    executionAuthorized: false as const,
    completionAuthorized: false as const,
    publicationAuthorized: false as const,
    canaryAuthorized: false as const,
    productionEligible: false as const,
  };
  return Object.freeze({ ...stable, receiptDigest: digest(stable) });
}

/**
 * Build a one-shot, exact-instance offline rehearsal join. Construction is
 * read-only and never invokes a correction factory, publication callback,
 * Provider, Manager claim or dispatcher.
 */
export function createAgentLoopMaintenanceCanaryOperationalRehearsal(
  unsafeInput: AgentLoopMaintenanceCanaryOperationalRehearsalInput,
): AgentLoopMaintenanceCanaryOperationalRehearsal {
  const { runtime, proof, plan, queuedJobDigest } = validateConstruction(unsafeInput);
  const issued = new WeakSet<object>();
  let attempted = false;
  let receipt: AgentLoopMaintenanceCanaryOperationalRehearsalReceipt | null = null;
  return Object.freeze({
    observe(evidence: unknown): void {
      if (attempted) invalidObservation();
      attempted = true;
      let consumed: AgentLoopMaintenanceRuntimeContextObservation | null = null;
      try {
        consumed = consumeAgentLoopMaintenanceRuntimeContextObservation(runtime, evidence);
      } catch {
        invalidObservation();
      }
      if (!consumed || !validRuntimeObservation(consumed, plan, queuedJobDigest)) invalidObservation();
      receipt = freezeReceipt(proof, plan, queuedJobDigest, consumed);
      issued.add(receipt);
    },
    read(): AgentLoopMaintenanceCanaryOperationalRehearsalReceipt | null {
      return receipt;
    },
    isEvidence(value: unknown): value is AgentLoopMaintenanceCanaryOperationalRehearsalReceipt {
      return !!value && typeof value === 'object' && issued.has(value);
    },
  });
}
