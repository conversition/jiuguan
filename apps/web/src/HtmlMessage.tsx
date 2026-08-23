/**
 * HTML 消息渲染（酒馆式：卡片/AI 输出里的 HTML 直接注入 DOM 渲染）
 * 轻量防 XSS：剥离 script/iframe/object/embed、事件处理器、javascript: 链接；
 * 保留 style（卡片样式/动画是核心诉求，本地模型内容风险可控）。
 * 分档渲染：
 *  - 完整文档（<!DOCTYPE/<html/<body，如卡片开场页/状态栏 HUD）→ 沙箱 srcdoc iframe
 *    （文档语义完整，:root CSS 变量 / html / body 选择器全生效；样式被 iframe 边界隔离，不泄漏进 app）
 *  - 片段（<details>/<div> 等）→ Shadow DOM（样式隔离，自然流动布局）
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 清洗 HTML：去脚本/事件/js 链接，保留样式与布局标签 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>|<iframe\b[^>]*\/?>/gi, '')
    .replace(/<(object|embed|applet|form)[\s\S]*?<\/\1>|<(object|embed|applet|form)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

/** 判断文本是否"像 HTML"：完整文档 / 含 <style> / 富标签 ≥3 个 */
export function looksLikeHtml(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 20) return false;
  if (/^<!doctype\s/i.test(t) || /<html[\s>]/i.test(t) || /<head[\s>]/i.test(t) || /<style[\s>]/i.test(t)) return true;
  const tags = (t.match(/<(div|p|span|h[1-6]|table|ul|ol|li|a|img|br|b|strong|i|em|section|article|main|header|footer|button|details|summary)[\s>]/gi) ?? []).length;
  return tags >= 3;
}

/** 判断是否为完整 HTML 文档（含 <!DOCTYPE / <html / <body）→ 需 iframe 渲染保 :root/CSS 变量语义 */
export function looksLikeFullDoc(html: string): boolean {
  return /<!DOCTYPE|<!doctype|<html[\s>]|<body[\s>]/i.test(html);
}

/** 从 markdown 代码围栏（``` 包整页 HTML）中提取 HTML；非围栏/围栏内非 HTML 返回 null */
export function extractHtmlFromCodeFence(text: string): string | null {
  const s = text.trimStart();
  if (!s.startsWith('```')) return null;
  const inner = s.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
  return looksLikeHtml(inner) ? inner : null;
}

/** 平台自带的自动测高脚本：在沙箱 iframe（不透明源）内 postMessage 内容高度给父级，父级据此设 iframe 高度 */
const AUTO_HEIGHT_SNIPPET = `<script>window.addEventListener('load',function(){var h=document.body.scrollHeight||document.documentElement.scrollHeight;parent.postMessage({__jgfh_h:'height',h:h},'*');});</script>`;

/** 完整文档 → 沙箱 srcdoc iframe：sandbox=allow-scripts（不透明源，无同源访问）；卡自带 <script> 已被 sanitize 剥离 */
function FullDocFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data && typeof e.data === 'object' && e.data.__jgfh_h === 'height') {
        const h = Number(e.data.h);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(h + 8, 100), 720));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const srcDoc = sanitizeHtml(html) + AUTO_HEIGHT_SNIPPET;
  return <iframe ref={ref} className="html-msg-frame" title="卡片前端" sandbox="allow-scripts" srcDoc={srcDoc} style={{ height }} />;
}

/** 片段（<details>/<div> 等非文档）→ Shadow DOM：样式隔离，自然流动布局 */
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

/** 渲染为 HTML：完整文档走 iframe，其余走 Shadow DOM */
export function HtmlMessage({ text }: { text: string }) {
  if (looksLikeFullDoc(text)) return <FullDocFrame html={text} />;
  return <ShadowFragment html={text} />;
}
