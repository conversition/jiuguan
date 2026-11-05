/**
 * packages/session - 世界书→PG 索引共享任务（CLI index-lore 与会话自动索引共用）
 *
 * 链路：解析条目(parseLoreEntry/parseLoreEntries) → chunkLoreEntry(语义切分)
 *       → bge 向量化 → 写 PostgreSQL(pgvector) + 别名表；幂等（ON CONFLICT 可重跑）。
 *
 * 背景：PG 检索按会话 DB 基名隔离（namespace），新会话若未索引则通道0/通道B 对空库查询恒 0 命中。
 * 本模块把原本只在 CLI 手动跑的索引抽为可编程调用，供 ChatSession 初始化时后台自动补索引。
 */
import { createHash } from 'node:crypto';
import { MemoryDb } from '../../memory/src/db.ts';
import { parseLoreEntry, buildAliasIndex } from '../../core/src/lore-parse.ts';
import { chunkLoreEntry } from '../../core/src/lore-chunk.ts';
import type { EmbeddingProvider } from '../../memory/src/embedding.ts';
import type { PgLoreIndexState, PgVectorStore } from '../../memory/src/pg-vector.ts';

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
  /** 实际写入的向量窗口数；维度不匹配或 --no-embed 时为 0 */
  chunks: number;
  /** 写入别名数 */
  aliases: number;
  /** PG 写入失败或不可用的条目数，不再把失败误报为已写 */
  failedEntries: number;
  /** 本次向量通道的实际状态；文本和别名在后两种状态下仍会更新。 */
  vectorStatus: 'indexed' | 'metadata-only' | 'dimension-mismatch';
  /** 持久读取围栏；只有 ready 的向量窗口会参与 ANN 查询。 */
  indexState: 'ready' | 'dirty' | 'stale-build' | 'unavailable';
}

/** Stable digest of the complete SQLite worldbook source represented by one namespace. */
export function loreIndexSourceDigest(parsed: readonly ParsedLore[], inactiveIds: readonly number[] = []): string {
  const entries = parsed
    .map((entry) => ({
      id: entry.id,
      book: entry.meta.book,
      settingText: entry.settingText,
      aliases: [...entry.aliases].sort(),
    }))
    .sort((left, right) => left.id - right.id || left.book.localeCompare(right.book));
  const inactive = [...new Set(inactiveIds)].sort((left, right) => left - right);
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(['lore-index-source-v1', entries, inactive]))
    .digest('hex')}`;
}

/**
 * Decide whether session startup must refresh the derived index. A compatible
 * provider retries dirty work; an incompatible fallback only runs when source
 * metadata changed or no persistent fence exists, then waits for recovery.
 */
export function loreIndexNeedsRebuild(input: {
  readonly state: PgLoreIndexState | null;
  readonly sourceDigest: string;
  readonly providerDimensions: number;
  readonly databaseDimensions: number;
}): boolean {
  if (!input.state || input.state.sourceDigest !== input.sourceDigest) return true;
  if (input.providerDimensions !== input.databaseDimensions) return false;
  return input.state.status !== 'ready'
    || input.state.vectorDimensions !== input.databaseDimensions;
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

  const sourceDigest = loreIndexSourceDigest(unique, o.inactiveIds);

  const writeBatch: Parameters<PgVectorStore['upsertLore']>[0][] = [];
  const dims = o.provider?.dims ?? 0;
  const vectorStatus: IndexLoreResult['vectorStatus'] = o.provider === null
    ? 'metadata-only'
    : dims === o.pg.vectorDimensions ? 'indexed' : 'dimension-mismatch';
  const vectorProvider = vectorStatus === 'indexed' ? o.provider : null;
  if (vectorStatus === 'dimension-mismatch') {
    log(`[索引] PG ANN 安全降级：provider=${o.provider?.name ?? 'none'} ${dims} 维，`
      + `数据库为 vector(${o.pg.vectorDimensions})；不写入不兼容向量，旧 ANN 窗口由 dirty 围栏隔离，继续更新文本/别名。`
      + `若这是 BGE 加载失败后的 hash-ngram(256)，请执行 pnpm embed:pull 并重启后重建。`);
  }
  let written = 0;
  let indexedChunks = 0;
  let failedEntries = 0;
  let staleBuild = false;
  const writtenLoreIds = new Set<number>();
  const begin = await o.pg.beginLoreIndexRebuild(o.namespace, sourceDigest, {
    // A degraded build updates fenced metadata/aliases but preserves physical
    // chunks for a later compatible provider. Dirty state keeps them unreadable.
    clearChunks: vectorStatus === 'indexed',
  });
  if (begin.status !== 'started') {
    return {
      entries: 0,
      chunks: 0,
      aliases: 0,
      failedEntries: unique.filter((p) => p.settingText.replace(/\s/g, '').length >= 5).length,
      vectorStatus,
      indexState: 'unavailable',
    };
  }
  const flush = async (): Promise<void> => {
    for (const item of writeBatch) {
      const result = await o.pg.upsertLore(item);
      if (result.status === 'written') {
        written += 1;
        indexedChunks += result.vectorChunks;
        writtenLoreIds.add(item.id);
      } else if (result.status === 'stale-build') {
        staleBuild = true;
      } else {
        failedEntries += 1;
      }
    }
    writeBatch.length = 0;
  };
  for (const p of unique) {
    if (p.settingText.replace(/\s/g, '').length < 5) continue; // 空设定不索引
    const chunks = chunkLoreEntry(p, { maxLen, overlap });
    let vecs: number[][] = [];
    if (vectorProvider && dims > 0) {
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        vecs.push(...(await vectorProvider.embedBatch(batch.map((c) => c.text))));
      }
    }
    writeBatch.push({
      namespace: o.namespace, id: p.id, book: p.meta.book, settingText: p.settingText, aliases: p.aliases,
      // Empty means metadata-only. Old ANN windows may remain physically for
      // recovery, but the dirty namespace fence makes them unreadable.
      chunks: vectorProvider
        ? chunks.map((c, i) => ({ seq: c.seq, text: c.text, vec: vecs[i] ?? new Array(0) }))
        : [],
      sourceDigest,
      generationId: begin.generationId,
      replaceChunks: vectorStatus === 'indexed',
    });
    if (writeBatch.length >= batchSize) {
      await flush();
      log(`[索引] 已写 ${written}/${unique.length} 条`
        + (failedEntries > 0 ? `（失败 ${failedEntries}）` : '') + '…');
      if (staleBuild) break;
    }
  }
  if (!staleBuild) await flush();

  // Only aliases backed by metadata successfully written by this generation
  // are eligible for publication.
  const finalizedEntries = unique.filter((entry) => writtenLoreIds.has(entry.id));
  const aliasIndex = buildAliasIndex(finalizedEntries);
  const aliasRows: { alias: string; entityName: string; explicit: boolean }[] = [];
  for (const [alias, entry] of aliasIndex) {
    aliasRows.push({ alias, entityName: entry.entityName || alias, explicit: entry.explicit });
  }

  // Cleanup, complete alias replacement and ready/dirty publication share one
  // exact-generation transaction. A stale generation fails before any write.
  const finalize = await o.pg.finalizeLoreIndexRebuild({
    namespace: o.namespace,
    sourceDigest,
    generationId: begin.generationId,
    retainedLoreIds: [...writtenLoreIds],
    aliases: aliasRows,
    publishReady: vectorStatus === 'indexed' && failedEntries === 0 && !staleBuild,
  });
  const indexState: IndexLoreResult['indexState'] = finalize === 'ready'
    ? 'ready'
    : finalize === 'dirty'
      ? 'dirty'
      : finalize === 'stale-build'
        ? 'stale-build'
        : finalize === 'unavailable'
          ? 'unavailable'
          : 'dirty';
  if (finalize === 'stale-build') {
    // A newer generation owns every observable row now; do not report the old
    // generation's earlier writes as its final published result.
    written = 0;
    indexedChunks = 0;
  } else if ((finalize === 'ready' || finalize === 'dirty')
    && o.inactiveIds && o.inactiveIds.length > 0) {
    log(`[索引] 原子收尾完成（显式 inactive=${o.inactiveIds.length}）`);
  }

  return {
    entries: written,
    chunks: indexedChunks,
    aliases: finalize === 'ready' || finalize === 'dirty' ? aliasRows.length : 0,
    failedEntries,
    vectorStatus,
    indexState,
  };
}

function readSessionLoreIndexInput(mem: MemoryDb): {
  parsed: ParsedLore[];
  inactiveIds: number[];
} {
  const rows = mem.db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry').all() as {
    id: number; book: string; key: string; comment: string; content: string; constant: number; active: number;
  }[];
  const parsed = rows
    .filter((r) => r.active === 1 && (r.content ?? '').trim().length > 0)
    .map((r) => parseLoreEntry({ id: r.id, book: r.book, key: r.key, comment: r.comment, content: r.content, constant: r.constant, active: r.active }));
  const inactiveIds = rows.filter((r) => r.active === 0).map((r) => r.id);
  return { parsed, inactiveIds };
}

export function sessionLoreIndexSourceDigest(mem: MemoryDb): string {
  const source = readSessionLoreIndexInput(mem);
  return loreIndexSourceDigest(source.parsed, source.inactiveIds);
}

/** 从会话 SQLite 世界书索引该会话命名空间（ChatSession 自动索引用）。
 *  无启用条目返回 null；provider=null 时只写文本/别名（无 ANN 向量，别名通道可用）。 */
export async function indexSessionLore(
  mem: MemoryDb, pg: PgVectorStore, namespace: string, provider: EmbeddingProvider | null,
  log?: (msg: string) => void,
): Promise<IndexLoreResult | null> {
  const source = readSessionLoreIndexInput(mem);
  return indexLoreEntries({
    pg,
    namespace,
    parsed: source.parsed,
    provider,
    inactiveIds: source.inactiveIds,
    log,
  });
}
