import { useEffect } from 'react';
import { authFetch, pluginWidgetUrl } from './authClient.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';
import {
  DshWidgetLoaderController,
  type DshPluginInfo,
  type DshWidgetLoaderRuntime,
  type DshWidgetScriptRef,
  type DshWidgetScriptState,
} from './dshWidgetLoaderCore.ts';

const SCRIPT_SELECTOR = 'script[data-dsh-plugin-id], script[id^="dsh-widget-"]';
export { WEB_CLIENT_PROFILE } from './clientProfile.ts';

function toScriptRef(script: HTMLScriptElement): DshWidgetScriptRef {
  return {
    identity: script,
    get pluginId() {
      return script.dataset.dshPluginId
        ?? (script.id.startsWith('dsh-widget-') ? script.id.slice('dsh-widget-'.length) : '');
    },
    get revision() { return script.dataset.dshPluginVersion; },
    get state() { return script.dataset.dshPluginState as DshWidgetScriptState | undefined; },
    setState(state) { script.dataset.dshPluginState = state; },
    listen(onLoad, onError) {
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      return () => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
      };
    },
    append() { document.body.appendChild(script); },
    remove() { script.remove(); },
  };
}

function createBrowserRuntime(): DshWidgetLoaderRuntime {
  return {
    async listPlugins(signal) {
      const response = await authFetch('/api/plugins', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`plugin list HTTP ${response.status}`);
      const payload = await response.json() as { plugins?: unknown };
      return Array.isArray(payload.plugins) ? payload.plugins as DshPluginInfo[] : [];
    },
    async probeWidget(url, signal) {
      const response = await authFetch(url, { method: 'HEAD', cache: 'no-store', signal });
      return response.ok;
    },
    listScripts() {
      return Array.from(document.querySelectorAll<HTMLScriptElement>(SCRIPT_SELECTOR)).map(toScriptRef);
    },
    createScript({ id, revision, url }) {
      const script = document.createElement('script');
      script.id = `dsh-widget-${id}`;
      script.src = url;
      script.defer = true;
      script.dataset.dshPluginId = id;
      script.dataset.dshPluginVersion = revision;
      script.dataset.dshPluginState = 'loading';
      return toScriptRef(script);
    },
    disposeAndReload(detail) {
      window.dispatchEvent(new CustomEvent('jiuguan:dsh-widget-dispose', { detail }));
      window.location.reload();
    },
    setTimer(callback, delayMs) { return window.setTimeout(callback, delayMs); },
    clearTimer(timer) { window.clearTimeout(timer as number); },
    log(message) { console.log(message); },
  };
}

/**
 * DSH 插件可视化加载器（通用机制，不写死任何插件）：
 * 轮询 /api/plugins 发现「启用的 DSH 插件」→ 注入受控入口 /ext/<插件id>/widget.js。
 * widget.js 走同源相对路径取数据，开发由 Vite 代理，生产由后端直接伺服。
 * 纯服务插件的 404 会静默跳过；后续更新添加 UI 后会在下一轮自动发现。
 */
export function DshWidgetLoader() {
  useEffect(() => {
    const controller = new DshWidgetLoaderController(createBrowserRuntime(), {
      widgetUrl: pluginWidgetUrl,
      allowRemoteWidgets: WEB_CLIENT_PROFILE.allowRemoteWidgets,
    });
    const syncVisibility = () => {
      if (document.hidden) controller.stop();
      else void controller.start();
    };
    const refresh = () => {
      if (!document.hidden) void controller.refresh();
    };
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener('jiuguan:plugins-changed', refresh);
    syncVisibility();
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('jiuguan:plugins-changed', refresh);
      controller.stop();
    };
  }, []);

  return null;
}
