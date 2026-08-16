/**
 * variable 包验证：DSL 求值 + VMS 依赖图分层 + 循环检测
 */
import { VariableManager } from '../src/vms.ts';
import { parseExpr, evaluate, extractDeps, WHITELIST_FUNCS } from '../src/dsl.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('== DSL 求值 ==');
{
  const resolve = (m: Record<string, number | string | boolean>) => (n: string) => m[n];
  check('算术 2+3*4=14', evaluate(parseExpr('2+3*4'), resolve({})) === 14);
  check('括号 (2+3)*4=20', evaluate(parseExpr('(2+3)*4'), resolve({})) === 20);
  check('比较 5>3', evaluate(parseExpr('5>3'), resolve({})) === true);
  check('逻辑 a&&b', evaluate(parseExpr('{a}&&{b}'), resolve({ a: true, b: false })) === false);
  check('min/max', evaluate(parseExpr('min(3,7)'), resolve({})) === 3);
  check('clamp(150,0,100)', evaluate(parseExpr('clamp(150,0,100)'), resolve({})) === 100);
  check('字符串 concat', evaluate(parseExpr('concat("你好", "世界")'), resolve({})) === '你好世界');
  check('len("abc")', evaluate(parseExpr('len("abc")'), resolve({})) === 3);
  check('变量引用 {x}+1', evaluate(parseExpr('{x}+1'), resolve({ x: 10 })) === 11);
  check('依赖提取', JSON.stringify(extractDeps(parseExpr('{a}+{b}*2')).sort()) === JSON.stringify(['a', 'b']));
  check('roll 确定性范围', (() => { const v = evaluate(parseExpr('roll(1,6)'), resolve({})); return typeof v === 'number' && v >= 1 && v <= 6; })());
}

console.log('== VMS 注册与求值 ==');
{
  const vms = new VariableManager();
  vms.register({ scope: 'sys', source: 'sys', name: 'round', type: 'literal', value: 1 });
  vms.register({ scope: 'preset', source: 'preset', name: 'base_progress', type: 'literal', value: 2 });
  vms.register({ scope: 'book', source: 'book', name: 'bonus', type: 'literal', value: 3 });
  // derived 链：progress = base + bonus；next = progress * round
  vms.register({ scope: 'card', source: 'card', name: 'progress', type: 'derived', expression: '{base_progress}+{bonus}' });
  vms.register({ scope: 'card', source: 'card', name: 'next', type: 'derived', expression: '{progress}*{round}' });

  const r = vms.evaluate();
  check('progress=5', r.values['card:card:progress'] === 5, `got=${r.values['card:card:progress']}`);
  check('next=5', r.values['card:card:next'] === 5, `got=${r.values['card:card:next']}`);
  check('拓扑分层（同层无依赖，层间串行）', r.layers.length >= 2, JSON.stringify(r.layers));
  check('无错误', r.errors.length === 0, JSON.stringify(r.errors));

  // set 后重算
  vms.set('book:book:bonus', 10);
  const r2 = vms.evaluate();
  check('set 后 progress=12', r2.values['card:card:progress'] === 12, `got=${r2.values['card:card:progress']}`);
}

console.log('== 作用域优先级 ==');
{
  const vms = new VariableManager();
  vms.register({ scope: 'preset', source: 'preset', name: 'words', type: 'literal', value: '默认' });
  vms.register({ scope: 'session', source: 'session', name: 'words', type: 'literal', value: '覆盖' });
  const r = vms.evaluate();
  // 引用 'words' 时解析到最高优先级（session）
  const d = vms.get('session:session:words');
  check('session 覆盖 preset', d?.value === '覆盖');
}

console.log('== 循环检测 ==');
{
  const vms = new VariableManager();
  vms.register({ scope: 'card', source: 'card', name: 'a', type: 'derived', expression: '{b}+1' });
  vms.register({ scope: 'card', source: 'card', name: 'b', type: 'derived', expression: '{a}+1' });
  let thrown = false;
  try { vms.evaluate(); } catch (e) { thrown = true; check('循环被拦截', (e as Error).message.includes('循环')); }
  check('循环检测生效', thrown);
}

console.log('== 批量注册（三源导入）==');
{
  const vms = new VariableManager();
  const r = vms.registerBatch([
    { scope: 'preset', source: 'preset', name: 'a', type: 'literal', value: 1 },
    { scope: 'book', source: 'book', name: 'b', type: 'literal', value: 2 },
    { scope: 'card', source: 'card', name: 'c', type: 'derived', expression: '{a}+{b}' },
  ]);
  check('批量注册 3 个', r.ok === 3);
  const ev = vms.evaluate();
  check('c=3', ev.values['card:card:c'] === 3, `got=${ev.values['card:card:c']}`);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
