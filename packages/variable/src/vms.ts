/**
 * variable 包 - 变量管理服务 VMS（06 设计 Phase 1）
 * 三源统一命名空间（scope:source:name）+ 依赖图 + 分层调度 + 循环检测 + 持久化。
 *
 * 命名空间：<scope>:<source>:<name>
 *   scope:  session > scene > card > book > preset > sys（覆盖优先级）
 *   source: preset | card | book | sys | session | scene | round
 */
import { parseExpr, evaluate, extractDeps } from './dsl.ts';
import type { AstNode, VarValue } from './dsl.ts';

export const SCOPE_RANK: Record<string, number> = { sys: 0, preset: 1, book: 2, card: 3, scene: 4, session: 5 };

export interface VarDecl {
  /** 完整名：scope:source:name */
  fullName: string;
  scope: string;
  source: string;
  name: string;
  /** literal 或 derived */
  type: 'literal' | 'derived';
  /** literal 的值或 derived 的表达式 */
  value?: VarValue;
  expression?: string;
  ast?: AstNode;
  deps: string[];
}

export interface RegisterInput {
  scope: string;
  source: string;
  name: string;
  type: 'literal' | 'derived';
  value?: VarValue;
  expression?: string;
}

export interface EvalResult {
  values: Record<string, VarValue>;
  /** 分层结果：[[varA, varB], [varC]]（同层无依赖） */
  layers: string[][];
  /** 求值失败项 */
  errors: { name: string; message: string }[];
  elapsedMs: number;
}

export class VariableManager {
  /** 裸名 → 全局最高优先级 fullName（注册期维护，求值期 O(1) 查表，避免 O(N) 扫描） */
  private nameIndex = new Map<string, string>();
  private decls = new Map<string, VarDecl>();

  /** 注册变量（derived 需解析表达式 + 提取依赖） */
  register(input: RegisterInput): void {
    const fullName = `${input.scope}:${input.source}:${input.name}`;
    const decl: VarDecl = {
      fullName, scope: input.scope, source: input.source, name: input.name,
      type: input.type, value: input.type === 'literal' ? input.value : undefined,
      expression: input.type === 'derived' ? input.expression : undefined,
      deps: [],
    };
    if (input.type === 'derived') {
      if (!input.expression) throw new Error(`derived 变量缺少表达式: ${fullName}`);
      decl.ast = parseExpr(input.expression);
      decl.deps = extractDeps(decl.ast).map((d) => this.resolveRef(fullName, d));
    }
    this.decls.set(fullName, decl);
    this.indexName(decl, fullName);
  }

  private indexName(decl: VarDecl, fullName: string): void {
    if (decl.name.includes(':')) return;
    const prev = this.nameIndex.get(decl.name);
    if (!prev || SCOPE_RANK[decl.scope] > SCOPE_RANK[prev.split(':')[0]]) {
      this.nameIndex.set(decl.name, fullName);
    }
  }

  /** 批量注册（三源导入） */
  registerBatch(inputs: RegisterInput[]): { ok: number; conflicts: { name: string; reason: string }[] } {
    const conflicts: { name: string; reason: string }[] = [];
    let ok = 0;
    for (const inp of inputs) {
      const full = `${inp.scope}:${inp.source}:${inp.name}`;
      const existing = this.decls.get(full);
      if (existing) {
        // 同 scope:source:name 重复注册 → 覆盖（幂等），跨 scope 冲突由 scope 优先级裁决
        if (inp.scope !== existing.scope) {
          conflicts.push({ name: full, reason: `跨 scope 重复（${existing.scope} vs ${inp.scope}），高优先级覆盖` });
        }
      }
      this.register(inp);
      ok++;
    }
    return { ok, conflicts };
  }

  /** 解析引用：优先当前声明所在 scope 的同名变量，否则裸名走全局最高优先级（nameIndex 查表） */
  private resolveRef(fromFull: string, refName: string): string {
    // refName 可能是完整名（含 :）
    if (refName.includes(':')) return refName;
    const [fromScope, fromSource] = fromFull.split(':');
    // 同 source 同名（变量常在同源内互相引用）
    const sameSource = `${fromScope}:${fromSource}:${refName}`;
    if (this.decls.has(sameSource)) return sameSource;
    return this.nameIndex.get(refName) ?? sameSource; // 未找到也返回预期名（求值时报未定义）
  }

  /** 获取变量（未求值的声明访问 value 字段） */
  get(fullName: string): VarDecl | undefined {
    return this.decls.get(fullName);
  }

  /** 裸名 → 最高优先级 fullName（规则执行器等以裸名引用的入口；未索引返回 undefined） */
  unregister(fullName: string): boolean {
    const decl = this.decls.get(fullName);
    if (!decl) return false;
    this.decls.delete(fullName);
    this.rebuildNameIndex();
    return true;
  }

  unregisterBySource(scope: string, source: string): number {
    let removed = 0;
    for (const fullName of [...this.decls.keys()]) {
      const decl = this.decls.get(fullName);
      if (decl?.scope === scope && decl.source === source) {
        this.decls.delete(fullName);
        removed++;
      }
    }
    if (removed > 0) this.rebuildNameIndex();
    return removed;
  }

  private rebuildNameIndex(): void {
    this.nameIndex.clear();
    for (const decl of this.decls.values()) this.indexName(decl, decl.fullName);
  }

  resolveBare(name: string): string | undefined {
    return this.nameIndex.get(name);
  }

  /** 设置 literal 值（触发版本号递增；derived 不可直接 set） */
  set(fullName: string, value: VarValue): void {
    const d = this.decls.get(fullName);
    if (!d) throw new Error(`变量未注册: ${fullName}`);
    if (d.type === 'derived') throw new Error(`derived 变量不可直接赋值: ${fullName}`);
    d.value = value;
  }

  /** 列出全部变量 */
  list(): VarDecl[] {
    return [...this.decls.values()];
  }

  /**
   * 求值：拓扑分层 + 逐层求值（层间串行，同层无依赖；循环检测失败抛错）
   * 返回 values 与 layers（分层可视化）
   */
  evaluate(targets?: string[]): EvalResult {
    const t0 = Date.now();
    const names = targets?.length ? targets : [...this.decls.keys()];
    const values: Record<string, VarValue> = {};
    const errors: EvalResult['errors'] = [];

    // 1. 依赖图 + Kahn 拓扑分层（含循环检测）
    const inDeg = new Map<string, number>();
    const edges = new Map<string, string[]>();
    for (const n of names) {
      const d = this.decls.get(n);
      if (!d) continue;
      inDeg.set(n, 0);
      edges.set(n, []);
    }
    for (const n of names) {
      const d = this.decls.get(n);
      if (!d || d.type !== 'derived') continue;
      for (const dep of d.deps) {
        if (names.includes(dep) && this.decls.has(dep)) {
          edges.get(dep)!.push(n);
          inDeg.set(n, (inDeg.get(n) ?? 0) + 1);
        }
      }
    }
    const queue: string[] = [];
    for (const [n, deg] of inDeg) if (deg === 0) queue.push(n);

    const layers: string[][] = [];
    const ordered: string[] = [];
    let remaining = queue.length;
    while (queue.length > 0) {
      const layer: string[] = [];
      const q = [...queue];
      queue.length = 0;
      for (const n of q) {
        layer.push(n);
        ordered.push(n);
        for (const next of edges.get(n) ?? []) {
          const nd = (inDeg.get(next) ?? 1) - 1;
          inDeg.set(next, nd);
          if (nd === 0) queue.push(next);
        }
      }
      layers.push(layer);
    }
    const unresolved = names.filter((n) => !ordered.includes(n) && this.decls.has(n));
    if (unresolved.length > 0) {
      throw new Error(`变量依赖存在循环: ${unresolved.join(', ')}`);
    }

    // 2. 逐层求值（层间串行 barrier；当前同层亦串行——DSL 为纯计算且规模小，
    //    worker 并行收益为负，保留 worker 化扩展点）
    for (const layer of layers) {
      for (const n of layer) {
        const d = this.decls.get(n)!;
        try {
          if (d.type === 'literal') {
            values[n] = d.value ?? '';
          } else {
            values[n] = evaluate(d.ast!, (ref) => {
              const target = this.resolveRef(n, ref);
              const resolved = names.includes(target) ? values[target] : this.get(target)?.value;
              return resolved;
            });
          }
        } catch (e) {
          errors.push({ name: n, message: (e as Error).message });
          values[n] = '';
        }
      }
    }

    // 3. 求值完成（持久化为调用方显式步骤，不由 evaluate 副作用触发）
    return { values, layers, errors, elapsedMs: Date.now() - t0 };
  }
}
