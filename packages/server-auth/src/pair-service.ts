/**
 * P5.2-A2-02：一次性配对 service（传输无关，HTTP 薄壳在 apps/server）。
 *
 * 硬约束（清单 A2-02 / 交接说明 §6）：
 *  · 恒时路径：严格解析 selector → 查库（miss 准备 dummy digest）→ **无论哪条路都调用**
 *    `crypto.verifyPairingCode` → 之后才决定公开失败；DB miss / 过期 / 吊销 / 耗尽 /
 *    已消费 / 错码对外**统一**为 `invalid`，不得提前 return 暴露区分度；
 *  · 每次验证失败且记录存在时持久扣减 attempts（`decrementPairingAttempts`），重启不能恢复；
 *  · transport 与 requestedScopes 必须是配对码授权集合的子集（未知值 fail-closed）；
 *  · 原子消费与 device+session 创建**只**走 `AuthStore.consumePairing`（单一 `BEGIN IMMEDIATE`），
 *    本 service 不重写状态机；并发兑换由 `changes=1` 判定，败者得到统一 invalid；
 *  · Bearer 明文（会话凭据）只在成功结果里出现一次；设备凭据明文从不交付
 *    （设备凭据只作为长期 digest 存在，重新配对即轮换）。
 */
import type { AuthCrypto, AuthSelector } from './crypto.ts';
import { AuthStorageError } from './storage-error.ts';
import { AuthStore } from './store.ts';
import {
  isAuthTransportValue,
  isDevicePlatformValue,
  isDeviceScopeValue,
  type AuthTransportValue,
  type DevicePlatformValue,
  type DeviceScopeValue,
} from './vocabulary.ts';

/** 会话默认有效期：30 天。计划未固定数值，作为常量与测试固定。 */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** device claim 的显示名上限（与契约 isPairingDeviceClaim 的 120 一致）。 */
const DISPLAY_NAME_MAX = 120;
/** clientInstanceId 上限（与契约 isSafeOpaqueId(…,160) 一致）。 */
const CLIENT_INSTANCE_ID_MAX = 160;

export interface PairServiceDeviceClaim {
  readonly displayName: string;
  readonly platform: DevicePlatformValue;
  readonly clientInstanceId?: string | null;
}

export interface PairServiceRequest {
  /** 一次性配对码明文（`jgp1_…`）；畸形也必须走完整恒时路径。 */
  readonly code: string;
  readonly transport: AuthTransportValue;
  readonly device: PairServiceDeviceClaim;
  readonly requestedScopes: readonly DeviceScopeValue[];
}

export interface PairServiceDeviceView {
  /** 与契约 PublicDeviceDescriptor 一致：公开投影用 `id`。 */
  readonly id: string;
  readonly displayName: string;
  readonly platform: DevicePlatformValue;
  readonly scopes: readonly DeviceScopeValue[];
  readonly transports: readonly AuthTransportValue[];
  readonly clientInstanceId: string | null;
  readonly createdAt: string;
}

export interface PairServiceSessionView {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly transport: AuthTransportValue;
  readonly scopes: readonly DeviceScopeValue[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PairServiceSuccess {
  readonly ok: true;
  readonly device: PairServiceDeviceView;
  readonly session: PairServiceSessionView;
  /**
   * 会话凭据明文（`jg1_…`，device-credential 语法）。
   * bearer 模式 → JSON `accessToken`（仅此一次）；cookie 模式 → Set-Cookie 值。
   * 服务层不落盘、不进日志。
   */
  readonly sessionCredential: string;
}

export type PairServiceFailureReason =
  /** 统一公开失败：错码/不存在/过期/撤销/耗尽/已消费/并发败者。 */
  | 'invalid'
  /** code 有效但请求的 transport 不在该配对码授权集合内。 */
  | 'transport-not-allowed'
  /** code 有效但请求的 scopes 不是授权集合子集。 */
  | 'scope-not-allowed';

export interface PairServiceFailure {
  readonly ok: false;
  readonly reason: PairServiceFailureReason;
}

export type PairServiceResult = PairServiceSuccess | PairServiceFailure;

export interface PairServiceOptions {
  readonly store: AuthStore;
  readonly crypto: AuthCrypto;
  readonly now: () => string;
  readonly sessionTtlMs?: number;
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > DISPLAY_NAME_MAX) {
    throw new AuthStorageError('invalid-layout', 'displayName 必须是 1..120 字符');
  }
  return value;
}

function requirePlatform(value: unknown): DevicePlatformValue {
  if (!isDevicePlatformValue(value)) {
    throw new AuthStorageError('invalid-layout', `未知 platform：${String(value)}`);
  }
  return value;
}

function requireClientInstanceId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > CLIENT_INSTANCE_ID_MAX) {
    throw new AuthStorageError('invalid-layout', 'clientInstanceId 必须是 1..160 字符或省略');
  }
  return value;
}

function requireScopes(value: unknown): DeviceScopeValue[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new AuthStorageError('invalid-layout', 'requestedScopes 必须是 1..16 项的非空数组');
  }
  const seen = new Set<string>();
  const scopes: DeviceScopeValue[] = [];
  for (const entry of value) {
    if (!isDeviceScopeValue(entry) || seen.has(entry)) {
      throw new AuthStorageError('invalid-layout', 'requestedScopes 含未知或重复 scope');
    }
    seen.add(entry);
    scopes.push(entry);
  }
  return scopes;
}

function requireTransport(value: unknown): AuthTransportValue {
  if (!isAuthTransportValue(value)) {
    throw new AuthStorageError('invalid-layout', `未知 transport：${String(value)}`);
  }
  return value;
}

/**
 * 用一次性配对码兑换 device + session。
 * 输入校验失败抛 `AuthStorageError('invalid-layout')`（HTTP 层映射 400）；
 * 配对失败返回 `{ok:false}`（HTTP 层映射 401/403），公开文案统一。
 */
export function pairWithCode(request: PairServiceRequest, options: PairServiceOptions): PairServiceResult {
  const { store, crypto } = options;
  const now = options.now;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  // 0) 请求形状的强校验：HTTP 层虽已用契约 guard 过滤，service 仍不信任输入。
  const displayName = requireDisplayName(request.device.displayName);
  const platform = requirePlatform(request.device.platform);
  const clientInstanceId = requireClientInstanceId(request.device.clientInstanceId);
  const requestedScopes = requireScopes(request.requestedScopes);
  const transport = requireTransport(request.transport);
  if (typeof request.code !== 'string' || request.code.length === 0 || request.code.length > 256) {
    throw new AuthStorageError('invalid-layout', 'code 缺失或超长');
  }

  // 1) 恒时路径：严格解析 selector（畸形 → null）→ 查库（miss → null → dummy digest）
  //    → 无论哪条路都调用 verifier。
  const selector = crypto.pairingCodeSelector(request.code);
  const record = selector ? store.findPairingBySelector(selector) : null;
  const verified = crypto.verifyPairingCode(request.code, record?.codeDigest ?? null);

  if (!verified) {
    // 每次失败持久扣减 attempts（记录存在且还有余量时）；重启不能恢复次数。
    if (record && record.attemptsRemaining > 0 && record.consumedAt === null && record.revokedAt === null) {
      store.decrementPairingAttempts(record.selector as AuthSelector);
    }
    return { ok: false, reason: 'invalid' };
  }
  // verified=true 而 record=null 理论不可达（摘要匹配才可能验证通过）；保守按统一失败处理。
  if (!record || !selector) return { ok: false, reason: 'invalid' };

  // 2) 记录状态判定（此刻 code 已证明有效，公开失败原因在这里开始区分）。
  const nowIso = now();
  if (
    record.consumedAt !== null
    || record.revokedAt !== null
    || Date.parse(record.expiresAt) <= Date.parse(nowIso)
    || record.attemptsRemaining <= 0
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // 3) 授权集合子集校验。
  if (!record.allowedTransports.includes(transport)) {
    return { ok: false, reason: 'transport-not-allowed' };
  }
  const allowedScopes = new Set<string>(record.allowedScopes);
  if (!requestedScopes.every((scope) => allowedScopes.has(scope))) {
    return { ok: false, reason: 'scope-not-allowed' };
  }

  // 4) 原子消费：device + session + credential digest + 初始 CSRF epoch，
  //    单一 BEGIN IMMEDIATE；并发败者由 store 抛 pairing-unavailable → 统一 invalid。
  const deviceIssued = crypto.issueDeviceCredential();
  const sessionIssued = crypto.issueDeviceCredential();
  const expiresAt = new Date(Date.parse(nowIso) + sessionTtlMs).toISOString();
  try {
    const consumed = store.consumePairing({
      pairingSelector: selector,
      device: {
        selector: deviceIssued.selector,
        credentialDigest: deviceIssued.digest,
        displayName,
        platform,
        scopes: requestedScopes,
        transports: [transport],
        clientInstanceId,
        securityEpoch: record.securityEpoch,
        createdAt: nowIso,
      },
      session: {
        selector: sessionIssued.selector,
        credentialDigest: sessionIssued.digest,
        csrfEpoch: 0,
        transport,
        expiresAt,
        issuedAt: nowIso,
        securityEpoch: record.securityEpoch,
      },
    });
    // 设备凭据明文从不交付：长期 digest 已落库，明文立即销毁。
    deviceIssued.value.discard();
    deviceIssued.digest.destroy();
    const sessionCredential = sessionIssued.value.take();
    sessionIssued.digest.destroy();
    return {
      ok: true,
      device: {
        id: consumed.device.deviceId,
        displayName: consumed.device.displayName,
        platform: consumed.device.platform,
        scopes: [...consumed.device.scopes],
        transports: [...consumed.device.transports],
        clientInstanceId: consumed.device.clientInstanceId,
        createdAt: consumed.device.createdAt,
      },
      session: {
        sessionId: consumed.session.publicId,
        deviceId: consumed.session.deviceId,
        transport: consumed.session.transport,
        scopes: [...consumed.device.scopes],
        issuedAt: consumed.session.issuedAt,
        expiresAt: consumed.session.expiresAt,
      },
      sessionCredential,
    };
  } catch (error) {
    deviceIssued.value.discard();
    deviceIssued.digest.destroy();
    sessionIssued.value.discard();
    sessionIssued.digest.destroy();
    // 并发兑换失败 / 事务内状态机拒绝 → 统一 invalid，不区分给客户端。
    if (error instanceof AuthStorageError && error.code === 'pairing-unavailable') {
      return { ok: false, reason: 'invalid' };
    }
    throw error;
  }
}
