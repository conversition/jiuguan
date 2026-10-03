import { isSafeOpaqueId } from '@jiuguan/mobile-contracts';
import type { NormalizedEndpoint } from './endpoint.ts';
import { ClientRuntimeError } from './errors.ts';

export interface ClientStorageIdentity {
  serverId: string;
  clientId: string;
}

export interface StoredBearerBinding {
  endpointOrigin: string;
  serverId: string;
  deviceId: string;
}

export type BearerBindingResolution =
  | { status: 'unpaired' }
  | {
      status: 'mismatch';
      reason: 'invalid-binding' | 'endpoint-changed' | 'server-identity-changed';
    }
  | {
      status: 'matched';
      binding: Readonly<StoredBearerBinding>;
      vaultKey: string;
    };

function requireOpaqueId(value: string, label: string): string {
  if (!isSafeOpaqueId(value)) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'invalid-' + label },
    });
  }
  return value;
}

function encodeLabel(value: string, label: string): string {
  if (value.length < 1
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'invalid-' + label },
    });
  }
  return encodeURIComponent(value);
}

function validStoredBinding(value: StoredBearerBinding): boolean {
  if (!isSafeOpaqueId(value.serverId) || !isSafeOpaqueId(value.deviceId)) return false;
  try {
    const parsed = new URL(value.endpointOrigin);
    return parsed.protocol === 'https:'
      && parsed.origin === value.endpointOrigin
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * 非秘密的设备本地数据键。稳定 serverId 允许同一电脑的 HTTPS 地址变化时仍保持隔离身份；
 * clientId/deviceId 与 sessionId 防止同一浏览器、不同设备或会话之间串草稿。
 */
export class ClientStorageNamespace {
  readonly #prefix: string;

  constructor(identity: ClientStorageIdentity) {
    const serverId = requireOpaqueId(identity.serverId, 'server-id');
    const clientId = requireOpaqueId(identity.clientId, 'client-id');
    this.#prefix = 'jg-local:v1:' + serverId + ':' + clientId;
  }

  preferenceKey(name: string): string {
    return this.#prefix + ':preference:' + encodeLabel(name, 'preference-name');
  }

  sessionPreferenceKey(sessionId: string, name: string): string {
    return this.#sessionPrefix(sessionId) + ':preference:' + encodeLabel(name, 'preference-name');
  }

  draftKey(sessionId: string, name = 'main'): string {
    return this.#sessionPrefix(sessionId) + ':draft:' + encodeLabel(name, 'draft-name');
  }

  #sessionPrefix(sessionId: string): string {
    return this.#prefix + ':session:' + requireOpaqueId(sessionId, 'session-id');
  }
}

/**
 * 仅用于平台安全存储（Android Keystore/Keychain adapter）的定位键，不得放进 localStorage。
 */
export function bearerVaultKey(
  endpoint: NormalizedEndpoint,
  serverId: string,
  deviceId: string,
): string {
  let endpointIsCanonicalHttps = false;
  try {
    const parsed = new URL(endpoint.origin);
    endpointIsCanonicalHttps = parsed.protocol === 'https:'
      && parsed.origin === endpoint.origin
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && !parsed.username
      && !parsed.password;
  } catch {
    endpointIsCanonicalHttps = false;
  }
  if (!endpoint.isSecure
    || endpoint.protocol !== 'https:'
    || !endpointIsCanonicalHttps) {
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'insecure-vault-endpoint' },
    });
  }
  return 'jg-vault:v1:'
    + encodeURIComponent(endpoint.origin)
    + ':' + requireOpaqueId(serverId, 'server-id')
    + ':' + requireOpaqueId(deviceId, 'device-id');
}

/**
 * 只有本地已信任绑定与本次无凭据握手的 endpoint + serverId 同时匹配时才返回 vault key。
 * 首次连接、换地址或换服务器都 fail closed；显式重新配对后由调用方保存新的 binding。
 */
export function resolveBearerBinding(
  endpoint: NormalizedEndpoint,
  observedServerId: string,
  stored: StoredBearerBinding | null | undefined,
): BearerBindingResolution {
  requireOpaqueId(observedServerId, 'server-id');
  if (!stored) return Object.freeze({ status: 'unpaired' });
  if (!validStoredBinding(stored)) {
    return Object.freeze({ status: 'mismatch', reason: 'invalid-binding' });
  }
  if (stored.endpointOrigin !== endpoint.origin) {
    return Object.freeze({ status: 'mismatch', reason: 'endpoint-changed' });
  }
  if (stored.serverId !== observedServerId) {
    return Object.freeze({ status: 'mismatch', reason: 'server-identity-changed' });
  }
  const binding = Object.freeze({ ...stored });
  return Object.freeze({
    status: 'matched',
    binding,
    vaultKey: bearerVaultKey(endpoint, stored.serverId, stored.deviceId),
  });
}

/**
 * 只应在 Bearer 配对成功并校验 pair result 后调用；它不读取、保存或返回 token。
 */
export function createBearerBinding(
  endpoint: NormalizedEndpoint,
  serverId: string,
  deviceId: string,
): Readonly<StoredBearerBinding> {
  bearerVaultKey(endpoint, serverId, deviceId);
  return Object.freeze({
    endpointOrigin: endpoint.origin,
    serverId,
    deviceId,
  });
}
