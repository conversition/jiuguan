import { randomUUID } from 'node:crypto';
import {
  AbortTurnError,
  type ChatCompletionClient,
  type ChatProviderCall,
  type ChatRequest,
  type ChatResponse,
  type ChatToolArgumentDelta,
  type ChatUsage,
  type ModelCallLane,
} from '../../packages/proxy/src/client.ts';
import { providerFailureDiagnosticCode } from '../../packages/proxy/src/provider-registry.ts';
import {
  MODEL_CALL_LANES,
  type ModelCallOutcome,
  type ModelCallTransport,
  type ModelUsageRecord,
} from './model-usage-ledger.ts';

export interface ModelUsageCostEstimate {
  readonly costMicrousd: number;
  readonly rateCardId: string;
}

export interface ObservedChatCompletionClientOptions {
  readonly record: (entry: ModelUsageRecord) => void;
  readonly resolveProviderId?: () => string | undefined;
  readonly estimateCost?: (usage: ChatUsage, call: ChatProviderCall | undefined) => ModelUsageCostEstimate | undefined;
  readonly createCallId?: () => string;
  readonly nowMs?: () => number;
  /** 只接收稳定码；账本故障不得破坏用户主回合。 */
  readonly onRecordError?: (code: 'model-usage-record-failed') => void;
}

function safeIdentity(value: unknown, fallback: string): string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\u0000-\u001f]/.test(value)
    ? value
    : fallback;
}

function normalizedLane(value: unknown): ModelCallLane {
  return typeof value === 'string' && (MODEL_CALL_LANES as readonly string[]).includes(value)
    ? value as ModelCallLane
    : 'unclassified';
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const diagnosticCode = (error as { diagnosticCode?: unknown }).diagnosticCode;
    if (typeof diagnosticCode === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(diagnosticCode)) return diagnosticCode;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(code)) return code;
    const classified = providerFailureDiagnosticCode(error);
    if (classified !== 'provider-failed') return classified;
  }
  return error instanceof AbortTurnError ? 'aborted' : 'provider-call-failed';
}

function outcome(error: unknown, signal: AbortSignal | undefined): ModelCallOutcome {
  return signal?.aborted || error instanceof AbortTurnError ? 'cancelled' : 'transport_error';
}

function optionalCallInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/**
 * 透明的生产调用观察器：返回同一个 ChatResponse、复用原回调，并把脱敏 usage 旁路写账。
 * Provider 内部自动重试不可见，因此这里记录的是“应用可观测调用”，不是供应商账单。
 */
export class ObservedChatCompletionClient implements ChatCompletionClient {
  readonly #delegate: ChatCompletionClient;
  readonly #options: ObservedChatCompletionClientOptions;
  readonly listModels?: (signal?: AbortSignal) => Promise<string[]>;
  readonly modelName?: () => string;
  readonly capabilities?: () => { readonly stream: boolean; readonly tools: boolean };

  constructor(delegate: ChatCompletionClient, options: ObservedChatCompletionClientOptions) {
    this.#delegate = delegate;
    this.#options = options;
    if (delegate.listModels) this.listModels = (signal) => delegate.listModels!(signal);
    if (delegate.modelName) this.modelName = () => delegate.modelName!();
    if (delegate.capabilities) this.capabilities = () => delegate.capabilities!();
  }

  complete(request: ChatRequest, signal?: AbortSignal, call?: ChatProviderCall): Promise<ChatResponse> {
    return this.#observe('complete', request, signal, call, () => this.#delegate.complete(request, signal, call));
  }

  stream(
    request: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    return this.#observe(
      'stream',
      request,
      signal,
      call,
      () => this.#delegate.stream(request, onDelta, onToolArg, signal, call),
    );
  }

  async #observe(
    transport: ModelCallTransport,
    request: ChatRequest,
    signal: AbortSignal | undefined,
    call: ChatProviderCall | undefined,
    invoke: () => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    const now = this.#options.nowMs ?? Date.now;
    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();
    const callId = safeIdentity((this.#options.createCallId ?? randomUUID)(), 'invalid-call-id');
    const identity = this.#callIdentity(call);
    const providerId = this.#providerId();
    const model = this.#model(request);
    try {
      const response = await invoke();
      const finishedMs = now();
      const estimate = response.usage
        ? this.#safeCostEstimate(response.usage, call)
        : undefined;
      this.#record({
        callId,
        ...identity,
        providerId,
        model,
        transport,
        outcome: 'completed',
        usage: response.usage ?? null,
        ...(estimate ?? {}),
        ...(response.finishReason ? { finishReason: safeIdentity(response.finishReason, 'unknown') } : {}),
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
        elapsedMs: this.#elapsed(startedMs, finishedMs),
      });
      return response;
    } catch (error) {
      const finishedMs = now();
      this.#record({
        callId,
        ...identity,
        providerId,
        model,
        transport,
        outcome: outcome(error, signal),
        usage: null,
        errorCode: errorCode(error),
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
        elapsedMs: this.#elapsed(startedMs, finishedMs),
      });
      throw error;
    }
  }

  #callIdentity(call: ChatProviderCall | undefined): Pick<ModelUsageRecord,
    'lane' | 'runId' | 'parentRunId' | 'sessionId' | 'round' | 'callIndex'> {
    return {
      lane: normalizedLane(call?.lane),
      ...(call?.runId ? { runId: safeIdentity(call.runId, 'unknown-run') } : {}),
      ...(call?.parentRunId ? { parentRunId: safeIdentity(call.parentRunId, 'unknown-parent-run') } : {}),
      ...(call?.sessionId ? { sessionId: safeIdentity(call.sessionId, 'unknown-session') } : {}),
      ...(optionalCallInteger(call?.round) === undefined ? {} : { round: optionalCallInteger(call?.round) }),
      ...(optionalCallInteger(call?.callIndex) === undefined ? {} : { callIndex: optionalCallInteger(call?.callIndex) }),
    };
  }

  #providerId(): string {
    try { return safeIdentity(this.#options.resolveProviderId?.(), 'unknown'); } catch { return 'unknown'; }
  }

  #model(request: ChatRequest): string {
    if (request.model) return safeIdentity(request.model, 'unknown');
    try { return safeIdentity(this.#delegate.modelName?.(), 'unknown'); } catch { return 'unknown'; }
  }

  #safeCostEstimate(usage: ChatUsage, call: ChatProviderCall | undefined): ModelUsageCostEstimate | undefined {
    try {
      const value = this.#options.estimateCost?.(usage, call);
      if (!value
        || !Number.isSafeInteger(value.costMicrousd) || value.costMicrousd < 0
        || safeIdentity(value.rateCardId, '') === '') return undefined;
      return { costMicrousd: value.costMicrousd, rateCardId: value.rateCardId };
    } catch {
      return undefined;
    }
  }

  #record(entry: ModelUsageRecord): void {
    try {
      this.#options.record(entry);
    } catch {
      try { this.#options.onRecordError?.('model-usage-record-failed'); } catch { /* observer remains non-blocking */ }
    }
  }

  #elapsed(startedMs: number, finishedMs: number): number {
    const value = Math.max(0, Math.floor(finishedMs - startedMs));
    return Number.isSafeInteger(value) ? value : 0;
  }
}

/** 复用现有 P13 明示费率；缺失/非法时费用保持 NULL，绝不猜价。 */
export function configuredModelUsageCostEstimator(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ObservedChatCompletionClientOptions['estimateCost'] | undefined {
  const input = Number(env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK);
  const output = Number(env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK);
  if (!Number.isSafeInteger(input) || input < 1 || !Number.isSafeInteger(output) || output < 1) {
    return undefined;
  }
  const rateCardId = `jg-harness-v1:${input}:${output}`;
  return (usage) => {
    const numerator = usage.prompt_tokens * input + usage.completion_tokens * output;
    if (!Number.isSafeInteger(numerator) || numerator < 0) return undefined;
    return { costMicrousd: Math.ceil(numerator / 1_000_000), rateCardId };
  };
}
