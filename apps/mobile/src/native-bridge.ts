/**
 * P10-03：Android 原生桥适配层（web 侧）。
 *
 * 规则（P10 计划第 3 条）：返回键、前后台、网络状态、Share、文件选择统一经此适配；
 * 桥不可用（web/PWA 或插件缺失）时降级到 Web API，绝不抛错导致壳不可用。
 * Capacitor 插件由壳入口显式注入；未注入即视为桥不可用，避免共享 UI 静态 import 原生插件。
 */

export interface BackButtonHandler {
  (canGoBack: boolean): void;
}

export interface NativeBridgeDeps {
  /** 由 Capacitor 运行时注入的桥；缺省用 Web 降级。仅测试注入。 */
  plugins?: {
    app?: {
      addListener(eventName: 'backButton', handler: (event: { canGoBack: boolean }) => void): { remove(): void };
      addListener(eventName: 'appStateChange', handler: (event: { isActive: boolean }) => void): { remove(): void };
      exitApp(): void;
    };
    share?: {
      share(input: { title?: string; text?: string; url?: string }): Promise<unknown>;
    };
  };
  navigatorLike?: {
    onLine?: boolean;
    share?(data: { title?: string; text?: string; url?: string }): Promise<void>;
  };
  historyBack?: () => void;
}

export interface BackButtonSubscription {
  /** 返回 true 表示桥接管（native 后退/退出），false 表示 Web 降级。 */
  readonly bridged: boolean;
  remove(): void;
}

export function registerBackButton(
  handler: BackButtonHandler,
  deps: NativeBridgeDeps = {},
): BackButtonSubscription {
  const native = deps.plugins?.app;
  if (native) {
    const listener = native.addListener('backButton', (event) => {
      handler(event.canGoBack);
      if (!event.canGoBack) return; // 首页：由壳决定是否 exitApp，这里不自动退出
      // native 后退由 WebView 历史处理：桥只通知，导航交给 handler
    });
    return { bridged: true, remove: () => listener.remove() };
  }
  // Web 降级：popstate；无历史可退时不动作。无 DOM 环境（测试/SSR）→ 空订阅。
  if (typeof window === 'undefined') {
    return { bridged: false, remove: () => {} };
  }
  const onPopState = (): void => handler(true);
  window.addEventListener('popstate', onPopState);
  return {
    bridged: false,
    remove: () => window.removeEventListener('popstate', onPopState),
  };
}

export type AppStateNotification = { isActive: boolean; source: 'native' | 'web' };

export function registerAppStateChange(
  handler: (notification: AppStateNotification) => void,
  deps: NativeBridgeDeps = {},
): BackButtonSubscription {
  const native = deps.plugins?.app;
  if (native) {
    const listener = native.addListener('appStateChange', (event) => {
      handler({ isActive: event.isActive, source: 'native' });
    });
    return { bridged: true, remove: () => listener.remove() };
  }
  if (typeof document === 'undefined') {
    return { bridged: false, remove: () => {} };
  }
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') handler({ isActive: true, source: 'web' });
  };
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') handler({ isActive: false, source: 'web' });
  };
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('visibilitychange', onHidden);
  return {
    bridged: false,
    remove: () => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('visibilitychange', onHidden);
    },
  };
}

export function isNetworkOnline(deps: NativeBridgeDeps = {}): boolean {
  return deps.navigatorLike?.onLine ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
}

export interface ShareOutcome {
  readonly via: 'native' | 'web' | 'unavailable';
}

export async function shareContent(
  payload: { title?: string; text?: string; url?: string },
  deps: NativeBridgeDeps = {},
): Promise<ShareOutcome> {
  const webShare = deps.navigatorLike?.share ?? (typeof navigator !== 'undefined' ? navigator.share : undefined);
  const nativeShare = deps.plugins?.share;
  if (nativeShare) {
    await nativeShare.share(payload);
    return { via: 'native' };
  }
  if (webShare) {
    const receiver = deps.navigatorLike ?? (typeof navigator !== 'undefined' ? navigator : undefined);
    await webShare.call(receiver, payload);
    return { via: 'web' };
  }
  return { via: 'unavailable' };
}

/** 系统文件选择：input[type=file] 一次一选；Android 上由系统文件选择器接管。 */
export function pickFile(accept: string, onPicked: (file: File | null) => void): void {
  if (typeof document === 'undefined') {
    onPicked(null);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => {
    onPicked(input.files?.[0] ?? null);
    input.remove();
  };
  input.click();
}
