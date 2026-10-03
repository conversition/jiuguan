import { existsSync } from 'node:fs';
import {
  acquireMaintenanceLease,
  assertMaintenanceLease,
  readMaintenanceState,
  releaseMaintenanceLease,
  resolveAuthStorageLayout,
} from '../../packages/server-auth/src/index.ts';
import { ServerProcessLock } from './process-lock.ts';
import {
  SnapshotCoordinatorError,
  type SnapshotFreezeAdapter,
} from './snapshot-coordinator.ts';

const SNAPSHOT_REASON_PREFIX = 'snapshot-capture:';
const SNAPSHOT_ID_RE = /^[a-f0-9]{24}$/;
const AUTH_LEASE_RE = /^[a-f0-9]{32}$/;
const LOCAL_LEASE_RE = /^local:[a-f0-9]{24}$/;

/**
 * SnapshotCoordinator 全程同步执行，持有 dataDir process lock 时 Node 事件循环不会穿插新的业务写回调。
 * secured 数据目录额外持久化 auth maintenance lease，崩溃后保持 fail-closed；local-only 由 capture.lock 恢复。
 */
export class SynchronousSnapshotFreezeAdapter implements SnapshotFreezeAdapter {
  readonly #serverLock: ServerProcessLock;
  readonly #layout;
  readonly #hasAuth: boolean;
  readonly #now: () => string;
  #localLease: string | null = null;

  constructor(options: { dataDir: string; serverLock: ServerProcessLock; now?: () => string }) {
    this.#serverLock = options.serverLock;
    this.#layout = resolveAuthStorageLayout(options.dataDir);
    this.#hasAuth = existsSync(this.#layout.activePointerPath);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  acquire(snapshotId: string): string {
    this.#serverLock.assertOwned();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('snapshotId 非法');
    if (this.#hasAuth) {
      return acquireMaintenanceLease(this.#layout, {
        reason: SNAPSHOT_REASON_PREFIX + snapshotId,
        now: this.#now(),
      }).token;
    }
    if (this.#localLease !== null) throw new Error('已有 local-only snapshot freeze');
    this.#localLease = 'local:' + snapshotId;
    return this.#localLease;
  }

  assert(leaseId: string, snapshotId: string): void {
    this.#serverLock.assertOwned();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('snapshotId 非法');
    if (AUTH_LEASE_RE.test(leaseId)) {
      const lease = assertMaintenanceLease(this.#layout, leaseId);
      if (lease.reason !== SNAPSHOT_REASON_PREFIX + snapshotId) {
        throw new SnapshotCoordinatorError('snapshot-freeze-failed', 'maintenance lease 不属于 snapshot');
      }
      return;
    }
    if (!LOCAL_LEASE_RE.test(leaseId) || leaseId !== 'local:' + snapshotId || this.#localLease !== leaseId) {
      throw new SnapshotCoordinatorError('snapshot-freeze-failed', 'local snapshot freeze 不匹配');
    }
  }

  release(leaseId: string, snapshotId: string): void {
    this.assert(leaseId, snapshotId);
    if (AUTH_LEASE_RE.test(leaseId)) releaseMaintenanceLease(this.#layout, leaseId);
    else this.#localLease = null;
  }

  recover(leaseId: string, snapshotId: string): void {
    this.#serverLock.assertOwned();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('snapshotId 非法');
    if (AUTH_LEASE_RE.test(leaseId)) {
      const lease = assertMaintenanceLease(this.#layout, leaseId);
      if (lease.reason !== SNAPSHOT_REASON_PREFIX + snapshotId) {
        throw new SnapshotCoordinatorError('snapshot-freeze-failed', '拒绝释放非 snapshot maintenance lease');
      }
      releaseMaintenanceLease(this.#layout, leaseId);
      return;
    }
    if (!LOCAL_LEASE_RE.test(leaseId) || leaseId !== 'local:' + snapshotId) {
      throw new Error('snapshot freeze lease id 非法');
    }
    if (this.#localLease === leaseId) this.#localLease = null;
  }

  recoverOrphan(snapshotId: string): void {
    this.#serverLock.assertOwned();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('snapshotId 非法');
    if (!this.#hasAuth) {
      if (this.#localLease === 'local:' + snapshotId) this.#localLease = null;
      return;
    }
    const state = readMaintenanceState(this.#layout);
    if (!state.active) return;
    const expectedReason = SNAPSHOT_REASON_PREFIX + snapshotId;
    if (!state.lease || state.lease.reason !== expectedReason) {
      throw new SnapshotCoordinatorError(
        'snapshot-freeze-failed',
        'maintenance 状态不属于当前 orphan snapshot，拒绝释放',
      );
    }
    releaseMaintenanceLease(this.#layout, state.lease.token);
  }
}
