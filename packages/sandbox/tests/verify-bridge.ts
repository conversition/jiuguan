/**
 * sandbox 包验证 - MVU 引擎 ↔ VMS 桥（接入回合）
 * 覆盖：
 *  - 原引擎沙箱运行 + lodash 子集（真实 tick，非早退）
 *  - 回合后驱动：幕间回合计数确定性递增（引擎真实计算）
 *  - VMS 同步（session:mvu:<path> 叶子）+ 宏展开（中文/点路径键）
 *  - memory_state 持久化 + 重启恢复
 */
import { readFileSync } from 'node:fs';
import { MvuBridge, defaultStarterState } from '../src/mvu-bridge.ts';
import { MemoryDb } from '../../memory/src/db.ts';
import { VariableManager } from '../../variable/src/vms.ts';
import { expandVariables } from '../../prompt/src/assembly.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const CARD_PATH = 'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/魔法少女是不会败北恶堕的吧！1.json';
const CARD_NAME = '魔法少女是不会败北恶堕的吧！1';

// 提取引擎脚本（34.5KB v23.5）
const card = JSON.parse(readFileSync(CARD_PATH, 'utf8'));
const scripts = card.data?.extensions?.tavern_helper?.scripts ?? [];
const engine = scripts.find((s: { name?: string }) => String(s.name ?? '').includes('监控器'));
check('引擎脚本存在', !!engine && engine.content.length > 10000, `len=${engine?.content?.length}`);
if (!engine) process.exit(failed > 0 ? 1 : 0);

console.log('\n== 桥接启动（沙箱 + lodash + Mvu mock + 起步状态）==');
const db = new MemoryDb(); // 内存库
const vms = new VariableManager();
const bridge = new MvuBridge({ cardName: CARD_NAME, engineScript: engine.content, db, vms, starterState: defaultStarterState() });
await bridge.start();
check('引擎 ready', bridge.isReady());
const logs = bridge.getLogs();
check('引擎挂载日志', logs.some((l) => l.includes('挂载完成')), logs.slice(-3).join(' | '));
check('引擎初始化日志', logs.some((l) => l.includes('核心引擎初始化完成')), logs.slice(-3).join(' | '));
const fatal = logs.filter((l) => /is not defined|ReferenceError|TypeError|Cannot read/.test(l));
check('无引擎异常', fatal.length === 0, fatal.slice(0, 2).join(' || '));
check('起步状态叶子已同步 VMS', !!vms.get('session:mvu:进程.阶段'), 'session:mvu:进程.阶段');

console.log('\n== 回合后驱动 tick（AI 消息落库后触发引擎计算）==');
const chat1 = [
  { is_user: false, content: '（开场白）' },
  { is_user: true, content: '你好，今天也要战斗吗？' },
  { is_user: false, content: '……（沉默地点头，握紧拳头）' },
];
const t1 = bridge.tickAfterAiTurn(chat1, 1);
check('tick1 无异常且产生变更', t1.changed.length > 0, `changed=${t1.changed.length}`);
check('幕间回合计数 0→1（引擎真实计算）', vms.get('session:mvu:系统状态.幕间回合计数')?.value === 1, `vms=${vms.get('session:mvu:系统状态.幕间回合计数')?.value}`);
const state1 = JSON.parse((db.db.prepare("SELECT state_json FROM memory_state WHERE entity_type='mvu' AND entity_id=?").get(CARD_NAME) as { state_json: string }).state_json);
check('引擎原地变更 state（幕间回合计数=1）', state1['系统状态']?.['幕间回合计数'] === 1, JSON.stringify(state1['系统状态']).slice(0, 80));
check('持久化行已写', true);

console.log('\n== 宏展开（中文/点路径键 → VMS 完整名后缀匹配）==');
const flat = bridge.getFlat();
const expanded = expandVariables('阶段={{var:进程.阶段}} 魔力={{var:主角.核心状态.魔力值.当前}} HP={{getvar::主角.核心状态.体力值.当前::0}}', flat);
check('引擎变量宏展开', expanded === '阶段=幕间休息 魔力=100 HP=100', expanded);
const block = bridge.getStateBlock(300);
check('引擎状态块注入', block.includes('世界.威胁等级 = 1') && block.includes('</引擎状态>'), block.slice(0, 80));

console.log('\n== 跨回合演化（tick2：幕间回合计数 1→2）==');
const chat2 = [...chat1, { is_user: true, content: '我们出发吧。' }, { is_user: false, content: '……嗯。' }];
const t2 = bridge.tickAfterAiTurn(chat2, 2);
check('tick2 幕间回合计数=2', vms.get('session:mvu:系统状态.幕间回合计数')?.value === 2, `value=${vms.get('session:mvu:系统状态.幕间回合计数')?.value}`);
check('tick2 无异常', !bridge.getLogs().slice(-20).some((l) => /ReferenceError|TypeError|is not defined/.test(l)));

console.log('\n== 重启恢复（新桥从 memory_state 恢复 stat_data）==');
const vms2 = new VariableManager();
const bridge2 = new MvuBridge({ cardName: CARD_NAME, engineScript: engine.content, db, vms: vms2 });
await bridge2.start();
check('恢复后幕间回合计数=2', vms2.get('session:mvu:系统状态.幕间回合计数')?.value === 2, `value=${vms2.get('session:mvu:系统状态.幕间回合计数')?.value}`);
check('恢复后阶段一致', vms2.get('session:mvu:进程.阶段')?.value === '幕间休息');
bridge.dispose();
bridge2.dispose();

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
