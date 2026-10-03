import {
  createServer,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createCommandCodeStandaloneAdapter,
  type CommandCodeStandaloneAdapter,
} from './adapter.ts';
import type { CommandCodeStandaloneConfig } from './config.ts';
import type { CommandCodeRuntime } from '../../../packages/commandcode-runtime/src/index.ts';

export type CommandCodeStandaloneServicePhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'draining'
  | 'disposed';

export interface CommandCodeStandaloneServiceOptions {
  readonly runtime: CommandCodeRuntime;
  readonly config: CommandCodeStandaloneConfig;
  /** Test seam; production callers must keep the configured loopback host/port. */
  readonly listenPort?: number;
  readonly adapter?: CommandCodeStandaloneAdapter;
}

export interface CommandCodeStandaloneServiceSnapshot {
  readonly phase: CommandCodeStandaloneServicePhase;
  readonly listening: boolean;
  readonly activeRequests: number;
}

export interface CommandCodeStandaloneService {
  start(): Promise<Readonly<AddressInfo>>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): Readonly<CommandCodeStandaloneServiceSnapshot>;
}

function closeServer(server: Server, listening: boolean): Promise<void> {
  if (!listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export function createCommandCodeStandaloneService(
  options: CommandCodeStandaloneServiceOptions,
): Readonly<CommandCodeStandaloneService> {
  const runtime = options.runtime;
  const config = options.config;
  const port = options.listenPort ?? config.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('listenPort must be an integer from 0 to 65535');
  }
  const adapter = options.adapter ?? createCommandCodeStandaloneAdapter({
    runtime,
    runtimeConfig: config.runtimeSnapshot,
    maxBodyBytes: config.maxBodyBytes,
    maxInflight: config.maxInflight,
  });
  const server = createServer((req, res) => {
    void adapter.handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({
          error: { message: 'Internal adapter error', type: 'internal_error' },
        }));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.headersTimeout = config.keepAliveTimeoutMs + 1_000;
  server.requestTimeout = 30_000;

  let phase: CommandCodeStandaloneServicePhase = 'idle';
  let listening = false;
  let startPromise: Promise<Readonly<AddressInfo>> | undefined;
  let drainPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  const start = (): Promise<Readonly<AddressInfo>> => {
    if (phase === 'starting' && startPromise) return startPromise;
    if (phase !== 'idle') {
      return Promise.reject(new Error('CommandCode standalone service is not startable'));
    }
    phase = 'starting';
    startPromise = new Promise<Readonly<AddressInfo>>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        phase = 'disposed';
        void adapter.dispose()
          .catch(() => undefined)
          .finally(() => reject(
            new Error(
              `CommandCode standalone service failed to listen${
                typeof (error as NodeJS.ErrnoException).code === 'string'
                  ? ` (${(error as NodeJS.ErrnoException).code})`
                  : ''
              }`,
            ),
          ));
      };
      const onListening = (): void => {
        server.off('error', onError);
        listening = true;
        if (phase !== 'starting') {
          if (phase === 'disposed') server.closeAllConnections();
          void closeServer(server, true).finally(() => {
            listening = false;
            reject(new Error('CommandCode standalone service stopped during startup'));
          });
          return;
        }
        const address = server.address();
        if (!address || typeof address === 'string') {
          phase = 'disposed';
          void adapter.dispose()
            .catch(() => undefined)
            .finally(() => reject(
              new Error('CommandCode standalone service returned an invalid address'),
            ));
          return;
        }
        phase = 'running';
        server.on('error', onRuntimeError);
        resolve(Object.freeze({ ...address }));
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: config.host, port });
    });
    return startPromise;
  };

  const onRuntimeError = (): void => {
    void dispose().catch(() => undefined);
  };

  const closeWhenPossible = async (force: boolean): Promise<void> => {
    if (!server.listening && !listening && startPromise) {
      try { await startPromise; } catch { /* startup path already cleaned itself */ }
    }
    if (!server.listening && !listening) return;
    const closing = closeServer(server, true);
    if (force) server.closeAllConnections();
    await closing;
    listening = false;
  };

  const drain = (): Promise<void> => {
    if (phase === 'disposed') return disposePromise ?? Promise.resolve();
    if (drainPromise) return drainPromise;
    phase = 'draining';
    const adapterDrain = adapter.drain().then(() => {
      server.closeIdleConnections();
    });
    const serverClose = closeWhenPossible(false);
    drainPromise = Promise.all([adapterDrain, serverClose]).then(() => undefined);
    return drainPromise;
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    phase = 'disposed';
    const adapterDispose = adapter.dispose();
    const serverClose = closeWhenPossible(true);
    disposePromise = Promise.all([adapterDispose, serverClose]).then(() => undefined);
    return disposePromise;
  };

  const snapshot = (): Readonly<CommandCodeStandaloneServiceSnapshot> => Object.freeze({
    phase,
    listening,
    activeRequests: adapter.snapshot().activeRequests,
  });
  return Object.freeze({ start, drain, dispose, snapshot });
}
