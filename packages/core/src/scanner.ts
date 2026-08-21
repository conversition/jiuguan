/**
 * core 包 - 世界书扫描器（激活引擎，复刻酒馆 world-info 语义）
 * 依据 v2 07 §3 ①c / 审查 ADR 8：关键词匹配 + 正则触发器 + 概率门 + 深度扫描 + 常量恒激活。
 * 输入：lorebook_entry 表数据 + 当前文本（+ 历史消息）
 * 输出：激活条目 → L1 静态设定注入块（含预算截断）
 */
import { MemoryDb } from '../../memory/src/db.ts';
import type { EmbeddingProvider } from '../../memory/src/embedding.ts';
import { estimateTokens } from '../../prompt/src/assembly.ts';
import { SemanticWorldbookActivator } from './worldbook/semantic-activator.ts';
import type { ActivationContext } from './worldbook/types.ts';

export interface LoreRow {
  id: number;
  uid: string;
  book: string;
  key: string;
  comment: string;
  content: string;
  selective: number;
  depth: number;
  constant: number;
  use_regex: number;
  triggers: string;
  probability: number;
  useProbability: number;
  active: number;
}

export interface ScanOptions {
  /** 当前文本（用户输入 + 最近消息拼接） */
  text: string;
  /** 历史消息（scanDepth 扩展扫描窗口） */
  history?: string[];
  /** 启用概率门（默认 true） */
  useProbability?: boolean;
  /** 注入 Token 预算 */
  budgetTokens?: number;
  /** 确定性种子（测试用，缺省随机） */
  seed?: number;
  /** 递归扫描深度（默认 0 = 不递归） */
  maxRecursion?: number;
}

export interface ActivatedEntry {
  id: number;
  uid: string;
  comment: string;
  content: string;
  constant: boolean;
  matchType: 'constant' | 'keyword' | 'regex' | 'semantic';
  score: number;
  order: number;
  /** 融合激活附加信息（语义激活条目；向后兼容可选） */
  priority?: 'high' | 'medium';
  triggeredBy?: { keyword: number; semantic: number; entity: number; probability: number };
}

export interface ScanResult {
  activated: ActivatedEntry[];
  injectedBlock: string;
  stats: {
    scanned: number;
    constant: number;
    keywordMatched: number;
    probabilityDropped: number;
    tokens: number;
    /** 语义补充激活条数（融合召回；0 表示未启用/降级） */
    semanticAdded?: number;
  };
}

/** 解析酒馆正则字符串：/pattern/flags → RegExp | null */
export function parseRegexFromString(input: string): RegExp | null {
  const m = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
  if (!m) return null;
  let [, pattern, flags] = m;
  if (pattern.match(/(^|[^\\])\//)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** 关键词/正则匹配（复刻酒馆 matchKeys：正则优先，否则纯文本子串） */
export function matchKey(haystack: string, needle: string): boolean {
  const re = parseRegexFromString(needle);
  if (re) return re.test(haystack);
  return haystack.includes(needle.trim());
}

/** 触发器数组解析（酒馆 triggers: [{key,text}] 或 [string]） */
function triggerTexts(triggersJson: string): string[] {
  try {
    const arr = JSON.parse(triggersJson) as unknown[];
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const t of arr) {
      if (typeof t === 'string') out.push(t);
      else if (t && typeof t === 'object' && 'text' in (t as object)) out.push(String((t as { text: string }).text));
    }
    return out;
  } catch {
    return [];
  }
}

/** 确定性伪随机（mulberry32，测试用） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LorebookScanner {
  /** 语义激活器（整条目向量 + 多信号融合；缺省 null = 纯关键词/正则模式） */
  private semantic: SemanticWorldbookActivator | null = null;

  constructor(private mem: MemoryDb) {}

  /** 注入编码 provider 并启用语义激活（缺省则不启用，扫描走纯关键词/正则） */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.semantic = new SemanticWorldbookActivator();
    this.semantic.setEmbeddingProvider(provider);
  }

  /** 预载世界书整条目语义索引（从 vec_memory 读取已编码整条目向量，不重复编码）。
   *  编码/向量缺失时自动降级为纯关键词/正则。 */
  initSemantic(mem: MemoryDb): void {
    if (this.semantic) this.semantic.loadFromVecMemory(mem);
  }

  /** 是否已启用语义激活 */
  isSemanticReady(): boolean {
    return this.semantic?.isReady() ?? false;
  }

  /** 主入口：扫描并激活条目（纯关键词/正则/概率/常驻，同步确定性路径） */
  scan(opts: ScanOptions): ScanResult {
    const result = this.runScan(opts);
    return { ...result, stats: { ...result.stats, semanticAdded: 0 } };
  }

  /**
   * 语义增强扫描（异步）：在【确定性触发】基础上并入【语义补充召回】。
   * 设计（决策 A）：关键词/正则/常驻命中保证激活、不过模糊阈值；语义融合只在「未被确定性命中」的
   * 条目中做补充（防漏触发：同义词/表述差异/语义相近但字面不同）。融合公式 = 加权线性 + sigmoid。
   */
  async scanAsync(opts: ScanOptions): Promise<ScanResult> {
    const base = this.runScan(opts);
    if (!this.semantic || !this.semantic.isReady()) {
      return { ...base, stats: { ...base.stats, semanticAdded: 0 } };
    }
    const deterministicIds = new Set(base.activated.map((e) => e.id));
    const text = opts.text;
    const context: ActivationContext = { currentInput: text, activeEntities: this.activeEntitiesOf(text) };
    const fusion = await this.semantic.activate(context);
    const supplements: ActivatedEntry[] = [];
    for (const s of fusion) {
      if (deterministicIds.has(s.entryId)) continue;
      const row = this.mem.db.prepare('SELECT * FROM lorebook_entry WHERE id = ?').get(s.entryId) as unknown as LoreRow | undefined;
      if (!row) continue;
      // 语义补充不重复应用确定性概率门（概率已作为融合信号计入得分，避免双重过滤）
      supplements.push({
        id: row.id, uid: row.uid, comment: row.comment, content: row.content,
        constant: false, matchType: 'semantic', score: s.score, order: 2,
        priority: s.priority, triggeredBy: s.triggeredBy,
      });
    }

    const merged = [...base.activated, ...supplements];
    const final = this.finalize(merged, opts.budgetTokens ?? 800);
    return {
      activated: final,
      injectedBlock: this.renderBlock(final),
      stats: { ...base.stats, semanticAdded: supplements.length, tokens: base.stats.tokens },
    };
  }

  /** 确定性命中判定 + 排序/预算截断共享管线 */
  private runScan(opts: ScanOptions): ScanResult {
    const rows = this.mem.db.prepare('SELECT * FROM lorebook_entry WHERE active = 1').all() as LoreRow[];
    const text = opts.text;
    const scanText = [text, ...(opts.history ?? [])].join('\n');
    const rand = mulberry32(opts.seed ?? Date.now());
    const stats = { scanned: rows.length, constant: 0, keywordMatched: 0, probabilityDropped: 0, tokens: 0 };
    const activated: ActivatedEntry[] = [];

    for (const row of rows) {
      // 1. 常量恒激活
      if (row.constant === 1) {
        activated.push({ id: row.id, uid: row.uid, comment: row.comment, content: row.content, constant: true, matchType: 'constant', score: 1.0, order: 0 });
        stats.constant++;
        continue;
      }

      // 2. 正则触发器（use_regex 条目）
      let matched = false;
      let matchType: ActivatedEntry['matchType'] = 'keyword';
      if (row.use_regex === 1) {
        const triggers = triggerTexts(row.triggers);
        if (triggers.some((t) => matchKey(scanText, t))) {
          matched = true;
          matchType = 'regex';
        }
      } else {
        // 3. 关键词匹配（key 竖线分隔）
        const keys = row.key ? row.key.split('|').filter(Boolean) : [];
        if (keys.some((k) => matchKey(scanText, k))) {
          matched = true;
          matchType = 'keyword';
        }
      }
      if (!matched) continue;
      stats.keywordMatched++;

      // 4. 概率门（v1.1 审查 §5.1 修复：读真实 probability/useProbability，替代硬编码 100）
      if (opts.useProbability !== false && row.constant !== 1 && row.useProbability === 1) {
        const prob = row.probability ?? 100;
        if (prob < 100 && rand() * 100 > prob) {
          stats.probabilityDropped++;
          continue;
        }
      }

      activated.push({
        id: row.id, uid: row.uid, comment: row.comment, content: row.content,
        constant: false, matchType, score: matchType === 'regex' ? 0.9 : 0.8, order: row.constant === 1 ? 0 : 1,
      });
    }

    const final = this.finalize(activated, opts.budgetTokens ?? 800);
    stats.tokens = final.reduce((acc, e) => acc + estimateTokens(e.content), 0);
    return { activated: final, injectedBlock: this.renderBlock(final), stats };
  }

  /** 排序（常量/副词条优先 + 原始顺序）后预算截断 */
  private finalize(activated: ActivatedEntry[], budget: number): ActivatedEntry[] {
    activated.sort((a, b) => a.order - b.order || a.id - b.id);
    const final: ActivatedEntry[] = [];
    let used = 0;
    for (const e of activated) {
      const cost = estimateTokens(e.content);
      if (used + cost > budget) {
        if (final.length === 0) {
          // 首条也超预算：截断内容保留关键信息
          const keep = Math.max(40, Math.floor((budget / Math.max(1, cost)) * e.content.length));
          final.push({ ...e, content: `${e.content.slice(0, keep)}…` });
          used = budget;
        }
        // 后续超限条目：跳过本条，继续尝试后续更小条目（v1.1 融合世界书：避免大条目饿死小规则）
        continue;
      }
      used += cost;
      final.push(e);
    }
    return final;
  }

  /** 在场实体（2-8 字连续段，去标点，限 6 个），用于语义融合实体重叠信号 */
  private activeEntitiesOf(text: string): Set<string> {
    return new Set(text.split(/[，。！？、,.!?\s]+/).filter((s) => s.length >= 2 && s.length <= 8).slice(0, 6));
  }

  /** L1 注入块渲染 */
  private renderBlock(entries: ActivatedEntry[]): string {
    if (entries.length === 0) return '';
    const lines = entries.map((e) => {
      const tag = e.constant ? '[恒定]' : `[${e.matchType}]`;
      return `${tag} ${e.comment}: ${e.content.slice(0, 200)}`;
    });
    return lines.join('\n');
  }
}
