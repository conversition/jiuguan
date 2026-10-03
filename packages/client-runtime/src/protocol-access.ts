import {
  API_PROTOCOL_VERSION,
  isProtocolCompatible,
  type ServerMeta,
} from '@jiuguan/mobile-contracts';
import type { ClientAuthTransport } from './auth-transport.ts';
import { ClientRuntimeError } from './errors.ts';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

export type ProtocolAccess =
  | {
      mode: 'read-write';
      clientProtocol: number;
      serverProtocol: number;
    }
  | {
      mode: 'read-only';
      clientProtocol: number;
      serverProtocol: number;
      minClientProtocol: number;
      maxClientProtocol: number;
      upgrade: 'client' | 'server';
    };

export function evaluateProtocolAccess(
  meta: ServerMeta,
  clientProtocol: number = API_PROTOCOL_VERSION,
): ProtocolAccess {
  if (!Number.isInteger(clientProtocol) || clientProtocol < 1) {
    throw new ClientRuntimeError('incompatible_protocol', {
      details: { clientProtocol },
    });
  }
  if (isProtocolCompatible(clientProtocol, meta.api)) {
    return Object.freeze({
      mode: 'read-write',
      clientProtocol,
      serverProtocol: meta.api.protocolVersion,
    });
  }
  return Object.freeze({
    mode: 'read-only',
    clientProtocol,
    serverProtocol: meta.api.protocolVersion,
    minClientProtocol: meta.api.minClientProtocol,
    maxClientProtocol: meta.api.maxClientProtocol,
    upgrade: clientProtocol < meta.api.minClientProtocol ? 'client' : 'server',
  });
}

export function createProtocolGuardTransport(
  transport: ClientAuthTransport,
  access: ProtocolAccess,
): ClientAuthTransport {
  return Object.freeze({
    kind: transport.kind,
    endpoint: transport.endpoint,
    async execute(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const method = String(
        init?.method ?? (input instanceof Request ? input.method : 'GET'),
      ).toUpperCase();
      if (access.mode === 'read-only' && !READ_ONLY_METHODS.has(method)) {
        throw new ClientRuntimeError('incompatible_protocol', {
          details: {
            clientProtocol: access.clientProtocol,
            minClientProtocol: access.minClientProtocol,
            maxClientProtocol: access.maxClientProtocol,
            method,
          },
        });
      }
      return transport.execute(input, init);
    },
  });
}
