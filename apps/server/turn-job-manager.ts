import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isSafeOpaqueId,
  isTurnJobAction,
  isTurnJobStatus,
  type PublicTurnJob,
  type TurnJobAction,
  type TurnJobStatus,
} from '../../packages/mobile-contracts/src/index.ts';

export const TURN_JOB_DB_FILE = 'turn-jobs.sqlite';
export const TURN_JOB_SCHEMA_VERSION = 3;
/** ASCII `JGTJ`. */
export const TURN_JOB_APPLICATION_ID = 0x4a47544a;
export const DEFAULT_TURN_JOB_LEASE_MS = 30_000;
export const DEFAULT_TURN_JOB_HEARTBEAT_MS = 10_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_REQUEST_JSON_BYTES = 4 * 1024 * 1024;

const LEGAL_TRANSITIONS: Readonly<Record<TurnJobStatus, readonly TurnJobStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled', 'recovering'],
  recovering: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

type SqlRow = Record<string, unknown>;

export type TurnJobConflictCode =
  | 'idempotency-conflict'
  | 'session-turn-active'
  | 'commit-fence-conflict'
  | 'transition-conflict';

export class TurnJobConflictError extends Error {
  readonly name = 'TurnJobConflictError';

  constructor(
    readonly code: TurnJobConflictCode,
    message: string,
    readonly runId?: string,
  ) {
    super(message);
  }
}

export interface CreateTurnJobInput {
  sessionId: string;
  action: TurnJobAction;
  requestId: string;
  originDeviceId: string;
  idempotencyKey: string;
  requestBody: unknown;
  round?: number;
}

export interface CreateTurnJobResult {
  job: PublicTurnJob;
  replayed: boolean;
}

export interface TransitionTurnJobInput {
  runId: string;
  expectedVersion: number;
  to: TurnJobStatus;
  leaseOwnerInstanceId?: string;
  publicErrorCode?: string;
  assistantMessageId?: number;
  resultRevision?: string;
}

export interface TurnJobExecutionRecord {
  job: PublicTurnJob;
  originDeviceId: string;
  requestBody: Record<string, unknown>;
  commitFenceAt?: string;
  lease?: {
    ownerInstanceId: string;
    expiresAt: string;
    heartbeatAt: string;
  };
}

export interface TurnJobCommittedOutcome {
  runId: string;
  sessionId: string;
  action: TurnJobAction;
  round: number;
  assistantMessageId: number;
  revision: string;
}

export interface RequestTurnJobCancelResult {
  job: PublicTurnJob;
  shouldAbortExecutor: boolean;
}

export interface RecoverExpiredTurnJobResult {
  job: PublicTurnJob;
  recovered: boolean;
  nextAttemptAt?: string;
}

export interface TurnJobSessionDeleteResult {
  readonly deletedJobs: number;
  readonly deletedIdempotencyBindings: number;
}

export interface TurnJobManagerOptions {
  dataDir: string;
  now?: () => string;
  randomId?: () => string;
  busyTimeoutMs?: number;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('TurnJobManager 时钟必须返回 canonical ISO 时间');
  }
  return value;
}

function requireOpaque(value: unknown, field: string, maxLength = 160): string {
  if (!isSafeOpaqueId(value, maxLength)) throw new Error(`${field} 非法`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} 非法`);
  }
  return value as number;
}

function requireLeaseDuration(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new Error('leaseDurationMs 必须是 1000..300000 的整数');
  }
  return value;
}

function normalizeJson(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > 32) throw new Error('requestBody 嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('requestBody 包含非有限数字');
    return value;
  }
  if (typeof value !== 'object') throw new Error('requestBody 只能包含 JSON 值');
  if (seen.has(value)) throw new Error('requestBody 不得循环引用');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen, depth + 1));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('requestBody 必须是普通 JSON 对象');
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key.length === 0 || key.length > 256) throw new Error('requestBody 字段名非法');
      output[key] = normalizeJson((value as Record<string, unknown>)[key], seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalRequestJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('requestBody 必须是 JSON 对象');
  }
  const text = JSON.stringify(normalizeJson(value, new Set(), 0));
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_JSON_BYTES) throw new Error('requestBody 过大');
  return text;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readPragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row?.[name];
  if (!Number.isInteger(value)) throw new Error(`无法读取 SQLite ${name}`);
  return value as number;
}

function initializeSchema(db: DatabaseSync): void {
  const version = readPragma(db, 'user_version');
  const applicationId = readPragma(db, 'application_id');
  if (version > TURN_JOB_SCHEMA_VERSION) throw new Error(`turn job 数据库版本过新: ${version}`);
  if (version === 0) {
    if (applicationId !== 0) throw new Error('turn job 数据库元数据不一致');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
        PRAGMA application_id = ${TURN_JOB_APPLICATION_ID};
      CREATE TABLE turn_job (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 8 AND 160),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
        action TEXT NOT NULL CHECK (action IN ('turn','regenerate')),
        request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
        origin_device_id TEXT NOT NULL CHECK (length(origin_device_id) BETWEEN 1 AND 160),
        status TEXT NOT NULL CHECK (status IN ('queued','running','recovering','succeeded','failed','cancelled')),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
        round INTEGER CHECK (round IS NULL OR round >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancel_requested_at TEXT,
        commit_fence_at TEXT,
        lease_owner_instance_id TEXT CHECK (
          lease_owner_instance_id IS NULL OR length(lease_owner_instance_id) BETWEEN 8 AND 160
        ),
        lease_expires_at TEXT,
        lease_heartbeat_at TEXT,
        version INTEGER NOT NULL CHECK (version >= 1),
        public_error_code TEXT CHECK (public_error_code IS NULL OR length(public_error_code) BETWEEN 1 AND 80),
        assistant_message_id INTEGER CHECK (assistant_message_id IS NULL OR assistant_message_id >= 1),
        result_revision TEXT CHECK (result_revision IS NULL OR length(result_revision) BETWEEN 1 AND 160)
      );
      CREATE UNIQUE INDEX idx_turn_job_one_active_per_session
        ON turn_job (session_id)
        WHERE status IN ('queued','running','recovering');
      CREATE INDEX idx_turn_job_status_created ON turn_job (status, created_at);
      CREATE TABLE turn_job_idempotency (
        origin_device_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('turn','regenerate')),
        session_id TEXT NOT NULL,
        key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        run_id TEXT NOT NULL REFERENCES turn_job (run_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (origin_device_id, action, session_id, key_digest)
      );
      CREATE INDEX idx_turn_job_idempotency_expiry ON turn_job_idempotency (expires_at);
      PRAGMA user_version = ${TURN_JOB_SCHEMA_VERSION};
      `);
      db.exec('COMMIT;');
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }
  if (applicationId !== TURN_JOB_APPLICATION_ID) throw new Error('turn job 数据库 application_id 不匹配');
  if (version === 1) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
        ALTER TABLE turn_job ADD COLUMN commit_fence_at TEXT;
        PRAGMA user_version = 2;
      `);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }
  if (version === 1 || version === 2) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
        ALTER TABLE turn_job ADD COLUMN lease_owner_instance_id TEXT CHECK (
          lease_owner_instance_id IS NULL OR length(lease_owner_instance_id) BETWEEN 8 AND 160
        );
        ALTER TABLE turn_job ADD COLUMN lease_expires_at TEXT;
        ALTER TABLE turn_job ADD COLUMN lease_heartbeat_at TEXT;
        PRAGMA user_version = ${TURN_JOB_SCHEMA_VERSION};
      `);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }
}

function parseJob(row: SqlRow): PublicTurnJob {
  const status = row.status;
  const action = row.action;
  if (!isTurnJobStatus(status) || !isTurnJobAction(action)) throw new Error('turn job 行包含未知枚举');
  const job: PublicTurnJob = {
    runId: requireOpaque(row.run_id, 'run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    action,
    requestId: requireOpaque(row.request_id, 'request_id'),
    status,
    createdAt: canonicalTimestamp(String(row.created_at)),
    updatedAt: canonicalTimestamp(String(row.updated_at)),
    version: requirePositiveInteger(row.version, 'version'),
    ...(row.round == null ? {} : { round: requirePositiveInteger(row.round, 'round') }),
    ...(row.started_at == null ? {} : { startedAt: canonicalTimestamp(String(row.started_at)) }),
    ...(row.finished_at == null ? {} : { finishedAt: canonicalTimestamp(String(row.finished_at)) }),
    ...(row.cancel_requested_at == null
      ? {}
      : { cancelRequestedAt: canonicalTimestamp(String(row.cancel_requested_at)) }),
  };
  if (status === 'succeeded' && (row.assistant_message_id != null || row.result_revision != null)) {
    job.result = {
      ...(row.assistant_message_id == null
        ? {}
        : { assistantMessageId: requirePositiveInteger(row.assistant_message_id, 'assistant_message_id') }),
      ...(row.result_revision == null ? {} : { revision: requireOpaque(row.result_revision, 'result_revision') }),
    };
  }
  if (status === 'failed' && row.public_error_code != null) {
    job.error = { code: requireOpaque(row.public_error_code, 'public_error_code', 80) };
  }
  return job;
}

function isConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT');
}

export class TurnJobManager {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #randomId: () => string;
  #closed = false;

  constructor(options: TurnJobManagerOptions) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stats = lstatSync(dataDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('TurnJobManager 数据路径必须是普通目录');
    const path = join(dataDir, TURN_JOB_DB_FILE);
    if (existsSync(path)) {
      const dbStats = lstatSync(path);
      if (!dbStats.isFile() || dbStats.isSymbolicLink()) throw new Error('turn job 数据库路径必须是普通文件');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS};`);
      initializeSchema(this.#db);
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL 由数据目录策略承担。 */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
  }

  create(input: CreateTurnJobInput): CreateTurnJobResult {
    this.#assertOpen();
    const sessionId = requireOpaque(input.sessionId, 'sessionId');
    if (!isTurnJobAction(input.action)) throw new Error('action 非法');
    const requestId = requireOpaque(input.requestId, 'requestId');
    const originDeviceId = requireOpaque(input.originDeviceId, 'originDeviceId');
    const idempotencyKey = requireOpaque(input.idempotencyKey, 'Idempotency-Key', 200);
    if (idempotencyKey.length < 8) throw new Error('Idempotency-Key 至少 8 字符');
    const round = input.round === undefined ? undefined : requirePositiveInteger(input.round, 'round');
    const requestJson = canonicalRequestJson(input.requestBody);
    // round 只有 regenerate 才是客户端业务意图。turn 的 round 由服务端会话状态分配，
    // 同一 Idempotency-Key 重试时它可能已随首个 executor 前进，不能据此误判请求冲突。
    // action/session 已进入幂等作用域；其余执行参数全部来自规范化 requestBody。
    const intentRound = input.action === 'regenerate' ? round : undefined;
    const requestHash = sha256(`${intentRound ?? 'null'}\n${requestJson}`);
    const keyDigest = sha256(idempotencyKey);
    const now = canonicalTimestamp(this.#now());
    const expiresAt = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
    const uuidHex = this.#randomId().replaceAll('-', '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(uuidHex)) throw new Error('TurnJobManager 随机源必须返回 UUID');
    const runId = `tjob_${uuidHex}`;

    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const existingBinding = this.#db.prepare(`
        SELECT request_hash, run_id FROM turn_job_idempotency
        WHERE origin_device_id = ? AND action = ? AND session_id = ? AND key_digest = ?
      `).get(originDeviceId, input.action, sessionId, keyDigest) as SqlRow | undefined;
      if (existingBinding) {
        const existingRunId = String(existingBinding.run_id);
        if (existingBinding.request_hash !== requestHash) {
          throw new TurnJobConflictError(
            'idempotency-conflict',
            '相同 Idempotency-Key 已绑定不同请求',
            existingRunId,
          );
        }
        const existing = this.#getJobRow(existingRunId);
        if (!existing) throw new Error('幂等记录引用的 turn job 不存在');
        this.#db.exec('COMMIT;');
        return { job: parseJob(existing), replayed: true };
      }

      const active = this.#db.prepare(`
        SELECT run_id FROM turn_job
        WHERE session_id = ? AND status IN ('queued','running','recovering')
        LIMIT 1
      `).get(sessionId) as SqlRow | undefined;
      if (active) {
        throw new TurnJobConflictError(
          'session-turn-active',
          '该会话已有活动生成任务',
          String(active.run_id),
        );
      }

      this.#db.prepare(`
        INSERT INTO turn_job
          (run_id, session_id, action, request_id, origin_device_id, status,
           request_hash, request_json, round, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 1)
      `).run(
        runId, sessionId, input.action, requestId, originDeviceId,
        requestHash, requestJson, round ?? null, now, now,
      );
      this.#db.prepare(`
        INSERT INTO turn_job_idempotency
          (origin_device_id, action, session_id, key_digest, request_hash, run_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(originDeviceId, input.action, sessionId, keyDigest, requestHash, runId, now, expiresAt);
      const created = this.#getJobRow(runId);
      if (!created) throw new Error('新建 turn job 无法读回');
      this.#db.exec('COMMIT;');
      return { job: parseJob(created), replayed: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      if (error instanceof TurnJobConflictError) throw error;
      if (isConstraintError(error)) {
        const active = this.getActiveForSession(sessionId);
        if (active) {
          throw new TurnJobConflictError('session-turn-active', '该会话已有活动生成任务', active.runId);
        }
      }
      throw error;
    }
  }

  get(runId: string): PublicTurnJob | null {
    this.#assertOpen();
    const row = this.#getJobRow(requireOpaque(runId, 'runId'));
    return row ? parseJob(row) : null;
  }

  /** 仅供可信服务端 runner 使用；不得把 requestBody/originDeviceId 投影到 API。 */
  getExecution(runId: string): TurnJobExecutionRecord | null {
    this.#assertOpen();
    const row = this.#getJobRow(requireOpaque(runId, 'runId'));
    if (!row) return null;
    const requestBody = JSON.parse(String(row.request_json)) as unknown;
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      throw new Error('turn job request_json 已损坏');
    }
    return {
      job: parseJob(row),
      originDeviceId: requireOpaque(row.origin_device_id, 'origin_device_id'),
      requestBody: requestBody as Record<string, unknown>,
      ...(row.commit_fence_at == null
        ? {}
        : { commitFenceAt: canonicalTimestamp(String(row.commit_fence_at)) }),
      ...(row.lease_owner_instance_id == null
        && row.lease_expires_at == null
        && row.lease_heartbeat_at == null
        ? {}
        : {
            lease: {
              ownerInstanceId: requireOpaque(row.lease_owner_instance_id, 'lease_owner_instance_id'),
              expiresAt: canonicalTimestamp(String(row.lease_expires_at)),
              heartbeatAt: canonicalTimestamp(String(row.lease_heartbeat_at)),
            },
          }),
    };
  }

  listActiveExecutions(): TurnJobExecutionRecord[] {
    this.#assertOpen();
    const rows = this.#db.prepare(`
      SELECT run_id FROM turn_job
      WHERE status IN ('queued','running','recovering')
      ORDER BY created_at, run_id
    `).all() as SqlRow[];
    return rows.map((row) => {
      const record = this.getExecution(String(row.run_id));
      if (!record) throw new Error('活动 turn job 在读取中消失');
      return record;
    });
  }

  /** queued job 必须连同 owner/expiry 一次 CAS 领取后，才允许产生 Provider 副作用。 */
  claimExecution(
    runIdValue: string,
    ownerInstanceIdValue: string,
    leaseDurationMs = DEFAULT_TURN_JOB_LEASE_MS,
  ): TurnJobExecutionRecord {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const ownerInstanceId = requireOpaque(ownerInstanceIdValue, 'ownerInstanceId');
    const duration = requireLeaseDuration(leaseDurationMs);
    const row = this.#getJobRow(runId);
    if (!row) throw new Error('turn job 不存在');
    const current = parseJob(row);
    if (current.status !== 'queued') {
      throw new TurnJobConflictError('transition-conflict', `只有 queued job 可以领取，当前为 ${current.status}`, runId);
    }
    if (current.cancelRequestedAt) {
      throw new TurnJobConflictError('transition-conflict', '已取消的 turn job 不得领取执行 lease', runId);
    }
    const now = canonicalTimestamp(this.#now());
    const expiresAt = new Date(Date.parse(now) + duration).toISOString();
    const result = this.#db.prepare(`
      UPDATE turn_job
      SET status = 'running', updated_at = ?, started_at = COALESCE(started_at, ?),
          lease_owner_instance_id = ?, lease_expires_at = ?, lease_heartbeat_at = ?,
          version = version + 1
      WHERE run_id = ? AND version = ? AND status = 'queued' AND cancel_requested_at IS NULL
    `).run(now, now, ownerInstanceId, expiresAt, now, runId, current.version);
    if (result.changes !== 1) {
      throw new TurnJobConflictError('transition-conflict', 'turn job lease 领取竞争失败', runId);
    }
    const claimed = this.getExecution(runId);
    if (!claimed?.lease) throw new Error('turn job lease 写入后无法读回');
    return claimed;
  }

  renewLease(
    runIdValue: string,
    ownerInstanceIdValue: string,
    leaseDurationMs = DEFAULT_TURN_JOB_LEASE_MS,
  ): TurnJobExecutionRecord {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const ownerInstanceId = requireOpaque(ownerInstanceIdValue, 'ownerInstanceId');
    const duration = requireLeaseDuration(leaseDurationMs);
    const now = canonicalTimestamp(this.#now());
    const expiresAt = new Date(Date.parse(now) + duration).toISOString();
    const result = this.#db.prepare(`
      UPDATE turn_job
      SET updated_at = ?, lease_expires_at = ?, lease_heartbeat_at = ?, version = version + 1
      WHERE run_id = ? AND status = 'running' AND lease_owner_instance_id = ?
    `).run(now, expiresAt, now, runId, ownerInstanceId);
    if (result.changes !== 1) {
      throw new TurnJobConflictError('transition-conflict', 'turn job lease 续租失败或 owner 已变化', runId);
    }
    const renewed = this.getExecution(runId);
    if (!renewed?.lease) throw new Error('续租后的 turn job 无法读回');
    return renewed;
  }

  /**
   * 最终会话写入前的持久提交栅栏。
   * 取消先到则拒绝；栅栏先到后，迟到取消只能读取状态，不能再中止 executor 或改写终态。
   */
  acquireCommitFence(runIdValue: string, ownerInstanceIdValue: string): TurnJobExecutionRecord {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const ownerInstanceId = requireOpaque(ownerInstanceIdValue, 'ownerInstanceId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#getJobRow(runId);
      if (!row) throw new Error('turn job 不存在');
      const current = parseJob(row);
      if (current.status !== 'running' && current.status !== 'recovering') {
        throw new TurnJobConflictError('commit-fence-conflict', `当前状态 ${current.status} 不能获取提交栅栏`, runId);
      }
      if (current.cancelRequestedAt) {
        throw new TurnJobConflictError('commit-fence-conflict', '取消请求已先于提交栅栏生效', runId);
      }
      const now = canonicalTimestamp(this.#now());
      if (row.lease_owner_instance_id !== ownerInstanceId
        || row.lease_expires_at == null
        || Date.parse(String(row.lease_expires_at)) <= Date.parse(now)) {
        throw new TurnJobConflictError('commit-fence-conflict', '执行 lease 已失效或 owner 不匹配', runId);
      }
      if (row.commit_fence_at == null) {
        const result = this.#db.prepare(`
          UPDATE turn_job
          SET commit_fence_at = ?, updated_at = ?, version = version + 1
          WHERE run_id = ? AND version = ? AND status = ?
            AND cancel_requested_at IS NULL AND commit_fence_at IS NULL
            AND lease_owner_instance_id = ? AND lease_expires_at > ?
        `).run(now, now, runId, current.version, current.status, ownerInstanceId, now);
        if (result.changes !== 1) {
          throw new TurnJobConflictError('commit-fence-conflict', '提交栅栏获取竞争失败', runId);
        }
      }
      const updated = this.getExecution(runId);
      if (!updated?.commitFenceAt) throw new Error('提交栅栏写入后无法读回');
      this.#db.exec('COMMIT;');
      return updated;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  /** 根据会话数据库中的持久 outcome marker 收敛成功；可在崩溃恢复时安全重放。 */
  completeFromOutcome(outcome: TurnJobCommittedOutcome): PublicTurnJob {
    this.#assertOpen();
    const runId = requireOpaque(outcome.runId, 'runId');
    const sessionId = requireOpaque(outcome.sessionId, 'sessionId');
    if (!isTurnJobAction(outcome.action)) throw new Error('outcome action 非法');
    const round = requirePositiveInteger(outcome.round, 'outcome round');
    const assistantMessageId = requirePositiveInteger(outcome.assistantMessageId, 'assistantMessageId');
    const revision = requireOpaque(outcome.revision, 'revision');
    const row = this.#getJobRow(runId);
    if (!row) throw new Error('turn job 不存在');
    const current = parseJob(row);
    if (current.sessionId !== sessionId || current.action !== outcome.action) {
      throw new TurnJobConflictError('commit-fence-conflict', 'outcome marker 与 turn job 身份不匹配', runId);
    }
    if (current.round !== undefined && current.round !== round) {
      throw new TurnJobConflictError('commit-fence-conflict', 'outcome marker 轮次不匹配', runId);
    }
    if (current.status === 'succeeded') {
      if (
        current.result?.assistantMessageId !== assistantMessageId
        || current.result?.revision !== revision
      ) {
        throw new TurnJobConflictError('commit-fence-conflict', '成功任务已绑定不同结果', runId);
      }
      return current;
    }
    if (row.commit_fence_at == null) {
      throw new TurnJobConflictError('commit-fence-conflict', '缺少持久提交栅栏', runId);
    }
    return this.transition({
      runId,
      expectedVersion: current.version,
      to: 'succeeded',
      assistantMessageId,
      resultRevision: revision,
    });
  }

  getActiveForSession(sessionId: string): PublicTurnJob | null {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT * FROM turn_job
      WHERE session_id = ? AND status IN ('queued','running','recovering')
      LIMIT 1
    `).get(requireOpaque(sessionId, 'sessionId')) as SqlRow | undefined;
    return row ? parseJob(row) : null;
  }

  transition(input: TransitionTurnJobInput): PublicTurnJob {
    this.#assertOpen();
    const runId = requireOpaque(input.runId, 'runId');
    const expectedVersion = requirePositiveInteger(input.expectedVersion, 'expectedVersion');
    if (!isTurnJobStatus(input.to)) throw new Error('目标状态非法');
    if (input.to === 'running') throw new Error('running 必须通过 claimExecution 获取 lease');
    if (input.to === 'recovering') throw new Error('recovering 只能由 recoverExpired 进入');
    const currentRow = this.#getJobRow(runId);
    if (!currentRow) throw new Error('turn job 不存在');
    const current = parseJob(currentRow);
    if (current.version !== expectedVersion || !LEGAL_TRANSITIONS[current.status].includes(input.to)) {
      throw new TurnJobConflictError('transition-conflict', 'turn job 状态迁移冲突', runId);
    }
    const leaseOwnerInstanceId = input.leaseOwnerInstanceId === undefined
      ? undefined
      : requireOpaque(input.leaseOwnerInstanceId, 'leaseOwnerInstanceId');
    if (leaseOwnerInstanceId !== undefined && currentRow.lease_owner_instance_id !== leaseOwnerInstanceId) {
      throw new TurnJobConflictError('transition-conflict', 'turn job lease owner 已变化', runId);
    }
    const errorCode = input.publicErrorCode === undefined
      ? null
      : requireOpaque(input.publicErrorCode, 'publicErrorCode', 80);
    const assistantMessageId = input.assistantMessageId === undefined
      ? null
      : requirePositiveInteger(input.assistantMessageId, 'assistantMessageId');
    const resultRevision = input.resultRevision === undefined
      ? null
      : requireOpaque(input.resultRevision, 'resultRevision');
    if (input.to === 'failed' ? errorCode === null : errorCode !== null) {
      throw new Error('publicErrorCode 只允许且必须用于 failed');
    }
    if (input.to === 'succeeded') {
      if (assistantMessageId === null && resultRevision === null) throw new Error('succeeded 必须包含结果引用');
      if (currentRow.commit_fence_at == null) {
        throw new TurnJobConflictError('commit-fence-conflict', '缺少持久提交栅栏', runId);
      }
    } else if (assistantMessageId !== null || resultRevision !== null) {
      throw new Error('结果引用只允许用于 succeeded');
    }
    if (input.to === 'cancelled' && currentRow.commit_fence_at != null) {
      throw new TurnJobConflictError('commit-fence-conflict', '提交栅栏后不得改写为 cancelled', runId);
    }
    const now = canonicalTimestamp(this.#now());
    const terminal = input.to === 'succeeded' || input.to === 'failed' || input.to === 'cancelled';
    const result = this.#db.prepare(`
      UPDATE turn_job
      SET status = ?, updated_at = ?,
          finished_at = CASE WHEN ? THEN ? ELSE NULL END,
          public_error_code = ?, assistant_message_id = ?, result_revision = ?,
          lease_owner_instance_id = CASE WHEN ? THEN NULL ELSE lease_owner_instance_id END,
          lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
          lease_heartbeat_at = CASE WHEN ? THEN NULL ELSE lease_heartbeat_at END,
          version = version + 1
      WHERE run_id = ? AND version = ? AND status = ?
    `).run(
      input.to, now, terminal ? 1 : 0, now,
      errorCode, assistantMessageId, resultRevision,
      terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0,
      runId, expectedVersion, current.status,
    );
    if (result.changes !== 1) {
      throw new TurnJobConflictError('transition-conflict', 'turn job 状态迁移竞争失败', runId);
    }
    const updated = this.#getJobRow(runId);
    if (!updated) throw new Error('更新后的 turn job 无法读回');
    return parseJob(updated);
  }

  /**
   * 进程重启后的保守恢复：只有 lease 已过期才接管。会话 outcome marker 必须由调用方先对账；
   * 此处只把没有成功 marker 的不确定 Provider 执行明确收敛为 failed/cancelled，绝不重放。
   */
  recoverExpired(
    runIdValue: string,
    publicErrorCode = 'server_restart_unrecoverable',
  ): RecoverExpiredTurnJobResult {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    const errorCode = requireOpaque(publicErrorCode, 'publicErrorCode', 80);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      let row = this.#getJobRow(runId);
      if (!row) throw new Error('turn job 不存在');
      let current = parseJob(row);
      if (current.status === 'queued'
        || current.status === 'succeeded'
        || current.status === 'failed'
        || current.status === 'cancelled') {
        this.#db.exec('COMMIT;');
        return { job: current, recovered: false };
      }
      const now = canonicalTimestamp(this.#now());
      if (row.lease_expires_at != null) {
        const nextAttemptAt = canonicalTimestamp(String(row.lease_expires_at));
        if (Date.parse(nextAttemptAt) > Date.parse(now)) {
          this.#db.exec('COMMIT;');
          return { job: current, recovered: false, nextAttemptAt };
        }
      }

      if (current.status === 'running') {
        const recovering = this.#db.prepare(`
          UPDATE turn_job
          SET status = 'recovering', updated_at = ?,
              lease_owner_instance_id = NULL, lease_expires_at = NULL, lease_heartbeat_at = NULL,
              version = version + 1
          WHERE run_id = ? AND version = ? AND status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `).run(now, runId, current.version, now);
        if (recovering.changes !== 1) {
          throw new TurnJobConflictError('transition-conflict', '过期 turn job 恢复竞争失败', runId);
        }
        row = this.#getJobRow(runId);
        if (!row) throw new Error('recovering turn job 无法读回');
        current = parseJob(row);
      }

      if (current.status !== 'recovering') {
        throw new TurnJobConflictError('transition-conflict', 'turn job 不在可恢复状态', runId);
      }
      const cancelled = current.cancelRequestedAt !== undefined && row.commit_fence_at == null;
      const terminal = this.#db.prepare(`
        UPDATE turn_job
        SET status = ?, updated_at = ?, finished_at = ?, public_error_code = ?,
            lease_owner_instance_id = NULL, lease_expires_at = NULL, lease_heartbeat_at = NULL,
            version = version + 1
        WHERE run_id = ? AND version = ? AND status = 'recovering'
      `).run(
        cancelled ? 'cancelled' : 'failed', now, now, cancelled ? null : errorCode,
        runId, current.version,
      );
      if (terminal.changes !== 1) {
        throw new TurnJobConflictError('transition-conflict', 'turn job 恢复终结竞争失败', runId);
      }
      const updated = this.#getJobRow(runId);
      if (!updated) throw new Error('恢复终结后的 turn job 无法读回');
      this.#db.exec('COMMIT;');
      return { job: parseJob(updated), recovered: true };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  /**
   * 显式取消请求。queued 可在尚无副作用时直接终结；running/recovering 只记录请求，
   * 由持有 job 自有 AbortController 的 runner 收敛到 cancelled。
   */
  requestCancel(runIdValue: string): RequestTurnJobCancelResult {
    this.#assertOpen();
    const runId = requireOpaque(runIdValue, 'runId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#getJobRow(runId);
      if (!row) throw new Error('turn job 不存在');
      const current = parseJob(row);
      if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') {
        this.#db.exec('COMMIT;');
        return { job: current, shouldAbortExecutor: false };
      }
      if (row.commit_fence_at != null) {
        this.#db.exec('COMMIT;');
        return { job: current, shouldAbortExecutor: false };
      }
      if (current.cancelRequestedAt) {
        this.#db.exec('COMMIT;');
        return {
          job: current,
          shouldAbortExecutor: current.status === 'running' || current.status === 'recovering',
        };
      }
      const now = canonicalTimestamp(this.#now());
      const queued = current.status === 'queued';
      const result = this.#db.prepare(`
        UPDATE turn_job
        SET cancel_requested_at = ?, updated_at = ?,
            status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            finished_at = CASE WHEN status = 'queued' THEN ? ELSE finished_at END,
            version = version + 1
        WHERE run_id = ? AND version = ? AND status = ?
      `).run(now, now, now, runId, current.version, current.status);
      if (result.changes !== 1) {
        throw new TurnJobConflictError('transition-conflict', 'turn job 取消请求竞争失败', runId);
      }
      const updated = this.#getJobRow(runId);
      if (!updated) throw new Error('取消后的 turn job 无法读回');
      this.#db.exec('COMMIT;');
      return { job: parseJob(updated), shouldAbortExecutor: !queued };
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  /**
   * Privacy cleanup for one exact session. Deleting the parent jobs lets the
   * existing foreign-key cascade remove every associated idempotency binding.
   */
  deleteSession(sessionIdValue: string): TurnJobSessionDeleteResult {
    this.#assertOpen();
    const sessionId = requireOpaque(sessionIdValue, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const bindingRow = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM turn_job_idempotency WHERE session_id = ?
      `).get(sessionId) as { count: number };
      const deletedJobs = Number(this.#db.prepare(
        'DELETE FROM turn_job WHERE session_id = ?',
      ).run(sessionId).changes);
      const deletedIdempotencyBindings = Number(bindingRow.count);
      const remaining = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM turn_job_idempotency WHERE session_id = ?
      `).get(sessionId) as { count: number };
      if (Number(remaining.count) !== 0) throw new Error('turn job 会话清理未级联删除幂等绑定');
      this.#db.exec('COMMIT;');
      return Object.freeze({ deletedJobs, deletedIdempotencyBindings });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #getJobRow(runId: string): SqlRow | undefined {
    return this.#db.prepare('SELECT * FROM turn_job WHERE run_id = ?').get(runId) as SqlRow | undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('TurnJobManager 已关闭');
  }
}
