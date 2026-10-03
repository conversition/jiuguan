/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../../NOTICE.md.
 */

import type {
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ConvertResponsesOptions,
  ResponsesRequest,
} from '../request-types.ts';

interface PendingAssistant {
  content: string | null;
  reasoningContent?: string;
  toolCalls: ChatToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function responsesTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => isRecord(part) ? textValue(part.text || '') : '')
    .join('');
}

function responsesReasoningOf(item: Record<string, unknown>): string {
  if (Array.isArray(item.summary) && item.summary.length) {
    return item.summary
      .map((part) => isRecord(part) ? textValue(part.text || '') : '')
      .join('');
  }
  if (Array.isArray(item.content) && item.content.length) {
    return item.content
      .map((part) => isRecord(part) ? textValue(part.text || '') : '')
      .join('');
  }
  return typeof item.text === 'string' ? item.text : '';
}

function serializedOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const normalized = value === undefined ? '' : value;
  return JSON.stringify(normalized);
}

function convertedTools(value: unknown): ChatRequest['tools'] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const tools = value.filter(isRecord)
    .filter((tool) => tool.type === 'function' || Boolean(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: textValue(tool.name),
        description: textValue(tool.description),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
  return tools.length ? tools : undefined;
}

function convertedToolChoice(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (isRecord(value) && value.name) {
    return { type: 'function', function: { name: value.name } };
  }
  return undefined;
}

export function convertResponsesToChat(
  request: ResponsesRequest,
  options: ConvertResponsesOptions,
): ChatRequest {
  const messages: ChatMessage[] = [];
  if (request.instructions !== undefined && request.instructions !== null) {
    const system = responsesTextOf(request.instructions);
    if (system) messages.push({ role: 'system', content: system });
  }

  let pending: PendingAssistant | undefined;
  const ensurePending = (): PendingAssistant => {
    pending ??= { content: null, toolCalls: [] };
    return pending;
  };
  const flushPending = (): void => {
    if (!pending) return;
    if (pending.content === null && !pending.toolCalls.length) {
      pending = undefined;
      return;
    }
    const message: ChatMessage = {
      role: 'assistant',
      content: pending.content,
    };
    if (pending.reasoningContent) {
      message.reasoning_content = pending.reasoningContent;
    }
    if (pending.toolCalls.length) {
      message.tool_calls = pending.toolCalls;
    }
    messages.push(message);
    pending = undefined;
  };

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!isRecord(item)) continue;
      const type = item.type ?? (item.role ? 'message' : undefined);
      if (type === 'reasoning') {
        const reasoning = responsesReasoningOf(item);
        if (reasoning) ensurePending().reasoningContent = reasoning;
      } else if (type === 'message') {
        const text = responsesTextOf(item.content);
        if (item.role === 'assistant') {
          if (text) ensurePending().content = text;
        } else if (item.role === 'system' || item.role === 'developer') {
          flushPending();
          messages.push({ role: 'system', content: text });
        } else {
          flushPending();
          messages.push({ role: 'user', content: text });
        }
      } else if (type === 'function_call') {
        ensurePending().toolCalls.push({
          id: item.call_id || item.id || options.newCallId(),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: item.arguments || '{}',
          },
        });
      } else if (type === 'function_call_output') {
        flushPending();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content: serializedOutput(item.output),
        });
      } else {
        options.onWarning?.({
          code: 'unknown_responses_input_item',
          itemType: typeof item.type === 'string' ? item.type : undefined,
        });
      }
    }
  }
  flushPending();

  const output: ChatRequest = {
    model: request.model,
    messages,
    stream: request.stream === true,
  };
  const tools = convertedTools(request.tools);
  if (tools) output.tools = tools;
  const toolChoice = convertedToolChoice(request.tool_choice);
  if (toolChoice !== undefined) output.tool_choice = toolChoice;
  if (request.max_output_tokens !== undefined) {
    output.max_tokens = request.max_output_tokens;
  }
  if (request.temperature !== undefined) output.temperature = request.temperature;
  if (request.top_p !== undefined) output.top_p = request.top_p;
  if (request.parallel_tool_calls !== undefined) {
    output.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (isRecord(request.reasoning) && request.reasoning.effort) {
    output.reasoning_effort = request.reasoning.effort;
  }
  return output;
}
