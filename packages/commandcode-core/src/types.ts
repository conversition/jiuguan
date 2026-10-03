export interface CommandCodeInputTokenDetails {
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  [key: string]: unknown;
}

export interface CommandCodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: CommandCodeInputTokenDetails;
  [key: string]: unknown;
}

export interface CommandCodeEventErrorDetail {
  message?: string;
  code?: string | null;
  statusCode?: number;
}

export interface CommandCodeErrorEvent {
  error?: CommandCodeEventErrorDetail;
  message?: string;
  code?: string | null;
}

export interface PublicProtocolError {
  message: string;
  type: string;
  code?: string;
}

export interface PublicProtocolErrorBody {
  error: PublicProtocolError;
  retry_after?: number;
}

export interface MappedCommandCodeError {
  status: number;
  code?: string | null;
  reportedStatus?: number | null;
  body: PublicProtocolErrorBody;
  retry_after?: number;
}
