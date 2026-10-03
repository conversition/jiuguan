/**
 * P5.2-A3-01：恒时凭据认证入口（传输无关；HTTP 解析在 apps/server）。
 *
 * 交接说明 §6 的唯一认证路径，**任何**凭据验证都必须走这里：
 *  1. 严格解析 selector（畸形 → dummy 全程）；
 *  2. 按 selector 查 device 表与 session 表各至多一条（miss → dummy digest）；
 *  3. **无论 malformed / unknown / revoked / 正常**都调用 crypto verifier；
 *  4. verifier 结束后才决定结果 —— DB miss / 过期 / 吊销不得提前 return；
 *  5. 失败对外统一（无 reason 区分），调用方（HTTP 层）也不得向客户端回传差异。
 *
 * 附加 fail-closed 规则：
 *  · 同一 selector 同时命中 device 与 session 表 → 拒绝（概率可忽略，但防御性处理）；
 *  · session 已吊销或已过期 → 拒绝；
 *  · session 所属 device 缺失或已吊销 → 拒绝。
 */
import type { AuthCrypto } from './crypto.ts';
import type { AuthDeviceRecord, AuthSessionRecord } from './store.ts';
import { AuthStore } from './store.ts';

export interface CredentialAuthSuccess {
  readonly ok: true;
  readonly device: AuthDeviceRecord;
  /** 凭据解析到会话时非空；解析到"纯设备凭据"时为 null（当前客户端拿不到设备明文，此路径仅防御性保留）。 */
  readonly session: AuthSessionRecord | null;
  readonly transportKind: 'session' | 'device';
}

export interface CredentialAuthFailure {
  readonly ok: false;
}

export type CredentialAuthResult = CredentialAuthSuccess | CredentialAuthFailure;

export interface CredentialAuthOptions {
  readonly store: AuthStore;
  readonly crypto: AuthCrypto;
  readonly now: () => string;
}

/**
 * 验证一个已提交的凭据明文（`jg1_<selector>_<secret>`）。
 * 输入可以是任何 unknown —— 畸形同样走完整 verifier 路径。
 */
export function authenticateCredential(presented: unknown, options: CredentialAuthOptions): CredentialAuthResult {
  const { store, crypto, now } = options;

  // 1) 严格解析 selector（畸形 → null → 后续全走 dummy）。
  const selector = crypto.deviceCredentialSelector(presented);

  // 2) 查库：两张表各至多一条；miss → digest 为 null → verifier 内部用 DUMMY_DIGEST。
  const deviceRecord = selector ? store.findDeviceBySelector(selector) : null;
  const sessionRecord = selector ? store.findSessionBySelector(selector) : null;
  const digest = deviceRecord?.credentialDigest ?? sessionRecord?.credentialDigest ?? null;

  // 3) 恒时验证：无论命中与否、无论 revoked/expired，都执行同一条 verifier 调用。
  const verified = crypto.verifyDeviceCredential(presented, digest);
  if (!verified || selector === null) {
    return { ok: false };
  }

  // 同一 selector 同时命中两张表 → 状态异常，fail-closed。
  if (deviceRecord !== null && sessionRecord !== null) {
    return { ok: false };
  }

  const nowIso = now();

  if (deviceRecord !== null) {
    if (deviceRecord.revokedAt !== null) return { ok: false };
    return { ok: true, device: deviceRecord, session: null, transportKind: 'device' };
  }

  if (sessionRecord !== null) {
    if (sessionRecord.revokedAt !== null) return { ok: false };
    if (Date.parse(sessionRecord.expiresAt) <= Date.parse(nowIso)) return { ok: false };
    const device = store.findDeviceById(sessionRecord.deviceId);
    if (device === null || device.revokedAt !== null) return { ok: false };
    return { ok: true, device, session: sessionRecord, transportKind: 'session' };
  }

  // verified=true 但两张表都查不到 —— 理论不可达；保守拒绝。
  return { ok: false };
}
