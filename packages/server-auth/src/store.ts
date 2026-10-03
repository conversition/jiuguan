/**
 * AuthStore：auth.sqlite 的**打开顺序**与 digest-only 数据访问（A1-02 第 2 步）。
 *
 * 打开顺序（交接说明 §4.3，顺序本身就是安全不变量）：
 * 1. 维护态 fail-closed → 2. 解析 active generation（缺失/越界/reparse/保护）→
 * 3. 读 manifest → 4. DB 与 root key 必须**成对存在** →
 * 5. storage binding 必须与 root key 派生值一致 → 6. 文件头预检（不经过 SQLite）→
 * 7. **只读**打开核对 `application_id` / `user_version` / auth_meta → 8. 确认可迁移后才读写打开并逐版事务迁移。
 *
 * 硬要求：
 * - `openAuthStore()` **永不**自动创建 key、空库或 generation；缺失就是失败。
 * - `AuthStore` 只接收 selector、**用途匹配的** 32 字节 digest 与业务字段；
 *   不接受完整 token / Cookie / pairing code / CSRF / capability 明文。
 * - 不导出裸 `DatabaseSync`、任意 SQL、root key 或通用 HMAC/HKDF。
 * - WAL 模式下 `synchronous=FULL`：吊销与 attempts 不能为吞吐降级。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createAuthCrypto,
  isAuthSelector,
  type AuthCrypto,
  type AuthSelector,
  type ProtectedDigest,
} from './crypto.ts';
import {
  AUTH_DB_APPLICATION_ID,
  AUTH_SCHEMA_VERSION,
  applyAuthMigrations,
  inspectAuthDatabaseFile,
  readAuthApplicationId,
  readAuthSchemaVersion,
} from './schema.ts';
import {
  assertAncestorChainNoReparsePoint,
  assertPathProtected,
  establishPathProtection,
  fsyncDirectorySync,
  type DurabilityCapability,
} from './platform-protection.ts';
import { createInstanceRootKeyFile, destroyRootKey, readInstanceRootKeyFile } from './root-key.ts';
import { AuthStorageError } from './storage-error.ts';
import {
  ACTIVE_POINTER_NAME,
  assertMaintenanceClear,
  buildGenerationId,
  createAuthStorageLayout,
  readActiveGeneration,
  readGenerationManifest,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
  writeActiveGeneration,
  writeGenerationManifest,
  type AuthGenerationManifest,
  type AuthGenerationPaths,
  type AuthStorageLayout,
} from './storage-layout.ts';
import {
  isAuthTransportValue,
  isDevicePlatformValue,
  isDeviceScopeValue,
  parseVocabularyArray,
  type AuthTransportValue,
  type DevicePlatformValue,
  type DeviceScopeValue,
} from './vocabulary.ts';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
/**
 * `lastSeenAt` 最多每 5 分钟落库一次，避免每请求写盘（device 与 session 同一策略）。
 * WAL + `synchronous=FULL` 下一次写入就是一次 fsync，绝不能放在每请求路径上。
 */
export const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
/** @deprecated 用 `LAST_SEEN_INTERVAL_MS`；保留旧名避免 A2 接线时破坏引用。 */
export const SESSION_LAST_SEEN_INTERVAL_MS = LAST_SEEN_INTERVAL_MS;

export interface AuthStoreOptions {
  readonly dataDir: string;
  /** 是否允许执行迁移；默认 false。只有显式启动/bootstrap 路径才应开启。 */
  readonly migrate?: boolean;
  /** 可注入时钟（测试用）；默认系统 UTC ISO 时间。 */
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface AuthStoreMeta {
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly securityEpoch: number;
  readonly storageBinding: string;
  /** 本次写入实际获得的耐久性能力（Windows 为 rename-only）。 */
  readonly durability: DurabilityCapability;
}

// ---------------------------------------------------------------- 记录类型

interface DeviceFields {
  readonly selector: AuthSelector;
  readonly credentialDigest: ProtectedDigest<'device-credential'>;
  readonly displayName: string;
  readonly platform: DevicePlatformValue;
  readonly scopes: readonly DeviceScopeValue[];
  readonly transports: readonly AuthTransportValue[];
  readonly clientInstanceId?: string | null;
  readonly securityEpoch: number;
  readonly createdAt?: string;
}

interface SessionFields {
  readonly selector: AuthSelector;
  readonly credentialDigest: ProtectedDigest<'device-credential'>;
  readonly csrfEpoch: number;
  readonly deviceId: string;
  readonly transport: AuthTransportValue;
  readonly expiresAt: string;
  readonly issuedAt?: string;
  readonly securityEpoch: number;
}

interface PairingFields {
  readonly selector: AuthSelector;
  readonly codeDigest: ProtectedDigest<'pairing-code'>;
  readonly allowedScopes: readonly DeviceScopeValue[];
  readonly allowedTransports: readonly AuthTransportValue[];
  readonly expiresAt: string;
  readonly attemptsRemaining?: number;
  readonly displayNameHint?: string | null;
  readonly createdAt?: string;
  readonly securityEpoch: number;
}

interface CapabilityFields {
  readonly selector: AuthSelector;
  readonly digest: ProtectedDigest<'asset-capability'>;
  readonly assetId: string;
  readonly targetDigest: string;
  readonly purpose: string;
  readonly sessionSelector: AuthSelector;
  readonly allowedMethods: readonly string[];
  readonly rangePolicy: string;
  readonly expiresAt: string;
  readonly requestsRemaining: number;
  readonly bytesRemaining: number;
  readonly reservationVersion: number;
  readonly issuedAt?: string;
}

export interface AuthDeviceRecord {
  readonly deviceId: string;
  readonly selector: string;
  readonly credentialDigest: Uint8Array;
  readonly displayName: string;
  readonly platform: DevicePlatformValue;
  readonly scopes: readonly DeviceScopeValue[];
  readonly transports: readonly AuthTransportValue[];
  readonly clientInstanceId: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly securityEpoch: number;
}

export interface AuthSessionRecord {
  readonly selector: string;
  readonly publicId: string;
  readonly credentialDigest: Uint8Array;
  readonly csrfEpoch: number;
  readonly deviceId: string;
  readonly transport: AuthTransportValue;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly securityEpoch: number;
}

export interface AuthPairingRecord {
  readonly pairingId: string;
  readonly selector: string;
  readonly codeDigest: Uint8Array;
  readonly allowedScopes: readonly DeviceScopeValue[];
  readonly allowedTransports: readonly AuthTransportValue[];
  readonly displayNameHint: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly attemptsRemaining: number;
  readonly consumedAt: string | null;
  readonly consumedDeviceId: string | null;
  readonly revokedAt: string | null;
  readonly securityEpoch: number;
}

export interface AuthAssetCapabilityRecord {
  readonly selector: string;
  readonly digest: Uint8Array;
  readonly assetId: string;
  readonly targetDigest: string;
  readonly purpose: string;
  readonly sessionSelector: string;
  readonly allowedMethods: readonly string[];
  readonly rangePolicy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requestsRemaining: number;
  readonly bytesRemaining: number;
  readonly reservationVersion: number;
  readonly revokedAt: string | null;
}

export type AssetCapabilityReservation =
  | { ok: true; record: AuthAssetCapabilityRecord }
  | { ok: false };

export interface AuthAuditEntry {
  readonly action: string;
  readonly decision: string;
  readonly status: number;
  readonly requestId?: string | null;
  readonly routeTemplate?: string | null;
  readonly reasonCode?: string | null;
  readonly deviceId?: string | null;
  readonly sessionPublicId?: string | null;
  readonly latencyBucket?: string | null;
  readonly bytesBucket?: string | null;
  readonly occurredAt?: string;
  readonly context?: 'startup' | 'pairing' | 'auth' | 'logout' | 'asset' | 'admin';
  readonly detail?: string;
}

export interface AuthAuditRecord {
  readonly id: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly decision: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly routeTemplate: string | null;
  readonly reasonCode: string | null;
  readonly deviceId: string | null;
  readonly sessionPublicId: string | null;
}

export interface ConsumeSessionDraft extends Omit<SessionFields, 'deviceId'> {
  /** 省略（或传空）时绑定本次新建的 device。 */
  readonly deviceId?: string;
}

export interface ConsumePairingInput {
  readonly pairingSelector: AuthSelector;
  readonly device: DeviceFields;
  readonly session: ConsumeSessionDraft;
}

export interface ConsumePairingResult {
  readonly device: AuthDeviceRecord;
  readonly session: AuthSessionRecord;
}

// ---------------------------------------------------------------- 行解析

type SqlRow = Record<string, unknown>;

function asString(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new AuthStorageError('record-invalid', `${field} 不是字符串`);
  }
  return value;
}

function asNullableString(row: SqlRow, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new AuthStorageError('record-invalid', `${field} 不是字符串`);
  }
  return value;
}

function asInteger(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AuthStorageError('record-invalid', `${field} 不是整数`);
  }
  return value;
}

function asBytes(row: SqlRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new AuthStorageError('record-invalid', `${field} 不是字节串`);
  }
  return value;
}

/** 磁盘上的 scopes/transports 必须重新走词表严格验证，未知值 fail-closed。 */
function asScopeArray(row: SqlRow, field: string): readonly DeviceScopeValue[] {
  const raw = asString(row, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthStorageError('record-invalid', `${field} 不是合法 JSON`);
  }
  const values = parseVocabularyArray(parsed, isDeviceScopeValue);
  if (!values) throw new AuthStorageError('record-invalid', `${field} 含未知或重复 scope`);
  return values;
}

function asTransportArray(row: SqlRow, field: string): readonly AuthTransportValue[] {
  const raw = asString(row, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthStorageError('record-invalid', `${field} 不是合法 JSON`);
  }
  const values = parseVocabularyArray(parsed, isAuthTransportValue);
  if (!values) throw new AuthStorageError('record-invalid', `${field} 含未知或重复 transport`);
  return values;
}

function asStringArray(row: SqlRow, field: string): readonly string[] {
  const raw = asString(row, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthStorageError('record-invalid', `${field} 不是合法 JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new AuthStorageError('record-invalid', `${field} 不是字符串数组`);
  }
  return parsed as string[];
}

function asPlatform(row: SqlRow, field: string): DevicePlatformValue {
  const value = row[field];
  if (!isDevicePlatformValue(value)) {
    throw new AuthStorageError('record-invalid', `${field} 平台取值未知`);
  }
  return value;
}

function asTransport(row: SqlRow, field: string): AuthTransportValue {
  const value = row[field];
  if (!isAuthTransportValue(value)) {
    throw new AuthStorageError('record-invalid', `${field} transport 取值未知`);
  }
  return value;
}

// ---------------------------------------------------------------- 入参校验

function requireSelector(value: unknown, field: string): AuthSelector {
  if (!isAuthSelector(value)) {
    throw new AuthStorageError('invalid-layout', `${field} 不是合法的 24 位小写 hex selector`);
  }
  return value;
}

function requireScopes(value: unknown, field: string): readonly DeviceScopeValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuthStorageError('invalid-layout', `${field} 必须是非空数组`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isDeviceScopeValue(entry)) {
      throw new AuthStorageError('invalid-layout', `${field} 含未知 scope`);
    }
    if (seen.has(entry)) throw new AuthStorageError('invalid-layout', `${field} 含重复 scope`);
    seen.add(entry);
  }
  return value as readonly DeviceScopeValue[];
}

function requireTransports(value: unknown, field: string): readonly AuthTransportValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuthStorageError('invalid-layout', `${field} 必须是非空数组`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isAuthTransportValue(entry)) {
      throw new AuthStorageError('invalid-layout', `${field} 含未知 transport`);
    }
    if (seen.has(entry)) throw new AuthStorageError('invalid-layout', `${field} 含重复 transport`);
    seen.add(entry);
  }
  return value as readonly AuthTransportValue[];
}

function requirePlatform(value: unknown): DevicePlatformValue {
  if (!isDevicePlatformValue(value)) {
    throw new AuthStorageError('invalid-layout', 'platform 取值未知');
  }
  return value;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new AuthStorageError('invalid-layout', `${field} 长度非法`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AuthStorageError('invalid-layout', `${field} 不是合法时间`);
  }
  return value;
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new AuthStorageError('invalid-layout', `${field} 必须是 ${min}..${max} 的整数`);
  }
  return Number(value);
}

/**
 * 非空字符串数组（用于 capability 的 allowedMethods）。
 * 写入侧就校验元素类型：否则会写进一个读回时必然被 `asStringArray` 判为
 * `record-invalid` 的行，把错误推迟到读取路径。
 */
function requireStringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new AuthStorageError('invalid-layout', `${field} 必须是非空且不超过 16 项的数组`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > max) {
      throw new AuthStorageError('invalid-layout', `${field} 每项都必须是有界非空字符串`);
    }
    if (seen.has(entry)) throw new AuthStorageError('invalid-layout', `${field} 含重复项`);
    seen.add(entry);
  }
  return [...value] as string[];
}

/** 把 ProtectedDigest 复制成可写入 BLOB 的字节，用后立即清零。 */
/** 恢复路径专用：只接受 32 字节 digest 字节串（绝不接受明文）。 */
function requireBytes32(value: unknown, field: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new AuthStorageError('invalid-layout', `${field} 必须是 32 字节`);
  }
  return Buffer.from(value);
}

function takeDigest(
  digest: ProtectedDigest<'device-credential' | 'pairing-code' | 'asset-capability'>,
  expectedPurpose: string,
): Buffer {
  if (!digest || typeof digest.copyForStorage !== 'function') {
    throw new AuthStorageError('invalid-layout', `digest 不是 ProtectedDigest`);
  }
  if (digest.purpose !== expectedPurpose) {
    throw new AuthStorageError(
      'invalid-layout',
      `digest 用途不符：期望 ${expectedPurpose}，实际 ${String(digest.purpose)}`,
    );
  }
  const bytes = digest.copyForStorage();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new AuthStorageError('invalid-layout', 'digest 必须是 32 字节');
  }
  return Buffer.from(bytes);
}

function buildId(): string {
  return randomBytes(12).toString('hex');
}

function parseDevice(row: SqlRow): AuthDeviceRecord {
  return {
    deviceId: asString(row, 'device_id'),
    selector: asString(row, 'selector'),
    credentialDigest: asBytes(row, 'credential_digest'),
    displayName: asString(row, 'display_name'),
    platform: asPlatform(row, 'platform'),
    scopes: asScopeArray(row, 'scopes_json'),
    transports: asTransportArray(row, 'transports_json'),
    clientInstanceId: asNullableString(row, 'client_instance_id'),
    createdAt: asString(row, 'created_at'),
    lastSeenAt: asNullableString(row, 'last_seen_at'),
    revokedAt: asNullableString(row, 'revoked_at'),
    securityEpoch: asInteger(row, 'security_epoch'),
  };
}

function parseSession(row: SqlRow): AuthSessionRecord {
  return {
    selector: asString(row, 'selector'),
    publicId: asString(row, 'public_id'),
    credentialDigest: asBytes(row, 'credential_digest'),
    csrfEpoch: asInteger(row, 'csrf_epoch'),
    deviceId: asString(row, 'device_id'),
    transport: asTransport(row, 'transport'),
    issuedAt: asString(row, 'issued_at'),
    expiresAt: asString(row, 'expires_at'),
    lastSeenAt: asNullableString(row, 'last_seen_at'),
    revokedAt: asNullableString(row, 'revoked_at'),
    securityEpoch: asInteger(row, 'security_epoch'),
  };
}

function parsePairing(row: SqlRow): AuthPairingRecord {
  return {
    pairingId: asString(row, 'pairing_id'),
    selector: asString(row, 'selector'),
    codeDigest: asBytes(row, 'code_digest'),
    allowedScopes: asScopeArray(row, 'allowed_scopes_json'),
    allowedTransports: asTransportArray(row, 'allowed_transports_json'),
    displayNameHint: asNullableString(row, 'display_name_hint'),
    createdAt: asString(row, 'created_at'),
    expiresAt: asString(row, 'expires_at'),
    attemptsRemaining: asInteger(row, 'attempts_remaining'),
    consumedAt: asNullableString(row, 'consumed_at'),
    consumedDeviceId: asNullableString(row, 'consumed_device_id'),
    revokedAt: asNullableString(row, 'revoked_at'),
    securityEpoch: asInteger(row, 'security_epoch'),
  };
}

function parseCapability(row: SqlRow): AuthAssetCapabilityRecord {
  return {
    selector: asString(row, 'selector'),
    digest: asBytes(row, 'digest'),
    assetId: asString(row, 'asset_id'),
    targetDigest: asString(row, 'target_digest'),
    purpose: asString(row, 'purpose'),
    sessionSelector: asString(row, 'session_selector'),
    allowedMethods: asStringArray(row, 'allowed_methods_json'),
    rangePolicy: asString(row, 'range_policy'),
    issuedAt: asString(row, 'issued_at'),
    expiresAt: asString(row, 'expires_at'),
    requestsRemaining: asInteger(row, 'requests_remaining'),
    bytesRemaining: asInteger(row, 'bytes_remaining'),
    reservationVersion: asInteger(row, 'reservation_version'),
    revokedAt: asNullableString(row, 'revoked_at'),
  };
}

function parseAudit(row: SqlRow): AuthAuditRecord {
  return {
    id: asInteger(row, 'id'),
    occurredAt: asString(row, 'occurred_at'),
    action: asString(row, 'action'),
    decision: asString(row, 'decision'),
    status: asInteger(row, 'status'),
    requestId: asNullableString(row, 'request_id'),
    routeTemplate: asNullableString(row, 'route_template'),
    reasonCode: asNullableString(row, 'reason_code'),
    deviceId: asNullableString(row, 'device_id'),
    sessionPublicId: asNullableString(row, 'session_public_id'),
  };
}

/** 把 SQLite 约束错误映射成稳定错误码，而不是把驱动原文抛给上层。 */
function mapSqliteError(error: unknown, context: string): AuthStorageError {
  // 我们自己抛的类型化错误原样透出：入参校验失败不能被包装成 io-failed。
  if (error instanceof AuthStorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('UNIQUE constraint failed')) {
    return new AuthStorageError('conflict', `${context}：唯一约束冲突`);
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new AuthStorageError('not-found', `${context}：外键指向的记录不存在`);
  }
  if (message.includes('CHECK constraint failed')) {
    return new AuthStorageError('invalid-layout', `${context}：数据不满足 schema 约束`);
  }
  if (message.includes('database is locked')) {
    return new AuthStorageError('conflict', `${context}：数据库被其它写入者占用`);
  }
  if (message.includes('readonly')) {
    return new AuthStorageError('conflict', `${context}：连接只读`);
  }
  return new AuthStorageError('io-failed', `${context}：${message}`);
}

/** 每连接都必须重新设置的 PRAGMA；WAL 下认证状态坚持 `synchronous=FULL`。 */
function applyConnectionPragmas(db: DatabaseSync, busyTimeoutMs: number): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(busyTimeoutMs))};`);
}

export interface InitializeAuthStorageOptions {
  readonly dataDir: string;
  readonly securityEpoch?: number;
  readonly now?: () => string;
  /**
   * 已存在 active generation 时是否允许新建并切换。
   * 默认 **false**：跨世代轮换（备份恢复/重置）只应由 A1-03 的恢复流程显式开启，
   * 否则同一 dataDir 上的二次 bootstrap 会静默孤立旧世代（旧 device/session/capability 全部失联）。
   */
  readonly allowRotation?: boolean;
}

export interface InitializeAuthStorageResult {
  readonly layout: AuthStorageLayout;
  readonly generationId: string;
  readonly storageBinding: string;
  readonly securityEpoch: number;
}

/**
 * 显式 bootstrap：建立一个完整且自洽的新 generation。
 *
 * **只允许 bootstrap / 恢复流程调用**；`openAuthStore()` 永远不会走到这里。
 * 顺序保证"要么有一个完整世代，要么什么都没激活"：
 * 建目录 → 建根密钥 → 写 manifest → 建库并迁移 → 写 auth_meta → **最后**原子切换 active pointer。
 * 中途失败时不会有 active pointer，遗留的 generation 目录是惰性的（不做递归删除）。
 */
export interface BuildAuthGenerationOptions {
  readonly dataDir: string;
  readonly securityEpoch?: number;
  readonly now?: () => string;
  readonly allowRotation?: boolean;
}

export interface BuiltAuthGeneration {
  readonly layout: AuthStorageLayout;
  readonly generationId: string;
  readonly storageBinding: string;
  readonly securityEpoch: number;
  readonly generation: AuthGenerationPaths;
}

/**
 * 建一个**完整但不激活**的世代（目录、根密钥、manifest、DB、auth_meta 全部就绪）。
 *
 * 激活（唯一原子切换点：写 active pointer）由调用方在**验证通过之后**执行 ——
 * `initializeAuthStorage()` 就是"建完即激活"的快捷方式；A1-03 的 restore 需要先验证再激活，
 * 因此必须用本函数而不是 initializeAuthStorage。
 */
export function buildAuthGeneration(options: BuildAuthGenerationOptions): BuiltAuthGeneration {
  const now = options.now ?? (() => new Date().toISOString());
  const layout = createAuthStorageLayout(options.dataDir);
  // 已有激活世代时默认拒绝：隐式新建会让旧世代（及其全部凭据）无声失联。
  if (existsSync(layout.activePointerPath) && options.allowRotation !== true) {
    throw new AuthStorageError(
      'conflict',
      `已存在 ${ACTIVE_POINTER_NAME}，拒绝隐式新建世代；跨世代轮换需显式 allowRotation`,
    );
  }
  const generationId = buildGenerationId();
  const generation = resolveGenerationPaths(layout, generationId);
  if (existsSync(generation.generationDir)) {
    throw new AuthStorageError('conflict', 'generation 目录已存在，拒绝复用');
  }
  assertAncestorChainNoReparsePoint(generation.generationDir);
  mkdirSync(generation.generationDir, { mode: 0o700 });
  establishPathProtection(generation.generationDir, 'directory');

  createInstanceRootKeyFile(generation.rootKeyPath);

  const rootKey = readInstanceRootKeyFile(generation.rootKeyPath);
  let crypto: AuthCrypto;
  let storageBinding: string;
  try {
    crypto = createAuthCrypto(rootKey);
    const binding = crypto.deriveStorageBinding(generationId as AuthSelector);
    storageBinding = Buffer.from(binding.copyForStorage()).toString('hex');
    binding.destroy();
  } finally {
    destroyRootKey(rootKey);
  }

  try {
    const securityEpoch = options.securityEpoch ?? 1;
    const manifest: AuthGenerationManifest = {
      version: 1,
      generationId,
      schemaVersion: AUTH_SCHEMA_VERSION,
      securityEpoch,
      storageBinding,
      createdAt: now(),
    };
    writeGenerationManifest(layout, manifest);

    const db = new DatabaseSync(generation.authDbPath);
    try {
      applyConnectionPragmas(db, DEFAULT_BUSY_TIMEOUT_MS);
      applyAuthMigrations(db, { from: 0 });
      db.prepare(
        `INSERT INTO auth_meta
           (id, schema_version, security_epoch, generation_id, storage_binding, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      ).run(AUTH_SCHEMA_VERSION, securityEpoch, generationId, storageBinding, now());
    } catch (error) {
      throw error instanceof AuthStorageError ? error : mapSqliteError(error, '初始化 auth.sqlite');
    } finally {
      try {
        db.close();
      } catch {
        /* 关闭失败不改变"初始化是否成功"的结论 */
      }
    }

    assertPathProtected(generation.authDbPath, 'file');
    fsyncDirectorySync(generation.generationDir);
    // 注意：这里**不**写 active pointer —— 激活是调用方的唯一原子切换点。
  } finally {
    crypto.destroy();
  }

  return {
    layout,
    generationId,
    storageBinding,
    securityEpoch: options.securityEpoch ?? 1,
    generation,
  };
}

export function initializeAuthStorage(
  options: InitializeAuthStorageOptions,
): InitializeAuthStorageResult {
  const built = buildAuthGeneration(options);
  // 唯一激活点：完整世代就绪后一次原子切换。
  writeActiveGeneration(built.layout, built.generationId);
  return {
    layout: built.layout,
    generationId: built.generationId,
    storageBinding: built.storageBinding,
    securityEpoch: built.securityEpoch,
  };
}

export class AuthStore {
  readonly #db: DatabaseSync;
  readonly #crypto: AuthCrypto;
  #meta: AuthStoreMeta;
  readonly #now: () => string;
  #closed = false;

  private constructor(db: DatabaseSync, crypto: AuthCrypto, meta: AuthStoreMeta, now: () => string) {
    this.#db = db;
    this.#crypto = crypto;
    this.#meta = meta;
    this.#now = now;
  }

  /**
   * 打开顺序见文件头注释。第 7 步的只读探测连接一定会被关闭；
   * 只有确认版本可迁移（且调用方允许迁移）时才会读写打开。
   */
  static open(options: AuthStoreOptions): AuthStore {
    const layout = resolveAuthStorageLayout(options.dataDir);
    // 1) 维护态：即使只是读取也必须 fail-closed。
    assertMaintenanceClear(layout);
    // 2) active generation：缺失、越界、reparse point、保护不足都在这里拒绝。
    const generationId = readActiveGeneration(layout);
    return AuthStore.openVerifiedGeneration({
      layout,
      generationId,
      now: options.now,
      busyTimeoutMs: options.busyTimeoutMs,
      migrate: options.migrate,
    });
  }

  /**
   * 备份/恢复专用：打开**指定**世代（不解析 active pointer、不做维护态检查 ——
   * 恢复流程本身就在维护态下进行）。其余校验（manifest / binding / 文件头 / 只读识别）
   * 与 `open()` 完全一致，不放宽任何一条。
   */
  static openForGeneration(options: {
    layout: AuthStorageLayout;
    generationId: string;
    now?: () => string;
    busyTimeoutMs?: number;
    migrate?: boolean;
  }): AuthStore {
    return AuthStore.openVerifiedGeneration(options);
  }

  private static openVerifiedGeneration(options: {
    layout: AuthStorageLayout;
    generationId: string;
    now?: () => string;
    busyTimeoutMs?: number;
    migrate?: boolean;
  }): AuthStore {
    const now = options.now ?? (() => new Date().toISOString());
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    const layout = options.layout;
    const generationId = options.generationId;
    const generation = resolveGenerationPaths(layout, generationId);
    const manifest = readGenerationManifest(layout, generationId);
    // manifest 记录的是写下这个世代的构建所支持的 schema 版本。若它高于本构建，
    // 说明该世代由更新的构建创建（可能已有本构建不认识的表/列），必须和 DB 版本一样 fail-closed。
    if (manifest.schemaVersion > AUTH_SCHEMA_VERSION) {
      throw new AuthStorageError(
        'schema-future',
        `manifest.schemaVersion=${manifest.schemaVersion} 高于本构建支持的 ${AUTH_SCHEMA_VERSION}`,
      );
    }

    // 3) DB 与 key 必须成对存在，缺任一都 fail-closed（绝不自动补建）。
    if (!existsSync(generation.authDbPath)) {
      throw new AuthStorageError(
        'auth-db-missing',
        `generation ${generationId} 缺少 auth.sqlite，拒绝自动创建（需显式 bootstrap 或恢复）`,
      );
    }
    assertPathProtected(generation.authDbPath, 'file');
    if (!existsSync(generation.rootKeyPath)) {
      throw new AuthStorageError(
        'root-key-missing',
        `generation ${generationId} 缺少根密钥，拒绝自动重建（否则会使全部已签发凭据失效）`,
      );
    }

    const rootKey = readInstanceRootKeyFile(generation.rootKeyPath);
    let crypto: AuthCrypto;
    try {
      crypto = createAuthCrypto(rootKey);
    } finally {
      destroyRootKey(rootKey);
    }

    try {
      // 4) storage binding：manifest 必须与 root key 的派生值一致。
      if (!crypto.verifyStorageBinding(generationId, Buffer.from(manifest.storageBinding, 'hex'))) {
        throw new AuthStorageError(
          'binding-mismatch',
          'manifest 的 storage binding 与根密钥派生值不一致（DB/key 不是同一世代）',
        );
      }

      // 5) 文件头预检：不经过 SQLite，先把"不是本项目的库"和"被截断/损坏"分开。
      const header = inspectAuthDatabaseFile(generation.authDbPath);
      if (header.userVersion > AUTH_SCHEMA_VERSION) {
        throw new AuthStorageError(
          'schema-future',
          `库版本 ${header.userVersion} 高于本构建支持的 ${AUTH_SCHEMA_VERSION}`,
        );
      }

      // 6) 只读识别：核对 application_id / user_version / auth_meta。
      const probe = new DatabaseSync(generation.authDbPath, { readOnly: true });
      let version: number;
      try {
        const applicationId = readAuthApplicationId(probe);
        if (applicationId !== AUTH_DB_APPLICATION_ID) {
          throw new AuthStorageError(
            'application-id-mismatch',
            `application_id=0x${applicationId.toString(16)} 不是本项目的认证库`,
          );
        }
        version = readAuthSchemaVersion(probe);
        if (version > AUTH_SCHEMA_VERSION) {
          throw new AuthStorageError(
            'schema-future',
            `库版本 ${version} 高于本构建支持的 ${AUTH_SCHEMA_VERSION}`,
          );
        }
        if (version >= 1) {
          const metaRow = probe.prepare('SELECT * FROM auth_meta WHERE id = 1').get() as
            | SqlRow
            | undefined;
          if (!metaRow) {
            throw new AuthStorageError('record-invalid', 'auth_meta 缺少唯一元数据行');
          }
          const dbGeneration = asString(metaRow, 'generation_id');
          const dbBinding = asString(metaRow, 'storage_binding');
          const dbEpoch = asInteger(metaRow, 'security_epoch');
          if (dbGeneration !== generationId || dbBinding !== manifest.storageBinding
            || dbEpoch !== manifest.securityEpoch) {
            throw new AuthStorageError(
              'binding-mismatch',
              'auth_meta 的 generation/binding/epoch 与 manifest 不一致',
            );
          }
        }
      } catch (error) {
        if (error instanceof AuthStorageError) throw error;
        throw mapSqliteError(error, '只读识别 auth.sqlite');
      } finally {
        try {
          probe.close();
        } catch {
          /* 探测连接关闭失败不影响后续判断 */
        }
      }

      if (version < AUTH_SCHEMA_VERSION && options.migrate !== true) {
        throw new AuthStorageError(
          'schema-outdated',
          `库版本 ${version} 需要迁移到 ${AUTH_SCHEMA_VERSION}，但本次打开未授权迁移`,
        );
      }

      // 7) 读写打开（必要时先迁移；迁移后同步 manifest 与 auth_meta 的版本号）。
      const db = new DatabaseSync(generation.authDbPath);
      const durability: DurabilityCapability = fsyncDirectorySync(generation.generationDir)
        ? 'directory-fsync'
        : 'rename-only';
      try {
        applyConnectionPragmas(db, busyTimeoutMs);
        const liveVersion = readAuthSchemaVersion(db);
        if (liveVersion < AUTH_SCHEMA_VERSION) {
          applyAuthMigrations(db, { from: liveVersion });
          // 迁移会重建/新增表：这里把元数据行补成与 manifest 一致，避免留下半自洽的库。
          db.prepare(
            `INSERT INTO auth_meta
               (id, schema_version, security_epoch, generation_id, storage_binding, updated_at)
             VALUES (1, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               schema_version = excluded.schema_version,
               security_epoch = excluded.security_epoch,
               generation_id = excluded.generation_id,
               storage_binding = excluded.storage_binding,
               updated_at = excluded.updated_at`,
          ).run(
            AUTH_SCHEMA_VERSION,
            manifest.securityEpoch,
            generationId,
            manifest.storageBinding,
            now(),
          );
          writeGenerationManifest(layout, { ...manifest, schemaVersion: AUTH_SCHEMA_VERSION });
        }
      } catch (error) {
        try {
          db.close();
        } catch {
          /* 已关闭 */
        }
        crypto.destroy();
        throw error instanceof AuthStorageError ? error : mapSqliteError(error, '打开 auth.sqlite');
      }

      return new AuthStore(db, crypto, {
        generationId,
        schemaVersion: AUTH_SCHEMA_VERSION,
        securityEpoch: manifest.securityEpoch,
        storageBinding: manifest.storageBinding,
        durability,
      }, now);
    } catch (error) {
      // 打开失败时销毁派生密钥，避免把半可用状态留在上层。
      try {
        crypto.destroy();
      } catch {
        /* 可能已在内层销毁 */
      }
      throw error;
    }
  }

  get meta(): AuthStoreMeta {
    return this.#meta;
  }

  #assertOpen(): void {
    if (this.#closed) throw new AuthStorageError('conflict', 'AuthStore 已关闭');
  }

  #get(sql: string, ...params: unknown[]): SqlRow | null {
    const row = this.#db.prepare(sql).get(...(params as never[]));
    return (row as SqlRow | undefined) ?? null;
  }

  #all(sql: string, ...params: unknown[]): SqlRow[] {
    return this.#db.prepare(sql).all(...(params as never[])) as SqlRow[];
  }

  #run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.#db.prepare(sql).run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  // ------------------------------------------------------------ device

  createDevice(input: DeviceFields): AuthDeviceRecord {
    this.#assertOpen();
    const selector = requireSelector(input.selector, 'selector');
    const digest = takeDigest(input.credentialDigest, 'device-credential');
    const scopes = requireScopes(input.scopes, 'scopes');
    const transports = requireTransports(input.transports, 'transports');
    const deviceId = buildId();
    const createdAt = requireTimestamp(input.createdAt ?? this.#now(), 'createdAt');
    try {
      this.#run(
        `INSERT INTO auth_device
           (device_id, selector, credential_digest, display_name, platform, scopes_json,
            transports_json, client_instance_id, created_at, last_seen_at, revoked_at, security_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        deviceId,
        selector,
        digest,
        requireText(input.displayName, 'displayName', 64),
        requirePlatform(input.platform),
        JSON.stringify(scopes),
        JSON.stringify(transports),
        input.clientInstanceId == null
          ? null
          : requireText(input.clientInstanceId, 'clientInstanceId', 64),
        createdAt,
        requireBoundedInteger(input.securityEpoch, 'securityEpoch', 1, Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      throw mapSqliteError(error, '写入 auth_device');
    } finally {
      digest.fill(0);
    }
    const record = this.findDeviceBySelector(selector);
    if (!record) throw new AuthStorageError('not-found', '刚写入的 device 读不回来');
    return record;
  }

  findDeviceBySelector(selector: AuthSelector): AuthDeviceRecord | null {
    this.#assertOpen();
    const row = this.#get('SELECT * FROM auth_device WHERE selector = ?', requireSelector(selector, 'selector'));
    return row ? parseDevice(row) : null;
  }

  findDeviceById(deviceId: string): AuthDeviceRecord | null {
    this.#assertOpen();
    const row = this.#get('SELECT * FROM auth_device WHERE device_id = ?', requireText(deviceId, 'deviceId', 64));
    return row ? parseDevice(row) : null;
  }

  /** 全量设备列表（管理路由用）；按创建时间排序。 */
  listDevices(): AuthDeviceRecord[] {
    this.#assertOpen();
    return (this.#all('SELECT * FROM auth_device ORDER BY created_at ASC, device_id ASC') as SqlRow[])
      .map(parseDevice);
  }

  revokeDevice(deviceId: string, at?: string): boolean {
    this.#assertOpen();
    const result = this.#run(
      'UPDATE auth_device SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
      requireTimestamp(at ?? this.#now(), 'revokedAt'),
      requireText(deviceId, 'deviceId', 64),
    );
    return result.changes === 1;
  }

  /**
   * 节流落库：只有距上次写入超过 `minIntervalMs` 才更新。
   * 与 session 同一策略 —— device 的 lastSeen 也可能被每请求调用，不能直接写盘。
   */
  touchDeviceLastSeen(
    deviceId: string,
    at?: string,
    minIntervalMs: number = LAST_SEEN_INTERVAL_MS,
  ): boolean {
    this.#assertOpen();
    const seenAt = requireTimestamp(at ?? this.#now(), 'lastSeenAt');
    const threshold = new Date(Date.parse(seenAt) - Math.max(0, minIntervalMs)).toISOString();
    const result = this.#run(
      'UPDATE auth_device SET last_seen_at = ? WHERE device_id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)',
      seenAt,
      requireText(deviceId, 'deviceId', 64),
      threshold,
    );
    return result.changes === 1;
  }

  countDevices(): number {
    this.#assertOpen();
    return asInteger(this.#get('SELECT COUNT(*) AS c FROM auth_device') ?? { c: 0 }, 'c');
  }

  countSessions(): number {
    this.#assertOpen();
    return asInteger(this.#get('SELECT COUNT(*) AS c FROM auth_session') ?? { c: 0 }, 'c');
  }

  countPairings(): number {
    this.#assertOpen();
    return asInteger(this.#get('SELECT COUNT(*) AS c FROM auth_pairing') ?? { c: 0 }, 'c');
  }

  countAssetCapabilities(): number {
    this.#assertOpen();
    return asInteger(this.#get('SELECT COUNT(*) AS c FROM auth_asset_capability') ?? { c: 0 }, 'c');
  }

  countUnrevokedDevices(): number {
    this.#assertOpen();
    return asInteger(
      this.#get('SELECT COUNT(*) AS c FROM auth_device WHERE revoked_at IS NULL') ?? { c: 0 },
      'c',
    );
  }

  /**
   * 统计仍持有指定 scope 的未撤销设备数（bootstrap 判定"已存在有效 admin 设备"用）。
   * `scopes_json` 是经 DDL CHECK 与读回双向验证的 JSON 数组；这里用 JSON1 的
   * `json_each` 做成员判定，词表取值由调用方保证（非词表值永远查不到，等价于 0）。
   */
  countUnrevokedDevicesByScope(scope: DeviceScopeValue): number {
    this.#assertOpen();
    if (!isDeviceScopeValue(scope)) {
      throw new AuthStorageError('invalid-layout', `未知 scope：${String(scope)}`);
    }
    return asInteger(
      this.#get(
        `SELECT COUNT(*) AS c FROM auth_device
         WHERE revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM json_each(auth_device.scopes_json) WHERE json_each.value = ?)`,
        scope,
      ) ?? { c: 0 },
      'c',
    );
  }

  /**
   * A1-03 恢复专用：把备份里的设备行导入为**已撤销**状态。
   *
   * 只接受 32 字节 digest（来自备份），绝不接受明文凭据；`revokedAt` 必填 ——
   * 新世代换了根密钥，旧 digest 本就永远无法通过验证，显式撤销是为了留下可审计的痕迹。
   * 不提供 session / pairing / capability 的对应入口：恢复流程按计划清空它们。
   */
  importRevokedDevice(input: {
    readonly selector: AuthSelector;
    readonly credentialDigest: Uint8Array;
    readonly displayName: string;
    readonly platform: DevicePlatformValue;
    readonly scopes: readonly DeviceScopeValue[];
    readonly transports: readonly AuthTransportValue[];
    readonly clientInstanceId?: string | null;
    readonly securityEpoch: number;
    readonly createdAt: string;
    readonly revokedAt: string;
  }): AuthDeviceRecord {
    this.#assertOpen();
    const selector = requireSelector(input.selector, 'selector');
    const digest = requireBytes32(input.credentialDigest, 'credentialDigest');
    const deviceId = buildId();
    try {
      this.#run(
        `INSERT INTO auth_device
           (device_id, selector, credential_digest, display_name, platform, scopes_json,
            transports_json, client_instance_id, created_at, last_seen_at, revoked_at, security_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        deviceId,
        selector,
        digest,
        requireText(input.displayName, 'displayName', 64),
        requirePlatform(input.platform),
        JSON.stringify(requireScopes(input.scopes, 'scopes')),
        JSON.stringify(requireTransports(input.transports, 'transports')),
        input.clientInstanceId == null
          ? null
          : requireText(input.clientInstanceId, 'clientInstanceId', 64),
        requireTimestamp(input.createdAt, 'createdAt'),
        requireTimestamp(input.revokedAt, 'revokedAt'),
        requireBoundedInteger(input.securityEpoch, 'securityEpoch', 1, Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      throw mapSqliteError(error, '导入已撤销设备');
    } finally {
      digest.fill(0);
    }
    const record = this.findDeviceBySelector(selector);
    if (!record) throw new AuthStorageError('not-found', '刚导入的 device 读不回来');
    return record;
  }

  /**
   * A1-03 恢复专用：把备份库里的 auth_device **整表**导入为已撤销状态（单事务，原子）。
   * 源库必须先通过 `verifyAuthBackup` 的精确 schema 校验；逐行复用 `parseDevice` 的严格
   * 验证（scopes/transports 未知值 fail-closed），任一行失败整体回滚。
   * session / pairing / capability 不导入 —— 恢复流程按计划把它们清空。
   */
  importRevokedDevicesFrom(source: DatabaseSync, options: { revokedAt: string }): number {
    this.#assertOpen();
    const rows = source.prepare('SELECT * FROM auth_device').all() as SqlRow[];
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      let count = 0;
      for (const row of rows) {
        const record = parseDevice(row);
        this.importRevokedDevice({
          selector: record.selector as AuthSelector,
          credentialDigest: record.credentialDigest,
          displayName: record.displayName,
          platform: record.platform,
          scopes: record.scopes,
          transports: record.transports,
          clientInstanceId: record.clientInstanceId,
          securityEpoch: record.securityEpoch,
          createdAt: record.createdAt,
          revokedAt: record.revokedAt ?? options.revokedAt,
        });
        count++;
      }
      this.#db.exec('COMMIT;');
      return count;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK;');
      } catch {
        /* 回滚失败不改变"导入失败"的结论 */
      }
      throw error instanceof AuthStorageError ? error : mapSqliteError(error, '批量导入已撤销设备');
    }
  }

  // ------------------------------------------------------------ session

  createSession(input: SessionFields): AuthSessionRecord {
    this.#assertOpen();
    const selector = requireSelector(input.selector, 'selector');
    const digest = takeDigest(input.credentialDigest, 'device-credential');
    const publicId = buildId();
    const issuedAt = requireTimestamp(input.issuedAt ?? this.#now(), 'issuedAt');
    try {
      this.#run(
        `INSERT INTO auth_session
           (selector, public_id, credential_digest, csrf_epoch, device_id, transport,
            issued_at, expires_at, last_seen_at, revoked_at, security_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        selector,
        publicId,
        digest,
        requireBoundedInteger(input.csrfEpoch, 'csrfEpoch', 0, Number.MAX_SAFE_INTEGER),
        requireText(input.deviceId, 'deviceId', 64),
        input.transport,
        issuedAt,
        requireTimestamp(input.expiresAt, 'expiresAt'),
        requireBoundedInteger(input.securityEpoch, 'securityEpoch', 1, Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      throw mapSqliteError(error, '写入 auth_session');
    } finally {
      digest.fill(0);
    }
    const record = this.findSessionBySelector(selector);
    if (!record) throw new AuthStorageError('not-found', '刚写入的 session 读不回来');
    return record;
  }

  findSessionBySelector(selector: AuthSelector): AuthSessionRecord | null {
    this.#assertOpen();
    const row = this.#get('SELECT * FROM auth_session WHERE selector = ?', requireSelector(selector, 'selector'));
    return row ? parseSession(row) : null;
  }

  revokeSession(selector: AuthSelector, at?: string): boolean {
    this.#assertOpen();
    const result = this.#run(
      'UPDATE auth_session SET revoked_at = ? WHERE selector = ? AND revoked_at IS NULL',
      requireTimestamp(at ?? this.#now(), 'revokedAt'),
      requireSelector(selector, 'selector'),
    );
    return result.changes === 1;
  }

  revokeSessionsForDevice(deviceId: string, at?: string): number {
    this.#assertOpen();
    const result = this.#run(
      'UPDATE auth_session SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
      requireTimestamp(at ?? this.#now(), 'revokedAt'),
      requireText(deviceId, 'deviceId', 64),
    );
    return result.changes;
  }

  /**
   * A2-03：吊销设备并**在同一事务内**级联吊销其全部会话 ——
   * 两步分开写会有"设备已吊销但会话仍有效"的窗口。
   */
  revokeDeviceWithSessions(deviceId: string, at?: string): { revoked: boolean; sessions: number } {
    this.#assertOpen();
    const revokedAt = requireTimestamp(at ?? this.#now(), 'revokedAt');
    const checkedId = requireText(deviceId, 'deviceId', 64);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const deviceResult = this.#run(
        'UPDATE auth_device SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
        revokedAt, checkedId,
      );
      const sessionResult = this.#run(
        'UPDATE auth_session SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
        revokedAt, checkedId,
      );
      this.#db.exec('COMMIT;');
      return { revoked: deviceResult.changes === 1, sessions: sessionResult.changes };
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK;');
      } catch {
        /* 回滚失败不改变"操作失败"的结论 */
      }
      throw error instanceof AuthStorageError ? error : mapSqliteError(error, '级联吊销设备');
    }
  }

  /**
   * A2-03 revoke-all：吊销全部设备/会话/未消费配对码，并把 security epoch +1
   *（单一事务）。`keepDeviceId` 用于"保留当前会话所属设备"的默认语义——
   * 注意保留设备其会话仍全部吊销，客户端需重新认证。
   * 返回新 epoch 与各表吊销数量。
   */
  revokeAllForReset(options: { at?: string; keepDeviceId?: string | null } = {}): {
    securityEpoch: number;
    devices: number;
    sessions: number;
    pairings: number;
  } {
    this.#assertOpen();
    const revokedAt = requireTimestamp(options.at ?? this.#now(), 'revokedAt');
    const keep = options.keepDeviceId === undefined || options.keepDeviceId === null
      ? null
      : requireText(options.keepDeviceId, 'keepDeviceId', 64);
    let devices = 0;
    let sessions = 0;
    let pairings = 0;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      devices = this.#run(
        keep === null
          ? 'UPDATE auth_device SET revoked_at = ? WHERE revoked_at IS NULL'
          : 'UPDATE auth_device SET revoked_at = ? WHERE revoked_at IS NULL AND device_id <> ?',
        ...(keep === null ? [revokedAt] : [revokedAt, keep] as const),
      ).changes;
      sessions = this.#run(
        'UPDATE auth_session SET revoked_at = ? WHERE revoked_at IS NULL',
        revokedAt,
      ).changes;
      pairings = this.#run(
        'UPDATE auth_pairing SET revoked_at = ? WHERE revoked_at IS NULL AND consumed_at IS NULL',
        revokedAt,
      ).changes;
      const metaRow = this.#run(
        'UPDATE auth_meta SET security_epoch = security_epoch + 1, updated_at = ? WHERE id = 1',
        revokedAt,
      );
      if (metaRow.changes !== 1) {
        throw new AuthStorageError('record-invalid', 'auth_meta 缺少 id=1 行，无法推进 security epoch');
      }
      this.#db.exec('COMMIT;');
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK;');
      } catch {
        /* 回滚失败不改变"操作失败"的结论 */
      }
      throw error instanceof AuthStorageError ? error : mapSqliteError(error, 'revoke-all');
    }
    // 同步缓存里的 meta（调用方随后读 meta.securityEpoch 应看到新值）。
    const updated = this.#get('SELECT * FROM auth_meta WHERE id = 1') as SqlRow;
    this.#meta = {
      generationId: asString(updated, 'generation_id'),
      schemaVersion: asInteger(updated, 'schema_version'),
      securityEpoch: asInteger(updated, 'security_epoch'),
      storageBinding: asString(updated, 'storage_binding'),
      durability: this.#meta.durability,
    };
    return {
      securityEpoch: this.#meta.securityEpoch,
      devices,
      sessions,
      pairings,
    };
  }

  /** 节流落库：只有距上次写入超过 `minIntervalMs` 才更新，避免每请求写盘。 */
  touchSessionLastSeen(
    selector: AuthSelector,
    at?: string,
    minIntervalMs: number = LAST_SEEN_INTERVAL_MS,
  ): boolean {
    this.#assertOpen();
    const seenAt = requireTimestamp(at ?? this.#now(), 'lastSeenAt');
    const threshold = new Date(Date.parse(seenAt) - Math.max(0, minIntervalMs)).toISOString();
    const result = this.#run(
      'UPDATE auth_session SET last_seen_at = ? WHERE selector = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)',
      seenAt,
      requireSelector(selector, 'selector'),
      threshold,
    );
    return result.changes === 1;
  }

  countActiveSessionsForDevice(deviceId: string, at?: string): number {
    this.#assertOpen();
    const row = this.#get(
      'SELECT COUNT(*) AS c FROM auth_session WHERE device_id = ? AND revoked_at IS NULL AND expires_at > ?',
      requireText(deviceId, 'deviceId', 64),
      requireTimestamp(at ?? this.#now(), 'at'),
    );
    return asInteger(row ?? { c: 0 }, 'c');
  }

  // ------------------------------------------------------------ pairing

  createPairing(input: PairingFields): AuthPairingRecord {
    this.#assertOpen();
    const selector = requireSelector(input.selector, 'selector');
    const digest = takeDigest(input.codeDigest, 'pairing-code');
    const pairingId = buildId();
    const createdAt = requireTimestamp(input.createdAt ?? this.#now(), 'createdAt');
    try {
      this.#run(
        `INSERT INTO auth_pairing
           (pairing_id, selector, code_digest, allowed_scopes_json, allowed_transports_json,
            display_name_hint, created_at, expires_at, attempts_remaining, consumed_at,
            consumed_device_id, revoked_at, security_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        pairingId,
        selector,
        digest,
        JSON.stringify(requireScopes(input.allowedScopes, 'allowedScopes')),
        JSON.stringify(requireTransports(input.allowedTransports, 'allowedTransports')),
        input.displayNameHint == null
          ? null
          : requireText(input.displayNameHint, 'displayNameHint', 64),
        createdAt,
        requireTimestamp(input.expiresAt, 'expiresAt'),
        requireBoundedInteger(input.attemptsRemaining ?? 5, 'attemptsRemaining', 0, 10),
        requireBoundedInteger(input.securityEpoch, 'securityEpoch', 1, Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      throw mapSqliteError(error, '写入 auth_pairing');
    } finally {
      digest.fill(0);
    }
    const record = this.findPairingBySelector(selector);
    if (!record) throw new AuthStorageError('not-found', '刚写入的 pairing 读不回来');
    return record;
  }

  findPairingBySelector(selector: AuthSelector): AuthPairingRecord | null {
    this.#assertOpen();
    const rows = this.#all(
      'SELECT * FROM auth_pairing WHERE selector = ?',
      requireSelector(selector, 'selector'),
    );
    if (rows.length > 1) {
      throw new AuthStorageError('record-invalid', 'pairing selector 命中多于一行');
    }
    return rows.length === 1 ? parsePairing(rows[0]) : null;
  }

  /** 错误尝试计数：受控递减，返回剩余次数。耗尽后再调用返回 0。 */
  /**
   * 撤销一个尚未消费的配对码（管理操作）。已消费的码无法"再撤销"——返回 false。
   */
  revokePairing(selector: AuthSelector, at?: string): boolean {
    this.#assertOpen();
    const result = this.#run(
      'UPDATE auth_pairing SET revoked_at = ? WHERE selector = ? AND revoked_at IS NULL AND consumed_at IS NULL',
      requireTimestamp(at ?? this.#now(), 'revokedAt'),
      requireSelector(selector, 'selector'),
    );
    return result.changes === 1;
  }

  decrementPairingAttempts(selector: AuthSelector): number {
    this.#assertOpen();
    this.#run(
      'UPDATE auth_pairing SET attempts_remaining = attempts_remaining - 1 WHERE selector = ? AND attempts_remaining > 0',
      requireSelector(selector, 'selector'),
    );
    const record = this.findPairingBySelector(selector);
    return record?.attemptsRemaining ?? 0;
  }

  /**
   * 原子兑换：查询、`consumed_at` 受控更新、device/session 创建、digest 写入在**同一个**
   * `BEGIN IMMEDIATE` 事务里。两个并发兑换最多一个成功 —— 第二个要么在 `UPDATE` 上拿到
   * `changes = 0`，要么被写锁挡住直到第一个提交。
   */
  consumePairing(input: ConsumePairingInput): ConsumePairingResult {
    this.#assertOpen();
    const pairingSelector = requireSelector(input.pairingSelector, 'pairingSelector');

    // 事务开始前把所有会抛错的入参校验与 digest 复制做完。
    const deviceSelector = requireSelector(input.device.selector, 'device.selector');
    const sessionSelector = requireSelector(input.session.selector, 'session.selector');
    const deviceDigest = takeDigest(input.device.credentialDigest, 'device-credential');
    const sessionDigest = takeDigest(input.session.credentialDigest, 'device-credential');
    const deviceId = buildId();
    const publicId = buildId();
    const now = input.device.createdAt ?? this.#now();
    // 省略 session.deviceId 时绑定本次新建的 device。
    const sessionDeviceId = input.session.deviceId && input.session.deviceId.length > 0
      ? input.session.deviceId
      : deviceId;

    let deviceScopes: readonly DeviceScopeValue[];
    let deviceTransports: readonly AuthTransportValue[];
    try {
      deviceScopes = requireScopes(input.device.scopes, 'device.scopes');
      deviceTransports = requireTransports(input.device.transports, 'device.transports');
      requirePlatform(input.device.platform);
      requireText(input.device.displayName, 'device.displayName', 64);
      requireBoundedInteger(input.device.securityEpoch, 'device.securityEpoch', 1, Number.MAX_SAFE_INTEGER);
      requireTimestamp(now, 'now');
      requireTimestamp(input.session.expiresAt, 'session.expiresAt');
      requireBoundedInteger(input.session.csrfEpoch, 'session.csrfEpoch', 0, Number.MAX_SAFE_INTEGER);
      requireBoundedInteger(input.session.securityEpoch, 'session.securityEpoch', 1, Number.MAX_SAFE_INTEGER);
      requireText(sessionDeviceId, 'session.deviceId', 64);

      this.#db.exec('BEGIN IMMEDIATE;');
      try {
        const row = this.#get('SELECT * FROM auth_pairing WHERE selector = ?', pairingSelector);
        if (!row) throw new AuthStorageError('pairing-unavailable', '配对记录不存在');
        const pairing = parsePairing(row);
        if (pairing.revokedAt !== null) {
          throw new AuthStorageError('pairing-unavailable', '配对已撤销');
        }
        if (pairing.consumedAt !== null) {
          throw new AuthStorageError('pairing-unavailable', '配对已被兑换');
        }
        if (pairing.expiresAt <= now) {
          throw new AuthStorageError('pairing-unavailable', '配对已过期');
        }
        if (pairing.attemptsRemaining <= 0) {
          throw new AuthStorageError('pairing-unavailable', '配对尝试次数已用尽');
        }

        // device 必须先落地：auth_pairing.consumed_device_id 有外键指向它。
        this.#run(
          `INSERT INTO auth_device
             (device_id, selector, credential_digest, display_name, platform, scopes_json,
              transports_json, client_instance_id, created_at, last_seen_at, revoked_at, security_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          deviceId,
          deviceSelector,
          deviceDigest,
          input.device.displayName,
          input.device.platform,
          JSON.stringify(deviceScopes),
          JSON.stringify(deviceTransports),
          input.device.clientInstanceId == null ? null : input.device.clientInstanceId,
          now,
          input.device.securityEpoch,
        );

        // 受控更新：只有仍然"未兑换且未撤销"的行会被改动，`changes = 1` 就是"本次兑换胜出"的证明。
        const consumed = this.#run(
          `UPDATE auth_pairing SET consumed_at = ?, consumed_device_id = ?
             WHERE selector = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
          now,
          deviceId,
          pairingSelector,
        );
        if (consumed.changes !== 1) {
          throw new AuthStorageError('pairing-unavailable', '配对已被并发兑换');
        }

        this.#run(
          `INSERT INTO auth_session
             (selector, public_id, credential_digest, csrf_epoch, device_id, transport,
              issued_at, expires_at, last_seen_at, revoked_at, security_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          sessionSelector,
          publicId,
          sessionDigest,
          input.session.csrfEpoch,
          sessionDeviceId,
          input.session.transport,
          input.session.issuedAt ?? now,
          input.session.expiresAt,
          input.session.securityEpoch,
        );

        this.#db.exec('COMMIT;');
      } catch (error) {
        try {
          this.#db.exec('ROLLBACK;');
        } catch {
          /* 回滚失败不改变"兑换失败"的结论 */
        }
        throw error instanceof AuthStorageError
          ? error
          : mapSqliteError(error, '兑换配对');
      }
    } finally {
      deviceDigest.fill(0);
      sessionDigest.fill(0);
    }

    const device = this.findDeviceBySelector(deviceSelector);
    const session = this.findSessionBySelector(sessionSelector);
    if (!device || !session) {
      throw new AuthStorageError('not-found', '兑换成功后读不回 device/session');
    }
    return { device, session };
  }

  // ------------------------------------------------------------ capability

  insertAssetCapability(input: CapabilityFields): AuthAssetCapabilityRecord {
    this.#assertOpen();
    const selector = requireSelector(input.selector, 'selector');
    const digest = takeDigest(input.digest, 'asset-capability');
    try {
      this.#run(
        `INSERT INTO auth_asset_capability
           (selector, digest, asset_id, target_digest, purpose, session_selector,
            allowed_methods_json, range_policy, issued_at, expires_at, requests_remaining,
            bytes_remaining, reservation_version, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        selector,
        digest,
        requireText(input.assetId, 'assetId', 256),
        requireText(input.targetDigest, 'targetDigest', 64),
        requireText(input.purpose, 'purpose', 32),
        requireSelector(input.sessionSelector, 'sessionSelector'),
        JSON.stringify(requireStringArray(input.allowedMethods, 'allowedMethods', 16)),
        requireText(input.rangePolicy, 'rangePolicy', 64),
        requireTimestamp(input.issuedAt ?? this.#now(), 'issuedAt'),
        requireTimestamp(input.expiresAt, 'expiresAt'),
        requireBoundedInteger(input.requestsRemaining, 'requestsRemaining', 0, Number.MAX_SAFE_INTEGER),
        requireBoundedInteger(input.bytesRemaining, 'bytesRemaining', 0, Number.MAX_SAFE_INTEGER),
        requireBoundedInteger(input.reservationVersion, 'reservationVersion', 0, Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      throw mapSqliteError(error, '写入 auth_asset_capability');
    } finally {
      digest.fill(0);
    }
    const record = this.findAssetCapabilityBySelector(selector);
    if (!record) throw new AuthStorageError('not-found', '刚写入的 capability 读不回来');
    return record;
  }

  findAssetCapabilityBySelector(selector: AuthSelector): AuthAssetCapabilityRecord | null {
    this.#assertOpen();
    const row = this.#get(
      'SELECT * FROM auth_asset_capability WHERE selector = ?',
      requireSelector(selector, 'selector'),
    );
    return row ? parseCapability(row) : null;
  }

  revokeAssetCapability(selector: AuthSelector, at?: string): boolean {
    this.#assertOpen();
    const result = this.#run(
      'UPDATE auth_asset_capability SET revoked_at = ? WHERE selector = ? AND revoked_at IS NULL',
      requireTimestamp(at ?? this.#now(), 'revokedAt'),
      requireSelector(selector, 'selector'),
    );
    return result.changes === 1;
  }

  /**
   * 在单条 SQLite UPDATE 中预扣一次读取及完整响应字节预算。
   * 并发调用只能有满足 WHERE 条件的请求成功，不存在读后写超卖窗口。
   */
  reserveAssetCapability(
    selector: AuthSelector,
    options: { bytes: number; now?: string },
  ): AssetCapabilityReservation {
    this.#assertOpen();
    const id = requireSelector(selector, 'selector');
    const bytes = requireBoundedInteger(options.bytes, 'bytes', 0, Number.MAX_SAFE_INTEGER);
    const now = requireTimestamp(options.now ?? this.#now(), 'now');
    const result = this.#run(
      `UPDATE auth_asset_capability
          SET requests_remaining = requests_remaining - 1,
              bytes_remaining = bytes_remaining - ?,
              reservation_version = reservation_version + 1
        WHERE selector = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          AND requests_remaining >= 1
          AND bytes_remaining >= ?`,
      bytes,
      id,
      now,
      bytes,
    );
    if (result.changes !== 1) return { ok: false };
    const record = this.findAssetCapabilityBySelector(id);
    if (!record) throw new AuthStorageError('not-found', 'capability 预扣后读不回来');
    return { ok: true, record };
  }

  // ------------------------------------------------------------ audit

  appendAudit(entry: AuthAuditEntry): number {
    this.#assertOpen();
    const result = this.#run(
      `INSERT INTO auth_audit
         (occurred_at, request_id, action, route_template, decision, reason_code,
          device_id, session_public_id, status, latency_bucket, bytes_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      requireTimestamp(entry.occurredAt ?? this.#now(), 'occurredAt'),
      entry.requestId ?? null,
      requireText(entry.action, 'action', 64),
      entry.routeTemplate ?? null,
      requireText(entry.decision, 'decision', 32),
      entry.reasonCode ?? null,
      entry.deviceId ?? null,
      entry.sessionPublicId ?? null,
      requireBoundedInteger(entry.status, 'status', 100, 599),
      entry.latencyBucket ?? null,
      entry.bytesBucket ?? null,
    );
    return result.lastInsertRowid;
  }

  recentAudit(limit = 50): AuthAuditRecord[] {
    this.#assertOpen();
    const rows = this.#all(
      'SELECT * FROM auth_audit ORDER BY occurred_at DESC, id DESC LIMIT ?',
      requireBoundedInteger(limit, 'limit', 1, 1_000),
    );
    return rows.map(parseAudit);
  }

  countAudit(): number {
    this.#assertOpen();
    return asInteger(this.#get('SELECT COUNT(*) AS c FROM auth_audit') ?? { c: 0 }, 'c');
  }

  /** 关闭连接并销毁派生密钥。可重复调用。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#crypto.destroy();
    try {
      this.#db.close();
    } catch {
      /* 已关闭或连接失效：不改变"已关闭"的事实 */
    }
  }
}

/** 独立函数形态的打开入口；只做编排，顺序见 `AuthStore.open`。 */
export function openAuthStore(options: AuthStoreOptions): AuthStore {
  return AuthStore.open(options);
}
