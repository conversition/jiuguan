/**
 * P5.2-A5 最小 Web 认证层。
 *
 * 只负责：探测 secured/local-only、内存保存 Cookie 会话 CSRF、为同源 unsafe API 请求
 * 注入 X-JG-CSRF、统一广播 401/403/429。它不持久化任何凭据，也不替代 P6 网络层。
 */
import {
  API_PROTOCOL_VERSION,
  isCookiePairResult,
  isAuthSessionState,
  isServerMeta,
  type AuthSessionState,
  type AssetCapability,
  type PairRequest,
  type ServerMeta,
} from '../../../packages/mobile-contracts/src/index.ts';
import {
  ClientUrlResolver,
  evaluateProtocolAccess,
  normalizeEndpoint,
} from '../../../packages/client-runtime/src/index.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';
import { nativeResultResponse, requirePlatformBridge } from './platformBridge.ts';

export type WebAuthState =
  | { phase: 'unknown' }
  | { phase: 'local-only'; meta: ServerMeta }
  | {
      phase: 'incompatible';
      meta: ServerMeta;
      clientProtocol: number;
      minClientProtocol: number;
      maxClientProtocol: number;
      upgrade: 'client' | 'server';
    }
  | { phase: 'unauthenticated'; meta: ServerMeta }
  | { phase: 'authenticated'; meta: ServerMeta; auth: AuthSessionState }
  | { phase: 'unreachable'; message: string };

export interface WebAuthFailure {
  status: 401 | 403 | 429;
  code: string;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface AuthClientOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  browserOrigin?: string;
}

export class WebAuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, details: Omit<WebAuthFailure, 'status'>) {
    super(details.message);
    this.name = 'WebAuthError';
    this.status = status;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

const env = (import.meta as unknown as { env?: Record<string, string> }).env;
export const WEB_API_BASE = env?.VITE_API_BASE ?? '';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fallbackOrigin(): string {
  // SSR/test-only fallback carries no cleartext network meaning; real browsers always use location.origin.
  return typeof location === 'undefined' ? 'https://localhost' : location.origin;
}

function requestUrl(input: RequestInfo | URL, base: URL): URL | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function mergedHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function publicError(payload: unknown, status: number): Omit<WebAuthFailure, 'status'> {
  const row = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : null;
  if (nested) {
    return {
      code: typeof nested.code === 'string' ? nested.code : 'request-failed',
      message: typeof nested.message === 'string' ? nested.message : '请求失败（HTTP ' + status + '）',
      ...(typeof nested.requestId === 'string' ? { requestId: nested.requestId } : {}),
    };
  }
  return {
    code: typeof row.code === 'string' ? row.code : 'request-failed',
    message: typeof row.error === 'string' ? row.error : '请求失败（HTTP ' + status + '）',
    ...(typeof row.requestId === 'string' ? { requestId: row.requestId } : {}),
  };
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const body = await response.text();
  if (body.trim() === '') {
    throw new Error(`${label} returned an empty response (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const contentType = response.headers.get('Content-Type') ?? 'unknown';
    throw new Error(`${label} returned non-JSON (HTTP ${response.status}, Content-Type: ${contentType})`);
  }
}

export class WebAuthClient {
  readonly #fetch: typeof fetch;
  readonly #base: URL;
  readonly #urls: ClientUrlResolver;
  #state: WebAuthState = { phase: 'unknown' };
  #initializing: Promise<WebAuthState> | null = null;
  #stateListeners = new Set<(state: WebAuthState) => void>();
  #failureListeners = new Set<(failure: WebAuthFailure) => void>();

  constructor(options: AuthClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const browserOrigin = options.browserOrigin ?? fallbackOrigin();
    const endpoint = normalizeEndpoint(options.apiBase ?? WEB_API_BASE, {
      baseOrigin: browserOrigin,
      allowInsecureLoopback: true,
    });
    this.#base = new URL(endpoint.origin);
    this.#urls = new ClientUrlResolver(endpoint);
  }

  get state(): WebAuthState { return this.#state; }
  apiUrl(path: string): string { return this.#urls.api(path); }
  eventUrl(path: string): string { return this.#urls.event(path); }
  assetUrl(path: string): string { return this.#urls.asset(path); }
  assetCapabilityUrl(capability: AssetCapability): string {
    return this.#urls.assetCapability(capability);
  }
  async publicAssetFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(this.assetUrl(path));
    const method = requestMethod(url, init);
    const headers = mergedHeaders(url, init);
    if (WEB_CLIENT_PROFILE.profile === 'android-bundled') {
      return this.#nativeFetch(url, method, headers, init, false, 'base64');
    }
    return this.#fetch(url, { ...init, headers, credentials: 'omit' });
  }
  pluginWidgetUrl(pluginId: string, revision: string): string {
    return this.#urls.pluginWidget(pluginId, revision);
  }

  subscribe(listener: (state: WebAuthState) => void): () => void {
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => { this.#stateListeners.delete(listener); };
  }

  subscribeFailures(listener: (failure: WebAuthFailure) => void): () => void {
    this.#failureListeners.add(listener);
    return () => { this.#failureListeners.delete(listener); };
  }

  initialize(force = false): Promise<WebAuthState> {
    if (!force && this.#state.phase !== 'unknown' && this.#state.phase !== 'unreachable') {
      return Promise.resolve(this.#state);
    }
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#loadState().finally(() => { this.#initializing = null; });
    return this.#initializing;
  }

  async refreshSession(): Promise<WebAuthState> {
    return this.initialize(true);
  }

  clearSession(): void {
    if (this.#state.phase === 'incompatible') return;
    const meta = 'meta' in this.#state ? this.#state.meta : null;
    this.#setState(meta ? { phase: 'unauthenticated', meta } : { phase: 'unknown' });
  }

  async pair(request: PairRequest): Promise<AuthSessionState> {
    if (WEB_CLIENT_PROFILE.profile === 'android-bundled') {
      await requirePlatformBridge().pair({
        ...request,
        transport: 'bearer',
        device: { ...request.device, platform: 'android' },
      });
      const state = await this.refreshSession();
      if (state.phase !== 'authenticated' || state.auth.session.transport !== 'bearer') {
        throw new Error('原生配对成功，但未能读取 Bearer 会话');
      }
      return state.auth;
    }
    const response = await this.fetch('/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new WebAuthError(response.status, publicError(payload, response.status));
    if (!isCookiePairResult(payload)) {
      throw new Error('配对响应不符合 Cookie 会话协议');
    }
    const state = await this.refreshSession();
    if (state.phase !== 'authenticated') throw new Error('配对成功，但未能读取安全会话');
    return state.auth;
  }

  async logout(): Promise<void> {
    const response = await this.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      throw new WebAuthError(response.status, publicError(payload, response.status));
    }
    if (WEB_CLIENT_PROFILE.profile === 'android-bundled') {
      await requirePlatformBridge().clearCredential();
    }
    this.clearSession();
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input, this.#base);
    const internal = url !== null
      && url.origin === this.#base.origin
      && (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ext/'));
    const method = requestMethod(input, init);
    if (internal && url?.pathname !== '/api/capabilities') {
      const state = await this.initialize();
      if (state.phase === 'incompatible' && !['GET', 'HEAD'].includes(method)) {
        throw new WebAuthError(409, {
          code: 'incompatible-client',
          message: '客户端协议与电脑端不兼容；升级完成前已禁用写操作',
        });
      }
    }

    const headers = mergedHeaders(input, init);
    if (
      internal
      && UNSAFE_METHODS.has(method)
      && this.#state.phase === 'authenticated'
      && this.#state.auth.session.transport === 'same-origin-cookie'
    ) {
      const token = this.#state.auth.csrfToken;
      if (!token) throw new Error('Cookie 会话缺少内存态 CSRF token');
      headers.set('X-JG-CSRF', token);
    }
    const target = internal && url !== null && !(input instanceof Request) ? url : input;
    const response = internal && url !== null && WEB_CLIENT_PROFILE.profile === 'android-bundled'
      ? await this.#nativeFetch(url, method, headers, init, url.pathname !== '/api/capabilities')
      : await this.#fetch(target, {
        ...init,
        headers,
        ...(internal ? { credentials: 'include' as const } : {}),
      });
    if (internal && (response.status === 401 || response.status === 403 || response.status === 429)) {
      await this.#recordFailure(response);
    }
    return response;
  }

  async #loadState(): Promise<WebAuthState> {
    try {
      const metaUrl = new URL(this.apiUrl('/api/capabilities'));
      const metaResponse = WEB_CLIENT_PROFILE.profile === 'android-bundled'
        ? await this.#nativeFetch(metaUrl, 'GET', new Headers(), { cache: 'no-store' }, false)
        : await this.#fetch(metaUrl, { cache: 'no-store', credentials: 'include' });
      const metaPayload = await readJsonResponse(metaResponse, 'Capabilities endpoint');
      if (!metaResponse.ok || !isServerMeta(metaPayload)) throw new Error('服务能力响应无效');
      const access = evaluateProtocolAccess(metaPayload, API_PROTOCOL_VERSION);
      if (access.mode === 'read-only') {
        return this.#setState({
          phase: 'incompatible',
          meta: metaPayload,
          clientProtocol: access.clientProtocol,
          minClientProtocol: access.minClientProtocol,
          maxClientProtocol: access.maxClientProtocol,
          upgrade: access.upgrade,
        });
      }
      if (metaPayload.auth.required !== true) {
        return this.#setState({ phase: 'local-only', meta: metaPayload });
      }
      const sessionUrl = new URL(this.apiUrl('/api/auth/session'));
      const sessionResponse = WEB_CLIENT_PROFILE.profile === 'android-bundled'
        ? await this.#nativeFetch(sessionUrl, 'GET', new Headers(), { cache: 'no-store' }, true)
        : await this.#fetch(sessionUrl, { cache: 'no-store', credentials: 'include' });
      if (sessionResponse.status === 401) {
        if (WEB_CLIENT_PROFILE.profile === 'android-bundled') {
          await requirePlatformBridge().clearCredential();
        }
        return this.#setState({ phase: 'unauthenticated', meta: metaPayload });
      }
      const sessionPayload = await readJsonResponse(sessionResponse, 'Auth session endpoint');
      if (!sessionResponse.ok || !isAuthSessionState(sessionPayload)) {
        throw new Error('认证会话响应无效');
      }
      return this.#setState({ phase: 'authenticated', meta: metaPayload, auth: sessionPayload });
    } catch (error) {
      return this.#setState({
        phase: 'unreachable',
        message: error instanceof Error ? error.message : '后端不可达',
      });
    }
  }

  async #nativeFetch(
    url: URL,
    method: string,
    headers: Headers,
    init: RequestInit | undefined,
    authenticated: boolean,
    responseType: 'text' | 'base64' = 'text',
  ): Promise<Response> {
    if (url.origin !== this.#base.origin) throw new Error('原生桥拒绝跨 endpoint 请求');
    if (init?.body !== undefined && typeof init.body !== 'string') {
      throw new Error('原生桥当前只接受字符串请求体');
    }
    const headerObject: Record<string, string> = {};
    headers.forEach((value, key) => { headerObject[key] = value; });
    const result = await requirePlatformBridge().request({
      path: url.pathname + url.search,
      method,
      headers: headerObject,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      authenticated,
      responseType,
    });
    return nativeResultResponse(result);
  }

  async #recordFailure(response: Response): Promise<void> {
    const status = response.status as 401 | 403 | 429;
    let payload: unknown = null;
    try { payload = await response.clone().json(); } catch { /* 公开错误可能无 JSON */ }
    const failure: WebAuthFailure = {
      status,
      ...publicError(payload, status),
      ...(status === 429 ? {
        retryAfterSeconds: Math.max(0, Number(response.headers.get('Retry-After') ?? 0) || 0),
      } : {}),
    };
    if (status === 401) {
      if (WEB_CLIENT_PROFILE.profile === 'android-bundled') {
        await requirePlatformBridge().clearCredential().catch(() => {});
      }
      this.clearSession();
    }
    for (const listener of this.#failureListeners) listener(failure);
  }

  #setState(state: WebAuthState): WebAuthState {
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
    return state;
  }
}

export const authClient = new WebAuthClient();
export const authFetch = authClient.fetch.bind(authClient);
export const apiUrl = authClient.apiUrl.bind(authClient);
export const eventUrl = authClient.eventUrl.bind(authClient);
export const assetUrl = authClient.assetUrl.bind(authClient);
export const assetCapabilityUrl = authClient.assetCapabilityUrl.bind(authClient);
export const pluginWidgetUrl = authClient.pluginWidgetUrl.bind(authClient);
export const publicAssetFetch = authClient.publicAssetFetch.bind(authClient);
