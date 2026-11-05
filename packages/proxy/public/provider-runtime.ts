/**
 * Public Provider runtime facade for trusted cross-workspace composition roots.
 *
 * Importers receive the supported registry/controller/client surface without
 * reaching through another workspace's private `src/` tree.
 */
export { withProviderWorkSettlement } from '../src/provider-work-lifecycle.ts';
export type { ProviderConfig } from '../src/config.ts';
export {
  ProviderRegistry,
  ProviderRegistryError,
  providerFailureDiagnosticCode,
  PROVIDER_BUILTIN_PREFIX,
} from '../src/provider-registry.ts';
export type {
  ProviderRegistrationDisposer,
  ProviderRegistryErrorCode,
  ProviderRegistryOptions,
  ProviderFailureDiagnosticCode,
} from '../src/provider-registry.ts';
export {
  createRegistryProviderClient,
  RegistryProviderClient,
  RegistryProviderSelectionError,
} from '../src/provider-client.ts';
export type {
  RegistryProviderClientOptions,
  RegistryProviderSelection,
} from '../src/provider-client.ts';
export {
  createOpenAIProviderController,
  OPENAI_PROVIDER_ID,
} from '../src/openai-provider.ts';
export type {
  OpenAIProviderController,
  OpenAIProviderControllerOptions,
  OpenAIProviderTransport,
} from '../src/openai-provider.ts';
