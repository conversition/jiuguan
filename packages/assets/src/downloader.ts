/**
 * 资产磁盘缓存 + 下载器（packages/assets）
 * 纯 Node（fetch 全局），不依赖浏览器：
 *  - DiskCache：<全局缓存根>/cache-v2-public/<id>（隔离 P5 前未经过 SSRF 门禁的旧缓存）
 *  - manifest 加载/保存/合并（<全局缓存根>/manifest.json；env JG_ASSETS_DIR 覆盖供测试隔离）
 *  - downloadOne/downloadAll：并发限流 + 单 URL 超时 + 模块级 inflight 去重 + 失败记录
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssetEntry, AssetManifest } from './asset-types.ts';
import { emptyManifest } from './asset-types.ts';
import { assetId, buildAssetIndex, normalizeUrl } from './build-index.ts';
import { safeFetchBuffer, SafeFetchError, validateSafeFetchUrl } from './safe-fetch.ts';

export const MAX_ASSET_DOWNLOAD_BYTES = 24 * 1024 * 1024;

export interface AssetDownloadOptions {
  maxBytes?: number;
  /** 仅供隔离 mock 测试；生产调用不得开启。 */
  allowPrivateNetworkForTests?: boolean;
  /** 仅供隔离 mock 测试；生产调用不得开启。 */
  allowNonStandardPortForTests?: boolean;
  /** 调用方生命周期；存在 signal 时禁用跨请求 inflight 共享，避免一个调用方取消其他调用方。 */
  signal?: AbortSignal;
}

/** 全局缓存根：默认在系统临时目录下（对所有卡共享一份、与启动目录无关），env JG_ASSETS_DIR 可覆盖 */
export const DEFAULT_ASSETS_DIR = process.env.JG_ASSETS_DIR
  ? resolve(process.env.JG_ASSETS_DIR)
  : join(tmpdir(), 'jiuguan-assets');

/** 磁盘缓存：按内容寻址 id 存二进制（无扩展名），MIME 由 URL 推断 */
export class DiskCache {
  private readonly dir: string;
  constructor(public readonly root: string = DEFAULT_ASSETS_DIR) {
    this.dir = join(root, 'cache-v2-public');
  }
  path(id: string): string {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new RangeError('invalid asset cache id');
    return join(this.dir, id);
  }
  size(id: string): number | null {
    try {
      const stat = statSync(this.path(id));
      return stat.isFile() && stat.size > 0 && stat.size <= MAX_ASSET_DOWNLOAD_BYTES ? stat.size : null;
    } catch {
      return null;
    }
  }
  has(id: string): boolean { return this.size(id) !== null; }
  get(id: string): Buffer | null {
    // best-effort：不存在、超出当前安全上限或读取竞争均返回 null。
    try {
      if (this.size(id) === null) return null;
      const value = readFileSync(this.path(id));
      return value.length <= MAX_ASSET_DOWNLOAD_BYTES ? value : null;
    } catch {
      return null;
    }
  }
  put(id: string, buf: Buffer): void {
    if (buf.length > MAX_ASSET_DOWNLOAD_BYTES) throw new RangeError('asset cache entry exceeds safe size');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(id), buf);
  }
  listFiles(): string[] {
    try { return existsSync(this.dir) ? readdirSync(this.dir) : []; } catch { return []; }
  }
  diskBytes(): number {
    let t = 0;
    for (const f of this.listFiles()) { try { t += statSync(join(this.dir, f)).size; } catch { /* 文件竞争删除跳过 */ } }
    return t;
  }
  /** 清空缓存文件；返回删除的文件数（不重置 manifest 状态，由调用方负责） */
  clear(): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    try { for (const f of readdirSync(this.dir)) { try { if (statSync(join(this.dir, f)).isFile()) removed++; } catch { /* 跳过 */ } } } catch { /* 目录读取失败 */ }
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* 删除失败忽略 */ }
    return removed;
  }
}

export function manifestFilePath(root: string = DEFAULT_ASSETS_DIR): string {
  return join(root, 'manifest.json');
}

export function loadManifest(root: string = DEFAULT_ASSETS_DIR): AssetManifest {
  const p = manifestFilePath(root);
  if (!existsSync(p)) return emptyManifest();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AssetManifest>;
    if (raw && Array.isArray(raw.entries)) {
      const cache = new DiskCache(root);
      const byUrl = new Map<string, AssetEntry>();
      for (const entry of raw.entries) {
        if (!entry || typeof entry.url !== 'string') continue;
        const url = normalizeUrl(entry.url);
        const id = assetId(url);
        const bytes = cache.size(id);
        if (byUrl.has(url)) continue;
        byUrl.set(url, {
          ...entry,
          id,
          url,
          cached: bytes !== null,
          bytes: bytes ?? undefined,
          failed: bytes !== null ? undefined : entry.failed,
        });
      }
      const entries = [...byUrl.values()];
      return { version: 1, entries, scannedAt: raw.scannedAt ?? '', overrides: raw.overrides ?? {} };
    }
  } catch { /* 损坏则从空重建 */ }
  return emptyManifest();
}

export function saveManifest(m: AssetManifest, root: string = DEFAULT_ASSETS_DIR): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(manifestFilePath(root), JSON.stringify(m, null, 2));
}

/** 把新发现条目并入 manifest（按规范化 url 去重；磁盘实况由下次 loadManifest 校准）。 */
export function mergeAssetIndex(m: AssetManifest, entries: AssetEntry[]): { added: number; total: number } {
  const byUrl = new Map(m.entries.map((entry) => {
    const url = normalizeUrl(entry.url);
    return [url, { ...entry, id: assetId(url), url }] as const;
  }));
  let added = 0;
  for (const entry of entries) {
    const url = normalizeUrl(entry.url);
    if (byUrl.has(url)) continue;
    byUrl.set(url, { ...entry, id: assetId(url), url });
    added++;
  }
  m.entries = [...byUrl.values()];
  m.scannedAt = new Date().toISOString();
  return { added, total: m.entries.length };
}

/** 扫描卡 → 并入 manifest → 落盘（不下载） */
export function scanAndMerge(cardText: string, sourceCard: string | undefined, root: string = DEFAULT_ASSETS_DIR): AssetManifest {
  const m = loadManifest(root);
  const entries = buildAssetIndex(cardText, sourceCard);
  mergeAssetIndex(m, entries);
  saveManifest(m, root);
  return m;
}

export interface DownloadResult { url: string; id: string; ok: boolean; bytes?: number; error?: string }

/** 模块级 in-flight 去重：同 URL 并发共用同一个 Promise（server 多请求 / 线程内安全） */
const inflight = new Map<string, Promise<DownloadResult>>();

export async function downloadOne(
  url: string,
  cache: DiskCache,
  timeoutMs = 30000,
  options: AssetDownloadOptions = {},
): Promise<DownloadResult> {
  if (options.signal?.aborted) {
    return { url, id: assetId(url), ok: false, error: 'aborted' };
  }
  const maxBytes = options.maxBytes ?? MAX_ASSET_DOWNLOAD_BYTES;
  let safeUrl: string;
  try {
    safeUrl = validateSafeFetchUrl(url, {
      timeoutMs,
      maxBytes,
      maxRedirects: 3,
      allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
      allowNonStandardPortForTests: options.allowNonStandardPortForTests,
      signal: options.signal,
    });
  } catch (error) {
    return { url, id: assetId(url), ok: false, error: error instanceof SafeFetchError ? error.code : 'invalid-url' };
  }
  const id = assetId(safeUrl);
  const cached = cache.get(id);
  if (cached) {
    return cached.length <= maxBytes
      ? { url, id, ok: true, bytes: cached.length }
      : { url, id, ok: false, error: 'response-too-large' };
  }
  const inflightKey = `${safeUrl}\n${maxBytes}\n${options.allowPrivateNetworkForTests === true}\n${options.allowNonStandardPortForTests === true}`;
  const shareInflight = options.signal === undefined;
  const prev = shareInflight ? inflight.get(inflightKey) : undefined;
  if (prev) return prev;
  const p = (async (): Promise<DownloadResult> => {
    try {
      const res = await safeFetchBuffer(safeUrl, {
        timeoutMs,
        maxBytes,
        maxRedirects: 3,
        allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
        allowNonStandardPortForTests: options.allowNonStandardPortForTests,
        signal: options.signal,
      });
      if (res.status < 200 || res.status >= 300) return { url, id, ok: false, error: `HTTP ${res.status}` };
      const buf = res.body;
      if (buf.length === 0) return { url, id, ok: false, error: 'empty body' };
      cache.put(id, buf);
      return { url, id, ok: true, bytes: buf.length };
    } catch (e) {
      return {
        url,
        id,
        ok: false,
        error: e instanceof SafeFetchError ? e.code : 'network-error',
      };
    } finally {
      if (shareInflight) inflight.delete(inflightKey);
    }
  })();
  if (shareInflight) inflight.set(inflightKey, p);
  return p;
}

export interface DownloadProgress { url: string; ok: boolean; bytes?: number; error?: string; done: number; total: number }

/** 并发限流批量下载；失败逐条记录并回调进度 */
export async function downloadAll(
  urls: string[],
  cache: DiskCache,
  onProgress?: (ev: DownloadProgress) => void,
  concurrency = 4,
  timeoutMs = 30000,
  options: AssetDownloadOptions = {},
): Promise<{ done: number; total: number; failed: { url: string; error: string }[] }> {
  const total = urls.length;
  const failed: { url: string; error: string }[] = [];
  let done = 0;
  const queue = [...urls];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      if (options.signal?.aborted) throw new SafeFetchError('aborted', '资源预载已取消');
      const url = queue.shift()!;
      const r = await downloadOne(url, cache, timeoutMs, options);
      if (options.signal?.aborted || r.error === 'aborted') {
        throw new SafeFetchError('aborted', '资源预载已取消');
      }
      done++;
      if (!r.ok) failed.push({ url, error: r.error ?? 'download failed' });
      onProgress?.({ url, ok: r.ok, bytes: r.bytes, error: r.error, done, total });
    }
  };
  const n = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { done, total, failed };
}

/** 按 URL 推断 MIME（服务端出图/音频用） */
export function mimeForUrl(url: string): string {
  const ext = (url.split('?')[0].split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
    wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm',
    html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', txt: 'text/plain',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  };
  return map[ext] ?? 'application/octet-stream';
}
