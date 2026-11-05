import type { SessionDeletionCleanupStep } from './session-deletion-coordinator.ts';
import type { SessionDeletionIdentity } from './session-deletion-journal.ts';

/**
 * Narrow anti-corruption port between the session deletion domain and DSH.
 *
 * The coordinator deliberately knows nothing about plugin instances, hooks, or
 * timeout policy. DshPluginHost owns those concerns and must provide an
 * awaitable, exact-session, idempotent cleanup operation here.
 */
export interface DshSessionCleanupPort {
  cleanupSession(sessionId: string): Promise<unknown>;
}

export const DSH_SESSION_DELETION_STEP_ID = 'dsh-plugin-session';
export const DSH_SESSION_DELETION_FAILURE_CODE = 'dsh-plugin-session-delete-failed';

export function createDshSessionDeletionStep(
  port: DshSessionCleanupPort,
): SessionDeletionCleanupStep {
  if (!port || typeof port.cleanupSession !== 'function') {
    throw new Error('dsh-session-cleanup-port-invalid');
  }
  return Object.freeze({
    id: DSH_SESSION_DELETION_STEP_ID,
    failureCode: DSH_SESSION_DELETION_FAILURE_CODE,
    async run(identity: SessionDeletionIdentity): Promise<void> {
      // Pass only the opaque identity. Card names and conversation content must
      // never cross this privacy cleanup boundary.
      await port.cleanupSession(identity.sessionId);
    },
  });
}
