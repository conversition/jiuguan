/**
 * FE-05.3 用户动作真实桥接（agentActionBridge）——**纯逻辑**，可 node 直测
 *
 * 完整链路（任务书）：
 *   用户在面板操作 → 协议适配转换参数 → 宿主核验目标/权限/操作身份
 *     → 调用**现有** Agent 入口 → 结果返回**发起面板**
 *
 * 不新增：模型客户端 / 独立任务队列 / 记忆检索器 / 变量更新后台 / 提示词组装器。
 *
 * 纪律：
 *  1. **请求发给谁，结果就归谁**：动作绑定发起面板 + 操作 ID + 会话运行实例 + 必要目标。
 *     用户发出请求后切换联系人/会话，结果仍属最初目标；切换后旧结果不得显示到新面板。
 *  2. **显示名不是主键**；前端自报的会话身份不能替代宿主校验。
 *  3. **跨窗口消息必须验证**：发送窗口（已注册帧）、既有通道绑定（token ⇄ panelId）、消息结构。
 *  4. **空接口不报错但不伪造业务成功**；真实失败由 UI 接住，不转成"成功"。
 *  5. **幂等只用于同一逻辑操作的重试**；有意重新生成是新的操作身份。
 */
import { NOOP_BACKGROUND_ACTIONS, resolvePanelAction, runNoopBackgroundAction, type PanelActionMode, type ActionEffect } from './actionModes.ts';
import { getSurface, isActionAllowed, type SurfaceEntry } from './surfaceRegistry.ts';
import type { ViewTarget } from '../htmlCore.ts';

/** 面板发起的动作请求（协议适配转换后的统一形状） */
export interface ActionRequest {
  panelId: string;
  moduleId: string;
  /** 通用语义动作名（PANEL_ACTION_MAP 中的一项） */
  action: string;
  payload?: Record<string, unknown>;
  sessionId: string;
  sessionRunId: string;
  target?: ViewTarget;
  /** 调用方提供的稳定逻辑键（同一逻辑操作重试时保持一致；重新生成时换新键） */
  logicalKey?: string;
}

/** 宿主侧核验上下文（来自真实运行状态，不由请求体自报） */
export interface HostActionContext {
  currentSessionId: string | null;
  currentSessionRunId: string;
  /** 帧 token → 已绑定面板（跨窗口校验） */
  frameBindings: Record<string, string>;
  /** 发起帧 token（宿主从 e.source 反查得到，**不信任消息体**） */
  sourceToken?: string;
}

export type ActionPlan =
  | { status: 'rejected'; reason: string; code: string }
  | { status: 'noop'; reason: string; neutral: unknown; supersededBy: string }
  | { status: 'ok'; reason: string; mode: PanelActionMode; effect: ActionEffect; call: { kind: string; name: string; payload: Record<string, unknown> }; identity: ActionIdentity; dispatch: 'bridge' };

export interface ActionIdentity {
  operationId: string;
  panelId: string;
  sessionId: string;
  sessionRunId: string;
  target?: ViewTarget;
  attempt: number;
  /** 是否一个新的逻辑任务（重新生成 = true；重试 = false） */
  newLogicalTask: boolean;
}

// ────────────────────────── 操作身份与幂等 ──────────────────────────

const identities = new Map<string, ActionIdentity>();
let seq = 0;

/**
 * 生成操作身份。
 *  - 同一 `logicalKey`（同面板 + 同动作 + 同逻辑键）→ **沿用原 operationId**，只推进 attempt；
 *  - 新逻辑键（重新生成 / 新的用户意图）→ 新 operationId。
 */
export function beginAction(req: ActionRequest, ctx: HostActionContext): ActionIdentity {
  const logical = req.logicalKey ?? `anon-${++seq}`;
  const key = `${req.panelId}|${req.action}|${logical}`;
  const prev = identities.get(key);
  if (prev) {
    const next = { ...prev, attempt: prev.attempt + 1, newLogicalTask: false };
    identities.set(key, next);
    return next;
  }
  const fresh: ActionIdentity = {
    operationId: `act:${req.panelId}:${req.action}:${Date.now().toString(36)}-${(++seq).toString(36)}`,
    panelId: req.panelId,
    sessionId: req.sessionId,
    sessionRunId: req.sessionRunId,
    target: req.target,
    attempt: 1,
    newLogicalTask: true,
  };
  identities.set(key, fresh);
  void ctx;
  return fresh;
}

/** 有意重新生成：换新逻辑键 → 新的逻辑身份（**不得**复用旧 operationId） */
export function beginRegeneration(req: ActionRequest, ctx: HostActionContext): ActionIdentity {
  return beginAction({ ...req, logicalKey: `regen-${Date.now().toString(36)}-${++seq}` }, ctx);
}

export function getIdentity(operationId: string): ActionIdentity | undefined {
  for (const v of identities.values()) if (v.operationId === operationId) return v;
  return undefined;
}

export function resetActionBridge(): void { identities.clear(); seq = 0; }

// ────────────────────────── 规划（宿主核验 + 模式选择） ──────────────────────────

export function planAgentAction(req: ActionRequest, ctx: HostActionContext): ActionPlan {
  // 1) 面板必须已登记 —— 未登记帧 / 未登记面板不得写入或生成
  const entry: SurfaceEntry | undefined = getSurface(req.panelId);
  if (!entry) return { status: 'rejected', code: 'panel-unregistered', reason: `面板 ${req.panelId} 未登记（拒绝越权动作）` };

  // 2) 跨窗口校验：发起帧必须已绑定到该面板（token ⇄ panelId）。
  //    消息体里的 panelId 不可信 —— 必须与通道绑定一致。
  if (ctx.sourceToken !== undefined) {
    const bound = ctx.frameBindings[ctx.sourceToken];
    if (!bound) return { status: 'rejected', code: 'frame-unbound', reason: '发起帧未绑定任何面板（拒绝未登记帧）' };
    if (bound !== req.panelId) {
      return { status: 'rejected', code: 'frame-mismatch', reason: `发起帧绑定的是 ${bound}，与请求中的 ${req.panelId} 不一致（拒绝伪造）` };
    }
  }

  // 3) 声明/模块一致（防止其它模块冒充该面板）
  if (entry.declaration.moduleId !== req.moduleId) {
    return { status: 'rejected', code: 'module-mismatch', reason: `面板来源模块为 ${entry.declaration.moduleId}，与请求的 ${req.moduleId} 不一致` };
  }

  // 4) 会话运行实例必须仍然有效（切换会话后旧实例动作一律拒绝）
  if (ctx.currentSessionRunId !== req.sessionRunId || ctx.currentSessionId !== req.sessionId) {
    return {
      status: 'rejected', code: 'stale-run',
      reason: `请求属于 ${req.sessionId}/${req.sessionRunId}，当前为 ${ctx.currentSessionId ?? '-'}/${ctx.currentSessionRunId || '-'}（失效实例不得写入或生成）`,
    };
  }

  // 5) 动作必须登记 + 面板已声明 + 权限满足（最小权限双重判定）
  const allowed = isActionAllowed(entry.declaration, req.action);
  if (!allowed.ok) return { status: 'rejected', code: 'action-not-allowed', reason: allowed.reason };

  // 6) 目标一致性：message 生命周期面板的动作必须打在自己的目标消息上
  const wantMsg = entry.declaration.lifecycle === 'message';
  if (wantMsg && req.target) {
    const t = entry.declaration.target;
    const same = (t.messageId !== undefined && req.target.messageId === t.messageId)
      || (!!t.messageKey && req.target.messageKey === t.messageKey);
    if (!same) return { status: 'rejected', code: 'target-mismatch', reason: '动作目标与该面板的目标消息不一致（不越权写入其它楼层）' };
  }

  // 7) 重复后台：中性返回 + 来源已停用（不是"接口不存在"）
  const bg = runNoopBackgroundAction(req.action);
  if (bg.hit) {
    const bgEntry = NOOP_BACKGROUND_ACTIONS.find((x) => x.action === req.action);
    return {
      status: 'noop',
      reason: '该动作为重复后台：返回标准空结果，不排队、不重试、不写权威数据',
      neutral: bg.value,
      supersededBy: bgEntry?.supersededBy ?? '由 Agent 接管',
    };
  }

  const mapping = resolvePanelAction(req.action);
  if (!mapping) return { status: 'rejected', code: 'unmapped-action', reason: `动作 ${req.action} 未映射到现有接口（不静默放行）` };

  const identity = beginAction(req, ctx);
  return {
    status: 'ok',
    reason: `${mapping.effect}：转发到现有入口 ${mapping.iface.kind}:${mapping.iface.name}`,
    mode: entry.declaration.actionMode,
    effect: mapping.effect,
    call: { kind: mapping.iface.kind, name: mapping.iface.name, payload: req.payload ?? {} },
    identity,
    dispatch: 'bridge',
  };
}

// ────────────────────────── 结果归属（不串会话） ──────────────────────────

export interface ActionResultEnvelope {
  identity: ActionIdentity;
  /** 结果或错误（错误必须暴露给 UI，不得转成"成功"） */
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type DeliveryDecision =
  | { action: 'deliver'; reason: string }
  | { action: 'drop-stale'; reason: string }
  | { action: 'no-panel'; reason: string };

/**
 * 结果投递判定：**结果仍归属最初的请求目标**。
 * 用户切了联系人/会话，或面板已销毁 → 不投递到新面板（避免串台）。
 */
export function routeActionResult(env: ActionResultEnvelope, ctx: HostActionContext): DeliveryDecision {
  const entry = getSurface(env.identity.panelId);
  if (!entry) return { action: 'no-panel', reason: `发起面板 ${env.identity.panelId} 已销毁 → 结果丢弃（不显示到其它面板）` };
  if (env.identity.sessionRunId !== ctx.currentSessionRunId || env.identity.sessionId !== ctx.currentSessionId) {
    return { action: 'drop-stale', reason: '结果属于已失效的会话运行实例 → 丢弃（不显示到新会话）' };
  }
  if (entry.declaration.sessionRunId !== env.identity.sessionRunId) {
    return { action: 'drop-stale', reason: '面板本身已切到别的运行实例 → 丢弃旧结果' };
  }
  return { action: 'deliver', reason: `投递给发起面板 ${env.identity.panelId}（含操作 ID ${env.identity.operationId}）` };
}

// ────────────────────────── 计数（报告/验收用） ──────────────────────────

export interface BridgeStats {
  planned: number; rejected: number; noop: number; delivered: number; dropped: number;
  /** 按动作分组的调用次数（真实桥接 vs 空操作分开） */
  byAction: Record<string, { bridged: number; noop: number; rejected: number }>;
}
const stats: BridgeStats = { planned: 0, rejected: 0, noop: 0, delivered: 0, dropped: 0, byAction: {} };

function bump(action: string, field: 'bridged' | 'noop' | 'rejected'): void {
  const cur = stats.byAction[action] ?? { bridged: 0, noop: 0, rejected: 0 };
  cur[field] += 1;
  stats.byAction[action] = cur;
}

export function trackPlan(req: ActionRequest, plan: ActionPlan): void {
  stats.planned += 1;
  if (plan.status === 'rejected') { stats.rejected += 1; bump(req.action, 'rejected'); }
  else if (plan.status === 'noop') { stats.noop += 1; bump(req.action, 'noop'); }
  else bump(req.action, 'bridged');
}

export function trackDelivery(d: DeliveryDecision): void {
  if (d.action === 'deliver') stats.delivered += 1;
  else stats.dropped += 1;
}

export function bridgeStats(): BridgeStats {
  return { ...stats, byAction: JSON.parse(JSON.stringify(stats.byAction)) };
}

export function resetBridgeStats(): void {
  stats.planned = 0; stats.rejected = 0; stats.noop = 0; stats.delivered = 0; stats.dropped = 0; stats.byAction = {};
}

// ────────────────────────── 取消支持（如实：只对声明可取消的任务生效） ──────────────────────────

/**
 * 面板的"取消"是否真的可用。
 * **不为测试完整而新建取消后台**：只有声明为可取消的任务（当前 = 主对话发送的在途回合）
 * 才允许取消；辅助生成明确不可取消。
 */
export function canCancelAction(target: string, ctx: { turnInFlight: boolean }): { ok: boolean; reason: string } {
  const mapping = resolvePanelAction(target);
  if (!mapping) return { ok: false, reason: `不存在动作 ${target}，无可取消的任务` };
  if (!mapping.cancellable) {
    return {
      ok: false,
      reason: `${target} 声明为**不可取消**（辅助生成/只读/提交类没有取消入口）→ 如实拒绝，不假装已取消`,
    };
  }
  if (!ctx.turnInFlight) return { ok: false, reason: `${target} 当前没有在途任务，无需取消` };
  return { ok: true, reason: `${target} 在途 → 复用既有中止入口（以服务端落库定局为准）` };
}

// ────────────────────────── 三层副作用账本（统计不混淆） ──────────────────────────

/**
 * 为什么分三层：**"桥接函数不直接写状态" ≠ "它触发的 Agent 回合没有状态与记忆提交"**。
 *  - `action-direct`：动作处理本身立即产生的影响（追加草稿、发起一次回合请求、发一条取消请求…）
 *  - `agent-business`：Agent 正常业务流程产生的影响（助手消息、状态提交、记忆写入）
 *  - `compat-extra`：兼容层**额外**产生的影响（本应出现的重复任务、二次请求等）——目标是恒为 0
 */
export type EffectLayer = 'action-direct' | 'agent-business' | 'compat-extra';

const ledger: Record<EffectLayer, Record<string, number>> = {
  'action-direct': {}, 'agent-business': {}, 'compat-extra': {},
};

export function recordEffect(layer: EffectLayer, key: string, n = 1): void {
  ledger[layer][key] = (ledger[layer][key] ?? 0) + n;
}

export function effectLedger(): Record<EffectLayer, Record<string, number>> {
  return JSON.parse(JSON.stringify(ledger)) as Record<EffectLayer, Record<string, number>>;
}

export function resetEffectLedger(): void {
  for (const k of Object.keys(ledger) as EffectLayer[]) ledger[k] = {};
}

/** 暴露给浏览器探针（只读） */
export function installActionBridgeProbe(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__jgActionBridge = () => ({ ...bridgeStats(), ledger: effectLedger() });
}
