/**
 * 会话级共享脚本运行包 store（FE-B2）
 *
 * 会话打开时拉取一次 `GET /api/session/:id/shared-scripts`，缓存在模块级并广播；
 * `HtmlMessage` 订阅后决定是否为该消息注入共享运行时。
 * 切会话时清空，避免上一个会话的脚本包串到新会话。
 */
import { EMPTY_BUNDLE, type SharedScriptBundle } from './sharedRuntime.ts';

let current: SharedScriptBundle = EMPTY_BUNDLE;
let currentSession = '';
let requestGeneration = 0;
let inflight: { sessionId: string; generation: number; promise: Promise<SharedScriptBundle> } | null = null;
const listeners = new Set<() => void>();

export function getSharedBundle(): SharedScriptBundle {
  return current;
}

export function subscribeSharedBundle(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* 订阅者异常不影响其它订阅者 */ }
  }
}

/** 会话切换时清空（防止跨会话串包） */
export function resetSharedBundle(sessionId = ''): void {
  if (currentSession === sessionId && current === EMPTY_BUNDLE) return;
  requestGeneration += 1;
  currentSession = sessionId;
  current = EMPTY_BUNDLE;
  inflight = null;
  emit();
}

export type BundleFetcher = <T>(path: string) => Promise<T>;

/** 拉取并缓存（同会话幂等；并发调用复用同一 in-flight） */
export async function loadSharedBundle(sessionId: string, fetcher: BundleFetcher): Promise<SharedScriptBundle> {
  if (!sessionId) return EMPTY_BUNDLE;
  if (currentSession === sessionId && current.manifestHash) return current;
  if (currentSession !== sessionId) {
    requestGeneration += 1;
    currentSession = sessionId;
    current = EMPTY_BUNDLE;
    inflight = null;
    // 切换瞬间就通知所有消费者清空旧包；不能等新请求完成后才更新会话宿主。
    emit();
  }
  if (inflight?.sessionId === sessionId) return inflight.promise;
  const generation = ++requestGeneration;
  const promise = (async () => {
    try {
      const b = await fetcher<SharedScriptBundle>(`/api/session/${encodeURIComponent(sessionId)}/shared-scripts`);
      if (!b || typeof b !== 'object' || !Array.isArray(b.scripts)) {
        throw new Error('shared-scripts 返回结构非法');
      }
      const loaded = { ...EMPTY_BUNDLE, ...b };
      if (currentSession === sessionId && requestGeneration === generation) {
        current = loaded;
        emit();
      }
      return loaded;
    } catch {
      // 无清单（未导入卡 / 卡无 tavern_helper 脚本 / 旧会话）：保持空包，不伪造
      if (currentSession === sessionId && requestGeneration === generation) {
        current = EMPTY_BUNDLE;
        emit();
      }
      return EMPTY_BUNDLE;
    } finally {
      // 旧会话请求可以自然结束，但不得清掉新会话正在进行的请求。
      if (inflight?.generation === generation) inflight = null;
    }
  })();
  inflight = { sessionId, generation, promise };
  return promise;
}
