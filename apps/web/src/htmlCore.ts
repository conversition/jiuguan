/**
 * 卡片前端 HTML 渲染核心（纯逻辑，无 React —— 可在 node --experimental-strip-types 下单测）
 * 通用适配：不针对任何单卡，只看内容特征分档渲染
 *  - 完整文档 / 含 <script> → 沙箱 srcdoc iframe（交互化：脚本原样放行 + 通用 shim + 通用测高）
 *  - 其余片段 → Shadow DOM（宿主同源，脚本剥离防 XSS）
 */

/** 清洗 HTML（宿主同源上下文用，如 Shadow DOM 片段）：去脚本/事件/js 链接，保留样式与布局标签 */
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

/** 消息分段类型：普通文本段（气泡渲染） / HTML 前端段（iframe 或 Shadow DOM 渲染） */
export type HtmlSegment = { type: 'text'; content: string } | { type: 'html'; content: string };

/** 把消息内容拆成文本段与 HTML 段：
 *  - 行首 ``` 围栏且内容像 HTML（开场页/状态栏整文档）→ html 段（围栏剥掉）
 *  - 其余（叙事/非 HTML 代码块/未闭合围栏）→ 文本段原样保留（交给 markdown）
 *  - 全程无围栏：整段按 looksLikeHtml 判定为单个 html 段或单个 text 段
 *  通用适配：任意卡片前端嵌在任意叙事位置都能分段干净呈现 */
export function splitHtmlSegments(text: string): HtmlSegment[] {
  const lines = text.split('\n');
  const segments: HtmlSegment[] = [];
  let buf: string[] = [];
  let sawFence = false;
  const flushText = (): void => {
    const t = buf.join('\n').trim();
    if (t) segments.push({ type: 'text', content: t });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const fence = /^\s*```([^\n]*)\s*$/.exec(lines[i]);
    if (fence) {
      sawFence = true;
      const inner: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) { inner.push(lines[j]); j++; }
      const html = inner.join('\n').trim();
      if (j < lines.length && looksLikeHtml(html)) {
        flushText();
        segments.push({ type: 'html', content: html });
        i = j + 1;
        continue;
      }
      // 非 HTML 代码块 / 未闭合围栏：保留围栏原样，交给 markdown 渲染
      buf.push(lines[i]);
      i++;
      continue;
    }
    buf.push(lines[i]);
    i++;
  }
  flushText();
  // 全程无围栏：整段按 looksLikeHtml 判定为单个 html 段或单个 text 段
  if (!sawFence) {
    const t = text.trim();
    return looksLikeHtml(t) ? [{ type: 'html', content: t }] : [{ type: 'text', content: t }];
  }
  return segments;
}

/** 在 <head> 开头注入（无 <head> 则文档最前）：shim 需先于卡片脚本执行 */
export function injectIntoHead(html: string, snippet: string): string {
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + snippet + html.slice(m.index + m[0].length);
  return snippet + html;
}

/** 在 </body>（或 </html>，或末尾）注入：测高脚本需在文档主体解析后执行 */
export function injectBeforeEnd(html: string, snippet: string): string {
  const b = /<\/body\s*>/i.exec(html);
  if (b) return html.slice(0, b.index) + snippet + html.slice(b.index);
  const h = /<\/html\s*>/i.exec(html);
  if (h) return html.slice(0, h.index) + snippet + html.slice(h.index);
  return html + snippet;
}

/** 通用安全代理 shim：不透明源下父窗口是跨域 WindowProxy——任意属性访问（含 typeof）抛 SecurityError，
 *  卡脚本里对 ST 集成的探测（ST_WIN.fn / toastr / SillyTavern / Mvu）会整体中断初始化（开场页空壳）。
 *  注入 __jgSafeParent 代理：任意属性返回 undefined（document 返回本 iframe 的 document），
 *  使 ST 集成探测全部优雅降级，iframe 内核心交互（标签页/开关/面板）不受影响。 */
export const PARENT_PROXY_SNIPPET = `<script>(function(){
  var proxy = new Proxy({}, {
    get: function(t, p) {
      if (p === 'document') return document;
      if (p === 'postMessage') return window.postMessage.bind(window);
      if (p === 'parent' || p === 'top' || p === 'self' || p === 'window' || p === 'frames') return proxy;
      if (p === 'toString') return function(){ return '[object Window]'; };
      return undefined;
    },
    has: function(){ return false; },
    ownKeys: function(){ return []; }
  });
  Object.defineProperty(window, '__jgSafeParent', { value: proxy, configurable: true, writable: true });
  // 尽力把父窗口 / 顶窗口本体也指向安全代理（浏览器允许则更彻底；不允许则由 transformParentAccess 文本替换兜底）
  try { Object.defineProperty(window, 'parent', { configurable: true, get: function(){ return proxy; } }); } catch (e) {
    try { Object.defineProperty(Window.prototype, 'parent', { configurable: true, get: function(){ return proxy; } }); } catch (e2) {}
  }
  try { Object.defineProperty(window, 'top', { configurable: true, get: function(){ return proxy; } }); } catch (e) {}
})();</script>`;

/** 把卡内联脚本里跨域必抛的 window.parent / window.top 限定访问替换为安全代理。
 *  仅替换限定形式（window. 前缀），绝不碰裸 top/parent（开场卡有同名局部变量）。 */
export function transformParentAccess(html: string): string {
  return html
    .replace(/window\.parent/g, 'window.__jgSafeParent')
    .replace(/window\.top/g, 'window.__jgSafeParent');
}

/** 通用 shim：沙箱不透明源下 localStorage/sessionStorage 访问抛 SecurityError，
 *  注入内存实现让任意依赖本地存储的卡片脚本不崩（数据仅存于该 iframe 生命周期，宿主不受影响）。 */
export const STORAGE_SHIM_SNIPPET = `<script>(function(){
  var nativeOk = false;
  try { window.localStorage.getItem('__jg_probe'); nativeOk = true; } catch (e) {}
  if (nativeOk) return;
  var mem = {};
  var api = {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function(k, v){ mem[k] = String(v); },
    removeItem: function(k){ delete mem[k]; },
    clear: function(){ mem = {}; },
    key: function(i){ return Object.keys(mem)[i] || null; },
    get length(){ return Object.keys(mem).length; }
  };
  try { Object.defineProperty(window, 'localStorage', { value: api, configurable: true, writable: true }); } catch (e) { try { window.localStorage = api; } catch (e2) {} }
  try { Object.defineProperty(window, 'sessionStorage', { value: api, configurable: true, writable: true }); } catch (e) { try { window.sessionStorage = api; } catch (e2) {} }
})();</script>`;

/** 通用自动测高：load/resize/MutationObserver 三通道，动态展开/收缩的前端自适应 iframe 高度（防抖 80ms） */
export const AUTO_HEIGHT_SNIPPET = `<script>(function(){
  var t = 0;
  function send(){
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    if (h > 0) parent.postMessage({ __jgfh_h: 'height', h: h }, '*');
  }
  function deb(){ clearTimeout(t); t = setTimeout(send, 80); }
  window.addEventListener('load', send);
  window.addEventListener('resize', deb);
  if (window.MutationObserver) {
    new MutationObserver(deb).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  setTimeout(send, 300);
  setTimeout(send, 1500);
})();</script>`;

/** 组装 iframe srcdoc：卡 HTML 的跨域 parent 访问替换为安全代理 + shim 置头（安全代理→存储 shim）、测高置尾 */
export function buildFullDocSrcDoc(html: string): string {
  const safeHtml = transformParentAccess(html);
  return injectBeforeEnd(
    injectIntoHead(safeHtml, PARENT_PROXY_SNIPPET + STORAGE_SHIM_SNIPPET),
    AUTO_HEIGHT_SNIPPET,
  );
}
