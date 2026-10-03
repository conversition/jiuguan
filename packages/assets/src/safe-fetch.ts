import { lookup as lookupDns } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export type SafeFetchErrorCode =
  | 'aborted'
  | 'invalid-url'
  | 'blocked-target'
  | 'blocked-port'
  | 'dns-failed'
  | 'redirect-limit'
  | 'response-too-large'
  | 'timeout'
  | 'network-error';

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** 唯一允许由调用方定制的请求头；其余安全相关头固定由本模块生成。 */
  accept?: string;
  /** 仅供本地隔离测试；生产调用不得开启。 */
  allowPrivateNetworkForTests?: boolean;
  /** 仅供随机端口 mock server 测试，并且必须和 allowPrivateNetworkForTests 同时开启。 */
  allowNonStandardPortForTests?: boolean;
  /** 调用方生命周期；中止时销毁当前连接并拒绝后续重定向。 */
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_CHUNKS = 8_192;

function validateOptions(options: SafeFetchOptions): number {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new SafeFetchError('timeout', '资源超时配置无效');
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_RESPONSE_BYTES) {
    throw new SafeFetchError('response-too-large', '资源大小上限无效');
  }
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new SafeFetchError('redirect-limit', '资源重定向配置无效');
  }
  if (options.accept !== undefined && (
    options.accept.length < 1
    || options.accept.length > 512
    || /[\r\n\u0000]/.test(options.accept)
  )) {
    throw new SafeFetchError('invalid-url', '资源 Accept 配置无效');
  }
  return maxRedirects;
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SafeFetchError('timeout', '资源请求超时');
  return remaining;
}

function withDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    let settled = false;
    let wait: number;
    try {
      wait = remainingMs(deadline);
    } catch (error) {
      rejectValue(error);
      return;
    }
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectValue(new SafeFetchError('aborted', '资源请求已取消'));
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectValue(new SafeFetchError('timeout', '资源请求超时'));
    }, wait);
    if (signal?.aborted) {
      clearTimeout(timer);
      settled = true;
      rejectValue(new SafeFetchError('aborted', '资源请求已取消'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolveValue(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        rejectValue(error);
      },
    );
  });
}

function throwIfAborted(options: SafeFetchOptions): void {
  if (options.signal?.aborted) throw new SafeFetchError('aborted', '资源请求已取消');
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null;
}

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return false;
  const [a, b] = bytes;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  let input = address.toLowerCase().split('%', 1)[0] ?? '';
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const low = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    input = `${input.slice(0, lastColon)}:${high}:${low}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  const allZero = words.every((word) => word === 0);
  if (allZero || (words.slice(0, 7).every((word) => word === 0) && w7 === 1)) return false;
  // IPv4-compatible / IPv4-mapped IPv6 must inherit the embedded IPv4 decision.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0 || w5 === 0xffff)) {
    const embedded = `${w6! >> 8}.${w6! & 0xff}.${w7! >> 8}.${w7! & 0xff}`;
    return isPublicIpv4(embedded);
  }
  // 只接受标准全球单播 2000::/3；再排除文档、Teredo 与 6to4 转换空间。
  if ((w0! & 0xe000) !== 0x2000) return false;
  if (w0 === 0x2001 && (w1 === 0 || w1 === 0x0db8)) return false;
  if (w0 === 0x2002) return false;
  return true;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseTarget(rawUrl: string, options: SafeFetchOptions): URL {
  if (
    rawUrl.length < 1
    || rawUrl.length > 4_096
    || rawUrl !== rawUrl.trim()
    || /[\u0000-\u001f\u007f]/.test(rawUrl)
  ) {
    throw new SafeFetchError('invalid-url', '资源 URL 无效');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('invalid-url', '资源 URL 无效');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new SafeFetchError('invalid-url', '资源 URL 必须是无凭据的 http(s) 地址');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const testPortAllowed = options.allowPrivateNetworkForTests === true
    && options.allowNonStandardPortForTests === true;
  if (!testPortAllowed && port !== 80 && port !== 443) {
    throw new SafeFetchError('blocked-port', '资源 URL 端口不在允许范围');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SafeFetchError('blocked-target', '资源目标不是公网地址');
  }
  if (!options.allowPrivateNetworkForTests && isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname)) {
    throw new SafeFetchError('blocked-target', '资源目标不是公网地址');
  }
  url.hash = '';
  return url;
}

/** 在读取缓存前执行的无网络 URL/端口/字面 IP 校验。 */
export function validateSafeFetchUrl(rawUrl: string, options: SafeFetchOptions): string {
  validateOptions(options);
  return parseTarget(rawUrl, options).toString();
}

async function resolveTarget(url: URL, options: SafeFetchOptions, deadline: number): Promise<ResolvedTarget> {
  throwIfAborted(options);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SafeFetchError('blocked-target', '资源目标不是公网地址');
  }
  const literalFamily = isIP(hostname);
  let addresses: ResolvedTarget[];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      const resolved = await withDeadline(
        lookupDns(hostname, { all: true, verbatim: true }),
        deadline,
        options.signal,
      );
      addresses = resolved
        .filter((item): item is ResolvedTarget => item.family === 4 || item.family === 6)
        .map((item) => ({ address: item.address, family: item.family }));
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError('dns-failed', '资源域名解析失败');
    }
  }
  if (addresses.length === 0) throw new SafeFetchError('dns-failed', '资源域名没有可用地址');
  throwIfAborted(options);
  if (!options.allowPrivateNetworkForTests && addresses.some((item) => !isPublicNetworkAddress(item.address))) {
    throw new SafeFetchError('blocked-target', '资源目标解析到非公网地址');
  }
  return addresses[0]!;
}

interface SingleResponse extends SafeFetchResult {
  redirect?: string;
}

function requestOnce(
  url: URL,
  target: ResolvedTarget,
  options: SafeFetchOptions,
  deadline: number,
): Promise<SingleResponse> {
  throwIfAborted(options);
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    let ended = false;
    let responseSeen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const succeed = (value: SingleResponse): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResponse(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectResponse(options.signal?.aborted
        ? new SafeFetchError('aborted', '资源请求已取消')
        : error instanceof SafeFetchError
        ? error
        : new SafeFetchError('network-error', '资源网络请求失败'));
    };
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'jiuguan-assets/1',
        Accept: options.accept ?? '*/*',
        'Accept-Encoding': 'identity',
      },
      lookup,
      maxHeaderSize: 32 * 1024,
      signal: options.signal,
    }, (response) => {
      responseSeen = true;
      response.once('error', fail);
      response.once('aborted', () => fail(new SafeFetchError('network-error', '资源响应意外中止')));
      response.once('close', () => {
        if (!ended && !settled) fail(new SafeFetchError('network-error', '资源响应提前关闭'));
      });
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        let redirect: string;
        try {
          redirect = new URL(location, url).toString();
        } catch {
          response.destroy();
          fail(new SafeFetchError('invalid-url', '资源重定向地址无效'));
          return;
        }
        // 不读取重定向 body，立即关闭旧跳连接，避免无限滴流占用资源。
        succeed({
          status,
          headers: response.headers,
          body: Buffer.alloc(0),
          finalUrl: url.toString(),
          redirect,
        });
        response.destroy();
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        fail(new SafeFetchError('response-too-large', '资源响应超过大小上限'));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > options.maxBytes || chunks.length >= MAX_RESPONSE_CHUNKS) {
          fail(new SafeFetchError('response-too-large', '资源响应超过大小或分片上限'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        ended = true;
        succeed({
          status,
          headers: response.headers,
          body: Buffer.concat(chunks, size),
          finalUrl: url.toString(),
        });
      });
    });
    request.once('error', fail);
    request.once('close', () => {
      if (!responseSeen && !settled) fail(new SafeFetchError('network-error', '资源连接提前关闭'));
    });
    let wait: number;
    try {
      wait = remainingMs(deadline);
    } catch (error) {
      request.destroy();
      fail(error);
      return;
    }
    timer = setTimeout(() => {
      const error = new SafeFetchError('timeout', '资源请求超时');
      fail(error);
      request.destroy();
    }, wait);
    request.end();
  });
}

/**
 * 安全的服务端资源读取：每一跳先解析并校验全部 DNS 地址，再把本次连接 pin 到已校验地址；
 * 禁止凭据 URL、私网/回环/保留地址、非 80/443 端口、无限重定向和无界响应体。
 */
export async function safeFetchBuffer(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  throwIfAborted(options);
  const maxRedirects = validateOptions(options);
  const deadline = Date.now() + options.timeoutMs;
  let current = parseTarget(rawUrl, options);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    throwIfAborted(options);
    const target = await resolveTarget(current, options, deadline);
    const response = await requestOnce(current, target, options, deadline);
    if (!response.redirect) return response;
    throwIfAborted(options);
    if (redirectCount === maxRedirects) {
      throw new SafeFetchError('redirect-limit', '资源重定向次数过多');
    }
    current = parseTarget(response.redirect, options);
  }
  throw new SafeFetchError('redirect-limit', '资源重定向次数过多');
}
