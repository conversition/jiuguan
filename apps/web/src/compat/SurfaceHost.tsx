/**
 * FE-05.1 可见表面容器（SurfaceHost）
 *
 * 职责（通用核心）：面板登记后的**可见性、生命周期、内容挂载与停靠**。
 * 不负责：卡片业务、固定联系人、特定变量字段（这些由调用方以内容渲染器提供）。
 *
 * 关键实现纪律：
 *  - `session-runtime` 内容**复用唯一会话执行实例**：把 `SessionHost` 的 iframe 通过 DOM 移动停靠进抽屉，
 *    **不重设 srcdoc、不新建第二个 iframe**（打开/关闭只改变可见性与停靠位置）。
 *  - `external-page` / `card-html` 内容由调用方渲染（协议适配层负责形状转换）。
 *  - `render-plan` 内容渲染数据投影结果（纯数据形状，不重新计算剧情）。
 *  - 关闭抽屉 → 停靠归还隐藏锚点，会话实例继续存活（≠ 取消任务）。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import type { PanelDeclaration } from './surfaceRegistry.ts';
import { planSurfaceDock, subscribeSurfaces, listSurfaces, installSurfaceProbe } from './surfaceRegistry.ts';
import { dockSessionHostFrame, undockSessionHostFrame, getSessionHostFrameEl, pingSessionHost } from './sessionHost.ts';
import type { PanelProjection } from './panelProjection.ts';

export interface SurfaceHostProps {
  /** 当前会话身份（面板按运行实例有效性过滤） */
  sessionId: string | null;
  sessionRunId: string;
  /** 内容渲染器：由协议适配层提供（通用核心不认识卡片内容） */
  renderContent?: (d: PanelDeclaration, active: boolean) => React.ReactNode;
  /** render-plan 面板的数据投影结果（按 panelId 索引） */
  projections?: Record<string, PanelProjection>;
  /** 用户操作入口（由 App 的动作桥提供） */
  onAction?: (panelId: string, action: string, payload?: Record<string, unknown>) => void;
}

/** 通用数据面板：把投影结果渲染成"键 → 值"表格（**不解释业务字段含义**） */
function ProjectionView({ projection, panelId, onAction }: { projection?: PanelProjection; panelId?: string; onAction?: SurfaceHostProps['onAction'] }) {
  if (!projection) return <div className="surface-empty">无数据投影（面板尚未读取状态）</div>;
  const rows = Object.entries(projection.state?.fields ?? {});
  return (
    <div className="surface-projection">
      <div className="surface-row"><span className="surface-k">状态来源</span><span className="surface-v">{projection.stateSourceText}</span></div>
      {projection.state && (
        <>
          <div className="surface-row"><span className="surface-k">作用域</span><span className="surface-v">{projection.scope}</span></div>
          <div className="surface-row"><span className="surface-k">存在</span><span className="surface-v">{projection.state.exists ? '是' : '否'}</span></div>
          <div className="surface-row"><span className="surface-k">版本</span><span className="surface-v">{projection.state.stateVersion ?? '-'}</span></div>
        </>
      )}
      {rows.length > 0 && (
        <table className="surface-fields">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {projection.empty.length > 0 && (
        <ul className="surface-empty-list">{projection.empty.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
      <div className="surface-actions">
        {projection.actions.map((a) => (
          <button
            key={a.action}
            className="surface-btn"
            data-action={a.action}
            onClick={() => panelId && onAction?.(panelId, a.action)}
          >{a.label}</button>
        ))}
        {projection.actions.length === 0 && <span className="surface-hint">当前无允许动作（只读）</span>}
      </div>
      <p className="surface-hint">投影只转换数据形状，不重新计算剧情（computed={projection.computed}）</p>
    </div>
  );
}

/** 外部前端页：由调用方（协议适配层）提供真实渲染；此处只给出兜底提示，避免静默失败 */
function ExternalPageFallback({ url }: { url: string }) {
  return <div className="surface-empty">外部前端页（由协议适配层渲染）：<code>{url}</code></div>;
}

export function SurfaceHost({ sessionId, sessionRunId, renderContent, projections, onAction }: SurfaceHostProps) {
  const [, force] = React.useState(0);

  useEffect(() => { installSurfaceProbe(); }, []);
  useEffect(() => subscribeSurfaces(() => force((n) => n + 1)), []);

  // 当前运行实例下已登记的面板（会话切换即失效，不再展示）
  const entries = useMemo(
    () => listSurfaces().filter((e) => e.declaration.sessionRunId === sessionRunId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionRunId, listSurfaces().length, listSurfaces().filter((e) => e.visible).length],
  );
  const visible = entries.filter((e) => e.visible);

  // FE-06.0 修订：**不再移动 iframe 的 DOM**（DOM 迁移会让子文档被重建）。
  // 会话实例由 App 的舞台容器固定承载；这里只计算"是否需要以抽屉形态呈现"供日志/探针使用。
  const dockPlan = useMemo(() => planSurfaceDock(visible, { sessionHostAvailable: Boolean(getSessionHostFrameEl()) }), [visible]);
  useEffect(() => {
    if (dockPlan.docked) {
      const r = dockSessionHostFrame();
      console.info(`[可见表面] 抽屉呈现：${r.reason}`);
    } else {
      const r = undockSessionHostFrame();
      console.info(`[可见表面] 收起：${r.reason}`);
    }
    // 心跳：要求子文档回一次上报（正面证明同一子文档持续存活；复用既有 host 通道）
    const timers = [120, 520].map((ms) => setTimeout(() => pingSessionHost(), ms));
    return () => { for (const t of timers) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockPlan.docked, dockPlan.container]);

  if (!sessionId || entries.length === 0) return null;

  return (
    <div className="surface-host" data-scope="surfaces">
      {/* 面板切换条：登记的面板在此列出，点击即"打开/关闭可见性"（不重启会话脚本） */}
      <div className="surface-tabs" role="tablist">
        {entries.map((e) => {
          const isStatusLauncher = e.declaration.panelId === 'session-state-view';
          const actionLabel = `${e.visible ? '收起' : '打开'}${e.declaration.title}`;
          return (
          <button
            key={e.declaration.panelId}
            role="tab"
            aria-selected={e.visible}
            aria-label={actionLabel}
            className={`surface-tab${e.visible ? ' on' : ''}${isStatusLauncher ? ' surface-tab--status-fab' : ''}`}
            data-panel={e.declaration.panelId}
            data-module={e.declaration.moduleId}
            title={`${actionLabel}（来源模块 ${e.declaration.moduleId}）`}
            onClick={() => onAction?.(e.declaration.panelId, e.visible ? 'surface.close' : 'surface.open')}
          >
            {isStatusLauncher
              ? <span className='surface-tab-icon' aria-hidden='true'>态</span>
              : e.declaration.title}
          </button>
          );
        })}
      </div>
      {entries.map((e) => {
        const d = e.declaration;
        // Mount on first open, then retain the same component/iframe while
        // hidden. This preserves card tabs, scroll and in-frame state.
        const shouldMount = e.visible || e.openCount > 0;
        return (
          <section
            key={d.panelId}
            className={`surface-panel slot-${d.slot}`}
            hidden={!e.visible}
            aria-hidden={!e.visible}
            data-panel={d.panelId}
            data-content={d.content.kind}
            data-lifecycle={d.lifecycle}
          >
            <header className="surface-head">
              <span className="surface-title">{d.title}</span>
              <span className="surface-meta">{d.content.kind} · {d.lifecycle} · {d.actionMode}</span>
              <button className="surface-close" title="关闭面板（只隐藏，不取消任务）"
                onClick={() => onAction?.(d.panelId, 'surface.close')}>✕</button>
            </header>
            <div className="surface-body">
              {!shouldMount ? null : d.content.kind === 'session-runtime'
                ? <div className="surface-dock-note" data-dock="session-runtime">
                  会话运行实例**固定挂载**在舞台容器（不移动 DOM、不重设 srcdoc）：打开/关闭本面板只改变外层容器的显示与尺寸。
                </div>
                : d.content.kind === 'render-plan'
                  ? (renderContent?.(d, e.visible) ?? <ProjectionView projection={projections?.[d.panelId]} panelId={d.panelId} onAction={onAction} />)
                  : d.content.kind === 'external-page'
                    ? (renderContent?.(d, e.visible) ?? <ExternalPageFallback url={d.content.url} />)
                    : (renderContent?.(d, e.visible) ?? <ExternalPageFallback url="card-html（待适配层渲染）" />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 供测试使用：外部页 iframe 的交互桥辅助已由 gal/bridge 提供（此处不重复导出，避免第二套协议） */
