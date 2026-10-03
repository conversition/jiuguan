/**
 * 状态仓库 + 提交协调器（FE-C1）
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────
 * 旧实现把变量状态**挂在 Node MVU 桥对象上**（`bridge.snapshotState()`），于是
 * 「桥没起来」= 「合法存档也读不到」= 「写入报 本会话未接入 MVU 引擎」。这是把
 * **存储**与**运行时可执行性**错误地绑在一起。
 *
 * 本模块只做存储与提交，不解释任何卡片业务：
 *  - 读取快照 / 保存状态 / 版本号 / 归属（instanceId）
 *  - 作用域：session（会话权威状态） 与 message（按**稳定消息身份**分别保存）
 *  - 幂等：同一 operationId 重试返回首次结果，不重复生效（FE-C4 基础）
 *  - 乐观锁：expectedVersion 不匹配 → 明确冲突，不静默覆盖
 *
 * **不使用空对象冒充初始化**：未初始化的作用域返回 `exists:false`，
 * 调用方必须区分「没有状态」与「状态是 {}」。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CONTROL_HISTORY_EPOCH, DEFAULT_BRANCH_KEY, SCOPE_CHARACTER, SCOPE_MESSAGE, SCOPE_SESSION, SESSION_SCOPE_KEY } from './schema.ts';

export interface StateScope {
  kind: 'session' | 'message' | 'character';
  /** session → 固定 'global'；message → 稳定消息身份（chat_log.id 的字符串形式）；
   *  character → characterId（稳定人物 ID） */
  key: string;
  /** 剧情分支 / 回复版本维度（本批固定 'main'） */
  branch?: string;
  /** character 作用域必需：会话命名空间（防止跨局串写；同名人物不共享单局状态） */
  sessionKey?: string;
}

/**
 * 合法前驱（AM-02）：这次写入依据的是哪条源正文 / 哪一轮。
 * 源正文被删除或撤回（回滚后 chat_log 行不存在、或轮次不符）→ 候选不再是合法写入。
 * 注意 recording version 与 "最后一次读取时间" 不是一回事。
 */
export interface PredecessorRef {
  round?: number;
  /** 源助手消息的稳定内部身份（chat_log.id） */
  messageId?: number;
  /** 源正文版本（同一条消息被重新生成时的递增版本；缺省 1） */
  recordVersion?: number;
}

/**
 * 快照来源（FE-04-A）：让"这份状态是怎么来的"可读。
 *  - card-write        ：卡片/用户经 bridge 写入（真实保存路径）
 *  - turn-carry-forward：Agent 回合推进但**未产生卡专属变量** → 明确标注为沿用最近一次已提交快照
 *                        （不是"读取时取最新状态"）
 *  - seed              ：测试/初始化预置（与生产链分开报告）
 */
export type SnapshotSource = 'card-write' | 'turn-carry-forward' | 'seed';

export interface StateSnapshot {
  /** 是否存在已保存状态（false = 未初始化；**不要**用 {} 冒充） */
  exists: boolean;
  state: Record<string, unknown>;
  stateVersion: number;
  instanceId?: string;
  updatedRound?: number;
  updatedAt?: string;
  /** 来源（不存在时为 undefined） */
  source?: SnapshotSource;
  /** 溯源说明（例如"本回合 Agent 未产生卡专属变量，沿用 #N"） */
  note?: string;
  /** 写入时的历史代际（AM-02：回滚后旧代际写入一律拒绝） */
  historyEpoch?: number;
}

export interface CommitInput {
  scope: StateScope;
  /** 目标状态（完整快照，非增量） */
  state: Record<string, unknown>;
  round?: number;
  /** 运行实例归属：用于拒绝旧实例的迟到写入 */
  instanceId?: string;
  /** 乐观锁基准版本；不匹配 → 抛 StateVersionConflict */
  expectedVersion?: number;
  /** 逻辑操作 ID：同 ID 重试返回首次结果（幂等） */
  operationId?: string;
  /** 变更路径，仅记录 */
  changes?: string[];
  /** 快照来源（FE-04-A 溯源） */
  source?: SnapshotSource;
  /** 溯源说明 */
  note?: string;
  /** AM-02：写入所依据的历史代际；低于当前代际 → 抛 StateEpochStaleError */
  historyEpoch?: number;
  /** AM-02：合法前驱（源正文身份）。源不存在/轮次不符 → 抛 StatePredecessorStaleError */
  predecessor?: PredecessorRef;
  /** session/message 作用域做代际校验时的会话命名空间 */
  sessionKey?: string;
  /** 同作用域内要求「当前历史代际」达到的下限（写入方声明自己已知晓的最新代际） */
  requireEpoch?: boolean;
}

export interface CommitResult {
  stateVersion: number;
  changed: string[];
  /** true = 命中已有提交记录，本次未重复生效 */
  deduped: boolean;
}

export class StateVersionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`状态版本冲突：期望 ${expected}，实际 ${actual}`);
    this.name = 'StateVersionConflictError';
  }
}

export class StateInstanceStaleError extends Error {
  constructor(stale: string, current: string) {
    super(`旧运行实例的写入被拒绝：${stale} ≠ 当前 ${current}`);
    this.name = 'StateInstanceStaleError';
  }
}

export class StateOperationIntentConflictError extends Error {
  constructor(operationId: string) {
    super(`操作身份冲突：${operationId} 已绑定到另一项业务意图`);
    this.name = 'StateOperationIntentConflictError';
  }
}

/** AM-02：历史代际过旧（回滚后旧写入）→ 拒绝。旧候选不得换最新版本后原样再提交。 */
export class StateEpochStaleError extends Error {
  constructor(stale: number, current: number) {
    super(`历史代际过旧：候选基于代际 ${stale}，当前代际 ${current}（回滚后旧写入被拒绝，请重新读取合法状态与证据）`);
    this.name = 'StateEpochStaleError';
  }
}

/** AM-02：合法前驱失效（源正文不存在 / 轮次不符 / 版本不符）→ 拒绝。 */
export class StatePredecessorStaleError extends Error {
  constructor(reason: string) {
    super(`合法前驱校验失败：${reason}`);
    this.name = 'StatePredecessorStaleError';
  }
}

/** 作用域键解析结果：同时给出 scope 与稳定的 session 命名空间（供代际控制查询） */
interface ResolvedScope {
  scope: string;
  key: string;
  branch: string;
  sessionKey: string;
}

function scopeKeyOf(s: StateScope, fallbackSessionKey?: string): ResolvedScope {
  const branch = s.branch ?? DEFAULT_BRANCH_KEY;
  if (s.kind === 'session') {
    return { scope: SCOPE_SESSION, key: SESSION_SCOPE_KEY, branch, sessionKey: fallbackSessionKey ?? SESSION_SCOPE_KEY };
  }
  if (s.kind === 'character') {
    const ns = (s.sessionKey ?? fallbackSessionKey ?? '').trim();
    if (!ns) throw new Error('character 作用域必须提供 sessionKey（会话命名空间，禁止跨局串写）');
    if (!s.key || !/^char_[A-Za-z0-9_]+$/.test(s.key)) {
      throw new Error(`非法人物作用域键：${JSON.stringify(s.key)}（应为代码分配的稳定 characterId）`);
    }
    return { scope: SCOPE_CHARACTER, key: `${ns}:${s.key}`, branch, sessionKey: ns };
  }
  if (!s.key || !/^\d+$/.test(s.key)) {
    // 内部身份必须是稳定消息 ID（数字）。外部楼层号必须先经协议层翻译，禁止越级直传。
    throw new Error(`非法消息作用域键：${JSON.stringify(s.key)}（应为稳定消息 ID）`);
  }
  return { scope: SCOPE_MESSAGE, key: s.key, branch, sessionKey: fallbackSessionKey ?? SESSION_SCOPE_KEY };
}

function parseState(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 扁平叶子路径（与 MVU 桥的 getFlat 口径一致的读取辅助；不参与业务） */
export function flatPaths(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flatPaths(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** 设置嵌套路径（仅存储层用；拒绝原型污染路径） */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) {
    throw new Error(`非法变量路径：${path}`);
  }
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    const next = cur[k];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/** 删除嵌套路径 */
export function deletePath(target: Record<string, unknown>, path: string): void {
  const segs = path.split('.').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) return;
  let cur: Record<string, unknown> | undefined = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    cur = next as Record<string, unknown>;
  }
  delete cur[segs[segs.length - 1]];
}

export class StateStore {
  constructor(
    private db: DatabaseSync,
    private readonly transactionActive: () => boolean = () => false,
  ) {}

  // ── AM-02：历史代际控制（存放在 session_control，**不随剧情回滚退回**） ──

  /** 当前历史代际：0 表示从未回滚过 */
  historyEpoch(sessionKey: string): number {
    const row = this.db.prepare('SELECT value FROM session_control WHERE session_key = ? AND control_key = ?')
      .get(sessionKey, CONTROL_HISTORY_EPOCH) as { value: string } | undefined;
    const n = row ? Number(row.value) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * 推进历史代际（回滚 / 重新生成 / 删除整轮 / 恢复旧存档时调用）。
   * 目的：使基于旧代际的在途写入与迟到子任务立即失效；合法回滚不受影响（它读到的是新代际）。
   */
  bumpHistoryEpoch(sessionKey: string, reason = ''): number {
    const next = this.historyEpoch(sessionKey) + 1;
    this.db.prepare(
      `INSERT INTO session_control (session_key, control_key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(session_key, control_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(sessionKey, CONTROL_HISTORY_EPOCH, String(next), new Date().toISOString());
    if (reason) {
      this.db.prepare(
        `INSERT INTO session_control (session_key, control_key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(session_key, control_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(sessionKey, `${CONTROL_HISTORY_EPOCH}_reason`, reason, new Date().toISOString());
    }
    return next;
  }

  /** 读取快照。未初始化 → exists:false（**不得**用默认值冒充） */
  read(scope: StateScope): StateSnapshot {
    const { scope: s, key, branch } = scopeKeyOf(scope);
    const row = this.db.prepare(
      'SELECT state_json, state_version, instance_id, initialized, updated_round, updated_at, source, note, history_epoch FROM state_snapshot WHERE scope = ? AND scope_key = ? AND branch_key = ?',
    ).get(s, key, branch) as
      { state_json: string; state_version: number; instance_id: string | null; initialized: number; updated_round: number | null; updated_at: string | null; source: string | null; note: string | null; history_epoch: number | null } | undefined;
    if (!row || row.initialized !== 1) {
      return { exists: false, state: {}, stateVersion: 0 };
    }
    return {
      exists: true,
      state: parseState(row.state_json),
      stateVersion: row.state_version,
      instanceId: row.instance_id ?? undefined,
      updatedRound: row.updated_round ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      source: (row.source as SnapshotSource | null) ?? undefined,
      note: row.note ?? undefined,
      historyEpoch: row.history_epoch ?? undefined,
    };
  }

  /** 仅取版本号（乐观锁基准；未初始化 → 0） */
  version(scope: StateScope): number {
    return this.read(scope).stateVersion;
  }

  /** 显式初始化（幂等：已初始化则不覆盖，返回现有版本） */
  initialize(scope: StateScope, state: Record<string, unknown>, opts: { round?: number; instanceId?: string; source?: SnapshotSource; note?: string; historyEpoch?: number; sessionKey?: string } = {}): CommitResult {
    const r = scopeKeyOf(scope, opts.sessionKey);
    const cur = this.read(scope);
    if (cur.exists) return { stateVersion: cur.stateVersion, changed: [], deduped: true };
    return this.write(r, state, {
      round: opts.round, instanceId: opts.instanceId, changed: flatPaths(state),
      source: opts.source ?? 'card-write', note: opts.note,
      historyEpoch: opts.historyEpoch ?? this.historyEpoch(r.sessionKey),
    });
  }

  /** 提交完整快照（幂等 + 乐观锁 + 实例归属 + 历史代际 + 合法前驱） */
  commit(input: CommitInput): CommitResult {
    const r = scopeKeyOf(input.scope, input.sessionKey);
    const { scope: s, key, branch } = r;
    const intentHash = sha256(stableJson({ scope: s, key, branch, state: input.state }));

    // 幂等：同一 operationId 已提交 → 返回首次结果，不再生效
    // （历史回执可读 ≠ 可重新应用：不同意图已被 intent_hash 拒绝）
    if (input.operationId) {
      const prev = this.db.prepare('SELECT state_version, changes_json, intent_hash, result_json FROM state_commit WHERE operation_id = ?')
        .get(input.operationId) as { state_version: number; changes_json: string | null; intent_hash?: string | null; result_json?: string | null } | undefined;
      if (prev) {
        if (prev.intent_hash && prev.intent_hash !== intentHash) throw new StateOperationIntentConflictError(input.operationId);
        if (prev.result_json) {
          try {
            const parsed = JSON.parse(prev.result_json) as CommitResult;
            return { ...parsed, deduped: true };
          } catch { /* legacy fallback */ }
        }
        return { stateVersion: prev.state_version, changed: parseChanges(prev.changes_json), deduped: true };
      }
    }

    const cur = this.read(input.scope);

    // 历史代际：低于当前代际的候选一律拒绝（不能换成最新版本后原样再提交）
    const controlEpoch = this.historyEpoch(r.sessionKey);
    if (input.historyEpoch !== undefined && input.historyEpoch < controlEpoch) {
      throw new StateEpochStaleError(input.historyEpoch, controlEpoch);
    }
    if (cur.historyEpoch !== undefined && input.historyEpoch !== undefined && input.historyEpoch < cur.historyEpoch) {
      throw new StateEpochStaleError(input.historyEpoch, cur.historyEpoch);
    }

    // 合法前驱：源正文必须仍然存在且轮次一致（回滚后源行被删除 → 旧候选失效）
    if (input.predecessor) this.assertPredecessor(input.predecessor);

    if (input.expectedVersion !== undefined && input.expectedVersion !== cur.stateVersion) {
      throw new StateVersionConflictError(input.expectedVersion, cur.stateVersion);
    }
    // 归属校验：只有当前实例可写（拒绝旧页面/旧实例的迟到写入）
    if (cur.exists && cur.instanceId && input.instanceId && cur.instanceId !== input.instanceId) {
      throw new StateInstanceStaleError(input.instanceId, cur.instanceId);
    }

    const changed = diffPaths(cur.exists ? cur.state : {}, input.state);
    return this.write(r, input.state, {
      round: input.round, instanceId: input.instanceId, changed,
      operationId: input.operationId,
      intentHash,
      prevVersion: cur.exists ? cur.stateVersion : 0,
      source: input.source ?? 'card-write', note: input.note,
      historyEpoch: input.historyEpoch ?? controlEpoch,
      predecessor: input.predecessor,
    });
  }

  /** 合法前驱校验：源记录存在、轮次一致；未声明轮次时只校验存在性 */
  private assertPredecessor(p: PredecessorRef): void {
    if (p.messageId === undefined) return;
    const row = this.db.prepare('SELECT round FROM chat_log WHERE id = ?').get(p.messageId) as { round: number } | undefined;
    if (!row) throw new StatePredecessorStaleError(`源消息 ${p.messageId} 不存在（可能已被回滚/撤回）`);
    if (p.round !== undefined && Number(row.round) !== Number(p.round)) {
      throw new StatePredecessorStaleError(`源消息 ${p.messageId} 属于第 ${row.round} 轮，候选声明第 ${p.round} 轮`);
    }
  }


  /** 已提交操作记录（诊断/审计） */
  commits(limit = 50): { operation_id: string; scope: string; scope_key: string; state_version: number; created_at: string | null }[] {
    return this.db.prepare(
      'SELECT operation_id, scope, scope_key, state_version, created_at FROM state_commit ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as { operation_id: string; scope: string; scope_key: string; state_version: number; created_at: string | null }[];
  }

  /** 已保存快照清单（诊断：能看清 session / message 各作用域的真实存在情况） */
  list(): { scope: string; scope_key: string; branch_key: string; state_version: number; initialized: number; updated_round: number | null; updated_at: string | null; source: string | null; note: string | null }[] {
    return this.db.prepare(
      'SELECT scope, scope_key, branch_key, state_version, initialized, updated_round, updated_at, source, note FROM state_snapshot ORDER BY scope, scope_key',
    ).all() as { scope: string; scope_key: string; branch_key: string; state_version: number; initialized: number; updated_round: number | null; updated_at: string | null; source: string | null; note: string | null }[];
  }

  private write(
    r: ResolvedScope, state: Record<string, unknown>,
    opts: { round?: number; instanceId?: string; changed: string[]; operationId?: string; intentHash?: string; prevVersion?: number; source?: SnapshotSource; note?: string; historyEpoch?: number; predecessor?: PredecessorRef },
  ): CommitResult {
    const { scope, key, branch } = r;
    const now = new Date().toISOString();
    const version = (opts.prevVersion ?? this.version({ kind: scope === SCOPE_SESSION ? 'session' : scope === SCOPE_CHARACTER ? 'character' : 'message', key, branch, sessionKey: r.sessionKey })) + 1;
    const epoch = opts.historyEpoch ?? 0;
    const ownsTransaction = !this.transactionActive();
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        `INSERT INTO state_snapshot (scope, scope_key, branch_key, state_json, state_version, instance_id, initialized, updated_round, updated_at, source, note, history_epoch)
         VALUES (?,?,?,?,?,?,1,?,?,?,?,?)
         ON CONFLICT(scope, scope_key, branch_key) DO UPDATE SET
           state_json = excluded.state_json,
           state_version = excluded.state_version,
           instance_id = COALESCE(excluded.instance_id, state_snapshot.instance_id),
           initialized = 1,
           updated_round = COALESCE(excluded.updated_round, state_snapshot.updated_round),
           updated_at = excluded.updated_at,
           source = COALESCE(excluded.source, state_snapshot.source),
           note = COALESCE(excluded.note, state_snapshot.note),
           history_epoch = excluded.history_epoch`,
      ).run(scope, key, branch, JSON.stringify(state ?? {}), version, opts.instanceId ?? null, opts.round ?? null, now, opts.source ?? null, opts.note ?? null, epoch);
      if (opts.operationId) {
        const result: CommitResult = { stateVersion: version, changed: opts.changed, deduped: false };
        this.db.prepare(
          `INSERT OR IGNORE INTO state_commit (operation_id, scope, scope_key, branch_key, instance_id, state_version, changes_json, intent_hash, result_json, status, created_at, history_epoch, predecessor_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(opts.operationId, scope, key, branch, opts.instanceId ?? null, version, JSON.stringify(opts.changed), opts.intentHash ?? null, JSON.stringify(result), 'committed', now, epoch, opts.predecessor ? JSON.stringify(opts.predecessor) : null);
      }
      if (ownsTransaction) this.db.exec('COMMIT');
    } catch (e) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      }
      throw e;
    }
    return { stateVersion: version, changed: opts.changed, deduped: false };
  }
}

function parseChanges(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 叶子路径差异（浅比较值；数组/对象按 JSON 比对） */
export function diffPaths(before: unknown, after: unknown): string[] {
  const a = new Set(flatPaths(before));
  const b = flatPaths(after);
  const out: string[] = [];
  for (const p of b) {
    const va = readAt(before, p);
    const vb = readAt(after, p);
    if (a.has(p) && JSON.stringify(va) === JSON.stringify(vb)) continue;
    out.push(p);
  }
  const bSet = new Set(b);
  for (const p of a) if (!bSet.has(p)) out.push(p);
  return out;
}

function readAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
