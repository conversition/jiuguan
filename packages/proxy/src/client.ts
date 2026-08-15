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

  /** 非流式调用（工具调用首选：一次拿到完整结构化输出） */
  async complete(req: ChatRequest): Promise<ChatResponse> {
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
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new OpenAICompatibleError(`chat/completions 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
    }
    return parseChatResponse(JSON.parse(text));
  }

  /** 流式调用（正文渲染：逐块回调 delta） */
  async stream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
  ): Promise<ChatResponse> {
    const res = await fetch(`${this.base}/chat/completions`, {
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
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new OpenAICompatibleError(`stream 失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
    }
    if (!res.body) throw new OpenAICompatibleError('响应无 body');

    let content = '';
    let finishReason = '';
    let usage: ChatResponse['usage'] = null;
    const toolCalls: ToolCall[] = [];

    await streamSSE(res.body, (json) => {
      const chunk = json as {
        choices?: { delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.delta?.content) {
        content += choice.delta.content;
        onDelta(choice.delta.content);
      }
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
          const idx = tc.index ?? 0;
          toolCalls[idx] = toolCalls[idx] ?? { id: tc.id ?? '', name: '', arguments: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    });

    return {
      content: content || null,
      toolCalls: toolCalls.filter((t) => t.name),
      finishReason,
      usage,
      raw: { streamed: true },
    };
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
