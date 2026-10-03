/**
 * P5.2-A2-02：认证运行时（secured 模式）。
 *
 * 职责：持有 AuthStore + crypto factory，把 HTTP 层解析出的 `PairRequest`
 * 交给 `pairWithCode()`（恒时路径与状态机都在 server-auth），并把结果映射成
 * HTTP 可渲染的形状。本文件不做任何秘密的持久化或日志输出。
 *
 * 启动纪律：`secured` 模式要求先完成 `pnpm auth:bootstrap`——没有激活世代时
 * `AuthRuntime.open()` 抛错，server 必须拒绝启动，而不是退回未认证模式。
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import {
  ACTIVE_POINTER_NAME,
  AuthStore,
  createAuthCrypto,
  openAuthStore,
  pairWithCode,
  readActiveGeneration,
  readInstanceRootKeyFile,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
  authenticateCredential,
} from '../../packages/server-auth/src/index.ts';
import { isPairRequest } from '../../packages/mobile-contracts/src/index.ts';
import type {
  AuthDeviceRecord,
  AuthSessionRecord,
  AuthTransportValue,
  DeviceScopeValue,
  AuthAssetCapabilityRecord,
} from '../../packages/server-auth/src/index.ts';
import type {
  AssetCapability,
  AssetCapabilityPurpose,
  DeviceSession,
  PairRequest,
  PublicDeviceDescriptor,
} from '../../packages/mobile-contracts/src/index.ts';
import {
  ASSET_CAPABILITY_PREFIX,
  isAssetCapabilityPurpose,
  isAssetCapabilityToken,
} from '../../packages/mobile-contracts/src/index.ts';

/** 会话凭据所在的 Cookie 名（__Host- 前缀强制 Secure / Path=/ / 无 Domain）。 */
export const SESSION_COOKIE_NAME = '__Host-jg_session';

export interface AuthenticatedContext {
  device: AuthDeviceRecord;
  session: AuthSessionRecord | null;
  transport: 'bearer' | 'same-origin-cookie';
  isAdmin: boolean;
}

export type CredentialExtraction =
  | { kind: 'none' }
  | { kind: 'presented'; transport: 'bearer' | 'same-origin-cookie'; value: string }
  | { kind: 'invalid'; reason: 'bad-authorization' | 'bad-cookie' | 'both-credentials' };

export type CsrfTokenExtraction =
  | { kind: 'none' }
  | { kind: 'presented'; value: string }
  | { kind: 'invalid' };

/**
 * A3-02：只接受唯一的 `X-JG-CSRF`。代理合并出来的逗号值视为重复头，
 * 不做“取第一个”猜测。token 的编码/长度不在这里提前分支，而交给 crypto
 * 的 dummy-digest + timingSafeEqual 路径统一验证。
 */
export function extractCsrfToken(headers: IncomingHttpHeaders): CsrfTokenExtraction {
  const header = headers['x-jg-csrf'];
  if (header === undefined) return { kind: 'none' };
  if (Array.isArray(header)) {
    if (header.length !== 1 || header[0] === undefined) return { kind: 'invalid' };
    if (header[0].includes(',')) return { kind: 'invalid' };
    return { kind: 'presented', value: header[0] };
  }
  if (header.includes(',')) return { kind: 'invalid' };
  return { kind: 'presented', value: header };
}

/**
 * 从请求头提取凭据（A3-01 纪律）：
 *  · Bearer 只接受唯一 `Authorization: Bearer <token>` —— 重复头（Node 给数组）、
 *    多余空白、其它 scheme 一律 invalid；
 *  · Cookie 只接受唯一 Cookie 头中的唯一目标 cookie；重复头、逗号合并、
 *    值内空白一律 invalid；
 *  · Bearer 与 Cookie 同时存在 → invalid（不做优先级猜测）；
 *  · 长期 token 绝不从 query / URL / body 读取（本函数只看头）。
 */
export function extractPresentedCredential(headers: {
  authorization?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}): CredentialExtraction {
  let bearerRaw: string | null = null;
  let bearerInvalid = false;
  const authz = headers.authorization;
  if (Array.isArray(authz)) {
    if (authz.length !== 1) bearerInvalid = true;
    else bearerRaw = authz[0] ?? null;
  } else if (typeof authz === 'string') {
    bearerRaw = authz;
  }
  let bearerValue: string | null = null;
  if (bearerRaw !== null) {
    // 形状：`Bearer <token>`，恰好一个空格，token 本身不含空白。
    const rest = bearerRaw.slice('Bearer '.length);
    if (bearerRaw.startsWith('Bearer ') && rest.length > 0 && !/\s/.test(rest)) {
      bearerValue = rest;
    } else {
      bearerInvalid = true;
    }
  }

  let cookieValue: string | null = null;
  let cookieInvalid = false;
  const cookieRaw = headers.cookie;
  if (Array.isArray(cookieRaw)) {
    // 重复 Cookie 头（浏览器不会，攻击者会）→ invalid。
    cookieInvalid = true;
  } else if (typeof cookieRaw === 'string') {
    if (cookieRaw.includes(',')) {
      // 逗号合并（代理拼接）→ invalid。
      cookieInvalid = true;
    } else {
      for (const pair of cookieRaw.split(';')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) {
          if (pair.trim().length > 0) cookieInvalid = true;
          continue;
        }
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        if (name !== name.trim() || value !== value.trim() || /\s/.test(value)) {
          cookieInvalid = true;
          continue;
        }
        if (name === SESSION_COOKIE_NAME) {
          if (cookieValue !== null) cookieInvalid = true;
          else cookieValue = value;
        }
      }
    }
  }

  if (bearerValue !== null && cookieValue !== null) {
    return { kind: 'invalid', reason: 'both-credentials' };
  }
  if (bearerInvalid) return { kind: 'invalid', reason: 'bad-authorization' };
  if (cookieInvalid) return { kind: 'invalid', reason: 'bad-cookie' };
  if (bearerValue !== null) return { kind: 'presented', transport: 'bearer', value: bearerValue };
  if (cookieValue !== null) return { kind: 'presented', transport: 'same-origin-cookie', value: cookieValue };
  return { kind: 'none' };
}

export type AccessMode = 'local-only' | 'secured';

/**
 * 解析 `JG_ACCESS_MODE`。未配置 = `local-only`（现状行为不变）；
 * 其它取值一律抛错 —— 配置打错时拒绝启动，绝不静默降级。
 */
export function parseAccessMode(raw: unknown): AccessMode {
  if (raw === undefined || raw === '') return 'local-only';
  if (raw === 'local-only' || raw === 'secured') return raw;
  throw new Error(`JG_ACCESS_MODE 必须是 local-only 或 secured，实际：${String(raw)}`);
}

export type AuthPairOutcome =
  | { kind: 'bad-request' }
  | { kind: 'invalid' }
  | { kind: 'transport-not-allowed' }
  | { kind: 'scope-not-allowed' }
  | {
      kind: 'ok-cookie' | 'ok-bearer';
      device: PublicDeviceDescriptor;
      session: DeviceSession;
      /** 会话凭据明文：bearer → JSON accessToken；cookie → Set-Cookie 值。只交付一次。 */
      sessionCredential: string;
    };

export class AuthRuntime {
  readonly #store: AuthStore;
  readonly #crypto: ReturnType<typeof createAuthCrypto>;

  private constructor(store: AuthStore, crypto: ReturnType<typeof createAuthCrypto>) {
    this.#store = store;
    this.#crypto = crypto;
  }

  /** secured 模式专用：打开已 bootstrap 的认证存储。没有激活世代时抛错（拒绝启动）。 */
  static open(options: { dataDir: string; now?: () => string }): AuthRuntime {
    const dataDir = resolve(options.dataDir);
    const layout = resolveAuthStorageLayout(dataDir);
    if (!existsSync(layout.activePointerPath)) {
      throw new Error(
        `secured 模式要求先完成认证 bootstrap（缺少 ${ACTIVE_POINTER_NAME}）：`
        + `pnpm auth:bootstrap --data-dir "${dataDir}"`,
      );
    }
    const store = openAuthStore({ dataDir, now: options.now });
    const generationId = readActiveGeneration(layout);
    const generation = resolveGenerationPaths(layout, generationId);
    const keyBytes = readInstanceRootKeyFile(generation.rootKeyPath);
    const crypto = createAuthCrypto(keyBytes);
    keyBytes.fill(0);
    return new AuthRuntime(store, crypto);
  }

  /**
   * 处理一次配对请求。输入是已 JSON.parse 的 body；契约 guard
   * （isPairRequest）在这里执行，不满足 → bad-request（HTTP 400）。
   * 状态机与恒时路径全部在 pairWithCode 内。
   */
  pair(raw: unknown, now: () => string): AuthPairOutcome {
    if (!isPairRequest(raw)) return { kind: 'bad-request' };
    const request = raw as PairRequest;
    const result = pairWithCode(
      {
        code: request.code,
        transport: request.transport,
        device: {
          displayName: request.device.displayName,
          platform: request.device.platform,
          clientInstanceId: request.device.clientInstanceId ?? null,
        },
        requestedScopes: request.requestedScopes,
      },
      { store: this.#store, crypto: this.#crypto, now },
    );
    if (!result.ok) {
      return { kind: result.reason };
    }
    return {
      kind: result.session.transport === 'bearer' ? 'ok-bearer' : 'ok-cookie',
      device: {
        id: result.device.id,
        displayName: result.device.displayName,
        platform: result.device.platform,
        scopes: [...result.device.scopes],
        createdAt: result.device.createdAt,
      },
      session: {
        ...result.session,
        scopes: [...result.session.scopes],
      },
      sessionCredential: result.sessionCredential,
    };
  }

  /**
   * A3-01：恒时凭据认证。验证失败统一返回 null —— 调用方一律回同一个 401，
   * 不得区分原因；失败路径不做任何写入（lastSeen 也不更新）。
   */
  authenticate(credential: { transport: 'bearer' | 'same-origin-cookie'; value: string }, now: () => string): AuthenticatedContext | null {
    const result = authenticateCredential(credential.value, { store: this.#store, crypto: this.#crypto, now });
    if (!result.ok) return null;
    // 凭据值本身不编码 transport；必须把持久化 session transport 与实际呈现通道绑定。
    // 否则 cookie token 可被搬到 Authorization 头，借 Bearer 路径绕过 A3-02 CSRF。
    if (result.session !== null && result.session.transport !== credential.transport) return null;
    // 这里不落 lastSeen：成功路径的节流写入由具体路由显式调用（计划 §6.3）。
    return {
      device: result.device,
      session: result.session,
      transport: credential.transport,
      isAdmin: result.device.scopes.includes('admin'),
    };
  }

  /** A3-02：由 session selector + epoch 派生的 CSRF synchronizer token。 */
  csrfTokenFor(session: AuthSessionRecord): string {
    return this.#crypto.deriveCsrfToken(session.selector as never, session.csrfEpoch);
  }

  /** A3-02：无论 token 是否为合法编码，都进入 crypto 的恒时比较路径。 */
  verifyCsrfToken(candidate: unknown, session: AuthSessionRecord): boolean {
    return this.#crypto.verifyCsrfToken(candidate, session.selector as never, session.csrfEpoch);
  }

  /** A2-03：admin 签发配对码；明文只在返回值里出现一次，绝不落日志。 */
  issuePairingCode(options: {
    scopes: readonly DeviceScopeValue[];
    transports: readonly AuthTransportValue[];
    displayNameHint?: string | null;
    ttlSeconds?: number;
    attemptsRemaining?: number;
    now: () => string;
  }): { code: string; selector: string; expiresAt: string; attemptsRemaining: number } {
    const issued = this.#crypto.issuePairingCode();
    try {
      const createdAt = options.now();
      const ttlMs = (options.ttlSeconds ?? 15 * 60) * 1_000;
      const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
      const attemptsRemaining = options.attemptsRemaining ?? 5;
      this.#store.createPairing({
        selector: issued.selector as never,
        codeDigest: issued.digest,
        allowedScopes: [...options.scopes],
        allowedTransports: [...options.transports],
        displayNameHint: options.displayNameHint ?? 'admin-issued',
        createdAt,
        expiresAt,
        attemptsRemaining,
        securityEpoch: this.#store.meta.securityEpoch,
      });
      return { code: issued.value.take(), selector: issued.selector, expiresAt, attemptsRemaining };
    } finally {
      issued.value.discard();
    }
  }

  issueAssetCapability(options: {
    assetId: string;
    targetDigest: string;
    purpose: AssetCapabilityPurpose;
    session: AuthSessionRecord;
    bytes: number;
    now: () => string;
  }): AssetCapability {
    if (!/^[a-f0-9]{24}$/.test(options.assetId)
      || !/^[a-f0-9]{64}$/.test(options.targetDigest)
      || !isAssetCapabilityPurpose(options.purpose)
      || !Number.isSafeInteger(options.bytes)
      || options.bytes <= 0) {
      throw new Error('invalid asset capability input');
    }
    const media = options.purpose === 'audio' || options.purpose === 'video';
    // 下载允许一次 HEAD 探测 + 一次完整 GET；GET 后字节预算归零，不能再次取正文。
    const requestsRemaining = options.purpose === 'download' ? 2 : media ? 8 : 4;
    const issuedAt = options.now();
    const ttlMs = media ? 5 * 60_000 : 2 * 60_000;
    const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
    const bytesRemaining = Math.min(
      Number.MAX_SAFE_INTEGER,
      options.purpose === 'download' ? options.bytes : options.bytes * requestsRemaining,
    );
    const material = this.#crypto.issueAssetCapabilityMaterial();
    try {
      this.#store.insertAssetCapability({
        selector: material.selector,
        digest: material.digest,
        assetId: options.assetId,
        targetDigest: options.targetDigest,
        purpose: options.purpose,
        sessionSelector: options.session.selector as never,
        allowedMethods: ['GET', 'HEAD'],
        rangePolicy: media ? 'single' : 'none',
        issuedAt,
        expiresAt,
        requestsRemaining,
        bytesRemaining,
        reservationVersion: 0,
      });
      const secret = material.secret.take();
      return {
        capability: `${ASSET_CAPABILITY_PREFIX}_${material.selector}_${secret}`,
        assetId: options.assetId,
        purpose: options.purpose,
        expiresAt,
        requestsRemaining,
        bytesRemaining,
      };
    } finally {
      material.secret.discard();
      material.digest.destroy();
    }
  }

  consumeAssetCapability(options: {
    token: unknown;
    assetId: string;
    targetDigest: string;
    purpose: AssetCapabilityPurpose;
    method: 'GET' | 'HEAD';
    bytes: number;
    rangeRequested: boolean;
    now: () => string;
  }): { ok: true; record: AuthAssetCapabilityRecord; sessionPublicId: string } | { ok: false } {
    const token = options.token;
    let selector: string | null = null;
    let secret: string | null = null;
    if (isAssetCapabilityToken(token)) {
      const match = /^jga1_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/.exec(token);
      if (match) {
        selector = match[1] ?? null;
        secret = match[2] ?? null;
      }
    }
    // 形状错误也执行一次 dummy 恒时验证，避免形成明显的快速旁路。
    const record = selector
      ? this.#store.findAssetCapabilityBySelector(selector as never)
      : null;
    const verified = this.#crypto.verifyAssetCapabilitySecret(
      selector,
      secret,
      record?.digest ?? null,
    );
    if (!verified || !record || record.revokedAt !== null) return { ok: false };
    const now = options.now();
    if (Date.parse(record.expiresAt) <= Date.parse(now)
      || record.assetId !== options.assetId
      || record.targetDigest !== options.targetDigest
      || record.purpose !== options.purpose
      || !record.allowedMethods.includes(options.method)
      || (options.rangeRequested && record.rangePolicy !== 'single')) {
      return { ok: false };
    }
    const session = this.#store.findSessionBySelector(record.sessionSelector as never);
    if (!session || session.revokedAt !== null || Date.parse(session.expiresAt) <= Date.parse(now)
      || session.securityEpoch !== this.#store.meta.securityEpoch) {
      return { ok: false };
    }
    const device = this.#store.findDeviceById(session.deviceId);
    if (!device || device.revokedAt !== null || device.securityEpoch !== this.#store.meta.securityEpoch) {
      return { ok: false };
    }
    const reserved = this.#store.reserveAssetCapability(record.selector as never, {
      bytes: options.bytes,
      now,
    });
    return reserved.ok
      ? { ...reserved, sessionPublicId: session.publicId }
      : { ok: false };
  }

  static assetTargetDigest(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  logoutSession(selector: string, at?: string): boolean {
    return this.#store.revokeSession(selector as never, at);
  }

  revokeDeviceWithSessions(deviceId: string, at?: string): { revoked: boolean; sessions: number } {
    return this.#store.revokeDeviceWithSessions(deviceId, at);
  }

  revokeAllForReset(options: { keepDeviceId?: string | null; at?: string }): {
    securityEpoch: number;
    devices: number;
    sessions: number;
    pairings: number;
  } {
    return this.#store.revokeAllForReset(options);
  }

  listDevices(): AuthDeviceRecord[] {
    return this.#store.listDevices();
  }

  /** 成功认证路径的节流 lastSeen 写入（5 分钟节流由 store 承担）。 */
  touchActivity(context: AuthenticatedContext, at?: string): void {
    this.#store.touchDeviceLastSeen(context.device.deviceId, at);
    if (context.session) {
      this.#store.touchSessionLastSeen(context.session.selector as never, at);
    }
  }

  close(): void {
    this.#crypto.destroy();
    this.#store.close();
  }
}
