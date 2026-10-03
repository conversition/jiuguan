/**
 * P5.2-A3-03：认证长响应生命周期注册表。
 *
 * 注册键同时包含 session selector 与 deviceId：logout 精确关闭单 session，
 * device revoke 关闭该设备全部流，revoke-all 关闭全部流。注册表不持有凭据明文。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type StreamTerminationReason =
  | 'session-revoked'
  | 'device-revoked'
  | 'all-revoked'
  | 'session-expired';

export interface AuthenticatedStreamRegistration {
  sessionSelector: string;
  deviceId: string;
  expiresAt: string;
  request: IncomingMessage;
  response: ServerResponse;
  controller: AbortController;
}

export interface ActiveStreamLease {
  release(): void;
  readonly active: boolean;
}

interface TimerHandle {
  unref?: () => void;
}

interface ActiveEntry extends AuthenticatedStreamRegistration {
  released: boolean;
  terminating: boolean;
  timer: TimerHandle | null;
  release: () => void;
  terminate: (reason: StreamTerminationReason) => void;
  onRequestAborted: () => void;
  onResponseClose: () => void;
  onResponseFinish: () => void;
  onResponseError: () => void;
  onControllerAbort: () => void;
}

export interface AuthenticatedStreamRegistryOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

export class AuthenticatedStreamRegistry {
  readonly #bySession = new Map<string, Set<ActiveEntry>>();
  readonly #byDevice = new Map<string, Set<ActiveEntry>>();
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #clearTimer: (timer: TimerHandle) => void;

  constructor(options: AuthenticatedStreamRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  register(input: AuthenticatedStreamRegistration): ActiveStreamLease {
    if (!input.sessionSelector || !input.deviceId || !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new TypeError('authenticated stream registration is invalid');
    }

    const entry = {} as ActiveEntry;
    Object.assign(entry, input, {
      released: false,
      terminating: false,
      timer: null,
    });

    const release = (): void => {
      if (entry.released) return;
      entry.released = true;
      if (entry.timer !== null) {
        this.#clearTimer(entry.timer);
        entry.timer = null;
      }
      input.request.off('aborted', entry.onRequestAborted);
      input.response.off('close', entry.onResponseClose);
      input.response.off('finish', entry.onResponseFinish);
      input.response.off('error', entry.onResponseError);
      input.controller.signal.removeEventListener('abort', entry.onControllerAbort);
      this.#delete(this.#bySession, input.sessionSelector, entry);
      this.#delete(this.#byDevice, input.deviceId, entry);
    };

    const terminate = (_reason: StreamTerminationReason): void => {
      if (entry.released || entry.terminating) return;
      entry.terminating = true;
      try {
        if (!input.controller.signal.aborted) input.controller.abort();
        if (!input.response.writableEnded && !input.response.destroyed) input.response.end();
      } finally {
        release();
      }
    };

    entry.release = release;
    entry.terminate = terminate;
    entry.onRequestAborted = () => terminate('session-revoked');
    entry.onResponseClose = release;
    entry.onResponseFinish = release;
    entry.onResponseError = release;
    entry.onControllerAbort = release;

    this.#add(this.#bySession, input.sessionSelector, entry);
    this.#add(this.#byDevice, input.deviceId, entry);
    input.request.once('aborted', entry.onRequestAborted);
    input.response.once('close', entry.onResponseClose);
    input.response.once('finish', entry.onResponseFinish);
    input.response.once('error', entry.onResponseError);
    input.controller.signal.addEventListener('abort', entry.onControllerAbort, { once: true });

    const scheduleExpiry = (): void => {
      if (entry.released) return;
      const remaining = Date.parse(input.expiresAt) - this.#now();
      if (remaining <= 0) {
        terminate('session-expired');
        return;
      }
      entry.timer = this.#setTimer(scheduleExpiry, Math.min(remaining, MAX_TIMER_DELAY_MS));
      entry.timer.unref?.();
    };
    scheduleExpiry();

    return {
      release,
      get active(): boolean { return !entry.released; },
    };
  }

  abortSession(sessionSelector: string): number {
    return this.#terminate(this.#bySession.get(sessionSelector), 'session-revoked');
  }

  abortDevice(deviceId: string): number {
    return this.#terminate(this.#byDevice.get(deviceId), 'device-revoked');
  }

  abortAll(): number {
    const entries = new Set<ActiveEntry>();
    for (const bucket of this.#bySession.values()) {
      for (const entry of bucket) entries.add(entry);
    }
    return this.#terminate(entries, 'all-revoked');
  }

  activeCount(): number {
    let count = 0;
    for (const entries of this.#bySession.values()) count += entries.size;
    return count;
  }

  activeCountForSession(sessionSelector: string): number {
    return this.#bySession.get(sessionSelector)?.size ?? 0;
  }

  #terminate(entries: Iterable<ActiveEntry> | undefined, reason: StreamTerminationReason): number {
    if (!entries) return 0;
    const snapshot = [...entries];
    for (const entry of snapshot) entry.terminate(reason);
    return snapshot.length;
  }

  #add(index: Map<string, Set<ActiveEntry>>, key: string, entry: ActiveEntry): void {
    let entries = index.get(key);
    if (!entries) {
      entries = new Set();
      index.set(key, entries);
    }
    entries.add(entry);
  }

  #delete(index: Map<string, Set<ActiveEntry>>, key: string, entry: ActiveEntry): void {
    const entries = index.get(key);
    if (!entries) return;
    entries.delete(entry);
    if (entries.size === 0) index.delete(key);
  }
}
