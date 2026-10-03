import type {
  BranchSelectionReference,
  ImageAttachment,
  TurnCommitControl,
} from '../../tools/cli/session.ts';
import type { PublicTurnJob, TurnJobAction } from '../../packages/mobile-contracts/src/index.ts';
import {
  TurnJobManager,
  type CreateTurnJobResult,
  type TurnJobCommittedOutcome,
} from './turn-job-manager.ts';
import { TurnJobRunner, type TurnJobRunOutcome } from './turn-job-runner.ts';

export interface TurnJobSession {
  turn(
    input: string,
    contentMode: 'nsfw' | 'nsf',
    onProse: (chunk: string) => void,
    signal: AbortSignal,
    attachments: ImageAttachment[],
    requestedRunId: string,
    commitControl: TurnCommitControl,
    branchSelection?: BranchSelectionReference,
  ): Promise<string>;
  regenerate(
    round: number,
    onProse: (chunk: string) => void,
    signal: AbortSignal,
    requestedRunId: string,
    commitControl: TurnCommitControl,
  ): Promise<{ prose: string; round: number; assistantMsgId: number | null; replanSuggestion?: string | null }>;
  turnOutcome(runId: string): TurnJobCommittedOutcome | null;
  getHistory(): { id: number; round: number; role: string; content: string }[];
  rollbackFailedTurn?(): { round: number; cleaned: boolean };
}

export type TurnJobValue = {
  action: 'turn';
  prose: string;
  round: number;
  assistantMsgId: number;
} | {
  action: 'regenerate';
  prose: string;
  round: number;
  assistantMsgId: number;
  replanSuggestion?: string | null;
};

export interface CreateServerTurnJobInput {
  sessionId: string;
  action: TurnJobAction;
  requestId: string;
  originDeviceId: string;
  idempotencyKey: string;
  round: number;
  input?: string;
  contentMode?: 'nsfw' | 'nsf';
  attachments?: ImageAttachment[];
  branchSelection?: BranchSelectionReference;
  /** 旧 SSE 客户端预先生成的临时身份；只用于进程内兼容取消，不进入公开 DTO。 */
  compatibilityRunId?: string;
}

export type TurnJobEventPhase = 'queued' | 'running' | 'settled';

export interface TurnJobServiceOptions {
  dataDir: string;
  serverInstanceId: string;
  resolveSession(sessionId: string): TurnJobSession | undefined;
  loadSession?(sessionId: string): Promise<TurnJobSession | undefined>;
  now?: () => string;
  randomId?: () => string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** P11-09：host release drain 后拒绝所有新旧 HTTP 入口创建任务。 */
  admissionOpen?: () => boolean;
  /**
   * P7-05：任务生命周期的失效通知旁路（queued/running/settled）。
   * 只投影公开 job DTO；通知异常绝不回写任务状态，也不依赖任何订阅者存活。
   */
  onJobEvent?(input: { job: PublicTurnJob; phase: TurnJobEventPhase }): void;
  onSettled?(input: {
    job: PublicTurnJob;
    session: TurnJobSession;
    value?: TurnJobValue;
  }): void | Promise<void>;
}

export class TurnJobAdmissionError extends Error {
  readonly name = 'TurnJobAdmissionError';
  readonly code = 'release-draining';
}

function assistantValue(
  session: TurnJobSession,
  outcome: TurnJobCommittedOutcome,
  action: TurnJobAction,
  replanSuggestion?: string | null,
): TurnJobValue {
  const row = session.getHistory().find((message) => (
    message.id === outcome.assistantMessageId
    && message.round === outcome.round
    && message.role === 'assistant'
  ));
  if (!row) throw new Error('turn outcome 引用的 assistant 消息不存在');
  return action === 'turn'
    ? { action, prose: row.content, round: outcome.round, assistantMsgId: outcome.assistantMessageId }
    : {
        action,
        prose: row.content,
        round: outcome.round,
        assistantMsgId: outcome.assistantMessageId,
        ...(replanSuggestion === undefined ? {} : { replanSuggestion }),
      };
}

/**
 * P7 的生产接线层：每个服务进程只持有一个 manager/runner。
 * HTTP 连接只订阅 runner；任务自己的 AbortSignal 只能由 cancel() 中止。
 */
export class TurnJobService {
  readonly manager: TurnJobManager;
  readonly runner: TurnJobRunner<TurnJobValue>;
  readonly #resolveSession: TurnJobServiceOptions['resolveSession'];
  readonly #loadSession?: TurnJobServiceOptions['loadSession'];
  readonly #onJobEvent?: TurnJobServiceOptions['onJobEvent'];
  readonly #onSettled?: TurnJobServiceOptions['onSettled'];
  readonly #admissionOpen: () => boolean;
  readonly #compatibilityAliases = new Map<string, string>();
  readonly #compatibilityCancels = new Map<string, { round?: number; expiresAt: number }>();
  readonly #notified = new Set<string>();
  readonly #activePromises = new Map<string, Promise<void>>();
  readonly #settledPromises = new Map<string, Promise<void>>();
  readonly #recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #closing = false;
  #closePromise?: Promise<void>;
  #recoveryTail: Promise<void> = Promise.resolve();

  constructor(options: TurnJobServiceOptions) {
    this.manager = new TurnJobManager({
      dataDir: options.dataDir,
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    this.runner = new TurnJobRunner<TurnJobValue>(this.manager, {
      ownerInstanceId: options.serverInstanceId,
      ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    });
    this.#resolveSession = options.resolveSession;
    this.#loadSession = options.loadSession;
    this.#onJobEvent = options.onJobEvent;
    this.#onSettled = options.onSettled;
    this.#admissionOpen = options.admissionOpen ?? (() => true);
  }

  create(input: CreateServerTurnJobInput): CreateTurnJobResult {
    if (this.#closing) throw new Error('turn job 服务正在关闭');
    if (!this.#admissionOpen()) throw new TurnJobAdmissionError('主机版本切换正在收口，请稍后重试');
    const session = this.#resolveSession(input.sessionId);
    if (!session) throw new Error('会话不存在，请先创建或恢复');
    const requestBody = input.action === 'turn'
      ? {
          input: input.input ?? '',
          contentMode: input.contentMode ?? 'nsfw',
          attachments: input.attachments ?? [],
          ...(input.branchSelection ? { branchSelection: input.branchSelection } : {}),
        }
      : {};
    const created = this.manager.create({
      sessionId: input.sessionId,
      action: input.action,
      requestId: input.requestId,
      originDeviceId: input.originDeviceId,
      idempotencyKey: input.idempotencyKey,
      requestBody,
      round: input.round,
    });
    if (!created.replayed) this.#emitJobEvent(created.job, 'queued');
    if (input.compatibilityRunId) {
      const aliasKey = this.#aliasKey(input.sessionId, input.compatibilityRunId);
      this.#compatibilityAliases.set(aliasKey, created.job.runId);
      const pendingCancel = this.#compatibilityCancels.get(aliasKey);
      if (pendingCancel && pendingCancel.expiresAt > Date.now()
        && (pendingCancel.round === undefined || pendingCancel.round === input.round)) {
        this.#compatibilityCancels.delete(aliasKey);
        this.manager.requestCancel(created.job.runId);
        const cancelled = this.manager.get(created.job.runId)!;
        void this.#notifySettled(cancelled);
        return { ...created, job: cancelled };
      }
    }
    if (created.job.status === 'queued') this.#start(created.job.runId);
    return created;
  }

  get(runId: string): PublicTurnJob | null { return this.manager.get(runId); }

  getActiveForSession(sessionId: string): PublicTurnJob | null {
    return this.manager.getActiveForSession(sessionId);
  }

  resolveCompatibilityRunId(sessionId: string, runId: string): string {
    return this.#compatibilityAliases.get(this.#aliasKey(sessionId, runId)) ?? runId;
  }

  /** 旧 UI 可在创建请求完成登记前点击停止；短期墓碑只服务这条兼容竞态。 */
  registerCompatibilityCancel(sessionId: string, runId: string, round?: number): void {
    const now = Date.now();
    for (const [key, value] of this.#compatibilityCancels) {
      if (value.expiresAt <= now) this.#compatibilityCancels.delete(key);
    }
    this.#compatibilityCancels.set(this.#aliasKey(sessionId, runId), {
      ...(round === undefined ? {} : { round }),
      expiresAt: now + 10 * 60_000,
    });
  }

  subscribe(runId: string, subscriber: (delta: string) => void): () => void {
    return this.runner.subscribe(runId, subscriber);
  }

  wait(runId: string, subscriberSignal?: AbortSignal): Promise<TurnJobRunOutcome<TurnJobValue>> {
    return this.runner.wait(runId, subscriberSignal);
  }

  cancel(runId: string): PublicTurnJob {
    const job = this.runner.cancel(runId);
    // queued 直接终结、或命中墓碑取消时 runner 不会再走 executor 生命周期，
    // 这里补发 settled；running 路径由 executor 生命周期去重后统一通知。
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      void this.#notifySettled(job);
    }
    return job;
  }

  /**
   * Stop or drain the one active foreground turn for a session.
   *
   * The deletion barrier must already reject new admission before calling this.
   * A pre-fence job is aborted; a commit-fenced job is allowed to settle, after
   * which the caller must re-check the session revision before deleting data.
   */
  async quiesceSession(sessionId: string): Promise<PublicTurnJob | null> {
    const active = this.manager.getActiveForSession(sessionId);
    if (!active) return null;
    this.cancel(active.runId);
    if (this.runner.isExecuting(active.runId)) {
      await Promise.allSettled([this.runner.wait(active.runId)]);
    }
    const lifecycle = this.#activePromises.get(active.runId);
    if (lifecycle) await Promise.allSettled([lifecycle]);
    const notification = this.#settledPromises.get(active.runId);
    if (notification) await Promise.allSettled([notification]);
    return this.manager.get(active.runId);
  }

  valueFromCommittedJob(job: PublicTurnJob): TurnJobValue | null {
    if (job.status !== 'succeeded' || !job.result?.assistantMessageId) return null;
    const session = this.#resolveSession(job.sessionId);
    if (!session) return null;
    const outcome = session.turnOutcome(job.runId);
    if (!outcome) return null;
    return assistantValue(session, outcome, job.action);
  }

  /** 启动及 lease 到期后的恢复入口；串行扫描，事件/HTTP 都不是真值。 */
  recoverAvailable(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    const current = this.#recoveryTail.then(() => this.#recoverAvailable());
    this.#recoveryTail = current.catch(() => {});
    return current;
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      for (const timer of this.#recoveryTimers.values()) clearTimeout(timer);
      this.#recoveryTimers.clear();
      this.#closePromise = (async () => {
        await this.#recoveryTail;
        while (this.#activePromises.size > 0) {
          await Promise.allSettled([...this.#activePromises.values()]);
        }
        while (this.#settledPromises.size > 0) {
          await Promise.allSettled([...this.#settledPromises.values()]);
        }
        this.manager.close();
      })();
    }
    return this.#closePromise;
  }

  async #recoverAvailable(): Promise<void> {
    if (this.#closing) return;
    for (const record of this.manager.listActiveExecutions()) {
      if (this.#closing) return;
      const { job } = record;
      let session = this.#resolveSession(job.sessionId);
      if (!session && this.#loadSession) {
        try {
          session = await this.#loadSession(job.sessionId);
        } catch {
          session = undefined;
        }
      }

      if (job.status === 'queued') {
        if (!session) {
          const failed = this.manager.transition({
            runId: job.runId,
            expectedVersion: job.version,
            to: 'failed',
            publicErrorCode: 'server_restart_session_unavailable',
          });
          await this.#notifySettled(failed);
          continue;
        }
        this.#start(job.runId);
        continue;
      }

      let markerConflict = false;
      if (session) {
        try {
          const outcome = session.turnOutcome(job.runId);
          if (outcome) {
            const succeeded = this.manager.completeFromOutcome(outcome);
            await this.#notifySettled(succeeded, assistantValue(session, outcome, job.action));
            continue;
          }
        } catch {
          markerConflict = true;
        }
      }
      const recovered = this.manager.recoverExpired(
        job.runId,
        markerConflict
          ? 'recovery_marker_conflict'
          : session ? 'server_restart_unrecoverable' : 'server_restart_session_unavailable',
      );
      if (recovered.nextAttemptAt) {
        this.#scheduleRecovery(job.runId, recovered.nextAttemptAt);
      } else if (recovered.recovered) {
        await this.#notifySettled(recovered.job);
      }
    }
  }

  #scheduleRecovery(runId: string, nextAttemptAt: string): void {
    if (this.#closing || this.#recoveryTimers.has(runId)) return;
    const delay = Math.max(0, Math.min(2_147_000_000, Date.parse(nextAttemptAt) - Date.now() + 25));
    const timer = setTimeout(() => {
      this.#recoveryTimers.delete(runId);
      void this.recoverAvailable().catch(() => {
        console.error('[turn-jobs] 延迟恢复扫描失败');
      });
    }, delay);
    timer.unref();
    this.#recoveryTimers.set(runId, timer);
  }

  #notifySettled(job: PublicTurnJob, value?: TurnJobValue): Promise<void> {
    const runId = job.runId;
    const active = this.#settledPromises.get(runId);
    if (active) return active;
    if (this.#notified.has(runId)) return Promise.resolve();
    this.#notified.add(runId);
    setTimeout(() => this.#notified.delete(runId), 10 * 60_000).unref();
    const pending = (async () => {
      this.#emitJobEvent(job, 'settled');
      const session = this.#resolveSession(job.sessionId);
      if (!session || !this.#onSettled) return;
      try {
        await this.#onSettled({
          job,
          session,
          ...(value === undefined ? {} : { value }),
        });
      } catch {
        // 生命周期通知是任务终态的旁路，不得回写任务状态。
      }
    })();
    this.#settledPromises.set(runId, pending);
    void pending.then(
      () => { if (this.#settledPromises.get(runId) === pending) this.#settledPromises.delete(runId); },
      () => { if (this.#settledPromises.get(runId) === pending) this.#settledPromises.delete(runId); },
    );
    return pending;
  }

  #emitJobEvent(job: PublicTurnJob, phase: TurnJobEventPhase): void {
    if (!this.#onJobEvent) return;
    try {
      this.#onJobEvent({ job, phase });
    } catch {
      // 失效通知是任务生命周期的旁路；通知方异常不得影响任务状态或执行。
    }
  }

  #start(runId: string): void {
    const promise = this.runner.start(runId, async (context) => {
      // claimExecution 成功后 executor 才被调用：这里对应 job 进入 running。
      this.#emitJobEvent(context.record.job, 'running');
      const session = this.#resolveSession(context.record.job.sessionId);
      if (!session) throw new Error('turn job 绑定的会话未加载');
      const control: TurnCommitControl = {
        runId,
        sessionId: context.record.job.sessionId,
        action: context.record.job.action,
        acquire: () => { context.acquireCommitFence(); },
      };
      try {
        if (context.record.job.action === 'turn') {
          const input = context.record.requestBody.input;
          const contentMode = context.record.requestBody.contentMode;
          const attachments = context.record.requestBody.attachments;
          const branchSelection = context.record.requestBody.branchSelection;
          if (typeof input !== 'string'
            || (contentMode !== 'nsfw' && contentMode !== 'nsf')
            || !Array.isArray(attachments)
            || (branchSelection !== undefined && (
              !branchSelection || typeof branchSelection !== 'object' || Array.isArray(branchSelection)
              || !Number.isSafeInteger((branchSelection as Record<string, unknown>).round)
              || Number((branchSelection as Record<string, unknown>).round) < 1
              || typeof (branchSelection as Record<string, unknown>).branchId !== 'string'
              || !/^branch:[a-f0-9]{24}$/u.test(String((branchSelection as Record<string, unknown>).branchId))
            ))) {
            throw new Error('turn job 请求载荷已损坏');
          }
          await session.turn(
            input,
            contentMode,
            context.emitDelta,
            context.signal,
            attachments as ImageAttachment[],
            runId,
            control,
            branchSelection as BranchSelectionReference | undefined,
          );
          const outcome = session.turnOutcome(runId);
          if (!outcome) throw new Error('turn job 完成但缺少 outcome marker');
          return { value: assistantValue(session, outcome, 'turn'), outcome };
        }

        const round = context.record.job.round;
        if (!round) throw new Error('regenerate job 缺少 round');
        let regenerated: Awaited<ReturnType<TurnJobSession['regenerate']>> | undefined;
        try {
          regenerated = await session.regenerate(
            round,
            context.emitDelta,
            context.signal,
            runId,
            control,
          );
        } catch (error) {
          // 建议卡属于成功提交后的可选后处理。最终事务已留下 marker 时，
          // 后处理异常必须按已提交成功对账，不能把 job 反向标为 failed。
          const committed = session.turnOutcome(runId);
          if (!committed) throw error;
          return { value: assistantValue(session, committed, 'regenerate'), outcome: committed };
        }
        const outcome = session.turnOutcome(runId);
        if (!outcome) throw new Error('regenerate job 完成但缺少 outcome marker');
        return {
          value: assistantValue(session, outcome, 'regenerate', regenerated.replanSuggestion),
          outcome,
        };
      } catch (error) {
        // 覆盖“会话提交后、runner 终结前”所有同步后处理窗口。
        const committed = session.turnOutcome(runId);
        if (!committed) {
          // 普通 turn 的 Provider/契约失败可能留下孤儿 user 行；显式取消路径会保留
          // 已生成的部分正文，因此只有非 abort 失败才执行旧的孤儿清理。
          if (context.record.job.action === 'turn' && !context.signal.aborted) {
            session.rollbackFailedTurn?.();
          }
          throw error;
        }
        return {
          value: assistantValue(session, committed, context.record.job.action),
          outcome: committed,
        };
      }
    });
    const lifecycle = promise.then(async (settled) => {
      await this.#notifySettled(settled.job, settled.value);
    }).catch(() => {
      // runner 已负责持久终态；这里只吸收进程级 Promise，避免未处理拒绝。
      if (!this.#closing) {
        void this.recoverAvailable().catch(() => {
          console.error('[turn-jobs] executor 异常后的恢复扫描失败');
        });
      }
    });
    this.#activePromises.set(runId, lifecycle);
    void lifecycle.then(
      () => { if (this.#activePromises.get(runId) === lifecycle) this.#activePromises.delete(runId); },
      () => { if (this.#activePromises.get(runId) === lifecycle) this.#activePromises.delete(runId); },
    );
  }

  #aliasKey(sessionId: string, runId: string): string {
    return `${sessionId.length}:${sessionId}${runId}`;
  }
}
