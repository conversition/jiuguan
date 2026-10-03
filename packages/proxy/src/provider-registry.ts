import { AsyncLocalStorage } from 'node:async_hooks';
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderAdapter,
  type ProviderCallContext,
  type ProviderCapabilities,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderModelInfo,
  type ProviderStreamSink,
} from './provider-types.ts';

const PROVIDER_ID_RE = /^[a-z][a-z0-9.-]{0,63}$/;
// DSH 插件 id 允许数字开头；owner 校验必须与插件清单保持一致。
const OWNER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const BUILTIN_PREFIX = 'builtin.';
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_GRACE_MS = 2_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_STREAM_TOOL_CALLS = 128;
const PROVIDER_OPERATION_FORCED = Symbol('provider-operation-forced');

type ProviderLifecyclePhase = 'active' | 'draining' | 'disposed';
type ProviderMethod = 'listModels' | 'complete' | 'stream' | 'health';
type ProviderCapability = keyof Pick<
  ProviderCapabilities,
  'listModels' | 'stream' | 'tools' | 'vision' | 'chatCompletions'
>;

interface ProviderActiveOperation {
  readonly forced: Promise<typeof PROVIDER_OPERATION_FORCED>;
  readonly isForced: () => boolean;
  readonly force: () => void;
  readonly release: () => void;
}

interface ProviderEntry {
  ownerId: string;
  adapter: ProviderAdapter;
  descriptor: ProviderDescriptor;
  phase: ProviderLifecyclePhase;
  controller: AbortController;
  activeOperations: Set<ProviderActiveOperation>;
  idleWaiters: Set<() => void>;
  shutdown?: Promise<void>;
  disposeTask?: Promise<void>;
}

export type ProviderRegistrationDisposer = () => Promise<void>;

export type ProviderRegistryErrorCode =
  | 'not-found'
  | 'not-configured'
  | 'capability-disabled'
  | 'method-unavailable'
  | 'recursive-call'
  | 'invocation-aborted'
  | 'invocation-forced'
  | 'provider-failed';

/** 面向宿主调用方的稳定错误；不会拼接 AbortSignal.reason 或插件异常。 */
export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;
  readonly providerId: string;
  /** Content-free telemetry category; public control flow still uses the coarse `code`. */
  readonly diagnosticCode?: ProviderFailureDiagnosticCode;
  /** Bounded, content-free backoff hint copied from a trusted adapter field only. */
  readonly retryAfterSeconds?: number;

  constructor(code: ProviderRegistryErrorCode, providerId: string, message: string,
    diagnosticCode?: ProviderFailureDiagnosticCode, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
    this.providerId = providerId;
    this.diagnosticCode = diagnosticCode;
    if (typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds)
      && retryAfterSeconds >= 1 && retryAfterSeconds <= 300) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

const MAX_PROVIDER_RETRY_AFTER_SECONDS = 300;

/** Reads only one explicit scalar field; error bodies/messages/causes remain private. */
export function providerFailureRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  let value: unknown;
  try { value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds; }
  catch { return undefined; }
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 1 && value <= MAX_PROVIDER_RETRY_AFTER_SECONDS
    ? value : undefined;
}

export type ProviderFailureDiagnosticCode =
  | 'provider-not-configured'
  | 'provider-authentication-failed'
  | 'provider-request-invalid'
  | 'provider-rate-limited'
  | 'provider-timeout'
  | 'provider-upstream-unavailable'
  | 'provider-transport-failed'
  | 'provider-stream-failed'
  | 'provider-stream-incomplete'
  | 'provider-disposed'
  | 'provider-failed';

/** Classifies only fixed status/name/code fields. Error text and upstream bodies are never read. */
export function providerFailureDiagnosticCode(error: unknown): ProviderFailureDiagnosticCode {
  if (!error || typeof error !== 'object') return 'provider-failed';
  let code: unknown;
  let status: unknown;
  let name: unknown;
  let diagnosticCode: unknown;
  try {
    const row = error as { code?: unknown; status?: unknown; name?: unknown; diagnosticCode?: unknown };
    code = row.code;
    status = row.status;
    name = row.name;
    diagnosticCode = row.diagnosticCode;
  } catch {
    return 'provider-failed';
  }
  if ([
    'provider-not-configured',
    'provider-authentication-failed',
    'provider-request-invalid',
    'provider-rate-limited',
    'provider-timeout',
    'provider-upstream-unavailable',
    'provider-transport-failed',
    'provider-stream-failed',
    'provider-stream-incomplete',
    'provider-disposed',
    'provider-failed',
  ].includes(String(diagnosticCode))) return diagnosticCode as ProviderFailureDiagnosticCode;
  if (code === 'COMMANDCODE_PROVIDER_NOT_CONFIGURED') return 'provider-not-configured';
  if (code === 'COMMANDCODE_PROVIDER_CREDENTIAL_INVALID') return 'provider-authentication-failed';
  if (code === 'COMMANDCODE_PROVIDER_REQUEST_INVALID') return 'provider-request-invalid';
  if (code === 'COMMANDCODE_PROVIDER_STREAM_FAILED') return 'provider-stream-failed';
  if (code === 'COMMANDCODE_PROVIDER_STREAM_INCOMPLETE') return 'provider-stream-incomplete';
  if (code === 'COMMANDCODE_PROVIDER_DISPOSED') return 'provider-disposed';
  // The adapter deliberately uses this fixed code only when no HTTP response
  // was available (for example a transport or local runtime failure). Keep it
  // distinct from a received 5xx response without inspecting error text/cause.
  if (code === 'COMMANDCODE_PROVIDER_UPSTREAM_FAILED') return 'provider-transport-failed';
  if (name === 'CommandCodeStreamIdleTimeoutError' || name === 'TimeoutError') return 'provider-timeout';
  if (status === 401 || status === 403) return 'provider-authentication-failed';
  if (status === 408) return 'provider-timeout';
  if (status === 429) return 'provider-rate-limited';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) {
    return 'provider-upstream-unavailable';
  }
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499) {
    return 'provider-request-invalid';
  }
  return 'provider-failed';
}

export interface ProviderRegistryOptions {
  /** 停止准入后，允许调用自然完成的最长时间。 */
  drainTimeoutMs?: number;
  /** 发出 owner signal 后，允许适配器协作式退出的宽限时间。 */
  abortGraceMs?: number;
  /** adapter.dispose 的单次有界等待时间。 */
  disposeTimeoutMs?: number;
  onDisposeError?: (providerId: string, error: unknown) => void;
  /** 只报告发生过迟到拒绝；原始错误不会跨生命周期边界泄漏。 */
  onLateInvocationError?: (providerId: string, error: ProviderRegistryError) => void;
}

function assertId(kind: 'provider' | 'owner', value: string): void {
  const re = kind === 'provider' ? PROVIDER_ID_RE : OWNER_ID_RE;
  if (!re.test(value)) {
    throw new Error(`${kind} id 非法: ${value}`);
  }
}

function safeNotify(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // 诊断回调不得破坏 registry 生命周期。
  }
}

/** 只复制公开白名单字段，防止 adapter 在 descriptor 上附带凭据并被 API 回显。 */
function publicDescriptor(input: ProviderDescriptor): ProviderDescriptor {
  if (!input || typeof input !== 'object') {
    throw new Error('Provider descriptor 缺失');
  }
  assertId('provider', input.id);
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
    throw new Error('Provider displayName 非法: ' + input.id);
  }
  if (typeof input.adapterVersion !== 'string' || input.adapterVersion.length === 0) {
    throw new Error('Provider adapterVersion 非法: ' + input.id);
  }
  if (typeof input.configured !== 'boolean') {
    throw new Error('Provider configured 非法: ' + input.id);
  }
  const capabilities = input.capabilities;
  if (!capabilities
    || typeof capabilities.listModels !== 'boolean'
    || typeof capabilities.stream !== 'boolean'
    || typeof capabilities.tools !== 'boolean'
    || typeof capabilities.vision !== 'boolean'
    || typeof capabilities.chatCompletions !== 'boolean'
    || (capabilities.responses !== undefined && typeof capabilities.responses !== 'boolean')
    || (capabilities.messages !== undefined && typeof capabilities.messages !== 'boolean')) {
    throw new Error('Provider capabilities 非法: ' + input.id);
  }
  if (input.protocolVersion !== PROVIDER_PROTOCOL_VERSION) {
    throw new Error(
      `Provider ${input.id} 协议版本不兼容: ${input.protocolVersion} != ${PROVIDER_PROTOCOL_VERSION}`,
    );
  }
  return {
    id: input.id,
    displayName: input.displayName,
    adapterVersion: input.adapterVersion,
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    configured: input.configured,
    capabilities: {
      listModels: capabilities.listModels,
      stream: capabilities.stream,
      tools: capabilities.tools,
      vision: capabilities.vision,
      chatCompletions: capabilities.chatCompletions,
      ...(capabilities.responses !== undefined ? { responses: capabilities.responses } : {}),
      ...(capabilities.messages !== undefined ? { messages: capabilities.messages } : {}),
    },
  };
}

function assertAdapterMethods(adapter: ProviderAdapter, descriptor: ProviderDescriptor): void {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`Provider adapter 非法: ${descriptor.id}`);
  }
  if (typeof adapter.complete !== 'function') {
    throw new Error(`Provider complete 方法缺失: ${descriptor.id}`);
  }
  if (descriptor.capabilities.listModels && typeof adapter.listModels !== 'function') {
    throw new Error(`Provider 声明 listModels 能力但方法缺失: ${descriptor.id}`);
  }
  if (descriptor.capabilities.stream && typeof adapter.stream !== 'function') {
    throw new Error(`Provider 声明 stream 能力但方法缺失: ${descriptor.id}`);
  }
}

function publicModelCapabilities(
  input: Partial<ProviderCapabilities> | undefined,
  providerId: string,
): Partial<ProviderCapabilities> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object') {
    throw new Error(`Provider models capabilities 非法: ${providerId}`);
  }
  const output: Partial<ProviderCapabilities> = {};
  const keys: Array<keyof ProviderCapabilities> = [
    'listModels', 'stream', 'tools', 'vision', 'chatCompletions', 'responses', 'messages',
  ];
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new Error(`Provider models capabilities 非法: ${providerId}`);
    }
    output[key] = value;
  }
  return output;
}

function validateModels(value: unknown, providerId: string): ProviderModelInfo[] {
  if (!Array.isArray(value)) throw new Error(`Provider models 结果非法: ${providerId}`);
  return value.map((model) => {
    if (!model || typeof model !== 'object') {
      throw new Error(`Provider model 非法: ${providerId}`);
    }
    const candidate = model as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
      throw new Error(`Provider model id 非法: ${providerId}`);
    }
    if (candidate.displayName !== undefined && typeof candidate.displayName !== 'string') {
      throw new Error(`Provider model displayName 非法: ${providerId}`);
    }
    const modelCapabilities = publicModelCapabilities(
      candidate.capabilities as Partial<ProviderCapabilities> | undefined,
      providerId,
    );
    return {
      id: candidate.id,
      ...(candidate.displayName !== undefined ? { displayName: candidate.displayName } : {}),
      ...(modelCapabilities !== undefined ? { capabilities: modelCapabilities } : {}),
    };
  });
}

function validateCompletion(value: unknown, providerId: string): ProviderCompletionResult {
  if (!value || typeof value !== 'object') {
    throw new Error(`Provider completion 结果非法: ${providerId}`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.content !== null && typeof candidate.content !== 'string') {
    throw new Error(`Provider completion content 非法: ${providerId}`);
  }
  if (typeof candidate.finishReason !== 'string' || !Array.isArray(candidate.toolCalls)) {
    throw new Error(`Provider completion 结构非法: ${providerId}`);
  }
  const toolCalls = candidate.toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== 'object') {
      throw new Error(`Provider completion toolCall 非法: ${providerId}`);
    }
    const tool = toolCall as Record<string, unknown>;
    if (typeof tool.id !== 'string'
      || typeof tool.name !== 'string'
      || typeof tool.arguments !== 'string') {
      throw new Error(`Provider completion toolCall 非法: ${providerId}`);
    }
    return { id: tool.id, name: tool.name, arguments: tool.arguments };
  });
  const usage = candidate.usage;
  let normalizedUsage: ProviderCompletionResult['usage'];
  if (usage !== undefined && usage !== null) {
    if (!usage || typeof usage !== 'object') {
      throw new Error(`Provider completion usage 非法: ${providerId}`);
    }
    const record = usage as Record<string, unknown>;
    const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    if (!integer(record.prompt_tokens)
      || !integer(record.completion_tokens)
      || !integer(record.total_tokens)) {
      throw new Error(`Provider completion usage 非法: ${providerId}`);
    }
    for (const key of ['cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const) {
      if (record[key] !== undefined && !integer(record[key])) {
        throw new Error(`Provider completion usage 非法: ${providerId}`);
      }
    }
    normalizedUsage = {
      prompt_tokens: record.prompt_tokens,
      completion_tokens: record.completion_tokens,
      total_tokens: record.total_tokens,
      ...(record.cached_input_tokens === undefined ? {} : { cached_input_tokens: record.cached_input_tokens as number }),
      ...(record.cache_write_tokens === undefined ? {} : { cache_write_tokens: record.cache_write_tokens as number }),
      ...(record.reasoning_tokens === undefined ? {} : { reasoning_tokens: record.reasoning_tokens as number }),
    };
  } else if (usage === null) {
    normalizedUsage = null;
  }
  return {
    content: candidate.content as string | null,
    toolCalls,
    finishReason: candidate.finishReason,
    ...(usage !== undefined ? { usage: normalizedUsage } : {}),
    // raw 是旧直连客户端的调试字段，不属于 Provider SPI 的公开结果契约。
    // 不透传插件任意对象，避免把 Key/Cookie/内部 URL 夹带回宿主调用链。
    raw: { providerId },
  };
}

function validateHealth(value: unknown, providerId: string): ProviderHealth {
  if (!value || typeof value !== 'object') {
    throw new Error(`Provider health 结果非法: ${providerId}`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ok !== 'boolean'
    || (candidate.code !== undefined && typeof candidate.code !== 'string')
    || (candidate.detail !== undefined && typeof candidate.detail !== 'string')) {
    throw new Error(`Provider health 结构非法: ${providerId}`);
  }
  return {
    ok: candidate.ok,
    ...(candidate.code !== undefined ? { code: candidate.code } : {}),
    ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
  };
}

function timeoutValue(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('ProviderRegistry timeout 必须是有限数字');
  return Math.max(minimum, Math.floor(value));
}

/**
 * 将 caller/owner 的中止转成新的 signal；adapter 只能看到标准 AbortError，
 * 无法读取 caller 传入的任意 reason。
 */
function sanitizedSignal(
  callerSignal: AbortSignal | undefined,
  ownerSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const sources = [callerSignal, ownerSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of sources) {
    if (signal.aborted) {
      abort();
      continue;
    }
    const listener = () => abort();
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

function requestCapabilities(
  request: ProviderCompletionRequest,
  streaming: boolean,
): ProviderCapability[] {
  const required: ProviderCapability[] = ['chatCompletions'];
  if (streaming) required.push('stream');
  if ((request.tools?.length ?? 0) > 0) required.push('tools');
  const hasImage = request.messages.some((message) => (
    Array.isArray(message.content)
      && message.content.some((part) => part.type === 'image_url')
  ));
  if (hasImage) required.push('vision');
  return required;
}

/**
 * 电脑端 Provider 注册表。
 *
 * adapter 永不直接暴露给调用方；所有生产调用必须经过此处的能力门禁、递归保护、
 * owner signal 和调用租约。注销会同步停止准入，再异步 drain 与清理。
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();
  private readonly instances = new Set<ProviderEntry>();
  private readonly invocationScope = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly drainTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly onDisposeError?: ProviderRegistryOptions['onDisposeError'];
  private readonly onLateInvocationError?: ProviderRegistryOptions['onLateInvocationError'];

  constructor(options: ProviderRegistryOptions = {}) {
    this.drainTimeoutMs = timeoutValue(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 0);
    this.abortGraceMs = timeoutValue(options.abortGraceMs, DEFAULT_ABORT_GRACE_MS, 0);
    this.disposeTimeoutMs = timeoutValue(options.disposeTimeoutMs, DEFAULT_DISPOSE_TIMEOUT_MS, 1);
    this.onDisposeError = options.onDisposeError;
    this.onLateInvocationError = options.onLateInvocationError;
  }

  register(ownerId: string, adapter: ProviderAdapter): ProviderRegistrationDisposer {
    const descriptor = publicDescriptor(adapter?.descriptor);
    if (descriptor.id.startsWith(BUILTIN_PREFIX)) {
      throw new Error(`插件 Provider 不得占用保留命名空间: ${descriptor.id}`);
    }
    assertAdapterMethods(adapter, descriptor);
    return this.registerEntry(ownerId, adapter, descriptor);
  }

  registerBuiltin(ownerId: string, adapter: ProviderAdapter): ProviderRegistrationDisposer {
    const descriptor = publicDescriptor(adapter?.descriptor);
    if (!descriptor.id.startsWith(BUILTIN_PREFIX)) {
      throw new Error(`内置 Provider 必须使用 ${BUILTIN_PREFIX} 前缀: ${descriptor.id}`);
    }
    assertAdapterMethods(adapter, descriptor);
    return this.registerEntry(ownerId, adapter, descriptor);
  }

  /** 仅 owner 可原子替换公开描述；adapter 与在途调用保持不变。 */
  updateDescriptor(ownerId: string, descriptorInput: ProviderDescriptor): void {
    assertId('owner', ownerId);
    const descriptor = publicDescriptor(descriptorInput);
    const entry = this.entries.get(descriptor.id);
    if (!entry || entry.phase !== 'active') {
      throw new Error(`Provider 不可更新: ${descriptor.id}`);
    }
    if (entry.ownerId !== ownerId) {
      throw new Error(`Provider owner 不匹配: ${descriptor.id}`);
    }
    assertAdapterMethods(entry.adapter, descriptor);
    entry.descriptor = descriptor;
  }

  /** 单个公开描述的诊断快照；绝不返回 raw adapter。 */
  describe(id: string): ProviderDescriptor | undefined {
    const descriptor = this.entries.get(id)?.descriptor;
    return descriptor ? publicDescriptor(descriptor) : undefined;
  }

  list(): ProviderDescriptor[] {
    return [...this.entries.values()]
      .map((entry) => publicDescriptor(entry.descriptor))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  listModels(id: string, ctx: ProviderCallContext): Promise<ProviderModelInfo[]> {
    return this.invoke(id, 'listModels', ['listModels'], true, ctx, async (adapter, callContext) => (
      validateModels(await adapter.listModels!(callContext), id)
    ));
  }

  complete(
    id: string,
    request: ProviderCompletionRequest,
    ctx: ProviderCallContext,
  ): Promise<ProviderCompletionResult> {
    return this.invoke(
      id,
      'complete',
      requestCapabilities(request, false),
      true,
      ctx,
      async (adapter, callContext) => validateCompletion(
        await adapter.complete(request, callContext),
        id,
      ),
    );
  }

  stream(
    id: string,
    request: ProviderCompletionRequest,
    sink: ProviderStreamSink,
    ctx: ProviderCallContext,
  ): Promise<ProviderCompletionResult> {
    return this.invoke(id, 'stream', requestCapabilities(request, true), true, ctx, async (adapter, callContext, isOpen) => {
      let sinkFailed = false;
      let terminalSinkError: unknown;
      const poisonSink = (error: unknown): never => {
        if (!sinkFailed) {
          sinkFailed = true;
          terminalSinkError = error;
        }
        throw terminalSinkError;
      };
      const rejectBoundary = (kind: 'text' | 'tool'): never => {
        return poisonSink(new Error(`Provider stream ${kind} 增量非法: ${id}`));
      };
      const sinkIsOpen = (): boolean => {
        if (sinkFailed) poisonSink(terminalSinkError);
        return isOpen();
      };
      const guardedSink: ProviderStreamSink = {
        onTextDelta: (delta) => {
          if (!sinkIsOpen()) return;
          if (typeof delta !== 'string') rejectBoundary('text');
          try {
            sink.onTextDelta(delta);
          } catch (error) {
            poisonSink(error);
          }
        },
        onToolCallDelta: (delta) => {
          if (!sinkIsOpen()) return;
          if (!delta || typeof delta !== 'object') rejectBoundary('tool');
          let index: unknown;
          let toolId: unknown;
          let nameDelta: unknown;
          let argumentsDelta: unknown;
          try {
            const candidate = delta as unknown as Record<string, unknown>;
            index = candidate.index;
            toolId = candidate.id;
            nameDelta = candidate.nameDelta;
            argumentsDelta = candidate.argumentsDelta;
          } catch {
            rejectBoundary('tool');
          }
          if (!Number.isSafeInteger(index)
            || (index as number) < 0
            || (index as number) >= MAX_PROVIDER_STREAM_TOOL_CALLS
            || (toolId !== undefined && typeof toolId !== 'string')
            || (nameDelta !== undefined && typeof nameDelta !== 'string')
            || (argumentsDelta !== undefined && typeof argumentsDelta !== 'string')) {
            rejectBoundary('tool');
          }
          try {
            // 只使用一次性快照并复制协议白名单字段；getter/Proxy 不能在校验后换值。
            sink.onToolCallDelta({
              index: index as number,
              ...(toolId !== undefined ? { id: toolId as string } : {}),
              ...(nameDelta !== undefined ? { nameDelta: nameDelta as string } : {}),
              ...(argumentsDelta !== undefined ? { argumentsDelta: argumentsDelta as string } : {}),
            });
          } catch (error) {
            poisonSink(error);
          }
        },
      };
      const completion = await adapter.stream!(request, guardedSink, callContext);
      // adapter 可能捕获边界或宿主 consumer 异常；注册表仍必须拒绝整次调用。
      if (sinkFailed) throw terminalSinkError;
      return validateCompletion(completion, id);
    });
  }

  health(id: string, ctx: ProviderCallContext): Promise<ProviderHealth> {
    return this.invoke(id, 'health', [], false, ctx, async (adapter, callContext) => (
      validateHealth(await adapter.health!(callContext), id)
    ));
  }

  /** 同步停止 owner 的所有准入，再等待每个实例独立 drain。 */
  async unregisterOwner(ownerId: string): Promise<void> {
    const tasks = [...this.instances]
      .filter((entry) => entry.ownerId === ownerId)
      .map((entry) => this.removeEntry(entry));
    await Promise.all(tasks);
  }

  /** 同步停止全部准入，再等待所有实例清理完毕。 */
  async clear(): Promise<void> {
    const tasks = [...this.instances].map((entry) => this.removeEntry(entry));
    await Promise.all(tasks);
  }

  private registerEntry(
    ownerId: string,
    adapter: ProviderAdapter,
    descriptor: ProviderDescriptor,
  ): ProviderRegistrationDisposer {
    assertId('owner', ownerId);
    if (this.entries.has(descriptor.id)) {
      throw new Error(`Provider 已注册: ${descriptor.id}`);
    }

    const entry: ProviderEntry = {
      ownerId,
      adapter,
      descriptor,
      phase: 'active',
      controller: new AbortController(),
      activeOperations: new Set(),
      idleWaiters: new Set(),
    };
    this.entries.set(descriptor.id, entry);
    this.instances.add(entry);
    let removal: Promise<void> | undefined;
    return () => {
      removal ??= this.removeEntry(entry);
      return removal;
    };
  }

  private invoke<T>(
    id: string,
    method: ProviderMethod,
    capabilities: readonly ProviderCapability[],
    requireConfigured: boolean,
    ctx: ProviderCallContext,
    call: (
      adapter: ProviderAdapter,
      callContext: ProviderCallContext,
      isOpen: () => boolean,
    ) => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry || entry.phase !== 'active') {
      return Promise.reject(this.callError('not-found', id, `Provider 不可用: ${id}`));
    }
    if (requireConfigured && !entry.descriptor.configured) {
      return Promise.reject(this.callError('not-configured', id, `Provider 尚未配置: ${id}`));
    }
    for (const capability of capabilities) {
      if (entry.descriptor.capabilities[capability] !== true) {
        return Promise.reject(this.callError(
          'capability-disabled',
          id,
          `Provider 未声明 ${capability} 能力: ${id}`,
        ));
      }
    }
    if (typeof entry.adapter[method] !== 'function') {
      return Promise.reject(this.callError(
        'method-unavailable',
        id,
        `Provider 未实现 ${method}: ${id}`,
      ));
    }
    if (ctx.signal?.aborted) {
      return Promise.reject(this.callError('invocation-aborted', id, `Provider 调用已中止: ${id}`));
    }
    const parentScope = this.invocationScope.getStore();
    if (parentScope?.has(id)) {
      return Promise.reject(this.callError(
        'recursive-call',
        id,
        `Provider 不允许递归调用自身: ${id}`,
      ));
    }

    const operation = this.acquireOperation(entry);
    const linked = sanitizedSignal(ctx.signal, entry.controller.signal);
    let consumerOpen = true;
    let resolveCallerAbort!: () => void;
    const callerAborted = new Promise<{ kind: 'caller-aborted' }>((resolve) => {
      resolveCallerAbort = () => resolve({ kind: 'caller-aborted' });
    });
    // caller abort 只结束本次调用方等待并关闭 sink；底层 work 的生命周期租约
    // 必须保留到真正 settle，避免 adapter.dispose 与忽略 signal 的 work 并发。
    const callerAbortListener = ctx.signal ? () => {
      consumerOpen = false;
      resolveCallerAbort();
    } : undefined;
    if (ctx.signal && callerAbortListener) {
      ctx.signal.addEventListener('abort', callerAbortListener, { once: true });
    }
    const callContext: ProviderCallContext = {
      ...ctx,
      signal: linked.signal,
    };
    const scope = new Set(parentScope ?? []);
    scope.add(id);
    const work = this.invocationScope.run(scope, () => (
      Promise.resolve().then(() => call(
        entry.adapter,
        callContext,
        // AbortController 会同步分发 signal listener。linked listener 比下面的
        // callerAbortListener 更早注册，因此必须直接检查 signal，堵住 adapter 在
        // abort handler 内同步 emit 的窗口；owner drain abort 同理。
        () => consumerOpen && !operation.isForced() && !linked.signal.aborted,
      ))
    ));
    // 记录底层工作真正 settle 时 signal 的状态。自然完成释放最后一个租约后，
    // unload 会立即 abort owner signal；不能让这个“完成后的 abort”把已经完成的
    // value/error 误判成调用中止。
    let abortedAtWorkSettlement = false;
    // work 自己拥有租约；调用方提前取消不能提前 release。
    void work.then(
      () => {
        abortedAtWorkSettlement = linked.signal.aborted;
        operation.release();
      },
      () => {
        abortedAtWorkSettlement = linked.signal.aborted;
        operation.release();
      },
    );

    void work.catch(() => {
      if (!operation.isForced()) return;
      const error = this.callError(
        'invocation-forced',
        id,
        `Provider 强制结束后发生迟到拒绝: ${id}`,
      );
      safeNotify(() => this.onLateInvocationError?.(id, error));
    });

    const settled = work.then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const forced = operation.forced.then(() => ({ kind: 'forced' as const }));
    return Promise.race([settled, forced, callerAborted]).then((outcome) => {
      consumerOpen = false;
      if (outcome.kind === 'caller-aborted') {
        throw this.callError('invocation-aborted', id, 'Provider 调用已中止: ' + id);
      }
      if (outcome.kind === 'forced') {
        if (ctx.signal?.aborted) {
          throw this.callError('invocation-aborted', id, `Provider 调用已中止: ${id}`);
        }
        throw this.callError('invocation-forced', id, `Provider 调用因卸载被终止: ${id}`);
      }
      if (outcome.kind === 'error') {
        if (abortedAtWorkSettlement) {
          throw this.callError('invocation-aborted', id, `Provider 调用已中止: ${id}`);
        }
        throw this.callError(
          'provider-failed', id, `Provider 调用失败: ${id}`,
          providerFailureDiagnosticCode(outcome.error),
          providerFailureRetryAfterSeconds(outcome.error),
        );
      }
      // 协作式 adapter 可能在 abort handler 中 resolve。即使 value 先赢得
      // Promise.race，也不能把中止后的结果提交给调用方。
      if (abortedAtWorkSettlement) {
        throw this.callError('invocation-aborted', id, `Provider 调用已中止: ${id}`);
      }
      return outcome.value;
    }).finally(() => {
      if (ctx.signal && callerAbortListener) {
        ctx.signal.removeEventListener('abort', callerAbortListener);
      }
      linked.cleanup();
    });
  }

  private callError(
    code: ProviderRegistryErrorCode,
    providerId: string,
    message: string,
    diagnosticCode?: ProviderFailureDiagnosticCode,
    retryAfterSeconds?: number,
  ): ProviderRegistryError {
    return new ProviderRegistryError(code, providerId, message, diagnosticCode, retryAfterSeconds);
  }

  private removeEntry(entry: ProviderEntry): Promise<void> {
    if (entry.shutdown) return entry.shutdown;
    entry.phase = 'draining';
    if (this.entries.get(entry.descriptor.id) === entry) {
      this.entries.delete(entry.descriptor.id);
    }

    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    entry.shutdown = shutdown;
    void this.retireEntry(entry).then(
      resolveShutdown,
      (error: unknown) => {
        safeNotify(() => this.onDisposeError?.(entry.descriptor.id, error));
        resolveShutdown();
      },
    );
    return shutdown;
  }

  private async retireEntry(entry: ProviderEntry): Promise<void> {
    try {
      const drained = await this.waitForIdle(entry, this.drainTimeoutMs);
      if (!drained) {
        if (!entry.controller.signal.aborted) entry.controller.abort();
        const aborted = await this.waitForIdle(entry, this.abortGraceMs);
        if (!aborted) this.forceActiveOperations(entry);
      } else if (!entry.controller.signal.aborted) {
        entry.controller.abort();
      }
      await this.disposeAdapter(entry);
    } finally {
      entry.phase = 'disposed';
      if (!entry.controller.signal.aborted) entry.controller.abort();
      this.forceActiveOperations(entry);
      entry.activeOperations.clear();
      entry.idleWaiters.clear();
      this.instances.delete(entry);
    }
  }

  private waitForIdle(entry: ProviderEntry, timeoutMs: number): Promise<boolean> {
    if (entry.activeOperations.size === 0) return Promise.resolve(true);
    if (timeoutMs === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const onIdle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.idleWaiters.delete(onIdle);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        entry.idleWaiters.delete(onIdle);
        resolve(false);
      }, timeoutMs);
      entry.idleWaiters.add(onIdle);
      if (entry.activeOperations.size === 0) onIdle();
    });
  }

  private acquireOperation(entry: ProviderEntry): ProviderActiveOperation {
    let forcedState = false;
    let released = false;
    let resolveForced!: (value: typeof PROVIDER_OPERATION_FORCED) => void;
    const forced = new Promise<typeof PROVIDER_OPERATION_FORCED>((resolve) => {
      resolveForced = resolve;
    });
    let operation!: ProviderActiveOperation;
    operation = {
      forced,
      isForced: () => forcedState,
      force: () => {
        if (forcedState) return;
        forcedState = true;
        resolveForced(PROVIDER_OPERATION_FORCED);
        operation.release();
      },
      release: () => {
        if (released) return;
        released = true;
        entry.activeOperations.delete(operation);
        if (entry.activeOperations.size === 0) {
          for (const resolveIdle of entry.idleWaiters) resolveIdle();
          entry.idleWaiters.clear();
        }
      },
    };
    entry.activeOperations.add(operation);
    return operation;
  }

  private forceActiveOperations(entry: ProviderEntry): void {
    for (const operation of [...entry.activeOperations]) operation.force();
  }

  private async disposeAdapter(entry: ProviderEntry): Promise<void> {
    if (entry.disposeTask) return entry.disposeTask;
    const task = this.runDispose(entry);
    entry.disposeTask = task;
    return task;
  }

  private async runDispose(entry: ProviderEntry): Promise<void> {
    if (typeof entry.adapter.dispose !== 'function') return;
    const work = Promise.resolve().then(() => entry.adapter.dispose!());
    const settled = work.then(
      () => ({ kind: 'done' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.disposeTimeoutMs);
    });
    const outcome = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === 'error') {
      safeNotify(() => this.onDisposeError?.(entry.descriptor.id, outcome.error));
    } else if (outcome.kind === 'timeout') {
      safeNotify(() => this.onDisposeError?.(
        entry.descriptor.id,
        new Error(`Provider dispose 超时: ${entry.descriptor.id}`),
      ));
    }
  }
}

export { BUILTIN_PREFIX as PROVIDER_BUILTIN_PREFIX };
