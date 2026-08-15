/**
 * 真实 embedding 端到端验证（审查 §2.3/ADR 8）：
 * 原始版 __XP大全（450 条 key 全空）→ bge 向量化 → 语义检索激活（无需关键词）
 */
import { readFileSync } from 'node:fs';
import { MemoryDb } from '../src/db.ts';
import { RetrievalEngine } from '../src/retrieval.ts';
import { TransformersEmbeddingProvider, HashEmbeddingProvider } from '../src/embedding.ts';
import { Vectorizer } from '../src/vectorize.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// 加载原始版 __XP大全（key 全空，仅 content）
const raw = JSON.parse(readFileSync('E:/claude cade test/project/jiuguanlike/剧本方案/世界书/__XP大全 v1.4.json', 'utf8'));
const entries = Object.values(raw.entries) as { comment?: string; content?: string; uid?: number }[];
const mem = new MemoryDb();
const insert = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
);
for (const e of entries) {
  insert.run(String(e.uid ?? 0), '__XP大全', '', e.comment ?? '', e.content ?? '', 0, 0, 0, 0, '[]', 100, 0, 1);
}
console.log(`== 原始版 __XP大全 导入: ${entries.length} 条（key 全空）==\n`);

// 真实 bge 向量化
console.log('-- bge 向量化 --');
const provider = new TransformersEmbeddingProvider();
const v = new Vectorizer(mem, provider);
const vr = await v.run({ sources: ['lore'], batchSize: 32 });
console.log(`  向量化: ${vr.vectorized} 条 / ${vr.elapsedMs}ms`);
check('原始版全部向量化', vr.vectorized === entries.length, `got=${vr.vectorized}`);

// 语义检索（key 空 → 只能靠向量）
console.log('\n-- 语义检索（无关键词，纯向量）--');
const ret = new RetrievalEngine(mem);
ret.setEmbeddingProvider(provider);
const r1 = await ret.recallAsync({ query: '女主角在浴室被偷看', budgetTokens: 300 });
check('偷窥语义命中（源:vec）', r1.hits.some((h) => h.source === 'vec'), `hits=${r1.hits.length}`);
if (r1.hits.length) console.log(`  命中示例: [${r1.hits[0].category}] ${r1.hits[0].content.slice(0, 60)}...`);

const r2 = await ret.recallAsync({ query: '催眠控制他人的心智', budgetTokens: 300 });
check('催眠语义命中', r2.hits.some((h) => h.source === 'vec'), `hits=${r2.hits.length}`);

const r3 = await ret.recallAsync({ query: '在公共场合暴露身体', budgetTokens: 300 });
check('露出语义命中', r3.hits.some((h) => h.source === 'vec'), `hits=${r3.hits.length}`);

// 无关查询应低命中
const r4 = await ret.recallAsync({ query: '主角在图书馆复习考试内容', budgetTokens: 300 });
check('无关查询命中 ≤3（门控）', r4.hits.length <= 3, `hits=${r4.hits.length}`);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
