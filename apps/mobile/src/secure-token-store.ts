/**
 * P10-07：Android Keystore 支撑的 token 存储端口（P10 计划第 2 条凭据部分）。
 *
 * 端口语义：设备配对 token 可撤销、绝不明文持久、绝不保存上游 Key。
 * - Android 真机：由原生侧 Keystore 加密后写入 EncryptedSharedPreferences/_datastore
 *   （挂载点：`apps/mobile/android` 的原生插件，P10-05 真机增量实现）；
 * - Web 降级：内存 + 可选会话存储，且**默认不持久化明文**——需要持久化时必须先经
 *   `crypto` 钩子加密（P6-06 的 storage namespace 语义）。
 * 本模块只定义端口与可测实现；Keystore 原生实现接线属真机增量。
 */

export interface SecureTokenStore {
  readonly kind: 'memory' | 'web-session' | 'android-keystore';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createMemoryTokenStore(): SecureTokenStore {
  const map = new Map<string, string>();
  return {
    kind: 'memory',
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

export interface WebSessionTokenStoreOptions {
  /** 会话级存储（sessionStorage 语义：随壳进程消失）。必须注入以便测试。 */
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  /** 值加密钩子（真机由 Keystore 派生密钥；Web 可注入 WebCrypto 实现）。 */
  crypto: {
    encrypt(plaintext: string): Promise<string>;
    decrypt(ciphertext: string): Promise<string>;
  };
  keyPrefix?: string;
}

export function createWebSessionTokenStore(options: WebSessionTokenStoreOptions): SecureTokenStore {
  const prefix = options.keyPrefix ?? 'jg.sec.';
  return {
    kind: 'web-session',
    async get(key) {
      const ciphertext = options.storage.getItem(prefix + key);
      if (ciphertext === null) return null;
      return options.crypto.decrypt(ciphertext);
    },
    async set(key, value) {
      options.storage.setItem(prefix + key, await options.crypto.encrypt(value));
    },
    async delete(key) {
      options.storage.removeItem(prefix + key);
    },
  };
}

/** Android 原生挂载点占位：在原生插件就绪前显式拒绝，绝不静默降级成明文持久化。 */
export function createAndroidKeystoreStoreUnavailable(): never {
  throw new Error('Android Keystore token store 需要原生插件（P10-05 真机增量）；当前环境不得明文持久化 token');
}
