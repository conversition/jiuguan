import { createHash } from 'node:crypto';
import type { ChatCompletionClient, ChatProviderCall, ChatRequest, ChatResponse, ChatToolArgumentDelta }
  from '../../packages/proxy/public/client.ts';
import { estimateAdmittedRequestInputTokens } from './admitted-model-gateway.ts';
import type { TurnOperationBudgetStore, TurnBudgetUsage } from './turn-operation-budget-store.ts';

export interface TurnOperationBudgetClientOptions {
  readonly client: ChatCompletionClient;
  readonly store: TurnOperationBudgetStore;
  readonly operationId: string;
  /** Unique for this physical attempt; construct another wrapper for another attempt. */
  readonly attemptId: string;
  readonly modelId: string;
  /** Required when the parent operation freezes multiple provider/model bindings. */
  readonly providerId?: string;
  readonly holdId?: string;
  /** Price both reserved and actual tokens against the same frozen provider rates. */
  readonly estimateCostMicrousd: (usage: Readonly<{ inputTokens: number; outputTokens: number }>) => number;
}

function usageOf(usage: ChatResponse['usage']): { inputTokens: number; outputTokens: number } {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
    || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0
    || !Number.isSafeInteger(usage.total_tokens)
    || usage.total_tokens < usage.prompt_tokens + usage.completion_tokens) {
    throw new Error('turn-operation-provider-usage-invalid');
  }
  for (const value of [usage.cached_input_tokens, usage.cache_write_tokens, usage.reasoning_tokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('turn-operation-provider-usage-invalid');
    }
  }
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

/** One wrapper is bound to one attempt. It never mutates the request or substitutes a model. */
export function createTurnOperationBudgetClient(options: TurnOperationBudgetClientOptions): ChatCompletionClient {
  if (!options.operationId || !options.attemptId || !options.modelId
    || (options.providerId !== undefined && !options.providerId)
    || typeof options.estimateCostMicrousd !== 'function') {
    throw new TypeError('turn-operation-client-binding-invalid');
  }
  let used = false;
  const price = (usage: Readonly<{ inputTokens: number; outputTokens: number }>): TurnBudgetUsage => {
    const costMicrousd = options.estimateCostMicrousd(usage);
    if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) throw new Error('turn-operation-cost-invalid');
    return { ...usage, costMicrousd };
  };
  const invoke = async (
    request: ChatRequest, signal: AbortSignal | undefined, call: ChatProviderCall | undefined,
    dispatch: (actual: ChatRequest, effective: ChatProviderCall) => Promise<ChatResponse>,
  ): Promise<ChatResponse> => {
    if (used) throw new Error('turn-operation-attempt-reused');
    used = true;
    if (signal?.aborted) throw new Error('turn-operation-call-aborted');
    if (request.model !== options.modelId) throw new Error('turn-operation-model-mismatch');
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! < 1) throw new Error('turn-operation-output-limit-required');
    const actual = structuredClone(request);
    const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify(actual)).digest('hex')}`;
    // The token estimator counts message bodies but not every provider's framing.
    // Reserve conservative framing headroom because actual input usage must not
    // silently overspend the operation's remaining capacity.
    const estimated = estimateAdmittedRequestInputTokens(actual);
    const inputTokens = estimated + Math.max(64, Math.ceil(estimated * 0.05)) + actual.messages.length * 8;
    const reservation = price({ inputTokens, outputTokens: actual.max_tokens! });
    const budgetReservation = { attemptId: options.attemptId, requestDigest, modelId: options.modelId,
      ...(options.providerId === undefined ? {} : { providerId: options.providerId }), ...reservation };
    if (options.holdId) options.store.reserveFromHold(options.operationId, options.holdId, budgetReservation);
    else options.store.reserve(options.operationId, budgetReservation);
    if (signal?.aborted) {
      options.store.release(options.operationId, options.attemptId);
      throw new Error('turn-operation-call-aborted');
    }
    let dispatched = false;
    let fenceRejected = false;
    let adapterFenceEntered = false;
    const assertRequestDigest = () => {
      if (`sha256:${createHash('sha256').update(JSON.stringify(actual)).digest('hex')}` !== requestDigest) {
        throw new Error('turn-operation-request-mutated');
      }
    };
    const effective = Object.freeze({ ...call, maxTransportAttempts: 1, beforeDispatch: () => {
      try {
        if (dispatched) throw new Error('turn-operation-duplicate-dispatch');
        if (signal?.aborted) throw new Error('turn-operation-call-aborted');
        const result: unknown = call?.beforeDispatch?.();
        if (result !== undefined) {
          try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* reject non-Promise thenables too */ }
          throw new Error('turn-operation-dispatch-fence-invalid');
        }
        assertRequestDigest();
        options.store.markDispatched(options.operationId, options.attemptId);
        dispatched = true;
      } catch (error) {
        if (!dispatched) fenceRejected = true;
        throw error;
      }
    }, beforeAdapterDispatch: () => {
      if (!dispatched || adapterFenceEntered) throw new Error('turn-operation-adapter-fence-invalid');
      adapterFenceEntered = true;
      if (signal?.aborted) throw new Error('turn-operation-call-aborted');
      assertRequestDigest();
      const result: unknown = call?.beforeAdapterDispatch?.();
      if (result !== undefined) {
        try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* reject non-Promise values too */ }
        throw new Error('turn-operation-adapter-fence-invalid');
      }
      // The caller's host fence must not mutate the already-accounted request.
      assertRequestDigest();
    } });
    let response: ChatResponse;
    try { response = await dispatch(actual, effective); }
    catch (error) {
      if (dispatched) options.store.markUnknown(options.operationId, options.attemptId);
      else if (fenceRejected) options.store.release(options.operationId, options.attemptId);
      else options.store.markPossiblyDispatched(options.operationId, options.attemptId);
      throw error;
    }
    if (!dispatched) {
      // A delegate that resolves without invoking the required fence may have
      // sent a request already. Retain its full reservation and reject it.
      options.store.markPossiblyDispatched(options.operationId, options.attemptId);
      throw new Error('turn-operation-dispatch-fence-missing');
    }
    if (!adapterFenceEntered) {
      options.store.markUnknown(options.operationId, options.attemptId);
      throw new Error('turn-operation-adapter-fence-missing');
    }
    let usage: TurnBudgetUsage;
    try { usage = price(usageOf(response.usage)); }
    catch (error) { options.store.markUnknown(options.operationId, options.attemptId); throw error; }
    options.store.settle(options.operationId, options.attemptId, usage);
    return response;
  };
  return {
    complete: (request, signal, call) => invoke(request, signal, call,
      (actual, effective) => options.client.complete(actual, signal, effective)),
    stream: (request, onDelta, onToolArg, signal, call) => invoke(request, signal, call,
      (actual, effective) => options.client.stream(actual, onDelta,
        onToolArg as ((name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void) | undefined,
        signal, effective)),
    ...(options.client.capabilities ? { capabilities: options.client.capabilities.bind(options.client) } : {}),
    ...(options.client.modelName ? { modelName: options.client.modelName.bind(options.client) } : {}),
    ...(options.client.listModels ? { listModels: options.client.listModels.bind(options.client) } : {}),
  };
}
