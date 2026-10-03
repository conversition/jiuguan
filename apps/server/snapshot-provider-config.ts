import { createHash } from 'node:crypto';

const MAX_DEPTH = 32;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'key'
    || normalized === 'auth'
    || normalized === 'bearer'
    || normalized.endsWith('key')
    || normalized.endsWith('token')
    || normalized.endsWith('authorization')
    || normalized.endsWith('authentication')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('passphrase')
    || normalized.endsWith('cookie');
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseProviderObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Provider 配置不是合法 JSON');
  }
  if (!objectValue(parsed)) throw new Error('Provider 配置必须是 JSON 对象');
  return parsed;
}

function project(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) throw new Error('Provider 配置嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => project(item, depth + 1));
  }
  if (objectValue(value)) {
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey(key)) continue;
      output[key] = project(item, depth + 1);
    }
    return output;
  }
  throw new Error('Provider 配置包含非法 JSON 值');
}

interface CredentialEntry {
  readonly path: readonly (string | number)[];
  readonly value: JsonValue;
}

function cloneJson(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) throw new Error('Provider 配置嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  if (objectValue(value)) {
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) output[key] = cloneJson(item, depth + 1);
    return output;
  }
  throw new Error('Provider 配置包含非法 JSON 值');
}

function collectCredentials(
  value: unknown,
  path: readonly (string | number)[],
  output: CredentialEntry[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) throw new Error('Provider 配置嵌套过深');
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCredentials(item, [...path, index], output, depth + 1));
    return;
  }
  if (!objectValue(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey(key)) {
      output.push(Object.freeze({ path: Object.freeze([...path, key]), value: cloneJson(item, depth + 1) }));
    } else {
      collectCredentials(item, [...path, key], output, depth + 1);
    }
  }
}

function assignCredential(root: Record<string, JsonValue>, entry: CredentialEntry): boolean {
  let current: JsonValue = root;
  for (let index = 0; index < entry.path.length - 1; index += 1) {
    const segment = entry.path[index]!;
    const next = entry.path[index + 1]!;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) throw new Error('Provider 凭据结构与快照配置冲突');
      const existing = current[segment];
      if (existing === undefined) return false;
      if (((typeof next === 'number') !== Array.isArray(existing))
        || (!objectValue(existing) && !Array.isArray(existing))) {
        throw new Error('Provider 凭据结构与快照配置冲突');
      }
      current = current[segment]!;
    } else {
      if (!objectValue(current)) throw new Error('Provider 凭据结构与快照配置冲突');
      const existing = current[segment];
      if (existing === undefined) return false;
      if (((typeof next === 'number') !== Array.isArray(existing))
        || (!objectValue(existing) && !Array.isArray(existing))) {
        throw new Error('Provider 凭据结构与快照配置冲突');
      }
      current = current[segment]!;
    }
  }
  const final = entry.path.at(-1)!;
  if (typeof final === 'number') {
    if (!Array.isArray(current)) throw new Error('Provider 凭据结构与快照配置冲突');
    current[final] = cloneJson(entry.value, 0);
  } else {
    if (!objectValue(current)) throw new Error('Provider 凭据结构与快照配置冲突');
    current[final] = cloneJson(entry.value, 0);
  }
  return true;
}

/** Canonical non-sensitive projection written to published snapshots. */
export function redactProviderConfig(raw: string): string {
  const projected = project(parseProviderObject(raw), 0);
  if (!objectValue(projected)) throw new Error('Provider 配置必须投影为 JSON 对象');
  return JSON.stringify(projected, null, 2) + '\n';
}

/**
 * Restore snapshot business settings while carrying forward only credential-bearing fields from
 * the currently active provider config. Snapshot credentials, including legacy ones, never win.
 */
export function mergeActiveProviderCredentials(snapshotRaw: string, activeRaw: string): string {
  const snapshot = parseProviderObject(redactProviderConfig(snapshotRaw));
  const active = parseProviderObject(activeRaw);
  const merged = cloneJson(snapshot, 0);
  if (!objectValue(merged)) throw new Error('Provider 配置必须是 JSON 对象');
  const credentials: CredentialEntry[] = [];
  collectCredentials(active, [], credentials, 0);
  for (const credential of credentials) assignCredential(merged as Record<string, JsonValue>, credential);
  return JSON.stringify(merged, null, 2) + '\n';
}

export function providerRedactedDigest(raw: string): { sizeBytes: number; sha256: string } {
  const content = redactProviderConfig(raw);
  const bytes = Buffer.from(content, 'utf8');
  return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
