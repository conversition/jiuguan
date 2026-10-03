import {
  isCsrfToken,
  isSafeOpaqueId,
  type AuthTransport,
} from '@jiuguan/mobile-contracts';
import type { ClientFetch } from './capability-handshake.ts';
import type { NormalizedEndpoint } from './endpoint.ts';
import { ClientRuntimeError } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORBIDDEN_CALLER_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-jg-csrf',
  'origin',
  'host',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

export interface ClientAuthTransport {
  readonly kind: AuthTransport;
  readonly endpoint: NormalizedEndpoint;
  execute(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response>;
}

export interface CookieTransportOptions {
  endpoint: NormalizedEndpoint;
  fetchImpl: ClientFetch;
  /**
   * 只读取 auth session 的内存态 CSRF；不得由 localStorage/URL 等持久来源实现。
   * safe method 不调用该 provider。
   */
  csrfTokenProvider: () => string | undefined | Promise<string | undefined>;
}

export interface BearerCredentialContext {
  endpointOrigin: string;
  serverId: string;
  deviceId: string;
}

/**
 * 平台安全存储适配器只暴露“代为执行已授权请求”，不提供 getToken()/readToken()。
 * 适配器应在其内部读取凭据、克隆 Request、附加 Authorization 后执行网络请求。
 */
export interface BearerCredentialProvider {
  /**
   * 凭据缺失/安全存储不可用时应抛 `ClientRuntimeError('credential_unavailable')`；
   * 普通 fetch 网络异常可直接抛出，由 transport 归类为可重试 network_error。
   */
  authorizedFetch(
    requestWithoutCredential: Request,
    context: Readonly<BearerCredentialContext>,
  ): Promise<Response>;
}

export interface BearerTransportOptions {
  endpoint: NormalizedEndpoint;
  serverId: string;
  deviceId: string;
  credentialProvider: BearerCredentialProvider;
}

function requestForEndpoint(
  endpoint: NormalizedEndpoint,
  input: string | URL | Request,
  init: RequestInit | undefined,
  transport: AuthTransport,
): Request {
  let rawUrl: string;
  if (input instanceof Request) rawUrl = input.url;
  else rawUrl = String(input);

  let url: URL;
  try {
    url = new URL(rawUrl, endpoint.origin);
  } catch (cause) {
    throw new ClientRuntimeError('transport_violation', { cause });
  }
  if (url.origin !== endpoint.origin || url.username || url.password) {
    throw new ClientRuntimeError('transport_violation');
  }

  let request: Request;
  try {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(url, init);
  } catch (cause) {
    throw new ClientRuntimeError('transport_violation', { cause });
  }
  for (const header of FORBIDDEN_CALLER_HEADERS) {
    if (request.headers.has(header)) {
      throw new ClientRuntimeError('transport_violation', {
        details: { transport, header },
      });
    }
  }
  return request;
}

function transportRequest(
  request: Request,
  options: {
    credentials: 'omit' | 'same-origin' | 'include';
    mode: 'same-origin' | 'cors';
    headers?: Headers;
  },
): Request {
  return new Request(request, {
    credentials: options.credentials,
    mode: options.mode,
    redirect: 'error',
    headers: options.headers ?? request.headers,
  });
}

export function createCookieTransport(
  options: CookieTransportOptions,
): ClientAuthTransport {
  return Object.freeze({
    kind: 'same-origin-cookie' as const,
    endpoint: options.endpoint,
    async execute(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = requestForEndpoint(
        options.endpoint,
        input,
        init,
        'same-origin-cookie',
      );
      const headers = new Headers(request.headers);
      if (!SAFE_METHODS.has(request.method.toUpperCase())) {
        let csrfToken: string | undefined;
        try {
          csrfToken = await options.csrfTokenProvider();
        } catch (cause) {
          throw new ClientRuntimeError('credential_unavailable', { cause });
        }
        if (!isCsrfToken(csrfToken)) {
          throw new ClientRuntimeError('credential_unavailable');
        }
        headers.set('X-JG-CSRF', csrfToken);
      }
      return options.fetchImpl(transportRequest(request, {
        credentials: 'include',
        mode: 'same-origin',
        headers,
      }));
    },
  });
}

export function createBearerTransport(
  options: BearerTransportOptions,
): ClientAuthTransport {
  if (!options.endpoint.isSecure
    || !isSafeOpaqueId(options.serverId)
    || !isSafeOpaqueId(options.deviceId)) {
    throw new ClientRuntimeError('transport_violation');
  }
  const context = Object.freeze({
    endpointOrigin: options.endpoint.origin,
    serverId: options.serverId,
    deviceId: options.deviceId,
  });
  return Object.freeze({
    kind: 'bearer' as const,
    endpoint: options.endpoint,
    async execute(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = transportRequest(
        requestForEndpoint(options.endpoint, input, init, 'bearer'),
        { credentials: 'omit', mode: 'cors' },
      );
      try {
        const response = await options.credentialProvider.authorizedFetch(request, context);
        if (!(response instanceof Response)) {
          throw new ClientRuntimeError('transport_violation', {
            details: { reason: 'invalid-bearer-provider-response' },
          });
        }
        return response;
      } catch (cause) {
        if (cause instanceof ClientRuntimeError) throw cause;
        throw new ClientRuntimeError('network_error', { retryable: true, cause });
      }
    },
  });
}
