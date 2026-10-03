/**
 * GLA 资源名 → URL 解析（纯逻辑）
 * 解析优先序：用户覆盖 → manifest 同名精确匹配 → miss。
 * 公开版不猜测第三方 CDN；未声明资源由展示层占位，不崩溃。
 */
import type { AssetEntry, AssetKind } from './asset-types.ts';

export function resolveGalUrl(
  kind: AssetKind,
  name: string,
  entries: AssetEntry[],
  overrides?: Record<string, string>,
): { url: string; constructed: boolean; cached: boolean } | { status: 'miss'; kind: AssetKind; name: string } {
  // 0) 用户/脚本真源覆盖（键 kind:name）
  if (overrides) {
    const o = overrides[`${kind}:${name}`] ?? overrides[name];
    if (typeof o === 'string' && o) return { url: o, constructed: false, cached: false };
  }
  // 1) 清单同名精确匹配
  const hit = entries.find((e) => e.kind === kind && e.name === name && e.url);
  if (hit) return { url: hit.url, constructed: false, cached: hit.cached };
  return { status: 'miss', kind, name };
}

/** 按 kind+name 精确查清单（菜单/常规资源用） */
export function findByKindName(entries: AssetEntry[], kind: AssetKind, name: string): AssetEntry | undefined {
  return entries.find((e) => e.kind === kind && e.name === name);
}
