import {
  listSkillDocuments,
  skillScopeIdentityDigest,
  type SkillDocumentSnapshot,
} from '../../../packages/core/public/skills.ts';
import {
  createLegacyAgentSkillCatalogAdapter,
  legacyAgentSkillId,
  type LegacyAgentSkillCatalogAdapter,
  type LegacyAgentSkillRecord,
} from './legacy-catalog-adapter.ts';
import { createFilesystemSkillPackageCatalog, type FilesystemSkillPackageCatalogOptions } from './filesystem-package-catalog.ts';

const LEGACY_AGENT_SKILL_ID_RE = /^skill:sha256:[a-f0-9]{64}$/u;

export type FilesystemLegacyAgentSkillDocumentReader = (
  directory?: string,
) => readonly SkillDocumentSnapshot[];

export interface FilesystemLegacyAgentSkillCatalogOptions {
  readonly directory?: string;
  readonly readDocuments?: FilesystemLegacyAgentSkillDocumentReader;
  /**
   * Exact compatibility ids of the roots visible to this catalog snapshot.
   * Dependencies are included transitively; every unrelated document remains outside the snapshot.
   */
  readonly allowedRootSkillIds?: readonly string[];
  /** Explicit host opt-in to immutable sidecar packages through the same Runtime catalog port. */
  readonly compiledPackages?: Omit<FilesystemSkillPackageCatalogOptions, 'directory'>;
}

function normalizeAllowedRootSkillIds(
  value: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000
    || value.some((skillId) => typeof skillId !== 'string' || !LEGACY_AGENT_SKILL_ID_RE.test(skillId))) {
    throw new TypeError('allowed Agent Skill roots must be exact legacy Agent Skill ids');
  }
  return Object.freeze([...new Set(value)].sort());
}

function normalizedLegacyName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < 1 || normalized.length > 240
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized)) return null;
  return normalized;
}

function documentsForAllowedRoots(
  documents: readonly SkillDocumentSnapshot[],
  allowedRootSkillIds: readonly string[] | undefined,
): readonly SkillDocumentSnapshot[] {
  if (allowedRootSkillIds === undefined) return documents;
  if (allowedRootSkillIds.length === 0) return Object.freeze([]);

  const documentsBySkillId = new Map<string, SkillDocumentSnapshot[]>();
  const documentsByDependencyAlias = new Map<string, SkillDocumentSnapshot[]>();
  const add = (
    index: Map<string, SkillDocumentSnapshot[]>,
    alias: string,
    document: SkillDocumentSnapshot,
  ): void => {
    const matches = index.get(alias);
    if (matches) matches.push(document);
    else index.set(alias, [document]);
  };

  for (const document of documents) {
    const name = normalizedLegacyName(document.skill.name);
    if (!name) continue;
    const skillId = legacyAgentSkillId(name);
    add(documentsBySkillId, skillId, document);
    add(documentsByDependencyAlias, name, document);
    add(documentsByDependencyAlias, skillId, document);
  }

  const selected = new Set<SkillDocumentSnapshot>();
  const pending: SkillDocumentSnapshot[] = [];
  const include = (document: SkillDocumentSnapshot): void => {
    if (selected.has(document)) return;
    selected.add(document);
    pending.push(document);
  };
  for (const rootSkillId of allowedRootSkillIds) {
    for (const document of documentsBySkillId.get(rootSkillId) ?? []) include(document);
  }

  while (pending.length > 0) {
    const document = pending.shift();
    if (!document) break;
    for (const requestedDependency of document.skill.requiresSkills ?? []) {
      if (typeof requestedDependency !== 'string') continue;
      const alias = requestedDependency.normalize('NFC').trim();
      for (const dependency of documentsByDependencyAlias.get(alias) ?? []) include(dependency);
    }
  }

  return Object.freeze(documents.filter((document) => selected.has(document)));
}

function toLegacyRecord(document: SkillDocumentSnapshot): LegacyAgentSkillRecord {
  const { skill, body, documentIdentityDigest } = document;
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    enabled: skill.enabled,
    body,
    documentIdentityDigest,
    ...(skill.role === undefined ? {} : { role: skill.role }),
    ...(skill.kind === undefined ? {} : { kind: skill.kind }),
    ...(skill.sourceType === undefined ? {} : { sourceType: skill.sourceType }),
    ...(skill.sourceHash === undefined ? {} : { sourceHash: skill.sourceHash }),
    ...(skill.lifecycle === undefined ? {} : { lifecycle: skill.lifecycle }),
    capabilityIds: skill.capabilityIds,
    taskKinds: skill.taskKinds,
    phases: skill.phases,
    contentModes: skill.contentModes,
    ...(skill.scopeLevel === undefined ? {} : { scopeLevel: skill.scopeLevel }),
    ...(skill.scopeSelector === undefined || skill.scopeLevel === undefined || skill.scopeLevel === 'global'
      ? {}
      : { scopeSelector: skillScopeIdentityDigest(skill.scopeLevel, skill.scopeSelector) }),
    ...(skill.risk === undefined ? {} : { risk: skill.risk }),
    ...(skill.evaluatorId === undefined ? {} : { evaluatorId: skill.evaluatorId }),
    ...(skill.conflictGroup === undefined ? {} : { conflictGroup: skill.conflictGroup }),
    requiresSkills: skill.requiresSkills,
    desiredTools: skill.desiredTools,
  });
}

/** Read one frozen filesystem revision for a post-commit shadow selection. */
export function createFilesystemLegacyAgentSkillCatalogAdapter(
  options?: FilesystemLegacyAgentSkillCatalogOptions,
): LegacyAgentSkillCatalogAdapter;
export function createFilesystemLegacyAgentSkillCatalogAdapter(
  directory?: string,
  readDocuments?: FilesystemLegacyAgentSkillDocumentReader,
  options?: Pick<FilesystemLegacyAgentSkillCatalogOptions, 'allowedRootSkillIds'>,
): LegacyAgentSkillCatalogAdapter;
export function createFilesystemLegacyAgentSkillCatalogAdapter(
  directoryOrOptions?: string | FilesystemLegacyAgentSkillCatalogOptions,
  positionalReadDocuments: FilesystemLegacyAgentSkillDocumentReader = listSkillDocuments,
  positionalOptions: Pick<FilesystemLegacyAgentSkillCatalogOptions, 'allowedRootSkillIds'> = {},
): LegacyAgentSkillCatalogAdapter {
  const configured = typeof directoryOrOptions === 'object' && directoryOrOptions !== null;
  const directory = configured ? directoryOrOptions.directory : directoryOrOptions;
  if (configured && directoryOrOptions.compiledPackages !== undefined) {
    if (typeof directory !== 'string' || directoryOrOptions.readDocuments !== undefined
      || directoryOrOptions.allowedRootSkillIds !== undefined) {
      throw new TypeError('compiled package catalog requires an explicit directory and package pins only');
    }
    return createFilesystemSkillPackageCatalog({ ...directoryOrOptions.compiledPackages, directory });
  }
  const readDocuments = configured
    ? (directoryOrOptions.readDocuments ?? listSkillDocuments)
    : positionalReadDocuments;
  const allowedRootSkillIds = normalizeAllowedRootSkillIds(
    configured ? directoryOrOptions.allowedRootSkillIds : positionalOptions.allowedRootSkillIds,
  );
  const documents = readDocuments(directory);
  return createLegacyAgentSkillCatalogAdapter(
    documentsForAllowedRoots(documents, allowedRootSkillIds).map(toLegacyRecord),
  );
}
