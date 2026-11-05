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
    case 'context-compiler-failed': return 'context_compiler_failed';
    case 'context-compiler-provider-request-invalid': return 'context_compiler_provider_request_invalid';
    case 'schema-repair-reserve-insufficient': return 'schema_repair_reserve_insufficient';
    case 'game-turn-output-invalid': {
      // Only the host's closed reason vocabulary may become a public failure.
      // Never stringify a model-supplied field or preserve the raw error message.
      let reason: unknown;
      try { reason = (error as { reason?: unknown }).reason; } catch { /* unknown classification */ }
      switch (reason) {
        case 'missing-tool': return 'game_turn_tool_missing';
        case 'parse-rejected': return 'game_turn_json_invalid';
        case 'schema-invalid': return 'game_turn_schema_invalid';
        case 'schema-repair-unavailable': return 'game_turn_schema_repair_unavailable';
        case 'schema-repair-failed': {
          const repairCode = (error as { repairCode?: unknown }).repairCode;
          switch (repairCode) {
            case 'schema-repair-response-empty': return 'game_turn_repair_empty';
            case 'schema-repair-response-truncated': return 'game_turn_repair_truncated';
            case 'schema-repair-response-tool-call': return 'game_turn_repair_tool_call';
            case 'schema-repair-response-json-invalid': return 'game_turn_repair_json_invalid';
            case 'schema-repair-response-shape-invalid': return 'game_turn_repair_shape_invalid';
            case 'schema-repair-model-abstained': return 'game_turn_repair_abstained';
            case 'schema-repair-issue-invalid': return 'game_turn_repair_issue_invalid';
            case 'schema-repair-value-invalid': return 'game_turn_repair_value_invalid';
            case 'schema-repair-schema-invalid': return 'game_turn_repair_schema_invalid';
            case 'schema-repair-evidence-storage-failed': return 'game_turn_repair_evidence_storage_failed';
            case 'schema-repair-source-stale': return 'game_turn_repair_source_stale';
            default: return 'game_turn_schema_repair_failed';
          }
        }
        case 'candidate-storage-failed': return 'game_turn_candidate_storage_failed';
        case 'normalization-failed': return 'game_turn_normalization_failed';
        default: return 'game_turn_output_invalid';
      }
    }
    case 'game-turn-budget-exhausted': return 'game_turn_budget_exhausted';
    case 'style-package-canary-output-invalid': return 'skill_package_output_invalid';
    case 'style-package-canary-budget-exhausted': return 'skill_package_budget_exhausted';
    case 'style-package-shadow-output-invalid': return 'skill_package_shadow_output_invalid';
    case 'style-package-shadow-budget-exhausted': return 'skill_package_shadow_budget_exhausted';
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
      const failureCode = cancelled ? undefined : publicFailureCode(error, leaseLost());
      // 观测缺口：publicFailureCode 会把未映射的异常折叠成 generation_failed，
      // 且本 catch 原先不记录 error 本体，导致「本地 300ms 失败、零 Provider 调用」
      // 这类问题完全无迹可查。这里只记稳定身份与截断后的 message（不落 prompt/正文），
      // 走 stderr，不进任何业务库。
      if (!cancelled && failureCode === 'generation_failed') {
        const name = error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: unknown }).name) : typeof error;
        const message = error instanceof Error ? error.message : String(error ?? '');
        // `game-turn-output-invalid` collapses every schema rejection into one message; the
        // structured reason is the only thing that says which area of the reply was rejected.
        const reason = error && typeof error === 'object' && 'reason' in error
          ? String((error as { reason?: unknown }).reason).slice(0, 120) : '';
        console.error('[turn-failure]', runId, name, message.slice(0, 300), reason ? `reason=${reason}` : '');
      }
      const terminal = this.manager.transition({
        runId,
        expectedVersion: latest.version,
        leaseOwnerInstanceId: this.#ownerInstanceId,
        to: cancelled ? 'cancelled' : 'failed',
        ...(failureCode === undefined ? {} : { publicErrorCode: failureCode }),
      });
      return { job: terminal };
    }
  }
}
