/** Historical Summary business COMMIT, independent of AL/Manager completion. */
import { types as nodeTypes } from 'node:util';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT as APPLY }
    from './agent-loop-action-receipt.ts';
import { AgentLoopProjectionStore, type AgentLoopTaskOutcomeSnapshot } from './agent-loop-projection-store.ts';
import type { AgentLoopTaskOutcomeEvidenceRef } from './agent-loop-task-outcome.ts';
import { agentLoopSummaryWriteDigest, AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX }
    from './agent-loop-summary-write-origin.ts';
import { SUMMARY_WRITE_RECEIPT_PREFIX } from './maintenance-summary-write-receipt.ts';
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';
import { MaintenanceJobManager } from './maintenance-job-manager.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';
import { openMaintenanceSummaryEvidenceSource } from './maintenance-summary-evidence-source.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';

export interface AgentLoopSummaryApplyCommitProjection {
    readonly state: 'unknown' | 'committed' | 'rolled-back';
    readonly evidence: readonly AgentLoopTaskOutcomeEvidenceRef[];
    readonly sourceDigest: string | null;
}
const UNKNOWN: AgentLoopSummaryApplyCommitProjection = Object.freeze({ state: 'unknown',
    evidence: Object.freeze([]), sourceDigest: null });
// Private-field-backed originals, not a DTO callback or a writable instance override.
const READ_JOB = MaintenanceJobManager.prototype.readAgentLoopSummaryApplyOutcomeJob;
const READ_COMPLETION = MaintenanceJobManager.prototype.readAgentLoopSummaryApplyCompletion;
const READ_ACTION = AgentLoopProjectionStore.prototype.readActionReceipt;
function unavailable(): never { throw new Error('agent-loop-summary-apply-outcome-unavailable'); }
function immutableJob(job: PublicMaintenanceJob) {
    return { runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind,
        sourceRevision: job.sourceRevision, policyVersion: job.policyVersion,
        parentRunId: job.parentRunId ?? null, trigger: job.trigger, mode: job.mode,
        attempt: job.attempt, createdAt: job.createdAt, startedAt: job.startedAt ?? null };
}
function proof(kind: AgentLoopTaskOutcomeEvidenceRef['kind'], refId: string, value: string, occurredAt: string) {
    return Object.freeze({ kind, refId, sourceDigest: value, occurredAt });
}

/** This reader issues no execution/completion authority and opens Session files query-only. */
export class AgentLoopSummaryApplyOutcomeReader {
    readonly #store: AgentLoopProjectionStore;
    readonly #manager: MaintenanceJobManager;
    readonly #allowed: (sessionId: string) => boolean;
    readonly #resolveDatabase: (sessionId: string) => string | null;
    constructor(options: Readonly<{
        store: AgentLoopProjectionStore; manager: MaintenanceJobManager;
        allowed: (sessionId: string) => boolean;
        resolveDatabase: (sessionId: string) => string | null;
    }>) {
        if (!options || nodeTypes.isProxy(options.store) || nodeTypes.isProxy(options.manager)
            || !(options.store instanceof AgentLoopProjectionStore) || !(options.manager instanceof MaintenanceJobManager)
            || typeof options.allowed !== 'function' || typeof options.resolveDatabase !== 'function') unavailable();
        this.#store = options.store; this.#manager = options.manager;
        this.#allowed = options.allowed; this.#resolveDatabase = options.resolveDatabase;
    }
    read(store: AgentLoopProjectionStore, snapshot: AgentLoopTaskOutcomeSnapshot): AgentLoopSummaryApplyCommitProjection {
        if (store !== this.#store) return unavailable();
        const { record } = snapshot, task = record.envelope;
        const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
        if (record.fenced || task.taskKind !== registration.taskKind
            || task.taskContractRef !== registration.contractRef || !task.currentAttemptId) return UNKNOWN;
        const sources = task.goal.sourceRefs;
        const runRefs = sources.filter(ref => /^maintenancejob\.mjob_[a-f0-9]{32}$/u.test(ref));
        const revisions = sources.filter(ref => /^revision\.sha256:[a-f0-9]{64}$/u.test(ref));
        if (sources.length !== 2 || runRefs.length !== 1 || revisions.length !== 1) return UNKNOWN;
        const runId = runRefs[0]!.slice('maintenancejob.'.length);
        const sourceRevision = revisions[0]!.slice('revision.'.length);
        let sessionId: string | null = null;
        const permitted = () => {
            try { return sessionId !== null && this.#allowed(sessionId) === true; } catch { return false; }
        };
        try {
            const job = READ_JOB.call(this.#manager, runId);
            if (!job) return UNKNOWN;
            sessionId = job.sessionId;
            if (!permitted()) return UNKNOWN;
            if (job.runId !== runId || job.sourceRevision !== sourceRevision) unavailable();
            const completion = READ_COMPLETION.call(this.#manager, runId);
            const path = this.#resolveDatabase(sessionId);
            if (path === null || !permitted()) return UNKNOWN;
            const source = openMaintenanceSummaryEvidenceSource(path, sessionId);
            if (!source) return UNKNOWN;
            let history: ReturnType<typeof source.committer.readAgentLoopSummaryWriteEvidence>;
            try { history = source.committer.readAgentLoopSummaryWriteEvidence(runId); }
            finally { source.close(); }
            if (!permitted()) return UNKNOWN;
            if (!history) return UNKNOWN;
            const { origin, intent, readback } = history;
            const claimDigest = agentLoopMaintenanceClaimDigest({ job, executorRoute: 'agent-loop',
                leaseOwnerInstanceId: origin.ownerId });
            if (origin.runId !== runId || origin.taskId !== task.taskId || origin.attemptId !== task.currentAttemptId
                || origin.sessionId !== sessionId || origin.sourceRevision !== sourceRevision
                || origin.claimAttempt !== job.attempt || origin.claimDigest !== claimDigest
                || origin.taskRevision > record.revision || origin.actionContractRef !== APPLY
                || intent.runId !== runId || intent.sessionId !== sessionId || intent.sourceRevision !== sourceRevision) unavailable();
            const action = READ_ACTION.call(store, { taskId: task.taskId, actionId: origin.actionId });
            if (!action || action.taskId !== task.taskId || action.attemptId !== origin.attemptId
                || action.actionId !== origin.actionId || action.actionDigest !== origin.actionDigest
                || action.actionContractRef !== APPLY || action.expectedRevision !== origin.taskRevision
                || action.ownerId !== origin.ownerId || action.status === 'reserved' || action.status === 'released'
                || !action.startedAt || action.startedAt > intent.committedAt) unavailable();
            if (completion) {
                const p = completion.completion;
                // Corroborate explicit original fields, not a changing whole-history
                // hash: a later legitimate rollback must remain visible.
                if (agentLoopSummaryWriteDigest(immutableJob(completion.job)) !== agentLoopSummaryWriteDigest(immutableJob(job))
                    || p.runId !== runId || p.taskId !== origin.taskId || p.attemptId !== origin.attemptId
                    || p.ownerId !== origin.ownerId || p.claimDigest !== origin.claimDigest
                    || p.sourceDigest !== origin.sourceDigest || p.actionId !== origin.actionId
                    || p.actionDigest !== origin.actionDigest || p.actionRevision !== origin.taskRevision
                    || p.originDigest !== origin.originDigest || p.intentDigest !== intent.intentDigest
                    || p.operationDigest !== intent.operationDigest || p.proposalDigest !== origin.proposalDigest
                    || p.contextDigest !== origin.contextDigest || p.budgetDigest !== origin.budgetDigest
                    || p.domainCommittedAt !== intent.committedAt || !readback
                    || p.readbackDigest !== readback.readbackDigest || p.domainVerifiedAt !== readback.verifiedAt) unavailable();
                if (snapshot.completion) {
                    const original = snapshot.completion;
                    if (p.candidateRef !== original.candidate.candidateRef || p.candidateDigest !== original.candidate.frozenDigest
                        || p.envelopeDigest !== original.candidate.envelopeDigest || p.taskRevision !== original.candidate.taskRevision
                        || p.taskUpdatedAt !== original.requested.acceptedAt
                        || p.verificationResultRef !== original.verification.verificationResultRef
                        || p.verificationDigest !== original.verification.verificationDigest) unavailable();
                }
            }
            const afterJob = READ_JOB.call(this.#manager, runId);
            const afterCompletion = READ_COMPLETION.call(this.#manager, runId);
            const afterAction = READ_ACTION.call(store, { taskId: task.taskId, actionId: origin.actionId });
            if (!permitted()) return UNKNOWN;
            if (!afterJob || agentLoopSummaryWriteDigest(immutableJob(job)) !== agentLoopSummaryWriteDigest(immutableJob(afterJob))
                || agentLoopSummaryWriteDigest(completion) !== agentLoopSummaryWriteDigest(afterCompletion)
                || agentLoopSummaryWriteDigest(action) !== agentLoopSummaryWriteDigest(afterAction)) unavailable();
            const evidence: AgentLoopTaskOutcomeEvidenceRef[] = [
                proof('summary-origin', `${AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX}${runId}`, origin.originDigest, intent.committedAt),
                proof('summary-write-intent', `${SUMMARY_WRITE_RECEIPT_PREFIX}${runId}`, intent.intentDigest, intent.committedAt),
                ...(readback ? [proof('summary-write-readback', `${SUMMARY_WRITE_RECEIPT_PREFIX}${runId}`,
                    readback.readbackDigest, readback.verifiedAt)] : []),
            ];
            if (history.state === 'rolled_back') {
                if (!history.rollbackDigest) unavailable();
                evidence.push(proof('summary-rollback', `maintenance_memory_summary_operation:${runId}`,
                    history.rollbackDigest, history.updatedAt));
            }
            return Object.freeze({ state: history.state === 'rolled_back' ? 'rolled-back' : 'committed',
                evidence: Object.freeze(evidence), sourceDigest: agentLoopSummaryWriteDigest({
                    job: immutableJob(job), history, action, completion: completion?.completion ?? null }) });
        } catch {
            if (sessionId !== null && !permitted()) return UNKNOWN;
            return unavailable();
        }
    }
}
