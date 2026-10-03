import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CommandCodeProviderFileConfig {
  readonly apiBase?: string;
  readonly upstreamProxy?: string;
  readonly zdr?: boolean;
  readonly streamIdleTimeoutMs?: number;
  readonly nonStreamIdleTimeoutMs?: number;
}

const MAX_CONFIG_BYTES = 16 * 1024;
const ALLOWED_KEYS = new Set([
  'apiBase', 'upstreamProxy', 'zdr', 'streamIdleTimeoutMs', 'nonStreamIdleTimeoutMs',
]);

export class CommandCodeProviderConfigError extends Error {
  readonly code = 'COMMANDCODE_PROVIDER_CONFIG_INVALID' as const;
  constructor(reason: string) {
    super(`CommandCode Provider config is invalid: ${reason}`);
    this.name = 'CommandCodeProviderConfigError';
  }
}

/** Read the plugin-owned non-credential configuration. */
export function readCommandCodeProviderFileConfig(
  dataDir: string,
): Readonly<CommandCodeProviderFileConfig> {
  const path = join(dataDir, 'config.json');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({});
    throw new CommandCodeProviderConfigError('could not inspect config.json');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CommandCodeProviderConfigError('config.json must be a regular file');
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new CommandCodeProviderConfigError(`config.json exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CommandCodeProviderConfigError('config.json must contain valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandCodeProviderConfigError('config.json must be an object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) throw new CommandCodeProviderConfigError(`unsupported key: ${key}`);
  }
  if (record.apiBase !== undefined && typeof record.apiBase !== 'string') {
    throw new CommandCodeProviderConfigError('apiBase must be a string');
  }
  if (record.upstreamProxy !== undefined && typeof record.upstreamProxy !== 'string') {
    throw new CommandCodeProviderConfigError('upstreamProxy must be a string');
  }
  if (record.zdr !== undefined && typeof record.zdr !== 'boolean') {
    throw new CommandCodeProviderConfigError('zdr must be a boolean');
  }
  for (const key of ['streamIdleTimeoutMs', 'nonStreamIdleTimeoutMs'] as const) {
    const value = record[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 7_200_000)) {
      throw new CommandCodeProviderConfigError(`${key} must be an integer between 1000 and 7200000`);
    }
  }
  return Object.freeze({
    ...(record.apiBase === undefined ? {} : { apiBase: record.apiBase }),
    ...(record.upstreamProxy === undefined ? {} : { upstreamProxy: record.upstreamProxy }),
    ...(record.zdr === undefined ? {} : { zdr: record.zdr }),
    ...(record.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: record.streamIdleTimeoutMs as number }),
    ...(record.nonStreamIdleTimeoutMs === undefined ? {} : { nonStreamIdleTimeoutMs: record.nonStreamIdleTimeoutMs as number }),
  });
}
