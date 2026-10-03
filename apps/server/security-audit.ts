import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import type { DeviceScopeValue } from '../../packages/server-auth/src/index.ts';

export type AuditDecision = 'allow' | 'deny' | 'error';
export type LatencyBucket = 'lt10ms' | 'lt50ms' | 'lt250ms' | 'lt1s' | 'lt5s' | 'gte5s';
export type BytesBucket = 'none' | 'lt1k' | 'lt16k' | 'lt256k' | 'lt4m' | 'gte4m' | 'stream' | 'unknown';

export interface SecurityAuditInput {
  timestamp: string;
  requestId: string;
  action: string;
  routeTemplate: string;
  decision: AuditDecision;
  reasonCode: string;
  deviceId?: string;
  sessionPublicId?: string;
  requiredScope?: DeviceScopeValue;
  status: number;
  latencyBucket: LatencyBucket;
  bytesBucket: BytesBucket;
}

export const SECURITY_AUDIT_FIELDS = Object.freeze([
  'timestamp',
  'requestId',
  'action',
  'routeTemplate',
  'decision',
  'reasonCode',
  'deviceId',
  'sessionPublicId',
  'requiredScope',
  'status',
  'latencyBucket',
  'bytesBucket',
] as const);

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SCOPES = new Set<DeviceScopeValue>(['read', 'chat', 'assets.write', 'settings.write', 'admin']);
const ROUTE_PATTERN = /^(?:static|unmatched|\/[A-Za-z0-9_.*:/-]{0,240})$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function safeTimestamp(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(0).toISOString();
}

function safeId(value: string | undefined): string | undefined {
  return value !== undefined && isSafeOpaqueId(value) ? value : undefined;
}

function safeRoute(value: string): string {
  return ROUTE_PATTERN.test(value) && !value.includes('?') ? value : 'unmatched';
}

function safeReason(value: string): string {
  return REASON_PATTERN.test(value) ? value : 'invalid-reason';
}

export function latencyBucket(durationMs: number): LatencyBucket {
  if (durationMs < 10) return 'lt10ms';
  if (durationMs < 50) return 'lt50ms';
  if (durationMs < 250) return 'lt250ms';
  if (durationMs < 1_000) return 'lt1s';
  if (durationMs < 5_000) return 'lt5s';
  return 'gte5s';
}

export function bytesBucket(bytes: number | null, stream = false): BytesBucket {
  if (stream) return 'stream';
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return 'none';
  if (bytes < 1_024) return 'lt1k';
  if (bytes < 16 * 1_024) return 'lt16k';
  if (bytes < 256 * 1_024) return 'lt256k';
  if (bytes < 4 * 1_024 * 1_024) return 'lt4m';
  return 'gte4m';
}

/**
 * 构造审计行时逐字段重建，不展开调用方对象。即使调用方错误地夹带 headers/body/query，
 * 也不可能越过此白名单进入 sink。
 */
export function buildSecurityAuditRecord(input: SecurityAuditInput): SecurityAuditInput {
  const deviceId = safeId(input.deviceId);
  const sessionPublicId = safeId(input.sessionPublicId);
  const requiredScope = input.requiredScope !== undefined && SCOPES.has(input.requiredScope)
    ? input.requiredScope
    : undefined;
  return {
    timestamp: safeTimestamp(input.timestamp),
    requestId: safeId(input.requestId) ?? 'invalid',
    action: METHODS.has(input.action) ? input.action : 'GET',
    routeTemplate: safeRoute(input.routeTemplate),
    decision: ['allow', 'deny', 'error'].includes(input.decision) ? input.decision : 'error',
    reasonCode: safeReason(input.reasonCode),
    ...(deviceId ? { deviceId } : {}),
    ...(sessionPublicId ? { sessionPublicId } : {}),
    ...(requiredScope ? { requiredScope } : {}),
    status: Number.isSafeInteger(input.status) && input.status >= 100 && input.status <= 599
      ? input.status
      : 500,
    latencyBucket: input.latencyBucket,
    bytesBucket: input.bytesBucket,
  };
}

export class SecurityAuditWriter {
  readonly #sink: (line: string) => void;

  constructor(sink: (line: string) => void) {
    this.#sink = sink;
  }

  write(input: SecurityAuditInput): void {
    const record = buildSecurityAuditRecord(input);
    try {
      this.#sink(JSON.stringify(record) + '\n');
    } catch {
      // 审计 I/O 失败不得把敏感异常回传给远端，也不得击穿业务进程。
    }
  }
}

export interface AuditSpanContext {
  routeTemplate?: string;
  reasonCode?: string;
  deviceId?: string;
  sessionPublicId?: string;
  requiredScope?: DeviceScopeValue;
}

export class SecurityAuditSpan {
  readonly #writer: SecurityAuditWriter;
  readonly #requestId: string;
  readonly #action: string;
  readonly #startedAt: number;
  readonly #clock: () => number;
  readonly #wallClock: () => string;
  #context: AuditSpanContext;
  #done = false;

  constructor(options: {
    writer: SecurityAuditWriter;
    requestId: string;
    action: string;
    routeTemplate: string;
    clock?: () => number;
    wallClock?: () => string;
  }) {
    this.#writer = options.writer;
    this.#requestId = options.requestId;
    this.#action = options.action;
    this.#clock = options.clock ?? (() => performance.now());
    this.#wallClock = options.wallClock ?? (() => new Date().toISOString());
    this.#startedAt = this.#clock();
    this.#context = { routeTemplate: options.routeTemplate };
  }

  annotate(context: AuditSpanContext): void {
    this.#context = { ...this.#context, ...context };
  }

  finish(options: {
    status: number;
    bytes?: number | null;
    stream?: boolean;
    decision?: AuditDecision;
    reasonCode?: string;
  }): void {
    if (this.#done) return;
    this.#done = true;
    const status = options.status;
    const decision = options.decision ?? (status >= 500 ? 'error' : status >= 400 ? 'deny' : 'allow');
    this.#writer.write({
      timestamp: this.#wallClock(),
      requestId: this.#requestId,
      action: this.#action,
      routeTemplate: this.#context.routeTemplate ?? 'unmatched',
      decision,
      reasonCode: options.reasonCode ?? this.#context.reasonCode
        ?? (decision === 'allow' ? 'allowed' : decision === 'deny' ? 'request-denied' : 'internal-error'),
      ...(this.#context.deviceId ? { deviceId: this.#context.deviceId } : {}),
      ...(this.#context.sessionPublicId ? { sessionPublicId: this.#context.sessionPublicId } : {}),
      ...(this.#context.requiredScope ? { requiredScope: this.#context.requiredScope } : {}),
      status,
      latencyBucket: latencyBucket(Math.max(0, this.#clock() - this.#startedAt)),
      bytesBucket: bytesBucket(options.bytes ?? null, options.stream === true),
    });
  }
}
