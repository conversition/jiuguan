/**
 * 验证脚本：回合奖励塑形（reward.ts 纯函数）
 * RL 映射的数值契约：acc 隐式代理 / cost 成本塑形 / step 结构加成。
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-reward.ts
 */
import { shapeTurnOutcome, planStructureScore } from '../../packages/prompt/src/reward.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const near = (a: number, b: number, eps = 0.021) => Math.abs(a - b) <= eps;

// ---- acc 隐式代理 ----
const r0 = shapeTurnOutcome({ retryIndex: 0, planOk: true });
check('首轮未重发 acc=1', near(r0.acc, 1), `got ${r0.acc}`);
check('首轮未重发 score=1', near(r0.score, 1), `got ${r0.score}`);
const r2 = shapeTurnOutcome({ retryIndex: 2, planOk: true });
check('重发 2 次 acc=0.4（线性衰减）', near(r2.acc, 0.4), `got ${r2.acc}`);
const r3 = shapeTurnOutcome({ retryIndex: 3, planOk: true });
check('重发 3 次 acc=0.1', near(r3.acc, 0.1), `got ${r3.acc}`);
const ab = shapeTurnOutcome({ retryIndex: 0, aborted: true });
check('中止 acc=0', ab.acc === 0, `got ${ab.acc}`);
const del = shapeTurnOutcome({ retryIndex: 1, deleted: true });
check('删除 acc=0', del.acc === 0, `got ${del.acc}`);
const r6 = shapeTurnOutcome({ retryIndex: 6, planOk: true });
check('重发 6 次 acc 钳制到 0', r6.acc === 0, `got ${r6.acc}`);

// ---- cost 成本塑形：超预算扣分、不惩罚正文长度 ----
const cheap = shapeTurnOutcome({ retryIndex: 0, tokenCost: 1000, planOk: true });
const pricey = shapeTurnOutcome({ retryIndex: 0, tokenCost: 20000, planOk: true });
check('超预算扣分（score 低于省额轮）', pricey.score < cheap.score, `got ${cheap.score} vs ${pricey.score}`);
check('预算内 cost=0', cheap.cost === 0, `got ${cheap.cost}`);
check('超预算 cost<0', pricey.cost < 0, `got ${pricey.cost}`);

// ---- step 结构加成（用 retryIndex=1：acc=0.7 不被 score 封顶 1 遮蔽）----
const barePlan = shapeTurnOutcome({ retryIndex: 1, tokenCost: 0, planOk: true, planStructureScore: 0 });
const richPlan = shapeTurnOutcome({ retryIndex: 1, tokenCost: 0, planOk: true, planStructureScore: 1 });
check('结构完整轮 step 加成>0', richPlan.step > 0, `got ${richPlan.step}`);
check('结构完整轮 score 高于裸 plan', richPlan.score > barePlan.score, `got ${barePlan.score} vs ${richPlan.score}`);
check('裸 plan step=0', barePlan.step === 0, `got ${barePlan.step}`);
check('score 钳制 ≤1', shapeTurnOutcome({ retryIndex: 0, tokenCost: 0, planOk: true, planStructureScore: 1 }).score <= 1, '');

// ---- planStructureScore ----
check('完整 plan = 1', planStructureScore({ roadmap: { current_arc: 'arc', current_stage: 's' }, key_events: [{}], bars_delta: {} }) === 1);
check('缺 bars_delta = 2/3', near(planStructureScore({ roadmap: { current_arc: 'arc', current_stage: 's' }, key_events: [{}] }), 2 / 3, 1e-9));
check('空 plan = 0', planStructureScore(null) === 0);
check('裸对象 = 0', planStructureScore({}) === 0);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);