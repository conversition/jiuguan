/** P17-01.4: single-flight background drains with bounded, abort-first shutdown. */
import type { StyleCompileJobStore } from './style-compile-job-store.ts';
import { drainStyleCompileJobsOnce, type StyleCompileJobHost } from './style-compile-job-executor.ts';

export interface StyleCompileJobLifecycleTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface StyleCompileJobLifecycle {
  /** 手动跑一轮（测试与启动即跑一次共用）。stop 后只累计 runs，不真正执行。 */
  runOnce(): Promise<void>;
  /** 停表并立即中止在途 drain；只等待既有 drain，不认领新作业。重复调用共用 Promise。 */
  quiesce(): Promise<void>;
  /** 停表并放弃后续轮次。幂等；与 quiesce 可任意顺序多次调用。 */
  stop(): void;
  stats(): Readonly<{
    runs: number; errors: number; stopped: boolean; quiesced: boolean;
    active: boolean; drainTimedOut: number;
  }>;
}

export function startStyleCompileJobLifecycle(options: Readonly<{
  store: StyleCompileJobStore;
  host: StyleCompileJobHost;
  ownerId: string;
  leaseMs: number;
  intervalMs: number;
  limit: number;
  availabilityDeferMs?: number;
  quiesceTimeoutMs?: number;
  now?: () => string;
  timers: StyleCompileJobLifecycleTimers;
  logger?: (message: string) => void;
  runOnStart?: boolean;
}>): StyleCompileJobLifecycle {
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(quiesceTimeoutMs) || quiesceTimeoutMs < 0) {
    throw new TypeError('style-job-quiesce-timeout-invalid');
  }
  if (Boolean(options.timers.setTimeout) !== Boolean(options.timers.clearTimeout)) {
    throw new TypeError('style-job-deadline-timers-incomplete');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const setDeadline = options.timers.setTimeout?.bind(options.timers)
    ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearDeadline = options.timers.clearTimeout?.bind(options.timers)
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const state = {
    runs: 0, errors: 0, stopped: false, quiesced: false, stopping: false, drainTimedOut: 0,
  };
  const idle = Promise.resolve();
  let activeDrain: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let quiescePromise: Promise<void> | undefined;
  const log = (message: string): void => {
    try { options.logger?.(message); } catch { /* Logging must not hold the worker or shutdown open. */ }
  };
  const runDrain = async (signal: AbortSignal): Promise<void> => {
    try {
      const report = await drainStyleCompileJobsOnce({
        store: options.store, host: options.host, owner: options.ownerId,
        now, leaseMs: options.leaseMs, limit: options.limit, signal,
        availabilityDeferMs: options.availabilityDeferMs,
      });
      if (report.claimed > 0) {
        log(`[StyleJob] claimed=${report.claimed} completed=${report.completed} `
          + `failed=${report.failed} cancelled=${report.cancelled} skipped=${report.skipped} `
          + `uncertain=${report.uncertain} deferred=${report.deferred}`);
      }
    } catch (error) {
      if (!signal.aborted) state.errors += 1;
      log(`[StyleJob] 单轮失败（style-job-drain-failed）：`
        + `${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
    }
  };

  const lifecycle: StyleCompileJobLifecycle = {
    runOnce() {
      state.runs += 1;
      if (state.stopped || state.stopping) return idle;
      if (activeDrain) return activeDrain;
      const controller = new AbortController();
      activeController = controller;
      // Publish the shared Promise before Host code can synchronously re-enter runOnce().
      const drain = Promise.resolve().then(() => runDrain(controller.signal)).finally(() => {
        if (activeDrain === drain) {
          activeDrain = undefined;
          activeController = undefined;
        }
      });
      activeDrain = drain;
      return drain;
    },
    quiesce() {
      if (quiescePromise) return quiescePromise;
      let resolveQuiesce!: () => void;
      let rejectQuiesce!: (error: unknown) => void;
      // Abort listeners may synchronously call quiesce again; publish before invoking them.
      quiescePromise = new Promise<void>((resolve, reject) => {
        resolveQuiesce = resolve;
        rejectQuiesce = reject;
      });
      state.quiesced = true;
      state.stopping = true;
      stopTimer();
      activeController?.abort();
      if (!activeDrain) {
        state.stopping = false;
        state.stopped = true;
        resolveQuiesce();
        return quiescePromise;
      }
      let deadlineHandle: unknown;
      const deadline = new Promise<'deadline'>((resolve) => {
        deadlineHandle = setDeadline(() => resolve('deadline'), quiesceTimeoutMs);
      });
      void Promise.race([
        activeDrain.then(() => 'drained' as const), deadline,
      ]).then((result) => {
        if (result === 'deadline') {
          state.drainTimedOut += 1;
          log(`[StyleJob] 关停等待超时（style-job-drain-timeout）：${quiesceTimeoutMs}ms`);
        }
      }).finally(() => {
        clearDeadline(deadlineHandle);
        state.stopping = false;
        state.stopped = true;
      }).then(resolveQuiesce, rejectQuiesce);
      return quiescePromise;
    },
    stop() {
      state.stopped = true;
      stopTimer();
      activeController?.abort();
    },
    stats() {
      return Object.freeze({
        runs: state.runs, errors: state.errors, stopped: state.stopped, quiesced: state.quiesced,
        active: activeDrain !== undefined, drainTimedOut: state.drainTimedOut,
      });
    },
  };

  let timerHandle: unknown = null;
  function stopTimer(): void {
    if (timerHandle !== null) {
      const handle = timerHandle;
      timerHandle = null;
      options.timers.clearInterval(handle);
    }
  }
  if (options.intervalMs > 0) {
    timerHandle = options.timers.setInterval(() => { void lifecycle.runOnce(); }, options.intervalMs);
  }
  if (options.runOnStart === true) void lifecycle.runOnce();
  return lifecycle;
}
