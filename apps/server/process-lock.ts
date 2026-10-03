import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { snapshotRestoreWorkspacePath } from './snapshot-restore-layout.ts';

export const SERVER_PROCESS_LOCK_DIR = '.jiuguan-server.lock';
const OWNER_FILE = 'owner.json';
const LOCK_ARTIFACT_PREFIX = '.jiuguan-server.lock.';

interface ProcessLockOwner {
  version: 1;
  pid: number;
  instanceId: string;
  acquiredAt: string;
}

export type ServerProcessLockErrorCode =
  | 'server-already-running'
  | 'server-lock-invalid'
  | 'server-restore-in-progress';

export class ServerProcessLockError extends Error {
  readonly name = 'ServerProcessLockError';

  constructor(readonly code: ServerProcessLockErrorCode, message: string) {
    super(message);
  }
}

export interface AcquireServerProcessLockOptions {
  dataDir: string;
  instanceId: string;
  pid?: number;
  now?: () => string;
  randomId?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  /** 仅供 restore coordinator 在已持有外部 workspace 门禁时使用。 */
  allowRestoreWorkspace?: boolean;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('进程锁时钟必须返回 canonical ISO 时间');
  }
  return value;
}

function requireInstanceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value)) throw new Error('serverInstanceId 非法');
  return value;
}

function artifactSuffix(randomId: () => string): string {
  const value = randomId();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(value)) throw new Error('进程锁随机源返回非法标识');
  return value;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function parseOwner(text: string): ProcessLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁 owner.json 不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁 owner.json 结构无效');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'acquiredAt,instanceId,pid,version'
    || record.version !== 1
    || !Number.isInteger(record.pid) || (record.pid as number) < 1
    || typeof record.instanceId !== 'string'
    || typeof record.acquiredAt !== 'string') {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁 owner.json 字段无效');
  }
  try {
    return {
      version: 1,
      pid: record.pid as number,
      instanceId: requireInstanceId(record.instanceId),
      acquiredAt: canonicalTimestamp(record.acquiredAt),
    };
  } catch {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁 owner.json 字段无效');
  }
}

function readOwner(lockDir: string): ProcessLockOwner {
  const lockStats = lstatSync(lockDir);
  if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁路径必须是普通目录');
  }
  const ownerPath = join(lockDir, OWNER_FILE);
  const ownerStats = lstatSync(ownerPath);
  if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) {
    throw new ServerProcessLockError('server-lock-invalid', '服务进程锁 owner.json 必须是普通文件');
  }
  return parseOwner(readFileSync(ownerPath, 'utf8'));
}

function removeOwnedArtifact(dataDir: string, target: string): void {
  const absolute = resolve(target);
  if (dirname(absolute) !== dataDir || !basename(absolute).startsWith(LOCK_ARTIFACT_PREFIX)) {
    throw new Error('拒绝清理 dataDir 外的进程锁产物');
  }
  rmSync(absolute, { recursive: true, force: true });
}

function writeOwnerDirectory(path: string, owner: ProcessLockOwner): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(join(path, OWNER_FILE), 'wx', 0o600);
    const payload = Buffer.from(JSON.stringify(owner) + '\n', 'utf8');
    writeSync(fd, payload, 0, payload.length);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ServerProcessLock {
  #released = false;

  constructor(
    readonly dataDir: string,
    readonly lockDir: string,
    readonly owner: Readonly<ProcessLockOwner>,
    private readonly randomId: () => string,
  ) {}

  /** 长操作开始前重新确认 dataDir 锁仍属于本进程，避免仅凭内存对象越过已变化的锁。 */
  assertOwned(): void {
    if (this.#released) {
      throw new ServerProcessLockError('server-lock-invalid', '服务进程锁已释放');
    }
    const current = readOwner(this.lockDir);
    if (current.pid !== this.owner.pid || current.instanceId !== this.owner.instanceId
      || current.acquiredAt !== this.owner.acquiredAt) {
      throw new ServerProcessLockError('server-lock-invalid', '服务进程锁所有者已变化');
    }
  }

  release(): boolean {
    if (this.#released) return false;
    this.assertOwned();
    const releasePath = join(this.dataDir, `${LOCK_ARTIFACT_PREFIX}release-${artifactSuffix(this.randomId)}`);
    renameSync(this.lockDir, releasePath);
    removeOwnedArtifact(this.dataDir, releasePath);
    this.#released = true;
    return true;
  }

  /**
   * dataDir 已被 restore 原子移到 pre-restore 位置后，按原 owner 精确释放随目录移动的锁。
   * 不能用于任意锁：owner 三元组不完全一致即 fail closed。
   */
  releaseMoved(movedDataDir: string): boolean {
    if (this.#released) return false;
    const movedRoot = resolve(movedDataDir);
    const movedLockDir = join(movedRoot, SERVER_PROCESS_LOCK_DIR);
    const current = readOwner(movedLockDir);
    if (current.pid !== this.owner.pid || current.instanceId !== this.owner.instanceId
      || current.acquiredAt !== this.owner.acquiredAt) {
      throw new ServerProcessLockError('server-lock-invalid', '移动后的服务进程锁所有者已变化');
    }
    const releasePath = join(movedRoot, `${LOCK_ARTIFACT_PREFIX}release-${artifactSuffix(this.randomId)}`);
    renameSync(movedLockDir, releasePath);
    removeOwnedArtifact(movedRoot, releasePath);
    this.#released = true;
    return true;
  }
}

/**
 * dataDir 级服务进程互斥。锁目录通过“完整 staging → 原子 rename”发布，确保可见锁一定有完整 owner。
 * 崩溃残留仅在 owner PID 明确不存在时回收；PID 复用最多造成 fail-closed 拒绝启动，不会双写。
 */
export function acquireServerProcessLock(options: AcquireServerProcessLockOptions): ServerProcessLock {
  const dataDir = resolve(options.dataDir);
  const restoreWorkspace = snapshotRestoreWorkspacePath(dataDir);
  if (!options.allowRestoreWorkspace && existsSync(restoreWorkspace)) {
    const stats = lstatSync(restoreWorkspace);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ServerProcessLockError('server-lock-invalid', 'restore workspace 类型非法');
    }
    throw new ServerProcessLockError(
      'server-restore-in-progress',
      '检测到未收敛的快照恢复事务，拒绝启动服务',
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dataStats = lstatSync(dataDir);
  if (!dataStats.isDirectory() || dataStats.isSymbolicLink()) throw new Error('用户数据路径必须是普通目录');
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid < 1) throw new Error('进程锁 pid 非法');
  const instanceId = requireInstanceId(options.instanceId);
  const randomId = options.randomId ?? randomUUID;
  const owner: ProcessLockOwner = {
    version: 1,
    pid,
    instanceId,
    acquiredAt: canonicalTimestamp((options.now ?? (() => new Date().toISOString()))()),
  };
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const lockDir = join(dataDir, SERVER_PROCESS_LOCK_DIR);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stage = join(dataDir, `${LOCK_ARTIFACT_PREFIX}stage-${artifactSuffix(randomId)}`);
    try {
      writeOwnerDirectory(stage, owner);
      try {
        renameSync(stage, lockDir);
        return new ServerProcessLock(dataDir, lockDir, Object.freeze(owner), randomId);
      } catch (error) {
        if (!existsSync(lockDir)) throw error;
      }
    } finally {
      if (existsSync(stage)) removeOwnedArtifact(dataDir, stage);
    }

    const existing = readOwner(lockDir);
    if (isProcessAlive(existing.pid)) {
      throw new ServerProcessLockError(
        'server-already-running',
        `同一数据目录已有酒馆服务进程（pid=${existing.pid}）`,
      );
    }
    const stalePath = join(dataDir, `${LOCK_ARTIFACT_PREFIX}stale-${artifactSuffix(randomId)}`);
    try {
      renameSync(lockDir, stalePath);
      removeOwnedArtifact(dataDir, stalePath);
    } catch (error) {
      if (existsSync(lockDir)) throw error;
      if (existsSync(stalePath)) removeOwnedArtifact(dataDir, stalePath);
    }
  }
  throw new ServerProcessLockError('server-lock-invalid', '服务进程锁竞争重试耗尽');
}
