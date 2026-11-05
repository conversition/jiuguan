/** Current Style background permissions are independent of the completed foreground turn. */
import { createHash } from 'node:crypto';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import { evaluateAgentTicketBeginPolicy } from '../agent-begin-policy.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import { agentLaneRolloutBucketIdentity, type AgentLaneRuntimeConfig } from '../agent-lane-runtime-config.ts';
import { createStyleCompileSkillSourceAuthority, type StyleCompileSkillSourceSnapshotV1 }
    from './style-compile-context.ts';
import type { ServerAgentSkillSourceContextAuthorityDependencies } from './context-authority.ts';

export function createStyleCompileSkillHostAuthority(input: {
    readonly source: StyleCompileSkillSourceSnapshotV1;
    readonly broker: AdmissionTicketBroker;
    readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl' | 'evidence'>;
    readonly readLaneRuntime: () => AgentLaneRuntimeConfig;
    readonly readEligibility: (lease: AgentAdmissionLease) => Readonly<{ allowed: boolean; revision: string }>;
    readonly liveEnabled: () => boolean;
    readonly safetyAuthority: ServerAgentSkillSourceContextAuthorityDependencies['safetyAuthority'];
    readonly nowMs?: () => number;
}) {
    const sourceAuthority = createStyleCompileSkillSourceAuthority({
        source: input.source, leaseAuthority: input.broker, nowMs: input.nowMs,
    });
    const decisionFor = (lease: AgentAdmissionLease) => {
        const runtime = input.readLaneRuntime();
        return { runtime, decision: evaluateAgentTicketBeginPolicy({
            lane: 'learning', sessionId: agentLaneRolloutBucketIdentity(runtime, lease.sessionId),
            desiredState: input.controlStore.get('learning').desiredState,
            hostCeiling: runtime.ceilings.learning, managed: runtime.managed,
            reservedModelCalls: lease.quotaReservationDigest ? lease.limits.maxModelCalls : 0,
            evidence: input.controlStore.evidence('learning'),
        }) };
    };
    const authorizeDispatch = (lease: AgentAdmissionLease): boolean => {
        const eligibility = input.readEligibility(lease), lane = input.controlStore.get('learning');
        const { runtime, decision } = decisionFor(lease);
        const source = sourceAuthority.readForLease(lease);
        if (!eligibility.allowed || lane.desiredState === 'killed' || lane.killedReason !== null
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
    return Object.freeze({ authorizeDispatch, authority: {
        controlStore: input.controlStore, safetyAuthority: input.safetyAuthority,
        runtimeAuthority: { readForLease(lease: AgentAdmissionLease) {
            const eligibility = input.readEligibility(lease), { runtime, decision } = decisionFor(lease);
            return {
                revision: `sha256:${createHash('sha256').update(JSON.stringify([eligibility.revision, runtime, decision])).digest('hex')}`,
                allowed: input.liveEnabled() && authorizeDispatch(lease) && decision.allowed,
                grant: { grantVersion: 'agent-skill-grant-v1' as const, tools: [], writableArtifactKinds: [],
                    maxRiskTier: 'advisory' as const, maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 512, maxOutputTokens: 0 },
                maxBodyTokens: 512, maxCompiledInstructionTokens: 512, maxValidatorOperations: 0, maxSkills: 1,
            };
        } },
    } });
}
