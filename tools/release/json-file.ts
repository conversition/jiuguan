import { readFileSync } from 'node:fs';

/**
 * Parse a JSON object written by either modern UTF-8 writers or historical
 * Windows PowerShell `Set-Content -Encoding UTF8` (which prepended a BOM).
 *
 * Only one BOM at byte zero is tolerated. Arrays, primitives, empty input,
 * UTF-16/NUL content and otherwise malformed JSON remain fail-closed.
 */
export function parseJsonObjectText(input: string, source = '<json>'): Record<string, unknown> {
  const normalized = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`release-json-invalid:${source}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new Error(`release-json-invalid:${source}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`release-json-object-required:${source}`);
  }
  return value as Record<string, unknown>;
}

export function readJsonObjectFile(path: string): Record<string, unknown> {
  return parseJsonObjectText(readFileSync(path, 'utf8'), path);
}
