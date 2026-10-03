/**
 * P10-10/11：返回键导航策略 + 断网重连管理。
 */
import type { ClientScheduler } from '../../../packages/client-runtime/src/index.ts';

// ── P10-10：返回键导航策略 ────────────────────────────────────────────────

export type BackAction = 'history-back' | 'request-exit-confirm' | 'keep-alive';

export interface NavigationPolicyInput {
  canGoBack: boolean;
  /** 有活动生成任务时不允许直接退出（P7 任务在服务端，离开只是不再看）。 */
  hasActiveJob: boolean;
  /** 用户已在本会话表达过"退出意向"（双击返回）。 */
  exitConfirmPending: boolean;
}

export function resolveBackAction(input: NavigationPolicyInput): BackAction {
  if (input.canGoBack) return 'history-back';
  if (input.hasActiveJob) return 'keep-alive'; // 活动任务：提示后台继续，不退出
  return input.exitConfirmPending ? 'request-exit-confirm' : 'keep-alive'; // 双击返回才确认退出
}

// ── P10-11：断网重连管理 ─────────────────────────────────────────────────

export type ConnectionEvent =
  | { kind: 'offline' }
  | { kind: 'online' }
  | { kind: 'reconnected'; attempt: number };

export interface ConnectionManagerDeps {
  isOnline(): boolean;
  /** 触发一次连通性探测（由调用方实现：GET /health 或事件通道重连）。 */
  probe(): Promise<boolean>;
  scheduler: ClientScheduler;
  onEvent(event: ConnectionEvent): void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface ConnectionManager {
  onOffline(): void;
  onOnline(): void;
  /** 立即尝试恢复（手动触发）。 */
  probeNow(): Promise<boolean>;
  stop(): void;
  readonly recovering: boolean;
}

const DEFAULT_BASE = 1_000;
const DEFAULT_MAX = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;

export function createConnectionManager(deps: ConnectionManagerDeps): ConnectionManager {
  const base = deps.baseDelayMs ?? DEFAULT_BASE;
  const maxDelay = deps.maxDelayMs ?? DEFAULT_MAX;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let recovering = false;
  let attempt = 0;
  let stopped = false;
  let cancelWait: (() => void) | null = null;

  const delay = (n: number): number => Math.min(base * (2 ** Math.max(0, n - 1)), maxDelay);

  const runRecovery = async (): Promise<void> => {
    if (recovering || stopped) return;
    recovering = true;
    try {
      while (!stopped && attempt < maxAttempts) {
        attempt += 1;
        const reachable = await deps.probe();
        if (reachable) {
          deps.onEvent({ kind: 'reconnected', attempt });
          return;
        }
        await new Promise<void>((resolve) => {
          const cancel = deps.scheduler.schedule(() => {
            cancelWait = null;
            resolve();
          }, delay(attempt));
          cancelWait = () => {
            cancel();
            cancelWait = null;
            resolve();
          };
        });
      }
      if (!stopped) deps.onEvent({ kind: 'offline' }); // 重试耗尽：仍视为离线
    } finally {
      recovering = false;
    }
  };

  return {
    get recovering(): boolean { return recovering; },
    onOffline(): void {
      if (!recovering && !stopped) {
        attempt = 0;
        deps.onEvent({ kind: 'offline' });
        void runRecovery();
      }
    },
    onOnline(): void {
      if (!recovering && !stopped) void runRecovery();
    },
    async probeNow(): Promise<boolean> {
      const reachable = await deps.probe();
      if (reachable) deps.onEvent({ kind: 'reconnected', attempt: 0 });
      return reachable;
    },
    stop(): void {
      stopped = true;
      cancelWait?.();
    },
  };
}
