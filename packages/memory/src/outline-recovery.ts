/**
 * AM 大纲恢复器。
 *
 * 它不是第二套记忆，也不调用 Provider：memory_arc 仍是唯一业务真值。
 * 恢复器把本轮通用 RAG 已命中的 arc/summary 与最近数轮剧情脊柱合并，
 * 再用有界词面相关性补齐“旧剧情被提起但尚未建立向量”的场景。
 */
import { MemoryDb } from './db.ts';
import type { RecallHit, RecallStructuredContext } from './retrieval.ts';

interface OutlineRow {
  id: number;
  code: string;
  chapter: string;
  title: string;
  summary: string;
  status: string;
  seq: number;
}

export interface OutlineRecoveryInput {
  currentRound: number;
  context: RecallStructuredContext;
  recallHits?: readonly RecallHit[];
  budgetTokens?: number;
  recentCount?: number;
  relevantCount?: number;
  /** 防止超长会话每轮无界全表扫描；显式 AM 码会另外直查补回。 */
  maxScanRows?: number;
}

export interface OutlineRecoveryResult {
  block: string;
  codes: readonly string[];
  recentCodes: readonly string[];
  recalledCodes: readonly string[];
  lexicalCodes: readonly string[];
  estimatedTokens: number;
  sourceRows: number;
}

type SelectionReason = 'recent' | 'recall' | 'lexical' | 'am-ref';

interface RankedRow {
  row: OutlineRow;
  reason: SelectionReason;
  score: number;
}

const EMPTY_RESULT: OutlineRecoveryResult = Object.freeze({
  block: '',
  codes: Object.freeze([]),
  recentCodes: Object.freeze([]),
  recalledCodes: Object.freeze([]),
  lexicalCodes: Object.freeze([]),
  estimatedTokens: 0,
  sourceRows: 0,
});

/** 与 prompt/context scheduler 相同的保守估算口径，避免 memory 反向依赖 prompt 包。 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) * 0.4);
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 只提取可解释的词面锚点；不把完整长摘要做全量 n-gram，以免常见二字词淹没实体名。
 */
function lexicalTerms(context: RecallStructuredContext): string[] {
  const weightedSources = [
    context.currentInput,
    ...(context.resolvedEntities ?? []),
    ...(context.sceneFacts ?? []),
    ...(context.recentDialogueHints ?? []).slice(-2),
    ...(context.memoryHints ?? []).slice(0, 1),
  ];
  const terms = new Set<string>();
  for (const source of weightedSources) {
    for (const raw of normalized(source).split(/[\s,，。！？、.!?;；:：()\[\]{}<>《》"“”'‘’|/\\]+/u)) {
      if (raw.length < 2) continue;
      // 实体/短语保持完整；长中文句只取 2~4 字滑窗并设总量上限。
      if (raw.length <= 12) terms.add(raw);
      if (/[\u3400-\u9fff]/u.test(raw)) {
        for (let width = 4; width >= 2 && terms.size < 72; width--) {
          for (let i = 0; i + width <= raw.length && terms.size < 72; i++) {
            terms.add(raw.slice(i, i + width));
          }
        }
      }
      if (terms.size >= 72) break;
    }
    if (terms.size >= 72) break;
  }
  return [...terms];
}

function amReferences(context: RecallStructuredContext): Set<string> {
  const joined = [
    context.currentInput,
    ...(context.recentDialogueHints ?? []),
    ...(context.memoryHints ?? []),
  ].join(' ');
  return new Set((joined.match(/\bAM\d+\b/giu) ?? []).map((code) => code.toUpperCase()));
}

function rowText(row: OutlineRow): string {
  return normalized(`${row.chapter} ${row.title} ${row.summary}`);
}

function lexicalScore(row: OutlineRow, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const haystack = rowText(row);
  let score = 0;
  let matches = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    // 完整实体/长词比常见二字片段更可靠。
    score += term.length >= 6 ? 8 : term.length >= 4 ? 4 : term.length === 3 ? 2 : 1;
    matches++;
    if (matches >= 12) break;
  }
  return score;
}

function safePositiveInt(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), max)
    : fallback;
}

function renderLine(candidate: RankedRow): string {
  const { row, reason } = candidate;
  const round = /^R\d+$/iu.test(row.title) ? row.title.toUpperCase() : row.title;
  const source = reason === 'am-ref' ? 'AM直引'
    : reason === 'recall' ? '语义/全文命中'
      : reason === 'lexical' ? '词面补召回'
        : '近期脊柱';
  const status = row.status && row.status !== 'active' ? `|${row.status}` : '';
  return `[${row.code}|${source}${status}|${round || `seq-${row.seq}`}] ${row.summary.trim()}`;
}

/**
 * 构造有界、可溯源的 AM 剧情骨架。
 *
 * 选择顺序：显式 AM 码 > 通用 RAG 已命中 > 词面相关旧大纲 > 最近剧情脊柱。
 * 最终渲染按 seq 升序，模型看到的是时间线而不是相似度乱序。
 */
export function buildOutlineRecovery(
  mem: MemoryDb,
  input: OutlineRecoveryInput,
): OutlineRecoveryResult {
  const budgetTokens = safePositiveInt(input.budgetTokens, 900, 4_000);
  const recentCount = safePositiveInt(input.recentCount, 4, 12);
  const relevantCount = safePositiveInt(input.relevantCount, 4, 12);
  const maxScanRows = safePositiveInt(input.maxScanRows, 5_000, 20_000);
  const rows = mem.db.prepare(
    `SELECT * FROM (
       SELECT id,code,COALESCE(chapter,'') AS chapter,COALESCE(title,'') AS title,
              COALESCE(summary,'') AS summary,COALESCE(status,'active') AS status,COALESCE(seq,id) AS seq
         FROM memory_arc
        WHERE COALESCE(summary,'') != ''
        ORDER BY seq DESC,id DESC LIMIT ?
     ) ORDER BY seq ASC,id ASC`,
  ).all(maxScanRows) as unknown as OutlineRow[];
  if (rows.length === 0) return EMPTY_RESULT;

  const byCode = new Map(rows.map((row) => [row.code.toUpperCase(), row] as const));
  const selected = new Map<string, RankedRow>();
  const put = (row: OutlineRow | undefined, reason: SelectionReason, score: number): void => {
    if (!row) return;
    const key = row.code.toUpperCase();
    const existing = selected.get(key);
    if (!existing || score > existing.score) selected.set(key, { row, reason, score });
  };

  for (const code of amReferences(input.context)) {
    let row = byCode.get(code);
    if (!row) {
      row = mem.db.prepare(
        `SELECT id,code,COALESCE(chapter,'') AS chapter,COALESCE(title,'') AS title,
                COALESCE(summary,'') AS summary,COALESCE(status,'active') AS status,COALESCE(seq,id) AS seq
           FROM memory_arc WHERE code=? AND COALESCE(summary,'') != '' LIMIT 1`,
      ).get(code) as OutlineRow | undefined;
      if (row) byCode.set(code, row);
    }
    put(row, 'am-ref', 10_000);
  }

  const recalledCodes = new Set<string>();
  for (const hit of input.recallHits ?? []) {
    if ((hit.category !== 'arc' && hit.category !== 'summary') || !hit.code) continue;
    const code = hit.code.toUpperCase();
    const row = byCode.get(code);
    if (!row) continue;
    recalledCodes.add(code);
    put(row, 'recall', 5_000 + Math.max(0, hit.score) * 100);
  }

  const recent = rows.slice(-recentCount);
  const recentCodes = new Set(recent.map((row) => row.code.toUpperCase()));
  for (const [index, row] of recent.entries()) put(row, 'recent', 100 + index);

  const terms = lexicalTerms(input.context);
  const lexical = rows
    .filter((row) => !recentCodes.has(row.code.toUpperCase()))
    .map((row) => ({ row, score: lexicalScore(row, terms) }))
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score || b.row.seq - a.row.seq)
    .slice(0, relevantCount);
  const lexicalCodes = new Set<string>();
  for (const entry of lexical) {
    lexicalCodes.add(entry.row.code.toUpperCase());
    put(entry.row, 'lexical', 1_000 + entry.score);
  }

  // 预算顺序：显式 AM 直引 > 最近剧情脊柱 > 通用命中 > 词面补召回。
  // 旧实现只按相关分排序，紧预算时会让多条旧命中挤掉全部近期因果，违背“恢复”本意。
  const admissionRank = (candidate: RankedRow): number => {
    if (candidate.reason === 'am-ref') return 4;
    if (recentCodes.has(candidate.row.code.toUpperCase())) return 3;
    if (candidate.reason === 'recall') return 2;
    return 1;
  };
  const ranked = [...selected.values()].sort((a, b) => (
    admissionRank(b) - admissionRank(a) || b.score - a.score || b.row.seq - a.row.seq
  ));
  const open = `<AM大纲恢复 version="1" as-of-round="${Math.max(0, input.currentRound)}">\n`;
  const note = '以下为只读剧情骨架；旧记录可能已被后续回合推进，冲突时以较新记录、当前人物状态和玩家本轮输入为准。\n';
  const close = '\n</AM大纲恢复>';
  const kept: RankedRow[] = [];
  for (const candidate of ranked) {
    const next = [...kept, candidate].sort((a, b) => a.row.seq - b.row.seq);
    const block = open + note + next.map(renderLine).join('\n') + close;
    if (estimateTokens(block) > budgetTokens) continue;
    kept.push(candidate);
  }
  if (kept.length === 0) return EMPTY_RESULT;
  kept.sort((a, b) => a.row.seq - b.row.seq);
  const block = open + note + kept.map(renderLine).join('\n') + close;
  const keptCodes = new Set(kept.map((entry) => entry.row.code.toUpperCase()));
  return Object.freeze({
    block,
    codes: Object.freeze(kept.map((entry) => entry.row.code)),
    recentCodes: Object.freeze([...recentCodes].filter((code) => keptCodes.has(code))),
    recalledCodes: Object.freeze([...recalledCodes].filter((code) => keptCodes.has(code))),
    lexicalCodes: Object.freeze([...lexicalCodes].filter((code) => keptCodes.has(code))),
    estimatedTokens: estimateTokens(block),
    sourceRows: rows.length,
  });
}

/**
 * 只在恢复块真的进入最终 prompt 后调用。访问计数是“被注入”审计，不是业务真值；
 * arc/summary 同码同步，保持原 RetrievalEngine 的双表口径。
 */
export function markOutlineRecoveryAccess(mem: MemoryDb, codes: readonly string[]): void {
  const unique = [...new Set(codes.filter((code) => /^AM\d+$/u.test(code)))];
  if (unique.length === 0) return;
  const now = Date.now();
  const touchArc = mem.db.prepare(
    'UPDATE memory_arc SET access_count=access_count+1,last_access_ms=? WHERE code=?',
  );
  const touchSummary = mem.db.prepare(
    'UPDATE memory_summary SET access_count=access_count+1,last_access_ms=? WHERE code=?',
  );
  mem.transaction(() => {
    for (const code of unique) {
      touchArc.run(now, code);
      touchSummary.run(now, code);
    }
  });
}
