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
import {
  DEFAULT_WEIGHTS,
  DEFAULT_DROP_THRESHOLD,
  AM_CODE_RE,
  DECAY_LAMBDA_DEFAULT,
  ACCESS_BOOST_DEFAULT,
  DAY_MS,
} from './schema.ts';

/** 记忆衰减/访问提升 运行时默认值（env 可覆盖；RecallQuery 三字段可再覆盖） */
const DECAY_ENABLED = !['0', 'false', 'off'].includes((process.env.JG_MEMORY_DECAY ?? '').toLowerCase());
const ENV_DECAY_LAMBDA = Number(process.env.JG_MEMORY_DECAY_LAMBDA ?? DECAY_LAMBDA_DEFAULT);
const ENV_ACCESS_BOOST = Number(process.env.JG_MEMORY_ACCESS_BOOST ?? ACCESS_BOOST_DEFAULT);

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
  /** PG 检索命名空间（会话 DB 基名）；缺省空串=不过滤（向后兼容无命名空间调用） */
  namespace?: string;
  /** 记忆衰减开关（默认读 JG_MEMORY_DECAY） */
  decay?: boolean;
  /** 遗忘曲线衰减系数（每天，默认 0.1） */
  decayLambda?: number;
  /** 访问提升系数（默认 0.5） */
  accessBoost?: number;
  /** 命中后是否回写访问计数（默认 true；内部多段检索避免重复回写时置 false） */
  trackAccess?: boolean;
  /** UP-07: structured recall context. currentInput is the primary semantic intent. */
  structured?: RecallStructuredContext;
  /**
   * 内部标记：跳过 rerank（仅供 recallAsync 调用 base recall 时使用）。
   * recallAsync 会在「base ∪ 异步追加的 alias/vec 候选」合并后再统一 rerank 一次，
   * 否则 base 命中会被 rerank 加成两次，与异步追加候选尺度不一致。
   */
  skipRerank?: boolean;
}

export interface RecallHit {
  /** Stable business identity: namespace + business source/category + row id. */
  recordKey: string;
  rowId: number;
  code: string;
  category: 'arc' | 'summary' | 'event' | 'state' | 'lore';
  content: string;
  score: number;
  source: string; // bm25 | vec | entity | am | like
  confidence: 'high' | 'low';
  /** 记忆衰减：被检索注入次数（lore 恒为 0，不参与衰减） */
  accessCount?: number;
  /** 记忆衰减：最近一次被注入时间戳(ms)，<=0 视为新生不衰减 */
  lastAccessMs?: number;
  /** 记忆衰减：本轮衰减因子（调试/日志） */
  decayFactor?: number;
  /** UP-07: human-readable reasons used by the lightweight reranker. */
  reasons?: string[];
  /** UP-07: approximate injected cost for final accounting. */
  injectedTokens?: number;
}

export interface RecallStructuredContext {
  currentInput: string;
  resolvedEntities?: string[];
  sceneFacts?: string[];
  recentDialogueHints?: string[];
  memoryHints?: string[];
  plotHypotheses?: string[];
  scope?: string;
  stateVersion?: string | number;
}

export interface RecallTraceEntry {
  recordKey: string;
  category: RecallCategory;
  source: string;
  decision: 'kept' | 'dropped';
  score: number;
  reasons: string[];
  injectedTokens?: number;
}

export interface RecallTrace {
  query: string;
  structured?: RecallStructuredContext;
  candidates: RecallTraceEntry[];
  injected: RecallTraceEntry[];
  dropped: RecallTraceEntry[];
  budgetTokens: number;
  usedTokens: number;
}

type RecallCategory = RecallHit['category'];
type RecallChannels = Required<NonNullable<RecallQuery['channels']>>;

const DEFAULT_CHANNELS: RecallChannels = { bm25: true, vec: true, entity: true, am: true };

function normalizeChannels(channels?: RecallQuery['channels']): RecallChannels {
  return { ...DEFAULT_CHANNELS, ...(channels ?? {}) };
}

function recordKey(category: RecallCategory, rowId: number, namespace = ''): string {
  return `${namespace || 'default'}:${category}:${rowId}`;
}

function uniqueParts(parts: (string | undefined)[], maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  for (const raw of parts) {
    const p = (raw ?? '').trim();
    if (!p || out.includes(p)) continue;
    const next = used + p.length + (out.length > 0 ? 1 : 0);
    if (next > maxChars) break;
    out.push(p);
    used = next;
  }
  return out.join(' ');
}

function synthesizeQuery(q: RecallQuery): string {
  if (!q.structured) return q.query;
  const s = q.structured;
  const primary = uniqueParts([
    s.currentInput,
    ...(s.resolvedEntities ?? []),
    ...(s.sceneFacts ?? []),
    ...(s.recentDialogueHints ?? []),
  ], 220);
  const secondary = uniqueParts([
    ...(s.memoryHints ?? []),
    ...(s.plotHypotheses ?? []).map((p) => `plan:${p}`),
    s.scope ? `scope:${s.scope}` : undefined,
    s.stateVersion !== undefined ? `state:${s.stateVersion}` : undefined,
    q.query,
  ], 100);
  return uniqueParts([primary, secondary], 320);
}

/** rerank 词元上限（n-gram 化后防爆）与单条命中最大匹配数（防加成无界） */
const MAX_TERMS = 48;
const MAX_MATCHES = 8;

function textTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (t.length < 2 || seen.has(t) || out.length >= MAX_TERMS) return;
    seen.add(t);
    out.push(t);
  };
  for (const raw of text.split(/[\s,，。！？、.!?;；:：()\[\]{}<>《》"'“”‘’]+/)) {
    const seg = raw.trim();
    if (seg.length < 2) continue;
    if (seg.length <= 16) {
      push(seg);
      continue;
    }
    // 长段（典型为无空格中文句）：整段 >16 字会被丢弃，导致 currentTerms 为空、rerank 空转。
    // 中文按字符滑窗补 2~3 字 n-gram；非中文长段退化为前缀截断。
    if (!/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(seg)) {
      push(seg.slice(0, 16));
      continue;
    }
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= seg.length; i++) push(seg.slice(i, i + n));
    }
  }
  return out;
}

function scoreOverlap(content: string, terms: string[], weight: number): { score: number; reasons: string[] } {
  let matches = 0;
  const reasons: string[] = [];
  for (const t of terms) {
    if (!content.includes(t)) continue;
    matches++;
    if (reasons.length < 4) reasons.push(t);
    if (matches >= MAX_MATCHES) break; // 上限保护：n-gram 化后词元数量大幅上升，避免加成无界膨胀
  }
  return { score: matches * weight, reasons };
}

export interface RecallResult {
  hits: RecallHit[];
  injectedBlock: string;
  codes: string[];
  elapsedMs: number;
  layerStats: Record<string, number>;
  trace?: RecallTrace;
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

/**
 * 记忆衰减因子（Ebbinghaus 遗忘曲线近似）：
 * decay = exp(-λ * days) ∈ (0, 1]，越久越小；elapsedMs<=0 = 全新 → 1。
 * @param elapsedMs 距最近一次被注入的时间（毫秒）
 * @param lambda 每天衰减系数（默认 0.1：7 天≈50% 残留）
 */
export function calculateDecay(elapsedMs: number, lambda: number): number {
  return Math.exp(-lambda * (Math.max(0, elapsedMs) / DAY_MS));
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

/** 动态记忆表（记忆衰减/访问计数仅作用于用户态记忆；世界书 lore 静态条目不参与） */
const ACCESS_TABLES: Partial<Record<RecallHit['category'], string>> = {
  arc: 'memory_arc',
  summary: 'memory_summary',
  event: 'memory_event',
  state: 'memory_state',
};

/** 提取 FTS trigram 查询词元：3-6 字短词（trigram 完整匹配语义可靠） */
function collectFtsTokens(query: string): string[] {
  return query.split(/[\s,，、;；]+/).filter((t) => t.length >= 3 && t.length <= 6);
}

/** 提取 LIKE 兜底查询：<3 字词元 + 长句（≥7 字）的 4 字全覆盖窗口（步长 1，保证包含任意 4 字连续子串）。
 *  多词元轮转取样（每词元每轮取 1 窗口直到上限）：避免超长首词元（如 150 字压缩摘要）独占全部名额、
 *  把真正重要的用户输入挤出 LIKE 匹配。 */
function collectLikeQueries(query: string): string[] {
  const windows: string[][] = [];
  for (const t of query.split(/[\s,，、;；]+/)) {
    if (!t) continue;
    if (t.length < 3) {
      windows.push([t]);
    } else if (t.length >= 7) {
      const w: string[] = [];
      for (let i = 0; i + 4 <= t.length; i++) w.push(t.slice(i, i + 4));
      windows.push(w);
    }
    // 3-6 字词元走 FTS trigram，不进 LIKE
  }
  const out: string[] = [];
  const max = 32;
  for (let round = 0; out.length < max; round++) {
    let took = false;
    for (const w of windows) {
      if (out.length >= max) break;
      if (round < w.length) {
        out.push(w[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

/**
 * 从世界书条目原文提炼「可读设定」：剥离 EJS/MVU 代码（<%_ … %>）与 {{// }} 注释，
 * 保留自然语言设定。只影响注入展示，不改检索匹配。
 */
export function readableLoreContent(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<%[-=_]?[\s\S]*?[-=_]?%>/g, ' ')   // EJS/MVU 代码段
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, ' ')        // 注释段
    .replace(/[\r\n]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 记忆块渲染（带来源与置信度标注；导出供 session 对去重后的 hits 重渲染，截断长度可调） */
export function renderRecallBlock(hits: RecallHit[], truncate = 240): string {
  if (hits.length === 0) return '<记忆召回>\n（本轮无高置信记忆命中）\n</记忆召回>';
  const lines = hits.map((h) => {
    const tag = h.confidence === 'low' ? ' [存疑]' : '';
    return `[${h.code || `ROW${h.rowId}`}|${h.category}|${h.score.toFixed(2)}|${h.source}]${tag} ${h.content.slice(0, truncate)}`;
  });
  return `<记忆召回>\n${lines.join('\n')}\n</记忆召回>`;
}

export class RetrievalEngine {
  /** 注入的 embedding provider（真实语义向量；缺省用内置 hash） */
  private embedProvider: { embed: (t: string) => Promise<number[]> } | null = null;
  private embedCache = new Map<string, number[]>();
  /** 注入的 PG 真向量库（可选；缺省回落 SQLite vec_memory）。lore_chunk.lore_id ↔ SQLite lorebook_entry.id */
  private pgStore: { query(ns: string, v: number[], k: number, threshold: number): Promise<{ loreId: number; seq: number; text: string; sim: number }[]>; queryByAlias(ns: string, q: string, k: number): Promise<{ alias: string; entityName: string; explicit: boolean }[]> } | null = null;

  constructor(private mem: MemoryDb) {}

  /** 注入真实 embedding provider（bge 等；recallAsync 使用） */
  setEmbeddingProvider(provider: { embed: (t: string) => Promise<number[]> }): void {
    this.embedProvider = provider;
  }

  /**
   * Q6 read-only semantic port. It reuses the session's configured embedding provider and
   * never writes PG/SQLite vector state. An unavailable provider is an explicit no-candidate
   * result so optional preference learning cannot change the foreground turn.
   */
  async embedTexts(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 9
      || texts.some((text) => typeof text !== 'string' || text.length < 1 || text.length > 2_000)) {
      throw new TypeError('embedding texts must contain 1..9 bounded strings');
    }
    if (!this.embedProvider) return Object.freeze([]);
    const vectors = await Promise.all(texts.map((text) => this.embedQuery(text)));
    return Object.freeze(vectors.map((vector) => Object.freeze([...vector])));
  }

  /** 注入 PG pgvector 存储（提供真向量 ANN + 别名确定性检索；缺省则回落 SQLite） */
  setPgStore(store: { query(ns: string, v: number[], k: number, threshold: number): Promise<{ loreId: number; seq: number; text: string; sim: number }[]>; queryByAlias(ns: string, q: string, k: number): Promise<{ alias: string; entityName: string; explicit: boolean }[]> } | null): void {
    this.pgStore = store;
  }

  /** 自适应覆盖（AQL 循环A/RAG）：boostIds 强制保留（即便天然分未过门）、RRF 权重/丢弃阈值覆盖。
   *  由数据/adaptive-config.json 的 retrieval 块热读注入；可整体 reset（清空回 env 默认）。 */
  private adaptive: { boostIds?: number[]; weights?: Partial<typeof DEFAULT_WEIGHTS>; dropThreshold?: number } = {};
  setAdaptive(opts: { boostIds?: number[]; weights?: Partial<typeof DEFAULT_WEIGHTS>; dropThreshold?: number }): void {
    this.adaptive = opts;
  }

  /** 异步混合检索：通道 B 使用真实 embedding（bge），其余通道与 recall 一致 */
  async recallAsync(q: RecallQuery): Promise<RecallResult> {
    const t0 = Date.now();
    const queryText = synthesizeQuery(q);
    const effectiveQuery = { ...q, query: queryText };
    const channels = normalizeChannels(q.channels);
    // 基础检索（关闭 hash vec 通道 + 衰减/访问回写 + rerank，避免与下方合并集重复；合并后统一应用一次）
    // structured 置空：queryText 已完成一次结构化合成，避免 recall 内二次 synthesize 造成查询重复膨胀
    const base = this.recall({
      ...effectiveQuery,
      structured: undefined,
      skipRerank: true,
      channels: { ...channels, vec: false },
      decay: false,
      trackAccess: false,
      budgetTokens: Number.MAX_SAFE_INTEGER,
    });
    const ns = q.namespace ?? '';
    // 强信号（alias/vec）合并表：命中已存在时**就地升级**而非跳过。
    // base 现在不做预算截断，命中面比过去宽得多；若沿用「已存在就跳过」，
    // 已被 bm25 低分召回的同一行将永远无法升级为高置信别名/向量命中，
    // 进而在最终预算里被高分 bm25 挤掉（verify-archive「别名命中正式本体」回归根因）。
    const byKey = new Map<string, RecallHit>(base.hits.map((h) => [h.recordKey, h] as const));
    const promoteStrong = (h: RecallHit, score: number, source: string): void => {
      const existing = byKey.get(h.recordKey);
      if (existing) {
        if (score > existing.score) existing.score = score;
        existing.source = source;
        existing.confidence = 'high';
        return;
      }
      const hit: RecallHit = { ...h, score, source, confidence: 'high' };
      byKey.set(hit.recordKey, hit);
      base.hits.push(hit);
    };

    // 通道0：PG 别名/职位简写确定性命中（最高优先）—— 解决 2 字词（"会长"）FTS 失效
    let aliasAdded = 0;
    if (channels.entity && this.pgStore) {
      for (const tok of queryText.split(/[\s,，、;；]+/)) {
        if (!tok || aliasAdded >= 6) continue;
        const aliasHits = await this.pgStore.queryByAlias(ns, tok, 3);
        for (const a of aliasHits) {
          // 反查该实体的 lorebook_entry.rowId：优先 comment 精确含实体名（角色本体设），退而 content 含
          const entity = a.entityName.replace(/[%_\]]/g, ' ').trim();
          // 仅启用条目：废弃（active=0）旧档案不得进入召回（0.9.x RAG 卫生）
          const rows = this.mem.db.prepare(
            `SELECT id AS rowId, CASE WHEN comment LIKE ?1 COLLATE NOCASE THEN 0 ELSE 1 END AS rank
             FROM lorebook_entry WHERE active = 1 AND (comment LIKE ?1 OR content LIKE ?2)
             ORDER BY rank ASC, id ASC LIMIT 6`
          ).all(`%${entity}%`, `%${entity}%`) as { rowId: number; rank: number }[];
          for (const { rowId } of rows.slice(0, 2)) {
            const h = this.hitFromRowId(rowId, 'lore', ns);
            if (!h) continue;
            if (byKey.get(h.recordKey)?.source === 'alias') continue; // 已升级过，避免重复计数
            promoteStrong(h, 0.99 - aliasAdded * 0.005, 'alias');
            aliasAdded++;
          }
        }
      }
    }

    // 通道B：PG 真向量 ANN（lore_chunk），退回落 SQLite vec_memory
    if (channels.vec && this.embedProvider) {
      const qv = await this.embedQuery(queryText);
      if (qv.length > 0) {
        const rows = this.mem.db.prepare("SELECT source, row_id, dims, embedding FROM vec_memory WHERE active = 1 AND source IN ('lore','arc','summary','event')").all() as {
          source: RecallCategory; row_id: number; dims: number; embedding: Uint8Array;
        }[];
        const scored: { source: RecallCategory; rowId: number; sim: number }[] = [];
        for (const r of rows) {
          if (r.dims !== qv.length) continue;
          const sim = cosine(qv, decodeF32(Buffer.from(r.embedding)));
          if (sim > 0.5) scored.push({ source: r.source, rowId: r.row_id, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        for (const s of scored.slice(0, 10)) {
          const h = this.hitFromRowId(s.rowId, s.source, ns);
          if (h) promoteStrong(h, s.sim, 'vec');
        }
        // PG 真向量 ANN：lore_id → SQLite lorebook_entry.id
        if (this.pgStore) {
          const pgHits = await this.pgStore.query(ns, qv, 10, Number(process.env.JG_VEC_THRESHOLD ?? 0.4));
          for (const pg of pgHits) {
            const h = this.hitFromRowId(pg.loreId, 'lore', ns);
            if (!h) continue;
            promoteStrong(h, pg.sim, 'vec');
          }
        }
      }
      } // end vector channel merge

    // 记忆衰减 + 访问提升（对完整合并集统一应用一次；内层 recall 已关闭以避免重复）
    if (q.decay ?? DECAY_ENABLED) {
      this.applyDecayAndAccess(base.hits, { decayLambda: q.decayLambda ?? ENV_DECAY_LAMBDA, accessBoost: q.accessBoost ?? ENV_ACCESS_BOOST });
    }
    // 语义强信号置顶（alias/vec 确定性优先），次按衰减后得分。
    // pri 必须是**一级**排序键：归一化后的 bm25 分（0.85~1.0）与 alias(0.99)/vec 余弦(0.4~0.9)
    // 量纲不可比，若让 score 优先，确定性命中会被普通全文命中反超并在预算里被裁掉。
    const pri: Record<string, number> = { alias: 0, vec: 1, am: 2, entity: 2, bm25: 3, like: 3 };
    this.rerank(base.hits, q.structured, pri);
    base.hits.sort((a, b) => (pri[a.source] ?? 9) - (pri[b.source] ?? 9) || b.score - a.score);
    const budgeted = this.applyBudget(base.hits, q.budgetTokens ?? 600);
    base.hits = budgeted.final;
    base.codes = base.hits.map((h) => h.code).filter(Boolean);
    base.injectedBlock = this.renderBlock(base.hits);
    base.layerStats = {
      ...base.layerStats,
      alias: aliasAdded,
      vec: base.hits.filter((h) => h.source === 'vec').length,
      budgetDropped: (base.layerStats.budgetDropped ?? 0) + budgeted.dropped,
      decayBoosted: base.hits.filter((h) => (h.decayFactor ?? 1) < 1 || (h.accessCount ?? 0) > 0).length,
    };
    if (q.trackAccess !== false) this.bumpAccess(base.hits);
    base.trace = this.buildTrace(queryText, q.structured, base.hits, budgeted.droppedHits, q.budgetTokens ?? 600);
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
    const queryText = synthesizeQuery(q);
    // 权重/阈值优先级：query 显式 > adaptive 覆盖 > env/默认（DEFAULT_WEIGHTS 此前是死常量，AQL 循环A 复权）
    const weights = { ...DEFAULT_WEIGHTS, ...this.adaptive.weights, ...q.weights };
    const drop = q.dropThreshold ?? this.adaptive.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
    const channels = normalizeChannels(q.channels);
    const round = q.round ?? 0;
    const ns = q.namespace ?? '';
    const hits = new Map<string, RecallHit>(); // recordKey -> hit
    const rankMaps: Record<string, Map<string, number>> = { bm25: new Map(), vec: new Map(), recency: new Map(), am: new Map() };

    // 通道A：FTS5 trigram BM25（短词 3-6 字）+ LIKE 兜底（<3 字词元 + 长句 n-gram 窗口词）
    if (channels.bm25) {
      for (const [category, meta] of Object.entries(FTS_TABLES)) {
        const tri = this.bm25Search(meta.ftsTable, collectFtsTokens(queryText));
        for (const row of tri) this.addBm25Hit(hits, rankMaps.bm25, category as RecallHit['category'], row, row.bm25, ns);
        // LIKE 兜底：短词（trigram 无法处理 <3 字）+ 长句窗口词（trigram AND 对齐失败场景）
          const likeQueries = collectLikeQueries(queryText);
        if (likeQueries.length > 0) {
          for (const row of this.likeSearch(meta, likeQueries)) {
            this.addBm25Hit(hits, rankMaps.bm25, category as RecallHit['category'], row, 0.25, ns);
          }
        }
      }
    }

    // 通道A2：实体精确映射（命中计入 rankMaps.recency 参与 RRF；单独计数供 layerStats 观测）
    let entityHits = 0;
    if (channels.entity) {
      const rows = this.mem.db.prepare(
        'SELECT row_id, category FROM idx_entity WHERE entity = ? ORDER BY weight DESC LIMIT 20'
      ).all(queryText.trim()) as { row_id: number; category: string }[];
      rows.forEach((r, i) => {
        const h = this.hitFromRowId(r.row_id, r.category as RecallHit['category'], ns);
        if (!h) return;
        entityHits++;
        this.addRankedHit(hits, rankMaps.recency, h, 1.0 - i * 0.02, `entity`);
      });
    }

    // 通道A3：AM 码直查（直接查原表，绕过 FTS 的 rowid 歧义）
    if (channels.am) {
      for (const token of queryText.split(/[\s,，、;；]+/)) {
        if (!AM_CODE_RE.test(token)) continue;
        const row = this.mem.db.prepare(
          `SELECT id AS row_id, code, 'arc' AS category, summary AS content FROM memory_arc WHERE code = ?
           UNION ALL SELECT id, code, 'summary', delta FROM memory_summary WHERE code = ?
           UNION ALL SELECT id, code, 'event', description FROM memory_event WHERE code = ?
           LIMIT 1`
        ).get(token, token, token) as { row_id: number; code: string; category: string; content: string } | undefined;
        if (row) {
          const h: RecallHit = {
            recordKey: recordKey(row.category as RecallHit['category'], row.row_id, ns),
            rowId: row.row_id, code: token, category: row.category as RecallHit['category'], content: row.content,
            score: 0, source: 'am', confidence: 'high',
          };
          this.addRankedHit(hits, rankMaps.am, h, 1.0, 'am');
        }
      }
    }

    // 通道B：向量余弦（BLOB 全扫，万级毫秒级）
    if (channels.vec) {
      const qv = this.embed(queryText);
      if (qv.length > 0) {
        const rows = this.mem.db.prepare("SELECT source, row_id, dims, embedding FROM vec_memory WHERE active = 1 AND source IN ('lore','arc','summary','event')").all() as {
          source: RecallCategory; row_id: number; dims: number; embedding: Uint8Array;
        }[];
        const scored: { source: RecallCategory; rowId: number; sim: number }[] = [];
        for (const r of rows) {
          const sim = cosine(qv, decodeF32(Buffer.from(r.embedding)));
          if (sim > 0.4) scored.push({ source: r.source, rowId: r.row_id, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        for (const s of scored.slice(0, 10)) {
          const h = this.hitFromRowId(s.rowId, s.source, ns);
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

    // RRF 融合（w_i/(60+rank)：权重真正参与融合 —— DEFAULT_WEIGHTS 复权，adaptive 可覆盖）
    const W = { bm25: weights.wBm25, vec: weights.wVec, recency: weights.wRecency, am: weights.wAmPriority };
    const fused: RecallHit[] = [];
    for (const h of hits.values()) {
      let rrf = 0;
      for (const [ch, rankMap] of Object.entries(rankMaps) as [keyof typeof W, Map<string, number>][]) {
        const rank = rankMap.get(h.recordKey);
        if (rank !== undefined) rrf += (W[ch] ?? 0) / (60 + rank);
      }
      h.score = rrf;
      fused.push(h);
    }
    fused.sort((a, b) => b.score - a.score);

    // 置信门控：RRF 得分范围 ~[0, 0.05]，min-max 归一化到 [0,1]
    const maxScore = fused.length > 0 ? fused[0].score : 0;
    const norm = (s: number) => (maxScore > 0 ? s / maxScore : 0);
    for (const h of fused) h.score = norm(h.score);
    // 记忆衰减 + 访问提升（拍在归一化得分上：score = norm * exp(-λΔt) + log(1+access)*boost）
    if (q.decay ?? DECAY_ENABLED) {
      this.applyDecayAndAccess(fused, { decayLambda: q.decayLambda ?? ENV_DECAY_LAMBDA, accessBoost: q.accessBoost ?? ENV_ACCESS_BOOST });
      fused.sort((a, b) => b.score - a.score);
    }
    const kept = fused.filter((h) => h.score >= drop);
    for (const h of kept) {
      h.confidence = h.score >= drop + 0.15 ? 'high' : 'low';
      h.source = h.source || 'rrf';
    }
    // AQL 循环A：boostIds 强制保留——天然分未过门也抬到 high 置信；完全未召回则按 lore 直查补入
    if (this.adaptive.boostIds && this.adaptive.boostIds.length > 0) {
      const ids = new Set(this.adaptive.boostIds);
      const known = new Set(fused.map((h) => h.recordKey));
      for (const id of ids) {
        let h = fused.find((x) => x.recordKey === recordKey('lore', id, ns));
        if (!h && !known.has(recordKey('lore', id, ns))) h = this.hitFromRowId(id, 'lore', ns) ?? undefined;
        if (!h) continue;
        h.score = Math.max(h.score, drop + 0.16);
        h.confidence = 'high';
        h.source = h.source || 'boost';
        if (!kept.includes(h)) kept.push(h);
      }
      kept.sort((a, b) => b.score - a.score);
    }

    // Token 预算截断（粗估：1 汉字 ≈ 1.5 token）
    if (!q.skipRerank) this.rerank(kept, q.structured);
    const { final, dropped: budgetDropped, droppedHits } = this.applyBudget(kept, q.budgetTokens ?? 600);

    // 访问计数回写（仅「实际注入」的命中，供遗忘曲线 access boost 累积）
    if (q.trackAccess !== false) this.bumpAccess(final);

    return {
      hits: final,
      injectedBlock: this.renderBlock(final),
      codes: final.map((h) => h.code).filter(Boolean),
      elapsedMs: Date.now() - t0,
      layerStats: {
        bm25: rankMaps.bm25.size,
        vec: rankMaps.vec.size,
        entity: entityHits,
        am: rankMaps.am.size,
        total: final.length,
        budgetDropped,
        decayBoosted: final.filter((h) => (h.decayFactor ?? 1) < 1 || (h.accessCount ?? 0) > 0).length,
      },
      trace: this.buildTrace(queryText, q.structured, final, droppedHits, q.budgetTokens ?? 600),
    };
  }

  /** 注入块渲染（带来源与置信度标注） */
  private renderBlock(hits: RecallHit[]): string {
    return renderRecallBlock(hits);
  }

  private applyBudget(hits: RecallHit[], budget: number): { final: RecallHit[]; dropped: number; droppedHits: RecallHit[]; usedTokens: number } {
    let used = 0;
    const final: RecallHit[] = [];
    for (const h of hits) {
      const cost = Math.ceil(h.content.length * 1.5);
      h.injectedTokens = cost;
      if (used + cost > budget && final.length > 0) break;
      used += cost;
      final.push(h);
    }
    return { final, dropped: hits.length - final.length, droppedHits: hits.slice(final.length), usedTokens: used };
  }

  private rerank(hits: RecallHit[], structured?: RecallStructuredContext, sourcePriority: Record<string, number> = {}): void {
    if (hits.length === 0) return;
    const currentTerms = textTerms(structured?.currentInput ?? '');
    const entityTerms = [...(structured?.resolvedEntities ?? []), ...textTerms((structured?.sceneFacts ?? []).join(' '))].filter(Boolean);
    const hintTerms = textTerms([...(structured?.recentDialogueHints ?? []), ...(structured?.memoryHints ?? [])].join(' '));
    for (const h of hits) {
      const reasons = new Set<string>(h.reasons ?? []);
      const cur = scoreOverlap(h.content, currentTerms, 0.18);
      const ent = scoreOverlap(h.content, entityTerms, 0.12);
      const hint = scoreOverlap(h.content, hintTerms, 0.04);
      if (cur.score > 0) reasons.add(`current:${cur.reasons.join('/')}`);
      if (ent.score > 0) reasons.add(`entity:${ent.reasons.join('/')}`);
      if (hint.score > 0) reasons.add(`hint:${hint.reasons.join('/')}`);
      if (h.category === 'lore' && h.content.length > 0) reasons.add('category:lore');
      if (sourcePriority[h.source] !== undefined) h.score += Math.max(0, 6 - sourcePriority[h.source]) * 0.005;
      h.score += cur.score + ent.score + hint.score;
      h.reasons = [...reasons].filter(Boolean);
    }
    hits.sort((a, b) => b.score - a.score || a.recordKey.localeCompare(b.recordKey));
  }

  private buildTrace(query: string, structured: RecallStructuredContext | undefined, kept: RecallHit[], dropped: RecallHit[], budgetTokens: number): RecallTrace {
    const toTrace = (h: RecallHit, decision: 'kept' | 'dropped'): RecallTraceEntry => ({
      recordKey: h.recordKey,
      category: h.category,
      source: h.source,
      decision,
      score: Number(h.score.toFixed(4)),
      reasons: h.reasons ?? [],
      injectedTokens: h.injectedTokens,
    });
    const injected = kept.map((h) => toTrace(h, 'kept'));
    const droppedEntries = dropped.map((h) => toTrace(h, 'dropped'));
    return {
      query,
      structured,
      candidates: [...injected, ...droppedEntries],
      injected,
      dropped: droppedEntries,
      budgetTokens,
      usedTokens: kept.reduce((sum, h) => sum + (h.injectedTokens ?? Math.ceil(h.content.length * 1.5)), 0),
    };
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
  private likeSearch(meta: FtsMeta, queries: string[]): { row_id: number }[] {
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

  private addBm25Hit(hits: Map<string, RecallHit>, rankMap: Map<string, number>, category: RecallHit['category'], row: { row_id: number }, score: number, namespace: string): void {
    const h = this.hitFromRowId(row.row_id, category, namespace);
    if (!h) return;
    this.addRankedHit(hits, rankMap, h, score, 'bm25');
  }

  private addRankedHit(hits: Map<string, RecallHit>, rankMap: Map<string, number>, hit: RecallHit, score: number, source: string): void {
    const prev = hits.get(hit.recordKey);
    if (prev && prev.source !== source && score > prev.score) {
      prev.score = score;
      prev.source = source;
    } else if (!prev) {
      hits.set(hit.recordKey, { ...hit, score, source });
    }
    if (!rankMap.has(hit.recordKey)) rankMap.set(hit.recordKey, rankMap.size);
  }

  private hitFromRowId(rowId: number, category: RecallHit['category'], namespace = ''): RecallHit | null {
    const meta = FTS_TABLES[category];
    const src = meta.srcTable;
    try {
      // 世界书静态条目仅取启用（active=1）：废弃/停用旧档案不得从任意通道注入
      const row = this.mem.db.prepare(`SELECT * FROM ${src} WHERE id = ? ${category === 'lore' ? 'AND active = 1' : ''} LIMIT 1`).get(rowId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const content = category === 'state'
        ? `${row.name ?? ''} ${row.state_json ?? ''}`
        : category === 'lore'
          ? `${row.comment ?? ''} ${readableLoreContent((row.content as string) ?? '')}`
          : (row.summary ?? row.delta ?? row.description ?? '') as string;
      return {
        recordKey: recordKey(category, rowId, namespace),
        rowId,
        code: (row.code as string) ?? '',
        category,
        content: String(content).slice(0, 300),
        score: 0,
        source: 'db',
        confidence: 'high',
        accessCount: Number(row.access_count ?? 0),
        lastAccessMs: Number(row.last_access_ms ?? 0),
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

  /**
   * 记忆衰减 + 访问提升：score = score * exp(-λ·Δt) + log(1+accessCount) * boost
   * （Ebbinghaus 遗忘曲线：越久没被引用磨损越大；被引用越多越重要。）
   * 世界书静态条目（lore）不参与；lastAccessMs<=0 视为新生（decay=1）。
   */
  private applyDecayAndAccess(hits: RecallHit[], opts: { decayLambda: number; accessBoost: number }): void {
    if (hits.length === 0) return;
    const now = Date.now();
    for (const h of hits) {
      if (h.category === 'lore') {
        h.decayFactor = 1;
        continue;
      }
      const elapsed = h.lastAccessMs && h.lastAccessMs > 0 ? now - h.lastAccessMs : 0;
      const decay = calculateDecay(elapsed, opts.decayLambda);
      const boost = Math.log(1 + (h.accessCount ?? 0)) * opts.accessBoost;
      h.score = h.score * decay + boost;
      h.decayFactor = decay;
    }
  }

  /** 访问计数回写：命中被实际注入提示词 → access_count+1 且刷新 last_access_ms
   *  （供后续轮次的遗忘曲线 access boost 累积；旧库缺列时忽略，不阻断检索）
   *  双表一致性：arc ↔ summary 同 AM 码孪生行同步累计（避免同一记忆两行访问计数分叉） */
  private bumpAccess(hits: RecallHit[]): void {
    if (hits.length === 0) return;
    const now = Date.now();
    const updated = new Set<string>();
    for (const h of hits) {
      const table = ACCESS_TABLES[h.category];
      if (!table || h.rowId <= 0) continue;
      try {
        const primaryKey = `${table}:${h.rowId}`;
        if (!updated.has(primaryKey)) {
          this.mem.db.prepare(`UPDATE ${table} SET access_count = access_count + 1, last_access_ms = ? WHERE id = ?`).run(now, h.rowId);
          updated.add(primaryKey);
        }
        // 孪生行同步（同 AM 码）：arc 命中同步 summary，summary 命中同步 arc
        if (h.category === 'arc' && h.code) {
          const rows = this.mem.db.prepare('SELECT id FROM memory_summary WHERE code = ?').all(h.code) as { id: number }[];
          for (const r of rows) {
            const twinKey = `memory_summary:${r.id}`;
            if (updated.has(twinKey)) continue;
            this.mem.db.prepare('UPDATE memory_summary SET access_count = access_count + 1, last_access_ms = ? WHERE id = ?').run(now, r.id);
            updated.add(twinKey);
          }
        } else if (h.category === 'summary' && h.code) {
          const rows = this.mem.db.prepare('SELECT id FROM memory_arc WHERE code = ?').all(h.code) as { id: number }[];
          for (const r of rows) {
            const twinKey = `memory_arc:${r.id}`;
            if (updated.has(twinKey)) continue;
            this.mem.db.prepare('UPDATE memory_arc SET access_count = access_count + 1, last_access_ms = ? WHERE id = ?').run(now, r.id);
            updated.add(twinKey);
          }
        }
      } catch {
        // 旧库缺列忽略
      }
    }
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
