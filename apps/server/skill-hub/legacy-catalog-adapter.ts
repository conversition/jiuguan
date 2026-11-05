import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_CONTENT_MODES,
  AGENT_SKILL_KINDS,
  AGENT_SKILL_OWNERS,
  AGENT_SKILL_PHASES,
  AGENT_SKILL_RISK_TIERS,
  AGENT_SKILL_SOURCE_TYPES,
  createAgentSkillCatalogSnapshot,
  createAgentSkillHeader,
  describeAgentSkillBody,
  type AgentSkillCatalogPort,
  type AgentSkillCatalogSnapshotV1,
  type AgentSkillBodyRequestV1,
  type AgentSkillContentMode,
  type AgentSkillHeaderV1,
  type AgentSkillKind,
  type AgentSkillOwner,
  type AgentSkillPhase,
  type AgentSkillRiskTier,
  type AgentSkillScopeKind,
  type AgentSkillSourceType,
} from '@jiuguan/skill-hub';

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const LEGACY_INPUT_SCHEMA_DIGEST = digest('legacy-agent-skill-input-v1');
const LEGACY_OUTPUT_SCHEMA_DIGEST = digest('legacy-agent-skill-output-v1');

export interface LegacyAgentSkillRecord {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly body: string;
  /** Exact full-document identity when the record came from one immutable SKILL.md read. */
  readonly documentIdentityDigest?: string;
  readonly role?: string;
  readonly kind?: string;
  readonly owner?: string;
  readonly sourceType?: string;
  readonly sourceHash?: string;
  readonly lifecycle?: string;
  readonly capabilityIds?: readonly string[];
  readonly taskKinds?: readonly string[];
  readonly phases?: readonly string[];
  readonly contentModes?: readonly string[];
  readonly scopeLevel?: string;
  readonly scopeSelector?: string;
  readonly risk?: string;
  readonly evaluatorId?: string;
  readonly conflictGroup?: string;
  readonly requiresSkills?: readonly string[];
  readonly desiredTools?: readonly string[];
}

export const LEGACY_AGENT_SKILL_SKIP_CODES = Object.freeze([
  'disabled',
  'inactive-lifecycle',
  'empty-body',
  'missing-capability',
  'missing-task-kind',
  'missing-phase',
  'missing-content-mode',
  'missing-scope',
  'missing-scope-selector',
  'missing-risk',
  'missing-evaluator',
  'invalid-metadata',
  'duplicate-identity',
  'dependency-unresolved',
] as const);

export type LegacyAgentSkillSkipCode = typeof LEGACY_AGENT_SKILL_SKIP_CODES[number];

export interface LegacyAgentSkillSkip {
  readonly skillName: string;
  readonly code: LegacyAgentSkillSkipCode;
}

export interface LegacyAgentSkillPublishedRef {
  readonly skillId: string;
  readonly version: string;
  readonly sourceVersion: string;
  readonly documentIdentityDigest: string;
  readonly manifestDigest: string;
}

export interface LegacyAgentSkillCatalogAdapter {
  readonly catalogPort: AgentSkillCatalogPort;
  readonly snapshot: AgentSkillCatalogSnapshotV1;
  readonly published: readonly LegacyAgentSkillPublishedRef[];
  readonly skipped: readonly LegacyAgentSkillSkip[];
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Locale-independent UTF-16 code-unit order for cross-host catalog determinism. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function legacyAgentSkillId(name: string): string {
  return `skill:sha256:${createHash('sha256').update(name.normalize('NFC').trim(), 'utf8').digest('hex')}`;
}

/**
 * Legacy files are mutable, so their compatibility version must bind the complete normalized
 * immutable identity (metadata, exact dependencies and body hash), not merely the body bytes.
 */
export function legacyAgentSkillVersion(sourceVersion: string, identityDigest: string): string {
  if (!VERSION_RE.test(sourceVersion) || !DIGEST_RE.test(identityDigest)) {
    throw new TypeError('legacy Agent Skill version input is invalid');
  }
  return `legacy.${sourceVersion.slice(0, 8)}.${identityDigest.slice('sha256:'.length)}`;
}

function stableToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function tokenList(value: readonly string[] | undefined): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null;
  if (value.some((item) => !stableToken(item))) return null;
  const unique = [...new Set(value)];
  if (unique.length !== value.length) return null;
  return Object.freeze(unique.sort());
}

function enumList<T extends string>(
  value: readonly string[] | undefined,
  allowed: readonly T[],
): readonly T[] | null {
  const tokens = tokenList(value);
  if (!tokens || tokens.some((item) => !allowed.includes(item as T))) return null;
  return tokens as readonly T[];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

function sourceType(record: LegacyAgentSkillRecord): AgentSkillSourceType {
  const direct = enumValue(record.sourceType, AGENT_SKILL_SOURCE_TYPES);
  if (direct) return direct;
  if (record.sourceType === 'managed') return 'learned';
  return 'filesystem';
}

function owner(record: LegacyAgentSkillRecord, source: AgentSkillSourceType): AgentSkillOwner | null {
  const direct = enumValue(record.owner, AGENT_SKILL_OWNERS);
  if (direct) return direct;
  if (source === 'builtin') return 'host';
  if (source === 'learned') return 'learned';
  return 'author';
}

function normalizedSourceHash(record: LegacyAgentSkillRecord): string {
  return record.sourceHash && DIGEST_RE.test(record.sourceHash)
    ? record.sourceHash
    : digest(JSON.stringify({ name: record.name, version: record.version, body: record.body }));
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < 1 || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized)) return null;
  return normalized;
}

function addSkip(
  skipped: LegacyAgentSkillSkip[],
  record: LegacyAgentSkillRecord,
  code: LegacyAgentSkillSkipCode,
): void {
  const name = typeof record.name === 'string' ? record.name : '(invalid legacy Skill)';
  skipped.push(Object.freeze({ skillName: name.slice(0, 240), code }));
}

interface LegacyIdentity {
  readonly skillId: string;
  readonly version: string;
}

interface PreparedLegacyAgentSkill {
  readonly record: LegacyAgentSkillRecord;
  readonly skillId: string;
  readonly sourceVersion: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyTokens: number;
  readonly documentIdentityDigest: string;
  readonly kind: AgentSkillKind;
  readonly owner: AgentSkillOwner;
  readonly sourceType: AgentSkillSourceType;
  readonly sourceHash: string;
  readonly capabilityIds: readonly string[];
  readonly taskKinds: readonly string[];
  readonly phases: readonly AgentSkillPhase[];
  readonly contentModes: readonly AgentSkillContentMode[];
  readonly scope: Readonly<{ kind: AgentSkillScopeKind; selector?: string }>;
  readonly riskTier: AgentSkillRiskTier;
  readonly evaluatorId: string;
  readonly conflictGroup?: string;
  readonly desiredTools: readonly string[];
  readonly requestedDependencies: readonly string[];
}

function normalizedDocumentIdentityDigest(record: LegacyAgentSkillRecord): string {
  if (record.documentIdentityDigest && DIGEST_RE.test(record.documentIdentityDigest)) {
    return record.documentIdentityDigest;
  }
  return digest(JSON.stringify({
    record: 'legacy-agent-skill-record-v1',
    name: record.name,
    description: record.description,
    version: record.version,
    enabled: record.enabled,
    body: record.body,
    role: record.role ?? null,
    kind: record.kind ?? null,
    owner: record.owner ?? null,
    sourceType: record.sourceType ?? null,
    sourceHash: record.sourceHash ?? null,
    lifecycle: record.lifecycle ?? null,
    capabilityIds: record.capabilityIds ?? null,
    taskKinds: record.taskKinds ?? null,
    phases: record.phases ?? null,
    contentModes: record.contentModes ?? null,
    scopeLevel: record.scopeLevel ?? null,
    scopeSelector: record.scopeSelector ?? null,
    risk: record.risk ?? null,
    evaluatorId: record.evaluatorId ?? null,
    conflictGroup: record.conflictGroup ?? null,
    requiresSkills: record.requiresSkills ?? null,
    desiredTools: record.desiredTools ?? null,
  }));
}

function identityDigest(
  candidate: PreparedLegacyAgentSkill,
  dependencies: readonly LegacyIdentity[],
): string {
  return digest(JSON.stringify({
    adapter: 'legacy-agent-skill-catalog-v2',
    sourceVersion: candidate.sourceVersion,
    skillId: candidate.skillId,
    name: candidate.name,
    description: candidate.description,
    kind: candidate.kind,
    owner: candidate.owner,
    capabilityIds: candidate.capabilityIds,
    taskKinds: candidate.taskKinds,
    phases: candidate.phases,
    contentModes: candidate.contentModes,
    scope: candidate.scope,
    riskTier: candidate.riskTier,
    artifactKind: candidate.kind === 'style' ? 'style.instructions' : 'agent.guidance',
    requires: dependencies,
    conflictsWith: [],
    conflictGroup: candidate.conflictGroup ?? null,
    desiredTools: candidate.desiredTools,
    writableArtifactKinds: [],
    limits: { maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
    inputSchemaDigest: LEGACY_INPUT_SCHEMA_DIGEST,
    outputSchemaDigest: LEGACY_OUTPUT_SCHEMA_DIGEST,
    bodyHash: candidate.bodyHash,
    bodyTokens: candidate.bodyTokens,
    sourceType: candidate.sourceType,
    sourceHash: candidate.sourceHash,
    sourceRevision: candidate.sourceHash,
    evaluatorId: candidate.evaluatorId,
    autoPromotion: false,
    priority: candidate.kind === 'foundation' ? 1_000 : 0,
  }));
}

/**
 * Strict compatibility adapter for the existing flat SKILL.md records.
 *
 * Incomplete legacy records are deliberately omitted instead of receiving inferred Agent authority.
 * Omitted records continue to work through the untouched legacy matcher; this adapter is observe-only.
 */
export function createLegacyAgentSkillCatalogAdapter(
  recordsInput: readonly LegacyAgentSkillRecord[],
): LegacyAgentSkillCatalogAdapter {
  if (!Array.isArray(recordsInput) || recordsInput.length > 10_000) {
    throw new TypeError('legacy Agent Skill records must be an array with at most 10000 items');
  }
  const records = [...recordsInput].sort((left, right) => (
    compareText(String(left.name), String(right.name))
    || compareText(String(left.version), String(right.version))
  ));

  // Any source-name collision is ambiguous. Block every colliding row instead of silently making
  // input order an authority decision through Map's last-write-wins behavior.
  const identityCounts = new Map<string, number>();
  for (const record of records) {
    const name = normalizedText(record.name, 240);
    if (!name) continue;
    const skillId = legacyAgentSkillId(name);
    identityCounts.set(skillId, (identityCounts.get(skillId) ?? 0) + 1);
  }
  const duplicateSkillIds = new Set(
    [...identityCounts.entries()].filter(([, count]) => count > 1).map(([skillId]) => skillId),
  );

  const headers: AgentSkillHeaderV1[] = [];
  const bodyByManifest = new Map<string, Readonly<{ header: AgentSkillHeaderV1; body: string }>>();
  const sourceVersionByManifest = new Map<string, string>();
  const documentIdentityByManifest = new Map<string, string>();
  const skipped: LegacyAgentSkillSkip[] = [];
  const prepared: PreparedLegacyAgentSkill[] = [];

  for (const record of records) {
    const normalizedName = normalizedText(record.name, 240);
    if (normalizedName && duplicateSkillIds.has(legacyAgentSkillId(normalizedName))) {
      addSkip(skipped, record, 'duplicate-identity');
      continue;
    }
    if (!record.enabled) {
      addSkip(skipped, record, 'disabled');
      continue;
    }
    if (record.lifecycle !== 'active') {
      addSkip(skipped, record, 'inactive-lifecycle');
      continue;
    }
    if (typeof record.body !== 'string' || record.body.length < 1) {
      addSkip(skipped, record, 'empty-body');
      continue;
    }
    const capabilityIds = tokenList(record.capabilityIds);
    if (!capabilityIds) {
      addSkip(skipped, record, 'missing-capability');
      continue;
    }
    const taskKinds = tokenList(record.taskKinds);
    if (!taskKinds) {
      addSkip(skipped, record, 'missing-task-kind');
      continue;
    }
    const phases = enumList<AgentSkillPhase>(record.phases, AGENT_SKILL_PHASES);
    if (!phases) {
      addSkip(skipped, record, 'missing-phase');
      continue;
    }
    const contentModes = enumList<AgentSkillContentMode>(record.contentModes, AGENT_SKILL_CONTENT_MODES);
    if (!contentModes) {
      addSkip(skipped, record, 'missing-content-mode');
      continue;
    }
    const scope = enumValue<AgentSkillScopeKind>(record.scopeLevel, ['global', 'session', 'card', 'world']);
    if (!scope) {
      addSkip(skipped, record, 'missing-scope');
      continue;
    }
    const scopeSelector = record.scopeSelector === undefined
      ? null
      : (stableToken(record.scopeSelector) ? record.scopeSelector : null);
    if (scope !== 'global' && scopeSelector === null) {
      addSkip(skipped, record, 'missing-scope-selector');
      continue;
    }
    if (scope === 'global' && record.scopeSelector !== undefined) {
      addSkip(skipped, record, 'invalid-metadata');
      continue;
    }
    const riskTier = enumValue<AgentSkillRiskTier>(record.risk, AGENT_SKILL_RISK_TIERS);
    if (!riskTier) {
      addSkip(skipped, record, 'missing-risk');
      continue;
    }
    if (!stableToken(record.evaluatorId)) {
      addSkip(skipped, record, 'missing-evaluator');
      continue;
    }
    const requestedDependencies = record.requiresSkills ?? [];
    if (!Array.isArray(requestedDependencies) || requestedDependencies.length > 32
      || requestedDependencies.some((dependency) => (
        typeof dependency !== 'string' || dependency.normalize('NFC').trim().length < 1
      ))) {
      addSkip(skipped, record, 'dependency-unresolved');
      continue;
    }
    const kind = enumValue<AgentSkillKind>(
      record.kind ?? (record.role === 'style' ? 'style' : undefined),
      AGENT_SKILL_KINDS,
    );
    const normalizedSourceType = sourceType(record);
    const normalizedOwner = owner(record, normalizedSourceType);
    const desiredTools = record.desiredTools?.length ? tokenList(record.desiredTools) : Object.freeze([]);
    const sourceVersion = typeof record.version === 'string' ? record.version.normalize('NFC').trim() : '';
    const description = normalizedText(
      typeof record.description === 'string' && record.description.trim().length > 0
        ? record.description
        : normalizedName,
      4_096,
    );
    if (!kind || !normalizedOwner || !desiredTools
      || (record.documentIdentityDigest !== undefined && !DIGEST_RE.test(record.documentIdentityDigest))
      || (record.conflictGroup !== undefined && !stableToken(record.conflictGroup))
      || (kind === 'foundation' && (normalizedOwner !== 'host' || normalizedSourceType !== 'builtin'))
      || !normalizedName || !description || !VERSION_RE.test(sourceVersion)) {
      addSkip(skipped, record, 'invalid-metadata');
      continue;
    }

    try {
      const bodyDescription = describeAgentSkillBody(record.body);
      prepared.push(Object.freeze({
        record,
        skillId: legacyAgentSkillId(normalizedName),
        sourceVersion,
        name: normalizedName,
        description,
        body: record.body,
        ...bodyDescription,
        documentIdentityDigest: normalizedDocumentIdentityDigest(record),
        kind,
        owner: normalizedOwner,
        sourceType: normalizedSourceType,
        sourceHash: normalizedSourceHash(record),
        capabilityIds,
        taskKinds,
        phases,
        contentModes,
        scope: Object.freeze({
          kind: scope,
          ...(scopeSelector === null ? {} : { selector: scopeSelector }),
        }),
        riskTier,
        evaluatorId: record.evaluatorId,
        ...(record.conflictGroup ? { conflictGroup: record.conflictGroup } : {}),
        desiredTools,
        requestedDependencies: Object.freeze([
          ...new Set(requestedDependencies.map((dependency) => dependency.normalize('NFC').trim())),
        ].sort()),
      }));
    } catch {
      addSkip(skipped, record, 'invalid-metadata');
    }
  }

  const candidateBySkillId = new Map(prepared.map((candidate) => [candidate.skillId, candidate]));
  const aliases = new Map<string, PreparedLegacyAgentSkill | null>();
  const addAlias = (alias: string, candidate: PreparedLegacyAgentSkill): void => {
    const prior = aliases.get(alias);
    aliases.set(alias, prior === undefined || prior === candidate ? candidate : null);
  };
  for (const candidate of prepared) {
    addAlias(candidate.name, candidate);
    addAlias(candidate.skillId, candidate);
  }

  const dependencyIds = new Map<string, readonly string[]>();
  const viable = new Map(candidateBySkillId);
  for (const candidate of prepared) {
    const resolved = candidate.requestedDependencies.map((request) => aliases.get(request));
    if (resolved.some((dependency) => dependency === undefined || dependency === null
      || dependency.skillId === candidate.skillId)) {
      addSkip(skipped, candidate.record, 'dependency-unresolved');
      viable.delete(candidate.skillId);
      continue;
    }
    dependencyIds.set(candidate.skillId, Object.freeze([
      ...new Set((resolved as PreparedLegacyAgentSkill[]).map((dependency) => dependency.skillId)),
    ].sort()));
  }

  // A dependency is publishable only if it survives every preceding check. Propagate removals so
  // no manifest can point at an inactive, invalid, duplicate or otherwise omitted compatibility row.
  let removedDependency = true;
  while (removedDependency) {
    removedDependency = false;
    for (const candidate of [...viable.values()]) {
      if ((dependencyIds.get(candidate.skillId) ?? []).some((skillId) => !viable.has(skillId))) {
        addSkip(skipped, candidate.record, 'dependency-unresolved');
        viable.delete(candidate.skillId);
        removedDependency = true;
      }
    }
  }

  const pending = new Map(viable);
  const builtIdentities = new Map<string, LegacyIdentity>();
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((candidate) => (
      (dependencyIds.get(candidate.skillId) ?? []).every((skillId) => builtIdentities.has(skillId))
    )).sort((left, right) => compareText(left.skillId, right.skillId));
    if (ready.length === 0) {
      // Legacy cycles cannot have recursively content-addressed exact versions. Fail closed rather
      // than manufacturing mutable or order-dependent version identities.
      for (const candidate of pending.values()) addSkip(skipped, candidate.record, 'dependency-unresolved');
      pending.clear();
      break;
    }

    for (const candidate of ready) {
      pending.delete(candidate.skillId);
      const dependencies = Object.freeze((dependencyIds.get(candidate.skillId) ?? []).map((skillId) => {
        const identity = builtIdentities.get(skillId);
        if (!identity) throw new Error('legacy-agent-skill-dependency-not-built');
        return identity;
      }).sort((left, right) => (
        compareText(left.skillId, right.skillId) || compareText(left.version, right.version)
      )));
      try {
        const immutableIdentityDigest = identityDigest(candidate, dependencies);
        const immutableVersion = legacyAgentSkillVersion(
          candidate.sourceVersion,
          immutableIdentityDigest,
        );
        const header = createAgentSkillHeader({
          manifestVersion: 'agent-skill-manifest-v1',
          skillId: candidate.skillId,
          version: immutableVersion,
          name: candidate.name,
          description: candidate.description,
          kind: candidate.kind,
          owner: candidate.owner,
          capabilityIds: candidate.capabilityIds,
          taskKinds: candidate.taskKinds,
          phases: candidate.phases,
          contentModes: candidate.contentModes,
          scope: candidate.scope,
          riskTier: candidate.riskTier,
          artifactKind: candidate.kind === 'style' ? 'style.instructions' : 'agent.guidance',
          requires: dependencies,
          conflictsWith: [],
          ...(candidate.conflictGroup ? { conflictGroup: candidate.conflictGroup } : {}),
          desiredTools: candidate.desiredTools,
          // Legacy metadata never grants write authority. A future managed manifest must declare it explicitly.
          writableArtifactKinds: [],
          limits: { maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
          inputSchemaDigest: LEGACY_INPUT_SCHEMA_DIGEST,
          outputSchemaDigest: LEGACY_OUTPUT_SCHEMA_DIGEST,
          bodyHash: candidate.bodyHash,
          bodyTokens: candidate.bodyTokens,
          sourceType: candidate.sourceType,
          sourceHash: candidate.sourceHash,
          sourceRevision: candidate.sourceHash,
          provenanceDigest: digest(JSON.stringify({
            adapter: 'legacy-agent-skill-catalog-v2',
            immutableIdentityDigest,
          })),
          evaluatorId: candidate.evaluatorId,
          autoPromotion: false,
          priority: candidate.kind === 'foundation' ? 1_000 : 0,
        });
        headers.push(header);
        builtIdentities.set(candidate.skillId, Object.freeze({
          skillId: candidate.skillId,
          version: immutableVersion,
        }));
        bodyByManifest.set(header.manifestDigest, Object.freeze({ header, body: candidate.body }));
        sourceVersionByManifest.set(header.manifestDigest, candidate.sourceVersion);
        documentIdentityByManifest.set(header.manifestDigest, candidate.documentIdentityDigest);
      } catch {
        addSkip(skipped, candidate.record, 'invalid-metadata');
      }
    }
  }

  const snapshot = createAgentSkillCatalogSnapshot(headers);
  const catalogPort: AgentSkillCatalogPort = Object.freeze({
    async readCatalog(): Promise<AgentSkillCatalogSnapshotV1> {
      return snapshot;
    },
    async loadBody(request: AgentSkillBodyRequestV1): Promise<string> {
      if (request.catalogRevision !== snapshot.catalogRevision) {
        throw new Error('agent-skill-catalog-revision-stale');
      }
      const entry = bodyByManifest.get(request.manifestDigest);
      if (!entry
        || entry.header.manifest.skillId !== request.skillId
        || entry.header.manifest.version !== request.version
        || entry.header.manifest.bodyHash !== request.bodyHash) {
        throw new Error('agent-skill-body-reference-invalid');
      }
      return entry.body;
    },
  });
  const published = Object.freeze(snapshot.headers.map((header) => Object.freeze({
    skillId: header.manifest.skillId,
    version: header.manifest.version,
    sourceVersion: sourceVersionByManifest.get(header.manifestDigest) ?? header.manifest.version,
    documentIdentityDigest: documentIdentityByManifest.get(header.manifestDigest)
      ?? digest(JSON.stringify(header)),
    manifestDigest: header.manifestDigest,
  })));
  return Object.freeze({
    catalogPort,
    snapshot,
    published,
    skipped: Object.freeze(skipped),
  });
}
