/**
 * proxy 包验证 - Provider URL 历史记忆（测试成功即记录；去重/置顶/上限/删除/持久化）
 * 注：模块级 env 在 import 时捕获，测试先设 JG_PROVIDER_HISTORY_JSON 隔离路径，再动态 import。
 */
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 隔离：历史文件写到临时路径，不触碰真实 data/provider-history.json
process.env.JG_PROVIDER_HISTORY_JSON = resolve('data', 'test-history.json');

const {
  readProviderHistory,
  recordProviderUrl,
  removeProviderUrl,
  writeProviderHistory,
  PROVIDER_HISTORY_JSON,
} = await import('../src/history.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

rmSync(PROVIDER_HISTORY_JSON, { force: true });

console.log('\n== 无文件：read 返回空 ==');
check('readProviderHistory 空数组', Array.isArray(readProviderHistory()) && readProviderHistory().length === 0);

console.log('\n== record：置顶 / 去重 / 更新 model+时间 ==');
let h = recordProviderUrl('https://opencode.ai/zen/go', 'deepseek-v4-flash');
check('记入 1 条', h.length === 1 && h[0].baseUrl === 'https://opencode.ai/zen/go' && h[0].model === 'deepseek-v4-flash');
const firstAt = h[0].lastSuccessAt;
recordProviderUrl('https://api.deepseek.com', 'deepseek-v4-flash');
h = recordProviderUrl('https://api.deepseek.com', 'deepseek-v4-pro'); // 同 URL 再记：去重置顶 + 模型更新
check('最新在前', h[0].baseUrl === 'https://api.deepseek.com');
check('去重后仍 2 条', h.length === 2);
check('模型已更新', h[0].model === 'deepseek-v4-pro');

console.log('\n== 归一化去重：https://HOST/ ≡ https://host ==');
recordProviderUrl('https://host', 'm0'); // 先记小写
h = recordProviderUrl('https://HOST/', 'm1'); // 同键再记：去重 + 展示替换为最新输入
check('大小写/尾斜杠归一后仍去重', h.length === 3 && h[0].baseUrl === 'https://HOST/' && h[0].model === 'm1', JSON.stringify(h));

console.log('\n== 空输入不落盘 ==');
const beforeBlank = readProviderHistory().length;
h = recordProviderUrl('   ', 'm');
check('空白 URL 不改变列表', h.length === beforeBlank && h.every((e) => e.baseUrl.trim() !== ''));

console.log('\n== 上限截断：35 条 → 30 ==');
for (let i = 0; i < 33; i++) recordProviderUrl(`https://e${i}.com`, `m${i}`);
h = readProviderHistory();
check('最多 30 条', h.length === 30, `实际 ${h.length}`);
check('保留最新（e32 在最前）', h[0].baseUrl === 'https://e32.com', h[0].baseUrl);

console.log('\n== remove：删中间保序 ==');
h = removeProviderUrl('https://e10.com');
check('删除后少 1 条', h.length === 29 && !h.some((e) => e.baseUrl === 'https://e10.com'));

console.log('\n== 持久化 ==');
check('文件已写且含内容', readFileSync(PROVIDER_HISTORY_JSON, 'utf8').includes('https://e32.com'));
const reread = readProviderHistory();
check('read 与内存一致', reread.length === h.length && reread[0].baseUrl === h[0].baseUrl);

console.log('\n== 坏 JSON 容错 ==');
writeFileSync(PROVIDER_HISTORY_JSON, 'not-json{{{');
check('坏 JSON 返回空数组', Array.isArray(readProviderHistory()) && readProviderHistory().length === 0);
writeProviderHistory([{ baseUrl: 'https://a.com', model: 'm', lastSuccessAt: new Date().toISOString() }]);
check('写回后可正常读', readProviderHistory().length === 1);

// 清理测试文件
rmSync(PROVIDER_HISTORY_JSON, { force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
