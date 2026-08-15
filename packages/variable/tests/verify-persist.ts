/**
 * variable 包验证 - VMS 持久化接线（06 §6：memory_state entity_type='variable' 快照 + 加载恢复）
 * 覆盖：
 *  - 全量快照（含中文/点路径引擎叶子）单行落库
 *  - 值变更后快照更新
 *  - 恢复为 literal（derived 不冻结，恢复后重算正确）
 *  - 空/坏数据防护
 */
import { MemoryDb } from '../../memory/src/db.ts';
import { VariableManager } from '../src/vms.ts';
import { persistVariables, restoreVariables, VMS_ENTITY_TYPE, VMS_ENTITY_ID } from '../src/persist.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const db = new MemoryDb();
const vms = new VariableManager();

// 注册：预设变量 + 引擎式中文点路径叶子 + 一个 derived
vms.registerBatch([
  { scope: 'preset', source: 'preset', name: 'wordsCloud', type: 'literal', value: '温柔,夜幕,雨声' },
  { scope: 'session', source: 'mvu', name: '主角.核心状态.魔力值.当前', type: 'literal', value: 100 },
  { scope: 'session', source: 'mvu', name: '系统状态.幕间回合计数', type: 'literal', value: 2 },
  { scope: 'session', source: 'mvu', name: '进程.阶段', type: 'literal', value: '幕间休息' },
  { scope: 'card', source: 'card', name: 'power', type: 'literal', value: 50 },
]);
vms.register({ scope: 'card', source: 'card', name: 'power2', type: 'derived', expression: '{power} * 2' });

console.log('\n== 全量快照落库（onPersist 每次 evaluate 触发）==');
vms.onPersist(() => persistVariables(db, vms, 3));
const r = vms.evaluate();
check('evaluate 成功（derived 重算 100）', r.values['card:card:power2'] === 100, String(r.values['card:card:power2']));
const row = db.db.prepare('SELECT state_json, updated_round FROM memory_state WHERE entity_type = ? AND entity_id = ?')
  .get(VMS_ENTITY_TYPE, VMS_ENTITY_ID) as { state_json: string; updated_round: number } | undefined;
check('快照行已写', !!row, '无行');
if (row) {
  const snap = JSON.parse(row.state_json) as Record<string, unknown>;
  check('含预设变量', snap['preset:preset:wordsCloud'] === '温柔,夜幕,雨声');
  check('含中文点路径引擎叶子', snap['session:mvu:主角.核心状态.魔力值.当前'] === 100, String(snap['session:mvu:主角.核心状态.魔力值.当前']));
  check('含整数类型保持', snap['session:mvu:系统状态.幕间回合计数'] === 2 && typeof snap['session:mvu:系统状态.幕间回合计数'] === 'number');
  check('不含 derived（表达式重算，不冻结）', !('card:card:power2' in snap));
  check('round=3', row.updated_round === 3, String(row.updated_round));
}

console.log('\n== 值变更后快照更新 ==');
vms.set('session:mvu:系统状态.幕间回合计数', 3);
vms.evaluate();
const row2 = db.db.prepare('SELECT state_json FROM memory_state WHERE entity_type = ? AND entity_id = ?')
  .get(VMS_ENTITY_TYPE, VMS_ENTITY_ID) as { state_json: string };
check('变更后快照刷新', JSON.parse(row2.state_json)['session:mvu:系统状态.幕间回合计数'] === 3);

console.log('\n== 恢复（新管理器 → 快照 → literal 声明）==');
const vms2 = new VariableManager();
const restored = restoreVariables(db, vms2);
check('恢复条数=5（仅 literal，derived 除外）', restored === 5, String(restored));
check('中文点路径恢复', vms2.get('session:mvu:主角.核心状态.魔力值.当前')?.value === 100);
check('恢复值正确', vms2.get('session:mvu:系统状态.幕间回合计数')?.value === 3);
// 模拟来源重新注册 derived（来源文件加载时声明，引用已恢复的 literal）→ 重算正确
vms2.register({ scope: 'card', source: 'card', name: 'power2', type: 'derived', expression: '{power} * 2' });
check('恢复后 evaluate 重算 derived（引用恢复值）', vms2.evaluate().values['card:card:power2'] === 100);

console.log('\n== 防护 ==');
const dbEmpty = new MemoryDb();
const vmsEmpty = new VariableManager();
check('空 VMS 不写行', persistVariables(dbEmpty, vmsEmpty, 1) === 0);
dbEmpty.db.prepare("INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES (?,?,?,?,?)")
  .run(VMS_ENTITY_TYPE, VMS_ENTITY_ID, '坏数据', '{invalid json', 1);
const vms3 = new VariableManager();
check('坏快照恢复=0 不崩溃', restoreVariables(dbEmpty, vms3) === 0);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
