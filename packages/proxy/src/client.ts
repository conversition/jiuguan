/**
 * proxy 包 - OpenAI 兼容客户端（chat/completions + SSE 流式 + tools）
 * 端点：{baseUrl}/v1/chat/completions；支持非流式（工具调用首选）与流式（正文渲染）。
 */
import type { ProviderConfig } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** 部分网关要求（Anthropic 转换层） */
  type?: string;
}

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

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  /** 原始响应（调试） */
  raw: unknown;
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

/** SSE 流式解析：逐行读 response.body，回调 data 块 */
export async function streamSSE(body: ReadableStream<Uint8Array>, onData: (json: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onData(JSON.parse(payload));
      } catch { /* 忽略无法解析的块 */ }
    }
  }
}

// ── 网关容错重试（2026-08-23）：opencode.ai 对大体量请求间歇 5xx / 超时 / 200 空响应
// 小请求稳定、体量一大就随机翻车（酒馆回合 + 导演分镜同受影响）。重试可吸收瞬时故障。
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** 总尝试次数（= 重试次数 + 1） */
const MAX_ATTEMPTS = 3;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** 单次尝试超时：首轮用配置全超时；重试轮缩到 ≤60s，避免失败链把单次调用拖成 N×全超时 */
function attemptTimeoutMs(cfg: ProviderConfig, attempt: number): number {
  return attempt === 0 ? cfg.timeoutMs : Math.min(cfg.timeoutMs, 60_000);
}

export class OpenAICompatibleClient {
  constructor(private cfg: ProviderConfig) {}

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
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.base}/models`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new OpenAICompatibleError(`models 请求失败 HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  /** 非流式调用（工具调用首选：一次拿到完整结构化输出；5xx/超时/200空自动重试） */
  async complete(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: OpenAICompatibleError | Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
      let res: Response;
      try {
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(attemptTimeoutMs(this.cfg, attempt)),
        });
      } catch (e) {
        // 网络层 / 超时：可重试
        lastErr = e as Error;
        if (attempt < MAX_ATTEMPTS - 1) { await sleep(600 * (attempt + 1)); continue; }
        throw e;
      }

      const text = await res.text();
      if (!res.ok) {
        const err = new OpenAICompatibleError(`chat/completions 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
          lastErr = err;
          await sleep(600 * (attempt + 1));
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
        if (attempt < MAX_ATTEMPTS - 1) { lastErr = err; await sleep(600 * (attempt + 1)); continue; }
        throw err;
      }

      // 200 但「无正文且无工具调用」的空响应 → 重试（静默吞掉会让上层拿空结果）
      if (isInvalidEmpty(parsed, req) && attempt < MAX_ATTEMPTS - 1) {
        lastErr = new OpenAICompatibleError('chat/completions 空响应（无正文且无工具调用），重试', res.status, text);
        await sleep(600 * (attempt + 1));
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
    onToolArg?: (name: string, argsDelta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    let lastErr: OpenAICompatibleError | Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new AbortTurnError();
      // 外部取消与超时合并：任一触发即中止（Node 22 AbortSignal.any）；每次尝试重建超时，避免累加过期信号
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs(this.cfg, attempt));
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let res: Response;
      try {
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: req.model ?? this.cfg.model,
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
        if (attempt < MAX_ATTEMPTS - 1) { await sleep(600 * (attempt + 1)); continue; }
        throw e;
      }

      if (!res.ok) {
        const text = await res.text();
        const err = new OpenAICompatibleError(`stream 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
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
      const emitToolArg = (n: string, a: string): void => { emitted++; onToolArg?.(n, a); };

      try {
        await streamSSE(res.body, (json) => {
          const chunk = json as {
            choices?: { delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          const choice = chunk.choices?.[0];
          if (!choice) return;
          if (signal?.aborted) throw new AbortTurnError();
          if (choice.delta?.content) {
            content += choice.delta.content;
            emitDelta(choice.delta.content);
          }
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
              const idx = tc.index ?? 0;
              toolCalls[idx] = toolCalls[idx] ?? { id: tc.id ?? '', name: '', arguments: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name += tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[idx].arguments += tc.function.arguments;
                if (onToolArg && toolCalls[idx].name) emitToolArg(toolCalls[idx].name, tc.function.arguments);
              }
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        });
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
      if (emitted === 0 && isInvalidEmpty(result, req) && attempt < MAX_ATTEMPTS - 1) {
        lastErr = new OpenAICompatibleError('stream 空响应（无正文且无工具调用），重试', res.status);
        await sleep(600 * (attempt + 1));
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

function parseChatResponse(json: unknown): ChatResponse {
  const raw = json as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
    usage: raw.usage ?? null,
    raw,
  };
}
