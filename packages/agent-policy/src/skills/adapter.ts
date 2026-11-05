import {
  AGENT_SKILL_SELECTION_REQUEST_VERSION,
  agentSkillGrantViolations,
  normalizeAgentSkillCatalogSnapshot,
  normalizeAgentSkillExecutionGrant,
  normalizeAgentSkillSelectionRequest,
  type AgentSkillAdapter as SkillHubAgentSkillAdapter,
  type AgentSkillAdmissionV1,
  type AgentSkillCatalogSnapshotV1,
  type AgentSkillCandidateRefV1,
  type AgentSkillContentMode,
  type AgentSkillExecutionGrantV1,
  type AgentSkillPhase,
  type AgentSkillSelectionRequestV1,
  type AgentSkillTargetScopeV1,
  type AgentSkillVersionRefV1,
} from '@jiuguan/skill-hub';
import {
  normalizeAgentSkillConsumerProfile,
  type AgentSkillConsumerProfileV1,
} from './profile.ts';

export interface AgentSkillConsumerContextV1 {
  /** Optional narrowing for taskKinds that host multiple logical consumers. */
  readonly capabilityId?: string;
  readonly taskKind: string;
  readonly policyVersion?: string;
  readonly phase: AgentSkillPhase;
  readonly contentMode: AgentSkillContentMode;
  readonly scope: AgentSkillTargetScopeV1;
  /** Authoritative host grant. A consumer profile can only narrow it. */
  readonly grant: AgentSkillExecutionGrantV1;
  readonly budgetTokens: number;
  readonly maxSkills: number;
  readonly explicit: readonly AgentSkillVersionRefV1[];
  /** Sanitized body-free discovery evidence. Omission preserves compatibility selection. */
  readonly candidates?: readonly AgentSkillCandidateRefV1[];
}

/** SkillHub adapter plus an explicit, inspectable consumer profile and routing predicate. */
export interface AgentSkillAdapter<TContext = AgentSkillConsumerContextV1>
  extends SkillHubAgentSkillAdapter<TContext> {
  readonly profile: AgentSkillConsumerProfileV1;
  supports(context: TContext): boolean;
  buildSelectionRequest(
    context: TContext,
    catalog: AgentSkillCatalogSnapshotV1,
  ): AgentSkillSelectionRequestV1;
  validateAdmission(admission: AgentSkillAdmissionV1, context: TContext): void;
}

const RISK_ORDER = Object.freeze({ advisory: 0, proposal: 1, write: 2 } as const);

/** Checks only static dimensions; an unbound profile can still be displayed as a compatible consumer. */
export function agentSkillConsumerProfileMatches(
  profile: AgentSkillConsumerProfileV1,
  context: Pick<
    AgentSkillConsumerContextV1,
    'capabilityId' | 'taskKind' | 'policyVersion' | 'phase' | 'contentMode'
  >,
): boolean {
  const policyVersion = context.policyVersion ?? '';
  return (context.capabilityId === undefined || context.capabilityId === profile.capabilityId)
    && profile.taskKinds.includes(context.taskKind)
    && profile.phases.includes(context.phase)
    && profile.contentModes.includes(context.contentMode)
    && profile.policyVersionIncludes.every((token) => policyVersion.includes(token))
    && profile.policyVersionExcludes.every((token) => !policyVersion.includes(token));
}

/** Intersects the host's risk tier with profile metadata; every other authority field is preserved. */
export function narrowAgentSkillGrantToProfile(
  grantInput: AgentSkillExecutionGrantV1,
  profileInput: AgentSkillConsumerProfileV1,
): AgentSkillExecutionGrantV1 {
  const grant = normalizeAgentSkillExecutionGrant(grantInput);
  const profile = normalizeAgentSkillConsumerProfile(profileInput);
  const maxRiskTier = RISK_ORDER[grant.maxRiskTier] <= RISK_ORDER[profile.maxRiskTier]
    ? grant.maxRiskTier
    : profile.maxRiskTier;
  return normalizeAgentSkillExecutionGrant({ ...grant, maxRiskTier });
}

function validateAdmissionAgainstProfile(
  admission: AgentSkillAdmissionV1,
  context: AgentSkillConsumerContextV1,
  profile: AgentSkillConsumerProfileV1,
): void {
  if (!profile.runtimeBound || !agentSkillConsumerProfileMatches(profile, context)) {
    throw new Error(`Agent Skill admission does not match consumer profile: ${profile.profileId}`);
  }
  const effectiveGrant = narrowAgentSkillGrantToProfile(context.grant, profile);
  for (const skill of admission.skills) {
    const violations = agentSkillGrantViolations(skill.header, effectiveGrant);
    if (violations.length > 0) {
      throw new Error(`Agent Skill admission exceeds consumer profile: ${violations.join(', ')}`);
    }
  }
}

/** Creates a side-effect-free adapter from static profile data; it never mutates the catalog. */
export function createAgentSkillAdapter(
  profileInput: AgentSkillConsumerProfileV1,
): AgentSkillAdapter<AgentSkillConsumerContextV1> {
  const profile = normalizeAgentSkillConsumerProfile(profileInput);
  const capabilityIds = Object.freeze([profile.capabilityId]);
  return Object.freeze({
    adapterId: `consumer:${profile.profileId}`,
    capabilityIds,
    profile,
    supports(context: AgentSkillConsumerContextV1): boolean {
      return profile.runtimeBound && agentSkillConsumerProfileMatches(profile, context);
    },
    buildSelectionRequest(
      context: AgentSkillConsumerContextV1,
      catalogInput: AgentSkillCatalogSnapshotV1,
    ): AgentSkillSelectionRequestV1 {
      if (!profile.runtimeBound || !agentSkillConsumerProfileMatches(profile, context)) {
        throw new Error(`Agent Skill adapter does not support context: ${profile.profileId}`);
      }
      const catalog = normalizeAgentSkillCatalogSnapshot(catalogInput);
      return normalizeAgentSkillSelectionRequest({
        requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
        catalogRevision: catalog.catalogRevision,
        capabilityId: profile.capabilityId,
        taskKind: context.taskKind,
        phase: context.phase,
        contentMode: context.contentMode,
        scope: context.scope,
        grant: narrowAgentSkillGrantToProfile(context.grant, profile),
        budgetTokens: context.budgetTokens,
        maxSkills: context.maxSkills,
        explicit: context.explicit,
        ...(context.candidates === undefined ? {} : { candidates: context.candidates }),
      });
    },
    validateAdmission(admission: AgentSkillAdmissionV1, context: AgentSkillConsumerContextV1): void {
      validateAdmissionAgainstProfile(admission, context, profile);
    },
  });
}
