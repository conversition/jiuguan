import { closeSync, createReadStream, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

export interface StaticWebOptions {
  rootDir: string;
  contentSecurityPolicy?: string;
}

export type StaticWebHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean;

export const STATIC_WEB_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join('; ');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const RESERVED_ROUTE_ROOTS = ['/api', '/ext', '/health'] as const;
const DANGEROUS_ESCAPE = /%(?:00|25|2e|2f|5c)/i;
// Vite/Rollup uses URL-safe base64-like hashes after a dash, while some
// pipelines emit hexadecimal digests after a dot.
const HASHED_ASSET = /(?:\.[a-f0-9]{8,64}|-[a-z0-9_-]{8,64})(?=\.[^.]+$)/i;

type ParsedPath =
  | { ok: true; pathname: string; segments: string[] }
  | { ok: false };

function rawPathOf(url: string | undefined): string | undefined {
  if (!url) return '/';
  const query = url.search(/[?#]/);
  const rawPath = query >= 0 ? url.slice(0, query) : url;
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return undefined;
  return rawPath;
}

function parsePath(url: string | undefined): ParsedPath {
  const rawPath = rawPathOf(url);
  if (!rawPath || rawPath.includes('\\') || rawPath.includes('\0')) {
    return { ok: false };
  }
  if (DANGEROUS_ESCAPE.test(rawPath)) return { ok: false };

  const segments: string[] = [];
  for (const rawSegment of rawPath.split('/')) {
    if (!rawSegment) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { ok: false };
    }
    if (
      segment === '.'
      || segment === '..'
      || segment.startsWith('.')
      || segment.includes('\\')
      || segment.includes('/')
      || segment.includes('\0')
      || DANGEROUS_ESCAPE.test(segment)
    ) {
      return { ok: false };
    }
    segments.push(segment);
  }

  return {
    ok: true,
    pathname: '/' + segments.join('/'),
    segments,
  };
}

function isReservedRoute(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return RESERVED_ROUTE_ROOTS.some((root) => (
    normalized === root || normalized.startsWith(root + '/')
  ));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ''
    || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function existingFileWithinRoot(root: string, candidate: string): string | undefined {
  try {
    const actual = realpathSync(candidate);
    if (!isWithinRoot(root, actual) || !statSync(actual).isFile()) return undefined;
    return actual;
  } catch {
    return undefined;
  }
}

/**
 * SPA fallback 只在客户端**明确接受 HTML** 时启用。
 *
 * 旧实现把通配 Accept（星号斜杠星号）和无 Accept 都算作接受 HTML，于是
 * `<img src="/foo">`（Accept 形如 `image/avif,image/webp,<通配>`）和 `fetch('/foo')`
 * 的 cache miss 都会拿到 200 + index.html，把资源 404 伪装成 HTML。这里只认显式
 * `text/html` 且 q 值 > 0（`text/html;q=0` 视为不接受）。
 */
function acceptsHtml(req: IncomingMessage): boolean {
  const raw = req.headers.accept;
  if (raw === undefined) return false;
  const accept = Array.isArray(raw) ? raw.join(',') : raw;
  if (accept.trim() === '') return false;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';');
    if (range?.trim().toLowerCase() !== 'text/html') continue;
    let quality = 1;
    for (const param of params) {
      const [name, value] = param.split('=');
      if (name?.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(value?.trim());
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    return quality > 0;
  }
  return false;
}

function canUseSpaFallback(req: IncomingMessage, pathname: string): boolean {
  if (isReservedRoute(pathname)) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return (lastSegment === '' || extname(lastSegment) === '') && acceptsHtml(req);
}

function contentTypeFor(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function writeSecurityHeaders(
  res: ServerResponse,
  contentSecurityPolicy: string,
): void {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
}

const NOT_FOUND_BODY = 'Not Found';

/**
 * 统一拒绝响应。必须先清掉此前为**成功路径**准备的头，否则在"已设置
 * Content-Length/Content-Type、随后 open 失败"的竞态里，404 响应会残留原文件的
 * Content-Length（客户端会一直等到超时才报错，或把短正文当成截断）。
 */
function rejectStaticPath(
  res: ServerResponse,
  contentSecurityPolicy: string,
): boolean {
  res.statusCode = 404;
  res.removeHeader('Content-Length');
  res.removeHeader('Content-Type');
  res.removeHeader('Accept-Ranges');
  res.removeHeader('ETag');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  writeSecurityHeaders(res, contentSecurityPolicy);
  res.end(NOT_FOUND_BODY);
  return true;
}

function resolveRoot(rootDir: string): string | undefined {
  try {
    const root = realpathSync(resolve(rootDir));
    return statSync(root).isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serve the built Web client without claiming API, extension, health, or mutation
 * routes. Returning false means the caller must continue its normal route chain.
 */
export function serveStaticWeb(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticWebOptions,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const root = resolveRoot(options.rootDir);
  if (!root) return false;

  const csp = options.contentSecurityPolicy ?? STATIC_WEB_CSP;
  const parsed = parsePath(req.url);
  if (!parsed.ok) return rejectStaticPath(res, csp);
  if (isReservedRoute(parsed.pathname)) return false;
  if (parsed.pathname.toLowerCase().endsWith('.map')) {
    return rejectStaticPath(res, csp);
  }

  const requested = resolve(root, ...parsed.segments);
  if (!isWithinRoot(root, requested)) return rejectStaticPath(res, csp);

  let selected = existingFileWithinRoot(root, requested);
  if (!selected && canUseSpaFallback(req, parsed.pathname)) {
    selected = existingFileWithinRoot(root, join(root, 'index.html'));
  }
  if (!selected) return rejectStaticPath(res, csp);
  if (selected.toLowerCase().endsWith('.map')) return rejectStaticPath(res, csp);

  // 在同一个 fd 上取 size 并直接从该 fd 流式读取：避免"先 stat 再 open"之间文件被
  // 替换/改写，导致 Content-Length 与实际发送字节数不一致。
  let fd: number;
  try {
    fd = openSync(selected, 'r');
  } catch {
    return rejectStaticPath(res, csp);
  }

  let size: number;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('not a regular file');
    size = stats.size;
  } catch {
    closeSync(fd);
    return rejectStaticPath(res, csp);
  }

  writeSecurityHeaders(res, csp);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeFor(selected));
  res.setHeader('Content-Length', String(size));

  if (extname(selected).toLowerCase() === '.html') {
    res.setHeader('Cache-Control', 'no-store');
  } else if (HASHED_ASSET.test(selected)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }

  if (req.method === 'HEAD' || size === 0) {
    closeSync(fd);
    res.end();
    return true;
  }

  const stream = createReadStream(selected, { fd, start: 0, end: size - 1 });
  stream.once('error', () => {
    if (!res.headersSent) {
      rejectStaticPath(res, csp);
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}

export function createStaticWebHandler(
  options: StaticWebOptions,
): StaticWebHandler {
  return (req, res) => serveStaticWeb(req, res, options);
}
