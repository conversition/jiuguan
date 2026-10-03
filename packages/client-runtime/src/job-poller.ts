/**
 * P7-07：fetch streaming 不可用时的 turn job 轮询降级。
 *
 * 轮询仍走 ClientAuthTransport → ApiClient，使用有界请求 deadline/retry 与轮询退避；
 * 长期 Bearer token 不进入 URL/query。轮询只读公开 job 投影，REST/SQLite 仍是真值。
 */
import {
  isPublicTurnJob,
  isSafeOpaqueId,
  type PublicTurnJob,
  type TurnJobStatus,
} from '@jiuguan/mobile-contracts';
import type { ClientAuthTransport } from './auth-transport.ts';
import {
  ApiClient,
  type ClientClock,
  type ClientScheduler,
} from './api-client.ts';
import { ClientRuntimeError } from './errors.ts';
import { ClientUrlResolver } from './url-resolver.ts';

export const DEFAULT_POLL_BASE_MS = 500;
export const DEFAULT_POLL_MAX_MS = 5_000;
export const DEFAULT_POLL_REQUEST_DEADLINE_MS = 15_000;
export const DEFAULT_POLL_REQUEST_ATTEMPTS = 2;

const TERMINAL_STATUSES: ReadonlySet<TurnJobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export interface TurnJobPollerOptions {
  transport: ClientAuthTransport;
  scheduler: ClientScheduler;
  requestIdFactory: () => string;
  clock?: ClientClock;
  pollBaseMs?: number;
  pollMaxMs?: number;
  requestDeadlineMs?: number;
  requestMaxAttempts?: number;
}

export interface TurnJobPollHandlers {
  onJob(job: PublicTurnJob): void | Promise<void>;
  onError?(error: ClientRuntimeError): void;
}

export interface TurnJobPollHandle {
  stop(): void;
  readonly stopped: boolean;
  /** 终态、显式 stop、外部 abort 或不可恢复 4xx/契约错误后 resolve。 */
  done: Promise<void>;
}

function positiveInteger(value: number, field: string, minimum = 1): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: `invalid-${field}` },
    });
  }
  return value;
}

function reportError(handler: TurnJobPollHandlers['onError'], error: ClientRuntimeError): void {
  try { handler?.(error); } catch { /* 错误观察器不得破坏轮询清理。 */ }
}

export class TurnJobPoller {
  readonly #api: ApiClient;
  readonly #resolver: ClientUrlResolver;
  readonly #scheduler: ClientScheduler;
  readonly #pollBaseMs: number;
  readonly #pollMaxMs: number;
  readonly #requestDeadlineMs: number;
  readonly #requestMaxAttempts: number;

  constructor(options: TurnJobPollerOptions) {
    this.#scheduler = options.scheduler;
    this.#resolver = new ClientUrlResolver(options.transport.endpoint);
    this.#pollBaseMs = positiveInteger(options.pollBaseMs ?? DEFAULT_POLL_BASE_MS, 'poll-base', 50);
    this.#pollMaxMs = positiveInteger(options.pollMaxMs ?? DEFAULT_POLL_MAX_MS, 'poll-max', 50);
    if (this.#pollMaxMs < this.#pollBaseMs) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'invalid-poll-range' },
      });
    }
    this.#requestDeadlineMs = positiveInteger(
      options.requestDeadlineMs ?? DEFAULT_POLL_REQUEST_DEADLINE_MS,
      'poll-request-deadline',
    );
    this.#requestMaxAttempts = positiveInteger(
      options.requestMaxAttempts ?? DEFAULT_POLL_REQUEST_ATTEMPTS,
      'poll-request-attempts',
    );
    this.#api = new ApiClient({
      transport: options.transport,
      clock: options.clock ?? { nowMs: () => Date.now() },
      scheduler: options.scheduler,
      requestIdFactory: options.requestIdFactory,
      defaultDeadlineMs: this.#requestDeadlineMs,
      defaultMaxAttempts: this.#requestMaxAttempts,
      retryBaseDelayMs: this.#pollBaseMs,
    });
  }

  pollJob(runId: string, handlers: TurnJobPollHandlers, signal?: AbortSignal): TurnJobPollHandle {
    if (!isSafeOpaqueId(runId)) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'invalid-run-id' },
      });
    }
    const url = this.#resolver.api(`/api/turn-jobs/${encodeURIComponent(runId)}`);
    const controller = new AbortController();
    let stopRequested = false;
    const stop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      controller.abort();
    };
    const abortFromCaller = (): void => stop();
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });

    const loop = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!stopRequested) {
        let job: PublicTurnJob | undefined;
        try {
          const { response } = await this.#api.request(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
          }, {
            deadlineMs: this.#requestDeadlineMs,
            maxAttempts: this.#requestMaxAttempts,
          });
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            reportError(handlers.onError, new ClientRuntimeError('credential_unavailable', {
              details: { status: response.status },
            }));
            return;
          }
          if (!response.ok) {
            await response.body?.cancel();
            const error = new ClientRuntimeError('network_error', {
              retryable: response.status >= 500,
              details: { status: response.status },
            });
            reportError(handlers.onError, error);
            if (response.status >= 400 && response.status < 500) return;
            consecutiveFailures += 1;
          } else {
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (cause) {
              throw new ClientRuntimeError('transport_violation', {
                details: { reason: 'invalid-job-json' },
                cause,
              });
            }
            job = payload !== null && typeof payload === 'object' && 'job' in payload
              && isPublicTurnJob((payload as { job: unknown }).job)
              ? (payload as { job: PublicTurnJob }).job
              : undefined;
            if (!job || job.runId !== runId) {
              throw new ClientRuntimeError('transport_violation', {
                details: { reason: 'invalid-job-payload' },
              });
            }
            consecutiveFailures = 0;
          }
        } catch (cause) {
          if (stopRequested || (cause instanceof ClientRuntimeError && cause.code === 'request_aborted')) return;
          const error = cause instanceof ClientRuntimeError
            ? cause
            : new ClientRuntimeError('network_error', { retryable: true, cause });
          reportError(handlers.onError, error);
          if (error.code === 'credential_unavailable' || error.code === 'transport_violation') return;
          consecutiveFailures += 1;
        }

        if (job) {
          await handlers.onJob(job);
          if (TERMINAL_STATUSES.has(job.status)) return;
        }
        await this.#wait(this.#pollDelay(consecutiveFailures), controller.signal);
      }
    };

    const done = loop().catch((cause: unknown) => {
      if (stopRequested) return;
      reportError(handlers.onError, cause instanceof ClientRuntimeError
        ? cause
        : new ClientRuntimeError('network_error', { cause }));
    }).finally(() => {
      stopRequested = true;
      controller.abort();
      signal?.removeEventListener('abort', abortFromCaller);
    });

    return {
      stop,
      get stopped(): boolean { return stopRequested; },
      done,
    };
  }

  #pollDelay(failures: number): number {
    return Math.min(
      this.#pollBaseMs * (2 ** Math.max(0, Math.min(failures, 20) - 1)),
      this.#pollMaxMs,
    );
  }

  async #wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const cancel = this.#scheduler.schedule(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cancel();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
