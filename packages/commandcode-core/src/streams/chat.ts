/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../../NOTICE.md.
 */

import { mapCcEventError } from '../errors.ts';
import {
  incompleteUpstreamDetail,
  incompleteUpstreamError,
  mapFinishReason,
  toOpenAIFinishReason,
} from '../finish-reasons.ts';
import { parseCommandCodeNdjsonLine } from '../ndjson.ts';
import type { CommandCodeCompletionDecision } from '../response-types.ts';
import type {
  CommandCodeChatSseTranslatorOptions,
  CommandCodeStreamFinalization,
  CommandCodeStreamSnapshot,
} from '../stream-types.ts';
import {
  cloneDecision,
  cloneMappedError,
  dataSse,
  emptyStreamError,
  isRecord,
  ownValue,
  stringValue,
  toolArguments,
} from '../stream-utils.ts';
import type { MappedCommandCodeError, CommandCodeUsage } from '../types.ts';
import { normalizeUsage, sanitizeUsage, usageToken } from '../usage.ts';

const SILENT_EVENT_TYPES = new Set([
  'start',
  'start-step',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'provider-metadata',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-error',
]);

function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): string {
  return dataSse({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
}

function openAiUsage(usage: CommandCodeUsage): Record<string, unknown> {
  const input = usageToken(usage, 'inputTokens') ?? 0;
  const output = usageToken(usage, 'outputTokens') ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: {
      cached_tokens: usageToken(usage, 'cachedInputTokens') ?? 0,
    },
  };
}

export class CommandCodeChatSseTranslator {
  private readonly id: string;
  private readonly model: string;
  private readonly created: number;
  private readonly newToolCallId: () => string;
  private readonly onWarning: CommandCodeChatSseTranslatorOptions['onWarning'];
  private lastEvent = '';
  private sawFinish = false;
  private finishReason: string | null = null;
  private usage: CommandCodeUsage | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private upstreamError: MappedCommandCodeError | null = null;
  private chunkIndex = 0;
  private toolCallIndex = 0;
  private finalFinishSeen = false;
  private emittedFrameCount = 0;
  private finalized = false;
  private finalization: CommandCodeStreamFinalization | null = null;

  constructor(options: CommandCodeChatSseTranslatorOptions) {
    this.id = options.id;
    this.model = options.model;
    this.created = options.created;
    this.newToolCallId = options.newToolCallId;
    this.onWarning = options.onWarning;
  }

  pushLine(line: string): string[] {
    this.assertOpen();
    const parsed = parseCommandCodeNdjsonLine(line);
    return parsed.kind === 'event' ? this.pushEvent(parsed.event) : [];
  }

  pushEvent(value: unknown): string[] {
    this.assertOpen();
    if (this.upstreamError) return [];
    if (!isRecord(value)) return [];
    const rawType = ownValue(value, 'type');
    if (typeof rawType !== 'string' || !rawType) return [];
    const eventType = rawType;
    if (this.finalFinishSeen && eventType !== 'error') return [];

    if (eventType === 'text-delta') {
      const text = stringValue(
        ownValue(value, 'text') || ownValue(value, 'delta') || '',
      );
      if (!text) {
        this.lastEvent = eventType;
        return [];
      }
      const delta = this.chunkIndex === 0
        ? { role: 'assistant', content: text }
        : { content: text };
      const frame = chunk(this.id, this.created, this.model, delta, null);
      this.chunkIndex++;
      this.lastEvent = eventType;
      return this.record([frame]);
    }

    if (eventType === 'reasoning-delta') {
      const text = stringValue(ownValue(value, 'text') || '');
      if (!text) {
        this.lastEvent = eventType;
        return [];
      }
      const delta = this.chunkIndex === 0
        ? { role: 'assistant', reasoning_content: text }
        : { reasoning_content: text };
      const frame = chunk(this.id, this.created, this.model, delta, null);
      this.chunkIndex++;
      this.lastEvent = eventType;
      return this.record([frame]);
    }

    if (eventType === 'tool-call') {
      const rawId = ownValue(value, 'toolCallId');
      const id = rawId ? stringValue(rawId) : this.newToolCallId();
      if (typeof id !== 'string' || !id) {
        throw new TypeError('newToolCallId must return a non-empty string');
      }
      const name = stringValue(ownValue(value, 'toolName') || '');
      const args = toolArguments(ownValue(value, 'input'));
      const entry = {
        index: this.toolCallIndex,
        id,
        type: 'function',
        function: {
          name,
          arguments: args,
        },
      };
      const delta = this.chunkIndex === 0
        ? { role: 'assistant', content: null, tool_calls: [entry] }
        : { tool_calls: [entry] };
      const frame = chunk(this.id, this.created, this.model, delta, null);
      this.toolCallIndex++;
      this.chunkIndex++;
      this.lastEvent = eventType;
      return this.record([frame]);
    }

    if (eventType === 'finish-step') {
      this.lastEvent = eventType;
      this.sawFinish = true;
      const rawReason = ownValue(value, 'finishReason');
      if (rawReason) this.finishReason = mapFinishReason(rawReason);
      this.applyUsage(ownValue(value, 'usage'), false);
      return [];
    }

    if (eventType === 'finish') {
      this.lastEvent = eventType;
      this.finalFinishSeen = true;
      this.sawFinish = true;
      this.finishReason = mapFinishReason(
        ownValue(value, 'finishReason') || 'stop',
      );
      const totalUsage = ownValue(value, 'totalUsage');
      const selectedUsage = totalUsage || this.usage || {};
      const normalized = normalizeUsage(
        sanitizeUsage(selectedUsage) ?? {},
      );
      this.setUsage(normalized);
      return [];
    }

    if (eventType === 'error') {
      this.upstreamError = mapCcEventError(value);
      this.lastEvent = eventType;
      return [];
    }

    if (!SILENT_EVENT_TYPES.has(eventType)) {
      this.onWarning?.({
        code: 'unknown_commandcode_event',
        eventType,
      });
    }
    this.lastEvent = eventType;
    return [];
  }

  finalize(): CommandCodeStreamFinalization {
    if (this.finalization) return this.copyFinalization(this.finalization);
    const hadOutputBeforeFinalize = this.chunkIndex > 0;

    let decision: CommandCodeCompletionDecision;
    let frames: string[];
    if (this.upstreamError) {
      decision = { kind: 'upstream_error', error: this.upstreamError };
      frames = [dataSse(this.upstreamError.body)];
    } else {
      const incomplete = incompleteUpstreamDetail(
        this.sawFinish,
        this.finishReason,
      );
      if (incomplete) {
        const error = incompleteUpstreamError(incomplete);
        decision = { kind: 'incomplete', error };
        frames = [dataSse(error.body)];
      } else if (this.outputTokens === 0) {
        const error = emptyStreamError();
        decision = { kind: 'empty', error };
        frames = [dataSse(error.body)];
      } else {
        decision = { kind: 'success' };
        const normalized = normalizeUsage(this.usage ?? {});
        frames = [
          chunk(
            this.id,
            this.created,
            this.model,
            {},
            toOpenAIFinishReason(this.finishReason || 'stop'),
            openAiUsage(normalized),
          ),
          'data: [DONE]\n\n',
        ];
      }
    }

    this.finalized = true;
    this.record(frames);
    this.finalization = {
      decision: cloneDecision(decision),
      frames: [...frames],
      hadOutputBeforeFinalize,
    };
    return this.copyFinalization(this.finalization);
  }

  snapshot(): CommandCodeStreamSnapshot {
    return {
      lastEvent: this.lastEvent,
      sawFinish: this.sawFinish,
      finishReason: this.finishReason,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      upstreamError: cloneMappedError(this.upstreamError),
      emittedFrameCount: this.emittedFrameCount,
      finalized: this.finalized,
    };
  }

  private applyUsage(value: unknown, normalize: boolean): void {
    const sanitized = sanitizeUsage(value);
    if (!sanitized) return;
    this.setUsage(normalize ? normalizeUsage(sanitized) : sanitized);
  }

  private setUsage(usage: CommandCodeUsage): void {
    this.usage = sanitizeUsage(usage);
    this.inputTokens = usageToken(usage, 'inputTokens') ?? 0;
    this.outputTokens = usageToken(usage, 'outputTokens') ?? 0;
    this.cachedInputTokens = usageToken(usage, 'cachedInputTokens') ?? 0;
  }

  private record(frames: string[]): string[] {
    this.emittedFrameCount += frames.length;
    return frames;
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error('CommandCode Chat SSE translator is already finalized');
    }
  }

  private copyFinalization(
    finalization: CommandCodeStreamFinalization,
  ): CommandCodeStreamFinalization {
    return {
      decision: cloneDecision(finalization.decision),
      frames: [...finalization.frames],
      hadOutputBeforeFinalize: finalization.hadOutputBeforeFinalize,
    };
  }
}
