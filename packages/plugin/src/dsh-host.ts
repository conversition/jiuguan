/**
 * plugin 包 - DSH 标准插件兼容宿主（deepseek-harness bundle 插件接口）
 *
 * DSH 插件契约（以 dsh-whale-widget 为基准实测）：
 *   package.json: { name, version, main, dsh?: { bundle: {...} } }   ← 无 manifest.json
 *   main 入口为 ESM，export { name, inject, apply }
 *     - name:   插件 id
 *     - inject: 依赖声明，如 ['webServer', 'credentials']
 *     - apply(ctx): 挂载入口；ctx 面向能力注入
 *   ctx 能力面：
 *     - webServer.register({kind:'exact', path, handler(req,res)}) → 返回 disposer
 *     - webServer.tapIndex((html) => html)                         → HTML 注入钩子（SPA 下降级为登记）
 *     - credentials.resolve(NAME) → Promise<{ value } | null>      ← 凭据读取
 *     - on(event, cb) → disposer；事件：'session/event' (session,event)、'session/disposed'(session)
 *     - effect(fn)  → fn() 返回清理函数；卸载时执行
 *
 * 与 ST 风格沙箱插件（runtime.ts）的关键差异：
 *   DSH 插件是「可信宿主直跑」模型（真 fs/网络/fetch），不做 node:vm 隔离；
 *   安全边界收敛在 manifest 权限声明 + 安装时确认（与 DSH 官方 pnpm 安装同级信任）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginRecord } from './registry.ts';

/** DSH webServer 路由注册项（whale-widget 只用 kind:'exact'，prefix 预留） */
export interface DshRouteDef {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/** DSH 凭据解析结果（对齐官方 ResolvedCredential：value + source 层名） */
export interface DshCredential {
  value: string;
  /** 来源层描述（'env' / 'provider.json' / 自定义） */
  source?: string;
}

/** DSH 插件 apply(ctx) 收到的宿主上下文 */
export interface DshPluginCtx {
  webServer: {
    register(def: DshRouteDef): () => void;
    tapIndex(fn: (html: string) => string): () => void;
  };
  credentials: {
    resolve(name: string): Promise<DshCredential | null>;
  };
  on(event: string, cb: (...args: unknown[]) => void): () => void;
  effect(fn: () => () => void): void;
}

/** DSH 插件 ESM 导出契约 */
export interface DshPluginExports {
  name: string;
  inject: string[];
  apply(ctx: DshPluginCtx): void | Promise<void>;
}

/** 已加载的 DSH 插件实例（路由表 + 清理函数） */
interface LoadedDshPlugin {
  record: PluginRecord;
  exports: DshPluginExports;
  routes: { kind: 'exact' | 'prefix'; path: string; handler: DshRouteDef['handler'] }[];
  indexTaps: ((html: string) => string)[];
  disposers: (() => void)[];
}

/** DSH 会话事件载荷（对齐官方 core/session Events：session/event(session, event) / session/disposed(session) / session/created(session)） */
export interface DshSessionEventPayload {
  session: { id: string; card?: string; round?: number };
  event: { type: string; data: Record<string, unknown> };
}

/** DSH assistant/message 事件 data 形状（whale-widget 消费的字段；对齐官方 SessionEventMap） */
export interface DshAssistantMessageData {
  turn: number;
  message: { source?: { model?: string } };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

const CREDENTIAL_NAMES = ['DEEPSEEK_API_KEY', 'DEEPSEEK_PLATFORM_TOKEN', 'JG_API_KEY'];

/**
 * DSH 插件宿主：加载/卸载/路由分发/会话事件广播。
 * 由 server.ts 持有单例；HTTP 分发在 /api 之前拦截（插件可遮蔽平台路由）。
 */
export class DshPluginHost {
  private loaded = new Map<string, LoadedDshPlugin>();
  /** 会话事件监听器（插件注册的 on('session/event')） */
  private sessionListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private indexTapFns: ((html: string) => string)[] = [];

  constructor(private credentialResolver: (name: string) => Promise<DshCredential | null>) {}

  /** 是否为 DSH 标准包：package.json 存在且含 main + name（无 manifest.json） */
  static isDshPackage(dir: string): boolean {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; main?: string };
      return typeof pkg.name === 'string' && typeof pkg.main === 'string';
    } catch {
      return false;
    }
  }

  /** 加载一个 DSH 插件目录（data/plugins/<name>/），apply 注入 ctx */
  async load(record: PluginRecord, dir: string): Promise<void> {
    if (this.loaded.has(record.id)) return;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) throw new Error(`DSH 插件缺少 package.json: ${dir}`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; main?: string };
    if (!pkg.main) throw new Error(`DSH 插件 package.json 缺少 main: ${record.id}`);

    const entryPath = join(dir, pkg.main);
    if (!existsSync(entryPath)) throw new Error(`DSH 插件入口不存在: ${entryPath}`);
    // 动态 import 编译后的 JS（whale-widget 的 lib/index.js 是纯 ESM，无需构建）
    const mod = (await import(pathToFileURL(entryPath).href)) as Partial<DshPluginExports>;
    if (typeof mod.apply !== 'function') throw new Error(`DSH 插件缺少 export apply(): ${record.id}`);

    const inst: LoadedDshPlugin = {
      record,
      exports: {
        name: mod.name ?? record.id,
        inject: Array.isArray(mod.inject) ? mod.inject : [],
        apply: mod.apply,
      },
      routes: [],
      indexTaps: [],
      disposers: [],
    };

    // 构造 ctx：路由/凭据/事件/清理 全部经宿主中转，卸载时统一回收
    const ctx: DshPluginCtx = {
      webServer: {
        register: (def) => {
          inst.routes.push({ kind: def.kind, path: def.path, handler: def.handler });
          return () => {
            inst.routes = inst.routes.filter((r) => r.handler !== def.handler);
          };
        },
        tapIndex: (fn) => {
          inst.indexTaps.push(fn);
          this.indexTapFns.push(fn);
          return () => {
            inst.indexTaps = inst.indexTaps.filter((f) => f !== fn);
            this.indexTapFns = this.indexTapFns.filter((f) => f !== fn);
          };
        },
      },
      credentials: {
        resolve: async (name) => this.credentialResolver(name),
      },
      on: (event, cb) => {
        let set = this.sessionListeners.get(event);
        if (!set) { set = new Set(); this.sessionListeners.set(event, set); }
        set.add(cb);
        const disposer = () => { set?.delete(cb); };
        inst.disposers.push(disposer);
        return disposer;
      },
      effect: (fn) => {
        try {
          const cleanup = fn();
          if (typeof cleanup === 'function') inst.disposers.push(cleanup);
        } catch { /* effect 注册失败不阻断加载 */ }
      },
    };

    await inst.exports.apply(ctx);
    this.loaded.set(record.id, inst);
  }

  /** 卸载：执行全部 disposer（路由/监听/资源），移除实例 */
  unload(id: string): void {
    const inst = this.loaded.get(id);
    if (!inst) return;
    for (const d of inst.disposers) {
      try { d(); } catch { /* 单个清理失败不阻断 */ }
    }
    for (const fn of inst.indexTaps) {
      this.indexTapFns = this.indexTapFns.filter((f) => f !== fn);
    }
    this.loaded.delete(id);
  }

  count(): number {
    return this.loaded.size;
  }

  ids(): string[] {
    return [...this.loaded.keys()];
  }

  /**
   * HTTP 分发入口：server 在自有路由前调用。命中返回 true（响应已写出）。
   * exact 精确匹配 → prefix 前缀匹配，先装先匹配。
   */
  dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    for (const inst of this.loaded.values()) {
      for (const route of inst.routes) {
        const hit = route.kind === 'exact'
          ? route.path === pathname
          : pathname.startsWith(route.path);
        if (!hit) continue;
        try {
          route.handler(req, res);
        } catch (e) {
          console.warn(`[dsh-插件] ${inst.record.id} 路由异常 ${pathname}: ${(e as Error).message.slice(0, 120)}`);
          if (!res.writableEnded && !res.destroyed) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('plugin route error');
          }
        }
        return true;
      }
    }
    return false;
  }

  /** HTML 注入管道（SPA 场景 jiuguan 不吐整页 HTML，留作扩展点） */
  applyIndexTaps(html: string): string {
    let out = html;
    for (const fn of this.indexTapFns) {
      try { out = fn(out); } catch { /* tap 失败返回原文 */ }
    }
    return out;
  }

  /** 广播会话事件（server 在回合内/完成时调用；对齐官方 session/event 签名 (session, event)） */
  emitSessionEvent(session: DshSessionEventPayload['session'], event: DshSessionEventPayload['event']): void {
    for (const cb of this.sessionListeners.get('session/event') ?? []) {
      try { cb(session, event); } catch { /* 监听器异常不阻断 */ }
    }
  }

  emitSessionDisposed(session: DshSessionEventPayload['session']): void {
    for (const cb of this.sessionListeners.get('session/disposed') ?? []) {
      try { cb(session); } catch { /* 监听器异常不阻断 */ }
    }
  }

  emitSessionCreated(session: DshSessionEventPayload['session']): void {
    for (const cb of this.sessionListeners.get('session/created') ?? []) {
      try { cb(session); } catch { /* 监听器异常不阻断 */ }
    }
  }

  /**
   * 桥接辅助：把 jiuguan 回合的 usage 映射为 DSH assistant/message + turn/end 两连发。
   * jiuguan 的 OpenAI usage(prompt_tokens/completion_tokens) → DSH TokenUsage；
   * DeepSeek 的 prompt_cache_hit_tokens/prompt_cache_miss_tokens 若在 raw 中则映射缓存档。
   */
  emitJiuguanTurn(opts: {
    sessionId: string; card?: string; round: number; model: string;
    promptTokens: number; completionTokens: number;
    cacheReadTokens?: number;
  }): void {
    const input = Math.max(0, opts.promptTokens - (opts.cacheReadTokens ?? 0));
    this.emitSessionEvent(
      { id: opts.sessionId, card: opts.card, round: opts.round },
      {
        type: 'assistant/message',
        data: {
          turn: opts.round,
          message: { source: { model: opts.model } },
          usage: {
            inputTokens: input,
            outputTokens: opts.completionTokens,
            ...(opts.cacheReadTokens !== undefined ? { cacheReadTokens: opts.cacheReadTokens } : {}),
          },
        },
      },
    );
    this.emitSessionEvent({ id: opts.sessionId, card: opts.card, round: opts.round }, { type: 'turn/end', data: { turn: opts.round } });
  }

  /** 重载全部启用插件（启动时调用；单插件失败仅告警不阻断其余） */
  async loadAll(records: PluginRecord[], dirOf: (rec: PluginRecord) => string): Promise<void> {
    let ok = 0;
    for (const rec of records) {
      if (!rec.enabled) continue;
      const dir = dirOf(rec);
      if (!DshPluginHost.isDshPackage(dir)) continue;
      try {
        await this.load(rec, dir);
        ok++;
      } catch (e) {
        console.warn(`[dsh-插件] ${rec.id} 加载失败: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    if (ok > 0) console.log(`[dsh-插件] 已加载 ${ok} 个 DSH 标准插件`);
  }
}

/** 凭据解析默认实现：环境变量优先 → provider.json（JG_API_KEY 复用平台 key） */
export function createEnvCredentialResolver(): (name: string) => Promise<DshCredential | null> {
  return async (name) => {
    const v = process.env[name];
    if (v) return { value: v };
    return null;
  };
}

export { CREDENTIAL_NAMES };
