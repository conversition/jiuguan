import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_PHASES,
  type AgentSkillPhase,
} from '@jiuguan/skill-hub';

export const AGENT_CONTRACT_DESCRIPTOR_VERSION = 'agent-contract-descriptor-v1' as const;
export const AGENT_CONTRACT_INDEX_VERSION = 'agent-contract-index-v1' as const;

export const AGENT_CONTRACT_COMPONENT_STATES = Object.freeze([
  'indexed', 'runtime-resolved', 'pending', 'missing',
] as const);
export type AgentContractComponentState = typeof AGENT_CONTRACT_COMPONENT_STATES[number];

export const AGENT_CONTRACT_COMPONENT_COVERAGES = Object.freeze([
  'complete', 'partial', 'missing',
] as const);
export type AgentContractComponentCoverage = typeof AGENT_CONTRACT_COMPONENT_COVERAGES[number];

export const AGENT_CONTRACT_IDENTITY_KINDS = Object.freeze([
  'foreground-turn', 'background-job', 'learning-run', 'unbound',
] as const);
export type AgentContractIdentityKind = typeof AGENT_CONTRACT_IDENTITY_KINDS[number];

export const AGENT_CONTRACT_ADAPTER_REGISTRATIONS = Object.freeze([
  'runtime-compatible', 'profile-only',
] as const);
export type AgentContractAdapterRegistration = typeof AGENT_CONTRACT_ADAPTER_REGISTRATIONS[number];

export const AGENT_CONTRACT_TASK_REGISTRATIONS = Object.freeze([
  'registered', 'host-guarded', 'profile-only',
] as const);
export type AgentContractTaskRegistration = typeof AGENT_CONTRACT_TASK_REGISTRATIONS[number];

export interface AgentContractPresentComponentRefV1 {
  readonly state: 'indexed' | 'runtime-resolved';
  readonly coverage: 'complete' | 'partial';
  readonly ref: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentContractMissingComponentRefV1 {
  readonly state: 'missing';
  readonly coverage: 'missing';
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentContractPendingComponentRefV1 {
  readonly state: 'pending';
  readonly coverage: 'missing';
  readonly reasonCode: string;
  readonly nextContract: string;
  readonly evidenceRefs: readonly string[];
}

export type AgentContractComponentRefV1 =
  | AgentContractPresentComponentRefV1
  | AgentContractPendingComponentRefV1
  | AgentContractMissingComponentRefV1;

export interface AgentContractDescriptorV1 {
  readonly descriptorVersion: typeof AGENT_CONTRACT_DESCRIPTOR_VERSION;
  readonly contractId: string;
  readonly profileRef: Readonly<{
    profileId: string;
    profileVersion: string;
  }>;
  readonly route: Readonly<{
    capabilityId: string;
    taskKind: string;
    phase: AgentSkillPhase;
    policyVersionIncludes: readonly string[];
    policyVersionExcludes: readonly string[];
  }>;
  readonly execution: Readonly<{
    executionGroupRef: string;
    dispatchOwnerCapabilityId: string | null;
    logicalOutcomeCapabilityId: string;
    canonicalOutcomeCapabilityId: string;
    identityKind: AgentContractIdentityKind;
  }>;
  readonly wiring: Readonly<{
    adapterRegistration: AgentContractAdapterRegistration;
    admissionTask: AgentContractTaskRegistration;
    runtimeState: 'not-indexed';
  }>;
  readonly contracts: Readonly<{
    skillInstructionSet: AgentContractComponentRefV1;
    hostInstruction: AgentContractComponentRefV1;
    inputValidator: AgentContractComponentRefV1;
    outputValidator: AgentContractComponentRefV1;
    policy: AgentContractComponentRefV1;
    skillSourceAuthority: AgentContractComponentRefV1;
    taskSourceProof: AgentContractComponentRefV1;
    hardChecks: readonly AgentContractComponentRefV1[];
    closureOutcome: AgentContractComponentRefV1;
    evidenceStream: AgentContractComponentRefV1;
    outcomeEvaluator: AgentContractComponentRefV1;
  }>;
  /** This index is descriptive and can never grant execution or write authority. */
  readonly authorityEffect: 'none';
  /** Dynamic live/rollout/kill/validation state intentionally stays in its existing authorities. */
  readonly runtimeStateIncluded: false;
}

export interface AgentContractIndexV1 {
  readonly indexVersion: typeof AGENT_CONTRACT_INDEX_VERSION;
  readonly authorityEffect: 'none';
  readonly runtimeStateIncluded: false;
  readonly indexRevision: string;
  readonly entries: readonly AgentContractDescriptorV1[];
}

const DESCRIPTOR_KEYS = new Set([
  'descriptorVersion', 'contractId', 'profileRef', 'route', 'execution', 'wiring', 'contracts',
  'authorityEffect', 'runtimeStateIncluded',
]);
const PROFILE_REF_KEYS = new Set(['profileId', 'profileVersion']);
const ROUTE_KEYS = new Set([
  'capabilityId', 'taskKind', 'phase', 'policyVersionIncludes', 'policyVersionExcludes',
]);
const EXECUTION_KEYS = new Set([
  'executionGroupRef', 'dispatchOwnerCapabilityId', 'logicalOutcomeCapabilityId',
  'canonicalOutcomeCapabilityId', 'identityKind',
]);
const WIRING_KEYS = new Set(['adapterRegistration', 'admissionTask', 'runtimeState']);
const CONTRACT_KEYS = new Set([
  'skillInstructionSet', 'hostInstruction', 'inputValidator', 'outputValidator', 'policy',
  'skillSourceAuthority', 'taskSourceProof', 'hardChecks', 'closureOutcome', 'evidenceStream',
  'outcomeEvaluator',
]);
const PRESENT_COMPONENT_KEYS = new Set(['state', 'coverage', 'ref', 'evidenceRefs']);
const PENDING_COMPONENT_KEYS = new Set([
  'state', 'coverage', 'reasonCode', 'nextContract', 'evidenceRefs',
]);
const MISSING_COMPONENT_KEYS = new Set(['state', 'coverage', 'reasonCode', 'evidenceRefs']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function componentIdentity(component: AgentContractComponentRefV1): string {
  switch (component.state) {
    case 'indexed':
    case 'runtime-resolved':
      return `${component.state}:${component.ref}`;
    case 'pending':
    case 'missing':
      return `${component.state}:${component.reasonCode}`;
  }
}

function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const unsupported = Object.keys(value).find((key) => !keys.has(key));
  if (unsupported !== undefined) throw new TypeError(`${label} contains unsupported field: ${unsupported}`);
  const missing = [...keys].find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label}.${missing} is required`);
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new TypeError(`${label} must be a stable token`);
  }
  return value;
}

function tokenOrNull(value: unknown, label: string): string | null {
  return value === null ? null : token(value, label);
}

function tokenSet(value: unknown, label: string, maximum = 64): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense array`);
  }
  const normalized = value.map((item, index) => token(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(normalized.sort(compareText));
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const normalized = token(value, label);
  if (!allowed.includes(normalized as T[number])) throw new TypeError(`${label} contains an unsupported value`);
  return normalized as T[number];
}

export function normalizeAgentContractComponentRef(
  input: unknown,
  label = 'agentContractComponentRef',
): AgentContractComponentRefV1 {
  plainRecord(input, label);
  const state = enumValue(input.state, AGENT_CONTRACT_COMPONENT_STATES, `${label}.state`);
  if (state === 'pending') {
    exactKeys(input, PENDING_COMPONENT_KEYS, label);
    if (input.coverage !== 'missing') throw new TypeError(`${label}.coverage must be missing`);
    return Object.freeze({
      state,
      coverage: 'missing' as const,
      reasonCode: token(input.reasonCode, `${label}.reasonCode`),
      nextContract: token(input.nextContract, `${label}.nextContract`),
      evidenceRefs: tokenSet(input.evidenceRefs, `${label}.evidenceRefs`),
    });
  }
  if (state === 'missing') {
    exactKeys(input, MISSING_COMPONENT_KEYS, label);
    if (input.coverage !== 'missing') throw new TypeError(`${label}.coverage must be missing`);
    return Object.freeze({
      state,
      coverage: 'missing' as const,
      reasonCode: token(input.reasonCode, `${label}.reasonCode`),
      evidenceRefs: tokenSet(input.evidenceRefs, `${label}.evidenceRefs`),
    });
  }
  exactKeys(input, PRESENT_COMPONENT_KEYS, label);
  const coverage = enumValue(input.coverage, ['complete', 'partial'] as const, `${label}.coverage`);
  return Object.freeze({
    state,
    coverage,
    ref: token(input.ref, `${label}.ref`),
    evidenceRefs: tokenSet(input.evidenceRefs, `${label}.evidenceRefs`),
  });
}

export function normalizeAgentContractDescriptor(input: unknown): AgentContractDescriptorV1 {
  plainRecord(input, 'agentContractDescriptor');
  exactKeys(input, DESCRIPTOR_KEYS, 'agentContractDescriptor');
  if (input.descriptorVersion !== AGENT_CONTRACT_DESCRIPTOR_VERSION) {
    throw new TypeError(`agentContractDescriptor.descriptorVersion must be ${AGENT_CONTRACT_DESCRIPTOR_VERSION}`);
  }
  if (input.authorityEffect !== 'none') {
    throw new TypeError('agentContractDescriptor.authorityEffect must be none');
  }
  if (input.runtimeStateIncluded !== false) {
    throw new TypeError('agentContractDescriptor.runtimeStateIncluded must be false');
  }

  plainRecord(input.profileRef, 'agentContractDescriptor.profileRef');
  exactKeys(input.profileRef, PROFILE_REF_KEYS, 'agentContractDescriptor.profileRef');
  const profileRef = Object.freeze({
    profileId: token(input.profileRef.profileId, 'agentContractDescriptor.profileRef.profileId'),
    profileVersion: token(input.profileRef.profileVersion, 'agentContractDescriptor.profileRef.profileVersion'),
  });

  plainRecord(input.route, 'agentContractDescriptor.route');
  exactKeys(input.route, ROUTE_KEYS, 'agentContractDescriptor.route');
  const route = Object.freeze({
    capabilityId: token(input.route.capabilityId, 'agentContractDescriptor.route.capabilityId'),
    taskKind: token(input.route.taskKind, 'agentContractDescriptor.route.taskKind'),
    phase: enumValue(input.route.phase, AGENT_SKILL_PHASES, 'agentContractDescriptor.route.phase'),
    policyVersionIncludes: tokenSet(
      input.route.policyVersionIncludes,
      'agentContractDescriptor.route.policyVersionIncludes',
    ),
    policyVersionExcludes: tokenSet(
      input.route.policyVersionExcludes,
      'agentContractDescriptor.route.policyVersionExcludes',
    ),
  });
  if (route.policyVersionIncludes.some((value) => route.policyVersionExcludes.includes(value))) {
    throw new TypeError('agentContractDescriptor route policy qualifiers must not overlap');
  }

  plainRecord(input.execution, 'agentContractDescriptor.execution');
  exactKeys(input.execution, EXECUTION_KEYS, 'agentContractDescriptor.execution');
  const execution = Object.freeze({
    executionGroupRef: token(
      input.execution.executionGroupRef,
      'agentContractDescriptor.execution.executionGroupRef',
    ),
    dispatchOwnerCapabilityId: tokenOrNull(
      input.execution.dispatchOwnerCapabilityId,
      'agentContractDescriptor.execution.dispatchOwnerCapabilityId',
    ),
    logicalOutcomeCapabilityId: token(
      input.execution.logicalOutcomeCapabilityId,
      'agentContractDescriptor.execution.logicalOutcomeCapabilityId',
    ),
    canonicalOutcomeCapabilityId: token(
      input.execution.canonicalOutcomeCapabilityId,
      'agentContractDescriptor.execution.canonicalOutcomeCapabilityId',
    ),
    identityKind: enumValue(
      input.execution.identityKind,
      AGENT_CONTRACT_IDENTITY_KINDS,
      'agentContractDescriptor.execution.identityKind',
    ),
  });

  plainRecord(input.wiring, 'agentContractDescriptor.wiring');
  exactKeys(input.wiring, WIRING_KEYS, 'agentContractDescriptor.wiring');
  if (input.wiring.runtimeState !== 'not-indexed') {
    throw new TypeError('agentContractDescriptor.wiring.runtimeState must be not-indexed');
  }
  const wiring = Object.freeze({
    adapterRegistration: enumValue(
      input.wiring.adapterRegistration,
      AGENT_CONTRACT_ADAPTER_REGISTRATIONS,
      'agentContractDescriptor.wiring.adapterRegistration',
    ),
    admissionTask: enumValue(
      input.wiring.admissionTask,
      AGENT_CONTRACT_TASK_REGISTRATIONS,
      'agentContractDescriptor.wiring.admissionTask',
    ),
    runtimeState: 'not-indexed' as const,
  });

  plainRecord(input.contracts, 'agentContractDescriptor.contracts');
  exactKeys(input.contracts, CONTRACT_KEYS, 'agentContractDescriptor.contracts');
  if (!Array.isArray(input.contracts.hardChecks) || input.contracts.hardChecks.length > 32) {
    throw new TypeError('agentContractDescriptor.contracts.hardChecks must have at most 32 items');
  }
  for (let index = 0; index < input.contracts.hardChecks.length; index += 1) {
    if (!Object.hasOwn(input.contracts.hardChecks, index)) {
      throw new TypeError('agentContractDescriptor.contracts.hardChecks must be a dense array');
    }
  }
  const hardChecks = Object.freeze(input.contracts.hardChecks.map((item, index) =>
    normalizeAgentContractComponentRef(item, `agentContractDescriptor.contracts.hardChecks[${index}]`))
    .sort((left, right) => compareText(componentIdentity(left), componentIdentity(right))));
  const hardCheckKeys = hardChecks.map(componentIdentity);
  if (new Set(hardCheckKeys).size !== hardCheckKeys.length) {
    throw new TypeError('agentContractDescriptor.contracts.hardChecks must not contain duplicates');
  }
  const contracts = Object.freeze({
    skillInstructionSet: normalizeAgentContractComponentRef(
      input.contracts.skillInstructionSet,
      'agentContractDescriptor.contracts.skillInstructionSet',
    ),
    hostInstruction: normalizeAgentContractComponentRef(
      input.contracts.hostInstruction,
      'agentContractDescriptor.contracts.hostInstruction',
    ),
    inputValidator: normalizeAgentContractComponentRef(
      input.contracts.inputValidator,
      'agentContractDescriptor.contracts.inputValidator',
    ),
    outputValidator: normalizeAgentContractComponentRef(
      input.contracts.outputValidator,
      'agentContractDescriptor.contracts.outputValidator',
    ),
    policy: normalizeAgentContractComponentRef(
      input.contracts.policy,
      'agentContractDescriptor.contracts.policy',
    ),
    skillSourceAuthority: normalizeAgentContractComponentRef(
      input.contracts.skillSourceAuthority,
      'agentContractDescriptor.contracts.skillSourceAuthority',
    ),
    taskSourceProof: normalizeAgentContractComponentRef(
      input.contracts.taskSourceProof,
      'agentContractDescriptor.contracts.taskSourceProof',
    ),
    hardChecks,
    closureOutcome: normalizeAgentContractComponentRef(
      input.contracts.closureOutcome,
      'agentContractDescriptor.contracts.closureOutcome',
    ),
    evidenceStream: normalizeAgentContractComponentRef(
      input.contracts.evidenceStream,
      'agentContractDescriptor.contracts.evidenceStream',
    ),
    outcomeEvaluator: normalizeAgentContractComponentRef(
      input.contracts.outcomeEvaluator,
      'agentContractDescriptor.contracts.outcomeEvaluator',
    ),
  });

  return Object.freeze({
    descriptorVersion: AGENT_CONTRACT_DESCRIPTOR_VERSION,
    contractId: token(input.contractId, 'agentContractDescriptor.contractId'),
    profileRef,
    route,
    execution,
    wiring,
    contracts,
    authorityEffect: 'none' as const,
    runtimeStateIncluded: false as const,
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Strict, deterministic, authority-free index construction. */
export function createAgentContractIndex(entries: readonly unknown[]): AgentContractIndexV1 {
  if (!Array.isArray(entries) || entries.length > 256) {
    throw new TypeError('agentContractIndex.entries must have at most 256 items');
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.hasOwn(entries, index)) throw new TypeError('agentContractIndex.entries must be a dense array');
  }
  const normalized = entries.map(normalizeAgentContractDescriptor).sort(
    (left, right) => compareText(left.contractId, right.contractId),
  );
  const contractIds = normalized.map((entry) => entry.contractId);
  if (new Set(contractIds).size !== contractIds.length) {
    throw new TypeError('agentContractIndex contains duplicate contractId');
  }
  const routeIds = normalized.map((entry) => JSON.stringify([
    entry.profileRef.profileId,
    entry.route.taskKind,
    entry.route.phase,
    entry.route.policyVersionIncludes,
    entry.route.policyVersionExcludes,
  ]));
  if (new Set(routeIds).size !== routeIds.length) {
    throw new TypeError('agentContractIndex contains duplicate route');
  }
  const frozenEntries = Object.freeze(normalized);
  const core = {
    indexVersion: AGENT_CONTRACT_INDEX_VERSION,
    authorityEffect: 'none' as const,
    runtimeStateIncluded: false as const,
    entries: frozenEntries,
  };
  return Object.freeze({ ...core, indexRevision: digest(core) });
}
