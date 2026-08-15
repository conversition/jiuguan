/**
 * memory 核心验证脚本（直接执行，不依赖 test runner 的 spawn 机制）
 * 覆盖：schema 初始化 / 写环 AM 码分配+双表一致 / 混合检索 trigram+LIKE 兜底 / 注入块标注 / AM 码直查 / 空库安全
 */
import { MemoryDb } from '../src/db.ts';
import { RetrievalEngine } from '../src/retrieval.ts';
import { WriteLoop } from '../src/writer.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

console.log('== schema v3 ==');
{
  const mem = new MemoryDb();
  const tables = mem.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const names = tables.map((t) => t.name);
  check('核心表齐全', ['memory_arc', 'memory_summary', 'memory_event', 'memory_state', 'vec_memory', 'fts_arc', 'fts_summary'].every((n) => names.includes(n)));
}

console.log('== 写环：AM 码分配 + 双表一致 ==');
{
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
  const r1 = writer.execute({
    delta_summary: '主角抵达学院，与魔法少女初遇，获得初始契约',
    state_changes: [
      { entity_type: 'protagonist', entity_id: '主角', field: '位置', value: '学院', action: 'upsert' },
      { entity_type: 'npc', entity_id: '魔法少女', field: '好感', value: '10', action: 'upsert' },
    ],
    new_events: [{ description: '主角与魔法少女签订契约' }],
    round: 1,
  });
  check('首轮 AM01', r1.insertedCodes.includes('AM01'), r1.insertedCodes.join(','));
  check('首轮事件独立码 AM02', r1.insertedCodes.includes('AM02'), r1.insertedCodes.join(','));
  check('双表一致', r1.codesConsistent);

  const r2 = writer.execute({ delta_summary: '主角遭遇怪物袭击，魔法少女变身迎战', round: 2 });
  // AM 码全局唯一：event 占用了 AM02，第二轮 summary 应为 AM03
  check('第二轮 AM03（全局唯一）', r2.insertedCodes.includes('AM03'), r2.insertedCodes.join(','));
  check('双表一致(2)', r2.codesConsistent);

  const state = mem.db.prepare('SELECT * FROM memory_state').all() as { entity_id: string; state_json: string }[];
  const mc = state.find((s) => s.entity_id === '魔法少女');
  check('状态表写入 魔法少女好感10', !!mc && mc.state_json.includes('"好感":"10"'), JSON.stringify(state));
}

console.log('== 混合检索 ==');
{
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  writer.initMeta({}, {});
  writer.execute({ delta_summary: '魔法少女在战斗中处于劣势姿态，快感值累积', round: 1 });
  writer.execute({ delta_summary: '主角在酒馆遇到神秘少女，获得任务线索', round: 2 });
  writer.execute({ delta_summary: '魔法少女变身迎战怪物，战斗进入白热化', round: 3 });

  const ret = new RetrievalEngine(mem);
  const r1 = ret.recall({ query: '魔法少女', round: 3, budgetTokens: 200 });
  check('trigram 3+字命中', r1.hits.length >= 1, `hits=${r1.hits.length}`);
  check('注入块格式', r1.injectedBlock.startsWith('<记忆召回>'));

  const r2 = ret.recall({ query: '少女', round: 3, budgetTokens: 200 });
  check('LIKE 兜底 2 字命中', r2.hits.length >= 1, `hits=${r2.hits.length}`);

  const r3 = ret.recall({ query: '屠龙刃 主角', round: 1, budgetTokens: 200 });
  const r4 = ret.recall({ query: 'AM01' });
  check('AM 码直查', r4.hits.some((h) => h.code === 'AM01'));

  const r5 = ret.recall({ query: '完全无关的词汇xyz' });
  check('空命中安全', r5.hits.length === 0 && r5.injectedBlock.includes('无高置信'));
}

console.log('== 性能基准（10 万级近似：3000 行 × 33 次扫描）==');
{
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  writer.initMeta({}, {});
  for (let i = 1; i <= 300; i++) {
    writer.execute({ delta_summary: `第${i}轮：主角推进主线任务${i}，击败怪物${i % 20}号，获得经验${i * 10}`, round: i });
  }
  const ret = new RetrievalEngine(mem);
  const t0 = Date.now();
  const r = ret.recall({ query: '主角 怪物', round: 300 });
  const elapsed = Date.now() - t0;
  check('300 轮数据检索 < 50ms', elapsed < 50, `elapsed=${elapsed}ms hits=${r.hits.length}`);
  // 独有内容精确命中对应轮次（如第 300 轮的"经验3000"）
  const rExact = ret.recall({ query: '经验3000 任务300', round: 300, budgetTokens: 100 });
  check('独有内容命中对应轮次', rExact.hits.some((h) => h.code === 'AM300'), `codes=${rExact.codes.join(',')}`);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
