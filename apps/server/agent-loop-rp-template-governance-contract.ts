/** @author Codex @date 2026-10-26 @version 1.0
 * RP-only passive candidate/fixture contracts and fixed-fact evaluation, never publication authority.
 */
import {
    normalizeRpChildAnalysisResult,
    type RpChildAnalysisResultV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import {
    normalizeRpScenarioTemplate,
    normalizeRpScenarioTemplateCandidate,
    type RpScenarioTemplateV1,
} from './agent-loop-rp-scenario-template.ts';
import {
    evalCanonical,
    evalDense,
    evalDigest,
    evalFreeze,
    evalRecord,
    evalSnapshot,
    evalToken,
} from './skill-evaluate-data.ts';

export const RP_TEMPLATE_GOVERNANCE_INPUT_CONTRACT = evalFreeze({
    version: 'rp-template-evaluation-input-v1',
    templateId: 'rp.character-consistency',
    source: 'synthetic-frozen-character-evidence',
    contentMode: 'nsf',
    sourceInstructions: 'untrusted-data',
    playerSovereignty: 'parent-only',
} as const);
export const RP_TEMPLATE_GOVERNANCE_OUTPUT_CONTRACT = evalFreeze({
    version: 'rp-template-evaluation-output-v1',
    resultVersion: 'rp-child-analysis-v1',
    validator: 'normalizeRpChildAnalysisResult',
    scope: 'schema-source-epistemic-player-and-fixed-expectations',
} as const);
export const RP_TEMPLATE_GOVERNANCE_EVALUATOR = evalFreeze({
    version: 'rp-template-evaluator-v1',
    checks: ['schema', 'source-binding', 'epistemic-boundary', 'player-sovereignty', 'fixed-expectations'],
    qualityClaim: 'fixed-fixture-contract-only',
    effect: 'unknown',
    promotionEligible: false,
} as const);

export interface RpTemplateGovernanceCandidateV1 {
    readonly version: 'rp-template-candidate-v1';
    readonly candidateId: string;
    readonly baseline: RpScenarioTemplateV1;
    readonly candidate: RpScenarioTemplateV1;
}

export interface RpTemplateGovernanceInputV1 {
    readonly version: 'rp-template-evaluation-input-v1';
    readonly templateId: 'rp.character-consistency';
    readonly scenarioKind: 'character-consistency';
    readonly contentMode: 'nsf';
    readonly sourceWatermarks: RpChildAnalysisResultV1['sourceWatermarks'];
    readonly evidence: readonly Readonly<{
        evidenceRef: string;
        claim: string;
        epistemicStatus: 'fact' | 'hypothesis' | 'disputed' | 'instruction';
        actor: 'npc' | 'player';
    }>[];
    readonly playerSovereignty: 'parent-only';
}

export interface RpTemplateGovernanceFixtureV1 {
    readonly version: 'rp-template-fixture-v1';
    readonly fixtureId: string;
    readonly input: RpTemplateGovernanceInputV1;
    readonly expectedOutput: RpChildAnalysisResultV1;
    readonly usageModel: Readonly<{ inputTokens: number; outputTokens: number; costMicros: number }>;
}

export interface RpTemplateGovernanceStaticReceiptV1 {
    readonly version: 'rp-template-static-receipt-v1';
    readonly status: 'passed';
    readonly candidateId: string;
    readonly candidateDigest: string;
    readonly baselineDigest: string;
    readonly templateDigest: string;
    readonly inputContractDigest: string;
    readonly outputContractDigest: string;
    readonly evaluatorDigest: string;
    readonly fixtureSetDigest: string;
    readonly fixtureCount: number;
    readonly authorityEffect: 'none';
    readonly promotionEligible: false;
    readonly effect: 'unknown';
    readonly receiptDigest: string;
}

export interface RpTemplateGovernanceEvaluationV1 {
    readonly version: 'rp-template-evaluation-v1';
    readonly status: 'passed' | 'failed' | 'invalid';
    readonly reasonCodes: readonly string[];
    readonly checks: Readonly<{
        schema: boolean;
        sourceBinding: boolean;
        epistemicBoundary: boolean;
        playerSovereignty: boolean;
        fixedExpectations: boolean;
    }>;
    readonly inputDigest: string;
    readonly outputDigest: string | null;
    readonly fixtureDigest: string;
    readonly evaluatorDigest: string;
    readonly effect: 'unknown';
    readonly promotionEligible: false;
}

function invalid(): never {
    throw new TypeError('rp-template-governance-input-invalid');
}

function text(input: unknown): string {
    if (typeof input !== 'string' || !input.trim() || input.length > 512 || input !== input.trim()) invalid();
    return input;
}

function same(left: unknown, right: unknown): boolean {
    return evalCanonical(left) === evalCanonical(right);
}

function versionParts(input: string): number[] {
    const parts = input.split('.').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 1_000_000)) {
        invalid();
    }
    return parts;
}

function newerVersion(baseline: string, candidate: string): boolean {
    const left = versionParts(baseline),
        right = versionParts(candidate);
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return right[index]! > left[index]!;
    }
    return false;
}

function comparableTemplate(template: RpScenarioTemplateV1): unknown {
    const { version: _version, analysisSpec, ...rest } = template;
    const { analysisQuestions: _questions, validationRequirements: _validation, ...analysis } = analysisSpec;
    return { ...rest, analysisSpec: analysis };
}

/** The first candidate may refine review text, not capability, source, schema or runtime policy. */
export function normalizeRpTemplateGovernanceCandidate(input: unknown): RpTemplateGovernanceCandidateV1 {
    const value = evalRecord(evalSnapshot(input), ['version', 'candidateId', 'baseline', 'candidate']);
    if (value.version !== 'rp-template-candidate-v1') invalid();
    const baseline = normalizeRpScenarioTemplate(value.baseline);
    const candidate = normalizeRpScenarioTemplateCandidate(value.candidate);
    if (
        baseline.templateId !== 'rp.character-consistency' ||
        candidate.templateId !== baseline.templateId ||
        !newerVersion(baseline.version, candidate.version) ||
        !same(comparableTemplate(baseline), comparableTemplate(candidate)) ||
        same(baseline.analysisSpec, candidate.analysisSpec)
    )
        invalid();
    return evalFreeze({
        version: 'rp-template-candidate-v1',
        candidateId: evalToken(value.candidateId),
        baseline,
        candidate,
    });
}

function normalizeInput(input: unknown): RpTemplateGovernanceInputV1 {
    const value = evalRecord(input, [
        'version',
        'templateId',
        'scenarioKind',
        'contentMode',
        'sourceWatermarks',
        'evidence',
        'playerSovereignty',
    ]);
    if (
        value.version !== 'rp-template-evaluation-input-v1' ||
        value.templateId !== 'rp.character-consistency' ||
        value.scenarioKind !== 'character-consistency' ||
        value.contentMode !== 'nsf' ||
        value.playerSovereignty !== 'parent-only'
    )
        invalid();
    const sourceWatermarks = normalizeRpChildAnalysisResult({
        version: 'rp-child-analysis-v1',
        templateId: value.templateId,
        completeness: 'unknown',
        conclusions: [],
        sourceWatermarks: value.sourceWatermarks,
        truncated: false,
    }).sourceWatermarks;
    const refs = sourceWatermarks.map((item) => item.sourceRef);
    if (new Set(refs).size !== refs.length) invalid();
    const evidence = evalDense(value.evidence, 0, 32).map((item) => {
        const entry = evalRecord(item, ['evidenceRef', 'claim', 'epistemicStatus', 'actor']);
        const evidenceRef = evalToken(entry.evidenceRef);
        if (
            !refs.some((ref) => evidenceRef === ref || evidenceRef.startsWith(`${ref}:`)) ||
            !['fact', 'hypothesis', 'disputed', 'instruction'].includes(String(entry.epistemicStatus)) ||
            !['npc', 'player'].includes(String(entry.actor))
        )
            invalid();
        return {
            evidenceRef,
            claim: text(entry.claim),
            epistemicStatus: entry.epistemicStatus,
            actor: entry.actor,
        } as RpTemplateGovernanceInputV1['evidence'][number];
    });
    return evalFreeze({
        version: 'rp-template-evaluation-input-v1',
        templateId: 'rp.character-consistency',
        scenarioKind: 'character-consistency',
        contentMode: 'nsf',
        sourceWatermarks,
        evidence,
        playerSovereignty: 'parent-only',
    });
}

function evaluateChecks(
    input: RpTemplateGovernanceInputV1,
    expected: RpChildAnalysisResultV1,
    output: RpChildAnalysisResultV1,
): RpTemplateGovernanceEvaluationV1['checks'] {
    const cited = output.conclusions.map((conclusion) => ({
        conclusion,
        entries: conclusion.evidenceRefs.map((ref) => input.evidence.filter((entry) => entry.evidenceRef === ref)),
    }));
    const sourceBinding =
        output.templateId === input.templateId &&
        same(output.sourceWatermarks, input.sourceWatermarks) &&
        cited.every(({ entries }) => entries.every((group) => group.length > 0));
    const epistemicBoundary = cited.every(({ conclusion, entries }) =>
        entries.every(
            (group) =>
                group.length > 0 &&
                group.every(
                    (entry) =>
                        entry.epistemicStatus !== 'instruction' &&
                        (conclusion.epistemicStatus !== 'fact' || entry.epistemicStatus === 'fact'),
                ),
        ),
    );
    const playerSovereignty = cited.every(({ entries }) =>
        entries.every(
            (group) =>
                group.length > 0 &&
                group.every((entry) => entry.actor === 'npc' && entry.epistemicStatus !== 'instruction'),
        ),
    );
    return {
        schema: true,
        sourceBinding,
        epistemicBoundary,
        playerSovereignty,
        fixedExpectations: same(output, expected),
    };
}

export function normalizeRpTemplateGovernanceFixture(input: unknown): RpTemplateGovernanceFixtureV1 {
    const value = evalRecord(evalSnapshot(input), ['version', 'fixtureId', 'input', 'expectedOutput', 'usageModel']);
    if (value.version !== 'rp-template-fixture-v1') invalid();
    const normalizedInput = normalizeInput(value.input);
    const expectedOutput = normalizeRpChildAnalysisResult(value.expectedOutput);
    const usage = evalRecord(value.usageModel, ['inputTokens', 'outputTokens', 'costMicros']);
    for (const amount of Object.values(usage)) {
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000) invalid();
    }
    if (!Object.values(evaluateChecks(normalizedInput, expectedOutput, expectedOutput)).every(Boolean)) invalid();
    return evalFreeze({
        version: 'rp-template-fixture-v1',
        fixtureId: evalToken(value.fixtureId),
        input: normalizedInput,
        expectedOutput,
        usageModel: usage as unknown as RpTemplateGovernanceFixtureV1['usageModel'],
    });
}

export function validateRpTemplateGovernanceCandidate(
    input: unknown,
    fixtureInputs: unknown,
): RpTemplateGovernanceStaticReceiptV1 {
    const candidate = normalizeRpTemplateGovernanceCandidate(input);
    const fixtures = evalDense(fixtureInputs, 1, 32)
        .map(normalizeRpTemplateGovernanceFixture)
        .sort((left, right) => (left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0));
    if (new Set(fixtures.map((fixture) => fixture.fixtureId)).size !== fixtures.length) invalid();
    const receipt = {
        version: 'rp-template-static-receipt-v1' as const,
        status: 'passed' as const,
        candidateId: candidate.candidateId,
        candidateDigest: evalDigest(candidate),
        baselineDigest: evalDigest(candidate.baseline),
        templateDigest: evalDigest(candidate.candidate),
        inputContractDigest: evalDigest(RP_TEMPLATE_GOVERNANCE_INPUT_CONTRACT),
        outputContractDigest: evalDigest(RP_TEMPLATE_GOVERNANCE_OUTPUT_CONTRACT),
        evaluatorDigest: evalDigest(RP_TEMPLATE_GOVERNANCE_EVALUATOR),
        fixtureSetDigest: evalDigest(fixtures),
        fixtureCount: fixtures.length,
        authorityEffect: 'none' as const,
        promotionEligible: false as const,
        effect: 'unknown' as const,
    };
    return evalFreeze({ ...receipt, receiptDigest: evalDigest(receipt) });
}

/** This is a fixed-fact contract score, not literary quality, truth promotion or domain generalisation. */
export function evaluateRpTemplateGovernanceOutput(
    fixtureInput: unknown,
    outputInput: unknown,
): RpTemplateGovernanceEvaluationV1 {
    const fixture = normalizeRpTemplateGovernanceFixture(fixtureInput);
    const metadata = {
        version: 'rp-template-evaluation-v1' as const,
        inputDigest: evalDigest(fixture.input),
        fixtureDigest: evalDigest(fixture),
        evaluatorDigest: evalDigest(RP_TEMPLATE_GOVERNANCE_EVALUATOR),
        effect: 'unknown' as const,
        promotionEligible: false as const,
    };
    let output: RpChildAnalysisResultV1;
    try {
        output = normalizeRpChildAnalysisResult(outputInput);
    } catch {
        return evalFreeze({
            ...metadata,
            status: 'invalid',
            reasonCodes: ['rp-template-output-schema-invalid'],
            outputDigest: null,
            checks: {
                schema: false,
                sourceBinding: false,
                epistemicBoundary: false,
                playerSovereignty: false,
                fixedExpectations: false,
            },
        });
    }
    const checks = evaluateChecks(fixture.input, fixture.expectedOutput, output);
    const reasonCodes = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => `rp-template-${name}-failed`);
    return evalFreeze({
        ...metadata,
        status: reasonCodes.length ? 'failed' : 'passed',
        reasonCodes,
        checks,
        outputDigest: evalDigest(output),
    });
}
