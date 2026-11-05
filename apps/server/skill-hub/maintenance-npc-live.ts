/** NPC Skill supplies proposal/no-op provenance on the existing call, never apply authority. */
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import { hasCompleteHarnessToolResults, type HarnessResult } from '../../../packages/harness/public/engine-result-contract.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedMaintenanceModelHandle } from '../admitted-maintenance-model.ts';
import { MAINTENANCE_POLICY_VERSION, validateMaintenanceProposal, normalizeNpcMaintenanceNoopTerminal,
    type MaintenanceProposal, type NpcMaintenanceNoopTerminal, type MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import { createMaintenanceNpcSkillContextAuthority,
    type MaintenanceNpcSkillContextDependencies } from './maintenance-npc-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillNpcLiveCallGroup } from './live-request.ts';
import { maintenanceNpcSkillDigest, sealMaintenanceNpcSkillResultProof,
    type MaintenanceNpcSkillResultProof } from './maintenance-npc-result-proof.ts';
export { isMaintenanceNpcSkillResultProof,
    type MaintenanceNpcSkillResultProof } from './maintenance-npc-result-proof.ts';

export function maintenanceNpcSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_MAINTENANCE_NPC_LIVE === '1';
}
export function maintenanceNpcSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === MAINTENANCE_POLICY_VERSION
        || MAINTENANCE_ADMISSION_POLICY_VERSIONS.some((version) => version === policyVersion);
}

export function createMaintenanceNpcSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly authority: Omit<MaintenanceNpcSkillContextDependencies, 'leaseAuthority' | 'bindings'> & {
        readonly permissionSnapshot: (lease: AgentAdmissionLease) => string | null;
    };
    readonly proposalContext: MaintenanceStrictProposalContext;
    readonly nowMs?: () => number;
}) {
    const execution = Object.freeze({ ...input.authority.execution, job: Object.freeze({ ...input.authority.execution.job }) });
    const authority = Object.freeze({ ...input.authority, execution });
    const source = authority.source, { job } = execution;
    const proposalContext = structuredClone(input.proposalContext);
    if (job.taskKind !== 'npc_state' || !maintenanceNpcSkillPolicyAllowed(job.policyVersion)) {
        throw new Error('maintenance-npc-skill-policy-mismatch');
    }
    if (maintenanceNpcSkillDigest(proposalContext) !== source.providerProposalContextDigest
        || !('allowedCharacterIds' in proposalContext) || typeof authority.permissionSnapshot !== 'function') {
        throw new Error('maintenance-npc-skill-context-mismatch');
    }
    const nowMs = input.nowMs ?? Date.now;
    let context: ReturnType<typeof createMaintenanceNpcSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null, contextRevision: string | null = null;
    let permission: string | null = null, terminalDigest: string | null = null;
    let terminalKind: 'proposal' | 'noop' | null = null;
    let requestSignal: AbortSignal | undefined;
    let finished = false, resultObserved = false, completeResultObserved = false, sealed = false;
    let proof: MaintenanceNpcSkillResultProof | null = null;
    const group = createServerAgentSkillNpcLiveCallGroup({
        broker: input.broker, consumerId: 'maintenance.npc', policyVersion: job.policyVersion,
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sourceRevision: job.sourceRevision, nowMs,
        createAuthority(binding) {
            context = createMaintenanceNpcSkillContextAuthority({ ...authority,
                leaseAuthority: input.broker, bindings: [binding], nowMs });
            return context;
        },
    });
    let success: ReturnType<typeof group.seal> = null;
    const fail = (reason: string): never => { group.abandon(); proof = null; throw new Error(reason); };
    const sealTerminal = (kind: 'proposal' | 'noop', terminal: MaintenanceProposal | NpcMaintenanceNoopTerminal): void => {
        if (sealed) return;
        sealed = true;
        // The original finish audit has settled this call's quota. Compare current source/control/
        // safety permissions, not a fresh begin decision for an additional call.
        if (!finished || !success || !currentLease || !permission || requestSignal?.aborted
            || nowMs() >= currentLease.expiresAtMs || !input.broker.ownsLease(currentLease)
            || kind !== terminalKind || terminalDigest !== maintenanceNpcSkillDigest(terminal)
            || authority.permissionSnapshot(currentLease) !== permission) {
            return fail('maintenance-npc-skill-proof-unavailable');
        }
        proof = sealMaintenanceNpcSkillResultProof({
            proofVersion: 'maintenance-npc-skill-result-v1',
            runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
            sourceRevision: job.sourceRevision, sourceDigest: source.sourceDigest,
            proposalContextDigest: source.proposalContextDigest,
            providerProposalContextDigest: source.providerProposalContextDigest,
            attempt: job.attempt, terminalKind: kind, terminalDigest,
            policyVersion: job.policyVersion, contentMode: source.contentMode,
            admittedAt: success.admittedAt, executedAt: success.executedAt,
            validatedAt: new Date(nowMs()).toISOString(), requestDigests: success.requestDigests,
            attribution: success.attribution,
        });
    };
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof group.prepareRequest>[0]) {
            terminalDigest = null; terminalKind = null;
            if (finished) {
                return fail('maintenance-npc-skill-request-invalid');
            }
            const prepared = await group.prepareRequest(candidate);
            if (!prepared || !context) return fail('maintenance-npc-skill-request-unavailable');
            try {
                currentLease = candidate.lease; requestSignal = candidate.signal;
                contextRevision = context.readForLease(candidate.lease).contextRevision;
                return prepared;
            } catch {
                prepared.discard(); return fail('maintenance-npc-skill-request-unavailable');
            }
        },
        observeResponse(content: string): void {
            terminalDigest = null; terminalKind = null;
            if (finished) return fail('maintenance-npc-skill-output-invalid');
            try {
                const envelope = JSON.parse(content);
                const name = envelope?.tool?.name;
                if (name === 'propose_npc_state') {
                    terminalKind = 'proposal';
                    terminalDigest = maintenanceNpcSkillDigest(validateMaintenanceProposal('npc_state',
                        envelope.tool.args, proposalContext));
                } else if (name === 'complete_npc_state_noop' && 'allowedCharacterIds' in proposalContext) {
                    terminalKind = 'noop';
                    terminalDigest = maintenanceNpcSkillDigest(normalizeNpcMaintenanceNoopTerminal(envelope.tool.args, proposalContext));
                } else if (!['query_memory', 'get_worldbook', 'get_variables'].includes(name)) {
                    return fail('maintenance-npc-skill-output-invalid');
                }
            } catch { return fail('maintenance-npc-skill-output-invalid'); }
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
            if (!completeResultObserved || !terminalKind || !terminalDigest || !currentLease || !context || requestSignal?.aborted
                || context.readForLease(currentLease).contextRevision !== contextRevision) {
                return fail('maintenance-npc-skill-proof-unavailable');
            }
            permission = authority.permissionSnapshot(currentLease);
            success = permission === null ? null : group.seal();
            if (!success) return fail('maintenance-npc-skill-proof-unavailable');
        },
        sealProposal(proposal: MaintenanceProposal): void { sealTerminal('proposal', proposal); },
        sealNoop(noop: NpcMaintenanceNoopTerminal): void { sealTerminal('noop', noop); },
        takeNpcResultProvenance(): MaintenanceNpcSkillResultProof | null {
            const result = proof; proof = null; return result;
        },
    });
}

/** A required side channel: errors propagate while the original lease always settles. */
export function bindMaintenanceNpcSkillLifecycle(handle: AdmittedMaintenanceModelHandle,
    call: ReturnType<typeof createMaintenanceNpcSkillLiveCall>) {
    return Object.freeze({
        ...handle, npcSkillRequired: true as const,
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
        npcNoopValidated: call.sealNoop,
        takeNpcResultProvenance: call.takeNpcResultProvenance,
    });
}
