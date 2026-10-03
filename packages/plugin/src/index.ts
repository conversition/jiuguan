export { PluginManifestSchema } from './manifest.ts';
export type { PluginManifest } from './manifest.ts';
export { installFromSource } from './installer.ts';
export type { InstallResult } from './installer.ts';
export { PluginRegistry, PluginUpdateRecoveryError } from './registry.ts';
export type { PluginRecord, PluginUpdateState, PluginUpdateTransaction } from './registry.ts';
export { PluginHost } from './runtime.ts';
export type { PluginCtx, HookResult } from './runtime.ts';
export {
  DshPluginHost,
  DshSessionCleanupError,
  createEnvCredentialResolver,
  CREDENTIAL_NAMES,
  DSH_HOST_API_VERSION,
  DSH_ROUTE_NAMESPACE,
  dshRouteBase,
} from './dsh-host.ts';
export type {
  DshRouteDef, DshCredential, DshDisposer, DshPluginCtx, DshPluginExports,
  DshSessionEventPayload, DshHostOptions, DshHostDiagnostics, DshProviderAdapter,
  DshProviderRegistrar,
  DshSessionCleanupContext, DshSessionCleanupFailure, DshSessionCleanupFailureCode,
  DshSessionCleanupFailureSummary, DshSessionCleanupResult,
} from './dsh-host.ts';
export {
  describePluginSource,
  matchesPluginSourceFingerprint,
  toPublicPluginRecord,
} from './public-record.ts';
export type {
  PluginSourceIdentity,
  PluginSourceKind,
  PublicPluginRecord,
} from './public-record.ts';
