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
 *    残余风险（用户已确认取舍）：卡脚本可 fetch 外网泄露自身静态内容（无会话数据；静态 <img> 本就能外联）
 *  片段走 Shadow DOM（宿主同源）→ 仍剥离 script / 事件处理器 / javascript: 链接，防 XSS
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sanitizeHtml, looksLikeFullDoc, buildFullDocSrcDoc } from './htmlCore.ts';

export { sanitizeHtml, looksLikeHtml, looksLikeFullDoc, extractHtmlFromCodeFence, splitHtmlSegments } from './htmlCore.ts';

/** 完整文档 / 含脚本 → 沙箱 srcdoc iframe：原样放行卡自带 HTML/CSS/JS（沙箱即安全边界），shim 置头、测高置尾 */
function FullDocFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data && typeof e.data === 'object' && e.data.__jgfh_h === 'height') {
        const h = Number(e.data.h);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(h + 8, 100), 1200));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return <iframe ref={ref} className="html-msg-frame" title="卡片前端" sandbox="allow-scripts allow-modals" srcDoc={buildFullDocSrcDoc(html)} style={{ height }} />;
}

/** 片段（无脚本，<details>/<div> 等）→ Shadow DOM：样式隔离，自然流动布局 */
function ShadowFragment({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let root = host.shadowRoot;
    if (!root) {
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;width:100%;color:inherit} :host img{max-width:100%;height:auto;border-radius:8px} :host>:first-child{margin-top:0}';
      root.appendChild(style);
    }
    root.innerHTML = sanitizeHtml(html);
  }, [html]);
  return <div ref={hostRef} className="html-msg" />;
}

/** 渲染为 HTML：完整文档 / 含脚本走 iframe（脚本需沙箱隔离），其余走 Shadow DOM */
export function HtmlMessage({ text }: { text: string }) {
  if (looksLikeFullDoc(text) || /<script[\s>]/i.test(text)) return <FullDocFrame html={text} />;
  return <ShadowFragment html={text} />;
}
