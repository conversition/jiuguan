/*
 * Configuration defaults and endpoint policy adapted from commandcode-proxy 1.0.0.
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

export const COMMANDCODE_API_ORIGIN = 'https://api.commandcode.ai' as const;
export const COMMANDCODE_PROTOCOL_VERSION = '1.53.1' as const;
export const COMMANDCODE_CLI_ENVIRONMENT = 'production' as const;
export const COMMANDCODE_USER_AGENT = 'cli' as const;

export const COMMANDCODE_UPSTREAM_PATHS = Object.freeze({
  generate: '/alpha/generate',
  fingerprint: '/alpha/fingerprint/record',
  lifecycle: '/alpha/lifecycle-events',
  models: '/provider/v1/models',
} as const);

export const COMMANDCODE_CLI_MODES = Object.freeze([
  'agent',
  'learning',
  'custom-agent',
  'custom-agent-create',
  'title-gen',
  'tool-desc',
  'compact',
  'vision',
] as const);

export const COMMANDCODE_CLI_SESSION_MODES = Object.freeze([
  'interactive',
  'non-interactive',
] as const);

export type CommandCodeCliMode = typeof COMMANDCODE_CLI_MODES[number];
export type CommandCodeCliSessionMode = typeof COMMANDCODE_CLI_SESSION_MODES[number];

export interface CommandCodeRuntimeConfigSources {
  /** Parsed host-owned configuration data. This function never opens a file. */
  fileConfig?: unknown;
  /** Explicit environment mapping. This function never reads ambient environment state. */
  env?: unknown;
  /** Trusted PC-host override with the highest precedence. Never map client input here. */
  hostOverrides?: unknown;
}

export interface CommandCodeDeviceProfileSnapshot {
  readonly projectDir: string;
  readonly projectSlug: string;
  readonly platform: 'win32';
  readonly arch: 'x64';
  readonly osRelease: '10.0.22631';
  readonly isContainer: false;
}

export interface CommandCodeUpstreamProxySnapshot {
  /** Internal-only URL. It may contain credentials and must never be returned to clients. */
  readonly url: string;
  /** Credential-free value suitable for an administrator-facing diagnostic. */
  readonly displayUrl: string;
}

export interface PublicCommandCodeDeviceProfile {
  readonly platform: CommandCodeDeviceProfileSnapshot['platform'];
  readonly arch: CommandCodeDeviceProfileSnapshot['arch'];
  readonly osRelease: CommandCodeDeviceProfileSnapshot['osRelease'];
  readonly isContainer: CommandCodeDeviceProfileSnapshot['isContainer'];
}

export interface CommandCodeRuntimeConfigSnapshot {
  readonly apiOrigin: typeof COMMANDCODE_API_ORIGIN;
  readonly protocolVersion: typeof COMMANDCODE_PROTOCOL_VERSION;
  readonly cliEnvironment: typeof COMMANDCODE_CLI_ENVIRONMENT;
  readonly userAgent: typeof COMMANDCODE_USER_AGENT;
  readonly deviceProfile: CommandCodeDeviceProfileSnapshot;
  readonly cliMode: CommandCodeCliMode;
  readonly cliSessionMode: CommandCodeCliSessionMode;
  readonly fingerprintSalt: string;
  readonly emptySystemPlaceholder: boolean;
  readonly zdr: boolean;
  readonly useProviderModels: boolean;
  readonly modelRefreshIntervalMs: number;
  readonly modelRequestTimeoutMs: number;
  readonly initializationRequestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly nonStreamIdleTimeoutMs: number;
  readonly proxyConnectTimeoutMs: number;
  readonly maxNdjsonBufferedChars: number;
  readonly sessionTtlMs: number;
  readonly sessionJitterMs: number;
  readonly initializationTtlMs: number;
  readonly initializationJitterMs: number;
  readonly upstreamProxy: CommandCodeUpstreamProxySnapshot | null;
}

export interface PublicCommandCodeRuntimeConfig {
  readonly apiOrigin: typeof COMMANDCODE_API_ORIGIN;
  readonly protocolVersion: typeof COMMANDCODE_PROTOCOL_VERSION;
  readonly deviceProfile: PublicCommandCodeDeviceProfile;
  readonly cliMode: CommandCodeCliMode;
  readonly cliSessionMode: CommandCodeCliSessionMode;
  readonly fingerprintSaltConfigured: boolean;
  readonly emptySystemPlaceholder: boolean;
  readonly zdr: boolean;
  readonly useProviderModels: boolean;
  readonly modelRefreshIntervalMs: number;
  readonly modelRequestTimeoutMs: number;
  readonly initializationRequestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly nonStreamIdleTimeoutMs: number;
  readonly upstreamProxy: string | null;
}

export class CommandCodeConfigError extends Error {
  readonly code = 'COMMANDCODE_CONFIG_INVALID' as const;

  constructor(readonly field: string, reason: string) {
    super(`Invalid CommandCode configuration for ${field}: ${reason}`);
    this.name = 'CommandCodeConfigError';
  }
}

const DEFAULT_DEVICE_PROJECT_DIR = 'C:\\Users\\dev\\projects\\app';
const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INITIALIZATION_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_NONSTREAM_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_NDJSON_BUFFERED_CHARS = 8 * 1_024 * 1_024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_JITTER_MS = 60 * 60 * 1_000;
const INITIALIZATION_TTL_MS = 8 * 60 * 60 * 1_000;
const INITIALIZATION_JITTER_MS = 2 * 60 * 60 * 1_000;
const MISSING = Symbol('missing-config-value');
const ISSUED_CONFIG_SNAPSHOTS = new WeakSet<object>();

function ownDataValue(source: unknown, keys: readonly string[]): unknown | typeof MISSING {
  if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
    return MISSING;
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      return MISSING;
    }
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) continue;
    return descriptor.value;
  }
  return MISSING;
}

function selectedValue(
  fallback: unknown,
  fileConfig: unknown,
  fileKeys: readonly string[],
  env: unknown,
  envKeys: readonly string[],
  hostOverrides: unknown,
  overrideKeys: readonly string[] = fileKeys,
): unknown {
  let selected = fallback;
  for (const candidate of [
    ownDataValue(fileConfig, fileKeys),
    ownDataValue(env, envKeys),
    ownDataValue(hostOverrides, overrideKeys),
  ]) {
    if (candidate !== MISSING) selected = candidate;
  }
  return selected;
}

function boundedString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxLength: number; trim?: boolean },
): string {
  if (typeof value !== 'string') {
    throw new CommandCodeConfigError(field, 'expected a string');
  }
  const result = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && !result) {
    throw new CommandCodeConfigError(field, 'must not be empty');
  }
  if (result.length > options.maxLength) {
    throw new CommandCodeConfigError(
      field,
      `must be at most ${options.maxLength} characters`,
    );
  }
  if (/\0/.test(result)) {
    throw new CommandCodeConfigError(field, 'must not contain NUL');
  }
  return result;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
  }
  throw new CommandCodeConfigError(field, 'expected true/false or 1/0');
}

function integerValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < min || (parsed as number) > max) {
    throw new CommandCodeConfigError(
      field,
      `expected an integer from ${min} to ${max}`,
    );
  }
  return parsed as number;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.some((candidate) => candidate === value)) {
    throw new CommandCodeConfigError(field, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function apiOriginValue(value: unknown): typeof COMMANDCODE_API_ORIGIN {
  const raw = boundedString(value, 'apiOrigin', { maxLength: 256 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommandCodeConfigError(
      'apiOrigin',
      'expected the fixed production HTTPS origin',
    );
  }
  if (
    url.origin !== COMMANDCODE_API_ORIGIN
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new CommandCodeConfigError(
      'apiOrigin',
      'expected the fixed production HTTPS origin',
    );
  }
  return COMMANDCODE_API_ORIGIN;
}

export function slugifyCommandCodeProjectPath(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'root';
}

function deviceProjectDirValue(value: unknown): string {
  if (value === '') return DEFAULT_DEVICE_PROJECT_DIR;
  const result = boundedString(value, 'deviceProjectDir', { maxLength: 1_024 });
  if (/\r|\n/.test(result)) {
    throw new CommandCodeConfigError('deviceProjectDir', 'must not contain line breaks');
  }
  const slug = slugifyCommandCodeProjectPath(result);
  if (slug.length > 256) {
    throw new CommandCodeConfigError('deviceProjectDir', 'derived project slug is too long');
  }
  return result;
}

function upstreamProxyValue(value: unknown): CommandCodeUpstreamProxySnapshot | null {
  if (value === '') return null;
  const raw = boundedString(value, 'upstreamProxy', { maxLength: 2_048 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommandCodeConfigError(
      'upstreamProxy',
      'expected a loopback http:// proxy URL',
    );
  }
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (
    url.protocol !== 'http:'
    || !loopbackHosts.includes(url.hostname.toLowerCase())
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new CommandCodeConfigError(
      'upstreamProxy',
      'expected a loopback http:// proxy URL',
    );
  }
  const port = url.port || '80';
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new CommandCodeConfigError(
      'upstreamProxy',
      'expected a loopback http:// proxy URL',
    );
  }
  return Object.freeze({
    url: url.toString(),
    displayUrl: `http://${url.hostname}:${port}`,
  });
}

export function createCommandCodeRuntimeConfigSnapshot(
  sources: CommandCodeRuntimeConfigSources = {},
): CommandCodeRuntimeConfigSnapshot {
  const fileConfigValue = ownDataValue(sources, ['fileConfig']);
  const envValue = ownDataValue(sources, ['env']);
  const hostOverridesValue = ownDataValue(sources, ['hostOverrides']);
  const fileConfig = fileConfigValue === MISSING ? undefined : fileConfigValue;
  const env = envValue === MISSING ? undefined : envValue;
  const hostOverrides = hostOverridesValue === MISSING ? undefined : hostOverridesValue;
  const projectDir = deviceProjectDirValue(selectedValue(
    DEFAULT_DEVICE_PROJECT_DIR,
    fileConfig,
    ['deviceProjectDir'],
    env,
    ['CC_DEVICE_PROJECT_DIR'],
    hostOverrides,
  ));
  const deviceProfile = Object.freeze({
    projectDir,
    projectSlug: slugifyCommandCodeProjectPath(projectDir),
    platform: 'win32' as const,
    arch: 'x64' as const,
    osRelease: '10.0.22631' as const,
    isContainer: false as const,
  });

  const snapshot: CommandCodeRuntimeConfigSnapshot = {
    apiOrigin: apiOriginValue(selectedValue(
      COMMANDCODE_API_ORIGIN,
      fileConfig,
      ['apiOrigin', 'apiBase'],
      env,
      ['CC_API_BASE'],
      hostOverrides,
      ['apiOrigin', 'apiBase'],
    )),
    protocolVersion: COMMANDCODE_PROTOCOL_VERSION,
    cliEnvironment: COMMANDCODE_CLI_ENVIRONMENT,
    userAgent: COMMANDCODE_USER_AGENT,
    deviceProfile,
    cliMode: enumValue(selectedValue(
      'agent', fileConfig, ['cliMode'], env, ['CC_CLI_MODE'], hostOverrides,
    ), 'cliMode', COMMANDCODE_CLI_MODES),
    cliSessionMode: enumValue(selectedValue(
      'interactive',
      fileConfig,
      ['cliSessionMode'],
      env,
      ['CC_CLI_SESSION_MODE'],
      hostOverrides,
    ), 'cliSessionMode', COMMANDCODE_CLI_SESSION_MODES),
    fingerprintSalt: boundedString(selectedValue(
      '',
      fileConfig,
      ['fingerprintSalt'],
      env,
      ['CC_FINGERPRINT_SALT'],
      hostOverrides,
    ), 'fingerprintSalt', { allowEmpty: true, maxLength: 1_024, trim: false }),
    emptySystemPlaceholder: booleanValue(selectedValue(
      true,
      fileConfig,
      ['emptySystemPlaceholder'],
      env,
      ['CC_EMPTY_SYSTEM_PLACEHOLDER'],
      hostOverrides,
    ), 'emptySystemPlaceholder'),
    zdr: booleanValue(selectedValue(
      false, fileConfig, ['zdr'], env, ['CMD_ZDR'], hostOverrides,
    ), 'zdr'),
    useProviderModels: booleanValue(selectedValue(
      true,
      fileConfig,
      ['useProviderModels'],
      env,
      ['CC_USE_PROVIDER_MODELS'],
      hostOverrides,
    ), 'useProviderModels'),
    modelRefreshIntervalMs: integerValue(selectedValue(
      DEFAULT_MODEL_REFRESH_INTERVAL_MS,
      fileConfig,
      ['modelRefreshIntervalMs'],
      env,
      ['CC_MODEL_REFRESH_INTERVAL_MS'],
      hostOverrides,
    ), 'modelRefreshIntervalMs', 1_000, 86_400_000),
    modelRequestTimeoutMs: integerValue(selectedValue(
      DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
      fileConfig,
      ['modelRequestTimeoutMs'],
      env,
      ['CC_MODEL_REQUEST_TIMEOUT_MS'],
      hostOverrides,
    ), 'modelRequestTimeoutMs', 1_000, 120_000),
    initializationRequestTimeoutMs: integerValue(selectedValue(
      DEFAULT_INITIALIZATION_REQUEST_TIMEOUT_MS,
      fileConfig,
      ['initializationRequestTimeoutMs'],
      env,
      ['CC_INITIALIZATION_REQUEST_TIMEOUT_MS'],
      hostOverrides,
    ), 'initializationRequestTimeoutMs', 1_000, 120_000),
    streamIdleTimeoutMs: integerValue(selectedValue(
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      fileConfig,
      ['streamIdleTimeoutMs', 'streamIdleMs'],
      env,
      ['CC_STREAM_IDLE_MS'],
      hostOverrides,
      ['streamIdleTimeoutMs', 'streamIdleMs'],
    ), 'streamIdleTimeoutMs', 1_000, 7_200_000),
    nonStreamIdleTimeoutMs: integerValue(selectedValue(
      DEFAULT_NONSTREAM_IDLE_TIMEOUT_MS,
      fileConfig,
      ['nonStreamIdleTimeoutMs', 'nonStreamIdleMs'],
      env,
      ['CC_NONSTREAM_IDLE_MS'],
      hostOverrides,
      ['nonStreamIdleTimeoutMs', 'nonStreamIdleMs'],
    ), 'nonStreamIdleTimeoutMs', 1_000, 7_200_000),
    proxyConnectTimeoutMs: integerValue(selectedValue(
      DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
      fileConfig,
      ['proxyConnectTimeoutMs'],
      env,
      ['CC_PROXY_CONNECT_TIMEOUT_MS'],
      hostOverrides,
    ), 'proxyConnectTimeoutMs', 1_000, 120_000),
    maxNdjsonBufferedChars: integerValue(selectedValue(
      DEFAULT_MAX_NDJSON_BUFFERED_CHARS,
      fileConfig,
      ['maxNdjsonBufferedChars'],
      env,
      ['CC_MAX_NDJSON_BUFFERED_CHARS'],
      hostOverrides,
    ), 'maxNdjsonBufferedChars', 1_024, 64 * 1_024 * 1_024),
    sessionTtlMs: SESSION_TTL_MS,
    sessionJitterMs: SESSION_JITTER_MS,
    initializationTtlMs: INITIALIZATION_TTL_MS,
    initializationJitterMs: INITIALIZATION_JITTER_MS,
    upstreamProxy: upstreamProxyValue(selectedValue(
      '', fileConfig, ['upstreamProxy'], env, ['CC_UPSTREAM_PROXY'], hostOverrides,
    )),
  };
  const frozenSnapshot = Object.freeze(snapshot);
  ISSUED_CONFIG_SNAPSHOTS.add(frozenSnapshot);
  return frozenSnapshot;
}

/**
 * Reject structurally forged snapshots before they reach the upstream boundary.
 * Runtime snapshots are intentionally process-local and must come from the parser above.
 */
export function assertCommandCodeRuntimeConfigSnapshot(
  value: unknown,
): asserts value is CommandCodeRuntimeConfigSnapshot {
  if (
    (typeof value !== 'object' || value === null)
    || !ISSUED_CONFIG_SNAPSHOTS.has(value)
  ) {
    throw new CommandCodeConfigError(
      'snapshot',
      'must be created by createCommandCodeRuntimeConfigSnapshot',
    );
  }
}

export function toPublicCommandCodeRuntimeConfig(
  snapshot: CommandCodeRuntimeConfigSnapshot,
): PublicCommandCodeRuntimeConfig {
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  const deviceProfile = Object.freeze({
    platform: snapshot.deviceProfile.platform,
    arch: snapshot.deviceProfile.arch,
    osRelease: snapshot.deviceProfile.osRelease,
    isContainer: snapshot.deviceProfile.isContainer,
  });
  return Object.freeze({
    apiOrigin: snapshot.apiOrigin,
    protocolVersion: snapshot.protocolVersion,
    deviceProfile,
    cliMode: snapshot.cliMode,
    cliSessionMode: snapshot.cliSessionMode,
    fingerprintSaltConfigured: snapshot.fingerprintSalt.length > 0,
    emptySystemPlaceholder: snapshot.emptySystemPlaceholder,
    zdr: snapshot.zdr,
    useProviderModels: snapshot.useProviderModels,
    modelRefreshIntervalMs: snapshot.modelRefreshIntervalMs,
    modelRequestTimeoutMs: snapshot.modelRequestTimeoutMs,
    initializationRequestTimeoutMs: snapshot.initializationRequestTimeoutMs,
    streamIdleTimeoutMs: snapshot.streamIdleTimeoutMs,
    nonStreamIdleTimeoutMs: snapshot.nonStreamIdleTimeoutMs,
    upstreamProxy: snapshot.upstreamProxy?.displayUrl ?? null,
  });
}
