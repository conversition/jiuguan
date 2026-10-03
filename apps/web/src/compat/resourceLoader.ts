/**
 * FE-03 资源统一加载链 + 页面脚本分策略调度（纯逻辑，可 node 单测）
 *
 * 解决的问题（**以当前真实页面请求为证据**，不是泛化的“全网镜像”）：
 *   1. 卡 HTML 里的 `src`/`href`/内联 `url()` 直连 CDN → 资源管理器（DiskCache）下载过的资源
 *      浏览器仍绕过缓存走外网；断网即坏图/坏脚本。→ 统一重写到 `/api/assets/img` 同源代理，
 *      使「下载缓存」与「页面实际请求」命中**同一份磁盘缓存**。
 *   2. `deferInlineScripts` 只延后内联脚本，外链脚本仍按原时机加载 → 混合页面顺序被破坏
 *      （典型：内联 A 定义数据、外链 B 读 A；或外链 B 定义数据、内联 A 读 B）。
 *      → 按 **script 类型**分策略延后，并**按文档原序、可等待外链加载完成**地恢复。
 *
 * 纪律：
 *   - 不写通用 JavaScript 重写器；只处理 HTML 里**真实存在**的引用形态（属性 + 内联 style url）。
 *   - 不放宽安全限制（沙箱与代理策略不动，只改引用地址）。
 *   - 缺项**准确降级**：不静默吞、不整页崩溃、不偷偷回退外网重试。
 */

/** 重写报告挂载键：宿主探测/诊断读取（无协议变更） */
export const REWRITE_REPORT_KEY = '__jgResReport';

/** 可代理的资源形态判定用扩展名（保守白名单；其余仍代理但会记录） */
const AUDIO_EXT = ['mp3', 'ogg', 'm4a', 'wav', 'flac', 'aac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'];

export type RewriteWhere = 'attr' | 'style' | 'srcset';

export interface RewriteEntry {
  from: string;
  to: string;
  where: RewriteWhere;
  /** 触发重写的标签（attr/srcset）/ 'style' */
  tag?: string;
  attr?: string;
}

export interface RewriteSkip {
  url: string;
  reason: string;
}

export interface RewriteReport {
  entries: RewriteEntry[];
  skipped: RewriteSkip[];
  /** 被代理的标签计数（诊断用） */
  byTag: Record<string, number>;
}

export interface ResourceRewriteOptions {
  proxyBase?: string;
  /** secured 模式预先签发的 URL → capability URL 映射。 */
  assetUrls?: ReadonlyMap<string, string>;
  /** true 时未签发资源改为 about:blank，绝不回退原始公网 URL。 */
  failClosed?: boolean;
  /** secured iframe CSP 仅允许这一受控 content 路径加载子资源。 */
  secureContentSource?: string;
}

/** 代理 URL 构造（与 App.tsx / GalPlayer 现有约定一致，单一写法） */
export function buildAssetProxyUrl(url: string, proxyBase = ''): string {
  return `${proxyBase}/api/assets/img?url=${encodeURIComponent(url)}`;
}

/** 判定是否需要/可以走同源代理（返回 null = 不代理 + 原因） */
export function shouldProxyUrl(url: string, context: { tag?: string; attr?: string } = {}): string | null {
  const u = String(url ?? '').trim();
  if (!u) return 'empty';
  if (/^(data|blob|javascript|mailto|tel|about|chrome):/i.test(u)) return 'non-fetchable-scheme';
  if (!/^https?:\/\//i.test(u)) return 'not-absolute-http';
  // 子页面语义（嵌套卡页面）由宿主显式处理，不在引用重写范围内
  if (context.tag === 'iframe' || context.tag === 'embed' || context.tag === 'object') return 'nested-page';
  // <a href> 是导航目标，不是资源
  if (context.tag === 'a') return 'anchor-navigation';
  return null;
}

export function extOf(url: string): string {
  try {
    return (String(url).split('?')[0].split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

/** 资源类型（仅用于诊断/报告，不改变代理行为） */
export function assetShapeOf(url: string): 'image' | 'audio' | 'video' | 'script' | 'style' | 'font' | 'other' {
  const e = extOf(url);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(e)) return 'video';
  if (e === 'js' || e === 'mjs') return 'script';
  if (e === 'css') return 'style';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(e)) return 'font';
  return 'other';
}

// ────────────────────────── 1) 引用重写 ──────────────────────────

/** 会被扫描的属性（按标签限定，避免误伤 `data-*` / 文本） */
// `a` / `iframe` / `embed` / `object` 也扫描 —— 不是为了代理它们，而是为了**留下明确的跳过原因**
// （导航目标 / 子页面语义不同），避免「静默不处理」看不出所以然。
const REF_TAGS = ['img', 'script', 'source', 'audio', 'video', 'link', 'input', 'track', 'iframe', 'embed', 'object', 'a'];
const REF_ATTRS = ['src', 'href', 'poster'];

function resolvedAssetUrl(
  value: string,
  options: ResourceRewriteOptions,
  report: RewriteReport,
): string | null {
  const capability = options.assetUrls?.get(value);
  if (capability) return capability;
  if (options.failClosed) {
    report.skipped.push({ url: value, reason: 'capability-unavailable' });
    return null;
  }
  return buildAssetProxyUrl(value, options.proxyBase ?? '');
}

function rewriteTagRefs(html: string, options: ResourceRewriteOptions, report: RewriteReport): string {
  const tagRe = new RegExp(`<(${REF_TAGS.join('|')})\\b[^>]*>`, 'gi');
  return html.replace(tagRe, (tagText) => {
    const tagName = (/^<([a-z]+)/i.exec(tagText)?.[1] ?? '').toLowerCase();
    return tagText.replace(/\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, attr: string, _q, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? '';
      const skip = shouldProxyUrl(val, { tag: tagName, attr: attr.toLowerCase() });
      if (skip) {
        if (/^https?:\/\//i.test(val)) report.skipped.push({ url: val, reason: skip });
        return whole;
      }
      const to = resolvedAssetUrl(val, options, report);
      if (!to) {
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
        return `${attr}=${quote}about:blank#jg-asset-blocked${quote}`;
      }
      report.entries.push({ from: val, to, where: 'attr', tag: tagName, attr: attr.toLowerCase() });
      report.byTag[tagName] = (report.byTag[tagName] ?? 0) + 1;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
      return `${attr}=${quote}${to}${quote}`;
    });
  });
}

/** `srcset="url1 1x, url2 2x"` → 逐个 url 重写，保描述符 */
function rewriteSrcset(html: string, options: ResourceRewriteOptions, report: RewriteReport): string {
  return html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, _q, dq, sq) => {
    const val: string = String(dq ?? sq ?? '');
    let changed = false;
    const parts = val.split(',').map((seg: string) => {
      const m = /^(\s*)(\S+)([\s\S]*)$/.exec(seg);
      if (!m) return seg;
      const [, lead, url, tail] = m;
      if (shouldProxyUrl(url, { attr: 'srcset' })) return seg;
      changed = true;
      const to = resolvedAssetUrl(url, options, report);
      if (!to) return `${lead}about:blank#jg-asset-blocked${tail}`;
      report.entries.push({ from: url, to, where: 'srcset', attr: 'srcset' });
      return `${lead}${to}${tail}`;
    });
    if (!changed) return whole;
    const quote = dq !== undefined ? '"' : "'";
    return `srcset=${quote}${parts.join(',')}${quote}`;
  });
}

/** 内联 `<style>` 与 `style="..."` 里的 url(...)（绝对 CDN 图/字体最常见的落点） */
function rewriteInlineStyleUrls(html: string, options: ResourceRewriteOptions, report: RewriteReport): string {
  return html.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, _all, dq, sq, bare) => {
    const val = String(dq ?? sq ?? bare ?? '').trim();
    if (shouldProxyUrl(val)) return whole;
    const to = resolvedAssetUrl(val, options, report);
    if (!to) return 'url("about:blank#jg-asset-blocked")';
    report.entries.push({ from: val, to, where: 'style' });
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
    return `url(${q}${to}${q})`;
  });
}

/** Shadow DOM 没有独立 CSP；secured 模式直接移除无法预签发的动态 CSS 导入。 */
function blockDynamicCssImports(html: string, options: ResourceRewriteOptions, report: RewriteReport): string {
  if (!options.failClosed) return html;
  return html.replace(
    /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')[^;{}]*;/gi,
    (whole) => {
      report.skipped.push({ url: whole, reason: 'dynamic-css-import-blocked' });
      return '/* jg-blocked-dynamic-css-import */';
    },
  );
}

/**
 * 统一资源引用重写：页面 + 子资源（属性 / srcset / 内联 style）。
 * 不做的事（明确边界）：不代理 `<iframe src>`（子页面语义）、不改 `data:`/相对路径、
 * 不重写外部 CSS **内部**的 url()（见报告“未支持”），不建设全网镜像。
 */
export function planResourceRewrite(
  html: string,
  opts: ResourceRewriteOptions = {},
): { html: string; report: RewriteReport } {
  const report: RewriteReport = { entries: [], skipped: [], byTag: {} };
  let out = rewriteTagRefs(html, opts, report);
  out = rewriteSrcset(out, opts, report);
  out = rewriteInlineStyleUrls(out, opts, report);
  out = blockDynamicCssImports(out, opts, report);
  return { html: out, report };
}

/**
 * 外部前端页的**相对引用**解析（FE-04.0 资源边界）。
 *
 * 卡自带外部页（如 `.../external-page/index.html`）由服务端代理抓成文本后注入 srcdoc ——
 * 此时页面自身没有 base URL，`./style.css`、`img/x.png`、`../shared/a.js` 都会落到宿主源上（404）。
 * 因此按**原页面 URL** 把相对引用绝对化，再由 planResourceRewrite 统一转同源代理。
 *
 * 只处理引用属性与 `srcset`/内联 `url()`；不动 `<a href>` 之外的语义、不动数据块。
 */
export function resolveRelativeRefs(
  html: string,
  pageUrl: string,
): { html: string; base: string; resolved: number } {
  let base = '';
  try { base = new URL('.', pageUrl).href; } catch { base = ''; }
  if (!base) return { html, base: '', resolved: 0 };
  let resolved = 0;
  const absolutize = (raw: string): string | null => {
    const v = String(raw ?? '').trim();
    if (!v) return null;
    if (/^([a-z][a-z0-9+.-]*:|#|\?)/i.test(v)) return null;      // 绝对 scheme / 锚点 / 查询串
    if (/^\/\//.test(v)) return `https:${v}`;                      // 协议相对
    try { return new URL(v, base).href; } catch { return null; }
  };
  const tagRe = new RegExp(`<(${REF_TAGS.join('|')})\\b[^>]*>`, 'gi');
  let out = html.replace(tagRe, (tagText) => tagText.replace(
    /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, attr: string, _q, dq, sq, bare) => {
      const to = absolutize(String(dq ?? sq ?? bare ?? ''));
      if (!to) return whole;
      resolved += 1;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
      return `${attr}=${quote}${to}${quote}`;
    },
  ));
  out = out.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, _q, dq, sq) => {
    const val: string = String(dq ?? sq ?? '');
    let hit = false;
    const parts = val.split(',').map((seg: string) => {
      const m = /^(\s*)(\S+)([\s\S]*)$/.exec(seg);
      if (!m) return seg;
      const to = absolutize(m[2]);
      if (!to) return seg;
      hit = true; resolved += 1;
      return `${m[1]}${to}${m[3]}`;
    });
    if (!hit) return whole;
    const quote = dq !== undefined ? '"' : "'";
    return `srcset=${quote}${parts.join(',')}${quote}`;
  });
  out = out.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, _a, dq, sq, bare) => {
    const to = absolutize(String(dq ?? sq ?? bare ?? ''));
    if (!to) return whole;
    resolved += 1;
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
    return `url(${q}${to}${q})`;
  });
  return { html: out, base, resolved };
}

// ────────────────────────── 2) 页面脚本分策略 ──────────────────────────

export type ScriptKind =
  /** 普通内联脚本（页面自身全局语义，需按序恢复） */
  | 'classic-inline'
  /** 普通外链脚本（原为解析阻塞；恢复时需等待加载完成以保持顺序） */
  | 'classic-external'
  /** ES module（保留模块语义） */
  | 'module-inline'
  | 'module-external'
  /** 数据块（importmap / JSON / 模板）：**不是 JavaScript，不得执行** */
  | 'data';

export interface ScriptPlanEntry {
  index: number;
  kind: ScriptKind;
  /** 原始 type 属性（'' = 缺省 classic） */
  originalType: string;
  /** 原始 src（外链） */
  src?: string;
  /** 是否解析阻塞（classic 外链且无 async/defer）；恢复时据此决定是否等待 */
  blocking: boolean;
  /** 本次是否被延后（数据块不延后） */
  deferred: boolean;
  /**
   * **前导库脚本**：页面首个可执行内联脚本**之前**出现的经典外链。
   * 这类脚本（jQuery 等）是「共享脚本 + 页面内联脚本」共同的前置依赖，因此**立即恢复**
   * （不等共享运行时结论）；否则会与运行时的「等 jQuery」互相阻塞（实测踩到）。
   */
  prelude: boolean;
  note: string;
}

const DATA_TYPES = [
  'application/json', 'application/ld+json', 'importmap', 'speculationrules',
  'text/template', 'text/x-template', 'text/plain', 'text/html',
  'application/x-template', 'text/x-handlebars-template', 'application/xml', 'text/xml',
];

function classifyScript(attrs: string): { kind: ScriptKind; originalType: string; src?: string; blocking: boolean; note: string } {
  const typeMatch = /\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const originalType = typeMatch ? (typeMatch[2] ?? typeMatch[3] ?? typeMatch[4] ?? '') : '';
  const t = originalType.trim().toLowerCase();
  const srcMatch = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const src = srcMatch ? (srcMatch[2] ?? srcMatch[3] ?? srcMatch[4] ?? '') : undefined;
  const hasAsync = /\basync\b/i.test(attrs);
  const hasDefer = /\bdefer\b/i.test(attrs);

  if (DATA_TYPES.some((d) => t === d)) {
    return { kind: 'data', originalType, src, blocking: false, note: `数据块（${t || 'inline'}）不按 JS 执行，保持原样` };
  }
  if (t === 'module') {
    return {
      kind: src ? 'module-external' : 'module-inline',
      originalType, src, blocking: false,
      note: 'ES module：模块天然延后求值（非解析阻塞），恢复时保留 type=module',
    };
  }
  // 未知 type（非 JS 且非数据）→ 保守当作数据块，不执行
  if (t && !/^(text\/javascript|application\/javascript|module)$/.test(t)) {
    return { kind: 'data', originalType, src, blocking: false, note: `未知 type=${t} → 不执行（保守）` };
  }
  if (src) {
    const blocking = !hasAsync && !hasDefer;
    return {
      kind: 'classic-external', originalType, src, blocking,
      note: blocking ? '普通外链：原为解析阻塞，恢复需等待加载以保持文档顺序' : '普通外链（async/defer）：非阻塞，恢复不等待',
    };
  }
  return { kind: 'classic-inline', originalType, blocking: false, note: '普通内联：按原位恢复，保持页面全局与顺序' };
}

/**
 * 按 script 类型分策略延后页面脚本（**不做“统一延迟执行片段”的一刀切**）。
 *  - classic（内联/外链）：延后 + 原位按序恢复（外链等 load）
 *  - module：延后 + 恢复为 type=module（保留模块语义）
 *  - 数据块（importmap/JSON/模板）：**原样保留**，绝不改成可执行脚本
 */
export function planScriptDeferral(html: string): { html: string; plan: ScriptPlanEntry[] } {
  const plan: ScriptPlanEntry[] = [];
  let idx = 0;
  // 是否已出现「可执行的内联/模块内联脚本」——此前的经典外链属于**前导库脚本**
  let seenInlineExecutable = false;
  const out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (m, attrs: string, body: string) => {
    const info = classifyScript(attrs);
    const prelude = info.kind === 'classic-external' && !seenInlineExecutable;
    const entry: ScriptPlanEntry = {
      index: idx, kind: info.kind, originalType: info.originalType, src: info.src,
      blocking: info.blocking, deferred: info.kind !== 'data', prelude, note: info.note,
    };
    plan.push(entry);
    idx += 1;
    if (info.kind === 'classic-inline' || info.kind === 'module-inline') seenInlineExecutable = true;
    if (info.kind === 'data') return m; // 数据块原样保留

    // 去掉会被浏览器立即处理的属性，改成占位节点
    const cleaned = attrs
      .replace(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, '')
      .replace(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, '')
      .trim();
    const holder = prelude ? 'text/jg-prelude-ext'
      : info.kind.endsWith('external') ? 'text/jg-deferred-ext'
        : 'text/jg-deferred';
    const attrsOut = [
      `type="${holder}"`,
      `data-jg-kind="${entry.kind}"`,
      info.originalType ? `data-jg-type="${info.originalType.replace(/"/g, '&quot;')}"` : '',
      info.src ? `data-jg-src="${info.src.replace(/"/g, '&quot;')}"` : '',
      info.src ? `data-jg-orig="${info.src.replace(/"/g, '&quot;')}"` : '',
      entry.blocking ? 'data-jg-blocking="1"' : '',
      cleaned,
    ].filter(Boolean).join(' ');
    return `<script ${attrsOut}>${body}</script>`;
  });
  return { html: out, plan };
}

// ────────────────────────── 3) 原位按序恢复（可等待外链） ──────────────────────────

/**
 * 生成页面脚本恢复器（在共享运行时给出结论后由引导器调用）。
 * 关键语义：
 *   阶段一（前导库脚本，立即）：页面首个可执行内联脚本**之前**的经典外链（jQuery 等）先恢复并等待加载。
 *     —— 它们是共享脚本运行时与页面内联脚本共同的前置依赖；若也等到 __jgSharedDone，
 *        会与运行时「等 jQuery」互相阻塞（FE-03 真实浏览器实测踩到）。
 *   阶段二（其余脚本）：由引导器在共享运行时给出结论后调用，**按文档原序**恢复；
 *     classic 外链原为解析阻塞者 → 等待 load/error 再继续（复现解析阻塞语义）。
 *   - 每个等待都有**上限**（不无限等待），超时后继续并明确告警
 *   - 数据块与未延后节点不受影响
 *   - 缺失资源（代理 502）→ 记录到 __jgResReport.missing，页面继续（不整页崩溃）
 *
 * 已知边界（不夸大）：同一页面内「外链脚本读取**更早内联脚本**定义的全局」无法与本策略共存 ——
 * 前导库脚本优先是为真实卡（库先行 + 内联应用代码）建模。此限制在报告“未支持”中明确列出。
 */
export function buildScriptRestoreSnippet(): string {
  return `<script>(function(){
  var HOLD = 'script[type="text/jg-deferred"],script[type="text/jg-deferred-ext"]';
  var PRELUDE = 'script[type="text/jg-prelude-ext"]';
  var WAIT_MS = 15000;
  function reportMiss(src, why){
    try {
      var r = window.${REWRITE_REPORT_KEY} || (window.${REWRITE_REPORT_KEY} = { entries: [], skipped: [], missing: [] });
      (r.missing = r.missing || []).push({ src: src, why: why });
    } catch (e) {}
    try { console.warn('[jiuguan] 页面资源缺失：' + src + '（' + why + '）；已降级继续，不整页中断'); } catch (e) {}
  }
  function snapshot(sel){
    var out = []; var list = document.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }
  // 单个节点：原位替换；blocking 外链等待 load/error（有上限）后再继续
  function mount(old, next){
    var kind = old.getAttribute('data-jg-kind') || 'classic-inline';
    var origType = old.getAttribute('data-jg-type') || '';
    var src = old.getAttribute('data-jg-src') || '';
    var blocking = old.getAttribute('data-jg-blocking') === '1';
    var ns = document.createElement('script');
    var settled = false, timer = 0;
    function finish(){ if (settled) return; settled = true; if (timer) clearTimeout(timer); next(); }
    if (kind === 'module-inline' || kind === 'module-external') { try { ns.type = 'module'; } catch (e) {} }
    else if (origType) { try { ns.type = origType; } catch (e) {} }
    if (src) ns.src = src; else ns.textContent = old.textContent;
    for (var a = 0; a < old.attributes.length; a++) {
      var at2 = old.attributes[a];
      if (at2.name === 'type' || at2.name.indexOf('data-jg-') === 0) continue;
      try { ns.setAttribute(at2.name, at2.value); } catch (e) {}
    }
    if (src) {
      ns.onerror = function(){ reportMiss(src, '脚本加载失败（本地代理不可用或资源缺失）'); finish(); };
      ns.onload = function(){ finish(); };
      if (blocking) timer = setTimeout(function(){
        console.warn('[jiuguan] 外链脚本加载超时（' + (WAIT_MS / 1000) + 's），已继续恢复后续脚本：' + src);
        finish();
      }, WAIT_MS);
    }
    try { old.parentNode.replaceChild(ns, old); } catch (e) {}
    if (!src) finish();
    else if (!blocking) finish();
  }
  function seq(list, done){ var i = 0; (function step(){ if (i >= list.length) { done(); return; } mount(list[i++], step); })(); }

  var preludeStarted = false, preludeDone = false, waiters = [];
  function runPrelude(cb){
    if (preludeDone) { cb(); return; }
    waiters.push(cb);
    if (preludeStarted) return;
    preludeStarted = true;
    seq(snapshot(PRELUDE), function(){
      preludeDone = true;
      var ws = waiters; waiters = [];
      for (var i = 0; i < ws.length; i++) { try { ws[i](); } catch (e) {} }
    });
  }
  function startPrelude(){ runPrelude(function(){}); }
  function restore(){
    runPrelude(function(){
      seq(snapshot(HOLD), function(){ try { window.__jgCardBooted = true; } catch (e) {} });
    });
  }
  window.__jgRestorePageScripts = restore;
  window.__jgRestorePrelude = startPrelude;
  // 前导库脚本立即恢复（不等共享运行时结论）
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPrelude);
  else startPrelude();
})();</script>`;
}
