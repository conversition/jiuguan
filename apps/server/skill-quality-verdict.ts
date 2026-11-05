/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2c 质量裁决合同：把双评委离线回执映射成**预声明规则**下的描述性裁决。
 *
 * 边界：
 * 1) 不计算总分、不宣布胜者，只回答「候选在两个方向上是否一致越过分界线」；
 * 2) 五维必须同向且每个维度均值差 ≥ 0.5（8 分制 score-sum 尺度）；
 * 3) 任一事实失败 → inconclusive；评委一致性低于 60% 或坐标不全 → insufficient-evidence；
 * 4) 裁决永远不授予 promotion；`causalEffect=unsupported`、`statisticalClaim=descriptive-only`。
 */
import { types as nodeTypes } from 'node:util';
import { evalDigest, evalFreeze, evalHash, evalRecord, evalTime, evalToken } from './skill-evaluate-data.ts';
import type { SkillQualityOfflineReceipt } from './skill-quality-offline.ts';
import {
    SKILL_QUALITY_LITERARY_RUBRIC, SKILL_QUALITY_RUBRIC_DIGEST,
} from './skill-quality-registry.ts';

export const SKILL_QUALITY_VERDICT_VERSION = 'skill-quality-verdict-v1' as const;
export const SKILL_QUALITY_VERDICT_RULE_VERSION = 'five-dimension-unanimous-margin-v1' as const;
/** 0.5 分（score-sum 0..8 尺度），即每名评委 0.25 分；以百分数比较避免浮点。 */
export const SKILL_QUALITY_VERDICT_MARGIN_TIMES_100 = 50;
export const SKILL_QUALITY_VERDICT_MIN_AGREEMENT_BPS = 6_000;
export const SKILL_QUALITY_VERDICT_REQUIRED_PACKETS = 48;
export const SKILL_QUALITY_VERDICT_REQUIRED_PAIRS = 24;

export const SKILL_QUALITY_VERDICTS = Object.freeze([
    'candidate-better', 'candidate-worse', 'no-decision', 'inconclusive', 'insufficient-evidence',
] as const);
export type SkillQualityVerdictKind = typeof SKILL_QUALITY_VERDICTS[number];

export const SKILL_QUALITY_VERDICT_ERROR_CODES = Object.freeze([
    'skill-quality-verdict-input-invalid',
    'skill-quality-verdict-digest-mismatch',
] as const);
export type SkillQualityVerdictErrorCode = typeof SKILL_QUALITY_VERDICT_ERROR_CODES[number];

export class SkillQualityVerdictError extends Error {
    constructor(readonly code: SkillQualityVerdictErrorCode) {
        if (!(SKILL_QUALITY_VERDICT_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-quality-verdict-error-code-invalid');
        }
        super(code);
        this.name = 'SkillQualityVerdictError';
    }
}

export interface SkillQualityVerdictDimensionInput {
    readonly dimensionId: string;
    readonly baseline: Readonly<{ count: number; sum: number }>;
    readonly candidate: Readonly<{ count: number; sum: number }>;
    readonly delta: Readonly<{ count: number; sum: number }>;
    readonly candidateAgreementBps: number;
}

export interface SkillQualityVerdictInput {
    readonly qualitySuiteId: string;
    readonly qualityManifestDigest: string;
    readonly rubricDigest: string;
    readonly normalizedPacketCount: number;
    readonly candidateFixtureFailedCount: number;
    readonly dimensions: readonly SkillQualityVerdictDimensionInput[];
}

export interface SkillQualityVerdictDimension {
    readonly dimensionId: string;
    readonly baselineMeanTimes100: number;
    readonly candidateMeanTimes100: number;
    readonly deltaMeanTimes100: number;
    readonly candidateAgreementBps: number;
}

export interface SkillQualityVerdict {
    readonly verdictVersion: typeof SKILL_QUALITY_VERDICT_VERSION;
    readonly decisionRuleVersion: typeof SKILL_QUALITY_VERDICT_RULE_VERSION;
    readonly qualitySuiteId: string;
    readonly qualityManifestDigest: string;
    readonly rubricDigest: string;
    readonly packetCount: 48;
    readonly dimensions: readonly SkillQualityVerdictDimension[];
    readonly verdict: SkillQualityVerdictKind;
    readonly promotionEligible: false;
    readonly causalEffect: 'unsupported';
    readonly statisticalClaim: 'descriptive-only';
    readonly decidedAt: string;
    readonly verdictDigest: string;
}

const EXPECTED_DIMENSIONS = SKILL_QUALITY_LITERARY_RUBRIC.dimensions.map((item) => item.dimensionId);

function reject(code: SkillQualityVerdictErrorCode): never {
    throw new SkillQualityVerdictError(code);
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    try { return evalRecord(input, keys); }
    catch { return reject('skill-quality-verdict-input-invalid'); }
}

function integer(value: unknown, minimum = 0, maximum = 1_000_000): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        reject('skill-quality-verdict-input-invalid');
    }
    return Number(value);
}

function meanTimes100(sum: number, count: number): number {
    if (count < 1) reject('skill-quality-verdict-input-invalid');
    return Math.round((sum * 100) / count);
}

function normalizeDimension(input: unknown, expectedId: string): SkillQualityVerdictDimensionInput {
    const value = record(input, ['dimensionId', 'baseline', 'candidate', 'delta', 'candidateAgreementBps']);
    if (value.dimensionId !== expectedId) reject('skill-quality-verdict-input-invalid');
    const part = (raw: unknown, signed = false): Readonly<{ count: number; sum: number }> => {
        const item = record(raw, ['count', 'sum']);
        const bound = SKILL_QUALITY_VERDICT_REQUIRED_PAIRS * 8;
        return evalFreeze({
            count: integer(item.count, 1, SKILL_QUALITY_VERDICT_REQUIRED_PAIRS),
            sum: integer(item.sum, signed ? -bound : 0, bound),
        });
    };
    const baseline = part(value.baseline);
    const candidate = part(value.candidate);
    const delta = part(value.delta, true);
    if (baseline.count !== SKILL_QUALITY_VERDICT_REQUIRED_PAIRS
        || candidate.count !== SKILL_QUALITY_VERDICT_REQUIRED_PAIRS
        || delta.count !== SKILL_QUALITY_VERDICT_REQUIRED_PAIRS) {
        reject('skill-quality-verdict-input-invalid');
    }
    return evalFreeze({
        dimensionId: expectedId,
        baseline,
        candidate,
        delta,
        candidateAgreementBps: integer(value.candidateAgreementBps, 0, 10_000),
    });
}

function normalizeInput(input: unknown): SkillQualityVerdictInput {
    const value = record(input, ['qualitySuiteId', 'qualityManifestDigest', 'rubricDigest',
        'normalizedPacketCount', 'candidateFixtureFailedCount', 'dimensions']);
    if (value.rubricDigest !== SKILL_QUALITY_RUBRIC_DIGEST) reject('skill-quality-verdict-input-invalid');
    if (!Array.isArray(value.dimensions) || nodeTypes.isProxy(value.dimensions)
        || value.dimensions.length !== EXPECTED_DIMENSIONS.length) {
        reject('skill-quality-verdict-input-invalid');
    }
    const dimensionList = value.dimensions as readonly unknown[];
    const dimensions = EXPECTED_DIMENSIONS.map((id, index) => normalizeDimension(dimensionList[index], id));
    return evalFreeze({
        qualitySuiteId: evalToken(value.qualitySuiteId),
        qualityManifestDigest: evalHash(value.qualityManifestDigest),
        rubricDigest: SKILL_QUALITY_RUBRIC_DIGEST,
        normalizedPacketCount: integer(value.normalizedPacketCount, 0, 48),
        candidateFixtureFailedCount: integer(value.candidateFixtureFailedCount, 0, 48),
        dimensions,
    });
}

/** 预声明规则：全维同向 + 每维均值差 ≥ 0.5 + 事实零失败 + 一致性 ≥ 60%。 */
export function decideSkillQualityVerdict(input: SkillQualityVerdictInput, now: string): SkillQualityVerdict {
    const value = normalizeInput(input);
    const decidedAt = evalTime(now);
    const dimensions = value.dimensions.map((dimension) => evalFreeze({
        dimensionId: dimension.dimensionId,
        baselineMeanTimes100: meanTimes100(dimension.baseline.sum, dimension.baseline.count),
        candidateMeanTimes100: meanTimes100(dimension.candidate.sum, dimension.candidate.count),
        deltaMeanTimes100: meanTimes100(dimension.delta.sum, dimension.delta.count),
        candidateAgreementBps: dimension.candidateAgreementBps,
    }));

    const atLeastMargin = (dimension: SkillQualityVerdictDimensionInput): boolean =>
        dimension.delta.sum * 100
        >= dimension.delta.count * SKILL_QUALITY_VERDICT_MARGIN_TIMES_100;
    const atMostNegativeMargin = (dimension: SkillQualityVerdictDimensionInput): boolean =>
        dimension.delta.sum * 100
        <= -dimension.delta.count * SKILL_QUALITY_VERDICT_MARGIN_TIMES_100;

    let verdict: SkillQualityVerdictKind;
    if (value.normalizedPacketCount !== SKILL_QUALITY_VERDICT_REQUIRED_PACKETS) {
        verdict = 'insufficient-evidence';
    } else if (value.candidateFixtureFailedCount > 0) {
        verdict = 'inconclusive';
    } else if (dimensions.some((item) => item.candidateAgreementBps < SKILL_QUALITY_VERDICT_MIN_AGREEMENT_BPS)) {
        verdict = 'insufficient-evidence';
    } else if (value.dimensions.every(atLeastMargin)) {
        verdict = 'candidate-better';
    } else if (value.dimensions.every(atMostNegativeMargin)) {
        verdict = 'candidate-worse';
    } else {
        verdict = 'no-decision';
    }

    const core = {
        verdictVersion: SKILL_QUALITY_VERDICT_VERSION,
        decisionRuleVersion: SKILL_QUALITY_VERDICT_RULE_VERSION,
        qualitySuiteId: value.qualitySuiteId,
        qualityManifestDigest: value.qualityManifestDigest,
        rubricDigest: value.rubricDigest,
        packetCount: 48 as const,
        dimensions,
        verdict,
        promotionEligible: false as const,
        causalEffect: 'unsupported' as const,
        statisticalClaim: 'descriptive-only' as const,
        decidedAt,
    };
    return evalFreeze({ ...core, verdictDigest: evalDigest(core) });
}

/** 宿主适配器：从双评委离线回执映射，不复制聚合逻辑。 */
export function verdictInputFromOfflineReceipt(receipt: SkillQualityOfflineReceipt): SkillQualityVerdictInput {
    return evalFreeze({
        qualitySuiteId: receipt.qualitySuiteId,
        qualityManifestDigest: receipt.qualityManifestDigest,
        rubricDigest: receipt.rubricDigest,
        normalizedPacketCount: receipt.summary.normalizedPacketCount,
        candidateFixtureFailedCount: receipt.summary.fixtureFacts.candidate.failedCount,
        dimensions: receipt.dimensions.map((item) => ({
            dimensionId: item.dimensionId,
            baseline: {
                count: item.pairLevel.baseline.count,
                sum: item.pairLevel.baseline.sum,
            },
            candidate: {
                count: item.pairLevel.candidate.count,
                sum: item.pairLevel.candidate.sum,
            },
            delta: {
                count: item.pairLevel.delta.count,
                sum: item.pairLevel.delta.sum,
            },
            candidateAgreementBps: item.judgeAgreement.candidate.withinToleranceRateBps,
        })),
    });
}

export function readSkillQualityVerdict(input: unknown): SkillQualityVerdict {
    const value = record(input, ['verdictVersion', 'decisionRuleVersion', 'qualitySuiteId',
        'qualityManifestDigest', 'rubricDigest', 'packetCount', 'dimensions', 'verdict',
        'promotionEligible', 'causalEffect', 'statisticalClaim', 'decidedAt', 'verdictDigest']);
    if (value.verdictVersion !== SKILL_QUALITY_VERDICT_VERSION
        || value.decisionRuleVersion !== SKILL_QUALITY_VERDICT_RULE_VERSION
        || value.packetCount !== 48
        || !(SKILL_QUALITY_VERDICTS as readonly unknown[]).includes(value.verdict)
        || value.promotionEligible !== false
        || value.causalEffect !== 'unsupported'
        || value.statisticalClaim !== 'descriptive-only') {
        reject('skill-quality-verdict-input-invalid');
    }
    const dimensions = (() => {
        if (!Array.isArray(value.dimensions) || value.dimensions.length !== EXPECTED_DIMENSIONS.length) {
            reject('skill-quality-verdict-input-invalid');
        }
        const list = value.dimensions as readonly unknown[];
        return EXPECTED_DIMENSIONS.map((id, index) => {
            const item = record(list[index], ['dimensionId', 'baselineMeanTimes100',
                'candidateMeanTimes100', 'deltaMeanTimes100', 'candidateAgreementBps']);
            if (item.dimensionId !== id) reject('skill-quality-verdict-input-invalid');
            return evalFreeze({
                dimensionId: id,
                baselineMeanTimes100: integer(item.baselineMeanTimes100, -8_000, 8_000),
                candidateMeanTimes100: integer(item.candidateMeanTimes100, -8_000, 8_000),
                deltaMeanTimes100: integer(item.deltaMeanTimes100, -800, 800),
                candidateAgreementBps: integer(item.candidateAgreementBps, 0, 10_000),
            });
        });
    })();
    const core = {
        verdictVersion: SKILL_QUALITY_VERDICT_VERSION,
        decisionRuleVersion: SKILL_QUALITY_VERDICT_RULE_VERSION,
        qualitySuiteId: evalToken(value.qualitySuiteId),
        qualityManifestDigest: evalHash(value.qualityManifestDigest),
        rubricDigest: evalHash(value.rubricDigest),
        packetCount: 48 as const,
        dimensions,
        verdict: value.verdict as SkillQualityVerdictKind,
        promotionEligible: false as const,
        causalEffect: 'unsupported' as const,
        statisticalClaim: 'descriptive-only' as const,
        decidedAt: evalTime(value.decidedAt),
    };
    if (value.verdictDigest !== evalDigest(core)) reject('skill-quality-verdict-digest-mismatch');
    return evalFreeze({ ...core, verdictDigest: evalHash(value.verdictDigest) });
}
