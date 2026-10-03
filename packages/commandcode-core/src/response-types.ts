import type { MappedCommandCodeError, CommandCodeUsage } from './types.ts';

export interface CommandCodeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface CommandCodeResponseState {
  lastEvent: string;
  fullText: string;
  reasoningText: string;
  toolCalls: CommandCodeToolCall[];
  finishReason: string;
  sawFinish: boolean;
  usage: CommandCodeUsage | null;
  upstreamError: MappedCommandCodeError | null;
}

export type CommandCodeEmptyPolicy = 'usage' | 'content';

export type CommandCodeCompletionDecision =
  | { kind: 'success' }
  | { kind: 'upstream_error'; error: MappedCommandCodeError }
  | { kind: 'incomplete'; error: MappedCommandCodeError }
  | { kind: 'empty'; error: MappedCommandCodeError };

export interface ResponseConversionWarning {
  code: 'unknown_commandcode_event';
  eventType: string;
}

export interface CreateCommandCodeAccumulatorOptions {
  newToolCallId: () => string;
  usagePolicy: 'total-only' | 'total-or-event';
  onWarning?: (warning: ResponseConversionWarning) => void;
}

export interface BuildChatCompletionOptions {
  id: string;
  model: string;
  created: number;
}

export interface BuildAnthropicResponseOptions {
  messageId: string;
  model: string;
  thinkingSignature: (thinkingText: string) => string;
}

export interface BuildResponsesObjectOptions {
  responseId: string;
  model: string;
  createdAt: number;
  completedAt: number;
  newId: (prefix: 'rs_' | 'msg_' | 'fc_') => string;
  input?: unknown;
  instructions?: unknown;
  maxOutputTokens?: unknown;
  reasoning?: unknown;
  temperature?: unknown;
  toolChoice?: unknown;
  tools?: unknown;
  topP?: unknown;
}
