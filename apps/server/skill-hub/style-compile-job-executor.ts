/** P17-01.4: durable execution fence around Provider work and synchronous proposal commit. */
import type {
  StyleCompileJobRecord, StyleCompileJobStore, StyleCompileJobClaim, StyleCompileJobResult,
} from './style-compile-job-store.ts';

export type PreparedStyleJobOutcome =
  | Readonly<{ status: 'prepared'; commit: () => StyleCompileJobResult }>
  | Readonly<{ status: 'rejected' | 'provider-failed' | 'ineligible'; detail?: string }>;

/** Provider work prepares a result; business writes belong exclusively in the synchronous commit callback. */
export interface StyleCompileJobHost {
  resolveSession(sessionId: string): unknown | null;
  /** Admission-only busy/quiet gate; false must not pretend a loaded source was deleted. */
  isSessionAvailable?(sessionId: string): boolean;
  /** Unloaded/unavailable sessions are not deleted. Only an authoritative tombstone may return true. */
  isSessionDeleted?(sessionId: string): boolean;
  isSourceRevisionCommitted(sessionId: string, sourceRevision: string, job?: StyleCompileJobRecord): boolean;
  /** Must compare the original durable packet, never rebuild a request from run/source alone. */
  isIntentCurrent?(job: StyleCompileJobRecord): boolean;
  /** Best-effort projection; the durable result remains authoritative if this callback fails. */
  onJobSettled?(job: StyleCompileJobRecord): void;
  executeStyleJob(
    job: StyleCompileJobRecord,
    context: Readonly<{ signal: AbortSignal }>,
  ): Promise<PreparedStyleJobOutcome>;
}

export interface StyleJobDrainReport {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly uncertain: number;
  readonly deferred: number;
}

class StyleJobAbortedError extends Error {
  constructor() { super('style-job-drain-aborted'); }
}

/** Abort does not depend on the Provider cooperating. The original Promise still has rejection handlers. */
function abortable<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new StyleJobAbortedError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    try {
      Promise.resolve(execute()).then(
        (value) => { cleanup(); resolve(value); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    } catch (error) { cleanup(); reject(error); }
  });
}

export async function drainStyleCompileJobsOnce(options: Readonly<{
  store: StyleCompileJobStore;
  host: StyleCompileJobHost;
  owner: string;
  now: () => string;
  leaseMs: number;
  limit: number;
  /** Unavailable sessions wait without spending lease recovery attempts or spinning in this drain. */
  availabilityDeferMs?: number;
  signal?: AbortSignal;
}>): Promise<StyleJobDrainReport> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 128) {
    throw new TypeError('style-job-drain-limit-invalid');
  }
  const availabilityDeferMs = options.availabilityDeferMs ?? 60_000;
  if (!Number.isSafeInteger(availabilityDeferMs) || availabilityDeferMs <= 0) {
    throw new TypeError('style-job-availability-defer-delay-invalid');
  }
  const signal = options.signal ?? new AbortController().signal;
  const report = {
    claimed: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0, uncertain: 0, deferred: 0,
  };
  const available = (sessionId: string): boolean => {
    try { return options.host.isSessionAvailable?.(sessionId) !== false; }
    catch { return false; }
  };
  // Claim just before execution. A slow first job must not spend every later job's lease.
  for (let i = 0; i < options.limit && !signal.aborted; i += 1) {
    const job = options.store.claimDue({
      owner: options.owner, now: options.now(), leaseMs: options.leaseMs, limit: 1,
    })[0];
    if (!job) break;
    report.claimed += 1;
    const claim: StyleCompileJobClaim = job;
    try {
      const session = options.host.resolveSession(job.sessionId);
      const sessionDeleted = options.host.isSessionDeleted?.(job.sessionId) === true;
      if (sessionDeleted || !session || !available(job.sessionId)) {
        if (sessionDeleted) {
          options.store.cancelForSession(
            job.sessionId, 'style-job-cancelled-session-deleted', options.now(),
          );
        } else {
          // A separate durable availability timer preserves generation without exhausting recovery budget.
          report.deferred += options.store.deferUnavailable(claim, options.now(), availabilityDeferMs) ? 1 : 0;
        }
        continue;
      }
      if (!options.host.isSourceRevisionCommitted(job.sessionId, job.sourceRevision, job)
        || options.host.isIntentCurrent?.(job) === false) {
        options.store.fenceByExecutor(claim, options.now());
        continue;
      }
      // Source reads can synchronously re-enter the host and close availability.
      // This is still before the durable execution marker and any Provider work.
      if (!available(job.sessionId)) {
        report.deferred += options.store.deferUnavailable(claim, options.now(), availabilityDeferMs) ? 1 : 0;
        continue;
      }
      if (signal.aborted || !options.store.startExecution(claim, options.now())) continue;
      // A crash from this point is an uncertain execution, never a fresh automatic Provider attempt.
      const outcome = await abortable(signal, () => options.host.executeStyleJob(job, { signal }));
      if (signal.aborted) throw new StyleJobAbortedError();
      const currentSession = options.host.resolveSession(job.sessionId);
      const currentSessionDeleted = options.host.isSessionDeleted?.(job.sessionId) === true;
      if (currentSessionDeleted || !currentSession) {
        if (currentSessionDeleted) {
          options.store.cancelForSession(job.sessionId, 'style-job-cancelled-session-deleted', options.now());
        } else {
          options.store.markUncertain(claim, options.now());
        }
        continue;
      }
      if (!options.host.isSourceRevisionCommitted(job.sessionId, job.sourceRevision, job)
        || options.host.isIntentCurrent?.(job) === false) {
        const fenced = options.store.fenceByExecutor(claim, options.now());
        if (!fenced) options.store.markUncertain(claim, options.now());
        continue;
      }
      if (outcome.status === 'prepared') {
        if (typeof outcome.commit !== 'function') throw new TypeError('style-job-commit-missing');
        if (Object.prototype.toString.call(outcome.commit) === '[object AsyncFunction]') {
          throw new TypeError('style-job-commit-must-be-synchronous');
        }
        options.store.withCommitAuthority(claim, options.now(), () => {
          // Re-read the source while holding the ledger commit authority; the host still owns its domain CAS.
          if (signal.aborted || !options.host.resolveSession(job.sessionId)
            || options.host.isSessionDeleted?.(job.sessionId) === true
            || !options.host.isSourceRevisionCommitted(job.sessionId, job.sourceRevision, job)
            || options.host.isIntentCurrent?.(job) === false) {
            throw new Error('style-job-commit-source-invalidated');
          }
          return outcome.commit();
        });
      } else if (outcome.status === 'rejected' || outcome.status === 'provider-failed') {
        const reason = outcome.status === 'rejected'
          ? 'style-job-failed-rejected' : 'style-job-failed-provider';
        options.store.complete(claim, reason, options.now());
      } else if (outcome.status === 'ineligible') {
        options.store.skipIneligible(claim, options.now());
      } else {
        throw new TypeError('style-job-outcome-invalid');
      }
      // Expiry without another Worker claiming must still disable business writes and stop replay.
      if (options.store.read(job.jobId)?.state === 'executing') {
        options.store.markUncertain(claim, options.now());
      }
    } catch {
      // Before dispatch, the lease can expire safely. After dispatch, unknown effects require readback.
      options.store.markUncertain(claim, options.now());
    } finally {
      // Report and projection use the persisted result, not a boolean commit-authority receipt.
      const settled = options.store.read(job.jobId);
      if (settled?.state === 'done' && settled.result?.status === 'created') report.completed += 1;
      else if (settled?.state === 'failed') report.failed += 1;
      else if (settled?.state === 'uncertain') report.uncertain += 1;
      else if (settled?.state === 'cancelled') {
        if (settled.result?.status === 'skipped') report.skipped += 1;
        else report.cancelled += 1;
      }
      if (settled && ['done', 'failed', 'uncertain', 'cancelled'].includes(settled.state)) {
        try {
          const notification: unknown = options.host.onJobSettled?.(settled);
          if (notification && (typeof notification === 'object' || typeof notification === 'function')
            && 'then' in notification) void Promise.resolve(notification).catch(() => {});
        } catch { /* Projection is replayable; never rewrite an already durable business result. */ }
      }
    }
  }
  return Object.freeze(report);
}
