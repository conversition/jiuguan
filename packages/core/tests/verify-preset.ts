/**
 * core 包验证 - 预设解析（启动流程审查 P0：enabled ∧ override 过滤 + setvar 收集）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePreset } from '../src/preset.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const fixture = JSON.stringify({
  name: '测试预设',
  prompts: [
    { role: 'user', name: '块A', enabled: true, content: '**块A内容** {{setvar::alpha::1}}' },
    { role: 'system', name: '块B', enabled: false, content: '**块B内容**（默认禁用）' },
    { role: 'user', name: '块C', content: '**块C内容**（无 enabled 字段，默认启用）' },
    { content: '', name: '空块' },
  ],
});

console.log('\n== 默认 enabled 语义 ==');
const p1 = parsePreset(fixture);
check('生效块 = A + C（B 默认禁用，空块跳过）', p1.blocks.length === 2, JSON.stringify(p1.blocks.map((b) => b.slice(0, 8))));
check('stats.enabled=2 total=4', p1.stats.enabled === 2 && p1.stats.total === 4, JSON.stringify(p1.stats));
check('setvar 全块收集（含禁用块 B）', p1.vars.length === 1 && p1.vars[0].name === 'alpha' && p1.vars[0].value === '1', JSON.stringify(p1.vars));

console.log('\n== override 覆盖块自身 enabled ==');
const p2 = parsePreset(fixture, { '1': true, '0': false });
check('override: 禁用块B→启用，启用块A→禁用', p2.blocks.length === 2 && p2.blocks.some((b) => b.includes('块B')) && !p2.blocks.some((b) => b.includes('块A')), JSON.stringify(p2.blocks.map((b) => b.slice(0, 8))));

console.log('\n== 真实预设（夏瑾 140 块，12 默认启用）==');
const xj = readFileSync(resolve('E:/claude cade test/project/jiuguanlike/剧本方案/预设/夏瑾 双鱼座 Beta 0.40.json'), 'utf8');
const p3 = parsePreset(xj);
check('真实预设 total=140', p3.stats.total === 140, JSON.stringify(p3.stats));
// 12 块 enabled 但其中 8 块空内容；实际注入 4 个非空块（1395 字符）
check('真实预设非空生效块=4', p3.stats.enabled === 4, JSON.stringify(p3.stats));
check('真实预设注入字符=1395', p3.stats.chars === 1395, String(p3.stats.chars));
check('真实预设 setvar ≥29', p3.vars.length >= 29, `vars=${p3.vars.length}`);
check('真实预设块非空', p3.blocks.length > 0 && p3.blocks[0].length > 50);

console.log('\n== 防护 ==');
let badRejected = false;
try { parsePreset('{bad json'); } catch { badRejected = true; }
check('坏 JSON 被拒', badRejected);
const p4 = parsePreset(JSON.stringify({ prompts: [{ content: 'x', enabled: 'yes' }] }));
check('enabled 非布尔容忍', p4.stats.enabled === 1, JSON.stringify(p4.stats));

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
