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
  mapAnthropicStopReason,
  mapFinishReason,
} from '../finish-reasons.ts';
import { parseCommandCodeNdjsonLine } from '../ndjson.ts';
import type { CommandCodeCompletionDecision } from '../response-types.ts';
import type {
  CommandCodeAnthropicSseTranslatorOptions,
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
import type { MappedCommandCodeError } from '../types.ts';
import {
  anthropicInputTokens,
  normalizeUsage,
  sanitizeUsage,
  usageDetailToken,
  usageToken,
} from '../usage.ts';

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

type AnthropicBlockType = 'text' | 'thinking';

export class CommandCodeAnthropicSseTranslator {
  private readonly messageId: string;
  private readonly model: string;
  private readonly newToolCallId: () => string;
  private readonly thinkingSignature: (thinkingText: string) => string;
  private readonly onWarning:
    CommandCodeAnthropicSseTranslatorOptions['onWarning'];
  private started = false;
  private nextBlockIndex = 0;
  private currentBlockIndex = -1;
  private currentBlockType: AnthropicBlockType | null = null;
  private blockStarted = false;
  private currentThinkingText = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private cacheWriteTokens = 0;
  private noCacheTokens: number | undefined;
  private finishReason: string | null = null;
  private sawFinish = false;
  private finalFinishSeen = false;
  private sawOutputEvent = false;
  private hasError = false;
  private upstreamError: MappedCommandCodeError | null = null;
  private lastEvent = '';
  private emittedFrameCount = 0;
  private finalized = false;
  private finalization: CommandCodeStreamFinalization | null = null;

  constructor(options: CommandCodeAnthropicSseTranslatorOptions) {
    this.messageId = options.messageId;
    this.model = options.model;
    this.newToolCallId = options.newToolCallId;
    this.thinkingSignature = options.thinkingSignature;
    this.onWarning = options.onWarning;
  }

  start(): string[] {
    this.assertOpen();
    if (this.started) return [];
    const frame = namedSse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.started = true;
    return this.record([frame]);
  }

  pushLine(line: string): string[] {
    this.assertOpen();
    const parsed = parseCommandCodeNdjsonLine(line);
    return parsed.kind === 'event' ? this.pushEvent(parsed.event) : [];
  }

  pushEvent(value: unknown): string[] {
    this.assertOpen();
    if (this.hasError) return this.start();
    if (!isRecord(value)) return this.start();
    const rawType = ownValue(value, 'type');
    if (typeof rawType !== 'string' || !rawType) return this.start();
    const eventType = rawType;
    if (this.finalFinishSeen && eventType !== 'error') return this.start();

    let preparedTool: {
      id: string;
      name: string;
      input: string;
    } | null = null;
    if (eventType === 'tool-call') {
      const rawId = ownValue(value, 'toolCallId');
      const id = rawId ? stringValue(rawId) : this.newToolCallId();
      if (typeof id !== 'string' || !id) {
        throw new TypeError('newToolCallId must return a non-empty string');
      }
      preparedTool = {
        id,
        name: stringValue(ownValue(value, 'toolName') || ''),
        input: toolArguments(ownValue(value, 'input')),
      };
    } else if (
      eventType !== 'reasoning-delta'
      && eventType !== 'text-delta'
      && eventType !== 'finish-step'
      && eventType !== 'finish'
      && eventType !== 'error'
      && !SILENT_EVENT_TYPES.has(eventType)
    ) {
      this.onWarning?.({
        code: 'unknown_commandcode_event',
        eventType,
      });
    }

    const frames = this.start();
    const eventFrames: string[] = [];

    if (eventType === 'reasoning-delta') {
      const text = stringValue(ownValue(value, 'text') || '');
      if (text) {
        eventFrames.push(...this.startBlock('thinking', {
          type: 'thinking',
          thinking: '',
        }));
        eventFrames.push(namedSse('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: { type: 'thinking_delta', thinking: text },
        }));
        this.currentThinkingText += text;
        this.sawOutputEvent = true;
      }
    } else if (eventType === 'text-delta') {
      const text = stringValue(ownValue(value, 'text') || '');
      if (text) {
        eventFrames.push(...this.startBlock('text', {
          type: 'text',
          text: '',
        }));
        eventFrames.push(namedSse('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: { type: 'text_delta', text },
        }));
        this.sawOutputEvent = true;
        this.outputTokens += 1;
      }
    } else if (eventType === 'tool-call') {
      const tool = preparedTool!;
      const toolIndex = this.nextBlockIndex;
      const toolFrames = [
        namedSse('content_block_start', {
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: {},
          },
        }),
        namedSse('content_block_delta', {
          type: 'content_block_delta',
          index: toolIndex,
          delta: { type: 'input_json_delta', partial_json: tool.input },
        }),
        namedSse('content_block_stop', {
          type: 'content_block_stop',
          index: toolIndex,
        }),
      ];
      eventFrames.push(...this.closeBlock(), ...toolFrames);
      this.nextBlockIndex++;
      this.sawOutputEvent = true;
      this.outputTokens += 20;
    } else if (eventType === 'finish-step' || eventType === 'finish') {
      if (eventType === 'finish') this.finalFinishSeen = true;
      this.sawFinish = true;
      const rawReason = ownValue(value, 'finishReason');
      if (rawReason) this.finishReason = mapFinishReason(rawReason);
      const usage = ownValue(value, 'totalUsage') || ownValue(value, 'usage');
      this.applyUsage(usage);
    } else if (eventType === 'error') {
      const upstreamError = mapCcEventError(value);
      const errorFrame = namedSse('error', {
        type: 'error',
        error: upstreamError.body.error,
      });
      this.hasError = true;
      this.upstreamError = upstreamError;
      eventFrames.push(errorFrame);
    }

    this.lastEvent = eventType;
    this.record(eventFrames);
    return [...frames, ...eventFrames];
  }

  finalize(): CommandCodeStreamFinalization {
    if (this.finalization) return this.copyFinalization(this.finalization);
    const hadOutputBeforeFinalize = this.sawOutputEvent || this.hasError;
    const frames = this.start();
    const tail: string[] = [];
    let decision: CommandCodeCompletionDecision;

    if (this.hasError && this.upstreamError) {
      decision = { kind: 'upstream_error', error: this.upstreamError };
    } else {
      tail.push(...this.closeBlock());
      const incomplete = incompleteUpstreamDetail(
        this.sawFinish,
        this.finishReason,
      );
      if (incomplete) {
        const error = incompleteUpstreamError(incomplete);
        decision = { kind: 'incomplete', error };
        tail.push(namedSse('error', {
          type: 'error',
          error: error.body.error,
        }));
      } else if (this.outputTokens === 0) {
        const error = emptyStreamError();
        decision = { kind: 'empty', error };
        tail.push(namedSse('error', {
          type: 'error',
          error: error.body.error,
          retry_after: 10,
        }));
      } else {
        decision = { kind: 'success' };
        tail.push(
          namedSse('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: mapAnthropicStopReason(
                this.finishReason || 'stop',
              ),
            },
            usage: {
              output_tokens: this.outputTokens,
              cache_read_input_tokens: this.cachedInputTokens,
              cache_creation_input_tokens: this.cacheWriteTokens,
              input_tokens: anthropicInputTokens(
                {
                  inputTokens: this.inputTokens,
                  cachedInputTokens: this.cachedInputTokens,
                  inputTokenDetails: {
                    cacheWriteTokens: this.cacheWriteTokens,
                  },
                },
                this.noCacheTokens,
              ),
            },
          }),
          namedSse('message_stop', { type: 'message_stop' }),
        );
      }
    }

    this.finalized = true;
    this.record(tail);
    const allFrames = [...frames, ...tail];
    this.finalization = {
      decision: cloneDecision(decision),
      frames: [...allFrames],
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

  private startBlock(
    type: AnthropicBlockType,
    contentBlock: Record<string, unknown>,
  ): string[] {
    if (this.blockStarted && this.currentBlockType === type) return [];
    const index = this.nextBlockIndex;
    const startFrame = namedSse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    });
    const frames = this.closeBlock();
    this.currentBlockIndex = index;
    this.nextBlockIndex = index + 1;
    this.currentBlockType = type;
    this.blockStarted = true;
    frames.push(startFrame);
    return frames;
  }

  private closeBlock(): string[] {
    if (!this.blockStarted) return [];
    const index = this.currentBlockIndex;
    const type = this.currentBlockType;
    const frames: string[] = [];
    if (type === 'thinking') {
      const signature = this.thinkingSignature(this.currentThinkingText);
      if (typeof signature !== 'string') {
        throw new TypeError('thinkingSignature must return a string');
      }
      frames.push(namedSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'signature_delta',
          signature,
        },
      }));
    }
    frames.push(namedSse('content_block_stop', {
      type: 'content_block_stop',
      index,
    }));
    if (type === 'thinking') this.currentThinkingText = '';
    this.blockStarted = false;
    this.currentBlockType = null;
    return frames;
  }

  private applyUsage(value: unknown): void {
    const sanitized = sanitizeUsage(value);
    if (!sanitized) return;
    const usage = normalizeUsage(sanitized);
    const input = usageToken(usage, 'inputTokens');
    const output = usageToken(usage, 'outputTokens');
    const cached = usageToken(usage, 'cachedInputTokens');
    const cacheWrite = usageDetailToken(usage, 'cacheWriteTokens');
    const noCache = usageDetailToken(usage, 'noCacheTokens');
    if (input !== undefined) this.inputTokens = input;
    if (output !== undefined) this.outputTokens = output;
    if (cached !== undefined) this.cachedInputTokens = cached;
    if (cacheWrite !== undefined) this.cacheWriteTokens = cacheWrite;
    if (noCache !== undefined) this.noCacheTokens = noCache;
  }

  private record(frames: string[]): string[] {
    this.emittedFrameCount += frames.length;
    return frames;
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error('CommandCode Anthropic SSE translator is already finalized');
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
