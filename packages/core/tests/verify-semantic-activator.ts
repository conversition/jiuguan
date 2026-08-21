/**
 * core 包验证：世界书整条目语义激活（SemanticWorldbookActivator + LorebookScanner.scanAsync）
 * 多信号融合（关键词/语义/实体/概率）→ sigmoid 阈值分级；确定性触发保证激活；语义作补充召回；无向量降级。
 * 用可控向量（3 维显式归一化近似）做确定性断言，不依赖真实 bge 模型。
 */
import { MemoryDb } from '../../memory/src/db.ts';
import type { EmbeddingProvider } from '../../memory/src/embedding.ts';
import { encodeF32, cosine } from '../../memory/src/retrieval.ts';
import { SemanticWorldbookActivator, defaultActivatorOptions } from '../src/worldbook/index.ts';
import { LorebookScanner } from '../src/scanner.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// ── 可控编码 provider：query → 固定向量 Q；条目向量来自 vec_memory（不依赖 provider）──
const Q = [1, 0, 0];                       // 用户输入 query 向量
const VA = [0.985, 0.15, 0.05];            // 剑术条目：与 Q 高相似
const VB = [0.8, 0.55, 0.2];               // 魔法条目：与 Q 中等相似（语义补充候选）
const VC = [0.1, 0.15, 0.98];              // 烘焙条目：与 Q 不相似（不应激活）
const norm = (v: number[]) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const [nA, nB, nC] = [norm(VA), norm(VB), norm(VC)];
const NQ = norm(Q);

class StubProvider implements EmbeddingProvider {
  readonly name = 'stub';
  readonly dims = 3;
  constructor(private v: () => number[]) {}
  async embed(): Promise<number[]> { return this.v(); }
  async embedBatch(texts: string[]): Promise<number[][]> { return texts.map(() => this.v()); }
}

// ── 数据：3 条世界书 + 3 条向量 ──
const mem = new MemoryDb();
const insert = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
insert.run('A', 't', '剑', '剑术', '关于剑术与格斗技巧的知识', 0, 0, 0, 0, '[]', 100, 0, 1);
insert.run('B', 't', '魔法', '魔法', '关于魔法的咒语与施法知识，需冥想引导', 0, 0, 0, 0, '[]', 100, 0, 1);
insert.run('C', 't', '烘焙', '烘焙', '关于面包烘焙的步骤与技巧', 0, 0, 0, 0, '[]', 100, 0, 1);
const insVec = mem.db.prepare('INSERT OR REPLACE INTO vec_memory (row_id, dims, embedding) VALUES (?,?,?)');
// lorebook_entry id 自增：1=A,2=B,3=C
insVec.run(1, 3, encodeF32(nA));
insVec.run(2, 3, encodeF32(nB));
insVec.run(3, 3, encodeF32(nC));

console.log(`== 语义激活器融合（query 与各条余弦: A=${cosine(NQ, nA).toFixed(2)} B=${cosine(NQ, nB).toFixed(2)} C=${cosine(NQ, nC).toFixed(2)}）==\n`);

const activator = new SemanticWorldbookActivator(defaultActivatorOptions());
activator.setEmbeddingProvider(new StubProvider(() => NQ));
activator.loadFromVecMemory(mem);
check('索引就绪', activator.isReady() && activator.entryCount() === 3, `count=${activator.entryCount()}`);

(async () => {
  // ── Part 1：activator.activate 直接断言融合分级 ──
  const ctx = { currentInput: '如何使用剑术与格斗技巧击败对手', activeEntities: new Set<string>() };
  const res = await activator.activate(ctx);
  const byId = new Map(res.map((r) => [r.entryId, r]));
  check('A 关键词命中 → 确定性激活（guarantee）', byId.has(1), `ids=${res.map((r) => r.entryId).join(',')}`);
  check('B 语义补充 → 激活（过 thresholdMedium）', byId.has(2) && byId.get(2)!.priority === 'medium', `priority=${byId.get(2)?.priority} score=${byId.get(2)?.score.toFixed(3)}`);
  check('C 低相似 → 不激活', !byId.has(3), `ids=${res.map((r) => r.entryId).join(',')}`);
  check('B 语义信号 > 0（融合可观测）', (byId.get(2)?.triggeredBy.semantic ?? 0) > 0.3, `sem=${byId.get(2)?.triggeredBy.semantic.toFixed(3)}`);

  // ── Part 2：LorebookScanner.scanAsync 端到端（语义补充并入）──
  const scanner = new LorebookScanner(mem);
  scanner.setEmbeddingProvider(new StubProvider(() => NQ));
  scanner.initSemantic(mem);
  const scan = await scanner.scanAsync({ text: '如何使用剑术与格斗技巧击败对手', seed: 42, budgetTokens: 2000 });
  const comments = scan.activated.map((e) => e.comment);
  check('scanAsync 关键词 A 激活', comments.includes('剑术'), `hits=${comments.join(',')}`);
  check('scanAsync 语义补充 B 激活（matchType=semantic）', scan.activated.some((e) => e.comment === '魔法' && e.matchType === 'semantic'), `hits=${comments.join(',')}`);
  check('scanAsync 语义补充计入统计', (scan.stats.semanticAdded ?? 0) >= 1, `semanticAdded=${scan.stats.semanticAdded}`);
  check('scanAsync C 不激活', !comments.includes('烘焙'), `hits=${comments.join(',')}`);
  check('scanAsync 保留确定性触发（不重复 B 两遍）', scan.activated.filter((e) => e.comment === '魔法').length === 1);

  // ── Part 3：无语义索引降级（纯关键词/正则）──
  const scannerLegacy = new LorebookScanner(mem);
  const legacy = await scannerLegacy.scanAsync({ text: '如何使用剑术与格斗技巧击败对手', seed: 42, budgetTokens: 2000 });
  check('降级：semanticAdded=0', (legacy.stats.semanticAdded ?? -1) === 0, `semanticAdded=${legacy.stats.semanticAdded}`);
  check('降级：关键词 A 仍激活', legacy.activated.some((e) => e.comment === '剑术'), `hits=${legacy.activated.map((e) => e.comment).join(',')}`);
  check('降级：B/C 不激活（无向量）', !legacy.activated.some((e) => e.comment === '魔法') && !legacy.activated.some((e) => e.comment === '烘焙'));

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
