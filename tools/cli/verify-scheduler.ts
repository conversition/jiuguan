/**
 * 验证脚本：L2 上下文调度层（优先级排序 + 全局预算裁剪 + 宁丢勿裁）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-scheduler.ts
 */
import { scheduleContext, blockTokens, shrinkToBudget } from '../../packages/prompt/src/context-scheduler.ts';
import type { ContextBlock } from '../../packages/prompt/src/context-scheduler.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const big = '长'.repeat(300); // 300 中文字 → 450 tok
const small = '短句内容'.repeat(6); // 24 字 → 36 tok

const blocks: ContextBlock[] = [
  { id: 'memory', fragment: small, cost: 400, priority: 80 },
  { id: 'worldbook', fragment: big, cost: 1200, priority: 60 },
  { id: 'worldstate', fragment: small, cost: 200, priority: 40 },
];

function main() {
  // ---- 场景1：优先级排序 + 预算裁剪 ----
  const r1 = scheduleContext(blocks, 40); // 预算只容 memory(36tok)
  check('场景1 保留优先级最高块', r1.blocks.length === 1 && r1.blocks[0].id === 'memory', `kept=${JSON.stringify(r1.blocks.map((b) => b.id))}`);
  check('场景1 被裁块标记 over-budget', r1.dropped.some((d) => d.id === 'worldbook' && d.reason === 'over-budget'), `dropped=${JSON.stringify(r1.dropped)}`);

  // ---- 场景2：预算宽松 → 全部保留，按 priority 排序 ----
  const r2 = scheduleContext(blocks, 2000);
  check('场景2 全保留且 priority 降序', r2.blocks.map((b) => b.id).join(',') === 'memory,worldbook,worldstate', `order=${r2.blocks.map((b) => b.id).join(',')}`);
  check('场景2 total 不超预算', r2.totalTokens <= 2000, `total=${r2.totalTokens}`);

  // ---- 场景3：单块超自报 cost → 整体丢（宁丢勿裁） ----
  const overBlock: ContextBlock[] = [{ id: 'huge', fragment: '大'.repeat(1000), cost: 100, priority: 99 }]; // 1500 tok > 100
  const r3 = scheduleContext(overBlock, 5000);
  check('场景3 超 cost 整体丢', r3.blocks.length === 0 && r3.dropped[0]?.reason === 'over-cost', `dropped=${JSON.stringify(r3.dropped)}`);

  // ---- 场景4：token 估算口径 ----
  const t1 = blockTokens('你好世界');
  check('场景4 中文按1.5估', t1 === 6, `got ${t1}`);
  const t2 = blockTokens('abcd');
  check('场景4 英文按0.4估', t2 === 2, `got ${t2}`);

  // ---- 场景5：reducible 块 over-cost → 收缩保留，而非整块丢 ----
  const reducible: ContextBlock[] = [{ id: 'worldstate', fragment: '世界状态\n变量: ' + '长'.repeat(1000), cost: 300, priority: 90, reducible: true }]; // >300 → 应收缩
  const r5 = scheduleContext(reducible, 50000);
  check('场景5 reducible 块被保留', r5.blocks.length === 1 && r5.blocks[0].id === 'worldstate', `kept=${JSON.stringify(r5.blocks.map((b) => b.id))}`);
  check('场景5 收缩后 cost 内', r5.blocks[0] && blockTokens(r5.blocks[0].fragment) <= 300, `tokens=${r5.blocks[0] ? blockTokens(r5.blocks[0].fragment) : 'N/A'}`);
  check('场景5 仍标记 over-cost（收缩降级）', r5.dropped.some((d) => d.id === 'worldstate' && d.reason === 'over-cost'), `dropped=${JSON.stringify(r5.dropped)}`);

  // ---- 场景6：非 reducible 块 over-cost 仍整块丢（宁丢勿裁保留） ----
  const nonReducible: ContextBlock[] = [{ id: 'worldstate', fragment: '变量: ' + '长'.repeat(1000), cost: 300, priority: 90 }]; // 无 reducible
  const r6 = scheduleContext(nonReducible, 50000);
  check('场景6 非 reducible 仍整块丢', r6.blocks.length === 0 && r6.dropped[0]?.reason === 'over-cost', `dropped=${JSON.stringify(r6.dropped)}`);

  // ---- 场景7：shrinkToBudget 工具 ----
  const s1 = shrinkToBudget('完整片段X', 20); // 已小 → 原样
  check('场景7 预算内原样返回', s1 === '完整片段X', `got ${s1}`);
  const s2 = shrinkToBudget('变量: ' + '长'.repeat(500), 300); // 收缩
  check('场景7 超预算收缩到预算内', blockTokens(s2) <= 300 && s2.includes('已精简'), `tokens=${blockTokens(s2)}`);

  console.log(failures === 0 ? '\n调度层验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();