#!/usr/bin/env node
/** Idempotent local install/sync for the first-party CommandCode DSH bundle. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry, type PluginRecord } from '../../packages/plugin/src/registry.ts';
import { DSH_HOST_API_VERSION } from '../../packages/plugin/src/dsh-host.ts';
import {
  matchesPluginSourceFingerprint,
  type PublicPluginRecord,
} from '../../packages/plugin/src/public-record.ts';
import {
  API_PROTOCOL_VERSION,
  isProtocolCompatible,
  isServerMeta,
} from '../../packages/mobile-contracts/src/index.ts';
import { layoutFor } from '../../tools/release/compat-matrix.ts';
import { loadHostRelease } from '../../tools/release/host-release-manifest.ts';

export const COMMANDCODE_PROVIDER_PLUGIN_ID = 'commandcode-provider' as const;

export type CommandCodeProviderSyncStatus = 'installed' | 'current' | 'updated';
export type CommandCodeProviderSyncTransport = 'offline' | 'http';

export interface CommandCodeProviderSyncOptions {
  dataDir?: string;
  sourceDir?: string;
  /**
   * Library calls are offline by default and never probe or mutate a live app.
   * The user-facing CLI opts into auto so a detected server is updated by HTTP.
   */
  mode?: 'offline' | 'auto';
}

export interface CommandCodeProviderSyncResult {
  status: CommandCodeProviderSyncStatus;
  transport: CommandCodeProviderSyncTransport;
  dataDir: string;
  pluginDir: string;
  record: PluginRecord | PublicPluginRecord;
}

export class CommandCodeProviderSyncConflictError extends Error {
  readonly code = 'COMMANDCODE_PROVIDER_SYNC_SOURCE_CONFLICT' as const;
  constructor(readonly installedSource: string) {
    super(
      'CommandCode Provider is installed from a different source; refusing to overwrite it. '
      + 'Uninstall that user-managed version explicitly before adopting the first-party bundle.',
    );
    this.name = 'CommandCodeProviderSyncConflictError';
  }
}

export class CommandCodeProviderSyncServerError extends Error {
  readonly code = 'COMMANDCODE_PROVIDER_SYNC_SERVER_ERROR' as const;
  constructor(message = 'Jiuguan server is listening but its plugin API is unavailable') {
    super(message);
    this.name = 'CommandCodeProviderSyncServerError';
  }
}

export class CommandCodeProviderSyncLiveDataDirError extends Error {
  readonly code = 'COMMANDCODE_PROVIDER_SYNC_LIVE_DATA_DIR' as const;
  constructor() {
    super(
      '--data-dir cannot be used while Jiuguan is running; '
      + 'stop the server for an offline install or omit --data-dir for live HTTP sync.',
    );
    this.name = 'CommandCodeProviderSyncLiveDataDirError';
  }
}

function defaultSourceDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveDataDir(explicit?: string): string {
  const selected = explicit ?? process.env.JG_USER_DATA_DIR ?? join(process.cwd(), 'data');
  return resolve(selected);
}

function packageMain(directory: string): string {
  const pkgPath = join(directory, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('CommandCode Provider package.json is missing');
  const pkgStat = lstatSync(pkgPath);
  if (!pkgStat.isFile() || pkgStat.isSymbolicLink()) {
    throw new Error('CommandCode Provider package.json must be a regular file');
  }
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; main?: unknown };
  if (parsed.name !== COMMANDCODE_PROVIDER_PLUGIN_ID || typeof parsed.main !== 'string') {
    throw new Error('CommandCode Provider package metadata is invalid');
  }
  const main = resolve(directory, parsed.main);
  const rel = relative(resolve(directory), main);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('CommandCode Provider main must stay inside the package');
  }
  if (!existsSync(main)) {
    throw new Error('CommandCode Provider bundle is missing; run the build command first');
  }
  return main;
}

function distributionHash(directory: string): string | null {
  try {
    const main = packageMain(directory);
    return createHash('sha256')
      .update(readFileSync(join(directory, 'package.json')))
      .update('\0')
      .update(readFileSync(main))
      .digest('hex');
  } catch {
    return null;
  }
}

function sameLocalSource(installedSource: string, sourceDir: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(installedSource)) return false;
  try { return resolve(installedSource) === sourceDir; } catch { return false; }
}

function isWorktreeFirstPartySource(source: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
  try { return resolve(source) === resolve(defaultSourceDir()); } catch { return false; }
}

function isVerifiedHostReleaseSource(source: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
  try {
    const sourcePath = resolve(source);
    const sourceStat = lstatSync(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return false;
    const repoRoot = resolve(defaultSourceDir(), '..', '..');
    const layout = layoutFor(join(repoRoot, '.workbuddy', 'host-release'));
    const rel = relative(resolve(layout.releasesDir), sourcePath);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) {
      return false;
    }
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 2 || parts[1] !== 'plugin' || !/^[A-Za-z0-9._-]{1,80}$/.test(parts[0])) {
      return false;
    }
    const manifest = loadHostRelease(layout, parts[0]);
    if (manifest.artifacts.pluginEntry !== 'plugin/index.js') return false;
    const pkg = JSON.parse(readFileSync(join(sourcePath, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
      type?: unknown;
      main?: unknown;
      jiuguan?: { hostApi?: unknown };
    };
    return pkg.name === COMMANDCODE_PROVIDER_PLUGIN_ID
      && pkg.main === 'index.js'
      && pkg.type === 'module'
      && pkg.version === manifest.components.plugin
      && pkg.jiuguan?.hostApi === DSH_HOST_API_VERSION
      && packageMain(sourcePath) === resolve(sourcePath, 'index.js');
  } catch {
    return false;
  }
}

function sharesVerifiedFirstPartyLineage(installedSource: string, sourceDir: string): boolean {
  const trusted = (source: string): boolean => (
    isWorktreeFirstPartySource(source) || isVerifiedHostReleaseSource(source)
  );
  return trusted(installedSource) && trusted(sourceDir);
}

interface LivePluginApi {
  readonly baseUrl: string;
  readonly plugins: PublicPluginRecord[];
}

function serverPort(): number {
  const raw = process.env.JG_WEB_PORT ?? '17800';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CommandCodeProviderSyncServerError('JG_WEB_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function connectionRefused(error: unknown): boolean {
  const cause = error && typeof error === 'object' && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  return Boolean(
    cause
    && typeof cause === 'object'
    && 'code' in cause
    && (cause as { code?: unknown }).code === 'ECONNREFUSED',
  );
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CommandCodeProviderSyncServerError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandCodeProviderSyncServerError();
  }
  return value as Record<string, unknown>;
}

/** 探测两级 deadline：单请求上限与整体预算，避免"两个请求各等 750ms"这类隐式行为。 */
const PROBE_REQUEST_TIMEOUT_MS = 750;
const PROBE_TOTAL_TIMEOUT_MS = 1_500;

/**
 * Probe only the configured loopback port. A refused connection means offline;
 * any listener that is slow or does not expose Jiuguan's API is fail-closed so
 * this command never starts a competing registry writer.
 *
 * 每个请求受 750ms 单请求上限约束，同时整体受 1500ms 总预算约束；预算耗尽后不再
 * 发起新请求。超时计时器覆盖到 body 解析完成，因此慢响应体同样在预算内失败。
 */
async function probeLiveServer(): Promise<LivePluginApi | null> {
  const baseUrl = `http://127.0.0.1:${serverPort()}`;
  const totalDeadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS;

  const probeJson = async (path: string): Promise<Record<string, unknown>> => {
    const remaining = totalDeadline - Date.now();
    if (remaining <= 0) throw new CommandCodeProviderSyncServerError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PROBE_REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new CommandCodeProviderSyncServerError();
      return await responseJson(response);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let capabilities: Record<string, unknown>;
    try {
      capabilities = await probeJson('/api/capabilities');
    } catch (error) {
      if (connectionRefused(error)) return null;
      throw new CommandCodeProviderSyncServerError();
    }
    if (!isServerMeta(capabilities) || capabilities.app.name !== 'jiuguan') {
      throw new CommandCodeProviderSyncServerError();
    }
    // 必须检查协议范围：对端 API 协议与本工具不兼容时，继续同步会写进对端不认识
    // 的插件记录，因此 fail-closed 而不是"能连上就当同一版本"。
    if (!isProtocolCompatible(API_PROTOCOL_VERSION, capabilities.api)) {
      throw new CommandCodeProviderSyncServerError(
        "Jiuguan server API protocol is outside this sync tool's supported range",
      );
    }

    const body = await probeJson('/api/plugins');
    if (!Array.isArray(body.plugins)) throw new CommandCodeProviderSyncServerError();
    const plugins = body.plugins.filter((value): value is PublicPluginRecord => Boolean(
      value
      && typeof value === 'object'
      && typeof (value as { id?: unknown }).id === 'string'
      && (
        (value as { sourceKind?: unknown }).sourceKind === 'local-path'
        || (value as { sourceKind?: unknown }).sourceKind === 'remote-url'
      )
      && /^sha256:[0-9a-f]{64}$/.test(String(
        (value as { sourceFingerprint?: unknown }).sourceFingerprint ?? '',
      )),
    ));
    if (plugins.length !== body.plugins.length) throw new CommandCodeProviderSyncServerError();
    return { baseUrl, plugins };
  } catch (error) {
    if (error instanceof CommandCodeProviderSyncServerError) throw error;
    throw new CommandCodeProviderSyncServerError();
  }
}

async function mutateLivePlugin(
  live: LivePluginApi,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${live.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch {
    throw new CommandCodeProviderSyncServerError('Jiuguan plugin API request failed');
  } finally {
    clearTimeout(timer);
  }
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new CommandCodeProviderSyncServerError('Jiuguan plugin API rejected the sync');
  }
  return payload;
}

function pluginRecordOf(payload: Record<string, unknown>): PublicPluginRecord {
  const record = payload.plugin;
  if (
    !record
    || typeof record !== 'object'
    || typeof (record as { id?: unknown }).id !== 'string'
    || (
      (record as { sourceKind?: unknown }).sourceKind !== 'local-path'
      && (record as { sourceKind?: unknown }).sourceKind !== 'remote-url'
    )
    || !/^sha256:[0-9a-f]{64}$/.test(String(
      (record as { sourceFingerprint?: unknown }).sourceFingerprint ?? '',
    ))
  ) {
    throw new CommandCodeProviderSyncServerError();
  }
  return record as PublicPluginRecord;
}

export async function syncCommandCodeProvider(
  options: CommandCodeProviderSyncOptions = {},
): Promise<CommandCodeProviderSyncResult> {
  const dataDir = resolveDataDir(options.dataDir);
  const sourceDir = resolve(options.sourceDir ?? defaultSourceDir());
  const sourceHash = distributionHash(sourceDir);
  if (!sourceHash) throw new Error('CommandCode Provider bundle is not build-ready');
  const pluginsDir = join(dataDir, 'plugins');
  const pluginDir = join(pluginsDir, COMMANDCODE_PROVIDER_PLUGIN_ID);
  const live = options.mode === 'auto' ? await probeLiveServer() : null;

  if (live) {
    if (options.dataDir !== undefined) throw new CommandCodeProviderSyncLiveDataDirError();
    const current = live.plugins.find((plugin) => plugin.id === COMMANDCODE_PROVIDER_PLUGIN_ID);
    if (!current) {
      const payload = await mutateLivePlugin(live, '/api/plugins/install', { url: sourceDir });
      return {
        status: 'installed',
        transport: 'http',
        dataDir,
        pluginDir,
        record: pluginRecordOf(payload),
      };
    }
    if (!matchesPluginSourceFingerprint(sourceDir, current.sourceFingerprint)) {
      throw new CommandCodeProviderSyncConflictError(current.sourceFingerprint);
    }
    const payload = await mutateLivePlugin(
      live,
      `/api/plugins/${encodeURIComponent(COMMANDCODE_PROVIDER_PLUGIN_ID)}/update`,
    );
    return {
      status: 'updated',
      transport: 'http',
      dataDir,
      pluginDir,
      record: pluginRecordOf(payload),
    };
  }

  const registry = new PluginRegistry(pluginsDir);
  const current = registry.get(COMMANDCODE_PROVIDER_PLUGIN_ID);

  if (!current) {
    const record = await registry.install(sourceDir);
    return { status: 'installed', transport: 'offline', dataDir, pluginDir, record };
  }

  const installedHash = distributionHash(pluginDir);
  const sameSource = sameLocalSource(current.source, sourceDir);
  if (installedHash === sourceHash && sameSource) {
    return { status: 'current', transport: 'offline', dataDir, pluginDir, record: current };
  }
  if (!sameSource && !sharesVerifiedFirstPartyLineage(current.source, sourceDir)) {
    throw new CommandCodeProviderSyncConflictError(current.source);
  }

  const transaction = await registry.prepareUpdate(
    COMMANDCODE_PROVIDER_PLUGIN_ID,
    sameSource ? undefined : sourceDir,
  );
  const record = transaction.commit();
  return { status: 'updated', transport: 'offline', dataDir, pluginDir, record };
}

function parseArgs(argv: readonly string[]): CommandCodeProviderSyncOptions | 'help' {
  const result: CommandCodeProviderSyncOptions = { mode: 'auto' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--data-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--data-dir requires a path');
      result.dataDir = value;
      continue;
    }
    if (arg === '--source-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--source-dir requires a path');
      result.sourceDir = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === resolve(entry); } catch { return false; }
}

if (isMainModule()) {
  void (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options === 'help') {
      console.log('Usage: pnpm commandcode:provider:sync -- [--data-dir <path>] [--source-dir <path>]');
      console.log('Different-source installations are never overwritten; no implicit --force exists.');
      console.log('--source-dir selects an already-built, installable CommandCode Provider package.');
      console.log('Running server: sync uses its loopback HTTP API; --data-dir is refused.');
      console.log('Stopped server: sync writes the selected local registry offline.');
      return;
    }
    const result = await syncCommandCodeProvider(options);
    console.log(
      `[commandcode-provider] ${result.status} (${result.transport}): ${result.pluginDir}`,
    );
  })().catch((error: unknown) => {
    console.error(`[commandcode-provider] ${error instanceof Error ? error.message : 'sync failed'}`);
    process.exitCode = error instanceof CommandCodeProviderSyncConflictError ? 2 : 1;
  });
}
