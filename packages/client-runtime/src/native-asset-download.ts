import type { AssetDownloadFormat } from '@jiuguan/mobile-contracts';
import { ClientRuntimeError } from './errors.ts';
import type { ClientExecutionProfile } from './client-profile.ts';

export type NativeDownloadDestination = 'save' | 'share';
export type NativeDownloadProgressPhase = 'issuing' | 'downloading' | 'saving';

export interface NativeDownloadRequest {
  assetId: string;
  format: AssetDownloadFormat;
  destination: NativeDownloadDestination;
}

/** JS → native：不含 endpoint、Bearer、capability、文件名或任何路径。 */
export interface NativeDownloadStart extends NativeDownloadRequest {
  operationId: string;
}

export type NativeDownloadEvent =
  | {
      type: 'progress';
      operationId: string;
      phase: NativeDownloadProgressPhase;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      type: 'completed';
      operationId: string;
      filename: string;
      mediaType: 'application/json' | 'image/png';
      bytes: number;
    }
  | { type: 'cancelled'; operationId: string }
  | {
      type: 'failed';
      operationId: string;
      code: 'credential-unavailable' | 'network-error' | 'response-invalid' | 'save-failed';
    };

export type NativeDownloadFailureCode = Extract<NativeDownloadEvent, { type: 'failed' }>['code']
  | 'bridge-invalid-event'
  | 'bridge-failed';

export interface NativeAssetDownloadBridge {
  start(request: NativeDownloadStart): Promise<void>;
  cancel(operationId: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
}

export type NativeDownloadResult =
  | { status: 'succeeded'; filename: string; mediaType: 'application/json' | 'image/png'; bytes: number }
  | { status: 'cancelled' }
  | { status: 'failed'; code: NativeDownloadFailureCode };

export interface NativeDownloadHandle {
  readonly operationId: string;
  readonly done: Promise<NativeDownloadResult>;
  cancel(): Promise<void>;
}

export interface NativeAssetDownloadControllerOptions {
  profile: ClientExecutionProfile;
  bridge?: NativeAssetDownloadBridge;
  operationIdFactory: () => string;
  onProgress?: (event: Extract<NativeDownloadEvent, { type: 'progress' }>) => void;
}

interface ActiveOperation {
  lastReceived: number;
  totalBytes: number | null;
  resolve: (value: NativeDownloadResult) => void;
}

const OPERATION_ID_RE = /^fdl_[A-Za-z0-9_-]{16,80}$/;
const ASSET_ID_RE = /^[a-f0-9]{24}$/;
const SAFE_FILENAME_RE = /^[^\\/\u0000-\u001f\u007f]{1,240}$/;
const FAILURE_CODES = new Set(['credential-unavailable', 'network-error', 'response-invalid', 'save-failed']);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseEvent(value: unknown): NativeDownloadEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.operationId !== 'string' || !OPERATION_ID_RE.test(row.operationId)) return null;
  if (row.type === 'progress') {
    if (!exactKeys(row, ['type', 'operationId', 'phase', 'receivedBytes', 'totalBytes'])
      || (row.phase !== 'issuing' && row.phase !== 'downloading' && row.phase !== 'saving')
      || !nonNegativeInteger(row.receivedBytes)
      || !nonNegativeInteger(row.totalBytes)
      || row.totalBytes < 1
      || row.receivedBytes > row.totalBytes) return null;
    return row as unknown as NativeDownloadEvent;
  }
  if (row.type === 'completed') {
    if (!exactKeys(row, ['type', 'operationId', 'filename', 'mediaType', 'bytes'])
      || typeof row.filename !== 'string'
      || !SAFE_FILENAME_RE.test(row.filename)
      || (row.mediaType !== 'application/json' && row.mediaType !== 'image/png')
      || !nonNegativeInteger(row.bytes)
      || row.bytes < 1) return null;
    return row as unknown as NativeDownloadEvent;
  }
  if (row.type === 'cancelled') {
    return exactKeys(row, ['type', 'operationId']) ? row as unknown as NativeDownloadEvent : null;
  }
  if (row.type === 'failed') {
    return exactKeys(row, ['type', 'operationId', 'code'])
      && typeof row.code === 'string' && FAILURE_CODES.has(row.code)
      ? row as unknown as NativeDownloadEvent
      : null;
  }
  return null;
}

function validRequest(value: NativeDownloadRequest): boolean {
  return ASSET_ID_RE.test(value.assetId)
    && (value.format === 'json' || value.format === 'png')
    && (value.destination === 'save' || value.destination === 'share');
}

export class NativeAssetDownloadController {
  readonly #bridge: NativeAssetDownloadBridge;
  readonly #operationIdFactory: () => string;
  readonly #onProgress?: NativeAssetDownloadControllerOptions['onProgress'];
  readonly #active = new Map<string, ActiveOperation>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(options: NativeAssetDownloadControllerOptions) {
    if (options.profile.assetDownloadMode !== 'native-required' || !options.bridge) {
      throw new ClientRuntimeError('native_file_adapter_unavailable');
    }
    this.#bridge = options.bridge;
    this.#operationIdFactory = options.operationIdFactory;
    this.#onProgress = options.onProgress;
    this.#unsubscribe = this.#bridge.subscribe((event) => this.#receive(event));
  }

  start(request: NativeDownloadRequest): NativeDownloadHandle {
    if (this.#disposed) throw new ClientRuntimeError('native_file_adapter_unavailable');
    if (!validRequest(request)) {
      throw new ClientRuntimeError('transport_violation', { details: { reason: 'invalid-native-download-request' } });
    }
    const operationId = this.#operationIdFactory();
    if (!OPERATION_ID_RE.test(operationId) || this.#active.has(operationId)) {
      throw new ClientRuntimeError('transport_violation', { details: { reason: 'invalid-native-operation-id' } });
    }
    let settle!: (value: NativeDownloadResult) => void;
    const done = new Promise<NativeDownloadResult>((resolve) => { settle = resolve; });
    this.#active.set(operationId, { lastReceived: 0, totalBytes: null, resolve: settle });
    const outbound: NativeDownloadStart = { operationId, ...request };
    void this.#bridge.start(outbound).catch(() => {
      this.#settle(operationId, { status: 'failed', code: 'bridge-failed' });
    });
    return {
      operationId,
      done,
      cancel: async () => {
        if (!this.#active.has(operationId)) return;
        try { await this.#bridge.cancel(operationId); }
        catch { this.#settle(operationId, { status: 'failed', code: 'bridge-failed' }); }
      },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    for (const operationId of [...this.#active.keys()]) {
      this.#settle(operationId, { status: 'cancelled' });
      void this.#bridge.cancel(operationId).catch(() => {});
    }
  }

  #settle(operationId: string, result: NativeDownloadResult): void {
    const operation = this.#active.get(operationId);
    if (!operation) return;
    this.#active.delete(operationId);
    operation.resolve(result);
  }

  #receive(raw: unknown): void {
    const hintedId = raw && typeof raw === 'object' && !Array.isArray(raw)
      && typeof (raw as { operationId?: unknown }).operationId === 'string'
      ? (raw as { operationId: string }).operationId
      : null;
    if (!hintedId || !this.#active.has(hintedId)) return;
    const event = parseEvent(raw);
    if (!event) {
      this.#settle(hintedId, { status: 'failed', code: 'bridge-invalid-event' });
      return;
    }
    const operation = this.#active.get(event.operationId)!;
    if (event.type === 'progress') {
      if ((operation.totalBytes !== null && operation.totalBytes !== event.totalBytes)
        || event.receivedBytes < operation.lastReceived) {
        this.#settle(event.operationId, { status: 'failed', code: 'bridge-invalid-event' });
        return;
      }
      operation.totalBytes = event.totalBytes;
      operation.lastReceived = event.receivedBytes;
      this.#onProgress?.(event);
      return;
    }
    if (event.type === 'completed') {
      if (operation.totalBytes !== null && event.bytes !== operation.totalBytes) {
        this.#settle(event.operationId, { status: 'failed', code: 'bridge-invalid-event' });
      } else {
        this.#settle(event.operationId, {
          status: 'succeeded', filename: event.filename, mediaType: event.mediaType, bytes: event.bytes,
        });
      }
      return;
    }
    if (event.type === 'cancelled') this.#settle(event.operationId, { status: 'cancelled' });
    else this.#settle(event.operationId, { status: 'failed', code: event.code });
  }
}
