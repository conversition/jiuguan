/**
 * P10-03/04：薄壳运行时入口——把各模块串成单一启动路径。
 *
 * 顺序即语义：
 * 1. 构建期 pinned endpoint fail-closed 解析（非法直接拒绝启动）；
 * 2. legacy PWA 残留清理（fail-soft，不阻塞）；
 * 3. 事件通道：流式探测 → EventStreamClient / 失败 → TurnJobPoller；
 * 4. 返回键与前后台订阅（native 优先，Web 降级）。
 * cleanup() 一次性解除全部订阅。
 */
import type {
  ClientAuthTransport,
  ClientScheduler,
  EventStreamClient,
  TurnJobPoller,
} from '../../../packages/client-runtime/src/index.ts';
import { resolvePinnedEndpoint, type PinnedEndpoint } from './pinned-endpoint.ts';
import { cleanupLegacyPwaState, type CacheCleanupDeps, type LegacyCacheCleanupResult } from './legacy-cache-cleanup.ts';
import {
  openEventChannel,
  type EventChannel,
  type EventChannelKind,
  type StreamingProbe,
} from './transport-wiring.ts';
import {
  registerAppStateChange,
  registerBackButton,
  type NativeBridgeDeps,
} from './native-bridge.ts';

export interface ShellEntryInput {
  /** 构建期注入的 pinned endpoint（通常是 import.meta.env / 常量）。 */
  pinnedEndpoint: unknown;
  transport: ClientAuthTransport;
  scheduler: ClientScheduler;
  requestIdFactory: () => string;
  eventStream: EventStreamClient;
  jobPoller: TurnJobPoller;
  probe?: StreamingProbe;
  pollTargets: () => string[];
  onEvent: (envelope: { eventId: string; serverInstanceId: string; type: string }) => void;
  onJob: (job: { runId: string; status: string }) => void;
  onSyncRequired: (reason: string) => void;
  /** 恢复时只查询这些既有 runId；调用方不得在此重新提交 turn。 */
  onResumeRunIds?: (runIds: readonly string[]) => void;
  onError?: (error: unknown) => void;
  cacheCleanupDeps?: CacheCleanupDeps;
  bridgeDeps?: NativeBridgeDeps;
}

export interface ShellRuntime {
  readonly apiOrigin: string;
  readonly pinned: PinnedEndpoint;
  readonly channelKind: EventChannelKind;
  readonly cacheCleanup: LegacyCacheCleanupResult;
  readonly backBridged: boolean;
  channel: EventChannel;
  cleanup(): void;
}

export async function createShellRuntime(input: ShellEntryInput): Promise<ShellRuntime> {
  // 1) endpoint：非法即拒绝启动——薄壳宁可白屏报错也不连错地方。
  const pinned = resolvePinnedEndpoint(input.pinnedEndpoint);

  // 2) PWA 残留清理：fail-soft。
  const cacheCleanup = await cleanupLegacyPwaState(input.cacheCleanupDeps);

  // 3) 事件通道。
  const channel = openEventChannel({
    transport: input.transport,
    scheduler: input.scheduler,
    requestIdFactory: input.requestIdFactory,
    eventStream: input.eventStream,
    jobPoller: input.jobPoller,
    ...(input.probe ? { probe: input.probe } : {}),
    pollTargets: input.pollTargets,
    onEvent: input.onEvent,
    onJob: (job) => input.onJob({ runId: job.runId, status: job.status }),
    onSyncRequired: input.onSyncRequired,
    onError: input.onError,
  });
  channel.start();

  // 4) 原生桥订阅。
  const back = registerBackButton(() => { /* 壳层导航策略在 UI 层实现 */ }, input.bridgeDeps);
  const appState = registerAppStateChange((state) => {
    if (state.isActive) input.onResumeRunIds?.([...input.pollTargets()]);
  }, input.bridgeDeps);

  return {
    apiOrigin: pinned.origin,
    pinned,
    channelKind: channel.kind,
    cacheCleanup,
    backBridged: back.bridged,
    channel,
    cleanup(): void {
      channel.stop();
      back.remove();
      appState.remove();
    },
  };
}
