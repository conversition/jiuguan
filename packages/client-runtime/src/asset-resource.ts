import type { AssetCapabilityPurpose } from '@jiuguan/mobile-contracts';
import type { ApiClient, ApiClientResult } from './api-client.ts';
import { ClientRuntimeError } from './errors.ts';
import type { ClientUrlResolver } from './url-resolver.ts';

const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024;

export interface ObjectUrlAdapter {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface AuthenticatedAssetObjectUrl {
  readonly url: string;
  readonly mediaType: string;
  readonly bytes: number;
  dispose(): void;
}

export interface AuthenticatedAssetObjectUrlOptions {
  apiClient: Pick<ApiClient, 'request'>;
  urlResolver: ClientUrlResolver;
  /** 必须位于 /api/assets scope；不得是任意或跨源 URL。 */
  path: string;
  purpose: AssetCapabilityPurpose;
  objectUrls: ObjectUrlAdapter;
  maxBytes?: number;
  signal?: AbortSignal;
}

function positiveMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('maxBytes 必须是正整数');
  }
  return value;
}

function mediaTypeOf(response: Response): string {
  return (response.headers.get('content-type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
}

function mediaTypeMatches(purpose: AssetCapabilityPurpose, mediaType: string): boolean {
  if (purpose === 'download') return false;
  if (purpose === 'image') return mediaType.startsWith('image/');
  if (purpose === 'audio') return mediaType.startsWith('audio/');
  if (purpose === 'video') return mediaType.startsWith('video/');
  if (purpose === 'font') return mediaType.startsWith('font/')
    || mediaType === 'application/font-woff'
    || mediaType === 'application/font-woff2'
    || mediaType === 'application/vnd.ms-fontobject';
  if (purpose === 'style') return mediaType === 'text/css';
  return mediaType === 'text/javascript'
    || mediaType === 'application/javascript'
    || mediaType === 'application/ecmascript'
    || mediaType === 'text/ecmascript';
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

async function readBounded(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await cancelBody(response);
    throw new ClientRuntimeError('asset_resource_too_large', {
      details: { maxBytes, declaredBytes: Number(declared) },
    });
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ClientRuntimeError('asset_resource_too_large', {
          details: { maxBytes, receivedBytes: total },
        });
      }
      const copy = new Uint8Array(part.value.byteLength);
      copy.set(part.value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * 备用子资源通道：用 ApiClient 完成带 Cookie/Bearer 的 GET，再把响应转为短寿命 blob URL。
 * 调用方必须在组件卸载或替换资源时调用 dispose；长期凭据不会进入返回 URL。
 */
export async function loadAuthenticatedAssetObjectUrl(
  options: AuthenticatedAssetObjectUrlOptions,
): Promise<AuthenticatedAssetObjectUrl> {
  const maxBytes = positiveMaxBytes(options.maxBytes ?? DEFAULT_MAX_OBJECT_BYTES);
  const target = options.urlResolver.asset(options.path);
  let result: ApiClientResult;
  try {
    result = await options.apiClient.request(target, {
      method: 'GET',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof ClientRuntimeError) throw cause;
    throw new ClientRuntimeError('asset_resource_unavailable', { cause });
  }
  const response = result.response;
  if (!response.ok) {
    await cancelBody(response);
    throw new ClientRuntimeError('asset_resource_unavailable', {
      retryable: response.status >= 500,
      details: { status: response.status, requestId: result.requestId },
    });
  }
  const mediaType = mediaTypeOf(response);
  if (!mediaTypeMatches(options.purpose, mediaType)) {
    await cancelBody(response);
    throw new ClientRuntimeError('asset_media_type_mismatch', {
      details: { purpose: options.purpose, mediaType: mediaType || 'missing' },
    });
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await readBounded(response, maxBytes);
  } catch (cause) {
    if (cause instanceof ClientRuntimeError) throw cause;
    throw new ClientRuntimeError('asset_resource_unavailable', {
      retryable: true,
      details: { requestId: result.requestId },
      cause,
    });
  }
  const blob = new Blob([bytes], { type: mediaType });
  let url: string;
  try {
    url = options.objectUrls.createObjectURL(blob);
  } catch (cause) {
    throw new ClientRuntimeError('asset_resource_unavailable', { cause });
  }
  if (!url.startsWith('blob:')) {
    try { options.objectUrls.revokeObjectURL(url); } catch { /* best effort */ }
    throw new ClientRuntimeError('transport_violation', {
      details: { reason: 'invalid-object-url' },
    });
  }
  let disposed = false;
  return Object.freeze({
    url,
    mediaType,
    bytes: bytes.byteLength,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try { options.objectUrls.revokeObjectURL(url); } catch { /* cleanup is best effort */ }
    },
  });
}
