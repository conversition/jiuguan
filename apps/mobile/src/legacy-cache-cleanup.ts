/**
 * P10-04：Android profile 的历史 PWA 残留清理（P10 计划第 7 条）。
 *
 * 同一台设备可能先装过 PWA（注册过 SW、写过 Cache Storage），换 bundled 壳后
 * 这些残留会劫持离线行为/占用存储。首启清理规则：
 * - 注销全部 Service Worker 注册（含等待/活动的）；
 * - 清空 CacheStorage 全部缓存桶；
 * - 清理只做一次：以 localStorage 标记防重（传注入实现以便测试）。
 * 全部 fail-soft：清理失败不阻塞壳启动（记录后继续）。
 */

export interface CacheCleanupDeps {
  serviceWorkerContainer?: {
    getRegistrations(): Promise<Array<{ unregister(): Promise<boolean> }>>;
  };
  caches?: {
    keys(): Promise<string[]>;
    delete(name: string): Promise<boolean>;
  };
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  now?: () => string;
}

export const CLEANUP_FLAG_KEY = 'jg.android-shell.cacheCleanupAt';

export interface LegacyCacheCleanupResult {
  readonly ran: boolean;
  readonly reason: 'already-done' | 'no-api' | 'cleaned' | 'failed';
  readonly unregisteredWorkers?: number;
  readonly deletedCaches?: number;
  readonly error?: string;
}

export async function cleanupLegacyPwaState(deps: CacheCleanupDeps = {}): Promise<LegacyCacheCleanupResult> {
  const storage = deps.localStorage
    ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (storage?.getItem(CLEANUP_FLAG_KEY)) {
    return { ran: false, reason: 'already-done' };
  }
  const swContainer = deps.serviceWorkerContainer
    ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
  const cacheStorage = deps.caches ?? (typeof caches !== 'undefined' ? caches : undefined);
  if (!swContainer && !cacheStorage) {
    markDone(storage, deps.now);
    return { ran: false, reason: 'no-api' };
  }
  try {
    let unregisteredWorkers = 0;
    let deletedCaches = 0;
    if (swContainer) {
      const registrations = await swContainer.getRegistrations();
      for (const registration of registrations) {
        if (await registration.unregister()) unregisteredWorkers += 1;
      }
    }
    if (cacheStorage) {
      const names = await cacheStorage.keys();
      for (const name of names) {
        if (await cacheStorage.delete(name)) deletedCaches += 1;
      }
    }
    markDone(storage, deps.now);
    return { ran: true, reason: 'cleaned', unregisteredWorkers, deletedCaches };
  } catch (error) {
    // fail-soft：残留不阻塞壳启动；下次启动重试（未打标记）。
    return {
      ran: false,
      reason: 'failed',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
}

function markDone(
  storage: CacheCleanupDeps['localStorage'],
  now?: () => string,
): void {
  try {
    storage?.setItem(CLEANUP_FLAG_KEY, (now ?? (() => new Date().toISOString()))());
  } catch {
    // localStorage 不可用（隐私模式等）：下次启动会重试清理，无害。
  }
}
