import { createHash } from 'node:crypto';
import { AGENT_SKILL_CONSUMER_PROFILE_BY_ID } from '../../packages/agent-policy/public/agent-skill-contract-index.ts';
import {
  AGENT_SUBCAPABILITY_IDS,
  AGENT_SKILL_CATALOG_VERSION,
  PUBLIC_AGENT_SKILL_KINDS,
  PUBLIC_AGENT_SKILL_LIFECYCLES,
  PUBLIC_AGENT_SKILL_OWNERS,
  PUBLIC_AGENT_SKILL_PHASES,
  PUBLIC_AGENT_SKILL_RISKS,
  PUBLIC_AGENT_SKILL_SOURCES,
  isPublicAgentSkillCatalog,
  type PublicAgentSkillCatalog,
  type PublicAgentSkillConsumerSummary,
  type PublicAgentSkillContentMode,
  type PublicAgentSkillKind,
  type PublicAgentSkillLifecycle,
  type PublicAgentSkillOwner,
  type PublicAgentSkillPhase,
  type PublicAgentSkillRisk,
  type PublicAgentSkillScopeLevel,
  type PublicAgentSkillSource,
  type PublicAgentSkillSummary,
} from '@jiuguan/mobile-contracts';

export interface LegacySkillRecord {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly keywords: readonly string[];
  readonly role?: string;
  readonly nsfw?: boolean;
  readonly source?: string;
  readonly conflictGroup?: string;
  readonly kind?: string;
  readonly owner?: string;
  readonly domain?: string;
  readonly capabilityIds?: readonly string[];
  readonly taskKinds?: readonly string[];
  readonly phases?: readonly string[];
  readonly contentModes?: readonly string[];
  readonly scopeLevel?: string;
  readonly risk?: string;
  readonly lifecycle?: string;
  readonly sourceType?: string;
  readonly evaluatorId?: string;
  readonly parentDigest?: string;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function legacySkillId(name: string): string {
  const hash = createHash('sha256').update(name.normalize('NFC'), 'utf8').digest('hex');
  return `skill:sha256:${hash}`;
}

function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function stableToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : fallback;
}

function boundedText(value: unknown, maximum: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function boundedStrings(
  value: readonly string[] | undefined,
  maximum: number,
  itemMaximum = 240,
): readonly string[] {
  return Object.freeze([...new Set((value ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= itemMaximum
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(entry)))]
    .slice(0, maximum)
    .sort((left, right) => left.localeCompare(right)));
}

function boundedTokens(value: readonly string[] | undefined, maximum: number): readonly string[] {
  return Object.freeze(boundedStrings(value, maximum).filter((entry) => TOKEN_RE.test(entry)));
}

function sourceType(skill: LegacySkillRecord): PublicAgentSkillSource {
  if (skill.sourceType && PUBLIC_AGENT_SKILL_SOURCES.includes(skill.sourceType as PublicAgentSkillSource)) {
    return skill.sourceType as PublicAgentSkillSource;
  }
  // Compatibility for headers written before the shared Skill Hub vocabulary landed.
  if (skill.sourceType === 'managed' || skill.source?.startsWith('learned-style:')) return 'learned';
  if (skill.sourceType === 'legacy') return 'filesystem';
  return 'filesystem';
}

function lifecycle(skill: LegacySkillRecord): PublicAgentSkillLifecycle {
  if (skill.lifecycle
    && PUBLIC_AGENT_SKILL_LIFECYCLES.includes(skill.lifecycle as PublicAgentSkillLifecycle)) {
    return skill.lifecycle as PublicAgentSkillLifecycle;
  }
  return skill.enabled ? 'active' : 'disabled';
}

function skillOwner(skill: LegacySkillRecord, source: PublicAgentSkillSource): PublicAgentSkillOwner {
  if (skill.owner && PUBLIC_AGENT_SKILL_OWNERS.includes(skill.owner as PublicAgentSkillOwner)) {
    return skill.owner as PublicAgentSkillOwner;
  }
  if (source === 'builtin') return 'host';
  if (source === 'learned') return 'learned';
  return 'author';
}

export interface AgentSkillMutationPermissions {
  readonly sourceType: PublicAgentSkillSource;
  readonly toggleable: boolean;
  readonly editable: boolean;
  readonly deletable: boolean;
}

/** Single authority used by both the public read model and the mutation endpoint. */
export function agentSkillMutationPermissions(
  skill: LegacySkillRecord,
): AgentSkillMutationPermissions {
  const normalizedSource = sourceType(skill);
  const userLayer = normalizedSource === 'filesystem' || normalizedSource === 'imported';
  return Object.freeze({
    sourceType: normalizedSource,
    // Learned Skills are immutable generated artifacts, but retain an operator kill switch.
    toggleable: userLayer || normalizedSource === 'learned',
    editable: userLayer,
    deletable: userLayer,
  });
}

function skillSummary(skill: LegacySkillRecord): PublicAgentSkillSummary {
  const permissions = agentSkillMutationPermissions(skill);
  const source = permissions.sourceType;
  const name = boundedText(skill.name, 240, '未命名 Skill');
  const phaseInputs = (skill.phases ?? []).map((phase) => phase === 'observe' ? 'learn' : phase);
  const phases = boundedStrings(phaseInputs, PUBLIC_AGENT_SKILL_PHASES.length)
    .filter((phase): phase is PublicAgentSkillPhase => (
      PUBLIC_AGENT_SKILL_PHASES.includes(phase as PublicAgentSkillPhase)
    ));
  const contentModes = boundedStrings(skill.contentModes, 2)
    .filter((mode): mode is PublicAgentSkillContentMode => mode === 'nsf' || mode === 'nsfw');
  const normalizedModes = contentModes.length > 0
    ? contentModes
    : skill.nsfw === true ? Object.freeze(['nsfw'] as const) : Object.freeze([]);
  const parentDigest = typeof skill.parentDigest === 'string' && DIGEST_RE.test(skill.parentDigest)
    ? skill.parentDigest
    : undefined;
  const conflictGroup = typeof skill.conflictGroup === 'string' && TOKEN_RE.test(skill.conflictGroup)
    ? skill.conflictGroup
    : undefined;
  const evaluatorId = typeof skill.evaluatorId === 'string' && TOKEN_RE.test(skill.evaluatorId)
    ? skill.evaluatorId
    : undefined;
  return Object.freeze({
    skillId: legacySkillId(skill.name),
    name,
    description: boundedText(skill.description, 4_096),
    version: boundedText(skill.version, 80, '1.0'),
    enabled: skill.enabled,
    kind: member<PublicAgentSkillKind>(
      skill.kind,
      PUBLIC_AGENT_SKILL_KINDS,
      skill.role === 'style' ? 'style' : 'procedure',
    ),
    owner: skillOwner(skill, source),
    domain: stableToken(skill.domain, skill.role === 'style' ? 'style' : 'general'),
    lifecycle: lifecycle(skill),
    risk: member<PublicAgentSkillRisk>(
      skill.risk === 'high' ? 'write' : skill.risk === 'medium' ? 'proposal' : skill.risk === 'low' ? 'advisory' : skill.risk,
      PUBLIC_AGENT_SKILL_RISKS,
      'advisory',
    ),
    sourceType: source,
    capabilityIds: boundedTokens(skill.capabilityIds, 32),
    taskKinds: boundedTokens(skill.taskKinds, 32),
    phases: Object.freeze(phases),
    contentModes: Object.freeze(normalizedModes),
    scopeLevel: member<PublicAgentSkillScopeLevel>(
      skill.scopeLevel,
      ['session', 'card', 'global', 'world'] as const,
      'global',
    ),
    keywords: boundedStrings(skill.keywords, 64, 120),
    toggleable: permissions.toggleable,
    editable: permissions.editable,
    deletable: permissions.deletable,
    ...(conflictGroup ? { conflictGroup } : {}),
    ...(evaluatorId ? { evaluatorId } : {}),
    ...(parentDigest ? { parentDigest } : {}),
  });
}

function capabilityLane(capabilityId: string): PublicAgentSkillConsumerSummary['lane'] {
  if (capabilityId.startsWith('learning.')) return 'learning';
  if (capabilityId.startsWith('maintenance.')) return 'maintenance';
  return 'interactive';
}

const CAPABILITY_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'interactive.prelude': '前厅编排',
  'interactive.director': '剧情导演',
  'interactive.critic': '提交前校验',
  'interactive.variableProposal': '变量提案',
  'interactive.aqlReplan': '质量重规划',
  'learning.preference': '偏好学习',
  'learning.branchPreference': '分支偏好学习',
  'learning.styleCompile': '文风学习',
  'maintenance.memory': '记忆维护',
  'maintenance.branchIndex': '剧情分支索引',
  'maintenance.arc': '剧情弧维护',
  'maintenance.npc': 'NPC 状态维护',
  'maintenance.worldbook': '世界书修正',
  'maintenance.nsfwScene': 'NSFW 场景策展',
  'context.compiler': '上下文编译',
});

function capabilityDisplayName(capabilityId: string): string {
  return CAPABILITY_DISPLAY_NAMES[capabilityId] ?? capabilityId.slice(0, 120);
}

function consumers(skills: readonly PublicAgentSkillSummary[]): readonly PublicAgentSkillConsumerSummary[] {
  const runtimeBoundIds = new Set<string>(AGENT_SUBCAPABILITY_IDS);
  // The deterministic host is runtime-bound without becoming a model subcapability.
  if (AGENT_SKILL_CONSUMER_PROFILE_BY_ID['maintenance.nsfwScene']?.runtimeBound) {
    runtimeBoundIds.add('maintenance.nsfwScene');
  }
  const ids = new Set<string>(runtimeBoundIds);
  ids.add('maintenance.nsfwScene');
  for (const skill of skills) skill.capabilityIds.forEach((id) => ids.add(id));
  return Object.freeze([...ids].sort((left, right) => left.localeCompare(right)).map((capabilityId) => {
    const attached = skills.filter((skill) => skill.capabilityIds.includes(capabilityId));
    return Object.freeze({
      capabilityId,
      displayName: capabilityDisplayName(capabilityId),
      lane: capabilityLane(capabilityId),
      runtimeBound: runtimeBoundIds.has(capabilityId),
      skillCount: attached.length,
      activeSkillCount: attached.filter((skill) => skill.enabled && skill.lifecycle === 'active').length,
      domains: Object.freeze([...new Set(attached.map((skill) => skill.domain))]
        .sort((left, right) => left.localeCompare(right))),
    });
  }));
}

/** Public header-only projection; Skill bodies and undeclared authority never enter this model. */
export function buildAgentSkillCatalog(skills: readonly LegacySkillRecord[]): PublicAgentSkillCatalog {
  const summaries = Object.freeze(skills.map(skillSummary)
    .sort((left, right) => left.skillId.localeCompare(right.skillId)));
  const consumerRows = consumers(summaries);
  const catalogRevision = `sha256:${createHash('sha256')
    .update(JSON.stringify({ skills: summaries, consumers: consumerRows }), 'utf8').digest('hex')}`;
  const catalog: PublicAgentSkillCatalog = Object.freeze({
    version: AGENT_SKILL_CATALOG_VERSION,
    catalogRevision,
    skills: summaries,
    consumers: consumerRows,
    stats: Object.freeze({
      total: summaries.length,
      active: summaries.filter((skill) => skill.enabled && skill.lifecycle === 'active').length,
      candidate: summaries.filter((skill) => skill.lifecycle === 'candidate').length,
      managed: summaries.filter((skill) => skill.sourceType === 'learned').length,
      writeGuidance: summaries.filter((skill) => skill.risk === 'write').length,
    }),
  });
  if (!isPublicAgentSkillCatalog(catalog)) {
    throw new TypeError('Agent Skill catalog projection violated its public contract');
  }
  return catalog;
}

export const buildAgentSkillRepositoryReadModel = buildAgentSkillCatalog;
