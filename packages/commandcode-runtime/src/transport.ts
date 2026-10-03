/*
 * Upstream request policy adapted from commandcode-proxy 1.0.0.
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

import { types as nodeUtilTypes } from 'node:util';
import {
  assertCommandCodeRuntimeConfigSnapshot,
  COMMANDCODE_API_ORIGIN,
  COMMANDCODE_CLI_ENVIRONMENT,
  COMMANDCODE_PROTOCOL_VERSION,
  COMMANDCODE_UPSTREAM_PATHS,
  COMMANDCODE_USER_AGENT,
  createCommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSources,
  type CommandCodeUpstreamProxySnapshot,
} from './config.ts';

export const COMMANDCODE_MAX_WIRE_JSON_DEPTH = 64;
export const COMMANDCODE_MAX_WIRE_JSON_NODES = 100_000;
export const COMMANDCODE_MAX_WIRE_JSON_INPUT_CHARS = 32 * 1_024 * 1_024;
export const COMMANDCODE_MAX_WIRE_JSON_OUTPUT_CHARS = 64 * 1_024 * 1_024;

export type CommandCodeUpstreamPurpose =
  | 'generate'
  | 'fingerprint'
  | 'lifecycle'
  | 'models';

export type CommandCodeProxySupport = 'none' | 'loopback-http-connect';

export interface CommandCodeUpstreamPolicy {
  readonly redirect: 'error';
  readonly upstreamProxy: CommandCodeUpstreamProxySnapshot | null;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number | null;
}

export interface CommandCodeUpstreamRequest {
  readonly purpose: CommandCodeUpstreamPurpose;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly policy: Readonly<CommandCodeUpstreamPolicy>;
}

export interface CommandCodeUpstreamTransport<TResponse = unknown> {
  /** Capability is bound to the executor so proxy configuration cannot be forgotten separately. */
  readonly proxySupport: CommandCodeProxySupport;
  readonly execute: (
    request: CommandCodeUpstreamRequest,
  ) => TResponse | PromiseLike<TResponse>;
}

export interface CommandCodeGenerateBuilderInput {
  readonly apiKey: string;
  readonly sessionId: string;
  readonly traceparent: string;
  readonly wireBody: unknown;
  /** Trusted PC-host decision only. Never map a browser/mobile header directly here. */
  readonly hostZdrOverride?: boolean;
  readonly signal?: AbortSignal;
}

export interface CommandCodeGenerateInput {
  readonly apiKey: string;
  readonly sessionId: string;
  readonly wireBody: unknown;
  /** Trusted PC-host decision only. Never map a browser/mobile header directly here. */
  readonly hostZdrOverride?: boolean;
  readonly signal?: AbortSignal;
}

export interface CommandCodeFingerprintInput {
  readonly apiKey: string;
  readonly fingerprint: unknown;
  readonly signal?: AbortSignal;
}

export interface CommandCodeLifecycleInput {
  readonly apiKey: string;
  readonly lifecycleSessionId: string;
  readonly signal?: AbortSignal;
}

export interface CommandCodeModelsInput {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

export interface CommandCodeUpstreamClient<TResponse = unknown> {
  generate(input: CommandCodeGenerateInput): Promise<TResponse>;
  recordFingerprint(input: CommandCodeFingerprintInput): Promise<TResponse>;
  sendLifecycleEvent(input: CommandCodeLifecycleInput): Promise<TResponse>;
  listModels(input: CommandCodeModelsInput): Promise<TResponse>;
}

type RequestField =
  | 'input'
  | 'apiKey'
  | 'sessionId'
  | 'lifecycleSessionId'
  | 'traceparent'
  | 'wireBody'
  | 'fingerprint'
  | 'configSource'
  | 'transport'
  | 'proxySupport';

export class CommandCodeRequestError extends Error {
  readonly code = 'COMMANDCODE_REQUEST_INVALID' as const;

  constructor(readonly field: RequestField, reason: string) {
    super(`Invalid CommandCode upstream request for ${field}: ${reason}`);
    this.name = 'CommandCodeRequestError';
  }
}

export class CommandCodeAbortError extends Error {
  readonly code = 'COMMANDCODE_REQUEST_ABORTED' as const;

  constructor() {
    super('CommandCode upstream request was aborted');
    this.name = 'AbortError';
  }
}

const MISSING = Symbol('missing-request-value');
const API_KEY_PATTERN = /^user_[A-Za-z0-9_-]{1,507}$/;
const SESSION_ID_PATTERN = /^[\x21-\x7e]{8,256}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFECYCLE_SESSION_ID_PATTERN = /^sess_[0-9a-f]{16}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const ISSUED_UPSTREAM_REQUESTS = new WeakSet<object>();
const REQUIRED_ENVELOPE_KEYS = Object.freeze([
  'config',
  'memory',
  'taste',
  'skills',
  'permissionMode',
  'mode',
  'params',
] as const);
const ALLOWED_ENVELOPE_KEYS = new Set<string>([
  ...REQUIRED_ENVELOPE_KEYS,
  'promptCache',
]);

function invalid(field: RequestField, reason: string): never {
  throw new CommandCodeRequestError(field, reason);
}

function plainInputObject(value: unknown): object {
  if (
    typeof value !== 'object'
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    return invalid('input', 'expected a plain data object');
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return invalid('input', 'expected a plain data object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid('input', 'expected a plain data object');
  }
  return value;
}

function ownDataValue(input: object, key: string): unknown | typeof MISSING {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, key);
  } catch {
    return invalid('input', 'could not inspect data properties');
  }
  if (!descriptor) return MISSING;
  if (!('value' in descriptor)) {
    return invalid('input', 'accessor properties are not allowed');
  }
  return descriptor.value;
}

function requiredValue(input: object, key: string, field: RequestField): unknown {
  const value = ownDataValue(input, key);
  if (value === MISSING || value === undefined) {
    return invalid(field, 'is required');
  }
  return value;
}

function signalValue(input: object): AbortSignal | undefined {
  const value = ownDataValue(input, 'signal');
  if (value === MISSING || value === undefined) return undefined;
  if (
    (typeof value === 'object' && value !== null && nodeUtilTypes.isProxy(value))
    || !(value instanceof AbortSignal)
  ) {
    return invalid('input', 'signal must be an AbortSignal');
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CommandCodeAbortError();
}

function strictString(value: unknown, field: RequestField, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(field, 'has an invalid format');
  }
  return value;
}

function apiKeyValue(input: object): string {
  return strictString(requiredValue(input, 'apiKey', 'apiKey'), 'apiKey', API_KEY_PATTERN);
}

function sessionIdValue(input: object): string {
  return strictString(
    requiredValue(input, 'sessionId', 'sessionId'),
    'sessionId',
    SESSION_ID_PATTERN,
  );
}

function lifecycleSessionIdValue(input: object): string {
  return strictString(
    requiredValue(input, 'lifecycleSessionId', 'lifecycleSessionId'),
    'lifecycleSessionId',
    LIFECYCLE_SESSION_ID_PATTERN,
  );
}

function traceparentValue(value: unknown): string {
  const traceparent = strictString(value, 'traceparent', TRACEPARENT_PATTERN);
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (
    !match
    || /^0+$/.test(match[1]!)
    || /^0+$/.test(match[2]!)
  ) {
    return invalid('traceparent', 'has an invalid format');
  }
  return traceparent;
}

function hostZdrOverrideValue(input: object): boolean {
  const value = ownDataValue(input, 'hostZdrOverride');
  if (value === MISSING || value === undefined) return false;
  if (typeof value !== 'boolean') {
    return invalid('input', 'hostZdrOverride must be a boolean');
  }
  return value;
}

function serializeStrictJson(value: unknown, field: 'wireBody' | 'fingerprint'): string {
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let inputChars = 0;
  let outputChars = 0;

  const fail = (reason: string): never => invalid(field, reason);
  const countInput = (amount: number): void => {
    inputChars += amount;
    if (inputChars > COMMANDCODE_MAX_WIRE_JSON_INPUT_CHARS) {
      fail('exceeds the JSON input budget');
    }
  };
  const append = (part: string): void => {
    outputChars += part.length;
    if (outputChars > COMMANDCODE_MAX_WIRE_JSON_OUTPUT_CHARS) {
      fail('exceeds the JSON output budget');
    }
    chunks.push(part);
  };
  const appendJsonString = (raw: string): void => {
    countInput(raw.length);
    let buffer = '"';
    const flushWith = (encoded: string): void => {
      if (buffer.length + encoded.length > 8_192) {
        append(buffer);
        buffer = '';
      }
      buffer += encoded;
    };
    for (let index = 0; index < raw.length; index++) {
      const code = raw.charCodeAt(index);
      let encoded: string;
      switch (code) {
        case 0x08: encoded = '\\b'; break;
        case 0x09: encoded = '\\t'; break;
        case 0x0a: encoded = '\\n'; break;
        case 0x0c: encoded = '\\f'; break;
        case 0x0d: encoded = '\\r'; break;
        case 0x22: encoded = '\\"'; break;
        case 0x5c: encoded = '\\\\'; break;
        default: {
          if (code <= 0x1f) {
            encoded = `\\u${code.toString(16).padStart(4, '0')}`;
          } else if (code >= 0xd800 && code <= 0xdbff) {
            const next = index + 1 < raw.length ? raw.charCodeAt(index + 1) : -1;
            if (next >= 0xdc00 && next <= 0xdfff) {
              encoded = `${raw[index]!}${raw[index + 1]!}`;
              index++;
            } else {
              encoded = `\\u${code.toString(16).padStart(4, '0')}`;
            }
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            encoded = `\\u${code.toString(16).padStart(4, '0')}`;
          } else {
            encoded = raw[index]!;
          }
        }
      }
      flushWith(encoded);
    }
    flushWith('"');
    if (buffer) append(buffer);
  };

  const visit = (current: unknown, depth: number): void => {
    nodes++;
    if (nodes > COMMANDCODE_MAX_WIRE_JSON_NODES) fail('exceeds the JSON node budget');
    if (depth > COMMANDCODE_MAX_WIRE_JSON_DEPTH) fail('exceeds the JSON depth budget');

    if (current === null) {
      append('null');
      return;
    }
    if (typeof current === 'string') {
      appendJsonString(current);
      return;
    }
    if (typeof current === 'boolean') {
      append(current ? 'true' : 'false');
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('contains a non-finite number');
      append(JSON.stringify(current));
      return;
    }
    if (typeof current !== 'object') fail('contains an unsupported value');
    const objectValue = current as object;
    if (nodeUtilTypes.isProxy(objectValue)) fail('contains an unsupported object');
    if (ancestors.has(objectValue)) fail('contains a circular reference');

    ancestors.add(objectValue);
    try {
      if (Array.isArray(objectValue)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(objectValue, 'length');
        const length = lengthDescriptor && 'value' in lengthDescriptor
          ? lengthDescriptor.value
          : -1;
        if (!Number.isSafeInteger(length) || length < 0 || length > COMMANDCODE_MAX_WIRE_JSON_NODES) {
          fail('contains an oversized array');
        }
        append('[');
        for (let index = 0; index < length; index++) {
          if (index > 0) append(',');
          const descriptor = Object.getOwnPropertyDescriptor(objectValue, String(index));
          if (!descriptor) {
            append('null');
          } else if (!('value' in descriptor)) {
            fail('contains an accessor property');
          } else {
            visit(descriptor.value, depth + 1);
          }
        }
        append(']');
        return;
      }

      const prototype = Object.getPrototypeOf(objectValue) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        fail('contains an unsupported object');
      }
      const keys = Reflect.ownKeys(objectValue);
      if (keys.length > COMMANDCODE_MAX_WIRE_JSON_NODES) {
        fail('contains too many object properties');
      }
      append('{');
      let emitted = 0;
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (!descriptor?.enumerable) continue;
        if (!('value' in descriptor)) fail('contains an accessor property');
        if (emitted > 0) append(',');
        appendJsonString(key);
        append(':');
        visit(descriptor.value, depth + 1);
        emitted++;
      }
      append('}');
    } catch (error) {
      if (error instanceof CommandCodeRequestError) throw error;
      fail('could not be serialized safely');
    } finally {
      ancestors.delete(objectValue);
    }
  };

  visit(value, 0);
  return chunks.join('');
}

export function serializeCommandCodeJson(value: unknown): string {
  return serializeStrictJson(value, 'wireBody');
}

function orderedGenerateBody(body: unknown, sessionId: string): string {
  if (
    typeof body !== 'object'
    || body === null
    || nodeUtilTypes.isProxy(body)
    || Array.isArray(body)
  ) {
    return invalid('wireBody', 'expected a protocol envelope object');
  }
  const prototype = Object.getPrototypeOf(body) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid('wireBody', 'expected a protocol envelope object');
  }

  const values = new Map<string, unknown>();
  try {
    const keys = Reflect.ownKeys(body);
    if (keys.length > COMMANDCODE_MAX_WIRE_JSON_NODES) {
      invalid('wireBody', 'contains too many envelope properties');
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) invalid('wireBody', 'contains an accessor property');
      if (!ALLOWED_ENVELOPE_KEYS.has(key)) invalid('wireBody', 'contains an unknown envelope field');
      values.set(key, descriptor.value);
    }
  } catch (error) {
    if (error instanceof CommandCodeRequestError) throw error;
    return invalid('wireBody', 'could not inspect the protocol envelope');
  }
  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (!values.has(key)) invalid('wireBody', 'is missing a required envelope field');
  }
  if (!UUID_PATTERN.test(sessionId)) {
    return serializeStrictJson(body, 'wireBody');
  }

  const ordered: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ['config', 'memory', 'taste', 'skills', 'permissionMode'] as const) {
    ordered[key] = values.get(key);
  }
  ordered.threadId = sessionId;
  ordered.mode = values.get('mode');
  if (values.has('promptCache')) ordered.promptCache = values.get('promptCache');
  ordered.params = values.get('params');
  return serializeStrictJson(ordered, 'wireBody');
}

function headersOf(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries) headers[name] = value;
  return Object.freeze(headers);
}

function policyOf(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  purpose: CommandCodeUpstreamPurpose,
): Readonly<CommandCodeUpstreamPolicy> {
  return Object.freeze({
    redirect: 'error' as const,
    upstreamProxy: snapshot.upstreamProxy,
    connectTimeoutMs: snapshot.proxyConnectTimeoutMs,
    requestTimeoutMs: purpose === 'models'
      ? snapshot.modelRequestTimeoutMs
      : purpose === 'fingerprint' || purpose === 'lifecycle'
        ? snapshot.initializationRequestTimeoutMs
        : null,
  });
}

function preparedRequest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  purpose: CommandCodeUpstreamPurpose,
  method: 'GET' | 'POST',
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
  body?: string,
): CommandCodeUpstreamRequest {
  const request = Object.freeze({
    purpose,
    url: `${COMMANDCODE_API_ORIGIN}${COMMANDCODE_UPSTREAM_PATHS[purpose]}`,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
    policy: policyOf(snapshot, purpose),
  });
  ISSUED_UPSTREAM_REQUESTS.add(request);
  return request;
}

/**
 * Reject structurally forged requests before a network executor observes secrets.
 * Requests are intentionally process-local and must come from the builders above.
 */
export function assertCommandCodeUpstreamRequest(
  value: unknown,
): asserts value is CommandCodeUpstreamRequest {
  if (
    (typeof value !== 'object' || value === null)
    || !ISSUED_UPSTREAM_REQUESTS.has(value)
  ) {
    throw new CommandCodeRequestError(
      'transport',
      'request must be created by a CommandCode upstream request builder',
    );
  }
}

function buildGenerateFromObject(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  input: object,
  traceparent: string,
): CommandCodeUpstreamRequest {
  const signal = signalValue(input);
  throwIfAborted(signal);
  const apiKey = apiKeyValue(input);
  const sessionId = sessionIdValue(input);
  const hostZdrOverride = hostZdrOverrideValue(input);
  const body = orderedGenerateBody(
    requiredValue(input, 'wireBody', 'wireBody'),
    sessionId,
  );
  const entries: Array<readonly [string, string]> = [
    ['Content-Type', 'application/json'],
    ['User-Agent', COMMANDCODE_USER_AGENT],
    ['x-command-code-version', COMMANDCODE_PROTOCOL_VERSION],
    ['x-cli-environment', COMMANDCODE_CLI_ENVIRONMENT],
    ['x-project-slug', snapshot.deviceProfile.projectSlug],
    ['x-taste-learning', 'false'],
    ['x-session-id', sessionId],
    ['Authorization', `Bearer ${apiKey}`],
    ['traceparent', traceparentValue(traceparent)],
  ];
  if (snapshot.zdr || hostZdrOverride) entries.push(['x-cmd-zdr', '1']);
  return preparedRequest(snapshot, 'generate', 'POST', headersOf(entries), signal, body);
}

function buildFingerprintFromObject(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  input: object,
): CommandCodeUpstreamRequest {
  const signal = signalValue(input);
  throwIfAborted(signal);
  const apiKey = apiKeyValue(input);
  const fingerprint = requiredValue(input, 'fingerprint', 'fingerprint');
  if (
    typeof fingerprint !== 'object'
    || fingerprint === null
    || nodeUtilTypes.isProxy(fingerprint)
    || Array.isArray(fingerprint)
  ) {
    return invalid('fingerprint', 'expected a JSON object');
  }
  const entries: Array<readonly [string, string]> = [
    ['Content-Type', 'application/json'],
    ['x-cli-environment', COMMANDCODE_CLI_ENVIRONMENT],
    ['Authorization', `Bearer ${apiKey}`],
    ['x-command-code-version', COMMANDCODE_PROTOCOL_VERSION],
  ];
  if (snapshot.zdr) entries.push(['x-cmd-zdr', '1']);
  return preparedRequest(
    snapshot,
    'fingerprint',
    'POST',
    headersOf(entries),
    signal,
    serializeStrictJson(fingerprint, 'fingerprint'),
  );
}

function buildLifecycleFromObject(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  input: object,
): CommandCodeUpstreamRequest {
  const signal = signalValue(input);
  throwIfAborted(signal);
  const apiKey = apiKeyValue(input);
  const lifecycleSessionId = lifecycleSessionIdValue(input);
  const entries: Array<readonly [string, string]> = [
    ['Content-Type', 'application/json'],
    ['x-cli-environment', COMMANDCODE_CLI_ENVIRONMENT],
    ['Authorization', `Bearer ${apiKey}`],
    ['x-command-code-version', COMMANDCODE_PROTOCOL_VERSION],
  ];
  if (snapshot.zdr) entries.push(['x-cmd-zdr', '1']);
  return preparedRequest(
    snapshot,
    'lifecycle',
    'POST',
    headersOf(entries),
    signal,
    serializeStrictJson({
      eventType: 'cli_session_exists',
      metadata: {
        sessionId: lifecycleSessionId,
        cliVersion: COMMANDCODE_PROTOCOL_VERSION,
        mode: snapshot.cliSessionMode,
        os: `${snapshot.deviceProfile.platform}-${snapshot.deviceProfile.arch}`,
      },
    }, 'wireBody'),
  );
}

function buildModelsFromObject(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  input: object,
): CommandCodeUpstreamRequest {
  const signal = signalValue(input);
  throwIfAborted(signal);
  const apiKey = apiKeyValue(input);
  return preparedRequest(snapshot, 'models', 'GET', headersOf([
    ['Authorization', `Bearer ${apiKey}`],
    ['x-cli-environment', COMMANDCODE_CLI_ENVIRONMENT],
    ['x-command-code-version', COMMANDCODE_PROTOCOL_VERSION],
  ]), signal);
}

export function buildCommandCodeGenerateRequest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  rawInput: CommandCodeGenerateBuilderInput,
): CommandCodeUpstreamRequest {
  const input = plainInputObject(rawInput);
  const signal = signalValue(input);
  throwIfAborted(signal);
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return buildGenerateFromObject(
    snapshot,
    input,
    traceparentValue(requiredValue(input, 'traceparent', 'traceparent')),
  );
}

export function buildCommandCodeFingerprintRequest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  rawInput: CommandCodeFingerprintInput,
): CommandCodeUpstreamRequest {
  const input = plainInputObject(rawInput);
  throwIfAborted(signalValue(input));
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return buildFingerprintFromObject(snapshot, input);
}

export function buildCommandCodeLifecycleRequest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  rawInput: CommandCodeLifecycleInput,
): CommandCodeUpstreamRequest {
  const input = plainInputObject(rawInput);
  throwIfAborted(signalValue(input));
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return buildLifecycleFromObject(snapshot, input);
}

export function buildCommandCodeModelsRequest(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  rawInput: CommandCodeModelsInput,
): CommandCodeUpstreamRequest {
  const input = plainInputObject(rawInput);
  throwIfAborted(signalValue(input));
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  return buildModelsFromObject(snapshot, input);
}

function requestSnapshot(
  readConfigSources: () => CommandCodeRuntimeConfigSources,
  signal: AbortSignal | undefined,
  proxySupport: CommandCodeProxySupport,
): CommandCodeRuntimeConfigSnapshot {
  throwIfAborted(signal);
  let sources: CommandCodeRuntimeConfigSources;
  try {
    sources = readConfigSources();
  } catch {
    throwIfAborted(signal);
    return invalid('configSource', 'failed to read configuration');
  }
  throwIfAborted(signal);
  const snapshot = createCommandCodeRuntimeConfigSnapshot(sources);
  throwIfAborted(signal);
  if (snapshot.upstreamProxy && proxySupport !== 'loopback-http-connect') {
    return invalid('transport', 'does not support the configured upstream proxy');
  }
  return snapshot;
}

function transportParts<TResponse>(
  rawTransport: CommandCodeUpstreamTransport<TResponse>,
): Readonly<{
  execute: CommandCodeUpstreamTransport<TResponse>['execute'];
  proxySupport: CommandCodeProxySupport;
}> {
  if (
    typeof rawTransport !== 'object'
    || rawTransport === null
    || nodeUtilTypes.isProxy(rawTransport)
    || Array.isArray(rawTransport)
  ) {
    return invalid('transport', 'expected a plain transport descriptor');
  }
  let prototype: object | null;
  let executeDescriptor: PropertyDescriptor | undefined;
  let proxyDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(rawTransport) as object | null;
    executeDescriptor = Object.getOwnPropertyDescriptor(rawTransport, 'execute');
    proxyDescriptor = Object.getOwnPropertyDescriptor(rawTransport, 'proxySupport');
  } catch {
    return invalid('transport', 'could not inspect the transport descriptor');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid('transport', 'expected a plain transport descriptor');
  }
  if (!executeDescriptor || !('value' in executeDescriptor) || typeof executeDescriptor.value !== 'function') {
    return invalid('transport', 'execute must be an own data function');
  }
  if (!proxyDescriptor || !('value' in proxyDescriptor)) {
    return invalid('proxySupport', 'must be an own data value');
  }
  if (
    proxyDescriptor.value !== 'none'
    && proxyDescriptor.value !== 'loopback-http-connect'
  ) {
    return invalid('proxySupport', 'has an invalid value');
  }
  return Object.freeze({
    execute: executeDescriptor.value as CommandCodeUpstreamTransport<TResponse>['execute'],
    proxySupport: proxyDescriptor.value as CommandCodeProxySupport,
  });
}

function transportExecutor<TResponse>(
  executeTransport: CommandCodeUpstreamTransport<TResponse>['execute'],
): (request: CommandCodeUpstreamRequest) => Promise<TResponse> {
  return async (request: CommandCodeUpstreamRequest): Promise<TResponse> => {
    throwIfAborted(request.signal);
    let response: TResponse;
    try {
      response = await executeTransport(request);
    } catch (error) {
      if (request.signal?.aborted) throw new CommandCodeAbortError();
      throw error;
    }
    throwIfAborted(request.signal);
    return response;
  };
}

function generatedTraceparent(
  createTraceparent: () => string,
  signal: AbortSignal | undefined,
): string {
  let traceparent: unknown;
  try {
    traceparent = createTraceparent();
  } catch {
    throwIfAborted(signal);
    return invalid('traceparent', 'factory failed');
  }
  throwIfAborted(signal);
  return traceparentValue(traceparent);
}

/**
 * Bind all upstream operations to one already-validated configuration snapshot.
 *
 * Runtime-level operations use this client so their initialization and primary
 * request cannot observe different configuration reads. Transport capabilities
 * are inspected once, at construction, and a configured proxy fails closed
 * before any operation can expose credentials to the executor.
 */
export function createCommandCodeSnapshotClient<TResponse = unknown>(
  snapshot: CommandCodeRuntimeConfigSnapshot,
  transport: CommandCodeUpstreamTransport<TResponse>,
  createTraceparent: () => string,
): Readonly<CommandCodeUpstreamClient<TResponse>> {
  assertCommandCodeRuntimeConfigSnapshot(snapshot);
  if (typeof createTraceparent !== 'function') invalid('traceparent', 'expected a factory function');
  const { execute: executeTransport, proxySupport } = transportParts(transport);
  if (snapshot.upstreamProxy && proxySupport !== 'loopback-http-connect') {
    invalid('transport', 'does not support the configured upstream proxy');
  }
  const execute = transportExecutor(executeTransport);

  return Object.freeze({
    async generate(rawInput: CommandCodeGenerateInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      const request = buildGenerateFromObject(
        snapshot,
        input,
        generatedTraceparent(createTraceparent, signal),
      );
      return await execute(request);
    },

    async recordFingerprint(rawInput: CommandCodeFingerprintInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      return await execute(buildFingerprintFromObject(snapshot, input));
    },

    async sendLifecycleEvent(rawInput: CommandCodeLifecycleInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      return await execute(buildLifecycleFromObject(snapshot, input));
    },

    async listModels(rawInput: CommandCodeModelsInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      return await execute(buildModelsFromObject(snapshot, input));
    },
  });
}

export function createCommandCodeUpstreamClient<TResponse = unknown>(
  readConfigSources: () => CommandCodeRuntimeConfigSources,
  transport: CommandCodeUpstreamTransport<TResponse>,
  createTraceparent: () => string,
): Readonly<CommandCodeUpstreamClient<TResponse>> {
  if (typeof readConfigSources !== 'function') invalid('configSource', 'expected a function');
  if (typeof createTraceparent !== 'function') invalid('traceparent', 'expected a factory function');
  const { execute: executeTransport, proxySupport } = transportParts(transport);
  const execute = transportExecutor(executeTransport);

  return Object.freeze({
    async generate(rawInput: CommandCodeGenerateInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      const snapshot = requestSnapshot(readConfigSources, signal, proxySupport);
      const request = buildGenerateFromObject(
        snapshot,
        input,
        generatedTraceparent(createTraceparent, signal),
      );
      return await execute(request);
    },

    async recordFingerprint(rawInput: CommandCodeFingerprintInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      const snapshot = requestSnapshot(readConfigSources, signal, proxySupport);
      return await execute(buildFingerprintFromObject(snapshot, input));
    },

    async sendLifecycleEvent(rawInput: CommandCodeLifecycleInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      const snapshot = requestSnapshot(readConfigSources, signal, proxySupport);
      return await execute(buildLifecycleFromObject(snapshot, input));
    },

    async listModels(rawInput: CommandCodeModelsInput): Promise<TResponse> {
      const input = plainInputObject(rawInput);
      const signal = signalValue(input);
      throwIfAborted(signal);
      const snapshot = requestSnapshot(readConfigSources, signal, proxySupport);
      return await execute(buildModelsFromObject(snapshot, input));
    },
  });
}
