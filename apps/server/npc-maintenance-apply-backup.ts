import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isCanonicalManagedLocalSessionId } from './managed-local-session-scope.ts';
import {
  createNpcMaintenanceApplyBackupMarker,
  NPC_MAINTENANCE_APPLY_BACKUP_MANIFEST_VERSION,
  NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION,
  NPC_MAINTENANCE_SESSION_SCHEMA_VERSION,
  npcMaintenanceApplyBackupAllows,
  readNpcMaintenanceActivationMarkers,
  sha256ActivationFile,
  writeNpcMaintenanceActivationMarker,
} from './npc-maintenance-activation.ts';
import { resolveSessionDatabase } from './security.ts';
import { SqliteOnlineSnapshotAdapter } from './snapshot-sqlite.ts';

export const NPC_MAINTENANCE_APPLY_BACKUP_ANCHOR_VERSION =
  'npc-maintenance-apply-backup-anchor-v1' as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

export interface NpcMaintenanceApplyBackupAnchor {
  readonly version: typeof NPC_MAINTENANCE_APPLY_BACKUP_ANCHOR_VERSION;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly capturedAt: string;
}

export interface NpcMaintenanceApplyBackupStoreOptions {
  readonly dataDir: string;
  readonly currentRevision: (sessionId: string) => string;
  readonly now?: () => string;
  readonly randomId?: () => string;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('npc-maintenance-backup-clock-invalid');
  }
  return value;
}

function requirePlainDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label}-missing`);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

function requirePlainFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label}-missing`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

function anchorFor(input: {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly capturedAt: string;
}): NpcMaintenanceApplyBackupAnchor {
  return Object.freeze({
    version: NPC_MAINTENANCE_APPLY_BACKUP_ANCHOR_VERSION,
    sessionId: input.sessionId,
    sourceRevision: input.sourceRevision,
    backupDirectory: input.backupDirectory,
    backupManifestSha256: input.backupManifestSha256,
    capturedAt: input.capturedAt,
  });
}

/** Strictly binds a persisted backup proof to the proposal about to write. */
export function assertNpcMaintenanceApplyBackupAnchor(
  value: unknown,
  expected: { readonly sessionId: string; readonly sourceRevision: string },
): asserts value is NpcMaintenanceApplyBackupAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('npc-maintenance-backup-anchor-invalid');
  }
  const row = value as Record<string, unknown>;
  const keys = [
    'version', 'sessionId', 'sourceRevision', 'backupDirectory',
    'backupManifestSha256', 'capturedAt',
  ];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))
    || row.version !== NPC_MAINTENANCE_APPLY_BACKUP_ANCHOR_VERSION
    || row.sessionId !== expected.sessionId
    || row.sourceRevision !== expected.sourceRevision
    || typeof row.backupDirectory !== 'string'
    || !/^npc-guarded-auto-[A-Za-z0-9_-]{8,96}$/u.test(row.backupDirectory)
    || !SHA256_RE.test(String(row.backupManifestSha256))
    || typeof row.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(row.capturedAt))
    || new Date(row.capturedAt).toISOString() !== row.capturedAt) {
    throw new Error('npc-maintenance-backup-anchor-invalid');
  }
}

/**
 * Per-session, source-revision-bound rollback snapshot gate for guarded NPC writes.
 * It performs no Provider work and never mutates the session database.
 */
export class NpcMaintenanceApplyBackupStore {
  readonly #dataDir: string;
  readonly #currentRevision: (sessionId: string) => string;
  readonly #now: () => string;
  readonly #randomId: () => string;
  readonly #sqlite = new SqliteOnlineSnapshotAdapter();

  constructor(options: NpcMaintenanceApplyBackupStoreOptions) {
    this.#dataDir = resolve(options.dataDir);
    this.#currentRevision = options.currentRevision;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
  }

  prepare(input: {
    readonly sessionId: string;
    readonly sourceRevision: string;
  }): NpcMaintenanceApplyBackupAnchor {
    if (!isCanonicalManagedLocalSessionId(input.sessionId)
      || !SHA256_RE.test(input.sourceRevision)) {
      throw new Error('npc-maintenance-backup-binding-invalid');
    }
    requirePlainDirectory(this.#dataDir, 'npc-maintenance-backup-data-directory');
    const sessionPath = resolveSessionDatabase(this.#dataDir, `${input.sessionId}.db`);
    if (!sessionPath || dirname(sessionPath) !== this.#dataDir) {
      throw new Error('npc-maintenance-backup-session-invalid');
    }
    requirePlainFile(sessionPath, 'npc-maintenance-backup-session-database');
    if (this.#currentRevision(input.sessionId) !== input.sourceRevision) {
      throw new Error('npc-maintenance-backup-source-revision-stale');
    }

    const existing = readNpcMaintenanceActivationMarkers(this.#dataDir).find((record) => (
      record.version === NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION
      && record.sessionId === input.sessionId
      && record.sourceRevision === input.sourceRevision
    ));
    if (existing?.version === NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION
      && npcMaintenanceApplyBackupAllows(existing, input.sessionId, input.sourceRevision)) {
      if (this.#currentRevision(input.sessionId) !== input.sourceRevision) {
        throw new Error('npc-maintenance-backup-source-revision-stale');
      }
      return anchorFor({
        sessionId: existing.sessionId,
        sourceRevision: existing.sourceRevision,
        backupDirectory: existing.backupDirectory,
        backupManifestSha256: existing.backupManifestSha256,
        capturedAt: existing.activatedAt,
      });
    }

    const capturedAt = canonicalTimestamp(this.#now());
    const suffix = this.#randomId().replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 16);
    if (suffix.length < 8) throw new Error('npc-maintenance-backup-id-invalid');
    const backupRoot = join(this.#dataDir, '.migration-backups');
    if (!existsSync(backupRoot)) mkdirSync(backupRoot, { recursive: false, mode: 0o700 });
    requirePlainDirectory(backupRoot, 'npc-maintenance-backup-root');
    if (dirname(backupRoot) !== this.#dataDir) throw new Error('npc-maintenance-backup-root-invalid');
    const backupDirectoryName = `npc-guarded-auto-${capturedAt.replace(/[-:.]/gu, '')}-${suffix}`;
    const backupDirectory = join(backupRoot, backupDirectoryName);
    mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
    let published = false;
    try {
      requirePlainDirectory(backupDirectory, 'npc-maintenance-backup-directory');
      if (statSync(this.#dataDir).dev !== statSync(backupDirectory).dev) {
        throw new Error('npc-maintenance-backup-cross-volume');
      }
      const destinationPath = join(backupDirectory, `${input.sessionId}.db`);
      this.#sqlite.captureOnline({
        component: {
          id: `session-db:${input.sessionId}`,
          role: 'session-db',
          sourceRelativePath: `${input.sessionId}.db`,
          captureMode: 'sqlite-online',
          schemaVersion: NPC_MAINTENANCE_SESSION_SCHEMA_VERSION,
        },
        sourcePath: sessionPath,
        destinationPath,
      });
      const backupStats = lstatSync(destinationPath);
      const backupEntry = Object.freeze({
        file: `${input.sessionId}.db`,
        bytes: backupStats.size,
        sha256: sha256ActivationFile(destinationPath),
        applicationId: 0,
        userVersion: NPC_MAINTENANCE_SESSION_SCHEMA_VERSION,
      });
      if (this.#currentRevision(input.sessionId) !== input.sourceRevision) {
        throw new Error('npc-maintenance-backup-source-revision-stale');
      }
      const manifestPath = join(backupDirectory, 'backup-manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify({
        version: NPC_MAINTENANCE_APPLY_BACKUP_MANIFEST_VERSION,
        capturedAt,
        sessionId: input.sessionId,
        sourceRevision: input.sourceRevision,
        backups: [backupEntry],
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
      chmodSync(destinationPath, 0o400);
      chmodSync(manifestPath, 0o400);
      const backupManifestSha256 = sha256ActivationFile(manifestPath);
      const marker = createNpcMaintenanceApplyBackupMarker({
        sessionId: input.sessionId,
        sourceRevision: input.sourceRevision,
        backupDirectory: backupDirectoryName,
        backupManifestSha256,
        activatedAt: capturedAt,
      });
      writeNpcMaintenanceActivationMarker(this.#dataDir, marker);
      published = true;
      const verified = readNpcMaintenanceActivationMarkers(this.#dataDir);
      if (!npcMaintenanceApplyBackupAllows(verified, input.sessionId, input.sourceRevision)) {
        throw new Error('npc-maintenance-backup-verification-failed');
      }
      if (this.#currentRevision(input.sessionId) !== input.sourceRevision) {
        throw new Error('npc-maintenance-backup-source-revision-stale');
      }
      return anchorFor({
        sessionId: input.sessionId,
        sourceRevision: input.sourceRevision,
        backupDirectory: backupDirectoryName,
        backupManifestSha256,
        capturedAt,
      });
    } catch (error) {
      // Before registry publication this directory has no authority and can be
      // removed safely. Published stale anchors are retained as forensic/rollback
      // evidence but can never authorize a different revision or session.
      if (!published) rmSync(backupDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}
