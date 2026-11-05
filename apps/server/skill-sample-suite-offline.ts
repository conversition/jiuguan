/** @author Codex @date 2026-10-16 @version 1.0
 * Hierarchical descriptive statistics over a complete host-defined 8x3 fixture matrix.
 * This module reports bounded prose proxies only. It never produces literary/semantic quality,
 * causal-effect, winner, pass, lifecycle, or publication authority.
 */
import {
    normalizeSkillSamplePacket, SKILL_SAMPLE_POLICY_VERSION, type SkillSamplePacket
} from './skill-sample-model.ts';
import {
    normalizeSkillSampleSuitePlan, normalizeSkillSampleSuitePlans,
    SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_REPEAT_COUNT,
    SKILL_SAMPLE_SUITE_SCENARIO_COUNT, type SkillSampleSuitePlan
} from './skill-sample-registry.ts';
import {
    evaluateSkillSampleOffline, SKILL_SAMPLE_OFFLINE_ALGORITHM,
    type SkillSampleOfflineReceipt, type SkillSampleTextMetrics
} from './skill-sample-offline.ts';
import { evalDense, evalDigest, evalFreeze } from './skill-evaluate-data.ts';

export const SKILL_SAMPLE_SUITE_OFFLINE_VERSION = 'skill-sample-suite-offline-receipt-v1' as const;
export const SKILL_SAMPLE_SUITE_OFFLINE_ALGORITHM = 'paired-hierarchical-proxy-micro-v1' as const;
export const SKILL_SAMPLE_SUITE_DIRECTION_MIN_DECISIVE_SCENARIOS = 6;
export const SKILL_SAMPLE_SUITE_DIRECTION_ALIGNMENT_MIN_BPS = 7_500;
export const SKILL_SAMPLE_SUITE_DIRECTION_OPPOSITION_MAX_BPS = 2_500;
const MICRO_SCALE = 1_000_000 as const;
const BASIS_POINTS = 10_000;

export type SkillSampleSuiteProxyMetric =
    | 'character-count'
    | 'sentence-count'
    | 'mean-sentence-length'
    | 'dialogue-ratio'
    | 'repetition-ratio'
    | 'required-term-match'
    | 'forbidden-term-match';

export interface SkillSampleSuiteDistribution {
    readonly count: number;
    readonly scale: 1 | typeof MICRO_SCALE;
    readonly sum: number;
    readonly min: number;
    readonly max: number;
    /** Two times the exact median, so even-sized samples need no floating-point rounding. */
    readonly medianTimes2: number;
    /** Four times the median absolute deviation around the exact median. */
    readonly medianAbsoluteDeviationTimes4: number;
}

export type SkillSampleSuiteDirectionObservation =
    | 'aligned'
    | 'mixed'
    | 'opposed'
    | 'insufficient'
    | 'unmeasured';

export interface SkillSampleSuiteDirectionEvidence {
    readonly expected: 'increase' | 'decrease' | 'none';
    readonly toleranceScaled: 0;
    readonly alignedScenarioCount: number;
    readonly opposedScenarioCount: number;
    readonly tiedScenarioCount: number;
    readonly decisiveScenarioCount: number;
    readonly decisiveRateBps: number;
    /** Zero when no scenario is decisive; ties cannot manufacture 100% agreement. */
    readonly agreementBps: number;
    readonly observation: SkillSampleSuiteDirectionObservation;
}

export interface SkillSampleSuiteMetricAggregate {
    readonly metric: SkillSampleSuiteProxyMetric;
    readonly pairLevel: Readonly<{
        baseline: SkillSampleSuiteDistribution;
        candidate: SkillSampleSuiteDistribution;
        delta: SkillSampleSuiteDistribution;
    }>;
    /** Each scenario contributes one median across its three repetitions, then all scenarios are equal-weighted. */
    readonly scenarioLevel: Readonly<{
        baseline: SkillSampleSuiteDistribution;
        candidate: SkillSampleSuiteDistribution;
        delta: SkillSampleSuiteDistribution;
    }>;
    readonly direction: SkillSampleSuiteDirectionEvidence;
}

export interface SkillSampleSuiteCoverage {
    readonly plannedScenarioCount: typeof SKILL_SAMPLE_SUITE_SCENARIO_COUNT;
    readonly repeatsPerScenario: typeof SKILL_SAMPLE_SUITE_REPEAT_COUNT;
    readonly plannedPairCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
    readonly completedPairCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
    readonly failedPairCount: 0;
    readonly uncertainPairCount: 0;
    readonly missingPairCount: 0;
    readonly completeScenarioCount: typeof SKILL_SAMPLE_SUITE_SCENARIO_COUNT;
    readonly completionRateBps: typeof BASIS_POINTS;
    readonly matrixStatus: 'complete';
}

export interface SkillSampleSuiteOfflineReceipt {
    readonly receiptVersion: typeof SKILL_SAMPLE_SUITE_OFFLINE_VERSION;
    readonly algorithmVersion: typeof SKILL_SAMPLE_SUITE_OFFLINE_ALGORITHM;
    readonly sourceAlgorithmVersion: typeof SKILL_SAMPLE_OFFLINE_ALGORITHM;
    readonly suiteManifestDigest: string;
    readonly scenarioSetDigest: string;
    readonly sampleMatrixDigest: string;
    readonly sourceIdentityDigest: string;
    readonly modelBindingDigest: string;
    readonly generationConfigDigest: string;
    readonly metricPolicyDigest: string;
    readonly coverage: SkillSampleSuiteCoverage;
    readonly metrics: readonly SkillSampleSuiteMetricAggregate[];
    readonly evidenceClass: 'fixture';
    readonly interpretation: 'descriptive-proxy-only';
    readonly causalEffect: 'unsupported';
    readonly effectOutcome: 'unknown';
    readonly literaryQuality: 'unmeasured';
    readonly semanticQuality: 'unmeasured';
    readonly promotionEligible: false;
    readonly evidenceDigest: string;
}

interface BoundSample {
    readonly packet: SkillSamplePacket;
    readonly plan: SkillSampleSuitePlan;
    readonly receipt: SkillSampleOfflineReceipt;
}

interface MetricDefinition {
    readonly metric: SkillSampleSuiteProxyMetric;
    readonly scale: 1 | typeof MICRO_SCALE;
    readonly read: (metrics: SkillSampleTextMetrics) => number;
}

const METRICS: readonly MetricDefinition[] = Object.freeze([
    { metric: 'character-count', scale: 1, read: (value) => value.characterCount },
    { metric: 'sentence-count', scale: 1, read: (value) => value.sentenceCount },
    {
        metric: 'mean-sentence-length', scale: MICRO_SCALE,
        read: (value) => scaledRatio(value.sentenceLength.numerator, value.sentenceLength.denominator)
    },
    {
        metric: 'dialogue-ratio', scale: MICRO_SCALE,
        read: (value) => scaledRatio(value.dialogue.numerator, value.dialogue.denominator)
    },
    {
        metric: 'repetition-ratio', scale: MICRO_SCALE,
        read: (value) => scaledRatio(value.repetition.repeatedBigramCount, value.repetition.bigramCount)
    },
    { metric: 'required-term-match', scale: 1, read: (value) => value.terms.requiredMatched },
    { metric: 'forbidden-term-match', scale: 1, read: (value) => value.terms.forbiddenMatched },
]);


function invalid(): never { throw new Error('skill-sample-suite-offline-invalid'); }


function checkedInteger(value: number): number {
    if (!Number.isSafeInteger(value)) invalid();
    return value;
}


function checkedAdd(left: number, right: number): number { return checkedInteger(left + right); }


function scaledRatio(numerator: number, denominator: number): number {
    if (!Number.isSafeInteger(numerator) || numerator < 0
        || !Number.isSafeInteger(denominator) || denominator < 0) invalid();
    if (denominator === 0) return 0;
    return checkedInteger(Math.floor((numerator * MICRO_SCALE) / denominator));
}


function sorted(values: readonly number[]): number[] {
    if (values.length < 1 || values.some((value) => !Number.isSafeInteger(value))) invalid();
    return [...values].sort((left, right) => left - right);
}


function medianTimes2(values: readonly number[]): number {
    const ordered = sorted(values);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
        ? checkedInteger(ordered[middle]! * 2)
        : checkedAdd(ordered[middle - 1]!, ordered[middle]!);
}


function medianInteger(values: readonly number[]): number {
    const twice = medianTimes2(values);
    if (twice % 2 !== 0) invalid();
    return twice / 2;
}


function distribution(
    values: readonly number[],
    scale: 1 | typeof MICRO_SCALE
): SkillSampleSuiteDistribution {
    const ordered = sorted(values);
    const centerTimes2 = medianTimes2(ordered);
    const deviationsTimes2 = ordered.map((value) => checkedInteger(Math.abs(value * 2 - centerTimes2)));
    return evalFreeze({
        count: ordered.length,
        scale,
        sum: ordered.reduce(checkedAdd, 0),
        min: ordered[0]!,
        max: ordered.at(-1)!,
        medianTimes2: centerTimes2,
        medianAbsoluteDeviationTimes4: medianTimes2(deviationsTimes2),
    });
}


function rateBps(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : Math.floor((numerator * BASIS_POINTS) / denominator);
}


function expectedDirection(
    metric: SkillSampleSuiteProxyMetric,
    goals: readonly string[]
): 'increase' | 'decrease' | 'none' {
    if (metric === 'dialogue-ratio' && goals.includes('dialogue-focused')) return 'increase';
    if (metric === 'mean-sentence-length') {
        const brisk = goals.includes('brisk-pace');
        const restrained = goals.includes('restrained-pace');
        if (brisk === restrained) return 'none';
        return brisk ? 'decrease' : 'increase';
    }
    return 'none';
}


function directionEvidence(
    expected: 'increase' | 'decrease' | 'none',
    scenarioDeltas: readonly number[]
): SkillSampleSuiteDirectionEvidence {
    if (expected === 'none') {
        return evalFreeze({
            expected, toleranceScaled: 0 as const, alignedScenarioCount: 0, opposedScenarioCount: 0,
            tiedScenarioCount: scenarioDeltas.length, decisiveScenarioCount: 0, decisiveRateBps: 0,
            agreementBps: 0, observation: 'unmeasured' as const,
        });
    }
    let aligned = 0;
    let opposed = 0;
    let tied = 0;
    for (const delta of scenarioDeltas) {
        const oriented = expected === 'increase' ? delta : -delta;
        if (oriented > 0) aligned += 1;
        else if (oriented < 0) opposed += 1;
        else tied += 1;
    }
    const decisive = aligned + opposed;
    const agreementBps = rateBps(aligned, decisive);
    const observation = decisive < SKILL_SAMPLE_SUITE_DIRECTION_MIN_DECISIVE_SCENARIOS
        ? 'insufficient' as const
        : agreementBps >= SKILL_SAMPLE_SUITE_DIRECTION_ALIGNMENT_MIN_BPS
            ? 'aligned' as const
            : agreementBps <= SKILL_SAMPLE_SUITE_DIRECTION_OPPOSITION_MAX_BPS
                ? 'opposed' as const
                : 'mixed' as const;
    return evalFreeze({
        expected, toleranceScaled: 0 as const, alignedScenarioCount: aligned,
        opposedScenarioCount: opposed, tiedScenarioCount: tied, decisiveScenarioCount: decisive,
        decisiveRateBps: rateBps(decisive, scenarioDeltas.length), agreementBps, observation,
    });
}


function compareSamples(left: BoundSample, right: BoundSample): number {
    return left.plan.suite.scenarioOrdinal - right.plan.suite.scenarioOrdinal
        || left.plan.suite.repeatIndex - right.plan.suite.repeatIndex;
}


function bindSamples(input: unknown): readonly BoundSample[] {
    const packets = evalDense(input, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_PAIR_COUNT)
        .map((item) => normalizeSkillSamplePacket(item));
    const rows = packets.map((packet) => ({
        packet,
        plan: normalizeSkillSampleSuitePlan(packet.plan),
        receipt: evaluateSkillSampleOffline(packet),
    })).sort(compareSamples);
    const plans = normalizeSkillSampleSuitePlans(rows.map((row) => row.plan));
    if (new Set(rows.map((row) => row.packet.packetDigest)).size !== SKILL_SAMPLE_SUITE_PAIR_COUNT) invalid();
    for (let index = 0; index < rows.length; index += 1) {
        if (rows[index]!.plan.planDigest !== plans[index]!.planDigest
            || rows[index]!.receipt.sourcePacketDigest !== rows[index]!.packet.packetDigest
            || rows[index]!.receipt.algorithmVersion !== SKILL_SAMPLE_OFFLINE_ALGORITHM) invalid();
    }
    const first = rows[0]!;
    if (rows.some((row) => row.plan.source.planDigest !== first.plan.source.planDigest
        || row.plan.suite.manifestDigest !== first.plan.suite.manifestDigest
        || row.packet.modelId !== first.packet.modelId
        || row.packet.modelBindingDigest !== first.packet.modelBindingDigest)) invalid();
    return evalFreeze(rows);
}


function aggregateMetric(
    definition: MetricDefinition,
    samples: readonly BoundSample[],
    goals: readonly string[]
): SkillSampleSuiteMetricAggregate {
    const baseline = samples.map((sample) => definition.read(sample.receipt.arms.baseline));
    const candidate = samples.map((sample) => definition.read(sample.receipt.arms.candidate));
    const deltas = candidate.map((value, index) => checkedInteger(value - baseline[index]!));
    const scenarioBaseline: number[] = [];
    const scenarioCandidate: number[] = [];
    const scenarioDeltas: number[] = [];
    for (let ordinal = 0; ordinal < SKILL_SAMPLE_SUITE_SCENARIO_COUNT; ordinal += 1) {
        const indexes = samples.map((sample, index) => ({ sample, index }))
            .filter(({ sample }) => sample.plan.suite.scenarioOrdinal === ordinal)
            .map(({ index }) => index);
        if (indexes.length !== SKILL_SAMPLE_SUITE_REPEAT_COUNT) invalid();
        scenarioBaseline.push(medianInteger(indexes.map((index) => baseline[index]!)));
        scenarioCandidate.push(medianInteger(indexes.map((index) => candidate[index]!)));
        scenarioDeltas.push(medianInteger(indexes.map((index) => deltas[index]!)));
    }
    return evalFreeze({
        metric: definition.metric,
        pairLevel: {
            baseline: distribution(baseline, definition.scale),
            candidate: distribution(candidate, definition.scale),
            delta: distribution(deltas, definition.scale),
        },
        scenarioLevel: {
            baseline: distribution(scenarioBaseline, definition.scale),
            candidate: distribution(scenarioCandidate, definition.scale),
            delta: distribution(scenarioDeltas, definition.scale),
        },
        direction: directionEvidence(expectedDirection(definition.metric, goals), scenarioDeltas),
    });
}


/**
 * Re-normalizes all 24 original packets and all single-pair receipts. Input order has no meaning;
 * the host suite coordinates define the only aggregation matrix.
 */
export function evaluateSkillSampleSuiteOffline(input: unknown): SkillSampleSuiteOfflineReceipt {
    try {
        const samples = bindSamples(input);
        const first = samples[0]!;
        const goals = first.plan.source.compilePacket.spec.goals;
        const metrics = METRICS.map((definition) => aggregateMetric(definition, samples, goals));
        const scenarioSetDigest = first.plan.fixtureSetDigest;
        const sampleMatrixDigest = evalDigest({
            suiteManifestDigest: first.plan.suite.manifestDigest,
            packets: samples.map((sample) => ({
                scenarioOrdinal: sample.plan.suite.scenarioOrdinal,
                repeatIndex: sample.plan.suite.repeatIndex,
                packetDigest: sample.packet.packetDigest,
            })),
        });
        const generationConfigDigest = evalDigest({
            policyVersion: SKILL_SAMPLE_POLICY_VERSION,
            modelId: first.packet.modelId,
            modelBindingDigest: first.packet.modelBindingDigest,
            rendererVersion: first.plan.rendererVersion,
            compilerRevision: first.plan.compilerRevision,
            primitiveRegistryDigest: first.plan.primitiveRegistryDigest,
            perPairBudgetDigest: first.plan.suite.perPairBudgetDigest,
            perPairInputTokens: first.plan.suite.perPairInputTokens,
            perPairOutputTokens: first.plan.suite.perPairOutputTokens,
            perPairMaxCostMicrousd: first.plan.suite.perPairMaxCostMicrousd,
        });
        const metricPolicyDigest = evalDigest({
            algorithmVersion: SKILL_SAMPLE_SUITE_OFFLINE_ALGORITHM,
            sourceAlgorithmVersion: SKILL_SAMPLE_OFFLINE_ALGORITHM,
            metrics: METRICS.map(({ metric, scale }) => ({ metric, scale })),
            pairReduction: 'all-complete-pairs',
            scenarioReduction: 'median-three-then-equal-weight',
            direction: {
                dialogueFocused: 'dialogue-ratio-increase',
                briskPace: 'mean-sentence-length-decrease',
                restrainedPace: 'mean-sentence-length-increase',
                toleranceScaled: 0,
                minimumDecisiveScenarios: SKILL_SAMPLE_SUITE_DIRECTION_MIN_DECISIVE_SCENARIOS,
                alignmentMinimumBps: SKILL_SAMPLE_SUITE_DIRECTION_ALIGNMENT_MIN_BPS,
                oppositionMaximumBps: SKILL_SAMPLE_SUITE_DIRECTION_OPPOSITION_MAX_BPS,
            },
        });
        const core = {
            receiptVersion: SKILL_SAMPLE_SUITE_OFFLINE_VERSION,
            algorithmVersion: SKILL_SAMPLE_SUITE_OFFLINE_ALGORITHM,
            sourceAlgorithmVersion: SKILL_SAMPLE_OFFLINE_ALGORITHM,
            suiteManifestDigest: first.plan.suite.manifestDigest,
            scenarioSetDigest,
            sampleMatrixDigest,
            sourceIdentityDigest: first.plan.source.planDigest,
            modelBindingDigest: first.packet.modelBindingDigest,
            generationConfigDigest,
            metricPolicyDigest,
            coverage: {
                plannedScenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
                repeatsPerScenario: SKILL_SAMPLE_SUITE_REPEAT_COUNT,
                plannedPairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
                completedPairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
                failedPairCount: 0 as const,
                uncertainPairCount: 0 as const,
                missingPairCount: 0 as const,
                completeScenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
                completionRateBps: BASIS_POINTS,
                matrixStatus: 'complete' as const,
            } as const,
            metrics,
            evidenceClass: 'fixture' as const,
            interpretation: 'descriptive-proxy-only' as const,
            causalEffect: 'unsupported' as const,
            effectOutcome: 'unknown' as const,
            literaryQuality: 'unmeasured' as const,
            semanticQuality: 'unmeasured' as const,
            promotionEligible: false as const,
        };
        return evalFreeze({ ...core, evidenceDigest: evalDigest(core) });
    } catch { return invalid(); }
}
