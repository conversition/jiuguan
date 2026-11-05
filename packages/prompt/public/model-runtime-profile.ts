/** Public immutable model-capability metadata used by cross-workspace authority resolvers. */
export {
  MODEL_RUNTIME_PROFILE_VERSION,
  DEFAULT_CONSERVATIVE_CONTEXT_TOKENS,
  parseStaticModelRuntimeProfiles,
  resolveModelRuntimeProfile,
  modelRuntimeProfileDigest,
  contextModelProfileFromRuntime,
  type ModelRuntimeProfile,
} from '../src/model-runtime-profile.ts';
