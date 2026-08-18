/**
 * 验证脚本：工具 DAG 平台化 (0.5.0 C)
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-tool-dag.ts
 * 场景：依赖拓扑排序 / 无依赖并行 / 结果进 tool_results 命名空间 / 环检测 / 异常隔离。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ToolDag, type ToolContext, type ToolDefinition } from '../../packages/core/src/tool-dag.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

interface TickCtx extends ToolContext {
  runtime: Record<string, unknown> & { ticks: string[] };
}

function makeTickTool(name: string, deps: string[] = [], delay = 8): ToolDefinition<TickCtx> {
  return {
    name,
    description: `ticks ${name}`,
    dependencies: deps,
    deterministic: true,
    sideEffects: false,
    async execute(ctx) {
      await sleep(delay);
      (ctx.runtime.ticks as string[]).push(name);
      return { ok: true, data: { name }, cost: delay };
    },
  };
}

async function main() {
  // ---- 场景1：菱形依赖拓扑（A → B/C → D）----
  const g1 = new ToolDag<TickCtx>();
  g1.define(makeTickTool('a')).define(makeTickTool('b', ['a'])).define(makeTickTool('c', ['a'])).define(makeTickTool('d', ['b', 'c']));
  const layers1 = g1.plan();
  check('依赖拓扑 = 3 层', layers1.length === 3, JSON.stringify(layers1));
  check('层1 = [a]', layers1[0].length === 1 && layers1[0][0] === 'a', JSON.stringify(layers1[0]));
  check('层2 = [b,c] 可并行', layers1[1].length === 2 && layers1[1].includes('b') && layers1[1].includes('c'), JSON.stringify(layers1[1]));
  check('层3 = [d]', layers1[2].length === 1 && layers1[2][0] === 'd', JSON.stringify(layers1[2]));

  // ---- 场景2：无依赖工具并行执行 + 结果进命名空间 ----
  const g2 = new ToolDag<TickCtx>();
  const ticks: string[] = [];
  g2.define(makeTickTool('recall_memory', [], 40));
  g2.define(makeTickTool('worldbook_activate', [], 40));
  g2.define(makeTickTool('update_variable', [], 40));
  const t0 = Date.now();
  const out2 = await g2.runAll({ round: 1, input: 'hi', deps: {}, runtime: { ticks } });
  const elapsed = Date.now() - t0;
  check('无依赖并行：总耗时 ≈ 单工具（< 累加 120ms 的 60%）', elapsed < 95, `elapsed=${elapsed}ms`);
  check('并行执行全部触发', ticks.length === 3, JSON.stringify(ticks));
  check('结果写入 tool_results 命名空间', out2.recall_memory?.ok === true && out2.update_variable?.ok === true, JSON.stringify(out2));

  // ---- 场景3：有副作用工具在依赖后分层（deps 读取上游结果）----
  const g3 = new ToolDag<TickCtx>();
  let sawDepHits = false;
  g3.define({
    name: 'recall_memory', description: 'upstream', dependencies: [], deterministic: true, sideEffects: false,
    execute: () => ({ ok: true, data: { hits: ['h1'] }, cost: 1 }),
  });
  g3.define({
    name: 'story_index', description: 'dep on recall', dependencies: ['recall_memory'], deterministic: true, sideEffects: true,
    execute(ctx) {
      const hits = (ctx.deps.recall_memory?.data.hits as unknown as string[] | undefined) ?? [];
      if (hits.length === 1) sawDepHits = true;
      return { ok: true, data: { indexed: true }, cost: 2 };
    },
  });
  const out3 = await g3.runAll({ round: 1, input: '', deps: {}, runtime: { ticks: [] } });
  check('有依赖工具读取到上游结果', sawDepHits, '');
  check('有副作用(story_index)工具产生结果', out3.story_index?.data.indexed === true, JSON.stringify(out3));

  // ---- 场景4：环检测 ----
  const g4 = new ToolDag<TickCtx>();
  g4.define(makeTickTool('x', ['y'])).define(makeTickTool('y', ['x']));
  let cycleCaught = false;
  try { g4.plan(); } catch (e) { cycleCaught = (e as Error).name === 'DagCycleError'; }
  check('依赖环触发 DagCycleError', cycleCaught);

  // ---- 场景5：工具执行抛错不阻断整体（结果标记失败）----
  const g5 = new ToolDag<TickCtx>();
  g5.define({
    name: 'boom', description: 'throws', dependencies: [], deterministic: true, sideEffects: false,
    execute: () => { throw new Error('boom!'); },
  });
  const out5 = await g5.runAll({ round: 1, input: '', deps: {}, runtime: { ticks: [] } });
  check('抛错工具结果 ok=false', out5.boom?.ok === false && out5.boom?.error === 'boom!', JSON.stringify(out5));

  console.log(failures === 0 ? '\n工具 DAG 验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
