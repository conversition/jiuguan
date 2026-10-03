import {
  isAssetDownloadGrant,
  type AssetDownloadFormat,
} from '../../../packages/mobile-contracts/src/index.ts';
import { NativeAssetDownloadController } from '../../../packages/client-runtime/src/index.ts';
import { authFetch, publicAssetFetch } from './authClient.ts';
import { downloadBytes } from './filetools.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';
import { requirePlatformBridge } from './platformBridge.ts';

const WEB_DOWNLOAD_LIMIT = 32 * 1024 * 1024;

export async function downloadLocalAsset(assetId: string, format: AssetDownloadFormat): Promise<void> {
  if (WEB_CLIENT_PROFILE.assetDownloadMode === 'native-required') {
    const bridge = requirePlatformBridge();
    const controller = new NativeAssetDownloadController({
      profile: WEB_CLIENT_PROFILE,
      bridge: {
        start: bridge.startAssetDownload,
        cancel: bridge.cancelAssetDownload,
        subscribe: bridge.subscribeAssetDownload,
      },
      operationIdFactory: () => `fdl_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    try {
      const result = await controller.start({ assetId, format, destination: 'save' }).done;
      if (result.status === 'cancelled') return;
      if (result.status === 'failed') throw new Error(`原生资产下载失败：${result.code}`);
      return;
    } finally {
      controller.dispose();
    }
  }
  const issued = await authFetch('/api/assets/download-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId, format }),
  });
  const payload: unknown = await issued.json().catch(() => null);
  const grant = payload && typeof payload === 'object'
    ? (payload as { download?: unknown }).download
    : null;
  if (!issued.ok || !isAssetDownloadGrant(grant)) {
    throw new Error('无法签发安全下载');
  }
  if (grant.bytes > WEB_DOWNLOAD_LIMIT) throw new Error('文件超过 Web 下载上限');
  const path = `/api/assets/download/${grant.assetId}/${grant.format}?cap=${encodeURIComponent(grant.capability)}`;
  const response = await publicAssetFetch(path, {
    method: 'GET',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: grant.mediaType },
  });
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (!response.ok || declared !== grant.bytes || declared > WEB_DOWNLOAD_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new Error('安全下载失败');
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== grant.mediaType) {
    await response.body?.cancel().catch(() => {});
    throw new Error('下载内容类型不匹配');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== grant.bytes) throw new Error('下载长度不匹配');
  downloadBytes(grant.filename, bytes, grant.mediaType);
}
