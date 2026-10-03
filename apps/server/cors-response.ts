import type { ServerResponse } from 'node:http';

function mergeVary(current: number | string | string[] | undefined, value: string): string {
  const existing = Array.isArray(current) ? current.join(',') : String(current ?? '');
  const names = existing.split(',').map((item) => item.trim()).filter(Boolean);
  if (!names.some((item) => item.toLowerCase() === value.toLowerCase())) names.push(value);
  return names.join(', ');
}

function isCapabilityAssetRoute(method: string, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD')
    && /^\/api\/assets\/content\/[a-f0-9]{24}$/.test(pathname);
}

/**
 * 在业务 handler 之前安装实际跨源响应的统一头。后续 JSON、SSE、writeHead 资产和错误
 * 响应都会继承这些 header，不要求各 handler 自行记忆 CORS。
 */
export function applyActualCorsHeaders(
  res: Pick<ServerResponse, 'getHeader' | 'removeHeader' | 'setHeader'>,
  input: { origin: string; method: string; pathname: string },
): void {
  res.setHeader('Access-Control-Allow-Origin', input.origin);
  res.setHeader('Vary', mergeVary(res.getHeader('Vary'), 'Origin'));
  res.removeHeader('Access-Control-Allow-Credentials');
  if (isCapabilityAssetRoute(input.method, input.pathname)) {
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');
  }
}
