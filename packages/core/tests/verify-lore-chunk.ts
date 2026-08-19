/**
 * core 包验证：设定文本语义切分（RAG chunking）
 * 覆盖：窗口长度约束、重叠、短文本单窗口、超长无标点硬切、chunkLoreEntry 携带元信息。
 */
import { chunkSettingText, chunkLoreEntry } from '../src/lore-chunk.ts';
import { parseLoreEntry } from '../src/lore-parse.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== chunkSettingText 基本切分 ==');
const longText = Array.from({ length: 40 }, (_, i) => `这是第${i}句关于世界观的描述，讲述了魔法少女的设定与背景。`).join('');
const c1 = chunkSettingText(longText, { maxLen: 200, overlap: 50 });
check('长文本切成多窗口', c1.length > 1, `got ${c1.length}`);
check('每窗口 ≤ maxLen', c1.every((s) => s.length <= 200), `max=${Math.max(...c1.map((s) => s.length))}`);
check('窗口内容保留可读（非空）', c1.every((s) => s.trim().length > 0));
check('总内容未丢失（约等于原文长）', c1.join('').replace(/ /g, '').length >= longText.length * 0.8, `len=${c1.join('').length}`);

console.log('\n== 短文本 / 边界 ==');
const c2 = chunkSettingText('一句话简介。');
check('不足窗口→单窗口', c2.length === 1 && c2[0].includes('一句话'), JSON.stringify(c2));
const c3 = chunkSettingText('');
check('空文本→空数组', c3.length === 0);

console.log('\n== 超长无标点硬切 ==');
const noPunct = '魔法'.repeat(500); // 1000 字无标点
const c4 = chunkSettingText(noPunct, { maxLen: 200, overlap: 40 });
check('无标点长段被硬切', c4.length > 1 && c4.every((s) => s.length <= 200), `n=${c4.length}`);

console.log('\n== chunkLoreEntry（携带元信息 + 不切 MVU 段）==');
const entry = parseLoreEntry({
  id: 7,
  comment: '桐月 樱佳',
  content: `<%_ var x = getvar('stat_data.x'); _%>\n${longText}`,
  constant: 0, active: 1, book: '测试',
});
const chunks = chunkLoreEntry(entry, { maxLen: 200, overlap: 50 });
check('chunkLoreEntry 生成多窗口', chunks.length > 1, `n=${chunks.length}`);
check('每窗口带 loreId/seq', chunks.every((c) => c.loreId === 7 && typeof c.seq === 'number' && c.seq >= 0));
check('窗口 seq 连续', chunks.every((c, i) => c.seq === i));
check('MVU 代码段不进入窗口', chunks.every((c) => !c.text.includes('<%_')));

console.log(failed === 0 ? `\nlore-chunk 验证全部通过（${passed} 项）✅` : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
