/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 迁移器：把现有 `data/skills/*&#47;SKILL.md` 逐包判定为
 * **compiled** 或 **带稳定 invalid reason**，并给出可核对的资源账本。
 *
 * 三条不做的事：
 * 1. **不替作者补元数据**。缺 capabilityIds/taskKinds/phases/contentModes/risk 的包不会被
 *    「猜一个默认值」；它们带着既有 `LEGACY_AGENT_SKILL_SKIP_CODES` 的码进报告。
 * 2. **不伪造发布**。迁移产出的所有包 `release.state='draft'`，`effect` 一律 0 样本；
 *    发布仍要经过 §17 的 Shadow/Canary/显式 Active。
 * 3. **不猜译正文**。仅提取唯一规范程序块或读取显式 program.json；原文及全部资源
 *    摘要绑定新版本，未映射的 Markdown 明确 invalid，不丢指令、不执行脚本。
 *
 * 判定顺序固定：`skipped（既有 adapter 口径）` → `legacy-uncompiled（正文不是规范 program）`
 * → `compiled`。因此报告里 `compiled + legacy-uncompiled + skipped = 总包数`，
 * 可以直接用来回答「legacy-uncompiled 还有多少」。
 */
import {
  AGENT_SKILL_PROGRAM_SOURCE_CONTRACT,
  createAgentSkillBundle,
  normalizeAgentSkillPackageV2,
  type AgentSkillPackageV2,
  type AgentSkillResourceV1,
} from '@jiuguan/skill-hub';
import { AGENT_SKILL_PROGRAM_INVALID_REASONS, assessAgentSkillProgramCompatibility } from '../../../packages/prompt/public/skill-program.ts';
import { skillDocumentSnapshot } from '../../../packages/core/public/skills.ts';
import { prepareSkillProgramMigration, type PreparedSkillProgramMigration } from './legacy-program-source.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  createLegacyAgentSkillCatalogAdapter,
  LEGACY_AGENT_SKILL_SKIP_CODES,
  type LegacyAgentSkillRecord,
  type LegacyAgentSkillSkipCode,
} from './legacy-catalog-adapter.ts';

export const SKILL_PACKAGE_MIGRATION_REPORT_VERSION =
  'skill-package-migration-report-v1' as const;

/** 闭集：既有 skip 码、同源程序兼容码及包级码；每个目录仍只计一次。 */
export const SKILL_PACKAGE_MIGRATION_REASON_CODES = Object.freeze([
  ...LEGACY_AGENT_SKILL_SKIP_CODES,
  ...AGENT_SKILL_PROGRAM_INVALID_REASONS,
  ...AGENT_SKILL_PROGRAM_SOURCE_CONTRACT.sourceInvalidReasons,
  'package-build-failed',
  'unclassified',
] as const);
export type SkillPackageMigrationReasonCode =
  typeof SKILL_PACKAGE_MIGRATION_REASON_CODES[number];

export interface MigratableSkillDocument {
  /** 目录名（与 SKILL.md 同名前缀），用于报告定位。 */
  readonly directory: string;
  readonly record: LegacyAgentSkillRecord;
  readonly documentIdentityDigest: string;
  /** 已算好的资源清单（含 body 一项，摘要必须等于 body 的 sha256）。 */
  readonly resources: readonly AgentSkillResourceV1[];
  /** 非 body 资源的字节总数，用于报告里的「包体积」。 */
  readonly attachmentBytes: number;
  /** Exact UTF-8 file snapshot, required when SKILL.md becomes a reference. */
  readonly originalDocument?: string;
  /** Exact program.json bytes decoded as UTF-8; never trimmed or normalized. */
  readonly explicitProgram?: string;
  /** Opt-in CI snapshot of the same raw bytes used above; never serialized into the package. */
  readonly resourceBytes?: ReadonlyMap<string, Uint8Array>;
}

export interface SkillPackageMigrationEntryV1 {
  readonly directory: string;
  readonly name: string;
  readonly skillId: string | null;
  readonly version: string | null;
  readonly documentIdentityDigest: string;
  readonly status: 'compiled' | 'invalid';
  readonly reasonCode: SkillPackageMigrationReasonCode | null;
  readonly program: 'canonical' | 'legacy-body' | 'unknown';
  readonly resourceCount: number;
  readonly attachmentBytes: number;
  readonly packageDigest: string | null;
  /** 仅 `package-build-failed` / `unclassified` 时给出根因（截断 200 字符），其余为 null。 */
  readonly detail: string | null;
}

export interface SkillPackageMigrationReportV1 {
  readonly reportVersion: typeof SKILL_PACKAGE_MIGRATION_REPORT_VERSION;
  readonly totals: Readonly<{
    documents: number;
    compiled: number;
    legacyUncompiled: number;
    skipped: number;
    packageBuildFailed: number;
  }>;
  readonly entries: readonly SkillPackageMigrationEntryV1[];
  /** 同一份内容的 skillId：出现即代表同名包无法迁移（必须人工改名）。 */
  readonly duplicateSkillIds: readonly string[];
  /** 目录存在但没有 SKILL.md（空壳目录）。它们也计入「包数」总数，不许从报告里消失。 */
  readonly missingDocuments: readonly string[];
}

export interface SkillPackageMigrationResultV1 {
  readonly report: SkillPackageMigrationReportV1;
  /** 仅供检查/后续落盘；迁移本身不发布、不写库。 */
  readonly packages: readonly Readonly<{ directory: string; package: AgentSkillPackageV2;
    sourceBinding?: Extract<PreparedSkillProgramMigration, { status: 'ready' }>['sourceBinding'] }>[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
});

function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function walkFiles(root: string, relativeDir = ''): string[] {
  const absolute = relativeDir ? join(root, relativeDir) : root;
  const out: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new TypeError(`resource-binding-invalid: linked resource ${childRelative}`);
    if (entry.isDirectory()) out.push(...walkFiles(root, childRelative));
    else if (entry.isFile()) out.push(childRelative);
    else throw new TypeError(`resource-binding-invalid: non-file resource ${childRelative}`);
    if (out.length > 256) throw new TypeError('resource-binding-invalid: too many resources');
  }
  return out.sort(compareText);
}

function resourceRole(path: string): AgentSkillResourceV1['role'] {
  if (path === 'SKILL.md') return 'body';
  if (path.startsWith('samples/') || path.startsWith('examples/')) return 'sample';
  if (path.startsWith('templates/')) return 'template';
  if (path.startsWith('schemas/') || path.endsWith('.json')) return 'schema';
  return 'reference';
}

/**
 * 读一个技能目录的**全部**资源并算摘要。body 的摘要用字符串口径
 * （与 `computeAgentSkillBodyHash` 相同的 UTF-8 sha256），才能与 manifest.bodyHash 对齐；
 * 其余资源按原始字节摘要，任何字节变化都会让包对不上。
 */
function readSkillDirectory(
  skillsDir: string,
  directory: string,
  includeResourceBytes: boolean,
): MigratableSkillDocument | null {
  const root = join(skillsDir, directory);
  const skillFile = join(root, 'SKILL.md');
  const stat = lstatSync(skillFile, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('resource-binding-invalid: SKILL.md must be a regular file');
  const paths = walkFiles(root);
  if (!paths.includes('SKILL.md')) throw new TypeError('resource-binding-invalid: SKILL.md must use exact casing');
  if ((existsSync(join(root, 'program.json')) && !paths.includes('program.json'))
    || paths.some(path => path.toLowerCase() === 'program.json' && path !== 'program.json')) {
    throw new TypeError('resource-binding-invalid: program.json must be a regular file with exact casing');
  }
  const bytesByPath = new Map(paths.map(path => {
    const absolute = join(root, path);
    const file = lstatSync(absolute);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 16 * 1024 * 1024) {
      throw new TypeError(`resource-binding-invalid: invalid resource ${path}`);
    }
    return [path, readFileSync(absolute)] as const;
  }));
  const decode = (path: string): string => {
    const bytes = bytesByPath.get(path)!;
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new TypeError(`resource-binding-invalid: invalid UTF-8 ${path}`);
    return value;
  };
  const originalDocument = decode('SKILL.md');
  const snapshot = skillDocumentSnapshot(directory, skillFile, originalDocument);

  const resources: AgentSkillResourceV1[] = [];
  let attachmentBytes = 0;
  for (const relativePath of paths) {
    const role = resourceRole(relativePath);
    if (role === 'body') {
      resources.push({
        path: relativePath,
        role,
        mediaType: 'text/markdown',
        bytes: Buffer.byteLength(snapshot.body, 'utf8'),
        sha256: `sha256:${createHash('sha256').update(snapshot.body, 'utf8').digest('hex')}`,
      });
      continue;
    }
    const bytes = bytesByPath.get(relativePath)!;
    attachmentBytes += bytes.byteLength;
    resources.push({
      path: relativePath,
      role,
      mediaType: mediaTypeOf(relativePath),
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  }

  return Object.freeze({
    directory,
    documentIdentityDigest: snapshot.documentIdentityDigest,
    resources: Object.freeze(resources),
    attachmentBytes,
    originalDocument,
    ...(includeResourceBytes ? { resourceBytes: bytesByPath } : {}),
    ...(bytesByPath.has('program.json') ? { explicitProgram: decode('program.json') } : {}),
    record: Object.freeze({
      name: snapshot.skill.name, description: snapshot.skill.description, version: snapshot.skill.version,
      enabled: snapshot.skill.enabled, body: snapshot.body, documentIdentityDigest: snapshot.documentIdentityDigest,
      role: snapshot.skill.role, kind: snapshot.skill.kind, sourceType: snapshot.skill.sourceType,
      sourceHash: snapshot.skill.sourceHash, lifecycle: snapshot.skill.lifecycle,
      capabilityIds: snapshot.skill.capabilityIds, taskKinds: snapshot.skill.taskKinds, phases: snapshot.skill.phases,
      contentModes: snapshot.skill.contentModes, scopeLevel: snapshot.skill.scopeLevel, scopeSelector: snapshot.skill.scopeSelector,
      risk: snapshot.skill.risk, evaluatorId: snapshot.skill.evaluatorId, conflictGroup: snapshot.skill.conflictGroup,
      requiresSkills: snapshot.skill.requiresSkills, desiredTools: snapshot.skill.desiredTools,
    }),
  });
}

/** 扫描整个 skills 目录：返回可迁移文档 + 没有 SKILL.md 的空壳目录（不许从报告里消失）。 */
export function readLegacySkillPackages(skillsDir: string, options: Readonly<{ includeResourceBytes?: boolean }> = {}): Readonly<{
  documents: readonly MigratableSkillDocument[];
  missingDirectories: readonly string[];
}> {
  const root = resolve(skillsDir);
  if (!existsSync(root)) throw new TypeError(`skills directory not found: ${skillsDir}`);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError('resource-binding-invalid: skills root must be a real directory');
  const children = readdirSync(root, { withFileTypes: true });
  if (children.some(child => child.isSymbolicLink())) throw new TypeError('resource-binding-invalid: linked skill directory');
  const directories = children
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);
  const documents: MigratableSkillDocument[] = [];
  const missingDirectories: string[] = [];
  for (const directory of directories) {
    const document = readSkillDirectory(root, directory, options.includeResourceBytes === true);
    if (document) documents.push(document);
    else missingDirectories.push(directory);
  }
  return Object.freeze({
    documents: Object.freeze(documents),
    missingDirectories: Object.freeze(missingDirectories),
  });
}

export function migrateLegacySkillPackages(
  documents: readonly MigratableSkillDocument[],
  options: Readonly<{ missingDirectories?: readonly string[] }> = {},
): SkillPackageMigrationResultV1 {
  if (!Array.isArray(documents) || documents.length > 10_000) {
    throw new TypeError('documents must be an array with at most 10000 items');
  }
  const ordered = [...documents].sort((left, right) => (
    compareText(left.record.name, right.record.name)
    || compareText(left.directory, right.directory)
  ));
  const originalAdapter = createLegacyAgentSkillCatalogAdapter(ordered.map((item) => item.record));
  const originalHeaders = new Map(originalAdapter.snapshot.headers.map(header => [header.manifestDigest, header]));
  const originalKinds = new Map(originalAdapter.published.map(item =>
    [item.documentIdentityDigest, originalHeaders.get(item.manifestDigest)!.manifest.kind]));
  // Original metadata checks retain priority. Only compatible programs replace body/sourceHash;
  // the original adapter then rebuilds exact versions and dependency references together.
  const prepared = new Map<MigratableSkillDocument, PreparedSkillProgramMigration>();
  const converted = new Map<MigratableSkillDocument, Extract<PreparedSkillProgramMigration, { status: 'ready' }>>();
  for (const document of ordered) {
    const kind = originalKinds.get(document.record.documentIdentityDigest ?? document.documentIdentityDigest);
    if (!kind) continue;
    const source = prepareSkillProgramMigration(document);
    prepared.set(document, source);
    if (source.status === 'ready' && assessAgentSkillProgramCompatibility(source.body, kind).status === 'compatible') {
      converted.set(document, source);
    }
  }
  const adapter = createLegacyAgentSkillCatalogAdapter(ordered.map(document => {
    const source = converted.get(document);
    return source ? { ...document.record, body: source.body, sourceHash: source.sourceHash } : document.record;
  }));
  const skipByIdentity = new Map<string, LegacyAgentSkillSkipCode>();
  for (const skip of [...adapter.skipped, ...originalAdapter.skipped]) {
    for (const matched of ordered.filter(item => item.record.name === skip.skillName)) {
      skipByIdentity.set(matched.documentIdentityDigest, skip.code);
    }
  }
  const publishedByIdentity = new Map(
    adapter.published.map((item) => [item.documentIdentityDigest, item]),
  );
  const headerByIdentity = new Map(
    adapter.snapshot.headers.map((header) => [`${header.manifest.skillId}@${header.manifest.version}`, header]),
  );

  const entries: SkillPackageMigrationEntryV1[] = [];
  const packages: SkillPackageMigrationResultV1['packages'][number][] = [];

  for (const document of ordered) {
    const identity = document.documentIdentityDigest;
    const skipCode = skipByIdentity.get(identity);
    const published = publishedByIdentity.get(identity);
    // 正文形态与「能不能进 Catalog」是两件事：被 skip 的包也要如实标注正文形态，
    // 否则报告只能说「47 个跳过」，说不出「47 个里有多少是规范 program」。
    const source = prepared.get(document);
    const conversion = converted.get(document);
    const program = assessAgentSkillProgramCompatibility(source?.status === 'ready' ? source.body : document.record.body).form;

    if (skipCode) {
      entries.push(entry(document, {
        status: 'invalid', reasonCode: skipCode, program,
      }));
      continue;
    }
    if (source?.status === 'invalid') {
      entries.push(entry(document, { status: 'invalid', reasonCode: source.reasonCode, program }));
      continue;
    }
    if (source?.status === 'ready' && !conversion && source.sourceBinding.form !== 'canonical-body') {
      const compatibility = assessAgentSkillProgramCompatibility(source.body, originalKinds.get(identity));
      entries.push(entry(document, { status: 'invalid', program,
        reasonCode: compatibility.reasonCode === 'legacy-uncompiled' ? 'program-invalid' : compatibility.reasonCode }));
      continue;
    }
    if (!published) {
      entries.push(entry(document, {
        status: 'invalid', reasonCode: 'unclassified', program: 'unknown',
      }));
      continue;
    }

    const header = headerByIdentity.get(`${published.skillId}@${published.version}`);
    if (!header) {
      entries.push(entry(document, {
        status: 'invalid', reasonCode: 'package-build-failed', program,
        skillId: published.skillId, version: published.version,
      }));
      continue;
    }

    try {
      const body = conversion ? conversion.body : document.record.body;
      const compatibility = assessAgentSkillProgramCompatibility(body, header.manifest.kind);
      const bundle = createAgentSkillBundle(header.manifest, body);
      const skillPackage = normalizeAgentSkillPackageV2({
        packageVersion: 'agent-skill-package-v2',
        bundle,
        resources: conversion ? conversion.resources : document.resources,
        // 迁移来的包由文件系统来源方拥有；不是作者自证，也不是「learned」。
        ownerRef: 'owner.host.filesystem.v1',
        environment: {
          modelPolicy: {
            mode: 'any',
            allowedModelIds: [],
            minContextTokens: 0,
            maxOutputTokens: Math.max(1, header.manifest.limits.maxOutputTokens),
          },
          sandboxProfileRef: 'sandbox.legacy.whole-body.v1',
          contextPolicyRef: 'context.legacy.whole-body.v1',
        },
        acceptance: {
          inputSchemaRef: header.manifest.inputSchemaDigest,
          outputSchemaRef: header.manifest.outputSchemaDigest,
          checks: [],
        },
        // 迁移只生产 draft：发布必须另走 Shadow → Canary → 显式 Active。
        release: { state: 'draft' },
        effect: { sampleCount: 0, passCount: 0 },
      });
      packages.push(Object.freeze({ directory: document.directory, package: skillPackage,
        ...(conversion ? { sourceBinding: conversion.sourceBinding } : {}) }));
      entries.push(entry(document, {
        status: compatibility.status === 'compatible' ? 'compiled' : 'invalid',
        reasonCode: compatibility.reasonCode,
        program,
        skillId: published.skillId,
        version: published.version,
        packageDigest: skillPackage.packageDigest,
        resourceCount: skillPackage.resources.length,
        attachmentBytes: skillPackage.resources.filter(item => item.role !== 'body').reduce((sum, item) => sum + item.bytes, 0),
      }));
    } catch (error) {
      entries.push(entry(document, {
        status: 'invalid', reasonCode: 'package-build-failed', program,
        skillId: published.skillId, version: published.version,
        detail: error instanceof Error ? error.message.slice(0, 200) : null,
      }));
    }
  }

  const duplicateSkillIds = [...new Set(
    adapter.skipped
      .filter((item) => item.code === 'duplicate-identity')
      .map((item) => item.skillName),
  )].sort(compareText);

  const missingDocuments = [...(options.missingDirectories ?? [])]
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort(compareText);

  const totals = {
    documents: entries.length + missingDocuments.length,
    compiled: entries.filter((item) => item.status === 'compiled').length,
    legacyUncompiled: entries.filter((item) => item.reasonCode === 'legacy-uncompiled').length,
    skipped: entries.filter((item) => item.reasonCode !== null
      && item.reasonCode !== 'legacy-uncompiled'
      && item.reasonCode !== 'package-build-failed').length,
    packageBuildFailed: entries.filter((item) => item.reasonCode === 'package-build-failed').length,
  };

  return Object.freeze({
    report: Object.freeze({
      reportVersion: SKILL_PACKAGE_MIGRATION_REPORT_VERSION,
      totals: Object.freeze(totals),
      entries: Object.freeze(entries),
      duplicateSkillIds: Object.freeze(duplicateSkillIds),
      missingDocuments: Object.freeze(missingDocuments),
    }),
    packages: Object.freeze(packages),
  });
}

function entry(
  document: MigratableSkillDocument,
  overrides: Readonly<{
    status: 'compiled' | 'invalid';
    reasonCode: SkillPackageMigrationReasonCode | null;
    program: 'canonical' | 'legacy-body' | 'unknown';
    skillId?: string | null;
    version?: string | null;
    packageDigest?: string | null;
    detail?: string | null;
    resourceCount?: number;
    attachmentBytes?: number;
  }>,
): SkillPackageMigrationEntryV1 {
  return Object.freeze({
    directory: document.directory,
    name: document.record.name,
    skillId: overrides.skillId ?? null,
    version: overrides.version ?? null,
    documentIdentityDigest: document.documentIdentityDigest,
    status: overrides.status,
    reasonCode: overrides.reasonCode,
    program: overrides.program,
    resourceCount: overrides.resourceCount ?? document.resources.length,
    attachmentBytes: overrides.attachmentBytes ?? document.attachmentBytes,
    packageDigest: overrides.packageDigest ?? null,
    detail: overrides.detail ?? null,
  });
}
