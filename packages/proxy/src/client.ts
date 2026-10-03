/**
 * proxy 包 - OpenAI 兼容客户端（chat/completions + SSE 流式 + tools）
 * 端点：{baseUrl}/v1/chat/completions；支持非流式（工具调用首选）与流式（正文渲染）。
 */
import type { ProviderConfig } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** 部分网关要求（Anthropic 转换层） */
  type?: string;
}

export type ChatContent = string | ChatContentPart[];

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Record<string, unknown>[];
  tool_choice?: 'auto' | 'none' | 'required' | Record<string, unknown>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  extraBody?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Provider 已归一化的真实用量。可选细分字段缺失时必须保持 undefined，不能伪装成 0。 */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: ChatUsage | null;
  /** 原始响应（调试） */
  raw: unknown;
}

/** 仅供宿主观测与准入使用；Registry 只向 Provider SPI 透传 runId，不下传其余本地元数据。 */
export type ModelCallLane =
  | 'turn_final'
  | 'interactive_prelude'
  | 'context_compiler'
  | 'variable_compile'
  | 'rolling_summary'
  | 'story_index'
  | 'aql_replan'
  | 'quiet_generate'
  | 'storyboard'
  | 'video_prompt'
  | 'maintenance'
  | 'style_compile'
  | 'preference'
  | 'arc'
  | 'npc'
  | 'critic'
  | 'unclassified';

/** 单次酒馆内部模型调用的稳定身份。CLI 客户端可忽略该元数据。 */
export interface ChatProviderCall {
  runId?: string;
  parentRunId?: string;
  sessionId?: string;
  round?: number;
  lane?: ModelCallLane;
  callIndex?: number;
  /**
   * 宿主为受控调用设置的单次逻辑调用传输尝试硬上限。
   * 普通主对话不设置，继续使用客户端默认重试策略；Provider 适配器不得提高该值。
   */
  maxTransportAttempts?: number;
}

/** OpenAI-compatible SSE 工具参数分片的稳定身份；旧两参数回调可忽略第三参。 */
export interface ChatToolArgumentDelta {
  index: number;
  id?: string;
  nameDelta?: string;
}

/**
 * 酒馆生成链路依赖的最小客户端形状。
 *
 * server 注入 Registry-backed 实现；独立 CLI 继续直接使用 OpenAICompatibleClient。
 * 业务层只依赖此窄接口，避免长持某个可能被热卸载的 Provider adapter。
 */
export interface ChatCompletionClient {
  complete(req: ChatRequest, signal?: AbortSignal, call?: ChatProviderCall): Promise<ChatResponse>;
  stream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
  modelName?(): string;
  /** P13-C 等可选执行器只能在能力被宿主明确证明时启用；缺省视为全部 false。 */
  capabilities?(): { readonly stream: boolean; readonly tools: boolean };
}

export class OpenAICompatibleError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'OpenAICompatibleError';
  }
}

/** 回合中止信号错误：用户主动停止生成时由 stream 抛出，调用方捕获后落库部分正文 */
export class AbortTurnError extends Error {
  constructor() {
    super('回合生成已中止');
    this.name = 'AbortTurnError';
  }
}

/** SSE 流式解析：逐行读 response.body，回调 data 块，并报告协议终态。 */
export async function streamSSE(
  body: ReadableStream<Uint8Array>,
  onData: (json: unknown) => void,
  signal?: AbortSignal,
): Promise<{ sawDone: boolean; malformedData: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let malformedData = 0;
  const cancelForAbort = () => {
    // Some fetch implementations resolve a pending read as EOF on abort instead
    // of rejecting it. Explicit cancellation closes the upstream body in both
    // cases; never forward signal.reason because it may contain caller data.
    void reader.cancel(new AbortTurnError()).catch(() => {});
  };
  if (signal?.aborted) cancelForAbort();
  else signal?.addEventListener('abort', cancelForAbort, { once: true });
  const consume = (line: string): boolean => {
    const t = line.trim();
    if (!t.startsWith('data:')) return false;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      malformedData++;
      return false;
    }
    // Consumer failures are application errors, not malformed SSE. Propagate
    // them so a partially consumed tool call can never be committed as success.
    onData(parsed);
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (consume(line)) return { sawDone: true, malformedData };
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && consume(buffer)) return { sawDone: true, malformedData };
    return { sawDone: false, malformedData };
  } catch (error) {
    // A parser/consumer/read failure must terminate the upstream body. Keep the
    // original failure authoritative even when cancellation itself also fails.
    try {
      await reader.cancel(error);
    } catch {
      // Best effort only: the caller needs the original application error.
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancelForAbort);
    try {
      reader.releaseLock();
    } catch {
      // A stream may already have released/invalidated the lock while failing.
    }
  }
}

// ── 网关容错重试（2026-08-23）：opencode.ai 对大体量请求间歇 5xx / 超时 / 200 空响应
// 小请求稳定、体量一大就随机翻车（酒馆回合 + 导演分镜同受影响）。重试可吸收瞬时故障。
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** 总尝试次数（= 重试次数 + 1） */
const MAX_ATTEMPTS = 3;
export interface OpenAICompatibleClientOptions {
  /**
   * 单次逻辑调用允许发出的 HTTP 请求总数。生产默认保留三次容错；
   * operational replay 会显式设为 1，使操作者授权的请求次数成为物理硬上限。
   */
  readonly maxAttempts?: number;
}
/** 防止恶意/畸形兼容上游用超大 index 构造稀疏数组拖垮事件循环。 */
const MAX_STREAM_TOOL_CALLS = 128;
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new AbortTurnError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new AbortTurnError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

function isRetryableStatus(code: number): boolean {
  return RETRYABLE_STATUS.has(code);
}

/** 判定「无效空响应」：请求要求产出（正文或工具调用），响应却两者皆空 → 网关/模型静默失败，值得重试 */
function isInvalidEmpty(res: ChatResponse, req: ChatRequest): boolean {
  if (res.content && res.content.trim()) return false;
  if (res.toolCalls.length > 0) return false;
  // 有正文或工具调用都算有产出；仅当两样都没有才视为空失败（后果由上层 safeParse/落库判空）
  return true;
}

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function supportsVisionModel(model: string): boolean {
  const m = model.toLowerCase();
  return [
    'gpt-4o', 'gpt-4.1', 'o3', 'o4', 'vision', 'vl', 'qwen-vl', 'qwen2.5-vl',
    'gemini', 'claude-3', 'claude-4', 'pixtral', 'llama-3.2', 'llava', 'kimi-vl',
  ].some((key) => m.includes(key));
}

function assertVisionReady(req: ChatRequest, model: string): void {
  if (hasImageContent(req.messages) && !supportsVisionModel(model)) {
    throw new OpenAICompatibleError(`当前模型 ${model} 未声明支持图片输入，请在 Provider 面板切换到支持 vision/多模态的模型后重试。`, 400);
  }
}

/** 单次尝试超时：首轮用配置全超时；重试轮缩到 ≤60s，避免失败链把单次调用拖成 N×全超时 */
function attemptTimeoutMs(cfg: ProviderConfig, attempt: number): number {
  return attempt === 0 ? cfg.timeoutMs : Math.min(cfg.timeoutMs, 60_000);
}

export class OpenAICompatibleClient {
  private readonly maxAttempts: number;

  constructor(private cfg: ProviderConfig, options: OpenAICompatibleClientOptions = {}) {
    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
      throw new Error(`maxAttempts must be an integer in 1..${MAX_ATTEMPTS}`);
    }
    this.maxAttempts = maxAttempts;
  }

  private attemptLimit(call?: ChatProviderCall): number {
    const requested = call?.maxTransportAttempts;
    if (requested === undefined) return this.maxAttempts;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new Error('maxTransportAttempts must be a positive integer');
    }
    return Math.min(requested, this.maxAttempts);
  }

  modelName(): string { return this.cfg.model; }
  capabilities(): { readonly stream: true; readonly tools: true } {
    return { stream: true, tools: true };
  }

  private get base(): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/v1`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /** 列出可用模型 */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const timeoutSignal = AbortSignal.timeout(15000);
    const res = await fetch(`${this.base}/models`, {
      method: 'GET',
      headers: this.headers(),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!res.ok) throw new OpenAICompatibleError(`models 请求失败 HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  /** 非流式调用（工具调用首选：一次拿到完整结构化输出；5xx/超时/200空自动重试） */
  async complete(req: ChatRequest, signal?: AbortSignal, call?: ChatProviderCall): Promise<ChatResponse> {
    let lastErr: OpenAICompatibleError | Error | null = null;
    const maxAttempts = this.attemptLimit(call);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new AbortTurnError();
      const payload = injectCacheControl(
        {
          model: req.model ?? this.cfg.model,
          messages: req.messages,
          ...(req.tools?.length ? { tools: req.tools, tool_choice: req.tool_choice ?? 'auto' } : {}),
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          stream: false,
          ...req.extraBody,
        },
        this.cfg.kind,
      );
      assertVisionReady(req, String(payload.model ?? this.cfg.model));
      let res: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs(this.cfg, attempt));
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        });
      } catch (e) {
        if (signal?.aborted) throw new AbortTurnError();
        // 网络层 / 超时：可重试
        lastErr = e as Error;
        if (attempt < maxAttempts - 1) { await sleep(600 * (attempt + 1), signal); continue; }
        throw e;
      }

      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (signal?.aborted) throw new AbortTurnError();
        throw e;
      }
      if (signal?.aborted) throw new AbortTurnError();
      if (!res.ok) {
        const err = new OpenAICompatibleError(`chat/completions 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
        if (isRetryableStatus(res.status) && attempt < maxAttempts - 1) {
          lastErr = err;
          await sleep(600 * (attempt + 1), signal);
          continue;
        }
        throw err;
      }

      let parsed: ChatResponse;
      try {
        parsed = parseChatResponse(JSON.parse(text));
      } catch (e) {
        // 200 但响应体非 JSON（网关截断/异常体）→ 视作空失败重试
        const err = new OpenAICompatibleError(`chat/completions 响应非 JSON: ${text.slice(0, 120)}`, res.status, text);
        if (attempt < maxAttempts - 1) { lastErr = err; await sleep(600 * (attempt + 1), signal); continue; }
        throw err;
      }

      // 200 但「无正文且无工具调用」的空响应 → 重试（静默吞掉会让上层拿空结果）
      if (isInvalidEmpty(parsed, req) && attempt < maxAttempts - 1) {
        lastErr = new OpenAICompatibleError('chat/completions 空响应（无正文且无工具调用），重试', res.status, text);
        await sleep(600 * (attempt + 1), signal);
        continue;
      }
      return parsed;
    }
    throw lastErr ?? new OpenAICompatibleError('chat/completions 请求失败（重试耗尽）');
  }

  /** 流式调用（正文渲染：逐块回调 delta；5xx/超时/200空自动重试，用户中止不重试）
   *  @param onDelta   content 增量（assistant 正文逐字）
   *  @param onToolArg 工具参数增量（function.arguments 分片，用于真流式提取 prose）
   *  @param signal    外部中止信号（用户停止生成；中止时抛 AbortTurnError，调用方落库部分正文）
   */
  async stream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    let lastErr: OpenAICompatibleError | Error | null = null;
    const maxAttempts = this.attemptLimit(call);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new AbortTurnError();
      // 外部取消与超时合并：任一触发即中止（Node 22 AbortSignal.any）；每次尝试重建超时，避免累加过期信号
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs(this.cfg, attempt));
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const model = req.model ?? this.cfg.model;
      assertVisionReady(req, model);

      let res: Response;
      try {
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model,
            messages: req.messages,
            ...(req.tools?.length ? { tools: req.tools } : {}),
            temperature: req.temperature,
            max_tokens: req.max_tokens,
            stream: true,
            ...req.extraBody,
          }),
          signal: combined,
        });
      } catch (e) {
        // 网络层 / 超时中止：先区分用户取消（AbortTurnError）与瞬时故障（可重试）
        if (signal?.aborted) throw new AbortTurnError();
        lastErr = e as Error;
        if (attempt < maxAttempts - 1) { await sleep(600 * (attempt + 1)); continue; }
        throw e;
      }

      if (!res.ok) {
        const text = await res.text();
        const err = new OpenAICompatibleError(`stream 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
        if (isRetryableStatus(res.status) && attempt < maxAttempts - 1) {
          lastErr = err;
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw err;
      }
      if (!res.body) throw new OpenAICompatibleError('响应无 body');

      let content = '';
      let finishReason = '';
      let usage: ChatResponse['usage'] = null;
      const toolCalls: ToolCall[] = [];
      /** 本次尝试已向调用方派发的增量数（决定空响应能否安全重试：已派过增量则不再重试，避免正文重复） */
      let emitted = 0;
      const emitDelta = (c: string): void => { emitted++; onDelta(c); };
      const emitToolArg = (n: string, a: string, delta: ChatToolArgumentDelta): void => {
        emitted++;
        onToolArg?.(n, a, delta);
      };

      try {
        const terminal = await streamSSE(res.body, (json) => {
          const chunk = json as {
            choices?: { delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
            usage?: unknown;
          };
          if (chunk.usage !== undefined && chunk.usage !== null) usage = parseChatUsage(chunk.usage);
          const choice = chunk.choices?.[0];
          if (!choice) return;
          if (signal?.aborted) throw new AbortTurnError();
          if (choice.delta?.content) {
            content += choice.delta.content;
            emitDelta(choice.delta.content);
          }
          if (choice.delta?.tool_calls) {
            for (const value of choice.delta.tool_calls) {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new OpenAICompatibleError('stream tool_calls 增量结构非法');
              }
              const tc = value as Record<string, unknown>;
              const rawIndex = tc.index ?? 0;
              if (!Number.isSafeInteger(rawIndex)
                || (rawIndex as number) < 0
                || (rawIndex as number) >= MAX_STREAM_TOOL_CALLS) {
                throw new OpenAICompatibleError('stream tool_calls index 非法');
              }
              const idx = rawIndex as number;
              const rawId = tc.id;
              const rawFunction = tc.function;
              if (rawId !== undefined && typeof rawId !== 'string') {
                throw new OpenAICompatibleError('stream tool_calls id 非法');
              }
              if (rawFunction !== undefined
                && (!rawFunction || typeof rawFunction !== 'object' || Array.isArray(rawFunction))) {
                throw new OpenAICompatibleError('stream tool_calls function 非法');
              }
              const functionDelta = rawFunction as Record<string, unknown> | undefined;
              const nameDelta = functionDelta?.name;
              const argumentsDelta = functionDelta?.arguments;
              if (nameDelta !== undefined && typeof nameDelta !== 'string') {
                throw new OpenAICompatibleError('stream tool_calls name 非法');
              }
              if (argumentsDelta !== undefined && typeof argumentsDelta !== 'string') {
                throw new OpenAICompatibleError('stream tool_calls arguments 非法');
              }
              toolCalls[idx] = toolCalls[idx] ?? { id: rawId ?? '', name: '', arguments: '' };
              if (rawId) toolCalls[idx].id = rawId;
              if (nameDelta) toolCalls[idx].name += nameDelta;
              if (typeof argumentsDelta === 'string') {
                toolCalls[idx].arguments += argumentsDelta;
              }
              // id、name 和 arguments 可以分别到达；即使当前没有参数文本，也必须
              // 把结构身份交给 Registry sink，避免多工具调用在流中串线。
              if (onToolArg && (
                rawId !== undefined
                || nameDelta !== undefined
                || argumentsDelta !== undefined
              )) {
                emitToolArg(toolCalls[idx].name, argumentsDelta ?? '', {
                  index: idx,
                  ...(rawId ? { id: rawId } : {}),
                  ...(nameDelta ? { nameDelta } : {}),
                });
              }
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }, combined);
        if (signal?.aborted) throw new AbortTurnError();
        if (terminal.malformedData > 0) {
          const err = new OpenAICompatibleError(`stream 含 ${terminal.malformedData} 个损坏 data 块`);
          if (emitted === 0 && attempt < maxAttempts - 1) {
            lastErr = err;
            await sleep(600 * (attempt + 1), signal);
            continue;
          }
          throw err;
        }
        // Some compatible vendors omit [DONE] but still emit finish_reason.
        // A bare EOF with neither marker is truncated and must never be committed.
        if (!terminal.sawDone && !finishReason) {
          const err = new OpenAICompatibleError('stream 在协议终态前中断');
          if (emitted === 0 && attempt < maxAttempts - 1) {
            lastErr = err;
            await sleep(600 * (attempt + 1), signal);
            continue;
          }
          throw err;
        }
      } catch (err) {
        // 外部中止 → AbortTurnError（区别于超时/网络错误）
        if (signal?.aborted) throw new AbortTurnError();
        throw err;
      }

      const result: ChatResponse = {
        content: content || null,
        toolCalls: toolCalls.filter((t) => t.name),
        finishReason,
        usage,
        raw: { streamed: true },
      };
      // 200 空响应（无正文无工具）且本次未派发任何增量 → 静默失败，重试一次
      if (emitted === 0 && isInvalidEmpty(result, req) && attempt < maxAttempts - 1) {
        lastErr = new OpenAICompatibleError('stream 空响应（无正文且无工具调用），重试', res.status);
        await sleep(600 * (attempt + 1), signal);
        continue;
      }
      return result;
    }
    throw lastErr ?? new OpenAICompatibleError('stream 请求失败（重试耗尽）');
  }
}

/** OpenAI 标准工具循环消息（错误召回重试用）：assistant tool_calls + tool 结果 */
export function toolLoopMessages(messages: ChatMessage[], tc: ToolCall, toolResult: string): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }],
    },
    { role: 'tool', tool_call_id: tc.id, content: toolResult },
  ];
}

/** 缓存注入（审查 ADR 4：provider 自适应）
 *  - openai 兼容：不发 cache_control（隐式前缀缓存，靠稳定前缀 ≥1024 tok + 易变内容排尾部）
 *  - anthropic：在 system 末尾 / tools 末尾 / 最后可缓存消息末尾注入 cache_control: ephemeral（≤4 断点）
 */
export function injectCacheControl(body: Record<string, unknown>, kind: 'openai' | 'anthropic'): Record<string, unknown> {
  if (kind !== 'anthropic') return body;
  const system = body['system'];
  if (typeof system === 'string') {
    body['system'] = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1] as Record<string, unknown>;
    if (last && typeof last === 'object' && !last['cache_control']) {
      last['cache_control'] = { type: 'ephemeral' };
    }
  }
  const tools = body['tools'] as Record<string, unknown>[] | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    const lastTool = tools[tools.length - 1] as Record<string, unknown>;
    if (lastTool && typeof lastTool === 'object' && !lastTool['cache_control']) {
      lastTool['cache_control'] = { type: 'ephemeral' };
    }
  }
  return body;
}

function usageInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OpenAICompatibleError(`响应 usage.${field} 非法`);
  }
  return Number(value);
}

function optionalUsageInteger(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : usageInteger(value, field);
}

/** 只复制 usage 白名单；兼容 OpenAI details 与内部扁平字段，绝不把上游任意对象带入业务层。 */
function parseChatUsage(value: unknown): ChatUsage | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAICompatibleError('响应 usage 非法');
  }
  const row = value as Record<string, unknown>;
  const promptDetails = row.prompt_tokens_details;
  const completionDetails = row.completion_tokens_details;
  if (promptDetails !== undefined && (!promptDetails || typeof promptDetails !== 'object' || Array.isArray(promptDetails))) {
    throw new OpenAICompatibleError('响应 usage.prompt_tokens_details 非法');
  }
  if (completionDetails !== undefined && (!completionDetails || typeof completionDetails !== 'object' || Array.isArray(completionDetails))) {
    throw new OpenAICompatibleError('响应 usage.completion_tokens_details 非法');
  }
  const prompt = promptDetails as Record<string, unknown> | undefined;
  const completion = completionDetails as Record<string, unknown> | undefined;
  const cached = optionalUsageInteger(
    row.cached_input_tokens ?? prompt?.cached_tokens,
    'cached_input_tokens',
  );
  const cacheWrite = optionalUsageInteger(
    row.cache_write_tokens ?? prompt?.cache_write_tokens,
    'cache_write_tokens',
  );
  const reasoning = optionalUsageInteger(
    row.reasoning_tokens ?? completion?.reasoning_tokens,
    'reasoning_tokens',
  );
  return {
    prompt_tokens: usageInteger(row.prompt_tokens, 'prompt_tokens'),
    completion_tokens: usageInteger(row.completion_tokens, 'completion_tokens'),
    total_tokens: usageInteger(row.total_tokens, 'total_tokens'),
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
  };
}

function parseChatResponse(json: unknown): ChatResponse {
  const raw = json as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
    usage?: unknown;
  };
  const choice = raw.choices?.[0];
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => ({
    id: tc.id ?? '',
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  }));
  return {
    content: choice?.message?.content ?? null,
    toolCalls,
    finishReason: choice?.finish_reason ?? '',
    usage: parseChatUsage(raw.usage),
    raw,
  };
}
