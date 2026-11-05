/** @author Codex @date 2026-10-16 @version 1.0
 * Fixed neutral fixture and actual host Style rendering, without live admission or promotion authority.
 */
import { renderAgentSkillStyleFixture, AGENT_SKILL_COMPILER_REVISION, AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST }
    from '@jiuguan/prompt/agent-skill-compiler';
import { assertCurrentSkillEvaluatePlan, normalizeSkillEvaluatePlan, type SkillEvaluatePlan }
    from './skill-evaluate-registry.ts';
import { evalCanonical, evalDense, evalDigest, evalFreeze, evalHash, evalRawDigest, evalRecord, evalSnapshot,
    evalToken }
    from './skill-evaluate-data.ts';

export const SKILL_SAMPLE_PLAN_VERSION = 'skill-sample-plan-v1' as const;
export const SKILL_SAMPLE_RENDERER_VERSION = 'agent-skill-style-fixture-renderer-v1' as const;
export interface SkillSampleFixture {
    readonly fixtureId: string;
    readonly revision: string;
    readonly language: 'zh-CN';
    readonly prompt: string;
    readonly requiredTerms: readonly string[];
    readonly forbiddenTerms: readonly string[];
}
export const SKILL_SAMPLE_FIXTURE: SkillSampleFixture = evalFreeze({
    fixtureId: 'neutral-library-key-return', revision: '1.0.0', language: 'zh-CN',
    prompt: '请写一段200至400字的中文叙事。时间为周五17:30，地点为公共图书馆服务台。'
        + '一位读者将捡到的储物柜钥匙交还给工作人员，然后离开。保持上述时间、地点和动作。'
        + '正文必须包含字面词“图书馆”和“钥匙”，不得出现字面词“爆炸”。',
    requiredTerms: ['图书馆', '钥匙'], forbiddenTerms: ['爆炸'],
});
export const SKILL_SAMPLE_FIXTURE_SET_DIGEST = evalDigest({
    fixtureSetVersion: 'skill-sample-neutral-fixtures-v1', fixtures: [SKILL_SAMPLE_FIXTURE],
});
export const SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST = evalRawDigest('');

export interface SkillSamplePlan {
    readonly planVersion: typeof SKILL_SAMPLE_PLAN_VERSION;
    readonly source: SkillEvaluatePlan;
    readonly fixture: SkillSampleFixture;
    readonly fixtureSetDigest: string;
    readonly rendererVersion: typeof SKILL_SAMPLE_RENDERER_VERSION;
    readonly compilerRevision: string;
    readonly primitiveRegistryDigest: string;
    readonly candidateInstruction: string;
    readonly candidateInstructionDigest: string;
    readonly baselineInstructionDigest: string;
    readonly planDigest: string;
}


function rendered(source: SkillEvaluatePlan) {
    return renderAgentSkillStyleFixture(JSON.parse(source.compilePacket.submission.bundle.body) as unknown);
}


/** Physical source authority is supplied by the runtime, never by serialized plan bytes. */
export function createSkillSamplePlan(input: unknown): SkillSamplePlan {
    try {
        const source = assertCurrentSkillEvaluatePlan(input);
        const render = rendered(source);
        const core = {
            planVersion: SKILL_SAMPLE_PLAN_VERSION, source, fixture: SKILL_SAMPLE_FIXTURE,
            fixtureSetDigest: SKILL_SAMPLE_FIXTURE_SET_DIGEST,
            rendererVersion: render.rendererVersion, compilerRevision: render.compilerRevision,
            primitiveRegistryDigest: render.primitiveRegistryDigest, candidateInstruction: render.instruction,
            candidateInstructionDigest: render.instructionDigest,
            baselineInstructionDigest: SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST,
        };
        return normalizeSkillSamplePlan({ ...core, planDigest: evalDigest(core) });
    } catch { throw new Error('skill-sample-plan-invalid'); }
}


/** Passive history keeps its original revision/digests; it cannot mint live source or model authority. */
export function normalizeSkillSamplePlan(input: unknown): SkillSamplePlan {
    try {
        const value = evalRecord(evalSnapshot(input), ['planVersion', 'source', 'fixture', 'fixtureSetDigest',
            'rendererVersion', 'compilerRevision', 'primitiveRegistryDigest', 'candidateInstruction',
            'candidateInstructionDigest', 'baselineInstructionDigest', 'planDigest']);
        const source = normalizeSkillEvaluatePlan(value.source);
        if (value.planVersion !== SKILL_SAMPLE_PLAN_VERSION
            || value.rendererVersion !== SKILL_SAMPLE_RENDERER_VERSION
            || evalCanonical(value.fixture) !== evalCanonical(SKILL_SAMPLE_FIXTURE)
            || value.fixtureSetDigest !== SKILL_SAMPLE_FIXTURE_SET_DIGEST
            || value.primitiveRegistryDigest !== source.primitiveRegistryDigest
            || typeof value.candidateInstruction !== 'string' || value.candidateInstruction.length < 1
            || value.candidateInstruction.length > 12_000 || value.candidateInstruction.trim().length === 0
            || value.candidateInstructionDigest !== evalRawDigest(value.candidateInstruction)
            || value.baselineInstructionDigest !== SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST) {
            throw new Error('fixture-render-binding-invalid');
        }
        const core = {
            planVersion: SKILL_SAMPLE_PLAN_VERSION, source, fixture: SKILL_SAMPLE_FIXTURE,
            fixtureSetDigest: SKILL_SAMPLE_FIXTURE_SET_DIGEST, rendererVersion: SKILL_SAMPLE_RENDERER_VERSION,
            compilerRevision: evalToken(value.compilerRevision),
            primitiveRegistryDigest: evalHash(value.primitiveRegistryDigest),
            candidateInstruction: value.candidateInstruction as string,
            candidateInstructionDigest: evalHash(value.candidateInstructionDigest),
            baselineInstructionDigest: SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST,
        };
        if (evalHash(value.planDigest) !== evalDigest(core)) throw new Error('plan-hash-invalid');
        return evalFreeze({ ...core, planDigest: value.planDigest as string });
    } catch { throw new Error('skill-sample-plan-invalid'); }
}


export function skillSamplePlanDigest(input: unknown): string { return normalizeSkillSamplePlan(input).planDigest; }


export function assertCurrentSkillSamplePlan(input: unknown): SkillSamplePlan {
    const plan = normalizeSkillSamplePlan(input);
    try { assertCurrentSkillEvaluatePlan(plan.source); }
    catch { throw new Error('skill-sample-registry-stale'); }
    if (plan.compilerRevision !== AGENT_SKILL_COMPILER_REVISION
        || plan.primitiveRegistryDigest !== AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST) {
        throw new Error('skill-sample-registry-stale');
    }
    const render = rendered(plan.source);
    if (plan.candidateInstruction !== render.instruction
        || plan.candidateInstructionDigest !== render.instructionDigest) {
        throw new Error('skill-sample-registry-stale');
    }
    return plan;
}


export const SKILL_SAMPLE_SUITE_PLAN_VERSION = 'skill-sample-plan-v2' as const;
export const SKILL_SAMPLE_SUITE_MANIFEST_VERSION = 'skill-sample-suite-manifest-v1' as const;
export const SKILL_SAMPLE_SUITE_DEFINITION_ID = 'skill-sample-suite-neutral-8x3-v1' as const;
export const SKILL_SAMPLE_SUITE_SCENARIO_COUNT = 8;
export const SKILL_SAMPLE_SUITE_REPEAT_COUNT = 3;
export const SKILL_SAMPLE_SUITE_PAIR_COUNT = 24;
export const SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS = 48;

export const SKILL_SAMPLE_SUITE_FIXTURES: readonly SkillSampleFixture[] = evalFreeze([
    SKILL_SAMPLE_FIXTURE,
    {
        fixtureId: 'neutral-clinic-umbrella-return', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周一08:20，地点为社区诊所接待台。'
            + '一位访客将候诊区捡到的雨伞交给工作人员，确认失物登记完成后离开。保持上述时间、地点和动作。'
            + '正文必须包含字面词“诊所”和“雨伞”，不得出现字面词“争吵”。',
        requiredTerms: ['诊所', '雨伞'], forbiddenTerms: ['争吵'],
    },
    {
        fixtureId: 'neutral-station-scarf-return', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周二19:10，地点为火车站问讯处。'
            + '一名乘客将候车座椅旁捡到的围巾交给值班人员，说明发现位置后赶去检票。保持上述时间、地点和动作。'
            + '正文必须包含字面词“火车站”和“围巾”，不得出现字面词“追逐”。',
        requiredTerms: ['火车站', '围巾'], forbiddenTerms: ['追逐'],
    },
    {
        fixtureId: 'neutral-bakery-receipt-correction', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周三06:45，地点为街角面包店柜台。'
            + '店员发现发票上的数量写错，向顾客说明情况并重新打印，顾客核对后收好离开。保持上述时间、地点和动作。'
            + '正文必须包含字面词“面包店”和“发票”，不得出现字面词“火灾”。',
        requiredTerms: ['面包店', '发票'], forbiddenTerms: ['火灾'],
    },
    {
        fixtureId: 'neutral-museum-guidebook-return', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周四15:25，地点为城市博物馆出口。'
            + '一位参观者将借用的导览手册交还给志愿者，询问闭馆时间后向大厅外走去。保持上述时间、地点和动作。'
            + '正文必须包含字面词“博物馆”和“手册”，不得出现字面词“盗窃”。',
        requiredTerms: ['博物馆', '手册'], forbiddenTerms: ['盗窃'],
    },
    {
        fixtureId: 'neutral-garden-shears-handoff', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周六09:40，地点为社区花园工具棚。'
            + '一名志愿者擦净修枝剪，将剪刀交给下一班同伴，并在登记板上写下归还时间。保持上述时间、地点和动作。'
            + '正文必须包含字面词“花园”和“剪刀”，不得出现字面词“受伤”。',
        requiredTerms: ['花园', '剪刀'], forbiddenTerms: ['受伤'],
    },
    {
        fixtureId: 'neutral-bus-stop-thermos-return', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周日13:05，地点为河畔公交站服务亭。'
            + '一位候车人把长椅上遗落的保温杯交给站务员，记下失物编号后登上到站车辆。保持上述时间、地点和动作。'
            + '正文必须包含字面词“公交站”和“保温杯”，不得出现字面词“事故”。',
        requiredTerms: ['公交站', '保温杯'], forbiddenTerms: ['事故'],
    },
    {
        fixtureId: 'neutral-art-center-score-return', revision: '1.0.0', language: 'zh-CN',
        prompt: '请写一段200至400字的中文叙事。时间为周五16:15，地点为社区艺术中心排练室。'
            + '一名乐手把排练后整理好的乐谱交给指挥，确认下次集合时间，再关好谱架离开。保持上述时间、地点和动作。'
            + '正文必须包含字面词“排练室”和“乐谱”，不得出现字面词“冲突”。',
        requiredTerms: ['排练室', '乐谱'], forbiddenTerms: ['冲突'],
    },
]);

export const SKILL_SAMPLE_SUITE_FIXTURE_SET_DIGEST = evalDigest({
    fixtureSetVersion: 'skill-sample-suite-neutral-fixtures-v1', fixtures: SKILL_SAMPLE_SUITE_FIXTURES,
});

export interface SkillSampleSuiteCreateOptions {
    readonly suiteId: string;
    readonly perPairBudgetDigest: string;
    readonly perPairInputTokens: number;
    readonly perPairOutputTokens: number;
    readonly perPairMaxCostMicrousd: number;
}

export interface SkillSampleSuiteBinding {
    readonly suiteDefinitionId: typeof SKILL_SAMPLE_SUITE_DEFINITION_ID;
    readonly suiteId: string;
    readonly manifestDigest: string;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly scenarioCount: typeof SKILL_SAMPLE_SUITE_SCENARIO_COUNT;
    readonly repeatCount: typeof SKILL_SAMPLE_SUITE_REPEAT_COUNT;
    readonly pairCount: typeof SKILL_SAMPLE_SUITE_PAIR_COUNT;
    readonly totalModelCalls: typeof SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS;
    readonly perPairBudgetDigest: string;
    readonly perPairInputTokens: number;
    readonly perPairOutputTokens: number;
    readonly perPairMaxCostMicrousd: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalMaxCostMicrousd: number;
}

export interface SkillSampleSuitePlan {
    readonly planVersion: typeof SKILL_SAMPLE_SUITE_PLAN_VERSION;
    readonly source: SkillEvaluatePlan;
    readonly fixture: SkillSampleFixture;
    readonly fixtureSetDigest: string;
    readonly rendererVersion: typeof SKILL_SAMPLE_RENDERER_VERSION;
    readonly compilerRevision: string;
    readonly primitiveRegistryDigest: string;
    readonly candidateInstruction: string;
    readonly candidateInstructionDigest: string;
    readonly baselineInstructionDigest: string;
    readonly suite: SkillSampleSuiteBinding;
    readonly planDigest: string;
}

type SkillSampleSuiteBudget = Readonly<{
    suiteId: string;
    perPairBudgetDigest: string;
    perPairInputTokens: number;
    perPairOutputTokens: number;
    perPairMaxCostMicrousd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalMaxCostMicrousd: number;
}>;


function positiveInteger(input: unknown): number {
    if (!Number.isSafeInteger(input) || Number(input) < 1) throw new Error('suite-budget-invalid');
    return Number(input);
}


function suiteBudget(input: unknown): SkillSampleSuiteBudget {
    const value = evalRecord(evalSnapshot(input), ['suiteId', 'perPairBudgetDigest', 'perPairInputTokens',
        'perPairOutputTokens', 'perPairMaxCostMicrousd']);
    const suiteId = evalHash(value.suiteId);
    const perPairBudgetDigest = evalHash(value.perPairBudgetDigest);
    const perPairInputTokens = positiveInteger(value.perPairInputTokens);
    const perPairOutputTokens = positiveInteger(value.perPairOutputTokens);
    const perPairMaxCostMicrousd = positiveInteger(value.perPairMaxCostMicrousd);
    const totals = [perPairInputTokens, perPairOutputTokens, perPairMaxCostMicrousd]
        .map((item) => item * SKILL_SAMPLE_SUITE_PAIR_COUNT);
    if (totals.some((item) => !Number.isSafeInteger(item))) throw new Error('suite-budget-invalid');
    return evalFreeze({
        suiteId, perPairBudgetDigest, perPairInputTokens, perPairOutputTokens, perPairMaxCostMicrousd,
        totalInputTokens: totals[0]!, totalOutputTokens: totals[1]!, totalMaxCostMicrousd: totals[2]!,
    });
}


function normalizeSuiteBinding(input: unknown): SkillSampleSuiteBinding {
    const value = evalRecord(input, ['suiteDefinitionId', 'suiteId', 'manifestDigest', 'scenarioOrdinal',
        'repeatIndex', 'scenarioCount', 'repeatCount', 'pairCount', 'totalModelCalls', 'perPairBudgetDigest',
        'perPairInputTokens', 'perPairOutputTokens', 'perPairMaxCostMicrousd', 'totalInputTokens',
        'totalOutputTokens', 'totalMaxCostMicrousd']);
    const scenarioOrdinal = Number(value.scenarioOrdinal);
    const repeatIndex = Number(value.repeatIndex);
    const budget = suiteBudget({
        suiteId: value.suiteId, perPairBudgetDigest: value.perPairBudgetDigest,
        perPairInputTokens: value.perPairInputTokens, perPairOutputTokens: value.perPairOutputTokens,
        perPairMaxCostMicrousd: value.perPairMaxCostMicrousd,
    });
    if (value.suiteDefinitionId !== SKILL_SAMPLE_SUITE_DEFINITION_ID
        || !Number.isSafeInteger(scenarioOrdinal) || scenarioOrdinal < 0
        || scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
        || !Number.isSafeInteger(repeatIndex) || repeatIndex < 0 || repeatIndex >= SKILL_SAMPLE_SUITE_REPEAT_COUNT
        || value.scenarioCount !== SKILL_SAMPLE_SUITE_SCENARIO_COUNT
        || value.repeatCount !== SKILL_SAMPLE_SUITE_REPEAT_COUNT || value.pairCount !== SKILL_SAMPLE_SUITE_PAIR_COUNT
        || value.totalModelCalls !== SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS
        || value.totalInputTokens !== budget.totalInputTokens
        || value.totalOutputTokens !== budget.totalOutputTokens
        || value.totalMaxCostMicrousd !== budget.totalMaxCostMicrousd) throw new Error('suite-binding-invalid');
    const { suiteId, ...budgetFields } = budget;
    return evalFreeze({
        suiteDefinitionId: SKILL_SAMPLE_SUITE_DEFINITION_ID, suiteId,
        manifestDigest: evalHash(value.manifestDigest),
        scenarioOrdinal, repeatIndex, scenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
        repeatCount: SKILL_SAMPLE_SUITE_REPEAT_COUNT, pairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
        totalModelCalls: SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS, ...budgetFields,
    });
}


function suiteManifestDigest(source: SkillEvaluatePlan, common: {
    rendererVersion: string; compilerRevision: string; primitiveRegistryDigest: string;
    candidateInstructionDigest: string; baselineInstructionDigest: string;
}, budget: SkillSampleSuiteBudget): string {
    return evalDigest({
        manifestVersion: SKILL_SAMPLE_SUITE_MANIFEST_VERSION,
        suiteDefinitionId: SKILL_SAMPLE_SUITE_DEFINITION_ID, suiteId: budget.suiteId,
        sourcePlanDigest: source.planDigest,
        fixtureSet: {
            fixtureSetDigest: SKILL_SAMPLE_SUITE_FIXTURE_SET_DIGEST,
            fixtures: SKILL_SAMPLE_SUITE_FIXTURES.map((fixture, scenarioOrdinal) => ({
                scenarioOrdinal, fixtureId: fixture.fixtureId, revision: fixture.revision,
                fixtureDigest: evalDigest(fixture),
            })),
        },
        rendererVersion: common.rendererVersion, compilerRevision: common.compilerRevision,
        primitiveRegistryDigest: common.primitiveRegistryDigest,
        candidateInstructionDigest: common.candidateInstructionDigest,
        baselineInstructionDigest: common.baselineInstructionDigest,
        budget: {
            ...budget, scenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
            repeatCount: SKILL_SAMPLE_SUITE_REPEAT_COUNT, pairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT,
            totalModelCalls: SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS,
        },
    });
}


function suiteCommon(render: ReturnType<typeof rendered>) {
    return {
        rendererVersion: render.rendererVersion, compilerRevision: render.compilerRevision,
        primitiveRegistryDigest: render.primitiveRegistryDigest, candidateInstruction: render.instruction,
        candidateInstructionDigest: render.instructionDigest,
        baselineInstructionDigest: SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST,
    };
}


/** Creates one immutable two-arm child plan per scenario/repeat; ordering is scenario-major then repeat-major. */
export function createSkillSampleSuitePlans(
    input: unknown, options: SkillSampleSuiteCreateOptions,
): readonly SkillSampleSuitePlan[] {
    try {
        const source = assertCurrentSkillEvaluatePlan(input);
        const render = rendered(source);
        const common = suiteCommon(render);
        const budget = suiteBudget(options);
        const manifestDigest = suiteManifestDigest(source, common, budget);
        const { suiteId, ...budgetFields } = budget;
        const plans = SKILL_SAMPLE_SUITE_FIXTURES.flatMap((fixture, scenarioOrdinal) =>
            Array.from({ length: SKILL_SAMPLE_SUITE_REPEAT_COUNT }, (_, repeatIndex) => {
                const suite = {
                    suiteDefinitionId: SKILL_SAMPLE_SUITE_DEFINITION_ID, suiteId,
                    manifestDigest, scenarioOrdinal, repeatIndex,
                    scenarioCount: SKILL_SAMPLE_SUITE_SCENARIO_COUNT, repeatCount: SKILL_SAMPLE_SUITE_REPEAT_COUNT,
                    pairCount: SKILL_SAMPLE_SUITE_PAIR_COUNT, totalModelCalls: SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS,
                    ...budgetFields,
                };
                const core = {
                    planVersion: SKILL_SAMPLE_SUITE_PLAN_VERSION, source, fixture,
                    fixtureSetDigest: SKILL_SAMPLE_SUITE_FIXTURE_SET_DIGEST, ...common, suite,
                };
                return normalizeSkillSampleSuitePlan({ ...core, planDigest: evalDigest(core) });
            }));
        return normalizeSkillSampleSuitePlans(plans);
    } catch { throw new Error('skill-sample-suite-plan-invalid'); }
}


/** V2 history is self-verifying; only assertCurrentSkillSampleSuitePlan can grant current registry authority. */
export function normalizeSkillSampleSuitePlan(input: unknown): SkillSampleSuitePlan {
    try {
        const value = evalRecord(evalSnapshot(input), ['planVersion', 'source', 'fixture', 'fixtureSetDigest',
            'rendererVersion', 'compilerRevision', 'primitiveRegistryDigest', 'candidateInstruction',
            'candidateInstructionDigest', 'baselineInstructionDigest', 'suite', 'planDigest']);
        if (value.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION
            || value.rendererVersion !== SKILL_SAMPLE_RENDERER_VERSION
            || value.fixtureSetDigest !== SKILL_SAMPLE_SUITE_FIXTURE_SET_DIGEST
            || typeof value.candidateInstruction !== 'string' || value.candidateInstruction.length < 1
            || value.candidateInstruction.length > 12_000 || value.candidateInstruction.trim().length === 0
            || value.candidateInstructionDigest !== evalRawDigest(value.candidateInstruction)
            || value.baselineInstructionDigest !== SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST) {
            throw new Error('suite-plan-contract-invalid');
        }
        const source = normalizeSkillEvaluatePlan(value.source);
        const suite = normalizeSuiteBinding(value.suite);
        const fixture = SKILL_SAMPLE_SUITE_FIXTURES[suite.scenarioOrdinal]!;
        if (evalCanonical(value.fixture) !== evalCanonical(fixture)
            || value.primitiveRegistryDigest !== source.primitiveRegistryDigest) {
            throw new Error('suite-fixture-binding-invalid');
        }
        const common = {
            rendererVersion: SKILL_SAMPLE_RENDERER_VERSION,
            compilerRevision: evalToken(value.compilerRevision),
            primitiveRegistryDigest: evalHash(value.primitiveRegistryDigest),
            candidateInstruction: value.candidateInstruction as string,
            candidateInstructionDigest: evalHash(value.candidateInstructionDigest),
            baselineInstructionDigest: SKILL_SAMPLE_BASELINE_INSTRUCTION_DIGEST,
        };
        const budget = suiteBudget({
            suiteId: suite.suiteId, perPairBudgetDigest: suite.perPairBudgetDigest,
            perPairInputTokens: suite.perPairInputTokens, perPairOutputTokens: suite.perPairOutputTokens,
            perPairMaxCostMicrousd: suite.perPairMaxCostMicrousd,
        });
        if (suite.manifestDigest !== suiteManifestDigest(source, common, budget)) {
            throw new Error('suite-manifest-binding-invalid');
        }
        const core = {
            planVersion: SKILL_SAMPLE_SUITE_PLAN_VERSION, source, fixture,
            fixtureSetDigest: SKILL_SAMPLE_SUITE_FIXTURE_SET_DIGEST, ...common, suite,
        };
        if (evalHash(value.planDigest) !== evalDigest(core)) throw new Error('suite-plan-hash-invalid');
        return evalFreeze({ ...core, planDigest: value.planDigest as string });
    } catch { throw new Error('skill-sample-suite-plan-invalid'); }
}


export function assertCurrentSkillSampleSuitePlan(input: unknown): SkillSampleSuitePlan {
    const plan = normalizeSkillSampleSuitePlan(input);
    try { assertCurrentSkillEvaluatePlan(plan.source); }
    catch { throw new Error('skill-sample-suite-registry-stale'); }
    if (plan.compilerRevision !== AGENT_SKILL_COMPILER_REVISION
        || plan.primitiveRegistryDigest !== AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST) {
        throw new Error('skill-sample-suite-registry-stale');
    }
    const render = rendered(plan.source);
    if (plan.candidateInstruction !== render.instruction
        || plan.candidateInstructionDigest !== render.instructionDigest) {
        throw new Error('skill-sample-suite-registry-stale');
    }
    return plan;
}


/** A complete suite is exactly the canonical 8x3 matrix; caller reordering or partial matrices fail closed. */
export function normalizeSkillSampleSuitePlans(input: unknown): readonly SkillSampleSuitePlan[] {
    try {
        const values = evalDense(input, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_PAIR_COUNT);
        const plans = values.map(normalizeSkillSampleSuitePlan);
        const first = plans[0]!;
        for (const [index, plan] of plans.entries()) {
            const scenarioOrdinal = Math.floor(index / SKILL_SAMPLE_SUITE_REPEAT_COUNT);
            const repeatIndex = index % SKILL_SAMPLE_SUITE_REPEAT_COUNT;
            if (plan.suite.scenarioOrdinal !== scenarioOrdinal || plan.suite.repeatIndex !== repeatIndex
                || plan.suite.manifestDigest !== first.suite.manifestDigest
                || plan.source.planDigest !== first.source.planDigest
                || plan.candidateInstructionDigest !== first.candidateInstructionDigest
                || plan.suite.perPairBudgetDigest !== first.suite.perPairBudgetDigest) {
                throw new Error('suite-matrix-invalid');
            }
        }
        if (new Set(plans.map((plan) => plan.planDigest)).size !== SKILL_SAMPLE_SUITE_PAIR_COUNT) {
            throw new Error('suite-plan-duplicate');
        }
        return evalFreeze(plans);
    } catch { throw new Error('skill-sample-suite-plans-invalid'); }
}


export type SkillSampleExecutionPlan = SkillSamplePlan | SkillSampleSuitePlan;


/** Strict version dispatch; a malformed V1 cannot fall through into V2 normalization or vice versa. */
export function normalizeSkillSampleExecutionPlan(input: unknown): SkillSampleExecutionPlan {
    const snapshot = evalSnapshot(input);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('skill-sample-execution-plan-invalid');
    }
    const version = (snapshot as Record<string, unknown>).planVersion;
    if (version === SKILL_SAMPLE_PLAN_VERSION) return normalizeSkillSamplePlan(snapshot);
    if (version === SKILL_SAMPLE_SUITE_PLAN_VERSION) return normalizeSkillSampleSuitePlan(snapshot);
    throw new Error('skill-sample-execution-plan-version-invalid');
}


export function assertCurrentSkillSampleExecutionPlan(input: unknown): SkillSampleExecutionPlan {
    const plan = normalizeSkillSampleExecutionPlan(input);
    return plan.planVersion === SKILL_SAMPLE_PLAN_VERSION
        ? assertCurrentSkillSamplePlan(plan) : assertCurrentSkillSampleSuitePlan(plan);
}


export function skillSampleExecutionPlanDigest(input: unknown): string {
    return normalizeSkillSampleExecutionPlan(input).planDigest;
}
