import { basename, dirname, join, resolve } from 'node:path';

export const SNAPSHOT_RESTORE_WORKSPACE_SUFFIX = '.restore-v1';
export const SNAPSHOT_RESTORE_PENDING_FILE = '.jiuguan-restore-pending.json';
export const SNAPSHOT_AUTH_ROTATION_INTENT_FILE = '.jiuguan-auth-rotation-v1.json';

/** restore workspace 必须是 dataDir 的同卷同父级兄弟目录，才能执行可回滚 rename。 */
export function snapshotRestoreWorkspacePath(dataDir: string): string {
  const root = resolve(dataDir);
  const parent = dirname(root);
  const name = basename(root);
  if (parent === root || !name) throw new Error('dataDir 不能是卷根目录');
  return join(parent, '.' + name + SNAPSHOT_RESTORE_WORKSPACE_SUFFIX);
}

export function snapshotPreRestorePath(dataDir: string, restoreId: string): string {
  if (!/^[a-f0-9]{24}$/.test(restoreId)) throw new Error('restoreId 非法');
  const root = resolve(dataDir);
  return join(dirname(root), '.' + basename(root) + '.pre-restore-' + restoreId);
}
