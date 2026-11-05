import {
  AGENT_SKILL_CONTENT_MODES,
  AGENT_SKILL_PHASES,
  AGENT_SKILL_RISK_TIERS,
  type AgentSkillContentMode,
  type AgentSkillPhase,
  type AgentSkillRiskTier,
} from '@jiuguan/skill-hub';

export const AGENT_SKILL_CONSUMER_PROFILE_VERSION = 'agent-skill-consumer-profile-v1' as const;

export const AGENT_SKILL_FAMILY_IDS = Object.freeze([
  'skill.foundation',
  'story.development',
  'quality.critic',
  'context.recovery',
  'preference.prompt',
  'style.rendering',
  'memory.consolidation',
  'arc.governance',
  'npc.state',
  'worldbook.repair',
  'nsfw.scene',
] as const);

export type AgentSkillFamilyId = typeof AGENT_SKILL_FAMILY_IDS[number];

/**
 * Static metadata describing one logical Agent consumer of the shared Skill catalog.
 *
 * `maxRiskTier` and `pinnedFamilies` are selection constraints and display metadata only. They
 * never grant tools, writable artifact kinds, model calls, or write authority. Runtime authority
 * remains exclusively in the host-provided AgentSkillExecutionGrantV1.
 */
export interface AgentSkillConsumerProfileV1 {
  readonly profileVersion: typeof AGENT_SKILL_CONSUMER_PROFILE_VERSION;
  readonly profileId: string;
  readonly capabilityId: string;
  readonly taskKinds: readonly string[];
  readonly phases: readonly AgentSkillPhase[];
  readonly contentModes: readonly AgentSkillContentMode[];
  readonly maxRiskTier: AgentSkillRiskTier;
  readonly pinnedFamilies: readonly AgentSkillFamilyId[];
  /** Static compatibility qualifier for shared legacy taskKinds (for example branch-semantic). */
  readonly policyVersionIncludes: readonly string[];
  readonly policyVersionExcludes: readonly string[];
  /** False means repository-visible metadata exists, but no admission/runtime binding is claimed. */
  readonly runtimeBound: boolean;
}

const PROFILE_KEYS = new Set([
  'profileVersion', 'profileId', 'capabilityId', 'taskKinds', 'phases', 'contentModes',
  'maxRiskTier', 'pinnedFamilies', 'policyVersionIncludes', 'policyVersionExcludes', 'runtimeBound',
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new TypeError(`${label} must be a stable token`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenSet(value: unknown, label: string, minimum = 1): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) {
    throw new TypeError(`${label} must be an array with ${minimum === 0 ? 'at most' : 'between 1 and'} 64 items`);
  }
  const normalized = value.map((item, index) => token(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(normalized.sort(compareText));
}

function enumSet<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): readonly T[number][] {
  const normalized = tokenSet(value, label);
  if (normalized.some((item) => !allowed.includes(item as T[number]))) {
    throw new TypeError(`${label} contains an unsupported value`);
  }
  return normalized as readonly T[number][];
}

/** Strict, deterministic normalization for user-independent consumer metadata. */
export function normalizeAgentSkillConsumerProfile(input: unknown): AgentSkillConsumerProfileV1 {
  plainRecord(input, 'agentSkillConsumerProfile');
  const keys = Object.keys(input);
  const unsupported = keys.find((key) => !PROFILE_KEYS.has(key));
  if (unsupported !== undefined) {
    throw new TypeError(`agentSkillConsumerProfile contains unsupported field: ${unsupported}`);
  }
  const missing = [...PROFILE_KEYS].find((key) => !(key in input));
  if (missing !== undefined) throw new TypeError(`agentSkillConsumerProfile.${missing} is required`);
  if (input.profileVersion !== AGENT_SKILL_CONSUMER_PROFILE_VERSION) {
    throw new TypeError(`agentSkillConsumerProfile.profileVersion must be ${AGENT_SKILL_CONSUMER_PROFILE_VERSION}`);
  }
  if (typeof input.runtimeBound !== 'boolean') {
    throw new TypeError('agentSkillConsumerProfile.runtimeBound must be a boolean');
  }
  const pinnedFamilies = enumSet(
    input.pinnedFamilies,
    AGENT_SKILL_FAMILY_IDS,
    'agentSkillConsumerProfile.pinnedFamilies',
  );
  if (!pinnedFamilies.includes('skill.foundation')) {
    throw new TypeError('agentSkillConsumerProfile.pinnedFamilies must include skill.foundation');
  }
  const policyVersionIncludes = tokenSet(
    input.policyVersionIncludes,
    'agentSkillConsumerProfile.policyVersionIncludes',
    0,
  );
  const policyVersionExcludes = tokenSet(
    input.policyVersionExcludes,
    'agentSkillConsumerProfile.policyVersionExcludes',
    0,
  );
  if (policyVersionIncludes.some((value) => policyVersionExcludes.includes(value))) {
    throw new TypeError('agentSkillConsumerProfile policy version qualifiers must not overlap');
  }
  const profile = {
    profileVersion: AGENT_SKILL_CONSUMER_PROFILE_VERSION,
    profileId: token(input.profileId, 'agentSkillConsumerProfile.profileId'),
    capabilityId: token(input.capabilityId, 'agentSkillConsumerProfile.capabilityId'),
    taskKinds: tokenSet(input.taskKinds, 'agentSkillConsumerProfile.taskKinds'),
    phases: enumSet(input.phases, AGENT_SKILL_PHASES, 'agentSkillConsumerProfile.phases'),
    contentModes: enumSet(
      input.contentModes,
      AGENT_SKILL_CONTENT_MODES,
      'agentSkillConsumerProfile.contentModes',
    ),
    maxRiskTier: (() => {
      const value = token(input.maxRiskTier, 'agentSkillConsumerProfile.maxRiskTier');
      if (!AGENT_SKILL_RISK_TIERS.includes(value as AgentSkillRiskTier)) {
        throw new TypeError('agentSkillConsumerProfile.maxRiskTier contains an unsupported value');
      }
      return value as AgentSkillRiskTier;
    })(),
    pinnedFamilies: pinnedFamilies as readonly AgentSkillFamilyId[],
    policyVersionIncludes,
    policyVersionExcludes,
    runtimeBound: input.runtimeBound,
  } satisfies AgentSkillConsumerProfileV1;
  return Object.freeze(profile);
}
