/**
 * sandbox 包验证：MVU 沙箱跑魔法少女卡原引擎（34.5KB v23.5）
 */
import { readFileSync } from 'node:fs';
import { MvuSandbox } from '../src/mvu-sandbox.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// 提取魔法少女卡的引擎脚本（tavern_helper.scripts[2]）
const card = JSON.parse(readFileSync('E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/魔法少女是不会败北恶堕的吧！1.json', 'utf8'));
const th = card.data?.extensions?.tavern_helper;
const scripts = th?.scripts ?? [];
const engine = scripts.find((s: { name?: string }) => String(s.name ?? '').includes('监控器'));
const mvuScript = scripts.find((s: { name?: string }) => String(s.name ?? '').includes('MVU变量框架'));
console.log(`== 魔法少女卡 tavern_helper 脚本 ${scripts.length} 个 ==`);
check('引擎脚本存在（34.5KB）', !!engine && engine.content.length > 10000, `len=${engine?.content?.length}`);
check('MVU 框架脚本存在（CDN import）', !!mvuScript, `len=${mvuScript?.content?.length}`);

if (!engine) {
  console.log('跳过沙箱运行（无引擎脚本）');
  process.exit(failed > 0 ? 1 : 0);
}

console.log('\n== MVU 沙箱运行原引擎（Mvu mock 替代 ESM bundle）==');
const sb = new MvuSandbox({ timeoutMs: 5000 });
try {
  sb.installMvuMock();
  sb.run(engine.content, 'card-engine.js');
  check('引擎脚本运行无异常', true);
  // 引擎启动：$(fn) 立即执行 new MagicGirlEngine，setTimeout(1500) 调 init
  await new Promise((r) => setTimeout(r, 2500));
  const hasInstance = sb.evalInSandbox('typeof window.MagicGirlEngineInstance') === 'object';
  check('MagicGirlEngineInstance 注册', hasInstance);
  const logs = sb.getLogs();
  const fatal = logs.filter((l) => l.includes('error') && !l.includes('未检测到MVU框架') === false);
  check('无致命错误', !fatal.some((l) => l.includes('core') || l.includes('engine')), fatal.slice(0, 2).join(' | '));
  check('Mvu 事件订阅', logs.some((l) => l.includes('[mvu:on] VARIABLE_UPDATE_ENDED')), '引擎应订阅 VARIABLE_UPDATE_ENDED');
  // 触发变量更新事件 → 引擎 tick 应响应（不崩溃）
  sb.emitMvuEvent('VARIABLE_UPDATE_ENDED', { stat_data: { 战斗阶段: '战斗准备', 当前回合: 1 } });
  check('事件驱动 tick 无异常', true);
  console.log(`  日志 ${logs.length} 条，样例: ${logs.slice(0, 4).join(' || ')}`);
} catch (e) {
  check('沙箱运行无异常', false, (e as Error).message.slice(0, 120));
} finally {
  sb.dispose();
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
