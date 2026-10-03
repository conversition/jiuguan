/**
 * HTML 消息渲染（酒馆式：任意卡片/AI 输出里的 HTML 前端直接渲染；分档通用，不针对单卡）
 *  - 完整文档（<!DOCTYPE/<html/<body）或含 <script> → 沙箱 srcdoc iframe
 *    （文档语义完整：:root CSS 变量 / html / body 选择器全生效；样式被 iframe 边界隔离）
 *  - 其余片段（<details>/<div> 等）→ Shadow DOM（样式隔离，自然流动布局）
 *
 * 交互化（通用适配，新卡无需额外处理）：
 *  iframe 沙箱 sandbox="allow-scripts allow-modals"（不透明源、无 allow-same-origin）：
 *    - 任意卡自带 <script>/onclick 原样放行 → 前端交互（标签页/开关/面板/上传）可用
 *    - 不透明源：卡脚本无法访问宿主 DOM / app 数据 / cookie / 宿主 localStorage，无法导航/弹窗/表单
 *    - 通用 shim + 通用测高见 htmlCore.ts
 *    - 交互桥：iframe 挂载时注册进 __jgfh 注册表（gal/bridge.ts）→ 卡脚本 postMessage choice/draft/rpc
 *      可把选项回传聊天（choice → 发用户消息触发 AI）、填输入框（draft）或远程调用宿主能力（rpc）
 *    残余风险（用户已确认取舍）：卡脚本可 fetch 外网泄露自身静态内容（无会话数据；静态 <img> 本就能外联）
 *  片段走 Shadow DOM（宿主同源）→ 仍剥离 script / 事件处理器 / javascript: 链接，防 XSS
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml, looksLikeFullDoc, buildFullDocSrcDoc, type ViewTarget } from './htmlCore.ts';
import { planResourceRewrite } from './compat/resourceLoader.ts';
import { buildFramePost, createFrameToken, isJgFrameMessage, registerFrame } from './gal/bridge.ts';
import { getSharedBundle, subscribeSharedBundle } from './compat/bundleStore.ts';
import { buildSharedRuntimeSnippet, needsSharedRuntime, parseSharedStatus, recordSharedStatus, type SharedScriptBundle } from './compat/sharedRuntime.ts';
import { FrameViewport } from './components/FrameViewport.tsx';
import { createInitialFrameSize, mergeFrameSize, type FrameSizeState } from './frameSize.ts';
import { prepareAssetCapabilities, type PreparedAssetCapabilities } from './assetCapabilities.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';

export { sanitizeHtml, looksLikeHtml, looksLikeFullDoc, extractHtmlFromCodeFence, splitHtmlSegments, splitGalSegments } from './htmlCore.ts';

/** 订阅会话级共享脚本包（会话打开时由 App 拉取，此处仅消费） */
function useSharedBundle(): SharedScriptBundle {
  const [, force] = useState(0);
  useEffect(() => subscribeSharedBundle(() => force((n) => n + 1)), []);
  return getSharedBundle();
}

/** 完整文档 / 含脚本 → 沙箱 srcdoc iframe：原样放行卡自带 HTML/CSS/JS（沙箱即安全边界），shim 置头、测高置尾 */
function FullDocFrame({ html, bundle, target }: { html: string; bundle: SharedScriptBundle; target?: ViewTarget }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => createFrameToken(), [html]);
  const [size, setSize] = useState<FrameSizeState>(createInitialFrameSize);
  const [assets, setAssets] = useState<PreparedAssetCapabilities | null>(null);
  useEffect(() => setSize(createInitialFrameSize()), [token]);
  useEffect(() => {
    let alive = true;
    setAssets(null);
    void prepareAssetCapabilities(html).then((prepared) => {
      if (alive) setAssets(prepared);
    });
    return () => { alive = false; };
  }, [html]);
  // FE-B2：仅当消息引用了清单导出符号时才注入共享运行时（避免每条消息塞入上百 KB 脚本）
  const sharedSnippet = useMemo(
    () => (needsSharedRuntime(html, bundle)
      // FE-04-C：消息页面 realm 也带上身份（作用域 page + 会话运行实例），便于跨运行环境统计与诊断
      ? buildSharedRuntimeSnippet(bundle, token, { scope: 'page', sessionRunId: target?.sessionRunId })
      : undefined),
    [html, bundle, token, target?.sessionRunId],
  );
  useEffect(() => {
    // 交互桥：把本 iframe 窗口注册进 __jgfh 注册表，宿主据此校验 choice/draft/rpc 来源并向其回发消息
    const win = ref.current?.contentWindow;
    const unregister = win ? registerFrame(win, buildFramePost(win, '*', token), token) : undefined;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !isJgFrameMessage(e.data, token)) return;
      const d = e.data as {
        __jgfh_h?: string;
        w?: unknown;
        h?: unknown;
        contentHeight?: unknown;
        viewportHeight?: unknown;
      };
      if (d.__jgfh_h === 'height' || d.__jgfh_h === 'size') {
        setSize((prev) => mergeFrameSize(prev, d));
      } else if (d.__jgfh_h === 'shared-status') {
        const st = parseSharedStatus(e.data);
        if (st) {
          recordSharedStatus(st);
          console.info(`[共享运行时] coreScripts=${st.coreScripts.ok} openingDeps=${st.openingDeps.ok}${st.openingDeps.missing.length ? ` 缺失=${st.openingDeps.missing.join(',')}` : ''}`);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      unregister?.();
      window.removeEventListener('message', onMsg);
    };
  }, [html, token]);
  if (!assets) return <div className="html-msg">正在准备安全资源…</div>;
  return (
    <FrameViewport title='卡片前端' reportedWidth={size.width} reportedHeight={size.height}>
      {(style) => (
        <iframe
          ref={ref}
          className='html-msg-frame'
          title='卡片前端'
          sandbox='allow-scripts allow-modals'
          srcDoc={buildFullDocSrcDoc(html, token, sharedSnippet, target, assets.mode === 'secured'
            ? { assetUrls: assets.urls, failClosed: true, secureContentSource: assets.secureContentSource }
            : {})}
          style={style}
        />
      )}
    </FrameViewport>
  );
}

/** 片段（无脚本，<details>/<div> 等）→ Shadow DOM：样式隔离，自然流动布局 */
function ShadowFragment({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [assets, setAssets] = useState<PreparedAssetCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    setAssets(null);
    void prepareAssetCapabilities(html).then((prepared) => {
      if (alive) setAssets(prepared);
    });
    return () => { alive = false; };
  }, [html]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !assets) return;
    let root = host.shadowRoot;
    if (!root) {
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;width:100%;color:inherit} :host img{max-width:100%;height:auto;border-radius:8px} :host>:first-child{margin-top:0}';
      root.appendChild(style);
      const body = document.createElement('div');
      body.setAttribute('data-jg-shadow-body', '1');
      root.appendChild(body);
    }
    let body = root.querySelector('[data-jg-shadow-body]');
    if (!body) {
      body = document.createElement('div');
      body.setAttribute('data-jg-shadow-body', '1');
      root.appendChild(body);
    }
    const rewritten = planResourceRewrite(html, assets.mode === 'secured'
      ? { assetUrls: assets.urls, failClosed: true }
      : {}).html;
    body.innerHTML = sanitizeHtml(rewritten);
  }, [html, assets]);
  if (!assets) return <div className="html-msg">正在准备安全资源…</div>;
  return <div ref={hostRef} className="html-msg" />;
}

/** 渲染为 HTML：完整文档 / 含脚本走 iframe（脚本需沙箱隔离），其余走 Shadow DOM */
export function HtmlMessage({ text, target }: { text: string; target?: ViewTarget }) {
  const bundle = useSharedBundle();
  if (!WEB_CLIENT_PROFILE.scriptedCards) return <ShadowFragment html={text} />;
  if (looksLikeFullDoc(text) || /<script[\s>]/i.test(text)) return <FullDocFrame html={text} bundle={bundle} target={target} />;
  return <ShadowFragment html={text} />;
}
