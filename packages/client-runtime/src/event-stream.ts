/**
 * P7-07：以 authenticated fetch streaming 消费 `/api/events`。
 *
 * EventSource 不能附加 Authorization，因此 Cookie 与原生 Bearer 都必须复用
 * ClientAuthTransport → ApiClient；长期 token 绝不进入 URL/query。事件只是失效通知，
 * 发生缺口/换实例时调用方必须先完成 REST 全量 refetch，随后才继续消费 live 事件。
 */
import {
  isEventEnvelope,
  isSafeOpaqueId,
  type EventEnvelope,
} from '@jiuguan/mobile-contracts';
import type { ClientAuthTransport } from './auth-transport.ts';
import {
  ApiClient,
  type ClientClock,
  type ClientScheduler,
} from './api-client.ts';
import { ClientRuntimeError } from './errors.ts';
import { ClientUrlResolver } from './url-resolver.ts';

export const DEFAULT_EVENT_STREAM_PATH = '/api/events';
/** 服务端心跳为 20 秒；客户端阈值保留充足调度余量。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const DEFAULT_STREAM_CONNECT_DEADLINE_MS = 15_000;
export const DEFAULT_STREAM_CONNECT_ATTEMPTS = 2;
export const DEFAULT_MAX_SSE_BUFFER_CHARS = 256 * 1024;

const EVENT_ID_RE = /^(?:0|[1-9][0-9]{0,19})$/;

export interface EventStreamCursor {
  lastEventId: string;
  serverInstanceId: string;
}

export type SyncRequiredReason = 'sync-required' | 'instance-mismatch' | 'gap';

export type EventStreamStopReason =
  | 'stopped'
  | 'streaming-unsupported'
  | 'auth-rejected'
  | 'transport-violation';

export interface EventStreamHandlers {
  onEvent(envelope: EventEnvelope): void | Promise<void>;
  /** 必须在 Promise resolve 前完成 REST 全量 refetch；此期间事件读取会暂停。 */
  onSyncRequired(reason: SyncRequiredReason, hint: EventEnvelope): void | Promise<void>;
  /** 仅报告不可自动恢复的停止；普通网络断线会按有界退避自动重连。 */
  onError?(error: ClientRuntimeError): void;
}

export interface EventStreamClientOptions {
  transport: ClientAuthTransport;
  scheduler: ClientScheduler;
  requestIdFactory: () => string;
  clock?: ClientClock;
  path?: string;
  /** 平台探针已知 fetch streaming 不可用时设 false，可在发请求前直接降级。 */
  supportsStreaming?: boolean;
  heartbeatTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  connectDeadlineMs?: number;
  connectMaxAttempts?: number;
  maxBufferedChars?: number;
}

export interface EventStreamSubscription {
  stop(): void;
  /** 最近一次已处理完成的游标；全量 refetch 进行中时返回 null。 */
  cursor(): EventStreamCursor | null;
  readonly stopped: boolean;
  done: Promise<EventStreamStopReason>;
}

interface ParsedFrame {
  id?: string;
  event?: string;
  data?: string;
}

interface ReadOutcome {
  reason: 'ended' | 'heartbeat-timeout';
  acceptedFrames: number;
}

function positiveInteger(value: number, field: string, minimum = 1): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: `invalid-${field}` },
    });
  }
  return value;
}

function reportError(handler: EventStreamHandlers['onError'], error: ClientRuntimeError): void {
  try { handler?.(error); } catch { /* 错误观察器不得破坏订阅清理。 */ }
}

function parseSseBlock(block: string): ParsedFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (id === undefined && event === undefined && data.length === 0) return null;
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    ...(data.length === 0 ? {} : { data: data.join('\n') }),
  };
}

function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const newlineLength = (index: number): number => {
    if (buffer[index] === '\n') return 1;
    if (buffer[index] !== '\r') return 0;
    return buffer[index + 1] === '\n' ? 2 : 1;
  };
  for (let index = 0; index < buffer.length; index += 1) {
    const first = newlineLength(index);
    if (first === 0) continue;
    const second = newlineLength(index + first);
    if (second > 0) return { index, length: first + second };
    index += first - 1;
  }
  return undefined;
}

function validateCursor(cursor: EventStreamCursor): EventStreamCursor {
  if (!EVENT_ID_RE.test(cursor.lastEventId) || !isSafeOpaqueId(cursor.serverInstanceId)) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'invalid-event-cursor' },
    });
  }
  return { ...cursor };
}

function isNextEventId(previous: string, next: string): boolean {
  return BigInt(next) === BigInt(previous) + 1n;
}

export class EventStreamClient {
  readonly #api: ApiClient;
  readonly #scheduler: ClientScheduler;
  readonly #url: string;
  readonly #supportsStreaming: boolean;
  readonly #heartbeatTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #connectDeadlineMs: number;
  readonly #connectMaxAttempts: number;
  readonly #maxBufferedChars: number;

  constructor(options: EventStreamClientOptions) {
    this.#scheduler = options.scheduler;
    const path = options.path ?? DEFAULT_EVENT_STREAM_PATH;
    if (path.includes('?') || path.includes('#')) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'event-stream-query-forbidden' },
      });
    }
    this.#url = new ClientUrlResolver(options.transport.endpoint).event(path);
    this.#supportsStreaming = options.supportsStreaming ?? true;
    this.#heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      'heartbeat-timeout',
      1_000,
    );
    this.#reconnectBaseMs = positiveInteger(
      options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      'reconnect-base',
    );
    this.#reconnectMaxMs = positiveInteger(
      options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      'reconnect-max',
    );
    if (this.#reconnectMaxMs < this.#reconnectBaseMs) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'invalid-reconnect-range' },
      });
    }
    this.#connectDeadlineMs = positiveInteger(
      options.connectDeadlineMs ?? DEFAULT_STREAM_CONNECT_DEADLINE_MS,
      'connect-deadline',
    );
    this.#connectMaxAttempts = positiveInteger(
      options.connectMaxAttempts ?? DEFAULT_STREAM_CONNECT_ATTEMPTS,
      'connect-attempts',
    );
    this.#maxBufferedChars = positiveInteger(
      options.maxBufferedChars ?? DEFAULT_MAX_SSE_BUFFER_CHARS,
      'sse-buffer-limit',
      1_024,
    );
    this.#api = new ApiClient({
      transport: options.transport,
      clock: options.clock ?? { nowMs: () => Date.now() },
      scheduler: options.scheduler,
      requestIdFactory: options.requestIdFactory,
      defaultDeadlineMs: this.#connectDeadlineMs,
      defaultMaxAttempts: this.#connectMaxAttempts,
      retryBaseDelayMs: this.#reconnectBaseMs,
    });
  }

  start(handlers: EventStreamHandlers, resume?: EventStreamCursor): EventStreamSubscription {
    let cursor = resume ? validateCursor(resume) : null;
    let stopRequested = false;
    let activeController: AbortController | null = null;
    const stop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      activeController?.abort();
    };

    if (!this.#supportsStreaming) {
      stopRequested = true;
      return {
        stop,
        cursor: () => (cursor ? { ...cursor } : null),
        get stopped(): boolean { return true; },
        done: Promise.resolve('streaming-unsupported'),
      };
    }

    const loop = async (): Promise<EventStreamStopReason> => {
      let reconnectAttempt = 0;
      while (!stopRequested) {
        activeController = new AbortController();
        const headers = new Headers({ accept: 'text/event-stream' });
        if (cursor) {
          headers.set('last-event-id', cursor.lastEventId);
          headers.set('x-jg-last-server-instance', cursor.serverInstanceId);
        }

        let response: Response;
        try {
          const result = await this.#api.request(this.#url, {
            method: 'GET',
            headers,
            signal: activeController.signal,
            cache: 'no-store',
          }, {
            deadlineMs: this.#connectDeadlineMs,
            maxAttempts: this.#connectMaxAttempts,
          });
          response = result.response;
        } catch (cause) {
          if (stopRequested || (cause instanceof ClientRuntimeError && cause.code === 'request_aborted')) {
            return 'stopped';
          }
          if (cause instanceof ClientRuntimeError
            && (cause.code === 'transport_violation' || cause.code === 'credential_unavailable')) {
            reportError(handlers.onError, cause);
            return cause.code === 'transport_violation' ? 'transport-violation' : 'auth-rejected';
          }
          await this.#wait(this.#reconnectDelay(++reconnectAttempt), activeController.signal);
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          reportError(handlers.onError, new ClientRuntimeError('credential_unavailable', {
            details: { status: response.status },
          }));
          return 'auth-rejected';
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status >= 400 && response.status < 500) {
            const error = new ClientRuntimeError('transport_violation', {
              details: { reason: 'event-stream-rejected', status: response.status },
            });
            reportError(handlers.onError, error);
            return 'transport-violation';
          }
          await this.#wait(this.#reconnectDelay(++reconnectAttempt), activeController.signal);
          continue;
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'text/event-stream') {
          await response.body?.cancel();
          const error = new ClientRuntimeError('transport_violation', {
            details: { reason: 'invalid-event-content-type' },
          });
          reportError(handlers.onError, error);
          return 'transport-violation';
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          return 'streaming-unsupported';
        }

        const outcome = await this.#readStream(
          response.body,
          activeController.signal,
          handlers,
          () => cursor,
          (next) => { cursor = next; },
        );
        if (stopRequested) return 'stopped';
        reconnectAttempt = outcome.acceptedFrames > 0 ? 0 : reconnectAttempt + 1;
        if (outcome.reason !== 'heartbeat-timeout') {
          await this.#wait(this.#reconnectDelay(reconnectAttempt), activeController.signal);
        }
      }
      return 'stopped';
    };

    const done = loop().catch((cause: unknown): EventStreamStopReason => {
      const error = cause instanceof ClientRuntimeError
        ? cause
        : new ClientRuntimeError('network_error', { cause });
      reportError(handlers.onError, error);
      return error.code === 'transport_violation' ? 'transport-violation' : 'stopped';
    }).finally(() => {
      stopRequested = true;
      activeController?.abort();
    });

    return {
      stop,
      cursor: () => (cursor ? { ...cursor } : null),
      get stopped(): boolean { return stopRequested; },
      done,
    };
  }

  #reconnectDelay(attempt: number): number {
    return Math.min(
      this.#reconnectBaseMs * (2 ** Math.max(0, Math.min(attempt, 20) - 1)),
      this.#reconnectMaxMs,
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

  async #readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    handlers: EventStreamHandlers,
    getCursor: () => EventStreamCursor | null,
    setCursor: (next: EventStreamCursor | null) => void,
  ): Promise<ReadOutcome> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let cancelHeartbeat: (() => void) | undefined;
    let timedOut = false;
    let acceptedFrames = 0;
    const abortReader = (): void => { void reader.cancel().catch(() => {}); };
    if (signal.aborted) abortReader();
    else signal.addEventListener('abort', abortReader, { once: true });
    const armHeartbeat = (): void => {
      cancelHeartbeat?.();
      cancelHeartbeat = this.#scheduler.schedule(() => {
        timedOut = true;
        void reader.cancel();
      }, this.#heartbeatTimeoutMs);
    };
    const drainFrames = async (): Promise<void> => {
      let boundary = frameBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        try {
          if (await this.#handleBlock(block, handlers, getCursor, setCursor)) acceptedFrames += 1;
        } catch (cause) {
          if (cause instanceof ClientRuntimeError) throw cause;
          throw new ClientRuntimeError('network_error', {
            details: { reason: 'event-handler-failed' },
            cause,
          });
        }
        boundary = frameBoundary(buffer);
      }
      if (buffer.length > this.#maxBufferedChars) {
        throw new ClientRuntimeError('transport_violation', {
          details: { reason: 'event-frame-too-large' },
        });
      }
    };

    armHeartbeat();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          try {
            buffer += decoder.decode();
          } catch (cause) {
            throw new ClientRuntimeError('transport_violation', {
              details: { reason: 'invalid-event-utf8' },
              cause,
            });
          }
          await drainFrames();
          return { reason: timedOut ? 'heartbeat-timeout' : 'ended', acceptedFrames };
        }
        armHeartbeat();
        try {
          buffer += decoder.decode(value, { stream: true });
        } catch (cause) {
          throw new ClientRuntimeError('transport_violation', {
            details: { reason: 'invalid-event-utf8' },
            cause,
          });
        }
        await drainFrames();
      }
    } catch (cause) {
      if (timedOut) return { reason: 'heartbeat-timeout', acceptedFrames };
      if (signal.aborted) return { reason: 'ended', acceptedFrames };
      if (cause instanceof ClientRuntimeError) throw cause;
      return { reason: 'ended', acceptedFrames };
    } finally {
      cancelHeartbeat?.();
      signal.removeEventListener('abort', abortReader);
      try { reader.releaseLock(); } catch { /* reader 已取消。 */ }
    }
  }

  async #handleBlock(
    block: string,
    handlers: EventStreamHandlers,
    getCursor: () => EventStreamCursor | null,
    setCursor: (next: EventStreamCursor | null) => void,
  ): Promise<boolean> {
    const frame = parseSseBlock(block);
    if (!frame?.data) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return false;
    }
    if (!isEventEnvelope(parsed)) return false;
    const envelope = parsed;
    if (!EVENT_ID_RE.test(envelope.eventId)
      || (envelope.eventId === '0' && envelope.type !== 'sync.required')
      || !isSafeOpaqueId(envelope.serverInstanceId)
      || frame.id !== envelope.eventId
      || frame.event !== envelope.type) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'invalid-event-frame' },
      });
    }

    const synchronize = async (reason: SyncRequiredReason): Promise<boolean> => {
      setCursor(null);
      await handlers.onSyncRequired(reason, envelope);
      setCursor({ lastEventId: envelope.eventId, serverInstanceId: envelope.serverInstanceId });
      return true;
    };

    if (envelope.type === 'sync.required') return synchronize('sync-required');

    const current = getCursor();
    if (current) {
      if (envelope.serverInstanceId !== current.serverInstanceId) {
        return synchronize('instance-mismatch');
      }
      if (envelope.eventId === current.lastEventId) return false;
      if (!isNextEventId(current.lastEventId, envelope.eventId)) return synchronize('gap');
    }

    await handlers.onEvent(envelope);
    setCursor({ lastEventId: envelope.eventId, serverInstanceId: envelope.serverInstanceId });
    return true;
  }
}
