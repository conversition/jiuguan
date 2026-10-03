import { isSafeOpaqueId } from './http.ts';

/** 设备令牌可授予的最小权限集合；服务端仍必须逐路由执行授权。 */
export const DEVICE_SCOPES = [
  'read',
  'chat',
  'assets.write',
  'settings.write',
  'admin',
] as const;

export type DeviceScope = (typeof DEVICE_SCOPES)[number];

/**
 * 浏览器/PWA 使用同源 HttpOnly Cookie；原生壳后续只能从系统安全存储读取 Bearer。
 * 两种传输不得通过 localStorage、IndexedDB 或 URL 查询参数交换秘密。
 */
export const AUTH_TRANSPORTS = ['same-origin-cookie', 'bearer'] as const;
export type AuthTransport = (typeof AUTH_TRANSPORTS)[number];

export const DEVICE_PLATFORMS = ['web', 'pwa', 'android', 'ios', 'desktop'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const PAIRING_CODE_STATES = ['active', 'consumed', 'expired', 'revoked'] as const;
export type PairingCodeState = (typeof PAIRING_CODE_STATES)[number];

/** 已缓存资产可申请的读取用途；服务端按用途分级发放 TTL 与读取预算。 */
export const ASSET_CAPABILITY_PURPOSES = [
  'image',
  'font',
  'style',
  'script',
  'audio',
  'video',
  'download',
] as const;
export type AssetCapabilityPurpose = (typeof ASSET_CAPABILITY_PURPOSES)[number];

export const ASSET_DOWNLOAD_FORMATS = ['json', 'png'] as const;
export type AssetDownloadFormat = (typeof ASSET_DOWNLOAD_FORMATS)[number];

/** 设备凭据版本前缀：`jg1_<selector>_<secret>`；selector 公开，secret 只存 HMAC 摘要。 */
export const DEVICE_CREDENTIAL_PREFIX = 'jg1';
/** 配对码版本前缀：`jgp1_<selector>_<secret>`；server 只落 selector 与摘要。 */
export const PAIRING_CODE_PREFIX = 'jgp1';
/** 短期资产 capability：`jga1_<selector>_<secret>`。 */
export const ASSET_CAPABILITY_PREFIX = 'jga1';

/** 未认证握手中可公开的认证能力，不包含设备令牌或配对码。 */
export interface ServerAuthDescriptor {
  required: boolean;
  /** P1 兼容字段；等价于 transports 中的 bearer。 */
  scheme?: 'bearer';
  transports?: AuthTransport[];
  pairingEnabled?: boolean;
  /** 同源 API 路径，例如 /api/auth/session；不得是绝对 URL。 */
  sessionEndpoint?: string;
}

export interface PairingDeviceClaim {
  displayName: string;
  platform: DevicePlatform;
  /** 客户端随机生成的非秘密安装标识；不得由硬件指纹派生。 */
  clientInstanceId?: string;
}

/**
 * 一次性配对码只允许出现在 POST JSON body 中。
 * `transport` 必须显式声明：不得根据可伪造的 `platform=android` 推断 Bearer。
 */
export interface PairRequest {
  code: string;
  transport: AuthTransport;
  device: PairingDeviceClaim;
  requestedScopes: DeviceScope[];
}

/** 设备列表与审计接口的公开投影；严禁加入 token、Cookie 或 token hash。 */
export interface PublicDeviceDescriptor {
  id: string;
  displayName: string;
  platform: DevicePlatform;
  scopes: DeviceScope[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** 当前认证会话的公开状态，不承载认证秘密。 */
export interface DeviceSession {
  sessionId: string;
  deviceId: string;
  transport: AuthTransport;
  scopes: DeviceScope[];
  issuedAt: string;
  expiresAt?: string;
}

interface PairResultBase {
  device: PublicDeviceDescriptor;
  session: DeviceSession;
}

/** Cookie 由 Set-Cookie 写入；响应 JSON 中绝不出现 accessToken。 */
export interface CookiePairResult extends PairResultBase {
  transport: 'same-origin-cookie';
}

/** 仅原生安全存储流程可请求 Bearer；这是唯一包含 accessToken 的配对结果。 */
export interface BearerPairResult extends PairResultBase {
  transport: 'bearer';
  tokenType: 'Bearer';
  accessToken: string;
}

export type PairResult = CookiePairResult | BearerPairResult;

export interface RevokeDeviceRequest {
  deviceId: string;
}

export interface DeviceRevocationResult {
  deviceId: string;
  revokedAt: string;
  revokedSessions: number;
}

/**
 * 可远程展示的配对码状态。code 本身只可在本机可信界面显示，因此不属于此类型。
 */
export interface PublicPairingCodeDescriptor {
  id: string;
  state: PairingCodeState;
  expiresAt: string;
  attemptsRemaining: number;
}

/** 已认证 admin 或本机 CLI 签发一次性配对码的请求。 */
export interface IssuePairingCodeRequest {
  /** 新设备可申请的权限上限；客户端请求必须是它的子集，不得静默提升。 */
  allowedScopes: DeviceScope[];
  /** 允许的传输方式；不得为空，也不得由服务端静默放宽。 */
  allowedTransports: AuthTransport[];
  /** 期望有效期（秒）；服务端仍按硬上限裁剪。 */
  ttlSeconds?: number;
  displayNameHint?: string;
}

/**
 * 配对码签发结果：唯一允许携带 code 明文的位置。
 * code 只在本机可信界面展示一次，不得进入日志、埋点、URL 或持久存储。
 */
export interface IssuedPairingCode extends PublicPairingCodeDescriptor {
  code: string;
}

/**
 * 当前认证会话。`csrfToken` 只对 Cookie 传输存在，由 session selector + csrf_epoch 确定性派生；
 * 刷新页面后通过重新调用 `GET /api/auth/session` 取得，不得写入浏览器持久存储。
 */
export interface AuthSessionState {
  device: PublicDeviceDescriptor;
  session: DeviceSession;
  csrfToken?: string;
}

export interface DeviceListResult {
  devices: PublicDeviceDescriptor[];
}

export interface RevokeAllRequest {
  /** 默认 true：保留当前会话所属设备，仅吊销其它设备。 */
  keepCurrent?: boolean;
}

export interface RevokeAllResult {
  revokedAt: string;
  revokedDevices: number;
  revokedSessions: number;
}

/**
 * 短期资产读取能力申请。只允许提交服务器 manifest 已知的 assetId + 用途；
 * 不接受任意 URL，因此不存在“提交 URL 换 capability”的路径。
 */
export interface AssetCapabilityRequest {
  assetId: string;
  purpose: AssetCapabilityPurpose;
}

/** capability 签发结果；唯一允许携带 capability 明文的响应。 */
export interface AssetCapability {
  capability: string;
  assetId: string;
  purpose: AssetCapabilityPurpose;
  expiresAt: string;
  requestsRemaining: number;
  bytesRemaining: number;
}

/** P8-05：只用稳定 assetId 申请服务端选择文件名的短时下载。 */
export interface AssetDownloadRequest {
  assetId: string;
  format: AssetDownloadFormat;
}

/** 下载授权不包含 storageKey/path；filename 已由服务端净化。 */
export interface AssetDownloadGrant extends AssetCapability {
  purpose: 'download';
  format: AssetDownloadFormat;
  filename: string;
  mediaType: 'application/json' | 'image/png';
  bytes: number;
}

const DEVICE_SCOPE_SET: ReadonlySet<string> = new Set(DEVICE_SCOPES);
const AUTH_TRANSPORT_SET: ReadonlySet<string> = new Set(AUTH_TRANSPORTS);
const DEVICE_PLATFORM_SET: ReadonlySet<string> = new Set(DEVICE_PLATFORMS);
const PAIRING_CODE_STATE_SET: ReadonlySet<string> = new Set(PAIRING_CODE_STATES);
const ASSET_CAPABILITY_PURPOSE_SET: ReadonlySet<string> = new Set(ASSET_CAPABILITY_PURPOSES);
const ASSET_DOWNLOAD_FORMAT_SET: ReadonlySet<string> = new Set(ASSET_DOWNLOAD_FORMATS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受 JSON 反序列化会产生的普通对象，排除类实例与自定义原型。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 归一化后的秘密键名黑名单：公开 DTO 的任意深度都不允许出现这些键。
 * 归一化为「小写 + 去掉 `-` 与 `_`」，因此 apiKey / api_key / API-KEY 统一命中 apikey。
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'bearer',
  'capability',
  'clientsecret',
  'code',
  'cookie',
  'credential',
  'credentialdigest',
  'credentialhash',
  'csrftoken',
  'devicetoken',
  'hmac',
  'paircode',
  'pairingcode',
  'passwd',
  'password',
  'privatekey',
  'refreshtoken',
  'rootkey',
  'salt',
  'secret',
  'sessiontoken',
  'setcookie',
  'signature',
  'token',
  'tokenhash',
]);

const MAX_DTO_DEPTH = 24;

function normalizeKeyForSecretScan(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * 递归搜索秘密键名。`allowedPaths` 用点号路径精确放行少数指定位置
 * （例如 BearerPairResult 的 `accessToken`），其余位置一律命中。
 * 深度超限按违规处理，避免恶意深层/自引用对象造成无限递归。
 */
function findForbiddenSecretPaths(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
  path = '',
  depth = 0,
  found: string[] = [],
): string[] {
  if (depth > MAX_DTO_DEPTH) {
    found.push(`${path === '' ? '<root>' : path}#depth-exceeded`);
    return found;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      findForbiddenSecretPaths(value[index], allowedPaths, `${path}[${index}]`, depth + 1, found);
    }
    return found;
  }
  if (!isRecord(value)) return found;
  for (const key of Object.keys(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (SECRET_KEY_NAMES.has(normalizeKeyForSecretScan(key)) && !allowedPaths.has(childPath)) {
      found.push(childPath);
    }
    findForbiddenSecretPaths(value[key], allowedPaths, childPath, depth + 1, found);
  }
  return found;
}

/** own enumerable 键必须全部落在 allowlist 内，且不得存在 symbol 键。 */
function hasExactOwnKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * 公开 DTO 统一守卫：必须是普通对象、own 键在 allowlist 内、无 symbol 键，
 * 且任意深度都不出现秘密键名（`allowedSecretPaths` 指定的精确位置除外）。
 */
function isGuardedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  allowedSecretPaths: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (!hasExactOwnKeys(value, allowedKeys)) return false;
  return findForbiddenSecretPaths(value, new Set(allowedSecretPaths)).length === 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isSameOriginApiPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  if (!value.startsWith('/api/') || value.includes('\\') || /[?#\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value, 'https://jiuguan.invalid');
    return parsed.origin === 'https://jiuguan.invalid' && parsed.pathname === value;
  } catch {
    return false;
  }
}

function isScopeArray(value: unknown, allowEmpty = false): value is DeviceScope[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > DEVICE_SCOPES.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const scope of value) {
    if (!isDeviceScope(scope) || seen.has(scope)) return false;
    seen.add(scope);
  }
  return true;
}

function isTransportArray(value: unknown, allowEmpty = false): value is AuthTransport[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > AUTH_TRANSPORTS.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const transport of value) {
    if (!isAuthTransport(transport) || seen.has(transport)) return false;
    seen.add(transport);
  }
  return true;
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * selector：12 字节小写 hex（24 字符）。与 `packages/server-auth` 的 `SELECTOR_RE` 完全一致，
 * 两层判断不得再出现"客户端接受但服务端永远拒绝"的差集。
 */
const AUTH_SELECTOR_RE = /^[a-f0-9]{24}$/;
/**
 * 32 字节秘密的 **canonical** base64url：恰好 43 字符，且尾字符低 2 位必须为 0。
 *
 * 共享包不能依赖 Node `Buffer`，因此用尾字符集合表达"规范化"：
 * 已用全 base64url 字母表逐个尾字符与
 * `Buffer.from(v,'base64url').toString('base64url') === v` 对照，0 处分歧。
 * 这样 `=` padding、44 字符、以及非规范尾字符都会被拒绝。
 */
const PRESENTED_SECRET_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const DEVICE_CREDENTIAL_RE = new RegExp(
  `^${DEVICE_CREDENTIAL_PREFIX}_[a-f0-9]{24}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`,
);
const PAIRING_CODE_RE = new RegExp(
  `^${PAIRING_CODE_PREFIX}_[a-f0-9]{24}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`,
);
/** A7 固定 wire：版本前缀 + 24 hex selector + canonical 32-byte base64url secret。 */
const CAPABILITY_TOKEN_RE = new RegExp(
  `^${ASSET_CAPABILITY_PREFIX}_[a-f0-9]{24}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`,
);

export function isDeviceScope(value: unknown): value is DeviceScope {
  return typeof value === 'string' && DEVICE_SCOPE_SET.has(value);
}

export function isAuthTransport(value: unknown): value is AuthTransport {
  return typeof value === 'string' && AUTH_TRANSPORT_SET.has(value);
}

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && DEVICE_PLATFORM_SET.has(value);
}

export function isPairingCodeState(value: unknown): value is PairingCodeState {
  return typeof value === 'string' && PAIRING_CODE_STATE_SET.has(value);
}

export function isAssetCapabilityPurpose(value: unknown): value is AssetCapabilityPurpose {
  return typeof value === 'string' && ASSET_CAPABILITY_PURPOSE_SET.has(value);
}

export function isAssetDownloadFormat(value: unknown): value is AssetDownloadFormat {
  return typeof value === 'string' && ASSET_DOWNLOAD_FORMAT_SET.has(value);
}

/** 12 字节小写 hex selector（凭据与配对码共用同一语法）。 */
export function isAuthSelector(value: unknown): value is string {
  return typeof value === 'string' && AUTH_SELECTOR_RE.test(value);
}

/** 32 字节秘密的 canonical base64url（43 字符，无 padding）。 */
export function isPresentedSecret(value: unknown): value is string {
  return typeof value === 'string' && PRESENTED_SECRET_RE.test(value);
}

/** 设备凭据必须符合 `jg1_<selector>_<secret>`，selector 公开、secret 高熵。 */
export function isDeviceCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && DEVICE_CREDENTIAL_RE.test(value);
}

/** 配对码必须符合 `jgp1_<selector>_<secret>`，以便严格解析后只查一条记录。 */
export function isPairingCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && PAIRING_CODE_RE.test(value);
}

/**
 * Cookie 传输的 synchronizer token。
 *
 * 与 server-auth 的 `CSRF_TOKEN_RE` 一致：43 字符 canonical base64url
 * （HKDF 派生的 32 字节），不使用"22..128 任意长度"的宽松区间。
 */
export function isCsrfToken(value: unknown): value is string {
  return typeof value === 'string' && PRESENTED_SECRET_RE.test(value);
}

/** 短期资产 capability 令牌（短期 bearer，允许出现在子资源 query 中）。 */
export function isAssetCapabilityToken(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_TOKEN_RE.test(value);
}

export function isServerAuthDescriptor(value: unknown): value is ServerAuthDescriptor {
  if (!isGuardedRecord(value, ['required', 'scheme', 'transports', 'pairingEnabled', 'sessionEndpoint'])) {
    return false;
  }
  if (typeof value.required !== 'boolean'
    || (value.scheme !== undefined && value.scheme !== 'bearer')
    || (value.transports !== undefined && !isTransportArray(value.transports))
    || (value.pairingEnabled !== undefined && typeof value.pairingEnabled !== 'boolean')
    || (value.sessionEndpoint !== undefined && !isSameOriginApiPath(value.sessionEndpoint))) {
    return false;
  }

  const transports = value.transports ?? [];
  if (value.scheme === 'bearer' && transports.length > 0 && !transports.includes('bearer')) return false;
  if (value.required && value.scheme !== 'bearer' && transports.length === 0) return false;
  if (value.pairingEnabled === true && (!value.required || value.sessionEndpoint === undefined)) return false;
  return true;
}

export function isPairingDeviceClaim(value: unknown): value is PairingDeviceClaim {
  return isGuardedRecord(value, ['displayName', 'platform', 'clientInstanceId'])
    && isBoundedText(value.displayName, 120)
    && isDevicePlatform(value.platform)
    && (value.clientInstanceId === undefined || isSafeOpaqueId(value.clientInstanceId, 160));
}

export function isPairRequest(value: unknown): value is PairRequest {
  return isGuardedRecord(value, ['code', 'transport', 'device', 'requestedScopes'], ['code'])
    && isPairingCode(value.code)
    && isAuthTransport(value.transport)
    && isPairingDeviceClaim(value.device)
    && isScopeArray(value.requestedScopes);
}

export function isPublicDeviceDescriptor(value: unknown): value is PublicDeviceDescriptor {
  if (!isGuardedRecord(value, ['id', 'displayName', 'platform', 'scopes', 'createdAt', 'lastSeenAt', 'revokedAt'])) {
    return false;
  }
  if (!isSafeOpaqueId(value.id)
    || !isBoundedText(value.displayName, 120)
    || !isDevicePlatform(value.platform)
    || !isScopeArray(value.scopes)
    || !isIsoTimestamp(value.createdAt)
    || (value.lastSeenAt !== undefined && !isIsoTimestamp(value.lastSeenAt))
    || (value.revokedAt !== undefined && !isIsoTimestamp(value.revokedAt))) {
    return false;
  }
  const created = Date.parse(value.createdAt);
  return (value.lastSeenAt === undefined || Date.parse(value.lastSeenAt) >= created)
    && (value.revokedAt === undefined || Date.parse(value.revokedAt) >= created);
}

export function isDeviceSession(value: unknown): value is DeviceSession {
  if (!isGuardedRecord(value, ['sessionId', 'deviceId', 'transport', 'scopes', 'issuedAt', 'expiresAt'])) {
    return false;
  }
  if (!isSafeOpaqueId(value.sessionId)
    || !isSafeOpaqueId(value.deviceId)
    || !isAuthTransport(value.transport)
    || !isScopeArray(value.scopes)
    || !isIsoTimestamp(value.issuedAt)
    || (value.expiresAt !== undefined && !isIsoTimestamp(value.expiresAt))) {
    return false;
  }
  return value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.issuedAt);
}

function isPairResultBase(value: Record<string, unknown>): boolean {
  const device = value.device;
  const session = value.session;
  if (!isPublicDeviceDescriptor(device) || !isDeviceSession(session)) return false;
  return session.deviceId === device.id
    && session.scopes.every((scope) => device.scopes.includes(scope));
}

export function isCookiePairResult(value: unknown): value is CookiePairResult {
  return isGuardedRecord(value, ['transport', 'device', 'session'])
    && value.transport === 'same-origin-cookie'
    && isPairResultBase(value)
    && (value.session as DeviceSession).transport === 'same-origin-cookie';
}

export function isBearerPairResult(value: unknown): value is BearerPairResult {
  return isGuardedRecord(value, ['transport', 'tokenType', 'accessToken', 'device', 'session'], ['accessToken'])
    && value.transport === 'bearer'
    && value.tokenType === 'Bearer'
    && isDeviceCredential(value.accessToken)
    && isPairResultBase(value)
    && (value.session as DeviceSession).transport === 'bearer';
}

export function isPairResult(value: unknown): value is PairResult {
  return isCookiePairResult(value) || isBearerPairResult(value);
}

export function isRevokeDeviceRequest(value: unknown): value is RevokeDeviceRequest {
  return isGuardedRecord(value, ['deviceId']) && isSafeOpaqueId(value.deviceId);
}

export function isDeviceRevocationResult(value: unknown): value is DeviceRevocationResult {
  return isGuardedRecord(value, ['deviceId', 'revokedAt', 'revokedSessions'])
    && isSafeOpaqueId(value.deviceId)
    && isIsoTimestamp(value.revokedAt)
    && isBoundedCount(value.revokedSessions);
}

export function isPublicPairingCodeDescriptor(value: unknown): value is PublicPairingCodeDescriptor {
  return isGuardedRecord(value, ['id', 'state', 'expiresAt', 'attemptsRemaining'])
    && isSafeOpaqueId(value.id)
    && isPairingCodeState(value.state)
    && isIsoTimestamp(value.expiresAt)
    && isBoundedCount(value.attemptsRemaining);
}

export function isIssuePairingCodeRequest(value: unknown): value is IssuePairingCodeRequest {
  if (!isGuardedRecord(value, ['allowedScopes', 'allowedTransports', 'ttlSeconds', 'displayNameHint'])) {
    return false;
  }
  return isScopeArray(value.allowedScopes)
    && isTransportArray(value.allowedTransports)
    && (value.ttlSeconds === undefined
      || (Number.isSafeInteger(value.ttlSeconds)
        && Number(value.ttlSeconds) >= 30
        && Number(value.ttlSeconds) <= 3600))
    && (value.displayNameHint === undefined || isBoundedText(value.displayNameHint, 120));
}

export function isIssuedPairingCode(value: unknown): value is IssuedPairingCode {
  return isGuardedRecord(
    value,
    ['id', 'state', 'expiresAt', 'attemptsRemaining', 'code'],
    ['code'],
  )
    && isPairingCode(value.code)
    && isPublicPairingCodeDescriptor({
      id: value.id,
      state: value.state,
      expiresAt: value.expiresAt,
      attemptsRemaining: value.attemptsRemaining,
    });
}

export function isAuthSessionState(value: unknown): value is AuthSessionState {
  if (!isGuardedRecord(value, ['device', 'session', 'csrfToken'], ['csrfToken'])) return false;
  const device = value.device;
  const session = value.session;
  if (!isPublicDeviceDescriptor(device) || !isDeviceSession(session)) return false;
  if (session.deviceId !== device.id) return false;
  if (!session.scopes.every((scope) => device.scopes.includes(scope))) return false;
  if (session.transport === 'same-origin-cookie') return isCsrfToken(value.csrfToken);
  return value.csrfToken === undefined;
}

export function isDeviceListResult(value: unknown): value is DeviceListResult {
  if (!isGuardedRecord(value, ['devices'])) return false;
  return Array.isArray(value.devices)
    && value.devices.length <= 512
    && value.devices.every(isPublicDeviceDescriptor);
}

export function isRevokeAllRequest(value: unknown): value is RevokeAllRequest {
  return isGuardedRecord(value, ['keepCurrent'])
    && (value.keepCurrent === undefined || typeof value.keepCurrent === 'boolean');
}

export function isRevokeAllResult(value: unknown): value is RevokeAllResult {
  return isGuardedRecord(value, ['revokedAt', 'revokedDevices', 'revokedSessions'])
    && isIsoTimestamp(value.revokedAt)
    && isBoundedCount(value.revokedDevices)
    && isBoundedCount(value.revokedSessions);
}

export function isAssetCapabilityRequest(value: unknown): value is AssetCapabilityRequest {
  return isGuardedRecord(value, ['assetId', 'purpose'])
    && typeof value.assetId === 'string'
    && /^[a-f0-9]{24}$/.test(value.assetId)
    && isAssetCapabilityPurpose(value.purpose);
}

export function isAssetCapability(value: unknown): value is AssetCapability {
  return isGuardedRecord(
    value,
    ['capability', 'assetId', 'purpose', 'expiresAt', 'requestsRemaining', 'bytesRemaining'],
    ['capability'],
  )
    && isAssetCapabilityToken(value.capability)
    && typeof value.assetId === 'string'
    && /^[a-f0-9]{24}$/.test(value.assetId)
    && isAssetCapabilityPurpose(value.purpose)
    && isIsoTimestamp(value.expiresAt)
    && isBoundedCount(value.requestsRemaining)
    && isBoundedCount(value.bytesRemaining);
}

export function isAssetDownloadRequest(value: unknown): value is AssetDownloadRequest {
  return isGuardedRecord(value, ['assetId', 'format'])
    && typeof value.assetId === 'string'
    && /^[a-f0-9]{24}$/.test(value.assetId)
    && isAssetDownloadFormat(value.format);
}

export function isAssetDownloadGrant(value: unknown): value is AssetDownloadGrant {
  return isGuardedRecord(
    value,
    [
      'capability', 'assetId', 'purpose', 'expiresAt', 'requestsRemaining', 'bytesRemaining',
      'format', 'filename', 'mediaType', 'bytes',
    ],
    ['capability'],
  )
    && isAssetCapability({
      capability: value.capability,
      assetId: value.assetId,
      purpose: value.purpose,
      expiresAt: value.expiresAt,
      requestsRemaining: value.requestsRemaining,
      bytesRemaining: value.bytesRemaining,
    })
    && value.purpose === 'download'
    && isAssetDownloadFormat(value.format)
    && typeof value.filename === 'string'
    && value.filename.length > 0
    && value.filename.length <= 240
    && !/[\\/\u0000-\u001f\u007f]/.test(value.filename)
    && (value.mediaType === 'application/json' || value.mediaType === 'image/png')
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0;
}
