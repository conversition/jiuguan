/**
 * core 包 - 世界书解析器
 * 依据审查 §7：处理双层格式（顶层 entries 旧格式字符串 + originalData.entries v1.12 格式），合并去重。
 * 同时提供条目 → 记忆服务 lorebook_entry 表的映射。
 */
import { z } from 'zod';
import { WorldInfoEntrySchema } from './chara.ts';
import type { WorldInfoEntry } from './chara.ts';

/** 世界书文件结构（酒馆导出格式） */
export const WorldBookSchema = z.object({
  entries: z.union([z.array(WorldInfoEntrySchema), z.record(WorldInfoEntrySchema)]).optional(),
  originalData: z.object({
    entries: z.union([z.array(WorldInfoEntrySchema), z.record(WorldInfoEntrySchema)]).optional(),
  }).passthrough().optional(),
}).passthrough();

export type WorldBook = z.infer<typeof WorldBookSchema>;

export interface ParsedWorldBook {
  entries: WorldInfoEntry[];
  /** 去重统计 */
  stats: { total: number; merged: number; duplicates: number };
  warnings: string[];
}

/** 将 entries（数组或数字键对象）规整为数组 */
function normalizeEntries(entries: unknown): WorldInfoEntry[] {
  if (Array.isArray(entries)) return entries as WorldInfoEntry[];
  if (entries && typeof entries === 'object') {
    // 数字键对象（酒馆导出格式：{"0": {...}, "1": {...}}）
    return Object.values(entries as Record<string, unknown>) as WorldInfoEntry[];
  }
  return [];
}

/** 解析世界书 JSON（双层格式合并去重：按 uid + comment 判重） */
export function parseWorldBook(json: string): ParsedWorldBook {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`世界书 JSON 解析失败: ${(e as Error).message}`);
  }

  const parsed = WorldBookSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`世界书 schema 校验失败: ${issues.join('; ')}`);
  }

  const topEntries = normalizeEntries(parsed.data.entries);
  const originalEntries = normalizeEntries(parsed.data.originalData?.entries);

  // 顶层 entries 若是旧格式字符串数组（无 content），以 originalData 为准
  const topHasRealContent = topEntries.some((e) => typeof e.content === 'string' && e.content.length > 0);
  const merged = new Map<string, WorldInfoEntry>();
  const keyOf = (e: WorldInfoEntry): string => `${e.uid ?? ''}|${e.comment ?? ''}|${e.key?.[0] ?? ''}`;

  const add = (e: WorldInfoEntry, source: string) => {
    const k = keyOf(e);
    if (merged.has(k)) return;
    // 校验单个条目
    const check = WorldInfoEntrySchema.safeParse(e);
    if (!check.success) {
      warnings.push(`条目跳过（校验失败）: ${k} ${check.error.issues[0]?.message}`);
      return;
    }
    merged.set(k, check.data);
  };

  // 顶层有真实内容 → 以顶层为准（ST 语义：顶层是权威编辑层，originalData 是导入快照，避免双层重复入库）；
  // 顶层为旧格式（无 content）→ 以 originalData.entries 为准
  if (topHasRealContent) {
    for (const e of topEntries) add(e, 'top');
  } else {
    for (const e of originalEntries) add(e, 'original');
  }

  const total = merged.size;
  const duplicates = (topHasRealContent ? topEntries.length : 0) + originalEntries.length - total;
  if (!topHasRealContent && originalEntries.length === 0 && topEntries.length === 0) {
    warnings.push('世界书为空（无任何条目）');
  }
  if (!topHasRealContent && originalEntries.length > 0) {
    warnings.push('顶层 entries 为旧格式（无内容），已以 originalData.entries 为准');
  }

  return {
    entries: [...merged.values()],
    stats: { total, merged: total, duplicates: Math.max(0, duplicates) },
    warnings,
  };
}

/** 条目 → 记忆服务 lorebook_entry 表行 */
export function entryToLorebookRow(e: WorldInfoEntry): {
  uid: string; book: string; key: string; comment: string;
  content: string; selective: number; depth: number; constant: number;
  use_regex: number; triggers: string; active: number;
  probability: number; useProbability: number;
} {
  return {
    uid: String(e.uid ?? ''),
    book: e.extensions?.book ?? '',
    key: (e.key ?? []).join('|'),
    comment: e.comment ?? '',
    content: e.content ?? '',
    selective: e.selective ? 1 : 0,
    depth: e.depth ?? 0,
    constant: e.constant ? 1 : 0,
    use_regex: e.use_regex ? 1 : 0,
    triggers: JSON.stringify(e.triggers ?? []),
    active: e.disable ? 0 : 1,
    // v1.1 审查 §5.1：概率门（酒馆 extensions.probability / useProbability）
    probability: Number(e.extensions?.probability ?? e.probability ?? 100),
    useProbability: Boolean(e.extensions?.useProbability ?? e.useProbability ?? false) ? 1 : 0,
  };
}

/** 卡片内嵌 character_book → lorebook 行数组 */
export function cardBookToLorebookRows(entries: WorldInfoEntry[], bookName: string): ReturnType<typeof entryToLorebookRow>[] {
  return entries.map((e) => ({ ...entryToLorebookRow(e), book: bookName }));
}
