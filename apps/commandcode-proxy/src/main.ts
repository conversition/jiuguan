import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCommandCodeNodeTransport,
  createCommandCodeRuntime,
} from '../../../packages/commandcode-runtime/src/index.ts';
import { createCommandCodeStandaloneConfig } from './config.ts';
import { createCommandCodeStandaloneService } from './service.ts';

const CONFIG_FILE_LIMIT_BYTES = 1_024 * 1_024;
const SHUTDOWN_GRACE_MS = 15_000;

async function loadConfig(path: string, optional: boolean): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('CommandCode standalone configuration could not be read');
  }
  let content: string;
  try {
    const buffer = Buffer.allocUnsafe(CONFIG_FILE_LIMIT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > CONFIG_FILE_LIMIT_BYTES) {
      throw new Error('CommandCode standalone configuration is too large');
    }
    content = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  try { return JSON.parse(content) as unknown; } catch {
    throw new Error('CommandCode standalone configuration is invalid JSON');
  }
}

export async function runCommandCodeStandalone(): Promise<void> {
  const explicitConfigPath = process.env.CC_CONFIG_PATH;
  const configPath = explicitConfigPath
    ? resolve(process.cwd(), explicitConfigPath)
    : fileURLToPath(new URL('../config.json', import.meta.url));
  const fileConfig = await loadConfig(configPath, !explicitConfigPath);
  const config = createCommandCodeStandaloneConfig({
    fileConfig,
    env: process.env,
  });
  const runtime = createCommandCodeRuntime({
    readConfigSources: () => config.runtimeSources,
    transport: createCommandCodeNodeTransport(),
  });
  const service = createCommandCodeStandaloneService({ runtime, config });
  const address = await service.start();
  console.log(
    `[commandcode] standalone fallback listening on http://${address.address}:${address.port}`,
  );

  let stopping = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceDispose = (): void => {
    void service.dispose().catch(() => undefined);
  };
  const shutdown = (): void => {
    if (stopping) {
      forceDispose();
      return;
    }
    stopping = true;
    forceTimer = setTimeout(forceDispose, SHUTDOWN_GRACE_MS);
    forceTimer.unref();
    void service.drain()
      .then(() => service.dispose())
      .catch(() => service.dispose())
      .finally(() => {
        if (forceTimer) clearTimeout(forceTimer);
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      })
      .catch(() => undefined);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === resolve(entry); } catch { return false; }
}

if (isMainModule()) {
  void runCommandCodeStandalone().catch((error: unknown) => {
    console.error(
      `[commandcode] standalone failed: ${
        error instanceof Error ? error.message : 'unknown startup error'
      }`,
    );
    process.exitCode = 1;
  });
}
