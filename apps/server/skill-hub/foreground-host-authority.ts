/** @author Codex @date 2026-10-13 @version 1.0
 * Share current host permission reads without introducing another orchestrator.
 */
import { createHash } from 'node:crypto';
import type { AgentClosureExecutionClass } from '../../../packages/agent-closure/index.ts';
import { narrowAgentRolloutState } from '../../../packages/agent-policy/public/admission.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import { evaluateAgentTicketBeginPolicy, rolloutLaneForAdmission } from '../agent-begin-policy.ts';
import { agentLaneRolloutBucketIdentity, type AgentLaneRuntimeConfig } from '../agent-lane-runtime-config.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import type { ServerAgentSkillContextAuthorityDependencies } from './context-authority.ts';

/** Current base permission and its revision, independent of the optional live-Skill switch. */
export interface ForegroundSkillHostEligibility {
    readonly allowed: boolean;
    readonly revision: string;
}

/** Fixed synchronous host readers shared by foreground consumers, not a new orchestrator. */
export function createForegroundSkillHostAuthority(input: {
    readonly turnAuthority: ServerAgentSkillContextAuthorityDependencies['turnAuthority'];
    readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl' | 'evidence'>;
    readonly safetyAuthority: ServerAgentSkillContextAuthorityDependencies['safetyAuthority'];
    readonly readLaneRuntime: () => AgentLaneRuntimeConfig;
    readonly readEligibility: (lease: AgentAdmissionLease) => ForegroundSkillHostEligibility;
    readonly liveEnabled: () => boolean;
    readonly isCurrentSession: () => boolean;
}) {
    const decisionFor = (lane: AgentAdmissionLease['lane'], sessionId: string, reservedModelCalls: number) => {
        const runtime = input.readLaneRuntime();
        const rolloutLane = rolloutLaneForAdmission(lane);
        return {
            runtime, decision: evaluateAgentTicketBeginPolicy({
                lane,
                sessionId: agentLaneRolloutBucketIdentity(runtime, sessionId),
                desiredState: input.controlStore.get(rolloutLane).desiredState,
                hostCeiling: runtime.ceilings[rolloutLane], managed: runtime.managed, reservedModelCalls,
                evidence: input.controlStore.evidence(rolloutLane)
            })
        };
    };
    const authorizeDispatch = (lease: AgentAdmissionLease): boolean => {
        const turn = input.turnAuthority.readAgentSkillTurnContext(lease.parentRunId);
        return input.isCurrentSession() && turn?.sessionId === lease.sessionId
            && turn.sourceRevision === lease.sourceRevision && turn.contentMode === lease.mode
            && input.readEligibility(lease).allowed;
    };
    /** Current permission after a successful call; never re-admits its already spent quota. */
    const permissionSnapshot = (lease: AgentAdmissionLease): string | null => {
        try {
            if (!input.liveEnabled() || !authorizeDispatch(lease)) return null;
            const turn = input.turnAuthority.readAgentSkillTurnContext(lease.parentRunId);
            if (!turn) return null;
            const lane = input.controlStore.get(rolloutLaneForAdmission(lease.lane));
            const runtime = input.readLaneRuntime();
            const effectiveState = narrowAgentRolloutState(lane.desiredState,
                runtime.managed ? runtime.ceilings[rolloutLaneForAdmission(lease.lane)] : 'on');
            const controls = agentCapabilitiesForAdmission(lease).map(id => input.controlStore.capabilityControl(id));
            if (effectiveState === 'off' || effectiveState === 'shadow' || effectiveState === 'killed'
                || lane.killedReason !== null
                || controls.some(control => control.killedReason !== null)) return null;
            const eligibility = input.readEligibility(lease);
            if (!eligibility.allowed) return null;
            const safety = lease.mode === 'nsfw' ? input.safetyAuthority.readForLease(lease, turn) : null;
            if (lease.mode === 'nsfw' && (!safety || safety.sessionId !== lease.sessionId
                || safety.sourceRevision !== turn.sourceRevision || !safety.state.enabled
                || safety.state.reasonCode !== 'active' || safety.state.adultAttestation !== 'verified'
                || !safety.state.participantsAdult || safety.state.consent !== 'confirmed'
                || !Number.isSafeInteger(safety.state.revision) || safety.state.revision < 1
                || safety.state.sourceRevision !== turn.worldbookSourceRevision)) return null;
            return `sha256:${createHash('sha256').update(JSON.stringify({ turn, lane, controls, safety,
                eligibility, runtime })).digest('hex')}`;
        } catch { return null; }
    };
    return Object.freeze({
        authorizeDispatch,
        permissionSnapshot,
        executionClass(lane: AgentAdmissionLease['lane'], ticketSessionId: string): AgentClosureExecutionClass {
            const { decision } = decisionFor(lane, ticketSessionId, 0);
            if (!decision.allowed) return 'fixture';
            return decision.effectiveState === 'test-session' ? 'operational-replay' : 'production';
        },
        authority: {
            turnAuthority: input.turnAuthority, controlStore: input.controlStore,
            safetyAuthority: input.safetyAuthority,
            runtimeAuthority: {
                readForLease(lease: AgentAdmissionLease) {
                    const eligibility = input.readEligibility(lease);
                    const { runtime, decision } = decisionFor(lease.lane, lease.sessionId,
                        lease.quotaReservationDigest ? lease.limits.maxModelCalls : 0);
                    return {
                        revision: `sha256:${createHash('sha256')
                            .update(JSON.stringify([eligibility.revision, runtime, decision])).digest('hex')}`,
                        allowed: input.liveEnabled() && authorizeDispatch(lease) && decision.allowed,
                        grant: {
                            grantVersion: 'agent-skill-grant-v1' as const, tools: [], writableArtifactKinds: [],
                            maxRiskTier: 'advisory' as const, maxModelCalls: 0, maxToolCalls: 0,
                            maxInputTokens: 512, maxOutputTokens: 0
                        },
                        maxBodyTokens: 512, maxCompiledInstructionTokens: 512, maxValidatorOperations: 0, maxSkills: 1,
                    };
                }
            },
        },
    });
}
