import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const RELEASE_DRAIN_FILE = 'release-drain.v1.json';
const MAX_DRAIN_MS = 30 * 60_000;

export interface ReleaseDrainLease {
  readonly version: 1;
  readonly token: string;
  readonly releaseId: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

export interface ReleaseDrainState {
  readonly active: boolean;
  readonly reason: 'absent' | 'active' | 'expired' | 'invalid';
  readonly lease?: ReleaseDrainLease;
}

function drainPath(dataDir: string): string {
  return join(resolve(dataDir), RELEASE_DRAIN_FILE);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function parseLease(raw: string): ReleaseDrainLease {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('release-drain-invalid');
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['version', 'token', 'releaseId', 'startedAt', 'expiresAt'])
    || row.version !== 1
    || typeof row.token !== 'string' || !/^[a-f0-9]{32}$/.test(row.token)
    || typeof row.releaseId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(row.releaseId)
    || typeof row.startedAt !== 'string' || new Date(row.startedAt).toISOString() !== row.startedAt
    || typeof row.expiresAt !== 'string' || new Date(row.expiresAt).toISOString() !== row.expiresAt) {
    throw new Error('release-drain-invalid');
  }
  const duration = Date.parse(row.expiresAt) - Date.parse(row.startedAt);
  if (duration < 1_000 || duration > MAX_DRAIN_MS) throw new Error('release-drain-invalid');
  return Object.freeze({
    version: 1,
    token: row.token,
    releaseId: row.releaseId,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  });
}

/** 文件存在但损坏时 fail closed；过期租约自动失效，避免发布进程崩溃永久锁死酒馆。 */
export function releaseDrainState(dataDir: string, nowMs = Date.now()): ReleaseDrainState {
  const path = drainPath(dataDir);
  if (!existsSync(path)) return { active: false, reason: 'absent' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { active: true, reason: 'invalid' };
    const lease = parseLease(readFileSync(path, 'utf8'));
    if (Date.parse(lease.expiresAt) <= nowMs) return { active: false, reason: 'expired', lease };
    return { active: true, reason: 'active', lease };
  } catch {
    return { active: true, reason: 'invalid' };
  }
}

export function beginReleaseDrain(input: {
  readonly dataDir: string;
  readonly releaseId: string;
  readonly ttlMs?: number;
  readonly nowMs?: number;
  readonly token?: string;
}): ReleaseDrainLease {
  const root = resolve(input.dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = releaseDrainState(root, input.nowMs ?? Date.now());
  if (existing.active) throw new Error('release-drain-already-active');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.releaseId)) throw new Error('release-id-invalid');
  const ttlMs = input.ttlMs ?? 10 * 60_000;
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_DRAIN_MS) throw new Error('release-drain-ttl-invalid');
  const nowMs = input.nowMs ?? Date.now();
  const token = input.token ?? randomUUID().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('release-drain-token-invalid');
  const lease: ReleaseDrainLease = Object.freeze({
    version: 1,
    token,
    releaseId: input.releaseId,
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  });
  const target = drainPath(root);
  // 只允许替换已经严格解析为过期的旧租约；活动/损坏文件已在上方拒绝。
  if (existing.reason === 'expired' && existsSync(target)) rmSync(target, { force: false });
  // 直接以 wx 建立唯一准入门；并发发布只有一个能成功。崩溃导致半 JSON 时服务端按 invalid fail closed。
  writeFileSync(target, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { chmodSync(target, 0o600); } catch { /* Windows ACL 由 dataDir 承担。 */ }
  return lease;
}

export function endReleaseDrain(dataDir: string, token: string): void {
  const state = releaseDrainState(dataDir);
  if (state.reason === 'absent' || state.reason === 'expired') return;
  if (!state.lease || state.lease.token !== token) throw new Error('release-drain-token-mismatch');
  rmSync(drainPath(dataDir), { force: false });
}
