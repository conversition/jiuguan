/**
 * P8-01 本地创作资产身份注册表。
 *
 * - assetId 由服务端随机生成，不从 displayName、文件名或内容推导；
 * - storageKey 只在服务端内部使用，跨端 DTO 不应暴露它；
 * - 删除保留 tombstone 映射，文件重新出现时沿用原身份；
 * - manifest 损坏时 fail-closed，绝不静默重建并让既有引用漂移。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isSafeAssetFileName, type AssetKind } from './asset-paths.ts';

export const ASSET_IDENTITY_VERSION = 1 as const;
export const LOCAL_ASSET_ID_RE = /^[a-f0-9]{24}$/;

export interface LocalAssetIdentity {
  assetId: string;
  kind: AssetKind;
  storageKey: string;
  displayName: string;
}

interface AssetIdentityManifest {
  version: typeof ASSET_IDENTITY_VERSION;
  records: LocalAssetIdentity[];
}

export class AssetIdentityManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetIdentityManifestError';
  }
}

function safeDisplayName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isLocalAssetId(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_ASSET_ID_RE.test(value);
}

function validateRecord(value: unknown): LocalAssetIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetIdentityManifestError('资产身份记录必须是对象');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'assetId,displayName,kind,storageKey') {
    throw new AssetIdentityManifestError('资产身份记录字段非法');
  }
  if (!isLocalAssetId(record.assetId)) throw new AssetIdentityManifestError('assetId 非法');
  if (record.kind !== 'card' && record.kind !== 'preset' && record.kind !== 'worldbook') {
    throw new AssetIdentityManifestError('资产 kind 非法');
  }
  if (!isSafeAssetFileName(record.storageKey)) {
    throw new AssetIdentityManifestError('资产 storageKey 非法');
  }
  if (!safeDisplayName(record.displayName)) {
    throw new AssetIdentityManifestError('资产 displayName 非法');
  }
  return {
    assetId: record.assetId,
    kind: record.kind,
    storageKey: record.storageKey,
    displayName: record.displayName,
  };
}

function parseManifest(raw: string): AssetIdentityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AssetIdentityManifestError('资产身份 manifest 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AssetIdentityManifestError('资产身份 manifest 必须是对象');
  }
  const manifest = parsed as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(',') !== 'records,version'
    || manifest.version !== ASSET_IDENTITY_VERSION
    || !Array.isArray(manifest.records)) {
    throw new AssetIdentityManifestError('资产身份 manifest 版本或字段非法');
  }
  const records = manifest.records.map(validateRecord);
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const record of records) {
    const logicalKey = `${record.kind}\0${record.storageKey}`;
    if (ids.has(record.assetId)) throw new AssetIdentityManifestError('资产身份 manifest 含重复 assetId');
    if (keys.has(logicalKey)) throw new AssetIdentityManifestError('资产身份 manifest 含重复 storageKey');
    ids.add(record.assetId);
    keys.add(logicalKey);
  }
  return { version: ASSET_IDENTITY_VERSION, records };
}

function atomicWrite(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = resolve(dirname(target), `.${target.split(/[\\/]/).pop()}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function clone(record: LocalAssetIdentity): LocalAssetIdentity {
  return { ...record };
}

export class AssetIdentityRegistry {
  readonly manifestPath: string;
  private readonly byId = new Map<string, LocalAssetIdentity>();
  private readonly byStorage = new Map<string, LocalAssetIdentity>();

  constructor(manifestPath: string) {
    this.manifestPath = resolve(manifestPath);
    if (!existsSync(this.manifestPath)) return;
    const manifest = parseManifest(readFileSync(this.manifestPath, 'utf8'));
    for (const record of manifest.records) this.index(record);
  }

  private storageIndex(kind: AssetKind, storageKey: string): string {
    return `${kind}\0${storageKey}`;
  }

  private index(record: LocalAssetIdentity): void {
    this.byId.set(record.assetId, record);
    this.byStorage.set(this.storageIndex(record.kind, record.storageKey), record);
  }

  private persist(): void {
    const records = [...this.byId.values()]
      .map(clone)
      .sort((a, b) => a.assetId.localeCompare(b.assetId));
    atomicWrite(this.manifestPath, `${JSON.stringify({
      version: ASSET_IDENTITY_VERSION,
      records,
    }, null, 2)}\n`);
  }

  private newId(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const assetId = randomBytes(12).toString('hex');
      if (!this.byId.has(assetId)) return assetId;
    }
    throw new Error('无法生成唯一 assetId');
  }

  /**
   * P8-04 two-phase creation: allocate an identity without making it visible.
   * The caller persists this exact record in its transaction intent and calls
   * commitPrepared only after every final asset file is durable.
   */
  prepareNew(kind: AssetKind, storageKey: string, displayName: string): LocalAssetIdentity {
    if (!isSafeAssetFileName(storageKey)) throw new TypeError('storageKey 非法');
    if (!safeDisplayName(displayName)) throw new TypeError('displayName 非法');
    if (this.byStorage.has(this.storageIndex(kind, storageKey))) throw new Error('storageKey 已被占用');
    return { assetId: this.newId(), kind, storageKey, displayName };
  }

  /** Idempotently publish an identity previously recorded in a durable intent. */
  commitPrepared(value: LocalAssetIdentity): LocalAssetIdentity {
    const record = validateRecord(value);
    const byId = this.byId.get(record.assetId);
    const byStorage = this.byStorage.get(this.storageIndex(record.kind, record.storageKey));
    if (byId || byStorage) {
      if (byId?.assetId === record.assetId
        && byId.kind === record.kind
        && byId.storageKey === record.storageKey
        && byId.displayName === record.displayName
        && byStorage?.assetId === record.assetId) return clone(byId);
      throw new Error('prepared identity 与现有 manifest 冲突');
    }
    this.index(record);
    try {
      this.persist();
    } catch (error) {
      this.byId.delete(record.assetId);
      this.byStorage.delete(this.storageIndex(record.kind, record.storageKey));
      throw error;
    }
    return clone(record);
  }

  ensure(kind: AssetKind, storageKey: string, displayName: string): LocalAssetIdentity {
    if (!isSafeAssetFileName(storageKey)) throw new TypeError('storageKey 非法');
    if (!safeDisplayName(displayName)) throw new TypeError('displayName 非法');
    const key = this.storageIndex(kind, storageKey);
    const current = this.byStorage.get(key);
    if (current) {
      if (current.displayName !== displayName) {
        current.displayName = displayName;
        this.persist();
      }
      return clone(current);
    }
    const record: LocalAssetIdentity = {
      assetId: this.newId(),
      kind,
      storageKey,
      displayName,
    };
    this.index(record);
    this.persist();
    return clone(record);
  }

  /**
   * 文件系统扫描使用的批量登记：只为首次发现的 storageKey 生成身份，不覆盖既有 displayName，
   * 并且整批最多写一次 manifest，避免 GET 列表按资产数同步 fsync。
   */
  ensureDiscovered(
    entries: readonly { kind: AssetKind; storageKey: string; displayName: string }[],
  ): LocalAssetIdentity[] {
    let changed = false;
    const out: LocalAssetIdentity[] = [];
    for (const entry of entries) {
      if (!isSafeAssetFileName(entry.storageKey)) throw new TypeError('storageKey 非法');
      if (!safeDisplayName(entry.displayName)) throw new TypeError('displayName 非法');
      const key = this.storageIndex(entry.kind, entry.storageKey);
      let record = this.byStorage.get(key);
      if (!record) {
        record = {
          assetId: this.newId(),
          kind: entry.kind,
          storageKey: entry.storageKey,
          displayName: entry.displayName,
        };
        this.index(record);
        changed = true;
      }
      out.push(clone(record));
    }
    if (changed) this.persist();
    return out;
  }

  get(kind: AssetKind, assetId: string): LocalAssetIdentity | null {
    if (!isLocalAssetId(assetId)) return null;
    const record = this.byId.get(assetId);
    return record?.kind === kind ? clone(record) : null;
  }

  getById(assetId: string): LocalAssetIdentity | null {
    if (!isLocalAssetId(assetId)) return null;
    const record = this.byId.get(assetId);
    return record ? clone(record) : null;
  }

  findByStorageKey(kind: AssetKind, storageKey: string): LocalAssetIdentity | null {
    if (!isSafeAssetFileName(storageKey)) return null;
    const record = this.byStorage.get(this.storageIndex(kind, storageKey));
    return record ? clone(record) : null;
  }

  /**
   * 兼容期解析：opaque assetId 优先；旧文件名只作为服务端内部 storageKey 返回。
   * 调用方必须继续通过 resolveAsset/readRevisioned* 验证文件确实存在。
   */
  resolveReference(kind: AssetKind, reference: unknown): { storageKey: string; assetId: string | null; legacy: boolean } | null {
    if (typeof reference !== 'string') return null;
    const value = reference.trim();
    if (isLocalAssetId(value)) {
      const record = this.get(kind, value);
      return record ? { storageKey: record.storageKey, assetId: record.assetId, legacy: false } : null;
    }
    if (!isSafeAssetFileName(value)) return null;
    const record = this.findByStorageKey(kind, value);
    return { storageKey: value, assetId: record?.assetId ?? null, legacy: true };
  }

  /** 受控重命名保持 assetId；实际文件 rename 必须由上层在同一提交协议中完成。 */
  rename(assetId: string, nextStorageKey: string, nextDisplayName: string): LocalAssetIdentity {
    if (!isSafeAssetFileName(nextStorageKey)) throw new TypeError('nextStorageKey 非法');
    if (!safeDisplayName(nextDisplayName)) throw new TypeError('nextDisplayName 非法');
    const current = this.byId.get(assetId);
    if (!current) throw new Error('assetId 不存在');
    const nextIndex = this.storageIndex(current.kind, nextStorageKey);
    const occupied = this.byStorage.get(nextIndex);
    if (occupied && occupied.assetId !== assetId) throw new Error('storageKey 已被其它资产占用');
    this.byStorage.delete(this.storageIndex(current.kind, current.storageKey));
    current.storageKey = nextStorageKey;
    current.displayName = nextDisplayName;
    this.byStorage.set(nextIndex, current);
    this.persist();
    return clone(current);
  }

  list(kind?: AssetKind): LocalAssetIdentity[] {
    return [...this.byId.values()]
      .filter((record) => kind === undefined || record.kind === kind)
      .map(clone)
      .sort((a, b) => a.assetId.localeCompare(b.assetId));
  }
}
