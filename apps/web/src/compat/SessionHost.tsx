/**
 * FE-04-C 会话宿主组件：挂载唯一的会话级执行实例（独立 realm iframe）
 *
 * 生命周期（与任务书一致）：
 *   创建 → 准备运行包 → 启动准入模块 → 就绪或明确降级 → 清理 → 失效
 *
 * 纪律：
 *  - **不随消息轮换**：只在 sessionId / sessionRunId / manifestHash 变化时重建
 *  - **消息页面挂载 / 流式正文变化 / 历史展开**都不重新引导它
 *  - 清理：卸载或切换会话 → endSessionHost + 移除 iframe（运行时 pagehide → dispose）
 *
 * FE-05.1 补充：本实例同时是"可见面板可停靠的运行时"。
 *  iframe 元素登记到 `sessionHost.ts`，由 SurfaceHost 通过 **DOM 移动**（appendChild）
 *  停靠 / 归还 —— **不重设 srcDoc、不新建第二个 iframe**，因此浏览上下文与会话状态都保留。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildFramePost, createFrameToken, isJgFrameMessage, registerFrame } from '../gal/bridge.ts';
import { buildSharedRuntimeSnippet, parseSharedStatus, recordSharedStatus, type SharedScriptBundle } from './sharedRuntime.ts';
import {
  buildSessionHostSrcDoc, endSessionHost, planSessionHost, recordSessionHost, installSessionHostProbe,
  setSessionHostFrameEl, setSessionHostAnchorEl, noteSessionHostDocBuild,
} from './sessionHost.ts';

export function SessionHost({
  sessionId,
  sessionRunId,
  bundle,
}: {
  sessionId: string | null;
  sessionRunId: string;
  bundle: SharedScriptBundle;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const token = useMemo(() => createFrameToken(), [sessionId, sessionRunId, bundle.manifestHash]);
  const plan = useMemo(() => planSessionHost(bundle), [bundle]);
  const [ready, setReady] = useState(false);

  // 会话级运行包（只带 session 作用域脚本）——同一 realm 内运行时自身也会按清单幂等
  const sessionOnly = useMemo<SharedScriptBundle>(
    () => ({ ...bundle, scripts: plan.scripts }),
    [bundle, plan],
  );
  const snippet = useMemo(
    () => (plan.needed ? buildSharedRuntimeSnippet(sessionOnly, token, { scope: 'session', sessionRunId }) : undefined),
    [plan.needed, sessionOnly, token, sessionRunId],
  );
  const srcDoc = useMemo(
    () => (snippet
      ? buildSessionHostSrcDoc(sessionOnly, plan, token, { sessionId: sessionId ?? '', sessionRunId }, snippet)
      : undefined),
    [snippet, sessionOnly, plan, token, sessionId, sessionRunId],
  );

  useEffect(() => { installSessionHostProbe(); }, []);
  // FE-06.0：诊断"宿主文档被重新生成"——把身份变化与内容变化分开归因（先测后改）
  const prevDeps = useRef<{ manifest: string; token: string; run: string; snippet: boolean } | null>(null);
  useEffect(() => {
    if (!srcDoc) return;
    const prev = prevDeps.current;
    const changed: string[] = [];
    if (!prev) changed.push('首次挂载');
    else {
      if (prev.manifest !== bundle.manifestHash) changed.push('manifestHash');
      if (prev.token !== token) changed.push('token');
      if (prev.run !== sessionRunId) changed.push('sessionRunId');
      if (prev.snippet !== Boolean(snippet)) changed.push('snippet存在性');
      if (changed.length === 0) changed.push('仅文档内容变化（身份未变）');
    }
    prevDeps.current = { manifest: bundle.manifestHash, token, run: sessionRunId, snippet: Boolean(snippet) };
    const n = noteSessionHostDocBuild({ changed, len: srcDoc.length, manifestHash: bundle.manifestHash, sessionRunId });
    if (n > 1) {
      console.warn(`[会话宿主] 宿主文档重新生成（第 ${n} 次）：${changed.join(' / ')}（长度 ${srcDoc.length}）`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcDoc]);
  // FE-05.1：把实例元素与隐藏锚点登记给停靠逻辑（供可见面板复用同一 iframe）
  useEffect(() => {
    setSessionHostFrameEl(ref.current);
    setSessionHostAnchorEl(anchorRef.current);
    return () => { setSessionHostFrameEl(null); setSessionHostAnchorEl(null); };
  }, [srcDoc]);

  // 执行计数汇总（跨运行环境）：宿主侧按会话运行实例记录实际启动
  useEffect(() => {
    if (!plan.needed || !sessionId) return;
    return () => { endSessionHost(sessionId, sessionRunId); };
  }, [plan.needed, sessionId, sessionRunId]);

  useEffect(() => {
    if (!srcDoc) return undefined;
    const win = ref.current?.contentWindow;
    const unregister = win ? registerFrame(win, buildFramePost(win, '*', token), token) : undefined;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return;
      // **两条不同通道必须分开校验**（真实浏览器才暴露的缺陷）：
      //   ① 会话宿主的执行状态上报（__jgfh_h='shared-status'）→ 由 parseSharedStatus 解析；
      //   ② 卡页面的交互帧消息（height/size/choice/draft/rpc）→ 由 isJgFrameMessage 校验。
      // 此前只用 isJgFrameMessage 过滤，① 恒被判为非法而丢弃 → recordSessionHost 永不执行、
      // 执行计数与 starts 永远为空（"会话脚本到底跑没跑"无法回答）。
      const isStatus = data.__jgfh_h === 'shared-status';
      if (isStatus) {
        if (token && data.token !== token) return; // 仍必须来自本帧（token 由本组件创建）
      } else if (!isJgFrameMessage(data, token)) return;
      const st = parseSharedStatus(data);
      if (!st) return;
      setReady(true);
      // 宿主侧状态汇集：会话实例的执行结果同样要进 `sharedRuntime` 的状态中枢，
      // 否则只跑会话脚本的会话（无消息页面）永远拿不到"脚本跑没跑"的上报（FE-05 资源预载判定依赖它）。
      recordSharedStatus(st);
      recordSessionHost({
        sessionId: sessionId ?? '',
        sessionRunId,
        manifestHash: bundle.manifestHash,
        instanceId: st.instanceId,
        executed: (st.coreScripts.items ?? []).map((i) => i.name),
        reused: st.reused === true,
        realm: st.realm,
      });
      console.info(`[会话宿主] run=${sessionRunId} 实例=${st.instanceId} 子文档=${st.realm?.bootId ?? "-"} 内存标记=${st.realm?.memMarker ?? 0} 启动=${st.realm?.scriptStarts ?? 0} 复用=${st.reused === true} 脚本=${(st.coreScripts.items ?? []).map((i) => `${i.name}${i.ok ? '' : '(失败)'}`).join(',') || '无'}`);
    };
    window.addEventListener('message', onMsg);
    return () => {
      unregister?.();
      window.removeEventListener('message', onMsg);
    };
  }, [srcDoc, token, sessionId, sessionRunId, bundle.manifestHash]);

  if (!plan.needed || !srcDoc) return null;
  return (
    // 隐藏锚点：iframe 的"原位"。面板打开时被 SurfaceHost 临时移动到可见容器，关闭时移回这里。
    <div ref={anchorRef} className="jg-session-host-anchor" data-scope="session-anchor" aria-hidden="true">
      <iframe
        ref={ref}
        className="jg-session-host"
        title="会话级执行宿主"
        data-scope="session"
        data-session-run={sessionRunId}
        data-ready={ready ? '1' : '0'}
        aria-hidden="true"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ position: 'absolute', width: 1, height: 1, left: -9999, top: 0, border: 0, opacity: 0 }}
      />
    </div>
  );
}
