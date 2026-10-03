/**
 * prompt 包 - 关键锚点检测器（KeyAnchorDetector）
 * 在滑动窗口/滚动摘要压缩前，识别「不可丢弃」的信息（实体首次出现 / 情感突变 / 目标声明 / 世界书触发点），
 * 即使窗口滑过也不丢，作为上下文压缩的前置预处理。规则 + 轻量信号驱动，不依赖每次调用 LLM。
 *
 * 与 0.7.0「关键锚点上下文压缩」方向对齐：锚点并入长期摘要/记忆，缓解长对话信息丢失。
 */
import type { Message } from './assembly.ts';

/** 锚点类型 */
export type AnchorType = 'entity' | 'emotion' | 'goal' | 'worldbook';

export interface KeyAnchor {
  type: AnchorType;
  /** 锚点对应文本片段 */
  text: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 所在回合（-1=未知） */
  round: number;
  /** 附加信息（如情感前后值 / 世界书条目 id） */
  metadata?: Record<string, unknown>;
}

export interface AnchorDetectorOptions {
  /** 实体最短长度（默认 2） */
  entityMinLength?: number;
  /** 情感突变阈值（0~1，跨轮情感绝对值差超过才记为锚点，默认 0.6） */
  emotionChangeThreshold?: number;
  /** 目标/承诺声明的正则模式（默认捕获 我要/我想/我答应/我发誓 等） */
  goalPatterns?: RegExp[];
  /** 每轮最多保留锚点数（防爆量） */
  maxAnchorsPerRound?: number;
  /** 情感词典：情感词 -> 强度(-1~1) */
  emotionLexicon?: Map<string, number>;
}

/** 情感词 → 强度（基础词典，可扩展/替换） */
const DEFAULT_EMOTION_LEXICON: Record<string, number> = {
  愤怒: -0.8, 怒: -0.7, 生气: -0.6,
  开心: 0.7, 高兴: 0.7, 笑: 0.4, 愉悦: 0.6,
  悲伤: -0.6, 哭: -0.6, 难过: -0.6, 泪: -0.5,
  惊讶: 0.4, 震惊: 0.5,
  恐惧: -0.7, 害怕: -0.6, 颤抖: -0.5,
  温柔: 0.4,
};

/** 默认停用词（实体提取时过滤） */
const DEFAULT_STOPWORDS = new Set([
  '我们', '你们', '他们', '它们', '这个', '那个', '什么', '怎么', '可以', '现在',
  '还是', '没有', '就是', '不是', '知道', '自己', '一个', '已经', '因为', '所以',
]);

const DEFAULT_GOAL_PATTERNS: RegExp[] = [
  /我(?:要|想|打算|决定|一定|必须)去?.{0,12}/,   // 我要去旧校舍
  /我(?:要|想|打算|决定|一定|必须)(?:调查|找到|找到|拿到|得到|救|查|问).{0,12}/,
  /(?:答应|向.{0,3}保证|发誓).{0,12}/,           // 答应她 / 向你保证
  /目标是.{0,16}/,
];

export class KeyAnchorDetector {
  private knownEntities = new Set<string>();
  private prevEmotion: number[] = [];
  private opts: Required<AnchorDetectorOptions>;
  private stopwords = DEFAULT_STOPWORDS;

  constructor(opts: AnchorDetectorOptions = {}) {
    const lexicon = new Map<string, number>(Object.entries(DEFAULT_EMOTION_LEXICON));
    if (opts.emotionLexicon) for (const [k, v] of opts.emotionLexicon) lexicon.set(k, v);
    this.opts = {
      entityMinLength: opts.entityMinLength ?? 2,
      emotionChangeThreshold: opts.emotionChangeThreshold ?? 0.6,
      goalPatterns: opts.goalPatterns ?? DEFAULT_GOAL_PATTERNS,
      maxAnchorsPerRound: opts.maxAnchorsPerRound ?? 6,
      emotionLexicon: lexicon,
    };
  }

  /**
   * 对消息序列检测锚点（消息按时间正序）。内部维护跨轮状态（已知实体集、上一轮情感）。
   * @param messages 消息（role/content/round），内容已去除 XML 标签
   * @param worldbookTriggers 可选：本轮已激活世界书条目 {entryId, snippet}
   */
  detect(messages: Array<Pick<Message, 'role' | 'content'> & { round: number }>, worldbookTriggers?: { entryId: number | string; snippet: string }[]): KeyAnchor[] {
    const anchors: KeyAnchor[] = [];
    for (const msg of messages) {
      const text = this.clean(msg.content);
      if (!text) continue;

      // 1. 实体首次出现
      for (const ent of this.extractEntities(text)) {
        if (this.knownEntities.has(ent)) continue;
        this.knownEntities.add(ent);
        anchors.push({ type: 'entity', text: ent, confidence: 0.9, round: msg.round, metadata: { isNew: true } });
      }

      // 2. 情感突变：跨轮情感值差分超过阈值
      const cur = this.calculateEmotion(text);
      const prev = this.prevEmotion.length > 0 ? this.prevEmotion[this.prevEmotion.length - 1] : 0;
      if (this.prevEmotion.length > 0 && Math.abs(cur - prev) > this.opts.emotionChangeThreshold) {
        anchors.push({ type: 'emotion', text: text.slice(0, 40), confidence: 0.7, round: msg.round, metadata: { from: prev, to: cur } });
      }
      this.prevEmotion.push(cur);
      if (this.prevEmotion.length > 4) this.prevEmotion.shift();

      // 3. 目标/承诺声明
      for (const pattern of this.opts.goalPatterns) {
        const m = text.match(pattern);
        if (m) {
          anchors.push({ type: 'goal', text: m[0].slice(0, 20), confidence: 0.85, round: msg.round });
          break;
        }
      }

      // 4. 世界书触发点
      if (worldbookTriggers) {
        for (const t of worldbookTriggers) {
          anchors.push({ type: 'worldbook', text: t.snippet.slice(0, 40), confidence: 0.95, round: msg.round, metadata: { entryId: t.entryId } });
        }
      }
    }
    return this.dedupe(anchors).slice(0, this.opts.maxAnchorsPerRound * Math.max(1, messages.length));
  }

  /** 断言：这些锚点是否含某类型、含某文本片段（测试便捷） */
  hasType(anchors: KeyAnchor[], type: AnchorType, fragment = ''): boolean {
    return anchors.some((a) => a.type === type && (!fragment || a.text.includes(fragment)));
  }

  /** 提取实体候选：先按标点/分句符切分，每分句取句首纯中文 run——
   *  ≤4 字保留整段（独立姓名/名，如「角色甲」「教师甲」），>4 字取前 2 字（嵌在动词后时仍能锚到名前缀，如「角色甲又见到…」→「角色甲」）。
   *  已知实体精确匹配去重交由 detect() 的 knownEntities 完成，故同名不同谓语语境只记首次。 */
  private extractEntities(text: string): string[] {
    const out: string[] = [];
    const clauses = text.split(/[，。！？、,.;；：!?\s]+/);
    for (const clause of clauses) {
      if (!clause) continue;
      const zh = clause.match(/^[一-龿]+/);
      if (zh) {
        const run = zh[0];
        out.push(run.length <= 4 ? run : run.slice(0, 2));
        continue;
      }
      const en = clause.match(/^[a-zA-Z]{3,20}/);
      if (en) out.push(en[0].split(/\s/)[0]);
    }
    return out.filter((t) => !this.stopwords.has(t));
  }

  /** 简易情感评分：Σ 情感词强度 → tanh 归一化到 (-1,1) */
  private calculateEmotion(text: string): number {
    let s = 0;
    for (const [word, v] of this.opts.emotionLexicon) {
      if (text.includes(word)) s += v;
    }
    return Math.tanh(s);
  }

  /** 清理 XML 标签与常见标记 */
  private clean(content: string): string {
    return (content ?? '').replace(/<[^>]{0,60}>/g, ' ').replace(/<|>/g, ' ');
  }

  /** 去重（type+text）并按置信度降序、回合正序 */
  private dedupe(anchors: KeyAnchor[]): KeyAnchor[] {
    const seen = new Set<string>();
    return anchors
      .filter((a) => { const k = `${a.type}:${a.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.round - b.round || b.confidence - a.confidence);
  }
}
