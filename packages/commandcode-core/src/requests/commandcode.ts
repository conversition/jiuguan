/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../../NOTICE.md.
 */

import type {
  BuildCommandCodeRequestOptions,
  ChatMessage,
  ChatRequest,
  CommandCodeTextBlock,
  CommandCodeWireRequest,
} from '../request-types.ts';
import { toWireToolName, toWireToolOutputValue, tryParseJson } from '../tools.ts';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 64_000;
const MAX_TOKENS = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function contentParts(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toolCalls(message: ChatMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord)
    : [];
}

function requestMessages(request: ChatRequest): ChatMessage[] {
  return Array.isArray(request.messages)
    ? request.messages.filter(isRecord) as ChatMessage[]
    : [];
}

function requestMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(value, MAX_TOKENS);
}

function systemBlocksOf(messages: ChatMessage[]): CommandCodeTextBlock[] {
  const blocks: CommandCodeTextBlock[] = [];
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'developer') continue;
    if (typeof message.content === 'string') {
      if (message.content) blocks.push({ type: 'text', text: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        if (!isRecord(rawPart)) continue;
        const rawText = rawPart.text ?? rawPart.content ?? '';
        const hasCacheControl = Boolean(rawPart.cache_control);
        if (rawText === '' && !hasCacheControl) continue;
        const block: CommandCodeTextBlock = {
          type: 'text',
          text: String(rawText),
        };
        if (hasCacheControl) block.cache_control = rawPart.cache_control;
        blocks.push(block);
      }
      continue;
    }
    if (message.content !== null && message.content !== undefined) {
      blocks.push({ type: 'text', text: String(message.content) });
    }
  }
  for (let index = 0; index < blocks.length - 1; index++) {
    blocks[index]!.text += '\n';
  }
  return blocks;
}

function toolNameLookup(messages: ChatMessage[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of toolCalls(message)) {
      if (!call.id) continue;
      const fn = isRecord(call.function) ? call.function : {};
      result.set(String(call.id), stringValue(fn.name));
    }
  }
  return result;
}

function userMessage(message: ChatMessage): Record<string, unknown> {
  if (typeof message.content === 'string') {
    return {
      role: 'user',
      content: [{ type: 'text', text: message.content }],
    };
  }
  if (Array.isArray(message.content)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const rawPart of message.content) {
      if (!rawPart) continue;
      if (!isRecord(rawPart)) {
        parts.push({ type: 'text', text: String(rawPart) });
        continue;
      }
      if (rawPart.type !== 'image_url') {
        parts.push({ ...rawPart });
        continue;
      }
      const imageUrl = isRecord(rawPart.image_url) ? rawPart.image_url : {};
      const url = stringValue(imageUrl.url);
      const mediaType = /^data:([^;,]+)/.exec(url)?.[1];
      const imagePart: Record<string, unknown> = { type: 'image', image: url };
      if (mediaType) imagePart.mimeType = mediaType;
      parts.push(imagePart);
    }
    return { role: 'user', content: parts };
  }
  return {
    role: 'user',
    content: [{ type: 'text', text: String(message.content) }],
  };
}

function assistantMessage(message: ChatMessage): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  if (message.reasoning_content) {
    parts.push({ type: 'reasoning', text: String(message.reasoning_content) });
  }
  if (typeof message.content === 'string') {
    if (message.content) parts.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const rawPart of message.content) {
      if (!isRecord(rawPart)) continue;
      if (rawPart.type === 'text') {
        parts.push({ ...rawPart });
      } else if (rawPart.type === 'reasoning' && !message.reasoning_content) {
        parts.push({ ...rawPart });
      }
    }
  }
  for (const call of toolCalls(message)) {
    const fn = isRecord(call.function) ? call.function : {};
    const args = fn.arguments;
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: stringValue(fn.name),
      input: typeof args === 'string' ? tryParseJson(args) : (args || {}),
    });
  }
  return { role: 'assistant', content: parts };
}

function toolMessage(
  message: ChatMessage,
  toolNames: Map<string, string>,
): Record<string, unknown> {
  const callId = stringValue(message.tool_call_id);
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: message.tool_call_id,
      toolName: toolNames.get(callId) || stringValue(message.name),
      output: { type: 'text', value: toWireToolOutputValue(message.content) },
    }],
  };
}

function wireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const chatMessages = messages.filter(
    (message) => message.role !== 'system' && message.role !== 'developer',
  );
  const toolNames = toolNameLookup(chatMessages);
  return chatMessages.map((message) => {
    if (message.role === 'user') return userMessage(message);
    if (message.role === 'assistant') return assistantMessage(message);
    if (message.role === 'tool') return toolMessage(message, toolNames);
    return {
      role: 'user',
      content: [{ type: 'text', text: String(message.content ?? '') }],
    };
  });
}

function wireTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((tool) => {
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(fn.name) || stringValue(tool.name);
    return {
      name: toWireToolName(name),
      description: stringValue(fn.description) || stringValue(tool.description),
      input_schema: fn.parameters
        || tool.input_schema
        || { type: 'object', properties: {} },
    };
  });
}

function wireToolChoice(value: unknown): unknown {
  if (typeof value === 'string') {
    const aliases = new Map<string, string>([
      ['auto', 'auto'],
      ['none', 'none'],
      ['required', 'any'],
    ]);
    return { type: aliases.get(value) ?? 'auto' };
  }
  if (!isRecord(value)) return undefined;
  if (value.type === 'function') {
    const fn = isRecord(value.function) ? value.function : {};
    return { type: 'tool', name: fn.name };
  }
  return value;
}

export function buildCommandCodeRequest(
  request: ChatRequest,
  options: BuildCommandCodeRequestOptions,
): CommandCodeWireRequest {
  const messages = requestMessages(request);
  const system = systemBlocksOf(messages);
  const convertedMessages = wireMessages(messages);
  const hasCacheMarker = system.some((block) => Boolean(block.cache_control))
    || convertedMessages.some((message) => (
      contentParts(message.content).some(
        (part) => isRecord(part) && Boolean(part.cache_control),
      )
    ));
  if (request.prompt_cache_key && !hasCacheMarker && system.length) {
    system[system.length - 1]!.cache_control = { type: 'ephemeral' };
  }

  const body: CommandCodeWireRequest = {
    config: {
      workingDir: options.deviceProfile.projectDir,
      date: options.date,
      environment: options.deviceProfile.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    mode: options.cliMode || 'agent',
    params: {
      model: stringValue(request.model) || DEFAULT_MODEL,
      messages: convertedMessages,
      max_tokens: requestMaxTokens(request.max_tokens),
      stream: true,
      tools: wireTools(request.tools),
    },
  };

  if (system.length) {
    body.params.system = system;
  } else if (options.emptySystemPlaceholder !== false) {
    body.params.system = [{ type: 'text', text: ' ' }];
  }
  if (request.temperature !== undefined) {
    body.params.temperature = request.temperature;
  }
  if (request.reasoning_effort !== undefined) {
    body.params.reasoning_effort = request.reasoning_effort;
  }
  if (request.tool_choice !== undefined && request.tool_choice !== null) {
    body.params.tool_choice = wireToolChoice(request.tool_choice);
  }
  if (request.parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = request.parallel_tool_calls;
  }
  return body;
}
