import { createHash } from 'node:crypto';
import type { ChatCompletionClient, ChatProviderCall, ChatRequest, ChatResponse, ChatToolArgumentDelta }
  from '../../packages/proxy/public/client.ts';
import { estimateAdmittedRequestInputTokens } from './admitted-model-gateway.ts';
import type { SkillRecoveryLiveBudgetStore } from './skill-recovery-live-budget.ts';

/** Frozen, host-verified builtin Provider capabilities and token prices. */
export interface SkillRecoveryLiveClientBinding {
  readonly providerId: 'builtin.openai'; readonly modelId: string;
  readonly contextWindowTokens: number; readonly maxRequestInputTokens: number; readonly maxRequestOutputTokens: number;
  readonly requestSafetyMarginTokens: number; readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
}
export interface SkillRecoveryLiveBudgetClientOptions {
  readonly client: ChatCompletionClient;
  readonly store: SkillRecoveryLiveBudgetStore;
  readonly runId: string;
  readonly binding: SkillRecoveryLiveClientBinding;
  /** Shared across all client wrappers belonging to this run; every physical attempt is unique. */
  readonly nextAttemptId: () => string;
  /** Synchronous, host-owned provider/config/source fence. */
  readonly assertCurrent: () => void;
}
function integer(value: number, minimum: number): boolean { return Number.isSafeInteger(value) && value >= minimum; }
function bindingOf(value: SkillRecoveryLiveClientBinding): SkillRecoveryLiveClientBinding {
  if (!value || value.providerId !== 'builtin.openai' || typeof value.modelId !== 'string' || !value.modelId
    || !integer(value.contextWindowTokens, 1) || !integer(value.maxRequestInputTokens, 1)
    || !integer(value.maxRequestOutputTokens, 1) || !integer(value.requestSafetyMarginTokens, 0)
    || !integer(value.inputMicrousdPerMillionTokens, 1) || !integer(value.outputMicrousdPerMillionTokens, 1)
    || value.maxRequestInputTokens + value.maxRequestOutputTokens + value.requestSafetyMarginTokens > value.contextWindowTokens) {
    throw new Error('skill-recovery-live-client-binding-invalid');
  }
  return Object.freeze({ providerId: value.providerId, modelId: value.modelId, contextWindowTokens: value.contextWindowTokens,
    maxRequestInputTokens: value.maxRequestInputTokens, maxRequestOutputTokens: value.maxRequestOutputTokens,
    requestSafetyMarginTokens: value.requestSafetyMarginTokens,
    inputMicrousdPerMillionTokens: value.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: value.outputMicrousdPerMillionTokens });
}
function synchronous(callback: (() => void) | undefined, code: string): void {
  if (!callback) return;
  const result: unknown = callback();
  if (result !== undefined) {
    try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* reject all non-void results */ }
    throw new Error(code);
  }
}
function cost(binding: SkillRecoveryLiveClientBinding, input: number, output: number): number {
  if (!integer(input, 0) || !integer(output, 0)) throw new Error('skill-recovery-live-usage-invalid');
  const numerator = BigInt(input) * BigInt(binding.inputMicrousdPerMillionTokens)
    + BigInt(output) * BigInt(binding.outputMicrousdPerMillionTokens);
  const result = Number((numerator + 999_999n) / 1_000_000n);
  if (!integer(result, 0)) throw new Error('skill-recovery-live-cost-invalid');
  return result;
}
function digest(request: ChatRequest): string {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
}

/**
 * Place directly around the trusted builtin transport after every request transform.
 * A reservation precedes delegation: even a noncompliant delegate that bypasses its
 * fences or throws before revealing dispatch cannot escape conservative accounting.
 */
export function createSkillRecoveryLiveBudgetClient(options: SkillRecoveryLiveBudgetClientOptions): ChatCompletionClient {
  const binding = bindingOf(options.binding);
  if (!options.client || !options.store || !options.runId || typeof options.nextAttemptId !== 'function'
    || typeof options.assertCurrent !== 'function') throw new Error('skill-recovery-live-client-options-invalid');
  const invoke = async (request: ChatRequest, signal: AbortSignal | undefined, call: ChatProviderCall | undefined,
    dispatch: (captured: ChatRequest, effective: ChatProviderCall) => Promise<ChatResponse>): Promise<ChatResponse> => {
    synchronous(options.assertCurrent, 'skill-recovery-live-current-invalid');
    if (signal?.aborted) throw new Error('skill-recovery-live-call-aborted');
    if (request.model !== binding.modelId || !integer(request.max_tokens!, 1)
      || request.max_tokens! > binding.maxRequestOutputTokens) throw new Error('skill-recovery-live-request-binding-invalid');
    const captured = structuredClone(request);
    const requestDigest = digest(captured);
    const estimated = estimateAdmittedRequestInputTokens(captured);
    if (!integer(estimated, 0) || estimated > binding.maxRequestInputTokens
      || binding.maxRequestInputTokens + captured.max_tokens! + binding.requestSafetyMarginTokens > binding.contextWindowTokens) {
      throw new Error('skill-recovery-live-request-window-exceeded');
    }
    // Input estimate is only a feasibility check; reserve the entire frozen input
    // ceiling because actual provider tokenization may exceed that estimate.
    const reservedCost = cost(binding, binding.maxRequestInputTokens, captured.max_tokens!);
    if (reservedCost < 1) throw new Error('skill-recovery-live-reservation-invalid');
    const attemptId = options.nextAttemptId();
    options.store.reserveDispatch(options.runId, attemptId, reservedCost);
    let beforeDispatch = false, beforeAdapterDispatch = false;
    const current = () => {
      if (signal?.aborted) throw new Error('skill-recovery-live-call-aborted');
      synchronous(options.assertCurrent, 'skill-recovery-live-current-invalid');
      if (digest(captured) !== requestDigest) throw new Error('skill-recovery-live-request-mutated');
    };
    const effective: ChatProviderCall = Object.freeze({ ...call, maxTransportAttempts: 1,
      beforeDispatch: () => {
        if (beforeDispatch) throw new Error('skill-recovery-live-dispatch-duplicate');
        current(); synchronous(call?.beforeDispatch, 'skill-recovery-live-dispatch-fence-invalid'); current();
        beforeDispatch = true;
      },
      beforeAdapterDispatch: () => {
        if (!beforeDispatch || beforeAdapterDispatch) throw new Error('skill-recovery-live-adapter-fence-invalid');
        current(); synchronous(call?.beforeAdapterDispatch, 'skill-recovery-live-adapter-fence-invalid'); current();
        beforeAdapterDispatch = true;
      },
    });
    let response: ChatResponse;
    try {
      current();
      response = await dispatch(captured, effective);
      current();
      if (!beforeDispatch || !beforeAdapterDispatch) throw new Error('skill-recovery-live-dispatch-fence-missing');
    } catch (error) {
      options.store.markUnknown(options.runId, attemptId);
      throw error;
    }
    let actualCost: number;
    try {
      const usage = response.usage;
      if (!usage || !integer(usage.prompt_tokens, 0) || !integer(usage.completion_tokens, 0)
        || !integer(usage.total_tokens, 0) || usage.total_tokens < usage.prompt_tokens + usage.completion_tokens
        || [usage.cached_input_tokens, usage.cache_write_tokens, usage.reasoning_tokens]
          .some(value => value !== undefined && !integer(value, 0))) throw new Error('skill-recovery-live-usage-invalid');
      actualCost = cost(binding, usage.prompt_tokens, usage.completion_tokens);
      if (usage.prompt_tokens > binding.maxRequestInputTokens || usage.completion_tokens > captured.max_tokens!) {
        if (actualCost > reservedCost) {
          // Store persists the observed overspend and fails the run before throwing.
          options.store.settleDispatch(options.runId, attemptId, actualCost);
        }
        throw new Error('skill-recovery-live-usage-limit-exceeded');
      }
    } catch (error) {
      // settleDispatch already terminalizes and persists any observed overspend.
      if (!(error instanceof Error && error.message === 'skill-recovery-attempt-cost-exceeded')) {
        options.store.markUnknown(options.runId, attemptId);
      }
      throw error;
    }
    options.store.settleDispatch(options.runId, attemptId, actualCost);
    return response;
  };
  return {
    complete: (request, signal, call) => invoke(request, signal, call,
      (captured, effective) => options.client.complete(captured, signal, effective)),
    stream: (request, delta, tool, signal, call) => invoke(request, signal, call,
      (captured, effective) => options.client.stream(captured, delta,
        tool as ((name: string, argsDelta: string, detail?: ChatToolArgumentDelta) => void) | undefined, signal, effective)),
    ...(options.client.capabilities ? { capabilities: options.client.capabilities.bind(options.client) } : {}),
    ...(options.client.modelName ? { modelName: options.client.modelName.bind(options.client) } : {}),
    ...(options.client.listModels ? { listModels: options.client.listModels.bind(options.client) } : {}),
  };
}
