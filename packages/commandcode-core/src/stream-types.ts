import type { CommandCodeCompletionDecision } from './response-types.ts';
import type { MappedCommandCodeError } from './types.ts';

export interface CommandCodeStreamFinalization {
  decision: CommandCodeCompletionDecision;
  frames: string[];
  hadOutputBeforeFinalize: boolean;
}

export interface CommandCodeStreamSnapshot {
  lastEvent: string;
  sawFinish: boolean;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  upstreamError: MappedCommandCodeError | null;
  emittedFrameCount: number;
  finalized: boolean;
}

export interface CommandCodeChatSseTranslatorOptions {
  id: string;
  model: string;
  created: number;
  newToolCallId: () => string;
  onWarning?: (warning: {
    code: 'unknown_commandcode_event';
    eventType: string;
  }) => void;
}

export interface CommandCodeAnthropicSseTranslatorOptions {
  messageId: string;
  model: string;
  newToolCallId: () => string;
  thinkingSignature: (thinkingText: string) => string;
  onWarning?: (warning: {
    code: 'unknown_commandcode_event';
    eventType: string;
  }) => void;
}

export type ResponsesStreamIdPrefix = 'rs_' | 'msg_' | 'fc_' | 'call_';

export interface CommandCodeResponsesSseTranslatorOptions {
  responseId: string;
  model: string;
  created: number;
  newId: (prefix: ResponsesStreamIdPrefix) => string;
  onWarning?: (warning: {
    code: 'unknown_commandcode_event';
    eventType: string;
  }) => void;
}
