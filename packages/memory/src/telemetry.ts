/**
 * memory 包 - 回合遥测（AQL 信号底座）
 *
 * 用户隐式反馈（regenerate / abort / delete）→ 结构化回合账本 turn_ledger。
 * 纪律：只追加写（INSERT），回滚/删除历史不读不删本表 → verify-rollback/abort/fallback 不回归。
 * 消费方：reward.ts（塑形）、tools/cli/analyze-quality.ts（归因聚合）、/api/quality/report（前端半自动）。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 回合结局（一条遥测 = 一次用户动作的终局） */
export type TurnOutcome = 'ok' | 'aborted' | 'failed' | 'deleted';

/** 一条回合遥测（turn_ledger 行） */
export interface TurnTelemetry {
  sessionId: string;
  round: number;
  /** 本轮内模型尝试次数（首轮=1，错误召回重试后=2；无用户含义，纯诊断） */
  attempt: number;
  /** 用户重发（regenerate）计数：0=首次生成，1=第 1 次重发，2=第 2 次… */
  retryIndex: number;
  /** 本条是否来自用户点"重新生成" */
  clickedRegenerate: boolean;
  outcome: TurnOutcome;
  /** 本回合近似 token 成本（上下文估算；供 cost 塑形） */
  tokenCost: number;
  contextFingerprint?: Record<string, unknown>;
  reward?: Record<string, number>;
  /** 重发前旧正文 md5（旧正文会被破坏性删除，hash 供差分/回看） */
  prevProseMd5?: string;
  createdAt?: string;
}

/** 上下文指纹（归因聚合沿用的字段字典；结构稳定，新增字段向后兼容） */
export interface ContextFingerprint extends Record<string, unknown> {
  recallHitIds: number[];
  recallCodes: string[];
  scanEntryIds: number[];
  windowCount: number;
  windowTokens: number;
  windowTruncated: boolean;
  distanceToSummary: number;
  longtermTokens: number;
  archiveIds: number[];
  budgetDropped: string[];
  model: string;
  bars: Record<string, number>;
  retryIndex: number;
}

const TURN_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS turn_ledger (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  round INTEGER,
  attempt INTEGER DEFAULT 0,
  retry_index INTEGER DEFAULT 0,
  clicked_regenerate INTEGER DEFAULT 0,
  outcome TEXT,
  token_cost INTEGER DEFAULT 0,
  context_fingerprint TEXT,
  reward TEXT,
  prev_prose_md5 TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_turnledger_round ON turn_ledger(round);
CREATE INDEX IF NOT EXISTS idx_turnledger_session ON turn_ledger(session_id);`;

/** 回合遥测记录器：追加写 turn_ledger，只读查询供归因/诊断 */
export class TelemetryRecorder {
  private db: DatabaseSync;
  private sessionId: string;

  constructor(db: DatabaseSync, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;
    // 防御：旧库/测试手建内存库可能跳过迁移，幂等建表不阻断记录
    try {
      this.db.exec(TURN_LEDGER_DDL);
    } catch {
      /* schema.ts/db.ts v5 已建表，此处仅兜底 */
    }
  }

  /** 追加写一条遥测（失败不抛出：遥测是旁路，绝不影响生成主链路） */
  record(t: TurnTelemetry): number {
    try {
      return this.db.prepare(
        `INSERT INTO turn_ledger
           (session_id, round, attempt, retry_index, clicked_regenerate, outcome,
            token_cost, context_fingerprint, reward, prev_prose_md5, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        this.sessionId, t.round, t.attempt, t.retryIndex, t.clickedRegenerate ? 1 : 0,
        t.outcome, t.tokenCost ?? 0,
        t.contextFingerprint ? JSON.stringify(t.contextFingerprint) : null,
        t.reward ? JSON.stringify(t.reward) : null,
        t.prevProseMd5 ?? null,
        t.createdAt ?? new Date().toISOString(),
      ).lastInsertRowid as number;
    } catch (e) {
      // 遥测失败静默（旁路不阻断；开发期可在 analyze-quality 归因时发现表缺失）
      if (process.env.JG_DEBUG_TELEMETRY) console.warn(`[遥测] 写入失败: ${(e as Error).message.slice(0, 80)}`);
      return 0;
    }
  }

  /** 读取某 round 的全部遥测（按 id 正序；差分/诊断用，不参与回滚） */
  listForRound(round: number): TurnTelemetry[] {
    return (this.db.prepare('SELECT * FROM turn_ledger WHERE round = ? ORDER BY id ASC').all(round) as {
      session_id: string; round: number; attempt: number; retry_index: number;
      clicked_regenerate: number; outcome: string; token_cost: number;
      context_fingerprint: string | null; reward: string | null; prev_prose_md5: string | null; created_at: string | null;
    }[]).map((r) => ({
      sessionId: r.session_id,
      round: r.round,
      attempt: r.attempt,
      retryIndex: r.retry_index,
      clickedRegenerate: Boolean(r.clicked_regenerate),
      outcome: r.outcome as TurnOutcome,
      tokenCost: r.token_cost,
      contextFingerprint: r.context_fingerprint ? JSON.parse(r.context_fingerprint) as Record<string, unknown> : undefined,
      reward: r.reward ? JSON.parse(r.reward) as Record<string, number> : undefined,
      prevProseMd5: r.prev_prose_md5 ?? undefined,
      createdAt: r.created_at ?? undefined,
    }));
  }
}
