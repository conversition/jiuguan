import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_BODY_REQUEST_VERSION,
  AGENT_SKILL_PROGRAM_VERSION,
  computeAgentSkillBodyHash,
  createAgentSkillCatalogSnapshot,
  createAgentSkillHeader,
  exactAgentSkillTokens,
  type AgentSkillCatalogPort,
  type AgentSkillBodyRequestV1,
  type AgentSkillPhase,
} from '@jiuguan/skill-hub';
import {
  SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION,
  createServerAgentSkillProfilePolicyRegistry,
} from './profile-policy-registry.ts';
import {
  SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION,
  createServerAgentSkillSourceAuthorityRegistry,
} from './source-authority-registry.ts';

export const SERVER_BUILTIN_AGENT_SKILL_RELEASE = 'host-context-foundation-v1.0.0' as const;

// This is an audited host-code allowlist, not an auto-discovered manifest or writable asset file.
const CONSUMERS: readonly Readonly<{
  profileId: string;
  tasks: readonly string[];
  phase: AgentSkillPhase;
  contentModes?: readonly ('nsf' | 'nsfw')[];
}>[] = Object.freeze([
  { profileId: 'interactive.prelude', tasks: ['interactive_prelude'], phase: 'plan' },
  { profileId: 'interactive.director', tasks: ['interactive_prelude'], phase: 'plan' },
  { profileId: 'interactive.critic', tasks: ['critic_revision'], phase: 'validate' },
  { profileId: 'interactive.aqlReplan', tasks: ['aql_replan'], phase: 'plan' },
  { profileId: 'interactive.variableProposal', tasks: ['interactive_prelude'], phase: 'execute' },
  { profileId: 'context.compiler', tasks: ['context_compiler'], phase: 'plan' },
  { profileId: 'learning.preference', tasks: ['preference_extract'], phase: 'learn' },
  { profileId: 'learning.branchPreference', tasks: ['preference_extract'], phase: 'learn' },
  { profileId: 'learning.styleCompile', tasks: ['style_compile'], phase: 'learn' },
  { profileId: 'maintenance.memory', tasks: ['memory_consolidation', 'rolling_summary'], phase: 'execute' },
  { profileId: 'maintenance.branchIndex', tasks: ['branch_index'], phase: 'execute' },
  { profileId: 'maintenance.arc', tasks: ['branch_index', 'arc_maintenance'], phase: 'execute' },
  { profileId: 'maintenance.npc', tasks: ['npc_state', 'npc_maintenance'], phase: 'execute' },
  { profileId: 'maintenance.worldbook', tasks: ['worldbook_repair'], phase: 'execute' },
  { profileId: 'maintenance.nsfwScene', tasks: ['nsfw_scene_curator'], phase: 'plan', contentModes: ['nsfw'] },
]);

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Trust is issued only from this release's host-code definitions; there are no caller inputs or IO.
 * The single foundation preserves host facts and leaves every output contract/tool/write decision
 * with the existing Agent. Constructing the pack neither enables a lane nor grants a Lease purpose.
 */
export function createServerBuiltinAgentSkillPack() {
  return createBuiltinPack(CONSUMERS);
}

/** Foundation for the existing conversation style slot; creates no Agent registration or execution authority. */
export function createServerConversationStyleFoundationPack() {
  return createBuiltinPack([{ profileId: 'style.compose', tasks: ['conversation-turn'], phase: 'execute', contentModes: ['nsf'] }]);
}

function createBuiltinPack(consumers: typeof CONSUMERS) {
  const body = JSON.stringify({
    kind: 'foundation',
    operations: [{ args: { profileId: 'memory-first.v1' }, primitiveId: 'foundation.context-priority' }],
    programVersion: AGENT_SKILL_PROGRAM_VERSION,
  });
  const headers = consumers.map((consumer) => {
    const seed = createAgentSkillHeader({
    manifestVersion: 'agent-skill-manifest-v1',
    skillId: `host.foundation.${consumer.profileId}`,
    version: '1.0.0',
    name: 'Host committed-context foundation',
    description: 'Use committed host context before optional narrative context.',
    kind: 'foundation', owner: 'host',
    capabilityIds: [consumer.profileId], taskKinds: consumer.tasks, phases: [consumer.phase],
    contentModes: consumer.contentModes ?? ['nsf', 'nsfw'], scope: { kind: 'global' }, riskTier: 'advisory',
    artifactKind: 'agent.host-context-foundation', requires: [], conflictsWith: [],
    desiredTools: [], writableArtifactKinds: [],
    limits: { maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
    inputSchemaDigest: digest(['host-supplied-context', 1]),
    outputSchemaDigest: digest(['host-owned-output-contract', 1]),
    bodyHash: computeAgentSkillBodyHash(body), bodyTokens: exactAgentSkillTokens(body),
    sourceType: 'builtin',
    sourceHash: digest([SERVER_BUILTIN_AGENT_SKILL_RELEASE, consumer.profileId, consumer.tasks, consumer.phase, body]),
    sourceRevision: SERVER_BUILTIN_AGENT_SKILL_RELEASE,
    provenanceDigest: digest(['host-code', SERVER_BUILTIN_AGENT_SKILL_RELEASE, consumer.profileId]),
    evaluatorId: 'evaluator.host-context-foundation-v1', autoPromotion: false, priority: 1_000,
    });
    return createAgentSkillHeader({
      ...seed.manifest,
      version: `1.0.0+${seed.manifestDigest.slice('sha256:'.length)}`,
    });
  });
  const catalog = createAgentSkillCatalogSnapshot(headers);
  const byManifest = new Map(catalog.headers.map((header) => [header.manifestDigest, header]));
  const catalogPort: AgentSkillCatalogPort = Object.freeze({
    async readCatalog() { return catalog; },
    async loadBody(request: AgentSkillBodyRequestV1) {
      const header = byManifest.get(request.manifestDigest);
      if (request.requestVersion !== AGENT_SKILL_BODY_REQUEST_VERSION
        || request.catalogRevision !== catalog.catalogRevision || !header
        || request.skillId !== header.manifest.skillId || request.version !== header.manifest.version
        || request.bodyHash !== header.manifest.bodyHash) {
        throw new Error('agent-skill-catalog-revision-stale');
      }
      return body;
    },
  });
  const sourceAuthority = createServerAgentSkillSourceAuthorityRegistry({
    snapshotVersion: SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION,
    entries: catalog.headers.map(({ manifest: item, manifestDigest }) => ({
      skillId: item.skillId, version: item.version, manifestDigest,
      bodyHash: item.bodyHash, sourceHash: item.sourceHash, sourceRevision: item.sourceRevision,
      trustClass: 'host-builtin',
      evidenceDigest: digest(['host-code-release', SERVER_BUILTIN_AGENT_SKILL_RELEASE, manifestDigest]),
    })),
  });
  const profileRegistry = createServerAgentSkillProfilePolicyRegistry(catalog.headers.map(({ manifest, manifestDigest }) => ({
    policyVersion: SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION,
    profileId: manifest.capabilityIds[0],
    familyRules: [{
      familyId: 'skill.foundation', allowAutoPromotion: false,
      allowedContracts: [{
        kind: manifest.kind, artifactKind: manifest.artifactKind,
        inputSchemaDigest: manifest.inputSchemaDigest, outputSchemaDigest: manifest.outputSchemaDigest,
        evaluatorId: manifest.evaluatorId, owner: manifest.owner, sourceType: manifest.sourceType,
      }],
    }],
    enrollments: [{ familyId: 'skill.foundation', skillId: manifest.skillId,
      version: manifest.version, manifestDigest, required: true }],
    maxSkills: 1, maxInstructionTokens: 512,
    executionCeiling: { maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 512, maxOutputTokens: 0 },
    maxRiskTier: 'advisory', allowedTools: [], allowedWritableArtifactKinds: [],
  })));
  return Object.freeze({
    release: SERVER_BUILTIN_AGENT_SKILL_RELEASE,
    catalogPort, sourceAuthority, profileRegistry,
  });
}
