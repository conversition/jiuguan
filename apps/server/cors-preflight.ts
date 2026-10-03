import type { IncomingHttpHeaders } from 'node:http';
import { parseSerializedOrigin } from './http-policy.ts';
import { matchRouteAccess, type RouteAccessPolicy } from './route-access.ts';

export type CorsPreflightDenyCode =
  | 'cors-preflight-invalid'
  | 'cors-origin-denied'
  | 'cors-route-denied'
  | 'cors-header-denied';

export type CorsPreflightDecision =
  | { handled: false }
  | {
      handled: true;
      allowed: false;
      status: 400 | 403;
      code: CorsPreflightDenyCode;
    }
  | {
      handled: true;
      allowed: true;
      origin: string;
      method: string;
      headers: readonly string[];
    };

export interface CorsPreflightInput {
  method?: string;
  pathname: string;
  headers: IncomingHttpHeaders;
  rawHeaders: readonly string[];
}

interface HeaderValue {
  present: boolean;
  invalid: boolean;
  value?: string;
}

const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_~-]+$/;
const METHOD_TOKEN_RE = /^[A-Z]+$/;

function singleHeader(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  name: string,
): HeaderValue {
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) occurrences++;
  }
  const raw = headers[name];
  if (occurrences === 0 && raw === undefined) return { present: false, invalid: false };
  if (occurrences !== 1 || typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim()) {
    return { present: true, invalid: true };
  }
  return { present: true, invalid: false, value: raw };
}

function requestedHeaders(value: string | undefined): readonly string[] | null {
  if (value === undefined) return [];
  const parts = value.split(',').map((item) => item.trim().toLowerCase());
  if (parts.length === 0
    || parts.some((item) => item.length === 0 || !HEADER_TOKEN_RE.test(item))
    || new Set(parts).size !== parts.length) {
    return null;
  }
  return Object.freeze(parts);
}

function allowedHeaders(policy: RouteAccessPolicy, method: string): ReadonlySet<string> {
  const allowed = new Set<string>(['x-request-id']);
  if (policy.access === 'protected') allowed.add('authorization');
  if (policy.body !== 'none') allowed.add('content-type');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    allowed.add('if-match');
    allowed.add('idempotency-key');
  }
  if (policy.template === '/api/assets/content/:assetId'
    && (method === 'GET' || method === 'HEAD')) {
    allowed.add('range');
  }
  return allowed;
}

export function parseAppOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === '') return new Set();
  const candidates = value.split(',').map((candidate) => candidate.trim());
  if (candidates.length > 4 || candidates.some((candidate) => candidate.length === 0)) {
    throw new TypeError('JG_APP_ORIGINS 必须包含 1..4 个非空精确 HTTP(S) origin');
  }
  const result = new Set<string>();
  for (const candidate of candidates) {
    const origin = parseSerializedOrigin(candidate);
    if (!origin) throw new TypeError('Invalid app Origin configuration: ' + candidate);
    result.add(origin);
  }
  return result;
}

export function assertAppOriginsDisjoint(
  appOrigins: ReadonlySet<string>,
  webOrigins: ReadonlySet<string>,
): void {
  for (const origin of appOrigins) {
    if (webOrigins.has(origin)) {
      throw new TypeError('JG_APP_ORIGINS 不能与同源 Web origin 重叠: ' + origin);
    }
  }
}

export function evaluateCorsPreflight(
  input: CorsPreflightInput,
  allowedAppOrigins: ReadonlySet<string>,
): CorsPreflightDecision {
  if ((input.method ?? 'GET').toUpperCase() !== 'OPTIONS') return { handled: false };

  const origin = singleHeader(input.headers, input.rawHeaders, 'origin');
  const requestedMethod = singleHeader(
    input.headers,
    input.rawHeaders,
    'access-control-request-method',
  );
  const requestedHeaderNames = singleHeader(
    input.headers,
    input.rawHeaders,
    'access-control-request-headers',
  );
  const contentLength = singleHeader(input.headers, input.rawHeaders, 'content-length');
  const transferEncoding = singleHeader(input.headers, input.rawHeaders, 'transfer-encoding');
  const hasCorsSignal = origin.present || requestedMethod.present || requestedHeaderNames.present;
  if (!hasCorsSignal) return { handled: false };
  if (origin.invalid
    || requestedMethod.invalid
    || requestedHeaderNames.invalid
    || contentLength.invalid
    || transferEncoding.invalid
    || transferEncoding.present
    || (contentLength.present && contentLength.value !== '0')
    || !origin.present
    || !requestedMethod.present
    || origin.value === undefined
    || requestedMethod.value === undefined
    || !METHOD_TOKEN_RE.test(requestedMethod.value)) {
    return {
      handled: true,
      allowed: false,
      status: 400,
      code: 'cors-preflight-invalid',
    };
  }

  const parsedOrigin = parseSerializedOrigin(origin.value);
  if (!parsedOrigin || !allowedAppOrigins.has(parsedOrigin)) {
    return {
      handled: true,
      allowed: false,
      status: 403,
      code: 'cors-origin-denied',
    };
  }

  const policy = matchRouteAccess(requestedMethod.value, input.pathname);
  if (!policy) {
    return {
      handled: true,
      allowed: false,
      status: 403,
      code: 'cors-route-denied',
    };
  }
  const headers = requestedHeaders(requestedHeaderNames.value);
  if (headers === null) {
    return {
      handled: true,
      allowed: false,
      status: 400,
      code: 'cors-preflight-invalid',
    };
  }
  const permitted = allowedHeaders(policy, requestedMethod.value);
  if (headers.some((header) => !permitted.has(header))) {
    return {
      handled: true,
      allowed: false,
      status: 403,
      code: 'cors-header-denied',
    };
  }

  return {
    handled: true,
    allowed: true,
    origin: parsedOrigin,
    method: requestedMethod.value,
    headers,
  };
}
