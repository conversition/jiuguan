import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
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
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ServerProcessLock } from './process-lock.ts';
import {
  SNAPSHOT_MANIFEST_FILE,
  canonicalSnapshotRelativePath,
  computeSnapshotPluginDigest,
  parseSnapshotManifest,
  serializeSnapshotManifest,
  type JiuguanSnapshotManifest,
  type SnapshotCaptureMode,
  type SnapshotComponentManifest,
  type SnapshotComponentRole,
} from './snapshot-manifest.ts';
import { redactProviderConfig } from './snapshot-provider-config.ts';

const SNAPSHOT_ROOT_NAME = '.snapshots-v1';
const CAPTURE_LOCK_DIR = 'capture.lock';
const CAPTURE_LOCK_RECORD = 'capture.json';
const CAPTURE_INTENT_FILE = 'capture-intent.json';
const INTENT_TEMP_PREFIX = '.capture-intent.tmp-';
const STAGE_PREFIX = '.stage-';
const FINAL_PREFIX = 'snapshot-';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SNAPSHOT_ID_RE = /^[a-f0-9]{24}$/;
const LEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

export type SnapshotCoordinatorErrorCode =
  | 'snapshot-conflict'
  | 'snapshot-invalid'
  | 'snapshot-io'
  | 'snapshot-source-changed'
  | 'snapshot-freeze-failed';

export class SnapshotCoordinatorError extends Error {
  readonly name = 'SnapshotCoordinatorError';
  constructor(readonly code: SnapshotCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class SnapshotCrashSimulationError extends Error {
  readonly name = 'SnapshotCrashSimulationError';
}

export interface SnapshotComponentPlan {
  readonly id: string;
  readonly role: SnapshotComponentRole;
  readonly sourceRelativePath: string;
  readonly captureMode: SnapshotCaptureMode;
  readonly schemaVersion?: number;
}

export interface SnapshotPluginPlan {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly componentIds: readonly string[];
}

export interface SnapshotFreezeAdapter {
  acquire(snapshotId: string): string;
  assert(leaseId: string, snapshotId: string): void;
  release(leaseId: string, snapshotId: string): void;
  recover(leaseId: string, snapshotId: string): void;
  /** 处理已写 capture lock、但尚未来得及持久化 lease id 的崩溃窗口；必须幂等。 */
  recoverOrphan(snapshotId: string): void;
}

export interface SnapshotSqliteCaptureAdapter {
  captureOnline(input: {
    component: SnapshotComponentPlan;
    sourcePath: string;
    destinationPath: string;
  }): void;
}

export type SnapshotCrashStage =
  | 'after-lock'
  | 'after-intent'
  | 'after-first-component'
  | 'after-manifest'
  | 'after-publish';

export interface SnapshotCoordinatorOptions {
  readonly dataDir: string;
  readonly serverLock: ServerProcessLock;
  readonly freeze: SnapshotFreezeAdapter;
  readonly sqlite?: SnapshotSqliteCaptureAdapter;
  readonly now?: () => string;
  readonly snapshotIdFactory?: () => string;
  readonly afterCopyForTest?: (componentId: string, sourcePath: string) => void;
}

export interface CreateSnapshotOptions {
  readonly applicationVersion: string;
  readonly components: readonly SnapshotComponentPlan[];
  readonly plugins?: readonly SnapshotPluginPlan[];
  readonly injectCrashAt?: SnapshotCrashStage;
}

export interface SnapshotCaptureResult {
  readonly snapshotDir: string;
  readonly manifestPath: string;
  readonly manifest: JiuguanSnapshotManifest;
}

interface SnapshotCaptureIntent {
  readonly version: 1;
  readonly snapshotId: string;
  readonly stageName: string;
  readonly finalName: string;
  readonly phase: 'staging' | 'publishing' | 'published';
  readonly freezeLeaseId: string;
  readonly createdAt: string;
}

function parseLockRecord(raw: string): { snapshotId: string; createdAt: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 capture lock 记录不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 capture lock 记录必须是对象');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'createdAt,snapshotId,version'
    || row.version !== 1 || typeof row.snapshotId !== 'string'
    || !SNAPSHOT_ID_RE.test(row.snapshotId) || typeof row.createdAt !== 'string') {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 capture lock 记录字段非法');
  }
  return { snapshotId: row.snapshotId, createdAt: canonicalIso(row.createdAt) };
}

function canonicalIso(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照时钟必须返回 canonical ISO 时间');
  }
  return value;
}

function resolveContained(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split('/'));
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照路径超出受控根目录');
  }
  return target;
}

function assertPlainAncestorChain(root: string, relativePath: string): string {
  const normalized = canonicalSnapshotRelativePath(relativePath, 'sourceRelativePath');
  const segments = normalized.split('/');
  let current = resolve(root);
  const rootStats = lstatSync(current);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new SnapshotCoordinatorError('snapshot-invalid', 'dataDir 必须是普通目录');
  }
  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照来源不得包含符号链接或 junction');
    }
  }
  return current;
}

function writeFileDurable(path: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function replaceFileDurable(path: string, content: string): void {
  const temp = join(dirname(path), INTENT_TEMP_PREFIX + randomUUID());
  try {
    writeFileDurable(temp, content);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function parseIntent(raw: string): SnapshotCaptureIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 intent 不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 intent 必须是对象');
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(',');
  if (keys !== 'createdAt,finalName,freezeLeaseId,phase,snapshotId,stageName,version'
    || row.version !== 1
    || typeof row.snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(row.snapshotId)
    || row.stageName !== STAGE_PREFIX + row.snapshotId
    || row.finalName !== FINAL_PREFIX + row.snapshotId
    || (row.phase !== 'staging' && row.phase !== 'publishing' && row.phase !== 'published')
    || typeof row.freezeLeaseId !== 'string' || !LEASE_ID_RE.test(row.freezeLeaseId)
    || typeof row.createdAt !== 'string') {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 intent 字段非法');
  }
  return {
    version: 1,
    snapshotId: row.snapshotId,
    stageName: row.stageName,
    finalName: row.finalName,
    phase: row.phase,
    freezeLeaseId: row.freezeLeaseId,
    createdAt: canonicalIso(row.createdAt),
  };
}

function validatePlans(plans: readonly SnapshotComponentPlan[]): SnapshotComponentPlan[] {
  if (plans.length < 1) throw new SnapshotCoordinatorError('snapshot-invalid', '快照至少需要一个组件');
  const ids = new Set<string>();
  const sources = new Set<string>();
  return plans.map((plan) => {
    if (!ID_RE.test(plan.id) || ids.has(plan.id)) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照 component id 非法或重复');
    }
    ids.add(plan.id);
    const sourceRelativePath = canonicalSnapshotRelativePath(plan.sourceRelativePath, 'sourceRelativePath');
    if (sources.has(sourceRelativePath)) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照来源路径重复');
    }
    sources.add(sourceRelativePath);
    const fileName = sourceRelativePath.split('/').at(-1);
    if (fileName === 'root.key' || sourceRelativePath.startsWith(SNAPSHOT_ROOT_NAME + '/')
      || sourceRelativePath.endsWith('-wal') || sourceRelativePath.endsWith('-shm')) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照来源属于禁止文件');
    }
    const databaseRole = plan.role === 'session-db' || plan.role === 'auth-db' || plan.role === 'control-db';
    if (databaseRole !== (plan.captureMode === 'sqlite-online')) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '数据库与 capture mode 不一致');
    }
    const providerConfig = sourceRelativePath === 'provider.json';
    if (providerConfig !== (plan.captureMode === 'redacted-json')
      || (plan.captureMode === 'redacted-json' && plan.role !== 'configuration')) {
      throw new SnapshotCoordinatorError(
        'snapshot-invalid',
        'provider.json 必须是 configuration/redacted-json 专用组件',
      );
    }
    if (databaseRole && (!Number.isSafeInteger(plan.schemaVersion) || Number(plan.schemaVersion) < 1)) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '数据库必须登记 schemaVersion');
    }
    return Object.freeze({
      id: plan.id,
      role: plan.role,
      sourceRelativePath,
      captureMode: plan.captureMode,
      ...(plan.schemaVersion === undefined ? {} : { schemaVersion: plan.schemaVersion }),
    });
  });
}

function sameSourceIdentity(before: ReturnType<typeof fstatSync>, after: ReturnType<typeof fstatSync>): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function hashFile(path: string): { sizeBytes: number; sha256: string } {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      sizeBytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  afterCopy?: () => void,
): { sizeBytes: number; sha256: string } {
  const sourceFd = openSync(sourcePath, 'r');
  let destinationFd: number | undefined;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) throw new SnapshotCoordinatorError('snapshot-invalid', '快照来源必须是普通文件');
    destinationFd = openSync(destinationPath, 'wx', 0o600);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      writeSync(destinationFd, buffer, 0, count);
      hash.update(buffer.subarray(0, count));
      sizeBytes += count;
    }
    fsyncSync(destinationFd);
    afterCopy?.();
    const after = fstatSync(sourceFd);
    if (!sameSourceIdentity(before, after) || sizeBytes !== before.size) {
      throw new SnapshotCoordinatorError('snapshot-source-changed', '快照复制期间来源文件发生变化');
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function captureRedactedProviderConfig(
  sourcePath: string,
  destinationPath: string,
  afterCopy?: () => void,
): { sizeBytes: number; sha256: string } {
  const sourceFd = openSync(sourcePath, 'r');
  const chunks: Buffer[] = [];
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) throw new SnapshotCoordinatorError('snapshot-invalid', '快照来源必须是普通文件');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    let redacted: string;
    try {
      redacted = redactProviderConfig(Buffer.concat(chunks).toString('utf8'));
    } catch (cause) {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'Provider 配置无法生成去密钥快照', { cause });
    }
    writeFileDurable(destinationPath, redacted);
    afterCopy?.();
    const after = fstatSync(sourceFd);
    if (!sameSourceIdentity(before, after)) {
      throw new SnapshotCoordinatorError('snapshot-source-changed', '快照复制期间来源文件发生变化');
    }
    const bytes = Buffer.from(redacted, 'utf8');
    return {
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    closeSync(sourceFd);
  }
}

function snapshotPluginManifest(
  plugin: SnapshotPluginPlan,
  componentsById: ReadonlyMap<string, SnapshotComponentManifest>,
) {
  if (!ID_RE.test(plugin.id) || typeof plugin.version !== 'string' || plugin.version.length < 1
    || plugin.version.length > 80 || typeof plugin.enabled !== 'boolean' || plugin.componentIds.length < 1) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '插件 inventory 非法');
  }
  const unique = new Set(plugin.componentIds);
  if (unique.size !== plugin.componentIds.length) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '插件 componentIds 重复');
  }
  const componentIds = Object.freeze([...unique].sort());
  const base = { id: plugin.id, version: plugin.version, enabled: plugin.enabled, componentIds };
  let digest: string;
  try {
    digest = computeSnapshotPluginDigest(base, componentsById);
  } catch (cause) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '插件 inventory 引用非法', { cause });
  }
  return Object.freeze({ ...base, digest });
}

export function verifySnapshotDirectory(snapshotDir: string): JiuguanSnapshotManifest {
  const root = resolve(snapshotDir);
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照必须是普通目录');
  }
  const topEntries = readdirSync(root).sort();
  if (topEntries.join(',') !== ['components', SNAPSHOT_MANIFEST_FILE].sort().join(',')) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照目录含未登记顶层条目');
  }
  const manifestPath = join(root, SNAPSHOT_MANIFEST_FILE);
  const manifestStats = lstatSync(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 manifest 必须是普通文件');
  }
  let manifest: JiuguanSnapshotManifest;
  try {
    manifest = parseSnapshotManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (cause) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 manifest 校验失败', { cause });
  }
  if (basename(root) !== FINAL_PREFIX + manifest.snapshotId) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照目录名与 snapshotId 不一致');
  }
  const componentsDir = join(root, 'components');
  const componentDirStats = lstatSync(componentsDir);
  if (!componentDirStats.isDirectory() || componentDirStats.isSymbolicLink()) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 components 必须是普通目录');
  }
  const expected = manifest.components.map((component) => basename(component.storedRelativePath)).sort();
  const actual = readdirSync(componentsDir).sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new SnapshotCoordinatorError('snapshot-invalid', '快照 components 与 manifest 不一致');
  }
  for (const component of manifest.components) {
    const path = resolveContained(root, component.storedRelativePath);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照 component 必须是普通文件');
    }
    const actualFile = hashFile(path);
    if (actualFile.sizeBytes !== component.sizeBytes || actualFile.sha256 !== component.sha256) {
      throw new SnapshotCoordinatorError('snapshot-invalid', '快照 component hash/长度不匹配');
    }
  }
  return manifest;
}

export class SnapshotCoordinator {
  readonly #dataDir: string;
  readonly #rootDir: string;
  readonly #serverLock: ServerProcessLock;
  readonly #freeze: SnapshotFreezeAdapter;
  readonly #sqlite?: SnapshotSqliteCaptureAdapter;
  readonly #now: () => string;
  readonly #snapshotIdFactory: () => string;
  readonly #afterCopyForTest?: SnapshotCoordinatorOptions['afterCopyForTest'];

  constructor(options: SnapshotCoordinatorOptions) {
    this.#dataDir = resolve(options.dataDir);
    if (resolve(options.serverLock.dataDir) !== this.#dataDir) {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'snapshot dataDir 与 server process lock 不一致');
    }
    this.#rootDir = join(this.#dataDir, SNAPSHOT_ROOT_NAME);
    this.#serverLock = options.serverLock;
    this.#freeze = options.freeze;
    this.#sqlite = options.sqlite;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#snapshotIdFactory = options.snapshotIdFactory ?? (() => randomBytes(12).toString('hex'));
    this.#afterCopyForTest = options.afterCopyForTest;
  }

  recover(): void {
    this.#serverLock.assertOwned();
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    const intentPath = join(this.#rootDir, CAPTURE_INTENT_FILE);
    const lockPath = join(this.#rootDir, CAPTURE_LOCK_DIR);
    let intent: SnapshotCaptureIntent | null = null;
    if (existsSync(intentPath)) intent = parseIntent(readFileSync(intentPath, 'utf8'));
    let lockRecord: { snapshotId: string; createdAt: string } | null = null;
    if (existsSync(lockPath)) {
      const stats = lstatSync(lockPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new SnapshotCoordinatorError('snapshot-invalid', '快照 capture lock 类型非法');
      }
      const recordPath = join(lockPath, CAPTURE_LOCK_RECORD);
      if (!existsSync(recordPath)) {
        throw new SnapshotCoordinatorError('snapshot-invalid', '快照 capture lock 缺少持久记录');
      }
      lockRecord = parseLockRecord(readFileSync(recordPath, 'utf8'));
      if (intent && lockRecord.snapshotId !== intent.snapshotId) {
        throw new SnapshotCoordinatorError('snapshot-invalid', '快照 lock 与 intent 不属于同一 capture');
      }
    }
    for (const entry of readdirSync(this.#rootDir)) {
      if (entry.startsWith(STAGE_PREFIX)) {
        const stagePath = join(this.#rootDir, entry);
        const stats = lstatSync(stagePath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new SnapshotCoordinatorError('snapshot-invalid', '快照 staging 产物类型非法');
        }
        rmSync(stagePath, { recursive: true, force: true });
      } else if (entry.startsWith(INTENT_TEMP_PREFIX)) {
        rmSync(join(this.#rootDir, entry), { force: true });
      }
    }
    if (intent) {
      try {
        this.#freeze.recover(intent.freezeLeaseId, intent.snapshotId);
      } catch (cause) {
        throw new SnapshotCoordinatorError('snapshot-freeze-failed', '无法恢复快照冻结租约', { cause });
      }
      rmSync(intentPath, { force: true });
    } else if (lockRecord) {
      try {
        this.#freeze.recoverOrphan(lockRecord.snapshotId);
      } catch (cause) {
        throw new SnapshotCoordinatorError('snapshot-freeze-failed', '无法恢复未持久化的快照冻结租约', { cause });
      }
    }
    if (existsSync(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  create(options: CreateSnapshotOptions): SnapshotCaptureResult {
    this.#serverLock.assertOwned();
    const plans = validatePlans(options.components);
    const snapshotId = this.#snapshotIdFactory();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'snapshotIdFactory 返回非法标识');
    }
    const createdAt = canonicalIso(this.#now());
    const crash = (stage: SnapshotCrashStage): void => {
      if (options.injectCrashAt === stage) throw new SnapshotCrashSimulationError('模拟快照崩溃：' + stage);
    };
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.#rootDir, CAPTURE_LOCK_DIR);
    let publishedVerified = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (cause) {
      throw new SnapshotCoordinatorError('snapshot-conflict', '已有快照 capture 正在进行或等待恢复', { cause });
    }
    writeFileDurable(join(lockPath, CAPTURE_LOCK_RECORD), JSON.stringify({
      version: 1,
      snapshotId,
      createdAt,
    }, null, 2) + '\n');
    crash('after-lock');

    const stageName = STAGE_PREFIX + snapshotId;
    const finalName = FINAL_PREFIX + snapshotId;
    const stageDir = join(this.#rootDir, stageName);
    const finalDir = join(this.#rootDir, finalName);
    const intentPath = join(this.#rootDir, CAPTURE_INTENT_FILE);
    if (existsSync(stageDir) || existsSync(finalDir) || existsSync(intentPath)) {
      rmSync(lockPath, { recursive: true, force: true });
      throw new SnapshotCoordinatorError('snapshot-conflict', '快照 id 或 intent 已存在');
    }

    let leaseId: string;
    try {
      leaseId = this.#freeze.acquire(snapshotId);
    } catch (cause) {
      try {
        this.#freeze.recoverOrphan(snapshotId);
        rmSync(lockPath, { recursive: true, force: true });
      } catch (recoveryCause) {
        throw new SnapshotCoordinatorError(
          'snapshot-freeze-failed',
          '无法取得快照冻结租约且 orphan 恢复失败，保留 capture lock',
          { cause: new AggregateError([cause, recoveryCause]) },
        );
      }
      throw new SnapshotCoordinatorError('snapshot-freeze-failed', '无法取得快照冻结租约', { cause });
    }
    if (!LEASE_ID_RE.test(leaseId)) {
      try {
        this.#freeze.recoverOrphan(snapshotId);
        rmSync(lockPath, { recursive: true, force: true });
      } catch (cause) {
        throw new SnapshotCoordinatorError(
          'snapshot-freeze-failed',
          '冻结适配器返回非法 lease id 且无法恢复',
          { cause },
        );
      }
      throw new SnapshotCoordinatorError('snapshot-freeze-failed', '冻结适配器返回非法 lease id');
    }

    let intent: SnapshotCaptureIntent = {
      version: 1,
      snapshotId,
      stageName,
      finalName,
      phase: 'staging',
      freezeLeaseId: leaseId,
      createdAt,
    };
    const persistIntent = (): void => replaceFileDurable(intentPath, JSON.stringify(intent, null, 2) + '\n');
    try {
      mkdirSync(stageDir, { mode: 0o700 });
      mkdirSync(join(stageDir, 'components'), { mode: 0o700 });
      persistIntent();
      crash('after-intent');

      const captured: SnapshotComponentManifest[] = [];
      for (const [index, plan] of plans.entries()) {
        this.#serverLock.assertOwned();
        this.#freeze.assert(leaseId, snapshotId);
        const sourcePath = assertPlainAncestorChain(this.#dataDir, plan.sourceRelativePath);
        if (sourcePath.startsWith(this.#rootDir + sep)) {
          throw new SnapshotCoordinatorError('snapshot-invalid', '不得把快照目录自身纳入快照');
        }
        const storedRelativePath = 'components/' + plan.id + '.bin';
        const destinationPath = resolveContained(stageDir, storedRelativePath);
        let capturedFile: { sizeBytes: number; sha256: string };
        if (plan.captureMode === 'copy-file') {
          capturedFile = copyStableFile(sourcePath, destinationPath, () => {
            this.#afterCopyForTest?.(plan.id, sourcePath);
          });
        } else if (plan.captureMode === 'redacted-json') {
          capturedFile = captureRedactedProviderConfig(sourcePath, destinationPath, () => {
            this.#afterCopyForTest?.(plan.id, sourcePath);
          });
        } else {
          if (!this.#sqlite) {
            throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 在线 capture adapter 未提供');
          }
          this.#sqlite.captureOnline({ component: plan, sourcePath, destinationPath });
          const outputStats = lstatSync(destinationPath);
          if (!outputStats.isFile() || outputStats.isSymbolicLink()) {
            throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite adapter 输出必须是普通单文件');
          }
          capturedFile = hashFile(destinationPath);
        }
        captured.push(Object.freeze({
          id: plan.id,
          role: plan.role,
          sourceRelativePath: plan.sourceRelativePath,
          storedRelativePath,
          captureMode: plan.captureMode,
          sizeBytes: capturedFile.sizeBytes,
          sha256: capturedFile.sha256,
          ...(plan.schemaVersion === undefined ? {} : { schemaVersion: plan.schemaVersion }),
        }));
        if (index === 0) crash('after-first-component');
      }

      const expectedOutputs = new Set(captured.map((component) => basename(component.storedRelativePath)));
      for (const entry of readdirSync(join(stageDir, 'components'))) {
        if (!expectedOutputs.has(entry) || entry.endsWith('-wal') || entry.endsWith('-shm')) {
          throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite/copy adapter 产生了未登记旁文件');
        }
      }
      const componentMap = new Map(captured.map((component) => [component.id, component]));
      const pluginIds = new Set<string>();
      const plugins = (options.plugins ?? []).map((plugin) => {
        if (pluginIds.has(plugin.id)) throw new SnapshotCoordinatorError('snapshot-invalid', '插件 inventory id 重复');
        pluginIds.add(plugin.id);
        return snapshotPluginManifest(plugin, componentMap);
      }).sort((a, b) => a.id.localeCompare(b.id));
      const manifest = parseSnapshotManifest({
        version: 1,
        snapshotId,
        createdAt,
        applicationVersion: options.applicationVersion,
        components: captured.sort((a, b) => a.id.localeCompare(b.id)),
        plugins,
      });
      const manifestPath = join(stageDir, SNAPSHOT_MANIFEST_FILE);
      writeFileDurable(manifestPath, serializeSnapshotManifest(manifest));
      parseSnapshotManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      crash('after-manifest');

      this.#serverLock.assertOwned();
      this.#freeze.assert(leaseId, snapshotId);
      intent = { ...intent, phase: 'publishing' };
      persistIntent();
      renameSync(stageDir, finalDir);
      verifySnapshotDirectory(finalDir);
      publishedVerified = true;
      intent = { ...intent, phase: 'published' };
      persistIntent();
      crash('after-publish');

      try {
        this.#freeze.release(leaseId, snapshotId);
      } catch (cause) {
        throw new SnapshotCoordinatorError('snapshot-freeze-failed', '快照已发布但冻结租约释放失败', { cause });
      }
      rmSync(intentPath, { force: true });
      rmSync(lockPath, { recursive: true, force: true });
      return {
        snapshotDir: finalDir,
        manifestPath: join(finalDir, SNAPSHOT_MANIFEST_FILE),
        manifest,
      };
    } catch (error) {
      if (error instanceof SnapshotCrashSimulationError) throw error;
      const cleanupErrors: unknown[] = [];
      try {
        if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
        if (existsSync(finalDir) && !publishedVerified) rmSync(finalDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        this.#freeze.release(leaseId, snapshotId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length === 0) {
        rmSync(intentPath, { force: true });
        rmSync(lockPath, { recursive: true, force: true });
      }
      if (cleanupErrors.length > 0) {
        throw new SnapshotCoordinatorError(
          'snapshot-freeze-failed',
          '快照失败且清理/释放冻结租约不完整，保留 intent 等待恢复',
          { cause: new AggregateError([error, ...cleanupErrors]) },
        );
      }
      throw error;
    }
  }
}
