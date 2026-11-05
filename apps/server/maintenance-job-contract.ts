/**
 * Side-effect-free Maintenance job protocol labels.
 *
 * Importing these constants must not construct a database, load node:sqlite or grant a claim.
 */
import { createHash } from 'node:crypto';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';

export const MAINTENANCE_JOB_SCHEMA_VERSION = 8;

/** Stable label for one currently claimed maintenance execution attempt; not a serialized field. */
export const MAINTENANCE_EXECUTION_CLAIM_VERSION = 'maintenance-execution-claim-v1' as const;

/** Original byte-preserving immutable claim hash, shared by live AL guards and
 * Manager historical receipts without importing Prepare/Service into Manager. */
export function agentLoopMaintenanceClaimDigest(execution: Pick<MaintenanceExecutionRecord,
    'job' | 'executorRoute' | 'leaseOwnerInstanceId'>): string {
    const job = execution.job;
    return `sha256:${createHash('sha256').update(JSON.stringify({ runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind,
        sourceRevision: job.sourceRevision, policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? null,
        trigger: job.trigger, mode: job.mode, attempt: job.attempt, createdAt: job.createdAt,
        startedAt: job.startedAt, executorRoute: execution.executorRoute, owner: execution.leaseOwnerInstanceId })).digest('hex')}`;
}
