/** @author Codex @date 2026-10-17 @version 1.0
 * Background-only blinded quality execution. Complete fixture evidence never grants promotion authority.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    SkillQualityStore, SKILL_QUALITY_DB_FILE, skillQualitySuiteId,
    type SkillQualityFailureReason, type SkillQualitySourceCurrentInput,
    type SkillQualityStoredSuite,
} from '../skill-quality-store.ts';
import {
    readSkillQualityProof, runSkillQualityModel,
    type RunSkillQualityModelInput, type SkillQualityClaim,
} from '../skill-quality-model.ts';
import {
    assertCurrentSkillQualityPlan, assertCurrentSkillQualityPlans, createSkillQualityPlans,
    SKILL_QUALITY_JUDGE_COUNT, SKILL_QUALITY_PLAN_COUNT,
    type SkillQualityModelBinding, type SkillQualityPlan,
} from '../skill-quality-registry.ts';
import {
    normalizeSkillSampleSuitePlan, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_REPEAT_COUNT,
    SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
} from '../skill-sample-registry.ts';
import {
    agentBudgetProfileDigest, normalizeAgentBudgetProfile,
} from '../../../packages/agent-policy/public/budget-profile.ts';
import type {
    SkillQualityDimensionAggregate, SkillQualityFixtureFactCounts,
    SkillQualityIntegerDistribution, SkillQualityJudgeAgreement, SkillQualityOfflineReceipt,
} from '../skill-quality-offline.ts';
import { evalDigest, evalFreeze } from '../skill-evaluate-data.ts';
import type { SkillSampleQualityInput } from './skill-sample-runtime.ts';

export { skillQualityEnabled } from '../skill-quality-authority.ts';

type ModelContext = Omit<RunSkillQualityModelInput, 'claim' | 'allowed' | 'signal'>;
const RETRY_MS = 5_000;
const CLAIM_LEASE_MS = 47_000;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export const SKILL_QUALITY_BATCH_EVIDENCE_VERSION = 'skill-quality-batch-evidence-v1' as const;
export const SKILL_QUALITY_BATCH_PROOF_VERSION = 'skill-quality-batch-proof-v1' as const;

export interface SkillQualityBatchCoordinateV1 {
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly judgeSlot: 'judge-a' | 'judge-b';
}

/**
 * Server-only fixed-batch evidence. This proves current lineage, matrix completeness and retained
 * Gateway execution audits; it deliberately makes no quality, causality, winner or promotion claim.
 */
export interface SkillQualityBatchEvidenceV1 {
    readonly evidenceVersion: typeof SKILL_QUALITY_BATCH_EVIDENCE_VERSION;
    readonly candidateId: string;
    readonly candidateRevision: 1;
    readonly candidateBundleDigest: string;
    readonly candidateManifestDigest: string;
    readonly validationEvidenceDigest: string;
    readonly compilePacketDigest: string;
    readonly sampleSuiteId: string;
    readonly sampleManifestDigest: string;
    readonly sampleMatrixDigest: string;
    readonly qualitySuiteId: string;
    readonly qualityManifestDigest: string;
    readonly qualityMatrixDigest: string;
    readonly coordinateCount: typeof SKILL_QUALITY_PLAN_COUNT;
    readonly coordinates: readonly SkillQualityBatchCoordinateV1[];
    readonly coordinateDigest: string;
    readonly executionAuditSummaryDigest: string;
    readonly offlineEvidenceDigest: string;
    readonly providerExecution: 'unverified';
    readonly causalEffect: 'unsupported';
    readonly winner: 'not-declared';
    readonly promotionEligible: false;
    readonly evidenceDigest: string;
}

export interface SkillQualityBatchEvidenceProofV1 {
    readonly proofVersion: typeof SKILL_QUALITY_BATCH_PROOF_VERSION;
    readonly evidenceDigest: string;
}

type SkillQualityBatchEvidenceEntry = Readonly<{
    owner: object;
    receipt: SkillQualityBatchEvidenceV1;
    snapshotDigest: string;
}>;

const QUALITY_BATCH_EVIDENCE_PROOFS = new WeakMap<object, SkillQualityBatchEvidenceEntry>();

export interface SkillQualityJudgeModelContext extends ModelContext, SkillQualityModelBinding {
    readonly judgeSlot: 'judge-a' | 'judge-b';
}

/** Host-owned and frozen at one resolution boundary; callers never submit these bindings. */
export interface SkillQualityAuthoritySnapshot {
    readonly generation: SkillQualityModelBinding;
    readonly judges: readonly [SkillQualityJudgeModelContext, SkillQualityJudgeModelContext];
    readonly perJudgeBudgetDigest: string;
}

export interface SkillQualityRuntimeOptions {
    readonly dataDir: string;
    enabled(): boolean;
    sourceAllowed(rawSessionId: string): boolean;
    resolveSource(sampleSuiteId: string): SkillSampleQualityInput | null;
    /** Readback-only source for already-completed evidence; never grants a dispatch. */
    resolveCompletedSource?(sampleSuiteId: string): SkillSampleQualityInput | null;
    resolveAuthority(source: SkillSampleQualityInput): SkillQualityAuthoritySnapshot | null;
    readonly now?: () => string;
    readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    onFailure?(code: 'skill-quality-open-failed' | 'skill-quality-recovery-pending'): void;
}

type ResolvedQualityAuthority = Readonly<{
    source: SkillSampleQualityInput;
    authority: SkillQualityAuthoritySnapshot;
    budget: ReturnType<typeof normalizeAgentBudgetProfile>;
    plans: readonly SkillQualityPlan[];
}>;

type ResolvedQualityContext = Omit<ResolvedQualityAuthority, 'plans'>;

function sourceFor(options: SkillQualityRuntimeOptions, sampleSuiteId: string, completed = false): SkillSampleQualityInput | null {
    try {
        if (completed && !options.resolveCompletedSource) return null;
        const source = completed ? options.resolveCompletedSource!(sampleSuiteId) : options.resolveSource(sampleSuiteId);
        if (!source || source.sampleSuiteId !== sampleSuiteId || !options.sourceAllowed(source.rawSessionId)
            || !HASH.test(source.sampleManifestDigest) || !HASH.test(source.sampleMatrixDigest)
            || source.samplePackets.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || source.samplePackets.some((packet) => packet.rawSessionId !== source.rawSessionId
                || packet.modelId !== source.generation.modelId
                || packet.modelBindingDigest !== source.generation.modelBindingDigest)) return null;
        return source;
    } catch { return null; }
}

function resolveQualityContext(
    options: SkillQualityRuntimeOptions,
    source: SkillSampleQualityInput,
): ResolvedQualityContext | null {
    try {
        const authority = options.resolveAuthority(source);
        if (!authority || authority.judges.length !== 2
            || authority.judges[0].judgeSlot !== 'judge-a'
            || authority.judges[1].judgeSlot !== 'judge-b'
            || authority.generation.modelId !== source.generation.modelId
            || authority.generation.modelBindingDigest !== source.generation.modelBindingDigest) return null;
        const bindings = [authority.generation, authority.judges[0], authority.judges[1]];
        if (bindings.some((binding) => !MODEL_ID.test(binding.modelId)
            || !HASH.test(binding.modelBindingDigest) || !HASH.test(binding.independenceGroupDigest))
            || new Set(bindings.map((binding) => binding.modelBindingDigest)).size !== 3
            || new Set(bindings.map((binding) => binding.independenceGroupDigest)).size !== 3) return null;
        const left = normalizeAgentBudgetProfile(authority.judges[0].budgetProfile);
        const right = normalizeAgentBudgetProfile(authority.judges[1].budgetProfile);
        const leftDigest = agentBudgetProfileDigest(left);
        const rightDigest = agentBudgetProfileDigest(right);
        if (leftDigest !== rightDigest || authority.perJudgeBudgetDigest !== leftDigest
            || left.lane !== 'style' || left.maxModelCalls !== 1 || left.maxSteps !== 1
            || left.maxToolCalls !== 0 || left.maxWrites !== 0
            || left.agentInputBudgetTokens > 8_000 || left.agentOutputBudgetTokens > 1_600
            || left.maxWallMs > 30_000) return null;
        return Object.freeze({ source, authority, budget: left });
    } catch { return null; }
}

function resolveQualityAuthority(
    options: SkillQualityRuntimeOptions,
    source: SkillSampleQualityInput,
    qualitySuiteId: string,
): ResolvedQualityAuthority | null {
    try {
        const context = resolveQualityContext(options, source);
        if (!context) return null;
        const { authority, budget } = context;
        const plans = createSkillQualityPlans(source.samplePackets, {
            qualitySuiteId,
            generation: authority.generation,
            judges: [
                {
                    modelId: authority.judges[0].modelId,
                    modelBindingDigest: authority.judges[0].modelBindingDigest,
                    independenceGroupDigest: authority.judges[0].independenceGroupDigest,
                },
                {
                    modelId: authority.judges[1].modelId,
                    modelBindingDigest: authority.judges[1].modelBindingDigest,
                    independenceGroupDigest: authority.judges[1].independenceGroupDigest,
                },
            ],
            perJudgeBudgetDigest: authority.perJudgeBudgetDigest,
            perJudgeInputTokens: budget.agentInputBudgetTokens,
            perJudgeOutputTokens: budget.agentOutputBudgetTokens,
            perJudgeMaxCostMicrousd: budget.maxCostMicrousd,
        });
        return Object.freeze({ ...context, plans });
    } catch { return null; }
}

export function skillQualitySourceCurrent(
    options: SkillQualityRuntimeOptions,
    retained: SkillQualitySourceCurrentInput,
    completed = false,
): boolean {
    try {
        const plans = assertCurrentSkillQualityPlans(retained.plans);
        const first = plans[0]!;
        const source = sourceFor(options, first.source.sampleSuiteId, completed);
        if (!source || source.rawSessionId !== retained.rawSessionId) return false;
        const context = resolveQualityContext(options, source);
        if (!context || JSON.stringify(source.samplePackets) !== JSON.stringify(retained.samplePackets)) {
            return false;
        }
        if (first.source.sampleManifestDigest !== source.sampleManifestDigest
            || first.source.sampleMatrixDigest !== source.sampleMatrixDigest) return false;
        return plans.every((plan) => {
            const judge = context.authority.judges[plan.suite.judgeOrdinal];
            return plan.source.generationModelId === context.authority.generation.modelId
                && plan.source.generationModelBindingDigest
                    === context.authority.generation.modelBindingDigest
                && plan.source.generationIndependenceGroupDigest
                    === context.authority.generation.independenceGroupDigest
                && judge !== undefined && plan.suite.judgeSlot === judge.judgeSlot
                && plan.suite.judgeModelId === judge.modelId
                && plan.suite.judgeModelBindingDigest === judge.modelBindingDigest
                && plan.suite.judgeIndependenceGroupDigest === judge.independenceGroupDigest
                && plan.suite.perJudgeBudgetDigest === context.authority.perJudgeBudgetDigest
                && plan.suite.perJudgeInputTokens === context.budget.agentInputBudgetTokens
                && plan.suite.perJudgeOutputTokens === context.budget.agentOutputBudgetTokens
                && plan.suite.perJudgeMaxCostMicrousd === context.budget.maxCostMicrousd;
        });
    } catch { return false; }
}

function qualityDistributionView(value: SkillQualityIntegerDistribution) {
    return Object.freeze({
        count: value.count,
        scale: value.scale,
        sum: value.sum,
        min: value.min,
        max: value.max,
        medianTimes2: value.medianTimes2,
        medianAbsoluteDeviationTimes4: value.medianAbsoluteDeviationTimes4,
    });
}

function qualityAgreementView(value: SkillQualityJudgeAgreement) {
    return Object.freeze({
        comparisonCount: value.comparisonCount,
        tolerance: value.tolerance,
        exactCount: value.exactCount,
        adjacentCount: value.adjacentCount,
        divergentCount: value.divergentCount,
        withinToleranceCount: value.withinToleranceCount,
        withinToleranceRateBps: value.withinToleranceRateBps,
    });
}

function qualityDimensionView(value: SkillQualityDimensionAggregate) {
    return Object.freeze({
        dimensionId: value.dimensionId,
        scoreBounds: Object.freeze({
            judgeMinimum: value.scoreBounds.judgeMinimum,
            judgeMaximum: value.scoreBounds.judgeMaximum,
            scoreSumMinimum: value.scoreBounds.scoreSumMinimum,
            scoreSumMaximum: value.scoreBounds.scoreSumMaximum,
            scoreSumScale: value.scoreBounds.scoreSumScale,
        }),
        pairLevel: Object.freeze({
            baseline: qualityDistributionView(value.pairLevel.baseline),
            candidate: qualityDistributionView(value.pairLevel.candidate),
            delta: qualityDistributionView(value.pairLevel.delta),
        }),
        scenarioLevel: Object.freeze({
            baseline: qualityDistributionView(value.scenarioLevel.baseline),
            candidate: qualityDistributionView(value.scenarioLevel.candidate),
            delta: qualityDistributionView(value.scenarioLevel.delta),
        }),
        judgeAgreement: Object.freeze({
            baseline: qualityAgreementView(value.judgeAgreement.baseline),
            candidate: qualityAgreementView(value.judgeAgreement.candidate),
        }),
    });
}

function qualityFactCountsView(value: SkillQualityFixtureFactCounts) {
    return Object.freeze({
        observationCount: value.observationCount,
        satisfiedCount: value.satisfiedCount,
        failedCount: value.failedCount,
        inconclusiveCount: value.inconclusiveCount,
    });
}

function skillQualityBatchEvidence(stored: SkillQualityStoredSuite): Readonly<{
    receipt: SkillQualityBatchEvidenceV1;
    snapshotDigest: string;
}> | null {
    try {
        if (stored.state !== 'succeeded' || stored.sourceCurrent !== true || !stored.evaluation
            || stored.plans.length !== SKILL_QUALITY_PLAN_COUNT
            || stored.jobs.length !== SKILL_QUALITY_PLAN_COUNT
            || stored.samplePackets.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || stored.execution.completedJobCount !== SKILL_QUALITY_PLAN_COUNT
            || stored.execution.expectedJobCount !== SKILL_QUALITY_PLAN_COUNT
            || stored.execution.gatewayProofStatus !== 'complete') return null;

        const plans = assertCurrentSkillQualityPlans(stored.plans);
        const first = plans[0]!;
        const samplePlans = stored.samplePackets.map((packet) => normalizeSkillSampleSuitePlan(packet.plan));
        const firstSamplePlan = samplePlans[0]!;
        const candidate = firstSamplePlan.source.candidate;
        const compilePacket = firstSamplePlan.source.compilePacket;
        if (candidate.state !== 'validated' || candidate.revision !== 1
            || candidate.validationEvidenceDigest === null
            || candidate.operationalReplayEvidenceDigest !== null
            || first.suite.qualitySuiteId !== stored.suiteId
            || first.source.sampleSuiteId !== firstSamplePlan.suite.suiteId
            || first.source.sampleManifestDigest !== firstSamplePlan.suite.manifestDigest) return null;

        for (const [index, samplePlan] of samplePlans.entries()) {
            const packet = stored.samplePackets[index]!;
            const scenarioOrdinal = Math.floor(index / SKILL_SAMPLE_SUITE_REPEAT_COUNT);
            const repeatIndex = index % SKILL_SAMPLE_SUITE_REPEAT_COUNT;
            if (samplePlan.suite.scenarioOrdinal !== scenarioOrdinal
                || samplePlan.suite.repeatIndex !== repeatIndex
                || samplePlan.suite.suiteId !== first.source.sampleSuiteId
                || samplePlan.suite.manifestDigest !== first.source.sampleManifestDigest
                || samplePlan.source.candidate.candidateId !== candidate.candidateId
                || samplePlan.source.candidate.revision !== candidate.revision
                || samplePlan.source.candidate.bundleDigest !== candidate.bundleDigest
                || samplePlan.source.compilePacket.packetDigest !== compilePacket.packetDigest
                || packet.planDigest !== samplePlan.planDigest) return null;
        }

        const coordinates: SkillQualityBatchCoordinateV1[] = [];
        const executionAuditSummary: Array<Readonly<{
            scenarioOrdinal: number;
            repeatIndex: number;
            judgeSlot: 'judge-a' | 'judge-b';
            jobId: string;
            planDigest: string;
            samplePacketDigest: string;
            qualityPacketDigest: string;
            executionPacketDigest: string;
            claimDigest: string;
            leaseAuditDigest: string;
            completedAt: string;
        }>> = [];
        const coordinateKeys = new Set<string>();
        for (const [index, item] of stored.jobs.entries()) {
            const plan = plans[index]!;
            const pairOrdinal = Math.floor(index / SKILL_QUALITY_JUDGE_COUNT);
            const scenarioOrdinal = Math.floor(pairOrdinal / SKILL_SAMPLE_SUITE_REPEAT_COUNT);
            const repeatIndex = pairOrdinal % SKILL_SAMPLE_SUITE_REPEAT_COUNT;
            const judgeSlot = index % SKILL_QUALITY_JUDGE_COUNT === 0 ? 'judge-a' as const : 'judge-b' as const;
            const samplePacket = stored.samplePackets[pairOrdinal]!;
            if (scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
                || item.job.state !== 'succeeded' || !item.packet || !item.execution
                || item.job.plan.planDigest !== plan.planDigest
                || item.job.qualitySuiteId !== stored.suiteId
                || item.job.samplePacketDigest !== samplePacket.packetDigest
                || item.samplePacket.packetDigest !== samplePacket.packetDigest
                || plan.source.scenarioOrdinal !== scenarioOrdinal
                || plan.source.repeatIndex !== repeatIndex
                || plan.suite.judgeSlot !== judgeSlot
                || plan.source.samplePacketDigest !== samplePacket.packetDigest
                || item.packet.planDigest !== plan.planDigest
                || item.packet.samplePacketDigest !== samplePacket.packetDigest
                || item.execution.jobId !== item.job.jobId
                || item.execution.qualityPacket.packetDigest !== item.packet.packetDigest
                || item.execution.completedAt !== item.job.updatedAt) return null;
            const coordinate = evalFreeze({ scenarioOrdinal, repeatIndex, judgeSlot });
            const key = `${scenarioOrdinal}:${repeatIndex}:${judgeSlot}`;
            if (coordinateKeys.has(key)) return null;
            coordinateKeys.add(key);
            coordinates.push(coordinate);
            executionAuditSummary.push(evalFreeze({
                scenarioOrdinal, repeatIndex, judgeSlot,
                jobId: item.job.jobId,
                planDigest: plan.planDigest,
                samplePacketDigest: samplePacket.packetDigest,
                qualityPacketDigest: item.packet.packetDigest,
                executionPacketDigest: item.execution.packetDigest,
                claimDigest: item.execution.claimDigest,
                leaseAuditDigest: item.execution.leaseAuditDigest,
                completedAt: item.execution.completedAt,
            }));
        }
        if (coordinateKeys.size !== SKILL_QUALITY_PLAN_COUNT) return null;

        const evaluation = stored.evaluation;
        if (evaluation.qualitySuiteId !== stored.suiteId
            || evaluation.qualityManifestDigest !== first.suite.manifestDigest
            || evaluation.sourceSuiteId !== first.source.sampleSuiteId
            || evaluation.sourceSuiteManifestDigest !== first.source.sampleManifestDigest
            || evaluation.sourceMatrixDigest !== first.source.sampleMatrixDigest
            || evaluation.coverage.plannedScenarioCount !== SKILL_SAMPLE_SUITE_SCENARIO_COUNT
            || evaluation.coverage.repeatsPerScenario !== SKILL_SAMPLE_SUITE_REPEAT_COUNT
            || evaluation.coverage.plannedPairCount !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || evaluation.coverage.judgesPerPair !== SKILL_QUALITY_JUDGE_COUNT
            || evaluation.coverage.plannedPacketCount !== SKILL_QUALITY_PLAN_COUNT
            || evaluation.coverage.normalizedPacketCount !== SKILL_QUALITY_PLAN_COUNT
            || evaluation.coverage.missingPacketCount !== 0
            || evaluation.coverage.duplicatePacketCount !== 0
            || evaluation.coverage.matrixStatus !== 'structurally-complete-unverified'
            || evaluation.coverage.providerExecution !== 'unverified'
            || evaluation.providerExecution !== 'unverified'
            || evaluation.causalEffect !== 'unsupported'
            || evaluation.winner !== 'not-declared'
            || evaluation.promotionEligible !== false
            || evaluation.autoPromotion !== false) return null;

        const frozenCoordinates = evalFreeze(coordinates);
        const coordinateDigest = evalDigest(frozenCoordinates);
        const executionAuditSummaryDigest = evalDigest(executionAuditSummary);
        const core = {
            evidenceVersion: SKILL_QUALITY_BATCH_EVIDENCE_VERSION,
            candidateId: candidate.candidateId,
            candidateRevision: 1 as const,
            candidateBundleDigest: candidate.bundleDigest,
            candidateManifestDigest: candidate.header.manifestDigest,
            validationEvidenceDigest: candidate.validationEvidenceDigest,
            compilePacketDigest: compilePacket.packetDigest,
            sampleSuiteId: first.source.sampleSuiteId,
            sampleManifestDigest: first.source.sampleManifestDigest,
            sampleMatrixDigest: first.source.sampleMatrixDigest,
            qualitySuiteId: stored.suiteId,
            qualityManifestDigest: first.suite.manifestDigest,
            qualityMatrixDigest: evaluation.qualityMatrixDigest,
            coordinateCount: SKILL_QUALITY_PLAN_COUNT,
            coordinates: frozenCoordinates,
            coordinateDigest,
            executionAuditSummaryDigest,
            offlineEvidenceDigest: evaluation.evidenceDigest,
            providerExecution: 'unverified' as const,
            causalEffect: 'unsupported' as const,
            winner: 'not-declared' as const,
            promotionEligible: false as const,
        };
        const receipt = evalFreeze({ ...core, evidenceDigest: evalDigest(core) });
        const snapshotDigest = evalDigest({
            evidenceDigest: receipt.evidenceDigest,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            plans: plans.map((plan) => plan.planDigest),
            samplePackets: stored.samplePackets.map((packet) => packet.packetDigest),
            executionAuditSummary,
        });
        return Object.freeze({ receipt, snapshotDigest });
    } catch { return null; }
}

/** Exact allow-list: per-pair observations and per-fact observations remain Store-only evidence. */
function qualityEvaluationView(value: SkillQualityOfflineReceipt) {
    return Object.freeze({
        receiptVersion: value.receiptVersion,
        algorithmVersion: value.algorithmVersion,
        qualitySuiteId: value.qualitySuiteId,
        qualityManifestDigest: value.qualityManifestDigest,
        qualityMatrixDigest: value.qualityMatrixDigest,
        sourceSuiteId: value.sourceSuiteId,
        sourceSuiteManifestDigest: value.sourceSuiteManifestDigest,
        sourceMatrixDigest: value.sourceMatrixDigest,
        registryDigest: value.registryDigest,
        rubricDigest: value.rubricDigest,
        factRegistryDigest: value.factRegistryDigest,
        judgeRegistryDigest: value.judgeRegistryDigest,
        budget: Object.freeze({
            perJudgeBudgetDigest: value.budget.perJudgeBudgetDigest,
            perJudgeInputTokens: value.budget.perJudgeInputTokens,
            perJudgeOutputTokens: value.budget.perJudgeOutputTokens,
            perJudgeMaxCostMicrousd: value.budget.perJudgeMaxCostMicrousd,
            totalInputTokens: value.budget.totalInputTokens,
            totalOutputTokens: value.budget.totalOutputTokens,
            totalMaxCostMicrousd: value.budget.totalMaxCostMicrousd,
        }),
        aggregationPolicyDigest: value.aggregationPolicyDigest,
        coverage: Object.freeze({
            plannedScenarioCount: value.coverage.plannedScenarioCount,
            repeatsPerScenario: value.coverage.repeatsPerScenario,
            plannedPairCount: value.coverage.plannedPairCount,
            judgesPerPair: value.coverage.judgesPerPair,
            plannedPacketCount: value.coverage.plannedPacketCount,
            normalizedPacketCount: value.coverage.normalizedPacketCount,
            missingPacketCount: value.coverage.missingPacketCount,
            duplicatePacketCount: value.coverage.duplicatePacketCount,
            matrixStatus: value.coverage.matrixStatus,
            providerExecution: value.coverage.providerExecution,
        }),
        dimensions: Object.freeze(value.dimensions.map(qualityDimensionView)),
        semanticFixtureFacts: Object.freeze({
            scope: value.semanticFixtureFacts.scope,
            observation: value.semanticFixtureFacts.observation,
            summary: Object.freeze({
                baseline: qualityFactCountsView(value.semanticFixtureFacts.summary.baseline),
                candidate: qualityFactCountsView(value.semanticFixtureFacts.summary.candidate),
            }),
        }),
        summary: Object.freeze({
            normalizedPacketCount: value.summary.normalizedPacketCount,
            literary: Object.freeze({
                concordantPairCount: value.summary.literary.concordantPairCount,
                inconclusivePairCount: value.summary.literary.inconclusivePairCount,
                fullyConcordantScenarioCount: value.summary.literary.fullyConcordantScenarioCount,
                inconclusiveScenarioCount: value.summary.literary.inconclusiveScenarioCount,
            }),
            fixtureFacts: Object.freeze({
                baseline: qualityFactCountsView(value.summary.fixtureFacts.baseline),
                candidate: qualityFactCountsView(value.summary.fixtureFacts.candidate),
            }),
        }),
        evidenceClass: value.evidenceClass,
        interpretation: value.interpretation,
        providerExecution: value.providerExecution,
        causalEffect: value.causalEffect,
        effectOutcome: value.effectOutcome,
        generalization: value.generalization,
        winner: value.winner,
        literaryQuality: value.literaryQuality,
        literaryObservation: value.literaryObservation,
        semanticQuality: value.semanticQuality,
        semanticScope: value.semanticScope,
        promotionEligible: value.promotionEligible,
        autoPromotion: value.autoPromotion,
        evidenceDigest: value.evidenceDigest,
    });
}

/** Public administrator projection. It contains no session id, prompt, arm body, plan or execution audit. */
export function skillQualitySuiteView(stored: SkillQualityStoredSuite) {
    const first = stored.plans[0]!;
    const states = stored.jobs.map((item) => item.job.state);
    const succeededJobCount = states.filter((state) => state === 'succeeded').length;
    const failedJobCount = states.filter((state) => state === 'failed').length;
    const uncertainJobCount = states.filter((state) => state === 'uncertain').length;
    const runningJobCount = states.filter((state) => state === 'running').length;
    const queuedJobCount = states.filter((state) => state === 'queued').length;
    return Object.freeze({
        suiteId: stored.suiteId,
        sourceSuiteId: first.source.sampleSuiteId,
        state: stored.state,
        qualityManifestDigest: first.suite.manifestDigest,
        sourceManifestDigest: first.source.sampleManifestDigest,
        sourceMatrixDigest: first.source.sampleMatrixDigest,
        registryDigest: first.registry.registryDigest,
        rubricDigest: first.registry.rubricDigest,
        factRegistryDigest: first.registry.factRegistryDigest,
        judgeRegistryDigest: first.suite.judgeRegistryDigest,
        pairCount: first.suite.pairCount,
        judgeCount: first.suite.judgeCount,
        planCount: first.suite.planCount,
        totalModelCalls: first.suite.totalModelCalls,
        perJudgeBudgetDigest: first.suite.perJudgeBudgetDigest,
        totalInputTokens: first.suite.totalInputTokens,
        totalOutputTokens: first.suite.totalOutputTokens,
        totalMaxCostMicrousd: first.suite.totalMaxCostMicrousd,
        coverage: Object.freeze({
            succeededJobCount, failedJobCount, uncertainJobCount, runningJobCount, queuedJobCount,
            completionRateBps: Math.floor(succeededJobCount * 10_000 / first.suite.planCount),
            matrixStatus: succeededJobCount === first.suite.planCount
                ? 'complete' as const : 'incomplete' as const,
        }),
        children: Object.freeze(stored.jobs.map((item) => Object.freeze({
            jobId: item.job.jobId,
            state: item.job.state,
            scenarioOrdinal: item.job.plan.source.scenarioOrdinal,
            repeatIndex: item.job.plan.source.repeatIndex,
            judgeSlot: item.job.plan.suite.judgeSlot,
            updatedAt: item.job.updatedAt,
            reasonCode: item.job.reasonCode,
        }))),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        sourceCurrentness: stored.sourceCurrent ? 'current' as const : 'stale' as const,
        evaluation: stored.evaluation ? qualityEvaluationView(stored.evaluation) : null,
        execution: Object.freeze({
            completedJobCount: stored.execution.completedJobCount,
            expectedJobCount: stored.execution.expectedJobCount,
            gatewayProofStatus: stored.execution.gatewayProofStatus,
        }),
        executionClass: 'fixture' as const,
        interpretation: 'descriptive-proxy-only' as const,
        causalEffect: 'unsupported' as const,
        effect: 'unknown' as const,
        promotionEligible: false,
    });
}

export class SkillQualityRuntime {
    readonly #store: SkillQualityStore;
    readonly #options: SkillQualityRuntimeOptions;
    readonly #owner = `skill-quality-worker:${randomUUID()}`;
    readonly #batchEvidenceOwner = Object.freeze({});
    #timer: ReturnType<typeof setTimeout> | null = null;
    #active: { rawSessionId: string; controller: AbortController; done: Promise<void> } | null = null;
    #closed = false;
    #busy = false;
    #recovering = true;

    constructor(store: SkillQualityStore, options: SkillQualityRuntimeOptions) {
        this.#store = store;
        this.#options = options;
        store.recoverUncertain();
        this.#recovering = store.status().running > 0;
    }

    submitSuite(input: { sampleSuiteId: string; idempotencyKey: string }) {
        this.#open();
        if (!this.#options.enabled()) throw new Error('skill-quality-suite-disabled');
        const source = sourceFor(this.#options, input.sampleSuiteId);
        if (!source) throw new Error('skill-quality-suite-source-unavailable');
        const suiteId = skillQualitySuiteId(input.idempotencyKey);
        const resolved = resolveQualityAuthority(this.#options, source, suiteId);
        if (!resolved) throw new Error('skill-quality-suite-model-unavailable');
        const stored = this.#store.enqueueSuite({
            rawSessionId: source.rawSessionId,
            plans: resolved.plans,
            samplePackets: source.samplePackets,
            createdAt: this.#now(),
        }, input.idempotencyKey);
        this.schedule();
        return skillQualitySuiteView(stored);
    }

    readSuite(suiteId: string) {
        this.#open();
        const stored = this.#store.readSuite(suiteId);
        return stored ? skillQualitySuiteView(stored) : null;
    }

    /**
     * 只读：把某批 Quality 执行的离线回执交给发布侧重算裁决。
     * 只回执，不含正文/证据集；`null` = 该批未完成或不存在。
     */
    readOfflineReceipt(suiteId: string): SkillQualityOfflineReceipt | null {
        this.#open();
        return this.#store.readSuite(suiteId)?.evaluation ?? null;
    }

    /** 只读：发布侧汇合需要存储层 suite（packet/job 证据），视图里没有。 */
    readStoredSuite(suiteId: string): SkillQualityStoredSuite | null {
        this.#open();
        return this.#store.readSuite(suiteId);
    }

    /** Publication readback: revalidate completed evidence without authorizing new Judge calls. */
    readCompletedEvidenceSuite(suiteId: string): SkillQualityStoredSuite | null {
        this.#open();
        const stored = this.#store.readSuite(suiteId);
        if (!stored || stored.state !== 'succeeded' || !stored.evaluation
            || stored.execution.gatewayProofStatus !== 'complete') return null;
        const rawSessionId = stored.samplePackets[0]?.rawSessionId;
        if (!rawSessionId) return null;
        const sourceCurrent = skillQualitySourceCurrent(this.#options, {
            rawSessionId, plans: stored.plans, samplePackets: stored.samplePackets,
        }, true);
        return Object.freeze({ ...stored, sourceCurrent });
    }

    listCompletedEvidenceForSample(sampleSuiteId: string, cursor = ''): Readonly<{
        suiteIds: readonly string[]; hasMore: boolean; nextCursor: string | null; unavailable: boolean;
    }> {
        this.#open();
        if (!this.#options.resolveCompletedSource) throw new Error('skill-quality-completed-source-unavailable');
        const page = this.#store.listCompletedForSample(sampleSuiteId, cursor);
        const suiteIds = page.suiteIds.filter((id) => this.readCompletedEvidenceSuite(id)?.sourceCurrent === true);
        return Object.freeze({ suiteIds: Object.freeze(suiteIds), hasMore: page.hasMore,
            nextCursor: page.nextCursor, unavailable: page.unavailable || suiteIds.length !== page.suiteIds.length });
    }

    /**
     * Mints a process-local capability only after two identical reads of one complete, current,
     * fixed 8x3x2 batch. The capability is not a quality verdict and carries no write authority.
     */
    readBatchEvidence(suiteId: string): SkillQualityBatchEvidenceProofV1 | null {
        this.#open();
        if (!this.#options.enabled()) return null;
        if (!HASH.test(suiteId)) throw new Error('skill-quality-batch-reference-invalid');
        try {
            const firstStored = this.#store.readSuite(suiteId);
            if (!firstStored) return null;
            const first = skillQualityBatchEvidence(firstStored);
            if (!first) return null;
            const secondStored = this.#store.readSuite(suiteId);
            if (!secondStored) return null;
            const second = skillQualityBatchEvidence(secondStored);
            if (!second || second.snapshotDigest !== first.snapshotDigest
                || second.receipt.evidenceDigest !== first.receipt.evidenceDigest) return null;
            const proof = Object.freeze({
                proofVersion: SKILL_QUALITY_BATCH_PROOF_VERSION,
                evidenceDigest: first.receipt.evidenceDigest,
            });
            QUALITY_BATCH_EVIDENCE_PROOFS.set(proof, Object.freeze({
                owner: this.#batchEvidenceOwner,
                receipt: first.receipt,
                snapshotDigest: first.snapshotDigest,
            }));
            return proof;
        } catch { return null; }
    }

    /** Only this live Runtime may unwrap its proof, while the durable source remains unchanged. */
    readCurrentBatchEvidence(proof: unknown): SkillQualityBatchEvidenceV1 | null {
        if (this.#closed || !this.#options.enabled() || !proof || typeof proof !== 'object') return null;
        const retained = QUALITY_BATCH_EVIDENCE_PROOFS.get(proof);
        if (!retained || retained.owner !== this.#batchEvidenceOwner) return null;
        try {
            const stored = this.#store.readSuite(retained.receipt.qualitySuiteId);
            if (!stored) return null;
            const current = skillQualityBatchEvidence(stored);
            if (!current || current.snapshotDigest !== retained.snapshotDigest
                || current.receipt.evidenceDigest !== retained.receipt.evidenceDigest) return null;
            return retained.receipt;
        } catch { return null; }
    }

    schedule(): void {
        if (this.#closed || this.#busy) return;
        if (this.#timer) clearTimeout(this.#timer);
        this.#wake(0);
    }

    async quiesceSession(rawSessionId: string): Promise<void> {
        const active = this.#active;
        if (active?.rawSessionId !== rawSessionId) return;
        active.controller.abort();
        await active.done;
    }

    redactSession(rawSessionId: string): void {
        this.#open();
        if (this.#active?.rawSessionId === rawSessionId) this.#active.controller.abort();
        this.#store.redactSession(rawSessionId);
    }

    async shutdown(): Promise<void> {
        this.#active?.controller.abort();
        await this.#active?.done.catch(() => this.#warn());
        this.close();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#active?.controller.abort();
        this.#store.close();
    }

    #open(): void {
        if (this.#closed) throw new Error('skill-quality-runtime-closed');
    }

    #now(): string { return this.#options.now?.() ?? new Date().toISOString(); }

    #warn(): void {
        try { this.#options.onFailure?.('skill-quality-recovery-pending'); }
        catch { /* Optional diagnostics cannot change execution authority. */ }
    }

    #wake(delayMs: number): void {
        if (this.#closed) return;
        this.#timer = setTimeout(() => { this.#timer = null; void this.#runBatch(); }, delayMs);
        this.#timer.unref?.();
    }

    #resolvedForClaim(claim: SkillQualityClaim): ResolvedQualityContext | null {
        const first = claim.plans[0];
        if (!first) return null;
        const source = sourceFor(this.#options, first.source.sampleSuiteId);
        if (!source || source.rawSessionId !== claim.rawSessionId) return null;
        const context = resolveQualityContext(this.#options, source);
        if (!context) return null;
        let selected: SkillQualityPlan;
        try { selected = assertCurrentSkillQualityPlan(claim.selectedPlan); }
        catch { return null; }
        const packet = source.samplePackets[
            selected.source.scenarioOrdinal * SKILL_SAMPLE_SUITE_REPEAT_COUNT + selected.source.repeatIndex];
        const judge = context.authority.judges[selected.suite.judgeOrdinal];
        if (!packet || !judge || claim.selectedPlanDigest !== selected.planDigest
            || selected.suite.qualitySuiteId !== first.suite.qualitySuiteId
            || selected.source.sampleSuiteId !== source.sampleSuiteId
            || selected.source.sampleMatrixDigest !== source.sampleMatrixDigest
            || selected.source.sampleManifestDigest !== source.sampleManifestDigest
            || source.samplePackets.some((item) => {
                const sourcePlan = normalizeSkillSampleSuitePlan(item.plan);
                return sourcePlan.suite.suiteId !== source.sampleSuiteId
                    || sourcePlan.suite.manifestDigest !== selected.source.sampleManifestDigest;
            })
            || selected.source.generationModelId !== context.authority.generation.modelId
            || selected.source.generationModelBindingDigest
                !== context.authority.generation.modelBindingDigest
            || selected.source.generationIndependenceGroupDigest
                !== context.authority.generation.independenceGroupDigest
            || selected.suite.judgeSlot !== judge.judgeSlot
            || selected.suite.judgeModelId !== judge.modelId
            || selected.suite.judgeModelBindingDigest !== judge.modelBindingDigest
            || selected.suite.judgeIndependenceGroupDigest !== judge.independenceGroupDigest
            || selected.suite.perJudgeBudgetDigest !== context.authority.perJudgeBudgetDigest
            || selected.suite.perJudgeInputTokens !== context.budget.agentInputBudgetTokens
            || selected.suite.perJudgeOutputTokens !== context.budget.agentOutputBudgetTokens
            || selected.suite.perJudgeMaxCostMicrousd !== context.budget.maxCostMicrousd
            || claim.modelId !== judge.modelId || claim.modelBindingDigest !== judge.modelBindingDigest
            || JSON.stringify(claim.samplePacket) !== JSON.stringify(packet)) return null;
        return context;
    }

    #allowed(claim: SkillQualityClaim, signal: AbortSignal): boolean {
        try {
            if (this.#closed || signal.aborted || !this.#options.enabled()) return false;
            const resolved = this.#resolvedForClaim(claim);
            if (!resolved) return false;
            const context = resolved.authority.judges[claim.selectedPlan.suite.judgeOrdinal];
            if (!context || context.modelId !== claim.modelId
                || context.modelBindingDigest !== claim.modelBindingDigest) return false;
            return this.#store.ownsClaim(claim);
        } catch { return false; }
    }

    #fail(claim: SkillQualityClaim, reason: SkillQualityFailureReason): void {
        if (this.#closed) return;
        try { this.#store.markFailed(claim, reason); }
        catch { this.#recovering = true; this.#warn(); }
    }

    async #judge(claim: SkillQualityClaim, controller: AbortController): Promise<void> {
        let proof: Awaited<ReturnType<typeof runSkillQualityModel>>;
        try {
            const resolved = this.#resolvedForClaim(claim);
            const context = resolved?.authority.judges[claim.selectedPlan.suite.judgeOrdinal];
            if (!context || !this.#allowed(claim, controller.signal)) {
                throw new Error('skill-quality-source-invalidated');
            }
            const { judgeSlot: _judgeSlot, independenceGroupDigest: _group, ...model } = context;
            proof = await runSkillQualityModel({
                ...model,
                claim,
                signal: controller.signal,
                allowed: () => this.#allowed(claim, controller.signal),
            });
            if (!this.#allowed(claim, controller.signal)) {
                throw new Error('skill-quality-source-invalidated');
            }
        } catch {
            this.#fail(claim, this.#allowed(claim, controller.signal)
                ? 'skill-quality-model-failed' : 'skill-quality-source-invalidated');
            return;
        }
        try { this.#store.finish(claim, proof); }
        catch {
            if (this.#closed) return;
            try {
                const stored = this.#store.read(claim.jobId);
                if (stored?.job.state === 'succeeded'
                    && stored.execution?.packetDigest === readSkillQualityProof(proof).packetDigest) return;
            } catch { this.#warn(); }
            this.#fail(claim, this.#allowed(claim, controller.signal)
                ? 'skill-quality-persistence-unconfirmed' : 'skill-quality-source-invalidated');
            this.#warn();
        }
    }

    async #runBatch(): Promise<void> {
        if (this.#closed || this.#busy) return;
        this.#busy = true;
        let processed = false;
        try {
            if (this.#recovering) {
                this.#store.recoverUncertain();
                this.#recovering = this.#store.status().running > 0;
                if (this.#recovering) return;
            }
            if (this.#options.enabled()) {
                const claim = this.#store.claimNext(this.#owner, CLAIM_LEASE_MS, (plan) => {
                    try { assertCurrentSkillQualityPlan(plan); return true; }
                    catch { return false; }
                });
                if (claim) {
                    processed = true;
                    const controller = new AbortController();
                    const done = this.#judge(claim, controller);
                    this.#active = { rawSessionId: claim.rawSessionId, controller, done };
                    try { await done; }
                    finally { this.#active = null; }
                }
            }
        } catch { this.#warn(); }
        finally {
            this.#busy = false;
            if (!this.#closed) {
                try {
                    if (this.#recovering) this.#wake(RETRY_MS);
                    else if (this.#store.status().queued > 0) this.#wake(processed ? 0 : RETRY_MS);
                } catch { this.#warn(); this.#wake(RETRY_MS); }
            }
        }
    }
}

export function openSkillQualityRuntime(options: SkillQualityRuntimeOptions): SkillQualityRuntime | null {
    let store: SkillQualityStore | null = null;
    try {
        if (!options.enabled() && !existsSync(join(options.dataDir, SKILL_QUALITY_DB_FILE))) return null;
        store = new SkillQualityStore({
            dataDir: options.dataDir,
            now: options.now,
            isSessionDeleted: options.isSessionDeleted,
            sourceCurrent: (source) => skillQualitySourceCurrent(options, source),
        });
        const runtime = new SkillQualityRuntime(store, options);
        runtime.schedule();
        return runtime;
    } catch {
        try { store?.close(); } catch { /* Preserve the optional service's closed state. */ }
        try { options.onFailure?.('skill-quality-open-failed'); }
        catch { /* Quality evaluation is optional and must never block dialogue Agents. */ }
        return null;
    }
}
