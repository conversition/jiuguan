/**
 * tools/cli - 世界书→PG 索引共享任务（CLI index-lore 与会话自动索引共用）
 *
 * 链路：解析条目(parseLoreEntry/parseLoreEntries) → chunkLoreEntry(语义切分)
 *       → bge 向量化 → 写 PostgreSQL(pgvector) + 别名表；幂等（ON CONFLICT 可重跑）。
 *
 * 背景：PG 检索按会话 DB 基名隔离（namespace），新会话若未索引则通道0/通道B 对空库查询恒 0 命中。
 * 本模块把原本只在 CLI 手动跑的索引抽为可编程调用，供 ChatSession 初始化时后台自动补索引。
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { parseLoreEntry, buildAliasIndex } from '../../packages/core/src/lore-parse.ts';
import { chunkLoreEntry } from '../../packages/core/src/lore-chunk.ts';
import type { EmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import type { PgVectorStore } from '../../packages/memory/src/pg-vector.ts';

/** 单条解析产物（lore-parse.parseLoreEntry 返回类型） */
export type ParsedLore = ReturnType<typeof parseLoreEntry>;

export interface IndexLoreOptions {
  pg: PgVectorStore;
  /** PG 命名空间（会话 DB 基名）：同一会话多世界书共享、不同会话互不串扰 */
  namespace: string;
  /** 预解析条目（来源方组装：会话侧取 SQLite lorebook_entry；CLI 可混入 worldbook JSON） */
  parsed: ParsedLore[];
  /** embedding provider；null=只写文本/别名不写向量（--no-embed） */
  provider: EmbeddingProvider | null;
  /** 废弃（active=0）条目 id：清理其在 PG 的旧窗口残留 */
  inactiveIds?: number[];
  batchSize?: number;
  maxLen?: number;
  overlap?: number;
  /** 进度日志（自动索引传 console.log；缺省静默） */
  log?: (msg: string) => void;
}

export interface IndexLoreResult {
  /** 实际写入条目数 */
  entries: number;
  /** 切分窗口总数 */
  chunks: number;
  /** 写入别名数 */
  aliases: number;
}

/** 索引一个命名空间。PG 不可用或条目为空返回 null（调用方降级）；失败抛出。 */
export async function indexLoreEntries(o: IndexLoreOptions): Promise<IndexLoreResult | null> {
  if (!o.pg.isReady) return null;
  const batchSize = o.batchSize ?? 32;
  const maxLen = o.maxLen ?? 240;
  const overlap = o.overlap ?? 64;
  const log = o.log ?? (() => {});

  // 去重（同 id 保留先到者）+ 过滤空设定
  const seen = new Set<number>();
  const unique = o.parsed.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  if (unique.length === 0) return null;

  const writeBatch: Parameters<PgVectorStore['upsertLore']>[0][] = [];
  const dims = o.provider?.dims ?? 0;
  let chunked = 0;
  let written = 0;
  for (const p of unique) {
    if (p.settingText.replace(/\s/g, '').length < 5) continue; // 空设定不索引
    const chunks = chunkLoreEntry(p, { maxLen, overlap });
    chunked += chunks.length;
    let vecs: number[][] = [];
    if (o.provider && dims > 0) {
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        vecs.push(...(await o.provider.embedBatch(batch.map((c) => c.text))));
      }
    }
    writeBatch.push({
      namespace: o.namespace, id: p.id, book: p.meta.book, settingText: p.settingText, aliases: p.aliases,
      chunks: chunks.map((c, i) => ({ seq: c.seq, text: c.text, vec: vecs[i] ?? new Array(0) })),
    });
    if (writeBatch.length >= batchSize) {
      for (const w of writeBatch) await o.pg.upsertLore(w);
      written += writeBatch.length;
      writeBatch.length = 0;
      log(`[索引] 已写 ${written}/${unique.length} 条…`);
    }
  }
  for (const w of writeBatch) await o.pg.upsertLore(w);
  written += writeBatch.length;

  // 废弃条目残留清理（active=0 旧窗口不再索引但仍在 PG）
  if (o.inactiveIds && o.inactiveIds.length > 0) {
    await o.pg.purgeLore(o.namespace, o.inactiveIds);
    log(`[索引] 清理废弃条目 ${o.inactiveIds.length} 条的 PG 残留`);
  }

  // 别名/职位简写（先清空该命名空间旧别名再写入，避免废弃实体别名残留）
  await o.pg.resetAliases(o.namespace);
  const aliasIndex = buildAliasIndex(unique);
  const aliasRows: { alias: string; entityName: string; explicit: boolean }[] = [];
  for (const [alias, entry] of aliasIndex) {
    aliasRows.push({ alias, entityName: entry.entityName || alias, explicit: entry.explicit });
  }
  await o.pg.upsertAlias(o.namespace, aliasRows);

  return { entries: written, chunks: chunked, aliases: aliasRows.length };
}

/** 从会话 SQLite 世界书索引该会话命名空间（ChatSession 自动索引用）。
 *  无启用条目返回 null；provider=null 时只写文本/别名（无 ANN 向量，别名通道可用）。 */
export async function indexSessionLore(
  mem: MemoryDb, pg: PgVectorStore, namespace: string, provider: EmbeddingProvider | null,
  log?: (msg: string) => void,
): Promise<IndexLoreResult | null> {
  const rows = mem.db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry WHERE active = 1').all() as {
    id: number; book: string; key: string; comment: string; content: string; constant: number; active: number;
  }[];
  const parsed = rows
    .filter((r) => (r.content ?? '').trim().length > 0)
    .map((r) => parseLoreEntry({ id: r.id, book: r.book, key: r.key, comment: r.comment, content: r.content, constant: r.constant, active: r.active }));
  const inactive = (mem.db.prepare('SELECT id FROM lorebook_entry WHERE active = 0').all() as { id: number }[]).map((r) => r.id);
  return indexLoreEntries({ pg, namespace, parsed, provider, inactiveIds: inactive, log });
}
