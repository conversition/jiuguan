/**
 * FE-05.2 统一面板数据投影（**只读投影**，纯逻辑可 node 直测）
 *
 * 目标：把「面板该显示什么」收敛成一个小型只读投影，组合现有读取接口的结果，
 *   **不建立第二个手机数据库**，也**不负责重新计算剧情**（`computed: 'none'`）。
 *
 * 纪律：
 *  1. **投影只转换数据形状**：状态来自 StateStore 的既有结果（含 source/note/version），
 *     消息来自已授权记录，对象列表必须有明确来源；缺什么就给出**准确的空状态**，不臆造。
 *  2. **卡片字段映射放在协议适配/声明式配置**：通用核心只提供通用路径解析，
 *     不在核心出现"某角色的字段路径"，也不内置联系人列表。
 *  3. **历史状态与当前会话状态分开订阅**：复用 FE-04 的事件用途分流，FE-05 不再合并成
 *     "所有面板收到事件后都去读最新状态"。
 *  4. **UI 偏好与剧情变量严格分离**：窗口位置/标签/选中对象/草稿/已读游标走独立偏好存储，
 *     按会话与模块隔离；未读游标引用既有稳定消息身份，不建影子聊天表。
 */
import type { ViewTarget } from '../htmlCore.ts';
import type { PanelActionMode } from './actionModes.ts';

// ────────────────────────── 通用路径解析（协议适配层用） ──────────────────────────

/**
 * 通用点路径解析。`a.b.c` / `a.0.b` 均可；缺失返回 undefined（**不回落默认值**，由调用方决定）。
 * 这是通用核心唯一的"字段访问"能力 —— 具体字段路径由声明式映射提供。
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 声明式字段映射（属于**协议适配/卡片配置**层，通用核心不内置任何具体路径） */
export interface PanelFieldMap {
  moduleId: string;
  fields: { key: string; path: string; label: string }[];
}

export function applyFieldMap(values: Record<string, unknown> | undefined, map?: PanelFieldMap): Record<string, unknown> {
  if (!map) return {};
  const out: Record<string, unknown> = {};
  for (const f of map.fields) {
    const v = resolvePath(values, f.path);
    if (v !== undefined) out[f.key] = v; // 映射不到就不出现（空状态由 empty 表达）
  }
  return out;
}

// ────────────────────────── 投影输入 / 输出 ──────────────────────────

export interface PanelProjectionInputs {
  target: ViewTarget & { sessionId: string; sessionRunId: string };
  /** 该面板请求的作用域（消息快照 vs 会话权威状态） */
  scope: 'message' | 'session';
  /** 现有 StateStore 读取结果；未请求/不存在 → null（**不用 {} 冒充初始化**） */
  state: { exists: boolean; source?: string; note?: string; stateVersion?: number; values?: Record<string, unknown> } | null;
  /** 已授权的消息记录（来自既有历史接口；不新建影子聊天表） */
  messages: { id: number; round: number; role: string; content: string }[];
  /** 有明确来源的对象/联系人列表（来源必填；空 → 准确空状态） */
  objects: { id: string; label: string; source: string }[];
  /** 当前允许的用户动作（已在动作表登记 + 面板声明 + 权限通过） */
  allowedActions: { action: string; mode: PanelActionMode; label: string }[];
  fieldMap?: PanelFieldMap;
  /** 通用会话状态查看器可显式直出全部顶层字段；卡片适配面板仍应优先使用 fieldMap。 */
  includeAllStateFields?: boolean;
  ui?: PanelUiState;
}

export interface PanelProjection {
  target: PanelProjectionInputs['target'];
  scope: 'message' | 'session';
  state: {
    exists: boolean; source?: string; note?: string; stateVersion?: number;
    /** 按声明式映射投影后的字段（未映射到的不出现） */
    fields: Record<string, unknown>;
  } | null;
  /** 状态来源的人类可读表达（turn-carry-forward 必须**如实**写成"沿用"，不得写成"本轮计算成功"） */
  stateSourceText: string;
  messages: PanelProjectionInputs['messages'];
  objects: PanelProjectionInputs['objects'];
  actions: PanelProjectionInputs['allowedActions'];
  ui: PanelUiState;
  /** 准确的空状态说明（缺什么就说什么） */
  empty: string[];
  /** 投影**不重新计算剧情**（恒为 none；任何"值会动"的说法必须来自 Agent 已提交结果） */
  computed: 'none';
}

/** 状态来源 → 如实文案。**不允许**把沿用快照说成"新变量演化成功"。 */
export function describeStateSource(state: PanelProjectionInputs['state']): string {
  if (!state) return '未请求状态';
  if (!state.exists) return '本条消息没有自己的状态快照（不回退最新状态；不显示伪数值）';
  switch (state.source) {
    case 'turn-carry-forward':
      return `本回合**沿用**已保存状态${state.note ? `（${state.note}）` : ''}：可用于历史展示与页面刷新，**不代表本轮已计算出新变量**`;
    case 'card-write':
      return `状态来自卡片/用户写入${state.note ? `（${state.note}）` : ''}`;
    case 'seed':
      return '状态来自开局种子数据';
    default:
      return `状态已存在（v${state.stateVersion ?? '?'}）${state.note ? `：${state.note}` : ''}`;
  }
}

export function buildPanelProjection(inputs: PanelProjectionInputs): PanelProjection {
  const { state, scope, messages, objects, allowedActions } = inputs;
  const empty: string[] = [];
  if (!state) {
    empty.push('未读取状态：面板未订阅或读取未返回');
  } else if (!state.exists) {
    empty.push(scope === 'message' ? '该消息暂无状态快照' : '当前会话暂无权威状态');
  }
  if (messages.length === 0) empty.push('没有已授权的消息记录');
  if (objects.length === 0) empty.push('没有带明确来源的对象/联系人');
  if (allowedActions.length === 0) empty.push('当前没有允许的用户动作（只读展示）');

  const unknownSource = objects.filter((o) => !o.source);
  if (unknownSource.length > 0) empty.push(`有 ${unknownSource.length} 个对象缺少来源（不展示无名来源对象）`);

  return {
    target: inputs.target,
    scope,
    state: state
      ? {
        exists: state.exists, source: state.source, note: state.note, stateVersion: state.stateVersion,
        fields: state.exists
          ? (inputs.includeAllStateFields ? { ...(state.values ?? {}) } : applyFieldMap(state.values, inputs.fieldMap))
          : {},
      }
      : null,
    stateSourceText: describeStateSource(state),
    messages,
    objects: objects.filter((o) => Boolean(o.source)),
    actions: allowedActions,
    ui: inputs.ui ?? {},
    empty,
    computed: 'none',
  };
}

// ────────────────────────── 事件用途分流（FE-05.2） ──────────────────────────

/** 面板事件用途（与 FE-04 的宿主事件用途一一对应，不新增机制） */
export type PanelEventPurpose = 'message-state' | 'session-state' | 'message' | 'ui';

export interface PanelSubscription {
  /** 面板订阅的用途集合（显式声明；不订阅就不收） */
  purposes: PanelEventPurpose[];
  /** 面板目标（用于过滤） */
  target: ViewTarget & { sessionId: string; sessionRunId: string };
  /** 对 message 用途：是否关心本会话全部消息（列表/未读） */
  watchMessages?: boolean;
}

export interface PanelEvent {
  purpose: PanelEventPurpose;
  target?: ViewTarget;
  sessionId?: string;
  sessionRunId?: string;
}

/**
 * 判定某条宿主事件是否应投递给该面板。
 * 纪律：**无目标的状态事件不得应用到具体视图**；跨会话/跨运行实例一律不投递。
 */
export function routePanelEvent(sub: PanelSubscription, ev: PanelEvent): { deliver: boolean; reason: string } {
  if (!sub.purposes.includes(ev.purpose)) {
    return { deliver: false, reason: `面板未订阅 ${ev.purpose} 用途` };
  }
  if (ev.sessionId && ev.sessionId !== sub.target.sessionId) {
    return { deliver: false, reason: '事件属于其它会话（不串会话）' };
  }
  if (ev.sessionRunId && ev.sessionRunId !== sub.target.sessionRunId) {
    return { deliver: false, reason: '事件属于已失效的会话运行实例（旧结果不得显示到新面板）' };
  }
  if (ev.purpose === 'ui') return { deliver: true, reason: '本地 UI 状态，仅面板自身处理' };

  if (ev.purpose === 'message-state') {
    if (!ev.target || (ev.target.messageId === undefined && !ev.target.messageKey)) {
      return { deliver: false, reason: '状态事件没有消息目标 → 不应用到具体视图（避免所有面板都去读"最新状态"）' };
    }
    const same = (ev.target.messageId !== undefined && ev.target.messageId === sub.target.messageId)
      || (!!ev.target.messageKey && ev.target.messageKey === sub.target.messageKey);
    return same
      ? { deliver: true, reason: '该消息就是本面板的目标消息' }
      : { deliver: false, reason: '状态事件属于其它消息（不替换本面板的历史状态）' };
  }
  if (ev.purpose === 'session-state') {
    return { deliver: true, reason: '面板显式订阅了会话状态变化' };
  }
  // message：列表 / 未读 / 消息提示
  return sub.watchMessages
    ? { deliver: true, reason: '同会话消息生命周期通知（列表/未读用）' }
    : { deliver: false, reason: '面板未声明关心消息列表' };
}

// ────────────────────────── UI 偏好存储（与剧情变量分离） ──────────────────────────

/** 面板 UI 状态（纯偏好；绝不是剧情变量） */
export interface PanelUiState {
  /** 抽屉是否展开 */
  drawerOpen?: boolean;
  /** 当前选中对象 id */
  activeObjectId?: string;
  /** 未发送草稿 */
  draft?: string;
  /** 已读游标：**引用既有稳定消息身份**（messageId），不建影子聊天表 */
  readCursorMessageId?: number;
  /** 尺寸档位 */
  size?: 'sm' | 'md' | 'lg';
  /** 面板内主题 */
  theme?: string;
}

/** 面板偏好与草稿使用共享 client namespace，但保持两类用途键分离。 */
export function uiPrefsKey(
  namespace: ClientStorageNamespace,
  sessionId: string,
  moduleId: string,
): string {
  return namespace.sessionPreferenceKey(sessionId, 'panel.' + moduleId);
}

export function uiDraftKey(
  namespace: ClientStorageNamespace,
  sessionId: string,
  moduleId: string,
): string {
  return namespace.draftKey(sessionId, 'panel.' + moduleId);
}

/** 可替换存储（node 测试用内存实现；浏览器默认 localStorage） */
interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const memoryKV = new Map<string, string>();
let kv: KV = {
  getItem: (k) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : (memoryKV.get(k) ?? null)),
  setItem: (k, v) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
    else memoryKV.set(k, v);
  },
};

export function setUiPrefStorage(impl: KV | null): void {
  if (impl) { kv = impl; return; }
  kv = {
    getItem: (k) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : (memoryKV.get(k) ?? null)),
    setItem: (k, v) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
      else memoryKV.set(k, v);
    },
  };
}

/** UI 偏好写入计数（**单独统计**，不得混入剧情写入与权威状态写入） */
let uiWrites = 0;
export function uiPrefWrites(): number { return uiWrites; }
export function resetUiPrefWrites(): void { uiWrites = 0; }

export function loadPanelUi(
  namespace: ClientStorageNamespace,
  sessionId: string,
  moduleId: string,
): PanelUiState {
  try {
    const raw = kv.getItem(uiPrefsKey(namespace, sessionId, moduleId));
    const v = raw ? JSON.parse(raw) as PanelUiState : {};
    const draftRaw = kv.getItem(uiDraftKey(namespace, sessionId, moduleId));
    const draft = draftRaw ? JSON.parse(draftRaw) as unknown : undefined;
    return v && typeof v === 'object'
      ? { ...v, ...(typeof draft === 'string' ? { draft } : {}) }
      : {};
  } catch { return {}; }
}

/** 写入面板 UI 偏好（合并 patch）。计数 +1；**不触碰任何状态仓库/消息**。 */
export function savePanelUi(
  namespace: ClientStorageNamespace,
  sessionId: string,
  moduleId: string,
  patch: PanelUiState,
): PanelUiState {
  const next = { ...loadPanelUi(namespace, sessionId, moduleId), ...patch };
  const { draft, ...preferences } = next;
  try {
    kv.setItem(uiPrefsKey(namespace, sessionId, moduleId), JSON.stringify(preferences));
    if (typeof draft === 'string') {
      kv.setItem(uiDraftKey(namespace, sessionId, moduleId), JSON.stringify(draft));
    }
    uiWrites += 1;
  } catch { /* 存储失败不抛 */ }
  return next;
}

/**
 * 渲染位置/主题等**展示偏好**（跨会话复用的那一类）与面板 UI 分开命名空间，避免混装。
 * 例：`sceneUi` 决定场景区段默认走原生舞台还是卡自带前端 —— 由**用户配置**决定，不按卡名强制。
 */
export interface ViewPrefs {
  /** 场景区段默认渲染：原生舞台 / 卡自带前端页 */
  sceneUi: 'native' | 'external';
}
export function loadViewPrefs(namespace: ClientStorageNamespace): ViewPrefs {
  try {
    const raw = kv.getItem(namespace.preferenceKey('view'));
    const v = raw ? (JSON.parse(raw) as Partial<ViewPrefs>) : null;
    return { sceneUi: v?.sceneUi === 'external' ? 'external' : 'native' };
  } catch { return { sceneUi: 'native' }; }
}

export function saveViewPrefs(
  namespace: ClientStorageNamespace,
  patch: Partial<ViewPrefs>,
): ViewPrefs {
  const next = { ...loadViewPrefs(namespace), ...patch };
  try {
    kv.setItem(namespace.preferenceKey('view'), JSON.stringify(next));
    uiWrites += 1;
  } catch { /* ignore */ }
  return next;
}

// ────────────────────── 面板订阅登记（正确目标收到更新 / 退订后不再重复通知） ──────────────────────

interface PanelSubEntry {
  sub: PanelSubscription;
  delivered: number;
  filtered: number;
  lastReason: string;
}
const panelSubs = new Map<string, PanelSubEntry>();

/** 面板订阅（显式声明用途；不订阅就不收） */
export function subscribePanel(panelId: string, sub: PanelSubscription): void {
  panelSubs.set(panelId, { sub, delivered: 0, filtered: 0, lastReason: '已订阅' });
}

/** 退订：撤销后不再收到任何事件（也不产生"重复通知"） */
export function unsubscribePanel(panelId: string): boolean {
  return panelSubs.delete(panelId);
}

export function isPanelSubscribed(panelId: string): boolean { return panelSubs.has(panelId); }

/**
 * AM-05：事件订阅回调（**扩展既有通知入口，不新增事件总线**）。
 *
 * `dispatchPanelEvent` 只返回逐面板判定，不能唤醒具体组件；记忆控制台是常驻 React 组件而非
 * 卡声明面板，需要一个"收到已提交事件"的回调。这里只把**同一个** dispatchPanelEvent 的入参
 * 转发给已注册回调，事件源、用途分流、目标过滤规则完全不变。
 */
const panelEventListeners = new Set<(ev: PanelEvent) => void>();

export function subscribePanelEvents(fn: (ev: PanelEvent) => void): () => void {
  panelEventListeners.add(fn);
  return () => { panelEventListeners.delete(fn); };
}

export function panelEventListenerCount(): number { return panelEventListeners.size; }

/**
 * 派发宿主事件给所有订阅面板：按目标过滤，返回逐面板判定。
 * **无目标的状态事件不得应用到具体视图**；已退订的面板不会出现在结果里。
 */
export function dispatchPanelEvent(ev: PanelEvent): { panelId: string; deliver: boolean; reason: string }[] {
  const out: { panelId: string; deliver: boolean; reason: string }[] = [];
  for (const [panelId, entry] of panelSubs) {
    const r = routePanelEvent(entry.sub, ev);
    if (r.deliver) entry.delivered += 1; else entry.filtered += 1;
    entry.lastReason = r.reason;
    out.push({ panelId, deliver: r.deliver, reason: r.reason });
  }
  // 回调在判定之后触发（回调内部自行按作用域/版本过滤；跨会话事件不得串数据）
  for (const fn of panelEventListeners) {
    try { fn(ev); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
  return out;
}

export function panelSubStats(): {
  panelId: string; purposes: PanelEventPurpose[]; delivered: number; filtered: number; lastReason: string;
}[] {
  return [...panelSubs].map(([panelId, e]) => ({
    panelId, purposes: e.sub.purposes, delivered: e.delivered, filtered: e.filtered, lastReason: e.lastReason,
  }));
}

export function resetPanelSubs(): void { panelSubs.clear(); }

/** 暴露给浏览器探针（只读） */
export function installPanelSubProbe(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__jgPanelSubs = () => panelSubStats();
}
import type { ClientStorageNamespace } from '../../../../packages/client-runtime/src/index.ts';
