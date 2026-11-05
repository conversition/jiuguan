import {
  assertExactKeys,
  assertPlainRecord,
  booleanValue,
  boundedString,
  compareText,
  deepFreeze,
  digestCanonical,
  digestText,
  member,
  safeInteger,
  sha256Digest,
  stableToken,
  uniqueSortedTokens,
  versionToken,
} from './internal.ts';

export const AGENT_SKILL_MANIFEST_VERSION = 'agent-skill-manifest-v1' as const;
export const AGENT_SKILL_HEADER_VERSION = 'agent-skill-header-v1' as const;
export const AGENT_SKILL_BUNDLE_VERSION = 'agent-skill-bundle-v1' as const;

export const AGENT_SKILL_KINDS = Object.freeze([
  'foundation', 'policy', 'procedure', 'style', 'validator',
] as const);
export type AgentSkillKind = typeof AGENT_SKILL_KINDS[number];

export const AGENT_SKILL_OWNERS = Object.freeze(['host', 'author', 'learned'] as const);
export type AgentSkillOwner = typeof AGENT_SKILL_OWNERS[number];

export const AGENT_SKILL_PHASES = Object.freeze(['plan', 'execute', 'validate', 'learn'] as const);
export type AgentSkillPhase = typeof AGENT_SKILL_PHASES[number];

export const AGENT_SKILL_CONTENT_MODES = Object.freeze(['nsf', 'nsfw'] as const);
export type AgentSkillContentMode = typeof AGENT_SKILL_CONTENT_MODES[number];

export const AGENT_SKILL_RISK_TIERS = Object.freeze(['advisory', 'proposal', 'write'] as const);
export type AgentSkillRiskTier = typeof AGENT_SKILL_RISK_TIERS[number];

export const AGENT_SKILL_SOURCE_TYPES = Object.freeze([
  'builtin', 'filesystem', 'imported', 'learned',
] as const);
export type AgentSkillSourceType = typeof AGENT_SKILL_SOURCE_TYPES[number];

export const AGENT_SKILL_SCOPE_KINDS = Object.freeze(['global', 'session', 'card', 'world'] as const);
export type AgentSkillScopeKind = typeof AGENT_SKILL_SCOPE_KINDS[number];

export interface AgentSkillScopeV1 {
  readonly kind: AgentSkillScopeKind;
  /** Optional exact runtime identity. Omission means any target of this scope kind. */
  readonly selector?: string;
}

export interface AgentSkillDependencyV1 {
  readonly skillId: string;
  /** Dependencies always name an immutable exact version; ranges are intentionally unsupported. */
  readonly version: string;
}

export interface AgentSkillExecutionLimitsV1 {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Domain-neutral, immutable Skill metadata. Permission-looking fields are requirements only:
 * selectors/admission must prove that the host grant already contains them. A manifest is never
 * an authority source.
 */
export interface AgentSkillManifestV1 {
  readonly manifestVersion: typeof AGENT_SKILL_MANIFEST_VERSION;
  readonly skillId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly kind: AgentSkillKind;
  readonly owner: AgentSkillOwner;
  readonly capabilityIds: readonly string[];
  readonly taskKinds: readonly string[];
  readonly phases: readonly AgentSkillPhase[];
  readonly contentModes: readonly AgentSkillContentMode[];
  readonly scope: AgentSkillScopeV1;
  readonly riskTier: AgentSkillRiskTier;
  readonly artifactKind: string;
  readonly requires: readonly AgentSkillDependencyV1[];
  readonly conflictsWith: readonly string[];
  readonly conflictGroup?: string;
  readonly desiredTools: readonly string[];
  readonly writableArtifactKinds: readonly string[];
  readonly limits: AgentSkillExecutionLimitsV1;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly bodyHash: string;
  readonly bodyTokens: number;
  readonly sourceType: AgentSkillSourceType;
  readonly sourceHash: string;
  readonly sourceRevision: string;
  readonly provenanceDigest: string;
  readonly evaluatorId: string;
  readonly autoPromotion: boolean;
  readonly priority: number;
}

export interface AgentSkillHeaderV1 {
  readonly headerVersion: typeof AGENT_SKILL_HEADER_VERSION;
  readonly manifest: AgentSkillManifestV1;
  readonly manifestDigest: string;
}

export interface AgentSkillBundleV1 {
  readonly bundleVersion: typeof AGENT_SKILL_BUNDLE_VERSION;
  readonly header: AgentSkillHeaderV1;
  /** Exact bytes-as-text. No trimming, summarization or truncation is permitted. */
  readonly body: string;
  readonly bundleDigest: string;
}

const MANIFEST_KEYS = new Set([
  'manifestVersion', 'skillId', 'version', 'name', 'description', 'kind', 'owner',
  'capabilityIds', 'taskKinds', 'phases', 'contentModes', 'scope', 'riskTier',
  'artifactKind', 'requires', 'conflictsWith', 'conflictGroup', 'desiredTools',
  'writableArtifactKinds', 'limits', 'inputSchemaDigest', 'outputSchemaDigest',
  'bodyHash', 'bodyTokens', 'sourceType', 'sourceHash', 'sourceRevision',
  'provenanceDigest', 'evaluatorId', 'autoPromotion', 'priority',
]);
const REQUIRED_MANIFEST_KEYS = new Set([...MANIFEST_KEYS].filter((key) => key !== 'conflictGroup'));
const SCOPE_KEYS = new Set(['kind', 'selector']);
const LIMIT_KEYS = new Set(['maxModelCalls', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens']);
const DEPENDENCY_KEYS = new Set(['skillId', 'version']);
const HEADER_KEYS = new Set(['headerVersion', 'manifest', 'manifestDigest']);
const BUNDLE_KEYS = new Set(['bundleVersion', 'header', 'body', 'bundleDigest']);
const MAX_BODY_CHARS = 1_048_576;

function normalizeScope(value: unknown): AgentSkillScopeV1 {
  assertPlainRecord(value, 'manifest.scope');
  assertExactKeys(value, SCOPE_KEYS, new Set(['kind']), 'manifest.scope');
  const kind = member(value.kind, AGENT_SKILL_SCOPE_KINDS, 'manifest.scope.kind');
  if (kind === 'global' && value.selector !== undefined) {
    throw new TypeError('manifest.scope.selector is forbidden for global scope');
  }
  return deepFreeze({
    kind,
    ...(value.selector === undefined ? {} : { selector: stableToken(value.selector, 'manifest.scope.selector') }),
  });
}

function normalizeLimits(value: unknown): AgentSkillExecutionLimitsV1 {
  assertPlainRecord(value, 'manifest.limits');
  assertExactKeys(value, LIMIT_KEYS, LIMIT_KEYS, 'manifest.limits');
  return deepFreeze({
    maxModelCalls: safeInteger(value.maxModelCalls, 'manifest.limits.maxModelCalls', 0, 1_000),
    maxToolCalls: safeInteger(value.maxToolCalls, 'manifest.limits.maxToolCalls', 0, 10_000),
    maxInputTokens: safeInteger(value.maxInputTokens, 'manifest.limits.maxInputTokens', 0, 10_000_000),
    maxOutputTokens: safeInteger(value.maxOutputTokens, 'manifest.limits.maxOutputTokens', 0, 10_000_000),
  });
}

function normalizeDependencies(value: unknown): readonly AgentSkillDependencyV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError('manifest.requires must be an array with at most 32 items');
  }
  const output = value.map((item, index) => {
    assertPlainRecord(item, `manifest.requires[${index}]`);
    assertExactKeys(item, DEPENDENCY_KEYS, DEPENDENCY_KEYS, `manifest.requires[${index}]`);
    return deepFreeze({
      skillId: stableToken(item.skillId, `manifest.requires[${index}].skillId`),
      version: versionToken(item.version, `manifest.requires[${index}].version`),
    });
  }).sort((left, right) => compareText(left.skillId, right.skillId) || compareText(left.version, right.version));
  const refs = output.map((item) => `${item.skillId}\u0000${item.version}`);
  if (new Set(refs).size !== refs.length) throw new TypeError('manifest.requires must not contain duplicates');
  return Object.freeze(output);
}

function normalizeEnumSet<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): readonly T[number][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > values.length) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const output = value.map((item, index) => member(item, values, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(output.sort(compareText));
}

export function normalizeAgentSkillManifest(input: unknown): AgentSkillManifestV1 {
  assertPlainRecord(input, 'manifest');
  assertExactKeys(input, MANIFEST_KEYS, REQUIRED_MANIFEST_KEYS, 'manifest');
  if (input.manifestVersion !== AGENT_SKILL_MANIFEST_VERSION) {
    throw new TypeError(`manifest.manifestVersion must be ${AGENT_SKILL_MANIFEST_VERSION}`);
  }
  const skillId = stableToken(input.skillId, 'manifest.skillId');
  const version = versionToken(input.version, 'manifest.version');
  const kind = member(input.kind, AGENT_SKILL_KINDS, 'manifest.kind');
  const owner = member(input.owner, AGENT_SKILL_OWNERS, 'manifest.owner');
  const conflictsWith = uniqueSortedTokens(input.conflictsWith, 'manifest.conflictsWith');
  if (conflictsWith.includes(skillId)) throw new TypeError('manifest.conflictsWith cannot contain its own skillId');
  const requires = normalizeDependencies(input.requires);
  if (requires.some((item) => item.skillId === skillId && item.version === version)) {
    throw new TypeError('manifest.requires cannot contain itself');
  }
  const autoPromotion = booleanValue(input.autoPromotion, 'manifest.autoPromotion');
  if (kind === 'foundation' && owner !== 'host') {
    throw new TypeError('foundation Skills must be host-owned');
  }
  if (kind === 'foundation' && autoPromotion) {
    throw new TypeError('foundation Skills cannot enable automatic promotion');
  }
  const normalized: AgentSkillManifestV1 = {
    manifestVersion: AGENT_SKILL_MANIFEST_VERSION,
    skillId,
    version,
    name: boundedString(input.name, 'manifest.name', 240),
    description: boundedString(input.description, 'manifest.description', 4_096),
    kind,
    owner,
    capabilityIds: uniqueSortedTokens(input.capabilityIds, 'manifest.capabilityIds', { minimum: 1 }),
    taskKinds: uniqueSortedTokens(input.taskKinds, 'manifest.taskKinds', { minimum: 1 }),
    phases: normalizeEnumSet(input.phases, AGENT_SKILL_PHASES, 'manifest.phases'),
    contentModes: normalizeEnumSet(input.contentModes, AGENT_SKILL_CONTENT_MODES, 'manifest.contentModes'),
    scope: normalizeScope(input.scope),
    riskTier: member(input.riskTier, AGENT_SKILL_RISK_TIERS, 'manifest.riskTier'),
    artifactKind: stableToken(input.artifactKind, 'manifest.artifactKind'),
    requires,
    conflictsWith,
    ...(input.conflictGroup === undefined
      ? {}
      : { conflictGroup: stableToken(input.conflictGroup, 'manifest.conflictGroup') }),
    desiredTools: uniqueSortedTokens(input.desiredTools, 'manifest.desiredTools'),
    writableArtifactKinds: uniqueSortedTokens(input.writableArtifactKinds, 'manifest.writableArtifactKinds'),
    limits: normalizeLimits(input.limits),
    inputSchemaDigest: sha256Digest(input.inputSchemaDigest, 'manifest.inputSchemaDigest'),
    outputSchemaDigest: sha256Digest(input.outputSchemaDigest, 'manifest.outputSchemaDigest'),
    bodyHash: sha256Digest(input.bodyHash, 'manifest.bodyHash'),
    bodyTokens: safeInteger(input.bodyTokens, 'manifest.bodyTokens', 1, 10_000_000),
    sourceType: member(input.sourceType, AGENT_SKILL_SOURCE_TYPES, 'manifest.sourceType'),
    sourceHash: sha256Digest(input.sourceHash, 'manifest.sourceHash'),
    sourceRevision: stableToken(input.sourceRevision, 'manifest.sourceRevision'),
    provenanceDigest: sha256Digest(input.provenanceDigest, 'manifest.provenanceDigest'),
    evaluatorId: stableToken(input.evaluatorId, 'manifest.evaluatorId'),
    autoPromotion,
    priority: safeInteger(input.priority, 'manifest.priority', -1_000, 1_000),
  };
  return deepFreeze(normalized);
}

export function agentSkillManifestDigest(input: unknown): string {
  return digestCanonical(normalizeAgentSkillManifest(input));
}

export function createAgentSkillHeader(input: unknown): AgentSkillHeaderV1 {
  const manifest = normalizeAgentSkillManifest(input);
  return deepFreeze({
    headerVersion: AGENT_SKILL_HEADER_VERSION,
    manifest,
    manifestDigest: digestCanonical(manifest),
  });
}

export function normalizeAgentSkillHeader(input: unknown): AgentSkillHeaderV1 {
  assertPlainRecord(input, 'skillHeader');
  assertExactKeys(input, HEADER_KEYS, HEADER_KEYS, 'skillHeader');
  if (input.headerVersion !== AGENT_SKILL_HEADER_VERSION) {
    throw new TypeError(`skillHeader.headerVersion must be ${AGENT_SKILL_HEADER_VERSION}`);
  }
  const manifest = normalizeAgentSkillManifest(input.manifest);
  const manifestDigest = sha256Digest(input.manifestDigest, 'skillHeader.manifestDigest');
  if (manifestDigest !== digestCanonical(manifest)) throw new TypeError('skillHeader.manifestDigest mismatch');
  return deepFreeze({ headerVersion: AGENT_SKILL_HEADER_VERSION, manifest, manifestDigest });
}

export function computeAgentSkillBodyHash(body: string): string {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_BODY_CHARS) {
    throw new TypeError('body must be a non-empty bounded string');
  }
  return digestText(body);
}

/** Deterministic compatibility estimator. It observes whole-body cost and never truncates. */
export function exactAgentSkillTokens(body: string): number {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_BODY_CHARS) {
    throw new TypeError('body must be a non-empty bounded string');
  }
  const cjk = (body.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  return Math.ceil(cjk * 1.5 + (body.length - cjk) * 0.4);
}

export function describeAgentSkillBody(body: string): Readonly<{ bodyHash: string; bodyTokens: number }> {
  return Object.freeze({ bodyHash: computeAgentSkillBodyHash(body), bodyTokens: exactAgentSkillTokens(body) });
}

function expectedBundleDigest(header: AgentSkillHeaderV1): string {
  return digestCanonical({
    bundleVersion: AGENT_SKILL_BUNDLE_VERSION,
    skillId: header.manifest.skillId,
    version: header.manifest.version,
    manifestDigest: header.manifestDigest,
    bodyHash: header.manifest.bodyHash,
    sourceHash: header.manifest.sourceHash,
  });
}

export function createAgentSkillBundle(manifestInput: unknown, body: string): AgentSkillBundleV1 {
  const header = createAgentSkillHeader(manifestInput);
  if (computeAgentSkillBodyHash(body) !== header.manifest.bodyHash) {
    throw new TypeError('bundle bodyHash does not match manifest');
  }
  if (exactAgentSkillTokens(body) !== header.manifest.bodyTokens) {
    throw new TypeError('bundle bodyTokens does not match manifest');
  }
  return deepFreeze({
    bundleVersion: AGENT_SKILL_BUNDLE_VERSION,
    header,
    body,
    bundleDigest: expectedBundleDigest(header),
  });
}

export function normalizeAgentSkillBundle(input: unknown): AgentSkillBundleV1 {
  assertPlainRecord(input, 'skillBundle');
  assertExactKeys(input, BUNDLE_KEYS, BUNDLE_KEYS, 'skillBundle');
  if (input.bundleVersion !== AGENT_SKILL_BUNDLE_VERSION) {
    throw new TypeError(`skillBundle.bundleVersion must be ${AGENT_SKILL_BUNDLE_VERSION}`);
  }
  const header = normalizeAgentSkillHeader(input.header);
  if (typeof input.body !== 'string') throw new TypeError('skillBundle.body must be a string');
  const bundle = createAgentSkillBundle(header.manifest, input.body);
  const digest = sha256Digest(input.bundleDigest, 'skillBundle.bundleDigest');
  if (digest !== bundle.bundleDigest) throw new TypeError('skillBundle.bundleDigest mismatch');
  return bundle;
}

export interface ImmutableAgentSkillVersionV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bundleDigest: string;
}

/** Same skillId+version can only ever resolve to one immutable manifest and body bundle. */
export function assertImmutableAgentSkillVersion(
  existing: ImmutableAgentSkillVersionV1,
  incoming: ImmutableAgentSkillVersionV1,
): void {
  const normalize = (value: ImmutableAgentSkillVersionV1, label: string): ImmutableAgentSkillVersionV1 => ({
    skillId: stableToken(value.skillId, `${label}.skillId`),
    version: versionToken(value.version, `${label}.version`),
    manifestDigest: sha256Digest(value.manifestDigest, `${label}.manifestDigest`),
    bundleDigest: sha256Digest(value.bundleDigest, `${label}.bundleDigest`),
  });
  const left = normalize(existing, 'existingVersion');
  const right = normalize(incoming, 'incomingVersion');
  if (left.skillId === right.skillId && left.version === right.version
    && (left.manifestDigest !== right.manifestDigest || left.bundleDigest !== right.bundleDigest)) {
    throw new Error(`immutable Skill version collision: ${left.skillId}@${left.version}`);
  }
}
