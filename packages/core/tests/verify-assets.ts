/**
 * core 包验证 - 资产用户层（编辑器 P2：非只读 + 优先级）
 * 覆盖：用户层优先于源 / listAssets 合并标记 / 保存回读 round-trip（parseWorldBook/parsePreset）
 *      / 删除用户副本回落源 / 文件名校验
 */
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.JG_USER_DATA_DIR = resolve('data', 'test-user-assets');
rmSync(process.env.JG_USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(process.env.JG_USER_DATA_DIR, { recursive: true });

const {
  resolveAsset, listAssets, readAsset, saveUserAsset, deleteUserAsset, deleteUserCard, saveAssetBuffer, resolveCard,
  USER_PRESET_DIR, USER_WORLDBOOK_DIR, USER_CARD_DIR,
} = await import('../src/asset-paths.ts');
const { parseWorldBook } = await import('../src/worldbook.ts');
const { parsePreset } = await import('../src/preset.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== 源资产解析（无用户层）==');
const srcPreset = resolveAsset('preset', '夏瑾 双鱼座 Beta 0.40.json');
check('源预设可解析', srcPreset?.source === 'asset' && srcPreset.path.includes('剧本方案'), srcPreset?.path);
const srcWb = resolveAsset('worldbook', '足交百科全书.json');
check('源世界书可解析', srcWb?.source === 'asset');

console.log('\n== 保存到用户层 → 优先级翻转 ==');
const wbJson = JSON.stringify({ entries: { '1': { uid: 1, key: ['触手'], comment: '触手测试', content: '触手出现时的描写要求。', probability: 80, useProbability: true } } });
saveUserAsset('worldbook', '测试世界书.json', wbJson);
const wbUser = resolveAsset('worldbook', '测试世界书.json');
check('世界书用户层优先', wbUser?.source === 'user' && wbUser.path.startsWith(USER_WORLDBOOK_DIR));
const wbRead = readAsset('worldbook', '测试世界书.json');
const parsedWb = parseWorldBook(wbRead!.raw);
check('保存格式可被 parseWorldBook 回读', parsedWb.entries.length === 1 && parsedWb.entries[0].comment === '触手测试');
check('概率门保留', parsedWb.entries[0].probability === 80 && parsedWb.entries[0].useProbability === true);

const presetJson = JSON.stringify({ name: '我的预设', prompts: [
  { role: 'system', name: '风格', enabled: true, content: '冷冽短句。 {{setvar::tone::cold}}' },
  { role: 'user', name: '块2', enabled: false, content: '备用块' },
] });
saveUserAsset('preset', '我的预设.json', presetJson);
const presetUser = resolveAsset('preset', '我的预设.json');
check('预设用户层优先', presetUser?.source === 'user' && presetUser.path.startsWith(USER_PRESET_DIR));
const parsedPreset = parsePreset(readAsset('preset', '我的预设.json')!.raw);
check('预设保存回读：enabled 过滤 + setvar', parsedPreset.stats.enabled === 1 && parsedPreset.vars.length === 1 && parsedPreset.vars[0].value === 'cold');

console.log('\n== listAssets 合并 + 源标记 ==');
const presets = listAssets('preset');
const myPreset = presets.find((p) => p.file === '我的预设.json');
const xjPreset = presets.find((p) => p.file === '夏瑾 双鱼座 Beta 0.40.json');
check('用户层在前', presets.indexOf(myPreset!) < presets.indexOf(xjPreset!));
check('source 标记', myPreset?.source === 'user' && xjPreset?.source === 'asset');
const wbs = listAssets('worldbook');
check('世界书列表含用户层', wbs.some((w) => w.file === '测试世界书.json' && w.source === 'user'));

console.log('\n== 删除用户副本 → 回落源 ==');
const removed = deleteUserAsset('worldbook', '测试世界书.json');
check('删除返回 true', removed === true);
check('用户层文件已删', !existsSync(resolve(USER_WORLDBOOK_DIR, '测试世界书.json')));
check('源世界书不受影响', resolveAsset('worldbook', '足交百科全书.json')?.source === 'asset');

console.log('\n== 角色卡用户层删除（json+png 同基名一并删）==');
saveUserAsset('card', '测试角色卡.json', '{}');
saveAssetBuffer('card', '测试角色卡.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'));
const cardRemoved = deleteUserCard('测试角色卡.json');
check('删除返回 true', cardRemoved === true);
check('json 与 png 同基名一并删除', !existsSync(resolve(USER_CARD_DIR, '测试角色卡.json')) && !existsSync(resolve(USER_CARD_DIR, '测试角色卡.png')));
check('源角色卡不受影响', resolveCard('夜璃·魔法少女侵蚀录（七曜主角）.json')?.source === 'asset');
check('路径穿越被拒', deleteUserCard('../../evil.json') === false && !existsSync(resolve('..', 'evil.json')));
check('未知文件删除返回 false', deleteUserCard('不存在.json') === false);

console.log('\n== 文件名校验（防路径穿越）==');
let traversalRejected = false;
try { saveUserAsset('preset', '../../evil.json', '{}'); } catch { traversalRejected = true; }
check('路径穿越被拒', traversalRejected);

rmSync(process.env.JG_USER_DATA_DIR, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
