/** @author Codex @date 2026-10-16 @version 1.0
 * Host-owned blinded literary/semantic fixture registry. It creates evidence plans, never release authority.
 */
import {
    assertCurrentSkillSampleSuitePlan, normalizeSkillSampleSuitePlan,
    SKILL_SAMPLE_SUITE_FIXTURES, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_REPEAT_COUNT,
    SKILL_SAMPLE_SUITE_SCENARIO_COUNT
} from './skill-sample-registry.ts';
import { normalizeSkillSamplePacket, type SkillSamplePacket } from './skill-sample-model.ts';
import { evaluateSkillSampleSuiteOffline } from './skill-sample-suite-offline.ts';
import {
    evalDense, evalDigest, evalFreeze, evalHash, evalRecord, evalSnapshot, evalToken
} from './skill-evaluate-data.ts';

export const SKILL_QUALITY_PLAN_VERSION = 'skill-quality-plan-v1' as const;
export const SKILL_QUALITY_MANIFEST_VERSION = 'skill-quality-manifest-v1' as const;
export const SKILL_QUALITY_REGISTRY_VERSION = 'skill-quality-registry-v1' as const;
export const SKILL_QUALITY_RUBRIC_VERSION = 'skill-quality-literary-rubric-v1' as const;
export const SKILL_QUALITY_FACT_REGISTRY_VERSION = 'skill-quality-semantic-facts-v1' as const;
export const SKILL_QUALITY_JUDGE_COUNT = 2;
export const SKILL_QUALITY_PLAN_COUNT = SKILL_SAMPLE_SUITE_PAIR_COUNT * SKILL_QUALITY_JUDGE_COUNT;
export const SKILL_QUALITY_TOTAL_MODEL_CALLS = SKILL_QUALITY_PLAN_COUNT;

export type SkillQualityJudgeSlot = 'judge-a' | 'judge-b';
export type SkillQualityAnonymousSlot = 'slot-0' | 'slot-1';
export type SkillQualityArm = 'baseline' | 'candidate';

export const SKILL_QUALITY_LITERARY_RUBRIC = evalFreeze({
    rubricVersion: SKILL_QUALITY_RUBRIC_VERSION,
    dimensions: [
        { dimensionId: 'coherence', question: 'Does the narrative remain internally coherent?' },
        { dimensionId: 'scene-specificity', question: 'Does it render the supplied scene with concrete specificity?' },
        { dimensionId: 'voice-consistency', question: 'Is its narrative voice controlled and internally consistent?' },
        { dimensionId: 'pacing-control', question: 'Is sentence and event pacing deliberate rather than accidental?' },
        { dimensionId: 'language-control', question: 'Is the Chinese prose clear, grammatical, and non-mechanical?' },
    ],
    anchors: [
        { score: 0, meaning: 'absent-or-broken' },
        { score: 1, meaning: 'major-problems' },
        { score: 2, meaning: 'mixed-or-basic' },
        { score: 3, meaning: 'strong-with-minor-problems' },
        { score: 4, meaning: 'consistently-strong' },
    ],
    comparisonPolicy: 'score-each-opaque-slot-independently',
    winnerPolicy: 'not-declared',
});
export type SkillQualityDimensionId = typeof SKILL_QUALITY_LITERARY_RUBRIC.dimensions[number]['dimensionId'];
export const SKILL_QUALITY_RUBRIC_DIGEST = evalDigest(SKILL_QUALITY_LITERARY_RUBRIC);

export interface SkillQualityFactAtom {
    readonly factId: string;
    readonly category: 'time' | 'place' | 'participant' | 'action' | 'required-term' | 'forbidden-term';
    readonly statement: string;
    readonly expectation: 'entailed';
    readonly factDigest: string;
}
export interface SkillQualityFactCard {
    readonly fixtureDigest: string;
    readonly cardVersion: typeof SKILL_QUALITY_FACT_REGISTRY_VERSION;
    readonly atoms: readonly SkillQualityFactAtom[];
    readonly cardDigest: string;
}

const FACT_BASES = evalFreeze([
    { time: '周五17:30', place: '公共图书馆服务台', participant: '一位读者和工作人员', actions: ['读者捡到储物柜钥匙', '读者把钥匙交还给工作人员', '读者随后离开'] },
    { time: '周一08:20', place: '社区诊所接待台', participant: '一位访客和工作人员', actions: ['访客在候诊区捡到雨伞', '访客把雨伞交给工作人员', '失物登记完成后访客离开'] },
    { time: '周二19:10', place: '火车站问讯处', participant: '一名乘客和值班人员', actions: ['乘客在候车座椅旁捡到围巾', '乘客把围巾交给值班人员并说明发现位置', '乘客随后赶去检票'] },
    { time: '周三06:45', place: '街角面包店柜台', participant: '店员和顾客', actions: ['店员发现发票数量写错', '店员向顾客说明并重新打印发票', '顾客核对收好后离开'] },
    { time: '周四15:25', place: '城市博物馆出口', participant: '一位参观者和志愿者', actions: ['参观者交还借用的导览手册', '参观者询问闭馆时间', '参观者随后向大厅外走去'] },
    { time: '周六09:40', place: '社区花园工具棚', participant: '两班志愿者', actions: ['一名志愿者擦净修枝剪', '志愿者把剪刀交给下一班同伴', '志愿者在登记板写下归还时间'] },
    { time: '周日13:05', place: '河畔公交站服务亭', participant: '一位候车人和站务员', actions: ['候车人在长椅上发现遗落的保温杯', '候车人把保温杯交给站务员并记下失物编号', '候车人随后登上到站车辆'] },
    { time: '周五16:15', place: '社区艺术中心排练室', participant: '一名乐手和指挥', actions: ['乐手整理排练后的乐谱', '乐手把乐谱交给指挥并确认下次集合时间', '乐手关好谱架后离开'] },
] as const);

function factAtom(fixtureDigest: string, factId: string, category: SkillQualityFactAtom['category'], statement: string): SkillQualityFactAtom {
    const core = { fixtureDigest, factId, category, statement, expectation: 'entailed' as const };
    return evalFreeze({ factId, category, statement, expectation: 'entailed' as const, factDigest: evalDigest(core) });
}

function createFactCards(): readonly SkillQualityFactCard[] {
    return evalFreeze(SKILL_SAMPLE_SUITE_FIXTURES.map((fixture, index) => {
        const fixtureDigest = evalDigest(fixture);
        const base = FACT_BASES[index]!;
        const atoms = [
            factAtom(fixtureDigest, 'time', 'time', `叙事时间为${base.time}`),
            factAtom(fixtureDigest, 'place', 'place', `叙事地点为${base.place}`),
            factAtom(fixtureDigest, 'participant', 'participant', `叙事参与者为${base.participant}`),
            ...base.actions.map((statement, index) => factAtom(fixtureDigest, `action-${index + 1}`, 'action', statement)),
            ...fixture.requiredTerms.map((term, index) => factAtom(fixtureDigest, `required-${index + 1}`, 'required-term', `正文包含字面词“${term}”`)),
            ...fixture.forbiddenTerms.map((term, index) => factAtom(fixtureDigest, `forbidden-${index + 1}`, 'forbidden-term', `正文不包含字面词“${term}”`)),
        ];
        const core = { fixtureDigest, cardVersion: SKILL_QUALITY_FACT_REGISTRY_VERSION, atoms };
        return evalFreeze({ ...core, cardDigest: evalDigest(core) });
    }));
}

export const SKILL_QUALITY_FACT_CARDS = createFactCards();
export const SKILL_QUALITY_FACT_REGISTRY_DIGEST = evalDigest({
    registryVersion: SKILL_QUALITY_FACT_REGISTRY_VERSION,
    cards: SKILL_QUALITY_FACT_CARDS.map(({ fixtureDigest, cardDigest }) => ({ fixtureDigest, cardDigest })),
});
export const SKILL_QUALITY_REGISTRY_DIGEST = evalDigest({
    registryVersion: SKILL_QUALITY_REGISTRY_VERSION,
    rubricDigest: SKILL_QUALITY_RUBRIC_DIGEST,
    factRegistryDigest: SKILL_QUALITY_FACT_REGISTRY_DIGEST,
    judgePolicy: 'two-distinct-groups-reciprocal-order-no-winner',
});

function factCardForOrdinal(ordinal: number): SkillQualityFactCard {
    const card = SKILL_QUALITY_FACT_CARDS[ordinal];
    if (!card) throw new Error('skill-quality-fact-card-unavailable');
    return card;
}

export function skillQualityFactCardForFixture(input: unknown): SkillQualityFactCard {
    const plan = normalizeSkillSampleSuitePlan(input);
    return factCardForOrdinal(plan.suite.scenarioOrdinal);
}

export interface SkillQualityModelBinding {
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly independenceGroupDigest: string;
}
export interface SkillQualityCreateOptions {
    readonly qualitySuiteId: string;
    readonly generation: SkillQualityModelBinding;
    readonly judges: readonly [SkillQualityModelBinding, SkillQualityModelBinding];
    readonly perJudgeBudgetDigest: string;
    readonly perJudgeInputTokens: number;
    readonly perJudgeOutputTokens: number;
    readonly perJudgeMaxCostMicrousd: number;
}
export interface SkillQualityPlan {
    readonly planVersion: typeof SKILL_QUALITY_PLAN_VERSION;
    readonly source: Readonly<{
        sampleSuiteId: string;
        sampleManifestDigest: string;
        sampleMatrixDigest: string;
        sampleJobId: string;
        samplePacketDigest: string;
        samplePlanDigest: string;
        fixtureDigest: string;
        generationModelId: string;
        generationModelBindingDigest: string;
        generationIndependenceGroupDigest: string;
        scenarioOrdinal: number;
        repeatIndex: number;
    }>;
    readonly registry: Readonly<{
        registryVersion: typeof SKILL_QUALITY_REGISTRY_VERSION;
        registryDigest: string;
        rubricDigest: string;
        factRegistryDigest: string;
        factCardDigest: string;
    }>;
    readonly suite: Readonly<{
        manifestVersion: typeof SKILL_QUALITY_MANIFEST_VERSION;
        qualitySuiteId: string;
        manifestDigest: string;
        judgeRegistryDigest: string;
        judgeSlot: SkillQualityJudgeSlot;
        judgeOrdinal: number;
        judgeModelId: string;
        judgeModelBindingDigest: string;
        judgeIndependenceGroupDigest: string;
        baselineSlot: SkillQualityAnonymousSlot;
        candidateSlot: SkillQualityAnonymousSlot;
        pairCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
        judgeCount: typeof SKILL_QUALITY_JUDGE_COUNT;
        planCount: typeof SKILL_QUALITY_PLAN_COUNT;
        totalModelCalls: typeof SKILL_QUALITY_TOTAL_MODEL_CALLS;
        perJudgeBudgetDigest: string;
        perJudgeInputTokens: number;
        perJudgeOutputTokens: number;
        perJudgeMaxCostMicrousd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalMaxCostMicrousd: number;
    }>;
    readonly evidence: Readonly<{
        evidenceClass: 'fixture';
        causalEffect: 'unsupported';
        effectOutcome: 'unknown';
        generalization: 'unsupported';
        winner: 'not-declared';
        promotionEligible: false;
        autoPromotion: false;
    }>;
    readonly planDigest: string;
}

function positive(input: unknown): number {
    if (!Number.isSafeInteger(input) || Number(input) < 1) throw new Error('skill-quality-budget-invalid');
    return Number(input);
}

function binding(input: unknown): SkillQualityModelBinding {
    const value = evalRecord(evalSnapshot(input), ['modelId', 'modelBindingDigest', 'independenceGroupDigest']);
    return evalFreeze({
        modelId: evalToken(value.modelId), modelBindingDigest: evalHash(value.modelBindingDigest),
        independenceGroupDigest: evalHash(value.independenceGroupDigest),
    });
}

function normalizeCreateOptions(input: SkillQualityCreateOptions) {
    const value = evalRecord(evalSnapshot(input), ['qualitySuiteId', 'generation', 'judges',
        'perJudgeBudgetDigest', 'perJudgeInputTokens', 'perJudgeOutputTokens', 'perJudgeMaxCostMicrousd']);
    const generation = binding(value.generation);
    const judges = evalDense(value.judges, 2, 2).map(binding) as unknown as
        readonly [SkillQualityModelBinding, SkillQualityModelBinding];
    const groups = [generation.independenceGroupDigest, ...judges.map((judge) => judge.independenceGroupDigest)];
    const bindingDigests = [generation.modelBindingDigest, ...judges.map((judge) => judge.modelBindingDigest)];
    if (new Set(groups).size !== 3 || new Set(bindingDigests).size !== 3) {
        throw new Error('skill-quality-independence-invalid');
    }
    const perJudgeInputTokens = positive(value.perJudgeInputTokens);
    const perJudgeOutputTokens = positive(value.perJudgeOutputTokens);
    const perJudgeMaxCostMicrousd = positive(value.perJudgeMaxCostMicrousd);
    const totals = [perJudgeInputTokens, perJudgeOutputTokens, perJudgeMaxCostMicrousd]
        .map((item) => item * SKILL_QUALITY_PLAN_COUNT);
    if (totals.some((item) => !Number.isSafeInteger(item))) throw new Error('skill-quality-budget-invalid');
    return evalFreeze({
        qualitySuiteId: evalHash(value.qualitySuiteId), generation, judges,
        perJudgeBudgetDigest: evalHash(value.perJudgeBudgetDigest), perJudgeInputTokens,
        perJudgeOutputTokens, perJudgeMaxCostMicrousd,
        totalInputTokens: totals[0]!, totalOutputTokens: totals[1]!, totalMaxCostMicrousd: totals[2]!,
    });
}

function bindSourcePackets(input: unknown): readonly SkillSamplePacket[] {
    const packets = evalDense(input, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_PAIR_COUNT)
        .map(normalizeSkillSamplePacket)
        .sort((left, right) => {
            const a = normalizeSkillSampleSuitePlan(left.plan).suite;
            const b = normalizeSkillSampleSuitePlan(right.plan).suite;
            return a.scenarioOrdinal - b.scenarioOrdinal || a.repeatIndex - b.repeatIndex;
        });
    evaluateSkillSampleSuiteOffline(packets);
    if (new Set(packets.map((packet) => packet.packetDigest)).size !== SKILL_SAMPLE_SUITE_PAIR_COUNT) {
        throw new Error('skill-quality-source-invalid');
    }
    return evalFreeze(packets);
}

function judgeRegistryDigest(value: ReturnType<typeof normalizeCreateOptions>): string {
    return evalDigest({
        generation: value.generation,
        judges: value.judges.map((judge, ordinal) => ({
            judgeSlot: ordinal === 0 ? 'judge-a' : 'judge-b', ...judge,
        })),
        policy: 'two-distinct-groups-reciprocal-order-no-retry',
    });
}

function normalizeEvidence(input: unknown): SkillQualityPlan['evidence'] {
    const value = evalRecord(input, ['evidenceClass', 'causalEffect', 'effectOutcome', 'generalization',
        'winner', 'promotionEligible', 'autoPromotion']);
    if (value.evidenceClass !== 'fixture' || value.causalEffect !== 'unsupported'
        || value.effectOutcome !== 'unknown' || value.generalization !== 'unsupported'
        || value.winner !== 'not-declared' || value.promotionEligible !== false
        || value.autoPromotion !== false) throw new Error('skill-quality-evidence-invalid');
    return evalFreeze({
        evidenceClass: 'fixture', causalEffect: 'unsupported', effectOutcome: 'unknown',
        generalization: 'unsupported', winner: 'not-declared', promotionEligible: false, autoPromotion: false,
    });
}

const FIXED_EVIDENCE = normalizeEvidence({
    evidenceClass: 'fixture', causalEffect: 'unsupported', effectOutcome: 'unknown',
    generalization: 'unsupported', winner: 'not-declared', promotionEligible: false, autoPromotion: false,
});

function qualityManifest(source: readonly SkillSamplePacket[], value: ReturnType<typeof normalizeCreateOptions>,
    sampleMatrixDigest: string): string {
    const first = source[0]!;
    const firstPlan = normalizeSkillSampleSuitePlan(first.plan);
    return evalDigest({
        manifestVersion: SKILL_QUALITY_MANIFEST_VERSION, qualitySuiteId: value.qualitySuiteId,
        source: {
            sampleSuiteId: firstPlan.suite.suiteId, sampleManifestDigest: firstPlan.suite.manifestDigest,
            sampleMatrixDigest,
            packets: source.map((packet) => ({
                scenarioOrdinal: normalizeSkillSampleSuitePlan(packet.plan).suite.scenarioOrdinal,
                repeatIndex: normalizeSkillSampleSuitePlan(packet.plan).suite.repeatIndex,
                samplePacketDigest: packet.packetDigest,
            })),
        },
        registryDigest: SKILL_QUALITY_REGISTRY_DIGEST, judgeRegistryDigest: judgeRegistryDigest(value),
        budget: {
            perJudgeBudgetDigest: value.perJudgeBudgetDigest, perJudgeInputTokens: value.perJudgeInputTokens,
            perJudgeOutputTokens: value.perJudgeOutputTokens,
            perJudgeMaxCostMicrousd: value.perJudgeMaxCostMicrousd,
            totalInputTokens: value.totalInputTokens, totalOutputTokens: value.totalOutputTokens,
            totalMaxCostMicrousd: value.totalMaxCostMicrousd,
        },
        evidence: FIXED_EVIDENCE,
    });
}

/** Caller bindings are data here; the future Runtime must resolve them from host authority. */
export function createSkillQualityPlans(sourceInput: unknown,
    optionInput: SkillQualityCreateOptions): readonly SkillQualityPlan[] {
    try {
        const source = bindSourcePackets(sourceInput);
        const value = normalizeCreateOptions(optionInput);
        if (source.some((packet) => packet.modelId !== value.generation.modelId
            || packet.modelBindingDigest !== value.generation.modelBindingDigest)) {
            throw new Error('generation-binding-invalid');
        }
        const sampleMatrixDigest = evaluateSkillSampleSuiteOffline(source).sampleMatrixDigest;
        const manifestDigest = qualityManifest(source, value, sampleMatrixDigest);
        const judgesDigest = judgeRegistryDigest(value);
        const plans = source.flatMap((packet) => {
            const samplePlan = normalizeSkillSampleSuitePlan(packet.plan);
            const factCard = skillQualityFactCardForFixture(samplePlan);
            const sourceBinding = {
                sampleSuiteId: samplePlan.suite.suiteId, sampleManifestDigest: samplePlan.suite.manifestDigest,
                sampleMatrixDigest, sampleJobId: packet.jobId, samplePacketDigest: packet.packetDigest,
                samplePlanDigest: samplePlan.planDigest, fixtureDigest: factCard.fixtureDigest,
                generationModelId: packet.modelId, generationModelBindingDigest: packet.modelBindingDigest,
                generationIndependenceGroupDigest: value.generation.independenceGroupDigest,
                scenarioOrdinal: samplePlan.suite.scenarioOrdinal, repeatIndex: samplePlan.suite.repeatIndex,
            };
            return value.judges.map((judge, judgeOrdinal) => {
                const isA = judgeOrdinal === 0;
                const suite = {
                    manifestVersion: SKILL_QUALITY_MANIFEST_VERSION, qualitySuiteId: value.qualitySuiteId,
                    manifestDigest, judgeRegistryDigest: judgesDigest,
                    judgeSlot: (isA ? 'judge-a' : 'judge-b') as SkillQualityJudgeSlot, judgeOrdinal,
                    judgeModelId: judge.modelId, judgeModelBindingDigest: judge.modelBindingDigest,
                    judgeIndependenceGroupDigest: judge.independenceGroupDigest,
                    baselineSlot: (isA ? 'slot-0' : 'slot-1') as SkillQualityAnonymousSlot,
                    candidateSlot: (isA ? 'slot-1' : 'slot-0') as SkillQualityAnonymousSlot,
                    pairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT, judgeCount: SKILL_QUALITY_JUDGE_COUNT,
                    planCount: SKILL_QUALITY_PLAN_COUNT, totalModelCalls: SKILL_QUALITY_TOTAL_MODEL_CALLS,
                    perJudgeBudgetDigest: value.perJudgeBudgetDigest,
                    perJudgeInputTokens: value.perJudgeInputTokens,
                    perJudgeOutputTokens: value.perJudgeOutputTokens,
                    perJudgeMaxCostMicrousd: value.perJudgeMaxCostMicrousd,
                    totalInputTokens: value.totalInputTokens, totalOutputTokens: value.totalOutputTokens,
                    totalMaxCostMicrousd: value.totalMaxCostMicrousd,
                };
                const registry = {
                    registryVersion: SKILL_QUALITY_REGISTRY_VERSION,
                    registryDigest: SKILL_QUALITY_REGISTRY_DIGEST, rubricDigest: SKILL_QUALITY_RUBRIC_DIGEST,
                    factRegistryDigest: SKILL_QUALITY_FACT_REGISTRY_DIGEST, factCardDigest: factCard.cardDigest,
                };
                const core = { planVersion: SKILL_QUALITY_PLAN_VERSION, source: sourceBinding,
                    registry, suite, evidence: FIXED_EVIDENCE };
                return normalizeSkillQualityPlan({ ...core, planDigest: evalDigest(core) });
            });
        });
        return normalizeSkillQualityPlans(plans);
    } catch { throw new Error('skill-quality-plans-invalid'); }
}

export function normalizeSkillQualityPlan(input: unknown): SkillQualityPlan {
    try {
        const value = evalRecord(evalSnapshot(input), ['planVersion', 'source', 'registry', 'suite',
            'evidence', 'planDigest']);
        if (value.planVersion !== SKILL_QUALITY_PLAN_VERSION) throw new Error('version-invalid');
        const sourceValue = evalRecord(value.source, ['sampleSuiteId', 'sampleManifestDigest',
            'sampleMatrixDigest', 'sampleJobId', 'samplePacketDigest', 'samplePlanDigest', 'fixtureDigest',
            'generationModelId', 'generationModelBindingDigest', 'generationIndependenceGroupDigest',
            'scenarioOrdinal', 'repeatIndex']);
        const scenarioOrdinal = Number(sourceValue.scenarioOrdinal);
        const repeatIndex = Number(sourceValue.repeatIndex);
        if (!Number.isSafeInteger(scenarioOrdinal) || scenarioOrdinal < 0
            || scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
            || !Number.isSafeInteger(repeatIndex) || repeatIndex < 0
            || repeatIndex >= SKILL_SAMPLE_SUITE_REPEAT_COUNT) throw new Error('coordinate-invalid');
        const fixtureDigest = evalDigest(SKILL_SAMPLE_SUITE_FIXTURES[scenarioOrdinal]!);
        if (evalHash(sourceValue.fixtureDigest) !== fixtureDigest) throw new Error('fixture-invalid');
        const source = evalFreeze({
            sampleSuiteId: evalHash(sourceValue.sampleSuiteId),
            sampleManifestDigest: evalHash(sourceValue.sampleManifestDigest),
            sampleMatrixDigest: evalHash(sourceValue.sampleMatrixDigest),
            sampleJobId: evalToken(sourceValue.sampleJobId),
            samplePacketDigest: evalHash(sourceValue.samplePacketDigest),
            samplePlanDigest: evalHash(sourceValue.samplePlanDigest), fixtureDigest,
            generationModelId: evalToken(sourceValue.generationModelId),
            generationModelBindingDigest: evalHash(sourceValue.generationModelBindingDigest),
            generationIndependenceGroupDigest: evalHash(sourceValue.generationIndependenceGroupDigest),
            scenarioOrdinal, repeatIndex,
        });
        const registryValue = evalRecord(value.registry, ['registryVersion', 'registryDigest',
            'rubricDigest', 'factRegistryDigest', 'factCardDigest']);
        const card = factCardForOrdinal(scenarioOrdinal);
        if (registryValue.registryVersion !== SKILL_QUALITY_REGISTRY_VERSION
            || registryValue.registryDigest !== SKILL_QUALITY_REGISTRY_DIGEST
            || registryValue.rubricDigest !== SKILL_QUALITY_RUBRIC_DIGEST
            || registryValue.factRegistryDigest !== SKILL_QUALITY_FACT_REGISTRY_DIGEST
            || registryValue.factCardDigest !== card.cardDigest) throw new Error('registry-invalid');
        const registry = evalFreeze({
            registryVersion: SKILL_QUALITY_REGISTRY_VERSION,
            registryDigest: SKILL_QUALITY_REGISTRY_DIGEST,
            rubricDigest: SKILL_QUALITY_RUBRIC_DIGEST,
            factRegistryDigest: SKILL_QUALITY_FACT_REGISTRY_DIGEST,
            factCardDigest: card.cardDigest,
        });
        const suiteValue = evalRecord(value.suite, ['manifestVersion', 'qualitySuiteId', 'manifestDigest',
            'judgeRegistryDigest', 'judgeSlot', 'judgeOrdinal', 'judgeModelId', 'judgeModelBindingDigest',
            'judgeIndependenceGroupDigest', 'baselineSlot', 'candidateSlot', 'pairCount', 'judgeCount',
            'planCount', 'totalModelCalls', 'perJudgeBudgetDigest', 'perJudgeInputTokens',
            'perJudgeOutputTokens', 'perJudgeMaxCostMicrousd', 'totalInputTokens', 'totalOutputTokens',
            'totalMaxCostMicrousd']);
        const judgeOrdinal = Number(suiteValue.judgeOrdinal);
        const isA = judgeOrdinal === 0;
        const perJudgeInputTokens = positive(suiteValue.perJudgeInputTokens);
        const perJudgeOutputTokens = positive(suiteValue.perJudgeOutputTokens);
        const perJudgeMaxCostMicrousd = positive(suiteValue.perJudgeMaxCostMicrousd);
        const expectedTotals = [perJudgeInputTokens, perJudgeOutputTokens, perJudgeMaxCostMicrousd]
            .map((item) => item * SKILL_QUALITY_PLAN_COUNT);
        if (suiteValue.manifestVersion !== SKILL_QUALITY_MANIFEST_VERSION || ![0, 1].includes(judgeOrdinal)
            || suiteValue.judgeSlot !== (isA ? 'judge-a' : 'judge-b')
            || suiteValue.baselineSlot !== (isA ? 'slot-0' : 'slot-1')
            || suiteValue.candidateSlot !== (isA ? 'slot-1' : 'slot-0')
            || suiteValue.pairCount !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || suiteValue.judgeCount !== SKILL_QUALITY_JUDGE_COUNT
            || suiteValue.planCount !== SKILL_QUALITY_PLAN_COUNT
            || suiteValue.totalModelCalls !== SKILL_QUALITY_TOTAL_MODEL_CALLS
            || expectedTotals.some((item) => !Number.isSafeInteger(item))
            || !Number.isSafeInteger(suiteValue.totalInputTokens)
            || !Number.isSafeInteger(suiteValue.totalOutputTokens)
            || !Number.isSafeInteger(suiteValue.totalMaxCostMicrousd)
            || suiteValue.totalInputTokens !== expectedTotals[0]
            || suiteValue.totalOutputTokens !== expectedTotals[1]
            || suiteValue.totalMaxCostMicrousd !== expectedTotals[2]) {
            throw new Error('suite-invalid');
        }
        const suite = evalFreeze({
            manifestVersion: SKILL_QUALITY_MANIFEST_VERSION,
            qualitySuiteId: evalHash(suiteValue.qualitySuiteId),
            manifestDigest: evalHash(suiteValue.manifestDigest),
            judgeRegistryDigest: evalHash(suiteValue.judgeRegistryDigest),
            judgeSlot: suiteValue.judgeSlot as SkillQualityJudgeSlot, judgeOrdinal,
            judgeModelId: evalToken(suiteValue.judgeModelId),
            judgeModelBindingDigest: evalHash(suiteValue.judgeModelBindingDigest),
            judgeIndependenceGroupDigest: evalHash(suiteValue.judgeIndependenceGroupDigest),
            baselineSlot: suiteValue.baselineSlot as SkillQualityAnonymousSlot,
            candidateSlot: suiteValue.candidateSlot as SkillQualityAnonymousSlot,
            pairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT, judgeCount: SKILL_QUALITY_JUDGE_COUNT,
            planCount: SKILL_QUALITY_PLAN_COUNT, totalModelCalls: SKILL_QUALITY_TOTAL_MODEL_CALLS,
            perJudgeBudgetDigest: evalHash(suiteValue.perJudgeBudgetDigest), perJudgeInputTokens,
            perJudgeOutputTokens, perJudgeMaxCostMicrousd,
            totalInputTokens: Number(suiteValue.totalInputTokens),
            totalOutputTokens: Number(suiteValue.totalOutputTokens),
            totalMaxCostMicrousd: Number(suiteValue.totalMaxCostMicrousd),
        });
        const evidence = normalizeEvidence(value.evidence);
        const core = { planVersion: SKILL_QUALITY_PLAN_VERSION, source, registry, suite, evidence };
        if (evalHash(value.planDigest) !== evalDigest(core)) throw new Error('digest-invalid');
        return evalFreeze({ ...core, planDigest: value.planDigest as string }) as SkillQualityPlan;
    } catch { throw new Error('skill-quality-plan-invalid'); }
}

export function normalizeSkillQualityPlans(input: unknown): readonly SkillQualityPlan[] {
    try {
        const plans = evalDense(input, SKILL_QUALITY_PLAN_COUNT, SKILL_QUALITY_PLAN_COUNT)
            .map(normalizeSkillQualityPlan);
        const first = plans[0]!;
        for (const [index, plan] of plans.entries()) {
            const pairOrdinal = Math.floor(index / SKILL_QUALITY_JUDGE_COUNT);
            if (plan.source.scenarioOrdinal !== Math.floor(pairOrdinal / SKILL_SAMPLE_SUITE_REPEAT_COUNT)
                || plan.source.repeatIndex !== pairOrdinal % SKILL_SAMPLE_SUITE_REPEAT_COUNT
                || plan.suite.judgeOrdinal !== index % SKILL_QUALITY_JUDGE_COUNT
                || plan.suite.manifestDigest !== first.suite.manifestDigest
                || plan.suite.qualitySuiteId !== first.suite.qualitySuiteId
                || plan.source.sampleSuiteId !== first.source.sampleSuiteId
                || plan.source.sampleManifestDigest !== first.source.sampleManifestDigest
                || plan.source.sampleMatrixDigest !== first.source.sampleMatrixDigest
                || plan.source.generationModelId !== first.source.generationModelId
                || plan.source.generationModelBindingDigest !== first.source.generationModelBindingDigest
                || plan.source.generationIndependenceGroupDigest
                    !== first.source.generationIndependenceGroupDigest
                || plan.suite.judgeRegistryDigest !== first.suite.judgeRegistryDigest
                || plan.suite.perJudgeBudgetDigest !== first.suite.perJudgeBudgetDigest
                || plan.suite.perJudgeInputTokens !== first.suite.perJudgeInputTokens
                || plan.suite.perJudgeOutputTokens !== first.suite.perJudgeOutputTokens
                || plan.suite.perJudgeMaxCostMicrousd !== first.suite.perJudgeMaxCostMicrousd
                || plan.suite.totalInputTokens !== first.suite.totalInputTokens
                || plan.suite.totalOutputTokens !== first.suite.totalOutputTokens
                || plan.suite.totalMaxCostMicrousd !== first.suite.totalMaxCostMicrousd) {
                throw new Error('matrix-invalid');
            }
            const pairMate = plans[pairOrdinal * SKILL_QUALITY_JUDGE_COUNT]!;
            if (plan.source.sampleJobId !== pairMate.source.sampleJobId
                || plan.source.samplePacketDigest !== pairMate.source.samplePacketDigest
                || plan.source.samplePlanDigest !== pairMate.source.samplePlanDigest
                || plan.source.fixtureDigest !== pairMate.source.fixtureDigest) {
                throw new Error('pair-source-invalid');
            }
        }
        const groups = [first.source.generationIndependenceGroupDigest,
            plans[0]!.suite.judgeIndependenceGroupDigest, plans[1]!.suite.judgeIndependenceGroupDigest];
        const judgeA = plans[0]!.suite; const judgeB = plans[1]!.suite;
        const modelBindingDigests = [first.source.generationModelBindingDigest,
            judgeA.judgeModelBindingDigest, judgeB.judgeModelBindingDigest];
        const sourcePlans = plans.filter((plan) => plan.suite.judgeOrdinal === 0);
        const expectedSampleMatrixDigest = evalDigest({
            suiteManifestDigest: first.source.sampleManifestDigest,
            packets: sourcePlans.map((plan) => ({
                scenarioOrdinal: plan.source.scenarioOrdinal, repeatIndex: plan.source.repeatIndex,
                packetDigest: plan.source.samplePacketDigest,
            })),
        });
        const expectedJudgeRegistryDigest = evalDigest({
            generation: {
                modelId: first.source.generationModelId,
                modelBindingDigest: first.source.generationModelBindingDigest,
                independenceGroupDigest: first.source.generationIndependenceGroupDigest,
            },
            judges: [judgeA, judgeB].map((judge) => ({
                judgeSlot: judge.judgeSlot, modelId: judge.judgeModelId,
                modelBindingDigest: judge.judgeModelBindingDigest,
                independenceGroupDigest: judge.judgeIndependenceGroupDigest,
            })),
            policy: 'two-distinct-groups-reciprocal-order-no-retry',
        });
        const expectedManifestDigest = evalDigest({
            manifestVersion: SKILL_QUALITY_MANIFEST_VERSION,
            qualitySuiteId: first.suite.qualitySuiteId,
            source: {
                sampleSuiteId: first.source.sampleSuiteId,
                sampleManifestDigest: first.source.sampleManifestDigest,
                sampleMatrixDigest: expectedSampleMatrixDigest,
                packets: plans.filter((plan) => plan.suite.judgeOrdinal === 0).map((plan) => ({
                    scenarioOrdinal: plan.source.scenarioOrdinal, repeatIndex: plan.source.repeatIndex,
                    samplePacketDigest: plan.source.samplePacketDigest,
                })),
            },
            registryDigest: SKILL_QUALITY_REGISTRY_DIGEST,
            judgeRegistryDigest: expectedJudgeRegistryDigest,
            budget: {
                perJudgeBudgetDigest: first.suite.perJudgeBudgetDigest,
                perJudgeInputTokens: first.suite.perJudgeInputTokens,
                perJudgeOutputTokens: first.suite.perJudgeOutputTokens,
                perJudgeMaxCostMicrousd: first.suite.perJudgeMaxCostMicrousd,
                totalInputTokens: first.suite.totalInputTokens,
                totalOutputTokens: first.suite.totalOutputTokens,
                totalMaxCostMicrousd: first.suite.totalMaxCostMicrousd,
            },
            evidence: FIXED_EVIDENCE,
        });
        if (new Set(groups).size !== 3 || new Set(modelBindingDigests).size !== 3
            || first.source.sampleMatrixDigest !== expectedSampleMatrixDigest
            || new Set(sourcePlans.map((plan) => plan.source.samplePacketDigest)).size
                !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || new Set(sourcePlans.map((plan) => plan.source.samplePlanDigest)).size
                !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || new Set(sourcePlans.map((plan) => plan.source.sampleJobId)).size
                !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || first.suite.judgeRegistryDigest !== expectedJudgeRegistryDigest
            || first.suite.manifestDigest !== expectedManifestDigest
            || plans.some((plan) => {
                const expected = plan.suite.judgeOrdinal === 0 ? judgeA : judgeB;
                return plan.suite.judgeModelId !== expected.judgeModelId
                    || plan.suite.judgeModelBindingDigest !== expected.judgeModelBindingDigest
                    || plan.suite.judgeIndependenceGroupDigest !== expected.judgeIndependenceGroupDigest;
            }) || new Set(plans.map((plan) => plan.planDigest)).size !== SKILL_QUALITY_PLAN_COUNT) {
            throw new Error('judge-registry-invalid');
        }
        return evalFreeze(plans);
    } catch { throw new Error('skill-quality-plans-invalid'); }
}

export function assertSkillQualityPlanSource(planInput: unknown, packetInput: unknown): SkillQualityPlan {
    const plan = normalizeSkillQualityPlan(planInput);
    const packet = normalizeSkillSamplePacket(packetInput);
    const samplePlan = assertCurrentSkillSampleSuitePlan(packet.plan);
    if (packet.jobId !== plan.source.sampleJobId
        || packet.packetDigest !== plan.source.samplePacketDigest
        || samplePlan.planDigest !== plan.source.samplePlanDigest
        || samplePlan.suite.suiteId !== plan.source.sampleSuiteId
        || samplePlan.suite.manifestDigest !== plan.source.sampleManifestDigest
        || samplePlan.suite.scenarioOrdinal !== plan.source.scenarioOrdinal
        || samplePlan.suite.repeatIndex !== plan.source.repeatIndex
        || packet.modelId !== plan.source.generationModelId
        || packet.modelBindingDigest !== plan.source.generationModelBindingDigest) {
        throw new Error('skill-quality-source-stale');
    }
    return plan;
}

export function assertCurrentSkillQualityPlan(input: unknown): SkillQualityPlan {
    const plan = normalizeSkillQualityPlan(input);
    if (plan.registry.registryDigest !== SKILL_QUALITY_REGISTRY_DIGEST
        || plan.registry.rubricDigest !== SKILL_QUALITY_RUBRIC_DIGEST
        || plan.registry.factRegistryDigest !== SKILL_QUALITY_FACT_REGISTRY_DIGEST) {
        throw new Error('skill-quality-registry-stale');
    }
    return plan;
}

export function assertCurrentSkillQualityPlans(input: unknown): readonly SkillQualityPlan[] {
    const plans = normalizeSkillQualityPlans(input);
    for (const plan of plans) assertCurrentSkillQualityPlan(plan);
    return plans;
}

export function skillQualityPlanDigest(input: unknown): string {
    return normalizeSkillQualityPlan(input).planDigest;
}

export function skillQualityArmForSlot(planInput: unknown, slot: SkillQualityAnonymousSlot): SkillQualityArm {
    const plan = normalizeSkillQualityPlan(planInput);
    if (slot !== 'slot-0' && slot !== 'slot-1') throw new Error('skill-quality-slot-invalid');
    return plan.suite.baselineSlot === slot ? 'baseline' : 'candidate';
}
