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
import { resolve } from 'node:path';
import pg from 'pg';

export const PG_VECTOR_DIMS = 512;

/** 从 .env.local / .env 手动读取 JG_PG_DSN（该文件不自动注入 process.env，需显式探测） */
function loadDsnFromEnvFile(): string | null {
  for (const p of [resolve(process.cwd(), '.env.local'), resolve(process.cwd(), '.env')]) {
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

export class PgVectorStore {
  private pool: pg.Pool | null = null;
  private ready = false;

  get isReady(): boolean {
    return this.ready;
  }

  /** 建立连接 + 初始化 schema（幂等）。失败置 ready=false 不抛（调用方回退）。 */
  async init(): Promise<void> {
    try {
      const pool = new pg.Pool({ connectionString: PG_DSN });
      // 试连
      await pool.query('SELECT 1');
      this.pool = pool;
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_text (
        id INT PRIMARY KEY,
        book TEXT DEFAULT '',
        setting_text TEXT DEFAULT '',
        aliases TEXT DEFAULT '[]',
        meta TEXT DEFAULT '{}',
        updated_at timestamptz DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_chunk (
        lore_id INT NOT NULL,
        seq INT NOT NULL,
        text TEXT DEFAULT '',
        embedding vector(${PG_VECTOR_DIMS}),
        PRIMARY KEY (lore_id, seq)
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS lore_chunk_embed_hnsw ON lore_chunk USING hnsw (embedding vector_cosine_ops)');
      // 别名/职位简写索引：`会长→桐月樱佳` 确定性命中（解决 2 字词 FTS 失效）
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_alias (
        alias TEXT PRIMARY KEY,
        entity_name TEXT DEFAULT '',
        explicit BOOLEAN DEFAULT false
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

  /** 写入一条条目的设定文本 + 别名 + 全部向量窗口（增量：ON CONFLICT 覆盖）。 */
  async upsertLore(p: {
    id: number; book: string; settingText: string; aliases: string[];
    chunks: { seq: number; text: string; vec: number[] }[];
  }): Promise<void> {
    if (!this.ready || !this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO lore_text (id, book, setting_text, aliases, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (id) DO UPDATE SET book=EXCLUDED.book, setting_text=EXCLUDED.setting_text, aliases=EXCLUDED.aliases, updated_at=now()`,
        [p.id, p.book, p.settingText, JSON.stringify(p.aliases)],
      );
      await client.query(
        `INSERT INTO lore_chunk (lore_id, seq, text, embedding)
         SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::vector[])
         ON CONFLICT (lore_id, seq) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding`,
        [p.chunks.map((_) => p.id), p.chunks.map((c) => c.seq), p.chunks.map((c) => c.text), p.chunks.map((c) => `[${c.vec.join(',')}]`)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] upsert 失败 lore#${p.id}: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      client.release();
    }
  }

  /** ANN 语义检索：余弦相似度 Top-K。threshold 为相似度下限（可配，默认 0.35，比旧 0.5 宽松）。 */
  async query(queryVec: number[], k = 10, threshold = 0.35): Promise<PgHit[]> {
    if (!this.ready || !this.pool || queryVec.length !== PG_VECTOR_DIMS) return [];
    const q = `[${queryVec.join(',')}]`;
    const res = await this.pool.query<{ lore_id: number; seq: number; text: string; sim: string }>(
      `SELECT lore_id, seq, text, (1 - (embedding <=> $1::vector)) AS sim
       FROM lore_chunk
       WHERE embedding IS NOT NULL AND (1 - (embedding <=> $1::vector)) >= $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [q, threshold, k],
    );
    return res.rows.map((r) => ({ loreId: r.lore_id, seq: r.seq, text: r.text, sim: Number(r.sim) }));
  }

  /**
   * 写别名/职位简写映射（`会长→桐月樱佳` 确定性命中）。
   * explicit=true 表示来自条目 comment/正文的显式别名；false 表示推导简写（职位/后缀）。批量 ON CONFLICT 覆盖。
   */
  async upsertAlias(rows: { alias: string; entityName: string; explicit: boolean }[]): Promise<void> {
    if (!this.ready || !this.pool || rows.length === 0) return;
    try {
      await this.pool.query(
        `INSERT INTO lore_alias (alias, entity_name, explicit)
         SELECT * FROM unnest($1::text[], $2::text[], $3::boolean[])
         ON CONFLICT (alias) DO UPDATE SET entity_name=EXCLUDED.entity_name, explicit=EXCLUDED.explicit`,
        [rows.map((r) => r.alias), rows.map((r) => r.entityName), rows.map((r) => r.explicit)],
      );
    } catch (e) {
      console.warn(`[pgvector] upsertAlias 失败(${rows.length}): ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /**
   * 别名/职位简写确定性检索。优先精确匹配，再退化到包含匹配——"会长"
   * 应对应"桐月樱佳"，不依赖 FTS trigram（2 字词 FTS 天然失效）。
   */
  async queryByAlias(query: string, k = 8): Promise<{ alias: string; entityName: string; explicit: boolean }[]> {
    if (!this.ready || !this.pool || !query.trim()) return [];
    try {
      const res = await this.pool.query<{ alias: string; entity_name: string; explicit: boolean }>(
        `SELECT alias, entity_name, explicit FROM lore_alias
         WHERE alias = $1 OR alias LIKE $2
         ORDER BY (alias = $1)::int DESC, explicit DESC, char_length(alias) DESC
         LIMIT $3`,
        [query.trim(), `%${query.trim()}%`, k],
      );
      return res.rows.map((r) => ({ alias: r.alias, entityName: r.entity_name, explicit: r.explicit }));
    } catch (e) {
      console.warn(`[pgvector] queryByAlias 失败: ${(e as Error).message.slice(0, 100)}`);
      return [];
    }
  }

  /** 别名表总数（健康检查/日志） */
  async aliasCount(): Promise<number> {
    if (!this.ready || !this.pool) return 0;
    const r = await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_alias');
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 统计窗口数（健康检查/日志） */
  async chunkCount(): Promise<number> {
    if (!this.ready || !this.pool) return 0;
    const r = await this.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM lore_chunk');
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
