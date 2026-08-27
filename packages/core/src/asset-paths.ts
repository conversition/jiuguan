/**
 * core 包 - 资产路径与用户层（编辑器 P2：非只读）
 * 分层：源资产（剧本方案，只读） + 用户层（data/{presets,worldbooks}，编辑器写入）
 * 优先级：用户层 > 源资产（保存/加载统一走 resolveAsset）
 * 用户层目录可用 JG_USER_DATA_DIR 覆盖（测试隔离）。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { extractCharaFromPng, pngPayloadToJson } from './chara.ts';

export type AssetKind = 'preset' | 'worldbook' | 'card';

export const ASSET_BASE = 'E:/claude cade test/project/jiuguanlike/剧本方案';
export const ASSET_PRESET_DIR = resolve(ASSET_BASE, '预设');
export const ASSET_WORLDBOOK_DIR = resolve(ASSET_BASE, '世界书');
export const ASSET_CARD_DIR = resolve(ASSET_BASE, '角色卡');

export const USER_DATA_DIR = process.env.JG_USER_DATA_DIR
  ? resolve(process.env.JG_USER_DATA_DIR)
  : resolve(process.cwd(), 'data');
export const USER_PRESET_DIR = resolve(USER_DATA_DIR, 'presets');
export const USER_WORLDBOOK_DIR = resolve(USER_DATA_DIR, 'worldbooks');
export const USER_CARD_DIR = resolve(USER_DATA_DIR, 'cards');

export function assetDir(kind: AssetKind, user: boolean): string {
  if (kind === 'preset') return user ? USER_PRESET_DIR : ASSET_PRESET_DIR;
  if (kind === 'worldbook') return user ? USER_WORLDBOOK_DIR : ASSET_WORLDBOOK_DIR;
  return user ? USER_CARD_DIR : ASSET_CARD_DIR;
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
  if (basename(file) !== file) return false; // 防路径穿越（与 saveUserAsset 同规则）
  const user = resolve(assetDir(kind, true), file);
  if (!existsSync(user)) return false;
  rmSync(user, { force: true });
  return true;
}

/** 删除世界书（两层兜底）：优先删用户层副本，无用户层副本时删源层文件。
 *  历史导入曾把用户书直接落在源资产目录（剧本方案/世界书），source 被标为 asset，
 *  前端按 source==='user' 显示删除按钮导致按钮没有全覆盖；现按钮全覆盖，此处两层都可删。
 *  仅接受裸文件名（防路径穿越）；调用方须已做两步确认。 */
export function deleteWorldbookFile(file: string): { removed: boolean; layer: 'user' | 'asset' | null } {
  if (basename(file) !== file || !/^[^\\/]+\.json$/i.test(file)) return { removed: false, layer: null };
  const user = resolve(assetDir('worldbook', true), file);
  if (existsSync(user)) {
    rmSync(user, { force: true });
    return { removed: true, layer: 'user' };
  }
  const src = resolve(assetDir('worldbook', false), file);
  if (existsSync(src)) {
    rmSync(src, { force: true });
    return { removed: true, layer: 'asset' };
  }
  return { removed: false, layer: null };
}

/** 删除角色卡用户层副本（PNG 卡导入会同时落 .json + .png，须同基名一并删除；源资产只读不删） */
export function deleteUserCard(file: string): boolean {
  if (basename(file) !== file || !/^[^\\/]+\.(json|png)$/i.test(file)) return false; // 防路径穿越
  const base = file.replace(/\.(json|png)$/i, '');
  let removed = false;
  for (const ext of ['json', 'png']) {
    const p = resolve(USER_CARD_DIR, `${base}.${ext}`);
    if (existsSync(p)) { rmSync(p, { force: true }); removed = true; }
  }
  return removed;
}

/** 保存二进制到用户层（PNG 卡原件；文件名校验同 saveUserAsset） */
export function saveAssetBuffer(kind: AssetKind, file: string, buf: Buffer): string {
  if (basename(file) !== file || !/^[^\\/]+\.[a-zA-Z0-9]+$/.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  const dir = assetDir(kind, true);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, file);
  writeFileSync(target, buf);
  return target;
}

// ── 角色卡资产族（用户层 + PNG 元数据解包）──

export interface CardInfo { file: string; name: string; format: 'json' | 'png'; source: 'user' | 'asset' }

/** 解析卡文件路径（用户层优先；.json/.png 均可） */
export function resolveCard(file: string): { path: string; source: 'user' | 'asset'; format: 'json' | 'png' } | null {
  const isPng = file.toLowerCase().endsWith('.png');
  for (const user of [true, false]) {
    const p = resolve(assetDir('card', user), file);
    if (existsSync(p) && statSync(p).isFile()) return { path: p, source: user ? 'user' : 'asset', format: isPng ? 'png' : 'json' };
  }
  return null;
}

/** 角色卡 PNG 签名（8 字节）；假 PNG（如 JPEG 改名）无 chara 元数据，不可作卡 */
function isRealPng(path: string): boolean {
  try {
    const sig = readFileSync(path).subarray(0, 8);
    return sig.length === 8 && sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
  } catch { return false; }
}

/** 列出角色卡（源 + 用户，json + 真 png；假 PNG 过滤） */
export function listCards(sortByLatest = false): CardInfo[] {
  const seen = new Set<string>();
  const out: CardInfo[] = [];
  for (const user of [true, false]) {
    const dir = assetDir('card', user);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (lower.endsWith('.json')) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push({ file: f, name: f.replace(/\.json$/i, ''), format: 'json', source: user ? 'user' : 'asset' });
      } else if (lower.endsWith('.png')) {
        if (seen.has(f)) continue;
        const p = resolve(dir, f);
        if (!isRealPng(p)) continue; // 假 PNG（JPEG 改名）无 chara 元数据，不可作卡
        seen.add(f);
        out.push({ file: f, name: f.replace(/\.png$/i, ''), format: 'png', source: user ? 'user' : 'asset' });
      }
    }
  }
  return out;
}

/** 读取卡为 JSON 文本（PNG 自动解包 chara tEXt → base64 解码 → JSON） */
export function readCardText(file: string): { path: string; source: 'user' | 'asset'; raw: string; format: 'json' | 'png' } | null {
  const r = resolveCard(file);
  if (!r) return null;
  if (r.format === 'png') {
    const payload = extractCharaFromPng(readFileSync(r.path));
    if (!payload) throw new Error(`PNG 卡无 chara 元数据: ${file}`);
    return { path: r.path, source: r.source, format: 'png', raw: pngPayloadToJson(payload) };
  }
  return { path: r.path, source: r.source, format: 'json', raw: readFileSync(r.path, 'utf8') };
}
