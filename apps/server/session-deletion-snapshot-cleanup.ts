import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import { verifySnapshotDirectory } from './snapshot-coordinator.ts';
import { resolveSessionDatabase } from './security.ts';

const SNAPSHOT_ROOT = '.snapshots-v1';
const SNAPSHOT_NAME_RE = /^snapshot-([a-f0-9]{24})$/u;
const RESTORE_ID_RE = /^[a-f0-9]{24}$/u;

export type SessionDeletionSnapshotCleanupErrorCode =
  | 'session-privacy-cleanup-input-invalid'
  | 'session-privacy-cleanup-unsafe-layout'
  | 'session-privacy-cleanup-snapshot-invalid'
  | 'session-privacy-cleanup-pre-restore-invalid'
  | 'session-privacy-cleanup-io';

export class SessionDeletionSnapshotCleanupError extends Error {
  readonly name = 'SessionDeletionSnapshotCleanupError';
  constructor(readonly code: SessionDeletionSnapshotCleanupErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface SessionDeletionSnapshotCleanupResult {
  readonly sessionId: string;
  readonly removedSnapshotIds: readonly string[];
  readonly removedPreRestoreIds: readonly string[];
  readonly scannedSnapshots: number;
  readonly scannedPreRestoreDirectories: number;
}

export interface SessionDeletionSnapshotCleanupInput {
  readonly dataDir: string;
  readonly sessionId: string;
  /** @internal Deterministic test seam for proving the apply phase rejects TOCTOU changes. */
  readonly injectBeforeApply?: () => void;
}

interface PathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
}

interface PlannedSnapshot {
  readonly path: string;
  readonly snapshotId: string;
  readonly identity: PathIdentity;
}

interface PlannedTreeEntry {
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
  readonly identity: PathIdentity;
}

interface PlannedPreRestoreDirectory {
  readonly path: string;
  readonly restoreId: string;
  readonly identity: PathIdentity;
  readonly entries: readonly PlannedTreeEntry[];
}

function fail(
  code: SessionDeletionSnapshotCleanupErrorCode,
  cause?: unknown,
): SessionDeletionSnapshotCleanupError {
  return new SessionDeletionSnapshotCleanupError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function pathIdentity(stats: Stats): PathIdentity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino, mode: stats.mode });
}

function sameIdentity(stats: Stats, identity: PathIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino && stats.mode === identity.mode;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw fail('session-privacy-cleanup-unsafe-layout');
  }
}

function assertPlainDirectory(path: string, code: SessionDeletionSnapshotCleanupErrorCode): Stats {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw fail(code);
  return stats;
}

function assertNoSymlinkAncestors(pathValue: string): void {
  const path = resolve(pathValue);
  const root = parse(path).root;
  let current = root;
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw fail('session-privacy-cleanup-unsafe-layout');
  }
  const rel = relative(root, path);
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw fail('session-privacy-cleanup-unsafe-layout');
    }
  }
}

function planPublishedSnapshots(
  dataDir: string,
  sessionFile: string,
): { readonly plans: PlannedSnapshot[]; readonly scanned: number } {
  const root = join(dataDir, SNAPSHOT_ROOT);
  if (!existsSync(root)) return { plans: [], scanned: 0 };
  assertPlainDirectory(root, 'session-privacy-cleanup-unsafe-layout');
  const plans: PlannedSnapshot[] = [];
  let scanned = 0;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith('snapshot-')) continue;
    const match = SNAPSHOT_NAME_RE.exec(entry.name);
    if (!match) throw fail('session-privacy-cleanup-snapshot-invalid');
    const path = join(root, entry.name);
    assertContained(root, path);
    const stats = lstatOrNull(path);
    if (!stats) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw fail('session-privacy-cleanup-snapshot-invalid');
    }
    let manifest: ReturnType<typeof verifySnapshotDirectory>;
    try {
      manifest = verifySnapshotDirectory(path);
    } catch (error) {
      throw fail('session-privacy-cleanup-snapshot-invalid', error);
    }
    scanned += 1;
    const binding = manifest.components.find((component) => component.sourceRelativePath === sessionFile);
    if (!binding) continue;
    if (binding.role !== 'session-db' || binding.captureMode !== 'sqlite-online') {
      throw fail('session-privacy-cleanup-snapshot-invalid');
    }
    plans.push({
      path,
      snapshotId: match[1]!,
      identity: pathIdentity(stats),
    });
  }
  return { plans, scanned };
}

function inspectPlainTree(
  root: string,
  code: SessionDeletionSnapshotCleanupErrorCode,
): PlannedTreeEntry[] {
  const entries: PlannedTreeEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      assertContained(root, path);
      const stats = lstatOrNull(path);
      if (!stats || stats.isSymbolicLink()) throw fail(code);
      const relativePath = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (stats.isDirectory()) {
        entries.push({ relativePath, kind: 'directory', identity: pathIdentity(stats) });
        visit(path, relativePath);
        continue;
      }
      if (!stats.isFile()) throw fail(code);
      entries.push({ relativePath, kind: 'file', identity: pathIdentity(stats) });
    }
  };
  visit(root, '');
  return entries;
}

function sameTreeEntry(left: PlannedTreeEntry, right: PlannedTreeEntry): boolean {
  return left.relativePath === right.relativePath
    && left.kind === right.kind
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.mode === right.identity.mode;
}

function assertPreRestorePlanCurrent(plan: PlannedPreRestoreDirectory): void {
  const rootStats = lstatOrNull(plan.path);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()
    || !sameIdentity(rootStats, plan.identity)) {
    throw fail('session-privacy-cleanup-pre-restore-invalid');
  }
  const currentEntries = inspectPlainTree(
    plan.path,
    'session-privacy-cleanup-pre-restore-invalid',
  );
  const finalRootStats = lstatOrNull(plan.path);
  if (!finalRootStats || !finalRootStats.isDirectory() || finalRootStats.isSymbolicLink()
    || !sameIdentity(finalRootStats, plan.identity)
    || currentEntries.length !== plan.entries.length
    || currentEntries.some((entry, index) => !sameTreeEntry(entry, plan.entries[index]!))) {
    throw fail('session-privacy-cleanup-pre-restore-invalid');
  }
}

function planPreRestoreDirectories(
  dataDir: string,
  sessionFile: string,
): { readonly plans: PlannedPreRestoreDirectory[]; readonly scanned: number } {
  const parent = dirname(dataDir);
  const dataName = basename(dataDir);
  const prefix = '.' + dataName + '.pre-restore-';
  const plans: PlannedPreRestoreDirectory[] = [];
  let scanned = 0;
  for (const entry of readdirSync(parent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith(prefix)) continue;
    const restoreId = entry.name.slice(prefix.length);
    if (!RESTORE_ID_RE.test(restoreId)) throw fail('session-privacy-cleanup-pre-restore-invalid');
    const preRestoreDir = join(parent, entry.name);
    assertContained(parent, preRestoreDir);
    const directoryStats = lstatOrNull(preRestoreDir);
    if (!directoryStats) continue;
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw fail('session-privacy-cleanup-pre-restore-invalid');
    }
    scanned += 1;
    const sessionPath = join(preRestoreDir, sessionFile);
    assertContained(preRestoreDir, sessionPath);
    const sessionStats = lstatOrNull(sessionPath);
    if (!sessionStats) continue;
    if (!sessionStats.isFile() || sessionStats.isSymbolicLink()) {
      throw fail('session-privacy-cleanup-pre-restore-invalid');
    }
    const entries = inspectPlainTree(
      preRestoreDir,
      'session-privacy-cleanup-pre-restore-invalid',
    );
    const sessionEntry = entries.find((item) => item.relativePath === sessionFile);
    if (!sessionEntry || sessionEntry.kind !== 'file'
      || !sameIdentity(sessionStats, sessionEntry.identity)) {
      throw fail('session-privacy-cleanup-pre-restore-invalid');
    }
    plans.push({
      path: preRestoreDir,
      restoreId,
      identity: pathIdentity(directoryStats),
      entries: Object.freeze(entries),
    });
  }
  return { plans, scanned };
}

/**
 * Removes whole signed snapshot envelopes that contain the deleted session.
 *
 * Rewriting one component would invalidate the manifest hashes and plugin envelope,
 * so a proven matching published snapshot is deleted as a unit. A pre-restore tree
 * is the complete old dataDir; once its top-level target session DB proves the
 * binding, the complete verified tree must be deleted to cover derived sidecars.
 * Planning validates every candidate before the first destructive operation.
 */
export function cleanupDeletedSessionSnapshotArtifacts(
  input: SessionDeletionSnapshotCleanupInput,
): SessionDeletionSnapshotCleanupResult {
  if (!input || typeof input.dataDir !== 'string' || input.dataDir.trim() === ''
    || !isSafeOpaqueId(input.sessionId, 160)) {
    throw fail('session-privacy-cleanup-input-invalid');
  }
  const dataDir = resolve(input.dataDir);
  if (dataDir === parse(dataDir).root || !basename(dataDir)) {
    throw fail('session-privacy-cleanup-input-invalid');
  }
  try {
    assertNoSymlinkAncestors(dataDir);
    const sessionFile = input.sessionId + '.db';
    if (!resolveSessionDatabase(dataDir, sessionFile)) {
      throw fail('session-privacy-cleanup-input-invalid');
    }
    const snapshots = planPublishedSnapshots(dataDir, sessionFile);
    const preRestore = planPreRestoreDirectories(dataDir, sessionFile);

    input.injectBeforeApply?.();

    // Revalidate the complete plan after the deterministic race seam and before
    // the first destructive operation. Each item is checked again immediately
    // before removal below, so changed identities never authorize deletion.
    for (const plan of snapshots.plans) {
      const current = lstatOrNull(plan.path);
      if (!current || !current.isDirectory() || current.isSymbolicLink()
        || !sameIdentity(current, plan.identity)) {
        throw fail('session-privacy-cleanup-snapshot-invalid');
      }
    }
    for (const plan of preRestore.plans) assertPreRestorePlanCurrent(plan);

    const removedSnapshotIds: string[] = [];
    for (const plan of snapshots.plans) {
      const current = lstatOrNull(plan.path);
      if (!current) continue;
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, plan.identity)) {
        throw fail('session-privacy-cleanup-snapshot-invalid');
      }
      rmSync(plan.path, { recursive: true, force: false });
      removedSnapshotIds.push(plan.snapshotId);
    }

    const removedPreRestoreIds: string[] = [];
    for (const plan of preRestore.plans) {
      assertPreRestorePlanCurrent(plan);
      rmSync(plan.path, { recursive: true, force: false });
      if (existsSync(plan.path)) throw fail('session-privacy-cleanup-pre-restore-invalid');
      removedPreRestoreIds.push(plan.restoreId);
    }

    return Object.freeze({
      sessionId: input.sessionId,
      removedSnapshotIds: Object.freeze(removedSnapshotIds),
      removedPreRestoreIds: Object.freeze(removedPreRestoreIds),
      scannedSnapshots: snapshots.scanned,
      scannedPreRestoreDirectories: preRestore.scanned,
    });
  } catch (error) {
    if (error instanceof SessionDeletionSnapshotCleanupError) throw error;
    throw fail('session-privacy-cleanup-io', error);
  }
}
