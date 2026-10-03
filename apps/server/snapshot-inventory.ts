import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  readActiveGeneration,
  readGenerationManifest,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
} from '../../packages/server-auth/src/index.ts';
import type { SnapshotComponentPlan, SnapshotPluginPlan } from './snapshot-coordinator.ts';
import type { SnapshotComponentRole } from './snapshot-manifest.ts';
import { TURN_JOB_DB_FILE } from './turn-job-manager.ts';
import { MAINTENANCE_JOB_DB_FILE } from './maintenance-job-manager.ts';
import { INTERACTIVE_LEDGER_DB_FILE } from './interactive-call-ledger.ts';
import { MODEL_USAGE_DB_FILE } from './model-usage-ledger.ts';
import { AGENT_ADMISSION_DB_FILE } from './agent-admission-ledger.ts';
import { AGENT_LEARNING_DB_FILE } from './agent-learning-ledger.ts';
import { ARC_PROJECTION_DB_FILE } from './arc-projection-store.ts';
import { AGENT_CONTROL_DB_FILE } from './agent-control-store.ts';
import { WORLDBOOK_REPAIR_DB_FILE } from './worldbook-repair-control.ts';

export interface DefaultSnapshotInventory {
  readonly components: readonly SnapshotComponentPlan[];
  readonly plugins: readonly SnapshotPluginPlan[];
}

const ROOT_CONFIGURATION_FILES = [
  'content-modes.json',
  'provider-history.json',
  'regex-rules.json',
] as const;
// P14 operational replay packages contain only strict, prose-incapable synthetic evidence
// and are needed to audit why a lane was unlocked after snapshot/restore.
const CONFIGURATION_DIRS = [
  'skills',
  'storyboard-workflows',
  'p14-evidence',
  'style-proposals',
] as const;
const ASSET_DIRS = ['cards', 'presets', 'worldbooks'] as const;
const MAX_COMPONENTS = 100_000;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/;

function posixRelative(root: string, target: string): string {
  const value = relative(root, target);
  if (!value || value === '..' || value.startsWith('..' + sep) || isAbsolute(value)) {
    throw new Error('inventory 路径超出 dataDir');
  }
  return value.split(sep).join('/');
}

function componentId(role: SnapshotComponentRole, relativePath: string): string {
  const digest = createHash('sha256').update(role + '\0' + relativePath).digest('hex').slice(0, 24);
  return role.replace(/[^a-z0-9]+/g, '-') + '-' + digest;
}

function readSqliteSchemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new Error('SQLite user_version 非法：' + path);
    }
    return Number(value);
  } finally {
    db.close();
  }
}

function walkPlainFiles(root: string, relativeDir: string): string[] {
  const start = resolve(root, ...relativeDir.split('/'));
  if (!existsSync(start)) return [];
  const output: string[] = [];
  const visit = (absoluteDir: string): void => {
    const dirStats = lstatSync(absoluteDir);
    if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) {
      throw new Error('inventory 目录必须是普通目录：' + posixRelative(root, absoluteDir));
    }
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('inventory 禁止符号链接：' + posixRelative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        output.push(posixRelative(root, absolute));
        if (output.length > MAX_COMPONENTS) throw new Error('inventory 文件数量超过上限');
      } else {
        throw new Error('inventory 只允许普通文件/目录：' + posixRelative(root, absolute));
      }
    }
  };
  visit(start);
  return output;
}

function pluginRecords(root: string): Array<{ id: string; version: string; enabled: boolean }> {
  const path = join(root, 'plugins', 'registry.json');
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('插件 registry.json 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { plugins?: unknown }).plugins)) {
    throw new Error('插件 registry.json 缺少 plugins 数组');
  }
  const seen = new Set<string>();
  return (parsed as { plugins: unknown[] }).plugins.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件 registry 记录非法');
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || !PLUGIN_ID_RE.test(row.id)
      || typeof row.version !== 'string' || !VERSION_RE.test(row.version)
      || typeof row.enabled !== 'boolean' || seen.has(row.id)) {
      throw new Error('插件 registry id/version/enabled 非法或重复');
    }
    seen.add(row.id);
    return { id: row.id, version: row.version, enabled: row.enabled };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function buildDefaultSnapshotInventory(dataDir: string): DefaultSnapshotInventory {
  const root = resolve(dataDir);
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('dataDir 必须是普通目录');
  const components: SnapshotComponentPlan[] = [];
  const add = (
    role: SnapshotComponentRole,
    sourceRelativePath: string,
    captureMode: 'copy-file' | 'sqlite-online' | 'redacted-json' = 'copy-file',
    schemaVersion?: number,
  ): void => {
    components.push(Object.freeze({
      id: componentId(role, sourceRelativePath),
      role,
      sourceRelativePath,
      captureMode,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
    }));
    if (components.length > MAX_COMPONENTS) throw new Error('inventory 组件数量超过上限');
  };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
    const sourceRelativePath = entry.name;
    add('session-db', sourceRelativePath, 'sqlite-online', readSqliteSchemaVersion(join(root, entry.name)));
  }
  const turnJobPath = join(root, TURN_JOB_DB_FILE);
  if (existsSync(turnJobPath)) {
    add('control-db', TURN_JOB_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(turnJobPath));
  }
  const maintenanceJobPath = join(root, MAINTENANCE_JOB_DB_FILE);
  if (existsSync(maintenanceJobPath)) {
    add('control-db', MAINTENANCE_JOB_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(maintenanceJobPath));
  }
  const interactiveLedgerPath = join(root, INTERACTIVE_LEDGER_DB_FILE);
  if (existsSync(interactiveLedgerPath)) {
    add('control-db', INTERACTIVE_LEDGER_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(interactiveLedgerPath));
  }
  const modelUsagePath = join(root, MODEL_USAGE_DB_FILE);
  if (existsSync(modelUsagePath)) {
    add('control-db', MODEL_USAGE_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(modelUsagePath));
  }
  const agentAdmissionPath = join(root, AGENT_ADMISSION_DB_FILE);
  if (existsSync(agentAdmissionPath)) {
    add('control-db', AGENT_ADMISSION_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(agentAdmissionPath));
  }
  const agentLearningPath = join(root, AGENT_LEARNING_DB_FILE);
  if (existsSync(agentLearningPath)) {
    add('control-db', AGENT_LEARNING_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(agentLearningPath));
  }
  const arcProjectionPath = join(root, ARC_PROJECTION_DB_FILE);
  if (existsSync(arcProjectionPath)) {
    add('control-db', ARC_PROJECTION_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(arcProjectionPath));
  }
  const agentControlPath = join(root, AGENT_CONTROL_DB_FILE);
  if (existsSync(agentControlPath)) {
    add('control-db', AGENT_CONTROL_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(agentControlPath));
  }
  const worldbookRepairPath = join(root, WORLDBOOK_REPAIR_DB_FILE);
  if (existsSync(worldbookRepairPath)) {
    add('control-db', WORLDBOOK_REPAIR_DB_FILE, 'sqlite-online', readSqliteSchemaVersion(worldbookRepairPath));
  }

  const securityDir = join(root, 'security');
  if (existsSync(join(securityDir, 'active-generation'))) {
    const layout = resolveAuthStorageLayout(root);
    const generationId = readActiveGeneration(layout);
    const generation = resolveGenerationPaths(layout, generationId);
    const manifest = readGenerationManifest(layout, generationId);
    add(
      'auth-db',
      posixRelative(root, generation.authDbPath),
      'sqlite-online',
      manifest.schemaVersion,
    );
  }

  if (existsSync(join(root, 'asset-identities.v1.json'))) {
    add('asset-manifest', 'asset-identities.v1.json');
  }
  if (existsSync(join(root, 'provider.json'))) {
    add('configuration', 'provider.json', 'redacted-json');
  }
  for (const file of ROOT_CONFIGURATION_FILES) {
    if (existsSync(join(root, file))) add('configuration', file);
  }
  for (const dir of ASSET_DIRS) {
    for (const path of walkPlainFiles(root, dir)) add('asset-content', path);
  }
  for (const dir of CONFIGURATION_DIRS) {
    for (const path of walkPlainFiles(root, dir)) add('configuration', path);
  }

  const records = pluginRecords(root);
  const registryPath = join(root, 'plugins', 'registry.json');
  if (existsSync(registryPath)) add('plugin-registry', 'plugins/registry.json');
  const backupPath = join(root, 'plugins', 'registry.json.bak');
  if (existsSync(backupPath)) add('plugin-registry', 'plugins/registry.json.bak');

  const pluginComponents = new Map<string, string[]>();
  for (const record of records) pluginComponents.set(record.id, []);
  const attachPluginFile = (pluginId: string, path: string): void => {
    const list = pluginComponents.get(pluginId);
    if (!list) throw new Error('插件持久文件没有 registry 记录：' + pluginId);
    add('plugin-content', path);
    list.push(components.at(-1)!.id);
  };
  for (const record of records) {
    for (const path of walkPlainFiles(root, 'plugins/' + record.id)) attachPluginFile(record.id, path);
    for (const path of walkPlainFiles(root, 'plugins/.data/' + record.id)) attachPluginFile(record.id, path);
    const storage = 'plugins/storage/' + record.id + '.json';
    if (existsSync(join(root, ...storage.split('/')))) attachPluginFile(record.id, storage);
  }
  const runtimeDir = join(root, 'plugins', '.runtime');
  if (existsSync(runtimeDir)) {
    const runtimeStats = lstatSync(runtimeDir);
    if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
      throw new Error('plugins/.runtime 类型非法');
    }
  }

  const plugins: SnapshotPluginPlan[] = records.map((record) => {
    const componentIds = pluginComponents.get(record.id) ?? [];
    if (componentIds.length < 1) throw new Error('插件目录为空或缺失：' + record.id);
    return Object.freeze({ ...record, componentIds: Object.freeze([...componentIds].sort()) });
  });
  return Object.freeze({
    components: Object.freeze(components.sort((a, b) => a.id.localeCompare(b.id))),
    plugins: Object.freeze(plugins),
  });
}
