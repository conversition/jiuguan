/**
 * plugin 包验证 - 注册表 CRUD + 持久化（本地目录安装路径）
 * 覆盖：安装（本地目录）→ 列出 → 启用禁用 → 卸载 → registry.json 持久化往返
 *      → manifest 校验拒绝坏插件
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginRegistry } from '../src/registry.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const FIXTURE = join('packages', 'plugin', 'tests', 'fixtures', 'style-tight');
const TMP = join('data', 'test-plugins');
rmSync(TMP, { recursive: true, force: true });

console.log('\n== 安装（本地目录，ST 式 manifest）==');
const reg = new PluginRegistry(TMP);
const rec = await reg.install(FIXTURE);
check('安装成功 id=style-tight', rec.id === 'style-tight' && rec.name === 'style-tight', rec.id);
check('manifest 字段映射', rec.displayName === '冷冽叙事文风插件' && rec.version === '1.0.0' && rec.server === 'server.js');
check('默认启用', rec.enabled === true);
check('插件目录拷贝（排除 .git）', existsSync(join(TMP, 'style-tight', 'server.js')) && existsSync(join(TMP, 'style-tight', 'manifest.json')));
check('registry.json 已写', existsSync(join(TMP, 'registry.json')));

console.log('\n== 重复安装拒绝 + 坏 manifest 拒绝 ==');
let dupRejected = false;
try { await reg.install(FIXTURE); } catch { dupRejected = true; }
check('重复安装被拒', dupRejected);
const badDir = join(TMP, 'bad-plugin');
mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ display_name: '无 name', version: '1' }));
let badRejected = false;
try { await reg.install(badDir); } catch (e) { badRejected = String((e as Error).message).includes('manifest'); }
check('缺 name 被拒', badRejected);

console.log('\n== 启用/禁用/卸载 ==');
reg.setEnabled('style-tight', false);
check('禁用生效', reg.get('style-tight')?.enabled === false);
reg.setEnabled('style-tight', true);
check('重新启用', reg.get('style-tight')?.enabled === true);

console.log('\n== 持久化往返（新实例读同一目录）==');
const reg2 = new PluginRegistry(TMP);
check('重启后仍列出', reg2.get('style-tight')?.version === '1.0.0');
check('禁用状态保留', reg2.get('style-tight')?.enabled === true);
check('服务端入口源码可读', (reg2.serverSource('style-tight') ?? '').includes('onMessageSend'));

reg.uninstall('style-tight');
check('卸载后目录删除', !existsSync(join(TMP, 'style-tight')));
check('卸载后列表空', reg.list().length === 0);
const regFile = JSON.parse(readFileSync(join(TMP, 'registry.json'), 'utf8')) as { plugins: unknown[] };
check('卸载后 registry.json 同步', regFile.plugins.length === 0);

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
