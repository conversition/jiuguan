import type { SessionDeletionCleanupStep } from './session-deletion-coordinator.ts';
import { cleanupDeletedSessionP14Evidence } from './p14-evidence-cleanup.ts';

export const P14_EVIDENCE_DELETION_STEP_ID = 'p14-evidence' as const;
export const P14_EVIDENCE_DELETION_FAILURE_CODE = 'p14-evidence-delete-failed' as const;

/** Keeps filesystem layout knowledge outside the deletion coordinator wiring. */
export function createP14EvidenceSessionDeletionStep(
  dataDir: string,
): SessionDeletionCleanupStep {
  const step: SessionDeletionCleanupStep = {
    id: P14_EVIDENCE_DELETION_STEP_ID,
    failureCode: P14_EVIDENCE_DELETION_FAILURE_CODE,
    run(identity) {
      cleanupDeletedSessionP14Evidence({ dataDir, sessionId: identity.sessionId });
    },
  };
  return Object.freeze(step);
}
