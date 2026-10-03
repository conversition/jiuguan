import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatUsage, ModelCallLane } from '../../packages/proxy/src/client.ts';

export const MODEL_USAGE_DB_FILE = 'model-usage.sqlite';
export const MODEL_USAGE_SCHEMA_VERSION = 1;
export const MODEL_USAGE_APPLICATION_ID = 0x4a474d55; // JGMU

export const MODEL_CALL_LANES = Object.freeze([
  'turn_final',
  'interactive_prelude',
  'context_compiler',
  'variable_compile',
  'rolling_summary',
  'story_index',
  'aql_replan',
  'quiet_generate',
  'storyboard',
  'video_prompt',
  'maintenance',
  'style_compile',
  'preference',
  'arc',
  'npc',
  'critic',
  'unclassified',
] as const satisfies readonly ModelCallLane[]);

export type ModelCallTransport = 'complete' | 'stream';
export type ModelCallOutcome = 'completed' | 'transport_error' | 'cancelled';
export type ModelUsageSource = 'provider' | 'unavailable';

export interface ModelUsageRecord {
  readonly callId: string;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly round?: number;
  readonly lane: ModelCallLane;
  readonly callIndex?: number;
  readonly providerId: string;
  readonly model: string;
  readonly transport: ModelCallTransport;
  readonly outcome: ModelCallOutcome;
  readonly usage?: ChatUsage | null;
  readonly costMicrousd?: number;
  readonly rateCardId?: string;
  readonly finishReason?: string;
  readonly errorCode?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
}

export interface ModelUsageRow extends Omit<ModelUsageRecord, 'usage'> {
  readonly usageSource: ModelUsageSource;
  readonly usage: ChatUsage | null;
}

export interface ModelUsageListFilters {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly lane?: ModelCallLane;
  readonly limit?: number;
}

export interface ModelUsageSessionRedactResult {
  readonly deletedCalls: number;
}

type Row = Record<string, unknown>;

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`model-usage-${name}-invalid`);
  return Number(value);
}

function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const appId = pragma(db, 'application_id');
  if (version > MODEL_USAGE_SCHEMA_VERSION) throw new Error('model-usage-too-new');
  if (version !== 0) {
    if (version !== MODEL_USAGE_SCHEMA_VERSION || appId !== MODEL_USAGE_APPLICATION_ID) {
      throw new Error('model-usage-metadata-mismatch');
    }
    return;
  }
  if (appId !== 0) throw new Error('model-usage-application-id-mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${MODEL_USAGE_APPLICATION_ID};
      CREATE TABLE model_call_usage (
        call_id TEXT PRIMARY KEY,
        run_id TEXT,
        parent_run_id TEXT,
        session_id TEXT,
        round INTEGER CHECK(round IS NULL OR round >= 0),
        lane TEXT NOT NULL,
        call_index INTEGER CHECK(call_index IS NULL OR call_index >= 0),
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport IN ('complete','stream')),
        outcome TEXT NOT NULL CHECK(outcome IN ('completed','transport_error','cancelled')),
        usage_source TEXT NOT NULL CHECK(usage_source IN ('provider','unavailable')),
        prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens >= 0),
        total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
        cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        cost_microusd INTEGER CHECK(cost_microusd IS NULL OR cost_microusd >= 0),
        rate_card_id TEXT,
        finish_reason TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
        CHECK(
          (usage_source='unavailable' AND prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL)
          OR
          (usage_source='provider' AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens IS NOT NULL)
        ),
        CHECK((cost_microusd IS NULL AND rate_card_id IS NULL) OR (cost_microusd IS NOT NULL AND rate_card_id IS NOT NULL))
      );
      CREATE INDEX model_call_usage_run ON model_call_usage(run_id, started_at);
      CREATE INDEX model_call_usage_session ON model_call_usage(session_id, started_at);
      CREATE INDEX model_call_usage_lane ON model_call_usage(lane, started_at);
      PRAGMA user_version = ${MODEL_USAGE_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
}

function safeToken(value: string, field: string, max = 200): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${field}-invalid`);
  }
  return value;
}

function optionalToken(value: string | undefined, field: string, max = 200): string | null {
  return value === undefined ? null : safeToken(value, field, max);
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}-invalid`);
  return value;
}

function optionalNonNegative(value: number | undefined, field: string): number | null {
  return value === undefined ? null : nonNegative(value, field);
}

function timestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field}-invalid`);
  }
  return value;
}

function lane(value: ModelCallLane): ModelCallLane {
  if (!(MODEL_CALL_LANES as readonly string[]).includes(value)) throw new Error('lane-invalid');
  return value;
}

function usageValues(value: ChatUsage | null | undefined): {
  source: ModelUsageSource;
  prompt: number | null;
  completion: number | null;
  total: number | null;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
} {
  if (value === undefined || value === null) {
    return {
      source: 'unavailable', prompt: null, completion: null, total: null,
      cached: null, cacheWrite: null, reasoning: null,
    };
  }
  return {
    source: 'provider',
    prompt: nonNegative(value.prompt_tokens, 'promptTokens'),
    completion: nonNegative(value.completion_tokens, 'completionTokens'),
    total: nonNegative(value.total_tokens, 'totalTokens'),
    cached: optionalNonNegative(value.cached_input_tokens, 'cachedInputTokens'),
    cacheWrite: optionalNonNegative(value.cache_write_tokens, 'cacheWriteTokens'),
    reasoning: optionalNonNegative(value.reasoning_tokens, 'reasoningTokens'),
  };
}

function parseRow(row: Row): ModelUsageRow {
  const source = row.usage_source;
  if (source !== 'provider' && source !== 'unavailable') throw new Error('usage-source-invalid');
  const parsedUsage = source === 'provider' ? {
    prompt_tokens: nonNegative(Number(row.prompt_tokens), 'promptTokens'),
    completion_tokens: nonNegative(Number(row.completion_tokens), 'completionTokens'),
    total_tokens: nonNegative(Number(row.total_tokens), 'totalTokens'),
    ...(row.cached_input_tokens === null ? {} : { cached_input_tokens: nonNegative(Number(row.cached_input_tokens), 'cachedInputTokens') }),
    ...(row.cache_write_tokens === null ? {} : { cache_write_tokens: nonNegative(Number(row.cache_write_tokens), 'cacheWriteTokens') }),
    ...(row.reasoning_tokens === null ? {} : { reasoning_tokens: nonNegative(Number(row.reasoning_tokens), 'reasoningTokens') }),
  } : null;
  const transport = row.transport;
  if (transport !== 'complete' && transport !== 'stream') throw new Error('transport-invalid');
  const outcome = row.outcome;
  if (outcome !== 'completed' && outcome !== 'transport_error' && outcome !== 'cancelled') {
    throw new Error('outcome-invalid');
  }
  return {
    callId: safeToken(String(row.call_id), 'callId'),
    ...(row.run_id === null ? {} : { runId: safeToken(String(row.run_id), 'runId') }),
    ...(row.parent_run_id === null ? {} : { parentRunId: safeToken(String(row.parent_run_id), 'parentRunId') }),
    ...(row.session_id === null ? {} : { sessionId: safeToken(String(row.session_id), 'sessionId') }),
    ...(row.round === null ? {} : { round: nonNegative(Number(row.round), 'round') }),
    lane: lane(String(row.lane) as ModelCallLane),
    ...(row.call_index === null ? {} : { callIndex: nonNegative(Number(row.call_index), 'callIndex') }),
    providerId: safeToken(String(row.provider_id), 'providerId'),
    model: safeToken(String(row.model), 'model'),
    transport,
    outcome,
    usageSource: source,
    usage: parsedUsage,
    ...(row.cost_microusd === null ? {} : { costMicrousd: nonNegative(Number(row.cost_microusd), 'costMicrousd') }),
    ...(row.rate_card_id === null ? {} : { rateCardId: safeToken(String(row.rate_card_id), 'rateCardId') }),
    ...(row.finish_reason === null ? {} : { finishReason: safeToken(String(row.finish_reason), 'finishReason') }),
    ...(row.error_code === null ? {} : { errorCode: safeToken(String(row.error_code), 'errorCode') }),
    startedAt: timestamp(String(row.started_at), 'startedAt'),
    finishedAt: timestamp(String(row.finished_at), 'finishedAt'),
    elapsedMs: nonNegative(Number(row.elapsed_ms), 'elapsedMs'),
  };
}

function listRows(db: DatabaseSync, filters: ModelUsageListFilters = {}): ModelUsageRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.runId !== undefined) {
    where.push('run_id=?');
    params.push(safeToken(filters.runId, 'runId'));
  }
  if (filters.sessionId !== undefined) {
    where.push('session_id=?');
    params.push(safeToken(filters.sessionId, 'sessionId'));
  }
  if (filters.lane !== undefined) {
    where.push('lane=?');
    params.push(lane(filters.lane));
  }
  const limit = filters.limit === undefined ? 1_000 : nonNegative(filters.limit, 'limit');
  if (limit < 1 || limit > 10_000) throw new Error('limit-invalid');
  const sql = 'SELECT * FROM model_call_usage'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY started_at,call_id LIMIT ?';
  params.push(limit);
  return (db.prepare(sql).all(...params) as Row[]).map(parseRow);
}

/**
 * 分析专用的严格只读入口。不会初始化、迁移、切 WAL 或创建任何文件。
 */
export function readModelUsageFile(file: string, filters: ModelUsageListFilters = {}): ModelUsageRow[] {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('model-usage-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (pragma(db, 'application_id') !== MODEL_USAGE_APPLICATION_ID
      || pragma(db, 'user_version') !== MODEL_USAGE_SCHEMA_VERSION) {
      throw new Error('model-usage-metadata-mismatch');
    }
    return listRows(db, filters);
  } finally {
    db.close();
  }
}

export class ModelUsageLedger {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: { dataDir: string; busyTimeoutMs?: number }) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('model-usage-data-dir-invalid');
    const path = join(dataDir, MODEL_USAGE_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('model-usage-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5_000};`);
      initialize(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL handled by parent directory. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  record(entry: ModelUsageRecord): void {
    this.#assertOpen();
    const usage = usageValues(entry.usage);
    const cost = optionalNonNegative(entry.costMicrousd, 'costMicrousd');
    const rateCard = optionalToken(entry.rateCardId, 'rateCardId');
    if ((cost === null) !== (rateCard === null)) throw new Error('cost-rate-card-mismatch');
    this.#db.prepare(`
      INSERT INTO model_call_usage(
        call_id,run_id,parent_run_id,session_id,round,lane,call_index,provider_id,model,
        transport,outcome,usage_source,prompt_tokens,completion_tokens,total_tokens,
        cached_input_tokens,cache_write_tokens,reasoning_tokens,cost_microusd,rate_card_id,
        finish_reason,error_code,started_at,finished_at,elapsed_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      safeToken(entry.callId, 'callId'),
      optionalToken(entry.runId, 'runId'),
      optionalToken(entry.parentRunId, 'parentRunId'),
      optionalToken(entry.sessionId, 'sessionId'),
      optionalNonNegative(entry.round, 'round'),
      lane(entry.lane),
      optionalNonNegative(entry.callIndex, 'callIndex'),
      safeToken(entry.providerId, 'providerId'),
      safeToken(entry.model, 'model'),
      entry.transport,
      entry.outcome,
      usage.source,
      usage.prompt,
      usage.completion,
      usage.total,
      usage.cached,
      usage.cacheWrite,
      usage.reasoning,
      cost,
      rateCard,
      optionalToken(entry.finishReason, 'finishReason'),
      optionalToken(entry.errorCode, 'errorCode'),
      timestamp(entry.startedAt, 'startedAt'),
      timestamp(entry.finishedAt, 'finishedAt'),
      nonNegative(entry.elapsedMs, 'elapsedMs'),
    );
  }

  list(filters: ModelUsageListFilters = {}): ModelUsageRow[] {
    this.#assertOpen();
    return listRows(this.#db, filters);
  }

  /** Privacy-first removal of exact-session call rows; aggregate rows do not exist in this ledger. */
  redactSession(sessionIdValue: string): ModelUsageSessionRedactResult {
    this.#assertOpen();
    const sessionId = safeToken(sessionIdValue, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const deletedCalls = Number(this.#db.prepare(
        'DELETE FROM model_call_usage WHERE session_id=?',
      ).run(sessionId).changes);
      this.#db.exec('COMMIT;');
      return Object.freeze({ deletedCalls });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('model-usage-closed');
  }
}
