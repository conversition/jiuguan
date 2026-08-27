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
import { basename } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { parseLoreEntry, parseLoreEntries } from '../../packages/core/src/lore-parse.ts';
import { createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';
import { indexLoreEntries } from './lore-index-task.ts';

interface Options {
  db?: string;
  worldbooks: string[];
  namespace?: string;
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
    else if (a === '--namespace') o.namespace = argv[++i];
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
  let mem: MemoryDb | null = null;
  if (o.db) {
    mem = new MemoryDb({ path: o.db, autoInit: false });
    const rows = mem.db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry WHERE active = 1').all();
    for (const r of rows as { id: number; book: string; key: string; comment: string; content: string; constant: number; active: number }[]) {
      if ((r.content ?? '').trim().length === 0) continue;
      parsedLore.push(parseLoreEntry({ id: r.id, book: r.book, key: r.key, comment: r.comment, content: r.content, constant: r.constant, active: r.active }));
    }
  }
  for (const wb of o.worldbooks) {
    const json = JSON.parse(readFileSync(wb, 'utf8'));
    let entries: unknown[] = json.entries ?? json.originalData?.entries ?? [];
    if (!Array.isArray(entries)) entries = Object.values(entries);
    parsedLore.push(...parseLoreEntries(entries as never, wb).filter((p) => p.meta.active !== false));
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
  // 命名空间 = PG 隔离键（同一会话多世界书共享、不同会话互不串扰）：显式 --namespace 优先，否则取 db 基名
  const namespace = o.namespace
    ?? (o.db ? basename(o.db).replace(/\.db$/i, '') : '')
    ?? '__worldbook';

  // 3) embedding provider（默认 bge；--no-embed 时用零向量占位标记，实际检索前会重新嵌入）
  const embedProvider = o.noEmbed ? null : await createEmbeddingProvider(true);
  if (o.noEmbed) {
    console.warn('[索引] --no-embed：只写设定文本/别名，不写向量（检索需先向量化）。');
  } else {
    console.log(`[索引] embedding=${embedProvider!.name} dims=${embedProvider!.dims}`);
  }

  // 4~5) 切分 + 向量化 + 入库 + 废弃清理 + 别名（共享任务：与会话自动索引同一实现）
  const result = await indexLoreEntries({
    pg, namespace, parsed: unique,
    provider: o.noEmbed ? null : embedProvider,
    inactiveIds: mem ? (mem.db.prepare('SELECT id FROM lorebook_entry WHERE active = 0').all() as { id: number }[]).map((r) => r.id) : [],
    batchSize: o.batchSize, maxLen: o.maxLen, overlap: o.overlap,
    log: (m) => console.log(m),
  });
  const written = result?.entries ?? 0;
  const chunked = result?.chunks ?? 0;

  const n = await pg.chunkCount();
  const na = await pg.aliasCount();
  console.log(`\n[索引] 完成：namespace=${namespace} 写入 ${written} 条 / ${chunked} 窗口，PG 总窗口 ${n}，别名 ${na}（含 "会长→桐月樱佳" 类职位简写）。`);
  console.log('  注：向量维度需与查询端 bge 一致（默认 512）。');
  await pg.close();
  process.exit(0);
}

void main();
