/**
 * P10-06：包内版本是 UI 唯一真值（P10 计划第 7 条）。
 *
 * 版本由装配期（prepare-www）写入 www/version.json；UI 只读包内文件，
 * 绝不向远端查询版本，也不接受远端版本覆盖包内值。
 */

export interface PackagedVersion {
  readonly version: string;
  readonly builtAt: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export function parsePackagedVersion(payload: unknown): PackagedVersion {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('version.json 形状非法');
  }
  const record = payload as Record<string, unknown>;
  const version = record.version;
  const builtAt = record.builtAt;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new TypeError('packaged version 非法');
  }
  if (typeof builtAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(builtAt)
    || !Number.isFinite(Date.parse(builtAt))) {
    throw new TypeError('builtAt 必须是 canonical ISO 时间');
  }
  return Object.freeze({ version, builtAt });
}

/** GET /version.json（同源、无需认证）。失败返回 null 由 UI 显示"未知版本"。 */
export async function loadPackagedVersion(
  fetchImpl: (input: string) => Promise<Response>,
): Promise<PackagedVersion | null> {
  try {
    const response = await fetchImpl('/version.json');
    if (!response.ok) return null;
    return parsePackagedVersion(await response.json());
  } catch {
    return null;
  }
}

/** 装配期调用：由包版本 + 当前时间生成 version.json 内容。 */
export function buildVersionJson(appVersion: string, now?: () => string): PackagedVersion {
  if (!VERSION_RE.test(appVersion)) {
    throw new TypeError(`appVersion 非法: ${appVersion.slice(0, 40)}`);
  }
  const builtAt = (now ?? (() => new Date().toISOString()))();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(builtAt)) {
    throw new TypeError('时钟必须返回 canonical ISO 时间');
  }
  return Object.freeze({ version: appVersion, builtAt });
}
