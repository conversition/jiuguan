export interface DshPluginInfo {
  id: string;
  kind?: 'st' | 'dsh';
  enabled: boolean;
  version?: string;
  updatedAt?: string;
}

export type DshWidgetScriptState = 'loading' | 'loaded' | 'error';

/** 对 script DOM 的最小抽象，使生命周期可在 Node 中确定性测试。 */
export interface DshWidgetScriptRef {
  /** 同一个 DOM script 在多次扫描中保持相同 identity，即使外层 adapter 重新包装。 */
  readonly identity: object;
  readonly pluginId: string;
  readonly revision?: string;
  readonly state?: DshWidgetScriptState;
  setState(state: DshWidgetScriptState): void;
  listen(onLoad: () => void, onError: () => void): () => void;
  append(): void;
  remove(): void;
}

export interface DshWidgetLoaderRuntime {
  listPlugins(signal: AbortSignal): Promise<DshPluginInfo[]>;
  probeWidget(url: string, signal: AbortSignal): Promise<boolean>;
  listScripts(): DshWidgetScriptRef[];
  createScript(input: { id: string; revision: string; url: string }): DshWidgetScriptRef;
  disposeAndReload(input: {
    id: string;
    revision?: string;
    nextRevision?: string;
    reason: 'disabled-or-uninstalled' | 'revision-changed' | 'duplicate-script';
  }): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  log?(message: string): void;
}

export interface DshWidgetLoaderOptions {
  apiBase?: string;
  widgetUrl?: (id: string, revision: string) => string;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  scriptTimeoutMs?: number;
  /** Android bundled profile 默认 false；禁用时不得读取插件列表、探测或注入 script。 */
  allowRemoteWidgets?: boolean;
}

interface TrackedScript {
  script: DshWidgetScriptRef;
  revision: string;
  state: 'loading' | 'loaded';
  loadTimer?: unknown;
  unlisten?: () => void;
}

// Admin admission refills at one token per ten seconds. A 10s poll left no headroom and two tabs
// could permanently rate-limit each other. Mutations trigger an immediate refresh, so 30s is both
// responsive and safe for normal background discovery.
export const DSH_WIDGET_POLL_INTERVAL_MS = 30_000;
export const DSH_WIDGET_RETRY_DELAY_MS = 1_000;
export const DSH_WIDGET_REQUEST_TIMEOUT_MS = 5_000;
export const DSH_WIDGET_SCRIPT_TIMEOUT_MS = 15_000;

export function dshPluginRevision(plugin: DshPluginInfo): string {
  return `${plugin.version ?? '0'}:${plugin.updatedAt ?? '0'}`;
}

export function dshWidgetUrl(apiBase: string, id: string, revision: string): string {
  return `${apiBase.replace(/\/$/, '')}/ext/${encodeURIComponent(id)}/widget.js?v=${encodeURIComponent(revision)}`;
}

/**
 * DSH widget 轮询控制器。
 * - 只有真实的 script load 事件可以标成 loaded；发现同名 DOM 不等于加载成功。
 * - data revision 与服务端 revision 不一致时先 dispose，再整页刷新。
 * - stop() 中止 fetch、清除轮询/超时并移除仍 loading 的脚本，适配 StrictMode。
 */
export class DshWidgetLoaderController {
  private readonly apiBase: string;
  private readonly buildWidgetUrl: (id: string, revision: string) => string;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly allowRemoteWidgets: boolean;
  private readonly tracked = new Map<string, TrackedScript>();
  private readonly requests = new Set<AbortController>();
  private pollTimer?: unknown;
  private active = false;
  private running = false;
  private reloadRequested = false;

  constructor(
    private readonly runtime: DshWidgetLoaderRuntime,
    options: DshWidgetLoaderOptions = {},
  ) {
    this.apiBase = options.apiBase ?? '';
    this.buildWidgetUrl = options.widgetUrl
      ?? ((id, revision) => dshWidgetUrl(this.apiBase, id, revision));
    this.pollIntervalMs = options.pollIntervalMs ?? DSH_WIDGET_POLL_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DSH_WIDGET_RETRY_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DSH_WIDGET_REQUEST_TIMEOUT_MS;
    this.scriptTimeoutMs = options.scriptTimeoutMs ?? DSH_WIDGET_SCRIPT_TIMEOUT_MS;
    this.allowRemoteWidgets = options.allowRemoteWidgets ?? true;
  }

  /** 启动并返回首轮扫描；重复 start 不会制造第二条轮询链。 */
  async start(): Promise<void> {
    if (!this.allowRemoteWidgets) return;
    if (this.active) return;
    this.active = true;
    await this.runCycle();
  }

  /** Plugin mutations use this instead of waiting for the low-frequency background poll. */
  async refresh(): Promise<void> {
    if (!this.active || this.reloadRequested) return;
    if (this.pollTimer !== undefined) {
      this.runtime.clearTimer(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.runCycle();
  }

  /** effect cleanup：已加载脚本保留；未完成脚本撤回，下次 mount 干净重试。 */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.pollTimer !== undefined) {
      this.runtime.clearTimer(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const request of this.requests) request.abort();
    this.requests.clear();
    for (const tracked of this.tracked.values()) {
      this.clearScriptWatch(tracked);
      if (tracked.state === 'loading') tracked.script.remove();
    }
    this.tracked.clear();
  }

  private async runCycle(): Promise<void> {
    if (!this.active || this.running || this.reloadRequested) return;
    this.running = true;
    try {
      const plugins = await this.withRequestTimeout((signal) => this.runtime.listPlugins(signal));
      if (!this.active) return;

      const activePlugins = new Map<string, string>();
      for (const plugin of plugins) {
        if (plugin.kind === 'dsh' && plugin.enabled) {
          activePlugins.set(plugin.id, dshPluginRevision(plugin));
        }
      }

      const scripts = new Map<string, DshWidgetScriptRef>();
      for (const script of this.runtime.listScripts()) {
        const duplicate = scripts.get(script.pluginId);
        if (duplicate) {
          this.requestReload({
            id: script.pluginId,
            revision: duplicate.revision,
            nextRevision: activePlugins.get(script.pluginId),
            reason: 'duplicate-script',
          });
          return;
        }
        scripts.set(script.pluginId, script);
      }

      for (const [id, script] of scripts) {
        const nextRevision = activePlugins.get(id);
        if (!nextRevision) {
          this.requestReload({ id, revision: script.revision, reason: 'disabled-or-uninstalled' });
          return;
        }
        if (script.revision !== nextRevision) {
          this.requestReload({
            id,
            revision: script.revision,
            nextRevision,
            reason: 'revision-changed',
          });
          return;
        }
        if (script.state === 'loaded') {
          this.trackLoaded(id, nextRevision, script);
        } else if (script.state === 'loading') {
          this.watchLoading(id, nextRevision, script);
        } else {
          // 缺失状态的既存 script 不能被推定为已执行；移除并走正常探测重试。
          script.remove();
          scripts.delete(id);
        }
      }

      for (const [id, revision] of activePlugins) {
        if (!this.active || this.reloadRequested || scripts.has(id)) continue;
        const url = this.buildWidgetUrl(id, revision);
        let exists = false;
        try {
          exists = await this.withRequestTimeout((signal) => this.runtime.probeWidget(url, signal));
        } catch {
          // 后端暂不可达或 HEAD 超时，由下一轮继续探测。
        }
        if (!this.active || this.reloadRequested || !exists) continue;

        const script = this.runtime.createScript({ id, revision, url });
        this.watchLoading(id, revision, script);
        script.append();
      }
    } catch {
      // 服务端尚未启动、响应无效或请求超时，均由常驻轮询恢复。
    } finally {
      this.running = false;
      if (this.active && !this.reloadRequested && this.pollTimer === undefined) {
        this.schedule(this.pollIntervalMs);
      }
    }
  }

  private trackLoaded(id: string, revision: string, script: DshWidgetScriptRef): void {
    const previous = this.tracked.get(id);
    if (previous?.script.identity === script.identity && previous.state === 'loaded') return;
    if (previous) this.clearScriptWatch(previous);
    this.tracked.set(id, { script, revision, state: 'loaded' });
  }

  private watchLoading(id: string, revision: string, script: DshWidgetScriptRef): void {
    const previous = this.tracked.get(id);
    if (previous?.script.identity === script.identity && previous.state === 'loading') return;
    if (previous) this.clearScriptWatch(previous);

    const tracked: TrackedScript = { script, revision, state: 'loading' };
    const retry = () => {
      const current = this.tracked.get(id);
      if (current !== tracked || tracked.state !== 'loading') return;
      this.clearScriptWatch(tracked);
      script.setState('error');
      script.remove();
      this.tracked.delete(id);
      if (this.active) this.schedule(this.retryDelayMs, true);
    };
    const loaded = () => {
      const current = this.tracked.get(id);
      if (current !== tracked || tracked.state !== 'loading') return;
      this.clearScriptWatch(tracked);
      tracked.state = 'loaded';
      script.setState('loaded');
      this.runtime.log?.(`[DshWidget] 已加载挂件: ${id}`);
    };

    tracked.unlisten = script.listen(loaded, retry);
    tracked.loadTimer = this.runtime.setTimer(retry, this.scriptTimeoutMs);
    this.tracked.set(id, tracked);
  }

  private clearScriptWatch(tracked: TrackedScript): void {
    if (tracked.loadTimer !== undefined) {
      this.runtime.clearTimer(tracked.loadTimer);
      tracked.loadTimer = undefined;
    }
    tracked.unlisten?.();
    tracked.unlisten = undefined;
  }

  private requestReload(input: Parameters<DshWidgetLoaderRuntime['disposeAndReload']>[0]): void {
    if (this.reloadRequested) return;
    this.reloadRequested = true;
    if (this.pollTimer !== undefined) {
      this.runtime.clearTimer(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const request of this.requests) request.abort();
    this.requests.clear();
    for (const tracked of this.tracked.values()) this.clearScriptWatch(tracked);
    this.tracked.clear();
    this.runtime.disposeAndReload(input);
  }

  private schedule(delayMs: number, replace = false): void {
    if (!this.active || this.reloadRequested) return;
    if (this.pollTimer !== undefined) {
      if (!replace) return;
      this.runtime.clearTimer(this.pollTimer);
    }
    this.pollTimer = this.runtime.setTimer(() => {
      this.pollTimer = undefined;
      void this.runCycle();
    }, delayMs);
  }

  private async withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = this.runtime.setTimer(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      this.runtime.clearTimer(timeout);
      this.requests.delete(controller);
    }
  }
}
