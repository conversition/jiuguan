/**
 * core 包 - 世界书设定文本语义切分（RAG chunking 前置）
 *
 * 用途：把 parseLoreEntry 产出的「可检索设定文本」（settingText）切成 ~200-300 字窗口，
 * 供向量化入库（pgvector）时逐 chunk 建立向量。相邻窗口做重叠（overlap）弱化上下文断裂。
 *
 * 设计要点（泛用、与具体文档语言解耦）：
 *   ① 按段落(空行)→句子(。！？；换行) 粗切，贪心合并成 ≤maxLen 的窗口；
 *   ② 相邻窗口保留 overlap 字重叠，避免主题在窗口边界被切断；
 *   ③ 仅对 settingText（剥离 EJS/注释后的可读设定）切分——MVU/EJS 变量逻辑由
 *      parseLoreEntry.variableRules 在条目级保留并带出，不参与向量切分（用户要求「代码不能丢」）。
 *   ④ 纯函数、无副作用，可单测；语言中立（中文/英文/混合均可按字符数工作）。
 */
import type { ParsedLoreEntry } from './lore-parse.ts';

/** 单个切分窗口 */
export interface LoreChunk {
  /** 所属条目 id（回溯原条目） */
  loreId: number;
  /** 窗口序号（0 起） */
  seq: number;
  /** 切分文本 */
  text: string;
  /** 在 settingText 中的起始偏移 */
  start: number;
}

/** 切分默认参数 */
export interface ChunkOptions {
  /** 单窗口目标最大字符数（默认 240） */
  maxLen?: number;
  /** 相邻窗口重叠字符数（默认 64） */
  overlap?: number;
  /** 最小有效窗口字符数（小于则并入前一窗口；默认 16） */
  minChunk?: number;
}

/** 句子分隔正则（中文句读 + 换行 + 英文句点/问叹 + 分号）——用于逐字符切句 */
const SENT_SPLIT = /[。！？!?；;\n]/;

/**
 * 对设定文本做语义窗口切分。
 * 返回多个窗口串；文本不足 minChunk×2 则整体返回单窗口。
 */
export function chunkSettingText(settingText: string, opts: ChunkOptions = {}): string[] {
  const maxLen = opts.maxLen ?? 240;
  const overlap = opts.overlap ?? 64;
  const minChunk = opts.minChunk ?? 16;
  const text = (settingText ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen || text.length < minChunk * 2) {
    return text ? [text] : [];
  }

  // 逐字符切句（保留分隔符在句尾）
  const units: string[] = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (SENT_SPLIT.test(ch) && cur.trim().length > 0) { units.push(cur.trim()); cur = ''; }
  }
  if (cur.trim().length > 0) units.push(cur.trim());

  const chunks: string[] = [];
  let buf = '';

  const flush = (s: string) => {
    const t = s.trim();
    if (t.length >= minChunk || chunks.length === 0) chunks.push(t);
    else if (chunks.length > 0) chunks[chunks.length - 1] += ' ' + t;
  };

  for (const u of units) {
    // 超长单元（无标点长段）：按 maxLen 硬切
    if (u.length > maxLen) {
      if (buf.trim()) flush(buf);
      buf = '';
      for (let i = 0; i < u.length; i += maxLen - overlap) {
        const piece = u.slice(i, i + maxLen).trim();
        if (piece) flush(piece);
      }
      continue;
    }
    if (buf.length + u.length > maxLen && buf.trim()) {
      // 保留重叠：从 buf 尾部取 overlap 字作为下一窗口起点
      const keep = buf.slice(Math.max(0, buf.length - overlap));
      flush(buf);
      buf = keep + ' ' + u.trim();
    } else {
      buf = buf ? buf + ' ' + u.trim() : u.trim();
    }
  }
  if (buf.trim()) flush(buf);
  return chunks.filter(Boolean);
}

/**
 * 对解析后的条目做切分，返回带条目 id / 序号 / 偏移的窗口。
 * MVU/EJS 变量规则不在本层切分（由调用方按条目带出）。
 */
export function chunkLoreEntry(p: ParsedLoreEntry, opts: ChunkOptions = {}): LoreChunk[] {
  const texts = chunkSettingText(p.settingText, opts);
  let offset = 0;
  return texts.map((text, i) => {
    const start = p.settingText.indexOf(text.slice(0, 12), offset);
    const s = start >= 0 ? start : offset;
    offset = s + text.length;
    return { loreId: p.id, seq: i, text, start: s };
  });
}
