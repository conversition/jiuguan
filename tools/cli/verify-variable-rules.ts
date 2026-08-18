/**
 * 验证脚本：确定性规则执行器（trigger-action → VMS 更新，变化集/contains/步数上限）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-variable-rules.ts
 */
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { executeRules, MAX_RULES_STEPS } from '../../packages/variable/src/rules.ts';
import type { VariableManifestRule } from '../../packages/variable/src/manifest.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

function freshVms(): VariableManager {
  const v = new VariableManager();
  v.register({ scope: 'session', source: 'card', name: 'affection', type: 'literal', value: 0 });
  v.register({ scope: 'session', source: 'card', name: 'trust', type: 'literal', value: 5 });
  v.register({ scope: 'session', source: 'card', name: 'location', type: 'literal', value: '未知' });
  return v;
}

const RULES: VariableManifestRule[] = [
  { trigger: 'contains({event_user_input}, "礼物")', action: 'affection = {affection} + 1', requires_ai: false },
  { trigger: 'contains({event_user_input}, "说谎")', action: 'trust = max(0, {trust} - 2)', requires_ai: false },
  { trigger: 'true', action: 'location = {event_location}', requires_ai: false },
];

function main() {
  // ---- 场景1：gift 事件 → 好感 +1 ----
  const v1 = freshVms();
  const r1 = executeRules(RULES, { user_input: '我把一份礼物递给她', location: '酒馆' }, v1);
  check('场景1 好感 0→1', v1.get('session:card:affection')?.value === 1, `got ${v1.get('session:card:affection')?.value}`);
  check('场景1 变化集含 affection', r1.effects.some((e) => e.name === 'session:card:affection' && e.old === 0 && e.new === 1), JSON.stringify(r1.effects));
  check('场景1 地点同步更新', v1.get('session:card:location')?.value === '酒馆', '');
  check('场景1 信任未动', v1.get('session:card:trust')?.value === 5, '');

  // ---- 场景2：说谎 → 信任 5→3；重复到 0 后 clamp 不再变化（无 effect） ----
  const v2 = freshVms();
  executeRules(RULES, { user_input: '你看出他在说谎', location: '王宫' }, v2);
  check('场景2 信任 5→3', v2.get('session:card:trust')?.value === 3, '');
  executeRules(RULES, { user_input: '又说谎了', location: '王宫' }, v2);
  executeRules(RULES, { user_input: '继续说谎', location: '王宫' }, v2);
  check('场景2 信任 clamp 到 0', v2.get('session:card:trust')?.value === 0, '');
  const r2 = executeRules(RULES, { user_input: '仍在说谎', location: '王宫' }, v2);
  check('场景2 无变化不产 effect', r2.effects.length === 0, JSON.stringify(r2.effects));

  // ---- 场景3：无 trigger 命中 → 全量无变化 ----
  const v3 = freshVms();
  const r3 = executeRules(RULES, { user_input: '今天天气不错', location: '庭院' }, v3);
  check('场景3 仅 location 变化', r3.effects.length === 1 && r3.effects[0].name === 'session:card:location', JSON.stringify(r3.effects));

  // ---- 场景4：步数上限（70 条恒真规则 → 64 步截断 + 记录错误） ----
  const v4 = freshVms();
  const many: VariableManifestRule[] = Array.from({ length: 70 }, () => ({ trigger: 'true', action: 'affection = {affection} + 1', requires_ai: false }));
  const r4 = executeRules(many, {}, v4);
  check('场景4 步数停在上限', r4.steps === MAX_RULES_STEPS, `steps=${r4.steps}`);
  check('场景4 截断错误记录', r4.errors.some((e) => e.message.includes('步数上限')), JSON.stringify(r4.errors));
  check('场景4 好感停在 64', v4.get('session:card:affection')?.value === 64, `got ${v4.get('session:card:affection')?.value}`);

  // ---- 场景5：action 左值未声明 / 派生变量不可赋值 → 跳过 + 错误 ----
  const v5 = freshVms();
  v5.register({ scope: 'session', source: 'card', name: 'derived', type: 'derived', expression: '{affection} * 2' });
  const r5 = executeRules([
    { trigger: 'true', action: 'ghost = 1', requires_ai: false },
    { trigger: 'true', action: 'derived = 3', requires_ai: false },
  ], {}, v5);
  check('场景5 两个非法 action 被跳过', r5.effects.length === 0 && r5.errors.length === 2, JSON.stringify(r5.errors));
  check('场景5 derived 未被覆盖', v5.get('session:card:derived')?.value === undefined, '');

  console.log(failures === 0 ? '\n变量规则执行验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();