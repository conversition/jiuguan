import { createHash } from 'node:crypto';
import {
  AGENT_CONTRACT_IDENTITY_KINDS,
  AGENT_CONTRACT_INDEX_VERSION,
  createAgentContractIndex,
  normalizeAgentContractComponentRef,
  type AgentContractComponentRefV1,
  type AgentContractIdentityKind,
  type AgentContractIndexV1,
} from './contract-index.ts';

export const AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION =
  'agent-contract-boundary-descriptor-v1' as const;
export const AGENT_CONTRACT_BOUNDARY_INDEX_VERSION = 'agent-contract-boundary-index-v1' as const;

export const AGENT_CONTRACT_BOUNDARY_SLOT_APPLICABILITIES = Object.freeze([
  'required', 'optional', 'not-applicable',
] as const);
export type AgentContractBoundarySlotApplicability =
  typeof AGENT_CONTRACT_BOUNDARY_SLOT_APPLICABILITIES[number];

export const AGENT_CONTRACT_BOUNDARY_SLOT_ACCESSES = Object.freeze([
  'read-only', 'domain-proposal', 'domain-committer-only', 'process-opaque', 'receipt-read', 'none',
] as const);
export type AgentContractBoundarySlotAccess =
  typeof AGENT_CONTRACT_BOUNDARY_SLOT_ACCESSES[number];

export const AGENT_CONTRACT_DIRECT_CAPABILITIES = Object.freeze([
  'file', 'network', 'process', 'shell', 'arbitrary-code',
] as const);
export type AgentContractDirectCapability = typeof AGENT_CONTRACT_DIRECT_CAPABILITIES[number];

export const AGENT_CONTRACT_LIFETIME_KINDS = Object.freeze([
  'active-turn', 'post-commit-source-window', 'claimed-job-attempt', 'in-flight-learning-source', 'pending', 'unbound',
] as const);
export type AgentContractLifetimeKind = typeof AGENT_CONTRACT_LIFETIME_KINDS[number];

export const AGENT_CONTRACT_PARENT_TURN_CONTINUATIONS = Object.freeze([
  'forbidden', 'independent-while-current', 'not-indexed', 'not-applicable',
] as const);
export type AgentContractParentTurnContinuation =
  typeof AGENT_CONTRACT_PARENT_TURN_CONTINUATIONS[number];

export const AGENT_CONTRACT_ISOLATION_LEVELS = Object.freeze([
  'application-contract-only', 'not-applicable',
] as const);
export type AgentContractIsolationLevel = typeof AGENT_CONTRACT_ISOLATION_LEVELS[number];

export interface AgentContractBoundarySlotV1 {
  readonly applicability: AgentContractBoundarySlotApplicability;
  readonly access: AgentContractBoundarySlotAccess;
  readonly component: AgentContractComponentRefV1 | null;
}

export interface AgentContractBoundaryWorkspaceV1 {
  readonly snapshot: AgentContractBoundarySlotV1;
  readonly assets: AgentContractBoundarySlotV1;
  readonly proposal: AgentContractBoundarySlotV1;
  readonly truth: AgentContractBoundarySlotV1;
  readonly artifact: AgentContractBoundarySlotV1;
  readonly receipt: AgentContractBoundarySlotV1;
  readonly debugExport: AgentContractBoundarySlotV1;
  /** The inventory cannot introduce another writable source of truth. */
  readonly secondaryWritableTruth: false;
}

export interface AgentContractBoundaryEnvironmentV1 {
  /** Descriptive only; this inventory never grants any listed capability. */
  readonly applicationGrantedDirectCapabilities: readonly AgentContractDirectCapability[];
  readonly modelToolSurface: AgentContractComponentRefV1;
  readonly skillExecutionGrant: AgentContractComponentRefV1;
  readonly hostPortSet: AgentContractComponentRefV1;
  readonly providerTransport: AgentContractComponentRefV1;
  readonly isolationGuarantees: readonly AgentContractComponentRefV1[];
  readonly isolationLevel: AgentContractIsolationLevel;
}

export interface AgentContractBoundaryLifetimeV1 {
  readonly kind: AgentContractLifetimeKind;
  readonly authority: AgentContractComponentRefV1;
  readonly parentTurnContinuation: AgentContractParentTurnContinuation;
  readonly terminationFences: readonly string[];
}

export interface AgentContractBoundaryDescriptorV1 {
  readonly boundaryVersion: typeof AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION;
  readonly contractId: string;
  readonly contractIndexRevision: string;
  readonly identityKind: AgentContractIdentityKind;
  readonly workspace: AgentContractBoundaryWorkspaceV1;
  readonly environment: AgentContractBoundaryEnvironmentV1;
  readonly lifetime: AgentContractBoundaryLifetimeV1;
  /** Boundary metadata is descriptive and never grants execution or write authority. */
  readonly authorityEffect: 'none';
  /** Per-run handles, leases and rollout state are deliberately excluded. */
  readonly runtimeStateIncluded: false;
}

export interface AgentContractBoundaryIndexV1 {
  readonly indexVersion: typeof AGENT_CONTRACT_BOUNDARY_INDEX_VERSION;
  readonly contractIndexRevision: string;
  readonly authorityEffect: 'none';
  readonly runtimeStateIncluded: false;
  readonly indexRevision: string;
  readonly entries: readonly AgentContractBoundaryDescriptorV1[];
}

const DESCRIPTOR_KEYS = new Set([
  'boundaryVersion', 'contractId', 'contractIndexRevision', 'identityKind', 'workspace',
  'environment', 'lifetime', 'authorityEffect', 'runtimeStateIncluded',
]);
const WORKSPACE_KEYS = new Set([
  'snapshot', 'assets', 'proposal', 'truth', 'artifact', 'receipt', 'debugExport',
  'secondaryWritableTruth',
]);
const SLOT_KEYS = new Set(['applicability', 'access', 'component']);
const ENVIRONMENT_KEYS = new Set([
  'applicationGrantedDirectCapabilities', 'modelToolSurface', 'skillExecutionGrant', 'hostPortSet',
  'providerTransport', 'isolationGuarantees', 'isolationLevel',
]);
const LIFETIME_KEYS = new Set([
  'kind', 'authority', 'parentTurnContinuation', 'terminationFences',
]);
const CONTRACT_INDEX_KEYS = new Set([
  'indexVersion', 'authorityEffect', 'runtimeStateIncluded', 'indexRevision', 'entries',
]);
const BOUNDARY_INDEX_KEYS = new Set([
  'indexVersion', 'contractIndexRevision', 'authorityEffect', 'runtimeStateIncluded',
  'indexRevision', 'entries',
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

type WorkspaceSlotName = Exclude<keyof AgentContractBoundaryWorkspaceV1, 'secondaryWritableTruth'>;

const WORKSPACE_SLOT_NAMES = Object.freeze([
  'snapshot', 'assets', 'proposal', 'truth', 'artifact', 'receipt', 'debugExport',
] as const satisfies readonly WorkspaceSlotName[]);

const SLOT_ACCESSES: Readonly<Record<WorkspaceSlotName, readonly AgentContractBoundarySlotAccess[]>> =
  Object.freeze({
    snapshot: Object.freeze(['read-only'] as const),
    assets: Object.freeze(['read-only'] as const),
    proposal: Object.freeze(['domain-proposal', 'domain-committer-only'] as const),
    truth: Object.freeze(['read-only'] as const),
    artifact: Object.freeze(['process-opaque'] as const),
    receipt: Object.freeze(['receipt-read'] as const),
    debugExport: Object.freeze(['read-only'] as const),
  });

const LIFETIME_CONTINUATIONS: Readonly<
Record<AgentContractLifetimeKind, AgentContractParentTurnContinuation>
> = Object.freeze({
  'active-turn': 'forbidden',
  'post-commit-source-window': 'independent-while-current',
  'claimed-job-attempt': 'independent-while-current',
  'in-flight-learning-source': 'forbidden',
  pending: 'not-indexed',
  unbound: 'not-applicable',
});

const IDENTITY_LIFETIMES: Readonly<
Record<AgentContractIdentityKind, readonly AgentContractLifetimeKind[]>
> = Object.freeze({
  'foreground-turn': Object.freeze(['active-turn', 'post-commit-source-window'] as const),
  'background-job': Object.freeze(['claimed-job-attempt', 'pending'] as const),
  'learning-run': Object.freeze(['in-flight-learning-source', 'pending'] as const),
  unbound: Object.freeze(['unbound'] as const),
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be enumerable`);
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be a data property`);
    }
  }
  const missing = [...keys].find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label}.${missing} is required`);
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new TypeError(`${label} must be a stable token`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const normalized = token(value, label);
  if (!allowed.includes(normalized as T[number])) {
    throw new TypeError(`${label} contains an unsupported value`);
  }
  return normalized as T[number];
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} items`);
  }
  const allowedKeys = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} must be a dense array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${String(key)}`);
    }
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new TypeError(`${label}[${key}] must be enumerable`);
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}[${key}] must be a data property`);
    }
  }
  return value;
}

function tokenSet(value: unknown, label: string, maximum = 64, minimum = 0): readonly string[] {
  const items = denseArray(value, label, maximum);
  if (items.length < minimum) {
    throw new TypeError(`${label} must contain at least ${minimum} item${minimum === 1 ? '' : 's'}`);
  }
  const normalized = items.map((item, index) => token(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return Object.freeze(normalized.sort(compareText));
}

function enumSet<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  maximum = 64,
): readonly T[number][] {
  const normalized = tokenSet(value, label, maximum);
  if (normalized.some((item) => !allowed.includes(item as T[number]))) {
    throw new TypeError(`${label} contains an unsupported value`);
  }
  return normalized as readonly T[number][];
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

function componentSet(value: unknown, label: string, maximum = 32): readonly AgentContractComponentRefV1[] {
  const items = denseArray(value, label, maximum);
  const normalized = items.map((item, index) =>
    normalizeAgentContractComponentRef(item, `${label}[${index}]`))
    .sort((left, right) => compareText(componentIdentity(left), componentIdentity(right)));
  const identities = normalized.map(componentIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${label} must not contain duplicate component identities`);
  }
  return Object.freeze(normalized);
}

export function normalizeAgentContractBoundarySlot(
  input: unknown,
  label = 'agentContractBoundarySlot',
): AgentContractBoundarySlotV1 {
  plainRecord(input, label);
  exactKeys(input, SLOT_KEYS, label);
  const applicability = enumValue(
    input.applicability,
    AGENT_CONTRACT_BOUNDARY_SLOT_APPLICABILITIES,
    `${label}.applicability`,
  );
  const access = enumValue(
    input.access,
    AGENT_CONTRACT_BOUNDARY_SLOT_ACCESSES,
    `${label}.access`,
  );
  if (applicability === 'not-applicable') {
    if (access !== 'none') throw new TypeError(`${label}.access must be none when not applicable`);
    if (input.component !== null) {
      throw new TypeError(`${label}.component must be null when not applicable`);
    }
    return Object.freeze({ applicability, access, component: null });
  }
  if (access === 'none') {
    throw new TypeError(`${label}.access must not be none when applicable`);
  }
  if (input.component === null) {
    throw new TypeError(`${label}.component must be present when applicable`);
  }
  return Object.freeze({
    applicability,
    access,
    component: normalizeAgentContractComponentRef(input.component, `${label}.component`),
  });
}

function normalizeWorkspaceSlot(
  value: unknown,
  name: WorkspaceSlotName,
): AgentContractBoundarySlotV1 {
  const label = `agentContractBoundaryDescriptor.workspace.${name}`;
  const slot = normalizeAgentContractBoundarySlot(value, label);
  if (slot.applicability !== 'not-applicable' && !SLOT_ACCESSES[name].includes(slot.access)) {
    throw new TypeError(`${label}.access is incompatible with the ${name} slot`);
  }
  return slot;
}

function normalizeWorkspace(input: unknown): AgentContractBoundaryWorkspaceV1 {
  const label = 'agentContractBoundaryDescriptor.workspace';
  plainRecord(input, label);
  exactKeys(input, WORKSPACE_KEYS, label);
  if (input.secondaryWritableTruth !== false) {
    throw new TypeError(`${label}.secondaryWritableTruth must be false`);
  }
  return Object.freeze({
    snapshot: normalizeWorkspaceSlot(input.snapshot, 'snapshot'),
    assets: normalizeWorkspaceSlot(input.assets, 'assets'),
    proposal: normalizeWorkspaceSlot(input.proposal, 'proposal'),
    truth: normalizeWorkspaceSlot(input.truth, 'truth'),
    artifact: normalizeWorkspaceSlot(input.artifact, 'artifact'),
    receipt: normalizeWorkspaceSlot(input.receipt, 'receipt'),
    debugExport: normalizeWorkspaceSlot(input.debugExport, 'debugExport'),
    secondaryWritableTruth: false as const,
  });
}

function normalizeEnvironment(input: unknown): AgentContractBoundaryEnvironmentV1 {
  const label = 'agentContractBoundaryDescriptor.environment';
  plainRecord(input, label);
  exactKeys(input, ENVIRONMENT_KEYS, label);
  const isolationLevel = enumValue(
    input.isolationLevel,
    AGENT_CONTRACT_ISOLATION_LEVELS,
    `${label}.isolationLevel`,
  );
  const isolationGuarantees = componentSet(
    input.isolationGuarantees,
    `${label}.isolationGuarantees`,
  );
  if (isolationLevel === 'not-applicable' && isolationGuarantees.length !== 0) {
    throw new TypeError(`${label}.isolationGuarantees must be empty when isolation is not applicable`);
  }
  if (isolationLevel === 'application-contract-only' && isolationGuarantees.length === 0) {
    throw new TypeError(`${label}.isolationGuarantees must describe at least one application contract`);
  }
  return Object.freeze({
    applicationGrantedDirectCapabilities: enumSet(
      input.applicationGrantedDirectCapabilities,
      AGENT_CONTRACT_DIRECT_CAPABILITIES,
      `${label}.applicationGrantedDirectCapabilities`,
      AGENT_CONTRACT_DIRECT_CAPABILITIES.length,
    ),
    modelToolSurface: normalizeAgentContractComponentRef(
      input.modelToolSurface,
      `${label}.modelToolSurface`,
    ),
    skillExecutionGrant: normalizeAgentContractComponentRef(
      input.skillExecutionGrant,
      `${label}.skillExecutionGrant`,
    ),
    hostPortSet: normalizeAgentContractComponentRef(input.hostPortSet, `${label}.hostPortSet`),
    providerTransport: normalizeAgentContractComponentRef(
      input.providerTransport,
      `${label}.providerTransport`,
    ),
    isolationGuarantees,
    isolationLevel,
  });
}

function normalizeLifetime(input: unknown): AgentContractBoundaryLifetimeV1 {
  const label = 'agentContractBoundaryDescriptor.lifetime';
  plainRecord(input, label);
  exactKeys(input, LIFETIME_KEYS, label);
  const kind = enumValue(input.kind, AGENT_CONTRACT_LIFETIME_KINDS, `${label}.kind`);
  const parentTurnContinuation = enumValue(
    input.parentTurnContinuation,
    AGENT_CONTRACT_PARENT_TURN_CONTINUATIONS,
    `${label}.parentTurnContinuation`,
  );
  if (parentTurnContinuation !== LIFETIME_CONTINUATIONS[kind]) {
    throw new TypeError(
      `${label}.parentTurnContinuation must be ${LIFETIME_CONTINUATIONS[kind]} for ${kind}`,
    );
  }
  const authority = normalizeAgentContractComponentRef(input.authority, `${label}.authority`);
  if (kind === 'pending' && authority.state !== 'pending') {
    throw new TypeError(`${label}.authority must be pending for a pending lifetime`);
  }
  if (kind === 'unbound' && authority.state !== 'missing') {
    throw new TypeError(`${label}.authority must be missing for an unbound lifetime`);
  }
  if (kind !== 'pending' && kind !== 'unbound'
    && authority.state !== 'indexed' && authority.state !== 'runtime-resolved') {
    throw new TypeError(`${label}.authority must be present for an active lifetime`);
  }
  return Object.freeze({
    kind,
    authority,
    parentTurnContinuation,
    terminationFences: tokenSet(input.terminationFences, `${label}.terminationFences`, 64, 1),
  });
}

export function normalizeAgentContractBoundaryDescriptor(
  input: unknown,
): AgentContractBoundaryDescriptorV1 {
  const label = 'agentContractBoundaryDescriptor';
  plainRecord(input, label);
  exactKeys(input, DESCRIPTOR_KEYS, label);
  if (input.boundaryVersion !== AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION) {
    throw new TypeError(
      `${label}.boundaryVersion must be ${AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION}`,
    );
  }
  if (input.authorityEffect !== 'none') {
    throw new TypeError(`${label}.authorityEffect must be none`);
  }
  if (input.runtimeStateIncluded !== false) {
    throw new TypeError(`${label}.runtimeStateIncluded must be false`);
  }
  const identityKind = enumValue(
    input.identityKind,
    AGENT_CONTRACT_IDENTITY_KINDS,
    `${label}.identityKind`,
  );
  const workspace = normalizeWorkspace(input.workspace);
  const environment = normalizeEnvironment(input.environment);
  const lifetime = normalizeLifetime(input.lifetime);
  if (!IDENTITY_LIFETIMES[identityKind].includes(lifetime.kind)) {
    throw new TypeError(`${label}.lifetime.kind is incompatible with identityKind ${identityKind}`);
  }
  if (identityKind === 'unbound' && environment.isolationLevel !== 'not-applicable') {
    throw new TypeError(`${label}.environment.isolationLevel must be not-applicable when unbound`);
  }
  if (identityKind === 'unbound') {
    const applicableSlot = WORKSPACE_SLOT_NAMES.find(
      (name) => workspace[name].applicability !== 'not-applicable',
    );
    if (applicableSlot !== undefined) {
      throw new TypeError(
        `${label}.workspace.${applicableSlot} must be not-applicable when unbound`,
      );
    }
    if (environment.applicationGrantedDirectCapabilities.length !== 0) {
      throw new TypeError(
        `${label}.environment.applicationGrantedDirectCapabilities must be empty when unbound`,
      );
    }
    if (environment.isolationGuarantees.length !== 0) {
      throw new TypeError(`${label}.environment.isolationGuarantees must be empty when unbound`);
    }
    const environmentComponents = [
      ['modelToolSurface', environment.modelToolSurface],
      ['skillExecutionGrant', environment.skillExecutionGrant],
      ['hostPortSet', environment.hostPortSet],
      ['providerTransport', environment.providerTransport],
    ] as const;
    const presentEnvironmentComponent = environmentComponents.find(
      ([, component]) => component.state !== 'missing',
    );
    if (presentEnvironmentComponent !== undefined) {
      throw new TypeError(
        `${label}.environment.${presentEnvironmentComponent[0]} must be missing when unbound`,
      );
    }
  }
  if (identityKind !== 'unbound' && environment.isolationLevel !== 'application-contract-only') {
    throw new TypeError(`${label}.environment.isolationLevel must be application-contract-only when bound`);
  }
  return Object.freeze({
    boundaryVersion: AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION,
    contractId: token(input.contractId, `${label}.contractId`),
    contractIndexRevision: token(input.contractIndexRevision, `${label}.contractIndexRevision`),
    identityKind,
    workspace,
    environment,
    lifetime,
    authorityEffect: 'none' as const,
    runtimeStateIncluded: false as const,
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function validateContractIndex(input: AgentContractIndexV1): AgentContractIndexV1 {
  const label = 'agentContractIndex';
  plainRecord(input, label);
  exactKeys(input, CONTRACT_INDEX_KEYS, label);
  if (input.indexVersion !== AGENT_CONTRACT_INDEX_VERSION) {
    throw new TypeError(`${label}.indexVersion must be ${AGENT_CONTRACT_INDEX_VERSION}`);
  }
  if (input.authorityEffect !== 'none') throw new TypeError(`${label}.authorityEffect must be none`);
  if (input.runtimeStateIncluded !== false) {
    throw new TypeError(`${label}.runtimeStateIncluded must be false`);
  }
  token(input.indexRevision, `${label}.indexRevision`);
  const entries = denseArray(input.entries, `${label}.entries`, 256);
  const rebuilt = createAgentContractIndex(entries);
  if (rebuilt.indexRevision !== input.indexRevision) {
    throw new TypeError(`${label}.indexRevision does not match its normalized entries`);
  }
  return rebuilt;
}

/**
 * Constructs a deterministic, authority-free companion index for one exact Agent contract index.
 * Live handles and mutable rollout state must remain in their existing runtime authorities.
 */
export function createAgentContractBoundaryIndex(
  contractIndex: AgentContractIndexV1,
  entries: readonly unknown[],
): AgentContractBoundaryIndexV1 {
  const normalizedContractIndex = validateContractIndex(contractIndex);
  const items = denseArray(entries, 'agentContractBoundaryIndex.entries', 256);
  const normalized = items.map(normalizeAgentContractBoundaryDescriptor).sort(
    (left, right) => compareText(left.contractId, right.contractId),
  );
  const contractIds = normalized.map((entry) => entry.contractId);
  if (new Set(contractIds).size !== contractIds.length) {
    throw new TypeError('agentContractBoundaryIndex contains duplicate contractId');
  }
  if (normalized.length !== normalizedContractIndex.entries.length) {
    throw new TypeError('agentContractBoundaryIndex must cover every Agent contract exactly once');
  }
  const contractsById = new Map(
    normalizedContractIndex.entries.map((entry) => [entry.contractId, entry] as const),
  );
  for (const entry of normalized) {
    if (entry.contractIndexRevision !== normalizedContractIndex.indexRevision) {
      throw new TypeError(
        `agentContractBoundaryIndex entry ${entry.contractId} has a mismatched contractIndexRevision`,
      );
    }
    const contract = contractsById.get(entry.contractId);
    if (contract === undefined) {
      throw new TypeError(`agentContractBoundaryIndex contains unknown contractId: ${entry.contractId}`);
    }
    if (entry.identityKind !== contract.execution.identityKind) {
      throw new TypeError(
        `agentContractBoundaryIndex entry ${entry.contractId} has a mismatched identityKind`,
      );
    }
  }
  const frozenEntries = Object.freeze(normalized);
  const core = {
    indexVersion: AGENT_CONTRACT_BOUNDARY_INDEX_VERSION,
    contractIndexRevision: normalizedContractIndex.indexRevision,
    authorityEffect: 'none' as const,
    runtimeStateIncluded: false as const,
    entries: frozenEntries,
  };
  return Object.freeze({ ...core, indexRevision: digest(core) });
}

/** Strictly validates and reconstructs a serialized boundary index against its exact base index. */
export function normalizeAgentContractBoundaryIndex(
  contractIndex: AgentContractIndexV1,
  input: unknown,
): AgentContractBoundaryIndexV1 {
  const label = 'agentContractBoundaryIndex';
  plainRecord(input, label);
  exactKeys(input, BOUNDARY_INDEX_KEYS, label);
  if (input.indexVersion !== AGENT_CONTRACT_BOUNDARY_INDEX_VERSION) {
    throw new TypeError(`${label}.indexVersion must be ${AGENT_CONTRACT_BOUNDARY_INDEX_VERSION}`);
  }
  if (input.authorityEffect !== 'none') {
    throw new TypeError(`${label}.authorityEffect must be none`);
  }
  if (input.runtimeStateIncluded !== false) {
    throw new TypeError(`${label}.runtimeStateIncluded must be false`);
  }
  const normalizedContractIndex = validateContractIndex(contractIndex);
  const contractIndexRevision = token(
    input.contractIndexRevision,
    `${label}.contractIndexRevision`,
  );
  if (contractIndexRevision !== normalizedContractIndex.indexRevision) {
    throw new TypeError(`${label}.contractIndexRevision does not match the Agent contract index`);
  }
  const indexRevision = token(input.indexRevision, `${label}.indexRevision`);
  const entries = denseArray(input.entries, `${label}.entries`, 256);
  const rebuilt = createAgentContractBoundaryIndex(normalizedContractIndex, entries);
  if (rebuilt.indexRevision !== indexRevision) {
    throw new TypeError(`${label}.indexRevision does not match its normalized entries`);
  }
  return rebuilt;
}
