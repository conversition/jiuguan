/**
 * FE-05.1 通用可见表面（surface registry）——**纯逻辑**，可 node 直测
 *
 * 问题：会话执行宿主已经存在（`sessionHost.ts` / `SessionHost.tsx`），但它是一个**隐藏的运行位置**。
 * 本轮要的不是"再建一套手机宿主"，而是在**同一个会话运行实例**上增加受控的可见面板与用户操作入口。
 *
 * 边界（本模块只做"面板属于谁 / 显示什么 / 允许什么"，不做业务）：
 *  - 面板声明复用 `MessageViewContext` 既有字段与 `ViewTarget`，**不新造状态契约**；
 *  - **显示名（title）只用于界面**，绝不能成为权限标识或数据主键（panelId 才是主键）；
 *  - **打开/关闭 ≠ 销毁**：打开/关闭只改变可见性，不重新运行会话脚本、不重建面板后台；
 *  - **关闭 ≠ 取消任务**：面板关闭时若 Agent 任务未完成，默认只是隐藏界面；用户明确点取消才走取消入口；
 *  - 结束/切换会话才按既有规则清理实例、监听与请求绑定。
 *
 * 通用核心不出现卡名 / 固定联系人 / 特定变量字段 / 某业务专用状态。
 */
import type { ViewTarget } from '../htmlCore.ts';
import { resolvePanelAction, type PanelActionMode } from './actionModes.ts';

/** 面板显示位置（通用容器，不是业务分类） */
export type SurfaceSlot = 'drawer' | 'overlay' | 'inline';
/** 面板生命周期：跟随会话（一次会话一个） / 跟随某条消息 */
export type SurfaceLifecycle = 'session' | 'message';

/**
 * 面板内容来源（全部复用已有渲染能力，不新建运行时）：
 *  - session-runtime：复用**唯一**会话执行实例（把同一个 iframe 停靠进可见容器，**不重设 srcdoc**）
 *  - external-page  ：卡自带外部前端页（经统一资源链与服务端代理 → 沙箱 iframe）
 *  - card-html      ：卡内 HTML 片段/文档（HtmlMessage 既有两条档位）
 *  - render-plan    ：数据面板（渲染 `panelProjection` 的结果，纯数据形状）
 */
export type PanelContent =
  | { kind: 'session-runtime'; reason: string }
  | { kind: 'external-page'; url: string; reason: string }
  | { kind: 'card-html'; html: string; reason: string }
  | { kind: 'render-plan'; planRef: string; reason: string };

/**
 * 面板声明。只补"实际缺少的面板信息"，其余复用既有契约。
 * `permissions` 沿用 `MessageViewContext.permissions` 的形状（同一份权限语义，不另开一套）。
 */
export interface PanelDeclaration {
  /** **稳定主键**（来源模块 + 局部名）。显示名不得用作主键。 */
  panelId: string;
  /** 来源模块（脚本/提供者标识；用于"未登记帧不得越权"校验） */
  moduleId: string;
  /** 界面标题（**仅显示**） */
  title: string;
  lifecycle: SurfaceLifecycle;
  sessionId: string;
  /** 所属会话运行实例（与 SessionHost 同一身份；切换会话即失效） */
  sessionRunId: string;
  /** 展示位置 */
  slot: SurfaceSlot;
  /** 必要消息目标（message 生命周期必填） */
  target: ViewTarget;
  content: PanelContent;
  /** 所需数据能力（报告/诊断用；**不是权限**，权限走 permissions） */
  dataNeeds: string[];
  /** 允许的用户动作（必须逐个在 actionModes.PANEL_ACTION_MAP 登记） */
  actions: string[];
  /** 该面板对外的动作模式（由 resolvePanelActionMode 得出） */
  actionMode: PanelActionMode;
  permissions: { draft: boolean; send: boolean; writeState: boolean };
}

/** 面板运行时条目（声明 + 可见性 + 计数） */
export interface SurfaceEntry {
  declaration: PanelDeclaration;
  visible: boolean;
  /** 首次登记时间（证明打开/关闭不重新登记） */
  registeredAt: number;
  openedAt?: number;
  closedAt?: number;
  /** 关闭时是否保留了未完成的 Agent 任务（默认保留 → 关闭只是隐藏） */
  pendingTaskKept: boolean;
  /** 面板订阅（用于销毁时统一清理，防泄漏） */
  subscriptions: string[];
  openCount: number;
  closeCount: number;
}

export interface SurfaceValidation {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 声明校验（纯函数；**默认拒绝**，不静默放行） */
export function validatePanelDeclaration(d: Partial<PanelDeclaration>): SurfaceValidation {
  const errors: string[] = [];
  if (!d.panelId || !ID_RE.test(d.panelId)) errors.push('panelId 缺失或非法（必须是稳定标识，不能用显示名代替）');
  if (!d.moduleId || !ID_RE.test(d.moduleId)) errors.push('moduleId 缺失或非法（面板必须声明来源模块）');
  if (!d.title || !d.title.trim()) errors.push('title 缺失（显示名，仅界面用）');
  if (d.panelId && d.title && d.panelId.trim() === d.title.trim()) {
    errors.push('panelId 不得等于显示名（显示名不能成为权限标识或数据主键）');
  }
  if (!d.sessionId) errors.push('sessionId 缺失（面板必须归属一个会话）');
  if (!d.sessionRunId) errors.push('sessionRunId 缺失（面板必须绑定会话运行实例）');
  if (d.lifecycle === 'message') {
    const t = d.target ?? {};
    if (t.messageId === undefined && !t.messageKey) {
      errors.push('message 生命周期面板必须带必要消息目标（messageId 或 messageKey）');
    }
  }
  if (!d.content || !d.content.kind) errors.push('content 缺失（必须声明内容来源；不用空 {} 冒充初始化）');
  if (d.content?.kind === 'external-page' && !(d.content as { url?: string }).url) {
    errors.push('external-page 内容必须带 url');
  }
  if (d.content?.kind === 'card-html' && !(d.content as { html?: string }).html) {
    errors.push('card-html 内容必须带 html');
  }
  const actions = d.actions ?? [];
  for (const a of actions) {
    if (!resolvePanelAction(a)) errors.push(`未登记动作 ${a}（必须先写入 actionModes.PANEL_ACTION_MAP）`);
  }
  if (!d.permissions || typeof d.permissions.send !== 'boolean') errors.push('permissions 缺失（不默认授予能力）');
  return { ok: errors.length === 0, errors };
}

/**
 * 动作是否被该面板允许：**双重判定** —— 动作已在全局登记 **且** 面板声明里列出。
 * 未列出的动作即便全局存在也不得由该面板发起（最小权限）。
 */
export function isActionAllowed(d: PanelDeclaration, action: string): { ok: boolean; reason: string } {
  const mapping = resolvePanelAction(action);
  if (!mapping) return { ok: false, reason: `动作 ${action} 未在全局动作表登记` };
  if (!d.actions.includes(action)) return { ok: false, reason: `面板 ${d.panelId} 未声明动作 ${action}` };
  if (mapping.effect === 'draft' && !d.permissions.draft) return { ok: false, reason: '面板未获得草稿权限' };
  if (mapping.effect === 'main-chat' && mapping.writesMessage && !d.permissions.send) {
    return { ok: false, reason: '面板未获得发送权限' };
  }
  if (mapping.writesState && !d.permissions.writeState) return { ok: false, reason: '面板未获得写状态权限' };
  return { ok: true, reason: '已登记且面板已声明，权限满足' };
}

// ────────────────────────── 注册表（纯内存） ──────────────────────────

const surfaces = new Map<string, SurfaceEntry>();
type Listener = () => void;
const listeners = new Set<Listener>();

/** 面板生命周期事件（供测试证明"开关不重启会话脚本"：这里**只有可见性事件**） */
export interface SurfaceLifecycleEvent {
  kind: 'register' | 'open' | 'close' | 'destroy' | 'cancel-task';
  panelId: string;
  at: number;
}
const lifecycleLog: SurfaceLifecycleEvent[] = [];

function emit(kind: SurfaceLifecycleEvent['kind'], panelId: string): void {
  lifecycleLog.push({ kind, panelId, at: Date.now() });
  for (const l of [...listeners]) { try { l(); } catch { /* ignore */ } }
}

export function subscribeSurfaces(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 登记面板（**重复登记同 id 只更新声明，不重置计数** → 证明打开/关闭不重新登记） */
export function registerSurface(d: PanelDeclaration): { ok: boolean; errors: string[]; entry?: SurfaceEntry } {
  const v = validatePanelDeclaration(d);
  if (!v.ok) return { ok: false, errors: v.errors };
  const prev = surfaces.get(d.panelId);
  if (prev) {
    // 同一运行实例内重复登记：保留可见性与计数（不视为"重新创建"）
    prev.declaration = d;
    return { ok: true, errors: [], entry: prev };
  }
  const entry: SurfaceEntry = {
    declaration: d, visible: false, registeredAt: Date.now(),
    pendingTaskKept: false, subscriptions: [], openCount: 0, closeCount: 0,
  };
  surfaces.set(d.panelId, entry);
  emit('register', d.panelId);
  return { ok: true, errors: [], entry };
}

/**
 * 打开面板：**只改变可见性**。不重新运行会话脚本、不重建后台、不重设 srcdoc。
 * 已可见时是幂等的（openCount 不再增加），避免重复挂载。
 */
export function openSurface(panelId: string): { ok: boolean; reason: string } {
  const e = surfaces.get(panelId);
  if (!e) return { ok: false, reason: `面板 ${panelId} 未登记（默认拒绝）` };
  if (e.visible) return { ok: true, reason: '面板已可见（幂等：不重复挂载、不重启脚本）' };
  e.visible = true;
  e.openedAt = Date.now();
  e.openCount += 1;
  emit('open', panelId);
  return { ok: true, reason: '可见性 = 打开；会话脚本与后台保持不变' };
}

/** 关闭面板：**只改变可见性**。未完成的 Agent 任务默认**保留**（不等于取消）。 */
export function closeSurface(panelId: string): { ok: boolean; reason: string; pendingTaskKept: boolean } {
  const e = surfaces.get(panelId);
  if (!e) return { ok: false, reason: `面板 ${panelId} 未登记`, pendingTaskKept: false };
  if (!e.visible) {
    return {
      ok: true,
      reason: '面板本已隐藏（幂等）；默认保留未完成的 Agent 任务（取消需用户显式点击取消入口，关闭 ≠ 取消）',
      pendingTaskKept: e.pendingTaskKept,
    };
  }
  e.visible = false;
  e.closedAt = Date.now();
  e.closeCount += 1;
  e.pendingTaskKept = true; // 默认语义：关闭 = 隐藏界面，任务继续；取消是另一个显式动作
  emit('close', panelId);
  return {
    ok: true,
    reason: '可见性 = 关闭；默认保留未完成的 Agent 任务（取消需用户显式点击取消入口）',
    pendingTaskKept: true,
  };
}

/** 显式取消面板上的未完成任务（唯一的"取消"入口；与关闭分开） */
export function cancelSurfaceTask(panelId: string): { ok: boolean; reason: string } {
  const e = surfaces.get(panelId);
  if (!e) return { ok: false, reason: `面板 ${panelId} 未登记` };
  e.pendingTaskKept = false;
  emit('cancel-task', panelId);
  return { ok: true, reason: '已走取消入口（由调用方执行实际取消，本模块只记录意图）' };
}

/** 销毁面板：结束/切换会话或面板自身声明结束时调用；清理订阅与状态引用 */
export function destroySurface(panelId: string): { ok: boolean; reason: string } {
  const e = surfaces.get(panelId);
  if (!e) return { ok: false, reason: `面板 ${panelId} 不存在` };
  surfaces.delete(panelId);
  emit('destroy', panelId);
  return { ok: true, reason: `已销毁并清理 ${e.subscriptions.length} 项订阅（不影响 SessionHost）` };
}

/**
 * 会话结束/切换时按既有规则清理：销毁属于该 run 的面板。
 * **不动 SessionHost**（它由 App 的会话切换统一处理）。
 */
export function destroySurfacesForRun(sessionRunId: string): number {
  let n = 0;
  for (const [id, e] of [...surfaces]) {
    if (e.declaration.sessionRunId === sessionRunId) { surfaces.delete(id); emit('destroy', id); n++; }
  }
  return n;
}

export function listSurfaces(): SurfaceEntry[] { return [...surfaces.values()]; }

export function getSurface(panelId: string): SurfaceEntry | undefined { return surfaces.get(panelId); }

/** 报告用：可见性 + 计数（回答"反复开关是否重复启动脚本/重复注册"） */
export function summarizeSurfaces(): {
  panelId: string; moduleId: string; title: string; visible: boolean;
  opens: number; closes: number; pendingTaskKept: boolean; contentKind: PanelContent['kind'];
}[] {
  return listSurfaces().map((e) => ({
    panelId: e.declaration.panelId, moduleId: e.declaration.moduleId, title: e.declaration.title,
    visible: e.visible, opens: e.openCount, closes: e.closeCount,
    pendingTaskKept: e.pendingTaskKept, contentKind: e.declaration.content.kind,
  }));
}

export function surfaceLifecycleLog(): SurfaceLifecycleEvent[] { return [...lifecycleLog]; }

export function resetSurfaces(): void { surfaces.clear(); lifecycleLog.length = 0; }

/**
 * 停靠计划：决定"会话执行实例的 iframe 是否停靠进可见容器"。
 *
 * 关键纪律（对应任务书"不要每打开一次就重新设置 srcdoc"）：
 *  会话运行实例**始终只存在一个** iframe；打开面板只是把它 `appendChild` 到可见容器
 *  （DOM 移动不重建浏览上下文），关闭则移回隐藏锚点。
 *  **绝不**为面板新建第二个 iframe / 第二份运行时。
 */
export interface DockPlan {
  /** 是否需要把会话实例以"抽屉形态"呈现（**不是移动 DOM**） */
  docked: boolean;
  /** 呈现载体：舞台容器（固定挂载点） */
  container: 'surface-drawer' | 'session-host-anchor';
  reason: string;
  /** 是否允许新建 iframe（**恒为 false**） */
  createNewRuntime: false;
  /**
   * 是否移动 iframe 的 DOM 位置（**恒为 false**）。
   * 实测：DOM 迁移会让子文档被重建（realmBootId 变化）→ 会话级脚本"只执行一次"失效。
   * 因此改为"固定挂载点 + 外层容器表现抽屉"。
   */
  moved: false;
}

export function planSurfaceDock(
  entries: SurfaceEntry[],
  opts: { sessionHostAvailable: boolean },
): DockPlan {
  const runtimePanels = entries.filter((e) => e.visible && e.declaration.content.kind === 'session-runtime');
  if (runtimePanels.length === 0) {
    return {
      docked: false, container: 'session-host-anchor',
      reason: '没有打开中的会话实例面板：舞台容器保持隐藏（实例仍固定挂载、继续存活）',
      createNewRuntime: false, moved: false,
    };
  }
  if (!opts.sessionHostAvailable) {
    return {
      docked: false, container: 'session-host-anchor',
      reason: '打开中的面板需要会话运行实例，但当前会话没有可呈现的执行实例 → 明确降级（不新建第二份运行时）',
      createNewRuntime: false, moved: false,
    };
  }
  return {
    docked: true, container: 'surface-drawer',
    reason: `会话实例**固定挂载**在舞台容器；${runtimePanels.length} 个面板共用同一实例，`
      + '打开面板只改变外层容器的显示/定位/尺寸（不移动 iframe、不重设 srcdoc、不新建运行时）',
    createNewRuntime: false, moved: false,
  };
}

/** 暴露给浏览器探针（只读） */
export function installSurfaceProbe(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__jgSurfaces = () => ({ list: summarizeSurfaces(), dock: planSurfaceDock(listSurfaces(), { sessionHostAvailable: true }) });
  w.__jgSurfaceLog = () => surfaceLifecycleLog();
}
