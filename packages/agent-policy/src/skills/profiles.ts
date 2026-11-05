import {
  AGENT_SKILL_CONSUMER_PROFILE_VERSION,
  normalizeAgentSkillConsumerProfile,
  type AgentSkillConsumerProfileV1,
  type AgentSkillFamilyId,
} from './profile.ts';

const BOTH_CONTENT_MODES = ['nsf', 'nsfw'] as const;

function profile(input: Readonly<{
  capabilityId: string;
  taskKinds: readonly string[];
  phases: AgentSkillConsumerProfileV1['phases'];
  contentModes?: AgentSkillConsumerProfileV1['contentModes'];
  maxRiskTier: AgentSkillConsumerProfileV1['maxRiskTier'];
  families?: readonly AgentSkillFamilyId[];
  policyVersionIncludes?: readonly string[];
  policyVersionExcludes?: readonly string[];
  runtimeBound?: boolean;
}>): AgentSkillConsumerProfileV1 {
  return normalizeAgentSkillConsumerProfile({
    profileVersion: AGENT_SKILL_CONSUMER_PROFILE_VERSION,
    profileId: input.capabilityId,
    capabilityId: input.capabilityId,
    taskKinds: input.taskKinds,
    phases: input.phases,
    contentModes: input.contentModes ?? BOTH_CONTENT_MODES,
    maxRiskTier: input.maxRiskTier,
    pinnedFamilies: ['skill.foundation', ...(input.families ?? [])],
    policyVersionIncludes: input.policyVersionIncludes ?? [],
    policyVersionExcludes: input.policyVersionExcludes ?? [],
    runtimeBound: input.runtimeBound ?? true,
  });
}

export const INTERACTIVE_PRELUDE_SKILL_PROFILE = profile({
  capabilityId: 'interactive.prelude',
  taskKinds: ['interactive_prelude'],
  phases: ['plan'],
  maxRiskTier: 'advisory',
  families: ['story.development'],
});

export const INTERACTIVE_DIRECTOR_SKILL_PROFILE = profile({
  capabilityId: 'interactive.director',
  taskKinds: ['interactive_prelude'],
  phases: ['plan'],
  maxRiskTier: 'advisory',
  families: ['story.development'],
});

export const INTERACTIVE_CRITIC_SKILL_PROFILE = profile({
  capabilityId: 'interactive.critic',
  taskKinds: ['critic_revision'],
  phases: ['validate'],
  maxRiskTier: 'advisory',
  families: ['quality.critic'],
});

export const INTERACTIVE_AQL_REPLAN_SKILL_PROFILE = profile({
  capabilityId: 'interactive.aqlReplan',
  taskKinds: ['aql_replan'],
  phases: ['plan'],
  maxRiskTier: 'advisory',
  families: ['context.recovery'],
});

export const INTERACTIVE_VARIABLE_PROPOSAL_SKILL_PROFILE = profile({
  capabilityId: 'interactive.variableProposal',
  taskKinds: ['interactive_prelude'],
  phases: ['execute'],
  maxRiskTier: 'proposal',
});

export const CONTEXT_COMPILER_SKILL_PROFILE = profile({
  capabilityId: 'context.compiler',
  taskKinds: ['context_compiler'],
  phases: ['plan'],
  maxRiskTier: 'advisory',
  families: ['context.recovery'],
});

export const LEARNING_PREFERENCE_SKILL_PROFILE = profile({
  capabilityId: 'learning.preference',
  taskKinds: ['preference_extract'],
  phases: ['learn'],
  maxRiskTier: 'proposal',
  families: ['preference.prompt'],
  policyVersionExcludes: ['branch-semantic'],
});

export const LEARNING_BRANCH_PREFERENCE_SKILL_PROFILE = profile({
  capabilityId: 'learning.branchPreference',
  taskKinds: ['preference_extract'],
  phases: ['learn'],
  maxRiskTier: 'proposal',
  families: ['story.development'],
  policyVersionIncludes: ['branch-semantic'],
});

export const LEARNING_STYLE_COMPILE_SKILL_PROFILE = profile({
  capabilityId: 'learning.styleCompile',
  taskKinds: ['style_compile'],
  phases: ['learn'],
  maxRiskTier: 'proposal',
  families: ['style.rendering'],
});

export const MAINTENANCE_MEMORY_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.memory',
  taskKinds: ['memory_consolidation', 'rolling_summary'],
  phases: ['execute'],
  maxRiskTier: 'proposal',
  families: ['memory.consolidation'],
});

export const MAINTENANCE_BRANCH_INDEX_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.branchIndex',
  taskKinds: ['branch_index'],
  phases: ['execute'],
  maxRiskTier: 'proposal',
  families: ['arc.governance'],
});

export const MAINTENANCE_ARC_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.arc',
  taskKinds: ['branch_index', 'arc_maintenance'],
  phases: ['execute'],
  maxRiskTier: 'proposal',
  families: ['arc.governance'],
});

export const MAINTENANCE_NPC_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.npc',
  taskKinds: ['npc_state', 'npc_maintenance'],
  phases: ['execute'],
  maxRiskTier: 'proposal',
  families: ['npc.state'],
});

export const MAINTENANCE_WORLDBOOK_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.worldbook',
  taskKinds: ['worldbook_repair'],
  phases: ['execute'],
  // This is only a ceiling. The adapter intersects it with the authoritative host grant.
  maxRiskTier: 'write',
  families: ['worldbook.repair'],
});

export const MAINTENANCE_NSFW_SCENE_SKILL_PROFILE = profile({
  capabilityId: 'maintenance.nsfwScene',
  taskKinds: ['nsfw_scene_curator'],
  phases: ['plan'],
  contentModes: ['nsfw'],
  maxRiskTier: 'proposal',
  families: ['nsfw.scene'],
  // Host-guarded deterministic curation; this is not a Broker/model task registration.
  runtimeBound: true,
});

export const AGENT_SKILL_CONSUMER_PROFILES: readonly AgentSkillConsumerProfileV1[] = Object.freeze([
  INTERACTIVE_PRELUDE_SKILL_PROFILE,
  INTERACTIVE_DIRECTOR_SKILL_PROFILE,
  INTERACTIVE_CRITIC_SKILL_PROFILE,
  INTERACTIVE_AQL_REPLAN_SKILL_PROFILE,
  INTERACTIVE_VARIABLE_PROPOSAL_SKILL_PROFILE,
  CONTEXT_COMPILER_SKILL_PROFILE,
  LEARNING_PREFERENCE_SKILL_PROFILE,
  LEARNING_BRANCH_PREFERENCE_SKILL_PROFILE,
  LEARNING_STYLE_COMPILE_SKILL_PROFILE,
  MAINTENANCE_MEMORY_SKILL_PROFILE,
  MAINTENANCE_BRANCH_INDEX_SKILL_PROFILE,
  MAINTENANCE_ARC_SKILL_PROFILE,
  MAINTENANCE_NPC_SKILL_PROFILE,
  MAINTENANCE_WORLDBOOK_SKILL_PROFILE,
  MAINTENANCE_NSFW_SCENE_SKILL_PROFILE,
]);

export const AGENT_SKILL_CONSUMER_PROFILE_BY_ID: Readonly<Record<string, AgentSkillConsumerProfileV1>> =
  Object.freeze(Object.fromEntries(AGENT_SKILL_CONSUMER_PROFILES.map((item) => [item.profileId, item])));
