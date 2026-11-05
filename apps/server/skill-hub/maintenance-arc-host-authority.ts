/** Arc permission remains current through audit settlement without reauthorizing spent quota. */
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import { evaluateAgentTicketBeginPolicy } from '../agent-begin-policy.ts';
import { agentLaneRolloutBucketIdentity, type AgentLaneRuntimeConfig } from '../agent-lane-runtime-config.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import { createMaintenanceArcSkillSourceAuthority,
    type MaintenanceArcSkillContextDependencies } from './maintenance-arc-context.ts';
import { maintenanceArcSkillDigest } from './maintenance-arc-proposal-proof.ts';

export function createMaintenanceArcSkillHostAuthority(input: Pick<MaintenanceArcSkillContextDependencies,
    'execution' | 'source' | 'jobAuthority' | 'sourceAuthority' | 'isSessionOpen' | 'safetyAuthority' | 'nowMs'> & {
        readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl' | 'evidence'>;
        readonly readLaneRuntime: () => AgentLaneRuntimeConfig;
        readonly readEligibility: (lease: AgentAdmissionLease) => { readonly allowed: boolean; readonly revision: string };
        readonly liveEnabled: () => boolean;
    }) {
    const sourceAuthority = createMaintenanceArcSkillSourceAuthority(input);
    const decisionFor = (lease: AgentAdmissionLease) => {
        const runtime = input.readLaneRuntime();
        return { runtime, decision: evaluateAgentTicketBeginPolicy({
            lane: 'maintenance', sessionId: agentLaneRolloutBucketIdentity(runtime, lease.sessionId),
            desiredState: input.controlStore.get('maintenance').desiredState,
            hostCeiling: runtime.ceilings.maintenance, managed: runtime.managed,
            reservedModelCalls: lease.quotaReservationDigest ? lease.limits.maxModelCalls : 0,
            evidence: input.controlStore.evidence('maintenance'),
        }) };
    };
    const permissionSnapshot = (lease: AgentAdmissionLease): string | null => {
        const source = sourceAuthority.readForLease(lease), eligibility = input.readEligibility(lease);
        const lane = input.controlStore.get('maintenance');
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
        return maintenanceArcSkillDigest({ source, eligibility, lane, capabilities, safety, runtime: input.readLaneRuntime() });
    };
    const authorizeDispatch = (lease: AgentAdmissionLease): boolean => {
        const { runtime, decision } = decisionFor(lease);
        return permissionSnapshot(lease) !== null && (runtime.managed ? decision.allowed : !decision.shouldKill);
    };
    return Object.freeze({ authorizeDispatch, permissionSnapshot, authority: {
        ...input, permissionSnapshot,
        runtimeAuthority: { readForLease(lease: AgentAdmissionLease) {
            const eligibility = input.readEligibility(lease), { runtime, decision } = decisionFor(lease);
            return {
                revision: maintenanceArcSkillDigest([eligibility.revision, runtime, decision]),
                allowed: authorizeDispatch(lease) && decision.allowed,
                grant: { grantVersion: 'agent-skill-grant-v1' as const, tools: [], writableArtifactKinds: [],
                    maxRiskTier: 'advisory' as const, maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 512, maxOutputTokens: 0 },
                maxBodyTokens: 512, maxCompiledInstructionTokens: 512, maxValidatorOperations: 0, maxSkills: 1,
            };
        } },
    } });
}
