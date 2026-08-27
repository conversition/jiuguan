/**
 * core 包 - 工具 DAG 平台化执行器（0.5.0 C）
 * 收编平台预计算步骤为声明式工具（ToolDefinition），由 DAG 依赖拓扑（Kahn）驱动：
 *   无依赖 → 并行层；有依赖 → 分层串行；结果统一写入 tool_results 命名空间。
 * 不把工具选择权交给模型（延续铁律：每回合 1 次模型往返），执行仍全部在平台侧。
 * 参考：v0.3 上下文调度器（priority/gate） + v2 方案 VMS 拓扑思想。
 *
 * 用法：
 *   const dag = new ToolDag(ctx);
 *   dag.define(recallTool).define(worldbookTool).define(varTool).define(indexTool);
 *   const out = await dag.runAll();            // 自动拓扑分层 + 并行执行
 *   dag.results('recall_memory').hits;         // 统一命名空间读取
 */
import type { ZodType } from 'zod';

/** 工具输入的派生上下文：继承上游工具结果（依赖指向其 name）+ 回合焦点 */
export interface ToolContext {
  round: number;
  input: string;
  /** 上游依赖工具的输出（按工具名索引；本工具可直接读取） */
  deps: Record<string, ToolResult>;
  /** 运行时扩展（平台注入：检索器/扫描器/VMS 等只读句柄） */
  runtime: Record<string, unknown>;
}

/** 工具执行结果（统一写入 tool_results 命名空间） */
export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
  cost?: number;
  error?: string;
}

/** 工具定义：声明式描述 + 依赖 + 确定性标记 + 执行闭包 */
export interface ToolDefinition<Ctx extends ToolContext = ToolContext> {
  /** 工具唯一名（结果命名空间键） */
  name: string;
  description: string;
  /** 输入参数 schema（zod 校验，缺省任意） */
  parameters?: ZodType;
  /** 依赖的工具名集合（拓扑排序依据） */
  dependencies?: string[];
  /** 确定性：true = 结果可缓存/可重复，false = 有副作用（写库/网络） */
  deterministic: boolean;
  /** 是否有外部副作用（写 DB / 调用 API），影响事件循环并行安全 */
  sideEffects: boolean;
  /** 执行返回结果（写入 tool_results），返回 null 表示本工具本轮无产出 */
  execute(ctx: Ctx, args: Record<string, unknown>): Promise<ToolResult | null> | (ToolResult | null);
}

/** DAG 拓扑排序失败（环引用） */
export class DagCycleError extends Error {
  constructor(names: string[]) {
    super(`工具 DAG 存在环: ${names.join(' -> ')}`);
    this.name = 'DagCycleError';
  }
}

export class ToolDag<Ctx extends ToolContext = ToolContext> {
  private defs = new Map<string, ToolDefinition<Ctx>>();
  private resultsStore = new Map<string, ToolResult>();
  private executionOrder: string[] = [];

  define(def: ToolDefinition<Ctx>): this {
    this.defs.set(def.name, def);
    return this;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  /** 拓扑排序（Kahn）：返回按依赖分层的执行顺序（每层内部可并行） */
  plan(): string[][] {
    const indeg = new Map<string, number>();
    for (const name of this.defs.keys()) indeg.set(name, 0);
    // 缺省允许无工具（空 DAG）
    for (const [name, def] of this.defs) {
      for (const dep of def.dependencies ?? []) {
        if (dep === name) throw new Error(`工具 ${name} 依赖自身`);
        if (!this.defs.has(dep)) continue; // 可选上游：忽略未注册依赖
        indeg.set(name, (indeg.get(name) ?? 0) + 1);
      }
    }
    const layers: string[][] = [];
    const ready: string[] = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n);
    const visited = new Set<string>();
    while (ready.length) {
      const layer = [...ready];
      layers.push(layer);
      for (const name of layer) {
        visited.add(name);
        ready.splice(ready.indexOf(name), 1); // 本层消费
        for (const [other, def] of this.defs) {
          if ((def.dependencies ?? []).includes(name)) {
            const nd = (indeg.get(other) ?? 0) - 1;
            indeg.set(other, nd);
            if (nd === 0 && !visited.has(other)) ready.push(other);
          }
        }
      }
    }
    if (visited.size !== this.defs.size) {
      const cyclic = [...this.defs.keys()].filter((n) => !visited.has(n));
      throw new DagCycleError(cyclic);
    }
    return layers;
  }

  /** 当前工具的执行层序（plan 后缓存；供日志/审计） */
  order(): string[] {
    return this.executionOrder;
  }

  /** 读取某工具结果（统一命名空间） */
  results(name: string): ToolResult | undefined {
    return this.resultsStore.get(name);
  }

  /** 已注册工具名列表 */
  names(): string[] {
    return [...this.defs.keys()];
  }

  /** 执行全部：按拓扑分层，层内并行（无依赖工具并发），层间串行；每工具结果写入命名空间 */
  async runAll(ctx: Ctx): Promise<Record<string, ToolResult>> {
    const layers = this.plan();
    this.executionOrder = layers.flat();
    // 结果跨层累积：上游层结果供下游依赖读取（不随层 clear）
    for (const layer of layers) {
      const tasks = layer.map((name) => this.runOne(name, ctx));
      await Promise.all(tasks);
    }
    // 组装最终命名空间（含所有已产出）
    const out: Record<string, ToolResult> = {};
    for (const name of this.executionOrder) {
      const r = this.resultsStore.get(name);
      if (r) out[name] = r;
    }
    return out;
  }

  private async runOne(name: string, ctx: Ctx): Promise<void> {
    const def = this.defs.get(name)!;
    // 组装本工具上下文：deps = 上游工具结果
    const depResults: Record<string, ToolResult> = {};
    for (const dep of def.dependencies ?? []) {
      const r = this.resultsStore.get(dep) ?? ctx.deps[dep];
      if (r) depResults[dep] = r;
    }
    const self = this;
    const toolCtx = { ...ctx, deps: depResults } as Ctx;
    try {
      const raw = (def.parameters ? def.parameters.parse({}) : {}) as Record<string, unknown>;
      const res = await def.execute(toolCtx, raw);
      if (res) self.resultsStore.set(name, res);
    } catch (e) {
      // 失败必须留痕：静默吞掉会让上游把 {ok:false,data:{}} 读成「0 命中」，与真空结果无法区分
      console.warn(`[DAG] 工具 ${name} 失败: ${(e as Error).message}`);
      self.resultsStore.set(name, { ok: false, data: {}, cost: 0, error: (e as Error).message });
    }
  }
}
