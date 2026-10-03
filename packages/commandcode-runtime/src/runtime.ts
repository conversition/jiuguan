/*
 * Runtime lifecycle behavior adapted from commandcode-proxy 1.0.0.
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: explicit instances, isolation, singleflight and disposal.
 */
import { performance } from 'node:perf_hooks';
import { types as nodeUtilTypes } from 'node:util';
import {
  createCommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSources,
} from './config.ts';
import {
  commandCodeNodeEntropy,
  createCommandCodeJitter,
  createCommandCodeLifecycleSessionId,
  createCommandCodeRuntimePepper,
  createCommandCodeTraceparent,
  createCommandCodeUuid,
  deriveCommandCodeDeviceFingerprint,
  deriveCommandCodeIdentitySignature,
  deriveCommandCodeModelScopeSignature,
  deriveCommandCodeRuntimeCredentialId,
  type CommandCodeEntropySource,
} from './identity.ts';
import {
  buildCommandCodeGenerateRequest,
  CommandCodeAbortError,
  createCommandCodeSnapshotClient,
  type CommandCodeUpstreamTransport,
} from './transport.ts';

const SESSION_ID_PATTERN = /^[\x21-\x7e]{8,256}$/;
const MODEL_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const MODEL_BODY_LIMIT_BYTES = 1_024 * 1_024;
const MODEL_LIMIT = 1_000;
const INITIALIZATION_RETRY_MS = 5_000;
const MODEL_RETRY_MS = 30_000;
const MODEL_STALE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_STATE_ENTRIES = 256;
const MISSING = Symbol('missing-runtime-value');

export type CommandCodeRuntimePhase = 'active' | 'draining' | 'disposed';
export type CommandCodeRuntimeErrorCode =
  | 'COMMANDCODE_RUNTIME_INVALID'
  | 'COMMANDCODE_RUNTIME_NOT_ACTIVE'
  | 'COMMANDCODE_RUNTIME_DISPOSED'
  | 'COMMANDCODE_RUNTIME_CONFIG_READ_FAILED'
  | 'COMMANDCODE_RUNTIME_UPSTREAM_FAILED'
  | 'COMMANDCODE_RUNTIME_RESPONSE_INVALID'
  | 'COMMANDCODE_RUNTIME_CLOCK_INVALID'
  | 'COMMANDCODE_RUNTIME_CAPACITY_EXCEEDED';

const ERROR_MESSAGES: Readonly<Record<CommandCodeRuntimeErrorCode, string>> = Object.freeze({
  COMMANDCODE_RUNTIME_INVALID: 'Invalid CommandCode runtime input',
  COMMANDCODE_RUNTIME_NOT_ACTIVE: 'CommandCode runtime is not accepting new work',
  COMMANDCODE_RUNTIME_DISPOSED: 'CommandCode runtime has been disposed',
  COMMANDCODE_RUNTIME_CONFIG_READ_FAILED: 'CommandCode runtime configuration could not be read',
  COMMANDCODE_RUNTIME_UPSTREAM_FAILED: 'CommandCode upstream request failed',
  COMMANDCODE_RUNTIME_RESPONSE_INVALID: 'CommandCode upstream response was invalid',
  COMMANDCODE_RUNTIME_CLOCK_INVALID: 'CommandCode runtime clock returned an invalid value',
  COMMANDCODE_RUNTIME_CAPACITY_EXCEEDED: 'CommandCode runtime state capacity was exceeded',
});

export class CommandCodeRuntimeError extends Error {
  constructor(readonly code: CommandCodeRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CommandCodeRuntimeError';
  }
}

export interface CommandCodeModel { readonly id: string }
export interface CommandCodeRuntimeGenerateInput {
  readonly apiKey: string;
  /** Trusted PC-host override. Never map an untrusted browser header here directly. */
  readonly sessionId?: string;
  readonly promptCacheKey?: string;
  readonly wireBody: unknown;
  readonly hostZdrOverride?: boolean;
  readonly signal?: AbortSignal;
}
export interface CommandCodeRuntimeModelsInput {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}
export interface CommandCodeRuntimeOptions {
  readonly readConfigSources: () => CommandCodeRuntimeConfigSources;
  readonly transport: CommandCodeUpstreamTransport<Response>;
  readonly now?: () => number;
  readonly entropy?: CommandCodeEntropySource;
}
export interface CommandCodeRuntimeStateSnapshot {
  readonly phase: CommandCodeRuntimePhase;
  readonly activeOperations: number;
  readonly sessionEntries: number;
  readonly initializationEntries: number;
  readonly modelEntries: number;
}
export interface CommandCodeRuntime {
  generate(input: CommandCodeRuntimeGenerateInput): Promise<Response>;
  listModels(input: CommandCodeRuntimeModelsInput): Promise<readonly CommandCodeModel[]>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): Readonly<CommandCodeRuntimeStateSnapshot>;
}

interface ParsedGenerateInput {
  readonly apiKey: string;
  readonly sessionId?: string;
  readonly promptCacheKey?: string;
  readonly wireBody: unknown;
  readonly hostZdrOverride?: boolean;
  readonly signal?: AbortSignal;
}
interface SessionState { readonly id: string; readonly expiresAt: number }
interface InitializationState {
  readonly fingerprint: ReturnType<typeof deriveCommandCodeDeviceFingerprint>;
  expiresAt: number;
  retryAt: number;
  flight?: Promise<boolean>;
}
interface ModelState {
  value?: readonly CommandCodeModel[];
  fetchedAt: number;
  retryAt: number;
  flight?: Promise<readonly CommandCodeModel[]>;
}
interface LinkedSignal { readonly signal: AbortSignal; cleanup(): void }
interface TrackedBody { cancel(): Promise<void> }

const FALLBACK_MODEL_IDS = Object.freeze([
  'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-haiku-4-5-20251001', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.3-codex', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
  'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5', 'zai-org/GLM-5.1',
  'zai-org/GLM-5', 'MiniMaxAI/MiniMax-M3', 'MiniMaxAI/MiniMax-M2.7',
  'MiniMaxAI/MiniMax-M2.5', 'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Max', 'stepfun/Step-3.7-Flash', 'stepfun/Step-3.5-Flash',
  'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5', 'google/gemini-3.5-flash',
  'google/gemini-3.1-flash-lite',
] as const);
export const COMMANDCODE_FALLBACK_MODELS: readonly CommandCodeModel[] = Object.freeze(
  FALLBACK_MODEL_IDS.map((id) => Object.freeze({ id })),
);

function invalid(): never {
  throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_INVALID');
}
function plainDataObject(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) return invalid();
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return invalid();
  } catch {
    return invalid();
  }
  return value;
}
function ownDataValue(input: object, key: string): unknown | typeof MISSING {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) return MISSING;
    if (!('value' in descriptor)) return invalid();
    return descriptor.value;
  } catch {
    return invalid();
  }
}
function requiredDataValue(input: object, key: string): unknown {
  const value = ownDataValue(input, key);
  if (value === MISSING || value === undefined) return invalid();
  return value;
}
function optionalFunction(input: object, key: string): Function | undefined {
  const value = ownDataValue(input, key);
  if (value === MISSING || value === undefined) return undefined;
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) return invalid();
  return value;
}
function optionalSessionValue(input: object, key: string): string | undefined {
  const value = ownDataValue(input, key);
  if (value === MISSING || value === undefined) return undefined;
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) return invalid();
  return value;
}
function signalValue(input: object): AbortSignal | undefined {
  const value = ownDataValue(input, 'signal');
  if (value === MISSING || value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || !(value instanceof AbortSignal)) return invalid();
  return value;
}
function parseGenerateInput(value: CommandCodeRuntimeGenerateInput): ParsedGenerateInput {
  const input = plainDataObject(value);
  const signal = signalValue(input);
  if (signal?.aborted) throw new CommandCodeAbortError();
  const apiKey = requiredDataValue(input, 'apiKey');
  const hostZdrOverride = ownDataValue(input, 'hostZdrOverride');
  if (typeof apiKey !== 'string') return invalid();
  if (hostZdrOverride !== MISSING && hostZdrOverride !== undefined
    && typeof hostZdrOverride !== 'boolean') return invalid();
  return Object.freeze({
    apiKey,
    sessionId: optionalSessionValue(input, 'sessionId'),
    promptCacheKey: optionalSessionValue(input, 'promptCacheKey'),
    wireBody: requiredDataValue(input, 'wireBody'),
    ...(hostZdrOverride === true ? { hostZdrOverride: true } : {}),
    ...(signal ? { signal } : {}),
  });
}
function parseModelsInput(value: CommandCodeRuntimeModelsInput): Readonly<{
  apiKey: string; signal?: AbortSignal;
}> {
  const input = plainDataObject(value);
  const signal = signalValue(input);
  if (signal?.aborted) throw new CommandCodeAbortError();
  const apiKey = requiredDataValue(input, 'apiKey');
  if (typeof apiKey !== 'string') return invalid();
  return Object.freeze({ apiKey, ...(signal ? { signal } : {}) });
}
function fixedTransport(value: unknown): Readonly<CommandCodeUpstreamTransport<Response>> {
  const descriptor = plainDataObject(value);
  const execute = requiredDataValue(descriptor, 'execute');
  const proxySupport = requiredDataValue(descriptor, 'proxySupport');
  if (typeof execute !== 'function' || nodeUtilTypes.isProxy(execute)) return invalid();
  if (proxySupport !== 'none' && proxySupport !== 'loopback-http-connect') return invalid();
  return Object.freeze({
    execute: execute as CommandCodeUpstreamTransport<Response>['execute'],
    proxySupport,
  });
}
function isResponse(value: unknown): value is Response {
  try { return value instanceof Response; } catch { return false; }
}
async function cancelResponse(response: unknown): Promise<void> {
  if (!isResponse(response) || !response.body || response.body.locked) return;
  try { await response.body.cancel(); } catch { /* best effort */ }
}

function touchState<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function insertBoundedState<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  isBusy: (candidate: V) => boolean,
): void {
  if (!map.has(key) && map.size >= MAX_STATE_ENTRIES) {
    for (const [candidateKey, candidate] of map) {
      if (isBusy(candidate)) continue;
      map.delete(candidateKey);
      break;
    }
  }
  if (!map.has(key) && map.size >= MAX_STATE_ENTRIES) {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_CAPACITY_EXCEEDED');
  }
  touchState(map, key, value);
}

function parseModelPayload(value: unknown): readonly CommandCodeModel[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'data');
  if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)
    || descriptor.value.length === 0 || descriptor.value.length > MODEL_LIMIT) {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  }
  const seen = new Set<string>();
  const models: CommandCodeModel[] = [];
  for (const rawItem of descriptor.value as unknown[]) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)
      || nodeUtilTypes.isProxy(rawItem)) {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
    }
    const idDescriptor = Object.getOwnPropertyDescriptor(rawItem, 'id');
    if (!idDescriptor || !('value' in idDescriptor)
      || typeof idDescriptor.value !== 'string'
      || !MODEL_ID_PATTERN.test(idDescriptor.value)) {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
    }
    if (seen.has(idDescriptor.value)) continue;
    seen.add(idDescriptor.value);
    models.push(Object.freeze({ id: idDescriptor.value }));
  }
  if (models.length === 0) {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  }
  return Object.freeze(models);
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_DISPOSED');
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MODEL_BODY_LIMIT_BYTES) {
        throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    try { await reader.cancel(); } catch { /* fixed error below */ }
    if (error instanceof CommandCodeRuntimeError) throw error;
    throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
  } finally {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export function createCommandCodeRuntime(
  rawOptions: CommandCodeRuntimeOptions,
): Readonly<CommandCodeRuntime> {
  const options = plainDataObject(rawOptions);
  const readConfigSources = requiredDataValue(options, 'readConfigSources');
  if (typeof readConfigSources !== 'function' || nodeUtilTypes.isProxy(readConfigSources)) {
    return invalid();
  }
  const transport = fixedTransport(requiredDataValue(options, 'transport'));
  const rawNow = optionalFunction(options, 'now');
  const rawEntropy = optionalFunction(options, 'entropy');
  const nowSource = (rawNow ?? (() => performance.now())) as () => number;
  const entropy = (rawEntropy ?? commandCodeNodeEntropy) as CommandCodeEntropySource;
  const runtimePepper = createCommandCodeRuntimePepper(entropy);

  let phase: CommandCodeRuntimePhase = 'active';
  let activeOperations = 0;
  let lastNow = -Infinity;
  let drainPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  const idleResolvers = new Set<() => void>();
  const sessions = new Map<string, SessionState>();
  const initializations = new Map<string, InitializationState>();
  const models = new Map<string, ModelState>();
  const runtimeAbortSubscribers = new Set<() => void>();
  const trackedBodies = new Set<TrackedBody>();

  const runtimeNow = (): number => {
    let value: unknown;
    try { value = nowSource(); } catch {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_CLOCK_INVALID');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)
      || value < 0 || value < lastNow) {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_CLOCK_INVALID');
    }
    lastNow = value;
    return value;
  };
  const settleIdle = (): void => {
    if (activeOperations !== 0) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };
  const acquire = (admission: boolean): (() => void) => {
    if (phase === 'disposed') {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_DISPOSED');
    }
    if (admission && phase !== 'active') {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_NOT_ACTIVE');
    }
    activeOperations++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeOperations--;
      settleIdle();
    };
  };
  const whenIdle = (): Promise<void> => {
    if (activeOperations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { idleResolvers.add(resolve); });
  };
  const throwIfStopped = (callerSignal?: AbortSignal): void => {
    if (phase === 'disposed') {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_DISPOSED');
    }
    if (callerSignal?.aborted) throw new CommandCodeAbortError();
  };
  const captureSnapshot = (callerSignal?: AbortSignal): CommandCodeRuntimeConfigSnapshot => {
    throwIfStopped(callerSignal);
    let sources: CommandCodeRuntimeConfigSources;
    try {
      sources = (readConfigSources as () => CommandCodeRuntimeConfigSources)();
    } catch {
      throwIfStopped(callerSignal);
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_CONFIG_READ_FAILED');
    }
    throwIfStopped(callerSignal);
    const snapshot = createCommandCodeRuntimeConfigSnapshot(sources);
    throwIfStopped(callerSignal);
    return snapshot;
  };
  const assertSnapshotTransport = (snapshot: CommandCodeRuntimeConfigSnapshot): void => {
    if (snapshot.upstreamProxy && transport.proxySupport !== 'loopback-http-connect') {
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_UPSTREAM_FAILED');
    }
  };
  const linkedSignal = (callerSignal?: AbortSignal): LinkedSignal => {
    const controller = new AbortController();
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    runtimeAbortSubscribers.add(abort);
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (phase === 'disposed' || callerSignal?.aborted) abort();
    let cleaned = false;
    return Object.freeze({
      signal: controller.signal,
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        runtimeAbortSubscribers.delete(abort);
        callerSignal?.removeEventListener('abort', abort);
      },
    });
  };
  const awaitShared = <T>(promise: Promise<T>, callerSignal?: AbortSignal): Promise<T> => {
    try { throwIfStopped(callerSignal); } catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        runtimeAbortSubscribers.delete(onRuntimeAbort);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onRuntimeAbort = (): void => finish(() => reject(
        new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_DISPOSED'),
      ));
      const onCallerAbort = (): void => finish(() => reject(new CommandCodeAbortError()));
      runtimeAbortSubscribers.add(onRuntimeAbort);
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      if (phase === 'disposed') return onRuntimeAbort();
      if (callerSignal?.aborted) return onCallerAbort();
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  };

  const sweepExpired = (at: number): void => {
    const expiredCredentials = new Set<string>();
    for (const [credentialId, session] of sessions) {
      if (session.expiresAt <= at) {
        sessions.delete(credentialId);
        expiredCredentials.add(credentialId);
      }
    }
    for (const [scope, state] of initializations) {
      const credentialId = scope.slice(0, 64);
      if (!state.flight && (expiredCredentials.has(credentialId)
        || (state.expiresAt <= at && state.retryAt <= at))) {
        initializations.delete(scope);
      }
    }
    for (const [scope, state] of models) {
      if (!state.flight && (
        (!state.value && state.retryAt <= at)
        || (state.value && state.fetchedAt + MODEL_STALE_RETENTION_MS <= at)
      )) {
        models.delete(scope);
      }
    }
  };

  const resolveSession = (
    credentialId: string,
    snapshot: CommandCodeRuntimeConfigSnapshot,
    at: number,
    override?: string,
    promptCacheKey?: string,
  ): string => {
    if (override) return override;
    if (promptCacheKey) return promptCacheKey;
    const existing = sessions.get(credentialId);
    if (existing && existing.expiresAt > at) {
      touchState(sessions, credentialId, existing);
      return existing.id;
    }
    const id = createCommandCodeUuid(entropy);
    const expiresAt = at + snapshot.sessionTtlMs
      + createCommandCodeJitter(snapshot.sessionJitterMs, entropy);
    insertBoundedState(
      sessions,
      credentialId,
      Object.freeze({ id, expiresAt }),
      () => false,
    );
    // Capacity eviction is not TTL expiry: a still-valid initialization may be reused.
    return id;
  };

  const initializationFlight = (
    scope: string,
    state: InitializationState,
    snapshot: CommandCodeRuntimeConfigSnapshot,
    apiKey: string,
  ): Promise<boolean> => {
    if (state.flight) return state.flight;
    const release = acquire(false);
    let flightSignal: LinkedSignal | undefined;
    let flight!: Promise<boolean>;
    flight = Promise.resolve().then(async (): Promise<boolean> => {
      let success = false;
      try {
        flightSignal = linkedSignal();
        const client = createCommandCodeSnapshotClient(
          snapshot,
          transport,
          () => createCommandCodeTraceparent(entropy),
        );
        const lifecycleSessionId = createCommandCodeLifecycleSessionId(entropy);
        const results = await Promise.allSettled([
          client.recordFingerprint({
            apiKey,
            fingerprint: state.fingerprint,
            signal: flightSignal.signal,
          }),
          client.sendLifecycleEvent({
            apiKey,
            lifecycleSessionId,
            signal: flightSignal.signal,
          }),
        ]);
        const checks = await Promise.all(results.map(async (result): Promise<boolean> => {
          if (result.status !== 'fulfilled' || !isResponse(result.value)) return false;
          const ok = result.value.ok;
          await cancelResponse(result.value);
          return ok;
        }));
        success = checks.every(Boolean);
        const completedAt = runtimeNow();
        if (phase !== 'disposed' && initializations.get(scope) === state) {
          if (success) {
            state.expiresAt = completedAt + snapshot.initializationTtlMs
              + createCommandCodeJitter(snapshot.initializationJitterMs, entropy);
            state.retryAt = 0;
          } else {
            state.expiresAt = 0;
            state.retryAt = completedAt + INITIALIZATION_RETRY_MS;
          }
        }
      } catch {
        if (phase !== 'disposed' && initializations.get(scope) === state) {
          let completedAt: number;
          try { completedAt = runtimeNow(); } catch { completedAt = state.retryAt; }
          state.expiresAt = 0;
          state.retryAt = completedAt + INITIALIZATION_RETRY_MS;
        }
      } finally {
        flightSignal?.cleanup();
        if (initializations.get(scope) === state && state.flight === flight) {
          state.flight = undefined;
        }
        release();
      }
      return success;
    });
    state.flight = flight;
    return flight;
  };

  const ensureInitialized = async (
    snapshot: CommandCodeRuntimeConfigSnapshot,
    credentialId: string,
    apiKey: string,
    callerSignal?: AbortSignal,
  ): Promise<void> => {
    const at = runtimeNow();
    const scope = `${credentialId}:${deriveCommandCodeIdentitySignature(snapshot)}`;
    let state = initializations.get(scope);
    if (!state) {
      state = {
        fingerprint: deriveCommandCodeDeviceFingerprint(snapshot, apiKey),
        expiresAt: 0,
        retryAt: 0,
      };
      insertBoundedState(initializations, scope, state, (candidate) => Boolean(candidate.flight));
    } else {
      touchState(initializations, scope, state);
    }
    if (state.expiresAt > at || state.retryAt > at) return;
    await awaitShared(initializationFlight(scope, state, snapshot, apiKey), callerSignal);
  };

  const modelFlight = (
    scope: string,
    state: ModelState,
    snapshot: CommandCodeRuntimeConfigSnapshot,
    apiKey: string,
  ): Promise<readonly CommandCodeModel[]> => {
    if (state.flight) return state.flight;
    const release = acquire(false);
    let flightSignal: LinkedSignal | undefined;
    const stale = state.value;
    let flight!: Promise<readonly CommandCodeModel[]>;
    flight = Promise.resolve().then(async (): Promise<readonly CommandCodeModel[]> => {
      try {
        flightSignal = linkedSignal();
        const client = createCommandCodeSnapshotClient(
          snapshot,
          transport,
          () => createCommandCodeTraceparent(entropy),
        );
        const response = await client.listModels({
          apiKey,
          signal: flightSignal.signal,
        });
        if (!isResponse(response) || !response.ok) {
          await cancelResponse(response);
          throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
        }
        const text = await readBoundedResponseText(response, flightSignal.signal);
        let payload: unknown;
        try { payload = JSON.parse(text) as unknown; } catch {
          throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
        }
        const value = parseModelPayload(payload);
        const completedAt = runtimeNow();
        if (phase !== 'disposed' && models.get(scope) === state) {
          state.value = value;
          state.fetchedAt = completedAt;
          state.retryAt = 0;
        }
        return value;
      } catch {
        if (phase !== 'disposed' && models.get(scope) === state) {
          let completedAt: number;
          try { completedAt = runtimeNow(); } catch { completedAt = state.retryAt; }
          state.retryAt = completedAt + MODEL_RETRY_MS;
        }
        return stale ?? COMMANDCODE_FALLBACK_MODELS;
      } finally {
        flightSignal?.cleanup();
        if (models.get(scope) === state && state.flight === flight) {
          state.flight = undefined;
        }
        release();
      }
    });
    state.flight = flight;
    return flight;
  };

  const trackResponse = (
    response: Response,
    linked: LinkedSignal,
    release: () => void,
  ): Response => {
    if (!response.body) {
      linked.cleanup();
      release();
      return response;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = response.body.getReader(); } catch {
      linked.cleanup();
      release();
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
    }
    let finished = false;
    let cancelPromise: Promise<void> | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let tracked!: TrackedBody;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      linked.signal.removeEventListener('abort', onAbort);
      linked.cleanup();
      trackedBodies.delete(tracked);
      try { reader.releaseLock(); } catch { /* pending/terminal reader needs no action */ }
      release();
    };
    const cancelUpstream = (): Promise<void> => {
      if (cancelPromise) return cancelPromise;
      if (finished) return Promise.resolve();
      try {
        cancelPromise = Promise.resolve(reader.cancel())
          .then(() => undefined, () => undefined)
          .finally(finish);
      } catch {
        finish();
        cancelPromise = Promise.resolve();
      }
      return cancelPromise;
    };
    const abortError = (): Error => (
      phase === 'disposed'
        ? new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_DISPOSED')
        : new CommandCodeAbortError()
    );
    const onAbort = (): void => {
      if (finished) return;
      try { bodyController?.error(abortError()); } catch { /* already terminal */ }
      void cancelUpstream();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        bodyController = controller;
      },
      async pull(controller): Promise<void> {
        if (finished) return controller.close();
        if (linked.signal.aborted) return onAbort();
        try {
          const chunk = await reader.read();
          if (linked.signal.aborted) return onAbort();
          if (chunk.done) {
            controller.close();
            finish();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch {
          if (linked.signal.aborted) {
            onAbort();
          } else {
            controller.error(new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_UPSTREAM_FAILED'));
            finish();
          }
        }
      },
      async cancel(): Promise<void> { await cancelUpstream(); },
    });
    tracked = Object.freeze({ cancel: cancelUpstream });
    trackedBodies.add(tracked);
    linked.signal.addEventListener('abort', onAbort, { once: true });
    if (linked.signal.aborted) onAbort();
    try {
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      void cancelUpstream();
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
    }
  };

  const generate = async (
    rawInput: CommandCodeRuntimeGenerateInput,
  ): Promise<Response> => {
    const releaseAdmission = acquire(true);
    let admissionTransferred = false;
    let linked: LinkedSignal | undefined;
    try {
      const input = parseGenerateInput(rawInput);
      throwIfStopped(input.signal);
      const snapshot = captureSnapshot(input.signal);
      assertSnapshotTransport(snapshot);
      const at = runtimeNow();
      sweepExpired(at);
      const credentialId = deriveCommandCodeRuntimeCredentialId(input.apiKey, runtimePepper);
      const sessionId = resolveSession(
        credentialId, snapshot, at, input.sessionId, input.promptCacheKey,
      );
      linked = linkedSignal(input.signal);
      const request = buildCommandCodeGenerateRequest(snapshot, {
        apiKey: input.apiKey,
        sessionId,
        traceparent: createCommandCodeTraceparent(entropy),
        wireBody: input.wireBody,
        ...(input.hostZdrOverride ? { hostZdrOverride: true } : {}),
        signal: linked.signal,
      });
      await ensureInitialized(snapshot, credentialId, input.apiKey, input.signal);
      throwIfStopped(input.signal);
      const releaseNetwork = acquire(false);
      let abandoned = false;
      let lateResponse: Response | undefined;
      const networkPromise = Promise.resolve().then(async (): Promise<Response> => {
        if (linked!.signal.aborted) throw new CommandCodeAbortError();
        return await transport.execute(request);
      }).then(
        async (response): Promise<Response> => {
          if (!isResponse(response)) {
            releaseNetwork();
            throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_RESPONSE_INVALID');
          }
          lateResponse = response;
          if (abandoned) {
            await cancelResponse(response);
            releaseNetwork();
            throw new CommandCodeAbortError();
          }
          releaseNetwork();
          return response;
        },
        (error: unknown): never => {
          releaseNetwork();
          throw error;
        },
      );
      void networkPromise.catch(() => undefined);
      let response: Response;
      try {
        response = await awaitShared(networkPromise, input.signal);
      } catch (error) {
        abandoned = true;
        if (lateResponse) await cancelResponse(lateResponse);
        throw error;
      }
      throwIfStopped(input.signal);
      const tracked = trackResponse(response, linked, releaseAdmission);
      admissionTransferred = true;
      linked = undefined;
      return tracked;
    } catch (error) {
      linked?.cleanup();
      if (error instanceof CommandCodeRuntimeError || error instanceof CommandCodeAbortError) {
        throw error;
      }
      throw new CommandCodeRuntimeError('COMMANDCODE_RUNTIME_UPSTREAM_FAILED');
    } finally {
      if (!admissionTransferred) releaseAdmission();
    }
  };

  const listModels = async (
    rawInput: CommandCodeRuntimeModelsInput,
  ): Promise<readonly CommandCodeModel[]> => {
    const release = acquire(true);
    try {
      const input = parseModelsInput(rawInput);
      throwIfStopped(input.signal);
      const snapshot = captureSnapshot(input.signal);
      const at = runtimeNow();
      sweepExpired(at);
      if (!snapshot.useProviderModels) return COMMANDCODE_FALLBACK_MODELS;
      assertSnapshotTransport(snapshot);
      const credentialId = deriveCommandCodeRuntimeCredentialId(input.apiKey, runtimePepper);
      const scope = `${credentialId}:${deriveCommandCodeModelScopeSignature(snapshot)}`;
      let state = models.get(scope);
      if (!state) {
        state = { fetchedAt: 0, retryAt: 0 };
        insertBoundedState(models, scope, state, (candidate) => Boolean(candidate.flight));
      } else {
        touchState(models, scope, state);
      }
      if (state.value && state.fetchedAt + snapshot.modelRefreshIntervalMs > at) {
        return state.value;
      }
      if (state.retryAt > at) return state.value ?? COMMANDCODE_FALLBACK_MODELS;
      return await awaitShared(
        modelFlight(scope, state, snapshot, input.apiKey),
        input.signal,
      );
    } finally {
      release();
    }
  };

  const drain = (): Promise<void> => {
    if (phase === 'disposed') return disposePromise ?? Promise.resolve();
    if (phase === 'active') phase = 'draining';
    drainPromise ??= whenIdle();
    return drainPromise;
  };
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    let resolveDispose!: () => void;
    disposePromise = new Promise<void>((resolve) => { resolveDispose = resolve; });
    phase = 'disposed';
    for (const abort of [...runtimeAbortSubscribers]) abort();
    runtimeAbortSubscribers.clear();
    for (const body of [...trackedBodies]) void body.cancel();
    void (async (): Promise<void> => {
      await whenIdle();
      sessions.clear();
      initializations.clear();
      models.clear();
      resolveDispose();
    })();
    return disposePromise;
  };
  const snapshot = (): Readonly<CommandCodeRuntimeStateSnapshot> => Object.freeze({
    phase,
    activeOperations,
    sessionEntries: sessions.size,
    initializationEntries: initializations.size,
    modelEntries: models.size,
  });
  return Object.freeze({ generate, listModels, drain, dispose, snapshot });
}
