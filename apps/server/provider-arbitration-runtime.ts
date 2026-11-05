/** @author Codex @date 2026-10-20 @version 2.0
 * P17-01.3c：统一等待、取消、实际执行结算与提交围栏。
 *
 * 调用方只写业务，三件事由包装器保证：
 * 1. 拿不到执行位（队列满/关闭/过期）时**不执行**，直接返回拒绝原因；
 * 2. `execute` 拿到的是仲裁器发出的 `AbortSignal`，前台抢占时它会 abort；
 * 3. 结果**只有 commit 成功才算数**。被抢占/过期/关闭后迟到的结果会被丢弃并回报原因 ——
 *    调用方不得自行落地（尤其是写库、写 Memory、改 Channel 指针这类副作用）。
 *
 * 本模块不碰 Provider 客户端，也不决定内容语义；它只回答「这次调用算不算数」。
 */
import {
  ProviderArbiter,
  type ArbiterOutcome,
  type ArbiterReasonCode,
  type ArbiterTicket,
} from './provider-arbiter.ts';
import type { ModelEntryKind } from './provider-arbitration.ts';

export const PROVIDER_ARBITRATION_RUNTIME_VERSION =
  'provider-arbitration-runtime-v2' as const;

export interface ArbitratedSite {
  readonly providerId: string;
  readonly modelId: string;
  readonly profileRef: string;
}

export type ArbitratedOutcome<T> =
  | Readonly<{ status: 'committed'; value: T }>
  | Readonly<{ status: 'rejected'; reasonCode: ArbiterReasonCode }>
  | Readonly<{ status: 'discarded'; reasonCode: ArbiterReasonCode }>;

export class ProviderArbitrationRuntime {
  readonly #arbiter: ProviderArbiter;

  constructor(arbiter: ProviderArbiter = new ProviderArbiter()) {
    this.#arbiter = arbiter;
  }

  get arbiter(): ProviderArbiter {
    return this.#arbiter;
  }

  /**
   * 受控执行：`execute` 必须尊重传入的 signal；返回值只在 `commit` 成功时才算数。
   * `commit` 回调用于「确认这次结果要落地」的副作用（写库/记账），在它之前不会再有任何写入。
   */
  async run<T>(input: Readonly<{
    entryKind: ModelEntryKind;
    site: ArbitratedSite;
    deadlineAt?: string;
    signal?: AbortSignal;
    execute: (signal: AbortSignal) => Promise<T>;
    /** Host-only, non-throwing transport lifetime; never an adapter/plugin-supplied authority. */
    physicalSettlement?: () => Promise<void>;
    commit: (value: T) => void | Promise<void>;
  }>): Promise<ArbitratedOutcome<T>> {
    const acquired: ArbiterOutcome = this.#arbiter.acquire({
      providerId: input.site.providerId,
      modelId: input.site.modelId,
      profileRef: input.site.profileRef,
      entryKind: input.entryKind,
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!acquired.granted || !acquired.ticket) {
      return Object.freeze({
        status: 'rejected',
        reasonCode: acquired.reasonCode ?? 'arbiter-discarded',
      });
    }
    const ticket: ArbiterTicket = acquired.ticket;
    // 排队中的 ticket 不能直接执行：先等它真正拿到执行位。
    await this.#arbiter.waitForStart(ticket);
    // A granted logical slot is not a dispatched physical request. Recheck after the await,
    // so cancellation in that microtask gap cannot reach the Provider even once.
    if (!this.#arbiter.beginExecution(ticket)) {
      this.#arbiter.release(ticket);
      return this.#discarded(ticket);
    }
    let onAbort: () => void = () => {};
    const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      ticket.signal.addEventListener('abort', onAbort, { once: true });
      if (ticket.signal.aborted) onAbort();
    });
    try {
      let executing: Promise<T>;
      try { executing = Promise.resolve(input.execute(ticket.signal)); }
      catch (error) { executing = Promise.reject(error); }
      let physical: Promise<void> | undefined;
      const settlePhysical = (): Promise<void> => {
        if (physical) return physical;
        if (!input.physicalSettlement) {
          this.#arbiter.settleExecution(ticket);
          return physical = Promise.resolve();
        }
        return physical = input.physicalSettlement().then(
          () => { this.#arbiter.settleExecution(ticket); },
          () => { this.#arbiter.settleExecution(ticket); },
        );
      };
      // Observe both settlement paths even when the cancellation race wins. Logical cancellation
      // returns promptly, but physical capacity stays reserved until this actual promise settles.
      const observed = executing.then(async (value) => {
        await settlePhysical();
        return { kind: 'value' as const, value };
      }, (error: unknown) => {
        // Provider unload may fail the consumer immediately while adapter work is still
        // alive. Report the original error now; retain and observe its physical lifetime.
        void settlePhysical().catch(() => {});
        return { kind: 'error' as const, error };
      });
      const result = await Promise.race([observed, cancelled]);
      if (result.kind === 'cancelled' || ticket.signal.aborted || ticket.state !== 'running') {
        return this.#discarded(ticket);
      }
      if (result.kind === 'error') {
        this.#arbiter.release(ticket);
        throw result.error;
      }
      const committed = this.#arbiter.commit(ticket);
      if (!committed.committed) return Object.freeze({
        status: 'discarded', reasonCode: ticket.reasonCode ?? committed.reasonCode ?? 'arbiter-discarded',
      });
      await input.commit(result.value);
      return Object.freeze({ status: 'committed', value: result.value });
    } finally {
      ticket.signal.removeEventListener('abort', onAbort);
    }
  }

  #discarded(ticket: ArbiterTicket): ArbitratedOutcome<never> {
    const outcome = this.#arbiter.commit(ticket);
    return Object.freeze({ status: 'discarded',
      reasonCode: ticket.reasonCode ?? outcome.reasonCode ?? 'arbiter-discarded' });
  }

  close(): void {
    this.#arbiter.close();
  }
}
