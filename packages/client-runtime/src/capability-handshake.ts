import {
  API_PROTOCOL_VERSION,
  isServerMeta,
  type ServerMeta,
} from '@jiuguan/mobile-contracts';
import {
  normalizeEndpoint,
  type NormalizeEndpointOptions,
  type NormalizedEndpoint,
} from './endpoint.ts';
import { ClientRuntimeError } from './errors.ts';
import {
  evaluateProtocolAccess,
  type ProtocolAccess,
} from './protocol-access.ts';

const MAX_CAPABILITIES_BYTES = 256 * 1024;

export type ClientFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CapabilityHandshakeOptions extends NormalizeEndpointOptions {
  endpoint: string | URL;
  fetchImpl: ClientFetch;
  /** ISO 时间由平台时钟适配器注入；运行层不读取 Date.now()。 */
  now: () => string;
  clientProtocol?: number;
  incompatiblePolicy?: 'reject' | 'read-only';
  expectedServerId?: string;
  signal?: AbortSignal;
}

export interface CapabilityHandshakeResult {
  endpoint: NormalizedEndpoint;
  meta: ServerMeta;
  receivedAt: string;
  access: ProtocolAccess;
}

function statusIsRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function aborted(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_CAPABILITIES_BYTES) {
      await reader.cancel();
      throw new ClientRuntimeError('invalid_server_meta');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handshakeCapabilities(
  options: CapabilityHandshakeOptions,
): Promise<CapabilityHandshakeResult> {
  const endpoint = normalizeEndpoint(options.endpoint, options);
  let response: Response;
  try {
    response = await options.fetchImpl(endpoint.capabilitiesUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal,
    });
  } catch (cause) {
    if (aborted(cause, options.signal)) {
      throw new ClientRuntimeError('request_aborted', { cause });
    }
    throw new ClientRuntimeError('capabilities_unavailable', {
      retryable: true,
      cause,
    });
  }

  if (!response.ok) {
    throw new ClientRuntimeError('capabilities_unavailable', {
      retryable: statusIsRetryable(response.status),
      details: { status: response.status },
    });
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPABILITIES_BYTES) {
    throw new ClientRuntimeError('invalid_server_meta');
  }
  const body = await readLimitedBody(response);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    throw new ClientRuntimeError('invalid_server_meta', { cause });
  }
  if (!isServerMeta(payload)) {
    throw new ClientRuntimeError('invalid_server_meta');
  }

  const clientProtocol = options.clientProtocol ?? API_PROTOCOL_VERSION;
  const access = evaluateProtocolAccess(payload, clientProtocol);
  if (access.mode === 'read-only' && options.incompatiblePolicy !== 'read-only') {
    throw new ClientRuntimeError('incompatible_protocol', {
      details: {
        clientProtocol,
        minClientProtocol: payload.api.minClientProtocol,
        maxClientProtocol: payload.api.maxClientProtocol,
      },
    });
  }
  if (options.expectedServerId !== undefined
    && options.expectedServerId !== payload.serverId) {
    throw new ClientRuntimeError('server_identity_mismatch', {
      details: {
        expectedServerId: options.expectedServerId,
        actualServerId: payload.serverId,
      },
    });
  }

  return Object.freeze({
    endpoint,
    meta: payload,
    receivedAt: options.now(),
    access,
  });
}
