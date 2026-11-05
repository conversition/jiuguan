/** AQL owns a post-commit advisory window; it never reopens foreground turn authority. */
import { createHash } from 'node:crypto';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import { evaluateAgentTicketBeginPolicy } from '../agent-begin-policy.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import { agentLaneRolloutBucketIdentity, type AgentLaneRuntimeConfig } from '../agent-lane-runtime-config.ts';
import { createAqlReplanSkillSourceAuthority, type AqlReplanSkillSourceSnapshotV1 } from './aql-replan-context.ts';
import type { ServerAgentSkillSourceContextAuthorityDependencies } from './context-authority.ts';

export function createAqlReplanSkillHostAuthority(input: {
    readonly source: AqlReplanSkillSourceSnapshotV1;
    readonly broker: AdmissionTicketBroker;
    readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl' | 'evidence'>;
    readonly readLaneRuntime: () => AgentLaneRuntimeConfig;
    readonly readEligibility: (lease: AgentAdmissionLease) => Readonly<{ allowed: boolean; revision: string }>;
    readonly liveEnabled: () => boolean;
    readonly safetyAuthority: ServerAgentSkillSourceContextAuthorityDependencies['safetyAuthority'];
    readonly nowMs?: () => number;
}) {
    const sourceAuthority = createAqlReplanSkillSourceAuthority({
        source: input.source, leaseAuthority: input.broker, nowMs: input.nowMs,
    });
    const decisionFor = (lease: AgentAdmissionLease) => {
        const runtime = input.readLaneRuntime();
        return { runtime, decision: evaluateAgentTicketBeginPolicy({
            lane: 'interactive', sessionId: agentLaneRolloutBucketIdentity(runtime, lease.sessionId),
            desiredState: input.controlStore.get('interactive').desiredState,
            hostCeiling: runtime.ceilings.interactive, managed: runtime.managed,
            reservedModelCalls: lease.quotaReservationDigest ? lease.limits.maxModelCalls : 0,
            evidence: input.controlStore.evidence('interactive'),
        }) };
    };
    const authorizeDispatch = (lease: AgentAdmissionLease): boolean => {
        const eligibility = input.readEligibility(lease), lane = input.controlStore.get('interactive');
        const { runtime, decision } = decisionFor(lease);
        const source = sourceAuthority.readForLease(lease);
        if (!input.liveEnabled() || !eligibility.allowed || lane.desiredState === 'killed' || lane.killedReason !== null
            || !source || !(runtime.managed ? decision.allowed : !decision.shouldKill)
            || !agentCapabilitiesForAdmission(lease).every((id) => input.controlStore.capabilityControl(id).killedReason === null)) return false;
        if (source.contentMode === 'nsf') return true;
        const safety = input.safetyAuthority.readForLease(lease, source);
        return Boolean(safety && safety.sessionId === lease.sessionId && safety.sourceRevision === source.sourceRevision
            && safety.state.enabled && safety.state.reasonCode === 'active' && safety.state.adultAttestation === 'verified'
            && safety.state.participantsAdult && safety.state.consent === 'confirmed'
            && Number.isSafeInteger(safety.state.revision) && safety.state.revision >= 1
            && safety.state.sourceRevision === source.worldbookSourceRevision);
    };
    // Preserve permission across this call's own accounting without authorizing another call.
    const permissionSnapshot = (lease: AgentAdmissionLease): string | null => {
        const source = sourceAuthority.readForLease(lease), eligibility = input.readEligibility(lease);
        const lane = input.controlStore.get('interactive');
        const capabilities = agentCapabilitiesForAdmission(lease).map((id) => input.controlStore.capabilityControl(id));
        if (!source || !input.liveEnabled() || !eligibility.allowed || lane.desiredState === 'off'
            || lane.desiredState === 'killed' || lane.killedReason !== null
            || capabilities.some((row) => row.killedReason !== null)) return null;
        const safety = source.contentMode === 'nsfw' ? input.safetyAuthority.readForLease(lease, source) : null;
        if (source.contentMode === 'nsfw' && (!safety || safety.sessionId !== lease.sessionId
            || safety.sourceRevision !== source.sourceRevision || !safety.state.enabled || safety.state.reasonCode !== 'active'
            || safety.state.adultAttestation !== 'verified' || !safety.state.participantsAdult || safety.state.consent !== 'confirmed'
            || !Number.isSafeInteger(safety.state.revision) || safety.state.revision < 1
            || safety.state.sourceRevision !== source.worldbookSourceRevision)) return null;
        return JSON.stringify({ source, eligibility, lane, capabilities, safety, runtime: input.readLaneRuntime() });
    };
    return Object.freeze({ authorizeDispatch, permissionSnapshot, authority: {
        controlStore: input.controlStore, safetyAuthority: input.safetyAuthority,
        runtimeAuthority: { readForLease(lease: AgentAdmissionLease) {
            const eligibility = input.readEligibility(lease), { runtime, decision } = decisionFor(lease);
            return {
                revision: `sha256:${createHash('sha256').update(JSON.stringify([eligibility.revision, runtime, decision])).digest('hex')}`,
                allowed: authorizeDispatch(lease) && decision.allowed,
                grant: { grantVersion: 'agent-skill-grant-v1' as const, tools: [], writableArtifactKinds: [],
                    maxRiskTier: 'advisory' as const, maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 512, maxOutputTokens: 0 },
                maxBodyTokens: 512, maxCompiledInstructionTokens: 512, maxValidatorOperations: 0, maxSkills: 1,
            };
        } },
    } });
}
