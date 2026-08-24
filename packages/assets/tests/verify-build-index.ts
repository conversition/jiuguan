/**
 * 资产索引构建验证（packages/assets/src/build-index.ts）
 * 用真实卡 data/cards/0e3osp.json 断言扫描/分类/去重/命名规律。
 * 运行：node --experimental-strip-types --experimental-transform-types packages/assets/tests/verify-build-index.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAssetIndex, countByKind, assetId, classifyAsset } from '../src/build-index.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== 分类（纯函数）==');
check('bg 分类', classifyAsset('https://ik.imagekit.io/yorino/bg/上学路早晨.webp') === 'bg');
check('sprite 分类', classifyAsset('https://ik.imagekit.io/yorino/sprite/叶梦常服笑脸.webp') === 'sprite');
check('menu 分类', classifyAsset('https://gitgud.io/RBQ/amakano3/-/raw/master/menu/auto.webp') === 'menu');
check('audio 分类', classifyAsset('https://x.com/a/bgm.mp3') === 'audio');
check('page 分类', classifyAsset('https://raw.githubusercontent.com/x/index.html') === 'page');
check('generic 分类', classifyAsset('https://files.catbox.moe/x.png') === 'generic');
check('id 稳定 24 位', assetId('https://a/b.webp') === assetId('https://a/b.webp') && assetId('https://a/b.webp').length === 24);

const cardPath = resolve(process.cwd(), 'data/cards/0e3osp.json');
if (readFileSync(cardPath, 'utf8')) {
  let text = '';
  try { text = readFileSync(cardPath, 'utf8'); } catch { text = ''; }
  if (text) {
    const entries = buildAssetIndex(text, '0e3osp');
    const by = countByKind(entries);
    const names = new Set(entries.map((e) => e.name));
    console.log('\n== 真实卡：鸿纱由美 ==');
    check('总量 611（预载 584 + regex 外联 27）', entries.length === 611);
    check('sprite 483', by.sprite === 483);
    check('bg 63', by.bg === 63);
    check('menu 40', by.menu === 40);
    check('cg 0（清单无 CG 目录）', by.cg === 0);
    check('audio 0（清单无音频）', by.audio === 0);
    check('page 2（两个引擎 index.html）', by.page === 2);
    check('generic ≥ 20（字体/图床/外联）', by.generic >= 20);
    check('id 无重复', new Set(entries.map((e) => e.id)).size === entries.length);
    check('资源名可达：bg 乐乐浦寮会客厅早晨', names.has('乐乐浦寮会客厅早晨'));
    check('资源名可达：sprite 叶梦常服笑脸', names.has('叶梦常服笑脸'));
    check('资源名可达：sprite 诗梦常服认真', names.has('诗梦常服认真'));
    check('CG 五人吃饭不在清单（走构造 fallback）', !names.has('五人吃饭'));
    check('sourceCard 已记录', entries.every((e) => e.sourceCard === '0e3osp'));
  } else {
    console.log('  ⚠️ 读取 data/cards/0e3osp.json 失败，跳过真实卡断言');
  }
} else {
  console.log('  ⚠️ 未找到 data/cards/0e3osp.json，跳过真实卡断言');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);