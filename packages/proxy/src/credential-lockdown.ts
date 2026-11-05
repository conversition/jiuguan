/**
 * P16 · T-1：零 Provider 测试用的凭据 fail-closed 边界。
 *
 * 背景（见 `docs/P16-Agent闭环评估层-测试与打通交接-20261008.md` §5.0）：
 * 把 `JG_API_KEY` / `COMMANDCODE_API_KEY` 等赋值为空字符串**不构成凭据封锁**——
 * `readLocalEnvCredential()` 会把空字符串视为"未配置"，随后继续读取仓库
 * `.env.local`/`.env`；`loadProviderConfig()` 也会在模块加载时把本地 env 文件合并进来。
 * 因此"环境变量置空 + 已启动反代"不能证明测试期间 0 Provider 请求。
 *
 * 本模块提供一个**显式的进程级测试模式**开关 `JG_TEST_CREDENTIAL_LOCKDOWN`：
 *
 * - 未设置：生产默认行为完全不变（不读取开关即视为关闭）。
 * - `1` / `on` / `true` / `yes`：封锁本地 env 文件、进程环境中的宿主凭据，
 *   以及 `provider.json` / `agent-provider.json` 的读取。
 * - 其他任意非空值：**fail-closed**（按封锁处理）。拼错的开关值不会让测试
 *   误以为自己已经隔离。
 *
 * 边界（不得越界使用）：
 * - 该门只服务于测试安全，**不是**生产 Provider 开关；生产不得依赖它做 kill switch。
 * - 不得为了让测试通过而改名、删除或覆盖用户的 `.env.local` / `provider.json`。
 *   封锁只影响"读"，`writeProviderJson()` 仍按磁盘真实内容合并，避免破坏用户数据。
 * - 子进程通过环境变量继承该门；本模块不提供任何"运行期关闭"的 API。
 */

export const CREDENTIAL_LOCKDOWN_ENV = 'JG_TEST_CREDENTIAL_LOCKDOWN' as const;

/**
 * 宿主/DSH 允许解析的凭据名。此表是 `packages/plugin/src/dsh-host.ts` 的
 * `CREDENTIAL_NAMES` 的**词表副本**（parity 由
 * `packages/proxy/tests/verify-credential-lockdown.ts` 守卫）。
 * 上层包不能反向依赖 plugin 层，所以这里保留副本而不是 import。
 */
export const DSH_CREDENTIAL_NAMES = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_PLATFORM_TOKEN',
  'JG_API_KEY',
  'COMMANDCODE_API_KEY',
] as const);

const LOCKDOWN_OFF_VALUES = new Set(['', '0', 'off', 'false', 'no']);

/**
 * 判断当前进程是否处于凭据封锁模式。
 *
 * 未设置 → false（生产默认）。
 * 已知关闭值 → false。
 * 已知开启值或**任何未知非空值** → true（fail-closed）。
 */
export function credentialLockdownActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[CREDENTIAL_LOCKDOWN_ENV];
  if (raw === undefined) return false;
  return !LOCKDOWN_OFF_VALUES.has(String(raw).trim().toLowerCase());
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 仅接受 loopback 目标；无法解析的 URL 一律视为非 loopback。 */
export function isLoopbackTarget(target: unknown): boolean {
  const raw = typeof target === 'string'
    ? target
    : target instanceof URL
      ? target.href
      : (target && typeof (target as { url?: unknown }).url === 'string'
        ? String((target as { url: string }).url)
        : '');
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const NON_LOOPBACK_FETCH_ERROR = 'credential-lockdown-non-loopback-fetch' as const;

export interface LoopbackGuardOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 安装 loopback-only 网络守卫。仅在凭据封锁开启时生效；任何非 loopback 的
 * `fetch` 立即抛出 `credential-lockdown-non-loopback-fetch`，使"测试期间没有
 * 真实上游请求"成为可断言的事实而不是约定。
 *
 * 返回一个幂等的 disposer，用于测试收尾恢复全局 fetch。
 */
export function installLoopbackNetworkGuard(options: LoopbackGuardOptions = {}): () => void {
  if (!credentialLockdownActive(options.env)) return () => {};
  const original = globalThis.fetch;
  const guarded: typeof globalThis.fetch = (input, init) => {
    if (!isLoopbackTarget(input)) {
      return Promise.reject(new Error(NON_LOOPBACK_FETCH_ERROR));
    }
    return original(input, init);
  };
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}
