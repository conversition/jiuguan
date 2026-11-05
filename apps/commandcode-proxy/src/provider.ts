/** PC-only, HTTP-free CommandCode Provider core shared with the loopback adapter. */
import { randomUUID } from 'node:crypto';
import {
  buildCommandCodeRequest,
  buildOpenAIChatCompletion,
  classifyCommandCodeCompletion,
  CommandCodeNdjsonDecoder,
  CommandCodeResponseAccumulator,
  toOpenAIFinishReason,
  usageDetailToken,
  usageToken,
  type ChatRequest as CommandCodeChatRequest,
  type CommandCodeResponseState,
  type CommandCodeUsage,
} from '../../../packages/commandcode-core/src/index.ts';
import {
  CommandCodeAbortError,
  type CommandCodeRuntime,
  type CommandCodeRuntimeConfigSnapshot,
} from '../../../packages/commandcode-runtime/src/index.ts';
import type {
  ProviderAdapter,
  ProviderCallContext,
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderHealth,
  ProviderModelInfo,
  ProviderStreamSink,
} from '../../../packages/proxy/src/provider-types.ts';

const ERROR_BODY_LIMIT_BYTES = 64 * 1_024;
const MAX_RETRY_AFTER_SECONDS = 300;
const DEFAULT_TRANSPORT_ATTEMPTS = 3;
const MAX_TRANSPORT_ATTEMPTS = 3;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const API_KEY_PATTERN = /^user_[A-Za-z0-9_-]{1,507}$/;
const PROMPT_CACHE_KEY_PATTERN = /^[\x21-\x7e]{8,256}$/;
const SESSION_ID_PATTERN = /^[\x21-\x7e]{8,256}$/;

export function isCommandCodeApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value);
}

export type CommandCodeProviderErrorCode =
  | 'COMMANDCODE_PROVIDER_NOT_CONFIGURED'
  | 'COMMANDCODE_PROVIDER_CREDENTIAL_INVALID'
  | 'COMMANDCODE_PROVIDER_REQUEST_INVALID'
  | 'COMMANDCODE_PROVIDER_UPSTREAM_FAILED'
  | 'COMMANDCODE_PROVIDER_UPSTREAM_REJECTED'
  | 'COMMANDCODE_PROVIDER_STREAM_FAILED'
  | 'COMMANDCODE_PROVIDER_STREAM_INCOMPLETE'
  | 'COMMANDCODE_PROVIDER_DISPOSED';

/** Error messages are fixed and never contain upstream bodies or credentials. */
export class CommandCodeProviderError extends Error {
  constructor(
    readonly code: CommandCodeProviderErrorCode,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    /** Content-free category derived from a bounded, exact upstream error shape. */
    readonly diagnosticCode?: 'provider-rate-limited',
  ) {
    super({
      COMMANDCODE_PROVIDER_NOT_CONFIGURED: 'CommandCode credential is not configured',
      COMMANDCODE_PROVIDER_CREDENTIAL_INVALID: 'CommandCode credential is invalid',
      COMMANDCODE_PROVIDER_REQUEST_INVALID: 'CommandCode request is invalid',
      COMMANDCODE_PROVIDER_UPSTREAM_FAILED: 'CommandCode upstream request failed',
      COMMANDCODE_PROVIDER_UPSTREAM_REJECTED: 'CommandCode upstream rejected the request',
      COMMANDCODE_PROVIDER_STREAM_FAILED: 'CommandCode upstream response stream failed',
      COMMANDCODE_PROVIDER_STREAM_INCOMPLETE: 'CommandCode upstream response was incomplete',
      COMMANDCODE_PROVIDER_DISPOSED: 'CommandCode provider has been disposed',
    }[code]);
    this.name = 'CommandCodeProviderError';
  }
}

function boundedRetryAfterSeconds(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d{1,9}$/u.test(value)
    ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed)
    && parsed >= 1 && parsed <= MAX_RETRY_AFTER_SECONDS
    ? parsed : undefined;
}

function responseRetryAfterSeconds(response: Response): number | undefined {
  try { return boundedRetryAfterSeconds(response.headers.get('retry-after') ?? undefined); }
  catch { return undefined; }
}

function transportAttemptLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSPORT_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  return Math.min(value, MAX_TRANSPORT_ATTEMPTS);
}

function retryableTransportFailure(error: CommandCodeProviderError): boolean {
  if (error.code === 'COMMANDCODE_PROVIDER_UPSTREAM_FAILED'
    || error.code === 'COMMANDCODE_PROVIDER_STREAM_FAILED'
    || error.code === 'COMMANDCODE_PROVIDER_STREAM_INCOMPLETE') return true;
  return error.code === 'COMMANDCODE_PROVIDER_UPSTREAM_REJECTED'
    && error.status !== undefined
    && RETRYABLE_UPSTREAM_STATUSES.has(error.status);
}

async function waitForTransportRetry(
  attempt: number,
  retryAfterSeconds: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new CommandCodeProviderAbortError();
  const delayMs = Math.max(600 * (attempt + 1), (retryAfterSeconds ?? 0) * 1_000);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new CommandCodeProviderAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class CommandCodeProviderAbortError extends Error {
  readonly code = 'COMMANDCODE_PROVIDER_ABORTED' as const;
  constructor() {
    super('CommandCode provider request was aborted');
    this.name = 'AbortError';
  }
}

export class CommandCodeStreamIdleTimeoutError extends Error {
  constructor() {
    super('CommandCode upstream response timed out');
    this.name = 'CommandCodeStreamIdleTimeoutError';
  }
}

export class CommandCodeUpstreamBodyError extends Error {
  constructor() {
    super('CommandCode upstream response body failed');
    this.name = 'CommandCodeUpstreamBodyError';
  }
}

export interface CommandCodeProviderAdapterOptions {
  readonly runtime: CommandCodeRuntime;
  readonly runtimeConfig: CommandCodeRuntimeConfigSnapshot;
  readonly resolveApiKey: () => Promise<string | null>;
  readonly configured: boolean;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface CommandCodeWireBuildResult {
  readonly wireBody: ReturnType<typeof buildCommandCodeRequest>;
  readonly promptCacheKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
function safeUuid(factory: () => string): string {
  let value: string;
  try { value = factory(); } catch {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  if (typeof value !== 'string' || !value) {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  return value.replace(/-/g, '').slice(0, 24);
}
function safeNow(now: () => number): number {
  let value: number;
  try { value = now(); } catch {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  return value;
}

function normalizedChatRequest(
  req: ProviderCompletionRequest | CommandCodeChatRequest,
): CommandCodeChatRequest {
  const { extraBody, ...base } = req as unknown as CommandCodeChatRequest & {
    extraBody?: Record<string, unknown>;
  };
  return { ...base, ...(isRecord(extraBody) ? extraBody : {}) } as CommandCodeChatRequest;
}

/** Build the exact wire body shared by the standalone adapter and DSH Provider. */
export function buildCommandCodeProviderWireBody(
  req: CommandCodeChatRequest,
  runtimeConfig: CommandCodeRuntimeConfigSnapshot,
  at: number,
): CommandCodeWireBuildResult {
  if (!Number.isFinite(at) || at < 0) {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  const chat = normalizedChatRequest(req);
  let wireBody: ReturnType<typeof buildCommandCodeRequest>;
  try {
    wireBody = buildCommandCodeRequest(chat, {
      deviceProfile: {
        projectDir: runtimeConfig.deviceProfile.projectDir,
        platform: runtimeConfig.deviceProfile.platform,
      },
      date: new Date(at).toISOString().slice(0, 10),
      cliMode: runtimeConfig.cliMode,
      emptySystemPlaceholder: runtimeConfig.emptySystemPlaceholder,
    });
  } catch {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_REQUEST_INVALID');
  }
  const rawPromptCacheKey = chat.prompt_cache_key;
  const promptCacheKey = typeof rawPromptCacheKey === 'string'
    && PROMPT_CACHE_KEY_PATTERN.test(rawPromptCacheKey)
    ? rawPromptCacheKey
    : undefined;
  return Object.freeze({ wireBody, ...(promptCacheKey ? { promptCacheKey } : {}) });
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandCodeStreamIdleTimeoutError()), timeoutMs);
    void reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      () => { clearTimeout(timer); reject(new CommandCodeUpstreamBodyError()); },
    );
  });
}

/** Consume one CommandCode NDJSON body and always cancel an incomplete body. */
export async function consumeCommandCodeNdjson(
  response: Response,
  maxBufferedChars: number,
  idleTimeoutMs: number,
  abortController: AbortController,
  onEvent: (event: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  if (!response.body) throw new CommandCodeUpstreamBodyError();
  const reader = response.body.getReader();
  const decoder = new CommandCodeNdjsonDecoder({ mode: 'bytes', maxBufferedChars });
  let completed = false;
  try {
    while (true) {
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (chunk.done) break;
      for (const result of decoder.pushBytes(chunk.value)) {
        if (result.kind === 'event') await onEvent(result.event);
      }
    }
    for (const result of decoder.finish()) {
      if (result.kind === 'event') await onEvent(result.event);
    }
    completed = true;
  } catch (error) {
    if (error instanceof CommandCodeStreamIdleTimeoutError) abortController.abort();
    throw error;
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* fixed public error remains authoritative */ }
    }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** Read and discard a bounded upstream error body without exposing it. */
export async function readCommandCodeErrorText(
  response: Response,
  idleTimeoutMs: number,
  abortController: AbortController,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > ERROR_BODY_LIMIT_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof CommandCodeStreamIdleTimeoutError) abortController.abort();
    try { await reader.cancel(); } catch { /* fixed public error remains authoritative */ }
    throw error instanceof CommandCodeStreamIdleTimeoutError
      ? error
      : new CommandCodeUpstreamBodyError();
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * CommandCode reports an exhausted credit balance as HTTP 400/BAD_REQUEST.
 * Recognize only that exact structured shape and expose a fixed category; the
 * upstream message itself never leaves this adapter.
 */
function commandCodeRejectionDiagnostic(
  status: number,
  text: string,
): 'provider-rate-limited' | undefined {
  if (status !== 400 || !text) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(payload)) return undefined;
  const error = ownValue(payload, 'error');
  if (!isRecord(error)) return undefined;
  const code = ownValue(error, 'code');
  if (code !== 'BAD_REQUEST' && code !== 'premium_credits_exhausted') return undefined;
  const nestedStatus = ownValue(error, 'status');
  if (nestedStatus !== undefined && nestedStatus !== 400) return undefined;
  const message = ownValue(error, 'message');
  return code === 'premium_credits_exhausted'
    || (typeof message === 'string'
      && /\binsufficient credits\b|\bpremium[ _-]credits[ _-]exhausted\b/iu.test(message))
    ? 'provider-rate-limited'
    : undefined;
}

function usageResult(state: CommandCodeResponseState): ProviderCompletionResult['usage'] {
  if (!state.usage) return null;
  const promptTokens = usageToken(state.usage, 'inputTokens') ?? 0;
  const completionTokens = usageToken(state.usage, 'outputTokens') ?? 0;
  const cachedInputTokens = usageToken(state.usage, 'cachedInputTokens');
  const cacheWriteTokens = usageDetailToken(state.usage, 'cacheWriteTokens');
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
  };
}

function sumUsageValue(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  const total = (left ?? 0) + (right ?? 0);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

/** Preserve reported physical-attempt usage when a logical call is retried. */
function mergeUsage(
  left: CommandCodeUsage | null,
  right: CommandCodeUsage | null,
): CommandCodeUsage | null {
  if (!left) return right;
  if (!right) return left;
  const inputTokens = sumUsageValue(
    usageToken(left, 'inputTokens'), usageToken(right, 'inputTokens'),
  );
  const outputTokens = sumUsageValue(
    usageToken(left, 'outputTokens'), usageToken(right, 'outputTokens'),
  );
  const cachedInputTokens = sumUsageValue(
    usageToken(left, 'cachedInputTokens'), usageToken(right, 'cachedInputTokens'),
  );
  const noCacheTokens = sumUsageValue(
    usageDetailToken(left, 'noCacheTokens'), usageDetailToken(right, 'noCacheTokens'),
  );
  const cacheReadTokens = sumUsageValue(
    usageDetailToken(left, 'cacheReadTokens'), usageDetailToken(right, 'cacheReadTokens'),
  );
  const cacheWriteTokens = sumUsageValue(
    usageDetailToken(left, 'cacheWriteTokens'), usageDetailToken(right, 'cacheWriteTokens'),
  );
  const hasDetails = noCacheTokens !== undefined
    || cacheReadTokens !== undefined
    || cacheWriteTokens !== undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(hasDetails ? {
      inputTokenDetails: {
        ...(noCacheTokens === undefined ? {} : { noCacheTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      },
    } : {}),
  };
}

function completionResult(
  state: CommandCodeResponseState,
  model: string,
  now: () => number,
  uuid: () => string,
): ProviderCompletionResult {
  const raw = buildOpenAIChatCompletion(state, {
    id: `chatcmpl-${safeUuid(uuid).slice(0, 12)}`,
    model,
    created: Math.floor(safeNow(now) / 1_000),
  });
  return {
    content: state.fullText || null,
    toolCalls: state.toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    finishReason: toOpenAIFinishReason(state.finishReason || 'stop'),
    usage: usageResult(state),
    raw,
  };
}

function linkedController(
  callerSignal: AbortSignal | undefined,
  providerSignal: AbortSignal,
): { controller: AbortController; cleanup(): void } {
  const controller = new AbortController();
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
  callerSignal?.addEventListener('abort', abort, { once: true });
  providerSignal.addEventListener('abort', abort, { once: true });
  if (callerSignal?.aborted || providerSignal.aborted) abort();
  return {
    controller,
    cleanup(): void {
      callerSignal?.removeEventListener('abort', abort);
      providerSignal.removeEventListener('abort', abort);
    },
  };
}

function toolInputText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}) ?? ''; } catch { return '{}'; }
}

async function requireApiKey(resolveApiKey: () => Promise<string | null>): Promise<string> {
  let apiKey: string | null;
  try { apiKey = await resolveApiKey(); } catch {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_NOT_CONFIGURED');
  }
  if (!apiKey) throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_NOT_CONFIGURED');
  if (!isCommandCodeApiKey(apiKey)) {
    throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_CREDENTIAL_INVALID');
  }
  return apiKey;
}

function throwTerminalError(state: CommandCodeResponseState): void {
  // A successful Provider result must contain observable model output. Some
  // upstream rejections have been observed as a terminal usage event without
  // text, reasoning, or tool calls; trusting outputTokens alone turns those
  // failures into empty 200 responses for Agent lanes.
  const decision = classifyCommandCodeCompletion(state, 'content');
  if (decision.kind === 'success') return;
  const retryAfterSeconds = boundedRetryAfterSeconds(
    decision.error.retry_after ?? decision.error.body.retry_after,
  );
  throw new CommandCodeProviderError(
    decision.kind === 'incomplete'
      ? 'COMMANDCODE_PROVIDER_STREAM_INCOMPLETE'
      : 'COMMANDCODE_PROVIDER_UPSTREAM_REJECTED',
    decision.error.status,
    retryAfterSeconds,
  );
}

/** Create a registry-ready ProviderAdapter without any HTTP request/response surface. */
export function createCommandCodeProviderAdapter(
  options: CommandCodeProviderAdapterOptions,
): Readonly<ProviderAdapter> {
  const { runtime, runtimeConfig, resolveApiKey } = options;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const providerController = new AbortController();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const execute = async (
    req: ProviderCompletionRequest,
    sink: ProviderStreamSink | undefined,
    ctx: ProviderCallContext,
  ): Promise<ProviderCompletionResult> => {
    if (disposed) throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_DISPOSED');
    if (ctx.signal?.aborted) throw new CommandCodeProviderAbortError();
    const apiKey = await requireApiKey(resolveApiKey);
    if (disposed) throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_DISPOSED');
    if (ctx.signal?.aborted) throw new CommandCodeProviderAbortError();
    const { wireBody, promptCacheKey } = buildCommandCodeProviderWireBody(
      normalizedChatRequest(req), runtimeConfig, safeNow(now),
    );
    const linked = linkedController(ctx.signal, providerController.signal);
    try {
      const maxAttempts = transportAttemptLimit(ctx.maxTransportAttempts);
      let lastError: CommandCodeProviderError | null = null;
      let priorAttemptUsage: CommandCodeUsage | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // A streamed retry is safe only before any visible delta reaches the caller.
        // Once output was emitted, replaying the request would duplicate prose/tool arguments.
        let emitted = 0;
        // Body idle timeouts must cancel only this physical request. Cancelling the
        // outer call controller would poison every later retry in the same logical call.
        const attemptLinked = linkedController(linked.controller.signal, providerController.signal);
        let accumulator: CommandCodeResponseAccumulator | undefined;
        try {
          const upstream = await runtime.generate({
            apiKey,
            wireBody,
            ...(promptCacheKey ? { promptCacheKey } : {}),
            ...(ctx.runId && SESSION_ID_PATTERN.test(ctx.runId) ? { sessionId: ctx.runId } : {}),
            signal: attemptLinked.controller.signal,
          });
          if (!upstream.ok) {
            let errorText = '';
            try {
              errorText = await readCommandCodeErrorText(
                upstream, runtimeConfig.nonStreamIdleTimeoutMs, attemptLinked.controller,
              );
            } catch {
              if (ctx.signal?.aborted || providerController.signal.aborted) {
                throw new CommandCodeProviderAbortError();
              }
              throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_STREAM_FAILED');
            }
            throw new CommandCodeProviderError(
              'COMMANDCODE_PROVIDER_UPSTREAM_REJECTED', upstream.status,
              responseRetryAfterSeconds(upstream),
              commandCodeRejectionDiagnostic(upstream.status, errorText),
            );
          }
          const responseAccumulator = new CommandCodeResponseAccumulator({
            usagePolicy: 'total-only',
            newToolCallId: () => `call_${safeUuid(uuid)}`,
          });
          accumulator = responseAccumulator;
          let toolIndex = 0;
          await consumeCommandCodeNdjson(
            upstream,
            runtimeConfig.maxNdjsonBufferedChars,
            sink ? runtimeConfig.streamIdleTimeoutMs : runtimeConfig.nonStreamIdleTimeoutMs,
            attemptLinked.controller,
            (rawEvent) => {
              let event = rawEvent;
              const type = ownValue(event, 'type');
              if (type === 'tool-call' && !ownValue(event, 'toolCallId')) {
                event = { ...event, toolCallId: `call_${safeUuid(uuid)}` };
              }
              responseAccumulator.pushEvent(event);
              if (!sink) return;
              if (type === 'text-delta') {
                const text = stringValue(ownValue(event, 'text') || '');
                if (text) {
                  emitted++;
                  sink.onTextDelta(text);
                }
              } else if (type === 'tool-call') {
                const id = stringValue(ownValue(event, 'toolCallId'));
                const name = stringValue(ownValue(event, 'toolName') || '');
                emitted++;
                sink.onToolCallDelta({
                  index: toolIndex++,
                  ...(id ? { id } : {}),
                  ...(name ? { nameDelta: name } : {}),
                  argumentsDelta: toolInputText(ownValue(event, 'input')),
                });
              }
            },
          );
          const state = responseAccumulator.snapshot();
          throwTerminalError(state);
          return completionResult({
            ...state,
            usage: mergeUsage(priorAttemptUsage, state.usage),
          }, wireBody.params.model, now, uuid);
        } catch (error) {
          if (
            ctx.signal?.aborted
            || linked.controller.signal.aborted
            || error instanceof CommandCodeAbortError
            || error instanceof CommandCodeProviderAbortError
          ) {
            throw new CommandCodeProviderAbortError();
          }
          const normalized = error instanceof CommandCodeProviderError
            ? error
            : new CommandCodeProviderError(
              error instanceof CommandCodeStreamIdleTimeoutError
                || error instanceof CommandCodeUpstreamBodyError
                ? 'COMMANDCODE_PROVIDER_STREAM_FAILED'
                : 'COMMANDCODE_PROVIDER_UPSTREAM_FAILED',
            );
          lastError = normalized;
          if (emitted > 0 || !retryableTransportFailure(normalized) || attempt === maxAttempts - 1) {
            throw normalized;
          }
          priorAttemptUsage = mergeUsage(
            priorAttemptUsage,
            accumulator?.snapshot().usage ?? null,
          );
        } finally {
          attemptLinked.cleanup();
        }
        await waitForTransportRetry(
          attempt, lastError.retryAfterSeconds, linked.controller.signal,
        );
      }
      throw lastError ?? new CommandCodeProviderError('COMMANDCODE_PROVIDER_UPSTREAM_FAILED');
    } finally {
      linked.cleanup();
    }
  };

  const listModels = async (ctx: ProviderCallContext): Promise<ProviderModelInfo[]> => {
    if (disposed) throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_DISPOSED');
    const apiKey = await requireApiKey(resolveApiKey);
    const linked = linkedController(ctx.signal, providerController.signal);
    try {
      const models = await runtime.listModels({ apiKey, signal: linked.controller.signal });
      return models.map((model) => ({ id: model.id, displayName: model.id }));
    } catch (error) {
      if (ctx.signal?.aborted || providerController.signal.aborted || error instanceof CommandCodeAbortError) {
        throw new CommandCodeProviderAbortError();
      }
      throw new CommandCodeProviderError('COMMANDCODE_PROVIDER_UPSTREAM_FAILED');
    } finally {
      linked.cleanup();
    }
  };

  const health = async (): Promise<ProviderHealth> => {
    if (disposed) return { ok: false, code: 'disposed', detail: 'CommandCode provider is stopped' };
    try {
      const apiKey = await options.resolveApiKey();
      if (!isCommandCodeApiKey(apiKey)) {
        return { ok: false, code: 'not_configured', detail: 'CommandCode credential is not configured' };
      }
      return { ok: true, code: 'ready', detail: 'CommandCode credential is configured' };
    } catch {
      return {
        ok: false,
        code: 'credential_unavailable',
        detail: 'CommandCode credential could not be resolved',
      };
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    providerController.abort();
    disposePromise = Promise.resolve(runtime.dispose());
    void disposePromise.catch(() => undefined);
    return disposePromise;
  };

  const descriptor = Object.freeze({
    id: 'commandcode',
    displayName: 'CommandCode',
    adapterVersion: '0.1.0',
    protocolVersion: 1 as const,
    configured: options.configured,
    capabilities: Object.freeze({
      listModels: true,
      stream: true,
      tools: true,
      vision: true,
      chatCompletions: true,
      responses: false,
      messages: false,
    }),
  });
  const adapter: ProviderAdapter = {
    descriptor,
    listModels,
    complete: (req, ctx) => execute(req, undefined, ctx),
    stream: (req, sink, ctx) => execute(req, sink, ctx),
    health,
    dispose,
  };
  return Object.freeze(adapter);
}
