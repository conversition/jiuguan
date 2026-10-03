export interface FileTransferCapabilities {
  version: number;
  maxImportBytes: number;
  streamingUpload: boolean;
  resumableUpload: boolean;
  authenticatedDownload?: boolean;
  downloadGrantPath?: '/api/assets/download-capabilities';
  downloadPathTemplate?: '/api/assets/download/{assetId}/{format}';
}

/** 服务端资产元数据。显示名永远不能直接用作磁盘路径。 */
export interface AssetMetadata {
  id: string;
  displayName: string;
  mediaType: string;
  size: number;
  contentHash: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export const LOCAL_ASSET_KINDS = ['card', 'preset', 'worldbook'] as const;
export type LocalAssetKind = (typeof LOCAL_ASSET_KINDS)[number];

/**
 * 本地创作资产跨端投影。storageKey、磁盘路径和旧文件名不属于稳定协议。
 * 这里的 assetId 与下方 URL 媒体缓存的 PublicAssetDescriptor.assetId 分属不同路由命名空间。
 */
export interface LocalAssetDescriptor {
  assetId: string;
  kind: LocalAssetKind;
  displayName: string;
  source: 'user' | 'asset';
  revision: string;
}

/** P8-02 流式上传成功后的严格公开结果；不包含客户端 filename 或服务端 storageKey。 */
export interface LocalAssetImportResult extends LocalAssetDescriptor {
  format: 'json' | 'png';
  bytes: number;
  embeddedWorldbook?: {
    count: number;
    displayName: string;
  };
}

export const PUBLIC_ASSET_KINDS = [
  'bg', 'sprite', 'menu', 'cg', 'audio', 'page', 'generic',
] as const;
export type PublicAssetKind = (typeof PUBLIC_ASSET_KINDS)[number];

/**
 * 远程资产公开投影。源 URL、query、签名参数与本机缓存路径永远不属于此 DTO。
 */
export interface PublicAssetDescriptor {
  assetId: string;
  kind: PublicAssetKind;
  displayName: string;
  cached: boolean;
  bytes?: number;
  sourceCard?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isLocalAssetDescriptor(value: unknown): value is LocalAssetDescriptor {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['assetId', 'kind', 'displayName', 'source', 'revision'], [])) {
    return false;
  }
  return typeof value.assetId === 'string'
    && /^[a-f0-9]{24}$/.test(value.assetId)
    && typeof value.kind === 'string'
    && (LOCAL_ASSET_KINDS as readonly string[]).includes(value.kind)
    && isSafeLabel(value.displayName)
    && (value.source === 'user' || value.source === 'asset')
    && typeof value.revision === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(value.revision);
}

export function isLocalAssetImportResult(value: unknown): value is LocalAssetImportResult {
  if (!isPlainRecord(value)
    || !hasExactKeys(value,
      ['assetId', 'kind', 'displayName', 'source', 'revision', 'format', 'bytes'],
      ['embeddedWorldbook'])) {
    return false;
  }
  const descriptor = {
    assetId: value.assetId,
    kind: value.kind,
    displayName: value.displayName,
    source: value.source,
    revision: value.revision,
  };
  const embedded = value.embeddedWorldbook;
  return isLocalAssetDescriptor(descriptor)
    && (value.format === 'json' || value.format === 'png')
    && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) > 0
    && (embedded === undefined
      || (isPlainRecord(embedded)
        && hasExactKeys(embedded, ['count', 'displayName'], [])
        && Number.isSafeInteger(embedded.count)
        && Number(embedded.count) > 0
        && isSafeLabel(embedded.displayName)));
}

/** 严格验证跨端公开投影；拒绝 URL、本机路径与任何额外秘密字段。 */
export function isPublicAssetDescriptor(value: unknown): value is PublicAssetDescriptor {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['assetId', 'kind', 'displayName', 'cached'], ['bytes', 'sourceCard'])) {
    return false;
  }
  return typeof value.assetId === 'string'
    && /^[a-f0-9]{24}$/.test(value.assetId)
    && typeof value.kind === 'string'
    && (PUBLIC_ASSET_KINDS as readonly string[]).includes(value.kind)
    && isSafeLabel(value.displayName)
    && typeof value.cached === 'boolean'
    && (value.bytes === undefined
      || (Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0))
    && (value.sourceCard === undefined || isSafeLabel(value.sourceCard));
}

/** Web 与 Android 壳之间的能力协商，不在共享 UI 中直接引用 Capacitor。 */
export interface ClientFileCapabilities {
  pickFiles: boolean;
  saveFile: boolean;
  shareFile: boolean;
}
