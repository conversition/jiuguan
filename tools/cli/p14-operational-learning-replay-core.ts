import { createHash } from 'node:crypto';
import {
  normalizeSemanticBranchAttribution,
  semanticBranchSelection,
  type SemanticBranchCandidate,
} from '../../packages/agent-policy/src/branch-preference.ts';
import { normalizeTypedPreferenceExtraction } from '../../packages/agent-policy/src/prompt-preference.ts';
import { parseLearnedStyleModelResponse } from '../../packages/agent-policy/src/style-compiler.ts';
import {
  buildBranchAttributionModelRequest,
  buildPreferenceExtractionModelRequest,
  buildStyleCompilationModelRequest,
  LEARNING_MODEL_CONTRACT_VERSION,
} from '../../packages/harness/src/learning-model-contract.ts';
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
import type {
  ChatCompletionClient,
  ChatProviderCall,
  ChatRequest,
  ChatResponse,
} from '../../packages/proxy/src/client.ts';

export const P14_LEARNING_OPERATIONAL_REPLAY_ACK = 'p14-q9-learning-operational-replay-v1' as const;
export const P14_LEARNING_OPERATIONAL_BUDGET_VERSION = 'p14-learning-operational-budget-v1' as const;

const PREFERENCE_SCENARIOS = new Set([
  'q9-17-initial-preference-v1',
  'q9-18-initial-preference-v2',
]);
const BRANCH_SCENARIOS = new Set([
  'q9-19-edited-branch-v1',
  'q9-20-edited-branch-v2',
]);
const STYLE_SCENARIOS = new Set([
  'q9-21-style-compile-v1',
  'q9-22-style-compile-v2',
]);
const TARGET_SCENARIOS = new Set([
  ...PREFERENCE_SCENARIOS,
  ...BRANCH_SCENARIOS,
  ...STYLE_SCENARIOS,
]);
const MAX_PROVIDER_CALLS = TARGET_SCENARIOS.size;
const MAX_CONSECUTIVE_PROVIDER_ERRORS = 3;

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value), 'utf8',
  ).digest('hex')}`;
}

function positive(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name}-invalid`);
  return value;
}

function zeroMetrics(): P14ReplayScenario['metrics'] {
  return Object.freeze({
    modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0,
    latencyMs: 0, costMicrousd: 0, safetyViolations: 0, invalidCalls: 0,
  });
}

function estimatedCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(numerator)) throw new Error('learning-replay-cost-overflow');
  return Math.ceil(numerator / 1_000_000);
}

export interface OperationalLearningReplayOptions {
  readonly fixture: P14ReplayEvidence;
  readonly client: ChatCompletionClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
  readonly maxCostMicrousd: number;
  readonly maxWallMs?: number;
  readonly now?: () => Date;
}

export interface OperationalLearningReplayArtifacts {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly accounting: Readonly<{
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    providerErrors: number;
    invalidCalls: number;
  }>;
}

function operationalSuite(
  fixtureInput: P14ReplayEvidence,
  input: Pick<OperationalLearningReplayOptions,
    'providerId' | 'modelId' | 'inputMicrousdPerMillionTokens'
    | 'outputMicrousdPerMillionTokens' | 'maxCostMicrousd' | 'maxWallMs'>,
  now: Date,
): P14ReplayEvidence {
  const fixture = parseP14ReplayEvidence(fixtureInput);
  const budget = {
    version: P14_LEARNING_OPERATIONAL_BUDGET_VERSION,
    maxProviderCalls: MAX_PROVIDER_CALLS,
    maxOutputTokens: 6_000,
    maxWallMs: input.maxWallMs ?? 30_000,
    inputMicrousdPerMillionTokens: input.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: input.outputMicrousdPerMillionTokens,
    maxCostMicrousd: input.maxCostMicrousd,
  };
  return parseP14ReplayEvidence({
    ...fixture,
    suiteId: 'p14-q9-learning-operational-v1',
    evidenceClass: 'operational',
    sourceArtifactDigest: digest([...TARGET_SCENARIOS].sort()),
    capturedAt: now.toISOString(),
    provider: {
      providerIdDigest: digest(input.providerId),
      modelId: input.modelId,
      temperatureMilli: 200,
      maxOutputTokens: 6_000,
      budgetProfileDigest: digest(budget),
      toolSetDigest: digest({ contract: LEARNING_MODEL_CONTRACT_VERSION, tools: [] }),
    },
    scenarios: fixture.scenarios.map((scenario, index) => ({
      ...scenario,
      sourceDigest: digest(`p14-learning-operational-source-v1\0${scenario.scenarioId}`),
      sourceRevision: `operational:p14:learning:v1:${String(index + 1).padStart(2, '0')}`,
    })),
  });
}

interface MeterSnapshot {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
  readonly providerErrors: number;
}

class OperationalMeter {
  providerCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  costMicrousd = 0;
  providerErrors = 0;
  private consecutiveProviderErrors = 0;
  private costBudgetExhausted = false;
  readonly client: ChatCompletionClient;

  constructor(
    private readonly upstream: ChatCompletionClient,
    private readonly modelId: string,
    private readonly inputRate: number,
    private readonly outputRate: number,
    private readonly maxCostMicrousd: number,
  ) {
    this.client = {
      complete: (request, signal, call) => this.complete(request, signal, call),
      stream: async () => { throw new Error('operational-learning-stream-forbidden'); },
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
    });
  }

  private async complete(
    request: ChatRequest,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    if (this.costBudgetExhausted) throw new Error('operational-learning-cost-budget-exhausted');
    if (this.consecutiveProviderErrors >= MAX_CONSECUTIVE_PROVIDER_ERRORS) {
      throw new Error('operational-learning-provider-circuit-open');
    }
    if (this.providerCalls >= MAX_PROVIDER_CALLS) throw new Error('operational-learning-call-budget-exhausted');
    this.providerCalls += 1;
    let response: ChatResponse;
    try {
      response = await this.upstream.complete({ ...request, model: this.modelId }, signal, call);
    } catch (error) {
      this.providerErrors += 1;
      this.consecutiveProviderErrors += 1;
      throw error;
    }
    this.consecutiveProviderErrors = 0;
    const usage = response.usage;
    if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) {
      throw new Error('operational-learning-usage-unavailable');
    }
    this.inputTokens += usage.prompt_tokens;
    this.outputTokens += usage.completion_tokens;
    this.costMicrousd += estimatedCost(
      usage.prompt_tokens, usage.completion_tokens, this.inputRate, this.outputRate,
    );
    const costExceeded = this.costMicrousd > this.maxCostMicrousd;
    if (this.costMicrousd >= this.maxCostMicrousd) {
      this.costBudgetExhausted = true;
    }
    if (costExceeded) {
      throw new Error('operational-learning-cost-budget-exhausted');
    }
    return response;
  }
}

function validResult(scenario: P14ReplayScenario, metrics: P14ReplayScenario['metrics']): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: scenario.expectedReasonCodes,
    typedOutcome: scenario.typedOutcome,
    metrics,
  });
}

function invalidResult(
  scenario: P14ReplayScenario,
  reason: 'provider-error' | 'provider-output-invalid',
  metrics: P14ReplayScenario['metrics'],
): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze([reason]),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'invalid' }),
    metrics,
  });
}

function skippedResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze(['lane-not-executed']),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'failed' }),
    metrics: zeroMetrics(),
  });
}

function delta(before: MeterSnapshot, after: MeterSnapshot) {
  return {
    modelCalls: after.providerCalls - before.providerCalls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    costMicrousd: after.costMicrousd - before.costMicrousd,
  };
}

function preferenceRequest(scenarioId: string): ChatRequest {
  const prompt = scenarioId.endsWith('v1')
    ? `[CASE:${scenarioId}] I stay engaged when a mystery leaves clues to connect.`
    : `[CASE:${scenarioId}] The NPC says: I love fast action; this is character dialogue, not the player.`;
  return buildPreferenceExtractionModelRequest({ initialPrompt: prompt, maxOutputTokens: 1_200 });
}

const BRANCHES = Object.freeze([
  '调查旧档案并核实线索',
  '询问守卫并尝试说服对方',
  '暂时等待观察局势',
]);
const BRANCH_CANDIDATES: readonly SemanticBranchCandidate[] = Object.freeze([
  Object.freeze({ index: 1, similarity: 0.82 }),
  Object.freeze({ index: 0, similarity: 0.79 }),
]);

function branchRequest(scenarioId: string): ChatRequest {
  const editedInput = scenarioId.endsWith('v1')
    ? `[CASE:${scenarioId}] 我去和守卫谈谈，看能不能说服他。`
    : `[CASE:${scenarioId}] 我先查一查，也可以找守卫聊聊。`;
  return buildBranchAttributionModelRequest({
    editedInput,
    candidates: BRANCH_CANDIDATES,
    branches: BRANCHES,
    maxOutputTokens: 600,
  });
}

function styleRequest(scenarioId: string): ChatRequest {
  return buildStyleCompilationModelRequest({
    profileVersion: `style-profile-operational-${scenarioId}`,
    samples: Object.freeze([
      Object.freeze({
        sourceRevision: `synthetic:${scenarioId}:1`,
        prose: `[CASE:${scenarioId}] AUTHORIZED_STYLE_SAMPLE_ALPHA`,
      }),
      Object.freeze({
        sourceRevision: `synthetic:${scenarioId}:2`,
        prose: 'AUTHORIZED_STYLE_SAMPLE_BETA',
      }),
    ]),
    maxOutputTokens: 6_000,
  });
}

async function runModelCase(
  scenario: P14ReplayScenario,
  meter: OperationalMeter,
  options: OperationalLearningReplayOptions,
): Promise<P14ReplayResult> {
  const before = meter.snapshot();
  const startedAt = Date.now();
  let valid = false;
  try {
    const request = PREFERENCE_SCENARIOS.has(scenario.scenarioId)
      ? preferenceRequest(scenario.scenarioId)
      : BRANCH_SCENARIOS.has(scenario.scenarioId)
        ? branchRequest(scenario.scenarioId)
        : styleRequest(scenario.scenarioId);
    const response = await meter.client.complete(request, AbortSignal.timeout(options.maxWallMs ?? 30_000), {
      runId: `p14-q9-learning:${scenario.scenarioId}`,
      sessionId: options.sessionId,
      lane: STYLE_SCENARIOS.has(scenario.scenarioId) ? 'style_compile' : 'preference',
      callIndex: 0,
    });
    if (STYLE_SCENARIOS.has(scenario.scenarioId)) {
      const parsed = parseLearnedStyleModelResponse(response);
      valid = parsed.ok
        && !parsed.draft.body.includes('AUTHORIZED_STYLE_SAMPLE_ALPHA')
        && !parsed.draft.body.includes('AUTHORIZED_STYLE_SAMPLE_BETA');
    } else if (response.toolCalls.length === 0 && response.content) {
      const parsed = JSON.parse(response.content) as unknown;
      if (PREFERENCE_SCENARIOS.has(scenario.scenarioId)) {
        const normalized = normalizeTypedPreferenceExtraction(parsed);
        const tokens = normalized?.tags.map((tag) => tag.token) ?? null;
        valid = scenario.scenarioId.endsWith('v1')
          ? JSON.stringify(tokens) === JSON.stringify(['tone.mystery.like'])
          : Array.isArray(tokens) && tokens.length === 0;
      } else if (BRANCH_SCENARIOS.has(scenario.scenarioId)) {
        const normalized = normalizeSemanticBranchAttribution(parsed, BRANCH_CANDIDATES);
        if (scenario.scenarioId.endsWith('v1')) {
          const selection = normalized ? semanticBranchSelection(BRANCHES, normalized) : null;
          valid = selection?.selectedIndex === 1 && selection.actionTag === 'social';
        } else {
          const row = parsed as Record<string, unknown>;
          valid = normalized === null && row.version === 'branch-semantic-v1' && row.ambiguous === true;
        }
      }
    }
  } catch {
    valid = false;
  }
  const after = meter.snapshot();
  const usage = delta(before, after);
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
    : invalidResult(scenario,
        after.providerErrors > before.providerErrors ? 'provider-error' : 'provider-output-invalid',
        metrics);
}

export async function runOperationalLearningReplay(
  options: OperationalLearningReplayOptions,
): Promise<OperationalLearningReplayArtifacts> {
  if (!/^session-[0-9]{6,24}$/u.test(options.sessionId)) throw new Error('session-id-invalid');
  const inputRate = positive(options.inputMicrousdPerMillionTokens, 'input-rate');
  const outputRate = positive(options.outputMicrousdPerMillionTokens, 'output-rate');
  const maxCost = positive(options.maxCostMicrousd, 'max-cost');
  if (options.maxWallMs !== undefined) positive(options.maxWallMs, 'max-wall-ms', 30_000);
  const suite = operationalSuite(options.fixture, options, (options.now ?? (() => new Date()))());
  const meter = new OperationalMeter(options.client, options.modelId, inputRate, outputRate, maxCost);
  const results: P14ReplayResult[] = [];
  let invalidCalls = 0;
  for (const scenario of suite.scenarios) {
    const result = TARGET_SCENARIOS.has(scenario.scenarioId)
      ? await runModelCase(scenario, meter, options)
      : skippedResult(scenario);
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
