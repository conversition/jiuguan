import { createClientExecutionProfile } from '../../../packages/client-runtime/src/index.ts';

const env = (import.meta as unknown as { env?: Record<string, string> }).env;

/** Web/PWA/Android 共享的唯一构建 profile 真值。未知值由 runtime fail closed。 */
export const WEB_CLIENT_PROFILE = createClientExecutionProfile(
  env?.VITE_JG_CLIENT_PROFILE || 'web',
);
