/**
 * 资产类型定义（packages/assets）
 * AssetEntry 描述"发现于某张角色卡的远端资源"；AssetManifest 是磁盘缓存索引（data/assets/manifest.json）。
 */

export type AssetKind = 'bg' | 'sprite' | 'menu' | 'cg' | 'audio' | 'page' | 'generic';

export interface AssetEntry {
  /** 内容寻址 ID：sha256(规范化 URL).slice(0,24) */
  id: string;
  url: string;
  kind: AssetKind;
  /** 资源名（去扩展名 basename；sprite 即"角色+服装+表情" concat，可直接回填 [show]/[alter]） */
  name: string;
  /** 从哪张卡发现（首次发现的卡 id，可多卡共享） */
  sourceCard?: string;
  cached: boolean;
  bytes?: number;
  failed?: string;
  addedAt: string;
}

export interface AssetManifest {
  version: 1;
  entries: AssetEntry[];
  scannedAt: string;
  /** 命名覆盖通道（用户/未来脚本填写 CG/BGM 等无清单资源的真源；键 = `kind:name`） */
  overrides: Record<string, string>;
}

export function emptyManifest(): AssetManifest {
  return { version: 1, entries: [], scannedAt: new Date().toISOString(), overrides: {} };
}