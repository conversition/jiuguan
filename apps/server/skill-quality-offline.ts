/** @author Codex @date 2026-10-16 @version 1.0
 * Host-side aggregation of a structurally complete, Provider-unverified blinded 8x3x2 fixture packet matrix.
 * Scores remain bounded per-dimension observations; this module never declares a total score or winner.
 */
import {
    normalizeSkillQualityPacket, type SkillQualityFactVerdict, type SkillQualityPacket,
} from './skill-quality-model.ts';
import {
    normalizeSkillQualityPlans, SKILL_QUALITY_FACT_CARDS, SKILL_QUALITY_JUDGE_COUNT,
    SKILL_QUALITY_LITERARY_RUBRIC, SKILL_QUALITY_PLAN_COUNT,
    type SkillQualityArm, type SkillQualityDimensionId,
} from './skill-quality-registry.ts';
import {
    SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_REPEAT_COUNT, SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
} from './skill-sample-registry.ts';
import { evalDense, evalDigest, evalFreeze } from './skill-evaluate-data.ts';

export const SKILL_QUALITY_OFFLINE_VERSION = 'skill-quality-offline-receipt-v1' as const;
export const SKILL_QUALITY_OFFLINE_ALGORITHM = 'blinded-two-judge-fixture-observation-v1' as const;
export const SKILL_QUALITY_SCORE_SUM_SCALE = 2 as const;
export const SKILL_QUALITY_JUDGE_TOLERANCE = 1 as const;
const BASIS_POINTS = 10_000 as const;

export type SkillQualityLiteraryObservation = 'concordant' | 'inconclusive';
export type SkillQualityFixtureFactStatus = 'satisfied' | 'failed' | 'inconclusive';

export interface SkillQualityIntegerDistribution {
    readonly count: number;
    /** Values are integer sums of two judge scores, representing exact half-point observations. */
    readonly scale: typeof SKILL_QUALITY_SCORE_SUM_SCALE;
    readonly sum: number;
    readonly min: number | null;
    readonly max: number | null;
    /** Twice the exact median of the stored integer numerators. */
    readonly medianTimes2: number | null;
    /** Four times MAD in the stored integer-numerator coordinate system. */
    readonly medianAbsoluteDeviationTimes4: number | null;
}

export interface SkillQualityJudgeAgreement {
    readonly comparisonCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
    readonly tolerance: typeof SKILL_QUALITY_JUDGE_TOLERANCE;
    readonly exactCount: number;
    readonly adjacentCount: number;
    readonly divergentCount: number;
    readonly withinToleranceCount: number;
    readonly withinToleranceRateBps: number;
}

export interface SkillQualityDimensionAggregate {
    readonly dimensionId: SkillQualityDimensionId;
    readonly scoreBounds: Readonly<{
        judgeMinimum: 0; judgeMaximum: 4; scoreSumMinimum: 0; scoreSumMaximum: 8;
        scoreSumScale: typeof SKILL_QUALITY_SCORE_SUM_SCALE;
    }>;
    readonly pairLevel: Readonly<{
        baseline: SkillQualityIntegerDistribution;
        candidate: SkillQualityIntegerDistribution;
        delta: SkillQualityIntegerDistribution;
    }>;
    /** Only scenarios with all three conclusive repetitions contribute one median each. */
    readonly scenarioLevel: Readonly<{
        baseline: SkillQualityIntegerDistribution;
        candidate: SkillQualityIntegerDistribution;
        delta: SkillQualityIntegerDistribution;
    }>;
    readonly judgeAgreement: Readonly<{
        baseline: SkillQualityJudgeAgreement;
        candidate: SkillQualityJudgeAgreement;
    }>;
}

export interface SkillQualityPairObservation {
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly literaryObservation: SkillQualityLiteraryObservation;
}

export interface SkillQualityFixtureFactObservation {
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly factDigest: string;
    readonly baseline: SkillQualityFixtureFactStatus;
    readonly candidate: SkillQualityFixtureFactStatus;
}

export interface SkillQualityFixtureFactCounts {
    readonly observationCount: number;
    readonly satisfiedCount: number;
    readonly failedCount: number;
    readonly inconclusiveCount: number;
}

export interface SkillQualityOfflineSummary {
    readonly normalizedPacketCount: typeof SKILL_QUALITY_PLAN_COUNT;
    readonly literary: Readonly<{
        concordantPairCount: number;
        inconclusivePairCount: number;
        fullyConcordantScenarioCount: number;
        inconclusiveScenarioCount: number;
    }>;
    readonly fixtureFacts: Readonly<{
        baseline: SkillQualityFixtureFactCounts;
        candidate: SkillQualityFixtureFactCounts;
    }>;
}

export interface SkillQualityOfflineReceipt {
    readonly receiptVersion: typeof SKILL_QUALITY_OFFLINE_VERSION;
    readonly algorithmVersion: typeof SKILL_QUALITY_OFFLINE_ALGORITHM;
    readonly qualitySuiteId: string;
    readonly qualityManifestDigest: string;
    readonly qualityMatrixDigest: string;
    readonly sourceSuiteId: string;
    readonly sourceSuiteManifestDigest: string;
    readonly sourceMatrixDigest: string;
    readonly registryDigest: string;
    readonly rubricDigest: string;
    readonly factRegistryDigest: string;
    readonly judgeRegistryDigest: string;
    readonly budget: Readonly<{
        perJudgeBudgetDigest: string;
        perJudgeInputTokens: number;
        perJudgeOutputTokens: number;
        perJudgeMaxCostMicrousd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalMaxCostMicrousd: number;
    }>;
    readonly aggregationPolicyDigest: string;
    readonly coverage: Readonly<{
        plannedScenarioCount: typeof SKILL_SAMPLE_SUITE_SCENARIO_COUNT;
        repeatsPerScenario: typeof SKILL_SAMPLE_SUITE_REPEAT_COUNT;
        plannedPairCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
        judgesPerPair: typeof SKILL_QUALITY_JUDGE_COUNT;
        plannedPacketCount: typeof SKILL_QUALITY_PLAN_COUNT;
        normalizedPacketCount: typeof SKILL_QUALITY_PLAN_COUNT;
        missingPacketCount: 0;
        duplicatePacketCount: 0;
        matrixStatus: 'structurally-complete-unverified';
        providerExecution: 'unverified';
    }>;
    readonly pairObservations: readonly SkillQualityPairObservation[];
    readonly dimensions: readonly SkillQualityDimensionAggregate[];
    readonly semanticFixtureFacts: Readonly<{
        scope: 'fixture-facts-only';
        observation: SkillQualityFixtureFactStatus;
        observations: readonly SkillQualityFixtureFactObservation[];
        summary: Readonly<{
            baseline: SkillQualityFixtureFactCounts;
            candidate: SkillQualityFixtureFactCounts;
        }>;
    }>;
    readonly summary: SkillQualityOfflineSummary;
    readonly evidenceClass: 'fixture';
    readonly interpretation: 'blinded-packet-contract-fixture-observation';
    readonly providerExecution: 'unverified';
    readonly causalEffect: 'unsupported';
    readonly effectOutcome: 'unknown';
    readonly generalization: 'unsupported';
    readonly winner: 'not-declared';
    readonly literaryQuality: 'unmeasured';
    readonly literaryObservation: SkillQualityLiteraryObservation;
    readonly semanticQuality: 'unmeasured';
    readonly semanticScope: 'fixture-facts-only';
    readonly promotionEligible: false;
    readonly autoPromotion: false;
    readonly evidenceDigest: string;
}

interface BoundQualityPacket {
    readonly packet: SkillQualityPacket;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly judgeOrdinal: number;
}

interface ArmScores {
    readonly baseline: readonly [number, number];
    readonly candidate: readonly [number, number];
}

interface PairDimensionObservation {
    readonly dimensionId: SkillQualityDimensionId;
    readonly scores: ArmScores;
    readonly baselineScoreSum: number;
    readonly candidateScoreSum: number;
    readonly deltaScoreSum: number;
}

interface BoundPair {
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly literaryObservation: SkillQualityLiteraryObservation;
    readonly dimensions: readonly PairDimensionObservation[];
    readonly facts: readonly SkillQualityFixtureFactObservation[];
}


function invalid(): never { throw new Error('skill-quality-offline-invalid'); }


function checkedInteger(input: number): number {
    if (!Number.isSafeInteger(input)) invalid();
    return input;
}


function checkedAdd(left: number, right: number): number { return checkedInteger(left + right); }


function orderedIntegers(input: readonly number[]): number[] {
    if (input.some((value) => !Number.isSafeInteger(value))) invalid();
    return [...input].sort((left, right) => left - right);
}


function medianTimes2(input: readonly number[]): number {
    const values = orderedIntegers(input);
    if (values.length < 1) invalid();
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 1
        ? checkedInteger(values[middle]! * 2)
        : checkedAdd(values[middle - 1]!, values[middle]!);
}


function medianInteger(input: readonly number[]): number {
    const twice = medianTimes2(input);
    if (twice % 2 !== 0) invalid();
    return twice / 2;
}


function distribution(input: readonly number[]): SkillQualityIntegerDistribution {
    const values = orderedIntegers(input);
    if (values.length === 0) {
        return evalFreeze({
            count: 0, scale: SKILL_QUALITY_SCORE_SUM_SCALE, sum: 0,
            min: null, max: null, medianTimes2: null, medianAbsoluteDeviationTimes4: null,
        });
    }
    const centerTimes2 = medianTimes2(values);
    const deviationsTimes2 = values.map((value) => checkedInteger(Math.abs(value * 2 - centerTimes2)));
    return evalFreeze({
        count: values.length,
        scale: SKILL_QUALITY_SCORE_SUM_SCALE,
        sum: values.reduce(checkedAdd, 0),
        min: values[0]!,
        max: values.at(-1)!,
        medianTimes2: centerTimes2,
        medianAbsoluteDeviationTimes4: medianTimes2(deviationsTimes2),
    });
}


function rateBps(numerator: number, denominator: number): number {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
        || numerator < 0 || denominator < 0 || numerator > denominator) invalid();
    return denominator === 0 ? 0 : Math.floor((numerator * BASIS_POINTS) / denominator);
}


function agreement(input: readonly (readonly [number, number])[]): SkillQualityJudgeAgreement {
    if (input.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT) invalid();
    let exactCount = 0;
    let adjacentCount = 0;
    let divergentCount = 0;
    for (const [left, right] of input) {
        const difference = Math.abs(left - right);
        if (difference === 0) exactCount += 1;
        else if (difference <= SKILL_QUALITY_JUDGE_TOLERANCE) adjacentCount += 1;
        else divergentCount += 1;
    }
    const withinToleranceCount = exactCount + adjacentCount;
    return evalFreeze({
        comparisonCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
        tolerance: SKILL_QUALITY_JUDGE_TOLERANCE,
        exactCount, adjacentCount, divergentCount, withinToleranceCount,
        withinToleranceRateBps: rateBps(withinToleranceCount, input.length),
    });
}


function factStatus(left: SkillQualityFactVerdict,
    right: SkillQualityFactVerdict): SkillQualityFixtureFactStatus {
    if (left !== right) return 'inconclusive';
    if (left === 'entailed') return 'satisfied';
    if (left === 'contradicted' || left === 'omitted') return 'failed';
    return 'inconclusive';
}


function factCounts(input: readonly SkillQualityFixtureFactStatus[]): SkillQualityFixtureFactCounts {
    const satisfiedCount = input.filter((status) => status === 'satisfied').length;
    const failedCount = input.filter((status) => status === 'failed').length;
    const inconclusiveCount = input.filter((status) => status === 'inconclusive').length;
    if (satisfiedCount + failedCount + inconclusiveCount !== input.length) invalid();
    return evalFreeze({ observationCount: input.length, satisfiedCount, failedCount, inconclusiveCount });
}


function fixtureFactObservation(input: readonly SkillQualityFixtureFactStatus[]): SkillQualityFixtureFactStatus {
    if (input.includes('failed')) return 'failed';
    if (input.includes('inconclusive')) return 'inconclusive';
    return 'satisfied';
}


function comparePackets(left: BoundQualityPacket, right: BoundQualityPacket): number {
    return left.scenarioOrdinal - right.scenarioOrdinal
        || left.repeatIndex - right.repeatIndex
        || left.judgeOrdinal - right.judgeOrdinal;
}


function bindPackets(input: unknown): readonly BoundQualityPacket[] {
    const packets = evalDense(input, SKILL_QUALITY_PLAN_COUNT, SKILL_QUALITY_PLAN_COUNT)
        .map(normalizeSkillQualityPacket);
    const rows = packets.map((packet) => ({
        packet,
        scenarioOrdinal: packet.plan.source.scenarioOrdinal,
        repeatIndex: packet.plan.source.repeatIndex,
        judgeOrdinal: packet.plan.suite.judgeOrdinal,
    })).sort(comparePackets);
    const plans = normalizeSkillQualityPlans(rows.map((row) => row.packet.plan));
    if (new Set(rows.map((row) => row.packet.packetDigest)).size !== SKILL_QUALITY_PLAN_COUNT
        || new Set(rows.map((row) => `${row.scenarioOrdinal}:${row.repeatIndex}:${row.judgeOrdinal}`)).size
            !== SKILL_QUALITY_PLAN_COUNT) invalid();
    const first = rows[0]!.packet.plan;
    for (const [index, row] of rows.entries()) {
        const plan = row.packet.plan;
        if (plan.planDigest !== plans[index]!.planDigest
            || row.packet.planDigest !== plan.planDigest
            || row.packet.samplePacketDigest !== plan.source.samplePacketDigest
            || plan.suite.manifestDigest !== first.suite.manifestDigest
            || plan.suite.qualitySuiteId !== first.suite.qualitySuiteId
            || plan.source.sampleSuiteId !== first.source.sampleSuiteId
            || plan.source.sampleManifestDigest !== first.source.sampleManifestDigest
            || plan.source.sampleMatrixDigest !== first.source.sampleMatrixDigest
            || plan.registry.registryDigest !== first.registry.registryDigest
            || plan.registry.rubricDigest !== first.registry.rubricDigest
            || plan.registry.factRegistryDigest !== first.registry.factRegistryDigest
            || plan.suite.judgeRegistryDigest !== first.suite.judgeRegistryDigest
            || plan.suite.perJudgeBudgetDigest !== first.suite.perJudgeBudgetDigest
            || plan.suite.perJudgeInputTokens !== first.suite.perJudgeInputTokens
            || plan.suite.perJudgeOutputTokens !== first.suite.perJudgeOutputTokens
            || plan.suite.perJudgeMaxCostMicrousd !== first.suite.perJudgeMaxCostMicrousd
            || plan.suite.totalInputTokens !== first.suite.totalInputTokens
            || plan.suite.totalOutputTokens !== first.suite.totalOutputTokens
            || plan.suite.totalMaxCostMicrousd !== first.suite.totalMaxCostMicrousd) invalid();
    }
    const groups = [first.source.generationIndependenceGroupDigest,
        rows[0]!.packet.plan.suite.judgeIndependenceGroupDigest,
        rows[1]!.packet.plan.suite.judgeIndependenceGroupDigest];
    if (new Set(groups).size !== 3) invalid();
    return evalFreeze(rows);
}


function slotForArm(packet: SkillQualityPacket, arm: SkillQualityArm) {
    const slot = arm === 'baseline' ? packet.plan.suite.baselineSlot : packet.plan.suite.candidateSlot;
    const judgment = packet.judgment.slots.find((item) => item.slot === slot);
    if (!judgment) invalid();
    return judgment;
}


function scoreFor(packet: SkillQualityPacket, arm: SkillQualityArm,
    dimensionId: SkillQualityDimensionId): number {
    const score = slotForArm(packet, arm).scores.find((item) => item.dimensionId === dimensionId);
    if (!score || !Number.isSafeInteger(score.score) || score.score < 0 || score.score > 4) invalid();
    return score.score;
}


function verdictFor(packet: SkillQualityPacket, arm: SkillQualityArm, factDigest: string): SkillQualityFactVerdict {
    const fact = slotForArm(packet, arm).facts.find((item) => item.factDigest === factDigest);
    if (!fact) invalid();
    return fact.verdict;
}


function bindPairs(rows: readonly BoundQualityPacket[]): readonly BoundPair[] {
    const pairs: BoundPair[] = [];
    for (let pairOrdinal = 0; pairOrdinal < SKILL_SAMPLE_SUITE_PAIR_COUNT; pairOrdinal += 1) {
        const first = rows[pairOrdinal * SKILL_QUALITY_JUDGE_COUNT];
        const second = rows[pairOrdinal * SKILL_QUALITY_JUDGE_COUNT + 1];
        if (!first || !second || first.judgeOrdinal !== 0 || second.judgeOrdinal !== 1
            || first.scenarioOrdinal !== second.scenarioOrdinal || first.repeatIndex !== second.repeatIndex
            || first.packet.plan.source.samplePacketDigest !== second.packet.plan.source.samplePacketDigest
            || first.packet.plan.source.samplePlanDigest !== second.packet.plan.source.samplePlanDigest
            || first.packet.plan.registry.factCardDigest !== second.packet.plan.registry.factCardDigest) invalid();
        const dimensions = SKILL_QUALITY_LITERARY_RUBRIC.dimensions.map(({ dimensionId }) => {
            const baseline = [scoreFor(first.packet, 'baseline', dimensionId),
                scoreFor(second.packet, 'baseline', dimensionId)] as const;
            const candidate = [scoreFor(first.packet, 'candidate', dimensionId),
                scoreFor(second.packet, 'candidate', dimensionId)] as const;
            const baselineScoreSum = checkedAdd(baseline[0], baseline[1]);
            const candidateScoreSum = checkedAdd(candidate[0], candidate[1]);
            return evalFreeze({
                dimensionId, scores: { baseline, candidate }, baselineScoreSum, candidateScoreSum,
                deltaScoreSum: checkedInteger(candidateScoreSum - baselineScoreSum),
            });
        });
        const literaryObservation = dimensions.some(({ scores }) =>
            Math.abs(scores.baseline[0] - scores.baseline[1]) > SKILL_QUALITY_JUDGE_TOLERANCE
            || Math.abs(scores.candidate[0] - scores.candidate[1]) > SKILL_QUALITY_JUDGE_TOLERANCE)
            ? 'inconclusive' as const : 'concordant' as const;
        const card = SKILL_QUALITY_FACT_CARDS[first.scenarioOrdinal];
        if (!card || card.cardDigest !== first.packet.plan.registry.factCardDigest) invalid();
        const facts = card.atoms.map(({ factDigest }) => evalFreeze({
            scenarioOrdinal: first.scenarioOrdinal,
            repeatIndex: first.repeatIndex,
            factDigest,
            baseline: factStatus(verdictFor(first.packet, 'baseline', factDigest),
                verdictFor(second.packet, 'baseline', factDigest)),
            candidate: factStatus(verdictFor(first.packet, 'candidate', factDigest),
                verdictFor(second.packet, 'candidate', factDigest)),
        }));
        pairs.push(evalFreeze({
            scenarioOrdinal: first.scenarioOrdinal, repeatIndex: first.repeatIndex,
            literaryObservation, dimensions, facts,
        }));
    }
    return evalFreeze(pairs);
}


function dimensionFor(pair: BoundPair, dimensionId: SkillQualityDimensionId): PairDimensionObservation {
    const dimension = pair.dimensions.find((item) => item.dimensionId === dimensionId);
    if (!dimension) invalid();
    return dimension;
}


function aggregateDimension(dimensionId: SkillQualityDimensionId,
    pairs: readonly BoundPair[]): SkillQualityDimensionAggregate {
    const concordantPairs = pairs.filter((pair) => pair.literaryObservation === 'concordant');
    const concordant = concordantPairs.map((pair) => dimensionFor(pair, dimensionId));
    const scenarioBaseline: number[] = [];
    const scenarioCandidate: number[] = [];
    const scenarioDelta: number[] = [];
    for (let scenarioOrdinal = 0; scenarioOrdinal < SKILL_SAMPLE_SUITE_SCENARIO_COUNT; scenarioOrdinal += 1) {
        const repetitions = concordantPairs.filter((pair) => pair.scenarioOrdinal === scenarioOrdinal);
        if (repetitions.length === 0) continue;
        if (repetitions.length !== SKILL_SAMPLE_SUITE_REPEAT_COUNT) continue;
        const dimensions = repetitions.map((pair) => dimensionFor(pair, dimensionId));
        scenarioBaseline.push(medianInteger(dimensions.map((item) => item.baselineScoreSum)));
        scenarioCandidate.push(medianInteger(dimensions.map((item) => item.candidateScoreSum)));
        scenarioDelta.push(medianInteger(dimensions.map((item) => item.deltaScoreSum)));
    }
    const all = pairs.map((pair) => dimensionFor(pair, dimensionId));
    return evalFreeze({
        dimensionId,
        scoreBounds: {
            judgeMinimum: 0 as const, judgeMaximum: 4 as const,
            scoreSumMinimum: 0 as const, scoreSumMaximum: 8 as const,
            scoreSumScale: SKILL_QUALITY_SCORE_SUM_SCALE,
        },
        pairLevel: {
            baseline: distribution(concordant.map((item) => item.baselineScoreSum)),
            candidate: distribution(concordant.map((item) => item.candidateScoreSum)),
            delta: distribution(concordant.map((item) => item.deltaScoreSum)),
        },
        scenarioLevel: {
            baseline: distribution(scenarioBaseline),
            candidate: distribution(scenarioCandidate),
            delta: distribution(scenarioDelta),
        },
        judgeAgreement: {
            baseline: agreement(all.map((item) => item.scores.baseline)),
            candidate: agreement(all.map((item) => item.scores.candidate)),
        },
    });
}


function concordantScenarioCount(pairs: readonly BoundPair[]): number {
    let count = 0;
    for (let scenarioOrdinal = 0; scenarioOrdinal < SKILL_SAMPLE_SUITE_SCENARIO_COUNT; scenarioOrdinal += 1) {
        if (pairs.filter((pair) => pair.scenarioOrdinal === scenarioOrdinal
            && pair.literaryObservation === 'concordant').length === SKILL_SAMPLE_SUITE_REPEAT_COUNT) count += 1;
    }
    return count;
}


/**
 * Re-normalizes every body-free judge packet. Input order has no authority; host plan coordinates define the matrix.
 * A literary disagreement removes the entire source pair from every dimension and its incomplete scenario median.
 */
export function evaluateSkillQualityOffline(input: unknown): SkillQualityOfflineReceipt {
    try {
        const rows = bindPackets(input);
        const pairs = bindPairs(rows);
        const first = rows[0]!.packet.plan;
        const pairObservations = pairs.map(({ scenarioOrdinal, repeatIndex, literaryObservation }) =>
            evalFreeze({ scenarioOrdinal, repeatIndex, literaryObservation }));
        const dimensions = SKILL_QUALITY_LITERARY_RUBRIC.dimensions
            .map(({ dimensionId }) => aggregateDimension(dimensionId, pairs));
        const factObservations = pairs.flatMap((pair) => pair.facts);
        const baselineFactStatuses = factObservations.map((item) => item.baseline);
        const candidateFactStatuses = factObservations.map((item) => item.candidate);
        const factSummary = evalFreeze({
            baseline: factCounts(baselineFactStatuses),
            candidate: factCounts(candidateFactStatuses),
        });
        const allFactStatuses = [...baselineFactStatuses, ...candidateFactStatuses];
        const concordantPairs = pairs.filter((pair) => pair.literaryObservation === 'concordant').length;
        const concordantScenarios = concordantScenarioCount(pairs);
        const summary = evalFreeze({
            normalizedPacketCount: SKILL_QUALITY_PLAN_COUNT,
            literary: {
                concordantPairCount: concordantPairs,
                inconclusivePairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT - concordantPairs,
                fullyConcordantScenarioCount: concordantScenarios,
                inconclusiveScenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT - concordantScenarios,
            },
            fixtureFacts: factSummary,
        });
        const qualityMatrixDigest = evalDigest({
            qualityManifestDigest: first.suite.manifestDigest,
            packets: rows.map((row) => ({
                scenarioOrdinal: row.scenarioOrdinal, repeatIndex: row.repeatIndex,
                judgeOrdinal: row.judgeOrdinal, planDigest: row.packet.planDigest,
                packetDigest: row.packet.packetDigest,
            })),
        });
        const aggregationPolicyDigest = evalDigest({
            algorithmVersion: SKILL_QUALITY_OFFLINE_ALGORITHM,
            scoreBounds: { minimum: 0, maximum: 4 },
            judgeTolerance: SKILL_QUALITY_JUDGE_TOLERANCE,
            pairScore: 'two-judge-score-sum-scale-2',
            pairInconclusive: 'any-arm-dimension-absolute-difference-greater-than-1',
            pairReduction: 'conclusive-pairs-only',
            scenarioReduction: 'all-three-conclusive-pairs-median-then-equal-weight',
            factReduction: {
                equalEntailed: 'satisfied', equalContradictedOrOmitted: 'failed',
                uncertainOrConflict: 'inconclusive',
            },
            dimensions: SKILL_QUALITY_LITERARY_RUBRIC.dimensions.map((item) => item.dimensionId),
        });
        const core = {
            receiptVersion: SKILL_QUALITY_OFFLINE_VERSION,
            algorithmVersion: SKILL_QUALITY_OFFLINE_ALGORITHM,
            qualitySuiteId: first.suite.qualitySuiteId,
            qualityManifestDigest: first.suite.manifestDigest,
            qualityMatrixDigest,
            sourceSuiteId: first.source.sampleSuiteId,
            sourceSuiteManifestDigest: first.source.sampleManifestDigest,
            sourceMatrixDigest: first.source.sampleMatrixDigest,
            registryDigest: first.registry.registryDigest,
            rubricDigest: first.registry.rubricDigest,
            factRegistryDigest: first.registry.factRegistryDigest,
            judgeRegistryDigest: first.suite.judgeRegistryDigest,
            budget: {
                perJudgeBudgetDigest: first.suite.perJudgeBudgetDigest,
                perJudgeInputTokens: first.suite.perJudgeInputTokens,
                perJudgeOutputTokens: first.suite.perJudgeOutputTokens,
                perJudgeMaxCostMicrousd: first.suite.perJudgeMaxCostMicrousd,
                totalInputTokens: first.suite.totalInputTokens,
                totalOutputTokens: first.suite.totalOutputTokens,
                totalMaxCostMicrousd: first.suite.totalMaxCostMicrousd,
            },
            aggregationPolicyDigest,
            coverage: {
                plannedScenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
                repeatsPerScenario: SKILL_SAMPLE_SUITE_REPEAT_COUNT,
                plannedPairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
                judgesPerPair: SKILL_QUALITY_JUDGE_COUNT,
                plannedPacketCount: SKILL_QUALITY_PLAN_COUNT,
                normalizedPacketCount: SKILL_QUALITY_PLAN_COUNT,
                missingPacketCount: 0 as const,
                duplicatePacketCount: 0 as const,
                matrixStatus: 'structurally-complete-unverified' as const,
                providerExecution: 'unverified' as const,
            } as const,
            pairObservations,
            dimensions,
            semanticFixtureFacts: {
                scope: 'fixture-facts-only' as const,
                observation: fixtureFactObservation(allFactStatuses),
                observations: factObservations,
                summary: factSummary,
            },
            summary,
            evidenceClass: 'fixture' as const,
            interpretation: 'blinded-packet-contract-fixture-observation' as const,
            providerExecution: 'unverified' as const,
            causalEffect: 'unsupported' as const,
            effectOutcome: 'unknown' as const,
            generalization: 'unsupported' as const,
            winner: 'not-declared' as const,
            literaryQuality: 'unmeasured' as const,
            literaryObservation: concordantPairs === SKILL_SAMPLE_SUITE_PAIR_COUNT
                ? 'concordant' as const : 'inconclusive' as const,
            semanticQuality: 'unmeasured' as const,
            semanticScope: 'fixture-facts-only' as const,
            promotionEligible: false as const,
            autoPromotion: false as const,
        };
        return evalFreeze({ ...core, evidenceDigest: evalDigest(core) });
    } catch { return invalid(); }
}
