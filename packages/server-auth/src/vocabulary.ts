/**
 * scope / transport / platform 的**服务端词表**。
 *
 * 为什么这里有一份副本：
 * `packages/server-auth` 的构建是 `rootDir: "src"`，而仓库里所有跨包引用都是相对路径
 * （没有 `@jiuguan/*` 的 node_modules 链接），因此 `src/**` **不能**导入
 * `packages/mobile-contracts`：那会让 `tsc -p packages/server-auth/tsconfig.json` 直接
 * 报 TS6059（文件不在 rootDir 下），把整包构建打挂。
 *
 * 所以服务端持有一份显式词表，并且由**跨包一致性测试**兜底：
 * `tests/verify-vocabulary-parity.ts` 用同一份 corpus 断言这里的取值、`schema.ts` 里的
 * CHECK 取值与 `@jiuguan/mobile-contracts` 的 `DEVICE_SCOPES` / `AUTH_TRANSPORTS` /
 * `DEVICE_PLATFORMS` 以及它们的 guard **完全一致**。任何一侧新增取值而另一侧没跟上，
 * 该测试会失败。改动这里必须同时跑 `pnpm test:auth`。
 *
 * 从磁盘读出的 scopes/transports 仍必须经过本文件的下述 guard 严格验证，未知值 fail-closed。
 */

export const DEVICE_SCOPE_VALUES = [
  'read',
  'chat',
  'assets.write',
  'settings.write',
  'admin',
] as const;
export type DeviceScopeValue = (typeof DEVICE_SCOPE_VALUES)[number];

export const AUTH_TRANSPORT_VALUES = ['same-origin-cookie', 'bearer'] as const;
export type AuthTransportValue = (typeof AUTH_TRANSPORT_VALUES)[number];

export const DEVICE_PLATFORM_VALUES = ['web', 'pwa', 'android', 'ios', 'desktop'] as const;
export type DevicePlatformValue = (typeof DEVICE_PLATFORM_VALUES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(DEVICE_SCOPE_VALUES);
const TRANSPORT_SET: ReadonlySet<string> = new Set(AUTH_TRANSPORT_VALUES);
const PLATFORM_SET: ReadonlySet<string> = new Set(DEVICE_PLATFORM_VALUES);

export function isDeviceScopeValue(value: unknown): value is DeviceScopeValue {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

export function isAuthTransportValue(value: unknown): value is AuthTransportValue {
  return typeof value === 'string' && TRANSPORT_SET.has(value);
}

export function isDevicePlatformValue(value: unknown): value is DevicePlatformValue {
  return typeof value === 'string' && PLATFORM_SET.has(value);
}

/**
 * 严格解析词表数组：要求非空、无重复、全部取值合法。任一不满足返回 null，
 * 调用方必须 fail-closed（不得静默裁剪或过滤未知值）。
 */
export function parseVocabularyArray<T extends string>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of value) {
    if (!guard(entry) || seen.has(entry)) return null;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
