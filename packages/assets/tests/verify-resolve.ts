/**
 * GLA 资源名→URL 解析验证（packages/assets/src/resolve.ts）
 * 运行：node --experimental-strip-types --experimental-transform-types packages/assets/tests/verify-resolve.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAssetIndex } from '../src/build-index.ts';
import { resolveGalUrl, craftAssetUrl } from '../src/resolve.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== 命名构造 ==');
check('bg 构造', craftAssetUrl('bg', '乐乐浦寮会客厅早晨') === 'https://ik.imagekit.io/yorino/bg/乐乐浦寮会客厅早晨.webp');
check('sprite 构造', craftAssetUrl('sprite', '叶梦常服笑脸') === 'https://ik.imagekit.io/yorino/sprite/叶梦常服笑脸.webp');
check('cg 构造（best-effort）', craftAssetUrl('cg', '五人吃饭') === 'https://ik.imagekit.io/yorino/cg/五人吃饭.webp');
check('bgm 不构造 → null', craftAssetUrl('bgm', 'x') === null);

const cardPath = resolve(process.cwd(), 'data/cards/0e3osp.json');
if (readFileSync(cardPath, 'utf8')) {
  let text = '';
  try { text = readFileSync(cardPath, 'utf8'); } catch { text = ''; }
  if (text) {
    const entries = buildAssetIndex(text);
    console.log('\n== 真实卡：manifest 命中 ==');
    const bg = resolveGalUrl('bg', '乐乐浦寮会客厅早晨', entries);
    check('bg 清单命中(非构造)', bg.status !== 'miss' && bg.status !== 'miss' && bg.constructed === false
      && bg.url === 'https://ik.imagekit.io/yorino/bg/乐乐浦寮会客厅早晨.webp');
    const sp = resolveGalUrl('sprite', '诗梦常服认真', entries);
    check('sprite 清单命中', sp.status !== 'miss' && sp.constructed === false
      && sp.url === 'https://ik.imagekit.io/yorino/sprite/诗梦常服认真.webp');
    const menu = resolveGalUrl('menu', 'auto', entries);
    check('menu 清单命中', menu.status !== 'miss' && menu.constructed === false && menu.url.includes('/menu/auto.webp'));
    const cg = resolveGalUrl('cg', '五人吃饭', entries);
    check('cg 无清单 → 构造 fallback', cg.status !== 'miss' && cg.constructed === true
      && cg.url === 'https://ik.imagekit.io/yorino/cg/五人吃饭.webp');
    const bgm = resolveGalUrl('bgm', 'Joyful Blue Sky', entries);
    check('bgm → miss', bgm.status === 'miss' && bgm.kind === 'bgm');
    const ov = resolveGalUrl('bg', '乐乐浦寮会客厅早晨', entries, { '乐乐浦寮会客厅早晨': 'https://real.example/bg/乐.webp' });
    check('override 优先', ov.status !== 'miss' && ov.constructed === false && ov.url.startsWith('https://real.example/'));
  } else {
    console.log('  ⚠️ 读取 data/cards/0e3osp.json 失败，跳过真实卡断言');
  }
} else {
  console.log('  ⚠️ 未找到 data/cards/0e3osp.json，跳过真实卡断言');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);