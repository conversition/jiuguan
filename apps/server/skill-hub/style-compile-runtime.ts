/** P17-01.4a.4.3: bounded recovery orchestration over the existing Style ledger and lifecycle. */
import type { createStyleCompilePipeline } from './style-compile-pipeline.ts';
import type { StyleCompileJobHost, PreparedStyleJobOutcome } from './style-compile-job-executor.ts';
import type { StyleCompileJobStore, StyleCompileJobRecord } from './style-compile-job-store.ts';
import type { StyleCompilePilotBudgetReservation } from './style-compile-job-store.ts';
import {
  startStyleCompileJobLifecycle, type StyleCompileJobLifecycle,
  type StyleCompileJobLifecycleTimers,
} from './style-compile-job-lifecycle.ts';

type Pipeline = Pick<ReturnType<typeof createStyleCompilePipeline>,
  'host' | 'deliverSessionIntents' | 'reconcileSession'>;

export interface StyleCompileRuntimeOptions {
  readonly store: StyleCompileJobStore;
  readonly pipeline: Pipeline;
  /** A bounded, metadata-only inventory. A null nextCursor restarts the next fair sweep. */
  listSessionIds(input: Readonly<{ cursor: string | null; limit: number }>): Readonly<{
    sessionIds: readonly string[]; nextCursor: string | null;
  }>;
  /** The server owns no-create loading and must recheck deletion admission before publication. */
  loadSession(rawSessionId: string): Promise<unknown | null | undefined>;
  sourceAllowed?(rawSessionId: string): boolean;
  /** Only the durable, permanently committed privacy journal may authorize metadata erasure. */
  isPrivacyCommitted?(rawSessionId: string): boolean;
  /** Busy foreground/post-turn work defers a lease; it is never a source-deletion fence. */
  isSessionAvailable?(rawSessionId: string): boolean;
  /** Pure live authority check; off permits readback but never new delivery/claims. */
  mode(): 'off' | 'background';
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly intervalMs: number;
  readonly jobLimit?: number;
  readonly sessionLimit?: number;
  readonly intentPageSize?: number;
  readonly quiesceTimeoutMs?: number;
  readonly timers: StyleCompileJobLifecycleTimers;
  readonly now?: () => string;
  readonly logger?: (message: string) => void;
  /** The composition root opts in only after deletion recovery and plugins are ready. */
  readonly runOnStart?: boolean;
}

export interface StyleCompileRuntime {
  readJob(jobId: string): StyleCompileJobRecord | null;
  reservePilotBudget(input: StyleCompilePilotBudgetReservation): void;
  haltPilotBudget(pilotIdDigest: string): void;
  runOnce(): Promise<void>;
  /** Wake is only a hint. It cannot rewind a durable intent page or mint dispatch permission. */
  wakeSession(rawSessionId: string): void;
  /** Cancel only this session and promptly leave its logical model operation. */
  quiesceSession(rawSessionId: string): Promise<void>;
  fenceSourceRevision(rawSessionId: string, sourceRevision: string): number;
  redactSession(rawSessionId: string): Promise<void>;
  quiesce(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
  stats(): Readonly<{
    runs: number; errors: number; active: boolean; stopped: boolean; closed: boolean;
    scannedSessions: number; delivered: number; settled: number; failed: number;
    queuedWakes: number; drainRuns: number; drainErrors: number; drainTimedOut: number;
  }>;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    && !/[\u0000-\u001f]/u.test(value);
}

/** The physical Provider may ignore abort. Its late result is observed but cannot reach commit. */
function abortable<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('style-runtime-operation-aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    // Deferral publishes the runtime's active identity before a Host may synchronously re-enter it.
    void Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('style-runtime-operation-aborted');
      return execute();
    }).then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export function startStyleCompileRuntime(options: StyleCompileRuntimeOptions): StyleCompileRuntime {
  const sessionLimit = options.sessionLimit ?? 8;
  const intentPageSize = options.intentPageSize ?? 32;
  const jobLimit = options.jobLimit ?? 4;
  for (const [value, maximum, code] of [
    [sessionLimit, 128, 'session-limit'], [intentPageSize, 256, 'intent-page-size'],
    [jobLimit, 128, 'job-limit'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`style-runtime-${code}-invalid`);
    }
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) {
    throw new TypeError('style-runtime-interval-invalid');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const state = {
    runs: 0, errors: 0, stopped: false, closed: false, scannedSessions: 0,
    delivered: 0, settled: 0, failed: 0,
  };
  const retired = { runs: 0, errors: 0, drainTimedOut: 0 };
  const cursors = new Map<string, number>();
  const wakes = new Set<string>();
  const redacted = new Set<string>();
  const suspending = new Set<string>();
  let inventoryCursor: string | null = null;
  let privacyCursor: string | null = null;
  let activeRun: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let activeModel: { sessionId: string; sourceRevision: string; job: StyleCompileJobRecord;
    controller: AbortController; done: Promise<PreparedStyleJobOutcome> } | undefined;
  let quiescePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let timer: unknown = null;
  const idle = Promise.resolve();
  const log = (code: string): void => {
    try { options.logger?.(`[StyleRuntime] ${code}`); } catch { /* Diagnostics never authorize work. */ }
  };
  const allowed = (id: string): boolean => {
    if (!identifier(id) || redacted.has(id) || suspending.has(id)) return false;
    try {
      if (options.isPrivacyCommitted?.(id) === true) return false;
      return options.sourceAllowed?.(id) !== false;
    } catch { return false; }
  };
  const background = (): boolean => {
    if (state.stopped || state.closed) return false;
    try { return options.mode() === 'background'; } catch { return false; }
  };
  const available = (id: string): boolean => {
    try { return options.isSessionAvailable?.(id) !== false; } catch { return false; }
  };
  let lifecycle: StyleCompileJobLifecycle;
  const stopDispatch = (): void => {
    // Stopping the existing drain aborts it before it can claim a later job in the same batch.
    lifecycle.stop();
    activeModel?.controller.abort();
  };
  const host: StyleCompileJobHost = {
    ...options.pipeline.host,
    resolveSession: (id) => {
      if (!allowed(id)) return null;
      return options.pipeline.host.resolveSession(id);
    },
    isSessionAvailable: available,
    isIntentCurrent: (job) => {
      if (!background()) { stopDispatch(); return false; }
      return allowed(job.sessionId) && options.pipeline.host.isIntentCurrent?.(job) !== false;
    },
    executeStyleJob(job, context) {
      if (!allowed(job.sessionId) || !background()) {
        stopDispatch();
        return Promise.reject(new Error('style-runtime-dispatch-closed'));
      }
      if (!available(job.sessionId)) {
        // The foreground may have become busy after the executor's first availability read.
        // Do not race it for a Provider slot or pretend this late closed boundary is success.
        return Promise.reject(new Error('style-runtime-session-became-unavailable'));
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (context.signal.aborted) controller.abort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
      const done = abortable(controller.signal, () => options.pipeline.host.executeStyleJob(job, { signal: controller.signal }))
        .then((outcome): PreparedStyleJobOutcome => {
          if (!background()) stopDispatch();
          if (controller.signal.aborted || !allowed(job.sessionId) || !background()) {
            throw new Error('style-runtime-prepared-source-closed');
          }
          if (outcome.status !== 'prepared') return outcome;
          return { status: 'prepared', commit: () => {
            if (!background()) stopDispatch();
            if (controller.signal.aborted || !allowed(job.sessionId) || !background()) {
              return { status: 'unknown', attempted: true };
            }
            return outcome.commit();
          } };
        }).finally(() => {
          context.signal.removeEventListener('abort', onAbort);
          if (activeModel?.done === done) activeModel = undefined;
        });
      activeModel = { sessionId: job.sessionId, sourceRevision: job.sourceRevision, job, controller, done };
      return done;
    },
  };
  const createLifecycle = (): StyleCompileJobLifecycle => startStyleCompileJobLifecycle({
    store: options.store, host, ownerId: options.ownerId, leaseMs: options.leaseMs,
    intervalMs: 0, limit: jobLimit, now, timers: options.timers,
    availabilityDeferMs: 10_000,
    quiesceTimeoutMs: options.quiesceTimeoutMs, logger: options.logger, runOnStart: false,
  });
  lifecycle = createLifecycle();

  const rotateLifecycle = (): void => {
    if (!lifecycle.stats().stopped) return;
    const previous = lifecycle.stats();
    retired.runs += previous.runs;
    retired.errors += previous.errors;
    retired.drainTimedOut += previous.drainTimedOut;
    lifecycle = createLifecycle();
  };
  const stopTimer = (): void => {
    if (timer !== null) {
      const current = timer;
      timer = null;
      options.timers.clearInterval(current);
    }
  };
  const record = (report: ReturnType<Pipeline['reconcileSession']>): void => {
    state.delivered += report.delivered;
    state.settled += report.settled;
    state.failed += report.failed;
  };
  const batch = async (signal: AbortSignal): Promise<void> => {
    try {
      // A completed deletion journal may predate this ledger, or an old backup may restore rows.
      // Sweep the central metadata independently of sourceAllowed and Session discovery/loading.
      if (options.isPrivacyCommitted) {
        try {
          const page = options.store.scanSessionIds({ cursor: privacyCursor, limit: sessionLimit });
          privacyCursor = page.nextCursor;
          for (const id of page.sessionIds) {
            if (signal.aborted || state.stopped) break;
            try {
              if (options.isPrivacyCommitted(id) === true) await runtime.redactSession(id);
            } catch { state.errors += 1; log('style-runtime-privacy-recovery-pending'); }
          }
        } catch { state.errors += 1; log('style-runtime-privacy-scan-failed'); }
      }
      if (signal.aborted || state.stopped) return;
      const chosen: string[] = [];
      // Wakes may expedite latency, but never occupy the entire fair inventory budget.
      const wakeLimit = sessionLimit === 1 ? state.runs % 2 : Math.floor(sessionLimit / 2);
      for (const id of wakes) {
        if (chosen.length >= wakeLimit) break;
        wakes.delete(id);
        if (allowed(id)) chosen.push(id);
      }
      const pageLimit = sessionLimit - chosen.length;
      const page = pageLimit > 0
        ? options.listSessionIds({ cursor: inventoryCursor, limit: pageLimit })
        : { sessionIds: [], nextCursor: inventoryCursor };
      if (!Array.isArray(page.sessionIds) || page.sessionIds.length > pageLimit
        || page.sessionIds.some((id) => !identifier(id))
        || new Set(page.sessionIds).size !== page.sessionIds.length
        || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096))) {
        throw new TypeError('style-runtime-inventory-invalid');
      }
      inventoryCursor = page.nextCursor;
      for (const id of page.sessionIds) if (!chosen.includes(id) && allowed(id)) chosen.push(id);
      const scanned: Array<{ id: string; cursor: number }> = [];
      for (const id of chosen) {
        if (signal.aborted || state.stopped) break;
        try {
          const loaded = await abortable(signal, () => options.loadSession(id));
          if (!loaded || signal.aborted || state.stopped || !allowed(id)) continue;
          const cursor = cursors.get(id) ?? 0;
          if (!background()) stopDispatch();
          const report = background()
            ? options.pipeline.deliverSessionIntents(id, { cursor, limit: intentPageSize })
            : options.pipeline.reconcileSession(id, { cursor, limit: intentPageSize });
          record(report);
          state.scannedSessions += 1;
          if (report.hasMore) cursors.set(id, report.nextCursor);
          else cursors.delete(id);
          scanned.push({ id, cursor });
        } catch {
          if (!signal.aborted) { state.errors += 1; log('style-runtime-session-page-failed'); }
        }
      }
      if (!signal.aborted && background()) {
        rotateLifecycle();
        await lifecycle.runOnce();
      }
      if (signal.aborted || state.stopped) return;
      // Revisit exactly the pages just delivered. This does not advance or reset their cursors.
      for (const { id, cursor } of scanned) {
        if (!allowed(id)) continue;
        try { record(options.pipeline.reconcileSession(id, { cursor, limit: intentPageSize })); }
        catch { state.errors += 1; log('style-runtime-readback-failed'); }
      }
    } catch {
      if (!signal.aborted) { state.errors += 1; log('style-runtime-batch-failed'); }
    }
  };

  const runtime: StyleCompileRuntime = {
    reservePilotBudget(input) {
      if (state.stopped || state.closed || !background()) throw new Error('style-pilot-runtime-closed');
      options.store.reservePilotBudget(input);
    },
    haltPilotBudget(pilotIdDigest) {
      if (state.closed) throw new Error('style-pilot-runtime-closed');
      options.store.haltPilotBudget(pilotIdDigest);
    },
    runOnce() {
      state.runs += 1;
      if (state.stopped || state.closed) return idle;
      if (!background()) stopDispatch();
      if (activeRun) return activeRun;
      const controller = new AbortController();
      activeController = controller;
      const run = Promise.resolve().then(() => batch(controller.signal)).finally(() => {
        if (activeRun === run) { activeRun = undefined; activeController = undefined; }
      });
      activeRun = run;
      return run;
    },
    wakeSession(id) {
      if (state.stopped || state.closed || !identifier(id) || redacted.has(id)) return;
      if (!background()) stopDispatch();
      const model = activeModel?.sessionId === id ? activeModel : undefined;
      if (model && !model.controller.signal.aborted) {
        let current = false;
        try { current = options.pipeline.host.isIntentCurrent?.(model.job) !== false; }
        catch { /* A failed original-packet read cannot preserve in-flight write authority. */ }
        if (!current) {
          try { options.store.cancelBySourceRevision(id, model.sourceRevision, now()); }
          catch { state.errors += 1; log('style-runtime-wake-source-fence-failed'); }
          finally { model.controller.abort(); }
        }
      }
      if (wakes.size < 256 || wakes.has(id)) wakes.add(id);
      void runtime.runOnce();
    },
    async quiesceSession(id) {
      if (state.closed || !identifier(id)) return;
      suspending.add(id);
      wakes.delete(id);
      try {
        const model = activeModel?.sessionId === id ? activeModel : undefined;
        let failure: unknown;
        let failed = false;
        try { options.store.cancelForSession(id, 'style-job-cancelled-request', now()); }
        catch (error) { failed = true; failure = error; }
        model?.controller.abort();
        await model?.done.catch(() => {});
        if (failed) throw failure;
      } finally { suspending.delete(id); }
    },
    fenceSourceRevision(id, revision) {
      if (state.closed) return 0;
      try { return options.store.cancelBySourceRevision(id, revision, now()); }
      finally {
        if (activeModel?.sessionId === id && activeModel.sourceRevision === revision) activeModel.controller.abort();
      }
    },
    async redactSession(id) {
      if (state.closed || !identifier(id)) return;
      redacted.add(id);
      wakes.delete(id);
      cursors.delete(id);
      await runtime.quiesceSession(id);
      options.store.deleteSessionAfterPrivacyFence(id);
    },
    quiesce() {
      if (quiescePromise) return quiescePromise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      quiescePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      runtime.stop();
      void Promise.all([lifecycle.quiesce(), activeRun ?? idle]).then(() => resolve(), reject);
      return quiescePromise;
    },
    stop() {
      state.stopped = true;
      stopTimer();
      activeController?.abort();
      stopDispatch();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(() => runtime.quiesce()).then(() => {
        if (state.closed) return;
        options.store.close();
        state.closed = true;
      });
      return closePromise;
    },
    readJob(jobId) {
      if (state.closed) throw new Error('style-runtime-closed');
      return options.store.read(jobId);
    },
    stats() {
      const drain = lifecycle.stats();
      return Object.freeze({ ...state, active: activeRun !== undefined, queuedWakes: wakes.size,
        drainRuns: retired.runs + drain.runs, drainErrors: retired.errors + drain.errors,
        drainTimedOut: retired.drainTimedOut + drain.drainTimedOut });
    },
  };
  if (options.intervalMs > 0) {
    timer = options.timers.setInterval(() => { void runtime.runOnce(); }, options.intervalMs);
  }
  if (options.runOnStart === true) void runtime.runOnce();
  return runtime;
}
