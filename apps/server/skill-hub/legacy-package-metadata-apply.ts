/** P17-04.1: the existing metadata-only apply, with byte-preserving planning
 * and batch rollback. This does not compile Markdown or publish a package. */
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { skillDocumentIdentityDigest } from '../../../packages/core/public/skills.ts';
import { readLegacySkillPackages } from './legacy-package-migrator.ts';
import { proposeSkillMetadata, type SkillMetadataProposalV1 } from './legacy-package-metadata-proposal.ts';

export const SKILL_PACKAGE_APPLY_KEYS = Object.freeze([
  'kind', 'capabilityIds', 'taskKinds', 'phases', 'contentModes',
  'scopeLevel', 'risk', 'evaluatorId', 'lifecycle',
] as const);
export interface SkillPackageApplyOptions {
  readonly skillsDir: string;
  readonly apply?: boolean;
  readonly backupRoot?: string;
}
export interface SkillPackageApplyReport {
  readonly mode: 'applied' | 'dry-run';
  readonly directories: number;
  readonly documents: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly missingDocuments: readonly string[];
  readonly entries: readonly Readonly<{ directory: string; status: 'changed' | 'unchanged' | 'missing-document'; added: readonly string[] }>[];
  readonly backupDir: string | null;
}
export class SkillPackageApplyError extends Error {
  constructor(readonly code: string, detail: string, readonly backupDir: string | null = null, cause?: unknown) {
    super(`${code}: ${detail}${backupDir ? `; backup: ${backupDir}` : ''}`, { cause });
    this.name = 'SkillPackageApplyError';
  }
}
function reject(code: string, detail: string): never { throw new SkillPackageApplyError(code, detail); }

/** Accept only the existing flat key/CSV format. Preserve every existing byte,
 * including comments, blank lines, mixed body EOLs and an absent final newline. */
export function appendSkillPackageMetadata(raw: string, values: Readonly<Record<string, string>>): Readonly<{
  text: string; added: readonly string[];
}> {
  const opening = /^---(\r?\n)/u.exec(raw);
  if (!opening) reject('skill-package-frontmatter-invalid', 'missing leading delimiter');
  const closing = /^---(?:\r?\n|$)/gmu;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(raw);
  if (!end) reject('skill-package-frontmatter-invalid', 'missing closing delimiter');
  const present = new Set<string>();
  for (const line of raw.slice(opening[0].length, end.index).split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = /^([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (!pair || present.has(pair[1]!)) reject('skill-package-frontmatter-invalid', 'non-flat or duplicate key');
    present.add(pair[1]!);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!(SKILL_PACKAGE_APPLY_KEYS as readonly string[]).includes(key)
      || typeof value !== 'string' || !value.length || /[\r\n\0]/u.test(value))
      reject('skill-package-metadata-invalid', key);
  }
  const added = SKILL_PACKAGE_APPLY_KEYS.filter(key => Object.hasOwn(values, key) && !present.has(key));
  const insertion = added.map(key => `${key}: ${values[key]}${opening[1]}`).join('');
  return Object.freeze({ text: `${raw.slice(0, end.index)}${insertion}${raw.slice(end.index)}`, added: Object.freeze(added) });
}

export function parseSkillPackageApplyArgs(argv: readonly string[]): SkillPackageApplyOptions {
  let apply = false, skillsDir = 'data/skills', backupRoot: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!['--apply', '--dry-run', '--dir', '--backup-root'].includes(flag) || seen.has(flag))
      reject('skill-package-arguments-invalid', flag);
    seen.add(flag);
    if (flag === '--apply' || flag === '--dry-run') { apply = flag === '--apply'; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) reject('skill-package-arguments-invalid', `missing value for ${flag}`);
    if (flag === '--dir') skillsDir = value; else backupRoot = value;
  }
  if (seen.has('--apply') && seen.has('--dry-run')) reject('skill-package-arguments-invalid', 'conflicting modes');
  return Object.freeze({ skillsDir: resolve(skillsDir), apply,
    ...(backupRoot === undefined ? {} : { backupRoot: resolve(backupRoot) }) });
}

function metadata(proposal: SkillMetadataProposalV1): Record<string, string> {
  return {
    kind: proposal.kind, capabilityIds: proposal.capabilityIds.join(','), taskKinds: proposal.taskKinds.join(','),
    phases: proposal.phases.join(','), contentModes: proposal.contentModes.join(','), scopeLevel: proposal.scopeLevel,
    risk: proposal.risk, evaluatorId: proposal.evaluatorId,
    // Preserve the explicitly approved metadata-apply behavior from 2026-10-19.
    // Existing lifecycle (including disabled/draft) always wins; no release API runs.
    lifecycle: 'active',
  };
}
function regularDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject('skill-package-path-invalid', path);
}
function readDocument(path: string): Buffer {
  regularDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) reject('skill-package-path-invalid', path);
  const bytes = readFileSync(path);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) reject('skill-package-encoding-invalid', path);
  return bytes;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
interface Change { path: string; directory: string; original: Buffer; next: Buffer; mode: number }

/** Preflight the whole inventory, back up every changed original, stage beside
 * each target, then replace. Recoverable I/O errors roll back changed bytes;
 * rollback conflicts are explicit failures and keep the originals in backup. */
export function applySkillPackageMetadata(options: SkillPackageApplyOptions): SkillPackageApplyReport {
  const root = resolve(options.skillsDir), backupRoot = resolve(options.backupRoot ?? '.workbuddy/tmp');
  regularDirectory(root);
  if (inside(root, backupRoot)) reject('skill-package-backup-invalid', 'backup root must be outside skills directory');
  // Reject link traversal before the legacy scanner reads any document/resources.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) reject('skill-package-path-invalid', entry.name);
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, 'SKILL.md');
    if (existsSync(path)) readDocument(path);
  }
  const scanned = readLegacySkillPackages(root);
  const proposals = new Map(proposeSkillMetadata(scanned.documents.filter(item => !item.record.capabilityIds?.length))
    .proposals.map(proposal => [proposal.directory, proposal]));
  const changes: Change[] = [];
  const entries: Array<SkillPackageApplyReport['entries'][number]> = [];
  for (const document of scanned.documents) {
    const path = join(root, document.directory, 'SKILL.md'), original = readDocument(path), raw = original.toString('utf8');
    if (skillDocumentIdentityDigest(raw) !== document.documentIdentityDigest) reject('skill-package-source-changed', document.directory);
    const proposal = proposals.get(document.directory);
    const planned = appendSkillPackageMetadata(raw, proposal ? metadata(proposal) : {});
    const changed = planned.added.length > 0;
    entries.push(Object.freeze({ directory: document.directory, status: changed ? 'changed' : 'unchanged', added: planned.added }));
    if (changed) changes.push({ path, directory: document.directory, original, next: Buffer.from(planned.text, 'utf8'),
      mode: lstatSync(path).mode & 0o777 });
  }
  for (const directory of scanned.missingDirectories) entries.push(Object.freeze({ directory, status: 'missing-document', added: Object.freeze([]) }));
  entries.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);
  let backupDir: string | null = null;
  const temps = new Set<string>();
  const stage = (change: Change, bytes: Buffer): string => {
    const path = join(dirname(change.path), `.SKILL.md.${randomUUID()}.tmp`);
    temps.add(path); writeFileSync(path, bytes, { flag: 'wx', mode: change.mode }); return path;
  };
  const assertOriginal = (change: Change) => {
    if (!readDocument(change.path).equals(change.original)) reject('skill-package-source-changed', change.directory);
  };
  if (options.apply === true && changes.length) {
    let replacementsStarted = false;
    let failure: SkillPackageApplyError | undefined;
    try {
      for (const change of changes) assertOriginal(change);
      mkdirSync(backupRoot, { recursive: true }); regularDirectory(backupRoot);
      backupDir = mkdtempSync(join(backupRoot, 'skills-backup-'));
      for (const change of changes) {
        assertOriginal(change);
        const backup = join(backupDir, `${change.directory}.SKILL.md`);
        copyFileSync(change.path, backup, constants.COPYFILE_EXCL);
        if (!readFileSync(backup).equals(change.original)) reject('skill-package-source-changed', change.directory);
      }
      const staged = changes.map(change => ({ change, path: stage(change, change.next) }));
      for (const change of changes) assertOriginal(change);
      replacementsStarted = true;
      for (const { change, path } of staged) {
        assertOriginal(change); renameSync(path, change.path); temps.delete(path);
      }
    } catch (cause) {
      const failures: unknown[] = [];
      if (replacementsStarted) for (const change of [...changes].reverse()) {
        try {
          const current = readDocument(change.path);
          if (current.equals(change.original)) continue;
          if (!current.equals(change.next)) reject('skill-package-rollback-conflict', change.directory);
          const restore = stage(change, change.original);
          renameSync(restore, change.path); temps.delete(restore);
        } catch (error) { failures.push(error); }
      }
      failure = new SkillPackageApplyError(failures.length ? 'skill-package-rollback-failed' : 'skill-package-apply-failed',
        failures.length ? 'rollback incomplete; inspect preserved backup' : 'batch aborted; owned replacements restored',
        backupDir, failures.length ? new AggregateError([cause, ...failures]) : cause);
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const path of temps) {
        try { if (existsSync(path)) unlinkSync(path); }
        catch (error) { cleanupFailures.push(error); }
      }
      if (cleanupFailures.length) failure = new SkillPackageApplyError('skill-package-cleanup-failed',
        'temporary file cleanup incomplete; inspect preserved backup', backupDir,
        new AggregateError([...(failure ? [failure] : []), ...cleanupFailures]));
    }
    if (failure) throw failure;
  }
  return Object.freeze({ mode: options.apply === true ? 'applied' : 'dry-run', directories: entries.length,
    documents: scanned.documents.length, changed: changes.length, unchanged: scanned.documents.length - changes.length,
    missingDocuments: scanned.missingDirectories, entries: Object.freeze(entries), backupDir });
}
