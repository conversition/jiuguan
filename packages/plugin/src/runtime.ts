/**
 * plugin 包 - 插件运行时（node:vm 沙箱 + 钩子分发）
 * 参考 SillyTavern 扩展 API 的映射：
 *   ST eventSource.on(event, cb)  ↔  hooks[onMessageSend|onProsePostProcess|onSessionStart|...]
 *   ST getContext()               ↔  ctx.session（受限读）
 *   ST extension_settings         ↔  ctx.storage（每插件 JSON 持久化）
 *   ST toastr/console             ↔  ctx.log
 * 安全（同 MVU 沙箱）：无 require/process/fs/网络；仅白名单标准对象 + ctx API。
 * 钩子失败隔离：单插件抛错 → 记录日志并跳过，不阻断回合。
 */
import vm from 'node:vm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginRegistry } from './registry.ts';
import { scanServerSource } from './scan.ts';

/** 钩子载荷与返回约定（04 §4.1）：
 *  onSessionStart({card, resume})                        → 无返回
 *  onMessageSend({userInput, round, mode})               → { promptInject?: string }
 *  onProsePostProcess({prose, turn, round})              → { prose?: string }（链式替换）
 *  onMemoryRecall({query, hits})                         → { hits? }（v1.1 接线）
 *  onSessionEnd()                                        → 无返回 */
export type HookResult = Record<string, unknown> | undefined | null | void;

export interface PluginCtx {
  id: string;
  log(msg: string): void;
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
}

interface LoadedPlugin {
  id: string;
  ctx: PluginCtx;
  hooks: Record<string, (payload: Record<string, unknown>) => unknown>;
}

const PLUGIN_SOURCE_MAX = 200 * 1024; // 单插件服务端源码上限

export class PluginHost {
  private loaded: LoadedPlugin[] = [];
  private started = false;

  constructor(private registry: PluginRegistry) {}

  /** 加载全部启用插件（含服务端入口），触发 onInit 与 onSessionStart 钩子 */
  start(payload: Record<string, unknown> = {}): void {
    if (this.started) return;
    this.started = true;
    let ok = 0;
    for (const rec of this.registry.list()) {
      if (!rec.enabled || !rec.server) continue;
      // DSH 标准包由 DshPluginHost 宿主直跑（server.ts 接线），沙箱不处理
      if (rec.kind === 'dsh') continue;
      const src = this.registry.serverSource(rec.id);
      if (!src) { console.warn(`[插件] ${rec.id} 服务端入口缺失: ${rec.server}`); continue; }
      // 0.5.0 沙箱强化：静态扫描逃逸特征，命中拒载（不执行不可信代码）
      const scan = scanServerSource(src, rec.permissions);
      if (!scan.ok) { console.warn(`[插件] ${rec.id} 拒载：${scan.deny}`); continue; }
      try {
        const ctx = this.makeCtx(rec.id);
        const loaded = loadPluginSandbox(rec.id, src, ctx);
        this.loaded.push({ id: rec.id, ctx, hooks: loaded.hooks });
        if (typeof loaded.plugin.onInit === 'function') loaded.plugin.onInit(ctx);
        ok++;
      } catch (e) {
        console.warn(`[插件] ${rec.id} 加载失败: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (ok > 0) console.log(`[插件] 已加载 ${ok} 个启用插件`);
    this.callHook('onSessionStart', payload);
  }

  /** 分发钩子：按加载顺序调用所有插件的同名钩子，返回非空结果数组 */
  callHook(name: string, payload: Record<string, unknown>): HookResult[] {
    const results: HookResult[] = [];
    for (const p of this.loaded) {
      const fn = p.hooks[name];
      if (typeof fn !== 'function') continue;
      try {
        const r = fn(payload);
        if (r !== undefined && r !== null) results.push(r as HookResult);
      } catch (e) {
        p.ctx.log(`[hook:${name}] 异常: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    return results;
  }

  /** 会话结束钩子（进程退出/会话销毁前调用） */
  dispose(): void {
    this.callHook('onSessionEnd', {});
    this.loaded = [];
  }

  count(): number {
    return this.loaded.length;
  }

  private makeCtx(id: string): PluginCtx {
    const storeFile = join(this.registry.pluginsDir, 'storage', `${id}.json`);
    mkdirSync(join(this.registry.pluginsDir, 'storage'), { recursive: true });
    let data: Record<string, unknown> = {};
    if (existsSync(storeFile)) {
      try { data = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>; } catch { data = {}; }
    }
    return {
      id,
      log: (msg: string) => console.log(`[插件:${id}] ${msg}`),
      storage: {
        get: (key: string) => data[key],
        set: (key: string, value: unknown) => { data[key] = value; writeFileSync(storeFile, JSON.stringify(data)); },
      },
    };
  }
}

interface PluginExports {
  hooks?: Record<string, (payload: Record<string, unknown>) => unknown>;
  onInit?: (ctx: PluginCtx) => void;
}

/** 沙箱加载插件源码：CJS 风格（exports.hooks / module.exports），无 require/import */
function loadPluginSandbox(id: string, source: string, ctx: PluginCtx): { plugin: PluginExports; hooks: Record<string, (p: Record<string, unknown>) => unknown> } {
  if (source.length > PLUGIN_SOURCE_MAX) throw new Error(`服务端源码超限（${source.length} > ${PLUGIN_SOURCE_MAX}）`);
  const consoleMock = {
    log: (...a: unknown[]) => ctx.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    warn: (...a: unknown[]) => ctx.log(`⚠ ${a.map(String).join(' ')}`),
    error: (...a: unknown[]) => ctx.log(`🔴 ${a.map(String).join(' ')}`),
  };
  const sandbox: Record<string, unknown> = {
    exports: {},
    module: { exports: {} },
    ctx,
    console: consoleMock,
    Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Symbol, BigInt,
    Error, TypeError, RangeError, NaN, Infinity, undefined,
    setTimeout, clearTimeout,
  };
  const context = vm.createContext(sandbox);
  const wrapped = `(function (exports, module, ctx, console) {\n${source}\n})(exports, module, ctx, console);`;
  vm.runInContext(wrapped, context, { filename: `plugin-${id}.js`, timeout: 5000 });
  const moduleExports = (sandbox.module as { exports: unknown }).exports;
  const exp = (moduleExports && typeof moduleExports === 'object' && Object.keys(moduleExports as object).length > 0
    ? moduleExports
    : sandbox.exports) as PluginExports;
  const hooks = (exp.hooks ?? {}) as Record<string, (p: Record<string, unknown>) => unknown>;
  return { plugin: exp, hooks };
}
