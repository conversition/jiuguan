import type {
  BranchSelectionReference,
  ImageAttachment,
  TurnCommitControl,
} from '../../packages/session/src/session.ts';
import { isTurnProgress, type PublicTurnJob, type TurnJobAction, type TurnProgress, type TurnProgressPhase }
  from '../../packages/mobile-contracts/src/index.ts';
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
    nsfwState?: unknown,
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
  /** Per-turn canonical object or bounded JSON/XML envelope for the NSFW preflight agent. */
  nsfwState?: unknown;
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
   * Per-session admission fence.  Session deletion owns this boundary so a
   * queued/recovered turn cannot resurrect state after its durable tombstone.
   */
  sessionAdmissionOpen?: (sessionId: string) => boolean;
  /**
   * P7-05：任务生命周期的失效通知旁路（queued/running/settled）。
   * 只投影公开 job DTO；通知异常绝不回写任务状态，也不依赖任何订阅者存活。
   */
  onJobEvent?(input: { job: PublicTurnJob; phase: TurnJobEventPhase }): void;
  onProgress?(input: { job: PublicTurnJob; progress: TurnProgress }): void;
  onSettled?(input: {
    job: PublicTurnJob;
    session: TurnJobSession;
    value?: TurnJobValue;
  }): void | Promise<void>;
  /** Drain metadata observers after producers settle, while Manager readback is still available. */
  beforeManagerClose?(): Promise<void>;
}

export class TurnJobAdmissionError extends Error {
  readonly name = 'TurnJobAdmissionError';
  constructor(
    message: string,
    readonly code: 'release-draining' | 'session-deleting' = 'release-draining',
  ) { super(message); }
}

function assistantValue(
  session: TurnJobSession,
  outcome: TurnJobCommittedOutcome,
  job: PublicTurnJob,
  replanSuggestion?: string | null,
): TurnJobValue {
  if (
    outcome.runId !== job.runId ||
    outcome.sessionId !== job.sessionId ||
    outcome.action !== job.action ||
    (job.round !== undefined && outcome.round !== job.round) ||
    (job.status === 'succeeded' &&
      (outcome.assistantMessageId !== job.result?.assistantMessageId || outcome.revision !== job.result?.revision))
  ) {
    throw new Error('turn outcome 与任务结果身份不匹配');
  }
  const row = session
    .getHistory()
    .find(
      (message) =>
        message.id === outcome.assistantMessageId && message.round === outcome.round && message.role === 'assistant',
    );
  if (!row) throw new Error('turn outcome 引用的 assistant 消息不存在');
  const action = job.action;
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
  readonly #onProgress?: TurnJobServiceOptions['onProgress'];
  readonly #progress = new Map<string, TurnProgress>();
  readonly #progressSubscribers = new Map<string, Set<(progress: TurnProgress) => void>>();
  readonly #onSettled?: TurnJobServiceOptions['onSettled'];
  readonly #beforeManagerClose?: TurnJobServiceOptions['beforeManagerClose'];
  readonly #admissionOpen: () => boolean;
  readonly #sessionAdmissionOpen: (sessionId: string) => boolean;
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
    this.#onProgress = options.onProgress;
    this.#onSettled = options.onSettled;
    this.#beforeManagerClose = options.beforeManagerClose;
    this.#admissionOpen = options.admissionOpen ?? (() => true);
    this.#sessionAdmissionOpen = options.sessionAdmissionOpen ?? (() => true);
  }

  create(input: CreateServerTurnJobInput): CreateTurnJobResult {
    if (this.#closing) throw new Error('turn job 服务正在关闭');
    if (!this.#admissionOpen()) throw new TurnJobAdmissionError('主机版本切换正在收口，请稍后重试');
    if (!this.#sessionAdmissionOpen(input.sessionId)) {
      throw new TurnJobAdmissionError('会话正在删除，已拒绝创建新的生成任务', 'session-deleting');
    }
    const session = this.#resolveSession(input.sessionId);
    if (!session) throw new Error('会话不存在，请先创建或恢复');
    const requestBody = input.action === 'turn'
      ? {
          input: input.input ?? '',
          contentMode: input.contentMode ?? 'nsfw',
          attachments: input.attachments ?? [],
          ...(input.branchSelection ? { branchSelection: input.branchSelection } : {}),
          ...(input.nsfwState === undefined ? {} : { nsfwState: input.nsfwState }),
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

  reportProgress(sessionId: string, runId: string, phase: TurnProgressPhase): void {
    const progress = Object.freeze({ runId, phase });
    if (!isTurnProgress(progress)) throw new Error('turn-progress-invalid');
    const job = this.manager.get(runId);
    if (!job || job.sessionId !== sessionId || job.status !== 'running' || !this.#sessionAdmissionOpen(sessionId)) return;
    this.#progress.set(runId, progress);
    try { this.#onProgress?.({ job, progress }); } catch { /* Progress cannot alter execution. */ }
    for (const subscriber of [...(this.#progressSubscribers.get(runId) ?? [])]) {
      try { subscriber(progress); } catch { /* A disconnected subscriber cannot alter execution. */ }
    }
  }

  getProgress(runId: string): TurnProgress | null {
    const job = this.manager.get(runId);
    return job?.status === 'running' ? this.#progress.get(runId) ?? null : null;
  }

  progressForSession(sessionId: string): TurnProgress | null {
    const job = this.manager.getActiveForSession(sessionId);
    return job ? this.getProgress(job.runId) : null;
  }

  subscribeProgress(runId: string, subscriber: (progress: TurnProgress) => void): () => void {
    const job = this.manager.get(runId);
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return () => {};
    const subscribers = this.#progressSubscribers.get(runId) ?? new Set();
    subscribers.add(subscriber); this.#progressSubscribers.set(runId, subscribers);
    const latest = this.getProgress(runId);
    if (latest) { try { subscriber(latest); } catch { /* Ignore a detached connection. */ } }
    return () => { subscribers.delete(subscriber); if (!subscribers.size) this.#progressSubscribers.delete(runId); };
  }

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

  /**
   * Remove the durable job/idempotency sidecar only after quiesceSession() and
   * a permanent session-deletion fence have both completed.
   */
  deleteSession(sessionId: string): ReturnType<TurnJobManager['deleteSession']> {
    if (this.manager.getActiveForSession(sessionId)) {
      throw new Error('turn-session-delete-not-quiescent');
    }
    return this.#deleteSessionSidecars(sessionId);
  }

  /**
   * Startup privacy recovery runs before ordinary job recovery. A durable
   * deletion fence makes a persisted queued/running row permanently
   * inadmissible, so it is safe to remove that stale row as long as this
   * process is not executing it. Requiring the injected fence prevents this
   * escape hatch from becoming a general active-job deletion API.
   */
  deleteSessionAfterPrivacyFence(sessionId: string): ReturnType<TurnJobManager['deleteSession']> {
    if (this.#sessionAdmissionOpen(sessionId)) {
      throw new Error('turn-session-delete-fence-missing');
    }
    const active = this.manager.getActiveForSession(sessionId);
    if (active && this.runner.isExecuting(active.runId)) {
      throw new Error('turn-session-delete-not-quiescent');
    }
    return this.#deleteSessionSidecars(sessionId);
  }

  #deleteSessionSidecars(sessionId: string): ReturnType<TurnJobManager['deleteSession']> {
    for (const key of this.#compatibilityAliases.keys()) {
      if (key.startsWith(`${sessionId.length}:${sessionId}`)) this.#compatibilityAliases.delete(key);
    }
    for (const key of this.#compatibilityCancels.keys()) {
      if (key.startsWith(`${sessionId.length}:${sessionId}`)) this.#compatibilityCancels.delete(key);
    }
    return this.manager.deleteSession(sessionId);
  }

  valueFromCommittedJob(job: PublicTurnJob): TurnJobValue | null {
    if (job.status !== 'succeeded' || !job.result?.assistantMessageId) return null;
    const session = this.#resolveSession(job.sessionId);
    if (!session) return null;
    try {
      const outcome = session.turnOutcome(job.runId);
      return outcome ? assistantValue(session, outcome, job) : null;
    } catch {
      // A historical success does not resurrect an artifact removed by regeneration/deletion.
      return null;
    }
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
        try { await this.#beforeManagerClose?.(); }
        finally { this.manager.close(); }
      })();
    }
    return this.#closePromise;
  }

  async #recoverAvailable(): Promise<void> {
    if (this.#closing) return;
    for (const record of this.manager.listActiveExecutions()) {
      if (this.#closing) return;
      const { job } = record;
      if (!this.#sessionAdmissionOpen(job.sessionId)) {
        if (job.status === 'queued') {
          const failed = this.manager.transition({
            runId: job.runId,
            expectedVersion: job.version,
            to: 'failed',
            publicErrorCode: 'session_deleting',
          });
          await this.#notifySettled(failed);
        }
        continue;
      }
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
            const value = assistantValue(session, outcome, job);
            const succeeded = this.manager.completeFromOutcome(outcome);
            await this.#notifySettled(succeeded, value);
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
    this.#progress.delete(runId);
    this.#progressSubscribers.delete(runId);
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
          const nsfwState = context.record.requestBody.nsfwState;
          if (typeof input !== 'string'
            || (contentMode !== 'nsfw' && contentMode !== 'nsf')
            || !Array.isArray(attachments)
            || (branchSelection !== undefined && (
              !branchSelection || typeof branchSelection !== 'object' || Array.isArray(branchSelection)
              || !Number.isSafeInteger((branchSelection as Record<string, unknown>).round)
              || Number((branchSelection as Record<string, unknown>).round) < 1
              || typeof (branchSelection as Record<string, unknown>).branchId !== 'string'
              || !/^branch:[a-f0-9]{24}$/u.test(String((branchSelection as Record<string, unknown>).branchId))
            ))
            || (nsfwState !== undefined && (
              nsfwState === null
              || (typeof nsfwState !== 'string' && typeof nsfwState !== 'object')
              || Array.isArray(nsfwState)
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
            nsfwState,
          );
          const outcome = session.turnOutcome(runId);
          if (!outcome) throw new Error('turn job 完成但缺少 outcome marker');
          return { value: assistantValue(session, outcome, context.record.job), outcome };
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
          return { value: assistantValue(session, committed, context.record.job), outcome: committed };
        }
        const outcome = session.turnOutcome(runId);
        if (!outcome) throw new Error('regenerate job 完成但缺少 outcome marker');
        return {
          value: assistantValue(session, outcome, context.record.job, regenerated.replanSuggestion),
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
          value: assistantValue(session, committed, context.record.job),
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
