/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

import type { CommandCodeCompletionDecision } from './response-types.ts';
import type { MappedCommandCodeError } from './types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function ownValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function cloneJsonData(
  value: unknown,
  ancestors: Set<object>,
): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (
    value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt values are not JSON serializable');
  }

  if (ancestors.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array<unknown>(value.length);
      Object.defineProperty(clone, 'toJSON', {
        value: undefined,
        configurable: true,
      });
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        Object.defineProperty(clone, String(index), {
          value: descriptor && 'value' in descriptor
            ? cloneJsonData(descriptor.value, ancestors)
            : undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return clone;
    }

    const clone = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      if (key === 'toJSON' && typeof descriptor.value === 'function') continue;
      Object.defineProperty(clone, key, {
        value: cloneJsonData(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(cloneJsonData(value, new Set()));
}

function ssePayload(value: unknown): string {
  const serialized = safeJsonStringify(value);
  if (serialized === undefined) {
    throw new TypeError('SSE payload must be JSON serializable');
  }
  return serialized;
}

export function toolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  const serializable = value === null || value === undefined ? {} : value;
  return safeJsonStringify(serializable) ?? '';
}

export function dataSse(value: unknown): string {
  return `data: ${ssePayload(value)}\n\n`;
}

export function namedSse(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${ssePayload(value)}\n\n`;
}

export function cloneMappedError(
  error: MappedCommandCodeError | null,
): MappedCommandCodeError | null {
  if (!error) return null;
  return {
    ...error,
    body: {
      ...error.body,
      error: { ...error.body.error },
    },
  };
}

export function cloneDecision(
  decision: CommandCodeCompletionDecision,
): CommandCodeCompletionDecision {
  if (decision.kind === 'success') return { kind: 'success' };
  return {
    kind: decision.kind,
    error: cloneMappedError(decision.error)!,
  };
}

export function emptyStreamError(): MappedCommandCodeError {
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
