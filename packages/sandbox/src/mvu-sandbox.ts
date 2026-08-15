/**
 * sandbox 包 - MVU 沙箱执行器（Phase 3：本地 vendor + 沙箱 + 薄适配层）
 * 目标：在不转译的前提下，于沙箱中运行魔法少女卡的 34.5KB 原引擎（v23.5），行为等价。
 *
 * 安全（审查 §9）：node:vm 沙箱 + 白名单 API——不提供 require/process/Buffer/fetch/XMLHttpRequest/
 * module/exports；console 仅白名单方法；setTimeout 有限；无文件/网络能力。
 * 注：vm 不是强安全边界，本沙箱用于隔离"不可信但属用户自选素材"的脚本，非对抗环境。
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeLodashMock } from './lodash.ts';

export interface MvuSandboxOptions {
  /** 本地 vendor bundle 路径（默认 data/vendor/mvu-bundle.js） */
  bundlePath?: string;
  /** mock 聊天数据（SillyTavern.getContext().chat） */
  chat?: unknown[];
  /** mock 角色数据 */
  character?: Record<string, unknown>;
  /** 引擎脚本超时（ms，同步部分） */
  timeoutMs?: number;
}

export interface MvuSandboxResult {
  mvuLoaded: boolean;
  engineGlobal?: unknown;
  logs: string[];
}

/** 白名单 console mock */
function makeConsole(logs: string[]): Record<string, (...a: unknown[]) => void> {
  const push = (level: string) => (...a: unknown[]) => logs.push(`[${level}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)?.slice(0, 200))).join(' ')}`);
  return { log: push('log'), info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

export class MvuSandbox {
  private context: vm.Context;
  private windowObj: Record<string, unknown>;
  private logs: string[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** 可变 chat 引用：引擎通过 SillyTavern.getContext().chat 读取，桥接器可随时替换内容 */
  private chatRef: unknown[];

  constructor(private opts: MvuSandboxOptions = {}) {
    this.windowObj = {} as Record<string, unknown>;
    this.chatRef = opts.chat ?? [];
    const cons = makeConsole(this.logs);

    // toastr mock（引擎用 window.toastr）
    const toastr = {
      error: (m: unknown) => this.logs.push(`[toastr:error] ${String(m)}`),
      success: (m: unknown) => this.logs.push(`[toastr:success] ${String(m)}`),
      warning: (m: unknown) => this.logs.push(`[toastr:warning] ${String(m)}`),
      info: (m: unknown) => this.logs.push(`[toastr:info] ${String(m)}`),
    };

    // SillyTavern mock 适配层（薄适配；chat 走可变引用）
    const sillyTavern = {
      getContext: () => ({
        chat: this.chatRef,
        character: opts.character ?? { name: 'sandbox' },
        worldInfo: { entries: [] },
        getCharacters: () => [opts.character ?? { name: 'sandbox' }],
      }),
    };

    const sandbox: Record<string, unknown> = {
      window: this.windowObj,
      globalThis: this.windowObj,
      self: this.windowObj,
      top: this.windowObj,
      parent: this.windowObj,
      console: cons,
      toastr,
      SillyTavern: sillyTavern,
      // jQuery mock：引擎用 $(fn) 做 DOM ready 启动、$(window).on 注册卸载钩子
      $: (arg: unknown) => {
        if (typeof arg === 'function') arg();
        return { on: () => ({}), off: () => ({}), append: () => ({}), remove: () => ({}) };
      },
      // 白名单标准对象
      Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Symbol, BigInt,
      Error, TypeError, RangeError, NaN, Infinity, undefined,
      // 有限定时器（引擎 init 重试用）
      setTimeout: (fn: () => void, ms: number) => {
        const id = setTimeout(() => { this.timers.delete(id); try { fn(); } catch (e) { this.logs.push(`[timer:error] ${(e as Error).message}`); } }, ms);
        this.timers.add(id);
        return id;
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); this.timers.delete(id); },
    };
    this.windowObj.toastr = toastr;
    this.windowObj.SillyTavern = sillyTavern;

    this.context = vm.createContext(sandbox);
  }

  /** 安装 Mvu 兼容 mock（bundle 为 ESM+酒馆 UI 依赖，沙箱不跑；用事件系统替代核心接口） */
  installMvuMock(extra?: Record<string, unknown>): void {
    const listeners = new Map<string, ((data?: unknown) => void)[]>();
    const on = (event: string, fn: (data?: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      this.logs.push(`[mvu:on] ${event}`);
    };
    const emit = (event: string, data?: unknown) => {
      for (const fn of listeners.get(event) ?? []) {
        try { fn(data); } catch (e) { this.logs.push(`[mvu:emit:error] ${(e as Error).message}`); }
      }
      this.logs.push(`[mvu:emit] ${event}`);
    };
    const mvu = {
      events: { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED' },
      on,
      emit,
      get: (name: string) => undefined,
      set: (name: string, value: unknown) => { this.logs.push(`[mvu:set] ${name}=${String(value).slice(0, 40)}`); },
      ...extra,
    };
    this.windowObj.Mvu = mvu;
    this.windowObj.mvu = mvu;
    // 酒馆全局 API：eventOn（引擎 init 调用）
    (this.context as Record<string, unknown>).eventOn = (event: string, fn: (data?: unknown) => void) => {
      this.logs.push(`[eventOn] ${event}`);
      on(event, fn);
    };
    (this.context as Record<string, unknown>).eventEmit = emit;
    (this as unknown as { _mvuEmit: (e: string, d?: unknown) => void })._mvuEmit = emit;
  }

  /** 触发 Mvu 事件（外部驱动引擎 tick） */
  emitMvuEvent(event: string, data?: unknown): void {
    const mvu = this.windowObj.Mvu as { emit?: (e: string, d?: unknown) => void };
    mvu?.emit?.(event, data);
  }

  /** 替换引擎可见的聊天上下文（引擎读 SillyTavern.getContext().chat 判定 AI/用户回合） */
  setChat(chat: unknown[]): void {
    this.chatRef.length = 0;
    this.chatRef.push(...chat);
  }

  /** 向沙箱全局注入白名单对象（如 lodash `_`） */
  injectGlobal(name: string, value: unknown): void {
    (this.context as Record<string, unknown>)[name] = value;
    this.windowObj[name] = value;
  }

  /** 安装 lodash 白名单子集 `_`（引擎硬依赖） */
  installLodash(): void {
    this.injectGlobal('_', makeLodashMock());
  }

  /** 加载本地 vendor bundle（MagVarUpdate）
   *  注意：bundle 为 ESM + 酒馆 UI 依赖（Vue/jQuery/tavern_events/远程 import），沙箱无法直接运行；
   *  实际迁移使用 installMvuMock() 提供兼容接口，此方法保留用于分析/未来改造。 */
  loadBundle(): void {
    const path = this.opts.bundlePath ?? resolve('data', 'vendor', 'mvu-bundle.js');
    if (!existsSync(path)) throw new Error(`vendor bundle 不存在: ${path}（先运行 tools/cli/vendor-mvu.ts 下载）`);
    const src = readFileSync(path, 'utf8');
    if (/^\s*import\b/.test(src)) {
      this.logs.push('[bundle] ESM 格式，沙箱跳过（使用 Mvu mock 替代）');
      return;
    }
    this.run(src, 'mvu-bundle.js');
  }

  /** 运行引擎脚本（同步 IIFE；异步 init 由 mock setTimeout 驱动） */
  run(src: string, name = 'script.js'): unknown {
    return vm.runInContext(src, this.context, { filename: name, timeout: this.opts.timeoutMs ?? 5000 });
  }

  /** 获取 window.Mvu（MagVarUpdate 框架入口） */
  getMvu(): unknown {
    return this.windowObj.Mvu;
  }

  /** 沙箱内执行表达式 */
  evalInSandbox(expr: string): unknown {
    return vm.runInContext(expr, this.context);
  }

  /** 等待引擎异步初始化完成（轮询 Mvu 出现） */
  async waitForMvu(timeoutMs = 5000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.getMvu()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** 清理定时器（防泄漏） */
  dispose(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  getLogs(): string[] {
    return this.logs;
  }
}

/** 从角色卡提取引擎脚本并运行（端到端便捷函数；用 Mvu mock 替代 bundle） */
export async function runMvuFromCard(
  engineScript: string,
  opts: MvuSandboxOptions = {},
): Promise<{ result: MvuSandboxResult; sandbox: MvuSandbox }> {
  const sb = new MvuSandbox(opts);
  sb.installLodash();
  sb.installMvuMock();
  sb.run(engineScript, 'card-engine.js');
  // 引擎启动：$(fn) 立即执行 → new MagicGirlEngine() → setTimeout(1500) init
  await new Promise((r) => setTimeout(r, 2500));
  const engineGlobal = sb.evalInSandbox('typeof window.MagicGirlEngineInstance !== "undefined" ? "MagicGirlEngineInstance" : null') as unknown;
  return {
    result: {
      mvuLoaded: sb.getMvu() !== undefined,
      engineGlobal,
      logs: sb.getLogs(),
    },
    sandbox: sb,
  };
}
