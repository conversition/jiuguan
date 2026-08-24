/**
 * __jgfh 交互桥协议验证（gal/bridge.ts）
 * 运行：node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-gal-bridge.ts
 */
import { isJgFrameMessage, registerFrame, findFrame, broadcastToFrames } from '../src/gal/bridge.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== isJgFrameMessage 合法消息 ==');
check('height 合法', isJgFrameMessage({ __jgfh_h: 'height', h: 480 }) === true);
check('size 合法', isJgFrameMessage({ __jgfh_h: 'size', w: 400, h: 480 }) === true);
check('choice send 合法', isJgFrameMessage({ __jgfh: 'choice', text: '选A' }) === true);
check('choice draft 合法', isJgFrameMessage({ __jgfh: 'choice', text: 'xxx', mode: 'draft' }) === true);
check('draft 合法', isJgFrameMessage({ __jgfh: 'draft', text: 'xxx' }) === true);
check('rpc 合法', isJgFrameMessage({ __jgfh: 'rpc', id: 1, ns: 'message', op: 'send', payload: { text: 'x' } }) === true);

console.log('\n== isJgFrameMessage 非法/伪造消息被拒 ==');
check('null 拒绝', isJgFrameMessage(null) === false);
check('字符串 拒绝', isJgFrameMessage('hello') === false);
check('空对象 拒绝', isJgFrameMessage({}) === false);
check('height 字段类型错', isJgFrameMessage({ __jgfh_h: 'height', h: '480' }) === false);
check('height 字段 Infinity 拒绝', isJgFrameMessage({ __jgfh_h: 'height', h: Infinity }) === false);
check('size 字段缺 w 拒绝', isJgFrameMessage({ __jgfh_h: 'size', h: 100 }) === false);
check('choice 缺 text 拒绝', isJgFrameMessage({ __jgfh: 'choice' }) === false);
check('choice text 非字符串 拒绝', isJgFrameMessage({ __jgfh: 'choice', text: 42 }) === false);
check('rpc id 非数字 拒绝', isJgFrameMessage({ __jgfh: 'rpc', id: 'a', ns: 'x', op: 'y' }) === false);
check('rpc 缺 op 拒绝', isJgFrameMessage({ __jgfh: 'rpc', id: 1, ns: 'x' }) === false);
check('未知协议字段 拒绝', isJgFrameMessage({ __jgfh: 'unknown', text: 'x' }) === false);

console.log('\n== registerFrame / findFrame 注册表 ==');
const fakeSource = { fake: true } as unknown as MessageEventSource;
const frameId = Math.random().toString(36).slice(2);
let posted: unknown = null;
const unregister = registerFrame(fakeSource, (msg) => { posted = msg; });
check('注册后可按 source 查中', findFrame(fakeSource)?.source === fakeSource);
check('未知 source 查不中', findFrame(null) === undefined);
check('未知 source 查不中(异源)', findFrame({ other: true } as unknown as MessageEventSource) === undefined);
unregister();
check('注销后查不中', findFrame(fakeSource) === undefined);

console.log('\n== broadcastToFrames（宿主 → 全部已注册帧，主题/缩放同步）==');
const gotA: unknown[] = [];
const gotB: unknown[] = [];
const unA = registerFrame({ a: 1 } as unknown as MessageEventSource, (msg) => { gotA.push(msg); });
const unB = registerFrame({ b: 1 } as unknown as MessageEventSource, (msg) => { gotB.push(msg); });
broadcastToFrames({ __jgfh: 'host', op: 'theme', value: 'dark' });
check('两帧都收到主题广播', gotA.length === 1 && gotB.length === 1 && (gotA[0] as { value?: string }).value === 'dark');
broadcastToFrames({ __jgfh: 'rpc', id: 9, ok: true, result: { x: 1 } });
check('两帧都收到 rpc 响应广播', gotA.length === 2 && gotB.length === 2);
unA(); unB();

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);