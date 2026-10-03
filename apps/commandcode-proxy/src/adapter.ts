import { createHash, randomUUID } from 'node:crypto';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import {
  buildAnthropicResponse,
  buildOpenAIChatCompletion,
  buildResponsesObject,
  classifyCommandCodeCompletion,
  CommandCodeAnthropicSseTranslator,
  CommandCodeChatSseTranslator,
  CommandCodeResponseAccumulator,
  CommandCodeResponsesSseTranslator,
  convertAnthropicToChat,
  convertResponsesToChat,
  mapCcError,
  type AnthropicRequest,
  type ChatRequest,
  type CommandCodeCompletionDecision,
  type CommandCodeStreamFinalization,
  type MappedCommandCodeError,
  type ResponsesRequest,
} from '../../../packages/commandcode-core/src/index.ts';
import {
  COMMANDCODE_FALLBACK_MODELS,
  type CommandCodeRuntime,
  type CommandCodeRuntimeConfigSnapshot,
} from '../../../packages/commandcode-runtime/src/index.ts';
import {
  CommandCodeBodyError,
  drainRejectedRequest,
  readBoundedJsonBody,
  waitForResponseDrain,
} from './body.ts';
import {
  buildCommandCodeProviderWireBody,
  consumeCommandCodeNdjson as consumeNdjson,
  readCommandCodeErrorText as readErrorText,
  CommandCodeStreamIdleTimeoutError as CommandCodeAdapterIdleTimeoutError,
  CommandCodeUpstreamBodyError as CommandCodeAdapterUpstreamError,
} from './provider.ts';

const FIXED_URL_BASE = 'http://127.0.0.1';
const API_KEY_PATTERN = /^user_[A-Za-z0-9_-]{1,507}$/;
const OUTPUT_EVENT_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call']);
const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

type PublicProtocol = 'chat' | 'anthropic' | 'responses';
export type CommandCodeAdapterPhase = 'active' | 'draining' | 'disposed';

export interface CommandCodeStandaloneAdapterOptions {
  readonly runtime: CommandCodeRuntime;
  readonly runtimeConfig: CommandCodeRuntimeConfigSnapshot;
  readonly maxBodyBytes: number;
  readonly maxInflight: number;
  readonly now?: () => number;
  readonly uuid?: () => string;
  readonly thinkingSignature?: (thinkingText: string) => string;
}

export interface CommandCodeStandaloneAdapterSnapshot {
  readonly phase: CommandCodeAdapterPhase;
  readonly activeRequests: number;
}

export interface CommandCodeStandaloneAdapter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): Readonly<CommandCodeStandaloneAdapterSnapshot>;
}

interface PreparedRequest {
  readonly protocol: PublicProtocol;
  readonly original: Record<string, unknown>;
  readonly chat: ChatRequest;
  readonly stream: boolean;
}

interface RequestIdentity {
  readonly publicId: string;
  readonly created: number;
  readonly newToolCallId: () => string;
  readonly newResponseId: (
    prefix: 'rs_' | 'msg_' | 'fc_' | 'call_',
  ) => string;
}

interface StreamTranslator {
  pushEvent(value: unknown): string[];
  finalize(): CommandCodeStreamFinalization;
}

class CommandCodeAdapterAuthError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function mappedError(
  status: number,
  type: string,
  message: string,
  retryAfter?: number,
): MappedCommandCodeError {
  return {
    status,
    body: {
      error: { message, type },
      ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
    },
    ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
  };
}

function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CommandCodeAdapterAuthError();
  return value;
}

function extractApiKey(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headerString(headers, 'authorization');
  const xApiKey = headerString(headers, 'x-api-key');
  let bearer: string | undefined;
  if (authorization !== undefined) {
    const match = /^Bearer (.+)$/.exec(authorization);
    if (!match || !API_KEY_PATTERN.test(match[1]!)) {
      throw new CommandCodeAdapterAuthError();
    }
    bearer = match[1]!;
  }
  if (xApiKey !== undefined && !API_KEY_PATTERN.test(xApiKey)) {
    throw new CommandCodeAdapterAuthError();
  }
  if (bearer && xApiKey && bearer !== xApiKey) {
    throw new CommandCodeAdapterAuthError();
  }
  return bearer ?? xApiKey;
}

function retryAfterOf(error: MappedCommandCodeError): number | undefined {
  return error.retry_after ?? error.body.retry_after;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  retryAfter?: number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
  if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendProtocolError(
  res: ServerResponse,
  protocol: PublicProtocol,
  error: MappedCommandCodeError,
): void {
  const retryAfter = retryAfterOf(error);
  const detail = error.body.error;
  if (protocol === 'anthropic') {
    sendJson(res, error.status, {
      type: 'error',
      error: { type: detail.type, message: detail.message },
      ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
    }, retryAfter);
    return;
  }
  if (protocol === 'responses') {
    sendJson(res, error.status, {
      error: {
        message: detail.message,
        type: detail.type,
        code: detail.code ?? null,
        param: null,
      },
      ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
    }, retryAfter);
    return;
  }
  sendJson(res, error.status, error.body as unknown as Record<string, unknown>, retryAfter);
}

function streamErrorFrame(
  protocol: Exclude<PublicProtocol, 'responses'>,
  error: MappedCommandCodeError,
): string {
  if (protocol === 'chat') {
    return `data: ${JSON.stringify(error.body)}\n\n`;
  }
  const retryAfter = retryAfterOf(error);
  return `event: error\ndata: ${JSON.stringify({
    type: 'error',
    error: error.body.error,
    ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
  })}\n\n`;
}

function fakeThinkingSignature(thinkingText: string): string {
  const seed = createHash('sha256')
    .update(thinkingText || 'jiuguan-commandcode-thinking')
    .digest();
  return Buffer.concat([Buffer.from([0x12, seed.length]), seed]).toString('base64');
}

function normalizedUuid(factory: () => string): string {
  const value = factory();
  if (typeof value !== 'string' || !value) throw new TypeError('uuid factory failed');
  return value.replace(/-/g, '');
}

function requestIdentity(
  protocol: PublicProtocol,
  now: () => number,
  uuid: () => string,
): RequestIdentity {
  const milliseconds = now();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('clock failed');
  }
  const created = Math.floor(milliseconds / 1_000);
  const compact = (): string => normalizedUuid(uuid);
  const publicId = protocol === 'chat'
    ? `chatcmpl-${compact().slice(0, 12)}`
    : protocol === 'anthropic'
      ? `msg_${compact().slice(0, 12)}`
      : `resp_${compact().slice(0, 24)}`;
  return {
    publicId,
    created,
    newToolCallId: () => `call_${compact().slice(0, 24)}`,
    newResponseId: (prefix) => `${prefix}${compact().slice(0, 24)}`,
  };
}

function prepareRequest(
  protocol: PublicProtocol,
  body: unknown,
  identity: RequestIdentity,
): PreparedRequest {
  if (!isRecord(body)) throw new CommandCodeBodyError('COMMANDCODE_BODY_INVALID_JSON');
  if (protocol === 'chat') {
    return {
      protocol,
      original: body,
      chat: body as ChatRequest,
      stream: body.stream === true,
    };
  }
  if (protocol === 'anthropic') {
    const chat = convertAnthropicToChat(body as AnthropicRequest);
    return { protocol, original: body, chat, stream: chat.stream === true };
  }
  if (ownValue(body, 'previous_response_id')) {
    throw mappedError(
      400,
      'invalid_request_error',
      'previous_response_id is not supported; send the full input each turn',
    );
  }
  const chat = convertResponsesToChat(body as ResponsesRequest, {
    newCallId: identity.newToolCallId,
  });
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    throw mappedError(400, 'invalid_request_error', 'input is required');
  }
  return { protocol, original: body, chat, stream: chat.stream === true };
}

function bodyError(
  error: CommandCodeBodyError,
): MappedCommandCodeError {
  if (error.code === 'COMMANDCODE_BODY_TOO_LARGE') {
    return mappedError(413, 'invalid_request_error', 'Request body exceeds the configured limit');
  }
  return mappedError(400, 'invalid_request_error', 'Invalid JSON body');
}

async function writeFrames(
  res: ServerResponse,
  frames: readonly string[],
  state: { started: boolean },
): Promise<void> {
  if (frames.length === 0) return;
  if (!state.started) {
    res.writeHead(200, SSE_HEADERS);
    state.started = true;
  }
  for (const frame of frames) {
    if (!res.write(frame)) await waitForResponseDrain(res);
  }
}

function completionError(decision: CommandCodeCompletionDecision): MappedCommandCodeError | null {
  return decision.kind === 'success' ? null : decision.error;
}

function createTranslator(
  protocol: PublicProtocol,
  model: string,
  identity: RequestIdentity,
  thinkingSignature: (text: string) => string,
): StreamTranslator {
  if (protocol === 'chat') {
    return new CommandCodeChatSseTranslator({
      id: identity.publicId,
      model,
      created: identity.created,
      newToolCallId: identity.newToolCallId,
    });
  }
  if (protocol === 'anthropic') {
    return new CommandCodeAnthropicSseTranslator({
      messageId: identity.publicId,
      model,
      newToolCallId: identity.newToolCallId,
      thinkingSignature,
    });
  }
  return new CommandCodeResponsesSseTranslator({
    responseId: identity.publicId,
    model,
    created: identity.created,
    newId: identity.newResponseId,
  });
}

async function streamResponse(
  res: ServerResponse,
  response: Response,
  prepared: PreparedRequest,
  model: string,
  identity: RequestIdentity,
  runtimeConfig: CommandCodeRuntimeConfigSnapshot,
  abortController: AbortController,
  thinkingSignature: (text: string) => string,
): Promise<void> {
  const translator = createTranslator(
    prepared.protocol,
    model,
    identity,
    thinkingSignature,
  );
  const writeState = { started: false };
  const bufferedAnthropicStart: string[] = [];
  try {
    await consumeNdjson(
      response,
      runtimeConfig.maxNdjsonBufferedChars,
      runtimeConfig.streamIdleTimeoutMs,
      abortController,
      async (event) => {
        const frames = translator.pushEvent(event);
        if (
          prepared.protocol === 'anthropic'
          && !writeState.started
          && !OUTPUT_EVENT_TYPES.has(String(ownValue(event, 'type') ?? ''))
        ) {
          bufferedAnthropicStart.push(...frames);
          return;
        }
        await writeFrames(
          res,
          [...bufferedAnthropicStart.splice(0), ...frames],
          writeState,
        );
      },
    );
    const final = translator.finalize();
    const error = completionError(final.decision);
    if (!writeState.started && error) {
      sendProtocolError(res, prepared.protocol, error);
      return;
    }
    await writeFrames(
      res,
      [...bufferedAnthropicStart, ...final.frames],
      writeState,
    );
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (abortController.signal.aborted && (res.destroyed || res.writableEnded)) return;
    const mapped = error instanceof CommandCodeAdapterIdleTimeoutError
      ? mappedError(429, 'rate_limit_error', 'Response timeout - request timed out', 5)
      : mappedError(502, 'upstream_error', 'Upstream response stream failed');
    if (!writeState.started) {
      sendProtocolError(res, prepared.protocol, mapped);
      return;
    }
    try {
      if (
        prepared.protocol === 'responses'
        && translator instanceof CommandCodeResponsesSseTranslator
      ) {
        await writeFrames(
          res,
          translator.transportError(mapped.body.error.message),
          writeState,
        );
        translator.finalize();
      } else {
        await writeFrames(
          res,
          [streamErrorFrame(prepared.protocol as 'chat' | 'anthropic', mapped)],
          writeState,
        );
      }
      if (!res.writableEnded) res.end();
    } catch {
      abortController.abort();
      res.destroy();
    }
  }
}

async function nonStreamResponse(
  res: ServerResponse,
  response: Response,
  prepared: PreparedRequest,
  model: string,
  identity: RequestIdentity,
  runtimeConfig: CommandCodeRuntimeConfigSnapshot,
  abortController: AbortController,
  now: () => number,
  thinkingSignature: (text: string) => string,
): Promise<void> {
  const accumulator = new CommandCodeResponseAccumulator({
    usagePolicy: prepared.protocol === 'chat' ? 'total-only' : 'total-or-event',
    newToolCallId: identity.newToolCallId,
  });
  try {
    await consumeNdjson(
      response,
      runtimeConfig.maxNdjsonBufferedChars,
      runtimeConfig.nonStreamIdleTimeoutMs,
      abortController,
      (event) => accumulator.pushEvent(event),
    );
  } catch (error) {
    const mapped = error instanceof CommandCodeAdapterIdleTimeoutError
      ? mappedError(429, 'rate_limit_error', 'Response timeout - request timed out', 5)
      : mappedError(502, 'upstream_error', 'Upstream response stream failed');
    sendProtocolError(res, prepared.protocol, mapped);
    return;
  }
  const state = accumulator.snapshot();
  const decision = classifyCommandCodeCompletion(
    state,
    prepared.protocol === 'chat' ? 'usage' : 'content',
  );
  const error = completionError(decision);
  if (error) {
    sendProtocolError(res, prepared.protocol, error);
    return;
  }
  if (prepared.protocol === 'chat') {
    sendJson(res, 200, buildOpenAIChatCompletion(state, {
      id: identity.publicId,
      model,
      created: identity.created,
    }));
    return;
  }
  if (prepared.protocol === 'anthropic') {
    sendJson(res, 200, buildAnthropicResponse(state, {
      messageId: identity.publicId,
      model,
      thinkingSignature,
    }));
    return;
  }
  const completedMilliseconds = now();
  if (!Number.isFinite(completedMilliseconds) || completedMilliseconds < 0) {
    throw new TypeError('clock failed');
  }
  const original = prepared.original;
  sendJson(res, 200, buildResponsesObject(state, {
    responseId: identity.publicId,
    model,
    createdAt: identity.created,
    completedAt: Math.floor(completedMilliseconds / 1_000),
    newId: identity.newResponseId,
    input: ownValue(original, 'input'),
    instructions: ownValue(original, 'instructions'),
    maxOutputTokens: ownValue(original, 'max_output_tokens'),
    reasoning: ownValue(original, 'reasoning'),
    temperature: ownValue(original, 'temperature'),
    toolChoice: ownValue(original, 'tool_choice'),
    tools: ownValue(original, 'tools'),
    topP: ownValue(original, 'top_p'),
  }));
}

export function createCommandCodeStandaloneAdapter(
  options: CommandCodeStandaloneAdapterOptions,
): Readonly<CommandCodeStandaloneAdapter> {
  const runtime = options.runtime;
  const runtimeConfig = options.runtimeConfig;
  const maxBodyBytes = options.maxBodyBytes;
  const maxInflight = options.maxInflight;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(maxInflight) || maxInflight <= 0) {
    throw new TypeError('maxInflight must be a positive integer');
  }
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const thinkingSignature = options.thinkingSignature ?? fakeThinkingSignature;
  let phase: CommandCodeAdapterPhase = 'active';
  let activeRequests = 0;
  let drainPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const idleResolvers = new Set<() => void>();

  const settleIdle = (): void => {
    if (activeRequests !== 0) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };
  const whenIdle = (): Promise<void> => {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { idleResolvers.add(resolve); });
  };

  const handleModels = async (
    req: IncomingMessage,
    res: ServerResponse,
    abortController: AbortController,
  ): Promise<void> => {
    let apiKey: string | undefined;
    try { apiKey = extractApiKey(req.headers); } catch {
      sendProtocolError(
        res,
        'chat',
        mappedError(401, 'authentication_error', 'Invalid API key'),
      );
      return;
    }
    let models = COMMANDCODE_FALLBACK_MODELS;
    if (apiKey) {
      try {
        models = await runtime.listModels({
          apiKey,
          signal: abortController.signal,
        });
      } catch {
        if (abortController.signal.aborted) return;
        sendProtocolError(
          res,
          'chat',
          mappedError(502, 'proxy_error', 'Model discovery failed'),
        );
        return;
      }
    }
    const milliseconds = now();
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError('clock failed');
    }
    const created = Math.floor(milliseconds / 1_000);
    sendJson(res, 200, {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created,
        owned_by: 'command-code',
      })),
    });
  };

  const handleGeneration = async (
    protocol: PublicProtocol,
    req: IncomingMessage,
    res: ServerResponse,
    abortController: AbortController,
  ): Promise<void> => {
    let apiKey: string | undefined;
    try { apiKey = extractApiKey(req.headers); } catch {
      drainRejectedRequest(req);
      sendProtocolError(
        res,
        protocol,
        mappedError(
          401,
          protocol === 'chat' ? 'auth_error' : 'authentication_error',
          'Invalid API key',
        ),
      );
      return;
    }
    if (!apiKey) {
      drainRejectedRequest(req);
      sendProtocolError(
        res,
        protocol,
        mappedError(
          401,
          protocol === 'chat' ? 'auth_error' : 'authentication_error',
          'Missing API key. Send Authorization: Bearer <key> or x-api-key',
        ),
      );
      return;
    }

    let body: unknown;
    try {
      body = await readBoundedJsonBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof CommandCodeBodyError) {
        if (error.code !== 'COMMANDCODE_BODY_ABORTED') {
          sendProtocolError(res, protocol, bodyError(error));
        }
        return;
      }
      throw error;
    }

    const identity = requestIdentity(protocol, now, uuid);
    let prepared: PreparedRequest;
    try {
      prepared = prepareRequest(protocol, body, identity);
    } catch (error) {
      if (error instanceof CommandCodeBodyError) {
        sendProtocolError(res, protocol, bodyError(error));
        return;
      }
      if (isRecord(error) && typeof error.status === 'number' && isRecord(error.body)) {
        sendProtocolError(res, protocol, error as unknown as MappedCommandCodeError);
        return;
      }
      throw error;
    }
    const at = now();
    if (!Number.isFinite(at) || at < 0) throw new TypeError('clock failed');
    const { wireBody, promptCacheKey } = buildCommandCodeProviderWireBody(
      prepared.chat,
      runtimeConfig,
      at,
    );
    let upstream: Response;
    try {
      upstream = await runtime.generate({
        apiKey,
        wireBody,
        ...(promptCacheKey ? { promptCacheKey } : {}),
        signal: abortController.signal,
      });
    } catch {
      if (abortController.signal.aborted) return;
      sendProtocolError(
        res,
        protocol,
        mappedError(502, 'proxy_error', 'Upstream request failed'),
      );
      return;
    }
    if (!upstream.ok) {
      let text: string;
      try {
        text = await readErrorText(
          upstream,
          runtimeConfig.nonStreamIdleTimeoutMs,
          abortController,
        );
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        sendProtocolError(
          res,
          protocol,
          error instanceof CommandCodeAdapterIdleTimeoutError
            ? mappedError(429, 'rate_limit_error', 'Response timeout - request timed out', 5)
            : mappedError(502, 'upstream_error', 'Upstream error response failed'),
        );
        return;
      }
      if (!res.destroyed) sendProtocolError(res, protocol, mapCcError(upstream.status, text));
      return;
    }
    const model = wireBody.params.model;
    if (prepared.stream) {
      await streamResponse(
        res,
        upstream,
        prepared,
        model,
        identity,
        runtimeConfig,
        abortController,
        thinkingSignature,
      );
    } else {
      await nonStreamResponse(
        res,
        upstream,
        prepared,
        model,
        identity,
        runtimeConfig,
        abortController,
        now,
        thinkingSignature,
      );
    }
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', FIXED_URL_BASE).pathname; } catch {
      sendJson(res, 400, {
        error: { message: 'Invalid request URL', type: 'invalid_request_error' },
      });
      return;
    }
    if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
      res.writeHead(phase === 'active' ? 200 : 503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(phase === 'active' ? 'OK' : 'NOT READY');
      return;
    }
    if (req.method === 'OPTIONS') {
      drainRejectedRequest(req);
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS' });
      res.end();
      return;
    }
    const protocol = pathname === '/v1/chat/completions' && req.method === 'POST'
      ? 'chat'
      : pathname === '/v1/messages' && req.method === 'POST'
        ? 'anthropic'
        : pathname === '/v1/responses' && req.method === 'POST'
          ? 'responses'
          : null;
    const models = pathname === '/v1/models' && req.method === 'GET';
    if (!protocol && !models) {
      drainRejectedRequest(req);
      sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
      return;
    }
    if (phase !== 'active' || activeRequests >= maxInflight) {
      drainRejectedRequest(req);
      sendProtocolError(
        res,
        protocol ?? 'chat',
        mappedError(
          503,
          'server_busy',
          'Service is not accepting new requests',
          5,
        ),
      );
      return;
    }

    const abortController = new AbortController();
    controllers.add(abortController);
    activeRequests++;
    const abort = (): void => { abortController.abort(); };
    const onResponseClose = (): void => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onResponseClose);
    try {
      if (models) {
        drainRejectedRequest(req);
        await handleModels(req, res, abortController);
      } else {
        await handleGeneration(protocol!, req, res, abortController);
      }
    } catch {
      abort();
      if (!res.headersSent && !res.destroyed) {
        sendProtocolError(
          res,
          protocol ?? 'chat',
          mappedError(500, 'internal_error', 'Internal adapter error'),
        );
      } else if (!res.writableEnded) {
        res.destroy();
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', onResponseClose);
      controllers.delete(abortController);
      activeRequests--;
      settleIdle();
    }
  };

  const drain = (): Promise<void> => {
    if (phase === 'disposed') return disposePromise ?? Promise.resolve();
    if (drainPromise) return drainPromise;
    phase = 'draining';
    drainPromise = (async (): Promise<void> => {
      await whenIdle();
      await runtime.drain();
    })();
    return drainPromise;
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    phase = 'disposed';
    for (const controller of [...controllers]) controller.abort();
    disposePromise = (async (): Promise<void> => {
      await runtime.dispose();
      await whenIdle();
    })();
    return disposePromise;
  };

  const snapshot = (): Readonly<CommandCodeStandaloneAdapterSnapshot> => Object.freeze({
    phase,
    activeRequests,
  });
  return Object.freeze({ handle, drain, dispose, snapshot });
}
