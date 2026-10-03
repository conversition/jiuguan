/**
 * P7-05：进程内失效通知 hub（`/api/events` 的唯一事件源）。
 *
 * 硬边界（不得回退）：
 * - eventId 是**同一 serverInstanceId 进程生命周期内**的单调投递序号，纯进程内存状态；
 *   进程重启后从 1 重新开始，客户端必须以 /api/capabilities 的 serverInstanceId 变化
 *   作为"重新全量同步"信号，而不是拿 eventId 做业务 revision。
 * - 不做 replay：不持久化事件，不消费 Last-Event-ID；REST/SQLite 仍是唯一真值，
 *   事件只触发客户端 refetch。
 * - payload 白名单：data 只允许 { status?: string } 形状的有界失效提示，
 *   严禁 prompt、正文、思维链、工具结果、凭据或任意自由对象。
 */
import {
  EVENT_SCHEMA_VERSION,
  isEventEnvelope,
  type EventEnvelope,
  type EventType,
  type EventResource,
} from '../../packages/mobile-contracts/src/index.ts';

/** 失效通知 data 的唯一白名单键。新增键必须先扩展此处并补契约测试。 */
const DATA_KEYS: ReadonlySet<string> = new Set(['status']);
const DATA_VALUE_MAX_LENGTH = 80;
const DATA_JSON_MAX_BYTES = 512;
const DEFAULT_MAX_SUBSCRIBERS = 32;
/** P7-06：有界 replay 缓冲默认值——只保留最近事件，绝不承诺完整历史。 */
export const DEFAULT_REPLAY_LIMIT_EVENTS = 256;
export const DEFAULT_REPLAY_LIMIT_BYTES = 64 * 1024;

export interface PublishInvalidationInput {
  type: EventType;
  resource: EventResource;
  runId?: string;
  requestId?: string;
  originClientId?: string;
  data?: unknown;
}

export interface InvalidationHubOptions {
  serverInstanceId: string;
  now?: () => string;
  maxSubscribers?: number;
  /** replay 缓冲的条数上界；超出即丢最旧。0 关闭 replay。 */
  replayLimitEvents?: number;
  /** replay 缓冲的序列化字节上界；超出即丢最旧。 */
  replayLimitBytes?: number;
}

export type InvalidationSubscriber = (envelope: EventEnvelope) => void;

export type ReplayCursorResult =
  | { kind: 'replay'; envelopes: EventEnvelope[] }
  | {
      kind: 'sync-required';
      reason: 'unknown-cursor' | 'future-cursor' | 'gap' | 'instance-mismatch' | 'replay-disabled';
    };

interface HistoryEntry {
  envelope: EventEnvelope;
  eventId: number;
  bytes: number;
}

function assertSafeInvalidationData(data: unknown): void {
  if (data === undefined) return;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('失效通知 data 必须是普通对象');
  }
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('失效通知 data 必须是普通对象');
  }
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DATA_KEYS.has(key)) {
      throw new Error(`失效通知 data 不允许字段: ${key.slice(0, 40)}`);
    }
    const value = record[key];
    if (typeof value !== 'string' || value.length > DATA_VALUE_MAX_LENGTH) {
      throw new Error(`失效通知 data.${key} 必须是有界字符串`);
    }
  }
  if (JSON.stringify(record).length > DATA_JSON_MAX_BYTES) {
    throw new Error('失效通知 data 序列化后超过上限');
  }
}

/**
 * 失效通知分发器。publish 同步扇出到全部订阅者；单个订阅者回调抛错只影响自身，
 * 不阻断其它订阅者，也不回传给事件产生方（任务生命周期不得依赖订阅者存活）。
 */
export class InvalidationHub {
  readonly #serverInstanceId: string;
  readonly #now: () => string;
  readonly #maxSubscribers: number;
  readonly #replayLimitEvents: number;
  readonly #replayLimitBytes: number;
  readonly #subscribers = new Set<InvalidationSubscriber>();
  readonly #history: HistoryEntry[] = [];
  #historyBytes = 0;
  #seq = 0;

  constructor(options: InvalidationHubOptions) {
    if (typeof options.serverInstanceId !== 'string' || options.serverInstanceId.length === 0) {
      throw new Error('InvalidationHub 需要 serverInstanceId');
    }
    this.#serverInstanceId = options.serverInstanceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
    if (!Number.isSafeInteger(this.#maxSubscribers) || this.#maxSubscribers < 1) {
      throw new Error('maxSubscribers 必须是不小于 1 的整数');
    }
    this.#replayLimitEvents = options.replayLimitEvents ?? DEFAULT_REPLAY_LIMIT_EVENTS;
    this.#replayLimitBytes = options.replayLimitBytes ?? DEFAULT_REPLAY_LIMIT_BYTES;
    if (!Number.isSafeInteger(this.#replayLimitEvents) || this.#replayLimitEvents < 0
      || !Number.isSafeInteger(this.#replayLimitBytes) || this.#replayLimitBytes < 0) {
      throw new Error('replayLimitEvents/replayLimitBytes 必须是非负整数');
    }
  }

  get serverInstanceId(): string {
    return this.#serverInstanceId;
  }

  /** 当前进程已投递的最后一条 eventId；尚未投递时为 '0'。 */
  get lastEventId(): string {
    return String(this.#seq);
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 发布一条失效通知并返回最终 envelope。eventId 全局（跨订阅者）单调递增；
   * 契约校验失败按 fail-closed 抛错，绝不降级发送畸形事件。
   */
  publish(input: PublishInvalidationInput): EventEnvelope {
    assertSafeInvalidationData(input.data);
    this.#seq += 1;
    const envelope: EventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: String(this.#seq),
      serverInstanceId: this.#serverInstanceId,
      type: input.type,
      resource: input.resource,
      occurredAt: this.#now(),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.originClientId === undefined ? {} : { originClientId: input.originClientId }),
      data: input.data === undefined ? {} : input.data,
    };
    if (!isEventEnvelope(envelope)) {
      this.#seq -= 1;
      throw new Error('失效通知 envelope 未通过契约校验');
    }
    this.#remember(envelope, this.#seq);
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(envelope);
      } catch {
        // 单个订阅者异常不得破坏扇出；连接级断开由各自的清理回调处理。
      }
    }
    return envelope;
  }

  /**
   * P7-06：按游标做**有界** replay。缓冲只保留最近 `replayLimitEvents` 条 /
   * `replayLimitBytes` 字节，更早的丢弃且永不恢复——任何取不到的连续区间都返回
   * `sync-required`，由客户端回到 REST 全量查询。REST/SQLite 仍是唯一真值。
   *
   * `cursorServerInstanceId` 用于证明游标属于当前进程实例；缺失时只做数值范围校验
   * （纯失效通知不承载业务真值，错实例游标的最坏后果是一次多余 refetch，不产生错误写入）。
   */
  replayFrom(lastEventId: string, cursorServerInstanceId?: string): ReplayCursorResult {
    if (this.#replayLimitEvents === 0) return { kind: 'sync-required', reason: 'replay-disabled' };
    if (typeof cursorServerInstanceId === 'string'
      && cursorServerInstanceId !== this.#serverInstanceId) {
      return { kind: 'sync-required', reason: 'instance-mismatch' };
    }
    const text = typeof lastEventId === 'string' ? lastEventId.trim() : '';
    if (!/^\d+$/.test(text)) return { kind: 'sync-required', reason: 'unknown-cursor' };
    const cursor = Number(text);
    if (cursor > this.#seq) return { kind: 'sync-required', reason: 'future-cursor' };
    if (this.#history.length === 0) {
      // 当前实例从未发布过事件：cursor 0 视为全新，其余一定是其它实例/被丢弃的旧游标。
      return cursor === 0
        ? { kind: 'replay', envelopes: [] }
        : { kind: 'sync-required', reason: 'gap' };
    }
    const oldest = this.#history[0]!.eventId;
    if (cursor < oldest - 1) return { kind: 'sync-required', reason: 'gap' };
    const envelopes = this.#history
      .filter((entry) => entry.eventId > cursor)
      .map((entry) => entry.envelope);
    return { kind: 'replay', envelopes };
  }

  /**
   * 为需要重新全量同步的连接生成 `sync.required` 建议。eventId 取当前 lastEventId：
   * 客户端以它为新游标后，后续 live 事件严格连续，不会再次命中 gap。
   * 该 envelope 不进入全局流也不进入 replay 缓冲（advisory）。
   */
  syncEnvelope(): EventEnvelope {
    const envelope: EventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: String(this.#seq),
      serverInstanceId: this.#serverInstanceId,
      type: 'sync.required',
      resource: { kind: 'server' },
      occurredAt: this.#now(),
      data: {},
    };
    if (!isEventEnvelope(envelope)) throw new Error('sync.required envelope 未通过契约校验');
    return envelope;
  }

  /** 当前缓冲内的最旧 eventId（缓冲为空时等于已投递序号 + 1，即“下一个”）。 */
  get oldestBufferedEventId(): number {
    return this.#history.length > 0 ? this.#history[0]!.eventId : this.#seq + 1;
  }

  get bufferedEventCount(): number {
    return this.#history.length;
  }

  #remember(envelope: EventEnvelope, eventId: number): void {
    if (this.#replayLimitEvents === 0) return;
    const bytes = JSON.stringify(envelope).length;
    this.#history.push({ envelope, eventId, bytes });
    this.#historyBytes += bytes;
    while (
      (this.#history.length > this.#replayLimitEvents || this.#historyBytes > this.#replayLimitBytes)
      && this.#history.length > 1
    ) {
      const dropped = this.#history.shift()!;
      this.#historyBytes -= dropped.bytes;
    }
  }

  subscribe(subscriber: InvalidationSubscriber): () => void {
    if (this.#subscribers.size >= this.#maxSubscribers) {
      throw new Error('事件订阅者已满');
    }
    if (typeof subscriber !== 'function') throw new Error('订阅者必须是回调函数');
    this.#subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscribers.delete(subscriber);
    };
  }
}
