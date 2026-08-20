/**
 * memory 核心验证脚本（直接执行，不依赖 test runner 的 spawn 机制）
 * 覆盖：schema 初始化 / 写环 AM 码分配+双表一致 / 混合检索 trigram+LIKE 兜底 / 注入块标注 / AM 码直查 / 空库安全
 */
import { MemoryDb } from '../src/db.ts';
import { RetrievalEngine, calculateDecay } from '../src/retrieval.ts';
import { WriteLoop } from '../src/writer.ts';
import { DAY_MS } from '../src/schema.ts';

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

console.log('== 记忆衰减 + 访问计数（Ebbinghaus 遗忘曲线 + 被引用提升）==');
{
  // 1. calculateDecay 纯函数
  check('decay(0 天)=1', calculateDecay(0, 0.1) === 1);
  const sevenDays = calculateDecay(7 * DAY_MS, 0.1);
  check('decay(7 天, 0.1)≈0.4966', Math.abs(sevenDays - Math.exp(-0.7)) < 1e-9, String(sevenDays));
  check('decay 随时间单调递减', calculateDecay(10 * DAY_MS, 0.1) < sevenDays);

  // 场景：两条同关键词记忆（round1 较早 / round2 较新）；arc↔summary 双表孪生行需同步设置
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  writer.initMeta({}, {});
  writer.execute({ delta_summary: '主角在远古遗迹发现封印，揭开了冒险的序幕', round: 1 });
  writer.execute({ delta_summary: '主角回到遗迹检查封印状态', round: 2 });
  const ret = new RetrievalEngine(mem);
  const now = Date.now();
  const setDecay = (round: number, daysAgo: number, acc: number): void => {
    const ts = daysAgo === 0 ? now : now - daysAgo * DAY_MS;
    mem.db.prepare('UPDATE memory_summary SET last_access_ms = ?, access_count = ? WHERE round = ?').run(ts, acc, round);
    mem.db.prepare('UPDATE memory_arc SET last_access_ms = ?, access_count = ? WHERE title = ?').run(ts, acc, `R${round}`);
  };

  // 2. 等了 5 天的旧记忆，同零访问：新记忆排序应高于旧记忆（但都保留，衰减未击穿门控）
  setDecay(1, 5, 0);
  const r2 = ret.recall({ query: '遗迹', round: 2, budgetTokens: 200, trackAccess: false });
  const f2 = r2.hits.find((h) => h.code === 'AM02');
  const o2 = r2.hits.find((h) => h.code === 'AM01');
  check('新旧都命中(5 天磨损未击穿)', !!f2 && !!o2, `codes=${r2.codes.join(',')}`);
  check('新记忆(今) 排序高于 旧记忆(5 天前)', f2 && o2 ? f2.score > o2.score : false, `fresh=${f2?.score?.toFixed(3)} old=${o2?.score?.toFixed(3)}`);

  // 3. 30 天零访问的旧记忆：衰减击穿置信门控 → 直接剔除（久不被引用则淡出）
  setDecay(1, 30, 0);
  const r3 = ret.recall({ query: '遗迹', round: 2, budgetTokens: 200, trackAccess: false });
  check('30 天零访问旧记忆被门控剔除', !r3.hits.some((h) => h.code === 'AM01'), r3.codes.join(','));

  // 4. 访问提升：30 天前的旧记忆但因被引用 50 次 → 反超今天的零访问新记忆（被引用越多越重要）
  setDecay(1, 30, 50);
  setDecay(2, 0, 0);
  const r4 = ret.recall({ query: '遗迹', round: 2, budgetTokens: 200, trackAccess: false });
  const o4 = r4.hits.find((h) => h.code === 'AM01');
  const f4 = r4.hits.find((h) => h.code === 'AM02');
  check('高频引用旧记忆复活并反超新记忆', o4 && f4 ? o4.score > f4.score : false, `old=${o4?.score?.toFixed(3)} fresh=${f4?.score?.toFixed(3)}`);

  // 5. 访问计数回写：recall（默认 trackAccess）后 access_count 自增（arc+summary 孪生行同步）
  setDecay(2, 0, 0);
  const r5 = ret.recall({ query: '遗迹', round: 2, budgetTokens: 200 });
  const sumCnt = mem.db.prepare('SELECT access_count FROM memory_summary WHERE round = 2').get() as { access_count: number };
  const arcCnt = mem.db.prepare("SELECT access_count FROM memory_arc WHERE title = 'R2'").get() as { access_count: number };
  check('命中注入后双表 access_count 各自增为 1', sumCnt.access_count === 1 && arcCnt.access_count === 1, `sum=${sumCnt.access_count} arc=${arcCnt.access_count}（命中 ${r5.hits.length}）`);

  // 6. decay:false 保守模式：不走时间磨损，新旧都贴近归一化基准（仅差 RRF 基分 <2%）
  setDecay(1, 30, 0);
  setDecay(2, 0, 0);
  const r6 = ret.recall({ query: '遗迹', round: 2, budgetTokens: 200, decay: false, trackAccess: false });
  const f6 = r6.hits.find((h) => h.code === 'AM02');
  const o6 = r6.hits.find((h) => h.code === 'AM01');
  check('decay:false 新旧得分贴近归一化基准', f6 && o6 ? Math.abs(f6.score - o6.score) < 0.02 : false, `fresh=${f6?.score?.toFixed(4)} old=${o6?.score?.toFixed(4)}`);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
