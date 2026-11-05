/** @author Codex @date 2026-10-14 @version 1.0
 * Read current background permissions without mutating rollout or weakening legacy fallback.
 */
import { createHash } from 'node:crypto';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import { evaluateAgentTicketBeginPolicy } from '../agent-begin-policy.ts';
import { agentLaneRolloutBucketIdentity, type AgentLaneRuntimeConfig } from '../agent-lane-runtime-config.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import {
    createMaintenanceMemorySkillSourceAuthority,
    type MaintenanceMemorySkillContextDependencies,
} from './maintenance-memory-context.ts';

export function createMaintenanceMemorySkillHostAuthority(input: Pick<MaintenanceMemorySkillContextDependencies,
    'execution' | 'source' | 'jobAuthority' | 'sourceAuthority' | 'isSessionOpen' | 'safetyAuthority' | 'nowMs'> & {
        readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl' | 'evidence'>;
        readonly readLaneRuntime: () => AgentLaneRuntimeConfig;
        readonly readEligibility: (lease: AgentAdmissionLease) => { readonly allowed: boolean; readonly revision: string };
        readonly liveEnabled: () => boolean;
    }) {
    const sourceAuthority = createMaintenanceMemorySkillSourceAuthority(input);
    const decisionFor = (lease: AgentAdmissionLease) => {
        const runtime = input.readLaneRuntime();
        return {
            runtime, decision: evaluateAgentTicketBeginPolicy({
                lane: 'maintenance', sessionId: agentLaneRolloutBucketIdentity(runtime, lease.sessionId),
                desiredState: input.controlStore.get('maintenance').desiredState,
                hostCeiling: runtime.ceilings.maintenance, managed: runtime.managed,
                reservedModelCalls: lease.quotaReservationDigest ? lease.limits.maxModelCalls : 0,
                evidence: input.controlStore.evidence('maintenance'),
            })
        };
    };
    const authorizeDispatch = (lease: AgentAdmissionLease): boolean => {
        const eligibility = input.readEligibility(lease);
        const lane = input.controlStore.get('maintenance');
        const { runtime, decision } = decisionFor(lease);
        // Match Broker's legacy boundary: optional Skill readiness is not base execution permission.
        const baseAllowed = runtime.managed ? decision.allowed : !decision.shouldKill;
        return eligibility.allowed && lane.desiredState !== 'killed' && lane.killedReason === null
            && sourceAuthority.readForLease(lease) !== null && baseAllowed
            && agentCapabilitiesForAdmission(lease).every((id) => input.controlStore.capabilityControl(id).killedReason === null);
    };
    return Object.freeze({
        authorizeDispatch,
        authority: {
            ...input, sourceAuthority: input.sourceAuthority,
            runtimeAuthority: {
                readForLease(lease: AgentAdmissionLease) {
                    const eligibility = input.readEligibility(lease);
                    const { runtime, decision } = decisionFor(lease);
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
