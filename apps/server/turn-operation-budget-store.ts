import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { normalizeTurnOperationBudget, turnOperationBudgetDigest, type TurnOperationBudgetV3 }
  from '../../packages/agent-policy/public/turn-operation-budget.ts';
import { sqliteTransaction } from './sqlite-transaction.ts';

export interface TurnBudgetReservation {
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly modelId: string;
  readonly providerId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}
export interface TurnBudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}
export interface TurnBudgetHold {
  readonly holdId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}
type Row = Record<string, string | number | null>;
function ownData(value: unknown, keys: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || (!keys.includes(key) && !optional.includes(key)))
    || keys.some((key) => !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
    || optional.some((key) => Object.hasOwn(value, key) && (!Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')))) {
    throw new Error('turn-operation-fields-invalid');
  }
}
function integer(value: unknown, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`turn-operation-${name}-invalid`);
  return value as number;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error('turn-operation-identity-invalid');
  }
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('turn-operation-digest-invalid');
  return value;
}
function modelBinding(profile: TurnOperationBudgetV3, modelId: string, providerId: string | undefined) {
  if (profile.modelBindings) {
    if (!providerId) throw new Error('turn-operation-provider-required');
    const binding = profile.modelBindings.find((row) => row.modelId === modelId && row.providerId === providerId);
    if (!binding) throw new Error('turn-operation-model-mismatch');
    return binding;
  }
  // A legacy single-model profile has no provider identity; it cannot claim one.
  if (providerId) throw new Error('turn-operation-provider-unbound');
  if (modelId !== profile.modelId) throw new Error('turn-operation-model-mismatch');
  return profile;
}

/** Persistent parent-operation accounting on the caller's existing SQLite database. */
export class TurnOperationBudgetStore {
  constructor(private readonly db: DatabaseSync, private readonly nowMs: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_operation_budget_v3 (
      operation_id TEXT PRIMARY KEY, profile_digest TEXT NOT NULL, profile_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS turn_operation_attempt_v3 (
      operation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_digest TEXT NOT NULL,
      model_id TEXT NOT NULL, reserved_input INTEGER NOT NULL, reserved_output INTEGER NOT NULL,
      reserved_cost INTEGER NOT NULL, status TEXT NOT NULL,
      actual_input INTEGER, actual_output INTEGER, actual_cost INTEGER, hold_id TEXT, provider_id TEXT,
      PRIMARY KEY(operation_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS turn_operation_hold_v3 (
      operation_id TEXT NOT NULL, hold_id TEXT NOT NULL, calls INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_microusd INTEGER NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY(operation_id, hold_id)
    );`);
    sqliteTransaction(db, () => {
      const columns = db.prepare('PRAGMA table_info(turn_operation_attempt_v3)').all() as Row[];
      if (!columns.some((column) => column.name === 'provider_id')) {
        db.exec('ALTER TABLE turn_operation_attempt_v3 ADD COLUMN provider_id TEXT');
      }
    }, true, 'turn-operation');
  }

  create(input: TurnOperationBudgetV3): void {
    const profile = normalizeTurnOperationBudget(input);
    const hash = turnOperationBudgetDigest(profile);
    sqliteTransaction(this.db, () => {
      const current = this.db.prepare('SELECT profile_digest,status FROM turn_operation_budget_v3 WHERE operation_id=?').get(profile.operationId) as Row | undefined;
      if (current) {
        if (current.profile_digest !== hash) throw new Error('turn-operation-profile-conflict');
        if (current.status !== 'active') throw new Error('turn-operation-not-active');
        return;
      }
      if (this.nowMs() >= profile.deadlineMs) throw new Error('turn-operation-deadline-exhausted');
      this.db.prepare('INSERT INTO turn_operation_budget_v3(operation_id,profile_digest,profile_json) VALUES(?,?,?)').run(profile.operationId, hash, JSON.stringify(profile));
    }, true, 'turn-operation');
  }

  /** A new run and all completion/repair reservations become visible atomically.
   * Existing operations are never reopened, including after a process restart. */
  createWithHolds(input: TurnOperationBudgetV3, holds: readonly TurnBudgetHold[]): void {
    const profile = normalizeTurnOperationBudget(input);
    if (!Array.isArray(holds) || types.isProxy(holds) || holds.length > 12
      || Reflect.ownKeys(holds).some((key) => key !== 'length' && (typeof key !== 'string'
        || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= holds.length))) {
      throw new Error('turn-operation-holds-invalid');
    }
    const normalized: TurnBudgetHold[] = [];
    const ids = new Set<string>();
    let calls = 0, inputTokens = 0, outputTokens = 0, costMicrousd = 0;
    for (let i = 0; i < holds.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(holds, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('turn-operation-holds-invalid');
      const raw = descriptor.value as TurnBudgetHold;
      ownData(raw, ['holdId', 'calls', 'inputTokens', 'outputTokens', 'costMicrousd']);
      const item = { holdId: identity(raw.holdId), calls: integer(raw.calls, 'calls', 1),
        inputTokens: integer(raw.inputTokens, 'input', 1), outputTokens: integer(raw.outputTokens, 'output', 1),
        costMicrousd: integer(raw.costMicrousd, 'cost') };
      if (ids.has(item.holdId)) throw new Error('turn-operation-hold-conflict');
      ids.add(item.holdId); normalized.push(item);
      calls += item.calls; inputTokens += item.inputTokens; outputTokens += item.outputTokens; costMicrousd += item.costMicrousd;
      integer(calls, 'calls'); integer(inputTokens, 'input'); integer(outputTokens, 'output'); integer(costMicrousd, 'cost');
    }
    if (calls > profile.maxModelCalls || inputTokens > profile.totalInputTokens
      || outputTokens > profile.totalOutputTokens || costMicrousd > profile.totalCostMicrousd) {
      throw new Error('turn-operation-budget-exhausted');
    }
    sqliteTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM turn_operation_budget_v3 WHERE operation_id=?').get(profile.operationId)) {
        throw new Error('turn-operation-profile-conflict');
      }
      if (this.nowMs() >= profile.deadlineMs) throw new Error('turn-operation-deadline-exhausted');
      this.db.prepare('INSERT INTO turn_operation_budget_v3(operation_id,profile_digest,profile_json) VALUES(?,?,?)')
        .run(profile.operationId, turnOperationBudgetDigest(profile), JSON.stringify(profile));
      const insert = this.db.prepare("INSERT INTO turn_operation_hold_v3 VALUES(?,?,?,?,?,?,'active')");
      for (const item of normalized) insert.run(profile.operationId, item.holdId, item.calls,
        item.inputTokens, item.outputTokens, item.costMicrousd);
    }, true, 'turn-operation');
  }

  /** End once, conservatively retaining any attempt whose dispatch status is uncertain. */
  end(operationId: string): void {
    sqliteTransaction(this.db, () => {
      this.profile(operationId);
      const row = this.db.prepare('SELECT status FROM turn_operation_budget_v3 WHERE operation_id=?').get(operationId) as Row | undefined;
      if (row?.status === 'ended') return;
      if (!row || !['active', 'exhausted'].includes(String(row.status))) throw new Error('turn-operation-not-active');
      // A caller may have crossed the transport boundary without durably marking it.
      // Preserve the full reservation rather than implicitly refunding a started call.
      this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='unknown' WHERE operation_id=? AND status IN ('reserved','dispatched')")
        .run(operationId);
      this.db.prepare("UPDATE turn_operation_hold_v3 SET status='released' WHERE operation_id=? AND status='active'")
        .run(operationId);
      const result = this.db.prepare("UPDATE turn_operation_budget_v3 SET status='ended' WHERE operation_id=? AND status IN ('active','exhausted')")
        .run(operationId);
      if (Number(result.changes) !== 1) throw new Error('turn-operation-end-conflict');
    }, true, 'turn-operation');
  }

  private profile(operationId: string): TurnOperationBudgetV3 {
    const row = this.db.prepare('SELECT profile_json,profile_digest FROM turn_operation_budget_v3 WHERE operation_id=?').get(identity(operationId)) as Row | undefined;
    if (!row || typeof row.profile_json !== 'string') throw new Error('turn-operation-missing');
    const profile = normalizeTurnOperationBudget(JSON.parse(row.profile_json));
    if (turnOperationBudgetDigest(profile) !== row.profile_digest) throw new Error('turn-operation-profile-corrupt');
    return profile;
  }

  private assertActive(operationId: string): void {
    const row = this.db.prepare('SELECT status FROM turn_operation_budget_v3 WHERE operation_id=?').get(operationId) as Row | undefined;
    if (!row || row.status !== 'active') throw new Error('turn-operation-not-active');
  }

  snapshot(operationId: string): Readonly<{ calls: number; inputTokens: number; outputTokens: number; costMicrousd: number }> {
    this.profile(operationId);
    const rows = this.db.prepare('SELECT * FROM turn_operation_attempt_v3 WHERE operation_id=? AND status<>?').all(operationId, 'released') as Row[];
    let inputTokens = 0, outputTokens = 0, costMicrousd = 0;
    for (const row of rows) {
      if (!['reserved', 'dispatched', 'unknown', 'settled'].includes(String(row.status))) throw new Error('turn-operation-status-invalid');
      const settled = row.status === 'settled';
      inputTokens += integer(settled ? row.actual_input : row.reserved_input, 'input');
      outputTokens += integer(settled ? row.actual_output : row.reserved_output, 'output');
      costMicrousd += integer(settled ? row.actual_cost : row.reserved_cost, 'cost');
      integer(inputTokens, 'input'); integer(outputTokens, 'output'); integer(costMicrousd, 'cost');
    }
    const holds = this.db.prepare("SELECT * FROM turn_operation_hold_v3 WHERE operation_id=? AND status='active'").all(operationId) as Row[];
    let calls = rows.length;
    for (const hold of holds) {
      calls += integer(hold.calls, 'calls'); inputTokens += integer(hold.input_tokens, 'input');
      outputTokens += integer(hold.output_tokens, 'output'); costMicrousd += integer(hold.cost_microusd, 'cost');
      integer(calls, 'calls'); integer(inputTokens, 'input'); integer(outputTokens, 'output'); integer(costMicrousd, 'cost');
    }
    return Object.freeze({ calls, inputTokens, outputTokens, costMicrousd });
  }

  hold(operationId: string, hold: TurnBudgetHold): void {
    ownData(hold, ['holdId', 'calls', 'inputTokens', 'outputTokens', 'costMicrousd']);
    const holdId = identity(hold.holdId), calls = integer(hold.calls, 'calls', 1);
    const input = integer(hold.inputTokens, 'input', 1), output = integer(hold.outputTokens, 'output', 1);
    const cost = integer(hold.costMicrousd, 'cost');
    sqliteTransaction(this.db, () => {
      const profile = this.profile(operationId); this.assertActive(operationId);
      if (this.nowMs() >= profile.deadlineMs) throw new Error('turn-operation-deadline-exhausted');
      const existing = this.db.prepare('SELECT 1 FROM turn_operation_hold_v3 WHERE operation_id=? AND hold_id=?').get(operationId, holdId);
      if (existing) throw new Error('turn-operation-hold-conflict');
      const used = this.snapshot(operationId);
      if (used.calls + calls > profile.maxModelCalls || used.inputTokens + input > profile.totalInputTokens
        || used.outputTokens + output > profile.totalOutputTokens || used.costMicrousd + cost > profile.totalCostMicrousd) {
        throw new Error('turn-operation-budget-exhausted');
      }
      this.db.prepare("INSERT INTO turn_operation_hold_v3 VALUES(?,?,?,?,?,?,'active')")
        .run(operationId, holdId, calls, input, output, cost);
    }, true, 'turn-operation');
  }

  releaseHold(operationId: string, holdId: string): void {
    sqliteTransaction(this.db, () => {
      this.profile(operationId);
      const reserved = this.db.prepare("SELECT 1 FROM turn_operation_attempt_v3 WHERE operation_id=? AND hold_id=? AND status='reserved' LIMIT 1").get(operationId, identity(holdId));
      if (reserved) throw new Error('turn-operation-hold-in-use');
      const result = this.db.prepare("UPDATE turn_operation_hold_v3 SET status='released' WHERE operation_id=? AND hold_id=? AND status='active'")
        .run(operationId, identity(holdId));
      if (Number(result.changes) !== 1) throw new Error('turn-operation-hold-conflict');
    }, true, 'turn-operation');
  }

  reserve(operationId: string, input: TurnBudgetReservation): void {
    this.reserveInternal(operationId, input);
  }

  reserveFromHold(operationId: string, holdId: string, input: TurnBudgetReservation): void {
    this.reserveInternal(operationId, input, identity(holdId));
  }

  private reserveInternal(operationId: string, input: TurnBudgetReservation, holdId?: string): void {
    ownData(input, ['attemptId', 'requestDigest', 'modelId', 'inputTokens', 'outputTokens', 'costMicrousd'], ['providerId']);
    const attemptId = identity(input.attemptId), requestDigest = digest(input.requestDigest), modelId = identity(input.modelId);
    const providerId = Object.hasOwn(input, 'providerId') ? identity(input.providerId) : undefined;
    const estimatedInput = integer(input.inputTokens, 'input', 1), output = integer(input.outputTokens, 'output', 1);
    const cost = integer(input.costMicrousd, 'cost');
    sqliteTransaction(this.db, () => {
      const profile = this.profile(operationId);
      this.assertActive(operationId);
      const existing = this.db.prepare('SELECT * FROM turn_operation_attempt_v3 WHERE operation_id=? AND attempt_id=?').get(operationId, attemptId) as Row | undefined;
      if (existing) {
        if (existing.status === 'reserved' && existing.request_digest === requestDigest && existing.model_id === modelId
          && existing.reserved_input === estimatedInput && existing.reserved_output === output && existing.reserved_cost === cost
          && existing.hold_id === (holdId ?? null) && existing.provider_id === (providerId ?? null)) return;
        throw new Error('turn-operation-attempt-conflict');
      }
      if (this.nowMs() >= profile.deadlineMs) throw new Error('turn-operation-deadline-exhausted');
      const binding = modelBinding(profile, modelId, providerId);
      const pending = this.db.prepare("SELECT 1 FROM turn_operation_attempt_v3 WHERE operation_id=? AND status IN ('dispatched','unknown') LIMIT 1").get(operationId);
      if (pending) throw new Error('turn-operation-outcome-unresolved');
      if (estimatedInput > binding.maxRequestInputTokens || output > binding.maxRequestOutputTokens
        || estimatedInput + output + binding.requestSafetyMarginTokens > binding.contextWindowTokens) {
        throw new Error('turn-operation-request-window-exceeded');
      }
      const used = this.snapshot(operationId);
      if (holdId) {
        const hold = this.db.prepare("SELECT * FROM turn_operation_hold_v3 WHERE operation_id=? AND hold_id=? AND status='active'").get(operationId, holdId) as Row | undefined;
        if (!hold || Number(hold.calls) < 1 || Number(hold.input_tokens) < estimatedInput
          || Number(hold.output_tokens) < output || Number(hold.cost_microusd) < cost) {
          throw new Error('turn-operation-hold-insufficient');
        }
        this.db.prepare(`UPDATE turn_operation_hold_v3 SET calls=calls-1,input_tokens=input_tokens-?,
          output_tokens=output_tokens-?,cost_microusd=cost_microusd-? WHERE operation_id=? AND hold_id=?`)
          .run(estimatedInput, output, cost, operationId, holdId);
      } else if (used.calls + 1 > profile.maxModelCalls || used.inputTokens + estimatedInput > profile.totalInputTokens
        || used.outputTokens + output > profile.totalOutputTokens || used.costMicrousd + cost > profile.totalCostMicrousd) {
        throw new Error('turn-operation-budget-exhausted');
      }
      this.db.prepare(`INSERT INTO turn_operation_attempt_v3(operation_id,attempt_id,request_digest,model_id,
        reserved_input,reserved_output,reserved_cost,status,actual_input,actual_output,actual_cost,hold_id,provider_id)
        VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)`)
        .run(operationId, attemptId, requestDigest, modelId, estimatedInput, output, cost, 'reserved', holdId ?? null, providerId ?? null);
    }, true, 'turn-operation');
  }

  markDispatched(operationId: string, attemptId: string): void {
    sqliteTransaction(this.db, () => {
      const profile = this.profile(operationId);
      this.assertActive(operationId);
      if (this.nowMs() >= profile.deadlineMs) throw new Error('turn-operation-deadline-exhausted');
      const pending = this.db.prepare("SELECT 1 FROM turn_operation_attempt_v3 WHERE operation_id=? AND status IN ('dispatched','unknown') LIMIT 1").get(operationId);
      if (pending) throw new Error('turn-operation-outcome-unresolved');
      const result = this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='dispatched' WHERE operation_id=? AND attempt_id=? AND status='reserved'")
        .run(operationId, identity(attemptId));
      if (Number(result.changes) !== 1) throw new Error('turn-operation-dispatch-conflict');
    }, true, 'turn-operation');
  }

  settle(operationId: string, attemptId: string, usage: TurnBudgetUsage): void {
    ownData(usage, ['inputTokens', 'outputTokens', 'costMicrousd']);
    const input = integer(usage.inputTokens, 'input'), output = integer(usage.outputTokens, 'output'), cost = integer(usage.costMicrousd, 'cost');
    const over = sqliteTransaction(this.db, () => {
      const profile = this.profile(operationId);
      const row = this.db.prepare('SELECT * FROM turn_operation_attempt_v3 WHERE operation_id=? AND attempt_id=?').get(operationId, identity(attemptId)) as Row | undefined;
      if (!row) throw new Error('turn-operation-attempt-missing');
      const binding = modelBinding(profile, String(row.model_id), row.provider_id === null ? undefined : String(row.provider_id));
      if (row.status === 'settled') {
        if (row.actual_input !== input || row.actual_output !== output || row.actual_cost !== cost) throw new Error('turn-operation-settlement-conflict');
      } else {
        if (row.status !== 'dispatched') throw new Error('turn-operation-settlement-conflict');
        this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='settled',actual_input=?,actual_output=?,actual_cost=? WHERE operation_id=? AND attempt_id=?")
          .run(input, output, cost, operationId, attemptId);
      }
      const used = this.snapshot(operationId);
      const exceeded = input > Number(row.reserved_input) || output > Number(row.reserved_output)
        || cost > Number(row.reserved_cost) || input + output + binding.requestSafetyMarginTokens > binding.contextWindowTokens
        || used.inputTokens > profile.totalInputTokens
        || used.outputTokens > profile.totalOutputTokens || used.costMicrousd > profile.totalCostMicrousd;
      if (exceeded) this.db.prepare("UPDATE turn_operation_budget_v3 SET status='exhausted' WHERE operation_id=?").run(operationId);
      return exceeded;
    }, true, 'turn-operation');
    // The overrun must remain durably accounted even though callers must reject the result.
    if (over) throw new Error('turn-operation-usage-exceeded');
  }

  markUnknown(operationId: string, attemptId: string): void {
    sqliteTransaction(this.db, () => {
      this.profile(operationId);
      const result = this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='unknown' WHERE operation_id=? AND attempt_id=? AND status='dispatched'")
        .run(operationId, identity(attemptId));
      if (Number(result.changes) !== 1) throw new Error('turn-operation-unknown-conflict');
    }, true, 'turn-operation');
  }

  /** A broken/unobservable transport may have dispatched; never refund its reservation. */
  markPossiblyDispatched(operationId: string, attemptId: string): void {
    sqliteTransaction(this.db, () => {
      this.profile(operationId);
      const row = this.db.prepare('SELECT status FROM turn_operation_attempt_v3 WHERE operation_id=? AND attempt_id=?').get(operationId, identity(attemptId)) as Row | undefined;
      if (row?.status === 'unknown') return;
      const result = this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='unknown' WHERE operation_id=? AND attempt_id=? AND status IN ('reserved','dispatched')")
        .run(operationId, attemptId);
      if (Number(result.changes) !== 1) throw new Error('turn-operation-unknown-conflict');
    }, true, 'turn-operation');
  }

  release(operationId: string, attemptId: string): void {
    sqliteTransaction(this.db, () => {
      this.profile(operationId);
      const row = this.db.prepare('SELECT * FROM turn_operation_attempt_v3 WHERE operation_id=? AND attempt_id=?').get(operationId, identity(attemptId)) as Row | undefined;
      if (!row || row.status !== 'reserved') throw new Error('turn-operation-release-conflict');
      if (row.hold_id !== null) {
        const restore = this.db.prepare(`UPDATE turn_operation_hold_v3 SET calls=calls+1,input_tokens=input_tokens+?,
          output_tokens=output_tokens+?,cost_microusd=cost_microusd+? WHERE operation_id=? AND hold_id=? AND status='active'`)
          .run(Number(row.reserved_input), Number(row.reserved_output), Number(row.reserved_cost), operationId, String(row.hold_id));
        if (Number(restore.changes) !== 1) throw new Error('turn-operation-hold-conflict');
      }
      const result = this.db.prepare("UPDATE turn_operation_attempt_v3 SET status='released' WHERE operation_id=? AND attempt_id=? AND status='reserved'")
        .run(operationId, identity(attemptId));
      if (Number(result.changes) !== 1) throw new Error('turn-operation-release-conflict');
    }, true, 'turn-operation');
  }
}
