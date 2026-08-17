/**
 * 验证脚本：L1 上下文 provider 生命周期（Cordis 底座）
 * 场景切换干净撤销 / consumer 先退 / 逆操作 LIFO / build 异常回滚
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-context-lifecycle.ts
 */
import { ContextProviderRuntime } from '../../packages/prompt/src/context-provider-runtime.ts';
import type { TurnFocus, ContextProviderFiber, ProvideMap } from '../../packages/prompt/src/context-provider-runtime.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const focusFor = (scene: string, round = 1): TurnFocus => ({
  round, scene, present: scene === 'tavern' ? ['酒保', '旅人'] : ['王宫大臣'], bars: { main: 1 }, input: '继续',
});

function main() {
  // ---- 场景1：依赖满足驱动激活 + 场景切换干净撤销 ----
  const rt = new ContextProviderRuntime();
  const events: string[] = [];
  const mark = (e: string) => () => { events.push(e); };
  // 场景块：仅在 tavern 激活，provide scene
  const sceneFib: ContextProviderFiber = {
    id: 'scene:tavern',
    provide: { scene: true },
    deps: (f) => f.scene === 'tavern',
    build: (f, _p, accum) => {
      accum.effect(mark('inv:scene:setup'));
      events.push('build:scene');
      return '[场景酒馆] 昏黄灯火，吧台后酒保擦杯';
    },
    teardown: mark('teardown:scene'),
  };
  // 依序块：inject scene → 依赖场景存在才激活
  const tavernBlock: ContextProviderFiber = {
    id: 'tavern-entrylist',
    inject: ['scene'],
    build: (_f, _p, accum) => {
      accum.effect(mark('inv:entries:close'));
      events.push('build:entries');
      return '[酒馆条目] 麦酒·奶酪·醉汉桌';
    },
    teardown: mark('teardown:entries'),
  };
  rt.register(sceneFib);
  rt.register(tavernBlock);

  rt.beginTurn(focusFor('tavern'));
  check('场景1 tavern 激活', rt.activeIds().includes('scene:tavern') && rt.activeIds().includes('tavern-entrylist'),
    `active=${JSON.stringify(rt.activeIds())}`);
  check('场景1 片段产对齐', rt.activeFragments().length === 2, `got ${rt.activeFragments().length}`);

  // 切场景 → scene 块不再满足 → 二者撤销，consumer 先退（events 顺序）
  events.length = 0;
  rt.beginTurn(focusFor('palace'));
  check('场景1 切换后全部撤销', rt.activeIds().length === 0, `active=${JSON.stringify(rt.activeIds())}`);
  const seq = events.join(',');
  check('场景1 consumer(entries) 先退再 provider(scene)', seq.indexOf('inv:entries:close') < seq.indexOf('inv:scene:setup')
    && seq.indexOf('teardown:entries') < seq.indexOf('teardown:scene'), `seq=${seq}`);
  check('场景1 无残留片段', rt.activeFragments().length === 0 && !rt.provides().scene, `provides=${JSON.stringify(rt.provides())}`);

  // 切回 tavern → 重新激活
  rt.beginTurn(focusFor('tavern'));
  check('场景1 切回重激活', rt.activeIds().length === 2, `active=${JSON.stringify(rt.activeIds())}`);

  // ---- 场景2：同场景内逐步骤逆操作 LIFO（unregister 触发撤销） ----
  const rt2 = new ContextProviderRuntime();
  const order2: string[] = [];
  const mark2 = (e: string) => () => { order2.push(e); };
  rt2.register({
    id: 'multi-effect',
    build: (_f, _p, accum) => {
      accum.effect(mark2('inv1'));
      accum.effect(mark2('inv2'));
      return '两步骤初始化';
    },
  } as ContextProviderFiber);
  rt2.beginTurn(focusFor('tavern'));
  rt2.unregister('multi-effect');
  check('场景2 逆操作 LIFO（inv2 先于 inv1）', order2.join(',') === 'inv2,inv1', `order=${order2.join(',')}`);

  // ---- 场景3：build 抛错 → 已累积逆操作逆序回滚 + 状态 inactive ----
  const rt3 = new ContextProviderRuntime();
  const rolled: string[] = [];
  const mark3 = (e: string) => () => { rolled.push(e); };
  rt3.register({
    id: 'explode',
    deps: (f) => f.scene === 'tavern',
    build: (_f, _p, accum) => {
      accum.effect(mark3('r2'));
      accum.effect(mark3('r1'));
      throw new Error('初始化到一半失败');
    },
  } as ContextProviderFiber);
  let threw = false;
  try { rt3.beginTurn(focusFor('tavern')); } catch { threw = true; }
  check('场景3 build 异常上抛', threw);
  check('场景3 已累积逆操作逆序回滚', rolled.join(',') === 'r1,r2', `rolled=${rolled.join(',')}`);
  check('场景3 状态回 inactive 无片段', rt3.activeIds().length === 0 && rt3.activeFragments().length === 0, `active=${JSON.stringify(rt3.activeIds())}`);

  // ---- 场景4：一个 provider 提供多键，多个 consumer 全部先退 ----
  const rt4 = new ContextProviderRuntime();
  const events4: string[] = [];
  const mark4 = (e: string) => () => { events4.push(e); };
  const mk = (id: string, inject: string[]): ContextProviderFiber => ({
    id, inject,
    build: (f, _p, accum) => {
      accum.effect(mark4(`inv:${id}`));
      return `${id}:${f.scene}`;
    },
    teardown: mark4(`teardown:${id}`),
  });
  rt4.register({
    id: 'core', provide: { a: 1, b: 2 }, deps: (f) => f.scene === 'tavern',
    build: () => 'core', teardown: mark4('teardown:core'),
  });
  rt4.register(mk('consumer-a', ['a']));
  rt4.register(mk('consumer-b', ['b']));
  rt4.beginTurn(focusFor('tavern'));
  check('场景4 全激活', rt4.activeIds().length === 3, `active=${JSON.stringify(rt4.activeIds())}`);
  events4.length = 0;
  rt4.beginTurn(focusFor('palace'));
  const seq4 = events4.join(',');
  check('场景4 两 consumer 先退再 provider', seq4.indexOf('teardown:consumer-a') < seq4.indexOf('teardown:core')
    && seq4.indexOf('teardown:consumer-b') < seq4.indexOf('teardown:core'), `seq=${seq4}`);

  console.log(failures === 0 ? '\n上下文生命周期验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();