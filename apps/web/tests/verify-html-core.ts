/**
 * 卡片前端 HTML 渲染核心验证（htmlCore.ts）
 * 运行：node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-html-core.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sanitizeHtml,
  looksLikeHtml,
  looksLikeFullDoc,
  extractHtmlFromCodeFence,
  splitHtmlSegments,
  injectIntoHead,
  injectBeforeEnd,
  buildFullDocSrcDoc,
  transformParentAccess,
  PARENT_PROXY_SNIPPET,
  STORAGE_SHIM_SNIPPET,
  AUTO_HEIGHT_SNIPPET,
  splitGalSegments,
} from '../src/htmlCore.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== sanitizeHtml（宿主同源路径防 XSS）==');
const dirty = '<div>你好<style>.x{color:red}</style><script>alert(1)</script><button onclick="hack()">x</button><a href="javascript:alert(2)">y</a></div>';
const clean = sanitizeHtml(dirty);
check('剥 script', !clean.includes('<script'));
check('剥 onclick', !clean.includes('onclick'));
check('剥 javascript:', !clean.includes('javascript:'));
check('保留 style/div', clean.includes('<style>') && clean.includes('<div>'));

console.log('\n== 分类 ==');
check('完整文档识别', looksLikeFullDoc('<!DOCTYPE html><html><body>状态栏</body></html>') === true);
check('html 标签识别', looksLikeFullDoc('<html lang="zh">x</html>') === true);
check('片段非文档', looksLikeFullDoc('<details><summary>a</summary></details>') === false);
check('像 HTML（富标签）', looksLikeHtml('<div>a</div><p>b</p><span>c</span>') === true);
check('纯文本不像 HTML', looksLikeHtml('她沉默了一会儿，然后轻声说：好的。') === false);

console.log('\n== 围栏提取 ==');
const fenced = '```\n<html><body><div>开场</div><div>页面</div><div>内容</div></body></html>\n```';
check('剥围栏取 HTML', extractHtmlFromCodeFence(fenced)?.trim() === '<html><body><div>开场</div><div>页面</div><div>内容</div></body></html>');
check('非围栏返回 null', extractHtmlFromCodeFence('普通文本') === null);

console.log('\n== splitHtmlSegments 分段（叙事 + 前端段干净分离）==');
const prose = '她沉默了一会儿，然后轻声说：好的。';
const doc1 = '<html><body><div>状态栏</div><div>HUD</div></body></html>';
const doc2 = '<!DOCTYPE html><html><body><div>开场</div><div>页</div></body></html>';
check('纯文本 → 单 text 段', splitHtmlSegments(prose).length === 1 && splitHtmlSegments(prose)[0].type === 'text');
check('单围栏文档 → 单 html 段', (() => { const s = splitHtmlSegments('```\n' + doc1 + '\n```'); return s.length === 1 && s[0].type === 'html' && s[0].content === doc1; })());
check('叙事+围栏HUD → [text, html] 且围栏剥掉', (() => {
  const s = splitHtmlSegments(prose + '\n\n```html\n' + doc1 + '\n```');
  return s.length === 2 && s[0].type === 'text' && s[0].content === prose && s[1].type === 'html' && s[1].content === doc1;
})());
check('两段围栏文档 → [html, html]', (() => {
  const s = splitHtmlSegments('```\n' + doc1 + '\n```\n\n```\n' + doc2 + '\n```');
  return s.length === 2 && s[0].type === 'html' && s[1].type === 'html';
})());
check('非 HTML 代码块保留围栏为 text', (() => {
  const s = splitHtmlSegments('代码如下：\n```js\nconsole.log("hi");\n```');
  return s.length >= 1 && s.some(x => x.type === 'text' && x.content.includes('```js'));
})());
check('未闭合围栏不误判为 html', (() => {
  const s = splitHtmlSegments('```\n<html><body><div>a</div><div>b</div></body></html>');
  return s.every(x => x.type === 'text');
})());
check('无围栏裸整文档 → 单 html 段', (() => {
  const s = splitHtmlSegments(doc1);
  return s.length === 1 && s[0].type === 'html';
})());

console.log('\n== 注入点（shim 置头 / 测高置尾）==');
const doc = '<!DOCTYPE html>\n<html><head><title>t</title></head><body><div>状态栏</div></body></html>';
const withHead = injectIntoHead(doc, '<shim/>');
check('shim 注入 <head> 后', withHead.includes('<head><shim/>'));
const noHead = injectIntoHead('<html><body>x</body></html>', '<shim/>');
check('无 <head> → 注入文档最前', noHead.startsWith('<shim/>'));
const withBody = injectBeforeEnd(doc, '<tail/>');
check('测高注入 </body> 前', withBody.includes('<div>状态栏</div><tail/></body>'));
const noBody = injectBeforeEnd('<html></html>', '<tail/>');
check('无 </body> → </html> 前', noBody === '<html><tail/></html>');
const bare = injectBeforeEnd('<div>x</div>', '<tail/>');
check('无任何容器 → 末尾', bare === '<div>x</div><tail/>');

console.log('\n== 跨域 parent 安全代理 ==');
const scriptWithParent = '<script>const ST_WIN = window.parent || window || top; if (typeof ST_WIN.calculateStoryLogic === "function") {}</script>';
const t1 = transformParentAccess(scriptWithParent);
check('window.parent → __jgSafeParent', t1.includes('window.__jgSafeParent || window || top'));
check('卡脚本不再含 window.parent', !t1.includes('window.parent'));
const t2 = transformParentAccess('var x = window.top.Mvu; var y = 5; var top = 1; top = 2;');
check('window.top → __jgSafeParent 且裸 top 局部变量不动', t2.includes('window.__jgSafeParent.Mvu') && t2.includes('var top = 1; top = 2;'));
// 用真实代理语义跑开场卡 getSTFn 探测模式：任意属性访问不得抛（typeof 不吞异常，跨域会抛）
const safeProxy = new Proxy({}, {
  get: (t, p) => (p === 'document' ? {} : p === 'postMessage' ? (() => {}) : p === 'parent' || p === 'top' || p === 'self' || p === 'window' || p === 'frames' ? safeProxy : undefined),
  has: () => false,
  ownKeys: () => [],
});
const ST_WIN = safeProxy;
const getSTFn = (fnName: string): unknown => {
  if (typeof (ST_WIN as unknown as Record<string, unknown>)[fnName] === 'function') return (ST_WIN as unknown as Record<string, unknown>)[fnName];
  return null;
};
let getStFnThrew = false;
let stFnResult: unknown;
try {
  stFnResult = getSTFn('getCharWorldbookNames');
  const ctx = (typeof (ST_WIN as unknown as Record<string, unknown>).SillyTavern !== 'undefined');
  const mvu = (ST_WIN as unknown as Record<string, unknown>).Mvu;
  void ctx; void mvu;
} catch { getStFnThrew = true; }
check('getSTFn 探测不抛且返回 null（跨域不中断）', !getStFnThrew && stFnResult === null);

console.log('\n== buildFullDocSrcDoc：跨域访问替换 + shim 组合 ==');
const cardHtml = '<!DOCTYPE html>\n<html><head><script src="https://code.jquery.com/jquery-3.7.1.min.js"></script></head><body><div>HUD</div><script>const ST_WIN = window.parent || window || top; $(function(){ console.log("on"); });</script></body></html>';
const srcDoc = buildFullDocSrcDoc(cardHtml);
check('卡自带 <script> 保留（不被剥离）', srcDoc.includes('<script src="https://code.jquery.com') && srcDoc.includes('$(function(){ console.log("on"); });'));
check('跨域 parent 替换生效', !srcDoc.includes('window.parent') && srcDoc.includes('window.__jgSafeParent'));
check('安全代理 shim 先于卡脚本', srcDoc.indexOf(PARENT_PROXY_SNIPPET) < srcDoc.indexOf('jquery-3.7.1'));
check('存储 shim 存在', srcDoc.includes(STORAGE_SHIM_SNIPPET));
check('测高存在且后于卡脚本', srcDoc.indexOf(AUTO_HEIGHT_SNIPPET) > srcDoc.indexOf('console.log'));
check('卡 body 内容完整', srcDoc.includes('<div>HUD</div>'));

console.log('\n== 真实卡数据：MVU 状态栏 160KB（走 iframe 需脚本放行）==');
const rules = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'regex-rules.json'), 'utf-8'));
const arr = Array.isArray(rules) ? rules : (rules.rules ?? []);
const statusBar = arr.find((x: { name: string }) => x.name.includes('MVU浪潮状态栏'));
if (statusBar) {
  const real = statusBar.replaceString as string;
  const sd = buildFullDocSrcDoc(real);
  check('真实卡：本地存储 shim 注入', sd.includes(STORAGE_SHIM_SNIPPET));
  check('真实卡：安全代理 shim 注入', sd.includes(PARENT_PROXY_SNIPPET));
  check('真实卡：测高注入', sd.includes(AUTO_HEIGHT_SNIPPET));
  check('真实卡：onclick 保留（交互可用）', /onclick\s*=/i.test(sd));
  check('真实卡：脚本保留', /<script/i.test(sd));
  check('真实卡：文档主体保留', sd.includes('<!DOCTYPE html>') || sd.includes('<html'));
  check('真实卡：跨域 window.parent 全部替换为安全代理', !/window\.parent/.test(sd) && sd.includes('window.__jgSafeParent'));
} else {
  console.log('  ⚠️ 未找到 MVU 状态栏规则，跳过真实卡断言');
}

console.log('\n== splitGalSegments（GLA 分段；不传 gal 时行为同 splitHtmlSegments）==');
const galSeg1 = splitGalSegments('叙事A\n\x00JGGAL0\x00\n叙事B', ['[bg|乐乐浦寮会客厅早晨]\n叶梦|呀吼！']);
check('gal 令牌 → gal 段', galSeg1.length === 3 && galSeg1[1].type === 'gal' && galSeg1[1].content.includes('叶梦|呀吼'));
check('gal 前后叙事保留', galSeg1[0].type === 'text' && galSeg1[2].type === 'text');
const galSeg2 = splitGalSegments('纯文本\n```html\n<!DOCTYPE html><html><body>前端页面</body></html>\n```\n结尾', ['x']);
check('无 gal 令牌 → 回退 splitHtmlSegments', galSeg2.some((s) => s.type === 'html') && !galSeg2.some((s) => s.type === 'gal'));
const galSeg3 = splitGalSegments('普通文本。', null);
check('gal 为 null → 行为一致', galSeg3.length === 1 && galSeg3[0].type === 'text');
const galSeg4 = splitGalSegments('# 标题\n\x00JGGAL0\x00\n[bg|A]\n对话\n\x00JGGAL1\x00\n\n结尾', ['[bg|A]', '[cg|B]']);
check('多 gal 段顺序解析', galSeg4.filter((s) => s.type === 'gal').map((s) => s.index).join(',') === '0,1');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
