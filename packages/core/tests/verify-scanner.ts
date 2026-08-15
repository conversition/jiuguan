/**
 * core 包验证：世界书扫描器黄金用例（XP大全绿灯版 450 条真实数据）
 * 数据特性：key = 标签名（54 条短词可真实触发，222 条长词需完整短语）
 */
import { readFileSync } from 'node:fs';
import { MemoryDb } from '../../memory/src/db.ts';
import { parseWorldBook, entryToLorebookRow } from '../src/worldbook.ts';
import { LorebookScanner } from '../src/scanner.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const mem = new MemoryDb();
const wb = parseWorldBook(readFileSync('E:/claude cade test/project/jiuguanlike/剧本方案/世界书/XP大全绿灯世界书-v1.4.json', 'utf8'));
const insert = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
for (const e of wb.entries) {
  const r = entryToLorebookRow(e);
  insert.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
}
console.log(`== XP大全绿灯版导入: ${wb.stats.total} 条 ==\n`);

const scanner = new LorebookScanner(mem);

console.log('-- 短词 key 真实触发 --');
const r1 = scanner.scan({ text: '她被蒙眼带到地下室，黑暗中什么也看不见', seed: 42, budgetTokens: 1000 });
check('蒙眼→激活「蒙眼」条目', r1.activated.some((e) => e.comment === '蒙眼'), `hits=${r1.activated.map((e) => e.comment).slice(0, 5).join(',')}`);

const r2 = scanner.scan({ text: '男主实施了睡姦，趁她熟睡时侵入（key 为繁体）', seed: 42 });
check('睡奸(睡姦繁体key)→激活「睡奸」条目', r2.activated.some((e) => e.comment.includes('睡奸')), `hits=${r2.activated.map((e) => e.comment).slice(0, 5).join(',')}`);

const r3 = scanner.scan({ text: '主人给了她奖励，她高兴地接受了', seed: 42 });
check('奖励→激活「奖励」条目', r3.activated.some((e) => e.comment === '奖励'), `hits=${r3.activated.map((e) => e.comment).slice(0, 5).join(',')}`);

console.log('\n-- 长词 key 完整短语触发 --');
const r4 = scanner.scan({ text: '她遭遇了偷窥破心锤的完整过程', seed: 42 });
check('偷窥破心锤→完整短语激活', r4.activated.some((e) => e.comment === '偷窥破心锤'), `hits=${r4.activated.map((e) => e.comment).slice(0, 5).join(',')}`);

console.log('\n-- 无关文本 --');
const r5 = scanner.scan({ text: '主角在图书馆安静地看书，阳光透过窗户洒进来', seed: 42 });
check('无关文本激活数 ≤ 3', r5.activated.length <= 3, `hits=${r5.activated.length}`);

console.log('\n-- 注入块与预算 --');
const r6 = scanner.scan({ text: '蒙眼 奖励 把尿式', seed: 42, budgetTokens: 600 });
check('注入块非空', r6.injectedBlock.length > 0);
console.log(`  注入块预览: ${r6.injectedBlock.slice(0, 150)}...`);

const r7 = scanner.scan({ text: '蒙眼 睡奸 奖励 把尿式 子宫奸', seed: 42, budgetTokens: 120 });
const r7full = scanner.scan({ text: '蒙眼 睡奸 奖励 把尿式 子宫奸', seed: 42, budgetTokens: 5000 });
check('预算截断条目数减少', r7.activated.length < r7full.activated.length, `budget=${r7.activated.length} full=${r7full.activated.length}`);

console.log('\n-- 确定性 --');
const ra = scanner.scan({ text: '他被蒙上了眼睛', seed: 7 });
const rb = scanner.scan({ text: '他被蒙上了眼睛', seed: 7 });
check('同 seed 同结果', JSON.stringify(ra.activated.map((e) => e.id)) === JSON.stringify(rb.activated.map((e) => e.id)));

console.log('\n-- 概率门（v1.1 审查 §5.1）--');
const insertProb = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
insertProb.run('P0', 'test', '概率条', '概率条', '概率激活测试条目', 0, 0, 0, 0, '[]', 0, 1, 1);
const rp = scanner.scan({ text: '概率条', seed: 42 });
check('概率 0% 条目不激活', !rp.activated.some((e) => e.comment === '概率条'), `hits=${rp.activated.map((e) => e.comment).join(',')}`);
insertProb.run('P1', 'test', '概率条100', '概率条100', '概率激活测试条目100', 0, 0, 0, 0, '[]', 100, 1, 1);
const rp2 = scanner.scan({ text: '概率条100', seed: 42 });
check('概率 100% 条目激活', rp2.activated.some((e) => e.comment === '概率条100'), `hits=${rp2.activated.map((e) => e.comment).join(',')}`);
insertProb.run('P2', 'test', '无概率', '无概率', '无概率门条目', 0, 0, 0, 0, '[]', 50, 0, 1);
const rp3 = scanner.scan({ text: '无概率', seed: 42 });
check('useProbability=0 跳过门（50% 也激活）', rp3.activated.some((e) => e.comment === '无概率'), `hits=${rp3.activated.map((e) => e.comment).join(',')}`);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
