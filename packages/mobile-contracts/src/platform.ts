/** Capacitor bundled WebView 的唯一应用 origin。配置、CORS 与启动断言必须与此保持一致。 */
export const CAPACITOR_APP_SCHEME = 'https' as const;
export const CAPACITOR_APP_HOSTNAME = 'localhost' as const;
export const CAPACITOR_APP_ORIGIN = `${CAPACITOR_APP_SCHEME}://${CAPACITOR_APP_HOSTNAME}` as const;

export const PLATFORM_PROFILE_KINDS = ['web', 'pwa', 'android-bundled'] as const;
export type PlatformProfileKind = (typeof PLATFORM_PROFILE_KINDS)[number];

export interface PlatformCapabilities {
  readonly profile: PlatformProfileKind;
  readonly scriptedCards: boolean;
  readonly remoteWidgets: boolean;
  readonly serviceWorker: boolean;
  readonly assetDownload: 'browser' | 'native-required';
  readonly secureCredentialStore: 'web-session' | 'android-keystore-required';
  readonly externalNavigation: 'browser' | 'system-browser-required';
}

const WEB_CAPABILITIES: PlatformCapabilities = Object.freeze({
  profile: 'web',
  scriptedCards: true,
  remoteWidgets: true,
  serviceWorker: true,
  assetDownload: 'browser',
  secureCredentialStore: 'web-session',
  externalNavigation: 'browser',
});

const PWA_CAPABILITIES: PlatformCapabilities = Object.freeze({
  ...WEB_CAPABILITIES,
  profile: 'pwa',
});

export const ANDROID_BUNDLED_CAPABILITIES: PlatformCapabilities = Object.freeze({
  profile: 'android-bundled',
  scriptedCards: false,
  remoteWidgets: false,
  serviceWorker: false,
  assetDownload: 'native-required',
  secureCredentialStore: 'android-keystore-required',
  externalNavigation: 'system-browser-required',
});

/** 未知 profile 必须失败，避免 Android 构建因拼写错误退化为 Web 权限。 */
export function resolvePlatformCapabilities(profile: string | undefined): PlatformCapabilities {
  if (profile === 'web' || profile === undefined || profile === '') return WEB_CAPABILITIES;
  if (profile === 'pwa') return PWA_CAPABILITIES;
  if (profile === 'android-bundled') return ANDROID_BUNDLED_CAPABILITIES;
  throw new TypeError('unknown-platform-profile');
}

export function assertCapacitorAppOrigin(actualOrigin: string): void {
  if (actualOrigin !== CAPACITOR_APP_ORIGIN) {
    throw new TypeError('capacitor-app-origin-mismatch');
  }
}
