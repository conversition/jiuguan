/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */
import type {
  CommandCodeErrorEvent,
  MappedCommandCodeError,
  PublicProtocolError,
} from './types.ts';

interface StatusMapping {
  status: number;
  type: string;
}

const CC_STATUS_MAP: ReadonlyMap<number, StatusMapping> = new Map([
  [400, { status: 400, type: 'invalid_request_error' }],
  [401, { status: 401, type: 'authentication_error' }],
  [402, { status: 429, type: 'rate_limit_error' }],
  [403, { status: 401, type: 'authentication_error' }],
  [404, { status: 404, type: 'not_found' }],
  [422, { status: 400, type: 'invalid_request_error' }],
  [429, { status: 429, type: 'rate_limit_error' }],
  [500, { status: 502, type: 'upstream_error' }],
  [502, { status: 502, type: 'upstream_error' }],
  [503, { status: 503, type: 'temporarily_unavailable' }],
]);

const ERROR_MESSAGE_LIMIT = 2_000;
const ERROR_CODE_LIMIT = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, limit);
}

function httpStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : null;
}

function publicError(message: string, type: string, code: string | null): PublicProtocolError {
  return { message, type, ...(code ? { code } : {}) };
}

export function mapCcError(
  ccStatus: number,
  ccBody?: string | null,
): MappedCommandCodeError {
  const mapped = CC_STATUS_MAP.get(ccStatus) ?? {
    status: 502,
    type: 'upstream_error',
  };
  let message = `CC API error (${ccStatus})`;
  let code: string | null = null;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody) as unknown;
      const root = isRecord(parsed) ? parsed : {};
      const rootError = ownValue(root, 'error');
      const nested = isRecord(rootError) ? rootError : {};
      message = boundedString(ownValue(nested, 'message'), ERROR_MESSAGE_LIMIT)
        ?? boundedString(ownValue(root, 'message'), ERROR_MESSAGE_LIMIT)
        ?? message;
      code = boundedString(ownValue(nested, 'code'), ERROR_CODE_LIMIT)
        ?? boundedString(ownValue(root, 'code'), ERROR_CODE_LIMIT);
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  if (ccStatus === 429) {
    return {
      status: 429,
      code,
      body: {
        error: publicError(message, 'rate_limit_error', code),
        retry_after: 30,
      },
    };
  }

  return {
    status: mapped.status,
    code,
    body: { error: publicError(message, mapped.type, code) },
  };
}

export function mapCcEventError(event: CommandCodeErrorEvent): MappedCommandCodeError {
  const root = isRecord(event) ? event : {};
  const rootError = ownValue(root, 'error');
  const nested = isRecord(rootError) ? rootError : {};
  const message = boundedString(ownValue(nested, 'message'), ERROR_MESSAGE_LIMIT)
    ?? boundedString(ownValue(root, 'message'), ERROR_MESSAGE_LIMIT)
    ?? 'Unknown CC error';
  const code = boundedString(ownValue(nested, 'code'), ERROR_CODE_LIMIT)
    ?? boundedString(ownValue(root, 'code'), ERROR_CODE_LIMIT);
  const statusMatch = message.match(/^<(\d{3})>/);
  const reportedStatus = statusMatch
    ? httpStatus(Number(statusMatch[1]))
    : httpStatus(ownValue(nested, 'statusCode'));
  const ccStatus = reportedStatus ?? 502;
  const mapped = CC_STATUS_MAP.get(ccStatus) ?? {
    status: 502,
    type: 'upstream_error',
  };

  if (mapped.status === 429) {
    return {
      status: 429,
      code,
      reportedStatus,
      body: {
        error: publicError(message, 'rate_limit_error', code),
        retry_after: 30,
      },
    };
  }

  return {
    status: mapped.status,
    code,
    reportedStatus,
    body: { error: publicError(message, mapped.type, code) },
  };
}

export function summarizeUpstreamError(text: unknown, limit = 500): string {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit
    ? `${flat.slice(0, limit)}…(${flat.length - limit} more)`
    : flat;
}
