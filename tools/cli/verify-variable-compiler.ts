/**
 * 验证脚本：变量编译调度器（状态机 Idle→Active/Fallback + 缓存命中 + 校验拒绝）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-variable-compiler.ts
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VariableCompiler, detectCardSource, hashCard } from '../../packages/variable/src/compiler.ts';
import type { CardVariableSpec, CompileFn } from '../../packages/variable/src/compiler.ts';
import { validateManifest } from '../../packages/variable/src/manifest.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const SPEC: CardVariableSpec = {
  cardId: 'tavern-girl',
  cardText: '当玩家送礼物时，好感+1；当谎言被识破时，信任-2。',
};

const GOOD_MANIFEST = {
  version: 1, cardId: 'tavern-girl', source: 'nl' as const,
  vars: [
    { name: 'affection', type: 'number' as const, default: 0 },
    { name: 'trust', type: 'number' as const, default: 5 },
  ],
  rules: [
    { trigger: 'contains({event_user_input}, "礼物")', action: 'affection = {affection} + 1', requires_ai: false },
    { trigger: 'contains({event_user_input}, "说谎")', action: 'trust = max(0, {trust} - 2)', requires_ai: false },
  ],
  cardHash: '',
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'jg-var-'));
  // ---- 场景1：compileFn 返回合法 manifest → Idle→Active，缓存落盘 ----
  let calls1 = 0;
  const c1 = new VariableCompiler('tavern-girl', dir, (async (spec, err) => { calls1++; return GOOD_MANIFEST; }) as CompileFn);
  const r1 = await c1.compile(SPEC);
  check('场景1 状态 Active', r1.state === 'active' && c1.stateOf() === 'active', `state=${r1.state}`);
  check('场景1 未命中缓存（首编）', r1.cacheHit === false, `cacheHit=${r1.cacheHit}`);
  check('场景1 产物可读取', c1.getManifest()?.rules.length === 2, `rules=${c1.getManifest()?.rules.length}`);
  check('场景1 仅调 1 次编译', calls1 === 1, `calls=${calls1}`);
  check('场景1 缓存已落盘', existsSync(join(dir, 'tavern-girl.json')), join(dir, 'tavern-girl.json'));

  // ---- 场景2：compileFn 恒返回坏产物 → 重试 2 次 → Fallback ----
  const bad: CompileFn = async () => ({ ...GOOD_MANIFEST, vars: [{ name: '1bad', type: 'number' }] });
  const c2 = new VariableCompiler('tavern-bad', dir, bad);
  const r2 = await c2.compile({ ...SPEC, cardId: 'tavern-bad' });
  check('场景2 两次失败进入 Fallback', r2.state === 'fallback' && c2.stateOf() === 'fallback', `state=${r2.state}`);
  check('场景2 attempts = 上限', c2.attemptsCount() === 2, `attempts=${c2.attemptsCount()}`);
  check('场景2 无产物', c2.getManifest() === null, 'manifest 应为 null');

  // ---- 场景3：同 cardId + 同文本 → 二次实例缓存命中，不调 compileFn ----
  let calls3 = 0;
  const c3 = new VariableCompiler('tavern-girl', dir, (async () => { calls3++; return GOOD_MANIFEST; }) as CompileFn);
  const r3 = await c3.compile(SPEC);
  check('场景3 缓存命中 Active', r3.cacheHit === true && r3.state === 'active', `cacheHit=${r3.cacheHit}`);
  check('场景3 二次加载未调 compileFn', calls3 === 0, `calls=${calls3}`);
  // 内容变更 → invalidate → 重编（不命中缓存）
  c3.invalidate();
  const r3b = await c3.compile({ ...SPEC, cardText: SPEC.cardText + '（新增一条规则）' });
  check('场景3 invalidate 后重编（非缓存）', r3b.cacheHit === false, `cacheHit=${r3b.cacheHit}`);

  // ---- 场景4：validateManifest 拒绝（坏变量名 / 未声明左值） ----
  const deps = { parseExpr: () => ({}) };
  const v1 = validateManifest({ ...GOOD_MANIFEST, vars: [{ name: '1bad', type: 'number' }] }, deps);
  check('场景4 坏变量名拒绝', !v1.ok, JSON.stringify(v1));
  const v2 = validateManifest({ ...GOOD_MANIFEST, rules: [{ trigger: 'true', action: 'ghost = 1' }] }, deps);
  check('场景4 未声明左值拒绝', !v2.ok, JSON.stringify(v2));

  // ---- 场景5：detectCardSource 类型判定 + hash 稳定性 ----
  check('场景5 mvu 判定', detectCardSource({ cardId: 'x', cardText: '', engineScript: 'x'.repeat(11 * 1024) }) === 'mvu', '');
  check('场景5 结构化判定', detectCardSource({ cardId: 'x', cardText: '', structured: [{ name: 'a', type: 'number' }] }) === 'structured', '');
  check('场景5 nl 判定', detectCardSource({ cardId: 'x', cardText: '当玩家送礼物时，好感+1' }) === 'nl', '');
  check('场景5 none 判定', detectCardSource({ cardId: 'x', cardText: '一段普通描述' }) === 'none', '');
  check('场景5 hash 稳定', hashCard('ab') === hashCard('ab') && hashCard('ab') !== hashCard('ac'), '');

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(failures === 0 ? '\n变量编译验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();