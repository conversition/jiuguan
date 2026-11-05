/** @author Codex @date 2026-10-20 @version 1.0
 * P17-02.1 生命周期层：把恢复入口挂进服务端——**启动即跑一次 + 周期触发**。
 *
 * 纪律：
 * 1. **单轮失败不停表**：一轮恢复抛错只计数并记 redacted 日志，下一次照常跑——
 *    恢复是后台尽力而为的工作，坏一轮不能让后续恢复停摆；
 * 2. **计时器可注入**：测试用假计时器手动 tick，不用真的等 interval；
 * 3. **单轮串行**：计时器与手动触发共享在途 Promise，停止后可等待重建收尾。
 */
import type { AgentLoopProjectionStore, AgentLoopRecoveryCursor } from './agent-loop-projection-store.ts';
import { recoverStaleAgentLoopTasks, type AgentLoopRecoveryOptions } from './agent-loop-recovery.ts';
import type { AgentLoopRefResolver } from './agent-loop-continuation.ts';

export const AGENT_LOOP_RECOVERY_LIFECYCLE_VERSION =
  'agent-loop-recovery-lifecycle-v1' as const;

export interface AgentLoopRecoveryLifecycleOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly intervalMs: number;
  readonly limit?: number;
  readonly resolvers?: Record<string, AgentLoopRefResolver>;
  readonly sourceState?: AgentLoopRecoveryOptions['sourceState'];
  readonly shadowPublication?: AgentLoopRecoveryOptions['shadowPublication'];
  readonly summaryApplyCompletion?: AgentLoopRecoveryOptions['summaryApplyCompletion'];
  /** 默认 console.warn；日志只写 redacted 计数，不写任务内容。 */
  readonly logger?: (message: string) => void;
  readonly runOnStart?: boolean;
  /** 计时器注入点：默认真实 setInterval/clearInterval。 */
  readonly timers?: Readonly<{
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  }>;
}

export interface AgentLoopRecoveryLifecycleStats {
  readonly runs: number;
  readonly errors: number;
  /** 仅计已接管并重建 continuation 的任务，不代表已恢复执行。 */
  readonly reconstructed: number;
  /** Historical Manager-published metadata completions, never execution/reconstruction. */
  readonly publicationReconciled?: number;
  /** Independent committed apply metadata, never execution/reconstruction. */
  readonly summaryApplyReconciled?: number;
  readonly lastRunAt: string | null;
  readonly stopped: boolean;
  readonly active: boolean;
}

export interface AgentLoopRecoveryLifecycleHandle {
  /** 幂等：重复调用无副作用。 */
  stop(): void;
  /** 立即手动跑一轮；并发触发共享同一轮，stopped 后为空操作。 */
  runOnce(): Promise<void>;
  whenIdle(): Promise<void>;
  /** 先停止新轮次，再等待在途重建结束；此后可以关闭 Store。 */
  quiesce(): Promise<void>;
  stats(): AgentLoopRecoveryLifecycleStats;
}

const DEFAULT_TIMERS = Object.freeze({
  set: (fn: () => void, ms: number) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clear: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
});

export function startAgentLoopRecoveryLifecycle(
  options: AgentLoopRecoveryLifecycleOptions,
): AgentLoopRecoveryLifecycleHandle {
  const logger = options.logger ?? ((message: string) => console.warn(message));
  const timers = options.timers ?? DEFAULT_TIMERS;
  let runs = 0;
  let errors = 0;
  let reconstructed = 0;
  let publicationReconciled = 0;
  let summaryApplyReconciled = 0;
  let lastRunAt: string | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let cursor: AgentLoopRecoveryCursor | null = null;

  const runRound = async (): Promise<void> => {
    runs += 1;
    lastRunAt = new Date().toISOString();
    try {
      const report = await recoverStaleAgentLoopTasks(options.store, {
        ownerId: options.ownerId,
        leaseMs: options.leaseMs,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(cursor === null ? {} : { after: cursor }),
        ...(options.resolvers === undefined ? {} : { resolvers: options.resolvers }),
        ...(options.sourceState === undefined ? {} : { sourceState: options.sourceState }),
        ...(options.shadowPublication === undefined ? {} : { shadowPublication: options.shadowPublication }),
        ...(options.summaryApplyCompletion === undefined ? {} : { summaryApplyCompletion: options.summaryApplyCompletion }),
      });
      cursor = report.nextCursor;
      reconstructed += report.claimed;
      publicationReconciled += report.publicationReconciled ?? 0;
      summaryApplyReconciled += report.summaryApplyReconciled ?? 0;
      if (report.claimed > 0) {
        logger(`[agent-loop] recovery claimed=${report.claimed} skipped=${report.skipped} (redacted)`);
      }
      if ((report.publicationReconciled ?? 0) > 0) {
        logger(`[agent-loop] publication metadata reconciled=${report.publicationReconciled} skipped=${report.skipped} (redacted)`);
      }
      if ((report.summaryApplyReconciled ?? 0) > 0) {
        logger(`[agent-loop] summary apply metadata reconciled=${report.summaryApplyReconciled} skipped=${report.skipped} (redacted)`);
      }
    } catch {
      // 单轮失败不停表：恢复是尽力而为的后台工作。
      errors += 1;
      logger('[agent-loop] recovery round failed (redacted)');
    }
  };

  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = runRound().finally(() => { inFlight = null; });
    return inFlight;
  };

  if (options.runOnStart !== false) {
    void runOnce();
  }
  const handle = timers.set(() => { void runOnce(); }, options.intervalMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    timers.clear(handle);
  };
  const whenIdle = (): Promise<void> => inFlight ?? Promise.resolve();

  return Object.freeze({
    stop,
    runOnce,
    whenIdle,
    quiesce: () => { stop(); return whenIdle(); },
    stats: () => Object.freeze({
      runs, errors, reconstructed, lastRunAt, stopped, active: inFlight !== null,
      ...(options.shadowPublication === undefined ? {} : { publicationReconciled }),
      ...(options.summaryApplyCompletion === undefined ? {} : { summaryApplyReconciled }),
    }),
  });
}
