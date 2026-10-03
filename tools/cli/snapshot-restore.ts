#!/usr/bin/env node
/**
 * P8-10 离线全量恢复入口。
 *
 * 必须同时给 snapshotId 与同值确认参数；命令只在电脑本地、服务已停止时运行，
 * 串联 P8-09 dataDir 切换和 P8-10 auth root/epoch 轮换，绝不自动启动 server。
 */
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireServerProcessLock, type ServerProcessLock } from '../../apps/server/process-lock.ts';
import { SnapshotAuthRotationCoordinator } from '../../apps/server/snapshot-auth-rotation.ts';
import {
  SnapshotRestoreCoordinator,
  readSnapshotRestorePendingMarker,
  recoverSnapshotRestoreBeforeServerLock,
} from '../../apps/server/snapshot-restore.ts';

const SNAPSHOT_ID_RE = /^[a-f0-9]{24}$/;

export interface SnapshotRestoreCliOptions {
  readonly argv: readonly string[];
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

export interface SnapshotRestoreCliResult {
  readonly exitCode: number;
  readonly snapshotId?: string;
  readonly restoreId?: string;
  readonly securityEpoch?: number;
}

function parseArgs(argv: readonly string[]): { dataDir: string; snapshotId: string } {
  const allowed = new Set(['--data-dir', '--snapshot-id', '--confirm-snapshot-id']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new Error('invalid-arguments');
    }
    values.set(flag, value);
  }
  if (values.size !== 3 || argv.length !== 6) throw new Error('invalid-arguments');
  const snapshotId = values.get('--snapshot-id') ?? '';
  const confirmation = values.get('--confirm-snapshot-id') ?? '';
  if (!SNAPSHOT_ID_RE.test(snapshotId) || confirmation !== snapshotId) throw new Error('confirmation-mismatch');
  const rawDataDir = values.get('--data-dir') ?? '';
  if (!rawDataDir) throw new Error('invalid-data-dir');
  return { dataDir: resolve(rawDataDir), snapshotId };
}

export function runSnapshotRestoreCli(options: SnapshotRestoreCliOptions): SnapshotRestoreCliResult {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  let parsed: { dataDir: string; snapshotId: string };
  try {
    parsed = parseArgs(options.argv);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'invalid-arguments';
    err('snapshot restore rejected: ' + code);
    return { exitCode: 2 };
  }

  let lock: ServerProcessLock | undefined;
  try {
    recoverSnapshotRestoreBeforeServerLock({ dataDir: parsed.dataDir });
    let marker = readSnapshotRestorePendingMarker(parsed.dataDir);
    if (marker && marker.snapshotId !== parsed.snapshotId) {
      err('snapshot restore rejected: pending-snapshot-mismatch');
      return { exitCode: 2 };
    }
    if (!marker) {
      lock = acquireServerProcessLock({
        dataDir: parsed.dataDir,
        instanceId: 'snapshot-restore-cli-' + randomUUID(),
      });
      new SnapshotRestoreCoordinator({
        dataDir: parsed.dataDir,
        serverLock: lock,
      }).restore({ snapshotId: parsed.snapshotId });
      // P8-09 成功会从 pre-restore 精确释放随目录移动的旧锁。
      lock = undefined;
      marker = readSnapshotRestorePendingMarker(parsed.dataDir);
    }
    if (!marker || marker.snapshotId !== parsed.snapshotId) {
      throw new Error('restore-marker-missing');
    }
    lock = acquireServerProcessLock({
      dataDir: parsed.dataDir,
      instanceId: 'snapshot-rotation-cli-' + randomUUID(),
    });
    const rotated = new SnapshotAuthRotationCoordinator({
      dataDir: parsed.dataDir,
      serverLock: lock,
    }).complete();
    lock.release();
    lock = undefined;
    out(JSON.stringify({
      status: 'restored',
      snapshotId: rotated.snapshotId,
      restoreId: rotated.restoreId,
      securityEpoch: rotated.securityEpoch,
      revokedDeviceCount: rotated.revokedDeviceCount,
      preRestoreName: basename(rotated.preRestoreDir),
      requiresDevicePairing: true,
    }));
    return {
      exitCode: 0,
      snapshotId: rotated.snapshotId,
      restoreId: rotated.restoreId,
      securityEpoch: rotated.securityEpoch,
    };
  } catch (error) {
    try { lock?.release(); } catch { /* marker/maintenance 仍会保持 fail closed。 */ }
    const code = error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'internal')
      : 'internal';
    err('snapshot restore failed: ' + code);
    return { exitCode: 1, snapshotId: parsed.snapshotId };
  }
}

function main(): number {
  return runSnapshotRestoreCli({ argv: process.argv.slice(2) }).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
