import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_GRANT_VERSION,
  AGENT_SKILL_SELECTION_REQUEST_VERSION,
  AGENT_SKILL_SOURCE_PROOF_VERSION,
  normalizeAgentSkillCatalogSnapshot,
  normalizeAgentSkillExecutionGrant,
  normalizeAgentSkillSelectionReceipt,
  normalizeAgentSkillSelectionRequest,
  selectAgentSkillHeaders,
  type AgentSkillAdmissionV1,
  type AgentSkillCandidateRefV1,
  type AgentSkillCatalogPort,
  type AgentSkillContentMode,
  type AgentSkillExecutionGrantV1,
  type AgentSkillPhase,
  type AgentSkillProfileAuthorizationV1,
  type AgentSkillRiskTier,
  type AgentSkillSelectionReceiptV1,
  type AgentSkillSelectionRequestV1,
  type AgentSkillSourceProofV1,
  type AgentSkillTargetScopeV1,
  type AgentSkillVersionRefV1,
} from '@jiuguan/skill-hub';
import {
  verifyCompiledAgentSkillArtifact,
  type AgentSkillCompilationRequestV1,
  type CompiledAgentSkillArtifactV1,
} from '@jiuguan/prompt/agent-skill-compiler';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import type {
  AgentAdmissionLease,
  AgentAdmissionLeaseClaimPurpose,
} from '../agent-admission-broker.ts';
import type {
  RegisteredServerAgentSkillProfilePolicyV1,
  ServerAgentSkillProfileAuthorizationV1,
  ServerAgentSkillProfilePolicyRegistry,
} from './profile-policy-registry.ts';
import {
  isServerAgentSkillRuntimeForCatalog,
  type AgentSkillAdmissionGuard,
  type GuardedAgentSkillAdmission,
  type ServerAgentSkillRuntimePort,
} from './composition.ts';
import type {
  ServerAgentSkillSourceAuthorityEntryV1,
  ServerAgentSkillSourceAuthorityRegistry,
} from './source-authority-registry.ts';

export const SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION =
  'server-agent-skill-admission-context-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_ADMISSION_VERSION =
  'server-agent-skill-profile-admission-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_ADMISSION_TRACE_VERSION =
  'server-agent-skill-profile-admission-trace-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION =
  'server-agent-skill-profile-admission-handle-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_CONSUMPTION_VERSION =
  'server-agent-skill-profile-consumption-v1' as const;

export const AGENT_SKILL_PROFILE_ADMISSION_ERROR_CODES = Object.freeze([
  'agent-skill-profile-admission-lease-not-owned',
  'agent-skill-profile-admission-purpose-denied',
  'agent-skill-profile-admission-lease-replayed',
  'agent-skill-profile-admission-lease-expired',
  'agent-skill-profile-admission-context-invalid',
  'agent-skill-profile-admission-context-drift',
  'agent-skill-profile-admission-lease-binding-mismatch',
  'agent-skill-profile-admission-capability-not-bound',
  'agent-skill-profile-admission-profile-mismatch',
  'agent-skill-profile-admission-nsfw-safety-required',
  'agent-skill-profile-admission-profile-unavailable',
  'agent-skill-profile-admission-catalog-unavailable',
  'agent-skill-profile-admission-catalog-drift',
  'agent-skill-profile-admission-policy-denied',
  'agent-skill-profile-admission-source-denied',
  'agent-skill-profile-admission-authority-drift',
  'agent-skill-profile-admission-runtime-rejected',
  'agent-skill-profile-admission-compiler-rejected',
  'agent-skill-profile-admission-compiled-binding-mismatch',
  'agent-skill-profile-admission-handle-not-owned',
  'agent-skill-profile-admission-handle-replayed',
  'agent-skill-profile-admission-consumer-rejected',
] as const);

export type AgentSkillProfileAdmissionErrorCode =
  typeof AGENT_SKILL_PROFILE_ADMISSION_ERROR_CODES[number];

/** Stable, content-free failure surface for a future production caller. */
export class AgentSkillProfileAdmissionError extends Error {
  constructor(
    readonly code: AgentSkillProfileAdmissionErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'AgentSkillProfileAdmissionError';
  }
}

/**
 * Server-owned context for one exact Lease. The transport is deliberately absent: a future live
 * composition root must read this snapshot from current control/session/safety authority.
 */
export interface ServerAgentSkillAdmissionContextSeedV1 {
  readonly snapshotVersion: typeof SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION;
  readonly ticketId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentAdmissionLease['lane'];
  readonly taskKind: AgentAdmissionLease['taskKind'];
  readonly policyVersion: string;
  readonly contentMode: AgentSkillContentMode;
  readonly capabilityId: string;
  readonly profileId: string;
  readonly phase: AgentSkillPhase;
  readonly scope: AgentSkillTargetScopeV1;
  readonly explicit: readonly AgentSkillVersionRefV1[];
  /** `null` is distinct from an authoritative empty discovery result. */
  readonly candidates: readonly AgentSkillCandidateRefV1[] | null;
  /** Current host/control ceilings; it is intersected with both Lease and Profile policy. */
  readonly runtimeGrant: AgentSkillExecutionGrantV1;
  /** Maximum materialized body tokens available inside the prompt headroom. */
  readonly maxBodyTokens: number;
  /** Maximum final fixed-template wrapper tokens, after compiler overhead. */
  readonly maxCompiledInstructionTokens: number;
  readonly maxValidatorOperations: number;
  readonly maxSkills: number;
  /** Revision of the exact capability/lane control rows used to build this snapshot. */
  readonly controlRevision: string;
  /** Required for `nsfw`; null for `nsf`. It binds adult/age/consent/worldbook safety state. */
  readonly nsfwSafetyDigest: string | null;
}

export interface ServerAgentSkillAdmissionContextSnapshotV1
  extends ServerAgentSkillAdmissionContextSeedV1 {
  readonly contextRevision: string;
}

export interface ServerAgentSkillAdmissionContextAuthorityPort {
  /**
   * Must resolve only from server-owned session/control/safety state for this exact Lease, and
   * fail closed rather than issue a snapshot while its lane or exact capability is killed.
   */
  readForLease(lease: AgentAdmissionLease):
    ServerAgentSkillAdmissionContextSnapshotV1
    | Promise<ServerAgentSkillAdmissionContextSnapshotV1>;
}

export interface AgentAdmissionLeaseAuthorityPort {
  /** Process-local identity check; structural copies never pass. */
  ownsLease(candidate: unknown): candidate is AgentAdmissionLease;
  /** The Ticket must explicitly grant this closed server purpose; ordinary Leases grant none. */
  allowsLeaseClaim(
    candidate: unknown,
    purpose: AgentAdmissionLeaseClaimPurpose,
  ): candidate is AgentAdmissionLease;
  /** Synchronously burns one exact, server-defined purpose before the service's first await. */
  claimLease(
    candidate: unknown,
    purpose: AgentAdmissionLeaseClaimPurpose,
  ): candidate is AgentAdmissionLease;
}

export type ServerAgentSkillCompilationRequestV1 = AgentSkillCompilationRequestV1;
export type CompiledAgentSkillArtifactBindingV1 = CompiledAgentSkillArtifactV1;

/** The compiler result is untrusted until the official deterministic verifier recompiles it. */
export interface AgentSkillProgramCompilerPort {
  compile(request: ServerAgentSkillCompilationRequestV1): unknown | Promise<unknown>;
}

export interface ServerAgentSkillProfileAdmissionTraceV1 {
  readonly traceVersion: typeof SERVER_AGENT_SKILL_PROFILE_ADMISSION_TRACE_VERSION;
  readonly leaseBindingDigest: string;
  readonly contextRevision: string;
  readonly catalogRevision: string;
  readonly capabilityId: string;
  readonly profileId: string;
  readonly profilePolicyRevision: string;
  readonly profileRegistryRevision: string;
  readonly sourceAuthorityRevision: string;
  readonly authorityRevision: string;
  readonly selectionReceiptDigest: string;
  readonly admissionDigest: string;
  readonly effectiveGrantDigest: string;
  readonly maxBodyTokens: number;
  readonly maxCompiledInstructionTokens: number;
  readonly maxValidatorOperations: number;
  readonly compiledArtifactDigest: string;
  readonly traceDigest: string;
}

/** Opaque by process identity: structural copies are rejected by `consume`. */
export interface ServerAgentSkillProfileAdmissionHandleV1 {
  readonly handleVersion: typeof SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION;
  readonly trace: ServerAgentSkillProfileAdmissionTraceV1;
}

export interface ServerAgentSkillProfileConsumptionV1 {
  readonly consumptionVersion: typeof SERVER_AGENT_SKILL_PROFILE_CONSUMPTION_VERSION;
  readonly ticketId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly toolSetDigest: string;
  readonly contentMode: AgentSkillContentMode;
  readonly contextRevision: string;
  readonly nsfwSafetyDigest: string | null;
  readonly expiresAtMs: number;
  readonly artifact: CompiledAgentSkillArtifactV1;
  readonly trace: ServerAgentSkillProfileAdmissionTraceV1;
}

/**
 * Fixed trusted-computing-base typed-slot sink. It must be an audited server-local synchronous
 * adapter, never transport/model/plugin supplied, and must return no bearer artifact. A Promise
 * return is rejected as a composition error, but only after invocation, so trust is established at
 * the composition root rather than inferred from a structural callback.
 */
export interface ServerAgentSkillProfileConsumerPort {
  consume(input: ServerAgentSkillProfileConsumptionV1): void;
}

const PROFILE_CONSUMPTIONS = new WeakSet<object>();

/** A structural or JSON copy cannot be staged by a production Prompt consumer. */
export function isServerAgentSkillProfileConsumption(
  input: unknown,
): input is ServerAgentSkillProfileConsumptionV1 {
  return input !== null && typeof input === 'object' && PROFILE_CONSUMPTIONS.has(input);
}

export interface ServerAgentSkillProfileAdmissionServiceDependencies {
  readonly leaseAuthority: AgentAdmissionLeaseAuthorityPort;
  readonly catalogPort: AgentSkillCatalogPort;
  readonly runtimePort: ServerAgentSkillRuntimePort;
  readonly profileRegistry: ServerAgentSkillProfilePolicyRegistry;
  readonly contextAuthority: ServerAgentSkillAdmissionContextAuthorityPort;
  readonly sourceAuthority: ServerAgentSkillSourceAuthorityRegistry;
  readonly compiler: AgentSkillProgramCompilerPort;
  readonly consumer: ServerAgentSkillProfileConsumerPort;
  readonly nowMs?: () => number;
}

const CONTEXT_SEED_KEYS = new Set([
  'snapshotVersion', 'ticketId', 'runId', 'parentRunId', 'sessionId', 'sourceRevision',
  'lane', 'taskKind', 'policyVersion', 'contentMode', 'capabilityId', 'profileId', 'phase',
  'scope', 'explicit', 'candidates', 'runtimeGrant', 'maxBodyTokens',
  'maxCompiledInstructionTokens', 'maxValidatorOperations', 'maxSkills', 'controlRevision',
  'nsfwSafetyDigest',
]);
const CONTEXT_SNAPSHOT_KEYS = new Set([...CONTEXT_SEED_KEYS, 'contextRevision']);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const RISK_ORDER: Readonly<Record<AgentSkillRiskTier, number>> = Object.freeze({
  advisory: 0,
  proposal: 1,
  write: 2,
});
const RISK_BY_ORDER = Object.freeze(['advisory', 'proposal', 'write'] as const);

const PROFILE_ADMISSION_LEASE_PURPOSE: AgentAdmissionLeaseClaimPurpose =
  SERVER_AGENT_SKILL_PROFILE_ADMISSION_VERSION;

function fail(code: AgentSkillProfileAdmissionErrorCode, cause?: unknown): never {
  throw new AgentSkillProfileAdmissionError(code, cause === undefined ? undefined : { cause });
}

function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const unsupported = Object.keys(value).find((key) => !keys.has(key));
  if (unsupported !== undefined) throw new TypeError(`${label} contains unsupported field: ${unsupported}`);
  const missing = [...keys].find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label}.${missing} is required`);
}

function stableToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    throw new TypeError(`${label} must be a stable token`);
  }
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  plainRecord(value, 'canonical JSON value');
  return `{${Object.keys(value).sort().map((key) => {
    const child = value[key];
    if (child === undefined) throw new TypeError('canonical JSON rejects undefined');
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  }).join(',')}}`;
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object') {
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    if (!Object.isFrozen(object)) Object.freeze(object);
  }
  return value;
}

function normalizeContextSeed(input: unknown): ServerAgentSkillAdmissionContextSeedV1 {
  plainRecord(input, 'profileAdmissionContext');
  exactKeys(input, CONTEXT_SEED_KEYS, 'profileAdmissionContext');
  if (input.snapshotVersion !== SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION) {
    throw new TypeError(
      `profileAdmissionContext.snapshotVersion must be ${SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION}`,
    );
  }
  const runtimeGrant = normalizeAgentSkillExecutionGrant(input.runtimeGrant);
  const maxBodyTokens = boundedInteger(
    input.maxBodyTokens,
    'profileAdmissionContext.maxBodyTokens',
    0,
    10_000_000,
  );
  const normalizedRequest = normalizeAgentSkillSelectionRequest({
    requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
    catalogRevision: ZERO_DIGEST,
    capabilityId: input.capabilityId,
    taskKind: input.taskKind,
    phase: input.phase,
    contentMode: input.contentMode,
    scope: input.scope,
    grant: runtimeGrant,
    // This normalization pass validates the nested selector shapes. The independent authority
    // ceiling is preserved below and intersected only when the real request is built.
    budgetTokens: Math.min(maxBodyTokens, runtimeGrant.maxInputTokens),
    maxSkills: input.maxSkills,
    explicit: input.explicit,
    ...(input.candidates === null ? {} : { candidates: input.candidates }),
  });
  const lane = input.lane;
  if (lane !== 'interactive' && lane !== 'maintenance' && lane !== 'learning' && lane !== 'critic') {
    throw new TypeError('profileAdmissionContext.lane is invalid');
  }
  const nsfwSafetyDigest = input.nsfwSafetyDigest === null
    ? null
    : sha256Digest(input.nsfwSafetyDigest, 'profileAdmissionContext.nsfwSafetyDigest');
  if (normalizedRequest.contentMode === 'nsf' && nsfwSafetyDigest !== null) {
    throw new TypeError('profileAdmissionContext.nsfwSafetyDigest must be null for nsf');
  }
  return deepFreeze({
    snapshotVersion: SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION,
    ticketId: stableToken(input.ticketId, 'profileAdmissionContext.ticketId'),
    runId: stableToken(input.runId, 'profileAdmissionContext.runId'),
    parentRunId: stableToken(input.parentRunId, 'profileAdmissionContext.parentRunId'),
    sessionId: stableToken(input.sessionId, 'profileAdmissionContext.sessionId'),
    sourceRevision: stableToken(input.sourceRevision, 'profileAdmissionContext.sourceRevision'),
    lane,
    taskKind: normalizedRequest.taskKind as AgentAdmissionLease['taskKind'],
    policyVersion: stableToken(input.policyVersion, 'profileAdmissionContext.policyVersion'),
    contentMode: normalizedRequest.contentMode,
    capabilityId: normalizedRequest.capabilityId,
    profileId: stableToken(input.profileId, 'profileAdmissionContext.profileId'),
    phase: normalizedRequest.phase,
    scope: normalizedRequest.scope,
    explicit: normalizedRequest.explicit,
    candidates: input.candidates === null ? null : normalizedRequest.candidates ?? Object.freeze([]),
    runtimeGrant,
    maxBodyTokens,
    maxCompiledInstructionTokens: boundedInteger(
      input.maxCompiledInstructionTokens,
      'profileAdmissionContext.maxCompiledInstructionTokens',
      0,
      10_000_000,
    ),
    maxValidatorOperations: boundedInteger(
      input.maxValidatorOperations,
      'profileAdmissionContext.maxValidatorOperations',
      0,
      1_000,
    ),
    maxSkills: normalizedRequest.maxSkills,
    controlRevision: stableToken(input.controlRevision, 'profileAdmissionContext.controlRevision'),
    nsfwSafetyDigest,
  });
}

export function createServerAgentSkillAdmissionContextSnapshot(
  input: unknown,
): ServerAgentSkillAdmissionContextSnapshotV1 {
  const core = normalizeContextSeed(input);
  return deepFreeze({ ...core, contextRevision: canonicalDigest(core) });
}

export function normalizeServerAgentSkillAdmissionContextSnapshot(
  input: unknown,
): ServerAgentSkillAdmissionContextSnapshotV1 {
  plainRecord(input, 'profileAdmissionContextSnapshot');
  exactKeys(input, CONTEXT_SNAPSHOT_KEYS, 'profileAdmissionContextSnapshot');
  const { contextRevision: claimedRevision, ...seed } = input;
  const snapshot = createServerAgentSkillAdmissionContextSnapshot(seed);
  if (sha256Digest(claimedRevision, 'profileAdmissionContextSnapshot.contextRevision')
    !== snapshot.contextRevision) {
    throw new TypeError('profileAdmissionContextSnapshot.contextRevision mismatch');
  }
  return snapshot;
}

function leaseBindingDigest(lease: AgentAdmissionLease): string {
  return canonicalDigest({
    version: lease.version,
    ticketId: lease.ticketId,
    requestDigest: lease.requestDigest,
    runId: lease.runId,
    parentRunId: lease.parentRunId,
    sessionId: lease.sessionId,
    sourceRevision: lease.sourceRevision,
    lane: lease.lane,
    taskKind: lease.taskKind,
    policyVersion: lease.policyVersion,
    modelId: lease.modelId,
    budgetProfileDigest: lease.budgetProfileDigest,
    toolSetDigest: lease.toolSetDigest,
    mode: lease.mode,
    limits: lease.limits,
    allowedTools: lease.allowedTools,
    consumedAtMs: lease.consumedAtMs,
    expiresAtMs: lease.expiresAtMs,
  });
}

function assertContextLeaseBindings(
  context: ServerAgentSkillAdmissionContextSnapshotV1,
  lease: AgentAdmissionLease,
): void {
  if (context.ticketId !== lease.ticketId
    || context.runId !== lease.runId
    || context.parentRunId !== lease.parentRunId
    || context.sessionId !== lease.sessionId
    || context.sourceRevision !== lease.sourceRevision
    || context.lane !== lease.lane
    || context.taskKind !== lease.taskKind
    || context.policyVersion !== lease.policyVersion
    || context.contentMode !== lease.mode
    || context.scope.sessionId !== lease.sessionId) {
    fail('agent-skill-profile-admission-lease-binding-mismatch');
  }
  if (!agentCapabilitiesForAdmission(lease).includes(context.capabilityId as never)) {
    fail('agent-skill-profile-admission-capability-not-bound');
  }
  if (context.profileId !== context.capabilityId) {
    fail('agent-skill-profile-admission-profile-mismatch');
  }
  if (lease.mode === 'nsfw' && context.nsfwSafetyDigest === null) {
    fail('agent-skill-profile-admission-nsfw-safety-required');
  }
}

function sortedIntersection(...sets: readonly (readonly string[])[]): readonly string[] {
  if (sets.length === 0) return Object.freeze([]);
  const rest = sets.slice(1).map((items) => new Set(items));
  return Object.freeze([...new Set(sets[0])]
    .filter((item) => rest.every((values) => values.has(item)))
    .sort());
}

function minimumRiskTier(...tiers: readonly AgentSkillRiskTier[]): AgentSkillRiskTier {
  return RISK_BY_ORDER[Math.min(...tiers.map((tier) => RISK_ORDER[tier]))]!;
}

function effectiveGrant(
  lease: AgentAdmissionLease,
  context: ServerAgentSkillAdmissionContextSnapshotV1,
  policy: RegisteredServerAgentSkillProfilePolicyV1,
): AgentSkillExecutionGrantV1 {
  return normalizeAgentSkillExecutionGrant({
    grantVersion: AGENT_SKILL_GRANT_VERSION,
    tools: sortedIntersection(lease.allowedTools, context.runtimeGrant.tools, policy.allowedTools),
    writableArtifactKinds: sortedIntersection(
      context.runtimeGrant.writableArtifactKinds,
      policy.allowedWritableArtifactKinds,
    ),
    maxRiskTier: minimumRiskTier(context.runtimeGrant.maxRiskTier, policy.maxRiskTier),
    maxModelCalls: Math.min(
      lease.limits.maxModelCalls,
      context.runtimeGrant.maxModelCalls,
      policy.executionCeiling.maxModelCalls,
    ),
    maxToolCalls: Math.min(
      lease.limits.maxToolCalls,
      context.runtimeGrant.maxToolCalls,
      policy.executionCeiling.maxToolCalls,
    ),
    maxInputTokens: Math.min(
      lease.limits.maxInputTokens,
      context.runtimeGrant.maxInputTokens,
      policy.executionCeiling.maxInputTokens,
    ),
    maxOutputTokens: Math.min(
      lease.limits.maxOutputTokens,
      context.runtimeGrant.maxOutputTokens,
      policy.executionCeiling.maxOutputTokens,
    ),
  });
}

function sameSourceEntry(
  left: ServerAgentSkillSourceAuthorityEntryV1,
  right: ServerAgentSkillSourceAuthorityEntryV1,
): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}

function profileAuthorization(
  base: ServerAgentSkillProfileAuthorizationV1,
  registryRevision: string,
  authorityRevision: string,
): AgentSkillProfileAuthorizationV1 {
  return deepFreeze({
    ...base,
    registryRevision,
    authorityRevision,
  });
}

function sourceProofs(
  admission: AgentSkillAdmissionV1,
  entries: readonly ServerAgentSkillSourceAuthorityEntryV1[],
  authorization: AgentSkillProfileAuthorizationV1,
): readonly AgentSkillSourceProofV1[] {
  if (entries.length !== admission.skills.length) {
    fail('agent-skill-profile-admission-source-denied');
  }
  return Object.freeze(admission.skills.map((skill, index) => {
    const entry = entries[index];
    if (!entry) fail('agent-skill-profile-admission-source-denied');
    return deepFreeze({
      proofVersion: AGENT_SKILL_SOURCE_PROOF_VERSION,
      admissionDigest: admission.admissionDigest,
      skillId: skill.snapshot.skillId,
      version: skill.snapshot.version,
      manifestDigest: skill.snapshot.manifestDigest,
      bodyHash: skill.snapshot.bodyHash,
      trustClass: entry.trustClass,
      profileId: authorization.profileId,
      profileAuthorizationDigest: authorization.authorizationDigest,
      profilePolicyRevision: authorization.policyRevision,
      profileRegistryRevision: authorization.registryRevision,
      authorityRevision: authorization.authorityRevision,
      evidenceDigest: entry.evidenceDigest,
    });
  }));
}

interface GuardAuthorization {
  readonly profile: ServerAgentSkillProfileAuthorizationV1;
  readonly sources: readonly ServerAgentSkillSourceAuthorityEntryV1[];
}

type PrepareGuardedAdmission = (
  request: AgentSkillSelectionRequestV1,
  grant: AgentSkillExecutionGrantV1,
  guard: AgentSkillAdmissionGuard<GuardAuthorization>,
) => Promise<GuardedAgentSkillAdmission<GuardAuthorization>>;

interface PreparedAdmissionRecord {
  readonly lease: AgentAdmissionLease;
  readonly context: ServerAgentSkillAdmissionContextSnapshotV1;
  readonly artifact: CompiledAgentSkillArtifactV1;
  readonly trace: ServerAgentSkillProfileAdmissionTraceV1;
  readonly assertCurrent: () => Promise<void>;
  consumed: boolean;
}

/**
 * Dark, server-only Profile admission boundary. `prepare` intentionally accepts exactly one value:
 * an identity-owned, one-shot AdmissionLease. It is not wired to Session, Prompt assembly, Provider,
 * routes, or background jobs by this module.
 */
export class ServerAgentSkillProfileAdmissionService {
  readonly #ownsLease: AgentAdmissionLeaseAuthorityPort['ownsLease'];
  readonly #allowsLeaseClaim: AgentAdmissionLeaseAuthorityPort['allowsLeaseClaim'];
  readonly #claimLease: AgentAdmissionLeaseAuthorityPort['claimLease'];
  readonly #readCatalog: AgentSkillCatalogPort['readCatalog'];
  readonly #prepareGuardedAdmission: PrepareGuardedAdmission;
  readonly #byProfileId: ServerAgentSkillProfilePolicyRegistry['byProfileId'];
  readonly #authorizeSelection: ServerAgentSkillProfilePolicyRegistry['authorizeSelection'];
  readonly #readContext: ServerAgentSkillAdmissionContextAuthorityPort['readForLease'];
  readonly #authorizeHeader: ServerAgentSkillSourceAuthorityRegistry['authorizeHeader'];
  readonly #authorizeAdmission: ServerAgentSkillSourceAuthorityRegistry['authorizeAdmission'];
  readonly #compile: AgentSkillProgramCompilerPort['compile'];
  readonly #consumeArtifact: ServerAgentSkillProfileConsumerPort['consume'];
  readonly #nowMs: () => number;
  readonly #profileRegistryRevision: string;
  readonly #sourceAuthorityRevision: string;
  readonly #prepared = new WeakMap<object, PreparedAdmissionRecord>();

  constructor(dependencies: ServerAgentSkillProfileAdmissionServiceDependencies) {
    const leaseAuthority = dependencies?.leaseAuthority;
    const catalogPort = dependencies?.catalogPort;
    const runtimePort = dependencies?.runtimePort;
    const profileRegistry = dependencies?.profileRegistry;
    const contextAuthority = dependencies?.contextAuthority;
    const sourceAuthority = dependencies?.sourceAuthority;
    const compiler = dependencies?.compiler;
    const consumer = dependencies?.consumer;
    const ownsLease = leaseAuthority?.ownsLease;
    const allowsLeaseClaim = leaseAuthority?.allowsLeaseClaim;
    const claimLease = leaseAuthority?.claimLease;
    const readCatalog = catalogPort?.readCatalog;
    const prepareGuardedAdmission = runtimePort?.prepareGuardedAdmission;
    const byProfileId = profileRegistry?.byProfileId;
    const authorizeSelection = profileRegistry?.authorizeSelection;
    const readContext = contextAuthority?.readForLease;
    const authorizeHeader = sourceAuthority?.authorizeHeader;
    const authorizeAdmission = sourceAuthority?.authorizeAdmission;
    const compile = compiler?.compile;
    const consumeArtifact = consumer?.consume;
    if (!dependencies || typeof dependencies !== 'object'
      || typeof ownsLease !== 'function'
      || typeof allowsLeaseClaim !== 'function'
      || typeof claimLease !== 'function'
      || typeof readCatalog !== 'function'
      || typeof prepareGuardedAdmission !== 'function'
      || typeof byProfileId !== 'function'
      || typeof authorizeSelection !== 'function'
      || typeof readContext !== 'function'
      || typeof authorizeHeader !== 'function'
      || typeof authorizeAdmission !== 'function'
      || typeof compile !== 'function'
      || typeof consumeArtifact !== 'function'
      || (dependencies.nowMs !== undefined && typeof dependencies.nowMs !== 'function')
      || !isServerAgentSkillRuntimeForCatalog(runtimePort, catalogPort)) {
      throw new TypeError('Agent Skill Profile admission dependencies are invalid');
    }
    // Capture every callback exactly once. Later replacement of a mutable port method cannot swap
    // authority after this service has been composed.
    this.#ownsLease = ownsLease.bind(leaseAuthority);
    this.#allowsLeaseClaim = allowsLeaseClaim.bind(leaseAuthority);
    this.#claimLease = claimLease.bind(leaseAuthority);
    this.#readCatalog = readCatalog.bind(catalogPort);
    this.#prepareGuardedAdmission = prepareGuardedAdmission.bind(runtimePort) as PrepareGuardedAdmission;
    this.#byProfileId = byProfileId.bind(profileRegistry);
    this.#authorizeSelection = authorizeSelection.bind(profileRegistry);
    this.#readContext = readContext.bind(contextAuthority);
    this.#authorizeHeader = authorizeHeader.bind(sourceAuthority);
    this.#authorizeAdmission = authorizeAdmission.bind(sourceAuthority);
    this.#compile = compile.bind(compiler);
    this.#consumeArtifact = consumeArtifact.bind(consumer);
    this.#nowMs = dependencies.nowMs ?? Date.now;
    this.#profileRegistryRevision = sha256Digest(
      profileRegistry.registryRevision,
      'profileRegistry.registryRevision',
    );
    this.#sourceAuthorityRevision = sha256Digest(
      sourceAuthority.authorityRevision,
      'sourceAuthority.authorityRevision',
    );
    Object.freeze(this);
  }

  async prepare(lease: AgentAdmissionLease): Promise<ServerAgentSkillProfileAdmissionHandleV1> {
    if (!this.#ownsLease(lease)) {
      fail('agent-skill-profile-admission-lease-not-owned');
    }
    if (!this.#allowsLeaseClaim(lease, PROFILE_ADMISSION_LEASE_PURPOSE)) {
      fail('agent-skill-profile-admission-purpose-denied');
    }
    // Broker-owned, purpose-scoped burn before the first await. Invalid context, drift, body IO,
    // compiler failure, HMR, and a second service instance all remain spent for this purpose.
    if (!this.#claimLease(lease, PROFILE_ADMISSION_LEASE_PURPOSE)) {
      fail('agent-skill-profile-admission-lease-replayed');
    }
    if (this.#nowMs() >= lease.expiresAtMs) {
      fail('agent-skill-profile-admission-lease-expired');
    }

    let context: ServerAgentSkillAdmissionContextSnapshotV1;
    try {
      context = normalizeServerAgentSkillAdmissionContextSnapshot(
        await this.#readContext(lease),
      );
    } catch (error) {
      if (error instanceof AgentSkillProfileAdmissionError) throw error;
      fail('agent-skill-profile-admission-context-invalid', error);
    }
    assertContextLeaseBindings(context, lease);

    const policy = this.#byProfileId(context.profileId);
    if (!policy) fail('agent-skill-profile-admission-profile-unavailable');
    const capturedRegistryRevision = this.#profileRegistryRevision;
    const capturedSourceAuthorityRevision = this.#sourceAuthorityRevision;
    const bindingDigest = leaseBindingDigest(lease);
    const grant = effectiveGrant(lease, context, policy);
    const effectiveGrantDigest = canonicalDigest(grant);
    const maxBodyTokens = Math.min(
      context.maxBodyTokens,
      policy.maxInstructionTokens,
      grant.maxInputTokens,
    );
    const maxCompiledInstructionTokens = Math.min(
      context.maxCompiledInstructionTokens,
      policy.maxInstructionTokens,
      grant.maxInputTokens,
    );
    const maxValidatorOperations = Math.min(
      context.maxValidatorOperations,
      grant.maxToolCalls,
      policy.executionCeiling.maxToolCalls,
    );
    const maxSkills = Math.min(context.maxSkills, policy.maxSkills);

    let catalog;
    try {
      catalog = normalizeAgentSkillCatalogSnapshot(await this.#readCatalog());
    } catch (error) {
      fail('agent-skill-profile-admission-catalog-unavailable', error);
    }
    const request = normalizeAgentSkillSelectionRequest({
      requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
      catalogRevision: catalog.catalogRevision,
      capabilityId: context.capabilityId,
      taskKind: lease.taskKind,
      phase: context.phase,
      contentMode: lease.mode,
      scope: context.scope,
      grant,
      budgetTokens: maxBodyTokens,
      maxSkills,
      explicit: context.explicit,
      ...(context.candidates === null ? {} : { candidates: context.candidates }),
    });
    let expectedReceipt: AgentSkillSelectionReceiptV1;
    try {
      expectedReceipt = selectAgentSkillHeaders(catalog.headers, request);
    } catch (error) {
      fail('agent-skill-profile-admission-runtime-rejected', error);
    }

    const assertCurrent = async (): Promise<void> => {
      if (this.#nowMs() >= lease.expiresAtMs) {
        fail('agent-skill-profile-admission-lease-expired');
      }
      if (!this.#ownsLease(lease)) {
        fail('agent-skill-profile-admission-lease-not-owned');
      }
      let currentContext: ServerAgentSkillAdmissionContextSnapshotV1;
      try {
        currentContext = normalizeServerAgentSkillAdmissionContextSnapshot(
          await this.#readContext(lease),
        );
      } catch (error) {
        fail('agent-skill-profile-admission-context-drift', error);
      }
      assertContextLeaseBindings(currentContext, lease);
      if (currentContext.contextRevision !== context.contextRevision) {
        fail('agent-skill-profile-admission-context-drift');
      }
      let currentCatalog;
      try {
        currentCatalog = normalizeAgentSkillCatalogSnapshot(await this.#readCatalog());
      } catch (error) {
        fail('agent-skill-profile-admission-catalog-drift', error);
      }
      if (currentCatalog.catalogRevision !== catalog.catalogRevision) {
        fail('agent-skill-profile-admission-catalog-drift');
      }
      const currentPolicy = this.#byProfileId(context.profileId);
      if (!currentPolicy || currentPolicy.policyRevision !== policy.policyRevision) {
        fail('agent-skill-profile-admission-authority-drift');
      }
      // Authority reads may cross the TTL; check again at the point of body access or consumption.
      if (this.#nowMs() >= lease.expiresAtMs) {
        fail('agent-skill-profile-admission-lease-expired');
      }
    };

    let issuedAuthorization: GuardAuthorization | undefined;
    let authorizationCalls = 0;
    let guarded: GuardedAgentSkillAdmission<GuardAuthorization>;
    try {
      guarded = await this.#prepareGuardedAdmission(request, grant, {
        authorize: async (receipt: AgentSkillSelectionReceiptV1): Promise<GuardAuthorization> => {
          authorizationCalls += 1;
          if (authorizationCalls !== 1) {
            fail('agent-skill-profile-admission-runtime-rejected');
          }
          let normalizedReceipt: AgentSkillSelectionReceiptV1;
          try {
            normalizedReceipt = normalizeAgentSkillSelectionReceipt(receipt);
          } catch (error) {
            fail('agent-skill-profile-admission-runtime-rejected', error);
          }
          if (normalizedReceipt.receiptDigest !== expectedReceipt.receiptDigest) {
            fail('agent-skill-profile-admission-runtime-rejected');
          }
          await assertCurrent();
          let profile: ServerAgentSkillProfileAuthorizationV1;
          try {
            profile = this.#authorizeSelection(context.profileId, normalizedReceipt);
          } catch (error) {
            fail('agent-skill-profile-admission-policy-denied', error);
          }
          let sources: readonly ServerAgentSkillSourceAuthorityEntryV1[];
          try {
            sources = Object.freeze(normalizedReceipt.selected.map(({ header }) => (
              this.#authorizeHeader(header)
            )));
          } catch (error) {
            fail('agent-skill-profile-admission-source-denied', error);
          }
          issuedAuthorization = Object.freeze({ profile, sources });
          return issuedAuthorization;
        },
        assertCurrent,
      });
    } catch (error) {
      if (error instanceof AgentSkillProfileAdmissionError) throw error;
      if ((error instanceof Error && error.message === 'agent-skill-runtime-catalog-revision-stale')
        || (typeof error === 'object' && error !== null
          && (error as { code?: unknown }).code === 'agent-skill-runtime-catalog-revision-stale')) {
        fail('agent-skill-profile-admission-catalog-drift', error);
      }
      fail('agent-skill-profile-admission-runtime-rejected', error);
    }

    let guardedReceipt: AgentSkillSelectionReceiptV1;
    try {
      guardedReceipt = normalizeAgentSkillSelectionReceipt(guarded.receipt);
    } catch (error) {
      fail('agent-skill-profile-admission-runtime-rejected', error);
    }
    if (authorizationCalls !== 1
      || issuedAuthorization === undefined
      || guarded.authorization !== issuedAuthorization
      || guardedReceipt.receiptDigest !== expectedReceipt.receiptDigest
      || issuedAuthorization.profile.selectionReceiptDigest !== expectedReceipt.receiptDigest
      || guarded.admission.selectionReceiptDigest !== expectedReceipt.receiptDigest
      || guarded.admission.catalogRevision !== catalog.catalogRevision
      || guarded.admission.instructionSetDigest !== expectedReceipt.instructionSetDigest) {
      fail('agent-skill-profile-admission-runtime-rejected');
    }

    await assertCurrent();
    let admittedSources: readonly ServerAgentSkillSourceAuthorityEntryV1[];
    try {
      admittedSources = this.#authorizeAdmission(guarded.admission);
    } catch (error) {
      fail('agent-skill-profile-admission-source-denied', error);
    }
    if (admittedSources.length !== guarded.authorization.sources.length
      || admittedSources.some((entry, index) => {
        const preflight = guarded.authorization.sources[index];
        return !preflight || !sameSourceEntry(entry, preflight);
      })) {
      fail('agent-skill-profile-admission-source-denied');
    }
    await assertCurrent();

    const authorityRevision = canonicalDigest({
      leaseBindingDigest: bindingDigest,
      contextRevision: context.contextRevision,
      catalogRevision: catalog.catalogRevision,
      profilePolicyRevision: policy.policyRevision,
      profileRegistryRevision: capturedRegistryRevision,
      sourceAuthorityRevision: capturedSourceAuthorityRevision,
      effectiveGrantDigest,
      selectionReceiptDigest: guardedReceipt.receiptDigest,
    });
    const authorization = profileAuthorization(
      guarded.authorization.profile,
      capturedRegistryRevision,
      authorityRevision,
    );
    const proofs = sourceProofs(guarded.admission, admittedSources, authorization);
    const compilationRequest: ServerAgentSkillCompilationRequestV1 = deepFreeze({
      admission: guarded.admission,
      sourceProofs: proofs,
      profileAuthorization: authorization,
      maxInstructionTokens: maxCompiledInstructionTokens,
      maxValidatorOperations,
    });
    let candidateArtifact: unknown;
    try {
      candidateArtifact = await this.#compile(compilationRequest);
    } catch (error) {
      fail('agent-skill-profile-admission-compiler-rejected', error);
    }
    await assertCurrent();
    let artifact: CompiledAgentSkillArtifactV1;
    try {
      artifact = verifyCompiledAgentSkillArtifact(candidateArtifact, compilationRequest);
    } catch (error) {
      fail('agent-skill-profile-admission-compiled-binding-mismatch', error);
    }
    await assertCurrent();

    const traceCore = deepFreeze({
      traceVersion: SERVER_AGENT_SKILL_PROFILE_ADMISSION_TRACE_VERSION,
      leaseBindingDigest: bindingDigest,
      contextRevision: context.contextRevision,
      catalogRevision: catalog.catalogRevision,
      capabilityId: context.capabilityId,
      profileId: context.profileId,
      profilePolicyRevision: policy.policyRevision,
      profileRegistryRevision: capturedRegistryRevision,
      sourceAuthorityRevision: capturedSourceAuthorityRevision,
      authorityRevision,
      selectionReceiptDigest: guardedReceipt.receiptDigest,
      admissionDigest: guarded.admission.admissionDigest,
      effectiveGrantDigest,
      maxBodyTokens,
      maxCompiledInstructionTokens,
      maxValidatorOperations,
      compiledArtifactDigest: artifact.compiledArtifactDigest,
    });
    const trace = deepFreeze({ ...traceCore, traceDigest: canonicalDigest(traceCore) });
    const handle = deepFreeze({
      handleVersion: SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION,
      trace,
    });
    this.#prepared.set(handle, {
      lease,
      context,
      artifact,
      trace,
      assertCurrent,
      consumed: false,
    });
    return handle;
  }

  /**
   * Atomically burns an exact prepared handle, revalidates authority, then hands the verified
   * artifact to the fixed synchronous typed-slot consumer. No reusable artifact leaves the service.
   */
  async consume(handleInput: unknown): Promise<void> {
    if (handleInput === null || typeof handleInput !== 'object') {
      fail('agent-skill-profile-admission-handle-not-owned');
    }
    const record = this.#prepared.get(handleInput);
    if (!record) fail('agent-skill-profile-admission-handle-not-owned');
    if (record.consumed) fail('agent-skill-profile-admission-handle-replayed');
    // Burn before the first await: concurrent callers and consumer re-entry cannot both win.
    record.consumed = true;
    await record.assertCurrent();
    const payload = deepFreeze({
      consumptionVersion: SERVER_AGENT_SKILL_PROFILE_CONSUMPTION_VERSION,
      ticketId: record.lease.ticketId,
      runId: record.lease.runId,
      parentRunId: record.lease.parentRunId,
      sessionId: record.lease.sessionId,
      modelId: record.lease.modelId,
      toolSetDigest: record.lease.toolSetDigest,
      contentMode: record.lease.mode,
      contextRevision: record.context.contextRevision,
      nsfwSafetyDigest: record.context.nsfwSafetyDigest,
      expiresAtMs: record.lease.expiresAtMs,
      artifact: record.artifact,
      trace: record.trace,
    });
    PROFILE_CONSUMPTIONS.add(payload);
    try {
      const result = this.#consumeArtifact(payload) as unknown;
      if (result !== undefined) {
        throw new TypeError('Agent Skill Profile consumer must complete synchronously');
      }
    } catch (error) {
      fail('agent-skill-profile-admission-consumer-rejected', error);
    }
  }
}

export function createServerAgentSkillProfileAdmissionService(
  dependencies: ServerAgentSkillProfileAdmissionServiceDependencies,
): ServerAgentSkillProfileAdmissionService {
  return new ServerAgentSkillProfileAdmissionService(dependencies);
}

/** Shared compiler evidence construction; these helpers do not grant a Lease or host authority. */
export { profileAuthorization as createServerAgentSkillCompilerAuthorization,
  sourceProofs as createServerAgentSkillCompilerSourceProofs };
