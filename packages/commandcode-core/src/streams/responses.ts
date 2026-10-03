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
} from '../finish-reasons.ts';
import { parseCommandCodeNdjsonLine } from '../ndjson.ts';
import type { CommandCodeCompletionDecision } from '../response-types.ts';
import { buildResponsesUsage } from '../responses.ts';
import type {
  CommandCodeResponsesSseTranslatorOptions,
  CommandCodeStreamFinalization,
  CommandCodeStreamSnapshot,
} from '../stream-types.ts';
import {
  cloneDecision,
  cloneMappedError,
  emptyStreamError,
  isRecord,
  namedSse,
  ownValue,
  stringValue,
  toolArguments,
} from '../stream-utils.ts';
import type { CommandCodeUsage, MappedCommandCodeError } from '../types.ts';
import { normalizeUsage, sanitizeUsage, usageToken } from '../usage.ts';

const SILENT_EVENT_TYPES = new Set([
  'start',
  'start-step',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'finish-step',
  'provider-metadata',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-error',
]);

type ResponsesItemKind = 'message' | 'reasoning' | 'function_call';

interface CurrentResponsesItem {
  kind: ResponsesItemKind;
  index: number;
  item: Record<string, unknown>;
  textBuffer: string;
}

export class CommandCodeResponsesSseTranslator {
  private readonly responseId: string;
  private readonly model: string;
  private readonly created: number;
  private readonly newId: CommandCodeResponsesSseTranslatorOptions['newId'];
  private readonly onWarning:
    CommandCodeResponsesSseTranslatorOptions['onWarning'];
  private sequence = 0;
  private responseStarted = false;
  private current: CurrentResponsesItem | null = null;
  private outputIndex = 0;
  private readonly doneItems: Array<Record<string, unknown>> = [];
  private usage: CommandCodeUsage | null = null;
  private outputText = '';
  private finishReason: string | null = null;
  private sawFinish = false;
  private finalFinishSeen = false;
  private lastEvent = '';
  private upstreamError: MappedCommandCodeError | null = null;
  private transportFailure = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private emittedFrameCount = 0;
  private finalized = false;
  private finalization: CommandCodeStreamFinalization | null = null;

  constructor(options: CommandCodeResponsesSseTranslatorOptions) {
    this.responseId = options.responseId;
    this.model = options.model;
    this.created = options.created;
    this.newId = options.newId;
    this.onWarning = options.onWarning;
  }

  pushLine(line: string): string[] {
    this.assertOpen();
    if (this.upstreamError) return [];
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
    const frames: string[] = [];

    if (eventType === 'text-delta') {
      const text = stringValue(
        ownValue(value, 'text') || ownValue(value, 'delta') || '',
      );
      if (!text) {
        this.lastEvent = eventType;
        return [];
      }
      const messageId = !this.current || this.current.kind !== 'message'
        ? this.allocateId('msg_')
        : null;
      frames.push(...this.startResponse());
      if (!this.current || this.current.kind !== 'message') {
        frames.push(...this.openItem('message', {
          type: 'message',
          id: messageId!,
          status: 'in_progress',
          role: 'assistant',
          content: [],
        }));
      }
      const current = this.current!;
      current.textBuffer += text;
      this.outputText += text;
      frames.push(this.sse('response.output_text.delta', {
        item_id: current.item.id,
        output_index: current.index,
        content_index: 0,
        delta: text,
        logprobs: [],
      }));
    } else if (eventType === 'reasoning-delta') {
      const text = stringValue(ownValue(value, 'text') || '');
      if (!text) {
        this.lastEvent = eventType;
        return [];
      }
      const reasoningId = !this.current || this.current.kind !== 'reasoning'
        ? this.allocateId('rs_')
        : null;
      frames.push(...this.startResponse());
      if (!this.current || this.current.kind !== 'reasoning') {
        frames.push(...this.openItem('reasoning', {
          type: 'reasoning',
          id: reasoningId!,
          summary: [],
          status: 'in_progress',
        }));
      }
      const current = this.current!;
      current.textBuffer += text;
      frames.push(this.sse('response.reasoning_summary_text.delta', {
        item_id: current.item.id,
        output_index: current.index,
        summary_index: 0,
        delta: text,
      }));
    } else if (eventType === 'tool-call') {
      const rawCallId = ownValue(value, 'toolCallId');
      const callId = rawCallId
        ? stringValue(rawCallId)
        : this.allocateId('call_');
      const args = toolArguments(ownValue(value, 'input'));
      const itemId = this.allocateId('fc_');
      const toolName = stringValue(ownValue(value, 'toolName') || '');
      frames.push(...this.startResponse());
      frames.push(...this.openItem('function_call', {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: toolName,
        arguments: '',
        status: 'in_progress',
      }));
      const current = this.current!;
      current.item.arguments = args;
      frames.push(this.sse('response.function_call_arguments.delta', {
        item_id: current.item.id,
        output_index: current.index,
        delta: args,
      }));
    } else if (eventType === 'finish') {
      this.finalFinishSeen = true;
      this.sawFinish = true;
      const rawReason = ownValue(value, 'finishReason');
      this.finishReason = rawReason ? mapFinishReason(rawReason) : null;
      this.applyUsage(
        ownValue(value, 'totalUsage') || ownValue(value, 'usage'),
      );
    } else if (eventType === 'error') {
      this.upstreamError = mapCcEventError(value);
    } else if (!SILENT_EVENT_TYPES.has(eventType)) {
      this.onWarning?.({
        code: 'unknown_commandcode_event',
        eventType,
      });
    }

    this.lastEvent = eventType;
    this.record(frames);
    return frames;
  }

  transportError(message: string): string[] {
    this.assertOpen();
    if (this.upstreamError) return [];
    const safeMessage = typeof message === 'string' && message
      ? message.slice(0, 2_000)
      : 'Upstream error';
    const frame = this.sse('error', {
      code: null,
      message: safeMessage,
      param: null,
    });
    this.transportFailure = true;
    this.upstreamError = {
      status: 502,
      body: {
        error: {
          message: safeMessage,
          type: 'upstream_error',
        },
      },
    };
    return this.record([frame]);
  }

  finalize(): CommandCodeStreamFinalization {
    if (this.finalization) return this.copyFinalization(this.finalization);
    const hadOutputBeforeFinalize = this.responseStarted
      || this.transportFailure;
    const frames: string[] = [];
    let decision: CommandCodeCompletionDecision;

    if (this.upstreamError) {
      decision = { kind: 'upstream_error', error: this.upstreamError };
      if (this.responseStarted && !this.transportFailure) {
        frames.push(...this.closeItem());
        frames.push(...this.failureFrames(this.upstreamError.body.error.message));
      }
    } else {
      const incomplete = incompleteUpstreamDetail(
        this.sawFinish,
        this.finishReason,
      );
      if (incomplete) {
        const error = incompleteUpstreamError(incomplete);
        decision = { kind: 'incomplete', error };
        if (this.responseStarted) {
          frames.push(...this.closeItem());
          frames.push(...this.failureFrames(error.body.error.message));
        }
      } else if (!this.responseStarted) {
        const error = emptyStreamError();
        decision = { kind: 'empty', error };
      } else {
        decision = { kind: 'success' };
        frames.push(...this.closeItem());
        const truncated = this.finishReason === 'length';
        const paused = this.finishReason === 'pause_turn';
        const status = truncated || paused ? 'incomplete' : 'completed';
        frames.push(this.sse(`response.${status}`, {
          response: {
            ...this.baseResponse(status, [...this.doneItems]),
            output_text: this.outputText,
            incomplete_details: truncated
              ? { reason: 'max_output_tokens' }
              : paused
                ? { reason: 'pause_turn' }
                : null,
            usage: buildResponsesUsage(this.usage, this.outputTokens),
          },
        }));
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

  private startResponse(): string[] {
    if (this.responseStarted) return [];
    this.responseStarted = true;
    return [
      this.sse('response.created', {
        response: this.baseResponse('in_progress'),
      }),
      this.sse('response.in_progress', {
        response: this.baseResponse('in_progress'),
      }),
    ];
  }

  private openItem(
    kind: ResponsesItemKind,
    item: Record<string, unknown>,
  ): string[] {
    const frames = this.closeItem();
    this.current = {
      kind,
      index: this.outputIndex++,
      item,
      textBuffer: '',
    };
    frames.push(this.sse('response.output_item.added', {
      output_index: this.current.index,
      item,
    }));
    if (kind === 'message') {
      frames.push(this.sse('response.content_part.added', {
        item_id: item.id,
        output_index: this.current.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    } else if (kind === 'reasoning') {
      frames.push(this.sse('response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: this.current.index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    return frames;
  }

  private closeItem(): string[] {
    if (!this.current) return [];
    const current = this.current;
    const item = current.item;
    const frames: string[] = [];
    if (current.kind === 'message') {
      frames.push(this.sse('response.output_text.done', {
        item_id: item.id,
        output_index: current.index,
        content_index: 0,
        text: current.textBuffer,
        logprobs: [],
      }));
      frames.push(this.sse('response.content_part.done', {
        item_id: item.id,
        output_index: current.index,
        content_index: 0,
        part: {
          type: 'output_text',
          text: current.textBuffer,
          annotations: [],
        },
      }));
      item.content = [{
        type: 'output_text',
        text: current.textBuffer,
        annotations: [],
      }];
      item.status = 'completed';
    } else if (current.kind === 'function_call') {
      frames.push(this.sse('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: current.index,
        arguments: item.arguments,
      }));
      item.status = 'completed';
    } else {
      frames.push(this.sse('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: current.index,
        summary_index: 0,
        text: current.textBuffer,
      }));
      frames.push(this.sse('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: current.index,
        summary_index: 0,
        part: { type: 'summary_text', text: current.textBuffer },
      }));
      item.summary = [{ type: 'summary_text', text: current.textBuffer }];
      item.status = 'completed';
    }
    frames.push(this.sse('response.output_item.done', {
      output_index: current.index,
      item,
    }));
    this.doneItems.push(item);
    this.current = null;
    return frames;
  }

  private failureFrames(message: string): string[] {
    return [this.sse('response.failed', {
      response: {
        ...this.baseResponse('failed', [...this.doneItems]),
        output_text: this.outputText,
        error: { code: 'upstream_error', message },
      },
    })];
  }

  private baseResponse(
    status: string,
    output: Array<Record<string, unknown>> = [],
  ): Record<string, unknown> {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.created,
      status,
      output,
      output_text: '',
      model: this.model,
      error: null,
      incomplete_details: null,
      parallel_tool_calls: true,
      previous_response_id: null,
      store: false,
      tools: [],
      metadata: {},
    };
  }

  private sse(type: string, data: Record<string, unknown>): string {
    const sequence = this.sequence;
    const frame = namedSse(type, {
      type,
      sequence_number: sequence,
      ...data,
    });
    this.sequence++;
    return frame;
  }

  private applyUsage(value: unknown): void {
    const sanitized = sanitizeUsage(value);
    if (!sanitized) return;
    const usage = normalizeUsage(sanitized);
    this.usage = usage;
    this.inputTokens = usageToken(usage, 'inputTokens') ?? 0;
    this.outputTokens = usageToken(usage, 'outputTokens') ?? 0;
    this.cachedInputTokens = usageToken(usage, 'cachedInputTokens') ?? 0;
  }

  private allocateId(prefix: Parameters<
    CommandCodeResponsesSseTranslatorOptions['newId']
  >[0]): string {
    const id = this.newId(prefix);
    if (typeof id !== 'string' || !id) {
      throw new TypeError(`newId(${prefix}) must return a non-empty string`);
    }
    return id;
  }

  private record(frames: string[]): string[] {
    this.emittedFrameCount += frames.length;
    return frames;
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error('CommandCode Responses SSE translator is already finalized');
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
