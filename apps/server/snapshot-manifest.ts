export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_MANIFEST_FILE = 'snapshot-manifest.json';

export const SNAPSHOT_COMPONENT_ROLES = [
  'session-db',
  'auth-db',
  'control-db',
  'asset-manifest',
  'asset-content',
  'configuration',
  'plugin-registry',
  'plugin-content',
] as const;

export type SnapshotComponentRole = (typeof SNAPSHOT_COMPONENT_ROLES)[number];
export type SnapshotCaptureMode = 'copy-file' | 'sqlite-online' | 'redacted-json';

export interface SnapshotComponentManifest {
  readonly id: string;
  readonly role: SnapshotComponentRole;
  readonly sourceRelativePath: string;
  readonly storedRelativePath: string;
  readonly captureMode: SnapshotCaptureMode;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly schemaVersion?: number;
}

export interface SnapshotPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly componentIds: readonly string[];
  readonly digest: string;
}

export interface JiuguanSnapshotManifest {
  readonly version: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly applicationVersion: string;
  readonly components: readonly SnapshotComponentManifest[];
  readonly plugins: readonly SnapshotPluginManifest[];
}

const SNAPSHOT_ID_RE = /^[a-f0-9]{24}$/;
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/;
const DB_ROLES = new Set<SnapshotComponentRole>(['session-db', 'auth-db', 'control-db']);

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

export function canonicalSnapshotRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error(field + ' 必须是 1..512 字符相对路径');
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.includes('\u0000')) {
    throw new Error(field + ' 必须使用安全 POSIX 相对路径');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..'
    || segment.length > 160 || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error(field + ' 含非法路径段');
  }
  return segments.join('/');
}

function canonicalIso(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error('createdAt 必须是 canonical ISO 时间');
  }
  return value;
}

function parseComponent(value: unknown): SnapshotComponentManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('component 必须是对象');
  const row = value as Record<string, unknown>;
  if (!exactKeys(
    row,
    ['id', 'role', 'sourceRelativePath', 'storedRelativePath', 'captureMode', 'sizeBytes', 'sha256'],
    ['schemaVersion'],
  )) throw new Error('component 字段集合非法');
  if (typeof row.id !== 'string' || !COMPONENT_ID_RE.test(row.id)) throw new Error('component.id 非法');
  if (typeof row.role !== 'string'
    || !(SNAPSHOT_COMPONENT_ROLES as readonly string[]).includes(row.role)) {
    throw new Error('component.role 非法');
  }
  const role = row.role as SnapshotComponentRole;
  if (row.captureMode !== 'copy-file' && row.captureMode !== 'sqlite-online'
    && row.captureMode !== 'redacted-json') {
    throw new Error('component.captureMode 非法');
  }
  const captureMode = row.captureMode;
  if (DB_ROLES.has(role) !== (captureMode === 'sqlite-online')) {
    throw new Error('数据库 role 必须使用 sqlite-online，普通文件不得使用 sqlite-online');
  }
  const sourceRelativePath = canonicalSnapshotRelativePath(row.sourceRelativePath, 'sourceRelativePath');
  const providerConfig = sourceRelativePath === 'provider.json';
  if (providerConfig !== (captureMode === 'redacted-json')
    || (captureMode === 'redacted-json' && role !== 'configuration')) {
    throw new Error('provider.json 必须是 configuration/redacted-json 专用组件');
  }
  const storedRelativePath = canonicalSnapshotRelativePath(row.storedRelativePath, 'storedRelativePath');
  if (storedRelativePath !== 'components/' + row.id + '.bin') {
    throw new Error('storedRelativePath 必须由 component.id 派生');
  }
  if (sourceRelativePath.endsWith('-wal') || sourceRelativePath.endsWith('-shm')) {
    throw new Error('快照不得登记 WAL/SHM 文件');
  }
  if (sourceRelativePath.split('/').at(-1) === 'root.key') {
    throw new Error('快照不得登记认证 root key');
  }
  if (!Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) < 0) throw new Error('sizeBytes 非法');
  if (typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)) throw new Error('sha256 非法');
  if (row.schemaVersion !== undefined
    && (!Number.isSafeInteger(row.schemaVersion) || Number(row.schemaVersion) < 1)) {
    throw new Error('schemaVersion 非法');
  }
  if (DB_ROLES.has(role) && row.schemaVersion === undefined) {
    throw new Error('数据库 component 必须记录 schemaVersion');
  }
  return Object.freeze({
    id: row.id,
    role,
    sourceRelativePath,
    storedRelativePath,
    captureMode,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    ...(row.schemaVersion === undefined ? {} : { schemaVersion: Number(row.schemaVersion) }),
  });
}

function parsePlugin(value: unknown): SnapshotPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plugin 必须是对象');
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['id', 'version', 'enabled', 'componentIds', 'digest'])) {
    throw new Error('plugin 字段集合非法');
  }
  if (typeof row.id !== 'string' || !PLUGIN_ID_RE.test(row.id)) throw new Error('plugin.id 非法');
  if (typeof row.version !== 'string' || !VERSION_RE.test(row.version)) throw new Error('plugin.version 非法');
  if (typeof row.enabled !== 'boolean') throw new Error('plugin.enabled 非法');
  if (!Array.isArray(row.componentIds) || row.componentIds.length < 1
    || row.componentIds.some((id) => typeof id !== 'string' || !COMPONENT_ID_RE.test(id))
    || new Set(row.componentIds).size !== row.componentIds.length) {
    throw new Error('plugin.componentIds 非法');
  }
  if (typeof row.digest !== 'string' || !SHA256_RE.test(row.digest)) throw new Error('plugin.digest 非法');
  return Object.freeze({
    id: row.id,
    version: row.version,
    enabled: row.enabled,
    componentIds: Object.freeze([...(row.componentIds as string[])].sort()),
    digest: row.digest,
  });
}

export function computeSnapshotPluginDigest(
  plugin: Pick<SnapshotPluginManifest, 'id' | 'version' | 'enabled' | 'componentIds'>,
  componentsById: ReadonlyMap<string, SnapshotComponentManifest>,
): string {
  const rows = plugin.componentIds.map((id) => {
    const component = componentsById.get(id);
    if (!component || component.role !== 'plugin-content') {
      throw new Error('插件 inventory 引用了非 plugin-content 组件');
    }
    return component.sourceRelativePath + ':' + component.sha256 + ':' + component.sizeBytes;
  }).sort();
  return createHash('sha256')
    .update(JSON.stringify({
      id: plugin.id,
      version: plugin.version,
      enabled: plugin.enabled,
      rows,
    }))
    .digest('hex');
}

export function parseSnapshotManifest(value: unknown): JiuguanSnapshotManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('snapshot manifest 必须是对象');
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['version', 'snapshotId', 'createdAt', 'applicationVersion', 'components', 'plugins'])) {
    throw new Error('snapshot manifest 字段集合非法');
  }
  if (row.version !== SNAPSHOT_FORMAT_VERSION) throw new Error('不支持的 snapshot manifest 版本');
  if (typeof row.snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(row.snapshotId)) throw new Error('snapshotId 非法');
  if (typeof row.applicationVersion !== 'string' || !VERSION_RE.test(row.applicationVersion)) {
    throw new Error('applicationVersion 非法');
  }
  if (!Array.isArray(row.components) || !Array.isArray(row.plugins)) throw new Error('components/plugins 必须是数组');
  const components = row.components.map(parseComponent);
  const plugins = row.plugins.map(parsePlugin);
  const componentIds = new Set<string>();
  const storedPaths = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const component of components) {
    if (componentIds.has(component.id)) throw new Error('component.id 重复');
    if (storedPaths.has(component.storedRelativePath)) throw new Error('storedRelativePath 重复');
    if (sourcePaths.has(component.sourceRelativePath)) throw new Error('sourceRelativePath 重复');
    componentIds.add(component.id);
    storedPaths.add(component.storedRelativePath);
    sourcePaths.add(component.sourceRelativePath);
  }
  const pluginIds = new Set<string>();
  const componentsById = new Map(components.map((component) => [component.id, component]));
  for (const plugin of plugins) {
    if (pluginIds.has(plugin.id)) throw new Error('plugin.id 重复');
    pluginIds.add(plugin.id);
    if (computeSnapshotPluginDigest(plugin, componentsById) !== plugin.digest) {
      throw new Error('plugin.digest 与 component 内容不一致');
    }
  }
  return Object.freeze({
    version: 1,
    snapshotId: row.snapshotId,
    createdAt: canonicalIso(row.createdAt),
    applicationVersion: row.applicationVersion,
    components: Object.freeze(components),
    plugins: Object.freeze(plugins),
  });
}

export function serializeSnapshotManifest(manifest: JiuguanSnapshotManifest): string {
  return JSON.stringify(parseSnapshotManifest(manifest), null, 2) + '\n';
}
import { createHash } from 'node:crypto';
