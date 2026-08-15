/**
 * core 包 - 资产路径与用户层（编辑器 P2：非只读）
 * 分层：源资产（剧本方案，只读） + 用户层（data/{presets,worldbooks}，编辑器写入）
 * 优先级：用户层 > 源资产（保存/加载统一走 resolveAsset）
 * 用户层目录可用 JG_USER_DATA_DIR 覆盖（测试隔离）。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export type AssetKind = 'preset' | 'worldbook';

export const ASSET_BASE = 'E:/claude cade test/project/jiuguanlike/剧本方案';
export const ASSET_PRESET_DIR = resolve(ASSET_BASE, '预设');
export const ASSET_WORLDBOOK_DIR = resolve(ASSET_BASE, '世界书');

export const USER_DATA_DIR = process.env.JG_USER_DATA_DIR
  ? resolve(process.env.JG_USER_DATA_DIR)
  : resolve(process.cwd(), 'data');
export const USER_PRESET_DIR = resolve(USER_DATA_DIR, 'presets');
export const USER_WORLDBOOK_DIR = resolve(USER_DATA_DIR, 'worldbooks');

export function assetDir(kind: AssetKind, user: boolean): string {
  if (kind === 'preset') return user ? USER_PRESET_DIR : ASSET_PRESET_DIR;
  return user ? USER_WORLDBOOK_DIR : ASSET_WORLDBOOK_DIR;
}

/** 解析资产文件路径（用户层优先；返回 {path, source} 或 null） */
export function resolveAsset(kind: AssetKind, file: string): { path: string; source: 'user' | 'asset' } | null {
  const user = resolve(assetDir(kind, true), file);
  if (existsSync(user) && statSync(user).isFile()) return { path: user, source: 'user' };
  const src = resolve(assetDir(kind, false), file);
  if (existsSync(src) && statSync(src).isFile()) return { path: src, source: 'asset' };
  return null;
}

/** 列出资产（用户层在前 + source 标记；重名用户层覆盖源） */
export function listAssets(kind: AssetKind): { file: string; name: string; source: 'user' | 'asset' }[] {
  const seen = new Set<string>();
  const out: { file: string; name: string; source: 'user' | 'asset' }[] = [];
  for (const user of [true, false]) {
    const dir = assetDir(kind, user);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ file: f, name: f.replace(/\.json$/, ''), source: user ? 'user' : 'asset' });
    }
  }
  return out;
}

/** 读取资产 JSON 文本（用户层优先） */
export function readAsset(kind: AssetKind, file: string): { path: string; source: 'user' | 'asset'; raw: string } | null {
  const r = resolveAsset(kind, file);
  if (!r) return null;
  return { path: r.path, source: r.source, raw: readFileSync(r.path, 'utf8') };
}

/** 保存到用户层（编辑器写入；返回落盘路径） */
export function saveUserAsset(kind: AssetKind, file: string, json: string): string {
  if (basename(file) !== file || !/^[^\\/]+\.[a-zA-Z0-9]+$/.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  const dir = assetDir(kind, true);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, file);
  writeFileSync(target, json, 'utf8');
  return target;
}

/** 删除用户层副本（恢复源资产）；无用户层副本返回 false */
export function deleteUserAsset(kind: AssetKind, file: string): boolean {
  const user = resolve(assetDir(kind, true), file);
  if (!existsSync(user)) return false;
  rmSync(user, { force: true });
  return true;
}
