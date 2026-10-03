/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

import { incompleteUpstreamDetail, incompleteUpstreamError } from './finish-reasons.ts';
import type {
  CommandCodeCompletionDecision,
  CommandCodeEmptyPolicy,
  CommandCodeResponseState,
} from './response-types.ts';
import { usageToken } from './usage.ts';

function emptyResponseError() {
  return {
    status: 429,
    body: {
      error: {
        message: 'Empty response from upstream (zero output tokens)',
        type: 'rate_limit_error',
      },
      retry_after: 10,
    },
    retry_after: 10,
  };
}

/**
 * Preserve the endpoint terminal priority: event error, incomplete stream,
 * empty response, then success.
 */
export function classifyCommandCodeCompletion(
  state: CommandCodeResponseState,
  emptyPolicy: CommandCodeEmptyPolicy,
): CommandCodeCompletionDecision {
  if (state.upstreamError) {
    return { kind: 'upstream_error', error: state.upstreamError };
  }
  const incomplete = incompleteUpstreamDetail(
    state.sawFinish,
    state.finishReason,
  );
  if (incomplete) {
    return { kind: 'incomplete', error: incompleteUpstreamError(incomplete) };
  }
  const empty = emptyPolicy === 'usage'
    ? (usageToken(state.usage, 'outputTokens') ?? 0) === 0
    : !(state.fullText || state.reasoningText || state.toolCalls.length);
  if (empty) return { kind: 'empty', error: emptyResponseError() };
  return { kind: 'success' };
}
