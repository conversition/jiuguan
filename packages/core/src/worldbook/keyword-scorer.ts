/**
 * core 包 - 世界书关键词/正则评分（0~1）
 * 复用 scanner.ts 的 matchKey/parseRegexFromString/triggerTexts（复刻酒馆 world-info 语义），
 * 产出确定性 0~1 得分，供语义融合公式使用。
 * 语义：精确关键词/正则命中 → 强信号（保证激活的兜底）；部分重叠 → 弱信号。
 */
import type { SemanticEntry } from './types.ts';
import { parseRegexFromString } from '../scanner.ts';

/** 触发器数组解析（酒馆 triggers: [{key,text}] 或 [string]；从 scanner 复用） */
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

/** 关键词/正则/文本子串匹配（复刻 scanner.matchKey：正则优先，否则纯文本子串） */
function matchKey(haystack: string, needle: string): boolean {
  const re = parseRegexFromString(needle);
  if (re) return re.test(haystack);
  return haystack.includes(needle.trim());
}

/** 关键词/正则命中得分（0~1）：
 *   - use_regex 条目：任一正则触发器命中 → 0.9（正则弱于精确关键词）
 *   - 非正则条目：key 任一精确关键词命中 → 1.0；其余做部分重叠比例（弱信号，供语义融合参考）
 *   determinism：返回 0 表示无任何字面命中 */
export function scoreKeyword(entry: SemanticEntry, text: string): number {
  if (entry.useRegex) {
    const triggers = triggerTexts(entry.triggersJson);
    if (triggers.length > 0 && triggers.some((t) => matchKey(text, t))) return 0.9;
    return 0;
  }
  const keys = entry.keywords;
  if (keys.length === 0) return 0;
  // 精确命中优先（1.0）
  if (keys.some((k) => matchKey(text, k))) return 1.0;
  // 部分重叠比例（任一关键词部分出现在输入 → 弱分）作为关键字信号的补充，供评分可观测
  const covered = keys.filter((k) => text.includes(k.slice(0, 2))).length;
  return covered > 0 ? 0.3 * (covered / keys.length) : 0;
}

/** 是否存在确定性字面命中（语义融合中用于判定"是否已被原触发逻辑覆盖"） */
export function hasDeterministicHit(entry: SemanticEntry, text: string): boolean {
  if (entry.useRegex) {
    const triggers = triggerTexts(entry.triggersJson);
    return triggers.length > 0 && triggers.some((t) => matchKey(text, t));
  }
  return entry.keywords.some((k) => matchKey(text, k));
}
