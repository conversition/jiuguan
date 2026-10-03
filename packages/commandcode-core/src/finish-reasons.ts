/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */
import type { MappedCommandCodeError } from './types.ts';

/** Normalize upstream terminal reasons without pretending truncated output is complete. */
export function mapFinishReason(reason: unknown): string {
  const normalized = String(reason ?? '').trim().toLowerCase();
  if (!normalized) return 'stop';
  if (
    normalized === 'tool-calls'
    || normalized === 'tool_calls'
    || normalized === 'tool_use'
  ) {
    return 'tool_calls';
  }
  if (
    normalized === 'length'
    || normalized === 'max_tokens'
    || normalized === 'max_output_tokens'
    || normalized === 'model_context_window_exceeded'
  ) {
    return 'length';
  }
  if (/^(?:network|connection|upstream)[-_\s]?error$/.test(normalized)) {
    return 'upstream_error';
  }
  return normalized;
}

export function incompleteUpstreamDetail(
  sawFinish: boolean,
  finishReason: string | null | undefined,
): string | null {
  if (!sawFinish) return 'no finish event';
  if (finishReason === 'upstream_error') {
    return 'provider reported an upstream connection failure';
  }
  return null;
}

export function incompleteUpstreamError(detail: string): MappedCommandCodeError {
  return {
    status: 502,
    body: {
      error: {
        message:
          `Upstream stream ended without a completion finish (${detail}) — response was truncated`,
        type: 'upstream_error',
      },
      retry_after: 10,
    },
    retry_after: 10,
  };
}

export function mapAnthropicStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    case 'pause_turn': return 'pause_turn';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

/** OpenAI has no pause_turn value; length is the truthful incomplete equivalent. */
export function toOpenAIFinishReason(finishReason: string): string {
  return finishReason === 'pause_turn' ? 'length' : finishReason;
}
