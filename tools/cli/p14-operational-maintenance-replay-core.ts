import { createHash } from 'node:crypto';
import type { ChatCompletionClient } from '../../packages/proxy/src/client.ts';
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
import { legacyMaintenanceReplayProviderTools } from '../../apps/server/admitted-maintenance-model.ts';
import {
  validateLegacyMaintenanceReplayProposal,
  type MaintenanceTaskKind,
} from '../../apps/server/maintenance-types.ts';

export const P14_OPERATIONAL_REPLAY_ACK = 'p14-q9-operational-replay-v1' as const;
export const P14_OPERATIONAL_BUDGET_VERSION = 'p14-maintenance-operational-budget-v1' as const;

type ProviderScenario = Readonly<{
  taskKind: Extract<MaintenanceTaskKind, 'branch_index' | 'npc_state'>;
  system: string;
  user: string;
  expectedBranchIds?: readonly string[];
  expectedCharacterId?: string;
  expectedEvidenceKind?: 'objective_fact' | 'belief' | 'knowledge';
  validateSemantic(args: Record<string, unknown>): boolean;
}>;

const ARC_CASE = (variant: 1 | 2): ProviderScenario => {
  const ids = variant === 1 ? ['route-north', 'route-south'] : ['rescue-first', 'seal-first'];
  return Object.freeze({
    taskKind: 'branch_index',
    expectedBranchIds: Object.freeze([...ids]),
    system: [
      'You are a bounded background maintenance worker.',
      'The supplied evidence is complete and synthetic.',
      'Call propose_branch_index exactly once. Do not write state and do not answer with prose.',
      `Return exactly two branches with branchId ${ids[0]} and ${ids[1]}.`,
      'Keep both conflicting possibilities open; do not invent a winning branch.',
    ].join(' '),
    user: variant === 1
      ? 'Evidence A says the north route is safe. Evidence B says only the south route is safe. Both sources have equal authority.'
      : 'One source requires rescuing the witness before sealing the gate. Another requires sealing the gate before the rescue. No source resolves the order.',
    validateSemantic(args) {
      const rows = args.branches;
      if (!Array.isArray(rows) || rows.length !== 2) return false;
      const actual = rows.map((row) => (row as { branchId?: unknown }).branchId).sort();
      return actual.join('\0') === [...ids].sort().join('\0');
    },
  });
};

const NPC_CASE = (
  variant: 1 | 2,
  kind: 'objective_fact' | 'belief' | 'knowledge',
): ProviderScenario => {
  const characterId = variant === 1 ? 'npc-aria' : 'npc-borin';
  const evidence = kind === 'objective_fact'
    ? variant === 1
      ? 'The narrator directly records that Aria carries the brass key.'
      : 'The narrator directly records that Borin is wounded.'
    : kind === 'belief'
      ? variant === 1
        ? 'Aria privately believes the mayor is a spy; the narrator does not confirm it.'
        : 'Borin privately believes the bridge is trapped; the narrator does not confirm it.'
      : variant === 1
        ? 'Aria personally witnessed the gate opening at midnight.'
        : 'Borin read the signed order and therefore knows the evacuation time.';
  return Object.freeze({
    taskKind: 'npc_state',
    expectedCharacterId: characterId,
    expectedEvidenceKind: kind,
    system: [
      'You are a bounded background maintenance worker.',
      'The supplied evidence is complete and synthetic.',
      'Call propose_npc_state exactly once. Do not write state and do not answer with prose.',
      `Return exactly one character with characterId ${characterId}.`,
      `Set evidenceKind to ${kind}; do not convert belief or knowledge into objective_fact.`,
      'Patch must contain exactly one concise evidence-specific property, never two or more.',
    ].join(' '),
    user: evidence,
    validateSemantic(args) {
      const rows = args.characters;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rows[0] as { characterId?: unknown; evidenceKind?: unknown; patch?: unknown };
      if (row.characterId !== characterId || !row.patch || typeof row.patch !== 'object' || Array.isArray(row.patch)) {
        return false;
      }
      return row.evidenceKind === kind && Object.keys(row.patch as Record<string, unknown>).length === 1;
    },
  });
};

const PROVIDER_CASES: Readonly<Record<string, ProviderScenario>> = Object.freeze({
  'q9-07-multi-arc-conflict-v1': ARC_CASE(1),
  'q9-08-multi-arc-conflict-v2': ARC_CASE(2),
  'q9-09-npc-objective-v1': NPC_CASE(1, 'objective_fact'),
  'q9-10-npc-objective-v2': NPC_CASE(2, 'objective_fact'),
  'q9-11-npc-belief-v1': NPC_CASE(1, 'belief'),
  'q9-12-npc-belief-v2': NPC_CASE(2, 'belief'),
  'q9-13-npc-knowledge-v1': NPC_CASE(1, 'knowledge'),
  'q9-14-npc-knowledge-v2': NPC_CASE(2, 'knowledge'),
});

const TARGET_LANES = new Set(['arc', 'npc', 'maintenance']);

function scenarioProviderTools(scenario: ProviderScenario): readonly Record<string, unknown>[] {
  const tools = structuredClone([
    ...legacyMaintenanceReplayProviderTools(scenario.taskKind),
  ]) as Array<Record<string, unknown>>;
  const proposal = tools.find((tool) => {
    const fn = tool.function as Record<string, unknown> | undefined;
    return fn?.name === `propose_${scenario.taskKind}`;
  });
  const fn = proposal?.function as Record<string, unknown> | undefined;
  const parameters = fn?.parameters as Record<string, unknown> | undefined;
  const properties = parameters?.properties as Record<string, unknown> | undefined;
  if (!proposal || !fn || !parameters || !properties) {
    throw new Error('operational-replay-tool-schema-invalid');
  }
  if (scenario.taskKind === 'branch_index') {
    const branches = properties.branches as Record<string, unknown> | undefined;
    const items = branches?.items as Record<string, unknown> | undefined;
    const itemProperties = items?.properties as Record<string, unknown> | undefined;
    const branchId = itemProperties?.branchId as Record<string, unknown> | undefined;
    if (!branches || !items || !itemProperties || !branchId || !scenario.expectedBranchIds) {
      throw new Error('operational-replay-tool-schema-invalid');
    }
    branches.minItems = scenario.expectedBranchIds.length;
    branches.maxItems = scenario.expectedBranchIds.length;
    branchId.enum = [...scenario.expectedBranchIds];
  } else {
    const characters = properties.characters as Record<string, unknown> | undefined;
    const items = characters?.items as Record<string, unknown> | undefined;
    const itemProperties = items?.properties as Record<string, unknown> | undefined;
    const characterId = itemProperties?.characterId as Record<string, unknown> | undefined;
    const evidenceKind = itemProperties?.evidenceKind as Record<string, unknown> | undefined;
    const patch = itemProperties?.patch as Record<string, unknown> | undefined;
    if (!characters || !items || !itemProperties || !characterId || !evidenceKind || !patch
      || !scenario.expectedCharacterId || !scenario.expectedEvidenceKind) {
      throw new Error('operational-replay-tool-schema-invalid');
    }
    characters.minItems = 1;
    characters.maxItems = 1;
    characterId.enum = [scenario.expectedCharacterId];
    evidenceKind.enum = [scenario.expectedEvidenceKind];
    patch.minProperties = 1;
    patch.maxProperties = 1;
  }
  return Object.freeze(tools.map((tool) => Object.freeze(tool)));
}

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

export interface OperationalMaintenanceReplayOptions {
  readonly fixture: P14ReplayEvidence;
  readonly client: ChatCompletionClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly maxOutputTokens: number;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
  readonly maxCostMicrousd: number;
  readonly now?: () => Date;
}

export interface OperationalMaintenanceReplayArtifacts {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly terminationReason: 'completed' | 'budget-cost-exhausted';
  readonly accounting: Readonly<{
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    providerErrors: number;
    invalidCalls: number;
  }>;
}

function safePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}-invalid`);
  return value;
}

function estimatedCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(numerator)) throw new Error('operational-replay-cost-overflow');
  return Math.ceil(numerator / 1_000_000);
}

function operationalSuite(
  fixtureInput: P14ReplayEvidence,
  input: Pick<OperationalMaintenanceReplayOptions,
    'providerId' | 'modelId' | 'maxOutputTokens' | 'inputMicrousdPerMillionTokens'
    | 'outputMicrousdPerMillionTokens' | 'maxCostMicrousd'>,
  now: Date,
): P14ReplayEvidence {
  const fixture = parseP14ReplayEvidence(fixtureInput);
  const sourceManifest = Object.entries(PROVIDER_CASES).map(([scenarioId, row]) => ({
    scenarioId, taskKind: row.taskKind, sourceDigest: digest(`${row.system}\0${row.user}`),
  }));
  const budget = {
    version: P14_OPERATIONAL_BUDGET_VERSION,
    maxProviderCalls: sourceManifest.length,
    maxOutputTokens: input.maxOutputTokens,
    inputMicrousdPerMillionTokens: input.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: input.outputMicrousdPerMillionTokens,
    maxCostMicrousd: input.maxCostMicrousd,
  };
  const tools = Object.entries(PROVIDER_CASES).map(([scenarioId, scenario]) => ({
    scenarioId,
    tools: scenarioProviderTools(scenario),
  }));
  return parseP14ReplayEvidence({
    ...fixture,
    evidenceClass: 'operational',
    sourceArtifactDigest: digest(sourceManifest),
    capturedAt: now.toISOString(),
    provider: {
      providerIdDigest: digest(input.providerId), modelId: input.modelId, temperatureMilli: 0,
      maxOutputTokens: input.maxOutputTokens, budgetProfileDigest: digest(budget), toolSetDigest: digest(tools),
    },
    scenarios: fixture.scenarios.map((scenario, index) => ({
      ...scenario,
      sourceDigest: digest(`p14-operational-source-v1\0${scenario.scenarioId}`),
      sourceRevision: `operational:p14:v1:${String(index + 1).padStart(2, '0')}`,
    })),
  });
}

function skippedResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId, reasonCodes: Object.freeze(['lane-not-executed']),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'failed' }), metrics: zeroMetrics(),
  });
}

function deterministicResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId, reasonCodes: scenario.expectedReasonCodes,
    typedOutcome: scenario.typedOutcome, metrics: zeroMetrics(),
  });
}

function costBudgetExhaustedResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze(['budget-cost-exhausted']),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'failed' }),
    metrics: zeroMetrics(),
  });
}

export async function runOperationalMaintenanceReplay(
  options: OperationalMaintenanceReplayOptions,
): Promise<OperationalMaintenanceReplayArtifacts> {
  if (!/^session-[0-9]{6,24}$/u.test(options.sessionId)) throw new Error('session-id-invalid');
  const maxOutputTokens = safePositive(options.maxOutputTokens, 'max-output-tokens');
  const inputRate = safePositive(options.inputMicrousdPerMillionTokens, 'input-rate');
  const outputRate = safePositive(options.outputMicrousdPerMillionTokens, 'output-rate');
  const maxCost = safePositive(options.maxCostMicrousd, 'max-cost');
  const suite = operationalSuite(options.fixture, options, (options.now ?? (() => new Date()))());
  const results: P14ReplayResult[] = [];
  let providerCalls = 0, inputTokens = 0, outputTokens = 0, costMicrousd = 0;
  let providerErrors = 0, invalidCalls = 0;
  let terminationReason: OperationalMaintenanceReplayArtifacts['terminationReason'] = 'completed';

  for (const scenario of suite.scenarios) {
    if (!TARGET_LANES.has(scenario.typedOutcome.lane)) {
      results.push(skippedResult(scenario));
      continue;
    }
    const providerCase = PROVIDER_CASES[scenario.scenarioId];
    if (!providerCase) {
      results.push(deterministicResult(scenario));
      continue;
    }
    if (costMicrousd >= maxCost) terminationReason = 'budget-cost-exhausted';
    if (terminationReason === 'budget-cost-exhausted') {
      results.push(costBudgetExhaustedResult(scenario));
      continue;
    }
    if (providerCalls >= Object.keys(PROVIDER_CASES).length) throw new Error('operational-replay-call-budget-exhausted');
    const startedAt = Date.now();
    providerCalls += 1;
    let toolCalls = 0, caseInputTokens = 0, caseOutputTokens = 0, caseCost = 0;
    let valid = false, providerError = false, costBudgetExhausted = false;
    try {
      const response = await options.client.complete({
        model: options.modelId,
        messages: [{ role: 'system', content: providerCase.system }, { role: 'user', content: providerCase.user }],
        tools: [...scenarioProviderTools(providerCase)],
        tool_choice: { type: 'function', function: { name: `propose_${providerCase.taskKind}` } },
        temperature: 0, max_tokens: maxOutputTokens, stream: false,
      }, AbortSignal.timeout(60_000), {
        runId: `p14-q9-op:${scenario.scenarioId}`, sessionId: options.sessionId, lane: 'maintenance',
      });
      if (!response.usage) throw new Error('operational-replay-usage-unavailable');
      caseInputTokens = response.usage.prompt_tokens;
      caseOutputTokens = response.usage.completion_tokens;
      caseCost = estimatedCost(caseInputTokens, caseOutputTokens, inputRate, outputRate);
      inputTokens += caseInputTokens;
      outputTokens += caseOutputTokens;
      costMicrousd += caseCost;
      if (costMicrousd > maxCost) {
        // Provider usage is only authoritative after the response. Account that response exactly,
        // then make the budget a hard latch so no subsequent Provider call can start.
        costBudgetExhausted = true;
        terminationReason = 'budget-cost-exhausted';
      } else {
        toolCalls = response.toolCalls.length;
        const call = response.toolCalls.length === 1 ? response.toolCalls[0] : undefined;
        if (call?.name === `propose_${providerCase.taskKind}`) {
          const args = JSON.parse(call.arguments) as unknown;
          validateLegacyMaintenanceReplayProposal(providerCase.taskKind, args);
          valid = providerCase.validateSemantic(args as Record<string, unknown>);
        }
      }
    } catch (error) {
      providerError = error instanceof Error && (
        error.message.includes('HTTP') || error.message.includes('fetch')
        || error.message.includes('timeout') || error.message.includes('aborted')
      );
      if (providerError) providerErrors += 1;
    }
    if (!valid && !costBudgetExhausted) invalidCalls += 1;
    results.push(Object.freeze({
      scenarioId: scenario.scenarioId,
      reasonCodes: Object.freeze(valid ? [...scenario.expectedReasonCodes]
        : [costBudgetExhausted ? 'budget-cost-exhausted'
          : providerError ? 'provider-error' : 'provider-output-invalid']),
      typedOutcome: Object.freeze(valid ? { ...scenario.typedOutcome }
        : { ...scenario.typedOutcome, verdict: costBudgetExhausted ? 'failed' as const : 'invalid' as const }),
      metrics: Object.freeze({
        modelCalls: 1, toolCalls, writes: 0, inputTokens: caseInputTokens,
        outputTokens: caseOutputTokens, latencyMs: Date.now() - startedAt,
        costMicrousd: caseCost, safetyViolations: 0,
        invalidCalls: valid || costBudgetExhausted ? 0 : 1,
      }),
    }));
  }
  const run = Object.freeze({
    version: P14_REPLAY_RUN_VERSION, suiteDigest: p14ReplaySuiteDigest(suite),
    provider: suite.provider, results: Object.freeze(results),
  });
  return Object.freeze({
    suite, run,
    terminationReason,
    accounting: Object.freeze({ providerCalls, inputTokens, outputTokens, costMicrousd, providerErrors, invalidCalls }),
  });
}
