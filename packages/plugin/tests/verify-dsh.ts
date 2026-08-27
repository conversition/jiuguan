#!/usr/bin/env node
/**
 * DSH 插件宿主端到端验证：真实安装 dsh-whale-widget → 加载 → 路由分发 → 卸载
 * 用法：node --experimental-strip-types --experimental-transform-types packages/plugin/tests/verify-dsh.ts <whale-widget源目录>
 */
import { rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { installFromSource } from '../src/installer.ts';
import { PluginRegistry } from '../src/registry.ts';
import { DshPluginHost } from '../src/dsh-host.ts';

const src = process.argv[2] ?? '';
if (!src || !existsSync(src)) {
  console.error('用法: verify-dsh.ts <dsh插件源目录（含 package.json）>');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'jg-dsh-verify-'));
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── mock HTTP req/res（不真开端口，直接喂对象）──
function mockRes(): ServerResponse & { body: string; status: number; headers: Record<string, string>; done: Promise<void> } {
  const store = { body: '', status: 200, headers: {} as Record<string, string> };
  const res = Object.create(ServerResponse.prototype) as ServerResponse & typeof store & { done: Promise<void> };
  for (const k of Object.keys(store)) {
    (res as Record<string, unknown>)[k] = (store as Record<string, unknown>)[k];
  }
  let resolveDone: () => void = () => {};
  res.done = new Promise<void>((r) => { resolveDone = r; });
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    res.status = status;
    if (headers) Object.assign(res.headers, headers);
    return res;
  }) as typeof res.writeHead;
  res.setHeader = ((n: string, v: string | number | string[]) => { res.headers[n] = String(v); return res; }) as typeof res.setHeader;
  res.end = ((data?: unknown) => {
    if (typeof data === 'string') res.body += data;
    resolveDone();
    return res;
  }) as typeof res.end;
  return res;
}
function mockReq(url: string): IncomingMessage {
  const req = Object.create(IncomingMessage.prototype) as IncomingMessage;
  (req as unknown as { url: string }).url = url;
  return req;
}

try {
  console.log('▶ S1 安装（本地目录 → 归一化为 PluginRecord）');
  const registry = new PluginRegistry(join(tmp, 'plugins'));
  const rec = await registry.install(src);
  check('安装成功 id=dsh-whale-widget', rec.id === 'dsh-whale-widget', rec.id);
  check('kind=dsh', rec.kind === 'dsh', String(rec.kind));
  check('server 入口=main(lib/index.js)', rec.server === 'lib/index.js', String(rec.server));
  check('版本为 0.2.x', /^0\.2\.\d+$/.test(rec.version), rec.version);
  check('本体已拷贝 package.json', existsSync(join(registry.pluginsDir, rec.name, 'package.json')));

  console.log('▶ S2 加载（ESM 动态 import → apply(ctx)）');
  const host = new DshPluginHost(async (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'sk-test' } : null));
  await host.load(rec, join(registry.pluginsDir, rec.name));
  check('host.count()=1', host.count() === 1);

  console.log('▶ S3 路由分发');
  let r = mockRes();
  host.dispatch(mockReq('/dsh-whale/balance.json'), r as unknown as ServerResponse, '/dsh-whale/balance.json');
  // 异步 handler（fetch 余额）：等 res.end 后断言；无 key/无网 → NO_KEY JSON，路由命中即算过
  await Promise.race([r.done, new Promise((ok) => setTimeout(ok, 30000))]);
  check('GET /dsh-whale/balance.json 命中且为 JSON', r.body.length > 0 && r.headers['Content-Type']?.includes('json'),
    `status=${r.status} ct=${r.headers['Content-Type']} body=${r.body.slice(0, 60)}`);

  r = mockRes();
  host.dispatch(mockReq('/dsh-whale/widget.js'), r as unknown as ServerResponse, '/dsh-whale/widget.js');
  check('GET /dsh-whale/widget.js 返回 JS', r.body.includes('__dshWhaleWidget') && r.headers['Content-Type']?.includes('javascript'),
    `len=${r.body.length}`);

  // 前端 DshWidgetLoader 统一按 /<插件id>/widget.js 探测注入（web 端约定入口），
  // 插件本体自定路径 /dsh-whale/widget.js 对 web 不可见 —— 宿主必须补挂 <id> 别名路由
  r = mockRes();
  const aliasHit = host.dispatch(mockReq('/dsh-whale-widget/widget.js'), r as unknown as ServerResponse, '/dsh-whale-widget/widget.js');
  check('GET /dsh-whale-widget/widget.js（<id> 约定入口）命中且返回 JS', aliasHit && r.body.includes('__dshWhaleWidget'),
    `dispatch=${aliasHit} len=${r.body.length}`);

  r = mockRes();
  const imgHit = host.dispatch(mockReq('/dsh-whale/image.png?v=2'), r as unknown as ServerResponse, '/dsh-whale/image.png');
  check('GET /dsh-whale/image.png 分发（资源在则 200）', imgHit, `dispatch=${imgHit}`);

  r = mockRes();
  const miss = host.dispatch(mockReq('/api/cards'), r as unknown as ServerResponse, '/api/cards');
  check('平台路径不被拦截', !miss);

  console.log('▶ S4 会话事件广播（官方三事件 + jiuguan usage 桥接）');
  let gotAssistant = null as Record<string, unknown> | null;
  let gotTurnEnd = false;
  // 直接向宿主注册监听（模拟 whale-widget 的 ctx.on('session/event')）
  const hostAny = host as unknown as { sessionListeners?: Map<string, Set<(...a: unknown[]) => void>> };
  hostAny.sessionListeners!.set('session/event', new Set([(_s: unknown, ev: { type: string; data: Record<string, unknown> }) => {
    if (ev.type === 'assistant/message') gotAssistant = ev.data;
    if (ev.type === 'turn/end') gotTurnEnd = true;
  }]));
  host.emitJiuguanTurn({
    sessionId: 's1', card: 'test', round: 3, model: 'deepseek-v4-flash',
    promptTokens: 1000, completionTokens: 200, cacheReadTokens: 600,
  });
  const a = gotAssistant as { turn: number; message: { source: { model: string } }; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } } | null;
  check('assistant/message 映射 input=prompt-cache=400', a?.usage.inputTokens === 400, JSON.stringify(a));
  check('cacheReadTokens 透传', a?.usage.cacheReadTokens === 600);
  check('message.source.model 透传', a?.message.source.model === 'deepseek-v4-flash');
  check('turn/end 随后发出', gotTurnEnd);
  host.emitSessionCreated({ id: 's1' });
  host.emitSessionDisposed({ id: 's1' });
  check('created/disposed 广播不抛错', true);

  console.log('▶ S5 启停/卸载生命周期');
  registry.setEnabled(rec.id, false);
  host.unload('dsh-whale-widget');
  check('卸载后 count=0', host.count() === 0);
  r = mockRes();
  check('卸载后不再分发', !host.dispatch(mockReq('/dsh-whale/widget.js'), r as unknown as ServerResponse, '/dsh-whale/widget.js'));

  console.log('▶ S6 重装 + loadAll（启动路径）');
  registry.setEnabled(rec.id, true);
  await host.loadAll(registry.list(), (x) => join(registry.pluginsDir, x.name));
  check('loadAll 后 count=1', host.count() === 1, `count=${host.count()}`);
} catch (e) {
  fail++;
  console.error('💥 未预期异常:', e);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
