/**
 * memory 包 - 混合检索管线（v2 07 §5.1）
 * 通道A：FTS5 trigram BM25 + LIKE 兜底（<3 字）+ 实体精确映射 + AM 码直查（确定性）
 * 通道B：vec_memory BLOB 余弦相似度（语义辅助）
 * 通道C：时效加权（recency）
 * 融合：RRF（Reciprocal Rank Fusion）+ 权重 → 置信门控 → 注入块
 *
 * 防幻觉三原则：
 *  ① 结果必须来自 DB 行（带 row_id / code）
 *  ② 低分丢弃而非硬凑（θ_drop 可调）
 *  ③ 注入块标注来源与置信度，低置信标 [存疑]
 */
import { MemoryDb } from './db.ts';
import { DEFAULT_WEIGHTS, DEFAULT_DROP_THRESHOLD, AM_CODE_RE } from './schema.ts';

export interface RecallQuery {
  /** 场景关键词（含人物/地点/事件/物品/任务要素） */
  query: string;
  /** 预见查询（下轮预检索，可选） */
  foreseeQuery?: string;
  /** 注入预算上限（Token），超出截断 */
  budgetTokens?: number;
  /** 当前轮次（recency 计算基准） */
  round?: number;
  /** 权重覆盖 */
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
  /** 门控阈值覆盖 */
  dropThreshold?: number;
  /** 通道开关（调试用） */
  channels?: { bm25?: boolean; vec?: boolean; entity?: boolean; am?: boolean };
}

export interface RecallHit {
  rowId: number;
  code: string;
  category: 'arc' | 'summary' | 'event' | 'state' | 'lore';
  content: string;
  score: number;
  source: string; // bm25 | vec | entity | am | like
  confidence: 'high' | 'low';
}

export interface RecallResult {
  hits: RecallHit[];
  injectedBlock: string;
  codes: string[];
  elapsedMs: number;
  layerStats: Record<string, number>;
}

/** f32 小端 BLOB 编码 */
export function encodeF32(vals: number[]): Buffer {
  const buf = Buffer.alloc(vals.length * 4);
  for (let i = 0; i < vals.length; i++) buf.writeFloatLE(vals[i], i * 4);
  return buf;
}

/** f32 小端 BLOB 解码 */
export function decodeF32(buf: Buffer): number[] {
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** 余弦相似度 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// FTS 元数据（审查 §3.3 修复：移除死字段 codeCol；显式 src 表名 + whereExpr，避免从 fts 表名反推的脆弱约定）
interface FtsMeta {
  ftsTable: string;
  /** LIKE 兜底的原表名 */
  srcTable: string;
  /** LIKE 兜底的检索表达式（可含 || 拼接） */
  whereExpr: string;
}
const FTS_TABLES: Record<RecallHit['category'], FtsMeta> = {
  arc: { ftsTable: 'fts_arc', srcTable: 'memory_arc', whereExpr: 'summary' },
  summary: { ftsTable: 'fts_summary', srcTable: 'memory_summary', whereExpr: 'delta' },
  event: { ftsTable: 'fts_event', srcTable: 'memory_event', whereExpr: 'description' },
  state: { ftsTable: 'fts_state', srcTable: 'memory_state', whereExpr: "name || ' ' || state_json" },
  lore: { ftsTable: 'fts_lore', srcTable: 'lorebook_entry', whereExpr: "comment || ' ' || content" },
};

/** 提取 FTS trigram 查询词元：3-6 字短词（trigram 完整匹配语义可靠） */
function collectFtsTokens(query: string): string[] {
  return query.split(/[\s,，、;；]+/).filter((t) => t.length >= 3 && t.length <= 6);
}

/** 提取 LIKE 兜底查询：<3 字词元 + 长句（≥7 字）的 4 字全覆盖窗口（步长 1，保证包含任意 4 字连续子串） */
function collectLikeQueries(query: string): string[] {
  const out: string[] = [];
  for (const t of query.split(/[\s,，、;；]+/)) {
    if (!t) continue;
    if (t.length < 3) {
      out.push(t);
    } else if (t.length >= 7) {
      for (let i = 0; i + 4 <= t.length; i++) out.push(t.slice(i, i + 4));
    }
  }
  return out.slice(0, 16);
}

export class RetrievalEngine {
  /** 注入的 embedding provider（真实语义向量；缺省用内置 hash） */
  private embedProvider: { embed: (t: string) => Promise<number[]> } | null = null;
  private embedCache = new Map<string, number[]>();

  constructor(private mem: MemoryDb) {}

  /** 注入真实 embedding provider（bge 等；recallAsync 使用） */
  setEmbeddingProvider(provider: { embed: (t: string) => Promise<number[]> }): void {
    this.embedProvider = provider;
  }

  /** 异步混合检索：通道 B 使用真实 embedding（bge），其余通道与 recall 一致 */
  async recallAsync(q: RecallQuery): Promise<RecallResult> {
    const t0 = Date.now();
    // 基础检索（关闭 hash vec 通道）
    const base = this.recall({ ...q, channels: { ...(q.channels ?? {}), vec: false } });

    if (q.channels?.vec !== false && this.embedProvider) {
      const qv = await this.embedQuery(q.query);
      if (qv.length > 0) {
        const rows = this.mem.db.prepare('SELECT row_id, dims, embedding FROM vec_memory').all() as {
          row_id: number; dims: number; embedding: Uint8Array;
        }[];
        const scored: { rowId: number; sim: number }[] = [];
        for (const r of rows) {
          if (r.dims !== qv.length) continue;
          const sim = cosine(qv, decodeF32(Buffer.from(r.embedding)));
          if (sim > 0.5) scored.push({ rowId: r.row_id, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const seen = new Set(base.hits.map((h) => h.rowId));
        for (const s of scored.slice(0, 10)) {
          if (seen.has(s.rowId)) continue;
          const cat = this.categoryOfRow(s.rowId);
          const h = this.hitFromRowId(s.rowId, cat);
          if (h) {
            base.hits.push({ ...h, score: s.sim, source: 'vec' });
            seen.add(s.rowId);
          }
        }
        // 向量命中优先置顶（语义强信号）
        base.hits.sort((a, b) => (b.source === 'vec' ? 1 : 0) - (a.source === 'vec' ? 1 : 0) || b.score - a.score);
        base.codes = base.hits.map((h) => h.code).filter(Boolean);
        base.injectedBlock = (this as unknown as { renderBlock(h: unknown[]): string }).renderBlock(base.hits as never);
      }
    }
    base.elapsedMs = Date.now() - t0;
    return base;
  }

  private async embedQuery(text: string): Promise<number[]> {
    const cached = this.embedCache.get(text);
    if (cached) return cached;
    if (!this.embedProvider) return [];
    const v = await this.embedProvider.embed(text);
    this.embedCache.set(text, v);
    return v;
  }

  /** 主入口：混合检索 */
  recall(q: RecallQuery): RecallResult {
    const t0 = Date.now();
    const weights = { ...DEFAULT_WEIGHTS, ...q.weights };
    const drop = q.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
    const channels = q.channels ?? { bm25: true, vec: true, entity: true, am: true };
    const round = q.round ?? 0;
    const hits = new Map<number, RecallHit>(); // rowId -> hit
    const rankMaps: Record<string, Map<number, number>> = { bm25: new Map(), vec: new Map(), recency: new Map(), am: new Map() };

    // 通道A：FTS5 trigram BM25（短词 3-6 字）+ LIKE 兜底（<3 字词元 + 长句 n-gram 窗口词）
    if (channels.bm25) {
      for (const [category, meta] of Object.entries(FTS_TABLES)) {
        const tri = this.bm25Search(meta.ftsTable, collectFtsTokens(q.query));
        for (const row of tri) this.addBm25Hit(hits, rankMaps.bm25, category as RecallHit['category'], row, row.bm25);
        // LIKE 兜底：短词（trigram 无法处理 <3 字）+ 长句窗口词（trigram AND 对齐失败场景）
        const likeQueries = collectLikeQueries(q.query);
        if (likeQueries.length > 0) {
          for (const row of this.likeSearch(meta, likeQueries)) {
            this.addBm25Hit(hits, rankMaps.bm25, category as RecallHit['category'], row, 0.25);
          }
        }
      }
    }

    // 通道A2：实体精确映射
    if (channels.entity) {
      const rows = this.mem.db.prepare(
        'SELECT row_id, category FROM idx_entity WHERE entity = ? ORDER BY weight DESC LIMIT 20'
      ).all(q.query.trim()) as { row_id: number; category: string }[];
      rows.forEach((r, i) => {
        const h = this.hitFromRowId(r.row_id, r.category as RecallHit['category']);
        if (h) this.addRankedHit(hits, rankMaps.recency, h, 1.0 - i * 0.02, `entity`);
      });
    }

    // 通道A3：AM 码直查（直接查原表，绕过 FTS 的 rowid 歧义）
    if (channels.am) {
      for (const token of q.query.split(/[\s,，、;；]+/)) {
        if (!AM_CODE_RE.test(token)) continue;
        const row = this.mem.db.prepare(
          `SELECT id AS row_id, code, 'arc' AS category, summary AS content FROM memory_arc WHERE code = ?
           UNION ALL SELECT id, code, 'summary', delta FROM memory_summary WHERE code = ?
           UNION ALL SELECT id, code, 'event', description FROM memory_event WHERE code = ?
           LIMIT 1`
        ).get(token, token, token) as { row_id: number; code: string; category: string; content: string } | undefined;
        if (row) {
          const h: RecallHit = {
            rowId: row.row_id, code: token, category: row.category as RecallHit['category'], content: row.content,
            score: 0, source: 'am', confidence: 'high',
          };
          this.addRankedHit(hits, rankMaps.am, h, 1.0, 'am');
        }
      }
    }

    // 通道B：向量余弦（BLOB 全扫，万级毫秒级）
    if (channels.vec) {
      const qv = this.embed(q.query);
      if (qv.length > 0) {
        const rows = this.mem.db.prepare('SELECT row_id, dims, embedding FROM vec_memory').all() as {
          row_id: number; dims: number; embedding: Uint8Array;
        }[];
        const scored: { rowId: number; sim: number }[] = [];
        for (const r of rows) {
          const sim = cosine(qv, decodeF32(Buffer.from(r.embedding)));
          if (sim > 0.4) scored.push({ rowId: r.row_id, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        for (const s of scored.slice(0, 10)) {
          const cat = this.categoryOfRow(s.rowId);
          const h = this.hitFromRowId(s.rowId, cat);
          if (h) this.addRankedHit(hits, rankMaps.vec, { ...h, score: s.sim, source: 'vec' }, s.sim, 'vec');
        }
      }
    }

    // 通道C：时效加权（按 code 序号近似轮次：AM 码越大越新）
    for (const h of hits.values()) {
      if (AM_CODE_RE.test(h.code)) {
        const n = parseInt(h.code.slice(2), 10);
        const rec = 1 - Math.min(1, Math.abs(round - n) / 100);
        this.addRankedHit(hits, rankMaps.recency, h, rec, 'recency');
      }
    }

    // RRF 融合
    const fused: RecallHit[] = [];
    for (const h of hits.values()) {
      let rrf = 0;
      for (const rankMap of Object.values(rankMaps)) {
        const rank = rankMap.get(h.rowId);
        if (rank !== undefined) rrf += 1 / (60 + rank);
      }
      h.score = rrf;
      fused.push(h);
    }
    fused.sort((a, b) => b.score - a.score);

    // 置信门控：RRF 得分范围 ~[0, 0.05]，min-max 归一化到 [0,1] 后按阈值丢弃
    const maxScore = fused.length > 0 ? fused[0].score : 0;
    const norm = (s: number) => (maxScore > 0 ? s / maxScore : 0);
    const kept = fused.filter((h) => norm(h.score) >= drop);
    for (const h of kept) {
      h.confidence = norm(h.score) >= drop + 0.15 ? 'high' : 'low';
      h.source = h.source || 'rrf';
    }

    // Token 预算截断（粗估：1 汉字 ≈ 1.5 token）
    const budget = q.budgetTokens ?? 600;
    let used = 0;
    const final: RecallHit[] = [];
    for (const h of kept) {
      const cost = Math.ceil(h.content.length * 1.5);
      if (used + cost > budget && final.length > 0) break;
      used += cost;
      final.push(h);
    }

    return {
      hits: final,
      injectedBlock: this.renderBlock(final),
      codes: final.map((h) => h.code).filter(Boolean),
      elapsedMs: Date.now() - t0,
      layerStats: { bm25: rankMaps.bm25.size, vec: rankMaps.vec.size, entity: rankMaps.entity?.size ?? 0, am: rankMaps.am.size, total: final.length },
    };
  }

  /** 注入块渲染（带来源与置信度标注） */
  private renderBlock(hits: RecallHit[]): string {
    if (hits.length === 0) return '<记忆召回>\n（本轮无高置信记忆命中）\n</记忆召回>';
    const lines = hits.map((h) => {
      const tag = h.confidence === 'low' ? ' [存疑]' : '';
      return `[${h.code || `ROW${h.rowId}`}|${h.category}|${h.score.toFixed(2)}|${h.source}]${tag} ${h.content.slice(0, 120)}`;
    });
    return `<记忆召回>\n${lines.join('\n')}\n</记忆召回>`;
  }

  /** FTS trigram 查询词元：3-6 字短词（trigram 完整匹配语义） */
  private bm25Search(ftsTable: string, tokens: string[]): { row_id: number; bm25: number }[] {
    if (tokens.length === 0) return [];
    const seen = new Map<number, number>(); // row_id -> best (lowest) bm25
    for (const token of tokens.slice(0, 6)) {
      // trigram 隐式 AND（短词完整出现即命中）；剥离 FTS 特殊字符
      const safe = token.replace(/["*:()[\]]/g, ' ').trim();
      if (safe.length < 3) continue;
      try {
        const rows = this.mem.db.prepare(
          `SELECT rowid AS row_id, bm25(${ftsTable}) AS bm25 FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY bm25 LIMIT 10`
        ).all(safe) as { row_id: number; bm25: number }[];
        for (const r of rows) {
          const prev = seen.get(r.row_id);
          if (prev === undefined || r.bm25 < prev) seen.set(r.row_id, r.bm25);
        }
      } catch {
        // 单个 token 语法错误忽略，继续下一个
      }
    }
    return Array.from(seen, ([row_id, bm25]) => ({ row_id, bm25 }));
  }

  /** LIKE 兜底：多查询词合并为单条 OR SQL（子串匹配，无 trigram 对齐问题） */
  private likeSearch(meta: FtsMeta, queries: string[]): { row_id: number; content: string }[] {
    const tokens = queries.filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const conds = tokens.map(() => `${meta.whereExpr} LIKE ?`).join(' OR ');
    const params = tokens.map((t) => `%${t}%`);
    try {
      const rows = this.mem.db.prepare(`SELECT id AS row_id FROM ${meta.srcTable} WHERE ${conds} LIMIT 20`)
        .all(...params) as { row_id: number }[];
      return rows;
    } catch {
      return [];
    }
  }

  private addBm25Hit(hits: Map<number, RecallHit>, rankMap: Map<number, number>, category: RecallHit['category'], row: { row_id: number }, score: number): void {
    const h = this.hitFromRowId(row.row_id, category);
    if (!h) return;
    this.addRankedHit(hits, rankMap, h, score, 'bm25');
  }

  private addRankedHit(hits: Map<number, RecallHit>, rankMap: Map<number, number>, hit: RecallHit, score: number, source: string): void {
    const prev = hits.get(hit.rowId);
    if (prev && prev.source !== source && score > prev.score) {
      prev.score = score;
      prev.source = source;
    } else if (!prev) {
      hits.set(hit.rowId, { ...hit, score, source });
    }
    if (!rankMap.has(hit.rowId)) rankMap.set(hit.rowId, rankMap.size);
  }

  private hitFromRowId(rowId: number, category: RecallHit['category']): RecallHit | null {
    const meta = FTS_TABLES[category];
    const src = meta.srcTable;
    try {
      const row = this.mem.db.prepare(`SELECT * FROM ${src} WHERE id = ? LIMIT 1`).get(rowId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const content = category === 'state'
        ? `${row.name ?? ''} ${row.state_json ?? ''}`
        : category === 'lore'
          ? `${row.comment ?? ''} ${row.content ?? ''}`
          : (row.summary ?? row.delta ?? row.description ?? '') as string;
      return {
        rowId,
        code: (row.code as string) ?? '',
        category,
        content: String(content).slice(0, 300),
        score: 0,
        source: 'db',
        confidence: 'high',
      };
    } catch {
      return null;
    }
  }

  private categoryOfRow(rowId: number): RecallHit['category'] {
    for (const cat of ['arc', 'summary', 'event', 'state', 'lore'] as const) {
      if (this.hitFromRowId(rowId, cat)) return cat;
    }
    return 'lore';
  }

  /** 占位 embedding：可替换为本地 bge 模型 / OpenAI 兼容 /embeddings（Phase 3） */
  private embed(text: string): number[] {
    // hash 桶伪向量（MVP 占位）：确定性、维度 64
    const dims = 64;
    const v = new Array<number>(dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      v[code % dims] += 1 + (code % 7) * 0.1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
