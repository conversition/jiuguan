/**
 * ST 生态回传宿主输入框 —— node:vm 端到端模拟
 * 验证「外部卡前端脚本 ⇄ 宿主输入框」整条链在真实 shim 下可用：
 *  ① 卡脚本设 #send_textarea.value / 派发 input → shim 捕获 → __jgfh draft → 宿主 applyBranch 填输入框
 *  ② __jgfhChoice / __jgfhDraft 回传 helper 正常发消息，且过 isJgFrameMessage 校验
 *  ③ generateQuietPrompt → ai.generate rpc → 宿主 reply 消费回文；isGenerating 往返期 truthy
 *  ④ getContext 首次拉 session.getContext rpc → 宿主回数据 → name1/name2/character/chat 读缓存
 *  ⑤ 真实卡正则规则 srcdoc 无 window.parent 字面 + window.parent.document.querySelector('#send_textarea') 正确变换
 * 运行：node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-st-echo.ts
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JGF_CHOICE_HELPER_SNIPPET, ST_COMPAT_SNIPPET, buildFullDocSrcDoc } from '../src/htmlCore.ts';
import { isJgFrameMessage } from '../src/gal/bridge.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const runSnippet = (ctx: Record<string, unknown>, snippet: string): void => {
  const inner = snippet.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
  vm.runInNewContext(inner, ctx, { timeout: 2000 });
};

function makeFakeElement(): Record<string, unknown> {
  const el: {
    tagName: string; id: string; attrs: Record<string, string>; style: { cssText: string };
    _handlers: Record<string, Array<(e: unknown) => void>>;
    getAttribute: (k: string) => string | null;
    setAttribute: (k: string, v: string) => void;
    addEventListener: (t: string, f: (e: unknown) => void) => void;
    dispatchEvent: (ev: { type: string; bubbles: boolean }) => void;
    appendChild: () => void;
  } = {
    tagName: 'TEXTAREA', id: '', attrs: {}, style: { cssText: '' }, _handlers: {},
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(t, f) { (this._handlers[t] ??= []).push(f); },
    dispatchEvent(ev) { (this._handlers[ev.type] ?? []).forEach((f) => f.call(this, ev as never)); },
    appendChild() {},
  };
  return el;
}

// ── 假窗口 / 假文档（足以让 JGF helper + ST shim 运行）──
const posted: Array<Record<string, unknown>> = [];
const textareaEl = makeFakeElement();
let createdTextarea = false;

const doc: Record<string, unknown> = {
  body: { appendChild() {} },
  documentElement: { scrollHeight: 0, clientWidth: 0, appendChild() {} },
  getElementById(id: string) { return id === 'send_textarea' && createdTextarea ? textareaEl : null; },
  createElement(tag: string) { if (tag === 'textarea') { createdTextarea = true; return textareaEl; } return makeFakeElement(); },
  querySelector(sel: string) { if (sel === '#send_textarea' && createdTextarea) return textareaEl; return null; },
};

const winHandlers: Record<string, Array<(e: unknown) => void>> = {};
const ctx: Record<string, unknown> = {
  document: doc,
  parent: null,
  console,
  setTimeout, clearTimeout,
  Promise, Proxy, Map, Set, Object, JSON, Array, String, Number, Math, Date,
  Event: class { type: string; bubbles: boolean; constructor(type: string, opts?: { bubbles?: boolean }) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } },
  __jgPost(msg: Record<string, unknown>) { posted.push(msg); },
  addEventListener(t: string, f: (e: unknown) => void) { (winHandlers[t] ??= []).push(f); },
  removeEventListener(t: string, f: (e: unknown) => void) { const a = winHandlers[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
};
ctx.window = ctx;
ctx.parent = ctx;

// ── 顶部可变状态（IIFE 同步段先于底部 let 执行，状态必须前置声明避免 TDZ）──
let sawTruthy = false;
let rules: Array<{ name?: string; replaceString?: unknown }> = [];
try {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'regex-rules.json'), 'utf8'));
  rules = (Array.isArray(raw) ? raw : (raw.rules ?? [])) as Array<{ name?: string; replaceString?: unknown }>;
} catch { rules = []; }
function circleObserve(): void {
  const g = (ctx.SillyTavern as unknown as { getContext: () => { isGenerating: boolean } }).getContext();
  if (g.isGenerating === true) sawTruthy = true;
}

console.log('\n== ① 外部页设 #send_textarea → __jgfh draft → 宿主输入框 ==');
runSnippet(ctx, JGF_CHOICE_HELPER_SNIPPET);
runSnippet(ctx, ST_COMPAT_SNIPPET);
posted.length = 0;
const inp = (doc.querySelector as (s: string) => Record<string, unknown> | null)('#send_textarea');
check('#send_textarea 已由 shim 注入（隐藏 textarea 存在）', inp != null);
check('#send_textarea 已安装 value setter（捕获回传）', typeof Object.getOwnPropertyDescriptor(inp ?? {}, 'value')?.set === 'function');
(inp as Record<string, unknown>).value = '注入聊天框的内容';
(inp as { dispatchEvent: (e: unknown) => void }).dispatchEvent(new ctx.Event('input', { bubbles: true }));
const draftMsg = posted.find((m) => m.__jgfh === 'draft');
check('设 .value 触发 __jgfh draft 回传宿主', draftMsg != null && draftMsg.text === '注入聊天框的内容');
check('draft 消息通过宿主 isJgFrameMessage 校验', isJgFrameMessage(draftMsg));

console.log('\n== ② __jgfhChoice / __jgfhDraft 回传 helper ==');
posted.length = 0;
(ctx.__jgfhChoice as (t: string, m?: string) => void)('选A');
check('__jgfhChoice 发 choice(send)', posted.some((m) => m.__jgfh === 'choice' && m.text === '选A' && m.mode === 'send'));
posted.length = 0;
(ctx.__jgfhDraft as (t: string) => void)('草稿D');
check('__jgfhDraft 发 draft', posted.some((m) => m.__jgfh === 'draft' && m.text === '草稿D'));

console.log('\n== ③ getContext 首次拉 session.getContext → 缓存回读 name1/name2/character/chat ==');
(async () => {
  posted.length = 0;
  (ctx.SillyTavern as never as { getContext: () => { name1: string } }).getContext(); // 首次访问起步拉会话数据（幂等）
  const ctxRpc = posted.find((m) => m.__jgfh === 'rpc' && m.ns === 'session' && m.op === 'getContext');
  check('首次 getContext 发 session.getContext rpc', ctxRpc != null);
  const rid2 = ctxRpc?.id as number;
  (winHandlers.message ?? []).forEach((f) => f({ data: { __jgfh: 'rpc', id: rid2, ok: true, result: { name1: '玩家一', name2: '角色名', character: { name: '角色名' }, chat: [{ id: 1, round: 0, role: 'user', content: 'hi' }] } } }));
  await new Promise((r) => setTimeout(r, 5)); // 等待 rpc reply 消费 → sessionCtx 更新
  // 用「先取的旧 ctx」也应能读到回填（live getter，非创建时快照）——WuWa 常见先 const ctx=getContext()
  const stCtxOld = (ctx.SillyTavern as never as { getContext: () => { name1: string; name2: string; character: { name: string } | null; chat: unknown[] } }).getContext();
  check('name1 回填真实玩家名（旧 ctx live getter）', stCtxOld.name1 === '玩家一');
  check('name2 回填真实角色名', stCtxOld.name2 === '角色名');
  check('character 回填 {name}', stCtxOld.character?.name === '角色名');
  check('chat 回填消息快照', Array.isArray(stCtxOld.chat) && (stCtxOld.chat as Array<{ content: string }>)[0]?.content === 'hi');

  console.log('\n== ④ generateQuietPrompt → ai.generate rpc → 宿主 reply 回文 + isGenerating ==');
  posted.length = 0;
  const gqp = (ctx.SillyTavern as never as { getContext: () => { generateQuietPrompt: (p: string) => Promise<string>; isGenerating: boolean } }).getContext().generateQuietPrompt('补全任务内容');
  const rpcMsg = posted.find((m) => m.__jgfh === 'rpc' && m.ns === 'ai' && m.op === 'generate');
  check('发 ai.generate rpc（payload.prompt 透传）', rpcMsg != null && (rpcMsg.payload as { prompt: string }).prompt === '补全任务内容');
  circleObserve();
  const rid = rpcMsg?.id as number;
  (winHandlers.message ?? []).forEach((f) => f({ data: { __jgfh: 'rpc', id: rid, ok: true, result: { text: '宿主静默生成正文' } } }));
  const t = await gqp;
  circleObserve();
  check('isGenerating 往返期 truthy（WuWa 轮询等待）', sawTruthy === true);
  check('生成结束后 isGenerating=false', (ctx.SillyTavern as never as { getContext: () => { isGenerating: boolean } }).getContext().isGenerating === false);
  check('Promise 兑现宿主回文（无 [Request Failed）', t === '宿主静默生成正文');

  let r1 = 0, r2 = 0;
  for (const r of rules){ try { const sd = buildFullDocSrcDoc(String(r.replaceString ?? '')); if (sd.includes('send_textarea')) { r1++; if (!/window\.parent/.test(sd) && sd.includes('window.__jgSafeParent')) r2++; } } catch { /* 规则可能非 HTML */ } }
  console.log('\n== ⑤ 真实卡正则规则 srcdoc 变换 ==');
  check(`含 send_textarea 的规则（${r1} 个）srcdoc 全部无 window.parent 字面并替换为安全代理`, r1 > 0 && r1 === r2);

  const t2 = buildFullDocSrcDoc('<script>let inp = window.parent.document.querySelector("#send_textarea"); if (inp) { inp.value = "x"; }</script>');
  check('window.parent.document.querySelector("#send_textarea") 正确变换为 __jgSafeParent', t2.includes('window.__jgSafeParent.document.querySelector("#send_textarea")'));
  check('变换后无 window.parent 字面', !/window\.parent/.test(t2));

  console.log('\n== ⑥ getSTFn 安全默认（卡「开始剧情」链：await api_updateWorldbookWith 不得抛、流程不截断）==');
  const gStFn = (ctx.getSTFn as (n: string) => unknown);
  const uwb = gStFn('updateWorldbookWith') as () => Promise<unknown>;
  check('getSTFn(updateWorldbookWith) 返回可调用函数', typeof uwb === 'function');
  let uwbThrew = false;
  try { await uwb(); } catch { uwbThrew = true; }
  check('await api_updateWorldbookWith() 不抛（卡内不提前 return，能走到 #send_textarea）', !uwbThrew);
  const gwb = gStFn('getWorldbook') as () => Promise<unknown[]>;
  check('getSTFn(getWorldbook) 可 await 且默认空数组', typeof gwb === 'function' && Array.isArray(await gwb()));
  const cbNames = gStFn('getCharWorldbookNames') as () => { primary: unknown };
  check('getSTFn(getCharWorldbookNames) 返回 {primary} 可探测', typeof cbNames === 'function' && cbNames().primary === null);
  const lastId = gStFn('getLastMessageId') as () => Promise<number>;
  check('getSTFn(getLastMessageId) 默认 0', typeof lastId === 'function' && (await lastId()) === 0);
  check('getSTFn(未知符号) 仍返回 undefined（探测降级语义保留）', gStFn('obviouslyUnknownStFn9987') === undefined);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();