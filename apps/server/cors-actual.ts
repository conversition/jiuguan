import type { IncomingHttpHeaders } from 'node:http';
import { parseSerializedOrigin } from './http-policy.ts';
import { matchRouteAccess } from './route-access.ts';

export type CorsActualDenyCode =
  | 'cors-origin-invalid'
  | 'cors-route-denied'
  | 'cors-cookie-denied';

export type CorsActualDecision =
  | { handled: false }
  | {
      handled: true;
      allowed: false;
      status: 400 | 403;
      code: CorsActualDenyCode;
      origin?: string;
    }
  | {
      handled: true;
      allowed: true;
      origin: string;
    };

export interface CorsActualInput {
  method?: string;
  pathname: string;
  headers: IncomingHttpHeaders;
  rawHeaders: readonly string[];
}

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count++;
  }
  return count;
}

function hasCredentialHeader(
  input: CorsActualInput,
  name: 'cookie' | 'x-jg-csrf',
): boolean {
  return rawHeaderCount(input.rawHeaders, name) > 0 || input.headers[name] !== undefined;
}

export function evaluateCorsActual(
  input: CorsActualInput,
  allowedAppOrigins: ReadonlySet<string>,
): CorsActualDecision {
  if ((input.method ?? 'GET').toUpperCase() === 'OPTIONS') return { handled: false };
  const originCount = rawHeaderCount(input.rawHeaders, 'origin');
  if (originCount === 0 && input.headers.origin === undefined) return { handled: false };
  if (originCount !== 1 || typeof input.headers.origin !== 'string') {
    return {
      handled: true,
      allowed: false,
      status: 400,
      code: 'cors-origin-invalid',
    };
  }
  const origin = parseSerializedOrigin(input.headers.origin);
  if (!origin || !allowedAppOrigins.has(origin)) return { handled: false };

  if (hasCredentialHeader(input, 'cookie') || hasCredentialHeader(input, 'x-jg-csrf')) {
    return {
      handled: true,
      allowed: false,
      status: 403,
      code: 'cors-cookie-denied',
      origin,
    };
  }
  if (!matchRouteAccess(input.method ?? 'GET', input.pathname)) {
    return {
      handled: true,
      allowed: false,
      status: 403,
      code: 'cors-route-denied',
      origin,
    };
  }
  return { handled: true, allowed: true, origin };
}
