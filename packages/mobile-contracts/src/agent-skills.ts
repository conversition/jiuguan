/** Content-free public read model for the shared Agent Skill catalog. */
export const AGENT_SKILL_CATALOG_VERSION = 'agent-skill-catalog-v1' as const;

export const PUBLIC_AGENT_SKILL_KINDS = Object.freeze([
  'foundation', 'policy', 'procedure', 'style', 'validator',
] as const);
export type PublicAgentSkillKind = typeof PUBLIC_AGENT_SKILL_KINDS[number];

export const PUBLIC_AGENT_SKILL_OWNERS = Object.freeze(['host', 'author', 'learned'] as const);
export type PublicAgentSkillOwner = typeof PUBLIC_AGENT_SKILL_OWNERS[number];

export const PUBLIC_AGENT_SKILL_RISKS = Object.freeze(['advisory', 'proposal', 'write'] as const);
export type PublicAgentSkillRisk = typeof PUBLIC_AGENT_SKILL_RISKS[number];

export const PUBLIC_AGENT_SKILL_LIFECYCLES = Object.freeze([
  'candidate', 'validated', 'replay-passed', 'shadow',
  'canary-5', 'canary-25', 'canary-50', 'active',
  'disabled', 'retired', 'rejected', 'killed', 'quarantined', 'rolled-back',
] as const);
export type PublicAgentSkillLifecycle = typeof PUBLIC_AGENT_SKILL_LIFECYCLES[number];

export const PUBLIC_AGENT_SKILL_SOURCES = Object.freeze([
  'builtin', 'filesystem', 'imported', 'learned',
] as const);
export type PublicAgentSkillSource = typeof PUBLIC_AGENT_SKILL_SOURCES[number];

export const PUBLIC_AGENT_SKILL_PHASES = Object.freeze([
  'plan', 'execute', 'validate', 'learn',
] as const);
export type PublicAgentSkillPhase = typeof PUBLIC_AGENT_SKILL_PHASES[number];

export type PublicAgentSkillContentMode = 'nsf' | 'nsfw';
export type PublicAgentSkillScopeLevel = 'session' | 'card' | 'global' | 'world';

export interface PublicAgentSkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly kind: PublicAgentSkillKind;
  readonly owner: PublicAgentSkillOwner;
  readonly domain: string;
  readonly lifecycle: PublicAgentSkillLifecycle;
  readonly risk: PublicAgentSkillRisk;
  readonly sourceType: PublicAgentSkillSource;
  readonly capabilityIds: readonly string[];
  readonly taskKinds: readonly string[];
  readonly phases: readonly PublicAgentSkillPhase[];
  readonly contentModes: readonly PublicAgentSkillContentMode[];
  readonly scopeLevel: PublicAgentSkillScopeLevel;
  readonly keywords: readonly string[];
  /** Whether the user-facing kill switch may enable/disable this Skill. */
  readonly toggleable: boolean;
  /** Whether the Skill body/metadata may be edited. Independent from the kill switch. */
  readonly editable: boolean;
  /** Whether this Skill may be permanently deleted. Independent from the kill switch. */
  readonly deletable: boolean;
  readonly conflictGroup?: string;
  readonly evaluatorId?: string;
  readonly parentDigest?: string;
}

export interface PublicAgentSkillConsumerSummary {
  readonly capabilityId: string;
  readonly displayName: string;
  readonly lane: 'interactive' | 'learning' | 'maintenance';
  /** Static wiring fact: this consumer has an invocation/admission binding in the host. */
  readonly runtimeBound: boolean;
  readonly skillCount: number;
  readonly activeSkillCount: number;
  readonly domains: readonly string[];
}

export interface PublicAgentSkillCatalogStats {
  readonly total: number;
  readonly active: number;
  readonly candidate: number;
  readonly managed: number;
  readonly writeGuidance: number;
}

export interface PublicAgentSkillCatalog {
  readonly version: typeof AGENT_SKILL_CATALOG_VERSION;
  /** Digest of public headers, active pointers and consumer bindings; never includes Skill bodies. */
  readonly catalogRevision: string;
  readonly skills: readonly PublicAgentSkillSummary[];
  readonly consumers: readonly PublicAgentSkillConsumerSummary[];
  readonly stats: PublicAgentSkillCatalogStats;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SKILL_KEYS = new Set<keyof PublicAgentSkillSummary>([
  'skillId', 'name', 'description', 'version', 'enabled', 'kind', 'owner', 'domain', 'lifecycle',
  'risk', 'sourceType', 'capabilityIds', 'taskKinds', 'phases', 'contentModes', 'scopeLevel',
  'keywords', 'toggleable', 'editable', 'deletable', 'conflictGroup', 'evaluatorId', 'parentDigest',
]);
const CONSUMER_KEYS = new Set<keyof PublicAgentSkillConsumerSummary>([
  'capabilityId', 'displayName', 'lane', 'runtimeBound', 'skillCount', 'activeSkillCount', 'domains',
]);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function strings(value: unknown, maximum: number, itemMaximum = 240): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((item) => boundedString(item, itemMaximum))
    && new Set(value).size === value.length;
}

function tokens(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every(token) && new Set(value).size === value.length;
}

function members<T extends string>(value: unknown, allowed: readonly T[], maximum: number): value is readonly T[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((item) => allowed.includes(item as T))
    && new Set(value).size === value.length;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPublicAgentSkillSummary(value: unknown): value is PublicAgentSkillSummary {
  if (!record(value) || !exactKeys(value, SKILL_KEYS)) return false;
  return token(value.skillId)
    && boundedString(value.name, 240)
    && boundedString(value.description, 4_096, true)
    && boundedString(value.version, 80)
    && typeof value.enabled === 'boolean'
    && PUBLIC_AGENT_SKILL_KINDS.includes(value.kind as PublicAgentSkillKind)
    && PUBLIC_AGENT_SKILL_OWNERS.includes(value.owner as PublicAgentSkillOwner)
    && token(value.domain)
    && PUBLIC_AGENT_SKILL_LIFECYCLES.includes(value.lifecycle as PublicAgentSkillLifecycle)
    && PUBLIC_AGENT_SKILL_RISKS.includes(value.risk as PublicAgentSkillRisk)
    && PUBLIC_AGENT_SKILL_SOURCES.includes(value.sourceType as PublicAgentSkillSource)
    && tokens(value.capabilityIds, 32)
    && tokens(value.taskKinds, 32)
    && members(value.phases, PUBLIC_AGENT_SKILL_PHASES, 4)
    && members(value.contentModes, ['nsf', 'nsfw'] as const, 2)
    && ['session', 'card', 'global', 'world'].includes(String(value.scopeLevel))
    && strings(value.keywords, 64, 120)
    && typeof value.toggleable === 'boolean'
    && typeof value.editable === 'boolean'
    && typeof value.deletable === 'boolean'
    && (value.conflictGroup === undefined || token(value.conflictGroup))
    && (value.evaluatorId === undefined || token(value.evaluatorId))
    && (value.parentDigest === undefined || (typeof value.parentDigest === 'string' && DIGEST_RE.test(value.parentDigest)));
}

export function isPublicAgentSkillCatalog(value: unknown): value is PublicAgentSkillCatalog {
  if (!record(value) || !exactKeys(value, new Set(['version', 'catalogRevision', 'skills', 'consumers', 'stats']))) {
    return false;
  }
  if (value.version !== AGENT_SKILL_CATALOG_VERSION
    || typeof value.catalogRevision !== 'string' || !DIGEST_RE.test(value.catalogRevision)
    || !Array.isArray(value.skills) || value.skills.length > 10_000
    || !value.skills.every(isPublicAgentSkillSummary)
    || new Set(value.skills.map((skill) => skill.skillId)).size !== value.skills.length
    || !Array.isArray(value.consumers) || value.consumers.length > 256) return false;
  const consumersValid = value.consumers.every((consumer) => record(consumer)
    && exactKeys(consumer, CONSUMER_KEYS)
    && token(consumer.capabilityId)
    && boundedString(consumer.displayName, 120)
    && ['interactive', 'learning', 'maintenance'].includes(String(consumer.lane))
    && typeof consumer.runtimeBound === 'boolean'
    && safeCount(consumer.skillCount)
    && safeCount(consumer.activeSkillCount)
    && (consumer.activeSkillCount as number) <= (consumer.skillCount as number)
    && tokens(consumer.domains, 64));
  if (!consumersValid || new Set(value.consumers.map((row) => row.capabilityId)).size !== value.consumers.length) {
    return false;
  }
  const stats = value.stats;
  if (!record(stats) || !exactKeys(stats, new Set([
    'total', 'active', 'candidate', 'managed', 'writeGuidance',
  ]))) return false;
  const counts = ['total', 'active', 'candidate', 'managed', 'writeGuidance']
    .map((key) => stats[key]);
  return counts.every(safeCount)
    && stats.total === value.skills.length
    && (stats.active as number) <= (stats.total as number)
    && (stats.candidate as number) <= (stats.total as number)
    && (stats.managed as number) <= (stats.total as number)
    && (stats.writeGuidance as number) <= (stats.total as number);
}
