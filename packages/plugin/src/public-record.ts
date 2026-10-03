import { createHash, timingSafeEqual } from 'node:crypto';
import type { PluginRecord } from './registry.ts';

export type PluginSourceKind = 'local-path' | 'remote-url';

export interface PluginSourceIdentity {
  sourceKind: PluginSourceKind;
  /** Algorithm-tagged, lowercase SHA-256 digest of the normalized source. */
  sourceFingerprint: string;
}

/**
 * Safe wire projection of PluginRecord. The persisted source is deliberately
 * absent: callers get only a coarse kind and an equality fingerprint.
 */
export interface PublicPluginRecord {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  license?: string;
  includes: string[];
  server?: string;
  hooks: string[];
  permissions: { network?: boolean; fs?: boolean; runtime?: boolean };
  kind: 'st' | 'dsh';
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  sourceKind: PluginSourceKind;
  sourceFingerprint: string;
}

interface NormalizedPluginSource {
  kind: PluginSourceKind;
  value: string;
}

const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const SCP_SOURCE_RE = /^(?:[^@\s]+@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/;
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'ftp:': '21',
  'git:': '9418',
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
};

function sourceText(source: string): string {
  if (typeof source !== 'string') throw new TypeError('plugin source must be a string');
  const value = source.trim().normalize('NFC');
  if (!value || value.includes('\0')) throw new TypeError('plugin source must not be empty');
  return value;
}

function collapsePathSegments(path: string, absolute: boolean): string[] {
  const output: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length > 0 && output.at(-1) !== '..') output.pop();
      else if (!absolute) output.push(segment);
      continue;
    }
    output.push(segment);
  }
  return output;
}

/**
 * Lexical path normalization is intentionally independent of the host OS.
 * It never resolves symlinks or exposes the result; it only feeds SHA-256.
 */
function normalizeLocalPath(source: string): string {
  let path = source.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');

  if (path.startsWith('//')) {
    const segments = collapsePathSegments(path.slice(2), true).map((part) => part.toLowerCase());
    return `windows-unc://${segments.join('/')}`;
  }

  if (WINDOWS_DRIVE_RE.test(path)) {
    const drive = path.slice(0, 1).toLowerCase();
    const segments = collapsePathSegments(path.slice(2), true).map((part) => part.toLowerCase());
    return `windows-drive:${drive}:/${segments.join('/')}`;
  }

  const absolute = path.startsWith('/');
  const segments = collapsePathSegments(path, absolute);
  if (absolute) return `posix:/${segments.join('/')}`;
  return `relative:${segments.join('/') || '.'}`;
}

function normalizeFileUrl(url: URL): NormalizedPluginSource {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new TypeError('plugin file URL contains invalid escaping');
  }
  const host = url.hostname.toLowerCase();
  if (!host && /^\/[A-Za-z]:\//.test(decodedPath)) decodedPath = decodedPath.slice(1);
  const path = host ? `//${host}${decodedPath}` : decodedPath;
  const suffix = url.search;
  return { kind: 'local-path', value: normalizeLocalPath(path) + suffix };
}

function normalizeRemoteUrl(source: string): NormalizedPluginSource {
  const url = new URL(source);
  url.username = '';
  url.password = '';
  url.hash = '';
  const defaultPort = DEFAULT_PORTS[url.protocol.toLowerCase()];
  if (defaultPort && url.port === defaultPort) url.port = '';
  if (url.protocol === 'file:') return normalizeFileUrl(url);
  return { kind: 'remote-url', value: url.href };
}

function normalizeScpSource(source: string): NormalizedPluginSource | null {
  if (WINDOWS_DRIVE_RE.test(source)) return null;
  const match = SCP_SOURCE_RE.exec(source);
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  const pathWithoutFragment = match[2]!.split('#', 1)[0]!;
  const path = collapsePathSegments(pathWithoutFragment.replaceAll('\\', '/'), false).join('/');
  if (!path) throw new TypeError('plugin remote source path must not be empty');
  return { kind: 'remote-url', value: `scp://${host}/${path}` };
}

function normalizePluginSource(source: string): NormalizedPluginSource {
  const value = sourceText(source);
  if (URL_SCHEME_RE.test(value)) return normalizeRemoteUrl(value);
  const scp = normalizeScpSource(value);
  if (scp) return scp;
  return { kind: 'local-path', value: normalizeLocalPath(value) };
}

function digestSource(source: NormalizedPluginSource): string {
  const digest = createHash('sha256')
    .update(source.kind)
    .update('\0')
    .update(source.value)
    .digest('hex');
  return `sha256:${digest}`;
}

/** Return the non-secret identity used by public plugin APIs and sync checks. */
export function describePluginSource(source: string): PluginSourceIdentity {
  const normalized = normalizePluginSource(source);
  return {
    sourceKind: normalized.kind,
    sourceFingerprint: digestSource(normalized),
  };
}

/**
 * Compare a caller-supplied source to a public fingerprint without exposing
 * either normalized source. Malformed sources/fingerprints fail closed.
 */
export function matchesPluginSourceFingerprint(
  candidateSource: string,
  expectedFingerprint: string,
): boolean {
  if (typeof expectedFingerprint !== 'string' || !FINGERPRINT_RE.test(expectedFingerprint)) return false;
  let actual: string;
  try {
    actual = describePluginSource(candidateSource).sourceFingerprint;
  } catch {
    return false;
  }
  const actualBytes = Buffer.from(actual.slice('sha256:'.length), 'hex');
  const expectedBytes = Buffer.from(expectedFingerprint.slice('sha256:'.length), 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function publicHomepage(homepage: string | undefined): string | undefined {
  if (!homepage) return undefined;
  try {
    const url = new URL(homepage);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/** Explicit field-by-field projection: PluginRecord.source can never leak via object spread. */
export function toPublicPluginRecord(record: PluginRecord): PublicPluginRecord {
  const source = describePluginSource(record.source);
  const homepage = publicHomepage(record.homepage);
  return {
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    version: record.version,
    description: record.description,
    author: record.author,
    ...(homepage ? { homepage } : {}),
    ...(record.license ? { license: record.license } : {}),
    includes: [...record.includes],
    ...(record.server ? { server: record.server } : {}),
    hooks: [...record.hooks],
    permissions: { ...record.permissions },
    kind: record.kind,
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    ...source,
  };
}
