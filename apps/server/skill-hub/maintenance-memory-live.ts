/** @author Codex @date 2026-10-15 @version 1.1
 * Memory proposal provenance is not persistence, approval, apply, or context consumption.
 */
import { createHash } from 'node:crypto';
import { hasCompleteHarnessToolResults,
    type HarnessResult } from '../../../packages/harness/public/engine-result-contract.ts';
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedMaintenanceModelHandle } from '../admitted-maintenance-model.ts';
import {
    MAINTENANCE_POLICY_VERSION,
    validateMaintenanceProposal,
    type MaintenanceProposal,
    type MaintenanceStrictProposalContext,
} from '../maintenance-types.ts';
import {
    createMaintenanceMemorySkillContextAuthority,
    type MaintenanceMemorySkillContextDependencies,
} from './maintenance-memory-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillBackgroundLiveCallGroup } from './live-request.ts';
import { sealMaintenanceMemorySkillProposalProof,
    type MaintenanceMemorySkillProposalProof } from './maintenance-memory-proposal-proof.ts';
export { isMaintenanceMemorySkillProposalProof,
    type MaintenanceMemorySkillProposalProof } from './maintenance-memory-proposal-proof.ts';

const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function maintenanceMemorySkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_MAINTENANCE_MEMORY_LIVE === '1';
}

/** Manual execution and natural post-turn admission have different, explicitly versioned policies. */
export function maintenanceMemorySkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === MAINTENANCE_POLICY_VERSION
        || MAINTENANCE_ADMISSION_POLICY_VERSIONS.some((version) => version === policyVersion);
}

export function createMaintenanceMemorySkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly authority: Omit<MaintenanceMemorySkillContextDependencies, 'leaseAuthority' | 'bindings'>;
    readonly proposalContext: MaintenanceStrictProposalContext;
    readonly nowMs?: () => number;
}) {
    const execution = Object.freeze({ ...input.authority.execution,
        job: Object.freeze({ ...input.authority.execution.job }) });
    const { job } = execution;
    const proposalContext = structuredClone(input.proposalContext);
    if (job.taskKind !== 'memory_consolidation' || !maintenanceMemorySkillPolicyAllowed(job.policyVersion)) {
        throw new Error('maintenance-memory-skill-policy-mismatch');
    }
    if (digest(proposalContext) !== input.authority.source.proposalContextDigest) {
        throw new Error('maintenance-memory-skill-context-mismatch');
    }
    const nowMs = input.nowMs ?? Date.now;
    let context: ReturnType<typeof createMaintenanceMemorySkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    let proposalDigest: string | null = null;
    let finished = false;
    let resultObserved = false;
    let completeResultObserved = false;
    let sealed = false;
    let proof: MaintenanceMemorySkillProposalProof | null = null;
    const group = createServerAgentSkillBackgroundLiveCallGroup({
        broker: input.broker, consumerId: 'maintenance.memory', policyVersion: job.policyVersion,
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sourceRevision: job.sourceRevision, nowMs,
        createAuthority(binding) {
            context = createMaintenanceMemorySkillContextAuthority({
                ...input.authority, execution, leaseAuthority: input.broker, bindings: [binding], nowMs,
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
                if (envelope?.tool?.name === 'propose_memory_consolidation') {
                    proposalDigest = digest(validateMaintenanceProposal('memory_consolidation',
                        envelope.tool.args, proposalContext));
                }
            } catch { /* An invalid model proposal can still receive the existing bounded correction. */ }
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
                if (!finished || !success || !context || !currentLease || proposalDigest !== digest(proposal)
                    || context.readForLease(currentLease).contextRevision !== contextRevision) return;
                const metadata = {
                    proofVersion: 'maintenance-memory-skill-proposal-v1' as const,
                    runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
                    sourceRevision: job.sourceRevision, sourceDigest: input.authority.source.sourceDigest,
                    attempt: job.attempt, proposalDigest, policyVersion: job.policyVersion,
                    contentMode: input.authority.source.contentMode,
                    admittedAt: success.admittedAt, executedAt: success.executedAt,
                    validatedAt: new Date(nowMs()).toISOString(), requestDigests: success.requestDigests,
                    attribution: success.attribution,
                };
                proof = sealMaintenanceMemorySkillProposalProof(metadata);
            } catch { /* Provenance loss cannot change an already validated business proposal. */ }
        },
        takeProposalProvenance(): MaintenanceMemorySkillProposalProof | null {
            const result = proof; proof = null; return result;
        },
    });
}

/** Trusted side channel, not a model-returned proof. It writes no durable event. */
export function bindMaintenanceMemorySkillLifecycle(
    handle: AdmittedMaintenanceModelHandle,
    call: ReturnType<typeof createMaintenanceMemorySkillLiveCall>,
) {
    return Object.freeze({
        ...handle,
        model: Object.freeze({
            ...handle.model, async complete(input: Parameters<typeof handle.model.complete>[0]) {
                const response = await handle.model.complete(input);
                call.observeResponse(response.content);
                return response;
            }
        }),
        resultObserved: call.observeResult,
        finish(outcome: Parameters<typeof handle.finish>[0] = 'completed') {
            try { call.finish(outcome); }
            catch { /* The original lease must settle even if its optional provenance sidecar fails. */ }
            handle.finish(outcome);
        },
        proposalValidated: call.sealProposal,
        takeProposalProvenance: call.takeProposalProvenance,
    });
}
