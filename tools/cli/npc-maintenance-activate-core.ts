import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MaintenanceJobManager, MAINTENANCE_JOB_DB_FILE } from '../../apps/server/maintenance-job-manager.ts';
import { acquireServerProcessLock } from '../../apps/server/process-lock.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import {
  assertNpcActivationSourceDatabases,
  createNpcMaintenanceActivationMarker,
  NPC_MAINTENANCE_BACKUP_MANIFEST_VERSION,
  NPC_MAINTENANCE_HISTORIC_SESSION_SCHEMA_VERSION,
  sha256ActivationFile,
  writeNpcMaintenanceActivationMarker,
} from '../../apps/server/npc-maintenance-activation.ts';

export const NPC_MAINTENANCE_ACTIVATION_ACK = 'p14-npc-characterstore-v1' as const;
export const NPC_MAINTENANCE_ACTIVATION_VERSION = NPC_MAINTENANCE_BACKUP_MANIFEST_VERSION;

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const OPTIONAL_CONTROL_DATABASES = Object.freeze([
  'agent-control.sqlite',
  'agent-admission.sqlite',
  'arc-maintenance-projection.sqlite',
] as const);

export interface NpcMaintenanceBackupEntry {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly applicationId: number;
  readonly userVersion: number;
}

export interface NpcMaintenanceActivationResult {
  readonly version: typeof NPC_MAINTENANCE_ACTIVATION_VERSION;
  readonly sessionId: string;
  readonly backupDirectory: string;
  readonly backups: readonly NpcMaintenanceBackupEntry[];
  readonly sessionSchemaBefore: number;
  readonly sessionSchemaAfter: number;
  readonly maintenance: Readonly<{
    globalEnabled: boolean;
    sessionEnabled: boolean;
    effectiveEnabled: boolean;
    defaultMode: 'shadow' | 'apply';
  }>;
  readonly providerCalls: 0;
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

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

function backupSqlite(sourcePath: string, destinationPath: string): NpcMaintenanceBackupEntry {
  requirePlainFile(sourcePath, 'activation-source-database');
  if (existsSync(destinationPath) || existsSync(destinationPath + '-wal')
    || existsSync(destinationPath + '-shm')) throw new Error('activation-backup-conflict');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec(`PRAGMA busy_timeout=5000; VACUUM INTO ${sqlString(destinationPath)}`);
  } finally {
    source.close();
  }
  requirePlainFile(destinationPath, 'activation-backup-database');
  const backup = new DatabaseSync(destinationPath, { readOnly: true });
  let applicationId: number;
  let userVersion: number;
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>;
    if (integrity.length !== 1 || String(integrity[0]?.integrity_check ?? '').toLowerCase() !== 'ok') {
      throw new Error('activation-backup-integrity-failed');
    }
    applicationId = Number((backup.prepare('PRAGMA application_id').get() as { application_id: unknown }).application_id);
    userVersion = Number((backup.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version);
  } finally {
    backup.close();
  }
  return Object.freeze({
    file: basename(destinationPath),
    bytes: lstatSync(destinationPath).size,
    sha256: sha256ActivationFile(destinationPath),
    applicationId,
    userVersion,
  });
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('activation-clock-invalid');
  }
  return value;
}

/**
 * Exclusive, zero-Provider activation for one exact session.
 *
 * The process lock proves the service is stopped, VACUUM INTO captures committed WAL state,
 * and the persisted Maintenance switch is opened only after the current migration and integrity checks.
 */
export function activateNpcMaintenance(input: {
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly acknowledgement: string;
  readonly now?: () => string;
}): NpcMaintenanceActivationResult {
  if (input.acknowledgement !== NPC_MAINTENANCE_ACTIVATION_ACK) {
    throw new Error(`activation requires --ack ${NPC_MAINTENANCE_ACTIVATION_ACK}`);
  }
  if (!SESSION_ID_RE.test(input.sessionId)) throw new Error('activation-session-id-invalid');
  const dataDirectory = resolve(input.dataDirectory);
  requirePlainDirectory(dataDirectory, 'activation-data-directory');
  const sessionPath = join(dataDirectory, `${input.sessionId}.db`);
  const maintenancePath = join(dataDirectory, MAINTENANCE_JOB_DB_FILE);

  const lock = acquireServerProcessLock({
    dataDir: dataDirectory,
    instanceId: `npc-activation-${randomUUID()}`,
  });
  let manager: MaintenanceJobManager | undefined;
  try {
    // The source identity is established only after exclusive ownership. Otherwise a
    // concurrently starting server could replace or migrate the exact files we validated.
    requirePlainFile(sessionPath, 'activation-session-database');
    requirePlainFile(maintenancePath, 'activation-maintenance-database');
    assertNpcActivationSourceDatabases(
      dataDirectory,
      input.sessionId,
      [NPC_MAINTENANCE_HISTORIC_SESSION_SCHEMA_VERSION, SCHEMA_VERSION],
    );
    const capturedAt = canonicalTimestamp((input.now ?? (() => new Date().toISOString()))());
    const backupRoot = join(dataDirectory, '.migration-backups');
    if (!existsSync(backupRoot)) mkdirSync(backupRoot, { recursive: false, mode: 0o700 });
    requirePlainDirectory(backupRoot, 'activation-backup-root');
    if (dirname(backupRoot) !== dataDirectory) throw new Error('activation-backup-root-outside-data');
    const backupDirectory = join(
      backupRoot,
      `npc-characterstore-${capturedAt.replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
    requirePlainDirectory(backupDirectory, 'activation-backup-directory');

    const sourceFiles = [
      `${input.sessionId}.db`,
      MAINTENANCE_JOB_DB_FILE,
      ...OPTIONAL_CONTROL_DATABASES.filter((file) => existsSync(join(dataDirectory, file))),
    ];
    const backups = Object.freeze(sourceFiles.map((file) => (
      backupSqlite(join(dataDirectory, file), join(backupDirectory, file))
    )));
    const manifestPath = join(backupDirectory, 'backup-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      version: NPC_MAINTENANCE_ACTIVATION_VERSION,
      capturedAt,
      sessionId: input.sessionId,
      backups,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const backupManifestSha256 = sha256ActivationFile(manifestPath);
    lock.assertOwned();

    const sessionBackup = backups.find((entry) => entry.file === `${input.sessionId}.db`)!;
    manager = new MaintenanceJobManager({ dataDir: dataDirectory });
    // Fail closed while the business schema is migrated.
    manager.setGlobalEnabled(false);
    const session = new MemoryDb({ path: sessionPath });
    let sessionSchemaAfter: number;
    try {
      sessionSchemaAfter = session.userVersion();
      if (sessionSchemaAfter !== SCHEMA_VERSION || session.integrityCheck().toLowerCase() !== 'ok') {
        throw new Error('activation-session-migration-invalid');
      }
    } finally {
      session.close();
    }
    manager.setDefaultMode('shadow');
    manager.setSessionEnabled(input.sessionId, true);
    const preparedSettings = manager.settings(input.sessionId);
    if (preparedSettings.globalEnabled || !preparedSettings.sessionEnabled
      || preparedSettings.effectiveEnabled || preparedSettings.defaultMode !== 'shadow') {
      throw new Error('activation-maintenance-settings-invalid');
    }

    // A tracked launcher profile is not authority by itself. The runtime only accepts an
    // active marker that is bound to this exact session, task kind and backup manifest.
    const preparedMarker = createNpcMaintenanceActivationMarker({
      status: 'prepared',
      sessionId: input.sessionId,
      backupDirectory,
      backupManifestSha256,
      activatedAt: capturedAt,
    });
    lock.assertOwned();
    writeNpcMaintenanceActivationMarker(dataDirectory, preparedMarker);

    const result: NpcMaintenanceActivationResult = Object.freeze({
      version: NPC_MAINTENANCE_ACTIVATION_VERSION,
      sessionId: input.sessionId,
      backupDirectory,
      backups,
      sessionSchemaBefore: sessionBackup.userVersion,
      sessionSchemaAfter,
      maintenance: Object.freeze({
        globalEnabled: true,
        sessionEnabled: true,
        effectiveEnabled: true,
        defaultMode: 'shadow' as const,
      }),
      providerCalls: 0,
    });
    // Last two state changes while the exclusive server lock is held. If marker activation
    // fails, catch closes the global gate; there is no fallible work after the active marker.
    lock.assertOwned();
    manager.setGlobalEnabled(true);
    writeNpcMaintenanceActivationMarker(dataDirectory, Object.freeze({
      ...preparedMarker,
      status: 'active' as const,
    }));
    return result;
  } catch (error) {
    try { manager?.setGlobalEnabled(false); } catch { /* keep the original activation failure */ }
    throw error;
  } finally {
    try { manager?.close(); } finally { lock.release(); }
  }
}
