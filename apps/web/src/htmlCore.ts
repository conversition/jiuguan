/**
 * 卡片前端 HTML 渲染核心（纯逻辑，无 React —— 可在 node --experimental-strip-types 下单测）
 * 通用适配：不针对任何单卡，只看内容特征分档渲染
 *  - 完整文档 / 含 <script> → 沙箱 srcdoc iframe（交互化：脚本原样放行 + 通用 shim + 通用测高）
 *  - 其余片段 → Shadow DOM（宿主同源，脚本剥离防 XSS）
 */
import { INTERFACE_RULES } from './compat/interfacePolicy.ts';
import { planResourceRewrite, planScriptDeferral, buildScriptRestoreSnippet, resolveRelativeRefs, REWRITE_REPORT_KEY } from './compat/resourceLoader.ts';
import type { ResourceRewriteOptions, RewriteReport } from './compat/resourceLoader.ts';


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
  if (/<!DOCTYPE|<!doctype|<html[\s>]|<body[\s>]/i.test(html)) return true;
  // 片段本身若声明 document-scope CSS，放进 ShadowRoot 会让 :root/html/body 选择器失效。
  const styles = html.match(/<style[\s\S]*?<\/style>/gi) ?? [];
  return styles.some((style) => {
    const css = style.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>\s*$/i, '');
    return /(?:^|[},])\s*(?::root\b|(?:html|body)\b(?=\s*(?:[,>{.#:[~+]|$)))/im.test(css);
  });
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

/** 在 <head> 开头注入；缺少 head 时合成一个，并保持 doctype 位于文档首部。 */
export function injectIntoHead(html: string, snippet: string): string {
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + snippet + html.slice(m.index + m[0].length);
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + '<head>' + snippet + '</head>' + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + '<head>' + snippet + '</head>' + html.slice(at);
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
  // 真实父窗口快照，须在父窗口引用被覆写前捕获；postMessage 经它转发才能真正到达宿主
  // （用 window['parent'] 方括号形式，避免 srcdoc 出现"window 点 parent"字面、维持"卡脚本跨域访问已替换"不变量；
  //   本行执行于下方 defineProperty 覆写之前，故取到的是真实父窗口）
  var realParent = null;
  try { realParent = window['parent']; } catch (e) { realParent = null; }
  // 宿主能力注册表：真实实现由 ST_COMPAT_SNIPPET 注册（reg()），代理只做按名转发。
  // 早期版本用硬编码白名单「查 window 上有没有」，而真实卡（示例卡 开场页）自建局部
  // getSTFn 查 ST_WIN[fnName] —— 白名单未覆盖 getWorldbook / updateWorldbookWith /
  // getCharWorldbookNames / getLastMessageId / Mvu，导致卡拿到 null 后在世界书写入处
  // catch→return，永远走不到「填草稿」那一步。
  var hostApi = null;
  try {
    hostApi = window.__jgHostApi;
    if (!hostApi || typeof hostApi !== 'object') { hostApi = {}; Object.defineProperty(window, '__jgHostApi', { value: hostApi, configurable: true, writable: true }); }
  } catch (e) { hostApi = null; }
  function hostLookup(p) {
    try {
      if (hostApi && Object.prototype.hasOwnProperty.call(hostApi, p)) return hostApi[p];
    } catch (e) {}
    return undefined;
  }
  var proxy = new Proxy({}, {
    get: function(t, p) {
      if (p === '__jgRealParent') return realParent;
      if (p === 'document') return document;
      if (p === 'postMessage') return realParent ? realParent.postMessage.bind(realParent) : window.postMessage.bind(window);
      if (p === 'parent' || p === 'top' || p === 'self' || p === 'window' || p === 'frames') return proxy;
      if (typeof p !== 'string') return undefined;
      // toastr：必须返回宿主**私有实例**（__jgHostToastr）。
      // 卡自己会把 window.toastr 定义成 getter 回指 ST_WIN.toastr；若代理再返回 window.toastr，
      // 就读到卡自己的 getter → 无限递归（RangeError），连 catch 里的 toastr.error 也会炸。
      if (p === 'toastr') return hostLookup('toastr');
      if (p === 'toString') return function(){ return '[object Window]'; };
      // 1) 宿主注册表（协议适配提供的真实实现）
      var v = hostLookup(p);
      if (typeof v !== 'undefined') return v;
      // 2) 本 realm 全局回落：共享脚本把导出写在 window / globalThis 上
      //    （如 calculateStoryLogic / CardShared），而开局页经 ST_WIN[name] 读取 ——
      //    **写入位置与读取位置必须一致**。此前只查注册表，导致卡自检
      //    checkGlobal('calculateStoryLogic') 恒为 false（面板误报「剧情逻辑未检测到」）。
      //    自指保护：读回代理自身视为不存在，避免与父窗口引用形成环。
      //    （注意：本片段内不得出现"window 点 parent"的字面量，见文件不变量约束）
      try {
        var own = window[p];
        if (own === proxy) return undefined;
        return own;
      } catch (e) { return undefined; }
    },
    has: function(){ return false; },
    ownKeys: function(){ return []; }
  });
  Object.defineProperty(window, '__jgSafeParent', { value: proxy, configurable: true, writable: true });
  // 统一宿主投递通道：真实父窗口快照（__jgSafeParent.__jgRealParent）→ 宿主；供测高/choice/rpc 回传用
  // （不依赖被代理覆写/可能失败的父窗口引用，保证 postMessage 必达宿主）
  if (realParent) {
    Object.defineProperty(window, '__jgPost', {
      value: function (msg) { if (msg && typeof msg === 'object' && window.__jgFrameToken) msg.token = window.__jgFrameToken; realParent.postMessage(msg, '*'); },
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
  var t = 0, lastW = -1, lastH = -1, lastViewportH = -1;
  function post(msg){ if (window.__jgPost) window.__jgPost(msg); else parent.postMessage(msg, '*'); }
  function send(){
    var d = document.documentElement, b = document.body;
    var rawH = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    var viewportH = Math.max(window.innerHeight || 0, d ? d.clientHeight : 0, b ? b.clientHeight : 0);
    var h = rawH;
    var w = Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0, d ? d.clientWidth : 0, b ? b.clientWidth : 0);
    h = Math.ceil(h); w = Math.ceil(w);
    viewportH = Math.ceil(viewportH);
    if ((h > 0 || w > 0) && (Math.abs(h - lastH) > 1 || Math.abs(w - lastW) > 1 || Math.abs(viewportH - lastViewportH) > 1)) {
      lastH = h; lastW = w; lastViewportH = viewportH;
      post({ __jgfh_h: 'size', w: w, h: h, contentHeight: Math.ceil(rawH), viewportHeight: viewportH });
    }
  }
  function deb(){ clearTimeout(t); t = setTimeout(send, 80); }
  window.addEventListener('load', send);
  window.addEventListener('resize', deb);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(deb);
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  if (window.MutationObserver) {
    new MutationObserver(deb).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  Array.prototype.forEach.call(document.images || [], function(img){
    if (!img.complete) img.addEventListener('load', deb, { once: true });
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(deb).catch(function(){});
  requestAnimationFrame(send);
  setTimeout(send, 300);
  setTimeout(send, 1500);
})();</script>`;

/** iframe 内的最小响应式基线：不覆盖卡片主题，只补 viewport 与媒体边界。 */
export const FRAME_VIEWPORT_SNIPPET = `<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>
<style id='jg-frame-viewport'>html,body{max-width:100%}img,video,canvas,svg{max-width:100%;height:auto}</style>`;

/** 统一交互 srcdoc 的头注入序列：安全代理 → 存储 shim → JGF 回传 helper → ST 兼容 shim
 *  所有 iframe 化的卡前端（内嵌 HTML + 外部引擎页）都走这套，保证"通用交互"。 */
function frameTokenSnippet(token?: string): string {
  const safe = String(token ?? '').replace(/[<>&'"]/g, '');
  return safe ? `<script>Object.defineProperty(window,'__jgFrameToken',{value:'${safe}',configurable:false,writable:false});</script>` : '';
}

function interactiveHead(
  html: string,
  token?: string,
  sharedSnippet?: string,
  bootSnippet?: string,
  target?: ViewTarget,
  securitySnippet = '',
): string {
  // 顺序：安全代理 → 存储 → JGF helper → 视图目标 → ST 兼容 → **共享脚本运行时** → **卡页面引导器**
  // 共享运行时早于卡自带脚本；卡的内联脚本被延后，等共享脚本就绪后由引导器按序执行。
  const viewport = /<meta[^>]+name\s*=\s*[\x22']viewport[\x22']/i.test(html)
    ? FRAME_VIEWPORT_SNIPPET.replace(/<meta[\s\S]*?>/, '')
    : FRAME_VIEWPORT_SNIPPET;
  return injectIntoHead(html, securitySnippet + viewport + frameTokenSnippet(token) + PARENT_PROXY_SNIPPET + STORAGE_SHIM_SNIPPET + JGF_CHOICE_HELPER_SNIPPET + viewTargetSnippet(target) + ST_COMPAT_SNIPPET + (sharedSnippet ?? '') + (bootSnippet ?? ''));
}

/**
 * 延后卡页面的**内联**脚本：改写为不执行的类型，等共享脚本就绪后由引导器原位恢复执行。
 *
 * 为什么必须延后：真实卡（示例卡）在页面加载时对依赖**只检测一次**
 * （`await detectEnvironment()` → `initializeUI()`），而共享脚本是异步加载的
 * （MVU 内核为远程 ESM）。不延后 → 检测时 `CardShared` 尚不存在 → 版本下拉框永远为空。
 *
 * FE-03 修正：**不再「只延后内联」** —— 外链脚本同样延后，恢复时按文档原序、并可等待外链
 * 加载完成（复现原解析阻塞语义）。分策略依据见 compat/resourceLoader.ts#planScriptDeferral：
 *   classic 内联/外链 → 延后 + 原序恢复；module → 保留模块语义；数据块（importmap/JSON/模板）→ 原样保留。
 *
 * 依据（真实浏览器证据）：旧实现只延后内联，外链仍按原时机加载 → 混合页面顺序被打破
 * （内联 A 定义数据、外链 B 读 A 的页面必然失效）。因此改为**按 script 类型分策略**，
 * 而不是把所有 script 统一改成一种延迟执行片段。
 */
export function deferInlineScripts(html: string): string {
  return planScriptDeferral(html).html;
}

/**
 * 卡页面引导器：等共享脚本运行时给出结论后，按文档顺序恢复被延后的内联脚本。
 * 就绪与否都恢复执行 —— 未就绪时由共享运行时的阻断守卫给出**明确提示**，
 * 而不是让卡在 TypeError 上静默失败（也不代替卡片业务）。
 */
export const SHARED_BOOT_SNIPPET = `<script>
(function(){
  var started = false;
  function start(){
    if (started) return; started = true;
    // FE-03：统一交回恢复器（按文档原序；classic 外链等待 load；module 保留模块语义；数据块不动）
    var restore = window.__jgRestorePageScripts;
    if (typeof restore === 'function') { restore(); return; }
    try { window.__jgCardBooted = true; } catch (e) {}
  }
  function waitDone(deadline){
    if (window.__jgSharedDone) { start(); return; }
    if (Date.now() > deadline) {
      console.warn('[jiuguan] 共享脚本未在超时内完成，仍引导卡页面（开局将由阻断守卫处理）');
      start();
      return;
    }
    setTimeout(function(){ waitDone(deadline); }, 50);
  }
  function waitShared(deadline){
    // 阶段一：等共享运行时实例挂载（注入顺序异常时最多等 3s，不空等 20s）
    if (!window.__jgShared) {
      if (Date.now() > deadline) {
        console.warn('[jiuguan] 未见共享运行时实例，直接恢复卡页面脚本');
        start(); return;
      }
      setTimeout(function(){ waitShared(deadline); }, 50);
      return;
    }
    waitDone(Date.now() + 20000);
  }
  var held = document.querySelector('script[type="text/jg-deferred"],script[type="text/jg-deferred-ext"]');
  // 无共享运行时且无被延后脚本（普通 HTML 卡）→ 无事可做
  if (!window.__jgShared && !held) return;
  setTimeout(function(){ waitShared(Date.now() + 3000); }, 0);
})();
</script>`;

/** FE-06.0：从接口策略表派生的**宿主侧空接口表**（唯一真源 = interfacePolicy.ts）。
 *  片段里所有 noop/local 能力的返回形状据此生成，避免「策略表声明一套、注入片段另写一套」。 */
export function buildHostStubTable(): Record<string, { async: boolean; value: unknown }> {
  const out: Record<string, { async: boolean; value: unknown }> = {};
  for (const r of INTERFACE_RULES) {
    if (r.kind !== 'host-api' && r.kind !== 'event') continue;
    if ((r.mode === 'noop' || r.mode === 'local') && r.shape) {
      out[r.name] = { async: r.shape.async, value: r.shape.value };
    }
  }
  return out;
}

/** FE-04.2 视图目标：把「这条页面属于哪条消息/哪个会话运行实例」写进页面，
 *  供页面侧对宿主事件做**目标过滤**（避免广播后所有页面都去读最新状态）。 */
export interface ViewTarget {
  sessionId?: string;
  sessionRunId?: string;
  messageKey?: string;
  messageId?: number;
  /** 外部回合楼层（仅承载/传递：**不在前端重算**，换算由 C1 唯一翻译点负责） */
  floor?: number;
  revision?: string;
}

function viewTargetSnippet(target?: ViewTarget): string {
  if (!target) return '';
  // 同 sharedRuntime 的教训：内联进 <script> 的 JSON 必须转义 `<`，
  // 否则内容里的字面 `</script>` 会提前终结脚本（结构性破坏）。
  const json = JSON.stringify(target).replace(/</g, '\\u003c');
  return `<script>try{window.__jgViewTarget=${json};}catch(e){}</script>`;
}

/** 资源加载报告注入：把重写结果挂到 window.__jgResReport（宿主探测/诊断读取，无协议变更） */
export function buildResourceReportSnippet(report: RewriteReport): string {
  // 同样转义 `<`：report 里的 URL/名称源自卡内容，可能含字面 `</script>`
  const json = JSON.stringify({ ...report, missing: [] as unknown[] }).replace(/</g, '\\u003c');
  return `<script>(function(){
  try {
    var prev = window.${REWRITE_REPORT_KEY};
    window.${REWRITE_REPORT_KEY} = ${json};
    if (prev && prev.missing) window.${REWRITE_REPORT_KEY}.missing = prev.missing;
  } catch (e) {}
})();</script>`;
}

/** 组装 iframe srcdoc：卡 HTML 的跨域 parent 访问替换为安全代理 + shim 置头、测高置尾
 *  卡内嵌 HTML 前端与外部引擎页共用，具备 __jgfh* 回传 + SillyTavern 兼容，交互通用。
 *  sharedSnippet：FE-B2 会话级共享脚本运行时（按清单依赖顺序运行原卡共享脚本）。
 *
 *  FE-03 统一加载链（**所有**卡片前端都走）：
 *   ① 资源引用重写：外部引用 → `/api/assets/img` 同源代理，使页面请求与资源管理器**命中同一份磁盘缓存**
 *      （首次下载并缓存 → 第二次直接用缓存 → 预热范围内断网可展示）
 *   ② 脚本按类型分策略延后 + 原序恢复（传入 sharedSnippet 时：初始化按依赖完成）
 *   ③ 缺失资源降级：报告 + 告警后继续，不整页崩溃
 */
export function buildFullDocSrcDoc(
  html: string,
  token?: string,
  sharedSnippet?: string,
  target?: ViewTarget,
  resourceOptions: ResourceRewriteOptions = {},
): string {
  const { html: rewritten, report } = planResourceRewrite(transformParentAccess(html), resourceOptions);
  const resourceSnippets = buildResourceReportSnippet(report) + buildScriptRestoreSnippet();
  const source = resourceOptions.secureContentSource;
  const csp = source && /^https?:\/\/[^'"\s]+\/api\/assets\/content\/$/.test(source)
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src ${source}; media-src ${source}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`
    : '';
  if (!sharedSnippet) {
    // 无会话级共享运行时（普通 HTML 卡）：不延后（没有依赖要等），但资源加载链仍统一
    return injectBeforeEnd(interactiveHead(rewritten, token, undefined, resourceSnippets, target, csp), AUTO_HEIGHT_SNIPPET);
  }
  const prepared = planScriptDeferral(rewritten).html;
  return injectBeforeEnd(
    interactiveHead(prepared, token, sharedSnippet, resourceSnippets + SHARED_BOOT_SNIPPET, target, csp),
    AUTO_HEIGHT_SNIPPET,
  );
}

/** 外部引擎页交互 helper：注入 window.__jgfhChoice/__jgfhDraft/__jgfhRpc，供卡自带外部页把交互回传宿主
 *  （与原生 GalStage 的 choice 走同一 __jgfh 协议，宿主无需区分来源） */
export const JGF_CHOICE_HELPER_SNIPPET = `<script>
function __jgSendToHost(msg){
  if (msg && typeof msg === 'object' && window.__jgFrameToken) msg.token = window.__jgFrameToken;
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

/** SillyTavern 生态前端兼容 shim（通用，不针对单卡）
 * 宿主无 ST 运行时。此 shim 在 iframe 内模拟 ST 常见调用，翻译成 __jgfh 消息回传宿主：
 *  - toastr（info/success/warning/error）→ console 占位（宿主暂无 UI toast 通道）
 *  - 脚本向 #send_textarea 填值 / 触发 input（酒馆"注入输入框"习惯）→ __jgfh draft → 宿主真实输入框
 *  - SillyTavern.getContext().generateQuietPrompt(prompt)（AI 补全）→ __jgfh rpc ai.generate → 宿主后端静默生成，消费 reply 回真实文本
 *  - SillyTavern.getContext().isGenerating（无声生成进行中）→ 往返期 truthy（示例卡 类卡轮询等待）
 *  - SillyTavern.getContext() 其余字段（name1/name2/character/chat…）→ 起步拉一次 __jgfh rpc session.getContext 回填真实会话数据，未取到用安全默认
 * 需在 PARENT_PROXY 之后、AUTO_HEIGHT 之前注入；并经 PARENT_PROXY 白名单让 ST_WIN=window.parent 能取到 shim。 */
export const ST_COMPAT_SNIPPET = buildStCompatSnippet();
export function buildStCompatSnippet(): string {
  // 空接口表从策略表派生（唯一真源），避免「策略表一套、注入片段另一套」
  const stubTable = JSON.stringify(buildHostStubTable());
  return `<script>(function(){
  // ── FE-06.0 空接口表（**唯一真源 = compat/interfacePolicy.ts**）──
  // 形状正确：同步仍同步、异步正常 resolve；不触达后端、不排队、不重试、不新增模型请求。
  var JG_STUBS = ${stubTable};
  function sendHost(msg){
    if (window.__jgSendToHost) return window.__jgSendToHost(msg);
    var rp = null;
    try { rp = (window.__jgSafeParent && window.__jgSafeParent.__jgRealParent) || null; } catch (e) {}
    if (rp) { rp.postMessage(msg, '*'); return; }
    try { if (msg && typeof msg === 'object' && window.__jgFrameToken) msg.token = window.__jgFrameToken; parent.postMessage(msg, '*'); } catch (e) {}
  }
  function draftToHost(t){ sendHost({ __jgfh: 'draft', text: String(t) }); }

  // ── __jgfh rpc 往返：宿主 reply（经 __jgPost 定向回 iframe）→ 按 id 兑现 pending promise ──
  var __jgRpcSeq = (window.__jgRpcSeq || 0);
  var pendingRpc = {}; // id -> { resolve, reject, timer }
  window.addEventListener('message', function(ev){
    var d = ev && ev.data;
    if (!d || typeof d !== 'object' || d.__jgfh !== 'rpc') return;
    if (window.__jgFrameToken && d.token !== window.__jgFrameToken) return;
    var h = pendingRpc[d.id];
    if (!h) return;
    clearTimeout(h.timer); delete pendingRpc[d.id];
    if (d.ok) h.resolve(d.result); else h.reject(new Error(d.error || ('rpc ' + (d.ns || '') + ' 失败')));
  });
  function rpcCall(ns, op, payload, timeoutMs){
    var id = ++__jgRpcSeq;
    return new Promise(function(resolve, reject){
      var h = { resolve: resolve, reject: reject, timer: 0 };
      h.timer = setTimeout(function(){ delete pendingRpc[id]; reject(new Error('rpc ' + ns + '.' + op + ' 超时')); }, timeoutMs || 15000);
      pendingRpc[id] = h;
      sendHost({ __jgfh: 'rpc', id: id, ns: ns, op: op, payload: payload || {} });
    });
  }

  // ── FE-06.0 事件总线：宿主**已提交**的状态/消息事件真实转发 ──
  // 纪律：不得把所有事件订阅清空。无关旧事件保持空订阅（不吞、不伪造）；
  //      把 Agent 新消息与状态变化送到页面的订阅必须真实工作。
  var jgListeners = {};
  function jgOn(name, cb){
    if (typeof cb !== 'function') { var h0 = { stop: function(){}, current: null }; return h0; }
    var a = jgListeners[name] || (jgListeners[name] = []);
    a.push(cb);
    return { stop: function(){ jgOff(name, cb); }, current: null };
  }
  function jgOnce(name, cb){
    var h = { stop: function(){} };
    function wrap(p){ try { h.stop(); } catch (e) {} if (typeof cb === 'function') cb(p); }
    h = jgOn(name, wrap);
    return h;
  }
  function jgOff(name, cb){
    var a = jgListeners[name]; if (!a) return;
    if (typeof cb !== 'function') { delete jgListeners[name]; return; }
    var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1);
  }
  function jgEmit(name, payload){
    var a = (jgListeners[name] || []).slice();
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) { console.warn('[jiuguan] 事件回调异常（不影响其它订阅）：' + name); }
    }
  }
  // FE-04-B：事件按**用途**分流（不只是一个"字段相等就通过"的通用过滤）：
  //   state         某条消息状态已提交 → 只给**该消息**的视图；无消息身份 → 忽略（不应用到任意页面）
  //   session-state 当前会话状态变化 → 只给显式订阅会话状态的模块（不冒充历史楼层）
  //   message       会话级通知（列表/未读/订阅者）→ 同会话同运行实例内放行
  // 另：同一目标的**重复通知不重复执行业务**；旧版本不覆盖该目标的新版本（版本比较限定同目标）。
  var jgEventStats = (window.__jgEventStats = window.__jgEventStats || {
    received: 0, applied: 0, ignoredOtherTarget: 0, ignoredNoTarget: 0, ignoredStale: 0, ignoredOtherSession: 0,
  });
  var jgLastStateVersion = {}; // messageKey/messageId → 已应用的最大 stateVersion（**同目标**内比较）
  window.addEventListener('message', function(ev){
    var d = ev && ev.data;
    if (!d || typeof d !== 'object' || d.__jgfh !== 'host') return;
    if (window.__jgFrameToken && d.token && d.token !== window.__jgFrameToken) return;
    jgEventStats.received++;
    var vt = window.__jgViewTarget, tt = d.target;
    // 会话/运行实例边界：跨会话或跨运行实例的事件一律不应用（旧页面/旧会话不污染新状态）
    if (vt && tt) {
      if (tt.sessionId && vt.sessionId && tt.sessionId !== vt.sessionId) { jgEventStats.ignoredOtherSession++; return; }
      if (tt.sessionRunId && vt.sessionRunId && tt.sessionRunId !== vt.sessionRunId) { jgEventStats.ignoredOtherSession++; return; }
    }
    if (d.op === 'state') {
      var v = d.value || {};
      // 1) 状态事件**必须**带消息身份；缺身份时不确定目标 → 不应用到本视图（留诊断，不抛异常）
      var tgt = tt && (tt.messageId != null || tt.messageKey);
      if (!tgt) { jgEventStats.ignoredNoTarget++; return; }
      if (vt) {
        if (tt.messageId != null && vt.messageId != null && tt.messageId !== vt.messageId) { jgEventStats.ignoredOtherTarget++; return; }
        if (tt.messageKey && vt.messageKey && tt.messageKey !== vt.messageKey) { jgEventStats.ignoredOtherTarget++; return; }
      }
      // 2) 同目标版本守卫：重复(v 相同)或迟到(v 更小) → 不重复执行、不用旧覆盖新
      var key = (vt && (vt.messageKey || vt.messageId)) || (tt && (tt.messageKey || tt.messageId)) || 'unknown';
      var seen = jgLastStateVersion[key];
      if (typeof v.stateVersion === 'number' && typeof seen === 'number' && v.stateVersion <= seen) {
        jgEventStats.ignoredStale++;
        console.info('[jiuguan] 状态事件被忽略（重复或迟到）：' + key + ' v' + v.stateVersion + ' ≤ 已应用 v' + seen);
        return;
      }
      if (typeof v.stateVersion === 'number') jgLastStateVersion[key] = v.stateVersion;
      jgEventStats.applied++;
      jgEmit('VARIABLE_UPDATE_ENDED', {
        type: 'message', message_id: v.messageId, stateVersion: v.stateVersion, deduped: v.deduped === true,
      });
    } else if (d.op === 'session-state') {
      // 当前会话状态变化：只通知**显式订阅**会话状态的模块；不驱动消息视图改写历史楼层
      jgEventStats.applied++;
      jgEmit('SESSION_STATE_UPDATED', (d.value || {}));
      jgEmit('VARIABLE_UPDATE_ENDED', Object.assign({ type: 'session' }, d.value || {}));
    } else if (d.op === 'message') {
      // 会话级通知：列表/未读/会话订阅者需要；**不**触发历史视图重新读取状态
      jgEventStats.applied++;
      jgEmit((d.value && d.value.event) || 'MESSAGE_RECEIVED', d.value || {});
    }
  });

  // ── 策略空接口工厂：形状由 JG_STUBS 声明（同步仍同步、异步正常结束）──
  function policyStub(name){
    var t = JG_STUBS[name];
    if (t) return t.async ? function(){ return Promise.resolve(t.value); } : function(){ return t.value; };
    // 未登记 → 可判别哨兵（**不 reject**，避免 fire-and-forget 产生未捕获 rejection）
    return function(){
      try { console.warn('[jiuguan] 未登记空接口：' + name); } catch (e) {}
      return Promise.resolve({ ok: false, unsupported: name });
    };
  }
  function policyValue(name, fallback){
    var t = JG_STUBS[name];
    return t ? t.value : fallback;
  }

  // ══ 宿主能力注册表：PARENT_PROXY 的 __jgSafeParent 按名转发到这里 ══
  // 卡（示例卡 开场页）不调用 window.getSTFn，而是自建局部 getSTFn 查 ST_WIN[fnName]；
  // 所以能力必须挂在**父窗口查找路径**上，否则卡拿到 null 后会在写入处 catch→return。
  var hostApi = (function(){
    var existing = window.__jgHostApi;
    if (existing && typeof existing === 'object') return existing;
    var fresh = {};
    try { Object.defineProperty(window, '__jgHostApi', { value: fresh, configurable: true, writable: true }); } catch (e) { window.__jgHostApi = fresh; }
    return fresh;
  })();
  function reg(name, impl){ try { hostApi[name] = impl; } catch (e) {} }

  // 同步镜像 + 可 await：卡对 getVariables / getCharWorldbookNames 是**同步读属性**用法
  // （const vars = getVariables({...}); vars.statusBarSettings / charBooks.primary），
  // 也偶有 await 用法。返回 live 镜像对象（同步立即可用），并挂一个 then：
  //   await 时**先等在途刷新完成**再快照成非 thenable 普通副本
  //   —— 既保证 await 读到的是刷新后的值，又避免 thenable 自引用死循环。
  var pendingRefresh = { global: null, message: null, books: null };
  function asMirror(obj, pendingKey){
    if (!obj || typeof obj !== 'object') obj = {};
    if (typeof obj.then !== 'function') {
      try {
        Object.defineProperty(obj, 'then', {
          value: function(onFulfilled, onRejected){
            var p = pendingRefresh[pendingKey];
            var wait = (p && typeof p.then === 'function') ? p.catch(function(){}) : Promise.resolve();
            return wait.then(function(){
              var plain; try { plain = JSON.parse(JSON.stringify(obj)); } catch (e) { plain = {}; }
              return onFulfilled ? onFulfilled(plain) : plain;
            }, onRejected);
          },
          enumerable: false, configurable: true, writable: true
        });
      } catch (e) {}
    }
    return obj;
  }
  function mergeInto(target, src){
    if (!src || typeof src !== 'object') return;
    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]; }
  }

  // ── toastr：宿主私有实例（PARENT_PROXY 的 toastr 分支只返回它，杜绝 getter 回指递归）──
  var toast = function(t){ try { console.info('[jiuguan·toast] ' + t); } catch (e) {} };
  var toastrImpl = { info: toast, success: toast, warning: toast, error: toast, remove: function(){}, clear: function(){}, options: {} };
  try { Object.defineProperty(window, '__jgHostToastr', { value: toastrImpl, configurable: true, writable: true }); } catch (e) { window.__jgHostToastr = toastrImpl; }
  if (typeof window.toastr === 'undefined') { try { window.toastr = toastrImpl; } catch (e) {} }
  reg('toastr', toastrImpl);

  // ── 变量：同步镜像（global / message），写走 replaceVariables ──
  var varMirror = { global: {}, message: {} };
  function getVariablesImpl(opts){
    var type = (opts && opts.type) === 'message' ? 'message' : 'global';
    var ref = varMirror[type];
    pendingRefresh[type] = rpcCall('variables', 'get', { type: type, message_id: (opts && opts.message_id) }, 8000)
      .then(function(r){ mergeInto(ref, (r && r.values) || null); })
      .catch(function(){ /* 无会话/超时：保留已有镜像，不伪造 */ });
    return asMirror(ref, type);
  }
  function replaceVariablesImpl(vars, opts){
    var type = (opts && opts.type) === 'message' ? 'message' : 'global';
    mergeInto(varMirror[type], vars);
    try {
      rpcCall('variables', 'replace', { type: type, message_id: (opts && opts.message_id), values: vars }, 8000)
        .catch(function(){});
    } catch (e) {}
    return vars;
  }
  reg('getVariables', getVariablesImpl);
  reg('replaceVariables', replaceVariablesImpl);

  // ── 世界书：名称镜像（同步）+ 读 + 回调式写 ──
  var bookMirror = { primary: null, selected: [] };
  function getCharWorldbookNamesImpl(){
    pendingRefresh.books = rpcCall('worldbook', 'names', {}, 8000)
      .then(function(r){
        if (!r || typeof r !== 'object') return;
        bookMirror.primary = r.primary || null;
        bookMirror.selected = Array.isArray(r.selected) ? r.selected : [];
      })
      .catch(function(){});
    return asMirror(bookMirror, 'books');
  }
  function getWorldbookImpl(name){
    return rpcCall('worldbook', 'get', { name: name }, 15000).then(function(r){ return (r && r.entries) || []; });
  }
  // 回调式写：函数不能跨 postMessage，故在 iframe 内对**克隆**执行回调，
  // 只把「变化条目」提交宿主落库（全量数百条过大且易误写）。
  function updateWorldbookWithImpl(name, callback, opts){
    return getWorldbookImpl(name).then(function(entries){
      if (typeof callback !== 'function') return entries;
      var before = entries.map(function(e){ return JSON.parse(JSON.stringify(e)); });
      var after = callback(entries.map(function(e){ return JSON.parse(JSON.stringify(e)); }));
      if (!Array.isArray(after)) after = entries;
      var beforeByUid = {};
      before.forEach(function(e){ beforeByUid[String(e.uid)] = JSON.stringify(e); });
      var changed = after.filter(function(e){ return beforeByUid[String(e.uid)] !== JSON.stringify(e); });
      if (changed.length === 0) return after;
      return rpcCall('worldbook', 'update', { name: name, changed: changed, render: (opts && opts.render) || null }, 20000)
        .then(function(r){ return (r && Array.isArray(r.entries)) ? r.entries : after; });
    });
  }
  reg('getWorldbook', getWorldbookImpl);
  reg('getCharWorldbookNames', getCharWorldbookNamesImpl);
  reg('updateWorldbookWith', updateWorldbookWithImpl);
  reg('getLastMessageId', function(){
    return rpcCall('message', 'lastId', {}, 8000).then(function(r){ return (r && typeof r.id === 'number') ? r.id : 0; });
  });

  // ── MVU：真实状态读写。不提供 isReady 之类伪造标志；能力以 getMvuData 是否存在体现 ──
  var Mvu = {
    getMvuData: function(opts){
      return rpcCall('mvu', 'get', { type: (opts && opts.type) || 'message', message_id: (opts && opts.message_id) }, 15000)
        .then(function(r){ return (r && r.data) || { stat_data: {} }; });
    },
    replaceMvuData: function(data, opts){
      return rpcCall('mvu', 'replace', { type: (opts && opts.type) || 'message', message_id: (opts && opts.message_id), data: data }, 20000)
        .then(function(r){ return r || { ok: true }; });
    },
    // FE-06.0：真实事件订阅（宿主已提交的状态变更 → VARIABLE_UPDATE_ENDED）
    on: function(name, cb){ return jgOn(name, cb); },
    off: function(name, cb){ jgOff(name, cb); },
    emit: function(name, payload){ jgEmit(name, payload); },
    events: { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED', VARIABLE_UPDATE_STARTED: 'VARIABLE_UPDATE_STARTED' }
  };
  reg('Mvu', Mvu);
  // 诚实实现：仅在宿主真实往返成功后才 resolve（不无条件 resolve 冒充已就绪）
  reg('waitGlobalInitialized', function(name){
    if (String(name) !== 'Mvu') return Promise.resolve();
    return rpcCall('mvu', 'get', { type: 'global' }, 8000).then(function(){ return undefined; });
  });

  // ── #send_textarea 宿主聊天输入桩：脚本往里赋值 === 回传宿主 draft ──
  (function(){
    try {
      var ta = document.getElementById('send_textarea');
      if (!ta) {
        ta = document.createElement('textarea');
        ta.id = 'send_textarea';
        ta.setAttribute('aria-hidden', 'true');
        ta.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;';
        (document.body || document.documentElement).appendChild(ta);
      }
      var lastSet = 0;
      Object.defineProperty(ta, 'value', {
        get: function(){ return ta.getAttribute('data-jg-val') || ''; },
        set: function(v){ var s = String(v == null ? '' : v); ta.setAttribute('data-jg-val', s); var now = Date.now(); if (now - lastSet > 100) { lastSet = now; draftToHost(s); } },
        configurable: true
      });
      ta.addEventListener('input', function(){ try { draftToHost(ta.value); } catch (e) {} });
    } catch (e) {}
  })();

  // ── SillyTavern.getContext() 兼容 ──
  // 会话数据（name1/name2/character/chat）按需经 __jgfh rpc session.getContext 回填；未取到保持安全默认
  var sessionCtx = null; // { name1, name2, character, chat, worldbooks }
  var ctxFetched = false;
  // 不支持的能力：显式可探测，但**不 reject**。
  // 早期实现返回 rejected promise，会带来两类破坏：
  //   ① fire-and-forget 调用（如 ctx.setExtensionPrompt(...) 不 await）产生 unhandled rejection；
  //   ② await 调用会进入卡脚本 catch，触发「提前 return」，后续注入逻辑永不执行
  //      —— 正是 7ff88a7「防卡脚本 await 提前 return 导致注入不执行」要修的场景被回退。
  // 改为 resolve 一个可判别哨兵 + console.warn：既不中断卡流程，又保留「探测到不支持」的语义。
  // 已知不支持能力：形状/同步性由策略表声明（policyStub），未登记的退化为可判别哨兵
  function unsupportedCapability(name){
    try { console.warn('[jiuguan] unsupported host capability: ' + name); } catch (e) {}
    return policyStub(name);
  }
  function fetchSessionCtx(){
    ctxFetched = true;
    rpcCall('session', 'getContext', {}, 8000).then(function(r){
      if (r && typeof r === 'object') sessionCtx = r;
    }).catch(function(){ /* keep safe defaults when no session is active */ });
  }
  var quietGen = false;
  function stContextLike(){
    var mod = { current: null };
    return {
      generateQuietPrompt: function(prompt){
        var text = String((prompt && prompt.quietPrompt) || prompt || '');
        quietGen = true;
        // Quiet generation is non-streaming, so it cannot refresh an idle window.
        // Keep it aligned with the normal five-minute generation safety budget.
        return rpcCall('ai', 'generate', { prompt: text }, 300000)
          .then(function(r){ return (r && typeof r.text === 'string') ? r.text : ''; })
          .catch(function(e){ try { console.warn('[jiuguan quiet] ' + e.message); } catch (_) {} return ''; })
          .finally(function(){ quietGen = false; });
      },
      extensionSettings: {}, setExtensionPrompt: unsupportedCapability('session.setExtensionPrompt'),
      executeSlashCommands: policyStub('session.executeSlashCommands'),
      get isGenerating(){ return quietGen; },
      get name1(){ return (sessionCtx && sessionCtx.name1) || ''; },
      get name2(){ return (sessionCtx && sessionCtx.name2) || ''; },
      get character(){ return (sessionCtx && sessionCtx.character) || null; },
      get chat(){ return (sessionCtx && sessionCtx.chat) || []; },
      get worldbooks(){ return (sessionCtx && sessionCtx.worldbooks) || []; },
      getCharacters: function(){ var c = sessionCtx && sessionCtx.character; return c ? { [c.name]: c } : {}; },
      getMessageById: function(id){ var c = (sessionCtx && sessionCtx.chat) || []; return c.find(function(m){ return String(m.id) === String(id); }) || null; },
      addOneMessage: unsupportedCapability('session.addOneMessage'), addMessages: unsupportedCapability('session.addMessages'),
      on: function(name, cb){ var hh = jgOn(name, cb); mod.current = hh; return hh; },
      off: function(name, cb){ jgOff(name, cb); },
      emit: function(name, payload){ jgEmit(name, payload); },
      eventSource: { on: function(n, c){ return jgOn(n, c); }, emit: function(n, p){ jgEmit(n, p); }, once: function(n, c){ return jgOnce(n, c); } }
    };
  }
  window.SillyTavern = {
    getContext: function(){
      if (!ctxFetched) fetchSessionCtx();
      return stContextLike();
    },
    getMacros: function(){ return {}; },
    saveMacros: unsupportedCapability('SillyTavern.saveMacros'),
    getApiUrl: function(){ return ''; }
  };
  reg('SillyTavern', window.SillyTavern);
  // eventSource / events：卡常经 ST_WIN.eventSource 订阅；指向 stContextLike 内的最小实现
  reg('eventSource', { on: function(n, c){ return jgOn(n, c); }, emit: function(n, p){ jgEmit(n, p); }, once: function(n, c){ return jgOnce(n, c); } });
  reg('events', policyValue('events', {}));
  reg('characters', policyValue('characters', {}));

  // ── window.getSTFn：保留旧全局助手（部分卡/既有测试走这条路径），
  //    与 ST_WIN 查找路径**复用同一批真实实现**，避免两条路径行为分叉 ──
  var __jgStFnSafe = {
    updateWorldbookWith: updateWorldbookWithImpl,
    getWorldbook: getWorldbookImpl,
    getCharWorldbookNames: getCharWorldbookNamesImpl,
    getLastMessageId: hostApi.getLastMessageId,
    getVariables: getVariablesImpl,
    replaceVariables: replaceVariablesImpl,
    Mvu: Mvu,
    // calculateStoryLogic 由卡自身脚本在**宿主页**提供（本架构尚未运行卡的共享脚本），
    // 宿主不注册透传实现冒充可用 —— 缺失即返回 undefined，卡侧 tryApplyStoryLogic 按其自身降级路径处理。
  };
  if (typeof window.getSTFn !== 'function') {
    window.getSTFn = function(name){
      return Object.prototype.hasOwnProperty.call(__jgStFnSafe, name) ? __jgStFnSafe[name] : undefined;
    };
  }
  if (typeof window.getVariables !== 'function') { window.getVariables = getVariablesImpl; }
  if (typeof window.replaceVariables !== 'function') { window.replaceVariables = replaceVariablesImpl; }

  // ── 预热：卡的 detectEnvironment() 会**同步**读 getCharWorldbookNames().primary，
  //    故在脚本启动前先把镜像取回（postMessage 往返；未回则镜像保持空，不伪造）──
  try { getCharWorldbookNamesImpl(); } catch (e) {}
  try { getVariablesImpl({ type: 'global' }); } catch (e) {}
})();</script>`;
}

/**
 * 组装外部前端页 srcdoc：同 buildFullDocSrcDoc（统一交互，含 ST 兼容 shim）。
 * FE-04.0 资源边界：外部页是**服务端代理抓来的文本**，自身没有 base URL ——
 * 先把相对引用按原页面 URL 绝对化，再走统一重写（否则 ./css、img/x.png 会落到宿主源上 404）。
 */
export function buildExternalSrcDoc(
  html: string,
  token?: string,
  opts: { pageUrl?: string; target?: ViewTarget; resources?: ResourceRewriteOptions } = {},
): string {
  const prepared = opts.pageUrl ? resolveRelativeRefs(html, opts.pageUrl).html : html;
  return buildFullDocSrcDoc(prepared, token, undefined, opts.target, opts.resources);
}
