import type { RouteRateGroup } from './route-access.ts';

export interface RateGroupPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly maxConcurrentPerDevice: number;
}

export type ProtectedRateGroup = Exclude<RouteRateGroup, 'public'>;

export const DEFAULT_RATE_POLICIES: Readonly<Record<ProtectedRateGroup, RateGroupPolicy>> = Object.freeze({
  read: { capacity: 120, refillPerSecond: 2, maxConcurrentPerDevice: 24 },
  chat: { capacity: 12, refillPerSecond: 0.2, maxConcurrentPerDevice: 2 },
  assets: { capacity: 24, refillPerSecond: 0.4, maxConcurrentPerDevice: 4 },
  settings: { capacity: 12, refillPerSecond: 0.2, maxConcurrentPerDevice: 2 },
  admin: { capacity: 8, refillPerSecond: 0.1, maxConcurrentPerDevice: 2 },
  extension: { capacity: 20, refillPerSecond: 1 / 3, maxConcurrentPerDevice: 4 },
});

export interface AdmissionLease {
  release(): void;
}

export type AdmissionResult =
  | { allowed: true; lease: AdmissionLease }
  | {
      allowed: false;
      reason: 'rate-limited' | 'concurrency-limited';
      retryAfterSeconds: number;
    };

export interface RequestAdmission {
  readonly group: ProtectedRateGroup;
  /** device + session + action group；资产组还应包含公开 asset target。 */
  readonly rateKey: string;
  /** device + action group，用于跨 session 的设备并发上限。 */
  readonly concurrencyKey: string;
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

function assertPolicy(group: string, policy: RateGroupPolicy): void {
  if (!Number.isFinite(policy.capacity) || policy.capacity < 1
    || !Number.isFinite(policy.refillPerSecond) || policy.refillPerSecond <= 0
    || !Number.isSafeInteger(policy.maxConcurrentPerDevice) || policy.maxConcurrentPerDevice < 1) {
    throw new Error('invalid rate policy for ' + group);
  }
}

/**
 * A6-01：已认证请求的 token bucket + 设备并发租约。
 *
 * clock 必须是单调时钟（生产使用 performance.now）；拒绝不会读取 body。租约 release 幂等，
 * 由 response finish/close/error 或 request abort 释放，因此 SSE 也占用真实并发预算。
 */
export class RequestAdmissionController {
  readonly #policies: Readonly<Record<ProtectedRateGroup, RateGroupPolicy>>;
  readonly #clock: () => number;
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #concurrency = new Map<string, number>();
  #operations = 0;

  constructor(
    policies: Readonly<Record<ProtectedRateGroup, RateGroupPolicy>> = DEFAULT_RATE_POLICIES,
    clock: () => number = () => performance.now(),
  ) {
    for (const [group, policy] of Object.entries(policies)) assertPolicy(group, policy);
    this.#policies = policies;
    this.#clock = clock;
  }

  admit(input: RequestAdmission): AdmissionResult {
    const policy = this.#policies[input.group];
    const nowMs = this.#clock();
    const bucketKey = input.group + ':' + input.rateKey;
    const existing = this.#buckets.get(bucketKey);
    const bucket: TokenBucket = existing ?? {
      tokens: policy.capacity,
      lastRefillMs: nowMs,
      lastSeenMs: nowMs,
    };
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      policy.capacity,
      bucket.tokens + elapsedMs * (policy.refillPerSecond / 1_000),
    );
    bucket.lastRefillMs = Math.max(bucket.lastRefillMs, nowMs);
    bucket.lastSeenMs = nowMs;
    this.#buckets.set(bucketKey, bucket);

    if (bucket.tokens < 1) {
      this.#prune(nowMs);
      return {
        allowed: false,
        reason: 'rate-limited',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((1 - bucket.tokens) / policy.refillPerSecond),
        ),
      };
    }
    bucket.tokens -= 1;

    const concurrent = this.#concurrency.get(input.concurrencyKey) ?? 0;
    if (concurrent >= policy.maxConcurrentPerDevice) {
      this.#prune(nowMs);
      return { allowed: false, reason: 'concurrency-limited', retryAfterSeconds: 1 };
    }
    this.#concurrency.set(input.concurrencyKey, concurrent + 1);
    this.#prune(nowMs);

    let released = false;
    return {
      allowed: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          const current = this.#concurrency.get(input.concurrencyKey) ?? 0;
          if (current <= 1) this.#concurrency.delete(input.concurrencyKey);
          else this.#concurrency.set(input.concurrencyKey, current - 1);
        },
      },
    };
  }

  active(concurrencyKey: string): number {
    return this.#concurrency.get(concurrencyKey) ?? 0;
  }

  #prune(nowMs: number): void {
    this.#operations++;
    if (this.#operations % 1_024 !== 0 || this.#buckets.size < 512) return;
    const staleBefore = nowMs - 10 * 60_000;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastSeenMs < staleBefore) this.#buckets.delete(key);
    }
  }
}

export interface PairingAdmissionOptions {
  readonly perKeyLimit: number;
  readonly globalLimit: number;
  readonly windowMs: number;
  readonly maxConcurrent: number;
  readonly clock?: () => number;
}

interface FixedWindow {
  index: number;
  count: number;
}

/**
 * 无身份 pairing 的 pre-body 门禁。remote socket 只作分桶提示，不被视为安全身份；
 * 真正不可绕过的是全局速率/并发，strict parse 后仍有持久 pairing attempts。
 */
export class PairingAdmissionController {
  readonly #options: PairingAdmissionOptions;
  readonly #clock: () => number;
  readonly #perKey = new Map<string, FixedWindow>();
  #global: FixedWindow = { index: -1, count: 0 };
  #active = 0;

  constructor(options: PairingAdmissionOptions) {
    if (!Number.isSafeInteger(options.perKeyLimit) || options.perKeyLimit < 1
      || !Number.isSafeInteger(options.globalLimit) || options.globalLimit < 1
      || !Number.isFinite(options.windowMs) || options.windowMs <= 0
      || !Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error('invalid pairing admission options');
    }
    this.#options = options;
    this.#clock = options.clock ?? (() => performance.now());
  }

  admit(partitionHint: string): AdmissionResult {
    const nowMs = this.#clock();
    const windowIndex = Math.floor(nowMs / this.#options.windowMs);
    if (this.#global.index !== windowIndex) this.#global = { index: windowIndex, count: 0 };
    this.#global.count++;

    const existing = this.#perKey.get(partitionHint);
    const perKey = existing?.index === windowIndex ? existing : { index: windowIndex, count: 0 };
    perKey.count++;
    this.#perKey.set(partitionHint, perKey);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((windowIndex + 1) * this.#options.windowMs - nowMs) / 1_000),
    );
    if (this.#global.count > this.#options.globalLimit
      || perKey.count > this.#options.perKeyLimit) {
      return { allowed: false, reason: 'rate-limited', retryAfterSeconds };
    }
    if (this.#active >= this.#options.maxConcurrent) {
      return { allowed: false, reason: 'concurrency-limited', retryAfterSeconds: 1 };
    }

    this.#active++;
    let released = false;
    return {
      allowed: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.#active = Math.max(0, this.#active - 1);
        },
      },
    };
  }

  get active(): number { return this.#active; }
}

export function bindAdmissionLease(
  lease: AdmissionLease,
  request: NodeJS.EventEmitter,
  response: NodeJS.EventEmitter,
): void {
  const release = (): void => lease.release();
  request.once('aborted', release);
  request.once('error', release);
  response.once('finish', release);
  response.once('close', release);
  response.once('error', release);
}
