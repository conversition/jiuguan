export {
  AUTH_DIGEST_BYTES,
  AUTH_ROOT_KEY_BYTES,
  AuthCryptoError,
  createAuthCrypto,
  isAuthSelector,
} from './crypto.ts';
export type {
  AssetCapabilityMaterial,
  AuthDigest,
  AuthDigestPurpose,
  AuthCrypto,
  AuthCryptoErrorCode,
  AuthSelector,
  IssuedDeviceCredential,
  IssuedPairingCode,
  IssuedVersionedSecret,
  OneTimeSecret,
  ProtectedDigest,
  StorageBindingMaterial,
} from './crypto.ts';

export { AuthStorageError } from './storage-error.ts';
export type { AuthStorageErrorCode } from './storage-error.ts';

export {
  ancestorDirectories,
  assertAncestorChainNoReparsePoint,
  assertNoReparsePoint,
  assertPathProtected,
  establishPathProtection,
  evaluatePosixProtection,
  evaluateWindowsAcl,
  fsyncDirectorySync,
  getDurabilityCapability,
  isWindowsSid,
  normalizePrincipal,
  parseIcaclsOutput,
  parseWhoamiUserOutput,
  parseWindowsIdentityProbe,
  readWindowsIdentity,
  tightenOwnerOnlyPermissions,
  tightenWindowsAcl,
} from './platform-protection.ts';
export type {
  AclEntry,
  DurabilityCapability,
  ProtectedKind,
  ProtectionVerdict,
  WindowsAclIdentity,
} from './platform-protection.ts';

export {
  createInstanceRootKeyFile,
  destroyRootKey,
  readInstanceRootKeyFile,
} from './root-key.ts';

export {
  AUTH_DB_APPLICATION_ID,
  AUTH_SCHEMA_MIGRATIONS,
  AUTH_SCHEMA_VERSION,
  AUTH_TABLE_COLUMNS,
  AUTH_TABLES,
  SQLITE_FILE_HEADER,
  applyAuthMigrations,
  authSchemaVersionOf,
  inspectAuthDatabaseFile,
  inspectAuthSchemaExactness,
  readAuthApplicationId,
  readAuthSchemaVersion,
  writeAuthSchemaVersion,
} from './schema.ts';
export type {
  ApplyMigrationsOptions,
  AuthDatabaseHeader,
  AuthMigration,
  AuthTableName,
  SchemaExactnessVerdict,
} from './schema.ts';

export {
  ACTIVE_POINTER_NAME,
  AUTH_DB_FILE_NAME,
  GENERATION_ID_RE,
  GENERATIONS_DIR_NAME,
  MAINTENANCE_FILE_NAME,
  MAINTENANCE_LEASE_RE,
  MANIFEST_FILE_NAME,
  ROOT_KEY_FILE_NAME,
  SECURITY_DIR_NAME,
  assertMaintenanceClear,
  assertMaintenanceLease,
  acquireMaintenanceLease,
  buildGenerationId,
  buildMaintenanceLeaseToken,
  classifyMaintenanceRead,
  createAuthStorageLayout,
  isAbsentFileError,
  isValidGenerationId,
  readActiveGeneration,
  readGenerationManifest,
  parseMaintenanceLease,
  readMaintenanceState,
  releaseMaintenanceLease,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
  writeActiveGeneration,
  writeAuthFileAtomic,
  writeGenerationManifest,
  writeMaintenanceState,
} from './storage-layout.ts';
export type {
  AtomicWriteResult,
  AuthGenerationManifest,
  AuthGenerationPaths,
  AuthMaintenanceLease,
  AuthMaintenanceState,
  AuthStorageLayout,
  MaintenanceReadOutcome,
} from './storage-layout.ts';

export {
  authenticateCredential,
} from './credential-auth.ts';
export type {
  CredentialAuthResult,
  CredentialAuthOptions,
  CredentialAuthSuccess,
  CredentialAuthFailure,
} from './credential-auth.ts';

export {
  DEFAULT_SESSION_TTL_MS,
  pairWithCode,
} from './pair-service.ts';
export type {
  PairServiceDeviceClaim,
  PairServiceDeviceView,
  PairServiceFailure,
  PairServiceFailureReason,
  PairServiceRequest,
  PairServiceResult,
  PairServiceSessionView,
  PairServiceSuccess,
} from './pair-service.ts';

export {
  BACKUP_DB_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  createAuthBackup,
  createAuthBackupFromDatabase,
  restoreAuthBackup,
  verifyAuthBackup,
} from './backup.ts';
export type {
  AuthBackupManifest,
  AuthBackupResult,
  AuthBackupVerification,
  BackupFailureStage,
  CreateAuthBackupOptions,
  CreateAuthBackupFromDatabaseOptions,
  ImportedAuthBackupResult,
  RestoreAuthBackupOptions,
  RestoreAuthBackupResult,
  RestoreFailureStage,
} from './backup.ts';

export {
  LAST_SEEN_INTERVAL_MS,
  SESSION_LAST_SEEN_INTERVAL_MS,
  AuthStore,
  buildAuthGeneration,
  initializeAuthStorage,
  openAuthStore,
} from './store.ts';
export type {
  BuildAuthGenerationOptions,
  BuiltAuthGeneration,
  AuthAssetCapabilityRecord,
  AssetCapabilityReservation,
  AuthAuditEntry,
  AuthAuditRecord,
  AuthDeviceRecord,
  AuthPairingRecord,
  AuthSessionRecord,
  AuthStoreMeta,
  AuthStoreOptions,
  ConsumePairingInput,
  ConsumePairingResult,
  InitializeAuthStorageOptions,
  InitializeAuthStorageResult,
} from './store.ts';

export {
  AUTH_TRANSPORT_VALUES,
  DEVICE_PLATFORM_VALUES,
  DEVICE_SCOPE_VALUES,
  isAuthTransportValue,
  isDevicePlatformValue,
  isDeviceScopeValue,
  parseVocabularyArray,
} from './vocabulary.ts';
export type {
  AuthTransportValue,
  DevicePlatformValue,
  DeviceScopeValue,
} from './vocabulary.ts';
