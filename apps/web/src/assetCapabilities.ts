import {
  isAssetCapability,
  isPublicAssetDescriptor,
  type AssetCapability,
  type AssetCapabilityPurpose,
  type PublicAssetDescriptor,
} from '../../../packages/mobile-contracts/src/index.ts';
import { resolveGalUrl } from '../../../packages/assets/src/resolve.ts';
import type { AssetEntry, AssetKind } from '../../../packages/assets/src/asset-types.ts';
import { assetCapabilityUrl, assetUrl, authClient, authFetch } from './authClient.ts';
import { assetShapeOf, planResourceRewrite } from './compat/resourceLoader.ts';

export interface PreparedAssetCapabilities {
  mode: 'local-only' | 'secured';
  urls: ReadonlyMap<string, string>;
  missing: readonly string[];
  secureContentSource?: string;
}

function secureContentSource(): string {
  return assetUrl('/api/assets/content/');
}

async function mintCapabilities(
  requests: Array<{ assetId: string; purpose: AssetCapabilityPurpose }>,
): Promise<AssetCapability[]> {
  const response = await authFetch(assetUrl('/api/assets/capabilities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  const payload: unknown = await response.json().catch(() => null);
  const capabilities = payload && typeof payload === 'object'
    ? (payload as { capabilities?: unknown }).capabilities
    : null;
  return response.ok && Array.isArray(capabilities) && capabilities.every(isAssetCapability)
    ? capabilities
    : [];
}

export function capabilityContentUrl(capability: AssetCapability): string {
  return assetCapabilityUrl(capability);
}

export async function resolveNamedAsset(
  kind: AssetKind,
  name: string,
): Promise<{ status: 'ok'; url: string; cached: boolean; constructed: boolean } | { status: 'miss' }> {
  const state = await authClient.initialize();
  if (state.phase === 'local-only') {
    const response = await authFetch(assetUrl('/api/assets/status'));
    const payload: unknown = await response.json().catch(() => null);
    const row = payload && typeof payload === 'object' ? payload as {
      entries?: AssetEntry[];
      overrides?: Record<string, string>;
    } : {};
    const resolved = resolveGalUrl(kind, name, row.entries ?? [], row.overrides);
    if (!('url' in resolved)) return { status: 'miss' };
    return {
      status: 'ok',
      url: assetUrl(`/api/assets/img?url=${encodeURIComponent(resolved.url)}`),
      cached: resolved.cached,
      constructed: resolved.constructed,
    };
  }
  if (state.phase !== 'authenticated') return { status: 'miss' };
  const response = await authFetch(assetUrl('/api/assets/status'));
  const payload: unknown = await response.json().catch(() => null);
  const entries = payload && typeof payload === 'object' && Array.isArray((payload as { entries?: unknown }).entries)
    ? (payload as { entries: unknown[] }).entries.filter(isPublicAssetDescriptor)
    : [];
  const entry = entries.find((candidate) =>
    candidate.kind === kind && candidate.displayName === name && candidate.cached);
  if (!entry) return { status: 'miss' };
  const [capability] = await mintCapabilities([{ assetId: entry.assetId, purpose: 'image' }]);
  return capability
    ? { status: 'ok', url: capabilityContentUrl(capability), cached: true, constructed: false }
    : { status: 'miss' };
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString().replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
  } catch {
    return value.trim();
  }
}

async function assetId(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeUrl(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

function purposeOf(url: string): AssetCapabilityPurpose | null {
  const shape = assetShapeOf(url);
  return shape === 'other' ? null : shape;
}

/**
 * 两阶段资源装配：先收集并签发，再把 capability map 交给纯字符串重写器。
 * secured 模式任何缺项都留在 missing，由调用方 fail-closed 挂载。
 */
export async function prepareAssetCapabilities(html: string): Promise<PreparedAssetCapabilities> {
  const state = await authClient.initialize();
  if (state.phase === 'local-only') {
    return { mode: 'local-only', urls: new Map(), missing: [] };
  }
  const discovered = planResourceRewrite(html).report.entries;
  const candidates = new Map<string, { url: string; purpose: AssetCapabilityPurpose }>();
  const missing: string[] = [];
  for (const entry of discovered) {
    const purpose = purposeOf(entry.from);
    if (!purpose) {
      missing.push(entry.from);
      continue;
    }
    const id = await assetId(entry.from);
    candidates.set(`${id}:${purpose}`, { url: entry.from, purpose });
  }
  if (candidates.size === 0) {
    return { mode: 'secured', urls: new Map(), missing, secureContentSource: secureContentSource() };
  }
  const statusResponse = await authFetch(assetUrl('/api/assets/status'));
  const statusPayload: unknown = await statusResponse.json().catch(() => null);
  const knownIds = new Set(
    statusPayload && typeof statusPayload === 'object'
      && Array.isArray((statusPayload as { entries?: unknown }).entries)
      ? (statusPayload as { entries: unknown[] }).entries
        .filter(isPublicAssetDescriptor)
        .filter((entry) => entry.cached)
        .map((entry) => entry.assetId)
      : [],
  );
  for (const [key, candidate] of [...candidates]) {
    const id = key.slice(0, 24);
    if (!knownIds.has(id)) {
      candidates.delete(key);
      missing.push(candidate.url);
    }
  }
  if (candidates.size === 0) {
    return { mode: 'secured', urls: new Map(), missing, secureContentSource: secureContentSource() };
  }
  const requests = await Promise.all([...candidates.values()].map(async (entry) => ({
    assetId: await assetId(entry.url),
    purpose: entry.purpose,
  })));
  const capabilities = await mintCapabilities(requests);
  if (capabilities.length === 0) {
    return {
      mode: 'secured',
      urls: new Map(),
      missing: [...missing, ...[...candidates.values()].map((entry) => entry.url)],
      secureContentSource: secureContentSource(),
    };
  }
  const byKey = new Map<string, AssetCapability>(capabilities
    .map((capability) => [`${capability.assetId}:${capability.purpose}`, capability] as const));
  const urls = new Map<string, string>();
  for (const [key, candidate] of candidates) {
    const capability = byKey.get(key);
    if (!capability) {
      missing.push(candidate.url);
      continue;
    }
    urls.set(
      candidate.url,
      capabilityContentUrl(capability),
    );
  }
  return { mode: 'secured', urls, missing, secureContentSource: secureContentSource() };
}
