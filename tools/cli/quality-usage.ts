/**
 * P14-01C：AQL 的只读成本关联层。
 *
 * session SQLite 与 model-usage.sqlite 分别读取，再在应用内按 runId + sessionId + round 关联；
 * 绝不 ATTACH、写回、迁移或伪装跨库事务，也不改变旧 QualityReport/turn_ledger.token_cost 口径。
 */
import { DatabaseSync } from 'node:sqlite';
import { TurnObservationStore, type TurnObservationRecord } from '../../packages/memory/src/turn-observation.ts';
import {
  readModelUsageFile,
  type ModelUsageRow,
  type ModelUsageSource,
} from '../../apps/server/model-usage-ledger.ts';

export type AqlTokenSource = 'provider' | 'estimated' | 'unavailable';

export interface AqlTokenMeasurement {
  readonly source: AqlTokenSource;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AqlUsageAttempt {
  readonly callId: string;
  readonly callIndex: number | null;
  readonly outcome: ModelUsageRow['outcome'];
  readonly source: ModelUsageSource;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AqlTurnUsageCorrelation {
  readonly observationId: string;
  readonly runId: string | null;
  readonly sessionId: string;
  readonly round: number;
  readonly assistantMessageId: number;
  readonly sourceRevision: string;
  readonly modelAttempts: number | null;
  /** 旧 turn_ledger.token_cost，只读保留原估算口径。 */
  readonly estimated: AqlTokenMeasurement;
  /** 只有所有 turn_final 尝试都有 Provider usage 时才给出完整总数。 */
  readonly provider: AqlTokenMeasurement;
  /** 完整 Provider 优先，否则回退旧估算；两者皆不可用时显式 unavailable。 */
  readonly selected: AqlTokenMeasurement;
  readonly attempts: readonly AqlUsageAttempt[];
  readonly costMicrousd: number | null;
}

interface EstimatedRow {
  readonly id: number;
  readonly sessionId: string;
  readonly round: number;
  readonly attempt: number;
  readonly tokenCost: number;
  readonly createdAt: string;
}

function unavailable(): AqlTokenMeasurement {
  return { source: 'unavailable', promptTokens: null, completionTokens: null, totalTokens: null };
}

function readEstimatedRows(db: DatabaseSync): EstimatedRow[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(
      `SELECT id,session_id,round,attempt,token_cost,created_at
       FROM turn_ledger WHERE outcome='ok' ORDER BY id`,
    ).all() as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  return rows.flatMap((row) => {
    const id = Number(row.id);
    const round = Number(row.round);
    const attempt = Number(row.attempt);
    const tokenCost = Number(row.token_cost);
    const sessionId = row.session_id;
    const createdAt = row.created_at;
    if (!Number.isSafeInteger(id) || id < 1
      || !Number.isSafeInteger(round) || round < 1
      || !Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(tokenCost) || tokenCost < 0
      || typeof sessionId !== 'string' || sessionId.length === 0
      || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return [];
    return [{ id, sessionId, round, attempt, tokenCost, createdAt }];
  });
}

function pairEstimated(
  observations: readonly TurnObservationRecord[],
  rows: readonly EstimatedRow[],
): Map<string, EstimatedRow> {
  const used = new Set<number>();
  const paired = new Map<string, EstimatedRow>();
  for (const observation of observations) {
    const observationAt = Date.parse(observation.createdAt);
    const match = rows.find((row) => !used.has(row.id)
      && row.sessionId === observation.sessionId
      && row.round === observation.round
      && (observation.modelAttempts === null || row.attempt === observation.modelAttempts)
      && Date.parse(row.createdAt) >= observationAt);
    if (!match) continue;
    used.add(match.id);
    paired.set(observation.observationId, match);
  }
  return paired;
}

function usageAttempts(
  observation: TurnObservationRecord,
  rows: readonly ModelUsageRow[],
): AqlUsageAttempt[] {
  if (observation.runId === null) return [];
  return rows
    .filter((row) => row.runId === observation.runId
      && row.sessionId === observation.sessionId
      && row.round === observation.round
      && row.lane === 'turn_final')
    .sort((left, right) => (left.callIndex ?? Number.MAX_SAFE_INTEGER) - (right.callIndex ?? Number.MAX_SAFE_INTEGER)
      || left.startedAt.localeCompare(right.startedAt)
      || left.callId.localeCompare(right.callId))
    .map((row) => ({
      callId: row.callId,
      callIndex: row.callIndex ?? null,
      outcome: row.outcome,
      source: row.usageSource,
      promptTokens: row.usage?.prompt_tokens ?? null,
      completionTokens: row.usage?.completion_tokens ?? null,
      totalTokens: row.usage?.total_tokens ?? null,
    }));
}

function providerMeasurement(
  attempts: readonly AqlUsageAttempt[],
  expectedAttempts: number | null,
): AqlTokenMeasurement {
  if (expectedAttempts === null || attempts.length !== expectedAttempts) return unavailable();
  const complete = attempts.every((attempt, index) => attempt.callIndex === index
    && attempt.outcome === 'completed'
    && attempt.source === 'provider'
    && attempt.promptTokens !== null
    && attempt.completionTokens !== null
    && attempt.totalTokens !== null);
  if (!complete) return unavailable();
  return {
    source: 'provider',
    promptTokens: attempts.reduce((sum, attempt) => sum + attempt.promptTokens!, 0),
    completionTokens: attempts.reduce((sum, attempt) => sum + attempt.completionTokens!, 0),
    totalTokens: attempts.reduce((sum, attempt) => sum + attempt.totalTokens!, 0),
  };
}

/** 已打开的两个独立数据源 → 纯内存关联结果。 */
export function correlateAqlUsage(
  sessionDb: DatabaseSync,
  modelUsageRows: readonly ModelUsageRow[],
): AqlTurnUsageCorrelation[] {
  const observations = new TurnObservationStore(sessionDb).list();
  const estimates = pairEstimated(observations, readEstimatedRows(sessionDb));
  return observations.map((observation) => {
    const attempts = usageAttempts(observation, modelUsageRows);
    const provider = providerMeasurement(attempts, observation.modelAttempts);
    const estimateRow = estimates.get(observation.observationId);
    const estimated: AqlTokenMeasurement = estimateRow
      ? { source: 'estimated', promptTokens: null, completionTokens: null, totalTokens: estimateRow.tokenCost }
      : unavailable();
    const selected = provider.source === 'provider' ? provider : estimated;
    const matchingCostRows = observation.runId === null ? [] : modelUsageRows.filter((row) => (
      row.runId === observation.runId
      && row.sessionId === observation.sessionId
      && row.round === observation.round
      && row.lane === 'turn_final'
    ));
    const costMicrousd = matchingCostRows.length === observation.modelAttempts
      && matchingCostRows.every((row) => row.costMicrousd !== undefined)
      ? matchingCostRows.reduce((sum, row) => sum + row.costMicrousd!, 0)
      : null;
    return Object.freeze({
      observationId: observation.observationId,
      runId: observation.runId,
      sessionId: observation.sessionId,
      round: observation.round,
      assistantMessageId: observation.assistantMessageId,
      sourceRevision: observation.sourceRevision,
      modelAttempts: observation.modelAttempts,
      estimated,
      provider,
      selected,
      attempts: Object.freeze(attempts),
      costMicrousd,
    });
  });
}

/** 文件包装器：两个 SQLite 都以 readOnly 打开，缺失 usage 文件按空账本处理。 */
export function correlateAqlUsageFiles(sessionFile: string, modelUsageFile: string): AqlTurnUsageCorrelation[] {
  const usageRows = readModelUsageFile(modelUsageFile, { lane: 'turn_final', limit: 10_000 });
  const sessionDb = new DatabaseSync(sessionFile, { readOnly: true });
  try {
    return correlateAqlUsage(sessionDb, usageRows);
  } finally {
    sessionDb.close();
  }
}
