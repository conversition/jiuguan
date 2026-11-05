/** @author Codex @date 2026-10-26 @version 1.0
 * Fixture-only RP template replay and independently re-executed offline Shadow evidence.
 * Injected functions are trusted offline test ports, not a sandbox or publication authority.
 */
import {
    agentSkillReplayEvidenceDigest,
    runAgentSkillReplayComparison,
    type AgentSkillReplayComparisonResult,
    type AgentSkillReplayThresholds,
} from '../../packages/harness/public/agent-skill-replay.ts';
import {
    evaluateRpTemplateGovernanceOutput,
    normalizeRpTemplateGovernanceCandidate,
    normalizeRpTemplateGovernanceFixture,
    validateRpTemplateGovernanceCandidate,
    type RpTemplateGovernanceCandidateV1,
    type RpTemplateGovernanceFixtureV1,
} from './agent-loop-rp-template-governance-contract.ts';
import { types as nodeTypes } from 'node:util';
import type { RpScenarioTemplateV1 } from './agent-loop-rp-scenario-template.ts';
import { evalDense, evalDigest, evalFreeze, evalHash, evalRecord, evalSnapshot } from './skill-evaluate-data.ts';

export const RP_TEMPLATE_GOVERNANCE_VERSION = 'rp-template-governance-report-v1' as const;
export const RP_TEMPLATE_GOVERNANCE_RUN_CONFIG_VERSION = 'rp-template-run-config-v1' as const;
export const RP_TEMPLATE_GOVERNANCE_DEFAULT_RUN_CONFIG = Object.freeze({
    version: RP_TEMPLATE_GOVERNANCE_RUN_CONFIG_VERSION,
    seed: 17_032,
});

export interface RpTemplateGovernanceRunConfig {
    readonly version: typeof RP_TEMPLATE_GOVERNANCE_RUN_CONFIG_VERSION;
    readonly seed: number;
}

export interface RpTemplateGovernanceExecutionRequest {
    readonly phase: 'replay' | 'shadow';
    readonly arm: 'baseline' | 'candidate';
    readonly requestDigest: string;
    readonly template: RpScenarioTemplateV1;
    readonly fixture: RpTemplateGovernanceFixtureV1;
    readonly runConfig: RpTemplateGovernanceRunConfig;
}

export interface RpTemplateGovernanceExecutionResult {
    readonly requestDigest: string;
    readonly output: unknown;
}

export interface RpTemplateGovernanceExecutor {
    execute(request: RpTemplateGovernanceExecutionRequest): Promise<RpTemplateGovernanceExecutionResult>;
}

export interface RpTemplateGovernanceInput {
    readonly candidate: RpTemplateGovernanceCandidateV1;
    readonly fixtures: readonly RpTemplateGovernanceFixtureV1[];
    readonly runConfig: RpTemplateGovernanceRunConfig;
    readonly executor: RpTemplateGovernanceExecutor;
}

type Evaluation = ReturnType<typeof evaluateRpTemplateGovernanceOutput>;
type StaticReceipt = ReturnType<typeof validateRpTemplateGovernanceCandidate>;

export interface RpTemplateGovernanceArmEvidence {
    readonly arm: 'baseline' | 'candidate';
    readonly templateDigest: string;
    readonly requestDigest: string;
    readonly status: Evaluation['status'];
    readonly reasonCodes: readonly string[];
    readonly checks: Evaluation['checks'];
    readonly sourceDigest: string;
    readonly inputDigest: string;
    readonly outputDigest: string | null;
    readonly syntheticUsage: RpTemplateGovernanceFixtureV1['usageModel'];
}

export interface RpTemplateGovernancePairEvidence {
    readonly fixtureDigest: string;
    readonly scenarioDigest: string;
    readonly sourceDigest: string;
    readonly inputDigest: string;
    readonly baseline: RpTemplateGovernanceArmEvidence;
    readonly candidate: RpTemplateGovernanceArmEvidence;
    /** This is bounded contract conformance, never semantic equivalence or a quality winner. */
    readonly comparison: 'both-conformant' | 'failed' | 'inconclusive';
}

export interface RpTemplateGovernanceStageEvidence {
    readonly phase: 'replay' | 'shadow';
    readonly evidenceClass: 'fixture';
    readonly comparison: AgentSkillReplayComparisonResult;
    readonly pairs: readonly RpTemplateGovernancePairEvidence[];
    readonly stageDigest: string;
}

export interface RpTemplateGovernanceReport {
    readonly version: typeof RP_TEMPLATE_GOVERNANCE_VERSION;
    readonly evidenceClass: 'fixture';
    readonly executionClass: 'synthetic-fixture';
    readonly costClass: 'synthetic-estimate';
    readonly effect: 'unknown';
    readonly promotionEligible: false;
    readonly authorityEffect: 'none';
    readonly businessWrites: 0;
    readonly actualModelCalls: 0;
    readonly runConfigDigest: string;
    readonly fixtureSetDigest: string;
    readonly static: StaticReceipt;
    readonly replay: RpTemplateGovernanceStageEvidence;
    readonly shadow: RpTemplateGovernanceStageEvidence;
    readonly syntheticUsage: RpTemplateGovernanceFixtureV1['usageModel'];
    readonly status: 'passed' | 'failed' | 'inconclusive';
    readonly reportDigest: string;
}

function runConfig(input: unknown): RpTemplateGovernanceRunConfig {
    const value = evalRecord(evalSnapshot(input), ['version', 'seed']);
    if (
        value.version !== RP_TEMPLATE_GOVERNANCE_RUN_CONFIG_VERSION ||
        !Number.isSafeInteger(value.seed) ||
        (value.seed as number) < 0 ||
        (value.seed as number) > 2_147_483_647
    ) {
        throw new Error('rp-template-run-config-invalid');
    }
    return evalFreeze(value) as unknown as RpTemplateGovernanceRunConfig;
}

function addUsage(fixtures: readonly RpTemplateGovernanceFixtureV1[], multiplier: number) {
    return evalFreeze(
        fixtures.reduce(
            (sum, fixture) => ({
                inputTokens: sum.inputTokens + fixture.usageModel.inputTokens * multiplier,
                outputTokens: sum.outputTokens + fixture.usageModel.outputTokens * multiplier,
                costMicros: sum.costMicros + fixture.usageModel.costMicros * multiplier,
            }),
            { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        ),
    );
}

function thresholds(fixtures: readonly RpTemplateGovernanceFixtureV1[]): AgentSkillReplayThresholds {
    return Object.freeze({
        scenarioCountMin: fixtures.length,
        contractSuccessRateMinBps: 10_000,
        contractSuccessRegressionMaxBps: 0,
        invalidCallRateMaxBps: 0,
        invalidCallRateRegressionMaxBps: 0,
        costMicrousdMax: addUsage(fixtures, 1).costMicros,
        costIncreaseMicrousdMax: 0,
        domainScoreMinBps: 10_000,
        domainScoreDeltaMinBps: 0,
    });
}

async function executeArm(
    execute: RpTemplateGovernanceExecutor['execute'],
    phase: 'replay' | 'shadow',
    arm: 'baseline' | 'candidate',
    template: RpScenarioTemplateV1,
    fixture: RpTemplateGovernanceFixtureV1,
    config: RpTemplateGovernanceRunConfig,
): Promise<RpTemplateGovernanceArmEvidence> {
    const templateDigest = evalDigest(template);
    const sourceDigest = evalDigest(fixture.input.sourceWatermarks);
    const inputDigest = evalDigest(fixture.input);
    const requestDigest = evalDigest({
        phase,
        arm,
        templateDigest,
        fixtureDigest: evalDigest(fixture),
        sourceDigest,
        inputDigest,
        runConfigDigest: evalDigest(config),
    });
    let output: unknown = null;
    let executionReason: string | null = null;
    try {
        const response = evalRecord(
            evalSnapshot(
                await execute(
                    evalFreeze({
                        phase,
                        arm,
                        requestDigest,
                        template,
                        fixture,
                        runConfig: config,
                    }),
                ),
            ),
            ['requestDigest', 'output'],
        );
        if (evalHash(response.requestDigest) !== requestDigest)
            executionReason = 'rp-template-execution-binding-invalid';
        else output = response.output;
    } catch {
        executionReason = 'rp-template-execution-incomplete';
    }
    const evaluation = evaluateRpTemplateGovernanceOutput(fixture, output);
    return evalFreeze({
        arm,
        templateDigest,
        requestDigest,
        status: executionReason ? 'invalid' : evaluation.status,
        reasonCodes: executionReason ? [executionReason, ...evaluation.reasonCodes] : evaluation.reasonCodes,
        checks: evaluation.checks,
        sourceDigest,
        inputDigest,
        outputDigest: evaluation.outputDigest,
        syntheticUsage: fixture.usageModel,
    });
}

async function runStage(
    phase: 'replay' | 'shadow',
    candidate: RpTemplateGovernanceCandidateV1,
    fixtures: readonly RpTemplateGovernanceFixtureV1[],
    config: RpTemplateGovernanceRunConfig,
    execute: RpTemplateGovernanceExecutor['execute'],
): Promise<RpTemplateGovernanceStageEvidence> {
    const pairRows = new Map<string, Partial<Record<'baseline' | 'candidate', RpTemplateGovernanceArmEvidence>>>();
    const comparison = await runAgentSkillReplayComparison({
        evidenceClass: 'fixture',
        incumbentDigest: evalDigest(candidate.baseline),
        candidateDigest: evalDigest(candidate.candidate),
        runConfig: { digest: evalDigest(config), value: config },
        scenarios: fixtures.map((fixture) => ({
            scenarioId: fixture.fixtureId,
            scenarioDigest: evalDigest(fixture),
            input: fixture,
        })),
        thresholds: thresholds(fixtures),
        executor: {
            async execute(request) {
                const arm = request.variant === 'incumbent' ? 'baseline' : 'candidate';
                const fixture = request.scenario.input;
                const result = await executeArm(execute, phase, arm, candidate[arm], fixture, config);
                const pair = pairRows.get(request.scenario.scenarioDigest) ?? {};
                pair[arm] = result;
                pairRows.set(request.scenario.scenarioDigest, pair);
                return {
                    scenarioId: request.scenario.scenarioId,
                    scenarioDigest: request.scenario.scenarioDigest,
                    runConfigDigest: request.runConfigDigest,
                    output: result,
                    reasonCodes: result.reasonCodes,
                    metrics: {
                        contractSucceeded: result.status === 'passed',
                        modelCalls: 0,
                        toolCalls: 0,
                        invalidCalls: 0,
                        inputTokens: fixture.usageModel.inputTokens,
                        outputTokens: fixture.usageModel.outputTokens,
                        costMicrousd: fixture.usageModel.costMicros,
                        latencyMs: 0,
                        safetyFallbacks: 0,
                    },
                };
            },
        },
        evaluator: {
            evaluatorDigest: evaluateRpTemplateGovernanceOutput(fixtures[0]!, fixtures[0]!.expectedOutput)
                .evaluatorDigest,
            async evaluate(request) {
                return {
                    scenarioId: request.scenario.scenarioId,
                    scenarioDigest: request.scenario.scenarioDigest,
                    runConfigDigest: request.runConfigDigest,
                    incumbentScoreBps: request.incumbent.output.status === 'passed' ? 10_000 : 0,
                    candidateScoreBps: request.candidate.output.status === 'passed' ? 10_000 : 0,
                    reasonCodes: ['rp-template-fixed-contract-conformance-only'],
                };
            },
        },
    });
    const pairs = fixtures.map((fixture): RpTemplateGovernancePairEvidence => {
        const fixtureDigest = evalDigest(fixture);
        const row = pairRows.get(fixtureDigest);
        if (!row?.baseline || !row.candidate) throw new Error('rp-template-comparison-incomplete');
        return evalFreeze({
            fixtureDigest,
            scenarioDigest: evalDigest(fixture.input),
            sourceDigest: row.baseline.sourceDigest,
            inputDigest: row.baseline.inputDigest,
            baseline: row.baseline,
            candidate: row.candidate,
            comparison:
                row.baseline.status === 'passed' && row.candidate.status === 'passed'
                    ? 'both-conformant'
                    : row.baseline.status === 'invalid' || row.candidate.status === 'invalid'
                      ? 'inconclusive'
                      : 'failed',
        });
    });
    if (
        comparison.evidenceDigest !== agentSkillReplayEvidenceDigest(comparison.evidence) ||
        comparison.evidence.summary.lifecyclePromotionEligible
    )
        throw new Error('rp-template-fixture-gate-invalid');
    const stage = { phase, evidenceClass: 'fixture' as const, comparison, pairs };
    return evalFreeze({ ...stage, stageDigest: evalDigest(stage) });
}

/** No Provider, runtime, Store, publication callback or evaluation override is accepted by this port. */
export async function runRpTemplateGovernance(input: RpTemplateGovernanceInput): Promise<RpTemplateGovernanceReport> {
    const value = evalRecord(input, ['candidate', 'fixtures', 'runConfig', 'executor']);
    const port = evalRecord(value.executor, ['execute']);
    if (typeof port.execute !== 'function' || nodeTypes.isProxy(port.execute)) {
        throw new Error('rp-template-executor-invalid');
    }
    const execute = port.execute.bind(undefined) as RpTemplateGovernanceExecutor['execute'];
    const candidate = normalizeRpTemplateGovernanceCandidate(value.candidate);
    const fixtures = evalDense(value.fixtures, 1, 6)
        .map(normalizeRpTemplateGovernanceFixture)
        .sort((left, right) => (left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0));
    if (
        new Set(fixtures.map((fixture) => fixture.fixtureId)).size !== fixtures.length ||
        new Set(fixtures.map(evalDigest)).size !== fixtures.length
    )
        throw new Error('rp-template-fixture-duplicate');
    const config = runConfig(value.runConfig);
    const receipt = validateRpTemplateGovernanceCandidate(candidate, fixtures);
    const replay = await runStage('replay', candidate, fixtures, config, execute);
    const shadow = await runStage('shadow', candidate, fixtures, config, execute);
    const pairs = [...replay.pairs, ...shadow.pairs];
    const report = {
        version: RP_TEMPLATE_GOVERNANCE_VERSION,
        evidenceClass: 'fixture' as const,
        executionClass: 'synthetic-fixture' as const,
        costClass: 'synthetic-estimate' as const,
        effect: 'unknown' as const,
        promotionEligible: false as const,
        authorityEffect: 'none' as const,
        businessWrites: 0 as const,
        actualModelCalls: 0 as const,
        runConfigDigest: evalDigest(config),
        fixtureSetDigest: receipt.fixtureSetDigest,
        static: receipt,
        replay,
        shadow,
        syntheticUsage: addUsage(fixtures, 4),
        status: pairs.some((pair) => pair.comparison === 'failed')
            ? ('failed' as const)
            : pairs.some((pair) => pair.comparison === 'inconclusive')
              ? ('inconclusive' as const)
              : ('passed' as const),
    };
    return evalFreeze({ ...report, reportDigest: evalDigest(report) });
}
