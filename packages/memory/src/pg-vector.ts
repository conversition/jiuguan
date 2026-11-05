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
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const PG_VECTOR_DIMS = 512;

/**
 * Parse PostgreSQL's canonical column type (for example `vector(512)`).
 * Kept separate from init so startup schema probing is deterministic and can
 * be covered without requiring a live PostgreSQL server.
 */
export function parsePgVectorDimensions(formattedType: unknown): number | null {
  if (typeof formattedType !== 'string') return null;
  const match = /^vector\((\d+)\)$/u.exec(formattedType.trim());
  if (!match) return null;
  const dimensions = Number(match[1]);
  return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : null;
}

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

/**
 * Read-only lore identity returned to bounded consumers such as the NSFW scene
 * curator.  Deliberately excludes chunk text: PostgreSQL is a rebuildable ANN
 * index, while SQLite remains the authority for active state, book allowlists
 * and the actual lore content.
 */
export interface PgLoreRef {
  loreId: number;
  score: number;
}

export type PgLoreRefQueryResult = Readonly<
  | { status: 'ok'; hits: readonly PgLoreRef[] }
  | { status: 'unavailable'; hits: readonly PgLoreRef[]; reason: 'not-ready' | 'invalid-vector' | 'query-failed' }
>;

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

export type PgLoreUpsertResult = Readonly<
  | { status: 'written'; vectorChunks: number }
  | { status: 'unavailable' | 'invalid-vector' | 'stale-build' | 'failed'; vectorChunks: 0 }
>;

export interface PgLoreIndexState {
  readonly namespace: string;
  readonly sourceDigest: string;
  readonly generationId: string;
  readonly status: 'dirty' | 'ready';
  readonly vectorDimensions: number | null;
}

export type PgLoreIndexStateWriteResult = 'written' | 'unavailable' | 'failed';

export type PgLoreIndexBeginResult = Readonly<
  | { status: 'started'; generationId: string }
  | { status: 'unavailable' | 'failed' }
>;

export type PgLoreIndexFinalizeResult =
  | 'ready'
  | 'dirty'
  | 'stale-build'
  | 'unavailable'
  | 'failed';

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class PgVectorStore {
  private pool: Pool | null = null;
  private ready = false;
  /** Actual dimension declared by the connected database, not an assumption. */
  private detectedVectorDimensions = PG_VECTOR_DIMS;

  get isReady(): boolean {
    return this.ready;
  }

  get vectorDimensions(): number {
    return this.detectedVectorDimensions;
  }

  /** 建立连接 + 初始化 schema（幂等）。失败置 ready=false 不抛（调用方回退）。 */
  async init(): Promise<void> {
    if (this.ready && this.pool) return;
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: PG_DSN });
      // Own the pool before the first network operation so every failure path
      // can close it and a later init attempt starts from a clean state.
      this.pool = pool;
      // 试连
      await pool.query('SELECT 1');
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      // 迁移：旧版表是单主键且无 namespace 列。检测到即 DROP，由下方重建为 namespace 复合主键（索引幂等可重跑，重建后需重跑 index-lore 恢复）。
      const nsCol = await pool.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'lore_chunk' AND column_name = 'namespace'`
      );
      if ((nsCol.rowCount ?? 0) === 0) {
        await pool.query('DROP TABLE IF EXISTS lore_text, lore_chunk, lore_alias').catch(() => {});
      }
      // 命名空间隔离：namespace = 会话 DB 文件基名（如 session-<时间戳>）。
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
      // CREATE TABLE IF NOT EXISTS intentionally preserves existing derived
      // indexes. Probe the actual typmod instead of assuming every installed
      // database is already vector(512): older installations may be 256 and
      // must remain readable/rebuildable without a destructive auto-migration.
      const vectorColumn = await pool.query<{ formatted_type: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
         FROM pg_attribute a
         WHERE a.attrelid = 'lore_chunk'::regclass
           AND a.attname = 'embedding'
           AND a.attnum > 0
           AND NOT a.attisdropped`,
      );
      const detectedDimensions = parsePgVectorDimensions(vectorColumn.rows[0]?.formatted_type);
      if (detectedDimensions === null) {
        throw new Error('lore_chunk.embedding must be a dimensioned vector(N) column');
      }
      this.detectedVectorDimensions = detectedDimensions;
      if (detectedDimensions !== PG_VECTOR_DIMS) {
        console.warn(`[pgvector] 检测到既有 embedding 列为 vector(${detectedDimensions})；`
          + `已保留旧索引，不做破坏性迁移。仅接受 ${detectedDimensions} 维 provider，`
          + `默认 BGE ${PG_VECTOR_DIMS} 维会安全降级为 SQLite/别名检索。`);
      }
      await pool.query('CREATE INDEX IF NOT EXISTS lore_chunk_embed_hnsw ON lore_chunk USING hnsw (embedding vector_cosine_ops)');
      // Persistent source/index fence. `lore_chunk` is rebuildable derived data,
      // but a non-empty namespace alone cannot prove it still represents the
      // current SQLite worldbook. A dirty row suppresses ANN reads until the
      // matching source digest has been rebuilt completely.
      await pool.query(`CREATE TABLE IF NOT EXISTS lore_index_state (
        namespace TEXT NOT NULL PRIMARY KEY,
        source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
        generation_id UUID NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('dirty','ready')),
        vector_dimensions INT,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK((status='dirty' AND vector_dimensions IS NULL)
          OR (status='ready' AND vector_dimensions > 0))
      )`);
      // Compatible in-place upgrade for installations created before rebuild
      // generations were explicit. Existing state keeps its ready/dirty value,
      // while receiving a legacy generation token that the next begin rotates.
      await pool.query('ALTER TABLE lore_index_state ADD COLUMN IF NOT EXISTS generation_id UUID');
      await pool.query(
        'UPDATE lore_index_state SET generation_id=$1::uuid WHERE generation_id IS NULL',
        [randomUUID()],
      );
      await pool.query('ALTER TABLE lore_index_state ALTER COLUMN generation_id SET NOT NULL');
      // 别名/职位简写索引：`会长→示例角色A` 确定性命中（解决 2 字词 FTS 失效）；按 namespace 隔离避免跨会话同名别名互覆盖
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
      await this.pool?.end().catch(() => {});
      this.pool = null;
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
    /** Full rebuild fence. Omit only for isolated direct metadata maintenance. */
    sourceDigest?: string;
    /** Exact begin token. Required together with sourceDigest for rebuild writes. */
    generationId?: string;
    /** Metadata-only fenced writes keep the prior chunks physically intact but unreadable while dirty. */
    replaceChunks?: boolean;
  }): Promise<PgLoreUpsertResult> {
    if (!this.ready || !this.pool) {
      return Object.freeze({ status: 'unavailable', vectorChunks: 0 });
    }
    // 维度不匹配时提前失败并说明原因：pgvector 的原始报错（expected N dimensions, not M）
    // 看不出「provider 回落了 hash」这个真正根因，运维会以为是数据坏了。
    const badDims = p.chunks.find((chunk) =>
      chunk.vec.length !== this.detectedVectorDimensions
      || chunk.vec.some((value) => !Number.isFinite(value)));
    if (badDims !== undefined) {
      console.warn(`[pgvector] upsert 跳过 lore#${p.id}: 向量无效或维度 ${badDims.vec.length}`
        + ` != 数据库 ${this.detectedVectorDimensions}；本次未写入任何行。`
        + `若 provider=hash-ngram(256) 而数据库=512，请先执行 pnpm embed:pull 并重启。`);
      return Object.freeze({ status: 'invalid-vector', vectorChunks: 0 });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (p.sourceDigest !== undefined || p.generationId !== undefined) {
        if (!p.sourceDigest || !/^sha256:[a-f0-9]{64}$/u.test(p.sourceDigest)
          || !p.generationId || !GENERATION_ID.test(p.generationId)) {
          await client.query('ROLLBACK');
          return Object.freeze({ status: 'stale-build', vectorChunks: 0 });
        }
        // Lock and verify the namespace generation in the same transaction as
        // the entry write. This prevents build A from writing after build B has
        // replaced the dirty fence and cleared A's partial chunks.
        const fence = await client.query(
          `SELECT 1 FROM lore_index_state
           WHERE namespace=$1 AND source_digest=$2
             AND generation_id=$3::uuid AND status='dirty'
           FOR UPDATE`,
          [p.namespace, p.sourceDigest, p.generationId],
        );
        if ((fence.rowCount ?? 0) !== 1) {
          await client.query('ROLLBACK');
          return Object.freeze({ status: 'stale-build', vectorChunks: 0 });
        }
      }
      await client.query(
        `INSERT INTO lore_text (namespace, id, book, setting_text, aliases, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (namespace, id) DO UPDATE SET book=EXCLUDED.book, setting_text=EXCLUDED.setting_text, aliases=EXCLUDED.aliases, updated_at=now()`,
        [p.namespace, p.id, p.book, p.settingText, JSON.stringify(p.aliases)],
      );
      // Full vector builds replace every entry's derived windows. A degraded
      // metadata-only build preserves the prior physical chunks for recovery;
      // the dirty namespace fence keeps them unreadable meanwhile.
      if (p.replaceChunks !== false) {
        await client.query(
          'DELETE FROM lore_chunk WHERE namespace = $1 AND lore_id = $2',
          [p.namespace, p.id],
        );
      }
      if (p.replaceChunks !== false && p.chunks.length > 0) {
        await client.query(
          `INSERT INTO lore_chunk (namespace, lore_id, seq, text, embedding)
           SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::vector[])
           ON CONFLICT (namespace, lore_id, seq) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding`,
          [p.chunks.map(() => p.namespace), p.chunks.map((_) => p.id), p.chunks.map((c) => c.seq), p.chunks.map((c) => c.text), p.chunks.map((c) => `[${c.vec.join(',')}]`)],
        );
      }
      await client.query('COMMIT');
      return Object.freeze({ status: 'written', vectorChunks: p.chunks.length });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] upsert 失败 lore#${p.id}: ${(e as Error).message.slice(0, 100)}`);
      return Object.freeze({ status: 'failed', vectorChunks: 0 });
    } finally {
      client.release();
    }
  }

  /** ANN 语义检索：余弦相似度 Top-K（限定 namespace）。threshold 为相似度下限（可配，默认 0.35，比旧 0.5 宽松）。 */
  async query(namespace: string, queryVec: number[], k = 10, threshold = 0.35): Promise<PgHit[]> {
    if (!this.ready || !this.pool || queryVec.length !== this.detectedVectorDimensions) return [];
    const q = `[${queryVec.join(',')}]`;
    const res = await this.pool.query<{ lore_id: number; seq: number; text: string; sim: string }>(
      `SELECT lore_id, seq, text, (1 - (embedding <=> $1::vector)) AS sim
       FROM lore_chunk
       WHERE namespace = $4
         AND NOT EXISTS (
           SELECT 1 FROM lore_index_state s
           WHERE s.namespace = $4 AND s.status = 'dirty'
         )
         AND embedding IS NOT NULL AND (1 - (embedding <=> $1::vector)) >= $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [q, threshold, k, namespace],
    );
    return res.rows.map((r) => ({ loreId: r.lore_id, seq: r.seq, text: r.text, sim: Number(r.sim) }));
  }

  /**
   * Identity-only ANN query for specialised read paths.
   *
   * The query is strictly namespace-scoped and never returns indexed chunk
   * text. Multiple matching chunks are collapsed to one lore id. Callers must
   * re-read that id from their session SQLite database before applying active,
   * source-book or safety policy. A missing/broken PostgreSQL index is an
   * explicit unavailable result and never interrupts the foreground turn.
   */
  async queryLoreRefs(
    namespace: string,
    queryVec: readonly number[],
    k = 24,
    threshold = 0.35,
  ): Promise<PgLoreRefQueryResult> {
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!this.ready || !this.pool) {
      return Object.freeze({ status: 'unavailable', hits: Object.freeze([]), reason: 'not-ready' });
    }
    if (queryVec.length !== this.detectedVectorDimensions || queryVec.some((value) => !Number.isFinite(value))) {
      return Object.freeze({ status: 'unavailable', hits: Object.freeze([]), reason: 'invalid-vector' });
    }

    const safeK = Math.max(1, Math.min(64, Math.trunc(k) || 24));
    const safeThreshold = Number.isFinite(threshold) ? Math.max(-1, Math.min(1, threshold)) : 0.35;
    const queryLimit = Math.min(256, safeK * 4);
    const vector = `[${queryVec.join(',')}]`;
    try {
      const res = await this.pool.query<{ lore_id: number; sim: string | number }>(
        `SELECT lore_id, (1 - (embedding <=> $1::vector)) AS sim
         FROM lore_chunk
         WHERE namespace = $4
           AND NOT EXISTS (
             SELECT 1 FROM lore_index_state s
             WHERE s.namespace = $4 AND s.status = 'dirty'
           )
           AND embedding IS NOT NULL AND (1 - (embedding <=> $1::vector)) >= $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [vector, safeThreshold, queryLimit, namespace],
      );
      const bestByLore = new Map<number, number>();
      for (const row of res.rows) {
        const loreId = Number(row.lore_id);
        const score = Number(row.sim);
        if (!Number.isSafeInteger(loreId) || loreId <= 0 || !Number.isFinite(score)) continue;
        const prior = bestByLore.get(loreId);
        if (prior === undefined || score > prior) bestByLore.set(loreId, score);
      }
      const hits = [...bestByLore]
        .map(([loreId, score]) => Object.freeze({ loreId, score }))
        .sort((a, b) => b.score - a.score || a.loreId - b.loreId)
        .slice(0, safeK);
      return Object.freeze({ status: 'ok', hits: Object.freeze(hits) });
    } catch (error) {
      console.warn(`[pgvector] identity-only query failed: ${(error as Error).message.slice(0, 100)}`);
      return Object.freeze({ status: 'unavailable', hits: Object.freeze([]), reason: 'query-failed' });
    }
  }

  /**
   * 写别名/职位简写映射（`会长→示例角色A` 确定性命中，按 namespace 隔离）。
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

  /** Read the persistent source/index fence for one session namespace. */
  async readLoreIndexState(namespace: string): Promise<PgLoreIndexState | null> {
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!this.ready || !this.pool) return null;
    try {
      const result = await this.pool.query<{
        namespace: string;
        source_digest: string;
        generation_id: string;
        status: 'dirty' | 'ready';
        vector_dimensions: number | string | null;
      }>(
        `SELECT namespace, source_digest, generation_id, status, vector_dimensions
         FROM lore_index_state WHERE namespace = $1`,
        [namespace],
      );
      const row = result.rows[0];
      if (!row || !/^sha256:[a-f0-9]{64}$/u.test(row.source_digest)
        || !GENERATION_ID.test(row.generation_id)
        || (row.status !== 'dirty' && row.status !== 'ready')) return null;
      const dimensions = row.vector_dimensions === null ? null : Number(row.vector_dimensions);
      if (row.status === 'dirty' && dimensions !== null) return null;
      if (row.status === 'ready' && (!Number.isSafeInteger(dimensions) || (dimensions ?? 0) <= 0)) return null;
      return Object.freeze({
        namespace: row.namespace,
        sourceDigest: row.source_digest,
        generationId: row.generation_id,
        status: row.status,
        vectorDimensions: dimensions,
      });
    } catch (error) {
      console.warn(`[pgvector] readLoreIndexState 失败: ${(error as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  /** Fence an outdated namespace before background work starts. */
  async markLoreIndexDirty(namespace: string, sourceDigest: string): Promise<PgLoreIndexStateWriteResult> {
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)) throw new TypeError('pgvector source digest invalid');
    if (!this.ready || !this.pool) return 'unavailable';
    const generationId = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO lore_index_state
           (namespace, source_digest, generation_id, status, vector_dimensions, updated_at)
         VALUES ($1,$2,$3::uuid,'dirty',NULL,now())
         ON CONFLICT (namespace) DO UPDATE SET
           source_digest=EXCLUDED.source_digest,
           generation_id=EXCLUDED.generation_id,
           status='dirty', vector_dimensions=NULL, updated_at=now()`,
        [namespace, sourceDigest, generationId],
      );
      return 'written';
    } catch (error) {
      console.warn(`[pgvector] markLoreIndexDirty 失败: ${(error as Error).message.slice(0, 100)}`);
      return 'failed';
    }
  }

  /**
   * Start one fenced generation. Compatible full rebuilds clear derived
   * windows up front; degraded metadata rebuilds preserve them physically
   * behind the dirty read fence for later provider recovery.
   */
  async beginLoreIndexRebuild(
    namespace: string,
    sourceDigest: string,
    options: Readonly<{ clearChunks?: boolean }> = {},
  ): Promise<PgLoreIndexBeginResult> {
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)) throw new TypeError('pgvector source digest invalid');
    if (!this.ready || !this.pool) return Object.freeze({ status: 'unavailable' });
    const generationId = randomUUID();
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO lore_index_state
           (namespace, source_digest, generation_id, status, vector_dimensions, updated_at)
         VALUES ($1,$2,$3::uuid,'dirty',NULL,now())
         ON CONFLICT (namespace) DO UPDATE SET
           source_digest=EXCLUDED.source_digest,
           generation_id=EXCLUDED.generation_id,
           status='dirty', vector_dimensions=NULL, updated_at=now()`,
        [namespace, sourceDigest, generationId],
      );
      if (options.clearChunks !== false) {
        await client.query('DELETE FROM lore_chunk WHERE namespace = $1', [namespace]);
      }
      await client.query('COMMIT');
      return Object.freeze({ status: 'started', generationId });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] beginLoreIndexRebuild 失败: ${(error as Error).message.slice(0, 100)}`);
      return Object.freeze({ status: 'failed' });
    } finally {
      client?.release();
    }
  }

  /**
   * Atomically finish one exact rebuild generation.
   *
   * All namespace-wide destructive work belongs here: pruning inactive or
   * deleted text/windows, replacing aliases, and publishing `ready`. The
   * source row is locked and checked before the first write, so an old build
   * cannot run its cleanup after a newer build has become ready. Metadata-only
   * and dimension-mismatch builds use `publishReady=false`; their metadata is
   * committed while the exact generation deliberately remains dirty.
   */
  async finalizeLoreIndexRebuild(input: {
    namespace: string;
    sourceDigest: string;
    generationId: string;
    retainedLoreIds: readonly number[];
    aliases: readonly { alias: string; entityName: string; explicit: boolean }[];
    publishReady: boolean;
  }): Promise<PgLoreIndexFinalizeResult> {
    const { namespace, sourceDigest } = input;
    if (!NAMESPACE.test(namespace)) throw new TypeError('pgvector namespace invalid');
    if (!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)) throw new TypeError('pgvector source digest invalid');
    if (!GENERATION_ID.test(input.generationId)) throw new TypeError('pgvector generation id invalid');
    const retainedLoreIds = [...new Set(input.retainedLoreIds)];
    if (retainedLoreIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new TypeError('pgvector retained lore id invalid');
    }
    if (!this.ready || !this.pool) return 'unavailable';

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const fence = await client.query(
        `SELECT 1 FROM lore_index_state
         WHERE namespace=$1 AND source_digest=$2
           AND generation_id=$3::uuid AND status='dirty'
         FOR UPDATE`,
        [namespace, sourceDigest, input.generationId],
      );
      if ((fence.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return 'stale-build';
      }

      if (input.publishReady) {
        // Only a complete compatible vector build may destructively prune.
        // Degraded metadata builds keep the old physical data for recovery;
        // their dirty fence keeps old chunks out of ANN reads.
        await client.query(
          `DELETE FROM lore_chunk
           WHERE namespace=$1 AND NOT (lore_id = ANY($2::int[]))`,
          [namespace, retainedLoreIds],
        );
        await client.query(
          `DELETE FROM lore_text
           WHERE namespace=$1 AND NOT (id = ANY($2::int[]))`,
          [namespace, retainedLoreIds],
        );
      }

      await client.query('DELETE FROM lore_alias WHERE namespace = $1', [namespace]);
      if (input.aliases.length > 0) {
        await client.query(
          `INSERT INTO lore_alias (namespace, alias, entity_name, explicit)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
           ON CONFLICT (namespace, alias) DO UPDATE
             SET entity_name=EXCLUDED.entity_name, explicit=EXCLUDED.explicit`,
          [
            input.aliases.map(() => namespace),
            input.aliases.map((row) => row.alias),
            input.aliases.map((row) => row.entityName),
            input.aliases.map((row) => row.explicit),
          ],
        );
      }

      const state = input.publishReady
        ? await client.query(
          `UPDATE lore_index_state
           SET status='ready', vector_dimensions=$4, updated_at=now()
           WHERE namespace=$1 AND source_digest=$2
             AND generation_id=$3::uuid AND status='dirty'`,
          [namespace, sourceDigest, input.generationId, this.detectedVectorDimensions],
        )
        : await client.query(
          `UPDATE lore_index_state
           SET status='dirty', vector_dimensions=NULL, updated_at=now()
           WHERE namespace=$1 AND source_digest=$2
             AND generation_id=$3::uuid AND status='dirty'`,
          [namespace, sourceDigest, input.generationId],
        );
      if ((state.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return 'stale-build';
      }
      await client.query('COMMIT');
      return input.publishReady ? 'ready' : 'dirty';
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      console.warn(`[pgvector] finalizeLoreIndexRebuild 失败: ${(error as Error).message.slice(0, 100)}`);
      return 'failed';
    } finally {
      client?.release();
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
      await client.query('DELETE FROM lore_index_state WHERE namespace = $1', [namespace]);
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
   * 应对应"示例角色A"，不依赖 FTS trigram（2 字词 FTS 天然失效）。
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
let singletonInit: Promise<void> | null = null;
export async function getPgVectorStore(): Promise<PgVectorStore> {
  singleton ??= new PgVectorStore();
  // A transient startup failure must not poison the process for its entire
  // lifetime. Retry lazily, with a single flight so concurrent session opens
  // cannot create competing pools/schema probes.
  if (!singleton.isReady) {
    singletonInit ??= singleton.init().finally(() => { singletonInit = null; });
    await singletonInit;
  }
  return singleton;
}
