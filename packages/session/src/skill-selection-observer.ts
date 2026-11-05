export const SKILL_SELECTION_OBSERVATION_VERSION = 'session-skill-selection-observation-v2' as const;

export interface SkillSelectionCandidateObservationV2 {
  readonly skillId: string;
  readonly sourceVersion: string;
  readonly bodyHash: string;
  readonly documentIdentityDigest: string;
  readonly scoreBps: number;
  readonly reasonCode: string;
  readonly evidenceDigest: string;
}

export interface LegacySelectedSkillObservationV2 {
  readonly skillId: string;
  readonly sourceVersion: string;
  readonly bodyHash: string;
  readonly documentIdentityDigest: string;
}

export interface LegacyRejectedSkillObservationV2 extends LegacySelectedSkillObservationV2 {
  readonly reason: 'duplicate' | 'conflict' | 'over-budget';
}

export interface SkillSelectionScopeDigestsV2 {
  readonly sessionId: string;
  readonly cardId?: string;
  readonly worldId?: string;
}

export interface StyleChassisObservation {
  readonly skillId: string;
  readonly sourceVersion: string;
  readonly bodyHash: string;
  readonly documentIdentityDigest: string;
  /** Bound to the actual committed run/message, never a round-only sample identity. */
  readonly commitDigest: string;
}

export const STYLE_PACKAGE_SCHEMA_PATHS = Object.freeze([
  'plan', 'plan.thought', 'plan.roadmap', 'plan.roadmap.current_arc', 'plan.roadmap.current_stage',
  'plan.roadmap.next_milestone', 'plan.roadmap.active_foreshadowing', 'plan.roadmap.active_foreshadowing.clue',
  'plan.roadmap.active_foreshadowing.status', 'plan.key_events',
  'plan.key_events.description', 'plan.key_events.character_focus', 'plan.key_events.reference_source',
  'plan.key_events.character_focus.name', 'plan.key_events.character_focus.knows', 'plan.key_events.character_focus.unknowns',
  'plan.bars_delta', 'plan.bars_delta.personal', 'plan.bars_delta.accident', 'plan.bars_delta.main', 'plan.bars_delta.erotic',
  'plan.parallel', 'plan.parallel.kind', 'plan.parallel.actor', 'plan.parallel.location', 'plan.parallel.action',
  'plan.parallel.countdown_min', 'plan.next_plan', 'plan.event_type', 'plan.nsfw_lock',
  'memory_delta', 'memory_delta.delta_summary', 'memory_delta.state_changes', 'memory_delta.state_changes.entity_type',
  'memory_delta.state_changes.entity_id', 'memory_delta.state_changes.field', 'memory_delta.state_changes.value',
  'memory_delta.state_changes.action', 'memory_delta.new_events', 'memory_delta.new_events.description',
  'memory_delta.new_events.characters', 'memory_delta.character_deltas', 'memory_delta.character_deltas.characterId',
  'memory_delta.character_deltas.mention', 'memory_delta.character_deltas.name', 'memory_delta.character_deltas.aliases',
  'memory_delta.character_deltas.newEntity', 'memory_delta.character_deltas.changes', 'memory_delta.character_deltas.changes.field',
  'memory_delta.character_deltas.changes.scope', 'memory_delta.character_deltas.changes.value', 'memory_delta.character_deltas.changes.factKind',
  'memory_delta.character_deltas.changes.status', 'memory_delta.character_deltas.changes.sceneId',
  'memory_delta.character_deltas.changes.effectiveAt', 'memory_delta.character_deltas.changes.sourceRefs',
  'memory_delta.character_deltas.relationships', 'memory_delta.character_deltas.relationships.relationshipId',
  'memory_delta.character_deltas.relationships.fromCharacterId', 'memory_delta.character_deltas.relationships.toCharacterId',
  'memory_delta.character_deltas.relationships.type', 'memory_delta.character_deltas.relationships.perspective',
  'memory_delta.character_deltas.relationships.factKind', 'memory_delta.character_deltas.relationships.status',
  'memory_delta.character_deltas.relationships.sceneId', 'memory_delta.character_deltas.relationships.effectiveAt',
  'memory_delta.character_deltas.relationships.sourceRefs', 'memory_delta.character_deltas.unresolved', 'prose', 'other',
] as const);
export type StylePackageSchemaPath = typeof STYLE_PACKAGE_SCHEMA_PATHS[number];

/** Maps validator paths to a closed host list; model-supplied values/keys never leave this boundary. */
export function stylePackageSchemaPaths(issues: readonly string[]): readonly StylePackageSchemaPath[] {
  const allowed = new Set<string>(STYLE_PACKAGE_SCHEMA_PATHS);
  const paths = new Set<StylePackageSchemaPath>();
  for (const issue of issues) {
    const normalized = (issue.split(':', 1)[0] ?? '').split('.').filter(part => !/^\d+$/u.test(part)).join('.');
    paths.add((allowed.has(normalized) ? normalized : 'other') as StylePackageSchemaPath);
  }
  return Object.freeze([...paths].sort());
}

export interface StylePackageShadowRejection {
  readonly reason: 'output-invalid' | 'budget-exhausted';
  readonly detail?: 'missing-tool' | 'parse-rejected' | 'normalization-failed' | 'schema-invalid';
  readonly schemaAreas?: readonly ('plan' | 'memory_delta' | 'prose' | 'other')[];
  readonly schemaPaths?: readonly StylePackageSchemaPath[];
}

export interface SkillSelectionObservationV2 {
  readonly observationVersion: typeof SKILL_SELECTION_OBSERVATION_VERSION;
  readonly round: number;
  readonly contentMode: 'nsf' | 'nsfw';
  /** Domain-separated opaque scope identities; raw identifiers never cross this boundary. */
  readonly scopeDigests: SkillSelectionScopeDigestsV2;
  /** Digest of the legacy matcher query. The query itself is deliberately absent. */
  readonly discoveryDigest: string;
  readonly budgetTokens: number;
  readonly maxSkills: number;
  readonly candidates: readonly SkillSelectionCandidateObservationV2[];
  readonly legacySelected: readonly LegacySelectedSkillObservationV2[];
  readonly legacyRejected: readonly LegacyRejectedSkillObservationV2[];
  /** Absent for older producers; null means the used chassis had no real source document. */
  readonly styleChassis?: StyleChassisObservation | null;
}

/** @deprecated Internal compatibility alias; the wire discriminator is v2. */
export type SkillSelectionObservationV1 = SkillSelectionObservationV2;

export interface SkillSelectionObserver {
  observe(input: SkillSelectionObservationV2): void | Promise<void>;
}

const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;

function token(value: string, label: string): string {
  const normalized = value.normalize('NFC');
  if (!TOKEN_RE.test(normalized)) throw new TypeError(`${label} must be a stable token`);
  return normalized;
}

function version(value: string): string {
  const normalized = value.normalize('NFC');
  if (!VERSION_RE.test(normalized)) throw new TypeError('sourceVersion must be a stable version token');
  return normalized;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function boundedArray<T>(value: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError(`${label} must contain at most 64 items`);
  }
  return value;
}

/**
 * Copy and freeze the body-free contract before it crosses the asynchronous observer boundary.
 * This intentionally has no fields for query text, Skill bodies, prompts, messages or Provider clients.
 */
export function normalizeSkillSelectionObservation(input: SkillSelectionObservationV2): SkillSelectionObservationV2 {
  if (input.observationVersion !== SKILL_SELECTION_OBSERVATION_VERSION) {
    throw new TypeError(`observationVersion must be ${SKILL_SELECTION_OBSERVATION_VERSION}`);
  }
  if (!Number.isSafeInteger(input.round) || input.round < 0
    || !Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 0
    || !Number.isSafeInteger(input.maxSkills) || input.maxSkills < 0 || input.maxSkills > 64) {
    throw new TypeError('Skill selection observation bounds are invalid');
  }
  if (input.contentMode !== 'nsf' && input.contentMode !== 'nsfw') {
    throw new TypeError('contentMode must be nsf or nsfw');
  }
  const candidates = boundedArray(input.candidates, 'candidates').map((item, index) => Object.freeze({
    skillId: token(item.skillId, `candidates[${index}].skillId`),
    sourceVersion: version(item.sourceVersion),
    bodyHash: hash(item.bodyHash, `candidates[${index}].bodyHash`),
    documentIdentityDigest: hash(
      item.documentIdentityDigest,
      `candidates[${index}].documentIdentityDigest`,
    ),
    scoreBps: Number.isSafeInteger(item.scoreBps) && item.scoreBps >= 0 && item.scoreBps <= 10_000
      ? item.scoreBps
      : (() => { throw new TypeError(`candidates[${index}].scoreBps is invalid`); })(),
    reasonCode: token(item.reasonCode, `candidates[${index}].reasonCode`),
    evidenceDigest: hash(item.evidenceDigest, `candidates[${index}].evidenceDigest`),
  }));
  const selected = boundedArray(input.legacySelected, 'legacySelected').map((item, index) => Object.freeze({
    skillId: token(item.skillId, `legacySelected[${index}].skillId`),
    sourceVersion: version(item.sourceVersion),
    bodyHash: hash(item.bodyHash, `legacySelected[${index}].bodyHash`),
    documentIdentityDigest: hash(
      item.documentIdentityDigest,
      `legacySelected[${index}].documentIdentityDigest`,
    ),
  }));
  const rejected = boundedArray(input.legacyRejected, 'legacyRejected').map((item, index) => {
    if (item.reason !== 'duplicate' && item.reason !== 'conflict' && item.reason !== 'over-budget') {
      throw new TypeError(`legacyRejected[${index}].reason is invalid`);
    }
    return Object.freeze({
      skillId: token(item.skillId, `legacyRejected[${index}].skillId`),
      sourceVersion: version(item.sourceVersion),
      bodyHash: hash(item.bodyHash, `legacyRejected[${index}].bodyHash`),
      documentIdentityDigest: hash(
        item.documentIdentityDigest,
        `legacyRejected[${index}].documentIdentityDigest`,
      ),
      reason: item.reason,
    });
  });
  const style = input.styleChassis;
  if (style !== undefined && style !== null && (typeof style !== 'object' || Array.isArray(style)
    || Object.keys(style).length !== 5
    || Object.keys(style).some(key => !['skillId', 'sourceVersion', 'bodyHash', 'documentIdentityDigest', 'commitDigest'].includes(key)))) {
    throw new TypeError('styleChassis must contain only source and commit identities');
  }
  const styleChassis = style === undefined || style === null ? style : Object.freeze({
    skillId: token(style.skillId, 'styleChassis.skillId'), sourceVersion: version(style.sourceVersion),
    bodyHash: hash(style.bodyHash, 'styleChassis.bodyHash'),
    documentIdentityDigest: hash(style.documentIdentityDigest, 'styleChassis.documentIdentityDigest'),
    commitDigest: hash(style.commitDigest, 'styleChassis.commitDigest'),
  });
  return Object.freeze({
    observationVersion: SKILL_SELECTION_OBSERVATION_VERSION,
    round: input.round,
    contentMode: input.contentMode,
    scopeDigests: Object.freeze({
      sessionId: hash(input.scopeDigests?.sessionId, 'scopeDigests.sessionId'),
      ...(input.scopeDigests?.cardId === undefined
        ? {}
        : { cardId: hash(input.scopeDigests.cardId, 'scopeDigests.cardId') }),
      ...(input.scopeDigests?.worldId === undefined
        ? {}
        : { worldId: hash(input.scopeDigests.worldId, 'scopeDigests.worldId') }),
    }),
    discoveryDigest: hash(input.discoveryDigest, 'discoveryDigest'),
    budgetTokens: input.budgetTokens,
    maxSkills: input.maxSkills,
    candidates: Object.freeze(candidates),
    legacySelected: Object.freeze(selected),
    legacyRejected: Object.freeze(rejected),
    ...(styleChassis === undefined ? {} : { styleChassis }),
  });
}

/**
 * Best-effort observe-only dispatch. It never waits, never throws into the foreground turn and
 * attaches a rejection handler even when the observer returns a never-ending/rejected Promise.
 */
export function dispatchSkillSelectionObservation(
  observer: SkillSelectionObserver | undefined,
  input: SkillSelectionObservationV2,
): void {
  if (!observer) return;
  let snapshot: SkillSelectionObservationV2;
  try {
    snapshot = normalizeSkillSelectionObservation(input);
  } catch {
    return;
  }
  queueMicrotask(() => {
    try {
      void Promise.resolve(observer.observe(snapshot)).catch(() => undefined);
    } catch {
      // A shadow observer must never change the committed turn outcome.
    }
  });
}
