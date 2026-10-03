import { ClientRuntimeError } from './errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface NormalizeEndpointOptions {
  /**
   * 浏览器同源模式把 location.origin 显式注入；运行层不直接读取 window/location。
   */
  baseOrigin?: string;
  /** 只供电脑本机开发/同源 HTTP 使用，远端 HTTP 即使开启也仍被拒绝。 */
  allowInsecureLoopback?: boolean;
}

export interface NormalizedEndpoint {
  origin: string;
  apiBase: string;
  capabilitiesUrl: string;
  protocol: 'http:' | 'https:';
  isLoopback: boolean;
  isSecure: boolean;
}

function parseUrl(raw: string, baseOrigin?: string): URL {
  try {
    return baseOrigin === undefined ? new URL(raw) : new URL(raw, baseOrigin);
  } catch (cause) {
    throw new ClientRuntimeError('invalid_endpoint', { cause });
  }
}

export function normalizeEndpoint(
  input: string | URL,
  options: NormalizeEndpointOptions = {},
): NormalizedEndpoint {
  const raw = input instanceof URL ? input.href : input.trim();
  const fallback = options.baseOrigin?.trim();
  if (raw.length === 0 && !fallback) {
    throw new ClientRuntimeError('invalid_endpoint');
  }
  const url = parseUrl(raw.length === 0 ? fallback! : raw, fallback);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ClientRuntimeError('invalid_endpoint');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ClientRuntimeError('invalid_endpoint');
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  const isSecure = url.protocol === 'https:';
  if (!isSecure && !(isLoopback && options.allowInsecureLoopback === true)) {
    throw new ClientRuntimeError('insecure_endpoint');
  }

  const origin = url.origin;
  return Object.freeze({
    origin,
    apiBase: origin,
    capabilitiesUrl: new URL('/api/capabilities', origin).href,
    protocol: url.protocol,
    isLoopback,
    isSecure,
  });
}
