import { spawnSync } from 'node:child_process';
import { COPYFILE_EXCL } from 'node:constants';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetIdentityRegistry } from '../../packages/core/src/asset-identity.ts';
import { buildDefaultSnapshotInventory } from './snapshot-inventory.ts';
import {
  SnapshotCoordinatorError,
  verifySnapshotDirectory,
  type SnapshotComponentPlan,
} from './snapshot-coordinator.ts';
import {
  SNAPSHOT_MANIFEST_FILE,
  canonicalSnapshotRelativePath,
  type JiuguanSnapshotManifest,
  type SnapshotComponentManifest,
} from './snapshot-manifest.ts';
import {
  mergeActiveProviderCredentials,
  providerRedactedDigest,
} from './snapshot-provider-config.ts';
import { verifySnapshotSqliteFile } from './snapshot-sqlite.ts';
import { ServerProcessLock } from './process-lock.ts';
import {
  SNAPSHOT_RESTORE_PENDING_FILE,
  snapshotPreRestorePath,
  snapshotRestoreWorkspacePath,
} from './snapshot-restore-layout.ts';

const OWNER_FILE = 'owner.json';
const INTENT_FILE = 'intent.json';
const STAGE_DIR = 'stage';
const PRE_DIR = 'pre-restore';
const FAILED_DIR = 'failed-restored';
const SNAPSHOT_ID_RE = /^[a-f0-9]{24}$/;

export type SnapshotRestorePhase =
  | 'staging'
  | 'staged'
  | 'prepared'
  | 'switching'
  | 'active-moved'
  | 'stage-activated'
  | 'preserving-pre'
  | 'pre-preserved';

export type SnapshotRestoreCrashStage =
  | 'after-stage'
  | 'after-dry-run'
  | 'after-active-moved'
  | 'after-stage-activated'
  | 'after-pre-preserved';

interface RestoreOwner {
  readonly version: 1;
  readonly pid: number;
  readonly restoreId: string;
  readonly createdAt: string;
}

interface RestoreIntent {
  readonly version: 1;
  readonly restoreId: string;
  readonly snapshotId: string;
  readonly phase: SnapshotRestorePhase;
  readonly createdAt: string;
  readonly preRestoreName: string;
}

export interface SnapshotRestorePendingMarker {
  readonly version: 1;
  readonly restoreId: string;
  readonly snapshotId: string;
  readonly restoredAt: string;
  readonly preRestoreName: string;
  readonly authRotationRequired: true;
}

export class SnapshotRestoreError extends Error {
  readonly name = 'SnapshotRestoreError';
  constructor(
    readonly code: 'restore-conflict' | 'restore-invalid' | 'restore-dry-run' | 'restore-recovery-required',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class SnapshotRestoreCrashSimulationError extends Error {
  readonly name = 'SnapshotRestoreCrashSimulationError';
}

export interface SnapshotRestoreDryRunAdapter {
  validate(input: { dataDir: string; snapshotId: string }): void;
}

export interface SnapshotRestoreResult {
  readonly restoreId: string;
  readonly snapshotId: string;
  readonly dataDir: string;
  readonly preRestoreDir: string;
  readonly marker: SnapshotRestorePendingMarker;
}

function canonicalIso(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new SnapshotRestoreError('restore-invalid', 'restore 时间必须是 canonical ISO');
  }
  return value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join(',') === [...keys].sort().join(','));
}

function parseOwner(raw: string): RestoreOwner {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SnapshotRestoreError('restore-invalid', 'restore owner 非法'); }
  if (!exactObject(value, ['version', 'pid', 'restoreId', 'createdAt'])
    || value.version !== 1 || !Number.isInteger(value.pid) || Number(value.pid) < 1
    || typeof value.restoreId !== 'string' || !SNAPSHOT_ID_RE.test(value.restoreId)
    || typeof value.createdAt !== 'string') {
    throw new SnapshotRestoreError('restore-invalid', 'restore owner 字段非法');
  }
  return { version: 1, pid: Number(value.pid), restoreId: value.restoreId, createdAt: canonicalIso(value.createdAt) };
}

function parseIntent(raw: string): RestoreIntent {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SnapshotRestoreError('restore-invalid', 'restore intent 非法'); }
  if (!exactObject(value, ['version', 'restoreId', 'snapshotId', 'phase', 'createdAt', 'preRestoreName'])
    || value.version !== 1
    || typeof value.restoreId !== 'string' || !SNAPSHOT_ID_RE.test(value.restoreId)
    || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(value.snapshotId)
    || typeof value.phase !== 'string'
    || !(['staging', 'staged', 'prepared', 'switching', 'active-moved', 'stage-activated', 'preserving-pre', 'pre-preserved'] as string[]).includes(value.phase)
    || typeof value.createdAt !== 'string' || typeof value.preRestoreName !== 'string'
    || value.preRestoreName !== '.pre-restore-' + value.restoreId) {
    throw new SnapshotRestoreError('restore-invalid', 'restore intent 字段非法');
  }
  return {
    version: 1,
    restoreId: value.restoreId,
    snapshotId: value.snapshotId,
    phase: value.phase as SnapshotRestorePhase,
    createdAt: canonicalIso(value.createdAt),
    preRestoreName: value.preRestoreName,
  };
}

export function parseSnapshotRestorePendingMarker(raw: string): SnapshotRestorePendingMarker {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SnapshotRestoreError('restore-invalid', 'restore marker 非法'); }
  if (!exactObject(value, ['version', 'restoreId', 'snapshotId', 'restoredAt', 'preRestoreName', 'authRotationRequired'])
    || value.version !== 1 || value.authRotationRequired !== true
    || typeof value.restoreId !== 'string' || !SNAPSHOT_ID_RE.test(value.restoreId)
    || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(value.snapshotId)
    || typeof value.restoredAt !== 'string' || typeof value.preRestoreName !== 'string'
    || value.preRestoreName !== '.pre-restore-' + value.restoreId) {
    throw new SnapshotRestoreError('restore-invalid', 'restore marker 字段非法');
  }
  return Object.freeze({
    version: 1,
    restoreId: value.restoreId,
    snapshotId: value.snapshotId,
    restoredAt: canonicalIso(value.restoredAt),
    preRestoreName: value.preRestoreName,
    authRotationRequired: true,
  });
}

export function readSnapshotRestorePendingMarker(dataDir: string): SnapshotRestorePendingMarker | null {
  const path = join(resolve(dataDir), SNAPSHOT_RESTORE_PENDING_FILE);
  if (!existsSync(path)) return null;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SnapshotRestoreError('restore-invalid', 'restore marker 必须是普通文件');
  }
  return parseSnapshotRestorePendingMarker(readFileSync(path, 'utf8'));
}

function writeDurable(path: string, content: string, exclusive: boolean): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, exclusive ? 'wx' : 'w', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows/部分文件系统不支持目录句柄 fsync；文件本身已 fsync，rename 仍由同卷语义保护。
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function replaceDurable(path: string, content: string): void {
  const temp = path + '.tmp-' + randomBytes(8).toString('hex');
  try {
    writeDurable(temp, content, true);
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function contained(root: string, relativePath: string): string {
  const canonical = canonicalSnapshotRelativePath(relativePath, 'sourceRelativePath');
  const target = resolve(root, ...canonical.split('/'));
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) {
    throw new SnapshotRestoreError('restore-invalid', 'restore 目标路径越界');
  }
  return target;
}

function hashFile(path: string): { sizeBytes: number; sha256: string } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let sizeBytes = 0;
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      sizeBytes += bytes;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function assertComponentFile(path: string, component: SnapshotComponentManifest): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new SnapshotRestoreError('restore-invalid', 'restore component 必须是独立普通文件');
  }
  let actual: { sizeBytes: number; sha256: string };
  try {
    actual = component.captureMode === 'redacted-json'
      ? providerRedactedDigest(readFileSync(path, 'utf8'))
      : hashFile(path);
  } catch (cause) {
    throw new SnapshotRestoreError('restore-invalid', 'restore Provider 配置去密钥校验失败', { cause });
  }
  if (actual.sizeBytes !== component.sizeBytes || actual.sha256 !== component.sha256) {
    throw new SnapshotRestoreError('restore-invalid', 'restore component hash/长度不匹配');
  }
}

function samePlans(actual: readonly SnapshotComponentPlan[], manifest: JiuguanSnapshotManifest): boolean {
  const normalize = (row: SnapshotComponentPlan | SnapshotComponentManifest): string => JSON.stringify({
    id: row.id,
    role: row.role,
    sourceRelativePath: row.sourceRelativePath,
    captureMode: row.captureMode,
    schemaVersion: row.schemaVersion ?? null,
  });
  const expected = manifest.components.filter((row) => row.role !== 'auth-db').map(normalize).sort();
  return actual.filter((row) => row.role !== 'auth-db').map(normalize).sort().join('\n') === expected.join('\n');
}

function samePlugins(
  actual: readonly { id: string; version: string; enabled: boolean; componentIds: readonly string[] }[],
  manifest: JiuguanSnapshotManifest,
): boolean {
  const normalize = (row: { id: string; version: string; enabled: boolean; componentIds: readonly string[] }): string =>
    JSON.stringify({ id: row.id, version: row.version, enabled: row.enabled, componentIds: [...row.componentIds].sort() });
  return actual.map(normalize).sort().join('\n') === manifest.plugins.map(normalize).sort().join('\n');
}

export function validateRestoredDataDir(dataDir: string, snapshotId: string): JiuguanSnapshotManifest {
  const root = resolve(dataDir);
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new SnapshotRestoreError('restore-invalid', 'restore staging 必须是普通目录');
  }
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new SnapshotRestoreError('restore-invalid', 'snapshotId 非法');
  const snapshotDir = join(root, '.snapshots-v1', 'snapshot-' + snapshotId);
  const manifest = verifySnapshotDirectory(snapshotDir);
  for (const component of manifest.components) {
    const target = contained(root, component.sourceRelativePath);
    assertComponentFile(target, component);
    if (component.captureMode === 'sqlite-online') {
      verifySnapshotSqliteFile({
        id: component.id,
        role: component.role,
        sourceRelativePath: component.sourceRelativePath,
        captureMode: component.captureMode,
        schemaVersion: component.schemaVersion,
      }, target);
    }
  }
  const inventory = buildDefaultSnapshotInventory(root);
  if (!samePlans(inventory.components, manifest) || !samePlugins(inventory.plugins, manifest)) {
    throw new SnapshotRestoreError('restore-invalid', 'restore staging inventory/plugin 引用与 manifest 不一致');
  }
  const identityPath = join(root, 'asset-identities.v1.json');
  if (existsSync(identityPath)) {
    const identities = new AssetIdentityRegistry(identityPath);
    for (const identity of identities.list()) {
      const directory = identity.kind === 'card' ? 'cards' : identity.kind === 'preset' ? 'presets' : 'worldbooks';
      const target = contained(root, directory + '/' + identity.storageKey);
      const stats = lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new SnapshotRestoreError('restore-invalid', 'asset identity 引用了缺失或非法文件');
      }
    }
  }
  return manifest;
}

function copyPublishedSnapshot(source: string, destination: string, manifest: JiuguanSnapshotManifest): void {
  mkdirSync(join(destination, 'components'), { recursive: true, mode: 0o700 });
  for (const component of manifest.components) {
    const sourcePath = contained(source, component.storedRelativePath);
    const target = contained(destination, component.storedRelativePath);
    copyFileSync(sourcePath, target, COPYFILE_EXCL);
  }
  copyFileSync(join(source, SNAPSHOT_MANIFEST_FILE), join(destination, SNAPSHOT_MANIFEST_FILE), COPYFILE_EXCL);
  verifySnapshotDirectory(destination);
}

function stageSnapshot(
  dataDir: string,
  stageDir: string,
  snapshotDir: string,
  manifest: JiuguanSnapshotManifest,
  marker: SnapshotRestorePendingMarker,
): void {
  mkdirSync(stageDir, { mode: 0o700 });
  for (const component of manifest.components) {
    const source = contained(snapshotDir, component.storedRelativePath);
    const target = contained(stageDir, component.sourceRelativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target, COPYFILE_EXCL);
    assertComponentFile(target, component);
    if (component.captureMode === 'redacted-json') {
      let merged: string;
      try {
        const active = contained(dataDir, component.sourceRelativePath);
        merged = mergeActiveProviderCredentials(
          readFileSync(target, 'utf8'),
          existsSync(active) ? readFileSync(active, 'utf8') : '{}',
        );
      } catch (cause) {
        throw new SnapshotRestoreError(
          'restore-invalid',
          '无法在恢复 Provider 业务配置时保留当前凭据',
          { cause },
        );
      }
      writeDurable(target, merged, false);
      assertComponentFile(target, component);
    }
  }
  const stagedSnapshot = join(stageDir, '.snapshots-v1', 'snapshot-' + manifest.snapshotId);
  copyPublishedSnapshot(snapshotDir, stagedSnapshot, manifest);
  writeDurable(
    join(stageDir, SNAPSHOT_RESTORE_PENDING_FILE),
    JSON.stringify(marker, null, 2) + '\n',
    true,
  );
  validateRestoredDataDir(stageDir, manifest.snapshotId);
  if (resolve(dataDir) === resolve(stageDir)) throw new SnapshotRestoreError('restore-invalid', 'restore staging 与 active 重合');
}

function defaultIsProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function assertMarker(path: string, intent: RestoreIntent): SnapshotRestorePendingMarker {
  const marker = readSnapshotRestorePendingMarker(path);
  if (!marker || marker.restoreId !== intent.restoreId || marker.snapshotId !== intent.snapshotId) {
    throw new SnapshotRestoreError('restore-invalid', 'restored active marker 与 intent 不一致');
  }
  return marker;
}

function rollbackActivated(workspace: string, dataDir: string, preDir: string, intent: RestoreIntent): void {
  assertMarker(dataDir, intent);
  const failed = join(workspace, FAILED_DIR);
  if (existsSync(failed)) throw new SnapshotRestoreError('restore-recovery-required', 'failed restore 隔离目录已存在');
  renameSync(dataDir, failed);
  syncDirectory(dirname(dataDir));
  syncDirectory(workspace);
  renameSync(preDir, dataDir);
  syncDirectory(dirname(dataDir));
  syncDirectory(workspace);
  rmSync(failed, { recursive: true, force: true });
}

export function recoverSnapshotRestoreBeforeServerLock(options: {
  dataDir: string;
  isProcessAlive?: (pid: number) => boolean;
}): 'none' | 'rolled-back' | 'committed' {
  const dataDir = resolve(options.dataDir);
  const workspace = snapshotRestoreWorkspacePath(dataDir);
  if (!existsSync(workspace)) return 'none';
  const workspaceStats = lstatSync(workspace);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new SnapshotRestoreError('restore-invalid', 'restore workspace 类型非法');
  }
  const owner = parseOwner(readFileSync(join(workspace, OWNER_FILE), 'utf8'));
  if ((options.isProcessAlive ?? defaultIsProcessAlive)(owner.pid)) {
    throw new SnapshotRestoreError('restore-conflict', '另一进程正在执行快照恢复');
  }
  const intent = parseIntent(readFileSync(join(workspace, INTENT_FILE), 'utf8'));
  if (owner.restoreId !== intent.restoreId) throw new SnapshotRestoreError('restore-invalid', 'restore owner/intent 不匹配');
  const preDir = join(workspace, PRE_DIR);
  const permanentPre = snapshotPreRestorePath(dataDir, intent.restoreId);
  const activeExists = existsSync(dataDir);
  const preExists = existsSync(preDir);
  const permanentExists = existsSync(permanentPre);

  if (intent.phase === 'staging' || intent.phase === 'staged' || intent.phase === 'prepared') {
    if (!activeExists || preExists || permanentExists) throw new SnapshotRestoreError('restore-recovery-required', 'pre-switch 恢复状态不一致');
    rmSync(workspace, { recursive: true, force: true });
    return 'rolled-back';
  }
  if (intent.phase === 'switching' && activeExists && !preExists) {
    rmSync(workspace, { recursive: true, force: true });
    return 'rolled-back';
  }
  if ((intent.phase === 'switching' || intent.phase === 'active-moved') && !activeExists && preExists) {
    renameSync(preDir, dataDir);
    syncDirectory(dirname(dataDir));
    syncDirectory(workspace);
    rmSync(workspace, { recursive: true, force: true });
    return 'rolled-back';
  }
  if (permanentExists && activeExists
    && (intent.phase === 'stage-activated' || intent.phase === 'preserving-pre' || intent.phase === 'pre-preserved')) {
    assertMarker(dataDir, intent);
    rmSync(workspace, { recursive: true, force: true });
    return 'committed';
  }
  if (activeExists && preExists
    && (intent.phase === 'active-moved' || intent.phase === 'stage-activated' || intent.phase === 'preserving-pre')) {
    rollbackActivated(workspace, dataDir, preDir, intent);
    rmSync(workspace, { recursive: true, force: true });
    return 'rolled-back';
  }
  throw new SnapshotRestoreError('restore-recovery-required', 'restore 崩溃状态无法唯一收敛');
}

export class NodeSnapshotRestoreDryRunAdapter implements SnapshotRestoreDryRunAdapter {
  constructor(private readonly timeoutMs = 30_000) {}

  validate(input: { dataDir: string; snapshotId: string }): void {
    const ownPath = fileURLToPath(import.meta.url);
    const extension = extname(ownPath);
    const script = join(dirname(ownPath), 'snapshot-restore-dry-run' + extension);
    const args = [
      ...(extension === '.ts' ? ['--experimental-strip-types', '--experimental-transform-types'] : []),
      script,
      '--data-dir',
      resolve(input.dataDir),
      '--snapshot-id',
      input.snapshotId,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: this.timeoutMs,
      windowsHide: true,
      env: { ...process.env, JG_SNAPSHOT_DRY_RUN: '1' },
    });
    if (result.error || result.status !== 0 || result.stdout.trim() !== 'snapshot-restore-dry-run:ok') {
      throw new SnapshotRestoreError('restore-dry-run', '隔离 dry-run boot 失败', {
        cause: result.error ?? new Error((result.stderr || result.stdout).slice(-500)),
      });
    }
  }
}

export class SnapshotRestoreCoordinator {
  readonly #dataDir: string;
  readonly #serverLock: ServerProcessLock;
  readonly #dryRun: SnapshotRestoreDryRunAdapter;
  readonly #now: () => string;
  readonly #restoreIdFactory: () => string;

  constructor(options: {
    dataDir: string;
    serverLock: ServerProcessLock;
    dryRun?: SnapshotRestoreDryRunAdapter;
    now?: () => string;
    restoreIdFactory?: () => string;
  }) {
    this.#dataDir = resolve(options.dataDir);
    if (resolve(options.serverLock.dataDir) !== this.#dataDir) {
      throw new SnapshotRestoreError('restore-invalid', 'restore dataDir 与 process lock 不一致');
    }
    this.#serverLock = options.serverLock;
    this.#dryRun = options.dryRun ?? new NodeSnapshotRestoreDryRunAdapter();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#restoreIdFactory = options.restoreIdFactory ?? (() => randomBytes(12).toString('hex'));
  }

  restore(options: { snapshotId: string; injectCrashAt?: SnapshotRestoreCrashStage }): SnapshotRestoreResult {
    this.#serverLock.assertOwned();
    if (!SNAPSHOT_ID_RE.test(options.snapshotId)) throw new SnapshotRestoreError('restore-invalid', 'snapshotId 非法');
    const restoreId = this.#restoreIdFactory();
    if (!SNAPSHOT_ID_RE.test(restoreId)) throw new SnapshotRestoreError('restore-invalid', 'restoreIdFactory 非法');
    const createdAt = canonicalIso(this.#now());
    const workspace = snapshotRestoreWorkspacePath(this.#dataDir);
    const stageDir = join(workspace, STAGE_DIR);
    const preDir = join(workspace, PRE_DIR);
    const permanentPre = snapshotPreRestorePath(this.#dataDir, restoreId);
    if (existsSync(workspace) || existsSync(permanentPre)) {
      throw new SnapshotRestoreError('restore-conflict', 'restore workspace 或 pre-restore 已存在');
    }
    const snapshotDir = join(this.#dataDir, '.snapshots-v1', 'snapshot-' + options.snapshotId);
    const manifest = verifySnapshotDirectory(snapshotDir);
    if (manifest.snapshotId !== options.snapshotId) throw new SnapshotRestoreError('restore-invalid', 'snapshotId 不匹配');
    const preRestoreName = '.pre-restore-' + restoreId;
    const marker: SnapshotRestorePendingMarker = Object.freeze({
      version: 1,
      restoreId,
      snapshotId: options.snapshotId,
      restoredAt: createdAt,
      preRestoreName,
      authRotationRequired: true,
    });
    let intent: RestoreIntent = {
      version: 1,
      restoreId,
      snapshotId: options.snapshotId,
      phase: 'staging',
      createdAt,
      preRestoreName,
    };
    let switched = false;
    const crash = (stage: SnapshotRestoreCrashStage): void => {
      if (options.injectCrashAt === stage) throw new SnapshotRestoreCrashSimulationError('模拟 restore 崩溃：' + stage);
    };
    const persist = (): void => replaceDurable(join(workspace, INTENT_FILE), JSON.stringify(intent, null, 2) + '\n');
    try {
      mkdirSync(workspace, { mode: 0o700 });
      writeDurable(join(workspace, OWNER_FILE), JSON.stringify({
        version: 1, pid: process.pid, restoreId, createdAt,
      }, null, 2) + '\n', true);
      persist();
      stageSnapshot(this.#dataDir, stageDir, snapshotDir, manifest, marker);
      intent = { ...intent, phase: 'staged' };
      persist();
      crash('after-stage');

      this.#dryRun.validate({ dataDir: stageDir, snapshotId: options.snapshotId });
      validateRestoredDataDir(stageDir, options.snapshotId);
      intent = { ...intent, phase: 'prepared' };
      persist();
      crash('after-dry-run');

      this.#serverLock.assertOwned();
      intent = { ...intent, phase: 'switching' };
      persist();
      renameSync(this.#dataDir, preDir);
      syncDirectory(dirname(this.#dataDir));
      syncDirectory(workspace);
      switched = true;
      intent = { ...intent, phase: 'active-moved' };
      persist();
      crash('after-active-moved');

      renameSync(stageDir, this.#dataDir);
      syncDirectory(dirname(this.#dataDir));
      syncDirectory(workspace);
      intent = { ...intent, phase: 'stage-activated' };
      persist();
      assertMarker(this.#dataDir, intent);
      validateRestoredDataDir(this.#dataDir, options.snapshotId);
      crash('after-stage-activated');

      intent = { ...intent, phase: 'preserving-pre' };
      persist();
      this.#serverLock.releaseMoved(preDir);
      renameSync(preDir, permanentPre);
      syncDirectory(dirname(this.#dataDir));
      syncDirectory(workspace);
      intent = { ...intent, phase: 'pre-preserved' };
      persist();
      crash('after-pre-preserved');

      rmSync(workspace, { recursive: true, force: true });
      return { restoreId, snapshotId: options.snapshotId, dataDir: this.#dataDir, preRestoreDir: permanentPre, marker };
    } catch (error) {
      if (error instanceof SnapshotRestoreCrashSimulationError) throw error;
      if (!switched && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
      if (switched) {
        throw new SnapshotRestoreError('restore-recovery-required', 'restore 切换中断，保留 workspace 等待启动恢复', { cause: error });
      }
      throw error;
    }
  }
}
