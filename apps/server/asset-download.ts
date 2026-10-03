import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AssetDownloadFormat } from '../../packages/mobile-contracts/src/index.ts';
import type { LocalAssetIdentity } from '../../packages/core/src/asset-identity.ts';
import {
  readRevisionedAsset,
  readRevisionedCard,
  resolveCard,
} from '../../packages/core/src/asset-paths.ts';
import { buildCharaPng } from '../../packages/core/src/chara.ts';

const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface PreparedAssetDownload {
  assetId: string;
  format: AssetDownloadFormat;
  filename: string;
  mediaType: 'application/json' | 'image/png';
  body: Buffer;
  targetDigest: string;
}

function trimCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join('');
}

function safeBaseName(value: string): string {
  const normalized = value.normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '')
    .trim();
  const bounded = trimCodePoints(normalized || 'asset', 120);
  return WINDOWS_RESERVED.test(bounded) ? `asset-${bounded}` : bounded;
}

function asciiFallback(base: string, extension: 'json' | 'png'): string {
  let ascii = base.normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[-_. ]+|[-_. ]+$/g, '')
    .slice(0, 100);
  if (!ascii) ascii = 'asset';
  if (WINDOWS_RESERVED.test(ascii)) ascii = `asset-${ascii}`;
  return `${ascii}.${extension}`;
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDisposition(displayName: string, format: AssetDownloadFormat): string {
  const extension = format;
  const withoutKnownExtension = displayName.replace(/\.(?:json|png)$/i, '');
  const unicodeName = `${safeBaseName(withoutKnownExtension)}.${extension}`;
  return `attachment; filename="${asciiFallback(withoutKnownExtension, extension)}"; filename*=UTF-8''${rfc5987(unicodeName)}`;
}

export function prepareAssetDownload(
  identity: LocalAssetIdentity,
  format: AssetDownloadFormat,
): PreparedAssetDownload | null {
  let body: Buffer;
  let mediaType: PreparedAssetDownload['mediaType'];
  if (identity.kind === 'card') {
    const card = readRevisionedCard(identity.storageKey);
    if (!card) return null;
    if (format === 'json') {
      body = Buffer.from(card.raw, 'utf8');
      mediaType = 'application/json';
    } else {
      const pngKey = identity.storageKey.replace(/\.json$/i, '.png');
      const original = resolveCard(pngKey);
      body = original?.format === 'png' ? readFileSync(original.path) : buildCharaPng(card.raw);
      mediaType = 'image/png';
    }
  } else {
    if (format !== 'json') return null;
    const asset = readRevisionedAsset(identity.kind, identity.storageKey);
    if (!asset) return null;
    body = Buffer.from(asset.raw, 'utf8');
    mediaType = 'application/json';
  }
  if (body.length < 1 || body.length > MAX_DOWNLOAD_BYTES) return null;
  const targetDigest = createHash('sha256')
    .update('jiuguan-local-download-v1\0')
    .update(identity.assetId)
    .update('\0')
    .update(format)
    .update('\0')
    .update(body)
    .digest('hex');
  const disposition = contentDisposition(identity.displayName, format);
  const encodedName = /filename\*=UTF-8''([^;]+)$/.exec(disposition)?.[1] ?? `asset.${format}`;
  return {
    assetId: identity.assetId,
    format,
    filename: decodeURIComponent(encodedName),
    mediaType,
    body,
    targetDigest,
  };
}
