import {
  isAssetCapability,
  type AssetCapability,
} from '@jiuguan/mobile-contracts';
import type { NormalizedEndpoint } from './endpoint.ts';
import { ClientRuntimeError } from './errors.ts';

function violation(reason: string): never {
  throw new ClientRuntimeError('transport_violation', {
    details: { reason },
  });
}

function validateOpaquePart(value: string, label: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    violation('invalid-' + label);
  }
  return value;
}

function isWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * 所有客户端可访问的酒馆 URL 都由同一个 normalized endpoint 派生。
 * 调用方只能提交站点根相对路径，不能借绝对 URL、反斜杠或 fragment 越出绑定 origin。
 */
export class ClientUrlResolver {
  readonly #origin: string;

  constructor(endpoint: NormalizedEndpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint.origin);
    } catch {
      violation('invalid-endpoint-origin');
    }
    if (parsed.origin !== endpoint.origin
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password) {
      violation('invalid-endpoint-origin');
    }
    this.#origin = endpoint.origin;
  }

  api(path: string): string {
    return this.#scoped(path, '/api', 'api');
  }

  /**
   * SSE 当前仍是 authenticated fetch + ReadableStream；独立方法保留事件语义，
   * 防止未来切换 EventSource/WebSocket 时组件重新拼 origin。
   */
  event(path: string): string {
    return this.#scoped(path, '/api', 'event');
  }

  asset(path: string): string {
    return this.#scoped(path, '/api/assets', 'asset');
  }

  /** capability 是可放入子资源 URL 的短期 bearer；长期设备凭据绝不经过此方法。 */
  assetCapability(capability: AssetCapability): string {
    if (!isAssetCapability(capability) || capability.purpose === 'download') violation('invalid-asset-capability');
    return this.asset(
      `/api/assets/content/${capability.assetId}?cap=${encodeURIComponent(capability.capability)}`,
    );
  }

  pluginWidget(pluginId: string, revision: string): string {
    const id = encodeURIComponent(validateOpaquePart(pluginId, 'plugin-id'));
    const version = validateOpaquePart(revision, 'plugin-revision');
    const url = new URL('/ext/' + id + '/widget.js', this.#origin);
    url.searchParams.set('v', version);
    return url.href;
  }

  #scoped(path: string, prefix: string, kind: string): string {
    if (path !== path.trim()
      || !path.startsWith('/')
      || path.startsWith('//')
      || path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(path)) {
      violation('invalid-' + kind + '-path');
    }
    let resolved: URL;
    try {
      resolved = new URL(path, this.#origin);
    } catch {
      violation('invalid-' + kind + '-path');
    }
    if (resolved.origin !== this.#origin
      || resolved.hash
      || !isWithin(resolved.pathname, prefix)) {
      violation('invalid-' + kind + '-scope');
    }
    return resolved.href;
  }
}
