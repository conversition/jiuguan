/**
 * P10-01：bundled WebView 的导航/CSP/Service Worker 边界。
 *
 * 规则（P10 计划第 2/6/7 条）：
 * - 主 WebView 永远只加载 bundled local origin；endpoint 只是 API transport。
 * - 非 bundled/api 的 URL 一律交给系统浏览器（open-external），绝不在主 WebView 导航。
 * - bundled origin 单独 CSP：default-src 'none'、无 unsafe-eval、frame-ancestors 'none'。
 * - Android profile 不注册 Service Worker、不显示安装提示；包内版本是 UI 唯一真值。
 */

import { resolvePinnedEndpoint } from './pinned-endpoint.ts';
import { CAPACITOR_APP_ORIGIN } from '../../../packages/mobile-contracts/src/index.ts';

export const BUNDLED_APP_ORIGIN = CAPACITOR_APP_ORIGIN;

export type OutboundDecision =
  | 'internal'       // 仅 bundled local origin
  | 'open-external'; // 交给系统浏览器，主 WebView 不导航

/** 任何解析失败的 URL 都按外部处理：主 WebView 宁可不导航，也不误放行。 */
export function evaluateOutboundUrl(
  raw: unknown,
  context: { bundledOrigin: string; apiOrigin: string },
): OutboundDecision {
  if (typeof raw !== 'string') return 'open-external';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'open-external';
  }
  if (url.origin === context.bundledOrigin) return 'internal';
  // pinned API origin 只允许 fetch transport；主 frame 导航同样必须离开带原生桥的 WebView。
  if (url.origin === context.apiOrigin) return 'open-external';
  return 'open-external';
}

export function buildBundledCsp(apiOriginRaw: string): string {
  const api = resolvePinnedEndpoint(apiOriginRaw);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' ${api.origin}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 与 packages/client-runtime 的 CLIENT_PROFILE_KINDS 同形；集成时以 client-runtime 为准做 parity。 */
export const SHELL_PROFILE_KINDS = ['web', 'pwa', 'android-bundled'] as const;
export type ShellProfileKind = (typeof SHELL_PROFILE_KINDS)[number];

export function shouldRegisterServiceWorker(profile: ShellProfileKind | string): boolean {
  return profile === 'web' || profile === 'pwa';
}

/** release 构建禁止出现的配置键/值（P10 计划第 5 条）。 */
export const FORBIDDEN_RELEASE_SETTINGS: readonly string[] = Object.freeze([
  'server.url',
  'live-reload',
  'cleartext:true',
  'allowNavigation',
  'unsigned-ota',
]);
