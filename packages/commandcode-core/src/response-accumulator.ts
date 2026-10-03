/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

import { mapCcEventError } from './errors.ts';
import { incompleteUpstreamDetail, mapFinishReason } from './finish-reasons.ts';
import { parseCommandCodeNdjsonLine } from './ndjson.ts';
import type {
  CommandCodeResponseState,
  CommandCodeToolCall,
  CreateCommandCodeAccumulatorOptions,
} from './response-types.ts';
import type { CommandCodeUsage } from './types.ts';
import { sanitizeUsage } from './usage.ts';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function copyToolCall(call: CommandCodeToolCall): CommandCodeToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  };
}

export class CommandCodeResponseAccumulator {
  private lastEvent = '';
  private fullText = '';
  private reasoningText = '';
  private readonly toolCalls: CommandCodeToolCall[] = [];
  private finishReason = 'stop';
  private sawFinish = false;
  private usage: CommandCodeUsage | null = null;
  private upstreamError: CommandCodeResponseState['upstreamError'] = null;
  private readonly newToolCallId: () => string;
  private readonly usagePolicy: CreateCommandCodeAccumulatorOptions['usagePolicy'];
  private readonly onWarning: CreateCommandCodeAccumulatorOptions['onWarning'];

  constructor(options: CreateCommandCodeAccumulatorOptions) {
    this.newToolCallId = options.newToolCallId;
    this.usagePolicy = options.usagePolicy;
    this.onWarning = options.onWarning;
  }

  pushLine(line: string): void {
    const parsed = parseCommandCodeNdjsonLine(line);
    if (parsed.kind === 'event') this.pushEvent(parsed.event);
  }

  pushEvent(value: unknown): void {
    if (!isRecord(value)) return;
    const rawEventType = ownValue(value, 'type');
    if (typeof rawEventType !== 'string' || !rawEventType) return;
    const eventType = rawEventType;

    if (eventType === 'text-delta') {
      this.lastEvent = eventType;
      this.fullText += stringValue(ownValue(value, 'text') || '');
      return;
    }
    if (eventType === 'reasoning-delta') {
      this.lastEvent = eventType;
      this.reasoningText += stringValue(ownValue(value, 'text') || '');
      return;
    }
    if (eventType === 'tool-call') {
      this.lastEvent = eventType;
      const input = ownValue(value, 'input');
      const rawArguments = typeof input === 'string'
        ? input
        : JSON.stringify(input || {});
      const toolCallId = ownValue(value, 'toolCallId');
      this.toolCalls.push({
        id: toolCallId
          ? stringValue(toolCallId)
          : this.newToolCallId(),
        type: 'function',
        function: {
          name: stringValue(ownValue(value, 'toolName') || ''),
          arguments: rawArguments ?? '',
        },
      });
      return;
    }
    if (eventType === 'finish-step' || eventType === 'finish') {
      this.lastEvent = eventType;
      this.sawFinish = true;
      this.finishReason = mapFinishReason(
        ownValue(value, 'finishReason') || 'stop',
      );
      const usageValue = this.usagePolicy === 'total-only'
        ? ownValue(value, 'totalUsage')
        : ownValue(value, 'totalUsage') || ownValue(value, 'usage');
      const eventUsage = sanitizeUsage(usageValue);
      if (eventUsage) this.usage = eventUsage;
      return;
    }
    if (eventType === 'error') {
      this.lastEvent = eventType;
      this.upstreamError = mapCcEventError(value);
      return;
    }
    if (!SILENT_EVENT_TYPES.has(eventType)) {
      this.onWarning?.({
        code: 'unknown_commandcode_event',
        eventType,
      });
    }
  }

  snapshot(): CommandCodeResponseState {
    return {
      lastEvent: this.lastEvent,
      fullText: this.fullText,
      reasoningText: this.reasoningText,
      toolCalls: this.toolCalls.map(copyToolCall),
      finishReason: this.finishReason,
      sawFinish: this.sawFinish,
      usage: sanitizeUsage(this.usage),
      upstreamError: this.upstreamError
        ? {
            ...this.upstreamError,
            body: {
              ...this.upstreamError.body,
              error: { ...this.upstreamError.body.error },
            },
          }
        : null,
    };
  }

  incompleteDetail(): string | null {
    return incompleteUpstreamDetail(this.sawFinish, this.finishReason);
  }

  hasContent(): boolean {
    return Boolean(this.fullText || this.reasoningText || this.toolCalls.length);
  }
}
