/**
 * prompt 包 - 关键锚点检测器（KeyAnchorDetector）
 * 在滑动窗口/滚动摘要压缩前，识别「不可丢弃」的信息（实体首次出现 / 情感突变 / 目标声明 / 世界书触发点），
 * 即使窗口滑过也不丢，作为上下文压缩的前置预处理。规则 + 轻量信号驱动，不依赖每次调用 LLM。
 *
 * 与 0.7.0「关键锚点上下文压缩」方向对齐：锚点并入长期摘要/记忆，缓解长对话信息丢失。
 */
import { estimateTokens, type Message } from './assembly.ts';

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

export const ROLLING_SUMMARY_SYSTEM_PROMPT = '你是剧情记忆压缩器，只输出摘要正文，禁止解释、禁止输出对话。';
export const ROLLING_SUMMARY_INPUT_LIMIT_TOKENS = 12_000;
export const ROLLING_SUMMARY_OUTPUT_RESERVE_TOKENS = 700;
export const ROLLING_SUMMARY_REQUEST_GUARD_TOKENS = 128;
export const ROLLING_SUMMARY_SOURCE_MAX_CHARS = 4_000;
export const ROLLING_SUMMARY_SOURCE_MAX_TOKENS = 6_000;
export const ROLLING_SUMMARY_ANCHOR_MAX_CHARS = 1_800;
export const ROLLING_SUMMARY_ANCHOR_MAX_TOKENS = 2_500;
export const ROLLING_SUMMARY_OLD_LONG_MAX_TOKENS = 1_500;

const ROLLING_SUMMARY_INTRO = '以下是从对话窗口中滑出的近期剧情（按时间正序）：';
const ROLLING_SUMMARY_INSTRUCTION = '请输出合并去重后的新长期摘要，聚焦：角色关系、当前处境与目标、关键事件、未解决伏笔、已获物品/技能。要求：正文 ≤500 字，不含任何 XML/标签；若上面给出「不可丢弃锚点」，必须确保其中的实体关系、目标与关键事件被纳入摘要。';
const ANCHOR_LABEL: Readonly<Record<AnchorType, string>> = Object.freeze({
  entity: '实体',
  emotion: '情感变化',
  goal: '目标声明',
  worldbook: '世界书触发',
});

export interface RollingSummarySourceRow {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly round: number;
  /** 同轮消息稳定排序；未提供时沿用输入顺序。 */
  readonly sequence?: number;
}

export interface KeyAnchorBlockPlan {
  readonly block: string;
  /** 按“近期优先、同轮高置信优先”的最终顺序。 */
  readonly anchors: readonly KeyAnchor[];
  readonly chars: number;
  readonly tokens: number;
}

export interface RollingSummaryPromptPlan {
  readonly prompt: string;
  readonly sourceLines: readonly string[];
  /**
   * CX-3：本次提示**真正覆盖**的轮次区间（含端点）。它由入选行反推，
   * 不是「批次边界」——watermark 只能推进到 `coveredToRound`（再按整轮裁剪），
   * 否则被字符预算挤掉的那些轮会被静默跳过，形成历史空洞。
   */
  readonly coveredFromRound: number;
  readonly coveredToRound: number;
  readonly anchorBlock: string;
  readonly selectedAnchorCount: number;
  readonly estimatedRequestInputTokens: number;
  /** 比 Gateway 的 12K 输入上限更严格：额外预留输出契约和估算误差。 */
  readonly requestTargetTokens: number;
}

function normalizedAnchorText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 40);
}

function anchorKey(anchor: KeyAnchor): string {
  return `${anchor.type}:${normalizedAnchorText(anchor.text).toLocaleLowerCase()}`;
}

/**
 * 与 AdmittedModelGateway 的 message 估算口径一致。当前摘要请求无 tools，
 * 因此只需计 system/user 内容及两个 role 字段。
 */
export function estimateRollingSummaryRequestInputTokens(prompt: string): number {
  return estimateTokens(ROLLING_SUMMARY_SYSTEM_PROMPT)
    + estimateTokens('system')
    + estimateTokens(prompt)
    + estimateTokens('user');
}

/** 有界轮次退避：1, 2, 4, 8, 8...；永远给出有限的下一次重试轮次。 */
/**
 * CX-3：滚动摘要 watermark 的推进规则（纯函数，便于离线验收）。
 *
 * 三个约束缺一不可：
 * 1. 只能推进到**本次提示真正覆盖**的轮次（`coveredToRound`），不能按批次边界算——
 *    被字符预算挤掉的轮会因此变成历史空洞；
 * 2. 不能越过 `windowStartRound - 1`：窗口里的轮次还没滑出，压缩它们属于重复消耗；
 * 3. 末轮若只有 user 没有 assistant（失败轮/孤儿行），只能停在**末轮之前**，
 *    否则那条回复会被下一个批次永远跳过。
 *
 * 返回 null = 没有可推进的位置；调用方应 defer（失败不前移 watermark，重试从同一起点恢复）。
 */
export function rollingSummaryWatermark(input: {
  readonly coveredToRound: number;
  readonly windowStartRound: number;
  readonly expectedSummaryRound: number;
  readonly tailRoundComplete: boolean;
}): number | null {
  let candidate = Math.min(input.coveredToRound, input.windowStartRound - 1);
  if (!input.tailRoundComplete) candidate = Math.min(candidate, input.coveredToRound - 1);
  if (!Number.isSafeInteger(candidate) || candidate <= input.expectedSummaryRound) return null;
  return candidate;
}

export function rollingSummaryRetryDelayRounds(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 1) return 1;
  return Math.min(8, 2 ** Math.min(3, Math.floor(consecutiveFailures) - 1));
}

/** 在字符和 token 双预算内裁剪；保留首尾，避免长消息只留下开场而丢失结论。 */
function fitText(text: string, maxChars: number, maxTokens: number): string {
  const clean = text.trim();
  if (!clean || maxChars <= 0 || maxTokens <= 0) return '';
  if (clean.length <= maxChars && estimateTokens(clean) <= maxTokens) return clean;
  const marker = '…[中段已裁剪]…';
  let low = 1;
  let high = Math.max(1, Math.min(clean.length, maxChars) - marker.length);
  let best = '';
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const head = Math.ceil(kept * 0.7);
    const tail = kept - head;
    const candidate = `${clean.slice(0, head)}${marker}${tail > 0 ? clean.slice(-tail) : ''}`;
    if (candidate.length <= maxChars && estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

/**
 * 先按近期优先去重，再受确定性的总字符/token/条数三重上限约束。
 * 输出顺序本身也是近期优先，使前部信息不会在下游意外截断时反转优先级。
 */
export function buildKeyAnchorBlock(
  input: readonly KeyAnchor[],
  opts: { maxChars?: number; maxTokens?: number; maxAnchors?: number } = {},
): KeyAnchorBlockPlan {
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? ROLLING_SUMMARY_ANCHOR_MAX_CHARS));
  const maxTokens = Math.max(0, Math.floor(opts.maxTokens ?? ROLLING_SUMMARY_ANCHOR_MAX_TOKENS));
  const maxAnchors = Math.max(0, Math.floor(opts.maxAnchors ?? 64));
  if (maxChars === 0 || maxTokens === 0 || maxAnchors === 0) {
    return Object.freeze({ block: '', anchors: Object.freeze([]), chars: 0, tokens: 0 });
  }

  const seen = new Set<string>();
  const recent = input
    .map((anchor, index) => ({ anchor, index }))
    .sort((left, right) => right.anchor.round - left.anchor.round
      || right.anchor.confidence - left.anchor.confidence
      || right.index - left.index)
    .filter(({ anchor }) => {
      const key = anchorKey(anchor);
      if (!normalizedAnchorText(anchor.text) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const selected: KeyAnchor[] = [];
  const lines: string[] = [];
  for (const { anchor } of recent) {
    if (selected.length >= maxAnchors) break;
    const text = normalizedAnchorText(anchor.text);
    const round = anchor.round >= 0 ? ` R${anchor.round}` : '';
    const line = `- [${ANCHOR_LABEL[anchor.type]}${round}] ${text}`;
    const candidate = `<不可丢弃锚点>\n${[...lines, line].join('\n')}\n</不可丢弃锚点>`;
    if (candidate.length > maxChars || estimateTokens(candidate) > maxTokens) continue;
    selected.push({ ...anchor, text });
    lines.push(line);
  }
  const block = lines.length > 0 ? `<不可丢弃锚点>\n${lines.join('\n')}\n</不可丢弃锚点>` : '';
  return Object.freeze({
    block,
    anchors: Object.freeze(selected),
    chars: block.length,
    tokens: estimateTokens(block),
  });
}

function renderRollingSummaryPrompt(sourceLines: readonly string[], anchorBlock: string, oldLong: string): string {
  return [
    ROLLING_SUMMARY_INTRO,
    sourceLines.join('\n'),
    anchorBlock,
    oldLong ? `旧的长期摘要：\n${oldLong}` : '',
    ROLLING_SUMMARY_INSTRUCTION,
  ].filter(Boolean).join('\n\n');
}

/** 内部条目：文本 + 来源轮次。轮次必须跟着行走，否则无法推导覆盖区间。 */
interface SelectedSourceLine { readonly text: string; readonly round: number }

function selectRecentSourceLines(rows: readonly RollingSummarySourceRow[]): SelectedSourceLine[] {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.content.trim().length > 0)
    .sort((left, right) => left.row.round - right.row.round
      || (left.row.sequence ?? left.index) - (right.row.sequence ?? right.index));
  const selected: SelectedSourceLine[] = [];
  let chars = 0;
  let tokens = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const { row } = ordered[i];
    const prefix = row.role === 'user' ? '玩家' : '角色';
    const availableChars = ROLLING_SUMMARY_SOURCE_MAX_CHARS - chars;
    const availableTokens = ROLLING_SUMMARY_SOURCE_MAX_TOKENS - tokens;
    if (availableChars <= prefix.length + 2 || availableTokens <= estimateTokens(`${prefix}: `)) break;
    const content = fitText(
      row.content,
      availableChars - prefix.length - 2,
      availableTokens - estimateTokens(`${prefix}: `),
    );
    if (!content) break;
    const line = `${prefix}: ${content}`;
    selected.unshift({ text: line, round: row.round });
    chars += line.length;
    tokens += estimateTokens(line);
  }
  return selected;
}

/**
 * 从任意规模历史生成一次可发送的摘要请求。所有裁剪在签票/网络调用前完成，
 * 最终以与 Gateway 同源的 estimateTokens 再验证，而不是依赖字符数猜测。
 */
export function planRollingSummaryPrompt(
  rows: readonly RollingSummarySourceRow[],
  oldLong: string,
  opts: {
    inputLimitTokens?: number;
    outputReserveTokens?: number;
    requestGuardTokens?: number;
  } = {},
): RollingSummaryPromptPlan | null {
  if (rows.length === 0) return null;
  const inputLimit = Math.max(1, Math.floor(opts.inputLimitTokens ?? ROLLING_SUMMARY_INPUT_LIMIT_TOKENS));
  const outputReserve = Math.max(0, Math.floor(opts.outputReserveTokens ?? ROLLING_SUMMARY_OUTPUT_RESERVE_TOKENS));
  const guard = Math.max(0, Math.floor(opts.requestGuardTokens ?? ROLLING_SUMMARY_REQUEST_GUARD_TOKENS));
  const requestTargetTokens = inputLimit - outputReserve - guard;
  if (requestTargetTokens <= estimateRollingSummaryRequestInputTokens(ROLLING_SUMMARY_INSTRUCTION)) return null;

  const chronological = rows
    .map((row, index) => ({ ...row, sequence: row.sequence ?? index }))
    .sort((left, right) => left.round - right.round || left.sequence - right.sequence);
  const detector = new KeyAnchorDetector();
  const detected = detector.detect(chronological);
  let anchorPlan = buildKeyAnchorBlock(detected);
  let entries = selectRecentSourceLines(chronological);
  let compactOldLong = fitText(oldLong, oldLong.length, ROLLING_SUMMARY_OLD_LONG_MAX_TOKENS);
  if (entries.length === 0) return null;
  let sourceLines = entries.map((entry) => entry.text);

  let prompt = renderRollingSummaryPrompt(sourceLines, anchorPlan.block, compactOldLong);
  let estimated = estimateRollingSummaryRequestInputTokens(prompt);
  let guardIterations = 0;
  while (estimated > requestTargetTokens && guardIterations < 4_096) {
    guardIterations += 1;
    if (entries.length > 1) {
      // 从最旧的一行开始丢：丢行时 entries 与 sourceLines 必须同步，否则覆盖区间会撒谎。
      entries = entries.slice(1);
      sourceLines = entries.map((entry) => entry.text);
    } else if (anchorPlan.anchors.length > 0) {
      anchorPlan = buildKeyAnchorBlock(anchorPlan.anchors.slice(0, -1));
    } else if (estimateTokens(compactOldLong) > 200) {
      compactOldLong = fitText(
        compactOldLong,
        compactOldLong.length,
        Math.max(200, Math.floor(estimateTokens(compactOldLong) * 0.8)),
      );
    } else {
      const only = sourceLines[0] ?? '';
      const reduced = fitText(only, only.length, Math.max(80, Math.floor(estimateTokens(only) * 0.8)));
      if (!reduced || reduced === only) return null;
      sourceLines = [reduced];
      entries = [{ text: reduced, round: entries[0]!.round }];
    }
    prompt = renderRollingSummaryPrompt(sourceLines, anchorPlan.block, compactOldLong);
    estimated = estimateRollingSummaryRequestInputTokens(prompt);
  }
  if (estimated > requestTargetTokens || estimated > inputLimit) return null;
  return Object.freeze({
    prompt,
    sourceLines: Object.freeze([...sourceLines]),
    coveredFromRound: entries[0]!.round,
    coveredToRound: entries[entries.length - 1]!.round,
    anchorBlock: anchorPlan.block,
    selectedAnchorCount: anchorPlan.anchors.length,
    estimatedRequestInputTokens: estimated,
    requestTargetTokens,
  });
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
   *  ≤4 字保留整段（独立姓名/名，如「白川真昼」「藤原主任」），>4 字取前 2 字（嵌在动词后时仍能锚到名前缀，如「示例角色B又见到…」→「示例角色B」）。
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

  /** 去重（type+text）并保留最近一次，再按回合倒序、置信度倒序输出。 */
  private dedupe(anchors: KeyAnchor[]): KeyAnchor[] {
    const newest = new Map<string, { anchor: KeyAnchor; index: number }>();
    anchors.forEach((anchor, index) => {
      const key = anchorKey(anchor);
      const previous = newest.get(key);
      if (!previous || anchor.round > previous.anchor.round
        || (anchor.round === previous.anchor.round && index > previous.index)) {
        newest.set(key, { anchor, index });
      }
    });
    return [...newest.values()]
      .sort((left, right) => right.anchor.round - left.anchor.round
        || right.anchor.confidence - left.anchor.confidence
        || right.index - left.index)
      .map(({ anchor }) => anchor);
  }
}
