// 验证 safeParseTurn 容错能力（嵌套 JSON 字符串 + 尾随字符）+ 契约归一化/诊断韧性
import { safeParseTurn, normalizeTurn, validateGameTurn, diagIssueDetail } from '../src/turn.ts';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// 1. 正常输出
const good = JSON.stringify({
  plan: { key_events: [{ description: 'x' }], bars_delta: {}, next_plan: 'y', event_type: 'normal' },
  memory_delta: { delta_summary: 'd' },
  prose: 'p',
});
check('正常输出', !!safeParseTurn(good));

// 2. 嵌套 JSON 字符串（plan/memory_delta 被模型序列化为字符串）
const nested = JSON.stringify({
  plan: JSON.stringify({ key_events: [{ description: 'x' }], bars_delta: {}, next_plan: 'y', event_type: 'normal' }),
  memory_delta: JSON.stringify({ delta_summary: 'd' }),
  prose: 'p',
});
const p2 = safeParseTurn(nested);
check('嵌套字符串修复', !!p2 && typeof p2.plan === 'object' && typeof p2.memory_delta === 'object');

// 3. 尾随垃圾字符
const trailing = good + '} extra garbage here';
check('尾随字符修复', !!safeParseTurn(trailing));

// 4. 截断（缺结尾）→ 应修复或返回 null（不崩溃）
const truncated = good.slice(0, -5);
const p4 = safeParseTurn(truncated);
check('截断不崩溃', p4 === null || (p4 && 'prose' in p4));

// 5. 归一化：countdown >30 clamp、bars 越界 clamp
const t = {
  plan: {
    key_events: [{ description: 'e' }],
    bars_delta: { accident: 150 },
    next_plan: 'n',
    event_type: 'normal',
    parallel: [{ kind: 'normal', actor: 'a', action: 'x', countdown_min: 60 }],
  },
  memory_delta: { delta_summary: 's' },
  prose: 'p',
};
const n = normalizeTurn(t);
check('countdown 60→30', n.turn.plan.parallel[0].countdown_min === 30);
check('bars 150→100', n.turn.plan.bars_delta.accident === 100);
check('归一化警告≥2', n.warnings.length >= 2, n.warnings.join(';'));

// 6. 契约韧性：state_changes.action 同义词归一化（模型写 update/remove 等口语词 → 契约可过）
const t6 = {
  plan: { key_events: [{ description: 'e' }], bars_delta: {}, next_plan: 'n', event_type: 'normal' },
  memory_delta: {
    delta_summary: 's',
    state_changes: [
      { entity_type: 'protagonist', entity_id: '主角', field: '位置', value: '学院', action: 'update' },
      { entity_type: 'npc', entity_id: '路人', action: 'remove' },
      { entity_type: 'npc', entity_id: '未知', action: '爆炸' },
    ],
  },
  prose: 'p',
};
const n6 = normalizeTurn(t6 as unknown as import('../src/turn.ts').GameTurn);
check('action update→upsert', n6.turn.memory_delta.state_changes[0].action === 'upsert');
check('action remove→delete', n6.turn.memory_delta.state_changes[1].action === 'delete');
check('action 未知→upsert 保底', n6.turn.memory_delta.state_changes[2].action === 'upsert');
check('action 归一化警告≥3', n6.warnings.filter((w) => w.includes('action')).length >= 3, n6.warnings.join(';'));
check('归一化后契约通过', validateGameTurn(n6.turn).ok, validateGameTurn(n6.turn).issues.join(';'));

// 7. diagIssueDetail：契约失败时能沿 path 取到实际值（供错误召回 + 日志）
const bad = {
  plan: { key_events: [{ description: 'e' }], bars_delta: {}, next_plan: 'n', event_type: 'normal' },
  memory_delta: { delta_summary: 's', state_changes: [{ entity_type: 'protagonist', entity_id: '主角', action: 'update' }] },
  prose: 'p',
};
const v7 = validateGameTurn(bad as unknown as import('../src/turn.ts').GameTurn);
check('裸 update 契约失败（未归一化）', !v7.ok, v7.issues.join(';'));
const detail = diagIssueDetail(v7.issues[0], bad as unknown as import('../src/turn.ts').GameTurn);
check('diag 取到实际值', detail.includes('"update"'), detail);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
