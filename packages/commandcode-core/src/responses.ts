/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

import {
  mapAnthropicStopReason,
  toOpenAIFinishReason,
} from './finish-reasons.ts';
import type {
  BuildAnthropicResponseOptions,
  BuildChatCompletionOptions,
  BuildResponsesObjectOptions,
  CommandCodeResponseState,
  CommandCodeToolCall,
} from './response-types.ts';
import type { CommandCodeUsage } from './types.ts';
import {
  anthropicInputTokens,
  normalizeUsage,
  usageDetailToken,
  usageToken,
} from './usage.ts';

function parsedToolInput(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return {};
  }
}

function wireToolCalls(toolCalls: CommandCodeToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  }));
}

function openAiUsage(usage: CommandCodeUsage | null): Record<string, unknown> {
  const normalized = normalizeUsage(usage);
  const input = usageToken(normalized, 'inputTokens') ?? 0;
  const output = usageToken(normalized, 'outputTokens') ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: {
      cached_tokens: usageToken(normalized, 'cachedInputTokens') ?? 0,
    },
  };
}

export function buildOpenAIChatCompletion(
  state: CommandCodeResponseState,
  options: BuildChatCompletionOptions,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: state.fullText || null,
  };
  if (state.toolCalls.length) {
    message.tool_calls = wireToolCalls(state.toolCalls);
  }
  if (state.reasoningText) {
    message.reasoning_content = state.reasoningText;
  }
  return {
    id: options.id,
    object: 'chat.completion',
    created: options.created,
    model: options.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toOpenAIFinishReason(state.finishReason),
    }],
    usage: openAiUsage(state.usage),
  };
}

export function buildAnthropicResponse(
  state: CommandCodeResponseState,
  options: BuildAnthropicResponseOptions,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (state.reasoningText) {
    content.push({
      type: 'thinking',
      thinking: state.reasoningText,
      signature: options.thinkingSignature(state.reasoningText),
    });
  }
  if (state.fullText) {
    content.push({ type: 'text', text: state.fullText });
  }
  for (const call of state.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parsedToolInput(call.function.arguments),
    });
  }

  const usage = normalizeUsage(state.usage);
  const estimatedOutput = Math.max(
    1,
    Math.ceil((state.fullText.length + state.reasoningText.length) / 4)
      + state.toolCalls.length * 20,
  );
  return {
    id: options.messageId,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content,
    stop_reason: mapAnthropicStopReason(state.finishReason || 'stop'),
    stop_sequence: null,
    usage: {
      input_tokens: anthropicInputTokens(usage),
      output_tokens: usageToken(usage, 'outputTokens') || estimatedOutput,
      cache_creation_input_tokens: usageDetailToken(
        usage,
        'cacheWriteTokens',
      ) ?? 0,
      cache_read_input_tokens:
        usageToken(usage, 'cachedInputTokens') ?? 0,
    },
  };
}

export function buildResponsesUsage(
  usage: CommandCodeUsage | null,
  fallbackOutputTokens = 0,
): Record<string, unknown> {
  const normalized = normalizeUsage(usage);
  const input = usageToken(normalized, 'inputTokens') || 0;
  const output = usageToken(normalized, 'outputTokens')
    || fallbackOutputTokens
    || 0;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: usageToken(normalized, 'cachedInputTokens') || 0,
      cache_write_tokens:
        usageDetailToken(normalized, 'cacheWriteTokens') || 0,
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

export function buildResponsesOutput(
  state: CommandCodeResponseState,
  newId: BuildResponsesObjectOptions['newId'],
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (state.reasoningText) {
    output.push({
      type: 'reasoning',
      id: newId('rs_'),
      summary: [{ type: 'summary_text', text: state.reasoningText }],
    });
  }
  if (state.fullText) {
    output.push({
      type: 'message',
      id: newId('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: state.fullText,
        annotations: [],
      }],
    });
  }
  for (const call of state.toolCalls) {
    output.push({
      type: 'function_call',
      id: newId('fc_'),
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }
  return output;
}

export function buildResponsesObject(
  state: CommandCodeResponseState,
  options: BuildResponsesObjectOptions,
): Record<string, unknown> {
  const truncated = state.finishReason === 'length';
  const paused = state.finishReason === 'pause_turn';
  return {
    id: options.responseId,
    object: 'response',
    created_at: options.createdAt,
    status: truncated || paused ? 'incomplete' : 'completed',
    completed_at: options.completedAt,
    error: null,
    incomplete_details: truncated
      ? { reason: 'max_output_tokens' }
      : paused
        ? { reason: 'pause_turn' }
        : null,
    input: options.input || [],
    instructions: options.instructions === undefined
      ? null
      : options.instructions,
    max_output_tokens: options.maxOutputTokens === undefined
      ? null
      : options.maxOutputTokens,
    model: options.model,
    output: buildResponsesOutput(state, options.newId),
    output_text: state.fullText || '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: options.reasoning || null,
    store: false,
    temperature: options.temperature === undefined ? 1 : options.temperature,
    text: { format: { type: 'text' } },
    tool_choice: options.toolChoice || 'auto',
    tools: options.tools || [],
    top_p: options.topP === undefined ? 1 : options.topP,
    truncation: 'disabled',
    usage: buildResponsesUsage(state.usage, 0),
    user: null,
    metadata: {},
  };
}
