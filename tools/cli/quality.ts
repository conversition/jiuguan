/**
 * 推理服务 - AQL 归因聚合（M3）
 * 读 turn_ledger 遥测 → 按维度聚合「负反馈率」→ 产出改进建议（半自动：低风险可自动，高风险待玩家一键应用）。
 * 供 tools/cli/analyze-quality.ts（离线 CLI）与 apps/server `/api/quality/report`（Web）共用。
 * 只读：不写任何表；会话 db 以只读态打开，不触发迁移/WAL 锁。
 */
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildAliasIndex, parseLoreEntries } from '../../packages/core/src/lore-parse.ts';

export interface EntryStat {
  /** lorebook_entry.id / memory 表 rowId */
  id: number;
  label: string;
  appeared: number;
  negative: number;
  rate: number;
  /** 用户输入含该实体但该轮注入集无此 id（期望-miss） */
  miss: number;
  missNegative: number;
  /** lore 静态条目（可 boost/档案提升） */
  lore: boolean;
}

export interface SummaryBucketStat {
  dist: number;
  appeared: number;
  negative: number;
  rate: number;
}

export interface Suggestion {
  dimension: 'rag' | 'summary' | 'budget' | 'model';
  risk: 'low' | 'high';
  target: string;
  action: string;
  sample: number;
  confidence: string;
}

export interface QualityReport {
  sessionId: string;
  dbFile: string;
  rounds: number;
  negativeRounds: number;
  retryRate: number;
  entries: EntryStat[];
  summaryBuckets: SummaryBucketStat[];
  windowTruncated: { appeared: number; negative: number; rate: number };
  models: { model: string; appeared: number; negative: number; rate: number }[];
  planFailedRounds: number;
  suggestions: Suggestion[];
}

interface Fingerprint {
  recallHitIds?: number[];
  scanEntryIds?: number[];
  archiveIds?: number[];
  windowCount?: number;
  windowTokens?: number;
  windowTruncated?: boolean;
  distanceToSummary?: number;
  model?: string;
  bars?: Record<string, number>;
}

interface TelRow {
  round: number;
  retry_index: number;
  clicked_regenerate: number;
  outcome: string;
  context_fingerprint: string | null;
}

/** 读全部遥测行（turn_ledger 缺失 → 空数组） */
function readTelemetry(db: DatabaseSync): TelRow[] {
  try {
    return db.prepare('SELECT round, retry_index, clicked_regenerate, outcome, context_fingerprint FROM turn_ledger ORDER BY id').all() as unknown as TelRow[];
  } catch {
    return [];
  }
}

function parseFp(raw: string | null): Fingerprint {
  if (!raw) return {};
  try { return JSON.parse(raw) as Fingerprint; } catch { return {}; }
}

/** 最低样本门槛（少于该轮次不产出建议，防随机重试过度适应）；env 可覆盖 */
export function qualityMinSample(): number {
  return Number(process.env.JG_QUALITY_MIN_SAMPLE ?? 5);
}

/** 会话 db → 质量报告（只读） */
export function analyzeQualityDb(file: string): QualityReport {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return analyzeQuality(db, file);
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/** 已打开只读 db → 质量报告 */
export function analyzeQuality(db: DatabaseSync, file = ''): QualityReport {
  const rows = readTelemetry(db);
  const sessionId = /session-(\d+)/i.exec(file)?.[1] ?? file;
  const minSample = qualityMinSample();

  // 按 round 分组 + 归集负反馈
  const byRound = new Map<number, TelRow[]>();
  for (const r of rows) {
    if (!byRound.has(r.round)) byRound.set(r.round, []);
    byRound.get(r.round)!.push(r);
  }
  const negativeRound = (arr: TelRow[]): boolean =>
    arr.some((r) => r.outcome !== 'ok' || r.retry_index >= 1);

  // 维度聚合
  const entryAgg = new Map<number, { label: string; appeared: Set<number>; negative: Set<number>; miss: Set<number>; missNeg: Set<number>; lore: boolean }>();
  const bucketAgg = new Map<number, { appeared: number; negative: number }>();
  const modelAgg = new Map<string, { appeared: number; negative: number }>();
  let windowAppeared = 0;
  let windowNegative = 0;
  let negativeRounds = 0;
  let planFailedRounds = 0;

  // 实体名册（miss 判定：输入含实体但注入集无其条目）
  let roster = new Map<string, { entityName: string; entryIds: number[] }>();
  try {
    const loreRows = db.prepare('SELECT id, book, key, comment, content, constant, active FROM lorebook_entry WHERE active = 1').all() as {
      id: number; book: string; key: string; comment: string; content: string; constant: number; active: number;
    }[];
    const idx = buildAliasIndex(parseLoreEntries(loreRows.map((r) => ({ ...r, uid: r.id })) as never, ''));
    for (const [alias, entry] of idx) {
      if (!entry.entityName || roster.has(alias)) continue;
      roster.set(alias, { entityName: entry.entityName, entryIds: entry.entryIds });
    }
  } catch { /* roster 不可用 → 跳过 miss 判定 */ }

  for (const [round, arr] of byRound) {
    const neg = negativeRound(arr);
    if (neg) negativeRounds++;
    const unionIds = new Set<number>();
    let truncated = false;
    let dist: number | null = null;
    let model = '';
    let input = '';
    for (const r of arr) {
      const fp = parseFp(r.context_fingerprint);
      for (const k of (['recallHitIds', 'scanEntryIds', 'archiveIds'] as const)) {
        for (const id of fp[k] ?? []) unionIds.add(id);
      }
      if (fp.windowTruncated) truncated = true;
      if (fp.distanceToSummary !== undefined) dist = fp.distanceToSummary;
      if (fp.model) model = fp.model;
      if (r.outcome === 'failed') planFailedRounds++;
    }
    // 窗口截断聚合（本轮任一行记 truncated）
    if (truncated) { windowAppeared++; if (neg) windowNegative++; }
    // 距离摘要分桶
    if (dist !== null) {
      const bucket = dist < 5 ? dist : dist < 10 ? 5 : dist < 20 ? 10 : 20;
      const b = bucketAgg.get(bucket) ?? { appeared: 0, negative: 0 };
      b.appeared++; if (neg) b.negative++;
      bucketAgg.set(bucket, b);
    }
    // 模型聚合
    if (model) {
      const m = modelAgg.get(model) ?? { appeared: 0, negative: 0 };
      m.appeared++; if (neg) m.negative++;
      modelAgg.set(model, m);
    }
    // 词条聚合 + miss 判定
    try {
      const u = db.prepare('SELECT content FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1').get(round, 'user') as { content?: string } | undefined;
      input = String(u?.content ?? '');
    } catch { /* 无 chat_log */ }
    for (const id of unionIds) {
      let a = entryAgg.get(id);
      if (!a) {
        a = { label: String(id), appeared: new Set(), negative: new Set(), miss: new Set(), missNeg: new Set(), lore: false };
        entryAgg.set(id, a);
      }
      a.appeared.add(round);
      if (neg) a.negative.add(round);
    }
    // 实体名 miss：输入含实体名/别名，但其全部 entryIds 都不在注入集（全名直呼同样计入）
    if (roster.size > 0 && input) {
      for (const [alias, ent] of roster) {
        if (!input.includes(alias) && !input.includes(ent.entityName)) continue;
        const injected = ent.entryIds.some((id) => unionIds.has(id));
        if (!injected && ent.entryIds.length > 0) {
          const a = entryAgg.get(ent.entryIds[0]) ?? {
            label: ent.entityName, appeared: new Set(), negative: new Set(), miss: new Set(), missNeg: new Set(), lore: true,
          };
          entryAgg.set(ent.entryIds[0], a);
          a.miss.add(round);
          if (neg) a.missNeg.add(round);
        }
      }
    }
    void input;
  }

  // 词条 label 解析（lore → comment；其余 → code）
  const entries: EntryStat[] = [];
  for (const [id, a] of entryAgg) {
    let label = a.label;
    if (a.lore === false) {
      try {
        const c = db.prepare('SELECT comment FROM lorebook_entry WHERE id = ?').get(id) as { comment?: string } | undefined;
        if (c?.comment) label = String(c.comment);
        a.lore = true;
      } catch { /* 非 lore */ }
    }
    entries.push({
      id, label, lore: a.lore,
      appeared: a.appeared.size, negative: a.negative.size,
      rate: a.appeared.size > 0 ? a.negative.size / a.appeared.size : 0,
      miss: a.miss.size, missNegative: a.missNeg.size,
    });
  }
  entries.sort((x, y) => y.negative - x.negative);

  const summaryBuckets: SummaryBucketStat[] = [...bucketAgg.entries()]
    .map(([dist, v]) => ({ dist, appeared: v.appeared, negative: v.negative, rate: v.appeared > 0 ? v.negative / v.appeared : 0 }))
    .sort((x, y) => x.dist - y.dist);
  const models = [...modelAgg.entries()].map(([model, v]) => ({
    model, appeared: v.appeared, negative: v.negative, rate: v.appeared > 0 ? v.negative / v.appeared : 0,
  }));

  // 建议（半自动：sample ≥ minSample 才有置信；低风险可自动应用，高风险待玩家）
  const suggestions: Suggestion[] = [];
  for (const e of entries) {
    if (e.negative >= minSample && e.rate >= 0.4) {
      suggestions.push({
        dimension: 'rag', risk: 'high',
        target: `lore#${e.id}`, action: `高重试词条「${e.label.slice(0, 20)}」重试率 ${(e.rate * 100).toFixed(0)}%（${e.negative}/${e.appeared} 轮）→ 建议加入检索 boost/档案提升`,
        sample: e.negative, confidence: `${e.negative}/${e.appeared}`,
      });
    }
    if (e.missNegative >= 2) {
      suggestions.push({
        dimension: 'rag', risk: 'high',
        target: `alias#${e.id}`, action: `「${e.label.slice(0, 20)}」被玩家提到但 ${e.missNegative} 次未注入 → 建议补齐别名/检索提升`,
        sample: e.missNegative, confidence: `${e.missNegative} 次 miss（负反馈轮）`,
      });
    }
  }
  for (const b of summaryBuckets) {
    if (b.appeared >= Math.max(2, minSample) && b.rate >= 0.5) {
      suggestions.push({
        dimension: 'summary', risk: 'low',
        target: `summary.dist${b.dist}`, action: `距摘要 ${b.dist} 轮分桶重试率 ${(b.rate * 100).toFixed(0)}% → 调低 summaryRoundsDelta / 抬高 longtermTokensDelta`,
        sample: b.appeared, confidence: `${b.negative}/${b.appeared}`,
      });
    }
  }
  if (windowAppeared >= Math.max(2, minSample) && windowNegative / windowAppeared >= 0.5) {
    suggestions.push({
      dimension: 'budget', risk: 'low',
      target: 'windowTokensDelta', action: `窗口截断轮重试率 ${((windowNegative / windowAppeared) * 100).toFixed(0)}% → 放大 windowTokensDelta`,
      sample: windowAppeared, confidence: `${windowNegative}/${windowAppeared}`,
    });
  }
  for (const m of models) {
    if (m.appeared >= minSample && m.rate >= 0.5) {
      suggestions.push({
        dimension: 'model', risk: 'low',
        target: m.model, action: `模型「${m.model}」重试率 ${(m.rate * 100).toFixed(0)}%`,
        sample: m.appeared, confidence: `${m.negative}/${m.appeared}`,
      });
    }
  }

  return {
    sessionId, dbFile: file, rounds: byRound.size, negativeRounds, retryRate: byRound.size > 0 ? negativeRounds / byRound.size : 0,
    entries, summaryBuckets,
    windowTruncated: { appeared: windowAppeared, negative: windowNegative, rate: windowAppeared > 0 ? windowNegative / windowAppeared : 0 },
    models, planFailedRounds, suggestions,
  };
}

/** 扫描 data/ 下全部会话 db（缺目录 → 空） */
export function scanSessionDbs(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((f) => /^session-.+\.db$/i.test(f)).map((f) => join(dataDir, f));
}
