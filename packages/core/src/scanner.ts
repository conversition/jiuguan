/**
 * core 包 - 世界书扫描器（激活引擎，复刻酒馆 world-info 语义）
 * 依据 v2 07 §3 ①c / 审查 ADR 8：关键词匹配 + 正则触发器 + 概率门 + 深度扫描 + 常量恒激活。
 * 输入：lorebook_entry 表数据 + 当前文本（+ 历史消息）
 * 输出：激活条目 → L1 静态设定注入块（含预算截断）
 */
import { MemoryDb } from '../../memory/src/db.ts';
import { estimateTokens } from '../../prompt/src/assembly.ts';

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
  matchType: 'constant' | 'keyword' | 'regex';
  score: number;
  order: number;
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
  constructor(private mem: MemoryDb) {}

  /** 主入口：扫描并激活条目 */
  scan(opts: ScanOptions): ScanResult {
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

    // 5. 排序（常量优先 + 原始顺序）后预算截断（首条超预算时截断内容而非整条塞入；后续超限条目跳过，小条目仍可保留）
    activated.sort((a, b) => a.order - b.order || a.id - b.id);
    const budget = opts.budgetTokens ?? 800;
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
    stats.tokens = used;

    return { activated: final, injectedBlock: this.renderBlock(final), stats };
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
