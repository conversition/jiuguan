/**
 * variable 包 - 确定性规则执行器（运行期，零 token）
 *
 * 把 VariableManifest.rules（trigger 布尔表达式 + action 赋值）翻译为对 VMS 的确定性更新。
 *  - trigger：DSL 表达式，可引用 `{event_<key>}`（回合事件）与变量名（VMS 当前值）
 *  - action：`lhs = rhs`，rhs 走 DSL 求值，结果 vms.set(lhs, value)
 *  - 返回变化集 RuleEffect[]（old→new），供紧凑注入（只注入变化变量）
 *  - 步数上限 MAX_RULES_STEPS 防异常；单规则抛错 → 跳过 + 记录，不阻断回合
 */
import { parseExpr, evaluate } from './dsl.ts';
import type { VarValue } from './dsl.ts';
import type { VariableManager } from './vms.ts';
import type { VariableManifestRule } from './manifest.ts';

export interface RuleEffect {
  /** 变量名（lhs） */
  name: string;
  old: VarValue;
  new: VarValue;
}

export interface RuleRunResult {
  /** 本轮实际变化（旧值≠新值） */
  effects: RuleEffect[];
  /** 触发但被跳过的规则（异常） */
  errors: { rule: string; message: string }[];
  steps: number;
}

/** 每轮规则执行步数上限（防异常死循环） */
export const MAX_RULES_STEPS = 64;

/** 变量全名 → 裸名（去 scope:source: 前缀；紧凑注入显示用） */
export function bareVarName(full: string): string {
  const i = full.lastIndexOf(':');
  return i > 0 ? full.slice(i + 1) : full;
}

/** 变化集 → 紧凑注入段（只含变化的变量）：`变量: 好感度=7; 地点=酒馆`；无变化返回空串 */
export function formatVarDelta(effects: RuleEffect[]): string {
  if (effects.length === 0) return '';
  return effects.map((e) => `${bareVarName(e.name)}=${e.new}`).join('; ');
}

/**
 * 执行规则集：对 events 顺序跑每条的 trigger/action；返回变化集。
 * 事件键以 `{event_<key>}` 引用（DSL ident 不支持点号，故用下划线）。
 */
export function executeRules(rules: VariableManifestRule[], events: Record<string, VarValue>, vms: VariableManager): RuleRunResult {
  const effects: RuleEffect[] = [];
  const errors: { rule: string; message: string }[] = [];
  let steps = 0;

  /** 引用解析：event_* → 回合事件；其余裸名 → VMS 当前值（resolveBare 查全名；derived 求值兜底） */
  const resolve = (ref: string): VarValue => {
    if (ref.startsWith('event_')) return events[ref.slice('event_'.length)] ?? '';
    const full = vms.resolveBare(ref) ?? ref;
    const d = vms.get(full);
    if (!d) return '';
    if (d.type === 'literal') return d.value ?? '';
    if (d.ast) return evaluate(d.ast, resolve);
    return '';
  };

  for (const rule of rules) {
    if (steps >= MAX_RULES_STEPS) { errors.push({ rule: rule.trigger, message: '步数上限触发，中止执行' }); break; }
    steps++;
    let ast;
    try { ast = parseExpr(rule.trigger); } catch (e) { errors.push({ rule: rule.trigger, message: (e as Error).message }); continue; }
    let hit: VarValue;
    try { hit = evaluate(ast, resolve); } catch (e) { errors.push({ rule: rule.trigger, message: (e as Error).message }); continue; }
    const truthy = hit === true || (typeof hit === 'number' && hit !== 0) || (typeof hit === 'string' && hit.length > 0);
    if (!truthy) continue;

    const m = rule.action.match(/^\s*([a-zA-Z0-9_一-鿿]+)\s*=\s*(.+)$/s);
    if (!m) { errors.push({ rule: rule.trigger, message: `action 需为 lhs = rhs 形式: ${rule.action}` }); continue; }
    const [, lhs, rhsExpr] = m;
    const full = vms.resolveBare(lhs) ?? lhs;
    const d = vms.get(full);
    if (!d || d.type === 'derived') { errors.push({ rule: rule.trigger, message: `左值不可赋值（未声明或 derived）: ${lhs}` }); continue; }
    let value: VarValue;
    try {
      value = evaluate(parseExpr(rhsExpr), resolve);
    } catch (e) {
      errors.push({ rule: rule.trigger, message: `action 求值失败: ${rhsExpr}（${(e as Error).message}）` });
      continue;
    }
    const old = d.value ?? '';
    if (old !== value) {
      vms.set(full, value);
      effects.push({ name: full, old, new: value });
    }
  }

  return { effects, errors, steps };
}
