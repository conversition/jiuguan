import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export const INSTALLATION_IDENTITY_FILE = 'installation.json';
const SERVER_ID_RE = /^jgs1_[a-f0-9]{32}$/;

export interface InstallationIdentity {
  version: 1;
  serverId: string;
  createdAt: string;
}

export interface InstallationIdentityOptions {
  dataDir: string;
  randomId?: () => string;
  now?: () => string;
}

export function isInstallationServerId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_ID_RE.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function parseIdentity(source: string): InstallationIdentity {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error('安装身份文件不是合法 JSON', { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('安装身份文件结构无效');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'createdAt,serverId,version'
    || record.version !== 1
    || !isInstallationServerId(record.serverId)
    || !isIsoTimestamp(record.createdAt)) {
    throw new Error('安装身份文件字段无效');
  }
  return Object.freeze({
    version: 1,
    serverId: record.serverId,
    createdAt: record.createdAt,
  });
}

function readIdentity(path: string): InstallationIdentity {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('安装身份路径必须是普通文件');
  }
  return parseIdentity(readFileSync(path, 'utf8'));
}

function newServerId(randomId: () => string): string {
  const hex = randomId().replaceAll('-', '').toLowerCase();
  const value = 'jgs1_' + hex;
  if (!isInstallationServerId(value)) {
    throw new Error('安装身份随机源返回了无效 UUID');
  }
  return value;
}

export function loadOrCreateInstallationIdentity(
  options: InstallationIdentityOptions,
): InstallationIdentity {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dataStats = lstatSync(dataDir);
  if (!dataStats.isDirectory() || dataStats.isSymbolicLink()) {
    throw new Error('用户数据路径必须是普通目录');
  }
  const path = join(dataDir, INSTALLATION_IDENTITY_FILE);
  if (existsSync(path)) return readIdentity(path);

  const identity: InstallationIdentity = {
    version: 1,
    serverId: newServerId(options.randomId ?? randomUUID),
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  if (!isIsoTimestamp(identity.createdAt)) {
    throw new Error('安装身份时钟必须返回 canonical ISO 时间');
  }

  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, 'wx', 0o600);
    created = true;
    writeSync(fd, JSON.stringify(identity, null, 2) + '\n', undefined, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return readIdentity(path);
    if (created) {
      try { unlinkSync(path); } catch { /* 只清理本次创建但未完成的固定文件。 */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return Object.freeze(identity);
}
