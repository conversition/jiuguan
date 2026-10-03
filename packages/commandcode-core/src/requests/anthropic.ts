/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../../NOTICE.md.
 */

import type {
  AnthropicRequest,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
} from '../request-types.ts';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function systemMessage(value: unknown): ChatMessage | undefined {
  if (typeof value === 'string') {
    return value ? { role: 'system', content: value } : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const blocks = value.filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => {
      const result: Record<string, unknown> = {
        type: 'text',
        text: textValue(block.text),
      };
      if (block.cache_control) result.cache_control = block.cache_control;
      return result;
    });
  const prompt = blocks.map((block) => textValue(block.text)).join('\n');
  if (!prompt) return undefined;
  return {
    role: 'system',
    content: blocks.length ? blocks : prompt,
  };
}

function assistantMessage(
  message: Record<string, unknown>,
  toolNames: Map<string, string>,
): ChatMessage {
  const blocks = Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [{ type: 'text', text: message.content || '' }];
  let textContent = '';
  let thinkingContent = '';
  let textHasCache = false;
  const textParts: Array<Record<string, unknown>> = [];
  const calls: ChatToolCall[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = textValue(block.text);
      textContent += text;
      const part: Record<string, unknown> = { type: 'text', text };
      if (block.cache_control) {
        part.cache_control = block.cache_control;
        textHasCache = true;
      }
      textParts.push(part);
    } else if (block.type === 'thinking') {
      thinkingContent += textValue(block.thinking);
    } else if (block.type === 'tool_use') {
      const id = textValue(block.id);
      const name = textValue(block.name);
      toolNames.set(id, name);
      calls.push({
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const result: ChatMessage = {
    role: 'assistant',
    content: textParts.length > 1 || textHasCache
      ? textParts
      : (textContent || null),
  };
  if (thinkingContent) result.reasoning_content = thinkingContent;
  if (calls.length) result.tool_calls = calls;
  return result;
}

function toolResultContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => isRecord(part) ? textValue(part.text) : '')
      .join('\n');
  }
  return textValue(value || '');
}

function appendUserMessages(
  target: ChatMessage[],
  message: Record<string, unknown>,
  toolNames: Map<string, string>,
): void {
  let textContent = '';
  const parts: Array<Record<string, unknown>> = [];
  let textHasCache = false;
  const toolResults: Array<Record<string, unknown>> = [];

  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = textValue(block.text);
        textContent += text;
        const part: Record<string, unknown> = { type: 'text', text };
        if (block.cache_control) {
          part.cache_control = block.cache_control;
          textHasCache = true;
        }
        parts.push(part);
      } else if (block.type === 'image') {
        const source = isRecord(block.source) ? block.source : {};
        const url = source.type === 'base64' && source.data
          ? `data:${stringValue(source.media_type) || 'image/png'};base64,${String(source.data)}`
          : stringValue(source.url);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_result') {
        toolResults.push(block);
      }
    }
  }

  for (const result of toolResults) {
    const callId = textValue(result.tool_use_id);
    const toolMessage: ChatMessage = {
      role: 'tool',
      tool_call_id: callId,
      content: toolResultContent(result.content),
    };
    const name = toolNames.get(callId);
    if (name) toolMessage.name = name;
    target.push(toolMessage);
  }

  if (parts.length || textContent) {
    const singleText = parts.length <= 1
      && (parts.length === 0 || parts[0]!.type === 'text')
      && !textHasCache;
    target.push({
      role: 'user',
      content: singleText ? textContent : parts,
    });
  }
}

function toolsOf(value: unknown): ChatRequest['tools'] {
  if (!Array.isArray(value) || !value.length) return undefined;
  return value.filter(isRecord).map((tool) => ({
    type: 'function',
    function: {
      name: textValue(tool.name),
      description: stringValue(tool.description),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function toolChoiceOf(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.type === 'auto' || value.type === undefined) return 'auto';
  if (value.type === 'any') return 'required';
  if (value.type === 'tool') {
    return { type: 'function', function: { name: value.name } };
  }
  if (value.type === 'none') return 'none';
  return undefined;
}

function reasoningEffortOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'disabled' || value.type === 'none') return undefined;
  if (value.type === 'adaptive') {
    return stringValue(value.effort) || 'medium';
  }
  if (typeof value.budget_tokens !== 'number' || !Number.isFinite(value.budget_tokens)) {
    return undefined;
  }
  if (value.budget_tokens >= 10_000) return 'high';
  if (value.budget_tokens >= 5_000) return 'medium';
  return 'low';
}

export function convertAnthropicToChat(request: AnthropicRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = systemMessage(request.system);
  if (system) messages.push(system);

  const toolNames = new Map<string, string>();
  if (Array.isArray(request.messages)) {
    for (const rawMessage of request.messages) {
      if (!isRecord(rawMessage)) continue;
      if (rawMessage.role === 'assistant') {
        messages.push(assistantMessage(rawMessage, toolNames));
      } else if (rawMessage.role === 'user') {
        appendUserMessages(messages, rawMessage, toolNames);
      }
    }
  }

  const output: ChatRequest = {
    model: stringValue(request.model) || DEFAULT_MODEL,
    messages,
    max_tokens: typeof request.max_tokens === 'number'
      && Number.isFinite(request.max_tokens)
      && request.max_tokens
      ? request.max_tokens
      : DEFAULT_MAX_TOKENS,
    stream: request.stream === true,
  };

  const tools = toolsOf(request.tools);
  if (tools) output.tools = tools;
  const toolChoice = toolChoiceOf(request.tool_choice);
  if (toolChoice !== undefined) output.tool_choice = toolChoice;
  if (request.temperature !== undefined) output.temperature = request.temperature;
  if (request.top_p !== undefined) output.top_p = request.top_p;
  if (request.stop_sequences) output.stop = request.stop_sequences;
  if (isRecord(request.metadata) && request.metadata.user_id) {
    output.user = request.metadata.user_id;
  }
  const reasoningEffort = reasoningEffortOf(request.thinking);
  if (reasoningEffort) output.reasoning_effort = reasoningEffort;
  return output;
}
