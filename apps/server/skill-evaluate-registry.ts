/** @author Codex @date 2026-10-16 @version 1.0
 * Fixed host Style SafeProgram conformance registry; never literary quality or promotion authority.
 */
import { normalizeAgentSkillCandidate, parseAgentSkillProgramBody,
    type AgentSkillCandidateRecordV1 } from '@jiuguan/skill-hub';
import { AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST, validateAgentSkillProgramPrimitives }
    from '@jiuguan/prompt/agent-skill-compiler';
import { normalizeSkillCompilePacket, SKILL_COMPILE_GOALS, type SkillCompilePacket }
    from './skill-compile-model.ts';
import { normalizeCandidateStaticValidationReceipt, type CandidateStaticValidationReceipt }
    from './agent-skill-candidate-static-validator.ts';
import { evalCanonical, evalDense, evalDigest, evalFreeze, evalHash, evalRecord, evalSnapshot }
    from './skill-evaluate-data.ts';

export const SKILL_EVALUATE_PLAN_VERSION = 'skill-evaluate-plan-v1' as const;
export const SKILL_EVALUATE_EVALUATOR_ID = 'style-safeprogram-conformance-v1' as const;
export const SKILL_EVALUATE_EVALUATOR_VERSION = '1.0.0' as const;
type Goal = typeof SKILL_COMPILE_GOALS[number];

export const SKILL_EVALUATE_RUBRIC = evalFreeze([
    { goal: 'dialogue-focused', primitiveId: 'style.apply-axis', selector: 'dialogue.density', predicate: 'positive' },
    { goal: 'sensory-rich', primitiveId: 'style.apply-axis', selector: 'sensory.detail', predicate: 'positive' },
    { goal: 'brisk-pace', primitiveId: 'style.apply-axis', selector: 'sentence.tempo', predicate: 'positive' },
    { goal: 'restrained-pace', primitiveId: 'style.apply-axis', selector: 'sentence.tempo', predicate: 'negative' },
    { goal: 'avoid-cliche', primitiveId: 'style.toggle-constraint', selector: 'avoid.cliche', predicate: 'true' },
    { goal: 'preserve-voice', primitiveId: 'style.toggle-constraint', selector: 'preserve.voice', predicate: 'true' },
] as const);
export const SKILL_EVALUATE_RUBRIC_DIGEST = evalDigest({
    rubricVersion: 'style-safeprogram-goal-rubric-v1', rules: SKILL_EVALUATE_RUBRIC,
    missingPrimitive: false, axisZero: false, overall: 'all-host-pass-and-model-agreement',
});
export const SKILL_EVALUATE_FIXTURE_SET_DIGEST = evalDigest({
    fixtureSetVersion: 'style-safeprogram-goal-fixtures-v1',
    cases: [...SKILL_COMPILE_GOALS].sort().map((goal) => ({ caseId: `goal.${goal}`, goal })),
});


function registryDigest(primitiveRegistryDigest: string): string {
    return evalDigest({
        registryVersion: 'skill-evaluate-registry-v1', evaluatorId: SKILL_EVALUATE_EVALUATOR_ID,
        evaluatorVersion: SKILL_EVALUATE_EVALUATOR_VERSION, primitiveRegistryDigest,
        rubricDigest: SKILL_EVALUATE_RUBRIC_DIGEST, fixtureSetDigest: SKILL_EVALUATE_FIXTURE_SET_DIGEST,
        kind: 'style', programVersion: 'agent-skill-program-v1', executionClass: 'fixture',
        evaluationScope: 'style-safeprogram-goal-conformance', promotionEligible: false,
    });
}

export const SKILL_EVALUATE_REGISTRY = evalFreeze({
    evaluatorId: SKILL_EVALUATE_EVALUATOR_ID, evaluatorVersion: SKILL_EVALUATE_EVALUATOR_VERSION,
    registryDigest: registryDigest(AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST),
    rubricDigest: SKILL_EVALUATE_RUBRIC_DIGEST, fixtureSetDigest: SKILL_EVALUATE_FIXTURE_SET_DIGEST,
    primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
});

export interface SkillEvaluateCase { readonly caseId: string; readonly goal: Goal; }
export interface SkillEvaluatePlan {
    readonly planVersion: typeof SKILL_EVALUATE_PLAN_VERSION;
    readonly evaluatorId: typeof SKILL_EVALUATE_EVALUATOR_ID;
    readonly evaluatorVersion: typeof SKILL_EVALUATE_EVALUATOR_VERSION;
    readonly registryDigest: string;
    readonly rubricDigest: string;
    readonly fixtureSetDigest: string;
    readonly primitiveRegistryDigest: string;
    readonly compilePacket: SkillCompilePacket;
    readonly candidate: AgentSkillCandidateRecordV1;
    readonly validation: CandidateStaticValidationReceipt;
    readonly cases: readonly SkillEvaluateCase[];
    readonly planDigest: string;
}


function sources(input: Record<string, unknown>) {
    const compilePacket = normalizeSkillCompilePacket(input.compilePacket);
    const candidate = normalizeAgentSkillCandidate(input.candidate);
    const validation = normalizeCandidateStaticValidationReceipt(input.validation);
    const bundle = compilePacket.submission.bundle;
    if (candidate.state !== 'validated' || candidate.revision !== 1 || !validation.passed
        || candidate.candidateId !== validation.candidateId || candidate.bundleDigest !== bundle.bundleDigest
        || validation.bundleDigest !== bundle.bundleDigest || candidate.parentBundleDigest !== null
        || candidate.createdAt !== compilePacket.completedAt || candidate.updatedAt !== validation.validatedAt
        || validation.expectedCandidateRevision !== 0
        || candidate.validationEvidenceDigest !== validation.evidenceDigest
        || evalCanonical(candidate.header) !== evalCanonical(bundle.header)) throw new Error('source-binding-invalid');
    const program = parseAgentSkillProgramBody(bundle.body);
    if (program.kind !== 'style') throw new Error('source-program-invalid');
    validateAgentSkillProgramPrimitives(program);
    return { compilePacket, candidate, validation };
}


/** Physical retained-source authority is supplied by the caller; this only binds exact immutable input data. */
export function createSkillEvaluatePlan(input: unknown): SkillEvaluatePlan {
    try {
        const value = evalRecord(evalSnapshot(input), ['compilePacket', 'candidate', 'validation']);
        const source = sources(value);
        if (source.validation.primitiveRegistryDigest !== SKILL_EVALUATE_REGISTRY.primitiveRegistryDigest) {
            throw new Error('source-validator-stale');
        }
        const core = {
            planVersion: SKILL_EVALUATE_PLAN_VERSION, ...SKILL_EVALUATE_REGISTRY, ...source,
            cases: source.compilePacket.spec.goals.map((goal) => ({ caseId: `goal.${goal}`, goal })),
        };
        return evalFreeze({ ...core, planDigest: evalDigest(core) });
    } catch { throw new Error('skill-evaluate-plan-invalid'); }
}


/** Historical v1 contracts retain their original registry digest; data never becomes a live execution proof. */
export function normalizeSkillEvaluatePlan(input: unknown): SkillEvaluatePlan {
    try {
        const value = evalRecord(evalSnapshot(input), ['planVersion', 'evaluatorId', 'evaluatorVersion',
            'registryDigest', 'rubricDigest', 'fixtureSetDigest', 'primitiveRegistryDigest',
            'compilePacket', 'candidate', 'validation', 'cases', 'planDigest']);
        if (value.planVersion !== SKILL_EVALUATE_PLAN_VERSION || value.evaluatorId !== SKILL_EVALUATE_EVALUATOR_ID
            || value.evaluatorVersion !== SKILL_EVALUATE_EVALUATOR_VERSION
            || value.rubricDigest !== SKILL_EVALUATE_RUBRIC_DIGEST
            || value.fixtureSetDigest !== SKILL_EVALUATE_FIXTURE_SET_DIGEST) throw new Error('plan-contract-invalid');
        const source = sources(value);
        const primitiveRegistryDigest = evalHash(value.primitiveRegistryDigest);
        if (source.validation.primitiveRegistryDigest !== primitiveRegistryDigest
            || value.registryDigest !== registryDigest(primitiveRegistryDigest)) throw new Error('registry-invalid');
        const cases = evalDense(value.cases, 1, 4).map((item) => {
            const entry = evalRecord(item, ['caseId', 'goal']);
            if (!(SKILL_COMPILE_GOALS as readonly unknown[]).includes(entry.goal)
                || entry.caseId !== `goal.${entry.goal}`) throw new Error('case-invalid');
            return { caseId: entry.caseId as string, goal: entry.goal as Goal };
        });
        const expected = source.compilePacket.spec.goals.map((goal) => ({ caseId: `goal.${goal}`, goal }));
        if (evalCanonical(cases) !== evalCanonical(expected)) throw new Error('cases-binding-invalid');
        const core = {
            planVersion: SKILL_EVALUATE_PLAN_VERSION, evaluatorId: SKILL_EVALUATE_EVALUATOR_ID,
            evaluatorVersion: SKILL_EVALUATE_EVALUATOR_VERSION, registryDigest: evalHash(value.registryDigest),
            rubricDigest: SKILL_EVALUATE_RUBRIC_DIGEST, fixtureSetDigest: SKILL_EVALUATE_FIXTURE_SET_DIGEST,
            primitiveRegistryDigest, ...source, cases,
        };
        if (evalHash(value.planDigest) !== evalDigest(core)) throw new Error('plan-hash-invalid');
        return evalFreeze({ ...core, planDigest: value.planDigest as string });
    } catch { throw new Error('skill-evaluate-plan-invalid'); }
}


export function skillEvaluatePlanDigest(input: unknown): string {
    return normalizeSkillEvaluatePlan(input).planDigest;
}


export function assertCurrentSkillEvaluatePlan(input: unknown): SkillEvaluatePlan {
    const plan = normalizeSkillEvaluatePlan(input);
    if (plan.registryDigest !== SKILL_EVALUATE_REGISTRY.registryDigest
        || plan.primitiveRegistryDigest !== SKILL_EVALUATE_REGISTRY.primitiveRegistryDigest) {
        throw new Error('skill-evaluate-registry-stale');
    }
    return plan;
}


/** Independent deterministic verdict on actual program arguments, never the model's declared pass/score. */
export function skillEvaluateHostFindings(input: unknown): readonly Readonly<{ caseId: string; passed: boolean }>[] {
    const plan = normalizeSkillEvaluatePlan(input);
    const program = parseAgentSkillProgramBody(plan.compilePacket.submission.bundle.body);
    return evalFreeze(plan.cases.map((entry) => {
        const rule = SKILL_EVALUATE_RUBRIC.find((item) => item.goal === entry.goal)!;
        const operation = program.operations.find((item) => item.primitiveId === rule.primitiveId
            && (rule.primitiveId === 'style.apply-axis' ? item.args.axisId : item.args.constraintId) === rule.selector);
        const actual = rule.primitiveId === 'style.apply-axis' ? operation?.args.level : operation?.args.enabled;
        const passed = rule.predicate === 'true' ? actual === true
            : typeof actual === 'number' && (rule.predicate === 'positive' ? actual > 0 : actual < 0);
        return { caseId: entry.caseId, passed };
    }));
}
