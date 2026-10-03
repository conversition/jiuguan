import { createHash } from 'node:crypto';

export const BRANCH_EXACT_NORMALIZATION_VERSION = 'branch-exact-v1';
export const BRANCH_SEMANTIC_NORMALIZATION_VERSION = 'branch-semantic-v1';
export const BRANCH_ACTION_TAGS = Object.freeze([
  'investigate', 'social', 'move', 'confront', 'wait', 'other',
] as const);

export type BranchActionTag = (typeof BRANCH_ACTION_TAGS)[number];
export type BranchLengthBucket = 'short' | 'medium' | 'long';

export interface ExactBranchSelection {
  readonly selectedIndex: number;
  readonly branchCount: number;
  readonly selectedDigest: string;
  readonly actionTag: BranchActionTag;
  readonly lengthBucket: BranchLengthBucket;
  readonly normalizationVersion:
    | typeof BRANCH_EXACT_NORMALIZATION_VERSION
    | typeof BRANCH_SEMANTIC_NORMALIZATION_VERSION;
}

export type ExactBranchMatch =
  | { readonly matched: true; readonly selection: ExactBranchSelection }
  | { readonly matched: false; readonly reason: 'empty-input' | 'no-match' | 'ambiguous-match' };

export interface BranchPreferenceEvidence {
  readonly eventKind: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: string;
  readonly sourceRevision?: string | null;
  readonly subjectDigest: string;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface BranchPreferenceProfile {
  readonly scope: 'session' | 'card';
  readonly sessionId: string | null;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly sampleCount: number;
  readonly uniqueSelectionCount: number;
  readonly tagCounts: Readonly<Record<BranchActionTag, number>>;
  readonly tagPosterior: Readonly<Record<BranchActionTag, number>>;
  readonly positionCounts: Readonly<Record<string, number>>;
}

export interface BranchPreferenceProfiles {
  readonly session: readonly BranchPreferenceProfile[];
  readonly card: readonly BranchPreferenceProfile[];
}

const OPAQUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PREFERENCE_CLEAR_TOMBSTONE_VERSION = 'preference-clear-v1';

/** P14-03B 唯一允许的文本等价：NFKC、首尾 trim、连续空白折叠。 */
export function normalizeBranchChoice(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function classifyBranchAction(value: string): BranchActionTag {
  if (/攻击|战斗|对抗|阻止|质问|揭穿|威胁|挑战|反击/u.test(value)) return 'confront';
  // "等待观察" is a hold action; decide that before the generic observation cue.
  if (/等待|观望|暂缓|休息|按兵不动|静观|隐藏|潜伏/u.test(value)) return 'wait';
  if (/调查|检查|寻找|搜索|观察|追踪|探查|查看|核实|研究|搜集/u.test(value)) return 'investigate';
  if (/询问|交谈|对话|告诉|请求|安慰|说服|拜访|联系|回应|追问/u.test(value)) return 'social';
  if (/前往|进入|离开|返回|撤退|跟随|绕行|逃离|出发|赶往/u.test(value)) return 'move';
  return 'other';
}

function lengthBucket(value: string): BranchLengthBucket {
  const length = [...value].length;
  if (length <= 12) return 'short';
  if (length <= 24) return 'medium';
  return 'long';
}

/** 只返回摘要与有限特征，不把规范化后的用户输入/分支正文带出匹配器。 */
export function matchExactBranchSelection(userInput: string, branches: readonly string[]): ExactBranchMatch {
  const normalizedInput = normalizeBranchChoice(userInput);
  if (!normalizedInput) return Object.freeze({ matched: false, reason: 'empty-input' });
  const matches: Array<{ index: number; branch: string }> = [];
  branches.forEach((branch, index) => {
    const normalized = normalizeBranchChoice(branch);
    if (normalized && normalized === normalizedInput) matches.push({ index, branch: normalized });
  });
  if (matches.length === 0) return Object.freeze({ matched: false, reason: 'no-match' });
  if (matches.length !== 1) return Object.freeze({ matched: false, reason: 'ambiguous-match' });
  const selected = matches[0]!;
  return Object.freeze({
    matched: true,
    selection: Object.freeze({
      selectedIndex: selected.index,
      branchCount: branches.length,
      selectedDigest: sha256(selected.branch),
      actionTag: classifyBranchAction(selected.branch),
      lengthBucket: lengthBucket(selected.branch),
      normalizationVersion: BRANCH_EXACT_NORMALIZATION_VERSION,
    }),
  });
}

interface MutableProfile {
  scope: 'session' | 'card';
  sessionId: string | null;
  cardId: string;
  contentMode: 'nsf' | 'nsfw';
  sampleCount: number;
  digests: Set<string>;
  tagCounts: Record<BranchActionTag, number>;
  positionCounts: Record<string, number>;
}

function validEvidence(row: BranchPreferenceEvidence): {
  tag: BranchActionTag; selectedIndex: number; branchCount: number;
} | null {
  if ((row.eventKind !== 'branch_exact_selected' && row.eventKind !== 'branch_semantic_selected')
    || !OPAQUE_TOKEN.test(row.sessionId) || !OPAQUE_TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
    || !SHA256.test(row.subjectDigest)) return null;
  const version = row.features.normalizationVersion;
  const tag = row.features.actionTag;
  const selectedIndex = row.features.selectedIndex;
  const branchCount = row.features.branchCount;
  if ((version !== BRANCH_EXACT_NORMALIZATION_VERSION
      && version !== BRANCH_SEMANTIC_NORMALIZATION_VERSION)
    || typeof tag !== 'string' || !BRANCH_ACTION_TAGS.includes(tag as BranchActionTag)
    || !Number.isSafeInteger(selectedIndex) || Number(selectedIndex) < 0
    || !Number.isSafeInteger(branchCount) || Number(branchCount) < 1
    || Number(selectedIndex) >= Number(branchCount)) return null;
  return { tag: tag as BranchActionTag, selectedIndex: Number(selectedIndex), branchCount: Number(branchCount) };
}

function exactIdentityKey(row: BranchPreferenceEvidence): string {
  return `${row.sessionId}\0${row.cardId}\0${row.contentMode}`;
}

function positivePreferenceEpoch(row: BranchPreferenceEvidence): number | null {
  const value = row.features.preferenceEpoch;
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function preferenceClearEpoch(row: BranchPreferenceEvidence): number | null {
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

function latestPreferenceEpochs(evidence: readonly BranchPreferenceEvidence[]): ReadonlyMap<string, number> {
  const epochs = new Map<string, number>();
  for (const row of evidence) {
    const epoch = preferenceClearEpoch(row);
    if (epoch === null) continue;
    const key = exactIdentityKey(row);
    epochs.set(key, Math.max(epoch, epochs.get(key) ?? 0));
  }
  return epochs;
}

export interface SemanticBranchCandidate {
  readonly index: number;
  readonly similarity: number;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    a += left[index]! * left[index]!;
    b += right[index]! * right[index]!;
  }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : 0;
}

/** Local embedding candidate generation only; it never turns similarity into preference truth. */
export function semanticBranchCandidates(
  inputVector: readonly number[],
  branchVectors: readonly (readonly number[])[],
): readonly SemanticBranchCandidate[] {
  if (branchVectors.length < 1 || branchVectors.length > 8) return Object.freeze([]);
  const ranked = branchVectors.map((vector, index) => ({
    index,
    similarity: Math.round(cosine(inputVector, vector) * 1_000_000) / 1_000_000,
  })).sort((left, right) => right.similarity - left.similarity || left.index - right.index);
  if ((ranked[0]?.similarity ?? 0) < 0.2) return Object.freeze([]);
  return Object.freeze(ranked.slice(0, 3).map((entry) => Object.freeze(entry)));
}

export function normalizeSemanticBranchAttribution(
  value: unknown,
  candidates: readonly SemanticBranchCandidate[],
): { readonly selectedIndex: number; readonly confidence: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['version', 'selectedIndex', 'confidence', 'ambiguous'].includes(key))
    || row.version !== BRANCH_SEMANTIC_NORMALIZATION_VERSION || row.ambiguous !== false
    || !Number.isSafeInteger(row.selectedIndex)
    || typeof row.confidence !== 'number' || !Number.isFinite(row.confidence)
    || row.confidence < 0.6 || row.confidence > 1
    || !candidates.some((candidate) => candidate.index === row.selectedIndex)) return null;
  return Object.freeze({ selectedIndex: Number(row.selectedIndex), confidence: row.confidence });
}

export function semanticBranchSelection(
  branches: readonly string[],
  attribution: { readonly selectedIndex: number },
): ExactBranchSelection | null {
  const selected = branches[attribution.selectedIndex];
  if (!selected) return null;
  const normalized = normalizeBranchChoice(selected);
  if (!normalized) return null;
  return Object.freeze({
    selectedIndex: attribution.selectedIndex,
    branchCount: branches.length,
    selectedDigest: sha256(normalized),
    actionTag: classifyBranchAction(normalized),
    lengthBucket: lengthBucket(normalized),
    normalizationVersion: BRANCH_SEMANTIC_NORMALIZATION_VERSION,
  });
}

/** Stable positive-only ranker. The least-preferred item remains as the final exploration slot. */
export function rankBranchesByPreference(
  branches: readonly string[],
  tagCounts: Readonly<Partial<Record<BranchActionTag, number>>>,
): readonly string[] {
  if (branches.length < 2) return Object.freeze([...branches]);
  const total = BRANCH_ACTION_TAGS.reduce((sum, tag) => sum + Math.max(0, tagCounts[tag] ?? 0), 0);
  if (total === 0) return Object.freeze([...branches]);
  const rows = branches.map((branch, index) => ({
    branch,
    index,
    score: Math.max(0, tagCounts[classifyBranchAction(branch)] ?? 0),
  }));
  const exploration = [...rows].sort((left, right) => left.score - right.score || right.index - left.index)[0]!;
  const ranked = rows.filter((row) => row !== exploration)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return Object.freeze([...ranked.map((row) => row.branch), exploration.branch]);
}

function newProfile(scope: 'session' | 'card', row: BranchPreferenceEvidence): MutableProfile {
  return {
    scope,
    sessionId: scope === 'session' ? row.sessionId : null,
    cardId: row.cardId,
    contentMode: row.contentMode as 'nsf' | 'nsfw',
    sampleCount: 0,
    digests: new Set<string>(),
    tagCounts: Object.fromEntries(BRANCH_ACTION_TAGS.map((tag) => [tag, 0])) as Record<BranchActionTag, number>,
    positionCounts: {},
  };
}

function finish(profile: MutableProfile): BranchPreferenceProfile {
  const denominator = profile.sampleCount + BRANCH_ACTION_TAGS.length;
  const tagCounts = Object.freeze({ ...profile.tagCounts });
  const tagPosterior = Object.freeze(Object.fromEntries(BRANCH_ACTION_TAGS.map((tag) => (
    [tag, (profile.tagCounts[tag] + 1) / denominator]
  ))) as Record<BranchActionTag, number>);
  const positionCounts = Object.freeze(Object.fromEntries(
    Object.entries(profile.positionCounts).sort(([left], [right]) => Number(left) - Number(right)),
  ));
  return Object.freeze({
    scope: profile.scope,
    sessionId: profile.sessionId,
    cardId: profile.cardId,
    contentMode: profile.contentMode,
    sampleCount: profile.sampleCount,
    uniqueSelectionCount: profile.digests.size,
    tagCounts,
    tagPosterior,
    positionCounts,
  });
}

/** 纯正样本 Dirichlet profile；未点击/未选择不会被当作负样本。 */
export function rebuildBranchPreferenceProfiles(
  evidence: readonly BranchPreferenceEvidence[],
): BranchPreferenceProfiles {
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
    const valid = validEvidence(row);
    if (!valid) continue;
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
      profile.digests.add(row.subjectDigest);
      profile.tagCounts[valid.tag] += 1;
      const position = String(valid.selectedIndex);
      profile.positionCounts[position] = (profile.positionCounts[position] ?? 0) + 1;
      map.set(key, profile);
    }
  }
  const sort = (values: Iterable<MutableProfile>) => [...values]
    .sort((left, right) => `${left.sessionId ?? ''}\0${left.cardId}\0${left.contentMode}`
      .localeCompare(`${right.sessionId ?? ''}\0${right.cardId}\0${right.contentMode}`))
    .map(finish);
  return Object.freeze({ session: Object.freeze(sort(session.values())), card: Object.freeze(sort(card.values())) });
}
