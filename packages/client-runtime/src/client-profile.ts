import { ClientRuntimeError } from './errors.ts';
import {
  resolvePlatformCapabilities,
  type PlatformCapabilities,
} from '@jiuguan/mobile-contracts';

export const CLIENT_PROFILE_KINDS = [
  'web',
  'pwa',
  'android-bundled',
] as const;

export type ClientProfileKind = (typeof CLIENT_PROFILE_KINDS)[number];

export interface ClientExecutionProfile extends PlatformCapabilities {
  readonly kind: ClientProfileKind;
  /** 是否允许从电脑端 /ext 路径动态执行插件 widget 脚本。 */
  readonly allowRemoteWidgets: boolean;
  /** Web/PWA 使用浏览器保存；Android bundled 必须使用 native HTTP/file adapter。 */
  readonly assetDownloadMode: 'browser' | 'native-required';
}

export interface ClientExecutionProfileOverrides {
  /** 仅供未来完成主 frame/bridge 审计后的显式构建策略；当前 Android 构建不传此覆盖。 */
  allowRemoteWidgets?: boolean;
}

/**
 * 构建期客户端 profile。Android bundled 默认拒绝远程 widget；PC Web/PWA 保持现有行为。
 * 未知 profile fail closed，防止拼写错误把 Android 构建退化成普通 Web。
 */
export function createClientExecutionProfile(
  kind: ClientProfileKind | string | undefined = 'web',
  overrides: ClientExecutionProfileOverrides = {},
): ClientExecutionProfile {
  const normalized = kind === '' ? 'web' : kind;
  if (!(CLIENT_PROFILE_KINDS as readonly string[]).includes(normalized)) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'invalid-client-profile' },
    });
  }
  const profileKind = normalized as ClientProfileKind;
  const capabilities = resolvePlatformCapabilities(profileKind);
  return Object.freeze({
    ...capabilities,
    kind: profileKind,
    allowRemoteWidgets: overrides.allowRemoteWidgets
      ?? capabilities.remoteWidgets,
    assetDownloadMode: capabilities.assetDownload,
  });
}
