import { extractExplicitPromptPreferences } from './prompt-preference.ts';

export const STYLE_EVIDENCE_VERSION = 'style-evidence-v1';
export type StyleEvidenceAcceptance = 'weak' | 'regenerated';

export interface DeterministicStyleEvidence {
  readonly styleEvidenceVersion: typeof STYLE_EVIDENCE_VERSION;
  readonly styleAcceptance: StyleEvidenceAcceptance;
  readonly styleSkillId: string;
  readonly styleContextDigest: string;
  readonly proseDigest: string;
  readonly tacticalSkillIds: readonly string[];
  readonly explicitStyleTags: readonly string[];
  readonly proseCharBucket: string;
  readonly paragraphCountBucket: string;
  readonly sentenceLengthBucket: string;
  readonly dialogueRatioBucket: string;
  readonly proseViewpoint: 'first' | 'second' | 'third' | 'mixed' | 'none';
  readonly prosePace: 'fast' | 'balanced' | 'slow';
  readonly duplicateInjection: boolean;
  readonly duplicateTacticalSkillIds: readonly string[];
}

export interface BuildStyleEvidenceInput {
  readonly userInput: string;
  readonly assistantProse: string;
  readonly styleSkillId: string;
  readonly styleContextDigest: string;
  readonly proseDigest: string;
  readonly tacticalSkillIds: readonly string[];
  readonly duplicateTacticalSkillIds?: readonly string[];
  readonly regenerated?: boolean;
}

export interface StyleEvidenceEvent {
  readonly eventKind: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: string;
  readonly round: number;
  readonly sourceRevision: string | null;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface StyleEvidenceProfile {
  readonly scope: 'session' | 'card';
  readonly sessionId: string | null;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly styleSkillId: string;
  readonly weakSampleCount: number;
  readonly strongSampleCount: 0;
  readonly metricCounts: Readonly<Record<string, number>>;
  readonly directiveTagCounts: Readonly<Record<string, number>>;
  readonly tacticalSkillCounts: Readonly<Record<string, number>>;
  readonly duplicateInjectionCount: number;
  readonly drift: Readonly<{ detected: boolean; dimensions: readonly string[] }>;
}

export interface StyleEvidenceProfiles {
  readonly session: readonly StyleEvidenceProfile[];
  readonly card: readonly StyleEvidenceProfile[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_TAGS = 32;
const STYLE_DIRECTIVE_MARKER = /(?:我|本人|玩家)\s*(?:更)?(?:喜欢|偏好|偏爱|希望|想要|不喜欢|不想要)|请(?:用|使用|保持|多用|少用|勿用)|不要|避免|禁止|别用/u;

const PREFERENCE_DIRECTIVES = Object.freeze([
  { stem: 'sentence.short', pattern: /短句|简短句子/u },
  { stem: 'sentence.long', pattern: /长句|长句子/u },
  { stem: 'paragraph.short', pattern: /短段落|段落短/u },
  { stem: 'paragraph.long', pattern: /长段落|段落长/u },
  { stem: 'dialogue.more', pattern: /多对白|多对话|对白为主|对话为主/u },
  { stem: 'dialogue.less', pattern: /少对白|少对话|减少对白|减少对话/u },
] as const);
const BAN_DIRECTIVES = Object.freeze([
  { token: 'ban.emoji.like', pattern: /(?:禁用|不要|避免|不用)(?:表情符号|emoji)/iu },
  { token: 'ban.english.like', pattern: /(?:不要|避免|禁用)英文/u },
  { token: 'ban.ellipsis.like', pattern: /(?:不要|避免|禁用)省略号/u },
] as const);
const NEGATIVE_STYLE_MARKER = /不喜欢|不想要|请勿|不要|避免|禁止|别用|少用/u;

const ALLOWED_DIRECTIVE_TAGS = new Set([
  ...['slow', 'balanced', 'fast'].flatMap((value) => [`pace.${value}.like`, `pace.${value}.avoid`]),
  ...['first_person', 'second_person', 'third_person'].flatMap((value) => [`viewpoint.${value}.like`, `viewpoint.${value}.avoid`]),
  ...PREFERENCE_DIRECTIVES.flatMap((entry) => [`${entry.stem}.like`, `${entry.stem}.avoid`]),
  ...BAN_DIRECTIVES.map((entry) => entry.token),
]);

const METRIC_VALUES = Object.freeze({
  proseCharBucket: new Set(['c000_127', 'c128_255', 'c256_511', 'c512_1023', 'c1024_plus']),
  paragraphCountBucket: new Set(['p01', 'p02_03', 'p04_06', 'p07_plus']),
  sentenceLengthBucket: new Set(['s00_17', 's18_35', 's36_63', 's64_plus']),
  dialogueRatioBucket: new Set(['d000_099', 'd100_299', 'd300_599', 'd600_1000']),
  proseViewpoint: new Set(['first', 'second', 'third', 'mixed', 'none']),
  prosePace: new Set(['fast', 'balanced', 'slow']),
});

function uniqueTokens(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value) => TOKEN.test(value)))].sort().slice(0, MAX_TAGS));
}

function bucket(value: number, boundaries: readonly number[], labels: readonly string[]): string {
  for (let index = 0; index < boundaries.length; index += 1) {
    if (value <= boundaries[index]!) return labels[index]!;
  }
  return labels.at(-1)!;
}

/** 固定词表文风指令；返回值永不携带来源句子。 */
export function extractExplicitStyleTags(input: string): readonly string[] {
  const normalized = input.normalize('NFKC').slice(0, 20_000);
  const tags = extractExplicitPromptPreferences(normalized).tags
    .filter((tag) => tag.dimension === 'pace' || tag.dimension === 'viewpoint')
    .map((tag) => tag.token);
  for (const clause of normalized.split(/[\n,，。！？!?；;]+/u).map((value) => value.trim()).filter(Boolean)) {
    if (!STYLE_DIRECTIVE_MARKER.test(clause)) continue;
    const polarity = NEGATIVE_STYLE_MARKER.test(clause) ? 'avoid' : 'like';
    for (const directive of PREFERENCE_DIRECTIVES) {
      if (directive.pattern.test(clause)) tags.push(`${directive.stem}.${polarity}`);
    }
    for (const directive of BAN_DIRECTIVES) if (directive.pattern.test(clause)) tags.push(directive.token);
  }
  return uniqueTokens(tags.filter((tag) => ALLOWED_DIRECTIVE_TAGS.has(tag)));
}

function proseMetrics(prose: string): Pick<DeterministicStyleEvidence,
  'proseCharBucket' | 'paragraphCountBucket' | 'sentenceLengthBucket' | 'dialogueRatioBucket'
  | 'proseViewpoint' | 'prosePace'> {
  const normalized = prose.normalize('NFKC');
  const chars = [...normalized].length;
  const paragraphs = normalized.split(/\n\s*\n|\n/u).map((value) => value.trim()).filter(Boolean);
  const sentences = normalized.split(/[。！？!?；;]+/u).map((value) => value.trim()).filter(Boolean);
  const averageSentence = sentences.length === 0 ? chars : Math.round(chars / sentences.length);
  const dialogueChars = [...(normalized.match(/[“「『][^”」』]*[”」』]|"[^"]*"/gu) ?? [])]
    .reduce((sum, value) => sum + [...value].length, 0);
  const dialoguePermille = chars === 0 ? 0 : Math.min(1000, Math.round((dialogueChars * 1000) / chars));
  const narrative = normalized.replace(/[“「『][^”」』]*[”」』]|"[^"]*"/gu, '');
  const first = (narrative.match(/我|我们|咱们/gu) ?? []).length;
  const second = (narrative.match(/你|你们/gu) ?? []).length;
  const third = (narrative.match(/他|她|他们|她们/gu) ?? []).length;
  const max = Math.max(first, second, third);
  const leaders = [first, second, third].filter((value) => value === max && value > 0).length;
  const proseViewpoint = max === 0 ? 'none' : leaders > 1 ? 'mixed' : first === max ? 'first' : second === max ? 'second' : 'third';
  return Object.freeze({
    proseCharBucket: bucket(chars, [127, 255, 511, 1023], ['c000_127', 'c128_255', 'c256_511', 'c512_1023', 'c1024_plus']),
    paragraphCountBucket: bucket(paragraphs.length, [1, 3, 6], ['p01', 'p02_03', 'p04_06', 'p07_plus']),
    sentenceLengthBucket: bucket(averageSentence, [17, 35, 63], ['s00_17', 's18_35', 's36_63', 's64_plus']),
    dialogueRatioBucket: bucket(dialoguePermille, [99, 299, 599], ['d000_099', 'd100_299', 'd300_599', 'd600_1000']),
    proseViewpoint,
    prosePace: averageSentence <= 17 ? 'fast' : averageSentence <= 35 ? 'balanced' : 'slow',
  });
}

/** 仅计算桶、枚举、摘要和既有身份；不返回正文。 */
export function buildDeterministicStyleEvidence(input: BuildStyleEvidenceInput): DeterministicStyleEvidence {
  if (!TOKEN.test(input.styleSkillId) || !DIGEST.test(input.styleContextDigest) || !DIGEST.test(input.proseDigest)) {
    throw new TypeError('style evidence identity invalid');
  }
  const tacticalSkillIds = uniqueTokens(input.tacticalSkillIds);
  const duplicateTacticalSkillIds = uniqueTokens(input.duplicateTacticalSkillIds ?? [])
    .filter((id) => tacticalSkillIds.includes(id));
  return Object.freeze({
    styleEvidenceVersion: STYLE_EVIDENCE_VERSION,
    styleAcceptance: input.regenerated ? 'regenerated' : 'weak',
    styleSkillId: input.styleSkillId,
    styleContextDigest: input.styleContextDigest,
    proseDigest: input.proseDigest,
    tacticalSkillIds,
    explicitStyleTags: extractExplicitStyleTags(input.userInput),
    ...proseMetrics(input.assistantProse),
    duplicateInjection: duplicateTacticalSkillIds.length > 0,
    duplicateTacticalSkillIds,
  });
}

interface MutableProfile {
  scope: 'session' | 'card';
  sessionId: string | null;
  cardId: string;
  contentMode: 'nsf' | 'nsfw';
  styleSkillId: string;
  samples: Array<{ metrics: Record<string, string>; tags: string[]; skills: string[]; duplicate: boolean }>;
}

function validEvidence(row: StyleEvidenceEvent): DeterministicStyleEvidence | null {
  const value = row.features;
  if (row.eventKind !== 'turn_accepted_weak' || value.styleEvidenceVersion !== STYLE_EVIDENCE_VERSION
    || value.styleAcceptance !== 'weak' || !TOKEN.test(row.sessionId) || !TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw') || !Number.isSafeInteger(row.round) || row.round < 1
    || typeof value.styleSkillId !== 'string' || !TOKEN.test(value.styleSkillId)
    || typeof value.styleContextDigest !== 'string' || !DIGEST.test(value.styleContextDigest)
    || typeof value.proseDigest !== 'string' || !DIGEST.test(value.proseDigest)
    || !Array.isArray(value.tacticalSkillIds) || !Array.isArray(value.explicitStyleTags)
    || !Array.isArray(value.duplicateTacticalSkillIds)) return null;
  const tactical = value.tacticalSkillIds;
  const tags = value.explicitStyleTags;
  const duplicate = value.duplicateTacticalSkillIds;
  if (tactical.length > MAX_TAGS || tags.length > MAX_TAGS || duplicate.length > MAX_TAGS
    || !tactical.every((item) => typeof item === 'string' && TOKEN.test(item))
    || !tags.every((item) => typeof item === 'string' && ALLOWED_DIRECTIVE_TAGS.has(item))
    || !duplicate.every((item) => typeof item === 'string' && tactical.includes(item))) return null;
  const metrics = Object.keys(METRIC_VALUES) as Array<keyof typeof METRIC_VALUES>;
  if (!metrics.every((key) => typeof value[key] === 'string' && METRIC_VALUES[key].has(value[key] as string))
    || typeof value.duplicateInjection !== 'boolean'
    || value.duplicateInjection !== (duplicate.length > 0)
    || new Set(tactical).size !== tactical.length || new Set(tags).size !== tags.length
    || new Set(duplicate).size !== duplicate.length) return null;
  return value as unknown as DeterministicStyleEvidence;
}

function increment(target: Record<string, number>, key: string): void { target[key] = (target[key] ?? 0) + 1; }

function modal(samples: MutableProfile['samples'], dimension: string): string | null {
  const counts: Record<string, number> = {};
  for (const sample of samples) increment(counts, sample.metrics[dimension]!);
  return Object.entries(counts).sort(([aKey, a], [bKey, b]) => b - a || aKey.localeCompare(bKey))[0]?.[0] ?? null;
}

function finish(profile: MutableProfile): StyleEvidenceProfile {
  const metricCounts: Record<string, number> = {};
  const directiveTagCounts: Record<string, number> = {};
  const tacticalSkillCounts: Record<string, number> = {};
  for (const sample of profile.samples) {
    for (const [dimension, value] of Object.entries(sample.metrics)) increment(metricCounts, `${dimension}.${value}`);
    for (const tag of sample.tags) increment(directiveTagCounts, tag);
    for (const skill of sample.skills) increment(tacticalSkillCounts, skill);
  }
  const dimensions = ['char', 'paragraph', 'sentence', 'dialogue', 'viewpoint', 'pace'];
  const changed: string[] = [];
  if (profile.samples.length >= 4) {
    const midpoint = Math.floor(profile.samples.length / 2);
    for (const dimension of dimensions) {
      if (modal(profile.samples.slice(0, midpoint), dimension) !== modal(profile.samples.slice(midpoint), dimension)) changed.push(dimension);
    }
  }
  const ordered = (value: Record<string, number>) => Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return Object.freeze({
    scope: profile.scope,
    sessionId: profile.sessionId,
    cardId: profile.cardId,
    contentMode: profile.contentMode,
    styleSkillId: profile.styleSkillId,
    weakSampleCount: profile.samples.length,
    strongSampleCount: 0,
    metricCounts: ordered(metricCounts),
    directiveTagCounts: ordered(directiveTagCounts),
    tacticalSkillCounts: ordered(tacticalSkillCounts),
    duplicateInjectionCount: profile.samples.filter((sample) => sample.duplicate).length,
    drift: Object.freeze({ detected: changed.length >= 2, dimensions: Object.freeze(changed) }),
  });
}

/** delete/regenerate 只失效明确引用的旧 revision；未来同 round 新消息仍可学习。 */
export function rebuildStyleEvidenceProfiles(events: readonly StyleEvidenceEvent[]): StyleEvidenceProfiles {
  const invalidatedRevisions = new Set(events.filter((row) => row.eventKind === 'delete' && row.sourceRevision !== null)
    .map((row) => `${row.sessionId}\0${row.sourceRevision}`));
  for (const row of events) {
    const replaced = row.features.replacedSourceRevision;
    if (row.eventKind === 'regenerate' && typeof replaced === 'string' && TOKEN.test(replaced)) {
      invalidatedRevisions.add(`${row.sessionId}\0${replaced}`);
    }
  }
  const session = new Map<string, MutableProfile>();
  const card = new Map<string, MutableProfile>();
  for (const row of events) {
    const evidence = validEvidence(row);
    if (!evidence) continue;
    if (row.sourceRevision === null || invalidatedRevisions.has(`${row.sessionId}\0${row.sourceRevision}`)) continue;
    const metrics = {
      char: evidence.proseCharBucket, paragraph: evidence.paragraphCountBucket,
      sentence: evidence.sentenceLengthBucket, dialogue: evidence.dialogueRatioBucket,
      viewpoint: evidence.proseViewpoint, pace: evidence.prosePace,
    };
    const groups: Array<[Map<string, MutableProfile>, string, 'session' | 'card']> = [
      [session, `${row.sessionId}\0${row.cardId}\0${row.contentMode}\0${evidence.styleSkillId}`, 'session'],
      [card, `${row.cardId}\0${row.contentMode}\0${evidence.styleSkillId}`, 'card'],
    ];
    for (const [map, key, scope] of groups) {
      const profile = map.get(key) ?? {
        scope, sessionId: scope === 'session' ? row.sessionId : null, cardId: row.cardId,
        contentMode: row.contentMode as 'nsf' | 'nsfw', styleSkillId: evidence.styleSkillId, samples: [],
      };
      profile.samples.push({ metrics, tags: [...evidence.explicitStyleTags], skills: [...evidence.tacticalSkillIds], duplicate: evidence.duplicateInjection });
      map.set(key, profile);
    }
  }
  const sort = (values: Iterable<MutableProfile>) => [...values]
    .sort((left, right) => `${left.sessionId ?? ''}\0${left.cardId}\0${left.contentMode}\0${left.styleSkillId}`
      .localeCompare(`${right.sessionId ?? ''}\0${right.cardId}\0${right.contentMode}\0${right.styleSkillId}`))
    .map(finish);
  return Object.freeze({ session: Object.freeze(sort(session.values())), card: Object.freeze(sort(card.values())) });
}
