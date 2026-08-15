/**
 * 串联验证 CLI（Phase 1 M2 最小闭环）：
 * 真实角色卡 → 解析 → 世界书条目 → 记忆服务(lorebook 导入 + 写环 + 检索) → 提示词装配 → 输出消息结构
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/turn-loop.ts
 */
import { readFileSync } from 'node:fs';
import { parseCharaCard } from '../../packages/core/src/chara.ts';
import { cardBookToLorebookRows, parseWorldBook, entryToLorebookRow } from '../../packages/core/src/worldbook.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { assembleTurn, DEFAULT_SYSTEM_CORE } from '../../packages/prompt/src/assembly.ts';
import { validateGameTurn } from '../../packages/prompt/src/turn.ts';

const CARDS = [
  'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/ASMR剧本工坊 (2).json',
  'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/魔法少女是不会败北恶堕的吧！1.json',
];
const WB = 'E:/claude cade test/project/jiuguanlike/剧本方案/世界书/XP大全绿灯世界书-v1.4.json';

console.log('══════ 最小闭环验证：卡 → 世界书 → 记忆 → 装配 ══════\n');

// 1. 解析真实卡
const cardPath = CARDS[0];
const cardJson = readFileSync(cardPath, 'utf8');
const parsed = parseCharaCard(cardJson);
console.log(`① 角色卡解析: ${parsed.card.name}（世界书 ${parsed.worldbookEntries.length} 条目）`);

// 2. 导入内嵌世界书 + 外部 XP 书到记忆服务
const mem = new MemoryDb();
const rows = cardBookToLorebookRows(parsed.worldbookEntries, parsed.card.name);
const insertLore = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
for (const r of rows) {
  insertLore.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
}
const wb = parseWorldBook(readFileSync(WB, 'utf8'));
const wbRows = wb.entries.slice(0, 50).map((e) => entryToLorebookRow(e));
for (const r of wbRows) insertLore.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
console.log(`② 记忆服务导入: 卡片条目 ${rows.length} + XP 书前 50 条`);

// 3. 写环：模拟 2 轮剧情增量
const writer = new WriteLoop(mem);
writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
const r1 = writer.execute({
  delta_summary: '用户要求生成一段深夜 ASMR 哄睡台本，主角以温柔低语开场',
  state_changes: [{ entity_type: 'protagonist', entity_id: '用户', field: '心情', value: '紧张', action: 'upsert' }],
  round: 1,
});
const r2 = writer.execute({
  delta_summary: '台本推进：加入呼吸声引导与耳语环节，气氛渐入佳境',
  round: 2,
});
console.log(`③ 写环: 轮1=${r1.insertedCodes.join(',')} 轮2=${r2.insertedCodes.join(',')} 双表一致=${r1.codesConsistent && r2.codesConsistent}`);

// 4. 混合检索
const ret = new RetrievalEngine(mem);
const recall = ret.recall({ query: 'ASMR 哄睡 低语', round: 2, budgetTokens: 300 });
console.log(`④ 检索: hits=${recall.hits.length} codes=[${recall.codes.join(',')}] elapsed=${recall.elapsedMs}ms`);

// 5. 提示词装配（模式 A：tools）
const assembled = assembleTurn({
  systemCore: DEFAULT_SYSTEM_CORE,
  staticSettings: `角色卡：${parsed.card.name}\n${parsed.card.data.description.slice(0, 300)}`,
  dynamicState: `推进槽: ${JSON.stringify({ personal: 0, accident: 0, main: 0, erotic: 0 })}\n轮次: 2`,
  memoryBlock: recall.injectedBlock,
  chatHistory: [
    { role: 'user', content: '请开始' },
    { role: 'assistant', content: '（首轮）' },
  ],
  userInput: '<最新互动>\n生成下一段 ASMR 台本\n</最新互动>',
  useTools: true,
});
console.log(`⑤ 装配: messages=${assembled.messages.length} tools=${assembled.tools?.length ? 'game.turn' : '无'} 稳定前缀≈${assembled.stablePrefixTokens}tok`);
console.log(`   system[0] 前缀: ${assembled.messages[0].content.slice(0, 60)}...`);
console.log(`   user[-1] 尾部: ${assembled.messages[assembled.messages.length - 1].content.slice(0, 60)}...`);

// 6. game.turn 契约校验（模拟模型输出）
const mockTurn = {
  plan: {
    thought: '委员会：以 ASMR 哄睡为主题推进，加入低语与呼吸引导',
    key_events: [{ description: '主角以更柔和的低语引导用户放松' }],
    bars_delta: { personal: 0, accident: 0, main: 0, erotic: 5 },
    next_plan: '加入耳语环节',
    event_type: 'normal',
  },
  memory_delta: { delta_summary: '台本加入呼吸引导，气氛放松' },
  prose: '（正文：深夜的低语……）',
};
const v = validateGameTurn(mockTurn);
console.log(`⑥ game.turn 契约校验: ${v.ok ? 'OK' : v.issues.join('; ')}`);

// 7. 非法输出应被拦截
const bad = validateGameTurn({ plan: {}, prose: 123 });
console.log(`⑦ 非法输出拦截: ${bad.ok ? '未拦截(错误)' : '已拦截 ' + bad.issues[0]}`);

console.log('\n══════ 最小闭环验证完成 ══════');
