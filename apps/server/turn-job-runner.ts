import { randomUUID } from 'node:crypto';
import type { PublicTurnJob } from '../../packages/mobile-contracts/src/index.ts';
import {
  DEFAULT_TURN_JOB_HEARTBEAT_MS,
  DEFAULT_TURN_JOB_LEASE_MS,
  TurnJobConflictError,
  TurnJobManager,
  type TurnJobCommittedOutcome,
  type TurnJobExecutionRecord,
} from './turn-job-manager.ts';

export interface TurnJobExecutionResult<T = unknown> {
  value: T;
  /** 必须是与会话最终写环同事务落库后读回的 marker，不能由 executor 临时拼装。 */
  outcome: TurnJobCommittedOutcome;
}

export interface TurnJobExecutionContext {
  runId: string;
  signal: AbortSignal;
  record: TurnJobExecutionRecord;
  emitDelta(delta: string): void;
  /** 最终会话事务前调用；取消先到会抛冲突，栅栏先到后迟到取消不再 abort。 */
  acquireCommitFence(): TurnJobExecutionRecord;
}

export interface TurnJobRunOutcome<T = unknown> {
  job: PublicTurnJob;
  value?: T;
}

type Executor<T> = (context: TurnJobExecutionContext) => Promise<TurnJobExecutionResult<T>>;
type DeltaSubscriber = (delta: string) => void;

interface ActiveRun<T> {
  controller: AbortController;
  subscribers: Set<DeltaSubscriber>;
  promise: Promise<TurnJobRunOutcome<T>>;
  heartbeat: ReturnType<typeof setInterval>;
}

export interface TurnJobRunnerOptions {
  ownerInstanceId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

function abortError(): Error {
  const error = new Error('订阅已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 任务表只能保存可公开、可重试判断的稳定类别。ProviderRegistryError 的 code
 * 可以跨边界，插件/上游 message、响应体和凭据一律不得进入持久任务记录。
 */
function publicFailureCode(error: unknown, leaseLost: boolean): string {
  if (leaseLost) return 'execution_lease_lost';
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  switch (code) {
    case 'provider-failed': return 'provider_failed';
    case 'not-configured': return 'provider_not_configured';
    case 'not-found': return 'provider_unavailable';
    case 'capability-disabled':
    case 'method-unavailable': return 'provider_capability_unavailable';
    case 'invocation-forced': return 'provider_reloaded';
    case 'invocation-aborted': return 'provider_interrupted';
    case 'skill-context-conflict': return 'skill_context_conflict';
    default: return 'generation_failed';
  }
}

/**
 * 进程内执行器只持有 AbortController、订阅者与 Promise；状态真值始终在 TurnJobManager。
 * subscriber 的 AbortSignal 永不转发给 executor，只有 cancel() 可以中止 job。
 */
export class TurnJobRunner<T = unknown> {
  readonly #active = new Map<string, ActiveRun<T>>();
  readonly #ownerInstanceId: string;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number;

  constructor(private readonly manager: TurnJobManager, options: TurnJobRunnerOptions = {}) {
    this.#ownerInstanceId = options.ownerInstanceId ?? `runner_${randomUUID()}`;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_TURN_JOB_LEASE_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_TURN_JOB_HEARTBEAT_MS;
    if (!Number.isInteger(this.#heartbeatIntervalMs)
      || this.#heartbeatIntervalMs < 250
      || this.#heartbeatIntervalMs >= this.#leaseDurationMs) {
      throw new Error('heartbeatIntervalMs 必须是小于 leaseDurationMs 且不少于 250 的整数');
    }
  }

  start(runId: string, executor: Executor<T>): Promise<TurnJobRunOutcome<T>> {
    const existing = this.#active.get(runId);
    if (existing) return existing.promise;
    const record = this.manager.getExecution(runId);
    if (!record) return Promise.reject(new Error('turn job 不存在'));
    if (record.job.status !== 'queued') {
      return Promise.reject(new TurnJobConflictError(
        'transition-conflict',
        `只有 queued job 可以启动，当前为 ${record.job.status}`,
        runId,
      ));
    }
    const running = this.manager.claimExecution(runId, this.#ownerInstanceId, this.#leaseDurationMs);
    const controller = new AbortController();
    let leaseLost = false;
    const subscribers = new Set<DeltaSubscriber>();
    const active = {} as ActiveRun<T>;
    active.controller = controller;
    active.subscribers = subscribers;
    active.heartbeat = setInterval(() => {
      try {
        this.manager.renewLease(runId, this.#ownerInstanceId, this.#leaseDurationMs);
      } catch {
        // owner/CAS 丢失后旧 executor 必须停止；它也不能再获取 commit fence 或写终态。
        leaseLost = true;
        controller.abort();
      }
    }, this.#heartbeatIntervalMs);
    active.heartbeat.unref();
    active.promise = this.#execute(
      running,
      controller,
      subscribers,
      executor,
      () => leaseLost,
    ).finally(() => {
      clearInterval(active.heartbeat);
      if (this.#active.get(runId) === active) this.#active.delete(runId);
      subscribers.clear();
    });
    this.#active.set(runId, active);
    return active.promise;
  }

  subscribe(runId: string, subscriber: DeltaSubscriber): () => void {
    const active = this.#active.get(runId);
    if (!active) return () => {};
    active.subscribers.add(subscriber);
    return () => { active.subscribers.delete(subscriber); };
  }

  async wait(runId: string, signal?: AbortSignal): Promise<TurnJobRunOutcome<T>> {
    const active = this.#active.get(runId);
    if (!active) {
      const job = this.manager.get(runId);
      if (!job) throw new Error('turn job 不存在');
      return { job };
    }
    if (!signal) return active.promise;
    if (signal.aborted) throw abortError();
    return new Promise<TurnJobRunOutcome<T>>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      void active.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  cancel(runId: string): PublicTurnJob {
    const requested = this.manager.requestCancel(runId);
    if (requested.shouldAbortExecutor) this.#active.get(runId)?.controller.abort();
    return requested.job;
  }

  isExecuting(runId: string): boolean {
    return this.#active.has(runId);
  }

  async #execute(
    record: TurnJobExecutionRecord,
    controller: AbortController,
    subscribers: Set<DeltaSubscriber>,
    executor: Executor<T>,
    leaseLost: () => boolean,
  ): Promise<TurnJobRunOutcome<T>> {
    const runId = record.job.runId;
    try {
      const result = await executor({
        runId,
        signal: controller.signal,
        record,
        acquireCommitFence: () => this.manager.acquireCommitFence(runId, this.#ownerInstanceId),
        emitDelta: (delta) => {
          if (typeof delta !== 'string' || delta.length === 0) return;
          for (const subscriber of [...subscribers]) {
            try { subscriber(delta); } catch { /* 单个订阅者不得破坏任务。 */ }
          }
        },
      });
      const latest = this.manager.getExecution(runId);
      if (!latest) throw new Error('turn job 在执行中消失');
      if (!latest.commitFenceAt) throw new Error('executor 未获取持久提交栅栏');
      const succeeded = this.manager.completeFromOutcome(result.outcome);
      return { job: succeeded, value: result.value };
    } catch (error) {
      const latest = this.manager.get(runId);
      if (!latest) throw error;
      if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled') {
        return { job: latest };
      }
      const cancelled = latest.cancelRequestedAt !== undefined;
      const terminal = this.manager.transition({
        runId,
        expectedVersion: latest.version,
        leaseOwnerInstanceId: this.#ownerInstanceId,
        to: cancelled ? 'cancelled' : 'failed',
        ...(cancelled ? {} : { publicErrorCode: publicFailureCode(error, leaseLost()) }),
      });
      return { job: terminal };
    }
  }
}
