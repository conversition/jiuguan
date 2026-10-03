#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_KEYS = new Set([
  'port', 'host', 'apiKey', 'apiBase', 'projectSlug', 'logFile', 'logLevel', 'zdr', 'upstreamProxy',
  'streamIdleTimeoutMs', 'nonStreamIdleTimeoutMs',
]);

export interface MigrateCommandCodeConfigOptions {
  readonly source: string;
  readonly dataDir: string;
  readonly replace?: boolean;
}

export interface MigrateCommandCodeConfigResult {
  readonly status: 'created' | 'current' | 'replaced';
  readonly target: string;
  readonly migratedKeys: readonly string[];
}

function readObject(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error('Legacy CommandCode config must be a regular file no larger than 16384 bytes');
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Legacy CommandCode config must be an object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!LEGACY_KEYS.has(key)) throw new Error(`Unsupported legacy config key: ${key}`);
  }
  return record;
}

export function migrateCommandCodeProviderConfig(
  options: MigrateCommandCodeConfigOptions,
): MigrateCommandCodeConfigResult {
  const source = resolve(options.source);
  const record = readObject(source);
  const migrated: Record<string, string | boolean | number> = {};
  if (record.apiBase !== undefined) {
    if (typeof record.apiBase !== 'string') throw new Error('Legacy apiBase must be a string');
    migrated.apiBase = record.apiBase;
  }
  if (record.upstreamProxy !== undefined) {
    if (typeof record.upstreamProxy !== 'string') throw new Error('Legacy upstreamProxy must be a string');
    migrated.upstreamProxy = record.upstreamProxy;
  }
  if (record.zdr !== undefined) {
    if (typeof record.zdr !== 'boolean') throw new Error('Legacy zdr must be a boolean');
    migrated.zdr = record.zdr;
  }
  for (const key of ['streamIdleTimeoutMs', 'nonStreamIdleTimeoutMs'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 7_200_000) {
      throw new Error(`Legacy ${key} must be an integer between 1000 and 7200000`);
    }
    migrated[key] = value as number;
  }
  const target = resolve(
    options.dataDir,
    'plugins',
    '.data',
    'commandcode-provider',
    'config.json',
  );
  const body = `${JSON.stringify(migrated, null, 2)}\n`;
  const targetExisted = existsSync(target);
  if (targetExisted) {
    const targetStat = lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('CommandCode Provider config target must be a regular file');
    }
    if (readFileSync(target, 'utf8') === body) {
      return { status: 'current', target, migratedKeys: Object.keys(migrated) };
    }
    if (!options.replace) {
      throw new Error('CommandCode Provider config already exists; pass --replace to update it');
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return {
    status: targetExisted ? 'replaced' : 'created',
    target,
    migratedKeys: Object.keys(migrated),
  };
}

function parseArgs(argv: readonly string[]): MigrateCommandCodeConfigOptions | 'help' {
  let source = '';
  let dataDir = '';
  let replace = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--replace') { replace = true; continue; }
    if (arg === '--source') { source = argv[++index] ?? ''; continue; }
    if (arg === '--data-dir') { dataDir = argv[++index] ?? ''; continue; }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!source || !dataDir) throw new Error('--source and --data-dir are required');
  return { source, dataDir, replace };
}

function isMainModule(): boolean {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''); } catch { return false; }
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === 'help') {
      console.log('Usage: pnpm commandcode:provider:migrate-config -- --source <legacy-config.json> --data-dir <Jiuguan-data> [--replace]');
    } else {
      const result = migrateCommandCodeProviderConfig(options);
      console.log(`[commandcode-provider] config ${result.status}; migrated keys: ${result.migratedKeys.join(', ') || 'none'}`);
    }
  } catch (error) {
    console.error(`[commandcode-provider] config migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
