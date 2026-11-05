/** @author Codex @date 2026-10-20 @version 2.0
 * P17-01.3 接入层：把既有 `ChatCompletionClient` 包一层仲裁，**接口不变**。
 *
 * 这样每个入口的改动只有一行：`const client = arbitrateChatClient(rawClient, {...})`，
 * 业务代码完全不用重写；不替换调用点时行为与原来一致（只是多了一张票据）。
 *
 * 关键语义：被抢占 / 过期 / 关闭后，包装器**抛错**而不是返回结果。
 * 返回一个「看起来正常」的响应才是真正的危险——调用方会照常写库、写 Memory、改指针。
 */
import type { ChatCompletionClient, ChatProviderCall } from '../../packages/proxy/public/client.ts';
import { withProviderWorkSettlement } from '../../packages/proxy/public/provider-runtime.ts';
import { arbitrationRuntime } from './provider-arbitration-composition.ts';
import type { ArbitratedSite, ProviderArbitrationRuntime } from './provider-arbitration-runtime.ts';
import type { ArbiterReasonCode } from './provider-arbiter.ts';
import type { ModelEntryKind } from './provider-arbitration.ts';

export const PROVIDER_ARBITRATION_CLIENT_VERSION =
  'provider-arbitration-client-v2' as const;

export class ProviderCallDiscardedError extends Error {
  readonly code = 'provider-call-discarded' as const;

  constructor(readonly reasonCode: ArbiterReasonCode) {
    super(`provider call discarded: ${reasonCode}`);
    this.name = 'ProviderCallDiscardedError';
  }
}

/** A local host fence, not a Provider failure; never retain the private guard exception. */
export class ProviderDispatchAuthorityDeniedError extends Error {
  readonly code = 'provider-dispatch-authority-denied' as const;

  constructor() {
    super('provider-dispatch-authority-denied');
    this.name = 'ProviderDispatchAuthorityDeniedError';
  }
}

export function arbitrateChatClient(
  client: ChatCompletionClient,
  options: Readonly<{
    entryKind: ModelEntryKind;
    site: ArbitratedSite;
    runtime?: ProviderArbitrationRuntime;
    deadlineAt?: string;
    /** Host-only synchronous fence, after obtaining the permit and before any delegate call. */
    beforeDispatch?: () => void;
  }>,
): ChatCompletionClient {
  const runtime = options.runtime ?? arbitrationRuntime();
  const deadlineFor = (call?: ChatProviderCall): string | undefined => {
    const deadlines = [options.deadlineAt, call?.deadlineAt].filter((value): value is string => value !== undefined);
    for (const value of deadlines) {
      if (!Number.isFinite(Date.parse(value))) throw new TypeError('arbiter timestamp invalid');
    }
    return deadlines.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  };
  const guard = async <T>(
    execute: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<T> => {
    let callBeforeDispatch: ChatProviderCall['beforeDispatch'];
    try { callBeforeDispatch = call?.beforeDispatch; }
    catch { throw new ProviderDispatchAuthorityDeniedError(); }
    let physicalSettlement: Promise<void> = Promise.resolve();
    return runtime.run({
      entryKind: options.entryKind,
      site: options.site,
      signal: callerSignal,
      deadlineAt: deadlineFor(call),
      // Preserve Registry's prompt consumer error/forced-unload semantics, while independently
      // retaining the physical permit through the actual adapter settlement (not its abort race).
      execute: (signal) => new Promise<T>((resolve, reject) => {
        physicalSettlement = withProviderWorkSettlement(async () => {
          try {
            for (const beforeDispatch of [options.beforeDispatch, callBeforeDispatch]) {
              if (!beforeDispatch) continue;
              try {
                const returned: unknown = beforeDispatch();
                if (returned !== undefined) {
                  // An accidentally async guard never grants dispatch, nor leaks an unhandled rejection.
                  try { void Promise.prototype.then.call(returned, () => {}, () => {}); }
                  catch { /* Non-Promise thenables are refused without invoking their code. */ }
                  throw new ProviderDispatchAuthorityDeniedError();
                }
              } catch { throw new ProviderDispatchAuthorityDeniedError(); }
            }
            // No await may separate the host fence from entering Observed/Registry/Provider.
            resolve(await execute(signal));
          }
          catch (error) { reject(error); }
        });
      }),
      physicalSettlement: () => physicalSettlement,
      commit: () => {},
    }).then((outcome) => {
      if (outcome.status === 'committed') return outcome.value;
      throw new ProviderCallDiscardedError(outcome.reasonCode);
    });
  };

  return {
    complete: (req, signal, call) => guard((inner) => client.complete(req, inner, call), signal, call),
    stream: (req, onDelta, onToolArg, signal, call) => guard(
      (inner) => client.stream(req,
        (delta) => { if (!inner.aborted) onDelta(delta); },
        onToolArg ? (...args) => { if (!inner.aborted) onToolArg(...args); } : undefined,
        inner, call),
      signal, call,
    ),
    // 只读元数据不占执行位：列模型/取名字不产生生成成本。
    ...(client.listModels ? { listModels: (signal?: AbortSignal) => client.listModels!(signal) } : {}),
    ...(client.modelName ? { modelName: () => client.modelName!() } : {}),
    ...(client.capabilities ? { capabilities: () => client.capabilities!() } : {}),
  };
}
