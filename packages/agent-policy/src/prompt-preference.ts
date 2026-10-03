export const PROMPT_PREFERENCE_EXTRACTOR_VERSION = 'prompt-preference-v1';
export const PROMPT_PREFERENCE_DIMENSIONS = Object.freeze([
  'pace', 'tone', 'interaction', 'viewpoint', 'relationship', 'action',
] as const);
export type PromptPreferenceDimension = (typeof PROMPT_PREFERENCE_DIMENSIONS)[number];
export type PromptPreferencePolarity = 'like' | 'avoid';
export type PromptPreferenceConfidence = 'explicit' | 'inferred-low';

export interface PromptPreferenceTag {
  readonly dimension: PromptPreferenceDimension;
  readonly value: string;
  readonly polarity: PromptPreferencePolarity;
  readonly confidence: PromptPreferenceConfidence;
  readonly token: string;
}

export interface ExplicitPromptPreferences {
  readonly version: typeof PROMPT_PREFERENCE_EXTRACTOR_VERSION;
  readonly tags: readonly PromptPreferenceTag[];
  readonly hasConflict: boolean;
}

export interface PromptPreferenceEvidence {
  readonly eventKind: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: string;
  readonly sourceRevision?: string | null;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface PromptPreferenceProfile {
  readonly scope: 'session' | 'card';
  readonly sessionId: string | null;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly sampleCount: number;
  readonly tagCounts: Readonly<Record<string, number>>;
  readonly conflictTags: readonly string[];
}

export interface PromptPreferenceProfiles {
  readonly session: readonly PromptPreferenceProfile[];
  readonly card: readonly PromptPreferenceProfile[];
}

const OPAQUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TAG_TOKEN = /^(pace|tone|interaction|viewpoint|relationship|action)\.[a-z][a-z0-9_]*\.(like|avoid)$/u;
const MAX_TAGS = 32;
const PREFERENCE_CLEAR_TOMBSTONE_VERSION = 'preference-clear-v1';

const VOCABULARY: Readonly<Record<PromptPreferenceDimension, readonly {
  value: string; pattern: RegExp;
}[]>> = Object.freeze({
  pace: Object.freeze([
    { value: 'slow', pattern: /慢节奏|节奏慢|慢热|缓慢推进|细水长流/u },
    { value: 'balanced', pattern: /张弛有度|节奏适中|平衡节奏/u },
    { value: 'fast', pattern: /快节奏|节奏快|紧凑|快速推进/u },
  ]),
  tone: Object.freeze([
    { value: 'romance', pattern: /恋爱|浪漫|感情线|情感戏/u },
    { value: 'mystery', pattern: /悬疑|推理|谜团/u },
    { value: 'action', pattern: /战斗|动作戏|冒险/u },
    { value: 'slice_of_life', pattern: /日常|生活流|治愈/u },
    { value: 'dark', pattern: /黑暗|沉重|压抑/u },
    { value: 'comedy', pattern: /轻松|喜剧|搞笑|欢乐/u },
    { value: 'horror', pattern: /恐怖|惊悚/u },
  ]),
  interaction: Object.freeze([
    { value: 'choice_guided', pattern: /剧情分支|分支选项|给我选择|提供选项|选择按钮/u },
    { value: 'freeform', pattern: /自由输入|自由发挥|开放式互动/u },
    { value: 'dialogue_heavy', pattern: /多对话|对话为主|重视对话|对白为主/u },
    { value: 'exploration', pattern: /探索为主|调查为主|重视探索/u },
  ]),
  viewpoint: Object.freeze([
    { value: 'first_person', pattern: /第一人称|我视角/u },
    { value: 'second_person', pattern: /第二人称|你视角/u },
    { value: 'third_person', pattern: /第三人称|上帝视角/u },
  ]),
  relationship: Object.freeze([
    { value: 'slow_burn', pattern: /慢热关系|慢热感情|循序渐进的关系/u },
    { value: 'trust', pattern: /信任建立|建立信任|互相信任/u },
    { value: 'romance', pattern: /恋爱关系|浪漫关系|感情发展/u },
    { value: 'rivalry', pattern: /竞争关系|宿敌|对手关系/u },
  ]),
  action: Object.freeze([
    { value: 'proactive', pattern: /主动行动|主动推进|积极行动/u },
    { value: 'cautious', pattern: /谨慎行动|稳妥行动|小心推进/u },
    { value: 'diplomatic', pattern: /交涉优先|外交手段|和平解决/u },
    { value: 'confrontational', pattern: /正面对抗|强硬行动|直接冲突/u },
  ]),
});

const POSITIVE_MARKER = /(?:我|本人|玩家)\s*(?:更)?(?:喜欢|偏好|偏爱)|(?:我|本人|玩家)\s*(?:希望|想要)\s*(?!让?(?:她|他|角色|人物))|请(?:用|使用|保持|多给)\s*(?!让?(?:她|他|角色|人物))|^(?:希望|想要)\s*(?!让?(?:她|他|角色|人物))|^(?:但(?:是)?|不过)\s*(?:我)?(?:更)?(?:喜欢|偏好|偏爱|希望|想要)|偏好\s*[:：]/u;
const NEGATIVE_MARKER = /(?:我|本人|玩家)\s*(?:不喜欢|不想要)|^(?:但(?:是)?|不过|而不是)\s*(?:我)?(?:不喜欢|不想要)|请勿|(?:不要|避免|禁止|少写|别用)\s*(?!让?(?:她|他|角色|人物))/u;
const MAX_MARKER_DISTANCE = 48;

function tokenOf(dimension: PromptPreferenceDimension, value: string, polarity: PromptPreferencePolarity): string {
  return `${dimension}.${value}.${polarity}`;
}

const ALLOWED_TAG_TOKENS = new Set(PROMPT_PREFERENCE_DIMENSIONS.flatMap((dimension) => (
  VOCABULARY[dimension].flatMap((entry) => ([
    tokenOf(dimension, entry.value, 'like'),
    tokenOf(dimension, entry.value, 'avoid'),
  ]))
)));

export const PROMPT_PREFERENCE_ALLOWED_TOKENS = Object.freeze([...ALLOWED_TAG_TOKENS].sort());

export interface TypedPreferenceExtraction {
  readonly version: 'typed-preference-v1';
  readonly confidence: 'inferred-low';
  readonly tags: readonly PromptPreferenceTag[];
}

/** Strict model-output boundary: frozen vocabulary only; no source prose can enter the ledger. */
export function normalizeTypedPreferenceExtraction(value: unknown): TypedPreferenceExtraction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['version', 'confidence', 'tags'].includes(key))
    || row.version !== 'typed-preference-v1' || row.confidence !== 'inferred-low'
    || !Array.isArray(row.tags) || row.tags.length > MAX_TAGS) return null;
  const tags: PromptPreferenceTag[] = [];
  for (const item of row.tags) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const tag = item as Record<string, unknown>;
    if (Object.keys(tag).some((key) => !['token'].includes(key))
      || typeof tag.token !== 'string' || !ALLOWED_TAG_TOKENS.has(tag.token)) return null;
    const [dimension, tagValue, polarity] = tag.token.split('.');
    tags.push(Object.freeze({
      dimension: dimension as PromptPreferenceDimension,
      value: tagValue!,
      polarity: polarity as PromptPreferencePolarity,
      confidence: 'inferred-low',
      token: tag.token,
    }));
  }
  const unique = [...new Map(tags.map((tag) => [tag.token, tag])).values()]
    .sort((left, right) => left.token.localeCompare(right.token));
  return Object.freeze({
    version: 'typed-preference-v1',
    confidence: 'inferred-low',
    tags: Object.freeze(unique),
  });
}

/** 只读固定词表；不调用模型，也不输出/保存来源句子。 */
export function extractExplicitPromptPreferences(input: string): ExplicitPromptPreferences {
  const normalized = input.normalize('NFKC').slice(0, 20_000);
  const tags = new Map<string, PromptPreferenceTag>();
  const clauses = normalized.split(/(?:[\n,，。！？!?；;]+|(?=但(?:是)?|不过|而不是))/u)
    .map((value) => value.trim()).filter(Boolean);
  for (const clause of clauses) {
    const negative = clause.match(NEGATIVE_MARKER);
    const positive = clause.match(POSITIVE_MARKER);
    const marker = negative ?? positive;
    if (!marker) continue;
    const markerIndex = marker.index ?? 0;
    const polarity: PromptPreferencePolarity = negative ? 'avoid' : 'like';
    for (const dimension of PROMPT_PREFERENCE_DIMENSIONS) {
      for (const entry of VOCABULARY[dimension]) {
        const term = clause.match(entry.pattern);
        if (!term || Math.abs((term.index ?? 0) - markerIndex) > MAX_MARKER_DISTANCE) continue;
        const token = tokenOf(dimension, entry.value, polarity);
        tags.set(token, Object.freeze({ dimension, value: entry.value, polarity, confidence: 'explicit', token }));
      }
    }
  }
  const ordered = [...tags.values()].sort((left, right) => left.token.localeCompare(right.token)).slice(0, MAX_TAGS);
  const polarities = new Map<string, Set<PromptPreferencePolarity>>();
  for (const tag of ordered) {
    const key = `${tag.dimension}.${tag.value}`;
    const set = polarities.get(key) ?? new Set<PromptPreferencePolarity>();
    set.add(tag.polarity);
    polarities.set(key, set);
  }
  return Object.freeze({
    version: PROMPT_PREFERENCE_EXTRACTOR_VERSION,
    tags: Object.freeze(ordered),
    hasConflict: [...polarities.values()].some((set) => set.size > 1),
  });
}

interface MutableProfile {
  scope: 'session' | 'card';
  sessionId: string | null;
  cardId: string;
  contentMode: 'nsf' | 'nsfw';
  sampleCount: number;
  counts: Record<string, number>;
}

function evidenceTags(row: PromptPreferenceEvidence): string[] | null {
  if (row.eventKind !== 'session_start_prompt'
    || !OPAQUE_TOKEN.test(row.sessionId) || !OPAQUE_TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
    || row.features.preferenceExtractorVersion !== PROMPT_PREFERENCE_EXTRACTOR_VERSION
    || !Array.isArray(row.features.explicitPreferenceTags)
    || (row.features.inferredPreferenceTags !== undefined
      && !Array.isArray(row.features.inferredPreferenceTags))) return null;
  const tags = [
    ...row.features.explicitPreferenceTags,
    ...((row.features.inferredPreferenceTags as unknown[] | undefined) ?? []),
  ];
  if (tags.length > MAX_TAGS || !tags.every((tag) => (
    typeof tag === 'string' && TAG_TOKEN.test(tag) && ALLOWED_TAG_TOKENS.has(tag)
  ))) return null;
  return [...new Set(tags as string[])].sort();
}

function exactIdentityKey(row: PromptPreferenceEvidence): string {
  return `${row.sessionId}\0${row.cardId}\0${row.contentMode}`;
}

function positivePreferenceEpoch(row: PromptPreferenceEvidence): number | null {
  const value = row.features.preferenceEpoch;
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function preferenceClearEpoch(row: PromptPreferenceEvidence): number | null {
  if (row.eventKind !== 'delete' || row.sourceRevision !== null
    || !OPAQUE_TOKEN.test(row.sessionId) || !OPAQUE_TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')) return null;
  const keys = Object.keys(row.features).sort();
  const expectedKeys = [
    'preferenceClearExpectedRevision', 'preferenceClearOperationId', 'preferenceClearPreviousEpoch',
    'preferenceClearRemoved', 'preferenceClearResultRevision', 'preferenceClearVersion', 'preferenceEpoch',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || row.features.preferenceClearVersion !== PREFERENCE_CLEAR_TOMBSTONE_VERSION
    || typeof row.features.preferenceClearOperationId !== 'string'
    || !OPAQUE_TOKEN.test(row.features.preferenceClearOperationId)
    || typeof row.features.preferenceClearExpectedRevision !== 'string'
    || !SHA256.test(row.features.preferenceClearExpectedRevision)
    || typeof row.features.preferenceClearResultRevision !== 'string'
    || !SHA256.test(row.features.preferenceClearResultRevision)
    || !Number.isSafeInteger(row.features.preferenceClearPreviousEpoch)
    || Number(row.features.preferenceClearPreviousEpoch) < 0
    || !Number.isSafeInteger(row.features.preferenceEpoch)
    || Number(row.features.preferenceEpoch) !== Number(row.features.preferenceClearPreviousEpoch) + 1
    || !Number.isSafeInteger(row.features.preferenceClearRemoved)
    || Number(row.features.preferenceClearRemoved) < 0) return null;
  return Number(row.features.preferenceEpoch);
}

function latestPreferenceEpochs(evidence: readonly PromptPreferenceEvidence[]): ReadonlyMap<string, number> {
  const epochs = new Map<string, number>();
  for (const row of evidence) {
    const epoch = preferenceClearEpoch(row);
    if (epoch === null) continue;
    const key = exactIdentityKey(row);
    epochs.set(key, Math.max(epoch, epochs.get(key) ?? 0));
  }
  return epochs;
}

function newProfile(scope: 'session' | 'card', row: PromptPreferenceEvidence): MutableProfile {
  return {
    scope,
    sessionId: scope === 'session' ? row.sessionId : null,
    cardId: row.cardId,
    contentMode: row.contentMode as 'nsf' | 'nsfw',
    sampleCount: 0,
    counts: {},
  };
}

function finish(profile: MutableProfile): PromptPreferenceProfile {
  const tagCounts = Object.freeze(Object.fromEntries(Object.entries(profile.counts).sort(([a], [b]) => a.localeCompare(b))));
  const conflicts: string[] = [];
  for (const dimension of PROMPT_PREFERENCE_DIMENSIONS) {
    const values = new Set(Object.keys(tagCounts)
      .filter((token) => token.startsWith(`${dimension}.`))
      .map((token) => token.split('.').slice(0, 2).join('.')));
    for (const value of values) {
      if ((tagCounts[`${value}.like`] ?? 0) > 0 && (tagCounts[`${value}.avoid`] ?? 0) > 0) conflicts.push(value);
    }
  }
  return Object.freeze({
    scope: profile.scope,
    sessionId: profile.sessionId,
    cardId: profile.cardId,
    contentMode: profile.contentMode,
    sampleCount: profile.sampleCount,
    tagCounts,
    conflictTags: Object.freeze(conflicts.sort()),
  });
}

/** 从脱敏 session_start_prompt 事件重建；无标签会话不伪造偏好样本。 */
export function rebuildPromptPreferenceProfiles(evidence: readonly PromptPreferenceEvidence[]): PromptPreferenceProfiles {
  const currentEpochs = latestPreferenceEpochs(evidence);
  const invalidatedRevisions = new Set(evidence.filter((row) => (
    row.eventKind === 'delete' && typeof row.sourceRevision === 'string' && OPAQUE_TOKEN.test(row.sourceRevision)
  )).map((row) => `${row.sessionId}\0${row.sourceRevision}`));
  for (const row of evidence) {
    const replaced = row.features.replacedSourceRevision;
    if (row.eventKind === 'regenerate' && typeof replaced === 'string' && OPAQUE_TOKEN.test(replaced)) {
      invalidatedRevisions.add(`${row.sessionId}\0${replaced}`);
    }
  }
  const session = new Map<string, MutableProfile>();
  const card = new Map<string, MutableProfile>();
  for (const row of evidence) {
    const tags = evidenceTags(row);
    if (!tags || tags.length === 0) continue;
    const preferenceEpoch = positivePreferenceEpoch(row);
    if (preferenceEpoch === null || preferenceEpoch !== (currentEpochs.get(exactIdentityKey(row)) ?? 0)) continue;
    if (typeof row.sourceRevision === 'string'
      && invalidatedRevisions.has(`${row.sessionId}\0${row.sourceRevision}`)) continue;
    const groups: Array<[Map<string, MutableProfile>, string, 'session' | 'card']> = [
      [session, `${row.sessionId}\0${row.cardId}\0${row.contentMode}`, 'session'],
      [card, `${row.cardId}\0${row.contentMode}`, 'card'],
    ];
    for (const [map, key, scope] of groups) {
      const profile = map.get(key) ?? newProfile(scope, row);
      profile.sampleCount += 1;
      for (const tag of tags) profile.counts[tag] = (profile.counts[tag] ?? 0) + 1;
      map.set(key, profile);
    }
  }
  const sort = (values: Iterable<MutableProfile>) => [...values]
    .sort((left, right) => `${left.sessionId ?? ''}\0${left.cardId}\0${left.contentMode}`
      .localeCompare(`${right.sessionId ?? ''}\0${right.cardId}\0${right.contentMode}`))
    .map(finish);
  return Object.freeze({ session: Object.freeze(sort(session.values())), card: Object.freeze(sort(card.values())) });
}
