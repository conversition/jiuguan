import {
  createCommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSources,
} from '../../../packages/commandcode-runtime/src/index.ts';

const DEFAULT_PORT = 3050;
const DEFAULT_MAX_BODY_MIB = 8;
const DEFAULT_MAX_INFLIGHT = 8;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const MAX_BODY_MIB = 32;
const MAX_INFLIGHT = 128;
const MAX_AGGREGATE_BODY_MIB = 128;
const MAX_KEEP_ALIVE_TIMEOUT_MS = 300_000;
const MIB = 1_024 * 1_024;

const RUNTIME_ENV_KEYS = Object.freeze([
  'CC_API_BASE',
  'CC_DEVICE_PROJECT_DIR',
  'CC_CLI_MODE',
  'CC_CLI_SESSION_MODE',
  'CC_FINGERPRINT_SALT',
  'CC_EMPTY_SYSTEM_PLACEHOLDER',
  'CMD_ZDR',
  'CC_USE_PROVIDER_MODELS',
  'CC_MODEL_REFRESH_INTERVAL_MS',
  'CC_MODEL_REQUEST_TIMEOUT_MS',
  'CC_INITIALIZATION_REQUEST_TIMEOUT_MS',
  'CC_STREAM_IDLE_MS',
  'CC_NONSTREAM_IDLE_MS',
  'CC_PROXY_CONNECT_TIMEOUT_MS',
  'CC_MAX_NDJSON_BUFFERED_CHARS',
  'CC_UPSTREAM_PROXY',
] as const);

export interface CommandCodeStandaloneConfigInput {
  readonly fileConfig?: unknown;
  readonly env?: unknown;
}

export interface CommandCodeStandaloneConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly maxInflight: number;
  readonly keepAliveTimeoutMs: number;
  readonly runtimeSources: Readonly<CommandCodeRuntimeConfigSources>;
  readonly runtimeSnapshot: CommandCodeRuntimeConfigSnapshot;
}

export class CommandCodeStandaloneConfigError extends Error {
  readonly code = 'COMMANDCODE_STANDALONE_CONFIG_INVALID' as const;

  constructor(readonly field: string) {
    super(`Invalid CommandCode standalone configuration for ${field}`);
    this.name = 'CommandCodeStandaloneConfigError';
  }
}

function ownDataValue(source: unknown, key: string): unknown {
  if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch { return undefined; }
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function snapshotFileConfig(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommandCodeStandaloneConfigError('fileConfig');
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let keys: string[];
  try { keys = Object.getOwnPropertyNames(value); } catch {
    throw new CommandCodeStandaloneConfigError('fileConfig');
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw new CommandCodeStandaloneConfigError('fileConfig');
    }
    if (descriptor && 'value' in descriptor) output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function selectedValue(
  fallback: unknown,
  fileConfig: unknown,
  fileKey: string,
  env: unknown,
  envKey: string,
): unknown {
  const envValue = ownDataValue(env, envKey);
  if (envValue !== undefined && envValue !== '') return envValue;
  const fileValue = ownDataValue(fileConfig, fileKey);
  return fileValue === undefined || fileValue === '' ? fallback : fileValue;
}

function integerValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CommandCodeStandaloneConfigError(field);
  }
  return parsed;
}

function runtimeEnvironment(env: unknown): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of RUNTIME_ENV_KEYS) {
    const value = ownDataValue(env, key);
    if (value !== undefined) output[key] = value;
  }
  return Object.freeze(output);
}

/**
 * Parse startup-only standalone settings and bind the runtime to one explicit,
 * immutable source set. This function never reads process.env or the file system.
 */
export function createCommandCodeStandaloneConfig(
  input: CommandCodeStandaloneConfigInput = {},
): Readonly<CommandCodeStandaloneConfig> {
  const fileConfig = snapshotFileConfig(ownDataValue(input, 'fileConfig'));
  const env = ownDataValue(input, 'env');
  const host = selectedValue('127.0.0.1', fileConfig, 'host', env, 'HOST');
  if (host !== '127.0.0.1') {
    throw new CommandCodeStandaloneConfigError('host');
  }
  const port = integerValue(
    selectedValue(DEFAULT_PORT, fileConfig, 'port', env, 'PORT'),
    'port',
    1,
    65_535,
  );
  const maxBodyMiB = integerValue(
    selectedValue(
      DEFAULT_MAX_BODY_MIB,
      fileConfig,
      'maxBodyMiB',
      env,
      'CC_MAX_BODY_MB',
    ),
    'maxBodyMiB',
    1,
    MAX_BODY_MIB,
  );
  const maxInflight = integerValue(
    selectedValue(
      DEFAULT_MAX_INFLIGHT,
      fileConfig,
      'maxInflight',
      env,
      'CC_MAX_INFLIGHT',
    ),
    'maxInflight',
    1,
    MAX_INFLIGHT,
  );
  const keepAliveTimeoutMs = integerValue(
    selectedValue(
      DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      fileConfig,
      'keepAliveTimeoutMs',
      env,
      'CC_KEEPALIVE_TIMEOUT_MS',
    ),
    'keepAliveTimeoutMs',
    1_000,
    MAX_KEEP_ALIVE_TIMEOUT_MS,
  );
  if (maxBodyMiB * maxInflight > MAX_AGGREGATE_BODY_MIB) {
    throw new CommandCodeStandaloneConfigError('capacity');
  }
  const runtimeSources = Object.freeze({
    ...(fileConfig === undefined ? {} : { fileConfig }),
    env: runtimeEnvironment(env),
  });
  const runtimeSnapshot = createCommandCodeRuntimeConfigSnapshot(runtimeSources);
  return Object.freeze({
    host,
    port,
    maxBodyBytes: maxBodyMiB * MIB,
    maxInflight,
    keepAliveTimeoutMs,
    runtimeSources,
    runtimeSnapshot,
  });
}
