/**
 * FE-04-C 会话宿主（session host）：**唯一的会话级执行持有者**
 *
 * 为什么需要：会话级脚本（无导出 / 无 DOM 依赖 / 纯副作用）此前被"移出每条消息"，
 * 但**没有新的执行位置** —— 等于既不重复执行、也没真正执行。本模块补上那个位置。
 *
 * 边界（受控的兼容运行位置，不是把主应用开放给卡片）：
 *  - 独立 realm：隐藏 iframe，`sandbox="allow-scripts"`（**不放 allow-same-origin**）→ 拿不到主应用 DOM / 密钥
 *  - 同一会话运行周期（sessionRunId）**只允许一个会话执行实例**；新增消息、流式变化、历史展开都不重建它
 *  - 只读脚本包可共用缓存；可变全局 / 监听器 / 定时器按会话隔离（各自 realm）
 *  - 清理：会话切换或组件卸载 → 移除 iframe（页面 pagehide → 运行时 dispose）
 *
 * 与环境需求分开表达（不合并成一个 "scope"）：
 *  生命周期：`session`（本宿主） vs `page`（消息视图内）
 *  环境需求：export / dom / storage / module —— 见 `SessionHostPlan.notes`
 */
import { buildFullDocSrcDoc, injectBeforeEnd, type ViewTarget } from '../htmlCore.ts';
import type { SharedScriptBundle, SharedScriptEntry, SharedRuntimeStatus } from './sharedRuntime.ts';

export interface SessionHostPlan {
  /** 是否需要挂载会话宿主（没有会话级脚本就不挂） */
  needed: boolean;
  /** 归会话执行的脚本（按清单顺序） */
  scripts: SharedScriptEntry[];
  reason: string;
  /** 环境需求说明（与生命周期分开表达，供报告/诊断；不参与调度） */
  notes: string[];
}

/**
 * 规划会话宿主：只挑**已准入且作用域为 session** 的脚本。
 * 纪律：`sessionScopeModules` 是**分类**，不是权限 —— 这里只负责"在哪执行"，
 * 能不能执行由执行准入（admission）已经决定；未登记的模块不会出现在 bundle.scripts 里。
 */
export function planSessionHost(bundle: SharedScriptBundle): SessionHostPlan {
  const scripts = (bundle.scripts ?? []).filter((s) => (s.scope ?? 'page') === 'session');
  const notes = scripts.map((s) => {
    const env: string[] = [];
    if ((s.capabilities ?? []).includes('network-module')) env.push('module');
    if ((s.capabilities ?? []).includes('storage')) env.push('storage');
    if ((s.capabilities ?? []).includes('dom-ui')) env.push('dom');
    if ((s.provides ?? []).length > 0) env.push('export');
    return `${s.name}：生命周期=session（同一运行实例一次）；环境需求=${env.join('+') || '纯脚本'}`;
  });
  if (!scripts.length) {
    return { needed: false, scripts: [], reason: '本会话没有准入为 session 作用域的脚本，无需会话宿主', notes: [] };
  }
  return {
    needed: true, scripts, notes,
    reason: `会话级脚本 ${scripts.length} 个：${scripts.map((s) => s.name).join('、')}（同一 sessionRunId 只启动一次）`,
  };
}

/** 会话宿主文档：只带会话级脚本的运行包（复用统一交互 shim / 资源链 / 消息身份契约）
 *
 *  FE-05.1：宿主文档内提供一个**局部渲染根**（`#jg-session-host`），把会话实例的真实状态
 *  （作用域 / 运行实例 / 复用 / 逐脚本结果 / 入口完成）以纯 DOM 摘要呈现。
 *  这样"把同一个会话实例停靠进可见容器"才有可见内容；通用实现，不含任何卡名。
 */
export function buildSessionHostSrcDoc(
  bundle: SharedScriptBundle,
  plan: SessionHostPlan,
  token: string,
  target: ViewTarget,
  sessionOnlySnippet: string,
): string {
  const hostDoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;background:#12141a;color:#e6e8ee;font:12px/1.7 ui-monospace,Menlo,Consolas,monospace}'
    + '#jg-session-host{padding:10px 12px;height:100%;box-sizing:border-box}'
    + 'h4{margin:0 0 6px;font-size:12px;color:#9aa3b2;font-weight:600}'
    + '#jg-session-status{white-space:pre-wrap;margin:0}'
    + '</style></head><body><div id="jg-session-host" data-scope="session">'
    + '<h4>会话运行实例（同一 sessionRunId 只启动一次）</h4><pre id="jg-session-status">等待会话脚本上报…</pre>'
    + '</div></body></html>';
  const doc = buildFullDocSrcDoc(hostDoc, token, sessionOnlySnippet, target);
  const NL = String.fromCharCode(10);
  const statusView = '<script>(function(){'
    + 'var el=document.getElementById("jg-session-status");if(!el)return;var t0=Date.now();'
    + 'function render(){var s=window.__jgShared&&window.__jgShared.status;'
    + 'if(s){var it=(s.coreScripts&&s.coreScripts.items)||[];'
    + 'el.textContent=["作用域："+(s.scope||"-"),"运行实例："+(s.sessionRunId||"-"),'
    + '"清单指纹："+String(s.manifestHash||"-").slice(0,8),"复用已有实例："+(s.reused?"是":"否"),'
    + '"子文档(REALM)："+((s.realm&&s.realm.bootId)||"-")+" / 内存标记="+((s.realm&&s.realm.memMarker)||0)+" / 启动="+((s.realm&&s.realm.scriptStarts)||0),'
    + '"脚本："+(it.length?it.map(function(i){return i.name+(i.ok?" ✓":" ✗ "+(i.error||""));}).join(" / "):"无"),'
    + '"入口全部完成："+(s.coreScripts&&s.coreScripts.ok?"是":"否")].join(String.fromCharCode(10));}'
    + 'else if(Date.now()-t0>15000){el.textContent="没有会话级脚本上报（或尚未完成加载）";}'
    + 'setTimeout(render,250);}render();})();' + NL + '</script>';
  void bundle; void plan;
  return injectBeforeEnd(doc, statusView);
}

// ────────────────────────── 执行计数（跨运行环境汇总） ──────────────────────────

export interface SessionHostRecord {
  sessionId: string;
  sessionRunId: string;
  manifestHash: string;
  /** 宿主 realm 实例 id（运行时上报） */
  instanceId: string;
  /** 实际启动过的脚本（同一 realm 内不重复） */
  executed: string[];
  /** 是否复用（同 realm + 同清单已初始化） */
  reused: boolean;
  startedAt: number;
  endedAt?: number;
  /** FE-06.0：**子文档自身**的生命周期证据（bootId / 仅内存标记 / 启动与清理次数） */
  realm?: SharedRuntimeStatus['realm'];
  /** 本运行实例出现过的所有子文档 bootId（**新增条目 = 文档被重建**） */
  bootIds?: string[];
}

const hosts = new Map<string, SessionHostRecord>();

export function recordSessionHost(rec: Omit<SessionHostRecord, 'startedAt' | 'endedAt'>): SessionHostRecord {
  const key = `${rec.sessionId}|${rec.sessionRunId}`;
  const prev = hosts.get(key);
  if (prev && prev.manifestHash === rec.manifestHash) {
    // 同一运行实例重复挂载 → 更新计数但保留 startedAt（用于证明"只启动一次"）
    // FE-06.0：累计出现过的子文档 bootId —— 条目增加即"子文档被重建"（父层逻辑身份可能没变）
    const bootIds = [...new Set([...(prev.bootIds ?? []), ...(rec.realm?.bootId ? [rec.realm.bootId] : [])])];
    const merged: SessionHostRecord = {
      ...prev, executed: rec.executed, reused: rec.reused, instanceId: rec.instanceId,
      realm: rec.realm ?? prev.realm, bootIds,
    };
    hosts.set(key, merged);
    return merged;
  }
  const fresh: SessionHostRecord = {
    ...rec, startedAt: Date.now(),
    bootIds: rec.realm?.bootId ? [rec.realm.bootId] : [],
  };
  hosts.set(key, fresh);
  return fresh;
}

export function endSessionHost(sessionId: string, sessionRunId: string): void {
  const key = `${sessionId}|${sessionRunId}`;
  const prev = hosts.get(key);
  if (prev) hosts.set(key, { ...prev, endedAt: Date.now() });
}

export function listSessionHosts(): SessionHostRecord[] {
  return [...hosts.values()];
}

export function clearSessionHosts(): void { hosts.clear(); }

/** 汇总：按会话运行实例统计会话级脚本的**实际启动次数**（跨全部运行环境） */
export function summarizeSessionExecutions(): {
  run: string; instanceId: string; reused: boolean; executed: string[]; starts: number; ended: boolean;
  realmBootId?: string; realmMemMarker?: number; realmScriptStarts?: number; realmCleanedUp?: number; bootIdCount: number;
}[] {
  return [...hosts.values()].map((h) => ({
    run: h.sessionRunId, instanceId: h.instanceId, reused: h.reused,
    executed: h.executed, starts: h.reused ? 0 : h.executed.length,
    ended: h.endedAt !== undefined,
    // FE-06.0：子文档证据（bootId 是文档级；memMarker 持续增长 = 同一文档在跑）
    realmBootId: h.realm?.bootId, realmMemMarker: h.realm?.memMarker,
    realmScriptStarts: h.realm?.scriptStarts, realmCleanedUp: h.realm?.cleanedUp,
    bootIdCount: (h.bootIds ?? []).length,
  }));
}

/** 暴露给浏览器探针（只读） */
export function installSessionHostProbe(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__jgSessionHosts = () => ({ hosts: listSessionHosts(), summary: summarizeSessionExecutions() });
  // FE-05.1：停靠日志（打开面板时实例被移动但**不重建**的证据）
  w.__jgSessionHostDocs = () => sessionHostDocBuilds();
  w.__jgSessionHostDock = () => ({
    log: sessionHostDockLog(),
    /** 会话实例 iframe 当前是否仍是同一个浏览上下文 */
    hasFrame: Boolean(hostFrameEl),
  });
}

// ─────────────────── FE-05.1 会话实例停靠（可见表面复用同一 iframe） ───────────────────

/**
 * 会话执行实例的 **iframe 元素注册表**。
 *
 * 为什么需要：FE-05 要求在**同一个会话运行实例**上增加可见面板，而不是再建一套手机宿主。
 * 浏览器里"移动一个已存在的 iframe DOM 节点"（appendChild 到另一个容器）**不会重建浏览上下文**，
 * 因此可见面板可以复用同一个 iframe；相对地，`srcDoc` 重新赋值会整页重载 —— 本轮严禁这么做。
 */
let hostFrameEl: HTMLIFrameElement | null = null;
/** 隐藏锚点（iframe 的"原位"）；由 SessionHost 组件渲染的固定容器 */
let hostAnchorEl: HTMLElement | null = null;
/** 停靠次数统计（报告用；正常情况下停靠不产生新的脚本启动） */
const dockLog: {
  action: 'dock' | 'undock' | 'noop' | 'failed';
  at: number;
  /** 移动前后 WindowProxy 是否同一对象（**跨源沙箱下不可靠，仅参考**） */
  keptWindowProxy: boolean | null;
  /** 移动前后运行时实例 id 是否相同。**null = 跨源不可读**（不用 false 冒充"已重启"） */
  keptInstance: boolean | null;
  instanceBefore: string | null;
  instanceAfter: string | null;
}[] = [];

export function setSessionHostFrameEl(el: HTMLIFrameElement | null): void { hostFrameEl = el; }
export function getSessionHostFrameEl(): HTMLIFrameElement | null { return hostFrameEl; }
export function setSessionHostAnchorEl(el: HTMLElement | null): void { hostAnchorEl = el; }
export function getSessionHostAnchorEl(): HTMLElement | null { return hostAnchorEl; }

/**
 * 尝试读取会话实例内部的运行时实例 id。
 * `sandbox="allow-scripts"` 是**不透明源**，父窗口跨源读 `__jgShared` 会在多数浏览器抛错或返回 undefined。
 * 读不到就返回 null（**不猜**）；此时以宿主侧 `listSessionHosts()` 记录的 instanceId 为准（那是经 postMessage 上报的）。
 */
function readInstanceId(el: HTMLIFrameElement | null): string | null {
  try {
    const w = el?.contentWindow as unknown as { __jgShared?: { instanceId?: string } } | null;
    return w?.__jgShared?.instanceId ?? null;
  } catch { return null; }
}

function recordDock(action: 'dock' | 'undock' | 'noop' | 'failed', keptWindowProxy: boolean | null, ib: string | null, ia: string | null): void {
  dockLog.push({
    action, at: Date.now(), keptWindowProxy,
    keptInstance: ib === null || ia === null ? null : ib === ia,
    instanceBefore: ib, instanceAfter: ia,
  });
}

/**
 * FE-06.0 修订：会话实例**固定挂载**，不再做 DOM 移动。
 *
 * 实测（真实浏览器、确定性复现）：把 iframe 从锚点 appendChild 到抽屉、关闭时再 appendChild 回来，
 * 会让**子文档被重建**（realmBootId 变化、bootIds 1→2），而 `srcDoc` 根本没变 ——
 * 重建来自"元素被移出文档又被放回"，不是父组件逻辑身份变化。
 * 会话级脚本"只执行一次"依赖同一个文档存活，因此改为：
 *   - iframe **始终留在同一个父容器**（舞台容器），不做 appendChild 迁移；
 *   - 打开面板只改变**外层容器**的显示/定位/尺寸（CSS），抽屉外观由外层容器表现；
 *   - 不复制 iframe、不重写 srcdoc、不新建第二个运行实例。
 */
export function dockSessionHostFrame(container?: HTMLElement | null): { ok: boolean; keptIdentity: boolean | null; keptInstance: boolean | null; reason: string } {
  void container;
  const el = hostFrameEl;
  if (!el) {
    recordDock('failed', null, null, null);
    return { ok: false, keptIdentity: null, keptInstance: null, reason: '没有可用的会话执行实例（本会话无会话级脚本或尚未挂载）' };
  }
  const i = readInstanceId(el);
  recordDock('noop', true, i, i);
  return {
    ok: true, keptIdentity: true, keptInstance: null,
    reason: '会话实例**固定挂载**在舞台容器：不移动 DOM，抽屉外观由外层容器（显示/定位/尺寸）表现',
  };
}

/** 兼容保留：固定挂载后无需归还（不产生 DOM 迁移）。 */
export function undockSessionHostFrame(): { ok: boolean; keptIdentity: boolean | null; keptInstance: boolean | null; reason: string } {
  const el = hostFrameEl;
  if (!el) {
    recordDock('failed', null, null, null);
    return { ok: false, keptIdentity: null, keptInstance: null, reason: '没有会话执行实例' };
  }
  const i = readInstanceId(el);
  recordDock('noop', true, i, i);
  return {
    ok: true, keptIdentity: true, keptInstance: null,
    reason: '会话实例保持固定挂载（无需归还）：关闭面板只隐藏外层容器，实例继续存活',
  };
}

/** FE-06.0：向会话实例发一次心跳（复用既有 host 通道；子文档回一次状态上报 → 内存标记自增） */
export function pingSessionHost(): boolean {
  const el = hostFrameEl;
  if (!el) return false;
  try {
    const token = (el.getAttribute('data-session-run') ?? '');
    void token;
    el.contentWindow?.postMessage({ __jgfh: 'host', op: 'ping' }, '*');
    return true;
  } catch { return false; }
}

export function sessionHostDockLog(): typeof dockLog { return [...dockLog]; }
export function resetSessionHostDockLog(): void { dockLog.length = 0; }

// ─────────────── FE-06.0：会话宿主**文档重建**诊断（先测后改） ───────────────

/**
 * 记录"宿主文档被重新生成"的事实与**可归因的触发原因**。
 * 目的：把"父组件逻辑身份没变"与"子文档其实被重建了"分开。若只有 srcDoc 长度变化、
 * 而 manifestHash / token / sessionRunId 都没变，说明是**文档内容被重新生成**（而不是身份切换）。
 */
const docBuilds: {
  at: number; changed: string[]; len: number; instanceHint: string;
}[] = [];

export function noteSessionHostDocBuild(reason: {
  changed: string[]; len: number; manifestHash: string; sessionRunId: string;
}): number {
  docBuilds.push({
    at: Date.now(), changed: reason.changed, len: reason.len,
    instanceHint: `${reason.manifestHash.slice(0, 6)}/${reason.sessionRunId}`,
  });
  return docBuilds.length;
}

export function sessionHostDocBuilds(): typeof docBuilds { return [...docBuilds]; }
export function resetSessionHostDocBuilds(): void { docBuilds.length = 0; }
