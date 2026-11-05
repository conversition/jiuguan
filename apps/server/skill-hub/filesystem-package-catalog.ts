/** Canonical package source for the existing Runtime. Pins are scope, never admission authority. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AGENT_SKILL_BODY_REQUEST_VERSION, createAgentSkillCatalogSnapshot,
  type AgentSkillCatalogPort, type AgentSkillBodyRequestV1,
} from '@jiuguan/skill-hub';
import { migrateLegacySkillPackages, readLegacySkillPackages } from './legacy-package-migrator.ts';
import type { LegacyAgentSkillCatalogAdapter } from './legacy-catalog-adapter.ts';

export interface FilesystemSkillPackagePin {
  readonly skillId: string;
  readonly version: string;
  /** Binds every resource, source identity and package policy, not only the program body. */
  readonly packageDigest: string;
}
export interface FilesystemSkillPackageCatalogOptions {
  readonly directory: string;
  /** Host-owned exact roots AND dependencies. No implicit dependency enrollment. */
  readonly pins: readonly FilesystemSkillPackagePin[];
  /** Current host control, checked on construction and every read. Missing/false is closed. */
  readonly isEnabled: () => boolean;
}
export interface FilesystemSkillPackageCatalog extends LegacyAgentSkillCatalogAdapter {
  readonly pins: readonly FilesystemSkillPackagePin[];
  /** Re-read the complete packages; usable by the existing guarded Runtime admission. */
  readonly assertCurrent: () => void;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ID = /^skill:sha256:[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,239}$/u;
const key = (ref: Pick<FilesystemSkillPackagePin, 'skillId' | 'version'>) => `${ref.skillId}\u0000${ref.version}`;
function fail(reason: string): never { throw new Error(`agent-skill-package-catalog-${reason}`); }

/**
 * Explicit opt-in beside the legacy prose adapter. Both use the same selector/materializer;
 * this source never substitutes legacy text when a sidecar is absent, invalid or stale.
 * Header reads expose no bodies. Complete resource snapshots are verified before body delivery.
 * Creating this catalog neither publishes a package nor creates a profile/source authorization.
 */
export function createFilesystemSkillPackageCatalog(options: FilesystemSkillPackageCatalogOptions): FilesystemSkillPackageCatalog {
  if (!options || typeof options.directory !== 'string' || options.directory.trim().length === 0
    || typeof options.isEnabled !== 'function') fail('options-invalid');
  const directory = resolve(options.directory);
  const isEnabled = options.isEnabled.bind(options);
  if (!Array.isArray(options.pins) || options.pins.length < 1 || options.pins.length > 16) fail('pins-invalid');
  const pins = Object.freeze(Array.from(options.pins, pin => {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)
      || (Object.getPrototypeOf(pin) !== Object.prototype && Object.getPrototypeOf(pin) !== null)
      || Object.keys(pin).length !== 3 || Object.keys(pin).some(name => !['skillId', 'version', 'packageDigest'].includes(name))
      || typeof pin.skillId !== 'string' || !ID.test(pin.skillId)
      || typeof pin.version !== 'string' || !VERSION.test(pin.version)
      || typeof pin.packageDigest !== 'string' || !DIGEST.test(pin.packageDigest)) fail('pins-invalid');
    return Object.freeze({ skillId: pin.skillId, version: pin.version, packageDigest: pin.packageDigest });
  }).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const pinnedKeys = new Set(pins.map(key));
  if (pinnedKeys.size !== pins.length) fail('pins-invalid');
  const assertEnabled = (): void => { if (isEnabled() !== true) fail('disabled'); };

  const readPinned = () => {
    assertEnabled();
    const scanned = readLegacySkillPackages(directory, { includeResourceBytes: true });
    const migrated = migrateLegacySkillPackages(scanned.documents, { missingDirectories: scanned.missingDirectories });
    const byId = new Map(migrated.packages.map(item => [item.package.bundle.header.manifest.skillId, item]));
    const selected = pins.map(pin => {
      const item = byId.get(pin.skillId);
      if (!item) fail('pin-unavailable');
      const entry = migrated.report.entries.find(row => row.directory === item.directory);
      if (entry?.status !== 'compiled' || entry.program !== 'canonical'
        || item.sourceBinding?.form !== 'explicit-program') fail('program-invalid');
      if (item.package.bundle.header.manifest.version !== pin.version || item.package.packageDigest !== pin.packageDigest) {
        fail('pin-mismatch');
      }
      for (const dependency of item.package.bundle.header.manifest.requires) {
        if (!pinnedKeys.has(key(dependency))) fail('dependency-unpinned');
      }
      const source = scanned.documents.find(document => document.directory === item.directory)!;
      const bytes = source.resourceBytes;
      if (!bytes || bytes.size !== item.package.resources.length) fail('resource-invalid');
      for (const resource of item.package.resources) {
        const value = bytes.get(resource.path);
        if (!value || value.byteLength !== resource.bytes
          || `sha256:${createHash('sha256').update(value).digest('hex')}` !== resource.sha256
          || (resource.role === 'body' && !Buffer.from(value).equals(Buffer.from(item.package.bundle.body, 'utf8')))) {
          fail('resource-invalid');
        }
      }
      return { item, source };
    });
    assertEnabled();
    return selected;
  };

  const selected = readPinned();
  const snapshot = createAgentSkillCatalogSnapshot(selected.map(({ item }) => item.package.bundle.header));
  const headers = new Map(snapshot.headers.map(header => [header.manifestDigest, header]));
  const assertCurrent = (): void => { readPinned(); };
  const catalogPort: AgentSkillCatalogPort = Object.freeze({
    async readCatalog() {
      assertCurrent();
      return snapshot;
    },
    async loadBody(request: AgentSkillBodyRequestV1) {
      assertEnabled();
      if (request.catalogRevision !== snapshot.catalogRevision) throw new Error('agent-skill-catalog-revision-stale');
      const header = headers.get(request.manifestDigest);
      if (request.requestVersion !== AGENT_SKILL_BODY_REQUEST_VERSION || !header
        || header.manifest.skillId !== request.skillId || header.manifest.version !== request.version
        || header.manifest.bodyHash !== request.bodyHash) throw new Error('agent-skill-body-reference-invalid');
      // Do not serve cached bodies after deletion, source edits, attachment changes or control revocation.
      const current = readPinned();
      return current.find(({ item }) => item.package.bundle.header.manifestDigest === request.manifestDigest)!.item.package.bundle.body;
    },
  });
  return Object.freeze({ pins, snapshot, catalogPort, assertCurrent, skipped: Object.freeze([]),
    published: Object.freeze(selected.map(({ item, source }) => Object.freeze({
      skillId: item.package.bundle.header.manifest.skillId,
      version: item.package.bundle.header.manifest.version,
      sourceVersion: source.record.version.normalize('NFC').trim(),
      documentIdentityDigest: source.documentIdentityDigest,
      manifestDigest: item.package.bundle.header.manifestDigest,
    }))),
  });
}
