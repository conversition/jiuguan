import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import {
  OPERATIONAL_REPLAY_ACKS,
  OPERATIONAL_REPLAY_BRIDGE_VERSION,
  OPERATIONAL_REPLAY_CAPABILITY_FILE,
  P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  type OperationalReplayAccounting,
  type OperationalReplayCapability,
  type OperationalReplayFinishResponse,
  type OperationalReplayLane,
  type OperationalReplayResponse,
  type OperationalReplaySelection,
} from '../../packages/operational-replay-contract/index.ts';

/**
 * Bridge-owned, deliberately narrow request shape. Keep this contract local so
 * the replay control plane cannot depend on proxy package-private source types.
 * The validator below reconstructs the allow-listed object before the host
 * adapts it to the ProviderRegistry request type.
 */
export interface OperationalReplayRequest {
  readonly model?: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
}

export interface OperationalReplayCallContext {
  readonly requestId: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly maxTransportAttempts?: number;
}

const LOOPBACK_HOST = '127.0.0.1';
const CAPABILITY_TTL_MS = 5 * 60_000;
const CAPABILITY_REFRESH_MS = 60_000;
const RUN_TTL_MS = 15 * 60_000;
const BODY_LIMIT_BYTES = 1024 * 1024;
const MIN_CONSERVATIVE_RATE = 50_000_000;
const MAX_RATE = 1_000_000_000;
const MAX_REQUEST_MESSAGES = 64;
const MAX_REQUEST_TOOLS = 32;
const MAX_REQUEST_CHARS = 500_000;
const SAFE_REQUEST_KEYS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'temperature', 'max_tokens', 'stream',
]);
const SAFE_BRIDGE_CODES = new Set([
  'content-type-invalid', 'body-too-large', 'body-invalid', 'lane-invalid', 'ack-invalid',
  'session-invalid', 'replay-run-active', 'max-provider-calls-invalid', 'max-output-tokens-invalid',
  'max-wall-ms-invalid', 'max-cost-microusd-invalid', 'input-rate-invalid', 'output-rate-invalid',
  'expected-provider-mismatch', 'expected-model-mismatch', 'replay-run-invalid', 'call-index-invalid',
  'call-sequence-invalid', 'request-invalid', 'request-messages-invalid', 'request-tools-invalid',
  'request-too-large', 'request-max-output-tokens-invalid', 'request-temperature-invalid',
  'request-stream-invalid', 'request-field-invalid', 'replay-cost-budget-exhausted',
  'replay-usage-unavailable', 'replay-call-in-flight', 'replay-capability-consumed',
]);

const LANE_LIMITS = Object.freeze({
  interactive: { maxCalls: 16, maxOutputTokens: 1_200, maxWallMs: 15_000, maxCostMicrousd: 1_500_000 },
  learning: { maxCalls: 6, maxOutputTokens: 1_200, maxWallMs: 30_000, maxCostMicrousd: 1_500_000 },
  maintenance: {
    maxCalls: 8,
    maxOutputTokens: 1_600,
    maxWallMs: 60_000,
    maxCostMicrousd: P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  },
} satisfies Record<OperationalReplayLane, {
  maxCalls: number; maxOutputTokens: number; maxWallMs: number; maxCostMicrousd: number;
}>);

interface ReplayRun {
  readonly id: string;
  readonly token: string;
  readonly lane: OperationalReplayLane;
  readonly sessionId: string;
  readonly selection: OperationalReplaySelection;
  readonly maxCalls: number;
  readonly maxOutputTokens: number;
  readonly maxWallMs: number;
  readonly maxCostMicrousd: number;
  readonly inputRate: number;
  readonly outputRate: number;
  readonly expiresAtMs: number;
  nextCallIndex: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  inFlight: boolean;
  closed: boolean;
}

export interface OperationalReplayBridgeOptions {
  readonly dataDir: string;
  readonly serverInstanceId: string;
  readonly resolveSelection: () => OperationalReplaySelection;
  readonly complete: (
    selection: OperationalReplaySelection,
    request: OperationalReplayRequest,
    context: OperationalReplayCallContext,
  ) => Promise<OperationalReplayResponse>;
  readonly nowMs?: () => number;
  readonly pid?: number;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name}-invalid`);
  }
  return Number(value);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new Error('content-type-invalid');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('body-too-large');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('body-invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body-invalid');
  return parsed as Record<string, unknown>;
}

function publicResponse(response: OperationalReplayResponse): OperationalReplayResponse {
  return {
    content: response.content,
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    finishReason: response.finishReason,
    raw: { transport: 'operational-replay-bridge' },
    ...(response.usage === undefined ? {} : { usage: response.usage }),
  };
}

function validateRequest(value: unknown, run: ReplayRun): OperationalReplayRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request-invalid');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !SAFE_REQUEST_KEYS.has(key))) {
    throw new Error('request-field-invalid');
  }
  if (!Array.isArray(request.messages) || request.messages.length < 1
    || request.messages.length > MAX_REQUEST_MESSAGES) throw new Error('request-messages-invalid');
  if (request.tools !== undefined
    && (!Array.isArray(request.tools) || request.tools.length > MAX_REQUEST_TOOLS)) {
    throw new Error('request-tools-invalid');
  }
  const serialized = JSON.stringify({ messages: request.messages, tools: request.tools ?? [] });
  if (serialized.length > MAX_REQUEST_CHARS) throw new Error('request-too-large');
  const requestedOutput = integer(
    request.max_tokens ?? run.maxOutputTokens,
    'request-max-output-tokens',
    1,
    run.maxOutputTokens,
  );
  if (request.temperature !== undefined
    && (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)
      || request.temperature < 0 || request.temperature > 2)) {
    throw new Error('request-temperature-invalid');
  }
  if (request.stream !== undefined && request.stream !== false) throw new Error('request-stream-invalid');
  return {
    model: run.selection.model,
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.tool_choice === undefined
      ? {}
      : { tool_choice: request.tool_choice }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    max_tokens: requestedOutput,
    stream: false,
  };
}

function estimatedCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  if (![inputTokens, outputTokens, inputRate, outputRate]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('replay-usage-unavailable');
  }
  const numerator = BigInt(inputTokens) * BigInt(inputRate)
    + BigInt(outputTokens) * BigInt(outputRate);
  const result = (numerator + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('replay-usage-unavailable');
  return Number(result);
}

function usageTokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('replay-usage-unavailable');
  }
  return Number(value);
}

export class OperationalReplayBridge {
  readonly capabilityPath: string;
  private readonly options: OperationalReplayBridgeOptions;
  private readonly nowMs: () => number;
  private readonly pid: number;
  private readonly globalToken = randomBytes(32).toString('base64url');
  private server: Server | null = null;
  private capability: OperationalReplayCapability | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private activeRun: ReplayRun | null = null;
  private capabilityConsumed = false;

  constructor(options: OperationalReplayBridgeOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.capabilityPath = resolve(options.dataDir, '.runtime', OPERATIONAL_REPLAY_CAPABILITY_FILE);
  }

  async start(): Promise<OperationalReplayCapability> {
    if (this.server) throw new Error('operational-replay-bridge-already-started');
    if (this.capabilityConsumed) throw new Error('operational-replay-capability-consumed');
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, LOOPBACK_HOST, () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('operational-replay-bridge-address-invalid');
    this.writeCapability(address.port);
    this.refreshTimer = setInterval(() => {
      try { this.writeCapability(address.port); }
      catch { console.warn('[OperationalReplay] capability refresh failed detail=redacted'); }
    }, CAPABILITY_REFRESH_MS);
    this.refreshTimer.unref();
    return this.capability!;
  }

  async close(): Promise<void> {
    this.stopCapabilityRefresh();
    this.activeRun = null;
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    this.removeOwnedCapability();
  }

  disposeSync(): void {
    this.stopCapabilityRefresh();
    this.activeRun = null;
    this.removeOwnedCapability();
  }

  private writeCapability(port: number): void {
    const now = this.nowMs();
    const capability: OperationalReplayCapability = Object.freeze({
      version: OPERATIONAL_REPLAY_BRIDGE_VERSION,
      host: LOOPBACK_HOST,
      port,
      pid: this.pid,
      serverInstanceId: this.options.serverInstanceId,
      token: this.globalToken,
      issuedAtMs: now,
      expiresAtMs: now + CAPABILITY_TTL_MS,
    });
    const directory = dirname(this.capabilityPath);
    const temp = `${this.capabilityPath}.${this.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(capability), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temp, this.capabilityPath);
      this.capability = capability;
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* preserve original write failure */ }
      throw error;
    }
  }

  private stopCapabilityRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private removeOwnedCapability(): void {
    try {
      if (!existsSync(this.capabilityPath)) return;
      const value = JSON.parse(readFileSync(this.capabilityPath, 'utf8')) as { serverInstanceId?: unknown };
      if (value.serverInstanceId === this.options.serverInstanceId) rmSync(this.capabilityPath, { force: true });
    } catch { /* stale file is rejected by the client TTL/pid/instance checks */ }
  }

  private authorized(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress;
    if (remote !== LOOPBACK_HOST && remote !== `::ffff:${LOOPBACK_HOST}`) return false;
    const address = this.server?.address();
    const expectedHost = address && typeof address !== 'string' ? `${LOOPBACK_HOST}:${address.port}` : '';
    if (req.headers.host !== expectedHost) return false;
    const token = req.headers['x-jiuguan-replay-token'];
    return typeof token === 'string' && safeEqual(token, this.globalToken);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(req)) return json(res, 404, { ok: false, code: 'not-found' });
      if (req.method === 'GET' && req.url === '/v1/status') {
        return json(res, 200, {
          ok: true,
          version: OPERATIONAL_REPLAY_BRIDGE_VERSION,
          serverInstanceId: this.options.serverInstanceId,
          pid: this.pid,
        });
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' });
      const body = await readJsonBody(req);
      if (req.url === '/v1/begin') return this.begin(res, body);
      if (req.url === '/v1/complete') return await this.complete(res, body);
      if (req.url === '/v1/finish') return this.finish(res, body);
      return json(res, 404, { ok: false, code: 'not-found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (SAFE_BRIDGE_CODES.has(message)) {
        return json(res, message === 'body-too-large' ? 413 : 400, { ok: false, code: message });
      }
      const failure = this.providerFailure(error);
      return json(res, 502, { ok: false, ...failure });
    }
  }

  private begin(res: ServerResponse, body: Record<string, unknown>): void {
    if (this.capabilityConsumed) throw new Error('replay-capability-consumed');
    const lane = body.lane;
    if (lane !== 'interactive' && lane !== 'learning' && lane !== 'maintenance') {
      throw new Error('lane-invalid');
    }
    if (body.ack !== OPERATIONAL_REPLAY_ACKS[lane]) throw new Error('ack-invalid');
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || !/^session-[0-9]{6,24}$/u.test(sessionId)
      || !existsSync(join(this.options.dataDir, `${sessionId}.db`))) {
      throw new Error('session-invalid');
    }
    const now = this.nowMs();
    if (this.activeRun && !this.activeRun.closed && this.activeRun.expiresAtMs > now) {
      throw new Error('replay-run-active');
    }
    const limits = LANE_LIMITS[lane];
    const maxCalls = integer(body.maxProviderCalls, 'max-provider-calls', 1, limits.maxCalls);
    const maxOutputTokens = integer(body.maxOutputTokens, 'max-output-tokens', 1, limits.maxOutputTokens);
    const maxWallMs = integer(body.maxWallMs, 'max-wall-ms', 1, limits.maxWallMs);
    const maxCostMicrousd = integer(body.maxCostMicrousd, 'max-cost-microusd', 1, limits.maxCostMicrousd);
    const inputRate = Math.max(MIN_CONSERVATIVE_RATE,
      integer(body.inputMicrousdPerMillionTokens, 'input-rate', 1, MAX_RATE));
    const outputRate = Math.max(MIN_CONSERVATIVE_RATE,
      integer(body.outputMicrousdPerMillionTokens, 'output-rate', 1, MAX_RATE));
    const selection = this.options.resolveSelection();
    if (body.expectedProviderId !== undefined && body.expectedProviderId !== selection.providerId) {
      throw new Error('expected-provider-mismatch');
    }
    if (body.expectedModel !== undefined && body.expectedModel !== selection.model) {
      throw new Error('expected-model-mismatch');
    }
    const run: ReplayRun = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      lane,
      sessionId,
      selection,
      maxCalls,
      maxOutputTokens,
      maxWallMs,
      maxCostMicrousd,
      inputRate,
      outputRate,
      expiresAtMs: now + RUN_TTL_MS,
      nextCallIndex: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
      inFlight: false,
      closed: false,
    };
    this.activeRun = run;
    this.capabilityConsumed = true;
    // A capability authorizes exactly one successful begin. The live transport
    // already holds the token, so refreshing the discoverable file would only
    // extend an authorization window that can no longer be used.
    this.stopCapabilityRefresh();
    json(res, 200, {
      ok: true,
      runId: run.id,
      runToken: run.token,
      sessionId: run.sessionId,
      effectiveProviderId: selection.providerId,
      effectiveModel: selection.model,
      expiresAtMs: run.expiresAtMs,
    });
  }

  private requireRun(body: Record<string, unknown>): ReplayRun {
    const run = this.activeRun;
    if (!run || run.closed || run.expiresAtMs <= this.nowMs()
      || body.runId !== run.id || typeof body.runToken !== 'string'
      || !safeEqual(body.runToken, run.token)) throw new Error('replay-run-invalid');
    return run;
  }

  private async complete(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const run = this.requireRun(body);
    if (run.inFlight) throw new Error('replay-call-in-flight');
    const callIndex = integer(body.callIndex, 'call-index', 0, run.maxCalls - 1);
    if (callIndex !== run.nextCallIndex || run.calls >= run.maxCalls) throw new Error('call-sequence-invalid');
    const request = validateRequest(body.request, run);
    // One UTF-8 byte is conservatively treated as one input token. Reserve the
    // full requested output before crossing the Provider boundary. This is
    // intentionally more expensive than the replay-core estimate: failed and
    // timed-out physical calls have already consumed their authorization.
    const conservativeInputTokens = Buffer.byteLength(JSON.stringify(request), 'utf8');
    const reservedCostMicrousd = estimatedCost(
      conservativeInputTokens,
      request.max_tokens ?? run.maxOutputTokens,
      run.inputRate,
      run.outputRate,
    );
    if (run.costMicrousd + reservedCostMicrousd > run.maxCostMicrousd) {
      run.closed = true;
      throw new Error('replay-cost-budget-exhausted');
    }
    // Everything through this point is synchronous. The reservation, sequence
    // advance and single-flight flag therefore become visible atomically before
    // the first await/physical Provider call. A failed call keeps the full
    // reservation; a successful call is reconciled to its Provider-reported
    // usage below so eight valid calls are not charged as UTF-8 bytes-as-tokens.
    run.inFlight = true;
    run.nextCallIndex += 1;
    run.calls += 1;
    run.costMicrousd += reservedCostMicrousd;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), run.maxWallMs);
    try {
      const call = body.call && typeof body.call === 'object' && !Array.isArray(body.call)
        ? body.call as { runId?: unknown } : undefined;
      const response = await this.options.complete(run.selection, request, {
        requestId: randomUUID(),
        runId: typeof call?.runId === 'string' ? call.runId : run.id,
        signal: controller.signal,
        maxTransportAttempts: 1,
      });
      const usage = response.usage;
      if (!usage) {
        run.closed = true;
        throw new Error('replay-usage-unavailable');
      }
      const promptTokens = usageTokens(usage.prompt_tokens);
      const completionTokens = usageTokens(usage.completion_tokens);
      const actualCostMicrousd = estimatedCost(
        promptTokens,
        completionTokens,
        run.inputRate,
        run.outputRate,
      );
      run.inputTokens += promptTokens;
      run.outputTokens += completionTokens;
      run.costMicrousd = run.costMicrousd - reservedCostMicrousd + actualCostMicrousd;
      if (run.costMicrousd > run.maxCostMicrousd) {
        run.closed = true;
        throw new Error('replay-cost-budget-exhausted');
      }
      json(res, 200, { ok: true, response: publicResponse(response) });
    } finally {
      clearTimeout(timer);
      run.inFlight = false;
    }
  }

  private finish(res: ServerResponse, body: Record<string, unknown>): void {
    const run = this.activeRun;
    if (!run || run.expiresAtMs <= this.nowMs()
      || body.runId !== run.id || typeof body.runToken !== 'string'
      || !safeEqual(body.runToken, run.token)) throw new Error('replay-run-invalid');
    if (run.inFlight) throw new Error('replay-call-in-flight');
    run.closed = true;
    const accounting: OperationalReplayAccounting = Object.freeze({
      providerCalls: run.calls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costMicrousd: run.costMicrousd,
    });
    this.stopCapabilityRefresh();
    this.removeOwnedCapability();
    const response = {
      ok: true,
      sessionId: run.sessionId,
      accounting,
    } satisfies OperationalReplayFinishResponse;
    json(res, 200, response);
  }

  private providerFailure(error: unknown): Readonly<{
    code: string;
    upstreamStatus?: number;
  }> {
    if (!error || typeof error !== 'object') return Object.freeze({ code: 'provider-failed' });
    let diagnostic: unknown;
    let code: unknown;
    let name: unknown;
    let upstreamStatus: unknown;
    try {
      const row = error as {
        diagnosticCode?: unknown;
        code?: unknown;
        name?: unknown;
        upstreamStatus?: unknown;
      };
      diagnostic = row.diagnosticCode;
      code = row.code;
      name = row.name;
      upstreamStatus = row.upstreamStatus;
    } catch { return Object.freeze({ code: 'provider-failed' }); }
    const publicCode = diagnostic === 'provider-rate-limited'
      ? 'provider-rate-limited'
      : diagnostic === 'provider-timeout' || name === 'TimeoutError'
        ? 'provider-timeout'
        : diagnostic === 'provider-upstream-unavailable'
          ? 'provider-upstream-5xx'
          : diagnostic === 'provider-transport-failed'
            ? 'provider-transport-failed'
            : diagnostic === 'provider-authentication-failed'
              ? 'provider-authentication-failed'
              : diagnostic === 'provider-request-invalid'
                ? 'provider-request-invalid'
                : code === 'invocation-aborted'
                  ? 'provider-timeout'
                  : 'provider-failed';
    const safeUpstreamStatus = publicCode === 'provider-request-invalid'
      && typeof upstreamStatus === 'number'
      && Number.isSafeInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 499
      ? upstreamStatus
      : undefined;
    return Object.freeze({
      code: publicCode,
      ...(safeUpstreamStatus === undefined ? {} : { upstreamStatus: safeUpstreamStatus }),
    });
  }
}
