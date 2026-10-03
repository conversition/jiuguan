/**
 * 世界书 ⇄ TavernHelper 形状桥接（FE-02）
 *
 * 卡（示例卡 开场页）按 **TavernHelper 形状**使用世界书：
 *   uid（稳定标识，回写靠它匹配）/ name（= ST 的 comment）/ key（关键词数组）/ content / enabled
 * 磁盘上的世界书文件是 **ST v1.12 原生形状**：
 *   id / comment / keys / enabled / constant / position / extensions ...
 *
 * 两者字段名不同，且文件条目**通常没有 uid**。若不归一化：
 *   - `e.name.includes('[initvar]')` 找不到条目（卡查的是 name，不是 comment）
 *   - uid 全为空串 → updateWorldbookWith 的按 uid 差异比对会把所有条目判为同一行
 * 因此读时归一化、写时按 uid 回填到**原始条目对象**（保留未知字段，不做整体重写）。
 */

/** TavernHelper 形状的世界书条目（卡可见的最小契约 + 透传字段） */
export interface TavernHelperEntry {
  uid: string;
  name: string;
  key: string[];
  content: string;
  enabled: boolean;
  [k: string]: unknown;
}

/** 仅返回可用于持久化写入的原生 uid/id；没有稳定标识时返回 null。 */
export function stableEntryUid(raw: Record<string, unknown>): string | null {
  const u = raw.uid ?? raw.id;
  return u === undefined || u === null || u === '' ? null : String(u);
}

/** 条目展示 uid：优先原生 uid，其次 id，最后按序退化（只用于只读/前端兼容）。 */
export function entryUid(raw: Record<string, unknown>, index: number): string {
  return stableEntryUid(raw) ?? `idx-${index}`;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** 提取文件里的条目数组（兼容 array / record 两种 entries 形态） */
export function rawEntriesOf(parsed: unknown): { entries: Record<string, unknown>[]; container: Record<string, unknown> | null } {
  if (!parsed || typeof parsed !== 'object') return { entries: [], container: null };
  const obj = parsed as Record<string, unknown>;
  const src = obj.entries;
  if (Array.isArray(src)) return { entries: src.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object'), container: null };
  if (src && typeof src === 'object') {
    const rec = src as Record<string, unknown>;
    return { entries: Object.values(rec).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object'), container: rec };
  }
  // 有些文件把条目直接放在 originalData.entries
  const od = obj.originalData;
  if (od && typeof od === 'object') return rawEntriesOf(od);
  return { entries: [], container: null };
}

/** 磁盘条目 → TavernHelper 形状 */
export function toTavernHelperEntry(raw: Record<string, unknown>, index: number): TavernHelperEntry {
  const enabled = raw.enabled !== undefined ? raw.enabled !== false : raw.disable !== true;
  return {
    uid: entryUid(raw, index),
    name: String(raw.name ?? raw.comment ?? ''),
    key: asStringArray(raw.key ?? raw.keys),
    content: String(raw.content ?? ''),
    enabled,
    // 透传字段（卡与宿主调试可能用到）
    constant: Boolean(raw.constant),
    selective: Boolean(raw.selective),
    position: raw.position ?? 0,
    depth: raw.depth ?? 0,
    use_regex: Boolean(raw.use_regex),
    triggers: raw.triggers ?? [],
  };
}

/** 把 TavernHelper 形状的变更条目回填进原始文件对象（按 uid 匹配，保留未知字段） */
export function applyChangedEntries(
  fileObj: Record<string, unknown>,
  changed: TavernHelperEntry[],
): { applied: number; missed: string[] } {
  const { entries } = rawEntriesOf(fileObj);
  const byUid = new Map<string, Record<string, unknown>>();
  entries.forEach((e, i) => byUid.set(entryUid(e, i), e));
  let applied = 0;
  const missed: string[] = [];
  for (const c of changed) {
    const target = byUid.get(String(c.uid));
    if (!target) { missed.push(String(c.uid)); continue; }
    if (typeof c.name === 'string') target.comment = c.name;
    if (typeof c.content === 'string') target.content = c.content;
    if (Array.isArray(c.key)) {
      // 原文件用 keys 还是 key，按原字段名写回，避免引入双份字段
      if (target.keys !== undefined || target.key === undefined) target.keys = c.key;
      else target.key = c.key;
    }
    if (typeof c.enabled === 'boolean') {
      if (target.enabled !== undefined || target.disable === undefined) target.enabled = c.enabled;
      else target.disable = !c.enabled;
    }
    applied++;
  }
  return { applied, missed };
}
