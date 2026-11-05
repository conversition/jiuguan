/** @author Codex @date 2026-10-18 @version 1.0
 * 发布总览（只读）：把「候选记录 × 采用回执 × Channel 指针」拼成一张操作者能看的表。
 *
 * 边界：
 * 1) 纯读：不写任何 Store、不做 CAS、不代替体检；
 * 2) `promotable` 只是**廉价提示**（validated/rev2 且有采用回执），**不等于**体检 ready——
 *    真正的门是 `skill-promotion-preflight-v1`（三段证据同源）；
 * 3) 输出不含正文、证据集、正文摘要以外的任何内容；排序稳定（码点），便于 diff。
 */
import { types as nodeTypes } from 'node:util';

export const SKILL_PROMOTION_OVERVIEW_VERSION = 'skill-promotion-overview-v2' as const;

/**
 * **廉价**阻断码：只由候选记录 + 采用回执 + Channel 指针推出，不做证据汇合、不做裁决。
 * 真正的门是 `skill-promotion-preflight-v1`；这里只用来让操作者一眼看到「大概卡在哪」。
 * 闭集，按码点排序。
 */
export const SKILL_PROMOTION_CHEAP_BLOCKERS = Object.freeze([
    'adoption-missing',
    'candidate-not-validated-rev2',
    'already-pointed',
] as const);
export type SkillPromotionCheapBlocker = typeof SKILL_PROMOTION_CHEAP_BLOCKERS[number];

export interface SkillPromotionOverviewCandidate {
    readonly candidateId: string;
    readonly state: string;
    readonly revision: number;
    readonly adoptionDigest: string | null;
    readonly joinDigest: string | null;
    readonly adoptedAt: string | null;
    /** 该候选当前被哪些 Channel 指针指着（码点排序）。 */
    readonly channels: readonly string[];
    /** 廉价提示：state=validated && revision=2 && 有采用回执。**不是**体检结论。 */
    readonly promotable: boolean;
    /**
     * 廉价阻断（闭集、码点排序）。`already-pointed` 表示某个 Channel 已指向该候选，
     * 不代表失败——重复发布会走 CAS 幂等；这里只是提示「已经在位」。
     */
    readonly cheapBlockers: readonly SkillPromotionCheapBlocker[];
}

export interface SkillPromotionOverviewChannel {
    readonly channelId: string;
    readonly revision: number;
    readonly candidateId: string;
    readonly adoptionDigest: string;
    readonly verdictDigest: string;
    readonly promotedAt: string;
}

export interface SkillPromotionOverview {
    readonly overviewVersion: typeof SKILL_PROMOTION_OVERVIEW_VERSION;
    readonly writesEnabled: boolean;
    readonly candidates: readonly SkillPromotionOverviewCandidate[];
    readonly channels: readonly SkillPromotionOverviewChannel[];
    readonly nextCursor: number;
    readonly hasMore: boolean;
    /** 读取时有记录无法归一化（损坏）⇒ 只计数，不泄露内容，也不因此中断整页。 */
    readonly skipped: number;
    readonly generatedAt: string;
}

export interface SkillPromotionOverviewPorts {
    readonly listCandidates: (input: { readonly limit: number; readonly cursor: number }) => Readonly<{
        readonly records: readonly Readonly<{
            candidateId: string; state: string; revision: number;
        }>[];
        readonly nextCursor: number;
        readonly hasMore: boolean;
        readonly failed?: number;
    }>;
    readonly readAdoption: (candidateId: string) => Readonly<{
        readonly revision: number;
        readonly adoption: Readonly<{
            readonly adoptionDigest: string;
            readonly joinDigest: string;
            readonly adoptedAt: string;
        }> | null;
    }> | null;
    readonly listPointers: () => readonly Readonly<{
        channelId: string; revision: number; candidateId: string;
        adoptionDigest: string; verdictDigest: string; promotedAt: string;
    }>[];
    readonly writesEnabled: boolean;
    readonly now: () => string;
}

const HASH = /^sha256:[a-f0-9]{64}$/u;

function reject(): never {
    throw new Error('skill-promotion-overview-input-invalid');
}

export function buildSkillPromotionOverview(
    ports: SkillPromotionOverviewPorts,
    input: { readonly limit?: number; readonly cursor?: number } = {},
): SkillPromotionOverview {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || nodeTypes.isProxy(input)) reject();
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string' || !['limit', 'cursor'].includes(key))) reject();
    const limit = input.limit ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) reject();
    const cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) reject();

    const page = ports.listCandidates({ limit, cursor });
    const pointers = ports.listPointers();
    const byCandidate = new Map<string, string[]>();
    for (const pointer of pointers) {
        const list = byCandidate.get(pointer.candidateId) ?? [];
        list.push(pointer.channelId);
        byCandidate.set(pointer.candidateId, list);
    }

    let skipped = 0;
    const candidates: SkillPromotionOverviewCandidate[] = [];
    for (const record of page.records) {
        let adoption: Readonly<{ adoptionDigest: string; joinDigest: string; adoptedAt: string }> | null = null;
        try {
            const state = ports.readAdoption(record.candidateId);
            if (state?.adoption
                && HASH.test(state.adoption.adoptionDigest) && HASH.test(state.adoption.joinDigest)) {
                adoption = state.adoption;
            }
        } catch { skipped += 1; }
        const channels = Object.freeze([...(byCandidate.get(record.candidateId) ?? [])].sort());
        const cheap: SkillPromotionCheapBlocker[] = [];
        if (!adoption) cheap.push('adoption-missing');
        if (record.state !== 'validated' || record.revision !== 2) {
            cheap.push('candidate-not-validated-rev2');
        }
        if (channels.length > 0) cheap.push('already-pointed');
        candidates.push(Object.freeze({
            candidateId: record.candidateId,
            state: String(record.state),
            revision: Number(record.revision),
            adoptionDigest: adoption ? adoption.adoptionDigest : null,
            joinDigest: adoption ? adoption.joinDigest : null,
            adoptedAt: adoption ? adoption.adoptedAt : null,
            channels,
            promotable: Boolean(adoption) && record.state === 'validated' && record.revision === 2,
            cheapBlockers: Object.freeze(cheap.sort() as SkillPromotionCheapBlocker[]),
        }));
    }

    return Object.freeze({
        overviewVersion: SKILL_PROMOTION_OVERVIEW_VERSION,
        writesEnabled: ports.writesEnabled,
        candidates: Object.freeze(candidates),
        channels: Object.freeze(pointers.map((pointer) => Object.freeze({
            channelId: pointer.channelId,
            revision: Number(pointer.revision),
            candidateId: pointer.candidateId,
            adoptionDigest: pointer.adoptionDigest,
            verdictDigest: pointer.verdictDigest,
            promotedAt: pointer.promotedAt,
        })).sort((left, right) => (left.channelId < right.channelId ? -1
            : left.channelId > right.channelId ? 1 : 0))),
        nextCursor: Number(page.nextCursor),
        hasMore: Boolean(page.hasMore),
        skipped: skipped + Number(page.failed ?? 0),
        generatedAt: ports.now(),
    });
}
