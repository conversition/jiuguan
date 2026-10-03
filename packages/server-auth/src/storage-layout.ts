/**
 * 认证安全存储的布局与 generation 切换点。
 *
 * 布局（交接说明 §4.1，从一开始就用 generation + 单一 active pointer，避免以后把独立
 * DB/key 硬改成成组切换）：
 *
 * ```text
 * <dataDir>/security/
 *   active-generation          # 唯一原子切换点，只保存已验证 generation id
 *   maintenance.json           # 持久 fail-closed 标记
 *   generations/
 *     <24-hex-generation>/
 *       auth.sqlite
 *       instance-root.key
 *       manifest.json
 * ```
 *
 * 本模块只负责"路径、指针、维护标记、manifest"的读写与校验，**不创建密钥、不建库**。
 * 安全数据固定在 `security/` 下，绝不放进 `data/*.db`（否则会被 `/api/sessions` 当成剧情会话）。
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertAncestorChainNoReparsePoint,
  assertNoReparsePoint,
  assertPathProtected,
  establishPathProtection,
  fsyncDirectorySync,
  type DurabilityCapability,
} from './platform-protection.ts';
import { AuthStorageError } from './storage-error.ts';

// 数据库级常量由 schema.ts 拥有（单一事实源），这里转出以保持既有导入面不变。
export { AUTH_DB_APPLICATION_ID, AUTH_SCHEMA_VERSION } from './schema.ts';

export const SECURITY_DIR_NAME = 'security';
export const GENERATIONS_DIR_NAME = 'generations';
export const ACTIVE_POINTER_NAME = 'active-generation';
export const MAINTENANCE_FILE_NAME = 'maintenance.json';
export const AUTH_DB_FILE_NAME = 'auth.sqlite';
export const ROOT_KEY_FILE_NAME = 'instance-root.key';
export const MANIFEST_FILE_NAME = 'manifest.json';

/** generation id：12 字节小写 hex（24 字符），与 selector 同形状但语义独立。 */
export const GENERATION_ID_RE = /^[a-f0-9]{24}$/;

export function isValidGenerationId(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_ID_RE.test(value);
}

export interface AuthStorageLayout {
  readonly dataDir: string;
  readonly securityDir: string;
  readonly generationsDir: string;
  readonly activePointerPath: string;
  readonly maintenancePath: string;
}

export interface AuthGenerationPaths {
  readonly generationId: string;
  readonly generationDir: string;
  readonly authDbPath: string;
  readonly rootKeyPath: string;
  readonly manifestPath: string;
}

/** 纯路径计算，不触碰文件系统。 */
export function resolveAuthStorageLayout(dataDir: string): AuthStorageLayout {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new AuthStorageError('invalid-layout', 'dataDir 不能为空');
  }
  const securityDir = join(dataDir, SECURITY_DIR_NAME);
  return {
    dataDir,
    securityDir,
    generationsDir: join(securityDir, GENERATIONS_DIR_NAME),
    activePointerPath: join(securityDir, ACTIVE_POINTER_NAME),
    maintenancePath: join(securityDir, MAINTENANCE_FILE_NAME),
  };
}

export function resolveGenerationPaths(
  layout: AuthStorageLayout,
  generationId: string,
): AuthGenerationPaths {
  if (!isValidGenerationId(generationId)) {
    throw new AuthStorageError('invalid-generation-id', `generation id 非法：${String(generationId)}`);
  }
  const generationDir = join(layout.generationsDir, generationId);
  return {
    generationId,
    generationDir,
    authDbPath: join(generationDir, AUTH_DB_FILE_NAME),
    rootKeyPath: join(generationDir, ROOT_KEY_FILE_NAME),
    manifestPath: join(generationDir, MANIFEST_FILE_NAME),
  };
}

/**
 * 创建 security/ 与 generations/ 目录并**建立**可验证保护。
 * **不**创建 generation、密钥或数据库 —— 那些属于显式 bootstrap。
 *
 * A1R-03：顺序改为"先验后写"。
 * 1. 创建前逐级验证所有**已存在**的祖先目录不是 reparse point；
 * 2. 每次只创建一层（非递归），立刻收紧并验证，通过后才创建下一层；
 * 3. 失败只清理本函数刚创建、路径可信、且为空的精确目录，**不用**递归删除。
 *
 * `dataDir`（应用用户数据目录）必须由调用方先行创建：本模块不递归创建祖先链，
 * 否则就无法在创建之前验证这些祖先。
 */
export function createAuthStorageLayout(dataDir: string): AuthStorageLayout {
  const layout = resolveAuthStorageLayout(dataDir);

  assertAncestorChainNoReparsePoint(layout.securityDir);
  let dataStats;
  try {
    dataStats = statSync(layout.dataDir);
  } catch {
    throw new AuthStorageError('io-failed', `dataDir 不存在或不可读：${layout.dataDir}`);
  }
  if (!dataStats.isDirectory()) {
    throw new AuthStorageError('invalid-layout', `dataDir 不是目录：${layout.dataDir}`);
  }

  // 第 1 层：security/
  const createdSecurity = !existsSync(layout.securityDir);
  if (createdSecurity) {
    // 创建动作之前再验一次：缩短祖先被替换成 junction 的窗口。
    assertAncestorChainNoReparsePoint(layout.securityDir);
    try {
      mkdirSync(layout.securityDir, { mode: 0o700 });
    } catch (error) {
      throw new AuthStorageError(
        'io-failed',
        `创建 ${SECURITY_DIR_NAME} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    establishPathProtection(layout.securityDir, 'directory');
  } catch (error) {
    if (createdSecurity) removeIfCreatedAndEmpty(layout.securityDir);
    throw error;
  }

  // 第 2 层：generations/
  const createdGenerations = !existsSync(layout.generationsDir);
  if (createdGenerations) {
    assertAncestorChainNoReparsePoint(layout.generationsDir);
    try {
      mkdirSync(layout.generationsDir, { mode: 0o700 });
    } catch (error) {
      if (createdSecurity) removeIfCreatedAndEmpty(layout.securityDir);
      throw new AuthStorageError(
        'io-failed',
        `创建 ${GENERATIONS_DIR_NAME} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    establishPathProtection(layout.generationsDir, 'directory');
  } catch (error) {
    if (createdGenerations) removeIfCreatedAndEmpty(layout.generationsDir);
    if (createdSecurity) removeIfCreatedAndEmpty(layout.securityDir);
    throw error;
  }

  return layout;
}

/**
 * 只清理"本函数刚创建、且确认为空"的目录。
 * 用非递归 `rmdirSync`：目录一旦非空（说明已被别的写入者使用）就保留现场，绝不递归删除。
 */
function removeIfCreatedAndEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* 非空或不可删：保留现场，交由人工/上层处理 */
  }
}

export interface AtomicWriteResult {
  /** 本次写入之后实际获得的耐久性能力（Windows 只能是 rename-only）。 */
  readonly durability: DurabilityCapability;
}

/**
 * 认证文件的原子写：同目录临时文件 → fsync → 建立/校验保护 → rename → 目录 fsync。
 *
 * A1R-04 的三点要求：
 * - 临时文件与最终文件都**显式收紧并校验**。临时文件的校验必须在 rename **之前**完成，
 *   否则改名之后才发现保护不合格时，敏感内容其实已经落到最终位置；
 * - 内容 flush 之后才 rename；
 * - 耐久性走平台能力探测：POSIX 额外 fsync 父目录；Windows 无法 fsync 目录句柄（实测 EPERM），
 *   降级为 rename-only，并由返回值显式暴露该边界，供 A1-03 的 crash fixture 使用。
 */
export function writeAuthFileAtomic(target: string, contents: string): AtomicWriteResult {
  const dir = dirname(target);
  assertAncestorChainNoReparsePoint(target);
  if (!existsSync(dir)) {
    throw new AuthStorageError('io-failed', `写入目标目录不存在：${dir}`);
  }

  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd: number | undefined;
  try {
    // 'wx' = O_CREAT | O_EXCL：不会覆盖同名的残留临时文件。
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
    // Windows 上必须先关闭句柄，否则后面的 rename 会失败。
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不改变"写入是否可信"的结论 */
      }
    }
    removeFileIfExists(tmp);
    throw new AuthStorageError(
      'io-failed',
      `写入 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    establishPathProtection(tmp, 'file');
    renameSync(tmp, target);
  } catch (error) {
    removeFileIfExists(tmp);
    throw new AuthStorageError(
      'io-failed',
      `提交 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 最终文件同样必须显式可验证，不能只依赖"临时文件当时是安全的"。
  assertPathProtected(target, 'file');
  const durability: DurabilityCapability = fsyncDirectorySync(dir) ? 'directory-fsync' : 'rename-only';
  return { durability };
}

/** 单个文件的尽力清理；只用 `unlinkSync`，绝不递归删除。 */
function removeFileIfExists(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* 清理失败不影响既有文件的安全性 */
  }
}

export interface AuthMaintenanceLease {
  /** 32 位小写 hex；恢复/备份的破坏性步骤必须出示它，普通布尔参数不算锁。 */
  readonly token: string;
  readonly reason: string;
  readonly acquiredAt: string;
}

export interface AuthMaintenanceState {
  readonly active: boolean;
  readonly reason?: string;
  readonly updatedAt?: string;
  readonly lease?: AuthMaintenanceLease;
}

/** 维护租约 token 形状：32 位小写 hex。 */
export const MAINTENANCE_LEASE_RE = /^[a-f0-9]{32}$/;

/** 生成一个维护租约 token（16 字节 CSPRNG）。 */
export function buildMaintenanceLeaseToken(): string {
  return randomBytes(16).toString('hex');
}

/** 解析维护标记里的租约字段；形状不符返回 null（调用方按 fail-closed 处理）。 */
export function parseMaintenanceLease(value: unknown): AuthMaintenanceLease | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== 'string' || !MAINTENANCE_LEASE_RE.test(record.token)) return null;
  if (typeof record.reason !== 'string' || record.reason.length === 0 || record.reason.length > 200) return null;
  if (typeof record.acquiredAt !== 'string' || Number.isNaN(Date.parse(record.acquiredAt))) return null;
  return { token: record.token, reason: record.reason, acquiredAt: record.acquiredAt };
}

/** 维护标记的一次读取结果。 */
export type MaintenanceReadOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'content'; readonly raw: string }
  | { readonly kind: 'unreadable'; readonly code: string | null };

/** 只有 `ENOENT` 才算"文件缺失"。 */
export function isAbsentFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * 纯判定：把一次读取结果映射为维护态（便于注入式测试）。
 *
 * A1R-01：**只有 `ENOENT` 视为未维护**。权限拒绝、I-O 故障、被占用、目标是目录等
 * 全都返回"维护中"。旧实现把所有读取异常都当成"文件缺失"并返回 `active:false`，
 * 会在存储已不可读时错误解除维护态，直接把远程入口放开。
 */
export function classifyMaintenanceRead(outcome: MaintenanceReadOutcome): AuthMaintenanceState {
  if (outcome.kind === 'absent') return { active: false };
  if (outcome.kind === 'unreadable') {
    return { active: true, reason: outcome.code ? `maintenance-unreadable:${outcome.code}` : 'maintenance-unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.raw);
  } catch {
    return { active: true, reason: 'maintenance-invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { active: true, reason: 'maintenance-invalid' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.active !== true) return { active: false };
  // 租约字段存在但形状不符：无法确认锁的状态，按 fail-closed 处理（不能当作无锁）。
  if (record.lease !== undefined && parseMaintenanceLease(record.lease) === null) {
    return { active: true, reason: 'maintenance-lease-invalid' };
  }
  const lease = record.lease === undefined ? undefined : (parseMaintenanceLease(record.lease) ?? undefined);
  return {
    active: true,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(lease ? { lease } : {}),
  };
}

/**
 * 读取持久维护标记（fail-closed）。
 * - `ENOENT` → 未维护。
 * - 其它读取错误 → 视为**正在维护**，并带上具体 errno。
 * - 内容无法解析 → 视为**正在维护**。
 */
export function readMaintenanceState(layout: AuthStorageLayout): AuthMaintenanceState {
  let raw: string;
  try {
    raw = readFileSync(layout.maintenancePath, 'utf8');
  } catch (error) {
    if (isAbsentFileError(error)) return classifyMaintenanceRead({ kind: 'absent' });
    const code = (error as { code?: unknown }).code;
    return classifyMaintenanceRead({
      kind: 'unreadable',
      code: typeof code === 'string' ? code : null,
    });
  }
  return classifyMaintenanceRead({ kind: 'content', raw });
}

export function writeMaintenanceState(
  layout: AuthStorageLayout,
  state: AuthMaintenanceState,
): void {
  const payload = {
    active: state.active === true,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    // 租约必须随标记一起持久化：清维护态时不写 lease 字段即等于释放租约。
    ...(state.lease === undefined ? {} : { lease: state.lease }),
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  writeAuthFileAtomic(layout.maintenancePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/** 取得维护租约：写入后必须能回读确认，写不进去就抛错（不能"以为拿到了锁"）。 */
export function acquireMaintenanceLease(
  layout: AuthStorageLayout,
  options: { reason: string; now?: string },
): AuthMaintenanceLease {
  // 已处于维护态时不允许抢占：我们无法区分"对方还活着"和"对方刚死"，
  // 抢占会让真正的持有者以为自己仍持有锁。恢复流程应先验证/释放既有租约。
  const current = readMaintenanceState(layout);
  if (current.active) {
    throw new AuthStorageError(
      'conflict',
      current.lease
        ? `已有维护租约（token 前 8 位 ${current.lease.token.slice(0, 8)}…，${current.lease.reason}），拒绝抢占`
        : '维护标记处于激活态但没有租约（旧格式或被改写），拒绝覆盖；需人工确认后清除',
    );
  }
  const reason = typeof options.reason === 'string' && options.reason.length > 0
    ? options.reason
    : 'auth-maintenance';
  const lease: AuthMaintenanceLease = {
    token: buildMaintenanceLeaseToken(),
    reason,
    acquiredAt: options.now ?? new Date().toISOString(),
  };
  writeMaintenanceState(layout, { active: true, reason, lease });
  const confirmed = readMaintenanceState(layout);
  if (!confirmed.active || confirmed.lease?.token !== lease.token) {
    throw new AuthStorageError(
      'maintenance-unreadable',
      '维护租约写入后无法回读确认，拒绝继续（可能存储不可读或被并发改写）',
    );
  }
  return lease;
}

/**
 * 破坏性步骤（恢复/重置）的准入检查：必须出示与持久化租约一致的 token。
 * 缺 token / 不在维护态 / 标记无租约（旧格式或被人为改写）都不放行。
 */
export function assertMaintenanceLease(layout: AuthStorageLayout, token: unknown): AuthMaintenanceLease {
  if (typeof token !== 'string' || !MAINTENANCE_LEASE_RE.test(token)) {
    throw new AuthStorageError('lease-required', '缺少合法的维护租约 token，拒绝执行破坏性步骤');
  }
  const state = readMaintenanceState(layout);
  if (!state.active) {
    throw new AuthStorageError('lease-required', '认证存储不在维护态，拒绝执行破坏性步骤');
  }
  if (!state.lease) {
    throw new AuthStorageError('lease-required', '维护标记没有租约（旧格式或被改写），拒绝继续');
  }
  if (state.lease.token !== token) {
    throw new AuthStorageError('lease-mismatch', '维护租约 token 不匹配，拒绝继续');
  }
  return state.lease;
}

/** 释放租约（只在 token 匹配时）；成功后回到非维护态。 */
export function releaseMaintenanceLease(layout: AuthStorageLayout, token: unknown): void {
  assertMaintenanceLease(layout, token);
  writeMaintenanceState(layout, { active: false });
}

/** 维护期间必须拒绝所有读写入口；调用方不得用普通布尔参数绕过。 */
export function assertMaintenanceClear(layout: AuthStorageLayout): void {
  const state = readMaintenanceState(layout);
  if (state.active) {
    throw new AuthStorageError(
      'maintenance-active',
      `认证存储处于维护状态${state.reason ? `（${state.reason}）` : ''}，远程入口必须保持关闭`,
    );
  }
}

/** 生成一个全新的 generation id（12 字节 CSPRNG）。 */
export function buildGenerationId(): string {
  // 与 crypto.ts 一致：只使用系统 CSPRNG。
  return randomBytes(12).toString('hex');
}

/**
 * 读取 active pointer。缺失、格式非法、或指向不存在的 generation 目录都 fail-closed，
 * 绝不"自动挑一个目录"。
 */
export function readActiveGeneration(layout: AuthStorageLayout): string {
  assertAncestorChainNoReparsePoint(layout.activePointerPath);
  let raw: string;
  try {
    raw = readFileSync(layout.activePointerPath, 'utf8');
  } catch {
    throw new AuthStorageError(
      'active-pointer-missing',
      `缺少 ${ACTIVE_POINTER_NAME}，无法确定当前认证世代`,
    );
  }
  const generationId = raw.trim();
  if (!isValidGenerationId(generationId)) {
    throw new AuthStorageError('active-pointer-invalid', 'active-generation 内容不是 24 位小写 hex');
  }
  const generation = resolveGenerationPaths(layout, generationId);
  if (!existsSync(generation.generationDir)) {
    throw new AuthStorageError(
      'generation-missing',
      `active-generation 指向不存在的世代 ${generationId}`,
    );
  }
  assertAncestorChainNoReparsePoint(generation.generationDir);
  assertNoReparsePoint(generation.generationDir);
  assertPathProtected(generation.generationDir, 'directory');
  return generationId;
}

/** 原子切换 active pointer。这是唯一的"激活"动作。 */
export function writeActiveGeneration(layout: AuthStorageLayout, generationId: string): void {
  if (!isValidGenerationId(generationId)) {
    throw new AuthStorageError('invalid-generation-id', `generation id 非法：${String(generationId)}`);
  }
  const generation = resolveGenerationPaths(layout, generationId);
  if (!existsSync(generation.generationDir)) {
    throw new AuthStorageError(
      'generation-missing',
      `拒绝把指针指向不存在的世代 ${generationId}`,
    );
  }
  // 激活只**验证**世代目录保护，不在写指针时顺手改 ACL。
  assertAncestorChainNoReparsePoint(generation.generationDir);
  assertPathProtected(generation.generationDir, 'directory');
  writeAuthFileAtomic(layout.activePointerPath, `${generationId}\n`);
}

export interface AuthGenerationManifest {
  readonly version: 1;
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly securityEpoch: number;
  /** storage binding 摘要（hex）；用于确认 DB 与 root key 属于同一世代。 */
  readonly storageBinding: string;
  readonly createdAt: string;
}

const MANIFEST_BINDING_RE = /^[a-f0-9]{64}$/;

export function writeGenerationManifest(
  layout: AuthStorageLayout,
  manifest: AuthGenerationManifest,
): void {
  const generation = resolveGenerationPaths(layout, manifest.generationId);
  // manifest 记录 binding 与 epoch，不能落进未受保护的目录。
  assertAncestorChainNoReparsePoint(generation.manifestPath);
  assertPathProtected(generation.generationDir, 'directory');
  writeAuthFileAtomic(generation.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readGenerationManifest(
  layout: AuthStorageLayout,
  generationId: string,
): AuthGenerationManifest {
  const generation = resolveGenerationPaths(layout, generationId);
  let raw: string;
  try {
    raw = readFileSync(generation.manifestPath, 'utf8');
  } catch {
    throw new AuthStorageError(
      'manifest-missing',
      `generation ${generationId} 缺少 ${MANIFEST_FILE_NAME}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AuthStorageError('manifest-invalid', 'manifest.json 不是合法 JSON');
  }
  if (parsed.version !== 1) {
    throw new AuthStorageError('manifest-invalid', 'manifest.version 必须是 1');
  }
  if (!isValidGenerationId(parsed.generationId) || parsed.generationId !== generationId) {
    throw new AuthStorageError('manifest-invalid', 'manifest.generationId 与目录不一致');
  }
  if (!Number.isInteger(parsed.schemaVersion) || Number(parsed.schemaVersion) < 1) {
    throw new AuthStorageError('manifest-invalid', 'manifest.schemaVersion 非法');
  }
  if (!Number.isInteger(parsed.securityEpoch) || Number(parsed.securityEpoch) < 1) {
    throw new AuthStorageError('manifest-invalid', 'manifest.securityEpoch 非法');
  }
  if (typeof parsed.storageBinding !== 'string' || !MANIFEST_BINDING_RE.test(parsed.storageBinding)) {
    throw new AuthStorageError('manifest-invalid', 'manifest.storageBinding 必须是 64 位小写 hex');
  }
  if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new AuthStorageError('manifest-invalid', 'manifest.createdAt 不是合法时间');
  }
  return {
    version: 1,
    generationId: parsed.generationId,
    schemaVersion: Number(parsed.schemaVersion),
    securityEpoch: Number(parsed.securityEpoch),
    storageBinding: parsed.storageBinding,
    createdAt: parsed.createdAt,
  };
}
