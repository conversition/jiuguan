import { createHash } from 'node:crypto';
import {
  BRANCH_ACTION_TAGS,
  type BranchActionTag,
  type BranchPreferenceProfile,
} from './branch-preference.ts';
import {
  type PromptPreferenceDimension,
  type PromptPreferenceProfile,
} from './prompt-preference.ts';

/**
 * P16 C3.3 · 剧情方向与偏好的**语义沉淀**。
 *
 * 原始学习证据是「一票一票」的（用户点了哪个分支、第一句里出现了什么词）。直接把
 * 计数摊进提示词有两个问题：样本少且不全面，而且模型看到一堆零散计数并不知道
 * "接下来该往哪个方向写"。这里做一层**简练的沉淀**：
 *
 * 1. 把分支动作计数收敛成 **固定四条互不相同的语义方向**（见
 *    `DIRECTION_GUIDANCE_DIRECTIONS`）—— 这是用户的硬口径：偏好多集中都不许把方向压成一条，
 *    多样性是这份引导的前提；
 * 2. 把偏好标签按**维度轴**聚合，每轴只留计数最高的极性、最多两个标签；
 * 3. 排序一律**字节序**（刻意不用 `localeCompare`）：摘要必须与运行环境的 locale 无关，
 *    否则同一份存档在两台机器上会算出不同 digest，回读直接失效。
 *
 * 本模块是纯函数，不读磁盘、不写库、不知道 SQLite 与 HTTP。CAS（证据修订）由调用方以
 * `evidenceRevision` 传入，归学习层自己管。
 */
export const DIRECTION_GUIDANCE_VERSION = 'direction-guidance-v1' as const;

/** 用户口径：四条不同语义方向是必须的，不允许因为偏好集中而收窄。 */
export const DIRECTION_GUIDANCE_DIRECTIONS = 4;

/** 方向取自分支动作词表；`other` 是兜底分类不是方向，因此不参与方向槽位。 */
export const DIRECTION_GUIDANCE_DIRECTIONS_POOL = Object.freeze(
  BRANCH_ACTION_TAGS.filter((tag) => tag !== 'other'),
);

/** 单轴最多保留的标签数：沉淀要简练，不是把计数表原样搬进提示词。 */
const MAX_TAGS_PER_AXIS = 2;

export interface DirectionSlot {
  readonly action: BranchActionTag;
  /** 相对权重（0–100 的整数近似），四条方向的权重和约为 100。 */
  readonly weight: number;
  /** 是否高于均分：高于均分才值得"强化推进"，否则只是必须保留的一条方向。 */
  readonly preferred: boolean;
}

export interface PreferenceAxis {
  readonly axis: PromptPreferenceDimension;
  readonly polarity: 'like' | 'avoid';
  /** 展示用标签：该轴该极性里计数最高的若干个（简练，不是全量）。 */
  readonly tags: readonly string[];
  /** 该轴该极性的**证据总量**（含未展示的标签）：轴强度的真值，不因展示截断而缩水。 */
  readonly weight: number;
}

export interface DirectionGuidance {
  readonly version: typeof DIRECTION_GUIDANCE_VERSION;
  /** 恒为 `DIRECTION_GUIDANCE_DIRECTIONS` 条，`action` 互不相同。 */
  readonly directions: readonly DirectionSlot[];
  readonly axes: readonly PreferenceAxis[];
  readonly sampleCount: number;
  /** 学习层自管的 CAS 令牌（证据修订）；不是闭环层的修订权威。 */
  readonly evidenceRevision: string;
  /** 沉淀产物身份（含证据修订）：用于 proposal-persisted / apply-committed 的 artifactDigest。 */
  readonly digest: string;
  /** 方向那半边的摘要：`learning.branchPreference` 单独用它。 */
  readonly branchDigest: string;
  /** 偏好那半边的摘要：`learning.preference` 单独用它。 */
  readonly preferenceDigest: string;
}

/** 与 locale 无关的字节序比较：摘要不能随运行环境漂移。 */
function byBytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 与插入顺序无关的 JSON：同一份沉淀在任何序列化顺序下都得到同一个摘要。 */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).filter((key) => row[key] !== undefined).sort(byBytes)
    .map((key) => JSON.stringify(key) + ':' + stableJson(row[key])).join(',') + '}';
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function counter(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

/**
 * 方向沉淀：把分支动作计数收敛成**恰好四条**互不相同的方向。
 *
 * 候选池固定为五个非 `other` 动作，所以"取前四"永远成立 —— 证据为零时也不会
 * 退化成空列表或少于四条（否则模型会失去方向多样性）。
 */
function consolidateDirections(profile: BranchPreferenceProfile | null): readonly DirectionSlot[] {
  const counts = profile?.tagCounts ?? ({} as Readonly<Record<string, number>>);
  const scored = DIRECTION_GUIDANCE_DIRECTIONS_POOL.map((action) => ({
    action: action as BranchActionTag,
    count: counter(counts[action]),
  }));
  const total = scored.reduce((sum, item) => sum + item.count, 0);
  const ordered = [...scored].sort((left, right) => right.count - left.count || byBytes(left.action, right.action));
  const selected = ordered.slice(0, DIRECTION_GUIDANCE_DIRECTIONS);
  return Object.freeze(selected.map((item) => Object.freeze({
    action: item.action,
    weight: total === 0 ? 0 : Math.round((item.count / total) * 100),
    // 高于均分才叫"需要强化"；证据为空时四条方向等权，全部 false。
    preferred: total > 0 && item.count * DIRECTION_GUIDANCE_DIRECTIONS > total,
  })));
}

const TAG_SHAPE = /^(pace|tone|interaction|viewpoint|relationship|action)\.([a-z][a-z0-9_]*)\.(like|avoid)$/u;

/**
 * 偏好沉淀：按维度轴聚合，每轴只留计数更高的极性与最多两个标签。
 *
 * `conflictTags` 的粒度是 `维度.取值`（同一取值上 like / avoid 同时出现 —— 那一条用户自相矛盾），
 * 所以只丢**那个取值**，同轴的其它取值照常参与；整轴丢弃会把有效信号一起扔掉。
 */
function consolidateAxes(profile: PromptPreferenceProfile | null): readonly PreferenceAxis[] {
  if (!profile) return Object.freeze([]);
  const conflicts = new Set(profile.conflictTags);
  interface Bucket { axis: PromptPreferenceDimension; polarity: 'like' | 'avoid'; tags: Array<{ tag: string; count: number }>; }
  const buckets = new Map<string, Bucket>();
  for (const [tag, rawCount] of Object.entries(profile.tagCounts)) {
    const matched = TAG_SHAPE.exec(tag);
    if (!matched) continue;
    const count = counter(rawCount);
    if (count === 0) continue;
    const axis = matched[1] as PromptPreferenceDimension;
    if (conflicts.has(`${axis}.${matched[2]}`)) continue;
    const polarity = matched[3] as 'like' | 'avoid';
    const key = `${axis}\u0000${polarity}`;
    const bucket = buckets.get(key) ?? { axis, polarity, tags: [] };
    bucket.tags.push({ tag, count });
    buckets.set(key, bucket);
  }
  const perAxis = new Map<PromptPreferenceDimension, Bucket[]>();
  for (const bucket of buckets.values()) {
    const list = perAxis.get(bucket.axis) ?? [];
    list.push(bucket);
    perAxis.set(bucket.axis, list);
  }
  const axes: PreferenceAxis[] = [];
  for (const list of perAxis.values()) {
    const weight = (bucket: Bucket) => bucket.tags.reduce((sum, item) => sum + item.count, 0);
    // 同一维度只留更强的极性；完全并列时固定取 like，避免顺序敏感。
    const ordered = [...list].sort((left, right) => weight(right) - weight(left)
      || byBytes(left.polarity === 'like' ? '0' : '1', right.polarity === 'like' ? '0' : '1'));
    const winner = ordered[0]!;
    const tags = [...winner.tags]
      .sort((left, right) => right.count - left.count || byBytes(left.tag, right.tag))
      .slice(0, MAX_TAGS_PER_AXIS)
      .map((item) => item.tag);
    axes.push(Object.freeze({
      axis: winner.axis,
      polarity: winner.polarity,
      tags: Object.freeze(tags),
      weight: weight(winner),
    }));
  }
  return Object.freeze(axes.sort((left, right) => right.weight - left.weight || byBytes(left.axis, right.axis)));
}

export function consolidateDirectionGuidance(input: {
  readonly branch: BranchPreferenceProfile | null;
  readonly prompt: PromptPreferenceProfile | null;
  readonly evidenceRevision: string;
}): DirectionGuidance {
  const directions = consolidateDirections(input.branch);
  const axes = consolidateAxes(input.prompt);
  const sampleCount = Math.max(input.branch?.sampleCount ?? 0, input.prompt?.sampleCount ?? 0);
  const identity = { version: DIRECTION_GUIDANCE_VERSION, evidenceRevision: input.evidenceRevision };
  return Object.freeze({
    version: DIRECTION_GUIDANCE_VERSION,
    directions,
    axes,
    sampleCount,
    evidenceRevision: input.evidenceRevision,
    digest: sha256(stableJson({ ...identity, directions, axes })),
    branchDigest: sha256(stableJson({ ...identity, directions })),
    preferenceDigest: sha256(stableJson({ ...identity, axes })),
  });
}

/** 渲染后的提示词文本摘要：回读时用它比对"当初注入的就是现在读到的"。 */
export function directionGuidanceBlockDigest(block: string): string {
  return sha256(block);
}

/**
 * 把沉淀结果渲染成注入 prompt 的块。
 *
 * 口吻与既有的 `<学习偏好 trust="derived">` 一致：明确标注这份引导是**派生且可撤销**的，
 * 且玩家在本轮明确说出的要求永远优先。四条方向逐条列出，并显式要求模型保留它们的差异。
 */
export function renderDirectionGuidance(input: {
  /** 回读时只需要这两块就足以重放出当初注入的文本。 */
  readonly guidance: Pick<DirectionGuidance, 'directions' | 'axes'>;
  readonly scope: string;
}): string {
  const { guidance } = input;
  const directionList = guidance.directions.map((slot) => `${slot.action}(${slot.weight})`).join(' / ');
  const preferred = guidance.directions.filter((slot) => slot.preferred).map((slot) => slot.action);
  const tags = guidance.axes.flatMap((axis) => axis.tags);
  return `<学习偏好 scope="${input.scope}" trust="derived" directions="${guidance.directions.length}">\n`
    + `分支必须给出 ${guidance.directions.length} 条互不相同的语义方向，一条都不许省：${directionList}\n`
    + `其中需要强化推进：${preferred.length > 0 ? preferred.join(' / ') : '（暂无，四条方向等权）'}\n`
    + `已沉淀偏好：${tags.length > 0 ? tags.join(', ') : '（暂无）'}\n`
    + '以上标签来自可撤销学习证据；本轮玩家明确要求永远优先。\n'
    + '</学习偏好>';
}
