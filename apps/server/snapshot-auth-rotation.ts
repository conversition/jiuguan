import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AuthStore,
  acquireMaintenanceLease,
  createAuthBackupFromDatabase,
  fsyncDirectorySync,
  initializeAuthStorage,
  readActiveGeneration,
  readGenerationManifest,
  readMaintenanceState,
  releaseMaintenanceLease,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
  restoreAuthBackup,
  writeAuthFileAtomic,
  type RestoreFailureStage,
} from '../../packages/server-auth/src/index.ts';
import { ServerProcessLock } from './process-lock.ts';
import { verifySnapshotDirectory } from './snapshot-coordinator.ts';
import {
  readSnapshotRestorePendingMarker,
  validateRestoredDataDir,
  type SnapshotRestorePendingMarker,
} from './snapshot-restore.ts';
import {
  SNAPSHOT_AUTH_ROTATION_INTENT_FILE,
  SNAPSHOT_RESTORE_PENDING_FILE,
  snapshotPreRestorePath,
} from './snapshot-restore-layout.ts';

const ROTATION_REASON_PREFIX = 'snapshot-restore-rotation:';
const SOURCE_BACKUP_PREFIX = '.jiuguan-auth-source-';

export type SnapshotAuthRotationCrashStage =
  | 'after-baseline'
  | 'after-lease'
  | 'after-auth-restore'
  | 'after-intent-cleanup';

type RotationPhase = 'started' | 'baseline-ready' | 'lease-held' | 'auth-restored' | 'verified';

interface RotationIntent {
  readonly version: 1;
  readonly restoreId: string;
  readonly snapshotId: string;
  readonly phase: RotationPhase;
  readonly createdAt: string;
}

interface SnapshotAuthSource {
  readonly dbPath: string;
  readonly securityEpoch: number;
  readonly deviceCount: number;
}

export class SnapshotAuthRotationError extends Error {
  readonly name = 'SnapshotAuthRotationError';
  constructor(
    readonly code: 'rotation-invalid' | 'rotation-conflict' | 'rotation-recovery-required',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class SnapshotAuthRotationCrashSimulationError extends Error {
  readonly name = 'SnapshotAuthRotationCrashSimulationError';
}

export interface SnapshotAuthRotationResult {
  readonly restoreId: string;
  readonly snapshotId: string;
  readonly generationId: string;
  readonly securityEpoch: number;
  readonly revokedDeviceCount: number;
  readonly preRestoreDir: string;
}

function canonicalIso(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new SnapshotAuthRotationError('rotation-invalid', 'rotation 时间必须是 canonical ISO');
  }
  return value;
}

function preRestoreEpoch(preRestoreDir: string): number {
  const path = resolve(preRestoreDir);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SnapshotAuthRotationError('rotation-invalid', 'pre-restore 必须是普通目录');
  }
  const layout = resolveAuthStorageLayout(path);
  if (!existsSync(layout.activePointerPath)) return 0;
  const generationId = readActiveGeneration(layout);
  const manifestEpoch = readGenerationManifest(layout, generationId).securityEpoch;
  const generation = resolveGenerationPaths(layout, generationId);
  const db = new DatabaseSync(generation.authDbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT security_epoch FROM auth_meta WHERE id = 1').get() as
      | { security_epoch?: unknown }
      | undefined;
    const databaseEpoch = row?.security_epoch;
    if (!Number.isInteger(databaseEpoch) || Number(databaseEpoch) < manifestEpoch) {
      throw new SnapshotAuthRotationError('rotation-invalid', 'pre-restore auth epoch 非法或倒退');
    }
    return Number(databaseEpoch);
  } finally {
    db.close();
  }
}

function snapshotAuthSource(dataDir: string, marker: SnapshotRestorePendingMarker): SnapshotAuthSource | null {
  const snapshotDir = join(dataDir, '.snapshots-v1', 'snapshot-' + marker.snapshotId);
  const manifest = verifySnapshotDirectory(snapshotDir);
  const components = manifest.components.filter((component) => component.role === 'auth-db');
  if (components.length === 0) return null;
  if (components.length !== 1) throw new SnapshotAuthRotationError('rotation-invalid', 'snapshot auth component 数量非法');
  const component = components[0]!;
  const dbPath = join(snapshotDir, ...component.storedRelativePath.split('/'));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = db.prepare('SELECT security_epoch FROM auth_meta WHERE id = 1').get() as { security_epoch?: unknown } | undefined;
    const count = db.prepare('SELECT count(*) AS n FROM auth_device').get() as { n?: unknown } | undefined;
    const securityEpoch = meta?.security_epoch;
    const deviceCount = count?.n;
    if (!Number.isInteger(securityEpoch) || Number(securityEpoch) < 1
      || !Number.isInteger(deviceCount) || Number(deviceCount) < 0) {
      throw new SnapshotAuthRotationError('rotation-invalid', 'snapshot auth meta/device count 非法');
    }
    return {
      dbPath,
      securityEpoch: Number(securityEpoch),
      deviceCount: Number(deviceCount),
    };
  } finally {
    db.close();
  }
}

function verifyFinalGeneration(
  dataDir: string,
  minimumPreviousEpoch: number,
  expectedDeviceCount: number,
  now: () => string,
): { generationId: string; securityEpoch: number; revokedDeviceCount: number } | null {
  const layout = resolveAuthStorageLayout(dataDir);
  if (!existsSync(layout.activePointerPath)) return null;
  const generationId = readActiveGeneration(layout);
  const manifest = readGenerationManifest(layout, generationId);
  if (manifest.securityEpoch <= minimumPreviousEpoch) return null;
  const store = AuthStore.openForGeneration({ layout, generationId, now });
  try {
    if (store.meta.securityEpoch !== manifest.securityEpoch
      || store.countSessions() !== 0
      || store.countPairings() !== 0
      || store.countAssetCapabilities() !== 0
      || store.countDevices() !== expectedDeviceCount
      || store.countUnrevokedDevices() !== 0) return null;
    return { generationId, securityEpoch: manifest.securityEpoch, revokedDeviceCount: expectedDeviceCount };
  } finally {
    store.close();
  }
}

function removePlainDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SnapshotAuthRotationError('rotation-invalid', 'rotation 临时目录类型非法');
  }
  rmSync(path, { recursive: true, force: true });
  fsyncDirectorySync(dirname(path));
}

export class SnapshotAuthRotationCoordinator {
  readonly #dataDir: string;
  readonly #serverLock: ServerProcessLock;
  readonly #now: () => string;

  constructor(options: { dataDir: string; serverLock: ServerProcessLock; now?: () => string }) {
    this.#dataDir = resolve(options.dataDir);
    if (resolve(options.serverLock.dataDir) !== this.#dataDir) {
      throw new SnapshotAuthRotationError('rotation-invalid', 'rotation dataDir 与 process lock 不一致');
    }
    this.#serverLock = options.serverLock;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  complete(options: {
    injectCrashAt?: SnapshotAuthRotationCrashStage;
    injectAuthFailureAt?: RestoreFailureStage;
  } = {}): SnapshotAuthRotationResult {
    this.#serverLock.assertOwned();
    const marker = readSnapshotRestorePendingMarker(this.#dataDir);
    if (!marker) throw new SnapshotAuthRotationError('rotation-invalid', '缺少 P8-09 restore pending marker');
    validateRestoredDataDir(this.#dataDir, marker.snapshotId);
    const preRestoreDir = snapshotPreRestorePath(this.#dataDir, marker.restoreId);
    const previousEpoch = preRestoreEpoch(preRestoreDir);
    const source = snapshotAuthSource(this.#dataDir, marker);
    const sourceEpoch = source?.securityEpoch ?? 0;
    const expectedDeviceCount = source?.deviceCount ?? 0;
    const minimumPreviousEpoch = Math.max(previousEpoch, sourceEpoch);
    const nowValue = canonicalIso(this.#now());
    const intentPath = join(this.#dataDir, SNAPSHOT_AUTH_ROTATION_INTENT_FILE);
    const sourceBackupDir = join(this.#dataDir, SOURCE_BACKUP_PREFIX + marker.restoreId);
    let intent: RotationIntent = {
      version: 1,
      restoreId: marker.restoreId,
      snapshotId: marker.snapshotId,
      phase: 'started',
      createdAt: nowValue,
    };
    const persist = (): void => {
      writeAuthFileAtomic(intentPath, JSON.stringify(intent, null, 2) + '\n');
    };
    const crash = (stage: SnapshotAuthRotationCrashStage): void => {
      if (options.injectCrashAt === stage) {
        throw new SnapshotAuthRotationCrashSimulationError('模拟 auth rotation 崩溃：' + stage);
      }
    };
    persist();

    const layout = resolveAuthStorageLayout(this.#dataDir);
    if (!existsSync(layout.activePointerPath)) {
      initializeAuthStorage({
        dataDir: this.#dataDir,
        securityEpoch: source
          ? Math.max(previousEpoch, 1)
          : minimumPreviousEpoch + 1,
        now: this.#now,
      });
    }
    intent = { ...intent, phase: 'baseline-ready' };
    persist();
    crash('after-baseline');

    let final = verifyFinalGeneration(
      this.#dataDir,
      minimumPreviousEpoch,
      expectedDeviceCount,
      this.#now,
    );
    const reason = ROTATION_REASON_PREFIX + marker.restoreId;

    if (!final && source) {
      removePlainDirectory(sourceBackupDir);
      const backup = createAuthBackupFromDatabase({
        sourceDbPath: source.dbPath,
        outputDir: sourceBackupDir,
        now: this.#now,
      });
      if (backup.manifest.securityEpoch !== source.securityEpoch) {
        throw new SnapshotAuthRotationError('rotation-invalid', 'snapshot auth backup epoch 漂移');
      }
      const maintenance = readMaintenanceState(layout);
      let leaseToken: string;
      if (maintenance.active) {
        if (!maintenance.lease || maintenance.lease.reason !== reason) {
          throw new SnapshotAuthRotationError('rotation-conflict', '存在不属于本 restore 的 auth maintenance');
        }
        leaseToken = maintenance.lease.token;
      } else {
        leaseToken = acquireMaintenanceLease(layout, { reason, now: nowValue }).token;
      }
      intent = { ...intent, phase: 'lease-held' };
      persist();
      crash('after-lease');

      restoreAuthBackup({
        dataDir: this.#dataDir,
        backupDir: sourceBackupDir,
        leaseToken,
        now: this.#now,
        injectFailureAt: options.injectAuthFailureAt,
      });
      intent = { ...intent, phase: 'auth-restored' };
      persist();
      crash('after-auth-restore');
      final = verifyFinalGeneration(
        this.#dataDir,
        minimumPreviousEpoch,
        expectedDeviceCount,
        this.#now,
      );
    }

    if (!final) {
      throw new SnapshotAuthRotationError('rotation-recovery-required', '新 auth generation 未满足 epoch/凭据失效不变量');
    }
    const maintenance = readMaintenanceState(layout);
    if (maintenance.active) {
      if (!maintenance.lease || maintenance.lease.reason !== reason) {
        throw new SnapshotAuthRotationError('rotation-conflict', '完成态存在无关 maintenance');
      }
      releaseMaintenanceLease(layout, maintenance.lease.token);
    }
    intent = { ...intent, phase: 'verified' };
    persist();
    removePlainDirectory(sourceBackupDir);
    rmSync(intentPath, { force: true });
    fsyncDirectorySync(this.#dataDir);
    crash('after-intent-cleanup');

    this.#serverLock.assertOwned();
    const markerPath = join(this.#dataDir, SNAPSHOT_RESTORE_PENDING_FILE);
    const currentMarker = readSnapshotRestorePendingMarker(this.#dataDir);
    if (!currentMarker || currentMarker.restoreId !== marker.restoreId
      || currentMarker.snapshotId !== marker.snapshotId) {
      throw new SnapshotAuthRotationError('rotation-conflict', '删除前 restore marker 已变化');
    }
    rmSync(markerPath, { force: true });
    fsyncDirectorySync(this.#dataDir);
    return {
      restoreId: marker.restoreId,
      snapshotId: marker.snapshotId,
      generationId: final.generationId,
      securityEpoch: final.securityEpoch,
      revokedDeviceCount: final.revokedDeviceCount,
      preRestoreDir,
    };
  }
}
