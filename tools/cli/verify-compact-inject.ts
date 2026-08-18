/**
 * 验证脚本：紧凑按需注入（只注入变化集 vs 扁平全量，token 对比）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-compact-inject.ts
 */
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { executeRules, formatVarDelta, bareVarName } from '../../packages/variable/src/rules.ts';
import { blockTokens } from '../../packages/prompt/src/context-scheduler.ts';
import type { VariableManifestRule } from '../../packages/variable/src/manifest.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const RULES: VariableManifestRule[] = [
  { trigger: 'contains({event_user_input}, "礼物")', action: 'affection = {affection} + 1', requires_ai: false },
  { trigger: 'true', action: 'location = {event_location}', requires_ai: false },
];

/** 镜像 session.worldStateBlock 的变量段（紧凑 vs 全量） */
const compactVarText = (effects: { name: string; old: unknown; new: unknown }[]) => (effects.length > 0 ? formatVarDelta(effects) : '（无变化）');

function main() {
  const v = new VariableManager();
  // 十几条不变量（模拟后台引擎/预设堆出的全量变量）
  v.register({ scope: 'session', source: 'card', name: 'affection', type: 'literal', value: 0 });
  v.register({ scope: 'session', source: 'card', name: 'trust', type: 'literal', value: 5 });
  for (let i = 0; i < 12; i++) v.register({ scope: 'session', source: 'card', name: `longvar_${i}`, type: 'literal', value: `不动值${i}` });
  v.register({ scope: 'session', source: 'card', name: 'location', type: 'literal', value: '未知' });

  // 全量扁平段（镜像旧 worldStateBlock）
  const allValues = Object.fromEntries(v.list().map((d) => [bareVarName(d.fullName), d.value ?? '']));
  const flatVars = Object.entries(allValues).map(([k, val]) => `${k}=${val}`).join('; ');
  const flatTokens = blockTokens(flatVars);

  // 触发一条规则（affection 变化）
  const r1 = executeRules(RULES, { user_input: '送她一份礼物', location: '酒馆' }, v);
  const deltaTokens = blockTokens(compactVarText(r1.effects));

  console.log(`全量变量段 ${flatTokens}t（${Object.keys(allValues).length} 变量） vs 变化集 ${deltaTokens}t（${r1.effects.length} 变量）`);
  check('紧凑注入 token < 全量', deltaTokens < flatTokens, `${deltaTokens} vs ${flatTokens}`);
  check('变化集只含变化的变量', r1.effects.every((e) => e.old !== e.new) && r1.effects.some((e) => bareVarName(e.name) === 'affection'), JSON.stringify(r1.effects.map((e) => bareVarName(e.name))));
  check('长时间无变化 → 空段', formatVarDelta([] as RuleEffect[]) === '', '');

  // 变化集 token 占比（量化收益）
  const ratio = flatTokens > 0 ? (1 - deltaTokens / flatTokens) * 100 : 0;
  console.log(`[收益] 变化集注入较全量省约 ${ratio.toFixed(0)}% token`);
  check('收益 > 0%', ratio > 0, `ratio=${ratio.toFixed(0)}%`);

  console.log(failures === 0 ? '\n紧凑注入验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();