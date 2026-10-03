/** P5.2-A4：secured 模式唯一 route-access manifest。未命中即默认拒绝。 */
import type { DeviceScopeValue } from '../../packages/server-auth/src/index.ts';

export type RouteBodyMode = 'none' | 'json' | 'multipart' | 'dsh';
export type RouteRateGroup = 'public' | 'read' | 'chat' | 'assets' | 'settings' | 'admin' | 'extension';

export interface RouteAccessPolicy {
  method: string;
  template: string;
  access: 'public' | 'protected';
  scope?: DeviceScopeValue;
  body: RouteBodyMode;
  csrf: 'none' | 'unsafe' | 'always';
  rateGroup: RouteRateGroup;
  stream?: boolean;
  prefix?: boolean;
}

export type RouteCredentialState =
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'authenticated'; scopes: readonly DeviceScopeValue[] };

export type RouteAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 404; code: 'route-denied' | 'auth-required' | 'auth-invalid' | 'scope-required' | 'admin-required' };

const publicRoute = (method: string, template: string, body: RouteBodyMode = 'none'): RouteAccessPolicy => ({
  method, template, access: 'public', body, csrf: 'none', rateGroup: 'public',
});
const protectedRoute = (
  method: string,
  template: string,
  scope: DeviceScopeValue | undefined,
  rateGroup: RouteRateGroup,
  options: Partial<Pick<RouteAccessPolicy, 'body' | 'csrf' | 'stream' | 'prefix'>> = {},
): RouteAccessPolicy => ({
  method,
  template,
  access: 'protected',
  ...(scope ? { scope } : {}),
  body: options.body ?? (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'json' : 'none'),
  csrf: options.csrf ?? 'unsafe',
  rateGroup,
  ...(options.stream ? { stream: true } : {}),
  ...(options.prefix ? { prefix: true } : {}),
});

export const ROUTE_ACCESS_MANIFEST: readonly RouteAccessPolicy[] = Object.freeze([
  publicRoute('GET', '/health'),
  publicRoute('GET', '/api/capabilities'),
  publicRoute('POST', '/api/auth/pair', 'json'),
  publicRoute('GET', '/api/assets/content/:assetId'),
  publicRoute('HEAD', '/api/assets/content/:assetId'),
  publicRoute('GET', '/api/assets/download/:assetId/:format'),
  publicRoute('HEAD', '/api/assets/download/:assetId/:format'),

  protectedRoute('GET', '/api/auth/session', undefined, 'read'),
  protectedRoute('POST', '/api/auth/logout', undefined, 'read'),
  protectedRoute('POST', '/api/auth/pairing-codes', 'admin', 'admin'),
  protectedRoute('GET', '/api/auth/devices', 'admin', 'admin'),
  protectedRoute('POST', '/api/auth/devices/:deviceId/revoke', 'admin', 'admin'),
  protectedRoute('POST', '/api/auth/revoke-all', 'admin', 'admin'),

  protectedRoute('*', '/ext/', 'admin', 'extension', { body: 'dsh', prefix: true }),
  protectedRoute('GET', '/api/assets/local', 'read', 'read'),
  // P8-02：唯一 multipart 核心路由；其余 unsafe /api 继续由中央策略强制 JSON。
  protectedRoute('POST', '/api/assets/import', 'assets.write', 'assets', { body: 'multipart' }),
  protectedRoute('GET', '/api/cards', 'read', 'read'),
  protectedRoute('GET', '/api/sessions', 'read', 'read'),
  protectedRoute('POST', '/api/log', 'admin', 'admin'),
  protectedRoute('GET', '/api/plugins', 'admin', 'admin'),
  protectedRoute('POST', '/api/plugins/install', 'admin', 'admin'),
  protectedRoute('POST', '/api/plugins/:id/:action', 'admin', 'admin'),
  protectedRoute('POST', '/api/snapshots', 'admin', 'admin'),

  protectedRoute('POST', '/api/session/new', 'chat', 'chat', { stream: true }),
  protectedRoute('POST', '/api/session/resume', 'chat', 'chat'),
  protectedRoute('POST', '/api/turn-jobs', 'chat', 'chat'),
  protectedRoute('GET', '/api/turn-jobs/:runId', 'chat', 'chat'),
  protectedRoute('POST', '/api/turn-jobs/:runId/cancel', 'chat', 'chat'),
  protectedRoute('GET', '/api/maintenance', 'admin', 'admin'),
  protectedRoute('POST', '/api/maintenance/control', 'admin', 'admin'),
  protectedRoute('GET', '/api/maintenance-jobs/:runId', 'read', 'read'),
  protectedRoute('POST', '/api/maintenance-jobs/:runId/cancel', 'admin', 'admin'),
  protectedRoute('GET', '/api/session/:sessionId/maintenance', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/maintenance/settings', 'admin', 'admin'),
  protectedRoute('POST', '/api/session/:sessionId/maintenance-jobs', 'admin', 'admin'),
  // P7-05：失效通知 SSE。GET 无 CSRF；stream=true 使吊销终止边界自动生效。
  protectedRoute('GET', '/api/events', 'read', 'read', { stream: true }),
  protectedRoute('POST', '/api/turn', 'chat', 'chat', { stream: true }),
  protectedRoute('POST', '/api/session/:sessionId/quiet', 'chat', 'chat'),
  protectedRoute('POST', '/api/session/:sessionId/regenerate', 'chat', 'chat', { stream: true }),
  protectedRoute('POST', '/api/session/:sessionId/turn/abort', 'chat', 'chat'),
  protectedRoute('POST', '/api/session/:sessionId/message/delete', 'chat', 'chat'),
  // 旧 Bearer/APK 仍可读 GET；Cookie Web 改走 POST，让浏览器 Origin + CSRF 与生成/缓存副作用语义一致。
  protectedRoute('GET', '/api/session/:sessionId/story-index', 'chat', 'chat', { csrf: 'always' }),
  protectedRoute('POST', '/api/session/:sessionId/story-index', 'chat', 'chat'),
  protectedRoute('POST', '/api/session/:sessionId/delete', 'settings.write', 'settings'),
  protectedRoute('GET', '/api/session/:sessionId/history', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/agent-control', 'read', 'read'),
  protectedRoute('POST', '/api/agent-control', 'admin', 'admin'),
  protectedRoute('GET', '/api/session/:sessionId/config', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/snapshot', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/memory-search', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/memory-state', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/memory-arc', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/memory-meta', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/characters', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/lorebook-scan', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/variables', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/turn-state', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/shared-scripts', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/state', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/turn-trace', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/state', 'settings.write', 'settings'),
  protectedRoute('GET', '/api/session/:sessionId/state-scopes', 'read', 'read'),
  protectedRoute('GET', '/api/session/:sessionId/mvu-state', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/mvu-update', 'chat', 'chat'),
  protectedRoute('GET', '/api/session/:sessionId/worldbook-entries', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/worldbook-update', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/session/:sessionId/variables-replace', 'settings.write', 'settings'),
  protectedRoute('GET', '/api/session/:sessionId/lorebook-entries', 'read', 'read'),
  protectedRoute('POST', '/api/session/:sessionId/director', 'chat', 'chat', { stream: true }),
  protectedRoute('POST', '/api/session/:sessionId/director/video-prompt', 'chat', 'chat', { stream: true }),

  protectedRoute('GET', '/api/providers', 'admin', 'admin'),
  protectedRoute('POST', '/api/providers/select', 'admin', 'admin'),
  protectedRoute('GET', '/api/providers/:id/models', 'admin', 'admin'),
  protectedRoute('POST', '/api/providers/:id/health', 'admin', 'admin'),
  protectedRoute('GET', '/api/provider', 'admin', 'admin'),
  protectedRoute('POST', '/api/provider/test', 'admin', 'admin'),
  protectedRoute('POST', '/api/provider/key', 'admin', 'admin'),
  protectedRoute('POST', '/api/provider/save', 'admin', 'admin'),
  protectedRoute('GET', '/api/provider/history', 'admin', 'admin'),
  protectedRoute('POST', '/api/provider/history/delete', 'admin', 'admin'),

  protectedRoute('GET', '/api/assets/status', 'read', 'read'),
  protectedRoute('POST', '/api/assets/scan', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/assets/preload', 'assets.write', 'assets', { stream: true }),
  protectedRoute('POST', '/api/assets/capabilities', 'read', 'assets'),
  protectedRoute('POST', '/api/assets/download-capabilities', 'read', 'assets'),
  protectedRoute('GET', '/api/assets/img', 'read', 'assets'),
  protectedRoute('POST', '/api/assets/cache/clear', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/assets/page', 'assets.write', 'assets'),

  protectedRoute('POST', '/api/regex/test', 'read', 'read'),
  protectedRoute('GET', '/api/regex-rules', 'read', 'read'),
  protectedRoute('POST', '/api/regex-rules/save', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/regex-rules/delete', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/regex-rules/import-card', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/card/import', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/card/import-worldbook', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/card/delete', 'assets.write', 'assets'),
  protectedRoute('GET', '/api/card/:file/raw', 'read', 'read'),
  protectedRoute('GET', '/api/card/:file/png', 'read', 'read'),
  protectedRoute('POST', '/api/preset/import', 'assets.write', 'assets'),
  protectedRoute('GET', '/api/preset/:file/raw', 'read', 'read'),
  protectedRoute('POST', '/api/worldbook/import', 'assets.write', 'assets'),
  protectedRoute('GET', '/api/worldbook/:file/raw', 'read', 'read'),
  protectedRoute('GET', '/api/presets', 'read', 'read'),
  protectedRoute('GET', '/api/preset/:file', 'read', 'read'),
  protectedRoute('POST', '/api/preset/save', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/preset/delete', 'assets.write', 'assets'),
  protectedRoute('GET', '/api/worldbooks', 'read', 'read'),
  protectedRoute('GET', '/api/worldbook/:file', 'read', 'read'),
  protectedRoute('POST', '/api/worldbook/save', 'assets.write', 'assets'),
  protectedRoute('POST', '/api/worldbook/delete', 'assets.write', 'assets'),

  protectedRoute('GET', '/api/skills', 'read', 'read'),
  protectedRoute('POST', '/api/skills/match', 'read', 'read'),
  protectedRoute('POST', '/api/skills/add', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/skills/import-style', 'settings.write', 'settings'),
  protectedRoute('POST', '/api/skills/:name/:action', 'settings.write', 'settings'),
  protectedRoute('GET', '/api/storyboard/workflows', 'read', 'read'),
  protectedRoute('POST', '/api/storyboard/run', 'chat', 'chat', { stream: true }),
  protectedRoute('POST', '/api/storyboard/video-prompt', 'chat', 'chat', { stream: true }),
  protectedRoute('GET', '/api/quality/report', 'admin', 'admin'),
  protectedRoute('GET', '/api/quality/overrides', 'admin', 'admin'),
  protectedRoute('POST', '/api/quality/overrides', 'admin', 'admin'),
  protectedRoute('GET', '/api/health', 'admin', 'admin'),
]);

function matchesTemplate(template: string, pathname: string): boolean {
  const expected = template.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    if (!segment.startsWith(':')) return segment === actual[index];
    const value = actual[index] ?? '';
    if (template === '/api/assets/content/:assetId') return /^[a-f0-9]{24}$/.test(value);
    if (template === '/api/assets/download/:assetId/:format') {
      return segment === ':assetId' ? /^[a-f0-9]{24}$/.test(value) : /^(json|png)$/.test(value);
    }
    return value.length > 0;
  });
}

export function matchRouteAccess(method: string, pathname: string): RouteAccessPolicy | null {
  const normalizedMethod = method.toUpperCase();
  for (const policy of ROUTE_ACCESS_MANIFEST) {
    if (policy.method !== '*' && policy.method !== normalizedMethod) continue;
    if (policy.prefix ? pathname.startsWith(policy.template) : matchesTemplate(policy.template, pathname)) {
      return policy;
    }
  }
  return null;
}

/** 纯授权判定供中央 server 管线与逐模板矩阵测试共用；认证密码学校验仍由 AuthRuntime 负责。 */
export function decideRouteAccess(
  policy: RouteAccessPolicy | null,
  credential: RouteCredentialState,
): RouteAccessDecision {
  if (!policy) return { allowed: false, status: 404, code: 'route-denied' };
  if (policy.access === 'public') return { allowed: true };
  if (credential.kind === 'anonymous') {
    return { allowed: false, status: 401, code: 'auth-required' };
  }
  if (credential.kind === 'invalid') {
    return { allowed: false, status: 401, code: 'auth-invalid' };
  }
  if (policy.scope && !credential.scopes.includes(policy.scope)) {
    return {
      allowed: false,
      status: 403,
      code: policy.scope === 'admin' ? 'admin-required' : 'scope-required',
    };
  }
  return { allowed: true };
}

export function assertRouteManifestValid(): void {
  const identities = new Set<string>();
  for (const policy of ROUTE_ACCESS_MANIFEST) {
    const identity = `${policy.method} ${policy.template}`;
    if (identities.has(identity)) throw new Error(`duplicate route policy: ${identity}`);
    identities.add(identity);
    if (policy.access === 'protected' && policy.rateGroup === 'public') {
      throw new Error(`protected route has public rate group: ${identity}`);
    }
    if (policy.stream && policy.access !== 'protected') {
      throw new Error(`public stream is forbidden: ${identity}`);
    }
  }
}

assertRouteManifestValid();
