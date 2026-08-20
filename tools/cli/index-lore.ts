/**
 * tools/cli - 世界书离线索引 CLI（RAG 真向量入库）
 *
 * 链路：读世界书/会话库 → parseLoreEntries(解析→别名) → chunkLoreEntry(切分)
 *       → bge 向量化 → 写 PostgreSQL(pgvector)
 *
 * 用法：
 *   # 从 SQLite 会话库 lorebook_entry 索引
 *   node --experimental-strip-types --experimental-transform-types tools/cli/index-lore.ts --db data/session-x.db
 *   # 从世界书 JSON 文件索引（可多次 --worldbook）
 *   node --experimental-strip-types --experimental-transform-types tools/cli/index-lore.ts --worldbook "E:/…/世界书.json"
 *   # 指定 bge 镜像 / 不向量化只写设定
 *   JG_PG_DSN=postgres://… node …/index-lore.ts --db … --no-embed
 *
 * 幂等：PG 侧 ON CONFLICT 覆盖；进程可反复跑。缺 PG 连接时告警退出（不解索引）。
 */
import { readFileSync } from 'node:fs';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { parseLoreEntries, parseLoreEntry, buildAliasIndex } from '../../packages/core/src/lore-parse.ts';
import { chunkLoreEntry } from '../../packages/core/src/lore-chunk.ts';
import { createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { getPgVectorStore, PG_VECTOR_DIMS } from '../../packages/memory/src/pg-vector.ts';

interface Options {
  db?: string;
  worldbooks: string[];
  noEmbed: boolean;
  batchSize: number;
  maxLen: number;
  overlap: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { worldbooks: [], noEmbed: false, batchSize: 32, maxLen: 240, overlap: 64 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') o.db = argv[++i];
    else if (a === '--worldbook') o.worldbooks.push(argv[++i]);
    else if (a === '--no-embed') o.noEmbed = true;
    else if (a === '--batch-size') o.batchSize = Number(argv[++i]);
    else if (a === '--max-len') o.maxLen = Number(argv[++i]);
    else if (a === '--overlap') o.overlap = Number(argv[++i]);
  }
  return o;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (!o.db && o.worldbooks.length === 0) {
    console.error('用法: --db <sqlite路径> 或 --worldbook <json路径>(\'可多个) …');
    process.exit(1);
  }

  // 1) 收集「解析条目」
  const parsedLore: ReturnType<typeof parseLoreEntry>[] = [];
  if (o.db) {
    const mem = new MemoryDb({ path: o.db, autoInit: false });
    const rows = mem.db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry').all();
    for (const r of rows as { id: number; book: string; key: string; comment: string; content: string; constant: number; active: number }[]) {
      if ((r.content ?? '').trim().length === 0) continue;
      parsedLore.push(parseLoreEntry({ id: r.id, book: r.book, key: r.key, comment: r.comment, content: r.content, constant: r.constant, active: r.active }));
    }
  }
  for (const wb of o.worldbooks) {
    const json = JSON.parse(readFileSync(wb, 'utf8'));
    let entries: unknown[] = json.entries ?? json.originalData?.entries ?? [];
    if (!Array.isArray(entries)) entries = Object.values(entries);
    parsedLore.push(...parseLoreEntries(entries as never, wb));
  }
  // 去重（同 id 保留先到者）
  const seen = new Set<number>();
  const unique = parsedLore.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  console.log(`[索引] 待索引条目 ${unique.length}（含设定者 ${unique.filter((p) => p.settingText.replace(/\s/g, '').length > 0).length} / 含别名 ${unique.filter((p) => p.aliases.length > 0).length} / 保留 EJS 变量规则 ${unique.filter((p) => p.variableRules.length > 0).length}）`);

  // 2) PG 连接（缺连则告警退出）
  const pg = await getPgVectorStore();
  if (!pg.isReady) {
    console.error('[索引] PG 不可用，未索引。检查 JG_PG_DSN / pgvector 扩展。');
    process.exit(1);
  }

  // 3) embedding provider（默认 bge；--no-embed 时用零向量占位标记，实际检索前会重新嵌入）
  const embedProvider = o.noEmbed ? null : await createEmbeddingProvider(true);
  if (o.noEmbed) {
    console.warn('[索引] --no-embed：只写设定文本/别名，不写向量（检索需先向量化）。');
  } else {
    console.log(`[索引] embedding=${embedProvider!.name} dims=${embedProvider!.dims}`);
  }

  // 4) 逐条切分 + 向量化 + 入库（分批，进度可见）
  const writeBatch: Parameters<typeof pg.upsertLore>[0][] = [];
  const dims = embedProvider?.dims ?? 0;
  let chunked = 0;
  let written = 0;
  for (const p of unique) {
    if (p.settingText.replace(/\s/g, '').length < 5) continue; // 空设定不索引
    const chunks = chunkLoreEntry(p, { maxLen: o.maxLen, overlap: o.overlap });
    chunked += chunks.length;
    // 向量化窗口（分批）
    let vecs: number[][] = [];
    if (embedProvider && dims > 0) {
      for (let i = 0; i < chunks.length; i += o.batchSize) {
        const batch = chunks.slice(i, i + o.batchSize);
        vecs.push(...(await embedProvider.embedBatch(batch.map((c) => c.text))));
      }
    }
    writeBatch.push({
      id: p.id, book: p.meta.book, settingText: p.settingText, aliases: p.aliases,
      chunks: chunks.map((c, i) => ({ seq: c.seq, text: c.text, vec: vecs[i] ?? new Array(0) })),
    });
    if (writeBatch.length >= o.batchSize) {
      for (const w of writeBatch) await pg.upsertLore(w);
      written += writeBatch.length;
      writeBatch.length = 0;
      console.log(`[索引] 已写 ${written}/${unique.length} 条…`);
    }
  }
  for (const w of writeBatch) await pg.upsertLore(w);
  written += writeBatch.length;

  // 5) 别名/职位简写写入 lore_alias（`会长→桐月樱佳` 确定性检索，解决 2 字词 FTS 失效）
  const aliasIndex = buildAliasIndex(unique);
  const aliasRows: { alias: string; entityName: string; explicit: boolean }[] = [];
  for (const [alias, entry] of aliasIndex) {
    aliasRows.push({ alias, entityName: entry.entityName || alias, explicit: entry.explicit });
  }
  await pg.upsertAlias(aliasRows);

  const n = await pg.chunkCount();
  const na = await pg.aliasCount();
  console.log(`\n[索引] 完成：写入 ${written} 条 / ${chunked} 窗口，PG 总窗口 ${n}，别名 ${na}（含 "会长→桐月樱佳" 类职位简写）。`);
  console.log('  注：向量维度需与查询端 bge 一致（默认 512）。');
  await pg.close();
  process.exit(0);
}

void main();
