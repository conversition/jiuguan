/**
 * GLA 资源名 → URL 解析（纯逻辑）
 * 解析优先序：manifest 同名精确匹配 → 命名规律构造（bg/sprite/cg 已知模式）→ miss。
 * bgm/audio/page/未知 menu → 无规律 → miss（展示层占位，不崩）。
 */
import type { AssetEntry, AssetKind } from './asset-types.ts';

/**
 * 可选的 GLA 资源 CDN 基址（bg/sprite/cg 目录命名规律的前缀）。
 * 公开版不内置任何私有图床；未配置该环境变量时只做清单匹配，不做 URL 构造。
 */
const CDN_BASE = (process.env.JG_GAL_ASSET_BASE ?? '').replace(/\/+$/u, '');

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
  // 2) 命名规律构造
  const crafted = craftAssetUrl(kind, name);
  if (crafted) return { url: crafted, constructed: true, cached: false };
  return { status: 'miss', kind, name };
}

/** 已知命名规律的资源 → 构造 URL；未配置 CDN 基址或未知 kind → null */
export function craftAssetUrl(kind: AssetKind, name: string): string | null {
  if (!CDN_BASE) return null;
  switch (kind) {
    case 'bg': return `${CDN_BASE}/bg/${name}.webp`;
    case 'sprite': return `${CDN_BASE}/sprite/${name}.webp`;
    case 'cg': return `${CDN_BASE}/cg/${name}.webp`;
    default: return null;
  }
}

/** 按 kind+name 精确查清单（菜单/常规资源用） */
export function findByKindName(entries: AssetEntry[], kind: AssetKind, name: string): AssetEntry | undefined {
  return entries.find((e) => e.kind === kind && e.name === name);
}