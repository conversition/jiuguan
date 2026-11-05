import { createHash } from 'node:crypto';
import {
  legacyMemoryMaintenanceReplayProviderTools,
  maintenanceProviderTools,
} from '../../apps/server/admitted-maintenance-model.ts';
import {
  isWorldbookRepairProposalContext,
  validateMaintenanceProposal,
  type RollingSummaryProposalContext,
  type WorldbookRepairProposalContext,
} from '../../apps/server/maintenance-types.ts';
import {
  OPERATIONAL_REPLAY_ACKS,
  P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  type OperationalReplayAccounting,
  type OperationalReplayResponse,
  type OperationalReplayTransportClient,
} from '../../packages/operational-replay-contract/index.ts';

export const P14_MAINTENANCE_OPERATIONAL_V3_FIXTURE_VERSION =
  'p14-maintenance-operational-fixture-v3' as const;
export const P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID =
  'p14-q9-maintenance-operational-suite-v3' as const;
export const P14_MAINTENANCE_OPERATIONAL_V3_REPORT_VERSION =
  'p14-maintenance-operational-report-v3' as const;
// The loopback bridge keeps its v2 acknowledgement so the established safety gate
// remains backwards compatible. v3 is a new suite, not a broader authorization.
export const P14_MAINTENANCE_OPERATIONAL_V3_ACK = OPERATIONAL_REPLAY_ACKS.maintenance;
export const P14_MAINTENANCE_OPERATIONAL_V3_MAX_PROVIDER_CALLS = 3 as const;

/**
 * Parse the repair-only selector before the replay bridge is opened. A present
 * but malformed option must never silently widen a one-call operator intent
 * into the three-call full suite.
 */
export function parseMaintenanceOperationalV3ScenarioArg(
  args: readonly string[],
): string | undefined {
  const indexes = args.flatMap((value, index) => value === '--scenario' ? [index] : []);
  const inlineValues = args.flatMap((value) => (
    value.startsWith('--scenario=') ? [value.slice('--scenario='.length)] : []
  ));
  if (indexes.length === 0 && inlineValues.length === 0) return undefined;
  if (indexes.length + inlineValues.length !== 1) {
    throw new Error('maintenance-v3-scenario-option-duplicate');
  }
  if (inlineValues.length === 1) {
    const value = inlineValues[0]!;
    if (value.trim().length === 0 || value.startsWith('--')) {
      throw new Error('maintenance-v3-scenario-option-value-required');
    }
    return value;
  }
  const value = args[indexes[0]! + 1];
  if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
    throw new Error('maintenance-v3-scenario-option-value-required');
  }
  return value;
}

const TARGET_TASKS = Object.freeze([
  'memory_consolidation',
  'rolling_summary',
  'worldbook_repair',
] as const);
export type MaintenanceOperationalV3TaskKind = (typeof TARGET_TASKS)[number];

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/u;
const REAL_SESSION_RE = /session-[0-9]{6,24}/u;
const SECRET_RE = /(?:\bsk-[A-Za-z0-9_-]{12,}|\bjgp1_[A-Za-z0-9_-]{8,}|authorization\s*:)/iu;

export interface MaintenanceOperationalV3TaskContext {
  readonly version: 'maintenance-operational-context-v3';
  readonly sessionId: 'session-operational-maintenance-v3';
  readonly sourceRevision: string;
  readonly evidenceDigest: string;
  readonly maxRound: number;
}

export interface MaintenanceOperationalV3Case {
  readonly scenarioId: string;
  readonly taskKind: MaintenanceOperationalV3TaskKind;
  readonly taskContext: MaintenanceOperationalV3TaskContext;
  readonly proposalContext: WorldbookRepairProposalContext | RollingSummaryProposalContext | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly expectedProposal: Readonly<Record<string, unknown>>;
}

export interface MaintenanceOperationalV3Fixture {
  readonly version: typeof P14_MAINTENANCE_OPERATIONAL_V3_FIXTURE_VERSION;
  readonly suiteId: typeof P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID;
  readonly cases: readonly MaintenanceOperationalV3Case[];
}

function operationalV3ProviderTools(
  taskKind: MaintenanceOperationalV3TaskKind,
  proposalContext: WorldbookRepairProposalContext | RollingSummaryProposalContext | null,
): readonly Record<string, unknown>[] {
  return taskKind === 'memory_consolidation'
    ? legacyMemoryMaintenanceReplayProviderTools()
    : maintenanceProviderTools(taskKind, proposalContext ?? undefined);
}

export type MaintenanceOperationalV3Classification =
  | 'valid'
  | 'provider-error'
  | 'protocol-error'
  | 'usage-unavailable'
  | 'tool-missing'
  | 'tool-count-invalid'
  | 'tool-name-invalid'
  | 'arguments-json-invalid'
  | 'text-envelope-invalid'
  | 'proposal-schema-invalid'
  | 'semantic-mismatch'
  | 'protocol-skipped'
  | 'budget-skipped';

export type MaintenanceOperationalV3FailureCode =
  | 'OP_REPLAY_RATE_LIMIT'
  | 'OP_REPLAY_TIMEOUT'
  | 'OP_REPLAY_UPSTREAM_5XX'
  | 'OP_REPLAY_UPSTREAM_4XX'
  | 'OP_REPLAY_AUTHENTICATION'
  | 'OP_REPLAY_REQUEST_INVALID'
  | 'OP_REPLAY_TRANSPORT'
  | 'OP_REPLAY_BUDGET'
  | 'OP_REPLAY_PROTOCOL';

export interface MaintenanceOperationalV3CaseResult {
  readonly scenarioId: string;
  readonly taskKind: MaintenanceOperationalV3TaskKind;
  readonly classification: MaintenanceOperationalV3Classification;
  /** Stable, content-free bridge diagnostic; never contains upstream text. */
  readonly failureCode: MaintenanceOperationalV3FailureCode | null;
  readonly providerCallIndex: number | null;
  readonly modelCalls: 0 | 1;
  readonly toolCalls: number;
  readonly writes: 0;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costMicrousd: number;
  readonly requestDigest: string;
}

export interface MaintenanceOperationalV3RunReport {
  readonly version: typeof P14_MAINTENANCE_OPERATIONAL_V3_REPORT_VERSION;
  readonly suiteId: typeof P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID;
  readonly evidenceClass: 'operational-shadow';
  readonly evidenceScope: 'full-suite' | 'repair-single-case';
  readonly selectedScenarioIds: readonly string[];
  readonly capturedAt: string;
  readonly sessionIdDigest: string;
  readonly provider: Readonly<{
    providerIdDigest: string;
    modelId: string;
    maxOutputTokens: number;
    maxCostMicrousd: number;
    toolSetDigest: string;
    sourceArtifactDigest: string;
  }>;
  readonly safety: Readonly<{
    syntheticFixtureOnly: true;
    businessSessionRead: false;
    businessWrites: 0;
    retriesPerCase: 0;
  }>;
  readonly sourceManifest: readonly Readonly<{
    scenarioId: string;
    taskKind: MaintenanceOperationalV3TaskKind;
    sourceDigest: string;
    taskContextDigest: string;
    proposalContextDigest: string;
    toolSetDigest: string;
  }>[];
  readonly results: readonly MaintenanceOperationalV3CaseResult[];
  readonly terminationReason: 'completed' | 'budget-cost-exhausted' | 'protocol-stopped';
  readonly accounting: Readonly<{
    providerCalls: number;
    successfulCalls: number;
    failedCalls: number;
    invalidCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    writes: 0;
  }>;
  readonly reportDigest: string;
}

export interface MaintenanceOperationalV3Evidence extends MaintenanceOperationalV3RunReport {
  readonly bridgeAccounting: OperationalReplayAccounting;
  readonly evidenceDigest: string;
}

export interface MaintenanceOperationalV3Options {
  readonly fixture: MaintenanceOperationalV3Fixture;
  readonly client: OperationalReplayTransportClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly maxOutputTokens: number;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
  readonly maxCostMicrousd: number;
  /** Optional repair replay selector. The full fixture is still validated before filtering. */
  readonly scenarioIds?: readonly string[];
  readonly now?: () => Date;
  readonly nowMs?: () => number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('maintenance-v3-digest-value-invalid');
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

export function maintenanceOperationalV3Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label}-invalid`);
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}-fields-invalid`);
  }
}

function positive(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label}-invalid`);
  }
  return Number(value);
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}-invalid`);
  return Number(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function ensureRedactedFixture(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024
    || REAL_SESSION_RE.test(serialized) || SECRET_RE.test(serialized)) {
    throw new Error('maintenance-v3-fixture-not-redacted');
  }
}

function parseTaskContext(value: unknown): MaintenanceOperationalV3TaskContext {
  plain(value, 'maintenance-v3-task-context');
  exact(value, ['version', 'sessionId', 'sourceRevision', 'evidenceDigest', 'maxRound'],
    'maintenance-v3-task-context');
  if (value.version !== 'maintenance-operational-context-v3'
    || value.sessionId !== 'session-operational-maintenance-v3'
    || typeof value.sourceRevision !== 'string' || !DIGEST_RE.test(value.sourceRevision)
    || typeof value.evidenceDigest !== 'string' || !DIGEST_RE.test(value.evidenceDigest)) {
    throw new Error('maintenance-v3-task-context-invalid');
  }
  return deepFreeze({
    version: value.version,
    sessionId: value.sessionId,
    sourceRevision: value.sourceRevision,
    evidenceDigest: value.evidenceDigest,
    maxRound: positive(value.maxRound, 'maintenance-v3-max-round', 1_000_000),
  });
}

function maxFactRound(proposal: Record<string, unknown>): number {
  const facts = Array.isArray(proposal.facts) ? proposal.facts : [];
  return facts.reduce((maximum, fact) => {
    const round = fact && typeof fact === 'object' && !Array.isArray(fact)
      ? (fact as Record<string, unknown>).sourceRound : undefined;
    return Number.isInteger(round) ? Math.max(maximum, Number(round)) : maximum;
  }, 0);
}

export function parseMaintenanceOperationalV3Fixture(value: unknown): MaintenanceOperationalV3Fixture {
  ensureRedactedFixture(value);
  plain(value, 'maintenance-v3-fixture');
  exact(value, ['version', 'suiteId', 'cases'], 'maintenance-v3-fixture');
  if (value.version !== P14_MAINTENANCE_OPERATIONAL_V3_FIXTURE_VERSION
    || value.suiteId !== P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID
    || !Array.isArray(value.cases)
    || value.cases.length !== P14_MAINTENANCE_OPERATIONAL_V3_MAX_PROVIDER_CALLS) {
    throw new Error('maintenance-v3-fixture-contract-invalid');
  }
  const parsed = value.cases.map((rawCase, index): MaintenanceOperationalV3Case => {
    plain(rawCase, `maintenance-v3-case-${index}`);
    exact(rawCase, [
      'scenarioId', 'taskKind', 'taskContext', 'proposalContext', 'evidence', 'expectedProposal',
    ], `maintenance-v3-case-${index}`);
    if (typeof rawCase.scenarioId !== 'string' || !TOKEN_RE.test(rawCase.scenarioId)
      || typeof rawCase.taskKind !== 'string'
      || !(TARGET_TASKS as readonly string[]).includes(rawCase.taskKind)) {
      throw new Error('maintenance-v3-case-identity-invalid');
    }
    const taskKind = rawCase.taskKind as MaintenanceOperationalV3TaskKind;
    const taskContext = parseTaskContext(rawCase.taskContext);
    plain(rawCase.evidence, `maintenance-v3-case-${index}-evidence`);
    plain(rawCase.expectedProposal, `maintenance-v3-case-${index}-proposal`);
    if (maintenanceOperationalV3Digest(rawCase.evidence) !== taskContext.evidenceDigest) {
      throw new Error('maintenance-v3-evidence-digest-mismatch');
    }
    let proposalContext: WorldbookRepairProposalContext | RollingSummaryProposalContext | null = null;
    if (taskKind === 'worldbook_repair') {
      if (!isWorldbookRepairProposalContext(rawCase.proposalContext)
        || rawCase.proposalContext.sessionId !== taskContext.sessionId) {
        throw new Error('maintenance-v3-worldbook-context-invalid');
      }
      proposalContext = structuredClone(rawCase.proposalContext);
    } else if (taskKind === 'rolling_summary') {
      plain(rawCase.proposalContext, 'maintenance-v3-summary-context');
      exact(rawCase.proposalContext, ['sessionId', 'sourceRevision', 'targetRound'],
        'maintenance-v3-summary-context');
      if (rawCase.proposalContext.sessionId !== taskContext.sessionId
        || rawCase.proposalContext.sourceRevision !== taskContext.sourceRevision
        || rawCase.proposalContext.targetRound !== taskContext.maxRound) {
        throw new Error('maintenance-v3-summary-context-invalid');
      }
      proposalContext = {
        sessionId: taskContext.sessionId,
        sourceRevision: taskContext.sourceRevision,
        targetRound: taskContext.maxRound,
      };
    } else if (rawCase.proposalContext !== null) {
      throw new Error('maintenance-v3-unexpected-proposal-context');
    }
    const validated = validateMaintenanceProposal(
      taskKind,
      rawCase.expectedProposal,
      proposalContext ?? undefined,
    );
    if (taskKind === 'memory_consolidation' && maxFactRound(validated.payload) > taskContext.maxRound) {
      throw new Error('maintenance-v3-memory-round-out-of-context');
    }
    if (taskKind === 'rolling_summary'
      && validated.payload.throughRound !== taskContext.maxRound) {
      throw new Error('maintenance-v3-summary-round-out-of-context');
    }
    const parsedCase: MaintenanceOperationalV3Case = {
      scenarioId: rawCase.scenarioId,
      taskKind,
      taskContext,
      proposalContext,
      evidence: structuredClone(rawCase.evidence),
      expectedProposal: structuredClone(validated.payload),
    };
    // Building the tools is part of preflight: a missing strict context must fail
    // before a Provider authorization can be consumed.
    operationalV3ProviderTools(taskKind, proposalContext);
    return deepFreeze(parsedCase);
  });
  if (new Set(parsed.map((item) => item.scenarioId)).size !== parsed.length
    || TARGET_TASKS.some((taskKind) => parsed.filter((item) => item.taskKind === taskKind).length !== 1)) {
    throw new Error('maintenance-v3-task-coverage-invalid');
  }
  return deepFreeze({
    version: P14_MAINTENANCE_OPERATIONAL_V3_FIXTURE_VERSION,
    suiteId: P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID,
    cases: parsed,
  });
}

function estimatedCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const numerator = BigInt(inputTokens) * BigInt(inputRate) + BigInt(outputTokens) * BigInt(outputRate);
  const result = (numerator + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('maintenance-v3-cost-overflow');
  return Number(result);
}

function taskTools(item: MaintenanceOperationalV3Case): readonly Record<string, unknown>[] {
  const tools = structuredClone(operationalV3ProviderTools(item.taskKind, item.proposalContext));
  if (item.taskKind === 'memory_consolidation') {
    const proposal = tools.find((tool) => (
      (tool.function as { name?: unknown } | undefined)?.name === 'propose_memory_consolidation'
    ));
    const parameters = proposal?.function && typeof proposal.function === 'object'
      ? (proposal.function as { parameters?: unknown }).parameters : undefined;
    plain(parameters, 'maintenance-v3-memory-parameters');
    const properties = parameters.properties;
    plain(properties, 'maintenance-v3-memory-properties');
    const facts = properties.facts;
    plain(facts, 'maintenance-v3-memory-facts');
    const items = facts.items;
    plain(items, 'maintenance-v3-memory-fact-items');
    const itemProperties = items.properties;
    plain(itemProperties, 'maintenance-v3-memory-fact-properties');
    const sourceRound = itemProperties.sourceRound;
    plain(sourceRound, 'maintenance-v3-memory-source-round');
    sourceRound.maximum = item.taskContext.maxRound;
  }
  return deepFreeze(tools);
}

export function buildMaintenanceOperationalV3Request(
  item: MaintenanceOperationalV3Case,
  modelId: string,
  maxOutputTokens: number,
): Readonly<Record<string, unknown>> {
  const expectedTool = `propose_${item.taskKind}`;
  const system = [
    `[CASE:${item.scenarioId}]`,
    'This is a fixed, synthetic, redacted shadow contract replay.',
    `Call ${expectedTool} exactly once. Do not call read tools and do not write domain state.`,
    'Prefer the native function call; if unavailable, return only',
    `{"tool":{"name":"${expectedTool}","args":<proposal object>}}.`,
    `Pass this exact object as args: ${JSON.stringify(item.expectedProposal)}.`,
  ].join(' ');
  const user = JSON.stringify({
    scenarioId: item.scenarioId,
    taskKind: item.taskKind,
    taskContext: item.taskContext,
    ...(item.proposalContext ? { proposalContext: item.proposalContext } : {}),
    evidence: item.evidence,
  });
  return deepFreeze({
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [...taskTools(item)],
    tool_choice: 'auto',
    temperature: 0,
    max_tokens: maxOutputTokens,
    stream: false,
  });
}

function parseTextEnvelope(
  content: string | null,
  expectedTool: string,
): { ok: true; args: unknown } | { ok: false; classification: MaintenanceOperationalV3Classification } {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, classification: 'tool-missing' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch {
    return {
      ok: false,
      classification: content.includes('"tool"') ? 'arguments-json-invalid' : 'text-envelope-invalid',
    };
  }
  try {
    plain(parsed, 'maintenance-v3-text-envelope');
    exact(parsed, ['tool'], 'maintenance-v3-text-envelope');
    plain(parsed.tool, 'maintenance-v3-text-envelope-tool');
    exact(parsed.tool, ['name', 'args'], 'maintenance-v3-text-envelope-tool');
    if (parsed.tool.name !== expectedTool) return { ok: false, classification: 'tool-name-invalid' };
    return { ok: true, args: parsed.tool.args };
  } catch {
    return { ok: false, classification: 'text-envelope-invalid' };
  }
}

export function classifyMaintenanceOperationalV3Response(
  item: MaintenanceOperationalV3Case,
  response: OperationalReplayResponse,
): Readonly<{
  classification: MaintenanceOperationalV3Classification;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}> {
  if (!response.usage) {
    return { classification: 'usage-unavailable', toolCalls: response.toolCalls.length, inputTokens: 0, outputTokens: 0 };
  }
  const inputTokens = nonNegative(response.usage.prompt_tokens, 'maintenance-v3-input-tokens');
  const outputTokens = nonNegative(response.usage.completion_tokens, 'maintenance-v3-output-tokens');
  if (response.toolCalls.length > 1) {
    return { classification: 'tool-count-invalid', toolCalls: response.toolCalls.length, inputTokens, outputTokens };
  }
  const expectedTool = `propose_${item.taskKind}`;
  const call = response.toolCalls[0];
  let args: unknown;
  let toolCalls = response.toolCalls.length;
  if (call) {
    if (call.name !== expectedTool) {
      return { classification: 'tool-name-invalid', toolCalls, inputTokens, outputTokens };
    }
    try { args = JSON.parse(call.arguments); }
    catch {
      return { classification: 'arguments-json-invalid', toolCalls, inputTokens, outputTokens };
    }
  } else {
    const envelope = parseTextEnvelope(response.content, expectedTool);
    if (!envelope.ok) return { classification: envelope.classification, toolCalls, inputTokens, outputTokens };
    toolCalls = 1;
    args = envelope.args;
  }
  let validated: Record<string, unknown>;
  try {
    validated = validateMaintenanceProposal(
      item.taskKind,
      args,
      item.proposalContext ?? undefined,
    ).payload;
  } catch {
    return { classification: 'proposal-schema-invalid', toolCalls, inputTokens, outputTokens };
  }
  return {
    classification: canonical(validated) === canonical(item.expectedProposal) ? 'valid' : 'semantic-mismatch',
    toolCalls,
    inputTokens,
    outputTokens,
  };
}

function errorClassification(error: unknown): 'provider-error' | 'protocol-error' | 'budget-skipped' {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'OP_REPLAY_BUDGET') return 'budget-skipped';
  if (typeof code === 'string' && [
    'OP_REPLAY_RATE_LIMIT', 'OP_REPLAY_TIMEOUT', 'OP_REPLAY_UPSTREAM_5XX',
    'OP_REPLAY_UPSTREAM_4XX', 'OP_REPLAY_AUTHENTICATION',
    'OP_REPLAY_REQUEST_INVALID', 'OP_REPLAY_TRANSPORT',
  ].includes(code)) return 'provider-error';
  const message = error instanceof Error ? error.message : '';
  return /provider|upstream|transport|timeout|fetch|429|5\d\d/iu.test(message)
    ? 'provider-error' : 'protocol-error';
}

function safeFailureCode(error: unknown): MaintenanceOperationalV3FailureCode | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && [
    'OP_REPLAY_RATE_LIMIT', 'OP_REPLAY_TIMEOUT', 'OP_REPLAY_UPSTREAM_5XX',
    'OP_REPLAY_UPSTREAM_4XX', 'OP_REPLAY_AUTHENTICATION',
    'OP_REPLAY_REQUEST_INVALID', 'OP_REPLAY_TRANSPORT', 'OP_REPLAY_BUDGET',
    'OP_REPLAY_PROTOCOL',
  ].includes(code) ? code as MaintenanceOperationalV3FailureCode : null;
}

function preflight(options: MaintenanceOperationalV3Options): Readonly<{
  fixture: MaintenanceOperationalV3Fixture;
  cases: readonly MaintenanceOperationalV3Case[];
  maxOutputTokens: number;
  inputRate: number;
  outputRate: number;
  maxCost: number;
}> {
  if (!/^session-[0-9]{6,24}$/u.test(options.sessionId)) throw new Error('maintenance-v3-session-id-invalid');
  if (typeof options.providerId !== 'string' || options.providerId.trim().length === 0
    || typeof options.modelId !== 'string' || options.modelId.trim().length === 0) {
    throw new Error('maintenance-v3-provider-selection-invalid');
  }
  const fixture = parseMaintenanceOperationalV3Fixture(options.fixture);
  const requested = options.scenarioIds === undefined
    ? fixture.cases.map((item) => item.scenarioId)
    : [...options.scenarioIds];
  if (requested.length < 1
    || (options.scenarioIds !== undefined && requested.length !== 1)
    || new Set(requested).size !== requested.length
    || requested.some((scenarioId) => typeof scenarioId !== 'string'
      || !fixture.cases.some((item) => item.scenarioId === scenarioId))) {
    throw new Error('maintenance-v3-scenario-selection-invalid');
  }
  const selected = requested.map((scenarioId) => (
    fixture.cases.find((item) => item.scenarioId === scenarioId)!
  ));
  return Object.freeze({
    fixture,
    cases: Object.freeze(selected),
    maxOutputTokens: positive(options.maxOutputTokens, 'maintenance-v3-max-output-tokens', 16_000),
    inputRate: positive(options.inputMicrousdPerMillionTokens, 'maintenance-v3-input-rate'),
    outputRate: positive(options.outputMicrousdPerMillionTokens, 'maintenance-v3-output-rate'),
    maxCost: positive(
      options.maxCostMicrousd,
      'maintenance-v3-max-cost',
      P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
    ),
  });
}

export async function runOperationalMaintenanceV3Replay(
  options: MaintenanceOperationalV3Options,
): Promise<MaintenanceOperationalV3RunReport> {
  const checked = preflight(options);
  const nowMs = options.nowMs ?? Date.now;
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const sourceManifest = checked.cases.map((item) => Object.freeze({
    scenarioId: item.scenarioId,
    taskKind: item.taskKind,
    sourceDigest: maintenanceOperationalV3Digest({ evidence: item.evidence, expectedProposal: item.expectedProposal }),
    taskContextDigest: maintenanceOperationalV3Digest(item.taskContext),
    proposalContextDigest: maintenanceOperationalV3Digest(item.proposalContext),
    toolSetDigest: maintenanceOperationalV3Digest(taskTools(item)),
  }));
  const results: MaintenanceOperationalV3CaseResult[] = [];
  let providerCalls = 0;
  let successfulCalls = 0;
  let failedCalls = 0;
  let invalidCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicrousd = 0;
  let terminationReason: MaintenanceOperationalV3RunReport['terminationReason'] = 'completed';

  for (const item of checked.cases) {
    const request = buildMaintenanceOperationalV3Request(item, options.modelId, checked.maxOutputTokens);
    const requestDigest = maintenanceOperationalV3Digest(request);
    if (terminationReason !== 'completed' || costMicrousd >= checked.maxCost) {
      if (costMicrousd >= checked.maxCost) terminationReason = 'budget-cost-exhausted';
      results.push(Object.freeze({
        scenarioId: item.scenarioId,
        taskKind: item.taskKind,
        classification: terminationReason === 'budget-cost-exhausted'
          ? 'budget-skipped' : 'protocol-skipped',
        failureCode: null,
        providerCallIndex: null, modelCalls: 0, toolCalls: 0, writes: 0,
        inputTokens: 0, outputTokens: 0, latencyMs: 0, costMicrousd: 0, requestDigest,
      }));
      continue;
    }
    const callIndex = providerCalls;
    providerCalls += 1; // Count before crossing the physical Provider boundary; failures also count.
    let providerCallIndex: number | null = callIndex;
    let modelCalls: 0 | 1 = 1;
    const startedAt = nowMs();
    let classification: MaintenanceOperationalV3Classification;
    let failureCode: MaintenanceOperationalV3FailureCode | null = null;
    let toolCalls = 0;
    let caseInputTokens = 0;
    let caseOutputTokens = 0;
    try {
      const response = await options.client.complete(
        request,
        AbortSignal.timeout(60_000),
        {
          runId: `p14-q9-maintenance-v3:${item.scenarioId}`,
          sessionId: options.sessionId,
          lane: 'maintenance',
        },
      );
      const classified = classifyMaintenanceOperationalV3Response(item, response);
      classification = classified.classification;
      toolCalls = classified.toolCalls;
      caseInputTokens = classified.inputTokens;
      caseOutputTokens = classified.outputTokens;
      inputTokens += caseInputTokens;
      outputTokens += caseOutputTokens;
      if (classification === 'usage-unavailable') terminationReason = 'protocol-stopped';
    } catch (error) {
      failureCode = safeFailureCode(error);
      const errorKind = errorClassification(error);
      classification = errorKind === 'budget-skipped' ? 'budget-skipped' : errorKind;
      if (errorKind === 'budget-skipped') {
        // The bridge checks and rejects its conservative reservation before
        // crossing the physical Provider boundary, so this is not a model call.
        providerCalls -= 1;
        providerCallIndex = null;
        modelCalls = 0;
        terminationReason = 'budget-cost-exhausted';
      }
      if (errorKind === 'protocol-error') terminationReason = 'protocol-stopped';
    }
    const caseCost = estimatedCost(caseInputTokens, caseOutputTokens, checked.inputRate, checked.outputRate);
    costMicrousd += caseCost;
    if (classification === 'valid') successfulCalls += 1;
    else if (classification === 'provider-error' || classification === 'protocol-error'
      || classification === 'usage-unavailable') failedCalls += 1;
    else if (classification !== 'budget-skipped') invalidCalls += 1;
    results.push(Object.freeze({
      scenarioId: item.scenarioId,
      taskKind: item.taskKind,
      classification,
      failureCode,
      providerCallIndex,
      modelCalls,
      toolCalls,
      writes: 0,
      inputTokens: caseInputTokens,
      outputTokens: caseOutputTokens,
      latencyMs: Math.max(0, nowMs() - startedAt),
      costMicrousd: caseCost,
      requestDigest,
    }));
    if (costMicrousd > checked.maxCost) terminationReason = 'budget-cost-exhausted';
  }

  const toolSetDigest = maintenanceOperationalV3Digest(sourceManifest.map((item) => ({
    scenarioId: item.scenarioId,
    toolSetDigest: item.toolSetDigest,
  })));
  const sourceArtifactDigest = maintenanceOperationalV3Digest(sourceManifest.map((item) => ({
    scenarioId: item.scenarioId,
    sourceDigest: item.sourceDigest,
    taskContextDigest: item.taskContextDigest,
    proposalContextDigest: item.proposalContextDigest,
  })));
  const base = deepFreeze({
    version: P14_MAINTENANCE_OPERATIONAL_V3_REPORT_VERSION,
    suiteId: P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID,
    evidenceClass: 'operational-shadow' as const,
    evidenceScope: options.scenarioIds === undefined
      ? 'full-suite' as const : 'repair-single-case' as const,
    selectedScenarioIds: checked.cases.map((item) => item.scenarioId),
    capturedAt,
    sessionIdDigest: maintenanceOperationalV3Digest(options.sessionId),
    provider: {
      providerIdDigest: maintenanceOperationalV3Digest(options.providerId),
      modelId: options.modelId,
      maxOutputTokens: checked.maxOutputTokens,
      maxCostMicrousd: checked.maxCost,
      toolSetDigest,
      sourceArtifactDigest,
    },
    safety: {
      syntheticFixtureOnly: true as const,
      businessSessionRead: false as const,
      businessWrites: 0 as const,
      retriesPerCase: 0 as const,
    },
    sourceManifest,
    results,
    terminationReason,
    accounting: {
      providerCalls,
      successfulCalls,
      failedCalls,
      invalidCalls,
      inputTokens,
      outputTokens,
      costMicrousd,
      writes: 0 as const,
    },
  });
  return deepFreeze({ ...base, reportDigest: maintenanceOperationalV3Digest(base) });
}

export function buildMaintenanceOperationalV3Evidence(
  report: MaintenanceOperationalV3RunReport,
  bridgeAccounting: OperationalReplayAccounting,
): MaintenanceOperationalV3Evidence {
  if (report.version !== P14_MAINTENANCE_OPERATIONAL_V3_REPORT_VERSION
    || report.suiteId !== P14_MAINTENANCE_OPERATIONAL_V3_SUITE_ID
    || report.reportDigest !== maintenanceOperationalV3Digest((({ reportDigest: _ignored, ...rest }) => rest)(report))
    || report.accounting.writes !== 0 || report.safety.businessWrites !== 0) {
    throw new Error('maintenance-v3-report-invalid');
  }
  if (report.evidenceScope !== 'full-suite' && report.evidenceScope !== 'repair-single-case') {
    throw new Error('maintenance-v3-evidence-scope-invalid');
  }
  if ((report.evidenceScope === 'full-suite'
      && (report.results.length !== P14_MAINTENANCE_OPERATIONAL_V3_MAX_PROVIDER_CALLS
        || TARGET_TASKS.some((taskKind) => !report.results.some((item) => item.taskKind === taskKind))))
    || (report.evidenceScope === 'repair-single-case' && report.results.length !== 1)
    || report.selectedScenarioIds.length !== report.results.length
    || report.results.some((item, index) => item.scenarioId !== report.selectedScenarioIds[index])) {
    throw new Error('maintenance-v3-evidence-scope-invalid');
  }
  for (const field of ['providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd'] as const) {
    nonNegative(bridgeAccounting[field], `maintenance-v3-bridge-${field}`);
  }
  if (bridgeAccounting.providerCalls !== report.accounting.providerCalls
    || bridgeAccounting.inputTokens !== report.accounting.inputTokens
    || bridgeAccounting.outputTokens !== report.accounting.outputTokens
    || bridgeAccounting.costMicrousd < report.accounting.costMicrousd
    || bridgeAccounting.costMicrousd > report.provider.maxCostMicrousd) {
    throw new Error('maintenance-v3-bridge-accounting-mismatch');
  }
  const base = deepFreeze({ ...report, bridgeAccounting: { ...bridgeAccounting } });
  return deepFreeze({ ...base, evidenceDigest: maintenanceOperationalV3Digest(base) });
}
