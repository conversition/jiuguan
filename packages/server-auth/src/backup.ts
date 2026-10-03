/**
 * A1-03 前半：最小 auth-only 备份。
 *
 * 硬要求（总清单 §17 / 交接说明 §5）：
 * - 复用同一 storage layout、ACL 适配器与持久 `maintenance.json`；备份持有**维护租约**，
 *   破坏性步骤必须出示 token，普通布尔参数不算锁。
 * - 副本用 `VACUUM INTO` 从**只读连接**生成（实测可行）：源库绝不被写，也不复制活跃 WAL
 *   （副本是单文件，不需要 -wal/-shm 就能读）。
 * - 副本必须只读通过 integrity_check —— **实测损坏可能只落在 free space**，
 *   `SELECT` 依然成功，所以"打开/查询成功"不构成任何证据，必须显式跑 integrity_check。
 * - `VACUUM INTO` **拒绝覆盖已存在文件**（实测 output file already exists），因此备份目录
 *   必须为空或不存在，绝不覆盖历史备份。
 * - 任何阶段失败都**不释放**租约：维护态保持，远程入口关闭；只有全流程成功才清除。
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertAncestorChainNoReparsePoint, establishPathProtection } from './platform-protection.ts';
import {
  AUTH_SCHEMA_VERSION,
  inspectAuthDatabaseFile,
  inspectAuthSchemaExactness,
  readAuthSchemaVersion,
} from './schema.ts';
import { AuthStorageError } from './storage-error.ts';
import {
  acquireMaintenanceLease,
  assertMaintenanceLease,
  buildGenerationId,
  readActiveGeneration,
  readGenerationManifest,
  releaseMaintenanceLease,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
  writeActiveGeneration,
  writeAuthFileAtomic,
  type AuthStorageLayout,
} from './storage-layout.ts';
import { AuthStore, buildAuthGeneration } from './store.ts';

export const BACKUP_DB_FILE_NAME = 'auth.sqlite';
export const BACKUP_MANIFEST_FILE_NAME = 'backup-manifest.json';

/** 允许出现在备份目录里的文件：副本 + manifest。多出任何东西都拒绝校验。 */
function backupDirEntries(backupDir: string): string[] {
  try {
    return readdirSync(backupDir).filter((name) => name !== '.' && name !== '..');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      throw new AuthStorageError('backup-invalid', `备份目录不存在：${backupDir}`);
    }
    throw new AuthStorageError(
      'backup-invalid',
      `备份目录不可读：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  // auth.sqlite 是小文件（会话/设备数量级），一次读入即可；若未来变大再改流式。
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export interface AuthBackupManifest {
  readonly version: 1;
  readonly backupId: string;
  readonly createdAt: string;
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly securityEpoch: number;
  /** 世代的 storage binding（64 位小写 hex）；恢复时要与备份 DB 的 auth_meta 比对。 */
  readonly storageBinding: string;
  /** 备份副本自身的 sha256（副本由 VACUUM 生成，与源文件字节不同，不能拿源库 hash 比）。 */
  readonly sha256: string;
  readonly integrityCheck: 'ok';
}

export interface AuthBackupVerification {
  readonly manifest: AuthBackupManifest | null;
  readonly sha256: string;
  readonly schemaVersion: number;
}

/** 备份目录里副本与 manifest 的逐项校验；`requireManifest=false` 用于刚生成、还没写 manifest 时。 */
function verifyBackupCopy(backupDir: string, requireManifest: boolean): AuthBackupVerification {
  const entries = backupDirEntries(backupDir);
  const allowed = [BACKUP_DB_FILE_NAME, BACKUP_MANIFEST_FILE_NAME];
  for (const entry of entries) {
    if (!allowed.includes(entry)) {
      throw new AuthStorageError('backup-invalid', `备份目录含未预期文件 ${entry}，拒绝校验`);
    }
    if (entry.includes('-wal') || entry.includes('-shm')) {
      throw new AuthStorageError('backup-invalid', '备份目录含 WAL/SHM 旁文件，副本不是独立单文件');
    }
  }
  const dbPath = join(backupDir, BACKUP_DB_FILE_NAME);
  if (!existsSync(dbPath)) {
    throw new AuthStorageError('backup-invalid', `备份缺少 ${BACKUP_DB_FILE_NAME}`);
  }

  // 1) 文件头：不是 SQLite / 不是本项目的库，在这里就分类清楚。
  const header = inspectAuthDatabaseFile(dbPath);
  if (header.userVersion > AUTH_SCHEMA_VERSION) {
    throw new AuthStorageError('schema-future', `备份 schema 版本 ${header.userVersion} 高于本构建`);
  }

  // 2) 只读打开：integrity_check 必须等于 ok（损坏可能只在 free space，SELECT 查不出来）。
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let schemaVersion: number;
  let authMeta: { generationId: string; securityEpoch: number; storageBinding: string };
  try {
    const integrity = String(
      (db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown })
        ?.integrity_check ?? '',
    ).toLowerCase();
    if (integrity !== 'ok') {
      throw new AuthStorageError('backup-invalid', `备份 integrity_check=${integrity}`);
    }
    schemaVersion = readAuthSchemaVersion(db);
    if (schemaVersion > AUTH_SCHEMA_VERSION) {
      throw new AuthStorageError('schema-future', `备份 schema 版本 ${schemaVersion} 高于本构建`);
    }
    // 3) 精确 schema：表集合与每张表的列都必须与当前版本完全一致。
    const exactness = inspectAuthSchemaExactness(db);
    if (!exactness.ok) {
      throw new AuthStorageError('backup-incompatible', `备份 schema 与当前版本不一致：${exactness.detail}`);
    }
    const meta = db.prepare(
      'SELECT generation_id, security_epoch, storage_binding FROM auth_meta WHERE id = 1',
    ).get() as Record<string, unknown> | undefined;
    if (!meta || typeof meta.generation_id !== 'string' || !/^[a-f0-9]{24}$/.test(meta.generation_id)
      || !Number.isInteger(meta.security_epoch) || Number(meta.security_epoch) < 1
      || typeof meta.storage_binding !== 'string' || !/^[a-f0-9]{64}$/.test(meta.storage_binding)) {
      throw new AuthStorageError('backup-invalid', '备份 auth_meta 缺失或字段非法');
    }
    authMeta = {
      generationId: meta.generation_id,
      securityEpoch: Number(meta.security_epoch),
      storageBinding: meta.storage_binding,
    };
  } catch (error) {
    if (error instanceof AuthStorageError) throw error;
    throw new AuthStorageError(
      'backup-invalid',
      `备份校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }

  const sha256 = sha256File(dbPath);
  const manifestPath = join(backupDir, BACKUP_MANIFEST_FILE_NAME);
  let manifest: AuthBackupManifest | null = null;
  if (requireManifest) {
    if (!existsSync(manifestPath)) {
      throw new AuthStorageError('backup-invalid', `备份缺少 ${BACKUP_MANIFEST_FILE_NAME}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new AuthStorageError('backup-invalid', 'backup-manifest.json 不是合法 JSON');
    }
    manifest = parseBackupManifest(parsed);
    if (manifest.schemaVersion !== schemaVersion) {
      throw new AuthStorageError('backup-invalid', 'manifest.schemaVersion 与副本 user_version 不一致');
    }
    if (manifest.sha256 !== sha256) {
      throw new AuthStorageError('backup-invalid', 'manifest.sha256 与副本实际内容不一致');
    }
    if (manifest.generationId !== authMeta.generationId
      || manifest.securityEpoch !== authMeta.securityEpoch
      || manifest.storageBinding !== authMeta.storageBinding) {
      throw new AuthStorageError('backup-invalid', 'manifest generation/epoch/binding 与 auth_meta 不一致');
    }
  }
  return { manifest, sha256, schemaVersion };
}

function parseBackupManifest(value: unknown): AuthBackupManifest {
  if (typeof value !== 'object' || value === null) {
    throw new AuthStorageError('backup-invalid', '备份 manifest 不是对象');
  }
  const record = value as Record<string, unknown>;
  const hex64 = (input: unknown, field: string): string => {
    if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
      throw new AuthStorageError('backup-invalid', `${field} 必须是 64 位小写 hex`);
    }
    return input;
  };
  if (record.version !== 1) throw new AuthStorageError('backup-invalid', '备份 manifest.version 必须是 1');
  if (typeof record.backupId !== 'string' || !/^[a-f0-9]{24}$/.test(record.backupId)) {
    throw new AuthStorageError('backup-invalid', '备份 backupId 非法');
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new AuthStorageError('backup-invalid', '备份 createdAt 非法');
  }
  if (typeof record.generationId !== 'string' || !/^[a-f0-9]{24}$/.test(record.generationId)) {
    throw new AuthStorageError('backup-invalid', '备份 generationId 非法');
  }
  if (!Number.isInteger(record.schemaVersion) || Number(record.schemaVersion) < 1) {
    throw new AuthStorageError('backup-invalid', '备份 schemaVersion 非法');
  }
  if (!Number.isInteger(record.securityEpoch) || Number(record.securityEpoch) < 1) {
    throw new AuthStorageError('backup-invalid', '备份 securityEpoch 非法');
  }
  if (record.integrityCheck !== 'ok') {
    throw new AuthStorageError('backup-invalid', '备份 manifest.integrityCheck 必须是 ok');
  }
  return {
    version: 1,
    backupId: record.backupId,
    createdAt: record.createdAt,
    generationId: record.generationId,
    schemaVersion: Number(record.schemaVersion),
    securityEpoch: Number(record.securityEpoch),
    storageBinding: hex64(record.storageBinding, 'storageBinding'),
    sha256: hex64(record.sha256, 'sha256'),
    integrityCheck: 'ok',
  };
}

/** 对一个已有备份目录做完整校验（副本 + manifest + sha256 交叉核对），通过后返回 manifest。 */
export function verifyAuthBackup(backupDir: string): AuthBackupManifest {
  const verification = verifyBackupCopy(backupDir, true);
  return verification.manifest as AuthBackupManifest;
}

/** 注入故障点（仅测试用）：模拟在指定阶段被 kill。 */
function failAt(options: CreateAuthBackupOptions, stage: BackupFailureStage): void {
  if (options.injectFailureAt === stage) {
    throw new AuthStorageError('io-failed', `[测试注入] 备份在 ${stage} 阶段失败`);
  }
}

export type BackupFailureStage = 'staging' | 'verify' | 'manifest' | 'release-lease';

export interface CreateAuthBackupOptions {
  readonly dataDir: string;
  /** 备份输出目录：必须不存在，或为**空**目录（VACUUM INTO 拒绝覆盖已存在文件）。 */
  readonly outputDir: string;
  readonly reason?: string;
  readonly now?: () => string;
  readonly injectFailureAt?: BackupFailureStage;
}

export interface AuthBackupResult {
  readonly backupDir: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly manifest: AuthBackupManifest;
  readonly leaseToken: string;
}

export interface ImportedAuthBackupResult {
  readonly backupDir: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly manifest: AuthBackupManifest;
}

export interface CreateAuthBackupFromDatabaseOptions {
  /** P8 全量快照中已经在线捕获并复验过的独立 auth SQLite。 */
  readonly sourceDbPath: string;
  readonly outputDir: string;
  readonly now?: () => string;
  readonly backupIdFactory?: () => string;
}

function authMetaFromDatabase(path: string): {
  generationId: string;
  securityEpoch: number;
  storageBinding: string;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(
      'SELECT generation_id, security_epoch, storage_binding FROM auth_meta WHERE id = 1',
    ).get() as Record<string, unknown> | undefined;
    if (!row || typeof row.generation_id !== 'string' || !/^[a-f0-9]{24}$/.test(row.generation_id)
      || !Number.isInteger(row.security_epoch) || Number(row.security_epoch) < 1
      || typeof row.storage_binding !== 'string' || !/^[a-f0-9]{64}$/.test(row.storage_binding)) {
      throw new AuthStorageError('backup-invalid', 'auth_meta 缺失或字段非法');
    }
    return {
      generationId: row.generation_id,
      securityEpoch: Number(row.security_epoch),
      storageBinding: row.storage_binding,
    };
  } finally {
    db.close();
  }
}

/**
 * 把 P8 已验证的离线 auth DB 转成 A1 restore 可消费的 auth-only backup。
 * 来源仍通过独立只读连接 `VACUUM INTO`，绝不直接信任/移动 snapshot 文件；本函数不需要维护租约，
 * 因为调用方只能在 restored server 被 marker 阻断且持有 dataDir process lock 时使用它。
 */
export function createAuthBackupFromDatabase(
  options: CreateAuthBackupFromDatabaseOptions,
): ImportedAuthBackupResult {
  const sourcePath = resolve(options.sourceDbPath);
  const outputDir = resolve(options.outputDir);
  const sourceStats = lstatSync(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new AuthStorageError('backup-invalid', 'snapshot auth 来源必须是普通文件');
  }
  if (existsSync(outputDir)) {
    const outputStats = lstatSync(outputDir);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      throw new AuthStorageError('invalid-layout', '备份输出必须是普通目录');
    }
    if (backupDirEntries(outputDir).length > 0) {
      throw new AuthStorageError('invalid-layout', `备份目录必须为空：${outputDir}`);
    }
    establishPathProtection(outputDir, 'directory');
  } else {
    assertAncestorChainNoReparsePoint(outputDir);
    mkdirSync(outputDir, { mode: 0o700 });
    establishPathProtection(outputDir, 'directory');
  }
  const dbPath = join(outputDir, BACKUP_DB_FILE_NAME);
  const manifestPath = join(outputDir, BACKUP_MANIFEST_FILE_NAME);
  if (resolve(dbPath) === sourcePath) throw new AuthStorageError('invalid-layout', 'auth 备份来源与目标重合');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${dbPath.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } catch (error) {
    throw new AuthStorageError(
      'io-failed',
      `生成 snapshot auth 备份失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    source.close();
  }
  const verification = verifyBackupCopy(outputDir, false);
  const meta = authMetaFromDatabase(dbPath);
  const backupId = (options.backupIdFactory ?? buildGenerationId)();
  if (!/^[a-f0-9]{24}$/.test(backupId)) throw new AuthStorageError('backup-invalid', 'backupIdFactory 返回非法值');
  const payload: AuthBackupManifest = {
    version: 1,
    backupId,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    generationId: meta.generationId,
    schemaVersion: verification.schemaVersion,
    securityEpoch: meta.securityEpoch,
    storageBinding: meta.storageBinding,
    sha256: verification.sha256,
    integrityCheck: 'ok',
  };
  writeAuthFileAtomic(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  verifyAuthBackup(outputDir);
  return { backupDir: outputDir, dbPath, manifestPath, manifest: payload };
}

/**
 * 生成 auth-only 备份。
 *
 * 冻结语义：取得维护租约（阻止其它进程启动）后，先对源库做一次 `BEGIN IMMEDIATE`
 * 写锁试探 —— 能拿到锁说明当前没有进行中的写入事务；随后立刻用**独立只读连接**
 * `VACUUM INTO`（源库绝不被写）。失败路径一律不释放租约（fail-closed）。
 */
export function createAuthBackup(options: CreateAuthBackupOptions): AuthBackupResult {
  const now = options.now ?? (() => new Date().toISOString());
  const layout: AuthStorageLayout = resolveAuthStorageLayout(options.dataDir);
  const generationId = readActiveGeneration(layout);
  const generation = resolveGenerationPaths(layout, generationId);
  const manifest = readGenerationManifest(layout, generationId);

  // 0) 输出目录必须为空或不存在；VACUUM INTO 本身也拒绝覆盖已存在文件。
  const dbPath = join(options.outputDir, BACKUP_DB_FILE_NAME);
  const manifestPath = join(options.outputDir, BACKUP_MANIFEST_FILE_NAME);
  if (existsSync(options.outputDir)) {
    const entries = backupDirEntries(options.outputDir);
    if (entries.length > 0) {
      throw new AuthStorageError('invalid-layout', `备份目录必须为空：${options.outputDir}`);
    }
  } else {
    assertAncestorChainNoReparsePoint(options.outputDir);
    mkdirSync(options.outputDir, { mode: 0o700 });
    establishPathProtection(options.outputDir, 'directory');
  }

  const lease = acquireMaintenanceLease(layout, {
    reason: options.reason ?? 'auth-backup',
    now: now(),
  });
  // 从这里开始：任何失败都不释放租约（维护态保持，远程入口关闭）。
  failAt(options, 'staging');

  // 1) 冻结证明：能拿到写锁说明当前没有进行中的写入事务。
  const guard = new DatabaseSync(generation.authDbPath);
  try {
    guard.exec('PRAGMA busy_timeout = 250;');
    guard.exec('BEGIN IMMEDIATE;');
    guard.exec('ROLLBACK;');
  } catch (error) {
    throw new AuthStorageError(
      'conflict',
      `备份期间无法取得写锁，可能有进行中的写入者：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      guard.close();
    } catch {
      /* 已关闭 */
    }
  }

  // 2) 独立只读连接生成副本：源库绝不被写（实测 VACUUM INTO 在只读连接上可用）。
  try {
    const source = new DatabaseSync(generation.authDbPath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${dbPath.replace(/\\/g, '/')}'`);
    } finally {
      try {
        source.close();
      } catch {
        /* 已关闭 */
      }
    }
  } catch (error) {
    if (error instanceof AuthStorageError) throw error;
    throw new AuthStorageError(
      'io-failed',
      `生成备份副本失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  failAt(options, 'verify');

  // 3) 副本自校验（integrity + application_id + 精确 schema），算出副本自身的 sha256。
  verifyBackupCopy(options.outputDir, false);

  // 4) 写备份 manifest —— 写出之后备份才算"完整可校验"；'manifest' 阶段的故障注入
  //    在这一步之后触发，模拟"manifest 已落盘、租约还没放"就死掉的窗口。
  const payload: AuthBackupManifest = {
    version: 1,
    backupId: buildGenerationId(),
    createdAt: now(),
    generationId,
    schemaVersion: manifest.schemaVersion,
    securityEpoch: manifest.securityEpoch,
    storageBinding: manifest.storageBinding,
    sha256: sha256File(dbPath),
    integrityCheck: 'ok',
  };
  writeAuthFileAtomic(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  failAt(options, 'manifest');
  failAt(options, 'release-lease');
  releaseMaintenanceLease(layout, lease.token);

  return {
    backupDir: options.outputDir,
    dbPath,
    manifestPath,
    manifest: payload,
    leaseToken: lease.token,
  };
}

export type RestoreFailureStage =
  | 'verify-backup'
  | 'build-generation'
  | 'copy-devices'
  | 'verify-new'
  | 'activate'
  | 'release-lease';

export interface RestoreAuthBackupOptions {
  readonly dataDir: string;
  /** 备份目录；恢复前会先做完整校验（verifyAuthBackup）。 */
  readonly backupDir: string;
  /** 维护租约 token：必须先 `acquireMaintenanceLease` 取得；普通布尔参数不算锁。 */
  readonly leaseToken: string;
  readonly now?: () => string;
  /** 仅测试用：在指定阶段抛错，验证崩溃一致性（A1R-04）。 */
  readonly injectFailureAt?: RestoreFailureStage;
}

export interface RestoreAuthBackupResult {
  readonly previousGenerationId: string;
  readonly generationId: string;
  readonly securityEpoch: number;
  readonly revokedDeviceCount: number;
}

/**
 * 用备份恢复：**旧备份不能直接激活**。
 *
 * 顺序（交接说明 §5 步骤 4–7）：
 * 1. 出示维护租约（调用方必须先停掉 secured listener 并取得租约）；
 * 2. 备份完整校验（integrity / application_id / 精确 schema / sha256）；
 * 3. `buildAuthGeneration({ allowRotation: true })` 新建**当前版**世代：新根密钥、
 *    security epoch = max(active, backup) + 1 —— 此时尚未激活；
 * 4. 把允许的数据复制进新世代：device 全部以"已撤销"进入；session/pairing/capability 清空；
 * 5. 验证新世代（meta 一致、三类凭据为空、设备全部已撤销）；
 * 6. **唯一原子切换点**：写一次 active pointer；
 * 7. 释放租约。任何阶段失败都不释放租约（维护态保持，远程入口关闭），
 *    指针要么还指向旧世代、要么已整体指向新世代，绝无 DB/key 分步激活窗口。
 */
export function restoreAuthBackup(options: RestoreAuthBackupOptions): RestoreAuthBackupResult {
  const now = options.now ?? (() => new Date().toISOString());
  const layout = resolveAuthStorageLayout(options.dataDir);
  const failAt = (stage: RestoreFailureStage): void => {
    if (options.injectFailureAt === stage) {
      throw new AuthStorageError('io-failed', `[测试注入] 恢复在 ${stage} 阶段失败`);
    }
  };

  // 1) 租约准入：没有 token / 不在维护态 / token 不匹配都不放行。
  assertMaintenanceLease(layout, options.leaseToken);
  const previousGenerationId = readActiveGeneration(layout);
  const previousManifest = readGenerationManifest(layout, previousGenerationId);

  // 2) 备份完整校验。
  const backup = verifyAuthBackup(options.backupDir);
  failAt('verify-backup');

  // 3) 新建当前版世代（不激活）。旧凭据在新根密钥下永远无法通过验证，
  //    epoch 取 max(active, backup) + 1 让所有基于旧 epoch 的派生失效。
  const built = buildAuthGeneration({
    dataDir: options.dataDir,
    securityEpoch: Math.max(previousManifest.securityEpoch, backup.securityEpoch) + 1,
    now,
    allowRotation: true,
  });
  failAt('build-generation');

  // 4) 复制允许的数据：device → 已撤销；session/pairing/capability 不导入。
  const newStore = AuthStore.openForGeneration({
    layout,
    generationId: built.generationId,
    now,
  });
  let revokedDeviceCount = 0;
  try {
    const source = new DatabaseSync(join(options.backupDir, BACKUP_DB_FILE_NAME), { readOnly: true });
    try {
      revokedDeviceCount = newStore.importRevokedDevicesFrom(source, { revokedAt: now() });
    } finally {
      try {
        source.close();
      } catch {
        /* 已关闭 */
      }
    }
  } catch (error) {
    try {
      newStore.close();
    } catch {
      /* 已关闭 */
    }
    throw error instanceof AuthStorageError
      ? error
      : new AuthStorageError(
          'backup-invalid',
          `复制备份数据失败：${error instanceof Error ? error.message : String(error)}`,
        );
  }
  failAt('copy-devices');

  // 5) 激活前验证新世代：meta 一致、三类凭据为空、设备全部已撤销。
  try {
    const reopened = AuthStore.openForGeneration({ layout, generationId: built.generationId, now });
    try {
      if (reopened.meta.generationId !== built.generationId
        || reopened.meta.securityEpoch !== built.securityEpoch) {
        throw new AuthStorageError('binding-mismatch', '新世代的 auth_meta 与 manifest 不一致');
      }
      if (reopened.countSessions() !== 0 || reopened.countPairings() !== 0
        || reopened.countAssetCapabilities() !== 0) {
        throw new AuthStorageError('record-invalid', '新世代不应包含任何 session/pairing/capability');
      }
      if (reopened.countDevices() !== revokedDeviceCount || reopened.countUnrevokedDevices() !== 0) {
        throw new AuthStorageError('record-invalid', '新世代的设备必须全部处于已撤销状态');
      }
    } finally {
      reopened.close();
    }
    newStore.close();
  } catch (error) {
    try {
      newStore.close();
    } catch {
      /* 已关闭 */
    }
    throw error instanceof AuthStorageError
      ? error
      : new AuthStorageError(
          'record-invalid',
          `验证新世代失败：${error instanceof Error ? error.message : String(error)}`,
        );
  }
  failAt('verify-new');

  // 6) 唯一原子切换点：一次写入 active pointer。
  writeActiveGeneration(layout, built.generationId);
  failAt('activate');

  // 7) 释放租约（token 匹配才放行）。
  failAt('release-lease');
  releaseMaintenanceLease(layout, options.leaseToken);

  return {
    previousGenerationId,
    generationId: built.generationId,
    securityEpoch: built.securityEpoch,
    revokedDeviceCount,
  };
}
