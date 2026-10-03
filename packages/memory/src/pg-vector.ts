/**
 * memory 包 - PostgreSQL + pgvector 真向量存储/检索层（RAG 语义通道）
 *
 * 背景：当前 vi.retrieval 用 SQLite BLOB 全扫 + hash 伪向量兜底，语义弱且无 ANN 索引。
 * 本层把「解析 → 切分 → bge 向量化」后的窗口写入本地 PostgreSQL(pgvector)，查询用 ANN
 * （hnsw vector_cosine_ops，`<=>` 余弦距离）Top-K 语义召回。
 *
 * 设计：
 *   - PG 仅作「向量/检索层」；运行状态/事务/回滚仍用 SQLite（memory_*、round_ledger），互不污染。
 *   - 连接串经 JG_PG_DSN（默认 localhost），缺连时 health()=false，调用方优雅回退 SQLite 检索，
 *     不阻断对话。
 *   - 维度固定 bge-small-zh-v1.5 = 512。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export const PG_VECTOR_DIMS = 512;

function workspaceRootFromCwd(): string | null {
  let cursor = resolve(process.cwd());
  while (true) {
    if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** 从当前目录或 pnpm 工作区根目录的 .env.local / .env 读取 JG_PG_DSN。 */
function loadDsnFromEnvFile(): string | null {
  const cwd = resolve(process.cwd());
  const workspaceRoot = workspaceRootFromCwd();
  const roots = [...new Set([cwd, workspaceRoot].filter((p): p is string => p !== null))];
  for (const p of roots.flatMap((root) => [resolve(root, '.env.local'), resolve(root, '.env')])) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('JG_PG_DSN=') === false) continue;
        return t.slice('JG_PG_DSN='.length).trim();
      }
    } catch { /* ignore */ }
  }
  return null;
}

export const PG_DSN = process.env.JG_PG_DSN
  ?? loadDsnFromEnvFile()
  ?? 'postgres://postgres:postgres@localhost:5432/jiuguan';

/** 向量检索命中 */
export interface PgHit {
  loreId: number;
  seq: number;
  text: string;
  sim: number;
}

export type PgNamespacePurgeResult = Readonly<
  | {
    status: 'purged';
    deletedChunks: number;
    deletedTexts: number;
    deletedAliases: number;
  }
  | {
    status: 'unavailable' | 'failed';
    deletedChunks: 0;
    deletedTexts: 0;
    deletedAliases: 0;
  }
>;

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;

export class PgVectorStore {
  private pool: Pool | null = null;
  private ready = false;

  get isReady(): boolean {
    return this.ready;
  }

  /** 建立连接 + 初始化 schema（幂等）。失败置 ready=false 不抛（调用方回退）。 */
  async init(): Promise<void> {
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: PG_DSN });
      // 试连
      await pool.query('SELECT 1');
      this.pool = pool;
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      // 迁移：旧版表是单主键且无 namespace 列。检测到即 DROP，由下方重建为 namespace 复合主键（索引幂等可重跑，重建后需重跑 index-lore 恢复）。
      const nsCol = await pool.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'lore_chunk' AND column_name = 'namespace'`
      );
      if ((nsCol.rowCount ?? 0) === 0) {
        await pool.query('DROP TABLE IF EXISTS lore_text, lore_chunk, lore_alias').catch(() => {});
      }
      // 命名空间隔离：namespace = 会话 DB 文件基名（如 session-example-c）。
      // 「多世界书共存」是设计意图，故按卡/会话隔离而非按 book——同一会话多世界书共享命名空间混合检索，不同会话互不串扰。
      // 迁移：旧表无 namespace 列 → 重建为复合主键（见下方 DROP+CREATE）。
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_text (
        namespace TEXT NOT NULL DEFAULT '',
        id INT NOT NULL,
        book TEXT DEFAULT '',
        setting_text TEXT DEFAULT '',
        aliases TEXT DEFAULT '[]',
        meta TEXT DEFAULT '{}',
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (namespace, id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_chunk (
        namespace TEXT NOT NULL DEFAULT '',
        lore_id INT NOT NULL,
        seq INT NOT NULL,
        text TEXT DEFAULT '',
        embedding vector(${PG_VECTOR_DIMS}),
        PRIMARY KEY (namespace, lore_id, seq)
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS lore_chunk_embed_hnsw ON lore_chunk USING hnsw (embedding vector_cosine_ops)');
      // 别名/职位简写索引：`会长→角色乙` 确定性命中（解决 2 字词 FTS 失效）；按 namespace 隔离避免跨会话同名别名互覆盖
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_alias (
        namespace TEXT NOT NULL DEFAULT '',
        alias TEXT NOT NULL,
        entity_name TEXT DEFAULT '',
        explicit BOOLEAN DEFAULT false,
        PRIMARY KEY (namespace, alias)
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS lore_alias_alias ON lore_alias (alias)');
      this.ready = true;
    } catch (e) {
      this.ready = false;
      console.warn(`[pgvector] 连接/初始化失败，回退 SQLite 检索: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      this.ready = false;
    }
  }

  /** 写入一条条目的设定文本 + 别名 + 全部向量窗口（增量：ON CONFLICT 覆盖）。namespace=会话 DB 基名，隔离跨卡。 */
  async upsertLore(p: {
    namespace: string; id: number; book: string; settingText: string; aliases: string[];
    chunks: { seq: number; text: string; vec: number[] }[];
  }): Promise<void> {
    if (!this.ready || !this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO lore_text (namespace, id, book, setting_text, aliases, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (namespace, id) DO UPDATE SET book=EXCLUDED.book, setting_text=EXCLUDED.setting_text, aliases=EXCLUDED.aliases, updated_at=now()`,
        [p.namespace, p.id, p.book, p.settingText, JSON.stringify(p.aliases)],
      );
      await client.query(
        `INSERT INTO lore_chunk (namespace, lore_id, seq, text, embedding)
         SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::vector[])
         ON CONFLICT (namespace, lore_id, seq) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding`,
        [p.chunks.map(() => p.namespace), p.chunks.map((_) => p.id), p.chunks.map((c) => c.seq), p.chunks.map((c) => c.text), p.chunks.map((c) => `[${c.vec.join(',')}]`)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] upsert 失败 lore#${p.id}: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      client.release();
    }
  }

  /** ANN 语义检索：余弦相似度 Top-K（限定 namespace）。threshold 为相似度下限（可配，默认 0.35，比旧 0.5 宽松）。 */
  async query(namespace: string, queryVec: number[], k = 10, threshold = 0.35): Promise<PgHit[]> {
    if (!this.ready || !this.pool || queryVec.length !== PG_VECTOR_DIMS) return [];
    const q = `[${queryVec.join(',')}]`;
    const res = await this.pool.query<{ lore_id: number; seq: number; text: string; sim: string }>(
      `SELECT lore_id, seq, text, (1 - (embedding <=> $1::vector)) AS sim
       FROM lore_chunk
       WHERE namespace = $4 AND embedding IS NOT NULL AND (1 - (embedding <=> $1::vector)) >= $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [q, threshold, k, namespace],
    );
    return res.rows.map((r) => ({ loreId: r.lore_id, seq: r.seq, text: r.text, sim: Number(r.sim) }));
  }

  /**
   * 写别名/职位简写映射（`会长→角色乙` 确定性命中，按 namespace 隔离）。
   * explicit=true 表示来自条目 comment/正文的显式别名；false 表示推导简写（职位/后缀）。批量 ON CONFLICT 覆盖。
   */
  async upsertAlias(namespace: string, rows: { alias: string; entityName: string; explicit: boolean }[]): Promise<void> {
    if (!this.ready || !this.pool || rows.length === 0) return;
    try {
      await this.pool.query(
        `INSERT INTO lore_alias (namespace, alias, entity_name, explicit)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
         ON CONFLICT (namespace, alias) DO UPDATE SET entity_name=EXCLUDED.entity_name, explicit=EXCLUDED.explicit`,
        [rows.map(() => namespace), rows.map((r) => r.alias), rows.map((r) => r.entityName), rows.map((r) => r.explicit)],
      );
    } catch (e) {
      console.warn(`[pgvector] upsertAlias 失败(${rows.length}): ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /** 清理某命名空间内指定条目的向量/设定残留（废弃 active=0 条目不再索引，但旧 chunk 仍在 → 显式 DELETE） */
  async purgeLore(namespace: string, ids: number[]): Promise<void> {
    if (!this.ready || !this.pool || ids.length === 0) return;
    try {
      const ph = ids.map((_, i) => `$${i + 2}`).join(',');
      await this.pool.query(
        `DELETE FROM lore_chunk WHERE namespace = $1 AND lore_id IN (${ph})`,
        [namespace, ...ids],
      );
      await this.pool.query(
        `DELETE FROM lore_text WHERE namespace = $1 AND id IN (${ph})`,
        [namespace, ...ids],
      );
    } catch (e) {
      console.warn(`[pgvector] purgeLore 失败(${ids.length}): ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /** 清空某命名空间全部别名（重新构建前先清理，避免废弃实体别名残留） */
  async resetAliases(namespace: string): Promise<void> {
    if (!this.ready || !this.pool) return;
    try {
      await this.pool.query('DELETE FROM lore_alias WHERE namespace = $1', [namespace]);
    } catch (e) {
      console.warn(`[pgvector] resetAliases 失败: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /**
   * Privacy cleanup for a complete session namespace.
   *
   * Unlike best-effort retrieval maintenance, this method reports unavailable
   * or failed explicitly so a deletion coordinator cannot claim completion.
   * All three derived tables are removed in one transaction.
   */
  async purgeNamespace(namespace: string): Promise<PgNamespacePurgeResult> {
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!this.ready || !this.pool) {
      return Object.freeze({
        status: 'unavailable',
        deletedChunks: 0,
        deletedTexts: 0,
        deletedAliases: 0,
      });
    }
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const chunks = await client.query(
        'DELETE FROM lore_chunk WHERE namespace = $1',
        [namespace],
      );
      const texts = await client.query(
        'DELETE FROM lore_text WHERE namespace = $1',
        [namespace],
      );
      const aliases = await client.query(
        'DELETE FROM lore_alias WHERE namespace = $1',
        [namespace],
      );
      await client.query('COMMIT');
      return Object.freeze({
        status: 'purged',
        deletedChunks: chunks.rowCount ?? 0,
        deletedTexts: texts.rowCount ?? 0,
        deletedAliases: aliases.rowCount ?? 0,
      });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] purgeNamespace 失败: ${(error as Error).message.slice(0, 100)}`);
      return Object.freeze({
        status: 'failed',
        deletedChunks: 0,
        deletedTexts: 0,
        deletedAliases: 0,
      });
    } finally {
      client?.release();
    }
  }

  /** 别名/职位简写确定性检索（限定 namespace）。优先精确匹配，再退化到包含匹配——"会长"
   * 应对应"角色乙"，不依赖 FTS trigram（2 字词 FTS 天然失效）。
   */
  async queryByAlias(namespace: string, query: string, k = 8): Promise<{ alias: string; entityName: string; explicit: boolean }[]> {
    if (!this.ready || !this.pool || !query.trim()) return [];
    try {
      const res = await this.pool.query<{ alias: string; entity_name: string; explicit: boolean }>(
        `SELECT alias, entity_name, explicit FROM lore_alias
         WHERE namespace = $4 AND (alias = $1 OR alias LIKE $2)
         ORDER BY (alias = $1)::int DESC, explicit DESC, char_length(alias) DESC
         LIMIT $3`,
        [query.trim(), `%${query.trim()}%`, k, namespace],
      );
      return res.rows.map((r) => ({ alias: r.alias, entityName: r.entity_name, explicit: r.explicit }));
    } catch (e) {
      console.warn(`[pgvector] queryByAlias 失败: ${(e as Error).message.slice(0, 100)}`);
      return [];
    }
  }

  /** 别名表总数（健康检查/日志）；带 namespace 时只统计该命名空间（空库检测） */
  async aliasCount(namespace?: string): Promise<number> {
    if (!this.ready || !this.pool) return 0;
    const r = namespace
      ? await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_alias WHERE namespace = $1', [namespace])
      : await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_alias');
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 统计窗口数（健康检查/日志）；带 namespace 时只统计该命名空间（空库检测/自动索引触发条件） */
  async chunkCount(namespace?: string): Promise<number> {
    if (!this.ready || !this.pool) return 0;
    const r = namespace
      ? await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_chunk WHERE namespace = $1', [namespace])
      : await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_chunk');
    return Number(r.rows[0]?.n ?? 0);
  }
}

/** 惰性单例（会话内复用连接池） */
let singleton: PgVectorStore | null = null;
export async function getPgVectorStore(): Promise<PgVectorStore> {
  if (!singleton) {
    singleton = new PgVectorStore();
    await singleton.init();
  }
  return singleton;
}
