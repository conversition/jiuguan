/**
 * GLA 场景解析器验证（packages/core/src/gal.ts）
 * 使用真实卡 data/cards/0e3osp.json（鸿纱由美，5 个 <gal_inface> 场景 + 1 纯文本版）断言 + 合成边界用例。
 * 运行：node --experimental-strip-types --experimental-transform-types packages/core/tests/verify-gal.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseGalInfaceScene,
  extractGalBlocks,
  hasGalBlock,
  collectSceneAssetNames,
} from '../src/gal.ts';
import type { GalInstruction } from '../src/gal.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};
const cnt = (ins: GalInstruction[], kind: string): number => ins.filter((x) => x.kind === kind).length;

// —— 真实卡（数据缺席则跳过，不红） ——
const cardPath = resolve(process.cwd(), 'data/cards/0e3osp.json');
if (readFileSync(cardPath, 'utf8')) {
  const parsed = (() => { try { return JSON.parse(readFileSync(cardPath, 'utf8')); } catch { return null; } })();
  if (parsed) {
    const blocks = [parsed.data.first_mes, ...parsed.data.alternate_greetings];
    const scenes = blocks.map((b: string) => parseGalInfaceScene(b));
    console.log('\n== 真实卡：鸿纱由美（6 段文本）==');

    check('5 段 present（含 gal_inface），第 6 段文字版 present=false',
      scenes.slice(0, 5).every((s) => s.present) && !scenes[5].present);
    check('总指令行数 = 362', scenes.reduce((a, s) => a + s.instructions.length, 0) === 362);
    check('bgm 指令 5', scenes.reduce((a, s) => a + cnt(s.instructions, 'bgm'), 0) === 5);
    check('bg 指令 7', scenes.reduce((a, s) => a + cnt(s.instructions, 'bg'), 0) === 7);
    check('show 指令 13', scenes.reduce((a, s) => a + cnt(s.instructions, 'show'), 0) === 13);
    check('alter 指令 48', scenes.reduce((a, s) => a + cnt(s.instructions, 'alter'), 0) === 48);
    check('action 指令 21', scenes.reduce((a, s) => a + cnt(s.instructions, 'action'), 0) === 21);
    check('cg 指令 2', scenes.reduce((a, s) => a + cnt(s.instructions, 'cg'), 0) === 2);
    check('hide_cg 指令 2', scenes.reduce((a, s) => a + cnt(s.instructions, 'hide_cg'), 0) === 2);
    check('leave 指令 4', scenes.reduce((a, s) => a + cnt(s.instructions, 'leave'), 0) === 4);
    check('choice 指令 3（g1/g2/g4）', scenes.reduce((a, s) => a + cnt(s.instructions, 'choice'), 0) === 3);
    check('未知指令 warning 0', scenes.every((s) => s.warnings.length === 0));
    check('<user> 对话行 9', scenes.reduce((a, s) => a + s.instructions.filter((x) => x.kind === 'line' && x.role === 'user').length, 0) === 9);
    check('旁白行 ≥94', scenes.reduce((a, s) => a + s.instructions.filter((x) => x.kind === 'line' && x.role === 'narration').length, 0) >= 94);

    console.log('\n== 真实卡：choice 选项数组 ==');
    const g1 = scenes[1].instructions.find((x) => x.kind === 'choice');
    check('g1 三选项', g1 && g1.kind === 'choice' && g1.options.length === 3
      && g1.options[0] === '询问诗梦最喜欢哪张CG' && g1.options[2] === '表示自己对HCG很期待');
    const g4 = scenes[4].instructions.find((x) => x.kind === 'choice');
    check('g4 三选项', g4 && g4.kind === 'choice' && g4.options[2] === '反客为主将她抱起来');

    console.log('\n== 真实卡：show/alter 拼接资产名 ==');
    const g0show = scenes[0].instructions.find((x) => x.kind === 'show');
    check('g0 show 叶梦常服笑脸 L2', g0show && g0show.kind === 'show' && g0show.char === '叶梦' && g0show.sprite === '叶梦常服笑脸' && g0show.slot === 'L2');
    const g4bgm = scenes[4].instructions.find((x) => x.kind === 'bgm');
    check('g4 bgm 優しい優しいオモテナシ', g4bgm && g4bgm.kind === 'bgm' && g4bgm.name === '優しい優しいオモテナシ');

    console.log('\n== 真实卡：内联 action 剥离 + 资产名收集 ==');
    const names = collectSceneAssetNames(scenes[0]);
    check('g0 资产名收集 bg=[乐乐浦寮会客厅早晨]', names.bg.length === 1 && names.bg[0] === '乐乐浦寮会客厅早晨');
    check('g0 立绘含 叶梦常服笑脸/诗梦常服烦躁', names.sprites.includes('叶梦常服笑脸') && names.sprites.includes('诗梦常服烦躁'));
    const inlineAction = scenes[0].instructions.filter((x) => x.kind === 'action');
    // g0 原文行尾有内联 [action|叶梦|jump_up] → 已被剥离且作为独立指令
    const g0TextNoBracket = scenes[0].instructions.find((x) => x.kind === 'line' && x.text.includes('[action'));
    check('内联指令从台词剥离（不在展示文本）', !g0TextNoBracket);
    check('g0 action 指令 ≥5（含内联剥离）', inlineAction.length >= 5);
  }
} else {
  console.log('  ⚠️ 未找到 data/cards/0e3osp.json，跳过真实卡断言');
}

console.log('\n== 合成边界用例 ==');
const s1 = parseGalInfaceScene('叶梦|你好呀[action|叶梦|jump_up]\n旁白|她笑了。\n[bg|乐乐浦寮会客厅早晨]\n<user>|辛苦了。');
check('合成：内联 action 上浮为指令', cnt(s1.instructions, 'action') === 1 && cnt(s1.instructions, 'line') === 3);
check('合成：旁白 role=narration', s1.instructions.find((x) => x.kind === 'line' && x.speaker === '旁白')?.role === 'narration');
check('合成：<user> role=user', s1.instructions.find((x) => x.kind === 'line' && x.speaker === '<user>')?.role === 'user');
check('合成：内联剥离后文本无 [action', s1.instructions.find((x) => x.kind === 'line' && x.text.includes('[action')) === undefined);

const s2 = parseGalInfaceScene('[foo|aaa]\n[hide_cg]\n[bar]');
check('合成：未知指令进 warnings 且不进 instructions', s2.warnings.length === 2 && !s2.instructions.some((x) => x.kind === 'foo'));
check('合成：裸 [hide_cg] 指令生效', cnt(s2.instructions, 'hide_cg') === 1);
check('合成：无 | 的裸 [bar] 视为未知指令', s2.warnings.includes('未知指令 [bar]'));

const s3 = parseGalInfaceScene('<!-- 无包裹纯文本 -->\nここは純テキスト。');
check('合成：纯文本 present=false', s3.present === false);
check('合成：纯文本行按旁白入列', s3.instructions.length === 1 && s3.instructions[0].kind === 'line');

const s4 = parseGalInfaceScene('\r\n<gal_inface>\r\n[bg|A]\r\n叶梦|X\r\n</gal_inface>\r\n');
check('合成：CRLF 输入兼容', s4.present && cnt(s4.instructions, 'bg') === 1 && cnt(s4.instructions, 'line') === 1);

const x = extractGalBlocks('叙事A\n<gal_inface>[bg|B]</gal_inface>\n叙事B');
check('extractGalBlocks：块抽令牌 + gal 保留', x.gal.length === 1 && x.gal[0].includes('[bg|B]') && x.text.includes('\x00JGGAL0\x00'));
check('hasGalBlock 判定', hasGalBlock('<gal_inface>x</gal_inface>') === true && hasGalBlock('纯文本') === false);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);