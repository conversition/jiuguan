import type { PairRequest } from '../../../packages/mobile-contracts/src/index.ts';
import type { NativeDownloadEvent, NativeDownloadStart } from '../../../packages/client-runtime/src/index.ts';

export interface NativeHttpResult {
  readonly status: number;
  readonly body: string;
  readonly bodyEncoding?: 'utf8' | 'base64';
  readonly headers?: Record<string, string>;
}

/** 由 bundled mobile-bootstrap 注入；共享 UI 不 import 或探测 Capacitor。 */
export interface JiuguanPlatformBridge {
  readonly profile: 'android-bundled';
  request(input: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    authenticated: boolean;
    responseType?: 'text' | 'base64';
  }): Promise<NativeHttpResult>;
  pair(request: PairRequest): Promise<void>;
  clearCredential(): Promise<void>;
  shareText(input: { title?: string; text: string }): Promise<void>;
  pickFile(input: { mime?: string }): Promise<{ name: string; mime?: string; size: number; base64: string } | undefined>;
  saveFile(input: { name: string; mime: string; base64: string }): Promise<{ saved: boolean } | undefined>;
  startAssetDownload(input: NativeDownloadStart): Promise<void>;
  cancelAssetDownload(operationId: string): Promise<void>;
  subscribeAssetDownload(listener: (event: NativeDownloadEvent) => void): () => void;
  networkState(): Promise<{ connected: boolean }>;
  exitToBackground(): Promise<void>;
  addListener(eventName: 'backButton' | 'appStateChange' | 'networkStatusChange', listener: (event: unknown) => void): Promise<{ remove(): Promise<void> }>;
}

declare global {
  interface Window {
    __JG_PLATFORM_BRIDGE__?: JiuguanPlatformBridge;
  }
}

export function requirePlatformBridge(): JiuguanPlatformBridge {
  const bridge = typeof window === 'undefined' ? undefined : window.__JG_PLATFORM_BRIDGE__;
  if (!bridge || bridge.profile !== 'android-bundled') {
    throw new Error('Android 原生安全桥不可用；拒绝降级为浏览器凭据存储');
  }
  return bridge;
}

export function nativeResultResponse(result: NativeHttpResult): Response {
  const body = result.bodyEncoding === 'base64'
    ? Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0))
    : result.body;
  return new Response(body, {
    status: result.status,
    headers: result.headers ?? {},
  });
}
