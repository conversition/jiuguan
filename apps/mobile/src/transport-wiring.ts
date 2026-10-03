/**
 * P10-03：流式能力探测与事件订阅分流。
 *
 * 规则（P10 计划第 4 条 + P7-07 契约）：
 * - `Response.body` 流式读取不可用（老 WebView）→ 订阅走 TurnJobPoller 轮询降级，
 *   只交付 job 公开投影（游标契约只对流式通道有意义）；
 * - 可用 → EventStreamClient（P7-06 游标契约）；
 * - 能力探测失败按"不可用"处理（fail-closed 到轮询，轮询永远是对的）。
 */
import type {
  ClientAuthTransport,
  ClientScheduler,
  EventStreamClient,
  EventStreamSubscription,
  TurnJobPoller,
  TurnJobPollHandle,
} from '../../../packages/client-runtime/src/index.ts';
import { isPublicTurnJob, type PublicTurnJob } from '../../../packages/mobile-contracts/src/index.ts';

export type EventChannelKind = 'stream' | 'poll';

export interface StreamingProbe {
  /** Response 构造 + body 可读性；WebView 缺流式时返回 false。仅测试注入。 */
  (): boolean;
}

export const defaultStreamingProbe: StreamingProbe = () => {
  try {
    if (typeof Response === 'undefined' || typeof ReadableStream === 'undefined') return false;
    const probe = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    return probe.body !== null && typeof probe.body.getReader === 'function';
  } catch {
    return false;
  }
};

export interface EventChannelDeps {
  transport: ClientAuthTransport;
  scheduler: ClientScheduler;
  requestIdFactory: () => string;
  eventStream: EventStreamClient;
  jobPoller: TurnJobPoller;
  probe?: StreamingProbe;
  /** 轮询通道要盯的活动 runId（流式通道忽略）。 */
  pollTargets: () => string[];
  onEvent: (envelope: { eventId: string; serverInstanceId: string; type: string }) => void;
  onJob: (job: PublicTurnJob) => void;
  onSyncRequired: (reason: string) => void;
  onError?: (error: unknown) => void;
}

export interface EventChannel {
  readonly kind: EventChannelKind;
  /** 流式通道在构造时已连接，此方法为轮询通道保留统一生命周期。 */
  start(): void;
  stop(): void;
  readonly stopped: boolean;
}

export function openEventChannel(deps: EventChannelDeps): EventChannel {
  const probe = deps.probe ?? defaultStreamingProbe;
  if (probe()) {
    const subscription: EventStreamSubscription = deps.eventStream.start({
      onEvent: (envelope) => deps.onEvent(envelope),
      onSyncRequired: (reason) => deps.onSyncRequired(reason),
      onError: (error) => deps.onError?.(error),
    });
    return {
      kind: 'stream',
      get stopped(): boolean { return subscription.stopped; },
      start: () => { /* EventStreamClient.start 已建立连接 */ },
      stop: () => subscription.stop(),
    };
  }

  // 轮询降级：盯每个活动 runId 直到终态；runId 由调用方在创建/恢复任务时登记。
  let stopped = false;
  const handles: TurnJobPollHandle[] = [];
  return {
    kind: 'poll',
    get stopped(): boolean { return stopped; },
    start: () => {
      for (const runId of deps.pollTargets()) {
        if (stopped) return;
        const handle = deps.jobPoller.pollJob(runId, {
          onJob: (job) => deps.onJob(job),
          onError: (error) => deps.onError?.(error),
        });
        handles.push(handle);
      }
    },
    stop: () => {
      stopped = true;
      for (const handle of handles) handle.stop();
    },
  };
}

/** 校验轮询响应负载（与 server GET /api/turn-jobs/:runId 的 {job} 形状对齐）。 */
export function parseJobPayload(payload: unknown): PublicTurnJob | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const job = (payload as { job?: unknown }).job;
  return isPublicTurnJob(job) ? job : null;
}
