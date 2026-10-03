/**
 * P9-02/03：Service Worker 注册与 PWA 安装提示门控。
 *
 * - 只在 web/pwa profile 注册；android-bundled 不注册（与 apps/mobile prepare-www
 *   的装配期剥离双保险）。
 * - 安装提示只在浏览器且未安装时展示；Android 壳内既不注册也不提示。
 * - 与 packages/client-runtime 的 CLIENT_PROFILE_KINDS 同形（P10-04 parity 已测）。
 */
export const PWA_PROFILE_KINDS = ['web', 'pwa', 'android-bundled'] as const;
export type PwaProfileKind = (typeof PWA_PROFILE_KINDS)[number];

export function shouldRegisterServiceWorker(profile: PwaProfileKind | string): boolean {
  return profile === 'web' || profile === 'pwa';
}

export interface InstallPromptGateInput {
  profile: PwaProfileKind | string;
  /** beforeinstallprompt 捕获到的延迟事件（无则不可安装）。 */
  deferredPrompt: unknown;
  displayMode: 'standalone' | 'browser';
}

export function shouldShowInstallPrompt(input: InstallPromptGateInput): boolean {
  if (!shouldRegisterServiceWorker(input.profile)) return false;      // Android 壳内不提示
  if (input.displayMode === 'standalone') return false;               // 已安装
  return input.deferredPrompt !== null && input.deferredPrompt !== undefined;
}

export interface ServiceWorkerRegistrationDeps {
  navigator?: {
    serviceWorker?: {
      register(scriptUrl: string, options?: { scope?: string }): Promise<ServiceWorkerRegistration>;
    };
  };
}

/** 注册 SW（scope 根）。注册失败静默（PWA 是增强不是依赖）；成功时返回注册对象供更新门控观察。 */
export async function registerServiceWorker(
  profile: PwaProfileKind | string,
  deps: ServiceWorkerRegistrationDeps = {},
): Promise<ServiceWorkerRegistration | null> {
  if (!shouldRegisterServiceWorker(profile)) return null;
  const container = (deps.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined))
    ?.serviceWorker;
  if (!container) return null;
  try {
    return await container.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}
