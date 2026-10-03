/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

export type CommandCodeNdjsonLineResult =
  | {
      kind: 'event';
      event: Record<string, unknown>;
    }
  | {
      kind: 'ignored';
      reason: 'blank' | 'comment' | 'done' | 'missing-type';
    }
  | {
      kind: 'malformed';
    };

export interface CommandCodeNdjsonDecoderOptions {
  mode: 'text' | 'bytes';
  maxBufferedChars: number;
}

export class CommandCodeNdjsonOverflowError extends Error {
  readonly code = 'COMMANDCODE_NDJSON_BUFFER_LIMIT';

  constructor(readonly maxBufferedChars: number) {
    super(`CommandCode NDJSON line exceeds ${maxBufferedChars} buffered characters`);
    this.name = 'CommandCodeNdjsonOverflowError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function parseCommandCodeNdjsonLine(
  line: string,
): CommandCodeNdjsonLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored', reason: 'blank' };
  if (trimmed === '[DONE]') return { kind: 'ignored', reason: 'done' };
  if (trimmed.startsWith(':')) return { kind: 'ignored', reason: 'comment' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'ignored', reason: 'missing-type' };
  }
  const type = ownValue(parsed, 'type');
  if (typeof type !== 'string' || !type) {
    return { kind: 'ignored', reason: 'missing-type' };
  }
  return { kind: 'event', event: parsed };
}

/**
 * Split arbitrary chunks into NDJSON lines. One instance accepts exactly one
 * input mode, preventing a text chunk from overtaking bytes held by
 * TextDecoder. finish() consumes a final line without a trailing newline.
 */
export class CommandCodeNdjsonDecoder {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly mode: CommandCodeNdjsonDecoderOptions['mode'];
  private readonly maxBufferedChars: number;
  private finished = false;

  constructor(options: CommandCodeNdjsonDecoderOptions) {
    if (options.mode !== 'text' && options.mode !== 'bytes') {
      throw new TypeError('mode must be text or bytes');
    }
    if (!Number.isInteger(options.maxBufferedChars) || options.maxBufferedChars <= 0) {
      throw new RangeError('maxBufferedChars must be a positive integer');
    }
    this.mode = options.mode;
    this.maxBufferedChars = options.maxBufferedChars;
  }

  pushText(chunk: string): CommandCodeNdjsonLineResult[] {
    this.assertOpen('text');
    return this.consumeText(chunk);
  }

  pushBytes(chunk: Uint8Array): CommandCodeNdjsonLineResult[] {
    this.assertOpen('bytes');
    return this.consumeText(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): CommandCodeNdjsonLineResult[] {
    if (this.finished) return [];
    this.finished = true;
    const results = this.mode === 'bytes'
      ? this.consumeText(this.decoder.decode())
      : [];
    if (!this.buffer) return results;
    const finalLine = this.buffer;
    this.buffer = '';
    results.push(parseCommandCodeNdjsonLine(finalLine));
    return results;
  }

  private assertOpen(expectedMode: CommandCodeNdjsonDecoderOptions['mode']): void {
    if (this.finished) {
      throw new Error('CommandCode NDJSON decoder is already finished');
    }
    if (this.mode !== expectedMode) {
      throw new TypeError(
        `CommandCode NDJSON decoder mode is ${this.mode}, not ${expectedMode}`,
      );
    }
  }

  private consumeText(text: string): CommandCodeNdjsonLineResult[] {
    const combined = this.buffer + text;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';
    if (
      remainder.length > this.maxBufferedChars
      || lines.some((line) => line.length > this.maxBufferedChars)
    ) {
      this.finished = true;
      this.buffer = '';
      throw new CommandCodeNdjsonOverflowError(this.maxBufferedChars);
    }
    this.buffer = remainder;
    return lines.map(parseCommandCodeNdjsonLine);
  }
}
