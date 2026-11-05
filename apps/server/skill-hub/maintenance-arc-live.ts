/** Arc Skill supplies proposal provenance on the existing Maintenance call, never apply authority. */
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import { hasCompleteHarnessToolResults, type HarnessResult } from '../../../packages/harness/public/engine-result-contract.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedMaintenanceModelHandle } from '../admitted-maintenance-model.ts';
import { MAINTENANCE_POLICY_VERSION, validateMaintenanceProposal,
    type MaintenanceProposal, type MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import { createMaintenanceArcSkillContextAuthority,
    type MaintenanceArcSkillContextDependencies } from './maintenance-arc-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillArcLiveCallGroup } from './live-request.ts';
import { maintenanceArcSkillDigest, sealMaintenanceArcSkillProposalProof,
    type MaintenanceArcSkillProposalProof } from './maintenance-arc-proposal-proof.ts';
export { isMaintenanceArcSkillProposalProof,
    type MaintenanceArcSkillProposalProof } from './maintenance-arc-proposal-proof.ts';

export function maintenanceArcSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_MAINTENANCE_ARC_LIVE === '1';
}
export function maintenanceArcSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === MAINTENANCE_POLICY_VERSION
        || MAINTENANCE_ADMISSION_POLICY_VERSIONS.some((version) => version === policyVersion);
}

function containsLocalReviewMaterial(value: unknown): boolean {
    if (typeof value === 'string') return /"arcReviewDescriptors"\s*:/u.test(value);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => key === 'arcReviewDescriptors' || containsLocalReviewMaterial(item));
}

export function createMaintenanceArcSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly authority: Omit<MaintenanceArcSkillContextDependencies, 'leaseAuthority' | 'bindings'> & {
        readonly permissionSnapshot: (lease: AgentAdmissionLease) => string | null;
    };
    readonly proposalContext: MaintenanceStrictProposalContext;
    readonly nowMs?: () => number;
}) {
    const execution = Object.freeze({ ...input.authority.execution, job: Object.freeze({ ...input.authority.execution.job }) });
    const authority = Object.freeze({ ...input.authority, execution });
    const source = authority.source, { job } = execution;
    const proposalContext = structuredClone(input.proposalContext);
    if (job.taskKind !== 'branch_index' || !maintenanceArcSkillPolicyAllowed(job.policyVersion)) {
        throw new Error('maintenance-arc-skill-policy-mismatch');
    }
    if (maintenanceArcSkillDigest(proposalContext) !== source.providerProposalContextDigest
        || 'arcReviewDescriptors' in proposalContext || typeof authority.permissionSnapshot !== 'function') {
        throw new Error('maintenance-arc-skill-context-mismatch');
    }
    const nowMs = input.nowMs ?? Date.now;
    let context: ReturnType<typeof createMaintenanceArcSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null, contextRevision: string | null = null;
    let permission: string | null = null, proposalDigest: string | null = null;
    let requestSignal: AbortSignal | undefined;
    let finished = false, resultObserved = false, completeResultObserved = false, sealed = false;
    let proof: MaintenanceArcSkillProposalProof | null = null;
    const group = createServerAgentSkillArcLiveCallGroup({
        broker: input.broker, consumerId: 'maintenance.arc', policyVersion: job.policyVersion,
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sourceRevision: job.sourceRevision, nowMs,
        createAuthority(binding) {
            context = createMaintenanceArcSkillContextAuthority({ ...authority,
                leaseAuthority: input.broker, bindings: [binding], nowMs });
            return context;
        },
    });
    let success: ReturnType<typeof group.seal> = null;
    const fail = (reason: string): never => { group.abandon(); proof = null; throw new Error(reason); };
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof group.prepareRequest>[0]) {
            proposalDigest = null;
            if (finished || containsLocalReviewMaterial(candidate.request)) {
                return fail('maintenance-arc-skill-request-invalid');
            }
            const prepared = await group.prepareRequest(candidate);
            if (!prepared || !context) return fail('maintenance-arc-skill-request-unavailable');
            try {
                currentLease = candidate.lease; requestSignal = candidate.signal;
                contextRevision = context.readForLease(candidate.lease).contextRevision;
                return prepared;
            } catch {
                prepared.discard(); return fail('maintenance-arc-skill-request-unavailable');
            }
        },
        observeResponse(content: string): void {
            proposalDigest = null;
            if (finished) return fail('maintenance-arc-skill-output-invalid');
            try {
                const envelope = JSON.parse(content);
                const name = envelope?.tool?.name;
                if (name === 'propose_branch_index') {
                    proposalDigest = maintenanceArcSkillDigest(validateMaintenanceProposal('branch_index',
                        envelope.tool.args, proposalContext));
                } else if (!['query_memory', 'get_worldbook', 'get_variables'].includes(name)) {
                    return fail('maintenance-arc-skill-output-invalid');
                }
            } catch { return fail('maintenance-arc-skill-output-invalid'); }
        },
        observeResult(result: HarnessResult): void {
            if (finished || resultObserved) return;
            resultObserved = true;
            completeResultObserved = result.status === 'final-answer' && hasCompleteHarnessToolResults(result.completeness);
        },
        finish(outcome: Parameters<AdmittedMaintenanceModelHandle['finish']>[0]): void {
            if (finished) return;
            finished = true;
            if (outcome !== 'completed') { group.abandon(); return; }
            if (!completeResultObserved || !proposalDigest || !currentLease || !context || requestSignal?.aborted
                || context.readForLease(currentLease).contextRevision !== contextRevision) {
                return fail('maintenance-arc-skill-proof-unavailable');
            }
            permission = authority.permissionSnapshot(currentLease);
            success = permission === null ? null : group.seal();
            if (!success) return fail('maintenance-arc-skill-proof-unavailable');
        },
        sealProposal(proposal: MaintenanceProposal): void {
            if (sealed) return;
            sealed = true;
            // The underlying finish audit has already settled this call's quota. Compare current
            // source/control/safety permissions, not a fresh begin decision for an additional call.
            if (!finished || !success || !currentLease || !permission || requestSignal?.aborted
                || nowMs() >= currentLease.expiresAtMs || !input.broker.ownsLease(currentLease)
                || proposalDigest !== maintenanceArcSkillDigest(proposal)
                || authority.permissionSnapshot(currentLease) !== permission) {
                return fail('maintenance-arc-skill-proof-unavailable');
            }
            proof = sealMaintenanceArcSkillProposalProof({
                proofVersion: 'maintenance-arc-skill-proposal-v1',
                runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
                sourceRevision: job.sourceRevision, sourceDigest: source.sourceDigest,
                proposalContextDigest: source.proposalContextDigest,
                providerProposalContextDigest: source.providerProposalContextDigest,
                attempt: job.attempt, proposalDigest, policyVersion: job.policyVersion, contentMode: source.contentMode,
                admittedAt: success.admittedAt, executedAt: success.executedAt,
                validatedAt: new Date(nowMs()).toISOString(), requestDigests: success.requestDigests,
                attribution: success.attribution,
            });
        },
        takeArcProposalProvenance(): MaintenanceArcSkillProposalProof | null {
            const result = proof; proof = null; return result;
        },
    });
}

/** A required side channel: errors propagate while the original lease always settles. */
export function bindMaintenanceArcSkillLifecycle(handle: AdmittedMaintenanceModelHandle,
    call: ReturnType<typeof createMaintenanceArcSkillLiveCall>) {
    return Object.freeze({
        ...handle, arcSkillRequired: true as const,
        model: Object.freeze({ ...handle.model,
            async complete(input: Parameters<typeof handle.model.complete>[0]) {
                const response = await handle.model.complete(input); call.observeResponse(response.content); return response;
            },
        }),
        resultObserved: call.observeResult,
        finish(outcome: Parameters<typeof handle.finish>[0] = 'completed') {
            try { call.finish(outcome); } finally { handle.finish(outcome); }
        },
        proposalValidated: call.sealProposal,
        takeArcProposalProvenance: call.takeArcProposalProvenance,
    });
}
