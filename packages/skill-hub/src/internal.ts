import { createHash } from 'node:crypto';

export const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
export const STABLE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
export const VERSION_TOKEN_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;

export function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${label}.${key} is required`);
  }
}

export function boundedString(value: unknown, label: string, max = 1_024): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < 1 || normalized.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return normalized;
}

export function stableToken(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 240);
  if (!STABLE_TOKEN_RE.test(normalized)) throw new TypeError(`${label} must be an opaque stable token`);
  return normalized;
}

export function versionToken(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 80);
  if (!VERSION_TOKEN_RE.test(normalized)) throw new TypeError(`${label} must be a stable version token`);
  return normalized;
}

export function sha256Digest(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 71);
  if (!HASH_RE.test(normalized)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
  return normalized;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function safeInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

export function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new TypeError(`${label} must be one of: ${values.join(', ')}`);
  }
  return value as T[number];
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareVersion(left: string, right: string): number {
  const split = (value: string): string[] => value.split(/([0-9]+)/u).filter(Boolean);
  const a = split(left);
  const b = split(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^[0-9]+$/u.test(x) && /^[0-9]+$/u.test(y)) {
      const nx = BigInt(x);
      const ny = BigInt(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    } else {
      const compared = compareText(x, y);
      if (compared !== 0) return compared;
    }
  }
  return 0;
}

export function uniqueSortedTokens(
  value: unknown,
  label: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): readonly string[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 64;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain between ${minimum} and ${maximum} items`);
  }
  const output = value.map((item, index) => stableToken(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(output.sort(compareText));
}

export function isoTimestamp(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 64);
  const time = Date.parse(normalized);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) {
    throw new TypeError(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return normalized;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  assertPlainRecord(value, 'canonical JSON value');
  const entries = Object.keys(value).sort(compareText).map((key) => {
    const item = value[key];
    if (item === undefined) throw new TypeError('canonical JSON does not support undefined');
    return `${JSON.stringify(key)}:${canonicalValue(item)}`;
  });
  return `{${entries.join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function digestCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
