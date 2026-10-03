/**
 * P10-01：构建期固定的精确 HTTPS endpoint。
 *
 * 规则（P10 计划第 2 条）：首版 APK 固定**一个精确 HTTPS origin**，运行时只读展示，
 * 换 endpoint 需要重新打包。fail-closed：任何非精确 origin（带路径/query/hash/凭据/
 * 非 HTTPS/通配）都拒绝——endpoint 只用于 API transport，绝不进入 URL/query 的 token 流。
 */

export interface PinnedEndpoint {
  /** 形如 `https://host[:port]` 的精确 origin；无路径、无 query、无凭据。 */
  readonly origin: string;
  readonly protocol: 'https:';
  readonly hostname: string;
  readonly port: string;
}

function fail(reason: string): never {
  throw new TypeError(`pinned endpoint 非法: ${reason}`);
}

export function resolvePinnedEndpoint(raw: unknown): PinnedEndpoint {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('必须是非空字符串');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    fail('不是合法 URL');
  }
  if (url.protocol !== 'https:') fail('只允许 https');
  if (url.username || url.password) fail('不允许内嵌凭据');
  if (url.pathname !== '/') fail('只允许精确 origin，不得带路径');
  if (url.search || url.hash) fail('不允许 query/hash');
  if (url.hostname.length === 0) fail('hostname 为空');
  if (url.hostname.includes('*') || url.hostname.includes(',')) fail('不允许通配/列表');
  return Object.freeze({
    origin: url.origin,
    protocol: 'https:' as const,
    hostname: url.hostname,
    port: url.port,
  });
}
