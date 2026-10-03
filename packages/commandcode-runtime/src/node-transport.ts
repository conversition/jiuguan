/*
 * PC-only Node.js network executor for the audited CommandCode upstream boundary.
 * It deliberately does not read ambient environment state or open connections at import time.
 */

import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from 'node:http';
import {
  request as requestHttps,
  type RequestOptions as HttpsRequestOptions,
} from 'node:https';
import { Buffer } from 'node:buffer';
import { PassThrough, Readable, type Duplex } from 'node:stream';
import {
  connect as connectTls,
  type ConnectionOptions as TlsConnectionOptions,
  type TLSSocket,
} from 'node:tls';
import {
  COMMANDCODE_API_ORIGIN,
  COMMANDCODE_UPSTREAM_PATHS,
} from './config.ts';
import {
  CommandCodeAbortError,
  CommandCodeRequestError,
  assertCommandCodeUpstreamRequest,
  type CommandCodeUpstreamRequest,
  type CommandCodeUpstreamTransport,
} from './transport.ts';

const TARGET_HOST = 'api.commandcode.ai';
const TARGET_PORT = 443;
const TARGET_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type CommandCodeNodeTransportErrorCode =
  | 'COMMANDCODE_CONNECT_TIMEOUT'
  | 'COMMANDCODE_REQUEST_TIMEOUT'
  | 'COMMANDCODE_PROXY_CONNECT_FAILED'
  | 'COMMANDCODE_TLS_FAILED'
  | 'COMMANDCODE_UPSTREAM_IO_FAILED'
  | 'COMMANDCODE_REDIRECT_REJECTED'
  | 'COMMANDCODE_INVALID_RESPONSE';

const ERROR_MESSAGES: Readonly<Record<CommandCodeNodeTransportErrorCode, string>> =
  Object.freeze({
    COMMANDCODE_CONNECT_TIMEOUT: 'CommandCode upstream connection timed out',
    COMMANDCODE_REQUEST_TIMEOUT: 'CommandCode upstream request timed out',
    COMMANDCODE_PROXY_CONNECT_FAILED: 'CommandCode upstream proxy connection failed',
    COMMANDCODE_TLS_FAILED: 'CommandCode upstream TLS connection failed',
    COMMANDCODE_UPSTREAM_IO_FAILED: 'CommandCode upstream I/O failed',
    COMMANDCODE_REDIRECT_REJECTED: 'CommandCode upstream redirect was rejected',
    COMMANDCODE_INVALID_RESPONSE: 'CommandCode upstream returned an invalid response',
  });

export class CommandCodeNodeTransportError extends Error {
  constructor(readonly code: CommandCodeNodeTransportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CommandCodeNodeTransportError';
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** Internal seam for deterministic, network-free state-machine tests. */
export interface CommandCodeNodeTransportPlatform {
  readonly httpRequest: (options: HttpRequestOptions) => ClientRequest;
  readonly httpsRequest: (
    options: HttpsRequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ClientRequest;
  readonly tlsConnect: (options: TlsConnectionOptions) => TLSSocket;
  readonly readableToWeb: (readable: Readable) => ReadableStream<Uint8Array>;
  readonly startTimer: (callback: () => void, timeoutMs: number) => TimerHandle;
  readonly cancelTimer: (handle: TimerHandle) => void;
}

const NODE_PLATFORM: CommandCodeNodeTransportPlatform = Object.freeze({
  httpRequest: (options: HttpRequestOptions) => requestHttp(options),
  httpsRequest: (
    options: HttpsRequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => requestHttps(options, onResponse),
  tlsConnect: (options: TlsConnectionOptions) => connectTls(options),
  readableToWeb: nodeReadableToWebSafely,
  startTimer: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs),
  cancelTimer: (handle: TimerHandle) => clearTimeout(handle),
});

function fixedError(code: CommandCodeNodeTransportErrorCode): CommandCodeNodeTransportError {
  return new CommandCodeNodeTransportError(code);
}

function expectedMethod(request: CommandCodeUpstreamRequest): 'GET' | 'POST' {
  return request.purpose === 'models' ? 'GET' : 'POST';
}

function verifyIssuedRequest(request: CommandCodeUpstreamRequest): void {
  assertCommandCodeUpstreamRequest(request);
  const expectedUrl = `${COMMANDCODE_API_ORIGIN}${COMMANDCODE_UPSTREAM_PATHS[request.purpose]}`;
  if (
    request.url !== expectedUrl
    || request.method !== expectedMethod(request)
    || request.policy.redirect !== 'error'
    || !Number.isSafeInteger(request.policy.connectTimeoutMs)
    || request.policy.connectTimeoutMs < 1
    || (
      request.policy.requestTimeoutMs !== null
      && (
        !Number.isSafeInteger(request.policy.requestTimeoutMs)
        || request.policy.requestTimeoutMs < 1
      )
    )
  ) {
    throw new CommandCodeRequestError(
      'transport',
      'issued request does not match the fixed upstream policy',
    );
  }
}

function outboundHeaders(request: CommandCodeUpstreamRequest): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(request.headers)) headers[name] = value;
  if (request.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(request.body, 'utf8'));
  }
  return headers;
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  const rawHeaders = response.rawHeaders;
  if (rawHeaders.length % 2 !== 0) {
    throw fixedError('COMMANDCODE_INVALID_RESPONSE');
  }
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return headers;
}

function proxyHostname(hostname: string): string {
  if (hostname.toLowerCase() === 'localhost') return '127.0.0.1';
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

function proxyAuthorization(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(proxyUrl.username);
    password = decodeURIComponent(proxyUrl.password);
  } catch {
    throw fixedError('COMMANDCODE_PROXY_CONNECT_FAILED');
  }
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function destroyQuietly(resource: { destroy: () => unknown } | undefined): void {
  if (!resource) return;
  try {
    resource.destroy();
  } catch {
    // Destruction is best-effort; callers only receive fixed transport errors.
  }
}

/**
 * Node's built-in Readable.toWeb adapter can enqueue one last PassThrough
 * chunk after a concurrent consumer cancellation has already closed its
 * WebStream controller. On Node 22 that escapes as ERR_INVALID_STATE and can
 * terminate the host process. Keep the terminal flag on our side so a late
 * iterator result is ignored instead of touching a closed controller.
 */
export function nodeReadableToWebSafely(readable: Readable): ReadableStream<Uint8Array> {
  const iterator = readable[Symbol.asyncIterator]();
  let terminal = false;

  const stopSource = async (): Promise<void> => {
    destroyQuietly(readable);
    try {
      await iterator.return?.();
    } catch {
      // The consumer has already cancelled; source cleanup is best-effort.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal) return;
      try {
        const chunk = await iterator.next();
        if (terminal) return;
        if (chunk.done) {
          terminal = true;
          controller.close();
          return;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          terminal = true;
          void stopSource();
          controller.error(fixedError('COMMANDCODE_INVALID_RESPONSE'));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (terminal) return;
        terminal = true;
        controller.error(error);
      }
    },
    async cancel() {
      if (terminal) return;
      terminal = true;
      await stopSource();
    },
  });
}

function cancellableWebBody(
  source: ReadableStream<Uint8Array>,
  onCancel: () => void,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let terminal = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal) return;
      try {
        const chunk = await reader.read();
        if (terminal) return;
        if (chunk.done) {
          terminal = true;
          onDone();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        if (terminal) return;
        terminal = true;
        try {
          controller.error(error);
        } catch {
          // A concurrent cancellation may already have closed the controller.
        }
      }
    },
    async cancel() {
      if (terminal) return;
      terminal = true;
      onCancel();
      try {
        await reader.cancel();
      } catch {
        // Cancellation is already reflected by the fixed lifetime teardown.
      }
    },
  });
}

function executeWithPlatform(
  request: CommandCodeUpstreamRequest,
  platform: CommandCodeNodeTransportPlatform,
): Promise<Response> {
  verifyIssuedRequest(request);
  if (request.signal?.aborted) return Promise.reject(new CommandCodeAbortError());

  return new Promise<Response>((resolve, reject) => {
    let ended = false;
    let sourceEnded = false;
    let responseDelivered = false;
    let upstreamResponseSeen = false;
    let connected = false;
    let connectTimer: TimerHandle | undefined;
    let requestTimer: TimerHandle | undefined;
    let connectRequest: ClientRequest | undefined;
    let upstreamRequest: ClientRequest | undefined;
    let tunnelSocket: Duplex | undefined;
    let secureSocket: TLSSocket | undefined;
    let upstreamResponse: IncomingMessage | undefined;
    let safeBody: PassThrough | undefined;
    let pendingNullBodyResponse: Response | undefined;

    const cancelTimers = (): void => {
      if (connectTimer !== undefined) {
        platform.cancelTimer(connectTimer);
        connectTimer = undefined;
      }
      if (requestTimer !== undefined) {
        platform.cancelTimer(requestTimer);
        requestTimer = undefined;
      }
    };

    const removeAbortListener = (): void => {
      request.signal?.removeEventListener('abort', onAbort);
    };

    const destroyNetwork = (): void => {
      destroyQuietly(upstreamResponse);
      destroyQuietly(upstreamRequest);
      destroyQuietly(connectRequest);
      destroyQuietly(secureSocket);
      destroyQuietly(tunnelSocket);
    };

    const fail = (error: Error): void => {
      if (ended) return;
      ended = true;
      cancelTimers();
      removeAbortListener();
      destroyNetwork();
      if (safeBody && !safeBody.destroyed) safeBody.destroy(error);
      if (!responseDelivered) reject(error);
    };

    const finish = (): void => {
      if (ended) return;
      ended = true;
      sourceEnded = true;
      cancelTimers();
      removeAbortListener();
      if (pendingNullBodyResponse && !responseDelivered) {
        responseDelivered = true;
        resolve(pendingNullBodyResponse);
      }
    };

    function onAbort(): void {
      fail(new CommandCodeAbortError());
    }

    const markConnected = (): void => {
      if (connected || ended) return;
      connected = true;
      if (connectTimer !== undefined) {
        platform.cancelTimer(connectTimer);
        connectTimer = undefined;
      }
    };

    const ioFailure = (): CommandCodeNodeTransportError => (
      fixedError('COMMANDCODE_UPSTREAM_IO_FAILED')
    );

    const attachResponse = (response: IncomingMessage): void => {
      if (ended) {
        destroyQuietly(response);
        return;
      }
      markConnected();
      upstreamResponseSeen = true;
      upstreamResponse = response;
      response.once('aborted', () => fail(ioFailure()));
      response.once('error', () => fail(ioFailure()));
      response.once('close', () => {
        if (!sourceEnded && !response.complete) fail(ioFailure());
      });

      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        response.resume();
        fail(fixedError('COMMANDCODE_REDIRECT_REJECTED'));
        return;
      }
      if (status < 200 || status > 599) {
        response.resume();
        fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
        return;
      }

      let headers: Headers;
      try {
        headers = responseHeaders(response);
      } catch {
        response.resume();
        fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
        return;
      }
      const responseInit: ResponseInit = {
        status,
        statusText: response.statusMessage ?? '',
        headers,
      };

      if (status === 204 || status === 205 || status === 304) {
        try {
          pendingNullBodyResponse = new Response(null, responseInit);
        } catch {
          response.resume();
          fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
          return;
        }
        response.once('end', finish);
        response.resume();
        return;
      }

      safeBody = new PassThrough();
      safeBody.on('error', () => {
        // Readable.toWeb forwards this fixed error; keep Node from treating it as unhandled.
      });
      safeBody.once('close', () => {
        if (sourceEnded || ended) return;
        ended = true;
        cancelTimers();
        removeAbortListener();
        destroyNetwork();
      });
      response.once('end', () => {
        sourceEnded = true;
      });

      let webBody: ReadableStream<Uint8Array>;
      let result: Response;
      try {
        webBody = cancellableWebBody(
          platform.readableToWeb(safeBody),
          () => {
            if (ended) return;
            ended = true;
            cancelTimers();
            removeAbortListener();
            destroyNetwork();
            destroyQuietly(safeBody);
          },
          finish,
        );
        result = new Response(webBody, responseInit);
      } catch {
        fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
        return;
      }
      response.pipe(safeBody);
      responseDelivered = true;
      resolve(result);
    };

    const finishUpstreamRequest = (nodeRequest: ClientRequest): void => {
      upstreamRequest = nodeRequest;
      nodeRequest.once('error', () => fail(ioFailure()));
      nodeRequest.once('upgrade', (response, socket) => {
        response.resume();
        destroyQuietly(socket);
        fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
      });
      nodeRequest.once('connect', (response, socket) => {
        response.resume();
        destroyQuietly(socket);
        fail(fixedError('COMMANDCODE_INVALID_RESPONSE'));
      });
      nodeRequest.once('close', () => {
        if (!upstreamResponseSeen) fail(ioFailure());
      });
      try {
        nodeRequest.end(request.body);
      } catch {
        fail(ioFailure());
      }
    };

    const httpsOptions = (): HttpsRequestOptions => ({
      protocol: 'https:',
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: COMMANDCODE_UPSTREAM_PATHS[request.purpose],
      method: request.method,
      headers: outboundHeaders(request),
      servername: TARGET_HOST,
      rejectUnauthorized: true,
    });

    const startDirect = (): void => {
      const options = { ...httpsOptions(), agent: false } satisfies HttpsRequestOptions;
      const nodeRequest = platform.httpsRequest(options, attachResponse);
      nodeRequest.once('socket', (socket) => {
        secureSocket = socket as TLSSocket;
        secureSocket.once('secureConnect', markConnected);
      });
      finishUpstreamRequest(nodeRequest);
    };

    const startTunnelledHttps = (socket: TLSSocket): void => {
      const options = {
        ...httpsOptions(),
        createConnection: () => socket,
      } satisfies HttpsRequestOptions;
      const nodeRequest = platform.httpsRequest(options, attachResponse);
      finishUpstreamRequest(nodeRequest);
    };

    const startProxy = (): void => {
      const proxySnapshot = request.policy.upstreamProxy;
      if (!proxySnapshot) {
        startDirect();
        return;
      }
      let proxyUrl: URL;
      let authorization: string | undefined;
      try {
        proxyUrl = new URL(proxySnapshot.url);
        authorization = proxyAuthorization(proxyUrl);
      } catch {
        fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
        return;
      }
      const headers: Record<string, string> = { Host: TARGET_AUTHORITY };
      if (authorization) headers['Proxy-Authorization'] = authorization;
      const options: HttpRequestOptions = {
        protocol: 'http:',
        hostname: proxyHostname(proxyUrl.hostname),
        port: Number(proxyUrl.port || '80'),
        method: 'CONNECT',
        path: TARGET_AUTHORITY,
        headers,
        agent: false,
      };
      const nodeRequest = platform.httpRequest(options);
      connectRequest = nodeRequest;
      let proxyConnected = false;
      nodeRequest.on('error', () => {
        if (!proxyConnected) fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
      });
      nodeRequest.once('response', (response) => {
        response.resume();
        fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
      });
      nodeRequest.once('upgrade', (response, socket) => {
        response.resume();
        destroyQuietly(socket);
        fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
      });
      nodeRequest.once('connect', (response, socket, head) => {
        if (ended) {
          destroyQuietly(socket);
          return;
        }
        if (response.statusCode !== 200 || head.length !== 0) {
          destroyQuietly(socket);
          fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
          return;
        }
        proxyConnected = true;
        connectRequest = undefined;
        tunnelSocket = socket;
        let tlsSocket: TLSSocket;
        try {
          tlsSocket = platform.tlsConnect({
            socket,
            servername: TARGET_HOST,
            rejectUnauthorized: true,
            ALPNProtocols: ['http/1.1'],
          });
        } catch {
          fail(fixedError('COMMANDCODE_TLS_FAILED'));
          return;
        }
        secureSocket = tlsSocket;
        const onTlsError = (): void => fail(fixedError('COMMANDCODE_TLS_FAILED'));
        tlsSocket.once('error', onTlsError);
        tlsSocket.once('secureConnect', () => {
          if (ended) return;
          tlsSocket.off('error', onTlsError);
          markConnected();
          try {
            startTunnelledHttps(tlsSocket);
          } catch {
            fail(ioFailure());
          }
        });
      });
      try {
        nodeRequest.end();
      } catch {
        fail(fixedError('COMMANDCODE_PROXY_CONNECT_FAILED'));
      }
    };

    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    connectTimer = platform.startTimer(
      () => fail(fixedError('COMMANDCODE_CONNECT_TIMEOUT')),
      request.policy.connectTimeoutMs,
    );
    if (request.policy.requestTimeoutMs !== null) {
      requestTimer = platform.startTimer(
        () => fail(fixedError('COMMANDCODE_REQUEST_TIMEOUT')),
        request.policy.requestTimeoutMs,
      );
    }
    try {
      startProxy();
    } catch {
      fail(ioFailure());
    }
  });
}

/**
 * Test-only source-module factory. It is intentionally not re-exported by package index.ts.
 */
export function createCommandCodeNodeTransportWithPlatform(
  platform: CommandCodeNodeTransportPlatform,
): Readonly<CommandCodeUpstreamTransport<Response>> {
  return Object.freeze({
    proxySupport: 'loopback-http-connect' as const,
    execute: (request: CommandCodeUpstreamRequest) => executeWithPlatform(request, platform),
  });
}

export function createCommandCodeNodeTransport(): Readonly<CommandCodeUpstreamTransport<Response>> {
  return createCommandCodeNodeTransportWithPlatform(NODE_PLATFORM);
}
