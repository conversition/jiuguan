/**
 * prompt 包 - 上下文提供者生命周期运行时（L1 · Cordis 底座）
 *
 * 把 Cordis 的 coeffect 依赖满足 + revertible effects 迁移到上下文装配层：
 *   - 每个上下文来源（记忆/世界书/长期摘要/世界状态/插件）是一个 provider fiber，
 *     声明 inject（依赖的 provide 键）+ provide（对外提供的服务/数据）+ build（产片段）
 *     + teardown（根逆操作）。
 *   - 每回合 beginTurn(focus) 依依赖求值做激活转换：新满足 → activate（build 产片段 +
 *     注册提供项 + 累积逐步骤逆操作）；不再满足 → deactivate（**consumer 先退、provider 后撤**，
 *     逐步骤逆操作 LIFO 逆序跑，最后根 teardown）——保证上下文干净进出、无残留、不串线。
 *
 * 只解决「哪些进、哪些出、怎么干净出」；成本/优先级/全局预算属 L2 调度层，不在本文件。
 */
export interface TurnFocus {
  /** 当前回合号 */
  round: number;
  /** 当前场景标识（由上轮 plan 的 scene 语境 + 世界书激活集合成） */
  scene: string;
  /** 在场实体（输入 + 上轮 plan 提取） */
  present: string[];
  /** 推进槽（bars） */
  bars: Record<string, number>;
  /** 本轮用户输入全文 */
  input: string;
}

/** 对外提供的服务/数据键值（下游 fiber 的 inject 引用） */
export type ProvideMap = Record<string, unknown>;

/** 激活期收集逆操作的注入面（等价 cordis ctx.effect） */
export interface FiberEffectCtx {
  effect(fn: () => void | Promise<void>): void;
}

/** provider fiber：一个上下文来源的声明 + 生命周期钩子 */
export interface ContextProviderFiber {
  /** 唯一标识（'memory' | 'worldbook' | 'worldstate' | 'scene:<场景>' | 'plugin:<name>' | ...） */
  id: string;
  /** coeffect：依赖的 provide 键（缺一不激活） */
  inject?: string[];
  /** 本块对外提供的服务/数据（激活后并入 provide 上下文，供下游 inject） */
  provide?: ProvideMap;
  /** 附加条件（provide 满足之外的自定义判断，如 bars 阈值/场景匹配） */
  deps?: (focus: TurnFocus, provides: ProvideMap) => boolean;
  /** 激活时产出注入片段（在 build 内调 accum.effect 逐步骤累积逆操作） */
  build(focus: TurnFocus, provides: ProvideMap, accum: FiberEffectCtx): string;
  /** 根逆操作（整体回收，执行于所有逐步骤逆操作之后） */
  teardown?: () => void | Promise<void>;
}

type FiberState = 'inactive' | 'activating' | 'active' | 'deactivating';

/**
 * 上下文 provider 运行时：注册表 + 提供项上下文 + 每回合激活转换。
 * 线程模型：回合串行（beginTurn 同步完成全量转换），无并发。
 */
export class ContextProviderRuntime {
  private fibers = new Map<string, ContextProviderFiber>();
  private states = new Map<string, FiberState>();
  private fragments = new Map<string, string>();
  private activeProvides = new Map<string, unknown>();
  /** 每 fiber 已累积的逐步骤逆操作（LIFO 执行） */
  private inverses = new Map<string, Array<() => void | Promise<void>>>();

  /** 注册 provider fiber（重名抛错） */
  register(fiber: ContextProviderFiber): void {
    if (this.fibers.has(fiber.id)) throw new Error(`重复注册上下文 provider: ${fiber.id}`);
    this.fibers.set(fiber.id, fiber);
    this.states.set(fiber.id, 'inactive');
  }

  unregister(id: string): void {
    if (this.states.get(id) === 'active') this.deactivate(id);
    this.fibers.delete(id);
    this.states.delete(id);
  }

  /** 当前激活 provider id（供 L2 调度取用） */
  activeIds(): string[] {
    return [...this.fibers.values()].filter((f) => this.states.get(f.id) === 'active').map((f) => f.id);
  }

  /** 当前激活块的注入片段（id → 片段） */
  activeFragments(): { id: string; fragment: string }[] {
    return [...this.fragments.entries()].map(([id, fragment]) => ({ id, fragment }));
  }

  /** 已激活块的对外提供项（供依赖求值读取） */
  provides(): ProvideMap {
    return Object.fromEntries(this.activeProvides);
  }

  /** 查看某块激活状态（调试/UI） */
  stateOf(id: string): FiberState | undefined {
    return this.states.get(id);
  }

  /** 回合开始：依 focus 做全量激活转换（先撤销失效，再激活新满足） */
  beginTurn(focus: TurnFocus): void {
    const ids = [...this.fibers.keys()];
    for (const id of ids) {
      if (this.states.get(id) === 'active' && !this.satisfied(this.fibers.get(id)!, focus)) this.deactivate(id);
    }
    for (const id of ids) {
      if (this.states.get(id) === 'inactive' && this.satisfied(this.fibers.get(id)!, focus)) this.activate(id, focus);
    }
  }

  /** 激活某块（幂等；build 异常时逆序回滚已累积逆操作） */
  private activate(id: string, focus: TurnFocus): void {
    const f = this.fibers.get(id);
    if (!f || this.states.get(id) !== 'inactive') return;
    this.states.set(id, 'activating');
    const inv: Array<() => void | Promise<void>> = [];
    const accum: FiberEffectCtx = { effect: (fn) => inv.push(fn) };
    let fragment: string;
    try {
      fragment = f.build(focus, this.provides(), accum);
    } catch (e) {
      for (const fn of [...inv].reverse()) void fn();
      this.states.set(id, 'inactive');
      throw e;
    }
    this.inverses.set(id, inv);
    this.fragments.set(id, fragment);
    for (const [k, v] of Object.entries(f.provide ?? {})) this.activeProvides.set(k, v);
    this.states.set(id, 'active');
  }

  /** 撤销某块：consumer（依赖本块 provide 键）先退、provider 后撤；LIFO 逆操作 → 根 teardown */
  private deactivate(id: string): void {
    const f = this.fibers.get(id);
    if (!f || this.states.get(id) !== 'active') return;
    this.states.set(id, 'deactivating');
    const providedKeys = Object.keys(f.provide ?? {});
    for (const [cid, cf] of this.fibers) {
      const depsOnMe = (cf.inject ?? []).some((k) => providedKeys.includes(k));
      if (depsOnMe && this.states.get(cid) === 'active') this.deactivate(cid);
    }
    this.fragments.delete(id);
    for (const k of providedKeys) this.activeProvides.delete(k);
    for (const fn of [...(this.inverses.get(id) ?? [])].reverse()) void fn();
    void f.teardown?.();
    this.inverses.delete(id);
    this.states.set(id, 'inactive');
  }

  /** 是否满足激活条件：inject 全在提供项 + 自定义 deps 通过 */
  private satisfied(f: ContextProviderFiber, focus: TurnFocus): boolean {
    if (f.inject && !f.inject.every((k) => this.activeProvides.has(k))) return false;
    if (f.deps && !f.deps(focus, this.provides())) return false;
    return true;
  }
}