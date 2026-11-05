export const UNASSIGNED_SKILL_VALUE = 'unassigned';
export const LEGACY_REPOSITORY_VERSION = 'legacy-skill-list';

type UnknownRecord = Record<string, unknown>;

export interface AgentSkillRecord {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly immutable: boolean;
  readonly toggleable: boolean;
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly legacy: boolean;
  readonly role: string;
  readonly kind: string;
  readonly owner: string;
  readonly lifecycleStatus: string;
  readonly riskTier: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly agents: readonly string[];
  readonly domains: readonly string[];
  readonly contentModes: readonly string[];
  readonly consumers: readonly string[];
  readonly capabilityIds: readonly string[];
  readonly taskKinds: readonly string[];
  readonly phases: readonly string[];
  readonly scopeLevel: string;
  readonly keywords: readonly string[];
  readonly path: string;
  readonly isDefault: boolean;
  readonly nsfw: boolean;
}

export interface AgentSkillConsumer {
  readonly capabilityId: string;
  readonly displayName: string;
  readonly lane: string;
  /** Static wiring only; live availability/pause/validation belongs to the Agent control plane. */
  readonly runtimeBound: boolean;
  readonly skillCount: number;
  readonly activeSkillCount: number;
  readonly domains: readonly string[];
}

export interface AgentSkillCatalogStats {
  readonly total: number;
  readonly active: number;
  readonly candidate: number;
  readonly managed: number;
  readonly writeGuidance: number;
}

export interface AgentSkillRepository {
  readonly repositoryVersion: string;
  readonly catalogRevision: string;
  readonly skills: readonly AgentSkillRecord[];
  readonly consumers: readonly AgentSkillConsumer[];
  readonly reportedStats: AgentSkillCatalogStats | null;
  readonly legacyFallback: boolean;
}

export interface SkillRepositoryFilters {
  readonly search: string;
  readonly role: string;
  readonly agent: string;
  readonly domain: string;
  readonly kind: string;
  readonly status: string;
  readonly risk: string;
  readonly source: string;
  readonly contentMode: string;
  readonly consumer: string;
}

export interface SkillRepositoryStats {
  readonly total: number;
  readonly active: number;
  readonly candidate: number;
  readonly managed: number;
  readonly agents: number;
  readonly writeGuidance: number;
  readonly legacy: number;
}

export const EMPTY_SKILL_REPOSITORY_FILTERS: SkillRepositoryFilters = Object.freeze({
  search: '',
  role: 'all',
  agent: 'all',
  domain: 'all',
  kind: 'all',
  status: 'all',
  risk: 'all',
  source: 'all',
  contentMode: 'all',
  consumer: 'all',
});

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(source: UnknownRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return '';
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[,，|]/u) : [];
  return [...new Set(values.map(text).filter(Boolean))];
}

function firstList(source: UnknownRecord, keys: readonly string[]): string[] {
  for (const key of keys) {
    const values = stringList(source[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function withFallback(values: readonly string[]): readonly string[] {
  return values.length > 0 ? values : [UNASSIGNED_SKILL_VALUE];
}

function mergedSkill(rawValue: unknown): UnknownRecord {
  const raw = record(rawValue);
  const metadata = {
    ...record(raw.frontmatter),
    ...record(raw.header),
    ...record(raw.headers),
    ...record(raw.metadata),
  };
  return { ...metadata, ...raw };
}

function inferredKind(role: string): string {
  if (role === 'style') return 'style';
  if (role === 'tactical') return 'procedure';
  return 'legacy';
}

function inferredAgents(
  source: UnknownRecord,
  capabilityIds: readonly string[],
  consumerNames: ReadonlyMap<string, string>,
): readonly string[] {
  const explicit = firstList(source, ['agents', 'agentIds', 'agent_ids', 'agent']);
  if (explicit.length > 0) return explicit;
  const inferred = capabilityIds.map((capabilityId) => consumerNames.get(capabilityId)
      || capabilityId.split(/[.:/]/u)[0] || '')
    .map((value) => value.trim())
    .filter(Boolean);
  return withFallback([...new Set(inferred)]);
}

function normalizeSkill(
  rawValue: unknown,
  index: number,
  consumerNames: ReadonlyMap<string, string>,
): AgentSkillRecord | null {
  const source = mergedSkill(rawValue);
  const name = firstText(source, ['name', 'title']);
  const explicitId = firstText(source, ['skillId', 'skill_id', 'id']);
  if (!name && !explicitId) return null;
  const skillName = name || explicitId;
  const role = firstText(source, ['role']) || UNASSIGNED_SKILL_VALUE;
  const capabilityIds = firstList(source, ['capabilityIds', 'capability_ids', 'capabilities']);
  const taskKinds = firstList(source, ['taskKinds', 'task_kinds']);
  const phases = firstList(source, ['phases', 'phase']);
  const lifecycle = firstText(source, ['lifecycleStatus', 'lifecycle_status', 'lifecycle', 'status']);
  const enabled = bool(source.enabled, bool(source.active, lifecycle !== 'disabled'));
  const active = bool(source.active, enabled && (!lifecycle || lifecycle === 'active' || lifecycle === 'enabled'));
  const kind = firstText(source, ['kind', 'skillKind', 'skill_kind']) || inferredKind(role);
  const sourceType = firstText(source, ['sourceType', 'source_type'])
    || (firstText(source, ['source']) ? 'imported' : kind === 'legacy' ? 'legacy' : UNASSIGNED_SKILL_VALUE);
  const legacy = !firstText(source, ['skillId', 'skill_id'])
    && !firstText(source, ['kind', 'skillKind', 'skill_kind'])
    && !firstText(source, ['lifecycleStatus', 'lifecycle_status', 'riskTier', 'risk_tier']);
  const consumers = firstList(source, ['consumers', 'consumerIds', 'consumer_ids', 'consumer']);
  const explicitDomains = firstList(source, ['domains', 'domain']);
  const editable = bool(source.editable, !bool(source.immutable, bool(source.readOnly, false)));
  const deletable = bool(source.deletable, editable);
  // Historic responses used `editable` for both body edits and enable/disable. Preserve
  // that kill-switch behavior when the new explicit permission is absent; learned
  // user-layer Skills must not lose their kill switch during a rolling upgrade.
  const toggleable = bool(
    source.toggleable ?? source.canToggle ?? source.can_toggle,
    editable || sourceType === 'filesystem' || sourceType === 'imported' || sourceType === 'learned',
  );
  const immutable = bool(source.immutable, bool(source.readOnly, !editable && !deletable));

  return Object.freeze({
    skillId: explicitId || `legacy:${skillName || index}`,
    name: skillName,
    description: firstText(source, ['description', 'summary']),
    version: firstText(source, ['version']) || '1.0',
    enabled,
    active,
    immutable,
    toggleable,
    editable,
    deletable,
    legacy,
    role,
    kind,
    owner: firstText(source, ['owner']) || UNASSIGNED_SKILL_VALUE,
    lifecycleStatus: lifecycle || (enabled ? 'enabled' : 'disabled'),
    riskTier: firstText(source, ['riskTier', 'risk_tier', 'risk']) || UNASSIGNED_SKILL_VALUE,
    sourceType,
    sourceRef: firstText(source, ['source', 'sourceRef', 'source_ref']),
    agents: inferredAgents(source, capabilityIds, consumerNames),
    domains: withFallback(explicitDomains.length > 0 ? explicitDomains : taskKinds),
    contentModes: withFallback(firstList(source, ['contentModes', 'content_modes', 'contentMode', 'content_mode'])),
    consumers: withFallback(consumers.length > 0 ? consumers : capabilityIds),
    capabilityIds,
    taskKinds,
    phases,
    scopeLevel: firstText(source, ['scopeLevel', 'scope_level']) || UNASSIGNED_SKILL_VALUE,
    keywords: firstList(source, ['keywords', 'triggers']),
    path: firstText(source, ['path']),
    isDefault: bool(source.default, false),
    nsfw: bool(source.nsfw, false),
  });
}

function normalizeConsumers(value: unknown): readonly AgentSkillConsumer[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set<string>();
  const consumers: AgentSkillConsumer[] = [];
  for (const candidate of value) {
    const source = record(candidate);
    const capabilityId = firstText(source, ['capabilityId', 'capability_id', 'id']);
    if (!capabilityId || seen.has(capabilityId)) continue;
    seen.add(capabilityId);
    consumers.push(Object.freeze({
      capabilityId,
      displayName: firstText(source, ['displayName', 'display_name', 'name']) || capabilityId,
      lane: firstText(source, ['lane']) || UNASSIGNED_SKILL_VALUE,
      runtimeBound: bool(source.runtimeBound ?? source.runtime_bound, true),
      skillCount: count(source.skillCount ?? source.skill_count) ?? 0,
      activeSkillCount: count(source.activeSkillCount ?? source.active_skill_count) ?? 0,
      domains: Object.freeze(firstList(source, ['domains', 'domain'])),
    }));
  }
  return Object.freeze(consumers.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh')));
}

function normalizeReportedStats(value: unknown): AgentSkillCatalogStats | null {
  const source = record(value);
  const total = count(source.total);
  const active = count(source.active);
  const candidate = count(source.candidate);
  const managed = count(source.managed);
  const writeGuidance = count(source.writeGuidance ?? source.write_guidance
    ?? source.highRisk ?? source.high_risk ?? source.writeRisk ?? source.write_risk);
  if ([total, active, candidate, managed, writeGuidance].some((entry) => entry === null)) return null;
  return Object.freeze({
    total: total!, active: active!, candidate: candidate!, managed: managed!, writeGuidance: writeGuidance!,
  });
}

/** Normalize both the v1 repository response and the historic `{ skills: [...] }` list. */
export function normalizeAgentSkillRepository(payload: unknown): AgentSkillRepository {
  const root = record(payload);
  const consumers = normalizeConsumers(root.consumers);
  const consumerNames = new Map(consumers.map((consumer) => [consumer.capabilityId, consumer.displayName]));
  const rawSkills = Array.isArray(root.skills)
    ? root.skills
    : Array.isArray(root.items) ? root.items
      : Array.isArray(payload) ? payload : [];
  const repositoryVersion = firstText(root, ['repositoryVersion', 'repository_version', 'version'])
    || LEGACY_REPOSITORY_VERSION;
  const skills = rawSkills
    .map((skill, index) => normalizeSkill(skill, index, consumerNames))
    .filter((skill): skill is AgentSkillRecord => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh'));
  return Object.freeze({
    repositoryVersion,
    catalogRevision: firstText(root, ['catalogRevision', 'catalog_revision']),
    skills: Object.freeze(skills),
    consumers,
    reportedStats: normalizeReportedStats(root.stats),
    legacyFallback: repositoryVersion === LEGACY_REPOSITORY_VERSION,
  });
}

function contains(values: readonly string[], expected: string): boolean {
  return expected === 'all' || values.includes(expected);
}

export function filterAgentSkills(
  skills: readonly AgentSkillRecord[],
  filters: SkillRepositoryFilters,
): AgentSkillRecord[] {
  const query = filters.search.trim().toLocaleLowerCase('zh-CN');
  return skills.filter((skill) => {
    if (filters.role === 'style' && skill.role !== 'style' && skill.kind !== 'style') return false;
    if (filters.role === 'tactical' && skill.role !== 'tactical'
      && !['procedure', 'policy', 'validator'].includes(skill.kind)) return false;
    if (!contains(skill.agents, filters.agent)) return false;
    if (!contains(skill.domains, filters.domain)) return false;
    if (filters.kind !== 'all' && skill.kind !== filters.kind) return false;
    if (filters.status !== 'all' && skill.lifecycleStatus !== filters.status) return false;
    if (filters.risk !== 'all' && skill.riskTier !== filters.risk) return false;
    if (filters.source !== 'all' && skill.sourceType !== filters.source) return false;
    if (!contains(skill.contentModes, filters.contentMode)) return false;
    if (!contains(skill.consumers, filters.consumer)) return false;
    if (!query) return true;
    return [
      skill.skillId, skill.name, skill.description, skill.owner, skill.kind,
      skill.lifecycleStatus, skill.riskTier, skill.sourceType, skill.sourceRef,
      ...skill.agents, ...skill.domains, ...skill.consumers, ...skill.capabilityIds,
      ...skill.taskKinds, ...skill.phases, ...skill.keywords,
    ].join('\n').toLocaleLowerCase('zh-CN').includes(query);
  });
}

export function skillFilterValues(
  skills: readonly AgentSkillRecord[],
  field: 'agents' | 'domains' | 'kind' | 'lifecycleStatus' | 'riskTier' | 'sourceType' | 'contentModes' | 'consumers',
): string[] {
  const values = new Set<string>();
  for (const skill of skills) {
    const value = skill[field];
    if (Array.isArray(value)) value.forEach((entry) => values.add(entry));
    else values.add(value as string);
  }
  return [...values].filter(Boolean).sort((left, right) => left.localeCompare(right, 'zh'));
}

export function summarizeAgentSkills(skills: readonly AgentSkillRecord[]): SkillRepositoryStats {
  const agents = new Set(skills.flatMap((skill) => skill.agents)
    .filter((agent) => agent !== UNASSIGNED_SKILL_VALUE));
  return Object.freeze({
    total: skills.length,
    active: skills.filter((skill) => skill.enabled && skill.active).length,
    candidate: skills.filter((skill) => skill.lifecycleStatus === 'candidate').length,
    managed: skills.filter((skill) => skill.sourceType === 'managed' || skill.sourceType === 'learned').length,
    agents: agents.size,
    writeGuidance: skills.filter((skill) => skill.riskTier === 'write'
      || skill.riskTier === 'high' || skill.riskTier === 'critical').length,
    legacy: skills.filter((skill) => skill.legacy).length,
  });
}
