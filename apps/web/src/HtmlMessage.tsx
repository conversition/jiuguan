/**
 * HTML 消息渲染（酒馆式：卡片/AI 输出里的 HTML 直接注入 DOM 渲染）
 * 轻量防 XSS：剥离 script/iframe/object/embed、事件处理器、javascript: 链接；
 * 保留 style（卡片样式/动画是核心诉求，本地模型内容风险可控）。
 */
import React from 'react';

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
  const tags = (t.match(/<(div|p|span|h[1-6]|table|ul|ol|li|a|img|br|b|strong|i|em|section|article|main|header|footer|button)[\s>]/gi) ?? []).length;
  return tags >= 3;
}

/** 从 markdown 代码围栏（``` 包整页 HTML）中提取 HTML；非围栏/围栏内非 HTML 返回 null */
export function extractHtmlFromCodeFence(text: string): string | null {
  const s = text.trimStart();
  if (!s.startsWith('```')) return null;
  const inner = s.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
  return looksLikeHtml(inner) ? inner : null;
}

/** 渲染为真实 HTML（dangerouslySetInnerHTML） */
export function HtmlMessage({ text }: { text: string }) {
  return <div className="html-msg" dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }} />;
}