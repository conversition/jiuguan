/**
 * 从角色卡原始内容构建资产索引（纯逻辑，不联网不落盘）
 * 来源两大类：
 *   1) 深层扫描卡 JSON 的所有字符串叶子里的 https URL（TavernHelper_scripts 的"资源预载"数据、
 *      regex 规则的 replaceString 外联图/字体等），按 host/目录分类；
 *   2) （可选）由 GLA 场景解析收集的"期望资产名"并入——resolve 阶段按命名规律构造即可，无需预收录。
 * 同 URL 去重（Map<url, entry> 保首次来源卡）。
 */
import { createHash } from 'node:crypto';
import type { AssetEntry, AssetKind } from './asset-types.ts';

const URL_RE = /https?:\/\/[^\s]+/g;
/** 尾部装饰字符（JSON 串相邻标点/括号），截掉再入索引 */
const TRAIL_RE = /[)\]},;'"]+$/;

export function normalizeUrl(url: string): string {
  return url.trim().replace(TRAIL_RE, '');
}

export function assetId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

export function classifyAsset(url: string): AssetKind {
  const u = url.toLowerCase();
  const ext = (u.split('?')[0].split('/').pop() ?? '').split('.').pop() ?? '';
  if (['mp3', 'ogg', 'm4a', 'wav', 'flac', 'aac', 'opus'].includes(ext)) return 'audio';
  if (u.includes('.html') || u.includes('index.html')) return 'page';
  if (u.includes('/menu/')) return 'menu';
  if (u.includes('/bg/')) return 'bg';
  if (u.includes('/sprite/')) return 'sprite';
  if (u.includes('/cg/')) return 'cg';
  return 'generic';
}

/** 资源名 = 去扩展名 basename（utf8 安全：URL 里中文为原始字符，%XX 编码可解） */
export function entryName(url: string): string {
  const seg = (url.split('?')[0].split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '');
  try { return decodeURIComponent(seg); } catch { return seg; }
}

function collectFromString(str: string, out: Map<string, AssetEntry>, sourceCard?: string): void {
  for (const raw of str.matchAll(URL_RE)) {
    const url = normalizeUrl(raw[0]);
    // '| 描述'-style 里的占位 / 裸 'http://' 无路径 跳过
    if (!url || !/^https?:\/\/[^/]+/.test(url)) continue;
    if (out.has(url)) continue;
    const kind = classifyAsset(url);
    out.set(url, {
      id: assetId(url),
      url,
      kind,
      name: entryName(url),
      sourceCard,
      cached: false,
      addedAt: new Date().toISOString(),
    });
  }
}

function walk(o: unknown, out: Map<string, AssetEntry>, sourceCard?: string): void {
  if (typeof o === 'string') { collectFromString(o, out, sourceCard); return; }
  if (Array.isArray(o)) { for (const v of o) walk(v, out, sourceCard); return; }
  if (o && typeof o === 'object') { for (const v of Object.values(o)) walk(v, out, sourceCard); }
}

export function buildAssetIndex(cardText: string, sourceCard?: string): AssetEntry[] {
  const out = new Map<string, AssetEntry>();
  try {
    const parsed: unknown = JSON.parse(cardText);
    walk(parsed, out, sourceCard);
  } catch {
    // 非 JSON（如纯文本/png 提取串）：直接全文扫描
    collectFromString(cardText, out, sourceCard);
  }
  return [...out.values()];
}

export function countByKind(entries: AssetEntry[]): Record<AssetKind, number> {
  const counts = { bg: 0, sprite: 0, menu: 0, cg: 0, audio: 0, page: 0, generic: 0 } as Record<AssetKind, number>;
  for (const e of entries) counts[e.kind]++;
  return counts;
}