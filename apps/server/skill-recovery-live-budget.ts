import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';

/** One SQLite file is one frozen A16 batch. Its location is host-owned, never caller-selected. */
export interface SkillRecoveryLiveBatchBinding {
  readonly fixtureDigest: string;
  readonly sessionDigest: string;
  readonly configDigest: string;
  readonly codeDigest: string;
  readonly maxRuns: number;
  readonly maxModelCalls: number;
  readonly maxCostMicrousd: number;
}
export interface SkillRecoveryLiveBudgetSnapshot extends SkillRecoveryLiveBatchBinding {
  readonly batchId: string;
  readonly calls: number;
  /** Settled actual cost plus the full reservation for every unresolved call. */
  readonly chargedMicrousd: number;
  readonly runs: readonly Readonly<{ runId: string; ordinal: number; status: 'active' | 'passed' | 'failed'; calls: number }>[];
}
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_RUNS = 3, MAX_CALLS_PER_RUN = 12, MAX_CALLS = 36;

function binding(input: SkillRecoveryLiveBatchBinding): SkillRecoveryLiveBatchBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('skill-recovery-batch-binding-invalid');
  const fields = Object.getOwnPropertyDescriptors(input);
  const names = ['fixtureDigest', 'sessionDigest', 'configDigest', 'codeDigest', 'maxRuns', 'maxModelCalls', 'maxCostMicrousd'];
  if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !fields[name]?.enumerable
    || !Object.hasOwn(fields[name]!, 'value'))) throw new Error('skill-recovery-batch-binding-invalid');
  for (const name of names.slice(0, 4)) {
    if (typeof fields[name]!.value !== 'string' || !DIGEST.test(fields[name]!.value)) {
      throw new Error('skill-recovery-batch-binding-invalid');
    }
  }
  const maxCostMicrousd: unknown = fields.maxCostMicrousd!.value;
  if (!Number.isSafeInteger(maxCostMicrousd) || (maxCostMicrousd as number) < 1) throw new Error('skill-recovery-batch-cost-invalid');
  const maxRuns: unknown = fields.maxRuns!.value, maxModelCalls: unknown = fields.maxModelCalls!.value;
  if (!Number.isSafeInteger(maxRuns) || (maxRuns as number) < 1 || (maxRuns as number) > MAX_RUNS
    || !Number.isSafeInteger(maxModelCalls) || (maxModelCalls as number) < 1 || (maxModelCalls as number) > MAX_CALLS
    || (maxModelCalls as number) > (maxRuns as number) * MAX_CALLS_PER_RUN) throw new Error('skill-recovery-batch-limit-invalid');
  return Object.freeze({ fixtureDigest: fields.fixtureDigest!.value as string,
    sessionDigest: fields.sessionDigest!.value as string, configDigest: fields.configDigest!.value as string,
    codeDigest: fields.codeDigest!.value as string, maxRuns: maxRuns as number,
    maxModelCalls: maxModelCalls as number, maxCostMicrousd: maxCostMicrousd as number });
}
function id(value: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('skill-recovery-batch-id-invalid');
  return value;
}
function amount(value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('skill-recovery-batch-cost-invalid');
  return value;
}

export class SkillRecoveryLiveBudgetStore {
  private opened = false;
  private ownedRunId: string | null = null;
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_recovery_live_batch (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), batch_id TEXT NOT NULL UNIQUE,
      fixture_digest TEXT NOT NULL, session_digest TEXT NOT NULL, config_digest TEXT NOT NULL,
      code_digest TEXT NOT NULL, max_runs INTEGER NOT NULL CHECK(max_runs BETWEEN 1 AND 3),
      max_model_calls INTEGER NOT NULL CHECK(max_model_calls BETWEEN 1 AND 36),
      max_cost_microusd INTEGER NOT NULL CHECK(max_cost_microusd>0)
    );
    CREATE TABLE IF NOT EXISTS skill_recovery_live_run (
      run_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE CHECK(ordinal BETWEEN 1 AND 3),
      status TEXT NOT NULL CHECK(status IN ('active','passed','failed'))
    );
    CREATE TABLE IF NOT EXISTS skill_recovery_live_attempt (
      attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES skill_recovery_live_run(run_id),
      reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>0),
      actual_microusd INTEGER CHECK(actual_microusd>=0),
      status TEXT NOT NULL CHECK(status IN ('reserved','settled','unknown'))
    );`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ } throw error; }
  }
  openOrCreate(input: SkillRecoveryLiveBatchBinding): SkillRecoveryLiveBudgetSnapshot {
    this.opened = false;
    this.ownedRunId = null;
    const frozen = binding(input);
    const batchId = `sha256:${createHash('sha256').update(JSON.stringify({ version: 'skill-recovery-live-batch-v1',
      fixtureDigest: frozen.fixtureDigest, sessionDigest: frozen.sessionDigest }), 'utf8').digest('hex')}`;
    this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM skill_recovery_live_batch WHERE singleton=1').get() as Record<string, unknown> | undefined;
      if (!current) {
        this.db.prepare(`INSERT INTO skill_recovery_live_batch
          (singleton,batch_id,fixture_digest,session_digest,config_digest,code_digest,max_runs,max_model_calls,max_cost_microusd)
          VALUES (1,?,?,?,?,?,?,?,?)`).run(batchId, frozen.fixtureDigest, frozen.sessionDigest, frozen.configDigest,
          frozen.codeDigest, frozen.maxRuns, frozen.maxModelCalls, frozen.maxCostMicrousd);
      } else if (current.batch_id !== batchId || current.fixture_digest !== frozen.fixtureDigest
        || current.session_digest !== frozen.sessionDigest || current.config_digest !== frozen.configDigest
        || current.code_digest !== frozen.codeDigest || current.max_runs !== frozen.maxRuns
        || current.max_model_calls !== frozen.maxModelCalls || current.max_cost_microusd !== frozen.maxCostMicrousd) {
        throw new Error('skill-recovery-batch-binding-mismatch');
      }
    });
    this.opened = true;
    return this.snapshot();
  }
  startRun(runId: string): number {
    id(runId);
    const ordinal = this.transaction(() => {
      const batch = this.requireBatch();
      const runs = this.db.prepare('SELECT run_id,ordinal,status FROM skill_recovery_live_run ORDER BY ordinal').all() as
        Array<{ run_id: string; ordinal: number; status: string }>;
      if (runs.some(run => run.run_id === runId)) throw new Error('skill-recovery-run-replay-forbidden');
      if (runs.some(run => run.status === 'failed')) throw new Error('skill-recovery-batch-failed');
      if (runs.some(run => run.status === 'active')) throw new Error('skill-recovery-run-unresolved');
      if (runs.length >= batch.max_runs) throw new Error('skill-recovery-run-limit');
      const ordinal = runs.length + 1;
      this.db.prepare("INSERT INTO skill_recovery_live_run(run_id,ordinal,status) VALUES (?,?,'active')").run(runId, ordinal);
      return ordinal;
    });
    this.ownedRunId = runId;
    return ordinal;
  }
  /** Called once immediately before each physical adapter dispatch, after all local preflight. */
  reserveDispatch(runId: string, attemptId: string, maxCostMicrousd: number): void {
    id(runId); id(attemptId); amount(maxCostMicrousd);
    if (this.ownedRunId !== runId) throw new Error('skill-recovery-run-replay-forbidden');
    this.transaction(() => {
      const batch = this.requireBatch();
      const run = this.db.prepare('SELECT status FROM skill_recovery_live_run WHERE run_id=?').get(runId) as { status: string } | undefined;
      if (!run || run.status !== 'active') throw new Error('skill-recovery-run-not-active');
      if (this.db.prepare('SELECT 1 FROM skill_recovery_live_attempt WHERE attempt_id=?').get(attemptId)) throw new Error('skill-recovery-attempt-replay-forbidden');
      const runCount = (this.db.prepare('SELECT COUNT(*) count FROM skill_recovery_live_attempt WHERE run_id=?').get(runId) as { count: number }).count;
      const totals = this.db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(COALESCE(actual_microusd,reserved_microusd)),0) cost,
        COALESCE(SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END),0) pending FROM skill_recovery_live_attempt`).get() as
        { count: number; cost: number; pending: number };
      if (totals.pending !== 0) throw new Error('skill-recovery-attempt-unresolved');
      if (runCount >= MAX_CALLS_PER_RUN || totals.count >= batch.max_model_calls) throw new Error('skill-recovery-call-limit');
      if (!Number.isSafeInteger(totals.cost) || totals.cost > batch.max_cost_microusd - maxCostMicrousd) {
        throw new Error('skill-recovery-batch-cost-exceeded');
      }
      this.db.prepare(`INSERT INTO skill_recovery_live_attempt(attempt_id,run_id,reserved_microusd,status)
        VALUES (?,?,?,'reserved')`).run(attemptId, runId, maxCostMicrousd);
    });
  }
  settleDispatch(runId: string, attemptId: string, actualCostMicrousd: number): void {
    id(runId); id(attemptId); amount(actualCostMicrousd, true);
    if (this.ownedRunId !== runId) throw new Error('skill-recovery-run-replay-forbidden');
    const exceeded = this.transaction(() => {
      this.requireBatch();
      const entry = this.db.prepare('SELECT * FROM skill_recovery_live_attempt WHERE attempt_id=?').get(attemptId) as
        { run_id: string; status: string; reserved_microusd: number } | undefined;
      const active = this.db.prepare('SELECT status FROM skill_recovery_live_run WHERE run_id=?').get(runId) as { status: string } | undefined;
      if (!entry || entry.run_id !== runId || entry.status !== 'reserved' || active?.status !== 'active') throw new Error('skill-recovery-attempt-settlement-invalid');
      this.db.prepare("UPDATE skill_recovery_live_attempt SET actual_microusd=?,status='settled' WHERE attempt_id=?")
        .run(actualCostMicrousd, attemptId);
      if (actualCostMicrousd > entry.reserved_microusd) {
        this.db.prepare("UPDATE skill_recovery_live_run SET status='failed' WHERE run_id=?").run(runId);
        return true;
      }
      return false;
    });
    if (exceeded) throw new Error('skill-recovery-attempt-cost-exceeded');
  }
  markUnknown(runId: string, attemptId: string): void {
    id(runId); id(attemptId);
    this.transaction(() => {
      this.requireBatch();
      const entry = this.db.prepare('SELECT run_id,status FROM skill_recovery_live_attempt WHERE attempt_id=?').get(attemptId) as
        { run_id: string; status: string } | undefined;
      if (!entry || entry.run_id !== runId || entry.status !== 'reserved') throw new Error('skill-recovery-attempt-unknown-invalid');
      this.db.prepare("UPDATE skill_recovery_live_attempt SET status='unknown' WHERE attempt_id=?").run(attemptId);
      this.db.prepare("UPDATE skill_recovery_live_run SET status='failed' WHERE run_id=? AND status='active'").run(runId);
    });
    if (this.ownedRunId === runId) this.ownedRunId = null;
  }
  finishRun(runId: string, status: 'passed' | 'failed'): void {
    id(runId);
    if (this.ownedRunId !== runId) throw new Error('skill-recovery-run-replay-forbidden');
    if (status !== 'passed' && status !== 'failed') throw new Error('skill-recovery-run-status-invalid');
    this.transaction(() => {
      this.requireBatch();
      const run = this.db.prepare('SELECT status FROM skill_recovery_live_run WHERE run_id=?').get(runId) as { status: string } | undefined;
      if (!run || run.status !== 'active') throw new Error('skill-recovery-run-not-active');
      const unresolved = this.db.prepare("SELECT 1 FROM skill_recovery_live_attempt WHERE run_id=? AND status='reserved' LIMIT 1").get(runId);
      if (status === 'passed' && unresolved) throw new Error('skill-recovery-attempt-unresolved');
      if (status === 'passed' && !this.db.prepare('SELECT 1 FROM skill_recovery_live_attempt WHERE run_id=? LIMIT 1').get(runId)) {
        throw new Error('skill-recovery-run-no-dispatch');
      }
      this.db.prepare('UPDATE skill_recovery_live_run SET status=? WHERE run_id=?').run(status, runId);
    });
    this.ownedRunId = null;
  }
  private requireBatch(): { max_cost_microusd: number; max_runs: number; max_model_calls: number } {
    if (!this.opened) throw new Error('skill-recovery-batch-not-open');
    const row = this.db.prepare('SELECT max_cost_microusd,max_runs,max_model_calls FROM skill_recovery_live_batch WHERE singleton=1').get() as
      { max_cost_microusd: number; max_runs: number; max_model_calls: number } | undefined;
    if (!row) throw new Error('skill-recovery-batch-not-open');
    return row;
  }
  snapshot(): SkillRecoveryLiveBudgetSnapshot {
    this.requireBatch();
    const row = this.db.prepare('SELECT * FROM skill_recovery_live_batch WHERE singleton=1').get() as Record<string, unknown> | undefined;
    if (!row) throw new Error('skill-recovery-batch-not-open');
    const totals = this.db.prepare('SELECT COUNT(*) count, COALESCE(SUM(COALESCE(actual_microusd,reserved_microusd)),0) cost FROM skill_recovery_live_attempt').get() as
      { count: number; cost: number };
    const runs = this.db.prepare(`SELECT r.run_id,r.ordinal,r.status,COUNT(a.attempt_id) calls
      FROM skill_recovery_live_run r LEFT JOIN skill_recovery_live_attempt a ON a.run_id=r.run_id
      GROUP BY r.run_id,r.ordinal,r.status ORDER BY r.ordinal`).all() as
      Array<{ run_id: string; ordinal: number; status: 'active' | 'passed' | 'failed'; calls: number }>;
    return Object.freeze({ batchId: row.batch_id as string, fixtureDigest: row.fixture_digest as string,
      sessionDigest: row.session_digest as string, configDigest: row.config_digest as string,
      codeDigest: row.code_digest as string, maxRuns: row.max_runs as number,
      maxModelCalls: row.max_model_calls as number, maxCostMicrousd: row.max_cost_microusd as number,
      calls: totals.count, chargedMicrousd: totals.cost,
      runs: Object.freeze(runs.map(run => Object.freeze({ runId: run.run_id, ordinal: run.ordinal, status: run.status, calls: run.calls }))) });
  }
}
