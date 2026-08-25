/**
 * 资产磁盘缓存 + 下载器（packages/assets）
 * 纯 Node（fetch 全局），不依赖浏览器：
 *  - DiskCache：<全局缓存根>/cache/<id>（内容寻址，无扩展名，MIME 由 URL 推断）
 *  - manifest 加载/保存/合并（<全局缓存根>/manifest.json；env JG_ASSETS_DIR 覆盖供测试隔离）
 *  - downloadOne/downloadAll：并发限流 + 单 URL 超时 + 模块级 inflight 去重 + 失败记录
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssetEntry, AssetManifest } from './asset-types.ts';
import { emptyManifest } from './asset-types.ts';
import { assetId, buildAssetIndex } from './build-index.ts';

/** 全局缓存根：默认在系统临时目录下（对所有卡共享一份、与启动目录无关），env JG_ASSETS_DIR 可覆盖 */
export const DEFAULT_ASSETS_DIR = process.env.JG_ASSETS_DIR
  ? resolve(process.env.JG_ASSETS_DIR)
  : join(tmpdir(), 'jiuguan-assets');

/** 磁盘缓存：按内容寻址 id 存二进制（无扩展名），MIME 由 URL 推断 */
export class DiskCache {
  private readonly dir: string;
  constructor(public readonly root: string = DEFAULT_ASSETS_DIR) {
    this.dir = join(root, 'cache');
  }
  path(id: string): string { return join(this.dir, id); }
  has(id: string): boolean { return existsSync(this.path(id)); }
  get(id: string): Buffer | null {
    // best-effort：文件不存在/读取失败返回 null（下载器将重取）
    try { return this.has(id) ? readFileSync(this.path(id)) : null; } catch { return null; }
  }
  put(id: string, buf: Buffer): void { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.path(id), buf); }
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
      return { version: 1, entries: raw.entries, scannedAt: raw.scannedAt ?? '', overrides: raw.overrides ?? {} };
    }
  } catch { /* 损坏则从空重建 */ }
  return emptyManifest();
}

export function saveManifest(m: AssetManifest, root: string = DEFAULT_ASSETS_DIR): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(manifestFilePath(root), JSON.stringify(m, null, 2));
}

/** 把新发现条目并入 manifest（按 url 去重，保留已缓存/失败状态，不清 scan 产生的 cached 假态） */
export function mergeAssetIndex(m: AssetManifest, entries: AssetEntry[]): { added: number; total: number } {
  const byUrl = new Map(m.entries.map((e) => [e.url, e]));
  let added = 0;
  for (const e of entries) {
    if (byUrl.has(e.url)) continue;
    byUrl.set(e.url, e);
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

export async function downloadOne(url: string, cache: DiskCache, timeoutMs = 30000): Promise<DownloadResult> {
  const id = assetId(url);
  const cached = cache.get(id);
  if (cached) return { url, id, ok: true, bytes: cached.length };
  const prev = inflight.get(url);
  if (prev) return prev;
  const p = (async (): Promise<DownloadResult> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'jiuguan-assets/1' } });
      if (!res.ok) return { url, id, ok: false, error: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) return { url, id, ok: false, error: 'empty body' };
      cache.put(id, buf);
      return { url, id, ok: true, bytes: buf.length };
    } catch (e) {
      return { url, id, ok: false, error: (e as Error).message.slice(0, 120) };
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
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
): Promise<{ done: number; total: number; failed: { url: string; error: string }[] }> {
  const total = urls.length;
  const failed: { url: string; error: string }[] = [];
  let done = 0;
  const queue = [...urls];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const url = queue.shift()!;
      const r = await downloadOne(url, cache, timeoutMs);
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