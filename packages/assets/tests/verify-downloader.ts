/**
 * 资产下载器验证（packages/assets/src/downloader.ts）
 * 用本地 node:http mock 服务器测 200 缓存/404/超时/去重/manifest 合并 —— 不连外网。
 * 运行：node --experimental-strip-types --experimental-transform-types packages/assets/tests/verify-downloader.ts
 */
import { createServer, Server } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskCache, downloadOne, downloadAll, loadManifest, saveManifest, scanAndMerge, mergeAssetIndex } from '../src/downloader.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const ROOT = join(tmpdir(), `jg-assets-test-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

const server: Server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/ok')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('PNGDATA-OK')); return; }
  if (url.startsWith('/text')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello'); return; }
  if (url.startsWith('/404')) { res.writeHead(404); res.end('nope'); return; }
  if (url.startsWith('/slow')) {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('SLOW')); }, 1000);
    return;
  }
  res.writeHead(500); res.end('unknown');
});
await new Promise<void>((res2) => server.listen(0, '127.0.0.1', res2));
const PORT = (server.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${PORT}`;

const cache = new DiskCache(ROOT);

try {
  console.log('\n== DiskCache ==');
  const idA = 'aaaa';
  cache.put(idA, Buffer.from('bytes'));
  check('put/get', cache.get(idA)?.toString() === 'bytes');
  check('has true', cache.has(idA) === true);
  check('has false 未写入', cache.has('zzzz') === false);
  check('diskBytes 统计', cache.diskBytes() === 5);
  check('listFiles 含 idA', cache.listFiles().includes(idA));

  console.log('\n== downloadOne：200 缓存 ==');
  const r1 = await downloadOne(`${BASE}/ok.png`, cache, 2000);
  check('200 ok', r1.ok === true && r1.bytes === Buffer.byteLength('PNGDATA-OK'));
  check('下载后落盘', cache.has(r1.id) === true);
  const r2 = await downloadOne(`${BASE}/ok.png`, cache, 2000);
  check('二次调用命中缓存（不再发网）', r2.ok === true && r2.bytes === Buffer.byteLength('PNGDATA-OK'));

  console.log('\n== downloadOne：404 ==');
  const r404 = await downloadOne(`${BASE}/404.png`, cache, 2000);
  check('404 → fail', r404.ok === false && /404/.test(r404.error ?? ''));

  console.log('\n== downloadOne：超时 ==');
  const rSlow = await downloadOne(`${BASE}/slow.png`, cache, 150);
  check('超时 → fail 且不落盘', rSlow.ok === false && cache.has(rSlow.id) === false);

  console.log('\n== downloadAll：并发 + 进度 ==');
  const urls = Array.from({ length: 6 }, (_, i) => `${BASE}/ok/${i}.png`);
  const seen = { ok: 0, err: 0 };
  const { done, total, failed } = await downloadAll(urls, cache, (ev) => { seen.ok += ev.ok ? 1 : 0; seen.err += ev.ok ? 0 : 1; }, 2, 2000);
  check('全部完成', done === 6 && total === 6 && failed.length === 0);
  check('进度回调每项都触发', seen.ok === 6);

  console.log('\n== manifest 合并 ==');
  const m = loadManifest(ROOT);
  const before = m.entries.length;
  check('空 manifest', before === 0);
  const added0 = mergeAssetIndex(m, [{ id: 'x1', url: `${BASE}/ok.png`, kind: 'generic', name: 'ok', cached: false, addedAt: '' }]);
  check('merge 新增 1', added0.added === 1);
  const added1 = mergeAssetIndex(m, [{ id: 'x1', url: `${BASE}/ok.png`, kind: 'generic', name: 'ok', cached: true, addedAt: '' }]);
  check('merge 同 url 去重', added1.added === 0 && m.entries.length === 1);
  saveManifest(m, ROOT);
  const m2 = loadManifest(ROOT);
  check('落盘再读一致', m2.entries.length === 1 && m2.entries[0].url === `${BASE}/ok.png`);

  console.log('\n== scanAndMerge ==');
  const sCard = JSON.stringify({ data: { extensions: { TavernHelper_scripts: [{ value: { data: { 资源预载: `${BASE}/ok.png ${BASE}/text.txt` } } }] } } });
  const merged = scanAndMerge(sCard, 'test-card', ROOT);
  check('含预载 2 条', merged.entries.length >= 2);
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);