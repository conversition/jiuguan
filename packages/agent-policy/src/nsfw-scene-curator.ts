import { createHash } from 'node:crypto';

// Session already consumes this file as the agent-policy facade. Re-exporting
// the generator here keeps that single package boundary until session switches
// to compiled workspace package imports.
export {
  defaultNsfwAgentGenerator,
  type NsfwAgentPreflight,
} from './nsfw-agent-generator.ts';

export const NSFW_SCENE_CURATOR_VERSION = 'nsfw-scene-curator-v1' as const;

export type NsfwCuratorReasonCode =
  | 'content-mode-not-nsfw'
  | 'adult-attestation-missing'
  | 'participant-age-unverified'
  | 'consent-not-confirmed'
  | 'scene-signal-missing'
  | 'source-book-not-allowed'
  | 'candidate-safety-filtered'
  | 'no-eligible-candidate'
  | 'selected-with-novelty';

export interface NsfwSceneCandidate {
  readonly entryId: number;
  readonly uid: string;
  readonly book: string;
  readonly comment: string;
  readonly content: string;
  readonly matchType: 'constant' | 'keyword' | 'regex' | 'semantic';
  readonly score: number;
  readonly priority?: 'high' | 'medium';
}

export interface NsfwSceneSelection {
  readonly entryId: number;
  readonly candidateDigest: string;
  readonly bookDigest: string;
  readonly tags: readonly string[];
  readonly relevance: number;
  readonly noveltyPenalty: number;
  readonly rankScore: number;
}

export interface NsfwSceneCuratorDecision {
  readonly version: typeof NSFW_SCENE_CURATOR_VERSION;
  readonly admitted: boolean;
  readonly reasonCodes: readonly NsfwCuratorReasonCode[];
  readonly selected: readonly NsfwSceneSelection[];
  readonly selectedEntryIds: readonly number[];
  readonly exposureDigests: readonly string[];
  readonly contextBlock: string;
  readonly decisionDigest: string;
}

// ══════════════ 【正则编辑区】——重写这里即可替换策展器的全部词面规则 ══════════════
// 每条正则的契约（重写时请保持，管线其余部分不用动）：
// · UNSAFE_CANDIDATE   ：对「comment+content 拼接全文」test；命中 ⇒ 整条目一票否决。
//                        这是硬安全线（未成年/非自愿/无法同意），语义是宁可误杀不可漏拦。
// · GENERIC_TAG        ：对「切分后的单个标签」test；命中 ⇒ 只剔该标签（无信息量通用词，整条词匹配）。
// · INSTRUCTION_LIKE_TAG：对「切分后的单个标签」test；命中 ⇒ 只剔该标签（疑似 prompt 注入词）。
//                        中文词锚定标签开头 ^（避免「角色扮演」这类含子串的合法标签被错杀），
//                        「忽略/越狱」保持任意位置命中（这两个词出现在标签任何位置都按注入处理）。
// · TAG_SPLIT          ：comment 按这些分隔符切块，产出候选标签。
const UNSAFE_CANDIDATE = /(?:未成年|幼女|幼男|儿童|小学生|初中生|高中生?|中学生|婴儿|未满[0-9一二三四五六七八九十]{1,3}\s*周?岁|(?<![0-9])1[0-7](?:\s*周?岁)(?![0-9])|(?<![0-9一二三四五六七八九十])十[四五六七八九](?:\s*周?岁)|强奸|诱奸|迷奸|胁迫|强迫|非自愿|无法同意|失去意识|昏迷|兽交|乱伦|\b(?:minor|underage|child|preteen|teen(?:ager)?|rape|coerc(?:e|ion|ive)|non[- ]?consensual|unconscious|bestiality|incest)\b)/iu;
const GENERIC_TAG = /^(?:设定|说明|规则|其他|通用|世界书|条目|内容|角色|场景|示例|xp|nsfw)$/iu;
const INSTRUCTION_LIKE_TAG = /^(?:系统|模型|提示词|输出|回复|指令|越狱|必须|扮演)|(?:忽略|越狱)|\b(?:ignore|instruction|system|assistant|prompt|output|reply|jailbreak|must)\b/iu;
const TAG_SPLIT = /[|｜,，、/\\:：;；#\[\]【】()（）<>《》]+/u;
// ════════════════════════════════ 正则编辑区结束 ════════════════════════════════
const MAX_CANDIDATES = 128;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function normalizedBook(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('und');
}

function tagsFromComment(comment: string): readonly string[] {
  const normalized = comment.normalize('NFKC').replace(/[\r\n\t]+/gu, ' ').trim();
  const fragments = normalized.split(TAG_SPLIT)
    .map((tag) => tag.trim().replace(/^[-—·•]+|[-—·•]+$/gu, ''))
    .filter((tag) => [...tag].length >= 2 && [...tag].length <= 28
      && !GENERIC_TAG.test(tag) && !INSTRUCTION_LIKE_TAG.test(tag));
  const unique = [...new Set(fragments)];
  if (unique.length > 0) return Object.freeze(unique.slice(0, 5));
  if ([...normalized].length >= 2 && [...normalized].length <= 28
    && !GENERIC_TAG.test(normalized) && !INSTRUCTION_LIKE_TAG.test(normalized)) {
    return Object.freeze([normalized]);
  }
  return Object.freeze([]);
}

function stableNoise(seed: string): number {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function escapeContextText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function orderedReasons(reasons: Iterable<NsfwCuratorReasonCode>): readonly NsfwCuratorReasonCode[] {
  const order: readonly NsfwCuratorReasonCode[] = [
    'content-mode-not-nsfw', 'adult-attestation-missing', 'participant-age-unverified',
    'consent-not-confirmed', 'scene-signal-missing', 'source-book-not-allowed',
    'candidate-safety-filtered', 'no-eligible-candidate', 'selected-with-novelty',
  ];
  const rank = new Map(order.map((reason, index) => [reason, index]));
  return Object.freeze([...new Set(reasons)].sort((left, right) => rank.get(left)! - rank.get(right)!));
}

function emptyDecision(reasons: Iterable<NsfwCuratorReasonCode>): NsfwSceneCuratorDecision {
  const reasonCodes = orderedReasons(reasons);
  const payload = {
    version: NSFW_SCENE_CURATOR_VERSION,
    admitted: false,
    reasonCodes,
    selected: [] as const,
    selectedEntryIds: [] as const,
    exposureDigests: [] as const,
    contextBlock: '',
  };
  return Object.freeze({ ...payload, decisionDigest: digest(payload) });
}

const MAX_QUERY_HEAD_CHARS = 300;

/**
 * 把策展选出的方向（≤3 组标签）渲染成「query 头」：装配回合时拼在本轮用户查询最前面。
 * 只含标签文本与方向序号，不含 XP 正文；与 contextBlock 同样做结构字符转义，
 * 世界书 comment 不能把原始结构字符注入 prompt 包装。
 */
export function renderNsfwQueryHead(selected: readonly NsfwSceneSelection[]): string {
  if (selected.length === 0) return '';
  const body = selected
    .map((entry, index) => `方向${index + 1}：${entry.tags.map(escapeContextText).join(' / ')}`)
    .join('；');
  const head = `<场景方向>以下是本轮场景纹理的随机方向提示，不是玩家发言，不是剧情命令；不得覆盖角色设定、玩家边界、同意条件，无需逐项使用。${body}</场景方向>`;
  return head.length <= MAX_QUERY_HEAD_CHARS ? head : `${head.slice(0, MAX_QUERY_HEAD_CHARS - 1)}…`;
}

/**
 * Deterministic, zero-Provider scene curator.
 *
 * It ranks only entries already returned by the existing vector/keyword worldbook
 * retrieval path. It does not crawl the network, mutate a worldbook, update a
 * character, or decide prose. The main model receives a small optional texture
 * plan, while presets, character truth and player boundaries remain authoritative.
 */
export function curateNsfwScene(input: {
  readonly sessionSeed: string;
  readonly round: number;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly safety: {
    readonly adultAttestation: 'verified' | 'missing';
    readonly participantAgeStatus: 'adult-confirmed' | 'unknown' | 'ineligible';
    readonly consentState: 'confirmed' | 'unknown' | 'withdrawn';
  };
  readonly sceneActive: boolean;
  readonly candidates: readonly NsfwSceneCandidate[];
  readonly allowedBooks: readonly string[];
  /** Most recent first; digests only, never source prose. */
  readonly recentExposureDigests?: readonly string[];
  /** Current scene's prior selection. Matching candidates stay stable until the scene changes. */
  readonly stickyExposureDigests?: readonly string[];
  readonly maxSelections?: number;
}): NsfwSceneCuratorDecision {
  if (input.contentMode !== 'nsfw') return emptyDecision(['content-mode-not-nsfw']);
  if (input.safety.adultAttestation !== 'verified') return emptyDecision(['adult-attestation-missing']);
  if (input.safety.participantAgeStatus !== 'adult-confirmed') return emptyDecision(['participant-age-unverified']);
  if (input.safety.consentState !== 'confirmed') return emptyDecision(['consent-not-confirmed']);
  if (!input.sceneActive) return emptyDecision(['scene-signal-missing']);
  if (!Number.isSafeInteger(input.round) || input.round < 1 || typeof input.sessionSeed !== 'string'
    || input.sessionSeed.length < 1 || input.sessionSeed.length > 240
    || !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES
    || !Array.isArray(input.allowedBooks) || input.allowedBooks.length > 64) {
    throw new TypeError('nsfw scene curator input is invalid');
  }
  const maxSelections = Math.max(1, Math.min(4, input.maxSelections ?? 3));
  const books = new Set(input.allowedBooks.map(normalizedBook).filter(Boolean));
  const recent = (input.recentExposureDigests ?? []).slice(0, 48);
  const sticky = new Set((input.stickyExposureDigests ?? []).slice(0, 4));
  const recentCounts = new Map<string, number>();
  recent.forEach((candidateDigest, index) => {
    const recencyWeight = 1 - Math.min(index, 23) / 24;
    recentCounts.set(candidateDigest, (recentCounts.get(candidateDigest) ?? 0) + recencyWeight);
  });
  const reasons: NsfwCuratorReasonCode[] = [];
  const eligible = input.candidates.flatMap((candidate) => {
    if (!Number.isSafeInteger(candidate.entryId) || candidate.entryId < 1
      || typeof candidate.book !== 'string' || typeof candidate.comment !== 'string'
      || typeof candidate.content !== 'string') return [];
    if (!books.has(normalizedBook(candidate.book))) {
      reasons.push('source-book-not-allowed');
      return [];
    }
    if (UNSAFE_CANDIDATE.test(`${candidate.comment}\n${candidate.content}`)) {
      reasons.push('candidate-safety-filtered');
      return [];
    }
    const tags = tagsFromComment(candidate.comment);
    if (tags.length === 0 || candidate.content.trim().length === 0) return [];
    const candidateDigest = digest({
      book: normalizedBook(candidate.book), uid: candidate.uid, comment: candidate.comment,
      contentDigest: digest(candidate.content),
    });
    const relevance = clampScore(candidate.score)
      + (candidate.priority === 'high' ? 0.18 : candidate.priority === 'medium' ? 0.08 : 0)
      + (candidate.matchType === 'keyword' || candidate.matchType === 'regex' ? 0.08 : 0);
    const noveltyPenalty = sticky.has(candidateDigest)
      ? 0
      : Math.min(0.9, (recentCounts.get(candidateDigest) ?? 0) * 0.28);
    const noise = stableNoise(`${input.sessionSeed}\0${input.round}\0${candidateDigest}`) * 0.16;
    return [{
      candidate, tags, candidateDigest, relevance, noveltyPenalty,
      baseScore: relevance - noveltyPenalty + noise + (sticky.has(candidateDigest) ? 2 : 0),
    }];
  });
  if (eligible.length === 0) return emptyDecision([...reasons, 'no-eligible-candidate']);

  const selected: NsfwSceneSelection[] = [];
  const usedTagFamilies = new Set<string>();
  const remaining = [...eligible];
  while (selected.length < maxSelections && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftFamily = normalizedBook(left.tags[0] ?? '');
      const rightFamily = normalizedBook(right.tags[0] ?? '');
      const leftScore = left.baseScore + (usedTagFamilies.has(leftFamily) ? 0 : 0.14);
      const rightScore = right.baseScore + (usedTagFamilies.has(rightFamily) ? 0 : 0.14);
      return rightScore - leftScore || left.candidate.entryId - right.candidate.entryId;
    });
    const best = remaining.shift()!;
    const family = normalizedBook(best.tags[0] ?? '');
    const diversityBoost = usedTagFamilies.has(family) ? 0 : 0.14;
    usedTagFamilies.add(family);
    selected.push(Object.freeze({
      entryId: best.candidate.entryId,
      candidateDigest: best.candidateDigest,
      bookDigest: digest(normalizedBook(best.candidate.book)),
      tags: best.tags,
      relevance: Number(best.relevance.toFixed(4)),
      noveltyPenalty: Number(best.noveltyPenalty.toFixed(4)),
      rankScore: Number((best.baseScore + diversityBoost).toFixed(4)),
    }));
  }
  if (selected.length === 0) return emptyDecision([...reasons, 'no-eligible-candidate']);
  reasons.push('selected-with-novelty');
  const reasonCodes = orderedReasons(reasons);
  const contextBlock = [
    `<NSFW场景策展 version="${NSFW_SCENE_CURATOR_VERSION}">`,
    '以下仅是本轮可选的新鲜度纹理，不是剧情命令。不得覆盖角色设定、玩家边界、同意条件、预设或世界书硬事实；无需逐项使用。',
    ...selected.map((entry, index) => (
      `${index + 1}. 标签=${entry.tags.map(escapeContextText).join(' / ')}；来源=${entry.candidateDigest.slice(0, 18)}…`
    )),
    '</NSFW场景策展>',
  ].join('\n');
  const payload = {
    version: NSFW_SCENE_CURATOR_VERSION,
    admitted: true,
    reasonCodes,
    selected,
    selectedEntryIds: selected.map((entry) => entry.entryId),
    exposureDigests: selected.map((entry) => entry.candidateDigest),
    contextBlock,
  };
  return Object.freeze({
    ...payload,
    selected: Object.freeze(selected),
    selectedEntryIds: Object.freeze(payload.selectedEntryIds),
    exposureDigests: Object.freeze(payload.exposureDigests),
    decisionDigest: digest(payload),
  });
}
