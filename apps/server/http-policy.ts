import type { IncomingHttpHeaders } from 'node:http';
import { matchRouteAccess } from './route-access.ts';

export type HttpRouteKind =
  | 'public-static'
  | 'public-health'
  | 'public-capabilities'
  | 'public-asset'
  | 'protected-api'
  | 'protected-extension'
  | 'protected-unknown';

export interface HttpRouteClassification {
  access: 'public' | 'protected';
  kind: HttpRouteKind;
}

export interface HttpRouteInput {
  method?: string;
  pathname: string;
  /** Only a containment-checked static resolver may set this flag. */
  publicStatic?: boolean;
}

export interface HttpPolicyInput extends HttpRouteInput {
  headers: IncomingHttpHeaders;
}

export type HttpPolicyDenyCode =
  | 'origin-invalid'
  | 'origin-denied'
  | 'fetch-metadata-invalid'
  | 'cross-site-denied'
  | 'asset-navigation-denied'
  | 'asset-destination-denied'
  | 'multipart-required'
  | 'json-required';

interface HttpPolicyDecisionBase {
  route: HttpRouteClassification;
  client: 'browser' | 'native';
  origin?: string;
  preflight: boolean;
}

export interface HttpPolicyAllowed extends HttpPolicyDecisionBase {
  ok: true;
}

export interface HttpPolicyDenied extends HttpPolicyDecisionBase {
  ok: false;
  status: 403 | 415;
  code: HttpPolicyDenyCode;
}

export type HttpPolicyDecision = HttpPolicyAllowed | HttpPolicyDenied;

export type HttpAuthorityDenyCode = 'host-invalid' | 'host-denied';

export type HttpAuthorityDecision =
  | { ok: true; authority: string }
  | { ok: false; status: 400 | 421; code: HttpAuthorityDenyCode };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const PUBLIC_ASSET_DESTINATIONS = new Set([
  'audio',
  'font',
  'image',
  'manifest',
  'script',
  'style',
  'track',
  'video',
]);

function normalizeMethod(method: string | undefined): string {
  const normalized = (method ?? 'GET').trim().toUpperCase();
  return normalized || 'GET';
}

/**
 * Decode once for policy classification so encoded separators cannot make an
 * API or extension request look like a public static path.
 */
function policyPath(pathname: string): string | null {
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#')) return null;
  try {
    return decodeURIComponent(pathname).replaceAll('\\', '/');
  } catch {
    return null;
  }
}

function inNamespace(pathname: string, namespace: '/api' | '/ext'): boolean {
  const lower = pathname.toLowerCase();
  return lower === namespace || lower.startsWith(`${namespace}/`);
}

/** Unknown routes are protected by default. */
export function classifyHttpRoute(input: HttpRouteInput): HttpRouteClassification {
  const method = normalizeMethod(input.method);
  const pathname = policyPath(input.pathname);

  if (pathname === '/health' && method === 'GET') {
    return { access: 'public', kind: 'public-health' };
  }
  if (pathname === '/api/capabilities' && method === 'GET') {
    return { access: 'public', kind: 'public-capabilities' };
  }
  if ((pathname === '/api/assets/img' && method === 'GET')
    || (pathname !== null
      && /^\/api\/assets\/content\/[a-f0-9]{24}$/.test(pathname)
      && (method === 'GET' || method === 'HEAD'))
    || (pathname !== null
      && /^\/api\/assets\/download\/[a-f0-9]{24}\/(?:json|png)$/.test(pathname)
      && (method === 'GET' || method === 'HEAD'))) {
    return { access: 'public', kind: 'public-asset' };
  }
  if (pathname && inNamespace(pathname, '/api')) {
    return { access: 'protected', kind: 'protected-api' };
  }
  if (pathname && inNamespace(pathname, '/ext')) {
    return { access: 'protected', kind: 'protected-extension' };
  }
  if (pathname && input.publicStatic === true && (method === 'GET' || method === 'HEAD')) {
    return { access: 'public', kind: 'public-static' };
  }
  return { access: 'protected', kind: 'protected-unknown' };
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${label} must be an integer in 1..65535`);
  }
}

/**
 * Build exact local origins. No proxy headers, remote address, wildcards, or
 * hostname suffix checks participate in this allowlist.
 */
export function buildLocalExactOrigins(backendPort: number, vitePort?: number): ReadonlySet<string> {
  assertPort(backendPort, 'backendPort');
  if (vitePort !== undefined) assertPort(vitePort, 'vitePort');
  const ports = new Set([backendPort, ...(vitePort === undefined ? [] : [vitePort])]);
  const origins = new Set<string>();
  for (const port of ports) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}

/**
 * 解析可选的 Vite/dev 前端端口。
 *
 * 生产（未设置 `JG_DEV_WEB_PORT`）**不**信任任何 dev origin：此前 server.ts 无条件把
 * `:5173` 加进 Origin allowlist，等于任何本机进程都能用 dev server 来源读 API。
 * 这里把"信任 dev 来源"改成显式配置；未配置即返回 undefined。
 */
export function parseDevWebPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('JG_DEV_WEB_PORT 必须是 1..65535 的整数');
  }
  return port;
}

/** Exact HTTP authorities accepted by the loopback listener before any route is served. */
export function buildLocalExactAuthorities(backendPort: number): ReadonlySet<string> {
  assertPort(backendPort, 'backendPort');
  const authorities = new Set([
    `127.0.0.1:${backendPort}`,
    `localhost:${backendPort}`,
  ]);
  if (backendPort === 80) {
    authorities.add('127.0.0.1');
    authorities.add('localhost');
  }
  return authorities;
}

function rawHeaderOccurrences(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count++;
  }
  return count;
}

/**
 * Reject DNS-rebinding and Host-confusion requests before static files or APIs.
 * Proxy headers are deliberately ignored; a future HTTPS gateway must add an
 * explicitly configured public authority instead of inheriting forwarded input.
 */
export function evaluateHttpAuthority(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  allowedAuthorities: ReadonlySet<string>,
): HttpAuthorityDecision {
  if (rawHeaderOccurrences(rawHeaders, 'host') !== 1) {
    return { ok: false, status: 400, code: 'host-invalid' };
  }
  const raw = headers.host;
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw.length > 255
    || raw !== raw.trim()
    || /[\s,\/\\@?#]/.test(raw)
  ) {
    return { ok: false, status: 400, code: 'host-invalid' };
  }
  const authority = raw.toLowerCase();
  if (!allowedAuthorities.has(authority)) {
    return { ok: false, status: 421, code: 'host-denied' };
  }
  return { ok: true, authority };
}

export function parseSerializedOrigin(value: string): string | null {
  if (!value || value !== value.trim() || value === 'null' || value.includes('*')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    return null;
  }
  // An Origin header has no path or trailing slash and must be canonical.
  return parsed.origin === value ? parsed.origin : null;
}

/** Validate configured origins at startup; invalid or wildcard entries fail closed. */
export function createExactOriginAllowlist(origins: Iterable<string>): ReadonlySet<string> {
  const allowlist = new Set<string>();
  for (const candidate of origins) {
    const origin = parseSerializedOrigin(candidate);
    if (!origin) throw new TypeError(`Invalid Origin configuration: ${candidate}`);
    allowlist.add(origin);
  }
  return allowlist;
}

export interface PublicHttpsConfig {
  origins: ReadonlySet<string>;
  authorities: ReadonlySet<string>;
}

/**
 * 解析私有 HTTPS 网关的精确公开 origin。配置只用于扩充 allowlist；监听地址仍由
 * server 固定为 loopback，Forwarded/X-Forwarded-* 永不参与推导。
 */
export function parsePublicHttpsOrigins(value: string | undefined): PublicHttpsConfig {
  if (value === undefined || value.trim() === '') {
    return { origins: new Set(), authorities: new Set() };
  }
  const candidates = value.split(',').map((candidate) => candidate.trim());
  if (candidates.length > 8 || candidates.some((candidate) => candidate.length === 0)) {
    throw new TypeError('JG_PUBLIC_HTTPS_ORIGINS 必须包含 1..8 个非空精确 HTTPS origin');
  }
  const origins = createExactOriginAllowlist(candidates);
  const authorities = new Set<string>();
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.host.length === 0 || parsed.host.length > 255) {
      throw new TypeError(`Invalid public HTTPS Origin configuration: ${origin}`);
    }
    authorities.add(parsed.host.toLowerCase());
  }
  return { origins, authorities };
}

interface SingleHeader {
  present: boolean;
  ambiguous: boolean;
  value?: string;
}

function singleHeader(headers: IncomingHttpHeaders, name: string): SingleHeader {
  const raw = headers[name];
  if (raw === undefined) return { present: false, ambiguous: false };
  if (Array.isArray(raw)) {
    if (raw.length !== 1 || raw[0] === undefined) return { present: true, ambiguous: true };
    return { present: true, ambiguous: false, value: raw[0] };
  }
  return { present: true, ambiguous: false, value: raw };
}

function isJsonContentType(headers: IncomingHttpHeaders): boolean {
  const header = singleHeader(headers, 'content-type');
  if (!header.present || header.ambiguous || header.value === undefined) return false;
  const mediaType = header.value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function isMultipartContentType(headers: IncomingHttpHeaders): boolean {
  const header = singleHeader(headers, 'content-type');
  if (!header.present || header.ambiguous || header.value === undefined) return false;
  return /^multipart\/form-data\s*;\s*boundary=(?:"[^"]+"|[^\s;]+)$/i.test(header.value);
}

function isCoreApiPath(pathname: string): boolean {
  const decoded = policyPath(pathname);
  return decoded !== null && inNamespace(decoded, '/api');
}

/**
 * ES modules and fonts loaded by an opaque sandbox use CORS with Origin:null.
 * Only those browser-controlled destinations may receive an ACAO response;
 * ordinary fetch/XHR (dest=empty) deliberately remains unreadable.
 */
export function shouldAllowOpaqueAssetCors(input: HttpPolicyInput): boolean {
  if (classifyHttpRoute(input).kind !== 'public-asset') return false;
  const origin = singleHeader(input.headers, 'origin');
  const site = singleHeader(input.headers, 'sec-fetch-site');
  const mode = singleHeader(input.headers, 'sec-fetch-mode');
  const destination = singleHeader(input.headers, 'sec-fetch-dest');
  if (origin.ambiguous || site.ambiguous || mode.ambiguous || destination.ambiguous) return false;
  const dest = destination.value?.trim().toLowerCase();
  return origin.value === 'null'
    && site.value?.trim().toLowerCase() === 'cross-site'
    && mode.value?.trim().toLowerCase() === 'cors'
    && (dest === 'script' || dest === 'font');
}

/**
 * Evaluate Origin/CSRF request shape. Device authentication is deliberately a
 * later gate. Origin-less callers are admitted as native, never as trusted
 * loopback callers, and must still present their device credential later.
 */
export function evaluateHttpPolicy(
  input: HttpPolicyInput,
  allowedOrigins: ReadonlySet<string>,
  allowedCrossSiteOrigins: ReadonlySet<string> = new Set(),
): HttpPolicyDecision {
  const method = normalizeMethod(input.method);
  const route = classifyHttpRoute(input);
  const originHeader = singleHeader(input.headers, 'origin');
  const client: 'browser' | 'native' = originHeader.present ? 'browser' : 'native';
  const base = { route, client, preflight: method === 'OPTIONS' } as const;

  const fetchSite = singleHeader(input.headers, 'sec-fetch-site');
  if (fetchSite.present && fetchSite.ambiguous) {
    return { ...base, ok: false, status: 403, code: 'fetch-metadata-invalid' };
  }
  const publicAsset = route.kind === 'public-asset';
  const fetchMode = singleHeader(input.headers, 'sec-fetch-mode');
  const fetchDest = singleHeader(input.headers, 'sec-fetch-dest');
  if (publicAsset && (
    (fetchMode.present && fetchMode.ambiguous)
    || (fetchDest.present && fetchDest.ambiguous)
  )) {
    return { ...base, ok: false, status: 403, code: 'fetch-metadata-invalid' };
  }
  const mode = fetchMode.value?.trim().toLowerCase();
  const destination = fetchDest.value?.trim().toLowerCase();
  const site = fetchSite.value?.trim().toLowerCase();
  const configuredCrossSiteOrigin = !originHeader.ambiguous
    && originHeader.value !== undefined
    && allowedCrossSiteOrigins.has(parseSerializedOrigin(originHeader.value) ?? '');
  if (publicAsset && (
    mode === 'navigate'
    || destination === 'document'
    || destination === 'iframe'
    || destination === 'embed'
    || destination === 'object'
  )) {
    return { ...base, ok: false, status: 403, code: 'asset-navigation-denied' };
  }
  if (publicAsset && site === 'cross-site' && !PUBLIC_ASSET_DESTINATIONS.has(destination ?? '')) {
    return { ...base, ok: false, status: 403, code: 'asset-destination-denied' };
  }
  if (!publicAsset && fetchSite.present && site === 'cross-site' && !configuredCrossSiteOrigin) {
    return { ...base, ok: false, status: 403, code: 'cross-site-denied' };
  }

  let origin: string | undefined;
  let opaqueAssetOrigin = false;
  if (originHeader.present) {
    if (originHeader.ambiguous || originHeader.value === undefined) {
      return { ...base, ok: false, status: 403, code: 'origin-invalid' };
    }
    if (publicAsset && originHeader.value === 'null') {
      origin = 'null';
      opaqueAssetOrigin = true;
    } else {
      origin = parseSerializedOrigin(originHeader.value) ?? undefined;
    }
    if (!origin) {
      return { ...base, ok: false, status: 403, code: 'origin-invalid' };
    }
    if (!opaqueAssetOrigin && !allowedOrigins.has(origin)) {
      return { ...base, origin, ok: false, status: 403, code: 'origin-denied' };
    }
  }

  if (!SAFE_METHODS.has(method) && isCoreApiPath(input.pathname)) {
    const bodyMode = matchRouteAccess(method, input.pathname)?.body;
    if (bodyMode === 'multipart') {
      if (!isMultipartContentType(input.headers)) {
        return { ...base, ...(origin ? { origin } : {}), ok: false, status: 415, code: 'multipart-required' };
      }
    } else if (!isJsonContentType(input.headers)) {
      return { ...base, ...(origin ? { origin } : {}), ok: false, status: 415, code: 'json-required' };
    }
  }

  return { ...base, ...(origin ? { origin } : {}), ok: true };
}
