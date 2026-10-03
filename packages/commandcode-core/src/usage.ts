/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */
import type {
  CommandCodeInputTokenDetails,
  CommandCodeUsage,
} from './types.ts';

type UsageTokenKey = 'inputTokens' | 'outputTokens' | 'cachedInputTokens';
type UsageDetailKey = 'noCacheTokens' | 'cacheReadTokens' | 'cacheWriteTokens';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function setOwn(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function usageToken(
  usage: CommandCodeUsage | null | undefined,
  key: UsageTokenKey,
): number | undefined {
  if (!isRecord(usage)) return undefined;
  return nonNegativeFiniteNumber(ownValue(usage, key));
}

export function usageDetailToken(
  usage: CommandCodeUsage | null | undefined,
  key: UsageDetailKey,
): number | undefined {
  if (!isRecord(usage)) return undefined;
  const details = ownValue(usage, 'inputTokenDetails');
  if (!isRecord(details)) return undefined;
  return nonNegativeFiniteNumber(ownValue(details, key));
}

export function sanitizeUsage(value: unknown): CommandCodeUsage | null {
  if (!isRecord(value)) return null;
  const usage: CommandCodeUsage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
  ] as const) {
    const token = nonNegativeFiniteNumber(ownValue(value, key));
    if (token !== undefined) setOwn(usage, key, token);
  }

  const rawDetails = ownValue(value, 'inputTokenDetails');
  if (isRecord(rawDetails)) {
    const details: CommandCodeInputTokenDetails = {};
    for (const key of [
      'noCacheTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const) {
      const token = nonNegativeFiniteNumber(ownValue(rawDetails, key));
      if (token !== undefined) setOwn(details, key, token);
    }
    if (Object.keys(details).length) {
      setOwn(usage, 'inputTokenDetails', details);
    }
  }
  return usage;
}

/**
 * Return a sanitized, normalized copy. A zero or invalid output token count
 * clears input/cache counts to avoid false billing.
 */
export function normalizeUsage(usage?: CommandCodeUsage | null): CommandCodeUsage {
  if (!usage) return {};
  const normalized = sanitizeUsage(usage) ?? {};
  if (!Number(usageToken(normalized, 'outputTokens'))) {
    setOwn(normalized, 'inputTokens', 0);
    setOwn(normalized, 'cachedInputTokens', 0);
  }
  return normalized;
}

export function anthropicInputTokens(
  usage?: CommandCodeUsage | null,
  noCacheOverride?: number,
): number {
  if (
    typeof noCacheOverride === 'number'
    && Number.isFinite(noCacheOverride)
    && noCacheOverride >= 0
  ) {
    return noCacheOverride;
  }
  const noCache = usageDetailToken(usage, 'noCacheTokens');
  if (noCache !== undefined) return noCache;
  const cacheRead = usageToken(usage, 'cachedInputTokens')
    || usageDetailToken(usage, 'cacheReadTokens')
    || 0;
  const cacheWrite = usageDetailToken(usage, 'cacheWriteTokens') || 0;
  return Math.max(
    0,
    (usageToken(usage, 'inputTokens') || 0) - cacheRead - cacheWrite,
  );
}
