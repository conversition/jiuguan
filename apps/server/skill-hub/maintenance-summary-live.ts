/** @author Codex @date 2026-10-15 @version 1.1
 * A real Summary dispatch proves only its normalized proposal, never persistence, apply, or consumption.
 */
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import { hasCompleteHarnessToolResults,
    type HarnessResult } from '../../../packages/harness/public/engine-result-contract.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedMaintenanceModelHandle } from '../admitted-maintenance-model.ts';
import {
    MAINTENANCE_POLICY_VERSION, validateMaintenanceProposal,
    type MaintenanceProposal, type MaintenanceStrictProposalContext,
} from '../maintenance-types.ts';
import {
    createMaintenanceSummarySkillContextAuthority, type MaintenanceSummarySkillContextDependencies,
} from './maintenance-summary-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillBackgroundLiveCallGroup } from './live-request.ts';
import {
    maintenanceSummarySkillDigest, sealMaintenanceSummarySkillProposalProof,
    type MaintenanceSummarySkillProposalProof,
} from './maintenance-summary-proposal-proof.ts';
export {
    isMaintenanceSummarySkillProposalProof, type MaintenanceSummarySkillProposalProof,
} from './maintenance-summary-proposal-proof.ts';

export function maintenanceSummarySkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_MAINTENANCE_SUMMARY_LIVE === '1';
}

/** Manual and post-turn admission retain their exact, independently versioned policy contracts. */
export function maintenanceSummarySkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === MAINTENANCE_POLICY_VERSION
        || MAINTENANCE_ADMISSION_POLICY_VERSIONS.some((version) => version === policyVersion);
}

export function createMaintenanceSummarySkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly authority: Omit<MaintenanceSummarySkillContextDependencies, 'leaseAuthority' | 'bindings'>;
    readonly proposalContext: MaintenanceStrictProposalContext;
    readonly nowMs?: () => number;
}) {
    const execution = Object.freeze({
        ...input.authority.execution, job: Object.freeze({ ...input.authority.execution.job }),
    });
    const authority = Object.freeze({ ...input.authority, execution });
    const source = authority.source;
    const { job } = execution;
    const proposalContext = structuredClone(input.proposalContext);
    if (job.taskKind !== 'rolling_summary' || !maintenanceSummarySkillPolicyAllowed(job.policyVersion)) {
        throw new Error('maintenance-summary-skill-policy-mismatch');
    }
    if (maintenanceSummarySkillDigest(proposalContext) !== source.proposalContextDigest) {
        throw new Error('maintenance-summary-skill-context-mismatch');
    }
    const nowMs = input.nowMs ?? Date.now;
    let context: ReturnType<typeof createMaintenanceSummarySkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    let proposalDigest: string | null = null;
    let finished = false;
    let resultObserved = false;
    let completeResultObserved = false;
    let sealed = false;
    let proof: MaintenanceSummarySkillProposalProof | null = null;
    const group = createServerAgentSkillBackgroundLiveCallGroup({
        broker: input.broker, consumerId: 'maintenance.memory', taskKind: 'rolling_summary',
        policyVersion: job.policyVersion, runId: job.runId, parentRunId: job.parentRunId ?? job.runId,
        sourceRevision: job.sourceRevision, nowMs,
        createAuthority(binding) {
            context = createMaintenanceSummarySkillContextAuthority({
                ...authority, leaseAuthority: input.broker, bindings: [binding], nowMs,
            });
            return context;
        },
    });
    let success: ReturnType<typeof group.seal> = null;
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof group.prepareRequest>[0]) {
            proposalDigest = null;
            if (finished) { group.abandon(); return null; }
            try {
                const prepared = await group.prepareRequest(candidate);
                if (prepared && context) {
                    currentLease = candidate.lease;
                    contextRevision = context.readForLease(candidate.lease).contextRevision;
                }
                return prepared;
            } catch { group.abandon(); return null; }
        },
        observeResponse(content: string): void {
            proposalDigest = null;
            try {
                const envelope = JSON.parse(content);
                if (envelope?.tool?.name === 'propose_rolling_summary') {
                    proposalDigest = maintenanceSummarySkillDigest(validateMaintenanceProposal('rolling_summary',
                        envelope.tool.args, proposalContext));
                }
            } catch { /* The original Harness owns bounded schema correction, not this optional sidecar. */ }
        },
        observeResult(result: HarnessResult): void {
            if (finished || resultObserved) return;
            resultObserved = true;
            completeResultObserved = result.status === 'final-answer'
                && hasCompleteHarnessToolResults(result.completeness);
        },
        finish(outcome: Parameters<AdmittedMaintenanceModelHandle['finish']>[0]): void {
            if (finished) return;
            finished = true;
            success = outcome === 'completed' && completeResultObserved && proposalDigest !== null
                ? group.seal() : null;
            if (!success) group.abandon();
        },
        sealProposal(proposal: MaintenanceProposal): void {
            if (sealed) return;
            sealed = true;
            try {
                if (!finished || !success || !context || !currentLease
                    || proposalDigest !== maintenanceSummarySkillDigest(proposal)
                    || context.readForLease(currentLease).contextRevision !== contextRevision) return;
                proof = sealMaintenanceSummarySkillProposalProof({
                    proofVersion: 'maintenance-summary-skill-proposal-v1',
                    runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
                    sourceRevision: job.sourceRevision, sourceDigest: source.sourceDigest,
                    proposalContextDigest: source.proposalContextDigest,
                    attempt: job.attempt, proposalDigest, policyVersion: job.policyVersion,
                    contentMode: source.contentMode,
                    admittedAt: success.admittedAt, executedAt: success.executedAt,
                    validatedAt: new Date(nowMs()).toISOString(), requestDigests: success.requestDigests,
                    attribution: success.attribution,
                });
            } catch { /* Missing attribution cannot change a validated business proposal. */ }
        },
        takeSummaryProposalProvenance(): MaintenanceSummarySkillProposalProof | null {
            const result = proof;
            proof = null;
            return result;
        },
    });
}

/** Independent Summary side channel; it cannot populate the Memory proof getter or a durable outbox. */
export function bindMaintenanceSummarySkillLifecycle(
    handle: AdmittedMaintenanceModelHandle,
    call: ReturnType<typeof createMaintenanceSummarySkillLiveCall>,
) {
    return Object.freeze({
        ...handle,
        model: Object.freeze({
            ...handle.model,
            async complete(input: Parameters<typeof handle.model.complete>[0]) {
                const response = await handle.model.complete(input);
                call.observeResponse(response.content);
                return response;
            },
        }),
        resultObserved: call.observeResult,
        finish(outcome: Parameters<typeof handle.finish>[0] = 'completed') {
            try { call.finish(outcome); }
            catch { /* Always settle the original lease even when optional attribution is unavailable. */ }
            handle.finish(outcome);
        },
        proposalValidated: call.sealProposal,
        takeSummaryProposalProvenance: call.takeSummaryProposalProvenance,
    });
}
