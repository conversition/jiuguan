import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ReleaseHostLayout } from './compat-matrix.ts';

interface HostReleaseManifestBase {
  readonly releaseId: string;
  readonly commit: string;
  readonly apiOrigin: string;
  readonly components: {
    readonly server: string;
    readonly web: string;
    readonly plugin: string;
  };
  readonly protocol: { readonly api: number; readonly minClient: number; readonly maxClient: number };
  readonly artifacts: {
    readonly runtimeEntry: string;
    readonly runtimeSha256: string;
    readonly webEntry: string;
    readonly webSha256: string;
    readonly pluginEntry: string;
    readonly pluginSha256: string;
  };
}

export interface HostReleaseManifestV1 extends HostReleaseManifestBase {
  readonly version: 1;
  readonly schemas: {
    readonly memory: number;
    readonly auth: number;
    readonly turnJobs: number;
    readonly maintenance: number;
    readonly interactiveLedger: number;
  };
}

export interface HostReleaseManifestV2 extends HostReleaseManifestBase {
  readonly version: 2;
  readonly schemas: {
    readonly memory: number;
    readonly auth: number;
    readonly turnJobs: number;
    readonly maintenance: number;
    readonly interactiveLedger: number;
    readonly modelUsage: number;
    readonly agentAdmission: number;
    readonly agentLearning: number;
    readonly arcProjection: number;
    readonly agentControl: number;
  };
}

export type HostReleaseManifest = HostReleaseManifestV1 | HostReleaseManifestV2;

const RELEASE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function exactHttpsTailnetOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.ts.net')
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('host-release-origin-invalid');
  }
  return url.origin;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host-release-manifest-invalid');
  const row = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(row).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('host-release-manifest-invalid');
  }
  return row;
}

function positiveInt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('host-release-manifest-invalid');
  return Number(value);
}

function safeRelative(value: unknown, suffix: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240
    || !/^[A-Za-z0-9._/-]+$/.test(value)
    || value.includes('\\') || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')
    || !value.endsWith(suffix)) throw new Error('host-release-manifest-invalid');
  return value;
}

export function parseHostReleaseManifest(value: unknown): HostReleaseManifest {
  const row = exactObject(value, [
    'version', 'releaseId', 'commit', 'apiOrigin', 'components', 'protocol', 'schemas', 'artifacts',
  ]);
  const components = exactObject(row.components, ['server', 'web', 'plugin']);
  const protocol = exactObject(row.protocol, ['api', 'minClient', 'maxClient']);
  if (row.version !== 1 && row.version !== 2) throw new Error('host-release-manifest-invalid');
  const schemaKeys = row.version === 1
    ? ['memory', 'auth', 'turnJobs', 'maintenance', 'interactiveLedger']
    : [
      'memory', 'auth', 'turnJobs', 'maintenance', 'interactiveLedger',
      'modelUsage', 'agentAdmission', 'agentLearning', 'arcProjection', 'agentControl',
    ];
  const schemas = exactObject(row.schemas, schemaKeys);
  const artifacts = exactObject(row.artifacts, [
    'runtimeEntry', 'runtimeSha256', 'webEntry', 'webSha256', 'pluginEntry', 'pluginSha256',
  ]);
  if (typeof row.releaseId !== 'string' || !RELEASE_ID.test(row.releaseId)
    || typeof row.commit !== 'string' || !/^[a-f0-9]{40}$/.test(row.commit)
    || typeof components.server !== 'string' || typeof components.web !== 'string' || typeof components.plugin !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(components.server)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(components.plugin)
    || components.server !== components.web
    || typeof artifacts.runtimeSha256 !== 'string' || !SHA256.test(artifacts.runtimeSha256)
    || typeof artifacts.webSha256 !== 'string' || !SHA256.test(artifacts.webSha256)
    || typeof artifacts.pluginSha256 !== 'string' || !SHA256.test(artifacts.pluginSha256)) {
    throw new Error('host-release-manifest-invalid');
  }
  const api = positiveInt(protocol.api);
  const minClient = positiveInt(protocol.minClient);
  const maxClient = positiveInt(protocol.maxClient);
  if (minClient > api || api > maxClient) throw new Error('host-release-manifest-invalid');
  const common = {
    releaseId: row.releaseId,
    commit: row.commit,
    apiOrigin: exactHttpsTailnetOrigin(String(row.apiOrigin)),
    components: Object.freeze({ server: components.server, web: components.web, plugin: components.plugin }),
    protocol: Object.freeze({ api, minClient, maxClient }),
    artifacts: Object.freeze({
      runtimeEntry: safeRelative(artifacts.runtimeEntry, '.js'),
      runtimeSha256: artifacts.runtimeSha256,
      webEntry: safeRelative(artifacts.webEntry, '.html'),
      webSha256: artifacts.webSha256,
      pluginEntry: safeRelative(artifacts.pluginEntry, '.js'),
      pluginSha256: artifacts.pluginSha256,
    }),
  } as const;
  const legacySchemas = {
    memory: positiveInt(schemas.memory),
    auth: positiveInt(schemas.auth),
    turnJobs: positiveInt(schemas.turnJobs),
    maintenance: positiveInt(schemas.maintenance),
    interactiveLedger: positiveInt(schemas.interactiveLedger),
  } as const;
  if (row.version === 1) {
    return Object.freeze({ ...common, version: 1, schemas: Object.freeze(legacySchemas) });
  }
  return Object.freeze({
    ...common,
    version: 2,
    schemas: Object.freeze({
      ...legacySchemas,
      modelUsage: positiveInt(schemas.modelUsage),
      agentAdmission: positiveInt(schemas.agentAdmission),
      agentLearning: positiveInt(schemas.agentLearning),
      arcProjection: positiveInt(schemas.arcProjection),
      agentControl: positiveInt(schemas.agentControl),
    }),
  });
}

function contained(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, ...relativePath.split('/'));
  if (target === base || !target.startsWith(base + sep)) throw new Error('host-release-path-escape');
  return target;
}

export function loadHostRelease(layout: ReleaseHostLayout, releaseId: string): HostReleaseManifest {
  if (!RELEASE_ID.test(releaseId)) throw new Error('host-release-id-invalid');
  const root = join(layout.releasesDir, releaseId);
  const manifestPath = join(root, 'host-release.json');
  if (!existsSync(root)) throw new Error('host-release-manifest-missing');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('host-release-manifest-missing');
  if (!existsSync(manifestPath)) throw new Error('host-release-manifest-missing');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('host-release-manifest-missing');
  const manifest = parseHostReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.releaseId !== releaseId) throw new Error('host-release-id-mismatch');
  for (const [entryKey, hashKey] of [
    ['runtimeEntry', 'runtimeSha256'], ['webEntry', 'webSha256'], ['pluginEntry', 'pluginSha256'],
  ] as const) {
    const path = contained(root, manifest.artifacts[entryKey]);
    if (!existsSync(path)) throw new Error('host-release-artifact-mismatch');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(path) !== manifest.artifacts[hashKey]) {
      throw new Error('host-release-artifact-mismatch');
    }
  }
  return manifest;
}

export function assertRollbackCompatible(current: HostReleaseManifest, target: HostReleaseManifest): void {
  if (current.version !== 2 || target.version !== 2) throw new Error('host-release-schema-proof-incomplete');
  if (Object.keys(current.schemas).some((key) => (
    current.schemas[key as keyof typeof current.schemas] !== target.schemas[key as keyof typeof target.schemas]
  ))) throw new Error('host-release-schema-incompatible');
  if (target.protocol.api < current.protocol.minClient || target.protocol.api > current.protocol.maxClient) {
    throw new Error('host-release-protocol-incompatible');
  }
}
