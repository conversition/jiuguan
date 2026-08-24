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

/** 消息分段类型：普通文本段（气泡渲染） / HTML 前端段（iframe 或 Shadow DOM 渲染） / GLA 场景段（GalStage 渲染） */
export type HtmlSegment =
  | { type: 'text'; content: string }
  | { type: 'html'; content: string }
  | { type: 'gal'; content: string; index: number };

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

/** GLA 令牌（applyDisplayRules Phase 0 抽取 <gal_inface> 块的占位符） */
export const GAL_TOKEN_RE = /\x00JGGAL(\d+)\x00/g;

/** 把消息内容拆成文本/HTML/GLA 段：
 *  - text 里含 \x00JGGAL<i>\x00 令牌（来自 applyDisplayRules 的 gal 抽取）→ 抽出为 {type:'gal'} 段（内容=块内脚本）
 *  - 其余文本段落回退 splitHtmlSegments（HTML 围栏照常抽 iframe，叙事留气泡）
 *  - 不传 gal（无 GLA 场景）时行为与 splitHtmlSegments 完全一致（旧视窗不破） */
export function splitGalSegments(text: string, gal: string[] | null | undefined): HtmlSegment[] {
  if (!gal || gal.length === 0) return splitHtmlSegments(text);
  GAL_TOKEN_RE.lastIndex = 0;
  const segs: HtmlSegment[] = [];
  let last = 0;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = GAL_TOKEN_RE.exec(text))) {
    saw = true;
    const before = text.slice(last, m.index);
    if (before.trim()) segs.push(...splitHtmlSegments(before));
    const idx = Number(m[1]);
    segs.push({ type: 'gal', content: gal[idx] ?? '', index: idx });
    last = m.index + m[0].length;
  }
  if (!saw) return splitHtmlSegments(text);
  const after = text.slice(last);
  if (after.trim()) segs.push(...splitHtmlSegments(after));
  return segs;
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
  // 真实父窗口快照，须在 window.parent 被覆写前捕获；postMessage 经它转发才能真正到达宿主
  var realParent = null;
  try { realParent = window.parent; } catch (e) { realParent = null; }
  var proxy = new Proxy({}, {
    get: function(t, p) {
      if (p === '__jgRealParent') return realParent;
      if (p === 'document') return document;
      if (p === 'postMessage') return realParent ? realParent.postMessage.bind(realParent) : window.postMessage.bind(window);
      if (p === 'parent' || p === 'top' || p === 'self' || p === 'window' || p === 'frames') return proxy;
      if (p === 'toString') return function(){ return '[object Window]'; };
      return undefined;
    },
    has: function(){ return false; },
    ownKeys: function(){ return []; }
  });
  Object.defineProperty(window, '__jgSafeParent', { value: proxy, configurable: true, writable: true });
  // 统一宿主投递通道：真实父窗口快照（__jgSafeParent.__jgRealParent）→ 宿主；供测高/choice/rpc 回传用
  // （不依赖被代理覆写/可能失败的 window.parent，保证 postMessage 必达宿主）
  if (realParent) {
    Object.defineProperty(window, '__jgPost', {
      value: function (msg) { realParent.postMessage(msg, '*'); },
      configurable: true, writable: true,
    });
  }
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

/** 通用自动测高/测宽：load/resize/MutationObserver 三通道，上报 {__jgfh_h:'size',w,h}（防抖 80ms）。
 *  宽带上报供自适应宿主（容器宽度变化时可二次布局）；兼容旧 {__jgfh_h:'height'} 消费方。 */
export const AUTO_HEIGHT_SNIPPET = `<script>(function(){
  var t = 0;
  function post(msg){ if (window.__jgPost) window.__jgPost(msg); else parent.postMessage(msg, '*'); }
  function send(){
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    var w = Math.max(d ? d.clientWidth : 0, b ? b.clientWidth : 0);
    if (h > 0 || w > 0) post({ __jgfh_h: 'size', w: w, h: h });
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

/** 外部引擎页交互 helper：注入 window.__jgfhChoice/__jgfhDraft/__jgfhRpc，供卡自带外部页把交互回传宿主
 *  （与原生 GalStage 的 choice 走同一 __jgfh 协议，宿主无需区分来源） */
export const JGF_CHOICE_HELPER_SNIPPET = `<script>
function __jgSendToHost(msg){
  if (window.__jgPost) { window.__jgPost(msg); return; }
  parent.postMessage(msg, '*');
}
window.__jgfhChoice = function(text, mode){
  __jgSendToHost({ __jgfh: 'choice', text: String(text), mode: mode === 'draft' ? 'draft' : 'send' });
};
window.__jgfhDraft = function(text){
  __jgSendToHost({ __jgfh: 'draft', text: String(text) });
};
window.__jgfhRpc = function(ns, op, payload){
  window.__jgfhRpcSeq = (window.__jgfhRpcSeq || 0) + 1;
  __jgSendToHost({ __jgfh: 'rpc', id: window.__jgfhRpcSeq, ns: ns, op: op, payload: payload });
};
</script>`;

/** 组装外部前端页 srcdoc：同 buildFullDocSrcDoc 但追加外部页交互 helper（外部页脚本调 __jgfhChoice 回传，免宿主集成） */
export function buildExternalSrcDoc(html: string): string {
  const safeHtml = transformParentAccess(html);
  return injectBeforeEnd(
    injectIntoHead(safeHtml, PARENT_PROXY_SNIPPET + STORAGE_SHIM_SNIPPET + JGF_CHOICE_HELPER_SNIPPET),
    AUTO_HEIGHT_SNIPPET,
  );
}
