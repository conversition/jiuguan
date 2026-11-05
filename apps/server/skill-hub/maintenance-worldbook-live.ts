/** Worldbook Skill supplies proposal provenance on the existing Maintenance call, never apply authority. */
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import { hasCompleteHarnessToolResults, type HarnessResult } from '../../../packages/harness/public/engine-result-contract.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedMaintenanceModelHandle } from '../admitted-maintenance-model.ts';
import { MAINTENANCE_POLICY_VERSION, validateMaintenanceProposal,
    type MaintenanceProposal, type MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import { createMaintenanceWorldbookSkillContextAuthority,
    type MaintenanceWorldbookSkillContextDependencies } from './maintenance-worldbook-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillWorldbookLiveCallGroup } from './live-request.ts';
import { maintenanceWorldbookSkillDigest, sealMaintenanceWorldbookSkillProposalProof,
    type MaintenanceWorldbookSkillProposalProof } from './maintenance-worldbook-proposal-proof.ts';
export { isMaintenanceWorldbookSkillProposalProof,
    type MaintenanceWorldbookSkillProposalProof } from './maintenance-worldbook-proposal-proof.ts';

export function maintenanceWorldbookSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_MAINTENANCE_WORLDBOOK_LIVE === '1';
}
export function maintenanceWorldbookSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === MAINTENANCE_POLICY_VERSION
        || MAINTENANCE_ADMISSION_POLICY_VERSIONS.some((version) => version === policyVersion);
}

export function createMaintenanceWorldbookSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly authority: Omit<MaintenanceWorldbookSkillContextDependencies, 'leaseAuthority' | 'bindings'> & {
        readonly permissionSnapshot: (lease: AgentAdmissionLease) => string | null;
    };
    readonly proposalContext: MaintenanceStrictProposalContext;
    readonly nowMs?: () => number;
}) {
    const execution = Object.freeze({ ...input.authority.execution, job: Object.freeze({ ...input.authority.execution.job }) });
    const authority = Object.freeze({ ...input.authority, execution });
    const source = authority.source, { job } = execution;
    const proposalContext = structuredClone(input.proposalContext);
    if (job.taskKind !== 'worldbook_repair' || !maintenanceWorldbookSkillPolicyAllowed(job.policyVersion)) {
        throw new Error('maintenance-worldbook-skill-policy-mismatch');
    }
    if (maintenanceWorldbookSkillDigest(proposalContext) !== source.providerProposalContextDigest
        || typeof authority.permissionSnapshot !== 'function') {
        throw new Error('maintenance-worldbook-skill-context-mismatch');
    }
    const nowMs = input.nowMs ?? Date.now;
    let context: ReturnType<typeof createMaintenanceWorldbookSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null, contextRevision: string | null = null;
    let permission: string | null = null, proposalDigest: string | null = null;
    let requestSignal: AbortSignal | undefined;
    let finished = false, resultObserved = false, completeResultObserved = false, sealed = false, failed = false;
    let proof: MaintenanceWorldbookSkillProposalProof | null = null;
    const group = createServerAgentSkillWorldbookLiveCallGroup({
        broker: input.broker, consumerId: 'maintenance.worldbook', policyVersion: job.policyVersion,
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sourceRevision: job.sourceRevision, nowMs,
        createAuthority(binding) {
            context = createMaintenanceWorldbookSkillContextAuthority({ ...authority,
                leaseAuthority: input.broker, bindings: [binding], nowMs });
            return context;
        },
    });
    let success: ReturnType<typeof group.seal> = null;
    const fail = (reason: string): never => { failed = true; group.abandon(); proof = null; throw new Error(reason); };
    const assertCurrent = (): void => {
        // Audit may already have spent the last quota unit. Only the captured permission and
        // original live claim/lease/source are checked; this is not admission for another call.
        if (failed || !finished || !success || !currentLease || !permission || requestSignal?.aborted
            || nowMs() >= currentLease.expiresAtMs || !input.broker.ownsLease(currentLease)
            || authority.permissionSnapshot(currentLease) !== permission) {
            return fail('maintenance-worldbook-skill-proof-unavailable');
        }
    };
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof group.prepareRequest>[0]) {
            proposalDigest = null;
            if (finished || failed) {
                return fail('maintenance-worldbook-skill-request-invalid');
            }
            const prepared = await group.prepareRequest(candidate);
            if (!prepared || !context) return fail('maintenance-worldbook-skill-request-unavailable');
            try {
                currentLease = candidate.lease; requestSignal = candidate.signal;
                contextRevision = context.readForLease(candidate.lease).contextRevision;
                return prepared;
            } catch {
                prepared.discard(); return fail('maintenance-worldbook-skill-request-unavailable');
            }
        },
        observeResponse(content: string): void {
            proposalDigest = null;
            if (finished || failed) return fail('maintenance-worldbook-skill-output-invalid');
            try {
                const envelope = JSON.parse(content);
                const name = envelope?.tool?.name;
                if (name === 'propose_worldbook_repair') {
                    proposalDigest = maintenanceWorldbookSkillDigest(validateMaintenanceProposal('worldbook_repair',
                        envelope.tool.args, proposalContext));
                } else if (!['query_memory', 'get_worldbook', 'get_variables'].includes(name)) {
                    return fail('maintenance-worldbook-skill-output-invalid');
                }
            } catch { return fail('maintenance-worldbook-skill-output-invalid'); }
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
                return fail('maintenance-worldbook-skill-proof-unavailable');
            }
            permission = authority.permissionSnapshot(currentLease);
            success = permission === null ? null : group.seal();
            if (!success) return fail('maintenance-worldbook-skill-proof-unavailable');
        },
        sealProposal(proposal: MaintenanceProposal): void {
            if (sealed) { assertCurrent(); return; }
            assertCurrent();
            if (proposalDigest !== maintenanceWorldbookSkillDigest(proposal)) {
                return fail('maintenance-worldbook-skill-proof-unavailable');
            }
            proof = sealMaintenanceWorldbookSkillProposalProof({
                proofVersion: 'maintenance-worldbook-skill-proposal-v1',
                runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
                sourceRevision: job.sourceRevision, sourceDigest: source.sourceDigest,
                proposalContextDigest: source.proposalContextDigest,
                providerProposalContextDigest: source.providerProposalContextDigest,
                attempt: job.attempt, proposalDigest: proposalDigest!, policyVersion: job.policyVersion, contentMode: source.contentMode,
                admittedAt: success!.admittedAt, executedAt: success!.executedAt,
                validatedAt: new Date(nowMs()).toISOString(), requestDigests: success!.requestDigests,
                attribution: success!.attribution,
            });
            sealed = true;
        },
        assertWorldbookSkillCurrent(): void {
            if (!sealed) return fail('maintenance-worldbook-skill-proof-unavailable');
            assertCurrent();
        },
        takeWorldbookProposalProvenance(): MaintenanceWorldbookSkillProposalProof | null {
            const result = proof; proof = null; return result;
        },
    });
}

/** A required side channel: errors propagate while the original lease always settles. */
export function bindMaintenanceWorldbookSkillLifecycle(handle: AdmittedMaintenanceModelHandle,
    call: ReturnType<typeof createMaintenanceWorldbookSkillLiveCall>) {
    return Object.freeze({
        ...handle, worldbookSkillRequired: true as const,
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
        takeWorldbookProposalProvenance: call.takeWorldbookProposalProvenance,
        assertWorldbookSkillCurrent: call.assertWorldbookSkillCurrent,
    });
}
