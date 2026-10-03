// 探测 MVU bundle 下载（jsdelivr → 本地 vendor）
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js';
const MIRROR = 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js';
const outDir = resolve('data', 'vendor');
mkdirSync(outDir, { recursive: true });

async function tryDownload(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.log(`[${url.slice(0, 50)}...] HTTP ${res.status}`); return false; }
    const text = await res.text();
    if (text.length < 1000) { console.log(`[${url.slice(0, 50)}...] 太小(${text.length}B)，可能非 bundle`); return false; }
    writeFileSync(resolve(outDir, 'mvu-bundle.js'), text, 'utf8');
    console.log(`✅ 下载成功: ${text.length} 字节 -> data/vendor/mvu-bundle.js`);
    return true;
  } catch (e) {
    console.log(`[${url.slice(0, 50)}...] 失败: ${(e as Error).message.slice(0, 60)}`);
    return false;
  }
}

if (!(await tryDownload(URL))) {
  await tryDownload(MIRROR);
}
