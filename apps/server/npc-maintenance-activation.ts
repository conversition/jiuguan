import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import type { MaintenanceTaskKind } from './maintenance-types.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_DB_FILE,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from './maintenance-job-manager.ts';

export const NPC_MAINTENANCE_ACTIVATION_FILE = 'npc-maintenance-activation.json' as const;
export const NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION =
  'p14-npc-characterstore-activation-v1' as const;
export const NPC_MAINTENANCE_BACKUP_MANIFEST_VERSION =
  'p14-npc-maintenance-activation-v1' as const;
export const NPC_MAINTENANCE_ACTIVATION_REGISTRY_VERSION =
  'p14-npc-maintenance-activation-registry-v2' as const;
export const NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION =
  'p14-npc-guarded-apply-backup-v2' as const;
export const NPC_MAINTENANCE_APPLY_BACKUP_MANIFEST_VERSION =
  'p14-npc-guarded-apply-manifest-v2' as const;
export const NPC_MAINTENANCE_SESSION_SCHEMA_VERSION = SCHEMA_VERSION;

// Schema 16 is the only historic Session layout whose backup/activation proof
// remains structurally readable after the v17 authority cutover. It is never
// runtime authority: readers filter it out before backup or source validation,
// while an offline re-activation may atomically replace the same session/kind.
export const NPC_MAINTENANCE_HISTORIC_SESSION_SCHEMA_VERSION = 16;
const NPC_STORED_SESSION_SCHEMAS: readonly number[] = Object.freeze([
  NPC_MAINTENANCE_HISTORIC_SESSION_SCHEMA_VERSION,
  SCHEMA_VERSION,
]);

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const BACKUP_DIRECTORY_RE = /^npc-(?:characterstore|guarded-auto)-[A-Za-z0-9_-]{8,96}$/u;
// Executor routing / isolated AL proposal staging/publication change no historic NPC proof.
// Preserve supported markers explicitly instead of moving a current-1 window.
const NPC_BACKUP_MAINTENANCE_SCHEMAS: readonly number[] = Object.freeze([
  3, 4, 5, 6, 7, MAINTENANCE_JOB_SCHEMA_VERSION,
]);
const OPTIONAL_BACKUP_FILES = Object.freeze(new Set([
  'agent-control.sqlite',
  'agent-admission.sqlite',
  'arc-maintenance-projection.sqlite',
]));
const REQUIRED_SESSION_TABLES = Object.freeze([
  'memory_meta',
  'chat_log',
  'character_registry',
  'character_fact_log',
  'character_alias_operation',
] as const);
const REQUIRED_MAINTENANCE_TABLES = Object.freeze([
  'maintenance_settings',
  'maintenance_session_settings',
  'maintenance_job',
  'maintenance_pending_proposal',
] as const);

export interface NpcMaintenanceActivationMarker {
  readonly version: typeof NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION;
  readonly status: 'prepared' | 'active';
  readonly sessionId: string;
  readonly taskKinds: readonly ['npc_state'];
  readonly sessionSchemaVersion: number;
  readonly maintenanceSchemaVersion: number;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly activatedAt: string;
}

/**
 * A just-in-time rollback proof for one exact guarded NPC proposal revision.
 * Unlike the legacy activation marker, this record is not an execution grant:
 * it is consumed only at the final business-write boundary.
 */
export interface NpcMaintenanceApplyBackupMarker {
  readonly version: typeof NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION;
  readonly status: 'active';
  readonly sessionId: string;
  readonly taskKinds: readonly ['npc_state'];
  readonly sourceRevision: string;
  readonly sessionSchemaVersion: number;
  readonly maintenanceSchemaVersion: number;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly activatedAt: string;
}

export type NpcMaintenanceActivationRecord =
  | NpcMaintenanceActivationMarker
  | NpcMaintenanceApplyBackupMarker;

interface NpcMaintenanceActivationRegistry {
  readonly version: typeof NPC_MAINTENANCE_ACTIVATION_REGISTRY_VERSION;
  readonly activations: readonly NpcMaintenanceActivationRecord[];
}

export interface NpcMaintenanceActivationDeletionResult {
  readonly sessionId: string;
  readonly removedRecords: number;
  readonly deletedBackupDirectories: number;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function requirePlainFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label}-missing`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

function requirePlainDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label}-missing`);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

export function sha256ActivationFile(path: string): string {
  requirePlainFile(path, 'npc-activation-hash-source');
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`npc-activation-${name}-invalid`);
  return Number(value);
}

function requireTables(db: DatabaseSync, tables: readonly string[], label: string): void {
  const query = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?");
  for (const table of tables) {
    if (!query.get(table)) throw new Error(`${label}-sentinel-missing`);
  }
}

/** Read-only validation performed before MemoryDb is allowed to touch the target. */
export function assertNpcActivationSourceDatabases(
  dataDirectory: string,
  sessionId: string,
  compatibleSessionVersions: readonly number[],
): { readonly sessionVersion: number } {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('activation-session-id-invalid');
  const dataDir = resolve(dataDirectory);
  const sessionPath = join(dataDir, `${sessionId}.db`);
  const maintenancePath = join(dataDir, MAINTENANCE_JOB_DB_FILE);
  requirePlainFile(sessionPath, 'activation-session-database');
  requirePlainFile(maintenancePath, 'activation-maintenance-database');
  const session = new DatabaseSync(sessionPath, { readOnly: true });
  try {
    if (pragma(session, 'application_id') !== 0) throw new Error('activation-session-application-id-mismatch');
    const sessionVersion = pragma(session, 'user_version');
    if (!compatibleSessionVersions.includes(sessionVersion)) {
      throw new Error('activation-session-schema-unsupported');
    }
    requireTables(session, REQUIRED_SESSION_TABLES.filter((table) => (
      table !== 'character_alias_operation'
      || sessionVersion >= NPC_MAINTENANCE_HISTORIC_SESSION_SCHEMA_VERSION
    )), 'activation-session');
    return Object.freeze({ sessionVersion });
  } finally {
    session.close();
    const maintenance = new DatabaseSync(maintenancePath, { readOnly: true });
    try {
      if (pragma(maintenance, 'application_id') !== MAINTENANCE_JOB_APPLICATION_ID
        || pragma(maintenance, 'user_version') !== MAINTENANCE_JOB_SCHEMA_VERSION) {
        throw new Error('activation-maintenance-metadata-mismatch');
      }
      requireTables(maintenance, REQUIRED_MAINTENANCE_TABLES, 'activation-maintenance');
    } finally {
      maintenance.close();
    }
  }
}

export function createNpcMaintenanceActivationMarker(input: {
  readonly status: 'prepared' | 'active';
  readonly sessionId: string;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly activatedAt: string;
}): NpcMaintenanceActivationMarker {
  const backupDirectory = basename(input.backupDirectory);
  if (!SESSION_ID_RE.test(input.sessionId)
    || !BACKUP_DIRECTORY_RE.test(backupDirectory)
    || !SHA256_RE.test(input.backupManifestSha256)
    || !canonicalTimestamp(input.activatedAt)) throw new Error('npc-activation-marker-input-invalid');
  return Object.freeze({
    version: NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION,
    status: input.status,
    sessionId: input.sessionId,
    taskKinds: Object.freeze(['npc_state'] as const),
    sessionSchemaVersion: SCHEMA_VERSION,
    maintenanceSchemaVersion: MAINTENANCE_JOB_SCHEMA_VERSION,
    backupDirectory,
    backupManifestSha256: input.backupManifestSha256,
    activatedAt: input.activatedAt,
  });
}

export function createNpcMaintenanceApplyBackupMarker(input: {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly backupDirectory: string;
  readonly backupManifestSha256: string;
  readonly activatedAt: string;
}): NpcMaintenanceApplyBackupMarker {
  const backupDirectory = basename(input.backupDirectory);
  if (!SESSION_ID_RE.test(input.sessionId)
    || !SHA256_RE.test(input.sourceRevision)
    || !BACKUP_DIRECTORY_RE.test(backupDirectory)
    || !SHA256_RE.test(input.backupManifestSha256)
    || !canonicalTimestamp(input.activatedAt)) {
    throw new Error('npc-apply-backup-marker-input-invalid');
  }
  return Object.freeze({
    version: NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION,
    status: 'active' as const,
    sessionId: input.sessionId,
    taskKinds: Object.freeze(['npc_state'] as const),
    sourceRevision: input.sourceRevision,
    sessionSchemaVersion: SCHEMA_VERSION,
    maintenanceSchemaVersion: MAINTENANCE_JOB_SCHEMA_VERSION,
    backupDirectory,
    backupManifestSha256: input.backupManifestSha256,
    activatedAt: input.activatedAt,
  });
}

function parseMarker(
  value: unknown,
  compatibleSessionVersions: readonly number[] = [SCHEMA_VERSION],
): NpcMaintenanceActivationMarker {
  const row = plainRecord(value);
  const keys = [
    'version', 'status', 'sessionId', 'taskKinds', 'sessionSchemaVersion',
    'maintenanceSchemaVersion', 'backupDirectory', 'backupManifestSha256', 'activatedAt',
  ] as const;
  if (!row || !exactKeys(row, keys)
    || row.version !== NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION
    || (row.status !== 'prepared' && row.status !== 'active')
    || !SESSION_ID_RE.test(String(row.sessionId))
    || !Array.isArray(row.taskKinds) || row.taskKinds.length !== 1 || row.taskKinds[0] !== 'npc_state'
    || !Number.isSafeInteger(row.sessionSchemaVersion)
    || !compatibleSessionVersions.includes(Number(row.sessionSchemaVersion))
    || !NPC_BACKUP_MAINTENANCE_SCHEMAS.includes(Number(row.maintenanceSchemaVersion))
    || !BACKUP_DIRECTORY_RE.test(String(row.backupDirectory))
    || !SHA256_RE.test(String(row.backupManifestSha256))
    || !canonicalTimestamp(row.activatedAt)) throw new Error('npc-activation-marker-invalid');
  return Object.freeze({
    version: NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION,
    status: row.status,
    sessionId: String(row.sessionId),
    taskKinds: Object.freeze(['npc_state'] as const),
    sessionSchemaVersion: Number(row.sessionSchemaVersion),
    maintenanceSchemaVersion: Number(row.maintenanceSchemaVersion),
    backupDirectory: String(row.backupDirectory),
    backupManifestSha256: String(row.backupManifestSha256),
    activatedAt: row.activatedAt,
  });
}

function parseApplyBackupMarker(
  value: unknown,
  compatibleSessionVersions: readonly number[] = [SCHEMA_VERSION],
): NpcMaintenanceApplyBackupMarker {
  const row = plainRecord(value);
  const keys = [
    'version', 'status', 'sessionId', 'taskKinds', 'sourceRevision',
    'sessionSchemaVersion', 'maintenanceSchemaVersion', 'backupDirectory',
    'backupManifestSha256', 'activatedAt',
  ] as const;
  if (!row || !exactKeys(row, keys)
    || row.version !== NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION
    || row.status !== 'active'
    || !SESSION_ID_RE.test(String(row.sessionId))
    || !Array.isArray(row.taskKinds) || row.taskKinds.length !== 1 || row.taskKinds[0] !== 'npc_state'
    || !SHA256_RE.test(String(row.sourceRevision))
    || !Number.isSafeInteger(row.sessionSchemaVersion)
    || !compatibleSessionVersions.includes(Number(row.sessionSchemaVersion))
    || !NPC_BACKUP_MAINTENANCE_SCHEMAS.includes(Number(row.maintenanceSchemaVersion))
    || !BACKUP_DIRECTORY_RE.test(String(row.backupDirectory))
    || !SHA256_RE.test(String(row.backupManifestSha256))
    || !canonicalTimestamp(row.activatedAt)) {
    throw new Error('npc-apply-backup-marker-invalid');
  }
  return Object.freeze({
    version: NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION,
    status: 'active' as const,
    sessionId: String(row.sessionId),
    taskKinds: Object.freeze(['npc_state'] as const),
    sourceRevision: String(row.sourceRevision),
    sessionSchemaVersion: Number(row.sessionSchemaVersion),
    maintenanceSchemaVersion: Number(row.maintenanceSchemaVersion),
    backupDirectory: String(row.backupDirectory),
    backupManifestSha256: String(row.backupManifestSha256),
    activatedAt: row.activatedAt,
  });
}

function parseActivationRecord(
  value: unknown,
  compatibleSessionVersions: readonly number[] = [SCHEMA_VERSION],
): NpcMaintenanceActivationRecord {
  const row = plainRecord(value);
  if (row?.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION) {
    return parseMarker(value, compatibleSessionVersions);
  }
  if (row?.version === NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION) {
    return parseApplyBackupMarker(value, compatibleSessionVersions);
  }
  throw new Error('npc-activation-marker-invalid');
}

function parseActivationDocument(
  value: unknown,
  compatibleSessionVersions: readonly number[] = [SCHEMA_VERSION],
): readonly NpcMaintenanceActivationRecord[] {
  const row = plainRecord(value);
  if (row?.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION) {
    // The original one-session document is accepted verbatim and migrated on
    // the next atomic write.
    return Object.freeze([parseMarker(value, compatibleSessionVersions)]);
  }
  if (!row || !exactKeys(row, ['version', 'activations'])
    || row.version !== NPC_MAINTENANCE_ACTIVATION_REGISTRY_VERSION
    || !Array.isArray(row.activations) || row.activations.length > 1_024) {
    throw new Error('npc-activation-registry-invalid');
  }
  const seen = new Set<string>();
  const records = row.activations.map((entry) => {
    const parsed = parseActivationRecord(entry, compatibleSessionVersions);
    const kind = parsed.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION ? 'legacy' : 'apply';
    const key = `${parsed.sessionId}\0${kind}`;
    if (seen.has(key)) throw new Error('npc-activation-registry-duplicate-session-kind');
    seen.add(key);
    return parsed;
  });
  return Object.freeze(records);
}

/**
 * An offline re-activation may encounter the original one-session marker from
 * more than one Maintenance schema ago. It is not valid runtime authority, but
 * a structurally intact marker for the exact session being re-activated may be
 * atomically replaced after a fresh backup has already been created.
 */
function replaceableStaleSingleMarker(
  value: unknown,
  replacement: NpcMaintenanceActivationRecord,
): boolean {
  if (replacement.version !== NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION) return false;
  const row = plainRecord(value);
  const keys = [
    'version', 'status', 'sessionId', 'taskKinds', 'sessionSchemaVersion',
    'maintenanceSchemaVersion', 'backupDirectory', 'backupManifestSha256', 'activatedAt',
  ] as const;
  return Boolean(row && exactKeys(row, keys)
    && row.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION
    && (row.status === 'prepared' || row.status === 'active')
    && row.sessionId === replacement.sessionId
    && Array.isArray(row.taskKinds) && row.taskKinds.length === 1 && row.taskKinds[0] === 'npc_state'
    && NPC_STORED_SESSION_SCHEMAS.includes(Number(row.sessionSchemaVersion))
    && Number.isSafeInteger(row.maintenanceSchemaVersion)
    && Number(row.maintenanceSchemaVersion) >= 1
    && Number(row.maintenanceSchemaVersion) < Math.min(...NPC_BACKUP_MAINTENANCE_SCHEMAS)
    && BACKUP_DIRECTORY_RE.test(String(row.backupDirectory))
    && SHA256_RE.test(String(row.backupManifestSha256))
    && canonicalTimestamp(row.activatedAt));
}

interface BackupManifestEntry {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly applicationId: number;
  readonly userVersion: number;
}

function parseBackupManifest(
  value: unknown,
  marker: NpcMaintenanceActivationMarker,
): readonly BackupManifestEntry[] {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['version', 'capturedAt', 'sessionId', 'backups'])
    || row.version !== NPC_MAINTENANCE_BACKUP_MANIFEST_VERSION
    || row.sessionId !== marker.sessionId
    || row.capturedAt !== marker.activatedAt
    || !Array.isArray(row.backups) || row.backups.length < 2 || row.backups.length > 5) {
    throw new Error('npc-activation-backup-manifest-invalid');
  }
  const sessionFile = `${marker.sessionId}.db`;
  const allowed = new Set([sessionFile, MAINTENANCE_JOB_DB_FILE, ...OPTIONAL_BACKUP_FILES]);
  const seen = new Set<string>();
  const entries = row.backups.map((value): BackupManifestEntry => {
    const entry = plainRecord(value);
    if (!entry || !exactKeys(entry, ['file', 'bytes', 'sha256', 'applicationId', 'userVersion'])
      || typeof entry.file !== 'string' || basename(entry.file) !== entry.file
      || !allowed.has(entry.file) || seen.has(entry.file)
      || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 1
      || !SHA256_RE.test(String(entry.sha256))
      || !Number.isSafeInteger(entry.applicationId) || Number(entry.applicationId) < 0
      || !Number.isSafeInteger(entry.userVersion) || Number(entry.userVersion) < 1) {
      throw new Error('npc-activation-backup-entry-invalid');
    }
    seen.add(entry.file);
    return Object.freeze({
      file: entry.file,
      bytes: Number(entry.bytes),
      sha256: String(entry.sha256),
      applicationId: Number(entry.applicationId),
      userVersion: Number(entry.userVersion),
    });
  });
  if (!seen.has(sessionFile) || !seen.has(MAINTENANCE_JOB_DB_FILE)) {
    throw new Error('npc-activation-required-backup-missing');
  }
  const session = entries.find((entry) => entry.file === sessionFile)!;
  const maintenance = entries.find((entry) => entry.file === MAINTENANCE_JOB_DB_FILE)!;
  if (session.applicationId !== 0
    || !NPC_STORED_SESSION_SCHEMAS.includes(session.userVersion)
    || maintenance.applicationId !== MAINTENANCE_JOB_APPLICATION_ID
    || maintenance.userVersion !== marker.maintenanceSchemaVersion) {
    throw new Error('npc-activation-backup-metadata-invalid');
  }
  return Object.freeze(entries);
}

function parseApplyBackupManifest(
  value: unknown,
  marker: NpcMaintenanceApplyBackupMarker,
): readonly BackupManifestEntry[] {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['version', 'capturedAt', 'sessionId', 'sourceRevision', 'backups'])
    || row.version !== NPC_MAINTENANCE_APPLY_BACKUP_MANIFEST_VERSION
    || row.sessionId !== marker.sessionId
    || row.sourceRevision !== marker.sourceRevision
    || row.capturedAt !== marker.activatedAt
    || !Array.isArray(row.backups) || row.backups.length !== 1) {
    throw new Error('npc-apply-backup-manifest-invalid');
  }
  const sessionFile = `${marker.sessionId}.db`;
  const entry = plainRecord(row.backups[0]);
  if (!entry || !exactKeys(entry, ['file', 'bytes', 'sha256', 'applicationId', 'userVersion'])
    || entry.file !== sessionFile
    || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 1
    || !SHA256_RE.test(String(entry.sha256))
    || entry.applicationId !== 0
    || entry.userVersion !== SCHEMA_VERSION) {
    throw new Error('npc-apply-backup-entry-invalid');
  }
  return Object.freeze([Object.freeze({
    file: sessionFile,
    bytes: Number(entry.bytes),
    sha256: String(entry.sha256),
    applicationId: 0,
    userVersion: SCHEMA_VERSION,
  })]);
}

function verifyBackupEntry(backupDirectory: string, entry: BackupManifestEntry): void {
  const path = join(backupDirectory, entry.file);
  requirePlainFile(path, 'npc-activation-backup-database');
  if (lstatSync(path).size !== entry.bytes || sha256ActivationFile(path) !== entry.sha256) {
    throw new Error('npc-activation-backup-file-mismatch');
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (pragma(db, 'application_id') !== entry.applicationId
      || pragma(db, 'user_version') !== entry.userVersion) {
      throw new Error('npc-activation-backup-file-metadata-mismatch');
    }
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    if (integrity.length !== 1
      || String(integrity[0]?.integrity_check ?? '').toLowerCase() !== 'ok') {
      throw new Error('npc-activation-backup-file-integrity-failed');
    }
  } finally {
    db.close();
  }
}

function writeActivationRegistry(
  dataDir: string,
  activations: readonly NpcMaintenanceActivationRecord[],
): void {
  const target = join(dataDir, NPC_MAINTENANCE_ACTIVATION_FILE);
  const temp = join(dataDir, `.${NPC_MAINTENANCE_ACTIVATION_FILE}.${randomUUID()}.tmp`);
  const registry: NpcMaintenanceActivationRegistry = Object.freeze({
    version: NPC_MAINTENANCE_ACTIVATION_REGISTRY_VERSION,
    activations: Object.freeze([...activations].sort((left, right) => (
      left.sessionId.localeCompare(right.sessionId) || left.version.localeCompare(right.version)
    ))),
  });
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  try {
    // The server process lock makes this short replacement window unobservable by Jiuguan.
    rmSync(target, { force: true });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeNpcMaintenanceActivationMarker(
  dataDirectory: string,
  marker: NpcMaintenanceActivationRecord,
): void {
  const dataDir = resolve(dataDirectory);
  const target = join(dataDir, NPC_MAINTENANCE_ACTIVATION_FILE);
  // Only a current-schema proof may be persisted as the replacement. Preserve
  // the existing typed-writer contract for other validation (runtime readers
  // still fail closed), but never let this path mint v16 authority.
  if (marker.sessionSchemaVersion !== SCHEMA_VERSION) {
    throw new Error('npc-activation-marker-session-schema-invalid');
  }
  const replacement = marker;
  let existing: readonly NpcMaintenanceActivationRecord[] = Object.freeze([]);
  if (existsSync(target)) {
    requirePlainFile(target, 'npc-activation-marker');
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(target, 'utf8')) as unknown;
      existing = parseActivationDocument(document, NPC_STORED_SESSION_SCHEMAS);
    } catch {
      if (!replaceableStaleSingleMarker(document, replacement)) {
        throw new Error('npc-activation-registry-invalid');
      }
      existing = Object.freeze([]);
    }
  }
  writeActivationRegistry(dataDir, [
    ...existing.filter((entry) => entry.sessionId !== replacement.sessionId
      || entry.version !== replacement.version),
    replacement,
  ]);
}

function readActivationRecords(dataDirectory: string): readonly NpcMaintenanceActivationRecord[] {
  const dataDir = resolve(dataDirectory);
  const path = join(dataDir, NPC_MAINTENANCE_ACTIVATION_FILE);
  if (!existsSync(path)) return Object.freeze([]);
  requirePlainFile(path, 'npc-activation-marker');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new Error('npc-activation-registry-invalid'); }
  return parseActivationDocument(parsed, NPC_STORED_SESSION_SCHEMAS);
}

function verifyActivationRecord(
  dataDir: string,
  marker: NpcMaintenanceActivationRecord,
): void {
  verifyBackupDirectoryForRecord(dataDir, marker);
  assertNpcActivationSourceDatabases(dataDir, marker.sessionId, [SCHEMA_VERSION]);
}

function verifyBackupDirectoryForRecord(
  dataDir: string,
  marker: NpcMaintenanceActivationRecord,
  exactContents = false,
): string {
  const backupRoot = join(dataDir, '.migration-backups');
  const backupDirectory = join(backupRoot, marker.backupDirectory);
  if (resolve(backupDirectory) !== backupDirectory
    || basename(backupDirectory) !== marker.backupDirectory) {
    throw new Error('npc-activation-backup-path-invalid');
  }
  requirePlainDirectory(backupRoot, 'npc-activation-backup-root');
  requirePlainDirectory(backupDirectory, 'npc-activation-backup-directory');
  const manifestPath = join(backupDirectory, 'backup-manifest.json');
  if (sha256ActivationFile(manifestPath) !== marker.backupManifestSha256) {
    throw new Error('npc-activation-backup-digest-mismatch');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown; }
  catch { throw new Error('npc-activation-backup-manifest-invalid'); }
  const entries = marker.version === NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION
    ? parseApplyBackupManifest(manifest, marker)
    : parseBackupManifest(manifest, marker);
  for (const entry of entries) verifyBackupEntry(backupDirectory, entry);
  if (exactContents) {
    const allowedFiles = new Set(['backup-manifest.json', ...entries.map((entry) => entry.file)]);
    const actual = readdirSync(backupDirectory, { withFileTypes: true });
    if (actual.length !== allowedFiles.size || actual.some((entry) => (
      !entry.isFile() || !allowedFiles.has(entry.name)
    ))) {
      throw new Error('npc-activation-backup-directory-contents-invalid');
    }
  }
  return backupDirectory;
}

function deletionRecordFromManifest(
  backupDirectory: string,
  sessionId: string,
): NpcMaintenanceActivationRecord | null {
  const manifestPath = join(backupDirectory, 'backup-manifest.json');
  const sessionBackupPath = join(backupDirectory, `${sessionId}.db`);
  if (!existsSync(manifestPath)) {
    if (existsSync(sessionBackupPath)) throw new Error('npc-activation-session-backup-unverified');
    return null;
  }
  requirePlainFile(manifestPath, 'npc-activation-backup-manifest');
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown; }
  catch {
    if (existsSync(sessionBackupPath)) throw new Error('npc-activation-session-backup-unverified');
    return null;
  }
  const row = plainRecord(manifest);
  if (row?.sessionId !== sessionId) {
    if (existsSync(sessionBackupPath)) throw new Error('npc-activation-session-backup-owner-mismatch');
    return null;
  }
  const backupDirectoryName = basename(backupDirectory);
  const backupManifestSha256 = sha256ActivationFile(manifestPath);
  if (row.version === NPC_MAINTENANCE_APPLY_BACKUP_MANIFEST_VERSION) {
    return createNpcMaintenanceApplyBackupMarker({
      sessionId,
      sourceRevision: String(row.sourceRevision),
      backupDirectory: backupDirectoryName,
      backupManifestSha256,
      activatedAt: String(row.capturedAt),
    });
  }
  if (row.version !== NPC_MAINTENANCE_BACKUP_MANIFEST_VERSION
    || !canonicalTimestamp(row.capturedAt)
    || !Array.isArray(row.backups)) {
    throw new Error('npc-activation-session-backup-unverified');
  }
  const maintenance = row.backups.map(plainRecord).find((entry) => (
    entry?.file === MAINTENANCE_JOB_DB_FILE
  ));
  if (!maintenance || !Number.isSafeInteger(maintenance.userVersion)
    || Number(maintenance.userVersion) < 1) {
    throw new Error('npc-activation-session-backup-unverified');
  }
  return Object.freeze({
    version: NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION,
    status: 'active' as const,
    sessionId,
    taskKinds: Object.freeze(['npc_state'] as const),
    sessionSchemaVersion: SCHEMA_VERSION,
    maintenanceSchemaVersion: Number(maintenance.userVersion),
    backupDirectory: backupDirectoryName,
    backupManifestSha256,
    activatedAt: String(row.capturedAt),
  });
}

/**
 * Privacy cleanup for one deleted session. It deliberately lives beside the
 * registry/manifest parser so the deletion coordinator does not learn this
 * subsystem's on-disk layout.
 *
 * Backups are removed before the registry rewrite. Therefore a crash can leave
 * a stale marker pointing at an already-absent directory, but retry is safe and
 * can still remove that marker. No directory is recursively removed until its
 * direct path, manifest binding, SQLite hashes/metadata and exact contents have
 * all been verified for this session.
 */
export function deleteNpcMaintenanceActivationSession(
  dataDirectory: string,
  sessionId: string,
): NpcMaintenanceActivationDeletionResult {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('npc-activation-delete-session-id-invalid');
  const dataDir = resolve(dataDirectory);
  requirePlainDirectory(dataDir, 'npc-activation-delete-data-directory');
  const registryPath = join(dataDir, NPC_MAINTENANCE_ACTIVATION_FILE);
  const records = readActivationRecords(dataDir);
  const removed = records.filter((record) => record.sessionId === sessionId);
  const remaining = records.filter((record) => record.sessionId !== sessionId);
  const remainingDirectories = new Set(remaining.map((record) => record.backupDirectory));
  const backupRoot = join(dataDir, '.migration-backups');
  const verifiedDirectories = new Set<string>();

  for (const marker of removed) {
    if (remainingDirectories.has(marker.backupDirectory)) {
      throw new Error('npc-activation-backup-shared-across-sessions');
    }
    const backupDirectory = join(backupRoot, marker.backupDirectory);
    if (existsSync(backupDirectory)) {
      verifiedDirectories.add(verifyBackupDirectoryForRecord(dataDir, marker, true));
    }
  }

  // Re-activation replaces a registry record but intentionally leaves its old
  // rollback snapshot behind. Scan only the two reserved NPC directory shapes
  // and accept an orphan solely when its own strict manifest proves ownership.
  if (existsSync(backupRoot)) {
    requirePlainDirectory(backupRoot, 'npc-activation-backup-root');
    for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
      if (!BACKUP_DIRECTORY_RE.test(entry.name)) continue;
      const backupDirectory = join(backupRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (removed.some((record) => record.backupDirectory === entry.name)) {
          throw new Error('npc-activation-backup-directory-invalid');
        }
        continue;
      }
      const marker = deletionRecordFromManifest(backupDirectory, sessionId);
      if (!marker) continue;
      if (remainingDirectories.has(entry.name)) {
        throw new Error('npc-activation-backup-shared-across-sessions');
      }
      verifiedDirectories.add(verifyBackupDirectoryForRecord(dataDir, marker, true));
    }
  }

  for (const backupDirectory of verifiedDirectories) {
    rmSync(backupDirectory, { recursive: true, force: true });
  }
  if (removed.length > 0) {
    if (!existsSync(registryPath)) throw new Error('npc-activation-registry-missing');
    writeActivationRegistry(dataDir, remaining);
  }
  return Object.freeze({
    sessionId,
    removedRecords: removed.length,
    deletedBackupDirectories: verifiedDirectories.size,
  });
}

/**
 * Reads and verifies every active per-session record. A legacy single marker is
 * returned as a one-element collection and is migrated by the next write.
 */
export function readNpcMaintenanceActivationMarkers(
  dataDirectory: string,
): readonly NpcMaintenanceActivationRecord[] {
  const dataDir = resolve(dataDirectory);
  const records = readActivationRecords(dataDir).filter((record) => (
    record.status === 'active' && record.sessionSchemaVersion === SCHEMA_VERSION
  ));
  for (const marker of records) verifyActivationRecord(dataDir, marker);
  return Object.freeze(records);
}

/** Backward-compatible one-session view used by the activation CLI/preflight. */
export function readNpcMaintenanceActivationMarker(
  dataDirectory: string,
  sessionId?: string,
): NpcMaintenanceActivationRecord | null {
  const records = readNpcMaintenanceActivationMarkers(dataDirectory).filter((record) => (
    record.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION
  ));
  if (sessionId !== undefined) {
    return records.find((record) => record.sessionId === sessionId) ?? null;
  }
  // A no-session legacy call is unambiguous only for the original one-marker
  // layout. Multi-session callers must request the exact session or use the
  // collection API; silently choosing one would misreport another session.
  return records.length === 1 ? records[0]! : null;
}

export function npcMaintenanceActivationAllows(
  marker: NpcMaintenanceActivationRecord | readonly NpcMaintenanceActivationRecord[] | null,
  sessionId: string,
  taskKind: MaintenanceTaskKind,
): boolean {
  const records = marker === null ? [] : Array.isArray(marker) ? marker : [marker];
  return records.some((entry) => entry.version === NPC_MAINTENANCE_ACTIVATION_MARKER_VERSION
    && entry.status === 'active'
    && entry.sessionSchemaVersion === SCHEMA_VERSION
    && entry.sessionId === sessionId
    && entry.taskKinds.includes(taskKind as 'npc_state'));
}

export function npcMaintenanceApplyBackupAllows(
  marker: NpcMaintenanceActivationRecord | readonly NpcMaintenanceActivationRecord[] | null,
  sessionId: string,
  sourceRevision: string,
): boolean {
  const records = marker === null ? [] : Array.isArray(marker) ? marker : [marker];
  return records.some((entry) => entry.version === NPC_MAINTENANCE_APPLY_BACKUP_MARKER_VERSION
    && entry.status === 'active'
    && entry.sessionSchemaVersion === SCHEMA_VERSION
    && entry.sessionId === sessionId
    && entry.sourceRevision === sourceRevision
    && entry.taskKinds.includes('npc_state'));
}

/**
 * The backup-bound marker grants only the NPC execution/write path. It is not a
 * lane-wide Maintenance credential: unrelated shadow tasks must continue to be
 * governed by their own lane, persisted-switch, admission and capability gates.
 */
export function maintenanceTaskNpcActivationAllows(
  marker: NpcMaintenanceActivationRecord | readonly NpcMaintenanceActivationRecord[] | null,
  sessionId: string,
  taskKind: MaintenanceTaskKind | undefined,
): boolean {
  return taskKind !== 'npc_state'
    || npcMaintenanceActivationAllows(marker, sessionId, taskKind);
}
