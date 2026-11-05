/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2b2c：按显式坐标汇合 24 个 Sample execution packet、48 个 Candidate arm 结算与
 * 48 个 Quality judge 执行。
 *
 * 铁律：
 * 1) 绝不对两个 48 元素数组按 ordinal 直接 zip；一切都以 (scenarioOrdinal, repeatIndex, arm)
 *    或 (sampleJobId, judgeSlot) 为键，双向核对集合相等。
 * 2) 汇合只证明「同一批坐标上发生了这些调用、摘要互相吻合」，不产生质量裁决、胜者或采用权。
 * 3) 任一处缺坐标、重复坐标、摘要不吻合即 fail closed。
 */
import { types as nodeTypes } from 'node:util';
import { evalDigest, evalFreeze, evalHash, evalRawDigest, evalRecord, evalTime, evalToken } from './skill-evaluate-data.ts';
import {
    SKILL_SAMPLE_SUITE_PAIR_COUNT,
    SKILL_SAMPLE_SUITE_REPEAT_COUNT,
    SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
    SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS,
} from './skill-sample-registry.ts';
import { SKILL_QUALITY_TOTAL_MODEL_CALLS } from './skill-quality-registry.ts';

export const SKILL_QUALITY_EVIDENCE_JOIN_VERSION = 'skill-quality-evidence-join-v1' as const;
export const SKILL_EVIDENCE_JOIN_SCENARIO_COUNT = SKILL_SAMPLE_SUITE_SCENARIO_COUNT;
export const SKILL_EVIDENCE_JOIN_REPEAT_COUNT = SKILL_SAMPLE_SUITE_REPEAT_COUNT;
export const SKILL_EVIDENCE_JOIN_SAMPLE_COUNT = SKILL_SAMPLE_SUITE_PAIR_COUNT;
export const SKILL_EVIDENCE_JOIN_ARM_COUNT = SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS;
export const SKILL_EVIDENCE_JOIN_JUDGE_COUNT = SKILL_QUALITY_TOTAL_MODEL_CALLS;

export const SKILL_EVIDENCE_JOIN_ERROR_CODES = Object.freeze([
    'skill-evidence-join-input-invalid',
    'skill-evidence-join-coordinate-missing',
    'skill-evidence-join-coordinate-duplicate',
    'skill-evidence-join-coordinate-mismatch',
    'skill-evidence-join-digest-mismatch',
] as const);
export type SkillEvidenceJoinErrorCode = typeof SKILL_EVIDENCE_JOIN_ERROR_CODES[number];

export class SkillEvidenceJoinError extends Error {
    constructor(readonly code: SkillEvidenceJoinErrorCode) {
        if (!(SKILL_EVIDENCE_JOIN_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-evidence-join-error-code-invalid');
        }
        super(code);
        this.name = 'SkillEvidenceJoinError';
    }
}

export type SkillEvidenceArm = 'baseline' | 'candidate';
export type SkillEvidenceJudgeSlot = 'judge-a' | 'judge-b';

export interface SkillEvidenceJoinSample {
    readonly sampleJobId: string;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly planDigest: string;
    readonly samplePacketDigest: string;
    readonly executionDigest: string;
    readonly arms: readonly Readonly<{
        variant: SkillEvidenceArm;
        sampleResponseDigest: string;
        candidateReceiptDigest: string;
        candidateResponseDigest: string | null;
        commonResponseBinding: string;
    }>[];
}

export interface SkillEvidenceJoinArm {
    readonly sampleKey: string;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly arm: SkillEvidenceArm;
    readonly planDigest: string;
    readonly outcome: 'passed' | 'failed' | 'inconclusive' | 'invalid';
    readonly receiptDigest: string;
    readonly responseDigest: string | null;
}

export interface SkillEvidenceJoinJudge {
    readonly jobId: string;
    readonly sampleJobId: string;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly judgeSlot: SkillEvidenceJudgeSlot;
    readonly judgeOrdinal: number;
    readonly outcome: 'passed' | 'failed' | 'inconclusive' | 'invalid';
    readonly packetDigest: string;
    readonly receiptDigest: string;
}

export interface SkillEvidenceJoinedRow {
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly sampleJobId: string;
    readonly samplePacketDigest: string;
    readonly executionDigest: string;
    readonly arms: readonly Readonly<{
        variant: SkillEvidenceArm;
        receiptDigest: string;
        candidateResponseDigest: string | null;
        sampleResponseDigest: string;
        commonResponseBinding: string;
    }>[];
    readonly judges: readonly Readonly<{
        judgeSlot: SkillEvidenceJudgeSlot;
        judgeOrdinal: number;
        jobId: string;
        packetDigest: string;
        receiptDigest: string;
    }>[];
}

export interface SkillEvidenceJoin {
    readonly joinVersion: typeof SKILL_QUALITY_EVIDENCE_JOIN_VERSION;
    readonly sampleSuiteId: string;
    readonly candidateBatchId: string;
    readonly qualitySuiteId: string;
    readonly coordinates: readonly SkillEvidenceJoinedRow[];
    readonly coverage: Readonly<{
        samples: typeof SKILL_EVIDENCE_JOIN_SAMPLE_COUNT;
        arms: typeof SKILL_EVIDENCE_JOIN_ARM_COUNT;
        judges: typeof SKILL_EVIDENCE_JOIN_JUDGE_COUNT;
        baselinePassed: number; candidatePassed: number;
    }>;
    readonly providerExecution: 'unverified';
    readonly qualityVerdict: 'not-declared';
    readonly winner: 'not-declared';
    readonly promotionEligible: false;
    readonly joinedAt: string;
    readonly joinDigest: string;
}

const MAX_ITEMS = 64;

function reject(code: SkillEvidenceJoinErrorCode): never {
    throw new SkillEvidenceJoinError(code);
}

function rowOf(input: unknown, keys: readonly string[]): Record<string, unknown> {
    try { return evalRecord(input, keys); }
    catch { return reject('skill-evidence-join-input-invalid'); }
}

function listOf(input: unknown, minimum: number, maximum: number): readonly unknown[] {
    if (!Array.isArray(input) || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
        || input.length < minimum || input.length > maximum) reject('skill-evidence-join-input-invalid');
    return input;
}

function coordinate(value: unknown, maximum: number): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= maximum) {
        reject('skill-evidence-join-input-invalid');
    }
    return Number(value);
}

function armOf(value: unknown): SkillEvidenceArm {
    if (value !== 'baseline' && value !== 'candidate') reject('skill-evidence-join-input-invalid');
    return value;
}

function slotOf(value: unknown): SkillEvidenceJudgeSlot {
    if (value !== 'judge-a' && value !== 'judge-b') reject('skill-evidence-join-input-invalid');
    return value;
}

function outcomeOf(value: unknown): SkillEvidenceJoinArm['outcome'] {
    if (value !== 'passed' && value !== 'failed' && value !== 'inconclusive' && value !== 'invalid') {
        reject('skill-evidence-join-input-invalid');
    }
    return value;
}

function sampleKeyOf(scenarioOrdinal: number, repeatIndex: number): string {
    return `${scenarioOrdinal}:${repeatIndex}`;
}

function normalizeSample(input: unknown): SkillEvidenceJoinSample {
    const value = rowOf(input, ['sampleJobId', 'scenarioOrdinal', 'repeatIndex', 'planDigest',
        'samplePacketDigest', 'executionDigest', 'arms']);
    const arms = listOf(value.arms, 2, 2);
    const normalizedArms = arms.map((item) => {
        const arm = rowOf(item, ['variant', 'sampleResponseDigest', 'candidateReceiptDigest',
            'candidateResponseDigest', 'commonResponseBinding']);
        const variant = armOf(arm.variant);
        return evalFreeze({
            variant,
            sampleResponseDigest: evalHash(arm.sampleResponseDigest),
            candidateReceiptDigest: evalHash(arm.candidateReceiptDigest),
            candidateResponseDigest: arm.candidateResponseDigest === null
                ? null : evalHash(arm.candidateResponseDigest),
            commonResponseBinding: evalHash(arm.commonResponseBinding),
        });
    });
    const variants = new Set(normalizedArms.map((item) => item.variant));
    if (variants.size !== 2 || !variants.has('baseline') || !variants.has('candidate')) {
        reject('skill-evidence-join-input-invalid');
    }
    return evalFreeze({
        sampleJobId: evalToken(value.sampleJobId),
        scenarioOrdinal: coordinate(value.scenarioOrdinal, SKILL_EVIDENCE_JOIN_SCENARIO_COUNT),
        repeatIndex: coordinate(value.repeatIndex, SKILL_EVIDENCE_JOIN_REPEAT_COUNT),
        planDigest: evalHash(value.planDigest),
        samplePacketDigest: evalHash(value.samplePacketDigest),
        executionDigest: evalHash(value.executionDigest),
        arms: normalizedArms as unknown as SkillEvidenceJoinSample['arms'],
    });
}

function normalizeArm(input: unknown): SkillEvidenceJoinArm {
    const value = rowOf(input, ['sampleKey', 'scenarioOrdinal', 'repeatIndex', 'arm', 'planDigest',
        'outcome', 'receiptDigest', 'responseDigest']);
    const outcome = outcomeOf(value.outcome);
    const responseDigest = value.responseDigest === null ? null : evalHash(value.responseDigest);
    if ((outcome === 'passed') !== (responseDigest !== null)) {
        reject('skill-evidence-join-input-invalid');
    }
    return evalFreeze({
        sampleKey: evalToken(value.sampleKey),
        scenarioOrdinal: coordinate(value.scenarioOrdinal, SKILL_EVIDENCE_JOIN_SCENARIO_COUNT),
        repeatIndex: coordinate(value.repeatIndex, SKILL_EVIDENCE_JOIN_REPEAT_COUNT),
        arm: armOf(value.arm),
        planDigest: evalHash(value.planDigest),
        outcome,
        receiptDigest: evalHash(value.receiptDigest),
        responseDigest,
    });
}

function normalizeJudge(input: unknown): SkillEvidenceJoinJudge {
    const value = rowOf(input, ['jobId', 'sampleJobId', 'scenarioOrdinal', 'repeatIndex',
        'judgeSlot', 'judgeOrdinal', 'outcome', 'packetDigest', 'receiptDigest']);
    return evalFreeze({
        jobId: evalToken(value.jobId),
        sampleJobId: evalToken(value.sampleJobId),
        scenarioOrdinal: coordinate(value.scenarioOrdinal, SKILL_EVIDENCE_JOIN_SCENARIO_COUNT),
        repeatIndex: coordinate(value.repeatIndex, SKILL_EVIDENCE_JOIN_REPEAT_COUNT),
        judgeSlot: slotOf(value.judgeSlot),
        judgeOrdinal: coordinate(value.judgeOrdinal, 2),
        outcome: outcomeOf(value.outcome),
        packetDigest: evalHash(value.packetDigest),
        receiptDigest: evalHash(value.receiptDigest),
    });
}

/**
 * 汇合入口。坐标键：
 * · Sample / Candidate / Judge 共用 (scenarioOrdinal, repeatIndex)；
 * · Candidate 追加 arm；Judge 追加 judgeSlot。
 * 结果按 (scenarioOrdinal, repeatIndex) 稳定排序，输入顺序不影响 joinDigest。
 */
export function joinSkillQualityEvidence(input: unknown): SkillEvidenceJoin {
    const value = rowOf(input, ['sampleSuiteId', 'candidateBatchId', 'qualitySuiteId',
        'samples', 'arms', 'judges', 'joinedAt']);
    const samples = listOf(value.samples, 0, MAX_ITEMS).map(normalizeSample);
    const arms = listOf(value.arms, 0, MAX_ITEMS).map(normalizeArm);
    const judges = listOf(value.judges, 0, MAX_ITEMS).map(normalizeJudge);

    // 1) Sample 坐标必须是完整 8×3 矩阵，且不重复。
    const sampleByKey = new Map<string, SkillEvidenceJoinSample>();
    for (const sample of samples) {
        const key = sampleKeyOf(sample.scenarioOrdinal, sample.repeatIndex);
        if (sampleByKey.has(key)) reject('skill-evidence-join-coordinate-duplicate');
        sampleByKey.set(key, sample);
    }
    for (let scenario = 0; scenario < SKILL_EVIDENCE_JOIN_SCENARIO_COUNT; scenario += 1) {
        for (let repeat = 0; repeat < SKILL_EVIDENCE_JOIN_REPEAT_COUNT; repeat += 1) {
            if (!sampleByKey.has(sampleKeyOf(scenario, repeat))) reject('skill-evidence-join-coordinate-missing');
        }
    }

    // 2) Candidate arm：(sampleKey, arm) 唯一；坐标/plan 与 Sample 精确一致；摘要交叉绑定。
    const armByKey = new Map<string, SkillEvidenceJoinArm>();
    const armBySample = new Map<string, Map<SkillEvidenceArm, SkillEvidenceJoinArm>>();
    for (const arm of arms) {
        const sample = sampleByKey.get(sampleKeyOf(arm.scenarioOrdinal, arm.repeatIndex));
        if (!sample) reject('skill-evidence-join-coordinate-mismatch');
        if (arm.sampleKey !== sample.sampleJobId) reject('skill-evidence-join-coordinate-mismatch');
        if (arm.planDigest !== sample.planDigest) reject('skill-evidence-join-coordinate-mismatch');
        const key = `${sample.sampleJobId}\u0000${arm.arm}`;
        if (armByKey.has(key)) reject('skill-evidence-join-coordinate-duplicate');
        armByKey.set(key, arm);
        const perSample = armBySample.get(sample.sampleJobId) ?? new Map();
        if (perSample.has(arm.arm)) reject('skill-evidence-join-coordinate-duplicate');
        perSample.set(arm.arm, arm);
        armBySample.set(sample.sampleJobId, perSample);
    }
    for (const sample of sampleByKey.values()) {
        const perSample = armBySample.get(sample.sampleJobId);
        if (!perSample || perSample.size !== 2
            || !perSample.has('baseline') || !perSample.has('candidate')) {
            reject('skill-evidence-join-coordinate-missing');
        }
        for (const executionArm of sample.arms) {
            const settled = perSample.get(executionArm.variant)!;
            if (settled.receiptDigest !== executionArm.candidateReceiptDigest
                || settled.responseDigest !== executionArm.candidateResponseDigest) {
                reject('skill-evidence-join-digest-mismatch');
            }
        }
    }

    // 3) Judge：(sampleJobId, judgeSlot) 唯一；每个 Sample 恰好两名评委；坐标一致。
    const judgeByKey = new Map<string, SkillEvidenceJoinJudge>();
    const judgesBySample = new Map<string, Map<SkillEvidenceJudgeSlot, SkillEvidenceJoinJudge>>();
    for (const judge of judges) {
        const sample = sampleByKey.get(sampleKeyOf(judge.scenarioOrdinal, judge.repeatIndex));
        if (!sample) reject('skill-evidence-join-coordinate-mismatch');
        if (judge.sampleJobId !== sample.sampleJobId) reject('skill-evidence-join-coordinate-mismatch');
        const key = `${judge.sampleJobId}\u0000${judge.judgeSlot}`;
        if (judgeByKey.has(key)) reject('skill-evidence-join-coordinate-duplicate');
        judgeByKey.set(key, judge);
        const perSample = judgesBySample.get(sample.sampleJobId) ?? new Map();
        if (perSample.has(judge.judgeSlot)) reject('skill-evidence-join-coordinate-duplicate');
        perSample.set(judge.judgeSlot, judge);
        judgesBySample.set(sample.sampleJobId, perSample);
    }
    for (const sample of sampleByKey.values()) {
        const perSample = judgesBySample.get(sample.sampleJobId);
        if (!perSample || perSample.size !== 2
            || !perSample.has('judge-a') || !perSample.has('judge-b')) {
            reject('skill-evidence-join-coordinate-missing');
        }
    }

    // 4) 稳定行：显式坐标排序，绝不按输入 ordinal。
    const coordinates = [...sampleByKey.values()]
        .sort((left, right) => left.scenarioOrdinal - right.scenarioOrdinal
            || left.repeatIndex - right.repeatIndex)
        .map((sample): SkillEvidenceJoinedRow => {
            const settled = armBySample.get(sample.sampleJobId)!;
            const judged = judgesBySample.get(sample.sampleJobId)!;
            return evalFreeze({
                scenarioOrdinal: sample.scenarioOrdinal,
                repeatIndex: sample.repeatIndex,
                sampleJobId: sample.sampleJobId,
                samplePacketDigest: sample.samplePacketDigest,
                executionDigest: sample.executionDigest,
                arms: (['baseline', 'candidate'] as const).map((variant) => {
                    const executionArm = sample.arms.find((item) => item.variant === variant)!;
                    const arm = settled.get(variant)!;
                    return evalFreeze({
                        variant,
                        receiptDigest: arm.receiptDigest,
                        candidateResponseDigest: arm.responseDigest,
                        sampleResponseDigest: executionArm.sampleResponseDigest,
                        commonResponseBinding: executionArm.commonResponseBinding,
                    });
                }),
                judges: (['judge-a', 'judge-b'] as const).map((judgeSlot) => {
                    const judge = judged.get(judgeSlot)!;
                    return evalFreeze({
                        judgeSlot,
                        judgeOrdinal: judge.judgeOrdinal,
                        jobId: judge.jobId,
                        packetDigest: judge.packetDigest,
                        receiptDigest: judge.receiptDigest,
                    });
                }),
            });
        });

    const coverage = evalFreeze({
        samples: SKILL_EVIDENCE_JOIN_SAMPLE_COUNT as typeof SKILL_EVIDENCE_JOIN_SAMPLE_COUNT,
        arms: SKILL_EVIDENCE_JOIN_ARM_COUNT as typeof SKILL_EVIDENCE_JOIN_ARM_COUNT,
        judges: SKILL_EVIDENCE_JOIN_JUDGE_COUNT as typeof SKILL_EVIDENCE_JOIN_JUDGE_COUNT,
        baselinePassed: arms.filter((item) => item.arm === 'baseline' && item.outcome === 'passed').length,
        candidatePassed: arms.filter((item) => item.arm === 'candidate' && item.outcome === 'passed').length,
    });
    const core = {
        joinVersion: SKILL_QUALITY_EVIDENCE_JOIN_VERSION,
        sampleSuiteId: evalToken(value.sampleSuiteId),
        candidateBatchId: evalToken(value.candidateBatchId),
        qualitySuiteId: evalToken(value.qualitySuiteId),
        coordinates,
        coverage,
        providerExecution: 'unverified' as const,
        qualityVerdict: 'not-declared' as const,
        winner: 'not-declared' as const,
        promotionEligible: false as const,
        joinedAt: evalTime(value.joinedAt),
    };
    return evalFreeze({ ...core, joinDigest: evalDigest(core) });
}

/** 回读校验：只接受可重新归一化且摘要一致的历史汇合结果。 */
export function readSkillQualityEvidenceJoin(input: unknown): SkillEvidenceJoin {
    const value = rowOf(input, ['joinVersion', 'sampleSuiteId', 'candidateBatchId', 'qualitySuiteId',
        'coordinates', 'coverage', 'providerExecution', 'qualityVerdict', 'winner',
        'promotionEligible', 'joinedAt', 'joinDigest']);
    if (value.joinVersion !== SKILL_QUALITY_EVIDENCE_JOIN_VERSION
        || value.providerExecution !== 'unverified'
        || value.qualityVerdict !== 'not-declared'
        || value.winner !== 'not-declared'
        || value.promotionEligible !== false) reject('skill-evidence-join-input-invalid');
    const coverage = rowOf(value.coverage, ['samples', 'arms', 'judges', 'baselinePassed', 'candidatePassed']);
    const rows = listOf(value.coordinates, SKILL_EVIDENCE_JOIN_SAMPLE_COUNT, SKILL_EVIDENCE_JOIN_SAMPLE_COUNT);
    const normalizedRows = rows.map((item) => {
        const row = rowOf(item, ['scenarioOrdinal', 'repeatIndex', 'sampleJobId', 'samplePacketDigest',
            'executionDigest', 'arms', 'judges']);
        const normalizedArms = listOf(row.arms, 2, 2).map((entry) => {
            const arm = rowOf(entry, ['variant', 'receiptDigest', 'candidateResponseDigest',
                'sampleResponseDigest', 'commonResponseBinding']);
            return evalFreeze({
                variant: armOf(arm.variant),
                receiptDigest: evalHash(arm.receiptDigest),
                candidateResponseDigest: arm.candidateResponseDigest === null
                    ? null : evalHash(arm.candidateResponseDigest),
                sampleResponseDigest: evalHash(arm.sampleResponseDigest),
                commonResponseBinding: evalHash(arm.commonResponseBinding),
            });
        });
        const variants = new Set(normalizedArms.map((entry) => entry.variant));
        if (variants.size !== 2 || !variants.has('baseline') || !variants.has('candidate')) {
            reject('skill-evidence-join-input-invalid');
        }
        const normalizedJudges = listOf(row.judges, 2, 2).map((entry) => {
            const judge = rowOf(entry, ['judgeSlot', 'judgeOrdinal', 'jobId', 'packetDigest', 'receiptDigest']);
            return evalFreeze({
                judgeSlot: slotOf(judge.judgeSlot),
                judgeOrdinal: coordinate(judge.judgeOrdinal, 2),
                jobId: evalToken(judge.jobId),
                packetDigest: evalHash(judge.packetDigest),
                receiptDigest: evalHash(judge.receiptDigest),
            });
        });
        const slots = new Set(normalizedJudges.map((entry) => entry.judgeSlot));
        if (slots.size !== 2 || !slots.has('judge-a') || !slots.has('judge-b')) {
            reject('skill-evidence-join-input-invalid');
        }
        return evalFreeze({
            scenarioOrdinal: coordinate(row.scenarioOrdinal, SKILL_EVIDENCE_JOIN_SCENARIO_COUNT),
            repeatIndex: coordinate(row.repeatIndex, SKILL_EVIDENCE_JOIN_REPEAT_COUNT),
            sampleJobId: evalToken(row.sampleJobId),
            samplePacketDigest: evalHash(row.samplePacketDigest),
            executionDigest: evalHash(row.executionDigest),
            arms: normalizedArms,
            judges: normalizedJudges,
        });
    });
    const core = {
        joinVersion: SKILL_QUALITY_EVIDENCE_JOIN_VERSION,
        sampleSuiteId: evalToken(value.sampleSuiteId),
        candidateBatchId: evalToken(value.candidateBatchId),
        qualitySuiteId: evalToken(value.qualitySuiteId),
        coordinates: normalizedRows,
        coverage: evalFreeze({
            samples: SKILL_EVIDENCE_JOIN_SAMPLE_COUNT as typeof SKILL_EVIDENCE_JOIN_SAMPLE_COUNT,
            arms: SKILL_EVIDENCE_JOIN_ARM_COUNT as typeof SKILL_EVIDENCE_JOIN_ARM_COUNT,
            judges: SKILL_EVIDENCE_JOIN_JUDGE_COUNT as typeof SKILL_EVIDENCE_JOIN_JUDGE_COUNT,
            baselinePassed: coverage.baselinePassed as number,
            candidatePassed: coverage.candidatePassed as number,
        }),
        providerExecution: 'unverified' as const,
        qualityVerdict: 'not-declared' as const,
        winner: 'not-declared' as const,
        promotionEligible: false as const,
        joinedAt: evalTime(value.joinedAt),
    };
    if (value.joinDigest !== evalDigest(core)) reject('skill-evidence-join-digest-mismatch');
    return evalFreeze({ ...core, joinDigest: evalHash(value.joinDigest) });
}

/** 供宿主适配器使用：内容无关的摘要，不暴露正文。 */
export function skillEvidenceJoinDigest(input: SkillEvidenceJoin): string {
    return evalRawDigest(JSON.stringify(input));
}
