/**
 * core 包 - 世界书语义激活器
 * 在保留关键词/正则/概率门触发的基础上，为世界书条目增加【语义向量匹配】能力。
 * 核心原则：
 *   - 世界书条目以【整条目】为单位向量化，不切碎（碎片破坏条目内部上下文关联）。
 *   - 复用 packages/memory 的 bge 编码能力（EmbeddingProvider）+ vec_memory 已落库整条目向量，不重复编码。
 *   - 融合得分 = 加权线性 + sigmoid；确定性触发（关键词/正则/常驻）保证激活不被模糊阈值吞掉，
 *    语义仅作为【未命中】条目的补充召回（防漏触发）。
 *   - 向量/编码不可用时自动降级为纯关键词/正则（基础功能不中断）。
 */
import { MemoryDb } from '../../../memory/src/db.ts';
import { cosine, decodeF32, readableLoreContent } from '../../../memory/src/retrieval.ts';
import type { EmbeddingProvider } from '../../../memory/src/embedding.ts';
import type {
  ActivationContext,
  SemanticActivatorOptions,
  SemanticActivation,
  SemanticEntry,
  SemanticIndexStatus,
} from './types.ts';
import { scoreKeyword, hasDeterministicHit } from './keyword-scorer.ts';

/** 默认权重/阈值（env 可覆盖）。
 *  校准说明：权重和为 1，sigmoid(raw-bias) 上限 = sigmoid(1-bias)。选 bias=0.35 → 上限≈0.66，
 *  故 thresholdHigh 取 0.6（需多信号都强才达 high）；纯语义条目标记 medium（经门控注入摘要）。
 *  语义温度默认 1.0（缓解文档原 0.1 的指数锐化过度压制中低相似度、导致语义召回落空的问题）。 */
export function defaultActivatorOptions(): Required<SemanticActivatorOptions> {
  const num = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    weights: {
      keyword: num('JG_WB_W_KEYWORD', 0.35),
      semantic: num('JG_WB_W_SEMANTIC', 0.4),
      entity: num('JG_WB_W_ENTITY', 0.1),
      probability: num('JG_WB_W_PROBABILITY', 0.15),
    },
    bias: num('JG_WB_SIGMOID_BIAS', 0.35),
    thresholdHigh: num('JG_WB_THRESHOLD_HIGH', 0.6),
    thresholdMedium: num('JG_WB_THRESHOLD_MEDIUM', 0.5),
    semanticTemperature: num('JG_WB_SEM_TEMP', 1.0),
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 温度缩放语义相似度到 0~1（x∈[-1,1]，温度越小越锐利） */
function scaleSimilarity(sim: number, temperature: number): number {
  const e = Math.exp(sim / temperature);
  const e1 = Math.exp(1 / temperature);
  return e / e1;
}

export class SemanticWorldbookActivator {
  private entries = new Map<number, SemanticEntry>();
  private ready = false;
  private provider: EmbeddingProvider | null = null;
  private queryCache = new Map<string, number[]>();

  constructor(private options: Required<SemanticActivatorOptions> = defaultActivatorOptions()) {}

  /** 注入编码 provider（缺省则语义得分为 0，仅依赖关键词/正则/实体/概率） */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.provider = provider;
    this.queryCache.clear();
  }

  /** 从 vec_memory 载入世界书整条目向量（闭环：session 在 useBge 时已用 Vectorizer 写入）。
   *  仅载入有向量的启用条目；无向量条目仅参与关键词/正则/概率信号（语义得分为 0）。 */
  loadFromVecMemory(mem: MemoryDb): void {
    const rows = mem.db.prepare('SELECT id, comment, content, probability, useProbability, constant, active, key, use_regex, triggers FROM lorebook_entry').all() as {
      id: number; comment: string; content: string; probability: number; useProbability: number;
      constant: number; active: number; key: string; use_regex: number; triggers: string;
    }[];
    const vecRows = mem.db.prepare('SELECT row_id, dims, embedding FROM vec_memory').all() as {
      row_id: number; dims: number; embedding: Uint8Array;
    }[];
    const vecByRow = new Map<number, number[]>();
    for (const v of vecRows) vecByRow.set(v.row_id, decodeF32(Buffer.from(v.embedding)));

    this.entries.clear();
    for (const r of rows) {
      const emb = vecByRow.get(r.id);
      this.entries.set(r.id, {
        id: r.id,
        comment: r.comment ?? '',
        content: readableLoreContent(r.content ?? ''),
        probability: Number(r.probability ?? 100),
        useProbability: Boolean(r.useProbability),
        constant: Boolean(r.constant),
        enabled: r.active === 1,
        keywords: (r.key ?? '').split('|').filter(Boolean),
        useRegex: Boolean(r.use_regex),
        triggersJson: r.triggers ?? '[]',
        embedding: emb,
      });
    }
    this.ready = true;
  }

  /** 是否已就绪（即便就绪，若 provider 缺失语义得分为 0） */
  isReady(): boolean {
    return this.ready;
  }

  /** 启用条目总数（含无向量条目） */
  entryCount(): number {
    return this.entries.size;
  }

  getStatus(): SemanticIndexStatus {
    return { ready: this.ready && !!this.provider, entryCount: this.entries.size };
  }

  /** 激活检测：对每条启用条目计算融合得分。返回所有过 thresholdMedium 的条目（含关键词命中的），
   *  由调用方决定如何并入既有确定性管线。 */
  async activate(context: ActivationContext): Promise<SemanticActivation[]> {
    const queryText = `${context.currentInput} ${context.recentSummary ?? ''}`.trim();
    let queryVec: number[] | null = null;
    if (this.provider) {
      queryVec = await this.encodeQuery(queryText);
    }
    const activeEntities = context.activeEntities ?? new Set<string>();

    const out: SemanticActivation[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;

      const keywordScore = scoreKeyword(entry, context.currentInput);
      const semanticScore = queryVec && entry.embedding
        ? scaleSimilarity(cosine(queryVec, entry.embedding), this.options.semanticTemperature)
        : 0;
      const entityScore = this.scoreEntity(entry, activeEntities);
      // 概率信号：启用概率门时 = prob/100（0% 强拉低、100% 拉满）；未启用 = 1（中性先验，不惩罚）
      const probability = entry.useProbability ? Math.max(0, Math.min(1, entry.probability / 100)) : 1;

      const raw =
        this.options.weights.keyword * keywordScore +
        this.options.weights.semantic * semanticScore +
        this.options.weights.entity * entityScore +
        this.options.weights.probability * probability;

      const activationScore = sigmoid(raw - this.options.bias);

      // 确定性触发保证激活（不过模糊阈值），其余按阈值分级
      const deterministic = hasDeterministicHit(entry, context.currentInput) || entry.constant;
      if (deterministic) {
        out.push({
          entryId: entry.id,
          score: activationScore,
          priority: 'high',
          triggeredBy: { keyword: keywordScore, semantic: semanticScore, entity: entityScore, probability },
        });
        continue;
      }
      if (activationScore >= this.options.thresholdMedium) {
        out.push({
          entryId: entry.id,
          score: activationScore,
          priority: activationScore >= this.options.thresholdHigh ? 'high' : 'medium',
          triggeredBy: { keyword: keywordScore, semantic: semanticScore, entity: entityScore, probability },
        });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  private async encodeQuery(text: string): Promise<number[]> {
    if (!this.provider) return [];
    const cached = this.queryCache.get(text);
    if (cached) return cached;
    const v = await this.provider.embed(text);
    this.queryCache.set(text, v);
    return v;
  }

  /** 实体重叠度：条目文本（comment+content）与当前活跃实体的重叠比例；无实体字段时退回文本 `activeEntities` 命中计数理论（0~1） */
  private scoreEntity(entry: SemanticEntry, activeEntities: Set<string>): number {
    if (activeEntities.size === 0) return 0;
    const text = `${entry.comment} ${entry.content}`;
    let hit = 0;
    for (const e of activeEntities) {
      if (text.includes(e)) hit++;
    }
    return Math.min(1, hit / Math.max(1, entry.keywords.length + 1));
  }
}
