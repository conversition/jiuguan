/** @author Codex @date 2026-10-14 @version 1.0
 * Recheck the Summary claim after asynchronous loading without borrowing Memory write authority.
 */
import type { MaintenanceJobManager } from './maintenance-job-manager.ts';
import type { MaintenanceCommitRequest } from './maintenance-proposal-committer.ts';

export function assertMaintenanceSummaryDirectWriteAllowed(request: MaintenanceCommitRequest, input: {
    readonly manager: Pick<MaintenanceJobManager, 'readExecution' | 'settings' | 'authorizeSummaryDirectProposal'>;
    readonly allowed: (sessionId: string) => boolean;
    readonly nowMs?: number;
}): void {
    const current = input.manager.readExecution(request.runId);
    const claim = request.executionClaim;
    const nowMs = input.nowMs ?? Date.now();
    const expiresAt = current ? Date.parse(current.leaseExpiresAt) : Number.NaN;
    if (request.taskKind !== 'rolling_summary' || !claim || request.directPreparation !== undefined
        || request.signal?.aborted || !input.allowed(request.sessionId)
        || !input.manager.settings(request.sessionId).effectiveEnabled
        || !current || current.job.status !== 'running'
        || current.job.mode !== 'apply' || current.job.taskKind !== request.taskKind
        || current.job.sessionId !== request.sessionId || current.job.sourceRevision !== request.expectedRevision
        || current.job.attempt !== claim.attempt || current.leaseOwnerInstanceId !== claim.ownerInstanceId
        || current.cancelRequestedAt !== undefined
        || !Number.isFinite(nowMs) || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        throw new Error('maintenance-summary-direct-commit-claim-invalid');
    }
    if (request.summaryPreparation !== undefined) {
        input.manager.authorizeSummaryDirectProposal(request.summaryPreparation, request);
    }
}
