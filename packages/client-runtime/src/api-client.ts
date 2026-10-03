import {
  REQUEST_ID_HEADER,
  isSafeOpaqueId,
} from '@jiuguan/mobile-contracts';
import type { ClientAuthTransport } from './auth-transport.ts';
import { ClientRuntimeError } from './errors.ts';

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const RETRYABLE_METHOD = new Set(['GET', 'HEAD']);

export interface ClientClock {
  nowMs(): number;
}

export interface ClientScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ApiClientOptions {
  transport: ClientAuthTransport;
  clock: ClientClock;
  scheduler: ClientScheduler;
  requestIdFactory: () => string;
  defaultDeadlineMs?: number;
  defaultMaxAttempts?: number;
  retryBaseDelayMs?: number;
}

export interface ApiRequestOptions {
  deadlineMs?: number;
  maxAttempts?: number;
}

export interface ApiClientResult {
  response: Response;
  requestId: string;
  attempts: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(label + ' 必须是正整数');
  }
  return value;
}

function requestTemplate(
  transport: ClientAuthTransport,
  input: string | URL | Request,
  init: RequestInit | undefined,
): Request {
  try {
    if (input instanceof Request) return new Request(input, init);
    return new Request(new URL(String(input), transport.endpoint.origin), init);
  } catch (cause) {
    throw new ClientRuntimeError('transport_violation', { cause });
  }
}

function retryDelay(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^[0-9]+$/.test(retryAfter)) {
    return Number(retryAfter) * 1_000;
  }
  return baseDelayMs * (2 ** Math.max(0, attempt - 1));
}

function waitFor(
  scheduler: ClientScheduler,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const cancel = scheduler.schedule(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, delayMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cancel();
      rejectWait(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ApiClient {
  readonly #transport: ClientAuthTransport;
  readonly #clock: ClientClock;
  readonly #scheduler: ClientScheduler;
  readonly #requestIdFactory: () => string;
  readonly #defaultDeadlineMs: number;
  readonly #defaultMaxAttempts: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: ApiClientOptions) {
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler;
    this.#requestIdFactory = options.requestIdFactory;
    this.#defaultDeadlineMs = positiveInteger(
      options.defaultDeadlineMs ?? 15_000,
      'defaultDeadlineMs',
    );
    this.#defaultMaxAttempts = positiveInteger(
      options.defaultMaxAttempts ?? 2,
      'defaultMaxAttempts',
    );
    this.#retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs ?? 150,
      'retryBaseDelayMs',
    );
  }

  async request(
    input: string | URL | Request,
    init?: RequestInit,
    options: ApiRequestOptions = {},
  ): Promise<ApiClientResult> {
    const template = requestTemplate(this.#transport, input, init);
    const method = template.method.toUpperCase();
    const retryableMethod = RETRYABLE_METHOD.has(method);
    const deadlineMs = positiveInteger(
      options.deadlineMs ?? this.#defaultDeadlineMs,
      'deadlineMs',
    );
    const requestedAttempts = positiveInteger(
      options.maxAttempts ?? this.#defaultMaxAttempts,
      'maxAttempts',
    );
    const maxAttempts = retryableMethod ? requestedAttempts : 1;
    const startedAt = this.#clock.nowMs();
    const deadlineAt = startedAt + deadlineMs;
    const controller = new AbortController();
    let deadlineReached = false;
    const cancelDeadline = this.#scheduler.schedule(() => {
      deadlineReached = true;
      controller.abort();
    }, deadlineMs);
    const callerSignal = template.signal;
    const abortFromCaller = (): void => controller.abort(callerSignal.reason);
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });

    let attempt = 0;
    let lastRequestId = '';
    try {
      while (attempt < maxAttempts) {
        if (deadlineReached || this.#clock.nowMs() >= deadlineAt) {
          throw new ClientRuntimeError('request_deadline_exceeded', {
            details: { attempts: attempt },
          });
        }
        if (callerSignal.aborted) {
          throw new ClientRuntimeError('request_aborted', {
            details: { attempts: attempt },
          });
        }

        attempt++;
        lastRequestId = this.#requestIdFactory();
        if (!isSafeOpaqueId(lastRequestId)) {
          throw new ClientRuntimeError('transport_violation', {
            details: { reason: 'invalid-request-id' },
          });
        }
        const headers = new Headers(template.headers);
        headers.set(REQUEST_ID_HEADER, lastRequestId);
        const request = new Request(template.clone(), {
          headers,
          signal: controller.signal,
        });

        let response: Response;
        try {
          response = await this.#transport.execute(request);
        } catch (cause) {
          if (deadlineReached || this.#clock.nowMs() >= deadlineAt) {
            throw new ClientRuntimeError('request_deadline_exceeded', {
              details: { attempts: attempt, requestId: lastRequestId, possiblySent: true },
              cause,
            });
          }
          if (callerSignal.aborted) {
            throw new ClientRuntimeError('request_aborted', {
              details: { attempts: attempt, requestId: lastRequestId, possiblySent: true },
              cause,
            });
          }
          if (cause instanceof ClientRuntimeError
            && cause.code !== 'network_error'
            && cause.code !== 'request_aborted') {
            throw cause;
          }
          if (!retryableMethod || attempt >= maxAttempts) {
            throw new ClientRuntimeError('network_error', {
              retryable: retryableMethod,
              details: {
                attempts: attempt,
                requestId: lastRequestId,
                possiblySent: true,
                method,
              },
              cause,
            });
          }
          const remaining = deadlineAt - this.#clock.nowMs();
          const delay = this.#retryBaseDelayMs * (2 ** Math.max(0, attempt - 1));
          if (delay >= remaining) {
            throw new ClientRuntimeError('request_deadline_exceeded', {
              details: { attempts: attempt, requestId: lastRequestId, possiblySent: true },
              cause,
            });
          }
          await waitFor(this.#scheduler, delay, controller.signal);
          continue;
        }

        if (!retryableMethod
          || !RETRYABLE_STATUS.has(response.status)
          || attempt >= maxAttempts) {
          return { response, requestId: lastRequestId, attempts: attempt };
        }
        const remaining = deadlineAt - this.#clock.nowMs();
        const delay = retryDelay(response, attempt, this.#retryBaseDelayMs);
        if (delay >= remaining) {
          return { response, requestId: lastRequestId, attempts: attempt };
        }
        await response.body?.cancel();
        await waitFor(this.#scheduler, delay, controller.signal);
      }
      throw new ClientRuntimeError('network_error', {
        details: { attempts: attempt, requestId: lastRequestId, possiblySent: true, method },
      });
    } catch (cause) {
      if (cause instanceof ClientRuntimeError) throw cause;
      if (deadlineReached || this.#clock.nowMs() >= deadlineAt) {
        throw new ClientRuntimeError('request_deadline_exceeded', {
          details: { attempts: attempt, requestId: lastRequestId, possiblySent: attempt > 0 },
          cause,
        });
      }
      if (callerSignal.aborted) {
        throw new ClientRuntimeError('request_aborted', {
          details: { attempts: attempt, requestId: lastRequestId, possiblySent: attempt > 0 },
          cause,
        });
      }
      throw cause;
    } finally {
      cancelDeadline();
      callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
}
