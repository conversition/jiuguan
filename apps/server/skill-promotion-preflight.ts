/** @author Codex @date 2026-10-18 @version 1.0
 * D-Q3a2c 收口：发布前置体检（只读）。
 *
 * 为什么需要它：`adoption` 只记 joinDigest，`verdict` 只记自己的 qualitySuiteId，
 * 两者之间没有显式边 ⇒ 一份「别的批次判 better」的裁决可以被拿来给这条候选开路。
 * 本模块不改任何状态，只回答一个问题：**这三段证据是否真的指向同一条候选、同一批执行**。
 *
 * 边界：
 * 1) 纯只读：不写 Store、不做 CAS、不授予 promotion（固定 `authorizesPromotion=false`）；
 * 2) 阻断项是闭集代码，按码点排序，顺序稳定；`state` 只有 ready / already-promoted / blocked；
 * 3) 任何一步不能重新归一化 ⇒ 一律 fail closed（当作阻断，不当作「大概没问题」）；
 * 4) 体检通过只说明「可以把这三个对象交给 promote 的 CAS」，不说明质量、不说明线上生效。
 */
import { types as nodeTypes } from 'node:util';
import {
    evalDigest, evalFreeze, evalHash, evalTime, evalToken,
} from './skill-evaluate-data.ts';
import {
    readSkillQualityEvidenceJoin, type SkillEvidenceJoin,
} from './skill-evidence-join.ts';
import {
    readSkillQualityVerdict, type SkillQualityVerdict,
} from './skill-quality-verdict.ts';
import type { SkillCandidateAdoptionReceipt } from './skill-candidate-adoption-store.ts';
import type { SkillChannelPointer } from './skill-candidate-promotion-store.ts';

export const SKILL_PROMOTION_PREFLIGHT_VERSION = 'skill-promotion-preflight-v1' as const;

/** 闭集阻断码：一条 = 一个必须修掉的证据缺口，不做自然语言拼接。 */
export const SKILL_PROMOTION_PREFLIGHT_BLOCKERS = Object.freeze([
    'adoption-missing',
    'candidate-not-validated-rev2',
    'join-invalid',
    'join-digest-mismatch',
    'verdict-invalid',
    'verdict-not-better',
    'verdict-suite-mismatch',
    'pointer-inconsistent',
] as const);
export type SkillPromotionPreflightBlocker = typeof SKILL_PROMOTION_PREFLIGHT_BLOCKERS[number];

export const SKILL_PROMOTION_PREFLIGHT_ERROR_CODES = Object.freeze([
    'skill-promotion-preflight-input-invalid',
    'skill-promotion-preflight-digest-mismatch',
    'skill-promotion-preflight-channel-unavailable',
] as const);
export type SkillPromotionPreflightErrorCode =
    typeof SKILL_PROMOTION_PREFLIGHT_ERROR_CODES[number];

export class SkillPromotionPreflightError extends Error {
    constructor(readonly code: SkillPromotionPreflightErrorCode) {
        if (!(SKILL_PROMOTION_PREFLIGHT_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-promotion-preflight-error-code-invalid');
        }
        super(code);
        this.name = 'SkillPromotionPreflightError';
    }
}

export interface SkillPromotionPreflightPorts {
    readonly adoption: {
        read(candidateId: string): Readonly<{
            readonly candidateId: string;
            readonly revision: number;
            readonly adoption: SkillCandidateAdoptionReceipt | null;
        }> | null;
    };
    readonly candidate: {
        readCandidate(candidateId: string): Readonly<{
            readonly state: string;
            readonly revision: number;
        }> | null;
    };
    readonly channel: {
        readPointer(channelId: string): SkillChannelPointer | null;
    };
}

export interface SkillPromotionPreflightInput {
    readonly candidateId: string;
    readonly channelId: string;
    readonly join: SkillEvidenceJoin;
    readonly verdict: SkillQualityVerdict;
    readonly ports: SkillPromotionPreflightPorts;
    readonly checkedAt: string;
}

export interface SkillPromotionPreflight {
    readonly preflightVersion: typeof SKILL_PROMOTION_PREFLIGHT_VERSION;
    readonly candidateId: string;
    readonly channelId: string;
    readonly state: 'ready' | 'already-promoted' | 'blocked';
    readonly blockers: readonly SkillPromotionPreflightBlocker[];
    readonly candidateState: string | null;
    readonly candidateRevision: number | null;
    readonly adoptionDigest: string | null;
    readonly joinDigest: string | null;
    readonly verdictDigest: string | null;
    /** 操作者把它原样交给 promote 的 CAS；新通道为 0。 */
    readonly expectedChannelRevision: number;
    readonly currentPointerDigest: string | null;
    readonly authorizesPromotion: false;
    readonly checkedAt: string;
    readonly preflightDigest: string;
}

const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/u;

function reject(code: SkillPromotionPreflightErrorCode): never {
    throw new SkillPromotionPreflightError(code);
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('skill-promotion-preflight-input-invalid');
    return value;
}

function channelId(value: unknown): string {
    if (typeof value !== 'string' || !CHANNEL.test(value)) reject('skill-promotion-preflight-input-invalid');
    return value;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        reject('skill-promotion-preflight-input-invalid');
    }
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        reject('skill-promotion-preflight-input-invalid');
    }
    return input as Record<string, unknown>;
}

function list(input: unknown): readonly unknown[] {
    if (!Array.isArray(input) || nodeTypes.isProxy(input)) {
        reject('skill-promotion-preflight-input-invalid');
    }
    return input as readonly unknown[];
}

function sortedBlockers(values: Iterable<SkillPromotionPreflightBlocker>): readonly SkillPromotionPreflightBlocker[] {
    // 码点排序（禁 localeCompare）：同一输入在任何主机上写出同一摘要。
    return evalFreeze([...new Set(values)].sort() as SkillPromotionPreflightBlocker[]);
}

/**
 * 只读体检：三段证据是否指向同一条候选、同一批执行，以及当前 Channel 指针位置。
 * 候选和采用读取异常折算为阻断；Channel 读取失败不能当作新通道，直接报错。
 */
export function checkSkillPromotionPreflight(input: SkillPromotionPreflightInput): SkillPromotionPreflight {
    const value = record(input, ['candidateId', 'channelId', 'join', 'verdict', 'ports', 'checkedAt']);
    const candidateId = token(value.candidateId);
    const id = channelId(value.channelId);
    const checkedAt = evalTime(value.checkedAt);
    const ports = value.ports as SkillPromotionPreflightPorts;
    if (!ports || typeof ports.adoption?.read !== 'function'
        || typeof ports.candidate?.readCandidate !== 'function'
        || typeof ports.channel?.readPointer !== 'function') {
        reject('skill-promotion-preflight-input-invalid');
    }

    const blockers: SkillPromotionPreflightBlocker[] = [];
    let join: SkillEvidenceJoin | null = null;
    try { join = readSkillQualityEvidenceJoin(value.join); }
    catch { blockers.push('join-invalid'); }
    let verdict: SkillQualityVerdict | null = null;
    try { verdict = readSkillQualityVerdict(value.verdict); }
    catch { blockers.push('verdict-invalid'); }

    let adoptionState: ReturnType<SkillPromotionPreflightPorts['adoption']['read']> = null;
    try { adoptionState = ports.adoption.read(candidateId); }
    catch { adoptionState = null; }
    const receipt = adoptionState && adoptionState.candidateId === candidateId
        ? adoptionState.adoption : null;
    if (!receipt) blockers.push('adoption-missing');

    let candidate: ReturnType<SkillPromotionPreflightPorts['candidate']['readCandidate']> = null;
    try { candidate = ports.candidate.readCandidate(candidateId); }
    catch { candidate = null; }
    if (!candidate || candidate.state !== 'validated' || candidate.revision !== 2) {
        blockers.push('candidate-not-validated-rev2');
    }

    // 采用回执 ↔ 汇合证据：必须逐字同一条。
    if (receipt && join && receipt.joinDigest !== join.joinDigest) {
        blockers.push('join-digest-mismatch');
    }
    // 裁决 ↔ 汇合证据：裁决必须针对同一批 Quality 执行。
    if (verdict && verdict.verdict !== 'candidate-better') blockers.push('verdict-not-better');
    if (verdict && join && verdict.qualitySuiteId !== join.qualitySuiteId) {
        blockers.push('verdict-suite-mismatch');
    }

    let pointer: SkillChannelPointer | null = null;
    try { pointer = ports.channel.readPointer(id); }
    catch { reject('skill-promotion-preflight-channel-unavailable'); }
    const sameCandidate = Boolean(pointer && receipt
        && pointer.candidateId === candidateId
        && pointer.adoptionDigest === receipt.adoptionDigest);
    // 指针已指向本候选、但证据链本身就断了 ⇒ 不是「已发布」，是状态不一致。
    if (sameCandidate && (blockers.length > 0 || !verdict || !receipt)) {
        blockers.push('pointer-inconsistent');
    }

    const unique = sortedBlockers(blockers);
    const state: SkillPromotionPreflight['state'] = unique.length > 0
        ? 'blocked' : sameCandidate ? 'already-promoted' : 'ready';
    const core = {
        preflightVersion: SKILL_PROMOTION_PREFLIGHT_VERSION,
        candidateId,
        channelId: id,
        state,
        blockers: unique,
        candidateState: candidate ? String(candidate.state) : null,
        candidateRevision: candidate ? Number(candidate.revision) : null,
        adoptionDigest: receipt ? receipt.adoptionDigest : null,
        joinDigest: join ? join.joinDigest : null,
        verdictDigest: verdict ? verdict.verdictDigest : null,
        expectedChannelRevision: pointer ? pointer.revision : 0,
        currentPointerDigest: pointer ? pointer.pointerDigest : null,
        authorizesPromotion: false as const,
        checkedAt,
    };
    return evalFreeze({ ...core, preflightDigest: evalDigest(core) });
}

/** 回读：重新归一化并重算摘要；改 state、改阻断项、改指针位置一律拒绝。 */
export function readSkillPromotionPreflight(input: unknown): SkillPromotionPreflight {
    const value = record(input, ['preflightVersion', 'candidateId', 'channelId', 'state',
        'blockers', 'candidateState', 'candidateRevision', 'adoptionDigest', 'joinDigest',
        'verdictDigest', 'expectedChannelRevision', 'currentPointerDigest',
        'authorizesPromotion', 'checkedAt', 'preflightDigest']);
    if (value.preflightVersion !== SKILL_PROMOTION_PREFLIGHT_VERSION
        || !['ready', 'already-promoted', 'blocked'].includes(String(value.state))
        || value.authorizesPromotion !== false) {
        reject('skill-promotion-preflight-input-invalid');
    }
    const blockers = sortedBlockers(list(value.blockers).map((item) => {
        if (typeof item !== 'string'
            || !(SKILL_PROMOTION_PREFLIGHT_BLOCKERS as readonly string[]).includes(item)) {
            reject('skill-promotion-preflight-input-invalid');
        }
        return item as SkillPromotionPreflightBlocker;
    }));
    if (blockers.length !== list(value.blockers).length) {
        reject('skill-promotion-preflight-input-invalid');
    }
    const nullableHash = (raw: unknown): string | null => {
        if (raw === null) return null;
        if (typeof raw !== 'string' || !HASH.test(raw)) reject('skill-promotion-preflight-input-invalid');
        return raw;
    };
    const nullableString = (raw: unknown): string | null => {
        if (raw === null) return null;
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
            reject('skill-promotion-preflight-input-invalid');
        }
        return raw;
    };
    if (!Number.isSafeInteger(value.candidateRevision ?? 0)
        || !Number.isSafeInteger(value.expectedChannelRevision)
        || Number(value.expectedChannelRevision) < 0) {
        reject('skill-promotion-preflight-input-invalid');
    }
    const core = {
        preflightVersion: SKILL_PROMOTION_PREFLIGHT_VERSION,
        candidateId: token(value.candidateId),
        channelId: channelId(value.channelId),
        state: value.state as SkillPromotionPreflight['state'],
        blockers,
        candidateState: nullableString(value.candidateState),
        candidateRevision: value.candidateRevision === null ? null : Number(value.candidateRevision),
        adoptionDigest: nullableHash(value.adoptionDigest),
        joinDigest: nullableHash(value.joinDigest),
        verdictDigest: nullableHash(value.verdictDigest),
        expectedChannelRevision: Number(value.expectedChannelRevision),
        currentPointerDigest: nullableHash(value.currentPointerDigest),
        authorizesPromotion: false as const,
        checkedAt: evalTime(value.checkedAt),
    };
    // state 必须与阻断项自洽：blocked ⇔ 至少一个阻断码。
    if ((core.state === 'blocked') !== (blockers.length > 0)) {
        reject('skill-promotion-preflight-digest-mismatch');
    }
    if (value.preflightDigest !== evalDigest(core)) {
        reject('skill-promotion-preflight-digest-mismatch');
    }
    return evalFreeze({ ...core, preflightDigest: evalHash(value.preflightDigest) });
}
