/**
 * tools/cli - RAG 增强验证（0.9.x：废弃条目隔离 + 角色档案恒定层）
 * 用《魔法少女侵蚀技术检证实验记录》真实世界书复现事故场景：
 *   - 索引层：废弃（active=0）条目被剔除、正式本体条目保留；
 *   - 检索层：recallAsync 命中永不含 inactive 行（废弃旧档案不再泄漏）；
 *   - PG 通道：别名「会长→桐月樱佳」确定性命中正式本体，废弃 chunk 被 active 过滤拦截；
 *   - 档案层：名册实体选中正式本体、排除废弃，完整注入可读文本。
 *
 * id 口径：与世界书同序插入临时库（autoincrement 1 基），再读回行构建别名索引，
 * 与生产 index-lore 完全一致（DB id 空间），避免文件下标/DB id 错位。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine, renderRecallBlock, readableLoreContent } from '../../packages/memory/src/retrieval.ts';
import { parseWorldBook, entryToLorebookRow } from '../../packages/core/src/worldbook.ts';
import { parseLoreEntries, buildAliasIndex } from '../../packages/core/src/lore-parse.ts';
import { createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const WB_PATH = 'data/worldbooks/《魔法少女侵蚀技术检证实验记录》.json';
/** 旧会话 PG 命名空间（已索引该世界书含废弃 chunk；用于验证运行时 active 过滤拦截） */
const PG_NS = 'session-1787145050757';

async function run(): Promise<void> {
  const wb = parseWorldBook(readFileSync(WB_PATH, 'utf8'));
  const rows = wb.entries.map((e) => entryToLorebookRow(e));
  console.log(`世界书条目 ${rows.length}（active=1: ${rows.filter((r) => r.active === 1).length} / 废弃: ${rows.filter((r) => r.active === 0).length}）`);

  // 临时库：同序插入（autoincrement 1 基，与生产 loadWorldbooks 同口径）
  const mem = new MemoryDb({ path: ':memory:' });
  const insert = mem.db.prepare(
    `INSERT INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, active, probability, useProbability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    insert.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.active, r.probability, r.useProbability);
  }
  const deprecatedRow = mem.db.prepare(`SELECT id, comment FROM lorebook_entry WHERE active = 0 AND comment LIKE '%废弃%' ORDER BY id LIMIT 1`).get() as { id: number; comment: string } | undefined;
  const formalRow = mem.db.prepare(`SELECT id, comment, constant FROM lorebook_entry WHERE active = 1 AND comment LIKE '%桐月%樱佳%' AND constant = 1 ORDER BY id LIMIT 1`).get() as { id: number; comment: string; constant: number } | undefined;
  console.log(`正式本体行 id=${formalRow?.id}（${formalRow?.comment}）/ 废弃行 id=${deprecatedRow?.id}（${deprecatedRow?.comment}）`);
  check('已找到正式本体 id 与废弃 id', !!formalRow && !!deprecatedRow && formalRow.id !== deprecatedRow.id);
  if (!formalRow || !deprecatedRow) { mem.db.close(); console.log(`${failed} 项失败 ❌`); process.exit(1); }

  // 读回 DB 行 → parse（DB id 空间）→ 别名索引（与 index-lore 同链路）
  // 关键：显式带 uid=行 id，避免 parseLoreEntries 在缺 uid 时用数组下标覆盖（导致 0 基/1 基错位）
  const dbRows = mem.db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry').all()
    .map((r) => ({ ...r, uid: (r as { id: number }).id }));
  const parsed = parseLoreEntries(dbRows as never, '侵蚀实验');
  const aliasIdx = buildAliasIndex(parsed);

  // ── ① 索引层 active 过滤（index-lore 同口径）──
  console.log('\n===== ① 索引层 active 过滤 =====');
  const idxRows = parsed.filter((p) => p.meta.active !== false);
  check('废弃行被索引层剔除', !idxRows.some((p) => p.id === deprecatedRow.id));
  check('正式本体保留', idxRows.some((p) => p.id === formalRow.id));

  // ── ② 检索层：hitFromRowId / recallAsync 不返回 inactive lore 行 ──
  console.log('\n===== ② 检索层废弃隔离（纯文本通道）=====');
  const ret = new RetrievalEngine(mem); // 先不接 PG/bge：纯 FTS/LIKE/实体
  const idDepHit = (ret as unknown as { hitFromRowId(r: number, c: string): unknown }).hitFromRowId(deprecatedRow.id, 'lore');
  check(`hitFromRowId(${deprecatedRow.id}) → null（inactive 隔离）`, idDepHit === null);
  const r1 = await ret.recallAsync({ query: '塞蕾丝 桐月樱佳 会长', round: 1, budgetTokens: 800 });
  const r2 = ret.recall({ query: '塞蕾丝 桐月樱佳 会长', round: 1, budgetTokens: 800 });
  const allHits = [...r1.hits, ...r2.hits];
  const badLore = allHits.filter((h) => h.category === 'lore' && mem.db.prepare('SELECT active FROM lorebook_entry WHERE id=?').get(h.rowId)?.active === 0);
  check('recallAsync/recall 命中均无 inactive lore 行', badLore.length === 0);

  // ── ③ PG 通道（别名确定性 + ANN）：真实索引数据下的废弃拦截 ──
  console.log('\n===== ③ PG 通道（旧命名空间含废弃 chunk，验证运行时拦截）=====');
  let pgChecked = false;
  try {
    const provider = await createEmbeddingProvider(true);
    ret.setEmbeddingProvider(provider);
    const pg = await getPgVectorStore();
    ret.setPgStore(pg.isReady ? pg : null);
    if (pg.isReady) {
      const r3 = await ret.recallAsync({ query: '会长 桐月樱佳', round: 1, budgetTokens: 1200, namespace: PG_NS });
      const loreIds = r3.hits.filter((h) => h.category === 'lore');
      const hasFormal = loreIds.some((h) => h.rowId === formalRow.id);
      const hasDep = loreIds.some((h) => h.rowId === deprecatedRow.id);
      console.log(`  PG 召回 lore 命中: ${loreIds.map((h) => `${h.rowId}(${h.source})`).join(',') || '无'}`);
      check('PG 通道命中正式本体', hasFormal);
      check('PG 通道拦截废弃行（不在命中）', !hasDep);
      pgChecked = true;
      await pg.close();
    } else {
      console.log('  （PG 不可用，跳过）');
    }
  } catch (e) {
    console.log(`  （PG/bge 不可用，跳过: ${(e as Error).message.slice(0, 60)}）`);
  }
  if (!pgChecked) console.log('  （PG 通道验证未执行——软跳过，非阻断）');

  // ── ④ 档案层：名册实体 → 本体条目选中正式、排除废弃，完整注入 ──
  console.log('\n===== ④ 角色档案层（镜像 session.buildArchiveBlock）=====');
  const entity = [...aliasIdx.entries()].find(([, e]) => e.entityName === '桐月樱佳');
  check('名册含实体 桐月樱佳', !!entity);
  check('会长 别名 → 桐月樱佳', [...aliasIdx.entries()].some(([a, e]) => a.includes('会长') && e.entityName === '桐月樱佳'));
  if (entity) {
    const ent = entity[1];
    console.log(`  实体 ${ent.entityName} entryIds=${ent.entryIds.join(',')}`);
    const placeholders = ent.entryIds.map(() => '?').join(',');
    const rows2 = mem.db.prepare(
      `SELECT id, comment, content, constant FROM lorebook_entry
       WHERE active = 1 AND id IN (${placeholders}) ORDER BY constant DESC, id ASC`
    ).all(...ent.entryIds) as { id: number; comment: string; content: string; constant: number }[];
    const profile = rows2.filter((r) => r.constant === 1 || String(r.comment ?? '').includes('桐月樱佳'));
    const profileIds = profile.map((r) => r.id);
    check('档案选中正式本体', profileIds.includes(formalRow.id));
    check('档案排除废弃行', !profileIds.includes(deprecatedRow.id));
    const text = profile.map((r) => `[桐月樱佳] ${r.comment}: ${readableLoreContent(r.content)}`).join('\n');
    check(`档案完整注入（${text.length} 字，远超 200 字截断线）`, text.length > 1000);
    check('档案含正式细节「塞蕾丝」', text.includes('塞蕾丝'));
    check('档案不含「已废弃」', !text.includes('已废弃'));
    check('档案不含 EJS 代码残留', !/<%/.test(text));
    console.log(`\n── 档案块预览（前 260 字）──\n<角色档案>\n${text.slice(0, 260)}\n</角色档案>`);
  }
  const rendered = renderRecallBlock(allHits);
  check('renderRecallBlock 可渲染（去重后记忆块路径）', rendered.length > 0);

  mem.db.close();
  console.log(failed === 0 ? `\nRAG 增强验证全部通过（${passed} 项）✅` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

function main(): void {
  if (!existsSync(resolve(WB_PATH))) {
    console.log(`[跳过] 找不到世界书 ${WB_PATH}`);
    process.exit(0);
  }
  void run();
}

main();
