/**
 * plugin 包验证 - 沙箱运行时（钩子分发 + storage 持久化 + 失败隔离）
 * 覆盖：onSessionStart / onMessageSend(promptInject) / onProsePostProcess(链式改写)
 *      / storage 跨实例持久化 / 插件抛错不阻断 / module.exports 风格
 */
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginRegistry } from '../src/registry.ts';
import { PluginHost } from '../src/runtime.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const FIXTURE = join('packages', 'plugin', 'tests', 'fixtures', 'style-tight');
const TMP = join('data', 'test-plugin-runtime');
const SRC = join('data', 'test-plugin-runtime-src');
rmSync(TMP, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

const reg = new PluginRegistry(TMP);
await reg.install(FIXTURE);

console.log('\n== 加载 + onSessionStart ==');
const host = new PluginHost(reg);
host.start();
check('插件加载', host.count() === 1, String(host.count()));
const s1 = JSON.parse(readFileSync(join(TMP, 'storage', 'style-tight.json'), 'utf8')) as Record<string, unknown>;
check('onSessionStart 写入 storage(sessionCount=1)', s1.sessionCount === 1, JSON.stringify(s1));

console.log('\n== onMessageSend（promptInject）==');
const inj = host.callHook('onMessageSend', { userInput: '你好', round: 1, mode: 'nsfw' })
  .flatMap((r) => (typeof (r as { promptInject?: unknown }).promptInject === 'string' ? [(r as { promptInject: string }).promptInject] : []));
check('promptInject 注入', inj.length === 1 && inj[0].includes('冷冽叙事'), JSON.stringify(inj));

console.log('\n== onProsePostProcess（链式改写）==');
const pp = host.callHook('onProsePostProcess', { prose: '她笑了笑（笑），  轻声说道。', turn: {}, round: 1 });
check('出戏符号剔除 + 空白压缩', (pp[0] as { prose: string }).prose === '她笑了笑， 轻声说道。', JSON.stringify(pp[0]));

console.log('\n== storage 跨实例持久化 ==');
const host2 = new PluginHost(reg);
host2.start();
const s2 = JSON.parse(readFileSync(join(TMP, 'storage', 'style-tight.json'), 'utf8')) as Record<string, unknown>;
check('第二次会话 sessionCount=2', s2.sessionCount === 2, JSON.stringify(s2));

console.log('\n== 失败隔离（抛错插件不阻断其它插件/回合）==');
const badDir = join(SRC, 'bad-hook');
rmSync(badDir, { recursive: true, force: true });
mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ name: 'bad-hook', version: '1.0.0', server: 'server.js' }));
writeFileSync(join(badDir, 'server.js'), 'exports.hooks = { onMessageSend: function () { throw new Error("boom"); } };');
await reg.install(badDir);
const host3 = new PluginHost(reg);
host3.start();
const r3 = host3.callHook('onMessageSend', { userInput: 'x', round: 1, mode: 'nsfw' });
check('抛错插件被隔离（结果为空）', r3.length === 1, `results=${r3.length}`); // style-tight 仍返回，bad-hook 抛错被吞
check('style-tight 结果保留', (r3[0] as { promptInject?: string }).promptInject?.includes('冷冽叙事') === true);
host3.dispose();

console.log('\n== module.exports 风格 ==');
const modDir = join(SRC, 'mod-style');
rmSync(modDir, { recursive: true, force: true });
mkdirSync(modDir, { recursive: true });
writeFileSync(join(modDir, 'manifest.json'), JSON.stringify({ name: 'mod-style', version: '1.0.0', server: 'server.js' }));
writeFileSync(join(modDir, 'server.js'),
  'module.exports = { hooks: { onMessageSend: function () { return { promptInject: "[mod-style]" }; } } };');
await reg.install(modDir);
const host4 = new PluginHost(reg);
host4.start();
const r4 = host4.callHook('onMessageSend', { userInput: 'x', round: 1, mode: 'nsfw' });
check('module.exports 钩子生效', r4.some((r) => (r as { promptInject?: string }).promptInject === '[mod-style]'));

rmSync(TMP, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
