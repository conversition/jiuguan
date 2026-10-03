import { createHash } from 'node:crypto';
import { evaluateDirectorPrelude, type DirectorPreludeDecision } from '../../packages/agent-policy/src/director-prelude.ts';
import { evaluatePolicyRouter, type AdmissionFacts } from '../../packages/agent-policy/src/policy-router.ts';
import { evaluatePrecommitCritic } from '../../packages/agent-policy/src/precommit-critic.ts';
import { agentBudgetProfileDigest, normalizeAgentBudgetProfile } from '../../packages/agent-policy/src/budget-profile.ts';
import { interactiveBudgetSnapshot, runInteractivePrelude } from '../../packages/harness/src/interactive-turn-runner.ts';
import { INTERACTIVE_NATIVE_TOOLS } from '../../packages/harness/src/interactive-tools.ts';
import {
  buildPrecommitCriticModelRequest,
  PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
} from '../../packages/harness/src/precommit-critic-model.ts';
import {
  parseP14ReplayEvidence,
  p14ReplaySuiteDigest,
  type P14ReplayEvidence,
  type P14ReplayScenario,
} from '../../packages/harness/src/replay-evidence.ts';
import {
  P14_REPLAY_RUN_VERSION,
  type P14ReplayResult,
  type P14ReplayRun,
} from '../../packages/harness/src/lane-evaluation.ts';
import { normalizeTurn, safeParseTurn, validateGameTurn, type GameTurn } from '../../packages/prompt/src/turn.ts';
import {
  AbortTurnError,
  OpenAICompatibleError,
  type ChatCompletionClient,
  type ChatProviderCall,
  type ChatRequest,
  type ChatResponse,
} from '../../packages/proxy/src/client.ts';
/*
 * Keep operational diagnostics prose-incapable. These buckets deliberately omit
 * error messages, response bodies, URLs and credentials.
 */
export const OPERATIONAL_PROVIDER_FAILURE_CLASSES = Object.freeze([
  'deadline',
  'rate-limit',
  'upstream-timeout',
  'upstream-5xx',
  'upstream-4xx',
  'transport',
  'protocol',
  'unknown',
] as const);
export type OperationalProviderFailureClass =
  (typeof OPERATIONAL_PROVIDER_FAILURE_CLASSES)[number];

export function classifyOperationalProviderFailure(
  error: unknown,
  signal?: AbortSignal,
): OperationalProviderFailureClass {
  if (signal?.aborted || error instanceof AbortTurnError
    || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
    return 'deadline';
  }
  if (error instanceof OpenAICompatibleError) {
    if (error.status === 429) return 'rate-limit';
    if (error.status === 408 || error.status === 504) return 'upstream-timeout';
    if (error.status !== undefined && error.status >= 500) return 'upstream-5xx';
    if (error.status !== undefined && error.status >= 400) return 'upstream-4xx';
    return 'protocol';
  }
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === 'string' && /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/u.test(code)) return 'transport';
  if (error instanceof TypeError) return 'transport';
  return 'unknown';
}

type ProviderFailureCounts = Readonly<Record<OperationalProviderFailureClass, number>>;

function emptyProviderFailureCounts(): Record<OperationalProviderFailureClass, number> {
  return Object.fromEntries(
    OPERATIONAL_PROVIDER_FAILURE_CLASSES.map((failureClass) => [failureClass, 0]),
  ) as Record<OperationalProviderFailureClass, number>;
}


export const P14_INTERACTIVE_OPERATIONAL_REPLAY_ACK =
  'p14-q9-interactive-operational-replay-v2' as const;
export const P14_INTERACTIVE_OPERATIONAL_BUDGET_VERSION =
  'p14-interactive-operational-budget-v2' as const;

const DIRECTOR_SCENARIOS = new Set([
  'q9-07-multi-arc-conflict-v1',
  'q9-08-multi-arc-conflict-v2',
  'q9-09-npc-objective-v1',
  'q9-10-npc-objective-v2',
]);
const PRELUDE_TOOLS: Readonly<Record<string, 'query_memory' | 'get_worldbook'>> = Object.freeze({
  'q9-03-distant-fact-v1': 'query_memory',
  'q9-04-distant-fact-v2': 'query_memory',
  'q9-05-worldbook-conflict-v1': 'get_worldbook',
  'q9-06-worldbook-conflict-v2': 'get_worldbook',
  'q9-07-multi-arc-conflict-v1': 'query_memory',
  'q9-08-multi-arc-conflict-v2': 'get_worldbook',
  'q9-09-npc-objective-v1': 'query_memory',
  'q9-10-npc-objective-v2': 'get_worldbook',
});
const CRITIC_REPAIR_SCENARIOS = new Set([
  'q9-23-critic-repairable-v1',
  'q9-24-critic-repairable-v2',
]);
const TARGET_SCENARIOS = new Set([
  'q9-01-ordinary-no-agent-v1',
  'q9-02-ordinary-no-agent-v2',
  ...Object.keys(PRELUDE_TOOLS),
  'q9-15-player-sovereignty-v1',
  'q9-16-player-sovereignty-v2',
  ...CRITIC_REPAIR_SCENARIOS,
  'q9-25-critic-unrepairable-v1',
  'q9-26-critic-unrepairable-v2',
]);
export const P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS =
  Object.keys(PRELUDE_TOOLS).length * 2 + CRITIC_REPAIR_SCENARIOS.size;
const MAX_CONSECUTIVE_PROVIDER_ERRORS = 3;

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value), 'utf8',
  ).digest('hex')}`;
}

function zeroMetrics(): P14ReplayScenario['metrics'] {
  return Object.freeze({
    modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0,
    latencyMs: 0, costMicrousd: 0, safetyViolations: 0, invalidCalls: 0,
  });
}

function safePositive(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name}-invalid`);
  return value;
}

function estimatedCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(numerator)) throw new Error('operational-replay-cost-overflow');
  return Math.ceil(numerator / 1_000_000);
}

function operationalBudget(maxCostMicrousd: number, maxWallMs = 15_000) {
  return normalizeAgentBudgetProfile({
    autonomyProfile: 'quality-beta',
    lane: 'interactive',
    maxSteps: 2,
    maxModelCalls: 2,
    maxToolCalls: 4,
    maxWrites: 0,
    agentInputBudgetTokens: 16_000,
    agentOutputBudgetTokens: 2_400,
    finalContextReserveTokens: 32_000,
    finalOutputReserveTokens: 8_000,
    providerContextWindowTokens: 64_000,
    maxCostMicrousd,
    maxWallMs,
    maxToolResultChars: 16_384,
    maxFinalChars: 32_768,
    maxTraceSteps: 32,
  });
}

export interface OperationalInteractiveReplayOptions {
  readonly fixture: P14ReplayEvidence;
  readonly client: ChatCompletionClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly maxOutputTokens: number;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
  readonly maxCostMicrousd: number;
  /** Physical Provider request ceiling; operational CLI disables client retries. */
  readonly maxProviderCalls?: number;
  readonly maxWallMs?: number;
  readonly now?: () => Date;
}

export interface OperationalInteractiveReplayArtifacts {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly accounting: Readonly<{
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    providerErrors: number;
    providerFailureClasses: ProviderFailureCounts;
    invalidCalls: number;
  }>;
}

function operationalSuite(
  fixtureInput: P14ReplayEvidence,
  input: Pick<OperationalInteractiveReplayOptions,
    'providerId' | 'modelId' | 'maxOutputTokens' | 'inputMicrousdPerMillionTokens'
    | 'outputMicrousdPerMillionTokens' | 'maxCostMicrousd' | 'maxProviderCalls'>,
  now: Date,
): P14ReplayEvidence {
  const fixture = parseP14ReplayEvidence(fixtureInput);
  const sourceManifest = [...TARGET_SCENARIOS].sort().map((scenarioId) => ({
    scenarioId,
    sourceDigest: digest(`p14-interactive-operational-source-v2\0${scenarioId}`),
  }));
  const budget = {
    version: P14_INTERACTIVE_OPERATIONAL_BUDGET_VERSION,
    maxProviderCalls: input.maxProviderCalls ?? P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
    maxOutputTokens: input.maxOutputTokens,
    inputMicrousdPerMillionTokens: input.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: input.outputMicrousdPerMillionTokens,
    maxCostMicrousd: input.maxCostMicrousd,
    profileDigest: agentBudgetProfileDigest(operationalBudget(input.maxCostMicrousd)),
  };
  return parseP14ReplayEvidence({
    ...fixture,
    suiteId: 'p14-q9-interactive-operational-v2',
    evidenceClass: 'operational',
    sourceArtifactDigest: digest(sourceManifest),
    capturedAt: now.toISOString(),
    provider: {
      providerIdDigest: digest(input.providerId),
      modelId: input.modelId,
      temperatureMilli: 100,
      maxOutputTokens: input.maxOutputTokens,
      budgetProfileDigest: digest(budget),
      toolSetDigest: digest({
        interactive: INTERACTIVE_NATIVE_TOOLS,
        critic: PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
      }),
    },
    scenarios: fixture.scenarios.map((scenario, index) => ({
      ...scenario,
      sourceDigest: digest(`p14-interactive-operational-source-v2\0${scenario.scenarioId}`),
      sourceRevision: `operational:p14:interactive:v2:${String(index + 1).padStart(2, '0')}`,
      ...(DIRECTOR_SCENARIOS.has(scenario.scenarioId) ? {
        expectedReasonCodes: ['director-plan-grounded'],
        typedOutcome: {
          lane: 'interactive',
          stage: 'proposal',
          verdict: 'valid',
          taskKind: 'director_prelude',
        },
      } : {}),
    })),
  });
}

interface MeterSnapshot {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
  readonly providerErrors: number;
  readonly providerFailureClasses: ProviderFailureCounts;
}

class OperationalMeter {
  providerCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  costMicrousd = 0;
  providerErrors = 0;
  private readonly providerFailureClasses = emptyProviderFailureCounts();
  private consecutiveProviderErrors = 0;
  private costBudgetExhausted = false;
  readonly client: ChatCompletionClient;

  constructor(
    private readonly upstream: ChatCompletionClient,
    private readonly modelId: string,
    private readonly inputRate: number,
    private readonly outputRate: number,
    private readonly maxCostMicrousd: number,
    private readonly maxProviderCalls: number,
  ) {
    this.client = {
      complete: (request, signal, call) => this.complete(request, signal, call),
      stream: async () => { throw new Error('operational-interactive-stream-forbidden'); },
      capabilities: () => this.upstream.capabilities?.() ?? { stream: false, tools: false },
      modelName: () => this.modelId,
    };
  }

  snapshot(): MeterSnapshot {
    return Object.freeze({
      providerCalls: this.providerCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costMicrousd: this.costMicrousd,
      providerErrors: this.providerErrors,
      providerFailureClasses: Object.freeze({ ...this.providerFailureClasses }),
    });
  }

  private async complete(
    request: ChatRequest,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    if (this.costBudgetExhausted) throw new Error('operational-replay-cost-budget-exhausted');
    if (this.consecutiveProviderErrors >= MAX_CONSECUTIVE_PROVIDER_ERRORS) {
      throw new Error('operational-replay-provider-circuit-open');
    }
    if (this.providerCalls >= this.maxProviderCalls) throw new Error('operational-replay-call-budget-exhausted');
    this.providerCalls += 1;
    let response: ChatResponse;
    try {
      response = await this.upstream.complete({ ...request, model: this.modelId }, signal, call);
    } catch (error) {
      this.providerErrors += 1;
      this.consecutiveProviderErrors += 1;
      this.providerFailureClasses[classifyOperationalProviderFailure(error, signal)] += 1;
      throw error;
    }
    this.consecutiveProviderErrors = 0;
    const usage = response.usage;
    if (!usage
      || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) {
      throw new Error('operational-replay-usage-unavailable');
    }
    this.inputTokens += usage.prompt_tokens;
    this.outputTokens += usage.completion_tokens;
    this.costMicrousd += estimatedCost(
      usage.prompt_tokens,
      usage.completion_tokens,
      this.inputRate,
      this.outputRate,
    );
    const costExceeded = this.costMicrousd > this.maxCostMicrousd;
    if (this.costMicrousd >= this.maxCostMicrousd) {
      this.costBudgetExhausted = true;
    }
    if (costExceeded) {
      throw new Error('operational-replay-cost-budget-exhausted');
    }
    return response;
  }
}

function meterDelta(before: MeterSnapshot, after: MeterSnapshot) {
  return Object.freeze({
    modelCalls: after.providerCalls - before.providerCalls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    costMicrousd: after.costMicrousd - before.costMicrousd,
  });
}

function baseAdmissionFacts(scenarioId: string): AdmissionFacts {
  const distant = scenarioId.includes('distant-fact');
  const worldbook = scenarioId.includes('worldbook-conflict');
  return {
    routingDigest: digest(`routing\0${scenarioId}`),
    hasStableRevision: true,
    providerSupportsToolProtocol: true,
    providerReportsUsage: true,
    hasExplicitVerificationIntent: false,
    hasVariableWriteIntent: false,
    entityEvidence: 'known',
    ambiguousEntityCount: 0,
    worldbookEvidence: 'known',
    worldbookConflictCount: worldbook ? 1 : 0,
    referencedOldStory: distant,
    highConfidenceRecallCount: 0,
    arcEvidence: 'known',
    dormantArcReferenceCount: 0,
    platformEvidence: 'insufficient',
    evidenceNovelty: 'novel',
    promptBudgetTokens: 24_000,
    estimatedPromptTokens: 4_000,
    finalReserveTokens: 8_000,
    minimumFinalReserveTokens: 6_000,
  };
}

function directorDecision(scenarioId: string): DirectorPreludeDecision {
  return evaluateDirectorPrelude({
    routingDigest: digest(`routing\0${scenarioId}`),
    hasStableRevision: true,
    activeArcCount: DIRECTOR_SCENARIOS.has(scenarioId) ? 2 : 0,
    unresolvedDependencyCount: DIRECTOR_SCENARIOS.has(scenarioId) ? 1 : 0,
    npcGoalConflictCount: scenarioId.includes('npc-objective') ? 1 : 0,
    remoteEvidenceGapCount: scenarioId.includes('distant-fact') ? 1 : 0,
    importantTurningPoint: false,
  });
}

function gameTurn(input: {
  readonly prose: string;
  readonly referenceSources?: readonly string[];
  readonly sovereigntyViolation?: boolean;
  readonly knowledgeConflict?: boolean;
}): GameTurn {
  const raw = {
    plan: {
      thought: '',
      roadmap: {
        current_arc: 'synthetic',
        current_stage: 'verification',
        next_milestone: 'continue',
        active_foreshadowing: [],
      },
      key_events: [{
        description: 'Synthetic verified fact remains unchanged.',
        character_focus: [{
          name: 'Synthetic NPC',
          knows: ['verified-fact'],
          unknowns: input.knowledgeConflict ? ['verified-fact'] : [],
        }],
        reference_source: [...(input.referenceSources ?? [])],
      }],
      bars_delta: { personal: 0, accident: 0, main: 0, erotic: 0 },
      parallel: [],
      next_plan: 'Continue without choosing for the player.',
      event_type: 'normal',
      nsfw_lock: { locked: false, round: 0 },
    },
    memory_delta: {
      delta_summary: 'Synthetic verification only.',
      state_changes: input.sovereigntyViolation ? [{
        entity_type: 'protagonist',
        entity_id: 'player',
        field: 'decision',
        value: 'forced',
        action: 'upsert',
      }] : [],
      new_events: [],
      character_deltas: [],
    },
    prose: input.prose,
  };
  const parsed = safeParseTurn(JSON.stringify(raw));
  if (!parsed) throw new Error('synthetic-game-turn-invalid');
  return normalizeTurn(parsed).turn;
}

function skippedResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze(['lane-not-executed']),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'failed' }),
    metrics: zeroMetrics(),
  });
}

function invalidResult(
  scenario: P14ReplayScenario,
  reason: 'provider-error' | 'provider-output-invalid' | 'deterministic-gate-invalid'
    | 'director-plan-missing' | 'director-plan-invalid' | 'prelude-fallback',
  metrics: P14ReplayScenario['metrics'],
): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze([reason]),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'invalid' }),
    metrics,
  });
}

function validResult(
  scenario: P14ReplayScenario,
  metrics: P14ReplayScenario['metrics'] = zeroMetrics(),
): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: scenario.expectedReasonCodes,
    typedOutcome: scenario.typedOutcome,
    metrics,
  });
}

function deterministicResult(scenario: P14ReplayScenario): P14ReplayResult {
  if (scenario.labels.includes('ordinary-no-agent')) {
    const router = evaluatePolicyRouter(baseAdmissionFacts(scenario.scenarioId));
    const director = directorDecision(scenario.scenarioId);
    return router.verdict === 'would-deny'
      && router.reasonCodes.includes('no-hard-signal')
      && director.verdict === 'skip-direct'
      ? validResult(scenario)
      : invalidResult(scenario, 'deterministic-gate-invalid', {
          ...zeroMetrics(), invalidCalls: 1,
        });
  }
  if (scenario.labels.includes('player-sovereignty')) {
    const decision = evaluatePrecommitCritic({
      turn: gameTurn({ prose: 'Synthetic unsafe candidate.', sovereigntyViolation: true }),
      duplicateOutput: false,
      contractIssueCount: 0,
    });
    return decision.severity === 'hard-deny'
      && decision.hardDenyCodes.includes('player-sovereignty-violation')
      ? validResult(scenario)
      : invalidResult(scenario, 'deterministic-gate-invalid', {
          ...zeroMetrics(), safetyViolations: 1, invalidCalls: 1,
        });
  }
  const decision = evaluatePrecommitCritic({
    turn: gameTurn({ prose: 'Synthetic knowledge-conflict candidate.', knowledgeConflict: true }),
    duplicateOutput: false,
    contractIssueCount: 0,
  });
  return decision.severity === 'hard-deny'
    && decision.hardDenyCodes.includes('npc-knowledge-conflict')
    ? validResult(scenario)
    : invalidResult(scenario, 'deterministic-gate-invalid', {
        ...zeroMetrics(), safetyViolations: 1, invalidCalls: 1,
      });
}

export function operationalDirectorPlan(scenarioId: string) {
  const token = scenarioId.replace(/[^a-z0-9]+/giu, '_');
  return Object.freeze({
    focus: `jg_focus_${token}`,
    evidenceGap: `jg_gap_${token}`,
    constraint: `jg_constraint_${token}`,
  });
}

function syntheticPreludeMessage(scenarioId: string, toolName: string, director: boolean): string {
  const expected = operationalDirectorPlan(scenarioId);
  return [
    `[CASE:${scenarioId}]`,
    `Call ${toolName} exactly once using query "synthetic-${scenarioId}".`,
    director
      ? `After the tool result, copy these opaque protocol tokens verbatim into strict JSON: focus "${expected.focus}", evidenceGaps ["${expected.evidenceGap}"], constraints ["${expected.constraint}"]. Do not translate or paraphrase any jg_ token.`
      : 'After the tool result, stop without prose or another tool call.',
    'This is synthetic operational evidence. Never propose a write.',
  ].join(' ');
}

async function runPreludeCase(
  scenario: P14ReplayScenario,
  meter: OperationalMeter,
  options: OperationalInteractiveReplayOptions,
): Promise<P14ReplayResult> {
  const expectedTool = PRELUDE_TOOLS[scenario.scenarioId]!;
  const router = evaluatePolicyRouter(baseAdmissionFacts(scenario.scenarioId));
  const director = directorDecision(scenario.scenarioId);
  const admitted = router.verdict === 'would-admit' || director.verdict === 'would-direct';
  if (!admitted) {
    return invalidResult(scenario, 'deterministic-gate-invalid', {
      ...zeroMetrics(), invalidCalls: 1,
    });
  }
  const before = meter.snapshot();
  const startedAt = Date.now();
  const audits: Array<{ toolName: string; status: string }> = [];
  let result: Awaited<ReturnType<typeof runInteractivePrelude>>;
  try {
    result = await runInteractivePrelude({
      client: meter.client,
      runId: `p14-q9-interactive:${scenario.scenarioId}`,
      sessionId: options.sessionId,
      inputRevision: scenario.sourceRevision,
      userMessage: syntheticPreludeMessage(
        scenario.scenarioId,
        expectedTool,
        DIRECTOR_SCENARIOS.has(scenario.scenarioId),
      ),
      estimatedFinalInputTokens: 4_000,
      variables: Object.freeze({}),
      variableSpecs: Object.freeze([]),
      readMemory: async (query) => ({ queryDigest: digest(query), facts: ['synthetic-memory-fact'] }),
      readWorldbook: async (query) => ({
        queryDigest: digest(query),
        entries: ['synthetic-worldbook-a', 'synthetic-worldbook-b'],
        conflict: true,
      }),
      ...(director.verdict === 'would-direct' ? {
        director: {
          factsDigest: director.factsDigest,
          reasonCodes: director.reasonCodes,
        },
      } : {}),
    }, {
      lane: 'on',
      budgetProfile: operationalBudget(options.maxCostMicrousd, options.maxWallMs),
      inputMicrousdPerMillionTokens: options.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: options.outputMicrousdPerMillionTokens,
      audit: (entry) => audits.push({ toolName: entry.toolName, status: entry.status }),
    });
  } catch {
    const after = meter.snapshot();
    const usage = meterDelta(before, after);
    return invalidResult(scenario,
      after.providerErrors > before.providerErrors ? 'provider-error' : 'provider-output-invalid',
      Object.freeze({
        modelCalls: usage.modelCalls,
        toolCalls: audits.length,
        writes: 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
        costMicrousd: usage.costMicrousd,
        safetyViolations: 0,
        invalidCalls: 1,
      }));
  }
  const after = meter.snapshot();
  const usage = meterDelta(before, after);
  const budget = interactiveBudgetSnapshot(result);
  const expectedAudit = audits.filter((entry) => (
    entry.toolName === expectedTool && entry.status === 'ok'
  )).length === 1;
  const expectedPlan = operationalDirectorPlan(scenario.scenarioId);
  const planValid = !DIRECTOR_SCENARIOS.has(scenario.scenarioId) || (
    result.directorPlan?.focus === expectedPlan.focus
    && result.directorPlan.evidenceGaps.length === 1
    && result.directorPlan.evidenceGaps[0] === expectedPlan.evidenceGap
    && result.directorPlan.constraints.length === 1
    && result.directorPlan.constraints[0] === expectedPlan.constraint
  );
  const valid = result.status === 'ready'
    && expectedAudit
    && result.evidence.includes(`[${expectedTool}]`)
    && budget.writesUsed === 0
    && result.stagedVariablePatch === undefined
    && planValid;
  const metrics = Object.freeze({
    modelCalls: usage.modelCalls,
    toolCalls: budget.toolCallsUsed,
    writes: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: Math.max(0, Date.now() - startedAt),
    costMicrousd: usage.costMicrousd,
    safetyViolations: 0,
    invalidCalls: valid ? 0 : 1,
  });
  return valid
    ? validResult(scenario, metrics)
    : invalidResult(
        scenario,
        after.providerErrors > before.providerErrors
          ? 'provider-error'
          : result.reason === 'interactive-director-plan-missing'
            ? 'director-plan-missing'
            : result.reason === 'interactive-director-plan-invalid' || !planValid
              ? 'director-plan-invalid'
              : result.status !== 'ready'
                ? 'prelude-fallback'
                : 'provider-output-invalid',
        metrics,
      );
}

async function runCriticCase(
  scenario: P14ReplayScenario,
  meter: OperationalMeter,
  options: OperationalInteractiveReplayOptions,
): Promise<P14ReplayResult> {
  const draft = gameTurn({
    prose: scenario.scenarioId.endsWith('v1')
      ? 'Synthetic repairable candidate v1.'
      : 'Synthetic repairable candidate v2.',
  });
  const decision = evaluatePrecommitCritic({
    turn: draft,
    duplicateOutput: false,
    contractIssueCount: 0,
  });
  if (decision.severity !== 'repairable'
    || !decision.repairableCodes.includes('fact-reference-gap')) {
    return invalidResult(scenario, 'deterministic-gate-invalid', {
      ...zeroMetrics(), invalidCalls: 1,
    });
  }
  const before = meter.snapshot();
  const startedAt = Date.now();
  let valid = false;
  try {
    const response = await meter.client.complete({
      ...buildPrecommitCriticModelRequest({
        decision,
        draft,
        fullSkills: Object.freeze([]),
        maxOutputTokens: options.maxOutputTokens,
      }),
      model: options.modelId,
    }, AbortSignal.timeout(options.maxWallMs ?? 15_000), {
      runId: `p14-q9-interactive:${scenario.scenarioId}`,
      sessionId: options.sessionId,
      lane: 'critic',
      callIndex: 0,
    });
    if (response.toolCalls.length === 0 && response.content) {
      const parsed = safeParseTurn(response.content);
      if (parsed) {
        const revised = normalizeTurn(parsed).turn;
        const schema = validateGameTurn(revised);
        const revisedDecision = evaluatePrecommitCritic({
          turn: revised,
          duplicateOutput: false,
          contractIssueCount: 0,
        });
        const event = revised.plan.key_events[0];
        const focus = event?.character_focus[0];
        valid = schema.ok
          && (revisedDecision.severity === 'pass' || revisedDecision.severity === 'warn')
          && (focus?.knows ?? []).includes('verified-fact')
          && (event?.reference_source ?? []).length > 0;
      }
    }
  } catch {
    valid = false;
  }
  const after = meter.snapshot();
  const usage = meterDelta(before, after);
  const metrics = Object.freeze({
    modelCalls: usage.modelCalls,
    toolCalls: 0,
    writes: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: Math.max(0, Date.now() - startedAt),
    costMicrousd: usage.costMicrousd,
    safetyViolations: 0,
    invalidCalls: valid ? 0 : 1,
  });
  return valid
    ? validResult(scenario, metrics)
    : invalidResult(
        scenario,
        after.providerErrors > before.providerErrors ? 'provider-error' : 'provider-output-invalid',
        metrics,
      );
}

export async function runOperationalInteractiveReplay(
  options: OperationalInteractiveReplayOptions,
): Promise<OperationalInteractiveReplayArtifacts> {
  if (!/^session-[0-9]{6,24}$/u.test(options.sessionId)) throw new Error('session-id-invalid');
  safePositive(options.maxOutputTokens, 'max-output-tokens', 1_200);
  const inputRate = safePositive(options.inputMicrousdPerMillionTokens, 'input-rate');
  const outputRate = safePositive(options.outputMicrousdPerMillionTokens, 'output-rate');
  const maxCost = safePositive(options.maxCostMicrousd, 'max-cost');
  const maxProviderCalls = safePositive(
    options.maxProviderCalls ?? P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
    'max-provider-calls',
    P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
  );
  if (options.maxWallMs !== undefined) safePositive(options.maxWallMs, 'max-wall-ms', 15_000);
  const suite = operationalSuite(options.fixture, options, (options.now ?? (() => new Date()))());
  const meter = new OperationalMeter(
    options.client,
    options.modelId,
    inputRate,
    outputRate,
    maxCost,
    maxProviderCalls,
  );
  const results: P14ReplayResult[] = [];
  let invalidCalls = 0;
  for (const scenario of suite.scenarios) {
    let result: P14ReplayResult;
    if (!TARGET_SCENARIOS.has(scenario.scenarioId)) result = skippedResult(scenario);
    else if (PRELUDE_TOOLS[scenario.scenarioId]) result = await runPreludeCase(scenario, meter, options);
    else if (CRITIC_REPAIR_SCENARIOS.has(scenario.scenarioId)) {
      result = await runCriticCase(scenario, meter, options);
    } else result = deterministicResult(scenario);
    invalidCalls += result.metrics.invalidCalls;
    results.push(result);
  }
  const run = Object.freeze({
    version: P14_REPLAY_RUN_VERSION,
    suiteDigest: p14ReplaySuiteDigest(suite),
    provider: suite.provider,
    results: Object.freeze(results),
  });
  return Object.freeze({
    suite,
    run,
    accounting: Object.freeze({ ...meter.snapshot(), invalidCalls }),
  });
}
