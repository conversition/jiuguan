import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPERATIONAL_REPLAY_BRIDGE_VERSION,
  OPERATIONAL_REPLAY_CAPABILITY_FILE,
  type OperationalReplayAccounting,
  type OperationalReplayCapability,
  type OperationalReplayFinish,
  type OperationalReplayLane,
  type OperationalReplayResponse,
  type OperationalReplayTransportClient,
} from '../../packages/operational-replay-contract/index.ts';

const MAX_CAPABILITY_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface OperationalReplayTransportOptions {
  readonly dataDir: string;
  readonly lane: OperationalReplayLane;
  readonly ack: string;
  readonly sessionId: string;
  readonly maxProviderCalls: number;
  readonly maxOutputTokens: number;
  readonly maxWallMs: number;
  readonly maxCostMicrousd: number;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
  readonly expectedProviderId?: string;
  readonly expectedModel?: string;
  readonly nowMs?: () => number;
  readonly processAlive?: (pid: number) => boolean;
}

export interface OperationalReplayTransport {
  readonly client: OperationalReplayTransportClient;
  readonly providerId: string;
  readonly modelId: string;
  finish(): Promise<OperationalReplayFinish>;
}

export function parseOperationalReplayAccounting(value: unknown): OperationalReplayAccounting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalReplayTransportError('OP_REPLAY_PROTOCOL', 'finish-accounting-invalid');
  }
  const row = value as Record<string, unknown>;
  const fields = ['providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd'] as const;
  if (fields.some((field) => !Number.isSafeInteger(row[field]) || Number(row[field]) < 0)) {
    throw new OperationalReplayTransportError('OP_REPLAY_PROTOCOL', 'finish-accounting-invalid');
  }
  return Object.freeze({
    providerCalls: Number(row.providerCalls),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    costMicrousd: Number(row.costMicrousd),
  });
}

export function parseOperationalReplayFinish(
  value: unknown,
  expectedSessionId: string,
): OperationalReplayFinish {
  if (!/^session-[0-9]{6,24}$/u.test(expectedSessionId)
    || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalReplayTransportError('OP_REPLAY_PROTOCOL', 'finish-session-invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.sessionId !== expectedSessionId) {
    throw new OperationalReplayTransportError('OP_REPLAY_PROTOCOL', 'finish-session-mismatch');
  }
  return Object.freeze({
    sessionId: expectedSessionId,
    accounting: parseOperationalReplayAccounting(row.accounting),
  });
}

interface BeginResponse {
  ok: true;
  runId: string;
  runToken: string;
  sessionId: string;
  effectiveProviderId: string;
  effectiveModel: string;
  expiresAtMs: number;
}

export type OperationalReplayTransportErrorCode =
  | 'OP_REPLAY_RATE_LIMIT'
  | 'OP_REPLAY_TIMEOUT'
  | 'OP_REPLAY_UPSTREAM_5XX'
  | 'OP_REPLAY_UPSTREAM_4XX'
  | 'OP_REPLAY_AUTHENTICATION'
  | 'OP_REPLAY_REQUEST_INVALID'
  | 'OP_REPLAY_TRANSPORT'
  | 'OP_REPLAY_BUDGET'
  | 'OP_REPLAY_PROTOCOL';

export class OperationalReplayTransportError extends Error {
  readonly upstreamStatus?: number;

  constructor(
    readonly code: OperationalReplayTransportErrorCode,
    detail: string,
    upstreamStatus?: number,
  ) {
    super(`operational replay bridge failed: ${detail}`);
    this.name = 'OperationalReplayTransportError';
    if (code === 'OP_REPLAY_REQUEST_INVALID'
      && typeof upstreamStatus === 'number' && Number.isSafeInteger(upstreamStatus)
      && upstreamStatus >= 400 && upstreamStatus <= 499) {
      this.upstreamStatus = upstreamStatus;
    }
  }
}

function transportErrorCode(code: string): OperationalReplayTransportErrorCode {
  if (code === 'provider-rate-limited') return 'OP_REPLAY_RATE_LIMIT';
  if (code === 'provider-timeout') return 'OP_REPLAY_TIMEOUT';
  if (code === 'provider-upstream-5xx') return 'OP_REPLAY_UPSTREAM_5XX';
  if (code === 'provider-upstream-4xx') return 'OP_REPLAY_UPSTREAM_4XX';
  if (code === 'provider-authentication-failed') return 'OP_REPLAY_AUTHENTICATION';
  if (code === 'provider-request-invalid') return 'OP_REPLAY_REQUEST_INVALID';
  if (code === 'provider-transport-failed') return 'OP_REPLAY_TRANSPORT';
  if (code === 'replay-cost-budget-exhausted') return 'OP_REPLAY_BUDGET';
  return 'OP_REPLAY_PROTOCOL';
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readOperationalReplayCapability(
  dataDir: string,
  options: { nowMs?: () => number; processAlive?: (pid: number) => boolean } = {},
): OperationalReplayCapability {
  const path = resolve(dataDir, '.runtime', OPERATIONAL_REPLAY_CAPABILITY_FILE);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('operational-replay-bridge-unavailable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('operational-replay-capability-invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.version !== OPERATIONAL_REPLAY_BRIDGE_VERSION
    || row.host !== '127.0.0.1'
    || !Number.isSafeInteger(row.port) || Number(row.port) < 1 || Number(row.port) > 65535
    || !Number.isSafeInteger(row.pid) || Number(row.pid) < 1
    || typeof row.serverInstanceId !== 'string' || row.serverInstanceId.length < 16
    || typeof row.token !== 'string' || row.token.length < 32
    || !Number.isSafeInteger(row.issuedAtMs)
    || !Number.isSafeInteger(row.expiresAtMs)) {
    throw new Error('operational-replay-capability-invalid');
  }
  const now = (options.nowMs ?? Date.now)();
  const issuedAtMs = Number(row.issuedAtMs);
  const expiresAtMs = Number(row.expiresAtMs);
  if (issuedAtMs > now + 5_000 || expiresAtMs <= now
    || expiresAtMs - issuedAtMs > MAX_CAPABILITY_TTL_MS) {
    throw new Error('operational-replay-capability-stale');
  }
  const pid = Number(row.pid);
  if (!(options.processAlive ?? defaultProcessAlive)(pid)) {
    throw new Error('operational-replay-capability-process-dead');
  }
  return row as unknown as OperationalReplayCapability;
}

async function requestJson(
  capability: OperationalReplayCapability,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${capability.port}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Jiuguan-Replay-Token': capability.token,
        ...(init.headers ?? {}),
      },
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof OperationalReplayTransportError) throw error;
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
    const code = name === 'AbortError' || name === 'TimeoutError'
      ? 'OP_REPLAY_TIMEOUT'
      : 'OP_REPLAY_TRANSPORT';
    throw new OperationalReplayTransportError(code, 'local-bridge-request-failed');
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new OperationalReplayTransportError('OP_REPLAY_PROTOCOL', 'local-bridge-response-invalid');
  }
  if (!response.ok || body.ok !== true) {
    const code = typeof body.code === 'string' && /^[a-z0-9-]{1,64}$/u.test(body.code)
      ? body.code
      : `http-${response.status}`;
    const upstreamStatus = code === 'provider-request-invalid'
      && typeof body.upstreamStatus === 'number'
      && Number.isSafeInteger(body.upstreamStatus)
      && body.upstreamStatus >= 400 && body.upstreamStatus <= 499
      ? body.upstreamStatus
      : undefined;
    throw new OperationalReplayTransportError(transportErrorCode(code), code, upstreamStatus);
  }
  return body;
}

class BridgeReplayClient implements OperationalReplayTransportClient {
  private callIndex = 0;

  constructor(
    private readonly capability: OperationalReplayCapability,
    private readonly begin: BeginResponse,
    private readonly maxWallMs: number,
  ) {}

  async complete(request: unknown, signal?: AbortSignal, call?: unknown): Promise<OperationalReplayResponse> {
    const callIndex = this.callIndex++;
    const body = await requestJson(this.capability, '/v1/complete', {
      method: 'POST',
      body: JSON.stringify({
        runId: this.begin.runId,
        runToken: this.begin.runToken,
        callIndex,
        request,
        ...(call ? { call } : {}),
      }),
      ...(signal ? { signal } : {}),
    }, this.maxWallMs + PROBE_TIMEOUT_MS);
    const response = body.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('operational-replay-bridge-response-invalid');
    }
    return response as OperationalReplayResponse;
  }

  async stream(
    _request: unknown,
    _onDelta: (delta: string) => void,
    _onToolArg?: (name: string, argsDelta: string, delta?: {
      index: number; id?: string; nameDelta?: string;
    }) => void,
    _signal?: AbortSignal,
    _call?: unknown,
  ): Promise<OperationalReplayResponse> {
    throw new Error('operational-replay-stream-disabled');
  }

  modelName(): string { return this.begin.effectiveModel; }
  capabilities(): { readonly stream: boolean; readonly tools: boolean } {
    return { stream: false, tools: true };
  }
}

export async function createOperationalReplayTransport(
  options: OperationalReplayTransportOptions,
): Promise<OperationalReplayTransport> {
  const capability = readOperationalReplayCapability(options.dataDir, options);
  const status = await requestJson(capability, '/v1/status', { method: 'GET' }, PROBE_TIMEOUT_MS);
  if (status.serverInstanceId !== capability.serverInstanceId || status.pid !== capability.pid) {
    throw new Error('operational-replay-capability-instance-mismatch');
  }
  const rawBegin = await requestJson(capability, '/v1/begin', {
    method: 'POST',
    body: JSON.stringify({
      lane: options.lane,
      ack: options.ack,
      sessionId: options.sessionId,
      maxProviderCalls: options.maxProviderCalls,
      maxOutputTokens: options.maxOutputTokens,
      maxWallMs: options.maxWallMs,
      maxCostMicrousd: options.maxCostMicrousd,
      inputMicrousdPerMillionTokens: options.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: options.outputMicrousdPerMillionTokens,
      ...(options.expectedProviderId ? { expectedProviderId: options.expectedProviderId } : {}),
      ...(options.expectedModel ? { expectedModel: options.expectedModel } : {}),
    }),
  }, PROBE_TIMEOUT_MS);
  const begin = rawBegin as unknown as BeginResponse;
  if (typeof begin.runId !== 'string' || typeof begin.runToken !== 'string'
    || begin.sessionId !== options.sessionId
    || typeof begin.effectiveProviderId !== 'string' || typeof begin.effectiveModel !== 'string') {
    throw new Error('operational-replay-begin-response-invalid');
  }
  if (options.expectedProviderId && begin.effectiveProviderId !== options.expectedProviderId) {
    throw new Error('operational-replay-effective-provider-mismatch');
  }
  if (options.expectedModel && begin.effectiveModel !== options.expectedModel) {
    throw new Error('operational-replay-effective-model-mismatch');
  }
  const client = new BridgeReplayClient(capability, begin, options.maxWallMs);
  let finishPromise: Promise<OperationalReplayFinish> | undefined;
  return Object.freeze({
    client,
    providerId: begin.effectiveProviderId,
    modelId: begin.effectiveModel,
    finish: () => (finishPromise ??= requestJson(capability, '/v1/finish', {
      method: 'POST',
      body: JSON.stringify({ runId: begin.runId, runToken: begin.runToken }),
    }, PROBE_TIMEOUT_MS).then((body) => parseOperationalReplayFinish(body, begin.sessionId))),
  });
}
