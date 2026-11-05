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
  parseP14ReplayRun,
  type P14ReplayResult,
  type P14ReplayRun,
} from '../../packages/harness/src/lane-evaluation.ts';
import {
  OPERATIONAL_REPLAY_ACKS,
  P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION,
  P14_MAINTENANCE_OPERATIONAL_BUDGET_ID,
  P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID,
  type MaintenanceOperationalReplayAccountingEvidence,
  type MaintenanceOperationalReplayBridgeAccounting,
  type MaintenanceOperationalReplaySourceManifestEntry,
  type MaintenanceOperationalReplayToolSetManifestEntry,
} from '../../packages/operational-replay-contract/index.ts';
import { maintenanceProviderTools } from '../../apps/server/admitted-maintenance-model.ts';
import {
  npcMaintenanceProposalRejectionCode,
  validateMaintenanceProposal,
  type MaintenanceStrictProposalContext,
  type MaintenanceTaskKind,
  type NpcMaintenanceProposalRejectionCode,
  type NpcMaintenanceProposalContext,
} from '../../apps/server/maintenance-types.ts';

export const P14_OPERATIONAL_REPLAY_ACK = OPERATIONAL_REPLAY_ACKS.maintenance;
export const P14_OPERATIONAL_BUDGET_VERSION = P14_MAINTENANCE_OPERATIONAL_BUDGET_ID;

export const P14_MAINTENANCE_OPERATIONAL_CASE_IDS = Object.freeze([
  // NPC is deliberately first: it is the dynamic-schema contract canary.
  'q9-09-npc-objective-v1',
  'q9-10-npc-objective-v2',
  'q9-11-npc-belief-v1',
  'q9-12-npc-belief-v2',
  'q9-13-npc-knowledge-v1',
  'q9-14-npc-knowledge-v2',
  'q9-07-multi-arc-conflict-v1',
  'q9-08-multi-arc-conflict-v2',
] as const);

type ProviderCaseId = (typeof P14_MAINTENANCE_OPERATIONAL_CASE_IDS)[number];
type ProviderTaskKind = Extract<MaintenanceTaskKind, 'branch_index' | 'npc_state'>;
type ArcProposalContext = Readonly<{
  sessionId: string;
  sourceRevision: string;
  allowedArcIds: readonly string[];
  allowedSourceRefs: readonly string[];
  maxRound: number;
}>;

interface ProviderScenario {
  readonly scenarioId: ProviderCaseId;
  readonly taskKind: ProviderTaskKind;
  readonly proposalContext: MaintenanceStrictProposalContext;
  /** Kept in-memory only; diagnostics compare its keys/types, never its values. */
  readonly expectedArgs: Readonly<Record<string, unknown>>;
  readonly system: string;
  readonly user: string;
  readonly validateSemantic: (payload: Record<string, unknown>) => boolean;
}

const TARGET_LANES = new Set(['arc', 'npc', 'maintenance']);
const SHA_RE = /^sha256:[a-f0-9]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('operational-replay-digest-value-invalid');
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

export function maintenanceOperationalReplayDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function hexDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceRevision(scenarioId: ProviderCaseId): string {
  return `sha256:${hexDigest(`p14-maintenance-operational-v2\0${scenarioId}`)}`;
}

function arcId(scenarioId: ProviderCaseId, index: number): string {
  return `arc:sha256:${hexDigest(`p14-maintenance-operational-arc-v2\0${scenarioId}\0${index}`)}`;
}

function npcCase(
  scenarioId: Extract<ProviderCaseId, `q9-${string}-npc-${string}`>,
  characterId: 'npc-aria' | 'npc-borin',
  kind: 'objective_fact' | 'belief' | 'knowledge',
  variant: 1 | 2,
): ProviderScenario {
  const sourceRef = `evidence:${scenarioId}:primary`;
  const context: NpcMaintenanceProposalContext = Object.freeze({
    sessionId: 'session-operational-maintenance-v2',
    sourceRevision: sourceRevision(scenarioId),
    allowedCharacterIds: Object.freeze([characterId]),
    allowedSourceRefs: Object.freeze([sourceRef]),
    expectedEntityVersions: Object.freeze({ [characterId]: variant === 1 ? 7 : 11 }),
    maxRound: 24,
  });
  const classification = kind === 'objective_fact'
    ? { status: 'confirmed', confidence: 'high' }
    : kind === 'belief'
      ? { status: 'pending', confidence: 'medium' }
      : { status: 'confirmed', confidence: 'high' };
  const evidence = Object.freeze({
    characterId,
    kind,
    field: variant === 1 ? 'observed_state' : 'recorded_state',
    value: kind === 'objective_fact'
      ? (variant === 1 ? 'carries-brass-key' : 'wounded')
      : kind === 'belief'
        ? (variant === 1 ? 'mayor-is-spy' : 'bridge-is-trapped')
        : (variant === 1 ? 'gate-opened-at-midnight' : 'evacuation-at-dawn'),
    ...classification,
    effectiveRound: variant === 1 ? 17 : 19,
    sourceRefs: [sourceRef],
  });
  const expectedArgs = Object.freeze({
    version: 'npc-maintenance-proposal-v1',
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    entries: Object.freeze([Object.freeze({
      kind: evidence.kind,
      characterId: evidence.characterId,
      field: evidence.field,
      value: evidence.value,
      status: evidence.status,
      confidence: evidence.confidence,
      effectiveRound: evidence.effectiveRound,
      expectedEntityVersion: context.expectedEntityVersions[characterId],
      sourceRefs: evidence.sourceRefs,
    })]),
  });
  const system = [
    `[CASE:${scenarioId}]`,
    'Use the supplied fixed proposalContext and evidence only.',
    'Call propose_npc_state exactly once using npc-maintenance-proposal-v1.',
    'Prefer the native function call; if native tool calls are unavailable, return exactly {"tool":{"name":"propose_npc_state","args":<proposal object>}} with no extra keys or prose.',
    'The sole entries array item must be a native JSON object, never a quoted or escaped JSON-encoded string.',
    `Pass this exact object as the tool arguments: ${JSON.stringify(expectedArgs)}.`,
    'Return one typed entry; do not write state and do not answer with prose.',
  ].join(' ');
  const user = JSON.stringify({ scenarioId, taskKind: 'npc_state', proposalContext: context, evidence });
  return Object.freeze({
    scenarioId,
    taskKind: 'npc_state',
    proposalContext: context,
    expectedArgs,
    system,
    user,
    validateSemantic(payload: Record<string, unknown>) {
      const entries = payload.entries;
      if (!Array.isArray(entries) || entries.length !== 1) return false;
      const entry = entries[0] as Record<string, unknown>;
      return entry.kind === kind && entry.characterId === characterId
        && entry.field === evidence.field && entry.value === evidence.value;
    },
  });
}

function arcCase(
  scenarioId: Extract<ProviderCaseId, `q9-${string}-multi-arc-${string}`>,
  variant: 1 | 2,
): ProviderScenario {
  const arcIds = Object.freeze([arcId(scenarioId, 1), arcId(scenarioId, 2)]);
  const sourceRefs = Object.freeze([
    `evidence:${scenarioId}:alpha`,
    `evidence:${scenarioId}:beta`,
  ]);
  const context: ArcProposalContext = Object.freeze({
    sessionId: 'session-operational-maintenance-v2',
    sourceRevision: sourceRevision(scenarioId),
    allowedArcIds: arcIds,
    allowedSourceRefs: sourceRefs,
    maxRound: 24,
  });
  const expectedArgs = Object.freeze({
    version: 'arc-maintenance-proposal-v1',
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    actions: Object.freeze([Object.freeze({
      kind: 'mark_source_conflict',
      arcIds,
      sourceRefs,
    })]),
  });
  const system = [
    `[CASE:${scenarioId}]`,
    'Use the supplied fixed proposalContext and equally authoritative conflicting sources only.',
    'Call propose_branch_index exactly once using arc-maintenance-proposal-v1.',
    'Prefer the native function call; if native tool calls are unavailable, return exactly {"tool":{"name":"propose_branch_index","args":<proposal object>}} with no extra keys or prose.',
    `Pass this exact object as the tool arguments: ${JSON.stringify(expectedArgs)}.`,
    'Mark the source conflict; do not choose a winner, write state, or answer with prose.',
  ].join(' ');
  const user = JSON.stringify({
    scenarioId,
    taskKind: 'branch_index',
    proposalContext: context,
    evidence: { conflictVariant: variant, arcIds, sourceRefs },
  });
  return Object.freeze({
    scenarioId,
    taskKind: 'branch_index',
    proposalContext: context,
    expectedArgs,
    system,
    user,
    validateSemantic(payload: Record<string, unknown>) {
      const actions = payload.actions;
      if (!Array.isArray(actions) || actions.length !== 1) return false;
      const action = actions[0] as Record<string, unknown>;
      const actualArcIds = Array.isArray(action.arcIds) ? [...action.arcIds].sort() : [];
      const actualSourceRefs = Array.isArray(action.sourceRefs) ? [...action.sourceRefs].sort() : [];
      return action.kind === 'mark_source_conflict'
        && JSON.stringify(actualArcIds) === JSON.stringify([...arcIds].sort())
        && JSON.stringify(actualSourceRefs) === JSON.stringify([...sourceRefs].sort());
    },
  });
}

const PROVIDER_CASES: Readonly<Record<ProviderCaseId, ProviderScenario>> = Object.freeze({
  'q9-09-npc-objective-v1': npcCase('q9-09-npc-objective-v1', 'npc-aria', 'objective_fact', 1),
  'q9-10-npc-objective-v2': npcCase('q9-10-npc-objective-v2', 'npc-borin', 'objective_fact', 2),
  'q9-11-npc-belief-v1': npcCase('q9-11-npc-belief-v1', 'npc-aria', 'belief', 1),
  'q9-12-npc-belief-v2': npcCase('q9-12-npc-belief-v2', 'npc-borin', 'belief', 2),
  'q9-13-npc-knowledge-v1': npcCase('q9-13-npc-knowledge-v1', 'npc-aria', 'knowledge', 1),
  'q9-14-npc-knowledge-v2': npcCase('q9-14-npc-knowledge-v2', 'npc-borin', 'knowledge', 2),
  'q9-07-multi-arc-conflict-v1': arcCase('q9-07-multi-arc-conflict-v1', 1),
  'q9-08-multi-arc-conflict-v2': arcCase('q9-08-multi-arc-conflict-v2', 2),
});

function scenarioProviderTools(scenario: ProviderScenario): readonly Record<string, unknown>[] {
  return maintenanceProviderTools(scenario.taskKind, scenario.proposalContext);
}

export interface MaintenanceOperationalReplayProvenance {
  readonly sourceManifest: readonly MaintenanceOperationalReplaySourceManifestEntry[];
  readonly toolSetManifest: readonly MaintenanceOperationalReplayToolSetManifestEntry[];
  readonly sourceArtifactDigest: string;
  readonly toolSetDigest: string;
}

/** Recomputed by the evidence importer; contains digests and ids only, never prompts or evidence prose. */
export function maintenanceOperationalReplayProvenance(): MaintenanceOperationalReplayProvenance {
  const sourceManifest = Object.freeze(P14_MAINTENANCE_OPERATIONAL_CASE_IDS.map((scenarioId) => {
    const scenario = PROVIDER_CASES[scenarioId];
    return Object.freeze({
      scenarioId,
      sourceDigest: maintenanceOperationalReplayDigest({ system: scenario.system, user: scenario.user }),
    });
  }));
  const toolSetManifest = Object.freeze(P14_MAINTENANCE_OPERATIONAL_CASE_IDS.map((scenarioId) => {
    const scenario = PROVIDER_CASES[scenarioId];
    return Object.freeze({
      scenarioId,
      taskKind: scenario.taskKind,
      proposalContextDigest: maintenanceOperationalReplayDigest(scenario.proposalContext),
      toolSetDigest: maintenanceOperationalReplayDigest(scenarioProviderTools(scenario)),
    });
  }));
  return Object.freeze({
    sourceManifest,
    toolSetManifest,
    sourceArtifactDigest: maintenanceOperationalReplayDigest(sourceManifest),
    toolSetDigest: maintenanceOperationalReplayDigest(toolSetManifest),
  });
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

export type MaintenanceOperationalProviderDiagnosticCode =
  | 'provider-not-configured'
  | 'provider-authentication-failed'
  | 'provider-request-invalid'
  | 'provider-rate-limited'
  | 'provider-timeout'
  | 'provider-upstream-unavailable'
  | 'provider-transport-failed'
  | 'provider-stream-failed'
  | 'provider-stream-incomplete'
  | 'provider-disposed'
  | 'provider-failed';

const PROVIDER_DIAGNOSTIC_CODES = new Set<MaintenanceOperationalProviderDiagnosticCode>([
  'provider-not-configured',
  'provider-authentication-failed',
  'provider-request-invalid',
  'provider-rate-limited',
  'provider-timeout',
  'provider-upstream-unavailable',
  'provider-transport-failed',
  'provider-stream-failed',
  'provider-stream-incomplete',
  'provider-disposed',
  'provider-failed',
]);

function isProviderDiagnosticCode(value: unknown): value is MaintenanceOperationalProviderDiagnosticCode {
  return typeof value === 'string'
    && PROVIDER_DIAGNOSTIC_CODES.has(value as MaintenanceOperationalProviderDiagnosticCode);
}

export interface MaintenanceOperationalProviderDiagnostic {
  readonly scenarioId: ProviderCaseId;
  readonly providerDiagnosticCode: MaintenanceOperationalProviderDiagnosticCode;
  readonly providerHttpStatus?: number;
}

export interface OperationalMaintenanceReplayArtifacts {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly terminationReason: 'completed' | 'budget-cost-exhausted' | 'provider-rate-limited';
  readonly providerDiagnostics: readonly MaintenanceOperationalProviderDiagnostic[];
  readonly accounting: Readonly<{
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    providerErrors: number;
    invalidCalls: number;
  }>;
}

/**
 * Content-free failure classes for the operational contract canary. Never add
 * Provider arguments, response text, character ids, or source refs here: this
 * error is intentionally safe to print from the CLI and retain in CI logs.
 */
export type MaintenanceOperationalContractFailureReason =
  | 'tool-missing'
  | 'tool-count-invalid'
  | 'tool-name-invalid'
  | 'arguments-json-invalid'
  | 'text-envelope-invalid'
  | 'proposal-schema-invalid'
  | 'semantic-mismatch'
  | 'usage-unavailable'
  | 'response-invalid'
  | NpcMaintenanceProposalRejectionCode;

export type MaintenanceOperationalJsonType =
  | 'array'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | 'undefined'
  | 'unsupported';

export interface MaintenanceOperationalFieldFingerprint {
  readonly key: string;
  readonly type: MaintenanceOperationalJsonType;
}

export interface MaintenanceOperationalStructureFingerprint {
  readonly version: 'p14-maintenance-structure-fingerprint-v1';
  readonly transport: 'native-tool' | 'text-envelope';
  readonly rootType: MaintenanceOperationalJsonType;
  readonly expectedRootFields: readonly MaintenanceOperationalFieldFingerprint[];
  readonly actualRootFields: readonly MaintenanceOperationalFieldFingerprint[];
  readonly actualRootFieldCount: number;
  readonly rootFieldsTruncated: boolean;
  readonly collectionKey: 'entries' | 'actions';
  readonly collectionType: MaintenanceOperationalJsonType;
  readonly collectionItemCount: number | null;
  readonly firstItemType: MaintenanceOperationalJsonType;
  readonly expectedFirstItemFields: readonly MaintenanceOperationalFieldFingerprint[];
  readonly actualFirstItemFields: readonly MaintenanceOperationalFieldFingerprint[];
  readonly actualFirstItemFieldCount: number;
  readonly firstItemFieldsTruncated: boolean;
}

const MAX_DIAGNOSTIC_FIELDS = 32;
const DIAGNOSTIC_PROTOCOL_KEYS = new Set([
  'actions', 'alias', 'arcId', 'arcIds', 'args', 'boundaryRound', 'chapterId',
  'characterId', 'characters', 'confidence', 'conflictArcIds', 'dependencyArcIds',
  'effectiveRound', 'entries', 'expectedEntityVersion', 'field', 'fromArcId',
  'intoArcId', 'kind', 'mentionDigest', 'mentionKey', 'name', 'patch', 'perspective',
  'reasonCode', 'relationType', 'sessionId', 'sourceRefs', 'sourceRevision', 'state',
  'status', 'tool', 'toCharacterId', 'value', 'version',
]);

function maintenanceOperationalJsonType(value: unknown): MaintenanceOperationalJsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'object': return 'object';
    case 'string': return 'string';
    case 'undefined': return 'undefined';
    default: return 'unsupported';
  }
}

function safeDiagnosticKey(key: string): string {
  return DIAGNOSTIC_PROTOCOL_KEYS.has(key)
    ? key
    : `other:sha256:${hexDigest(key).slice(0, 16)}`;
}

function diagnosticFields(value: unknown): Readonly<{
  fields: readonly MaintenanceOperationalFieldFingerprint[];
  count: number;
  truncated: boolean;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ fields: Object.freeze([]), count: 0, truncated: false });
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const fields = keys.slice(0, MAX_DIAGNOSTIC_FIELDS).map((key) => Object.freeze({
    key: safeDiagnosticKey(key),
    type: maintenanceOperationalJsonType(row[key]),
  }));
  return Object.freeze({
    fields: Object.freeze(fields),
    count: keys.length,
    truncated: keys.length > MAX_DIAGNOSTIC_FIELDS,
  });
}

function firstCollectionItem(value: unknown, collectionKey: 'entries' | 'actions'): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const collection = (value as Record<string, unknown>)[collectionKey];
  return Array.isArray(collection) ? collection[0] : undefined;
}

/**
 * Describes shape only. Values, response prose, ids and refs never survive;
 * unknown/untrusted field names are represented by a short digest.
 */
function maintenanceOperationalStructureFingerprint(
  taskKind: ProviderTaskKind,
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
  transport: MaintenanceOperationalStructureFingerprint['transport'],
): MaintenanceOperationalStructureFingerprint {
  const collectionKey = taskKind === 'npc_state' ? 'entries' : 'actions';
  const actualRoot = diagnosticFields(actual);
  const expectedRoot = diagnosticFields(expected);
  const actualCollection = actual && typeof actual === 'object' && !Array.isArray(actual)
    ? (actual as Record<string, unknown>)[collectionKey]
    : undefined;
  const actualFirstItem = firstCollectionItem(actual, collectionKey);
  const expectedFirstItem = firstCollectionItem(expected, collectionKey);
  const actualFirstItemFields = diagnosticFields(actualFirstItem);
  return Object.freeze({
    version: 'p14-maintenance-structure-fingerprint-v1',
    transport,
    rootType: maintenanceOperationalJsonType(actual),
    expectedRootFields: expectedRoot.fields,
    actualRootFields: actualRoot.fields,
    actualRootFieldCount: actualRoot.count,
    rootFieldsTruncated: actualRoot.truncated,
    collectionKey,
    collectionType: maintenanceOperationalJsonType(actualCollection),
    collectionItemCount: Array.isArray(actualCollection) ? actualCollection.length : null,
    firstItemType: maintenanceOperationalJsonType(actualFirstItem),
    expectedFirstItemFields: diagnosticFields(expectedFirstItem).fields,
    actualFirstItemFields: actualFirstItemFields.fields,
    actualFirstItemFieldCount: actualFirstItemFields.count,
    firstItemFieldsTruncated: actualFirstItemFields.truncated,
  });
}

export class OperationalMaintenanceContractError extends Error {
  readonly name = 'OperationalMaintenanceContractError';

  constructor(
    readonly scenarioId: ProviderCaseId,
    readonly taskKind: ProviderTaskKind,
    readonly reasonCode: MaintenanceOperationalContractFailureReason,
    readonly structureFingerprint?: MaintenanceOperationalStructureFingerprint,
  ) {
    super(`operational-maintenance-contract-invalid:${scenarioId}:${reasonCode}`);
  }
}

export const P14_MAINTENANCE_OPERATIONAL_FAILURE_VERSION =
  'p14-maintenance-operational-failure-v2' as const;

export type MaintenanceOperationalFailureStage = 'replay' | 'post-processing';

export interface MaintenanceOperationalFailureCaseSummary {
  readonly scenarioId: ProviderCaseId;
  readonly status: 'valid' | 'invalid' | 'provider-error' | 'budget-exhausted' | 'not-executed';
  readonly providerDiagnosticCode?: MaintenanceOperationalProviderDiagnosticCode;
  readonly providerHttpStatus?: number;
  readonly metrics: Readonly<{
    modelCalls: number;
    toolCalls: number;
    writes: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    safetyViolations: number;
    invalidCalls: number;
  }>;
}

export interface MaintenanceOperationalFailureContext {
  readonly stage: MaintenanceOperationalFailureStage;
  readonly expectedSessionId: string;
  readonly artifacts?: Pick<
    OperationalMaintenanceReplayArtifacts,
    'suite' | 'run' | 'accounting' | 'terminationReason' | 'providerDiagnostics'
  >;
}

export interface MaintenanceOperationalFailureArtifact {
  readonly version: typeof P14_MAINTENANCE_OPERATIONAL_FAILURE_VERSION;
  readonly lane: 'maintenance';
  readonly status: 'failed';
  readonly artifactClass: 'failure-diagnostic';
  readonly importable: false;
  readonly failureCode: 'contract-invalid' | 'operational-replay-failed';
  readonly failureStage: MaintenanceOperationalFailureStage;
  readonly sessionId: string;
  readonly scenarioId?: ProviderCaseId;
  readonly taskKind?: ProviderTaskKind;
  readonly reasonCode?: MaintenanceOperationalContractFailureReason;
  readonly structureFingerprint?: MaintenanceOperationalStructureFingerprint;
  readonly terminationReason: OperationalMaintenanceReplayArtifacts['terminationReason'] | null;
  readonly replayAccounting: OperationalMaintenanceReplayArtifacts['accounting'] | null;
  readonly caseSummaries: readonly MaintenanceOperationalFailureCaseSummary[];
  readonly bridgeAccountingStatus: 'available' | 'unavailable';
  readonly bridgeAccounting: MaintenanceOperationalReplayBridgeAccounting | null;
}

function failureCaseSummaries(
  artifacts: MaintenanceOperationalFailureContext['artifacts'],
): readonly MaintenanceOperationalFailureCaseSummary[] {
  if (!artifacts) return Object.freeze([]);
  const scenarioById = new Map(
    artifacts.suite.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const resultById = new Map(
    artifacts.run.results.map((result) => [result.scenarioId, result]),
  );
  const providerDiagnosticById = new Map<ProviderCaseId, MaintenanceOperationalProviderDiagnostic>();
  for (const diagnostic of artifacts.providerDiagnostics) {
    if (P14_MAINTENANCE_OPERATIONAL_CASE_IDS.includes(diagnostic.scenarioId)
      && isProviderDiagnosticCode(diagnostic.providerDiagnosticCode)) {
      const providerHttpStatus = diagnostic.providerDiagnosticCode === 'provider-request-invalid'
        ? safeProviderHttpStatus(diagnostic.providerHttpStatus)
        : undefined;
      providerDiagnosticById.set(diagnostic.scenarioId, Object.freeze({
        scenarioId: diagnostic.scenarioId,
        providerDiagnosticCode: diagnostic.providerDiagnosticCode,
        ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
      }));
    }
  }
  return Object.freeze(P14_MAINTENANCE_OPERATIONAL_CASE_IDS.map((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    const result = resultById.get(scenarioId);
    const metrics = result?.metrics;
    const summaryMetrics = Object.freeze({
      modelCalls: metrics?.modelCalls ?? 0,
      toolCalls: metrics?.toolCalls ?? 0,
      writes: metrics?.writes ?? 0,
      inputTokens: metrics?.inputTokens ?? 0,
      outputTokens: metrics?.outputTokens ?? 0,
      costMicrousd: metrics?.costMicrousd ?? 0,
      safetyViolations: metrics?.safetyViolations ?? 0,
      invalidCalls: metrics?.invalidCalls ?? 0,
    });
    const valid = Boolean(scenario && result
      && metrics?.modelCalls === 1 && metrics.toolCalls === 1
      && metrics.writes === 0 && metrics.invalidCalls === 0
      && metrics.safetyViolations === 0
      && JSON.stringify(result.typedOutcome) === JSON.stringify(scenario.typedOutcome)
      && scenario.expectedReasonCodes.every((reason) => result.reasonCodes.includes(reason)));
    const status = valid ? 'valid' as const
      : summaryMetrics.modelCalls === 0 ? 'not-executed' as const
        : result?.reasonCodes.includes('budget-cost-exhausted')
          ? 'budget-exhausted' as const
          : result?.reasonCodes.includes('provider-error')
            ? 'provider-error' as const : 'invalid' as const;
    const providerDiagnostic = status === 'provider-error'
      ? providerDiagnosticById.get(scenarioId)
      : undefined;
    return Object.freeze({
      scenarioId,
      status,
      ...(providerDiagnostic ? {
        providerDiagnosticCode: providerDiagnostic.providerDiagnosticCode,
        ...(providerDiagnostic.providerHttpStatus === undefined
          ? {}
          : { providerHttpStatus: providerDiagnostic.providerHttpStatus }),
      } : {}),
      metrics: summaryMetrics,
    });
  }));
}

/** Safe failure-only artifact. It deliberately cannot satisfy the evidence importer. */
export function buildMaintenanceOperationalFailureArtifact(
  error: unknown,
  bridgeAccounting: MaintenanceOperationalReplayBridgeAccounting | undefined,
  context: MaintenanceOperationalFailureContext,
): MaintenanceOperationalFailureArtifact {
  if (!/^session-[0-9]{6,24}$/u.test(context.expectedSessionId)) {
    throw new Error('maintenance-operational-failure-session-id-invalid');
  }
  const contractError = error instanceof OperationalMaintenanceContractError ? error : undefined;
  let verifiedBridgeAccounting: MaintenanceOperationalReplayBridgeAccounting | null = null;
  if (bridgeAccounting) {
    try {
      verifiedBridgeAccounting = sessionBoundBridgeAccounting(
        bridgeAccounting,
        'maintenance-operational-failure-bridge-accounting',
        context.expectedSessionId,
      );
    } catch { /* an invalid diagnostic input is represented as unavailable */ }
  }
  const replayAccounting = context.artifacts ? Object.freeze({
    providerCalls: context.artifacts.accounting.providerCalls,
    inputTokens: context.artifacts.accounting.inputTokens,
    outputTokens: context.artifacts.accounting.outputTokens,
    costMicrousd: context.artifacts.accounting.costMicrousd,
    providerErrors: context.artifacts.accounting.providerErrors,
    invalidCalls: context.artifacts.accounting.invalidCalls,
  }) : null;
  return Object.freeze({
    version: P14_MAINTENANCE_OPERATIONAL_FAILURE_VERSION,
    lane: 'maintenance',
    status: 'failed',
    artifactClass: 'failure-diagnostic',
    importable: false,
    failureCode: contractError ? 'contract-invalid' : 'operational-replay-failed',
    failureStage: context.stage,
    sessionId: context.expectedSessionId,
    ...(contractError ? {
      scenarioId: contractError.scenarioId,
      taskKind: contractError.taskKind,
      reasonCode: contractError.reasonCode,
      ...(contractError.structureFingerprint
        ? { structureFingerprint: contractError.structureFingerprint }
        : {}),
    } : {}),
    terminationReason: context.artifacts?.terminationReason ?? null,
    replayAccounting,
    caseSummaries: failureCaseSummaries(context.artifacts),
    bridgeAccountingStatus: verifiedBridgeAccounting ? 'available' : 'unavailable',
    bridgeAccounting: verifiedBridgeAccounting,
  });
}

type TextToolEnvelopeResult =
  | Readonly<{ ok: true; args: Record<string, unknown> }>
  | Readonly<{ ok: false; reasonCode: MaintenanceOperationalContractFailureReason }>;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

/** Strict replay-only mirror of the Harness text decision transport. */
function parseTextToolEnvelope(
  content: string | null,
  expectedToolName: string,
): TextToolEnvelopeResult {
  if (typeof content !== 'string' || content.length === 0) {
    return Object.freeze({ ok: false, reasonCode: 'tool-missing' });
  }
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return Object.freeze({ ok: false, reasonCode: 'arguments-json-invalid' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ ok: false, reasonCode: 'text-envelope-invalid' });
  }
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ['tool'])
    || !envelope.tool || typeof envelope.tool !== 'object' || Array.isArray(envelope.tool)) {
    return Object.freeze({ ok: false, reasonCode: 'text-envelope-invalid' });
  }
  const tool = envelope.tool as Record<string, unknown>;
  if (!exactKeys(tool, ['name', 'args']) || typeof tool.name !== 'string') {
    return Object.freeze({ ok: false, reasonCode: 'text-envelope-invalid' });
  }
  if (tool.name !== expectedToolName) {
    return Object.freeze({ ok: false, reasonCode: 'tool-name-invalid' });
  }
  if (!tool.args || typeof tool.args !== 'object' || Array.isArray(tool.args)) {
    return Object.freeze({ ok: false, reasonCode: 'text-envelope-invalid' });
  }
  return Object.freeze({ ok: true, args: tool.args as Record<string, unknown> });
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

function operationalSuite(
  fixtureInput: P14ReplayEvidence,
  input: Pick<OperationalMaintenanceReplayOptions,
    'providerId' | 'modelId' | 'maxOutputTokens' | 'inputMicrousdPerMillionTokens'
    | 'outputMicrousdPerMillionTokens' | 'maxCostMicrousd'>,
  now: Date,
): P14ReplayEvidence {
  const fixture = parseP14ReplayEvidence(fixtureInput);
  const provenance = maintenanceOperationalReplayProvenance();
  const sourceById = new Map(provenance.sourceManifest.map((entry) => [entry.scenarioId, entry.sourceDigest]));
  if (P14_MAINTENANCE_OPERATIONAL_CASE_IDS.some((scenarioId) => (
    !fixture.scenarios.some((scenario) => scenario.scenarioId === scenarioId)
  ))) throw new Error('operational-maintenance-suite-cases-missing');
  const budget = {
    version: P14_OPERATIONAL_BUDGET_VERSION,
    maxProviderCalls: P14_MAINTENANCE_OPERATIONAL_CASE_IDS.length,
    maxOutputTokens: input.maxOutputTokens,
    inputMicrousdPerMillionTokens: input.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: input.outputMicrousdPerMillionTokens,
    maxCostMicrousd: input.maxCostMicrousd,
  };
  return parseP14ReplayEvidence({
    ...fixture,
    suiteId: P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID,
    evidenceClass: 'operational',
    sourceArtifactDigest: provenance.sourceArtifactDigest,
    capturedAt: now.toISOString(),
    provider: {
      providerIdDigest: maintenanceOperationalReplayDigest(input.providerId),
      modelId: input.modelId,
      temperatureMilli: 0,
      maxOutputTokens: input.maxOutputTokens,
      budgetProfileDigest: maintenanceOperationalReplayDigest(budget),
      toolSetDigest: provenance.toolSetDigest,
    },
    scenarios: fixture.scenarios.map((scenario, index) => ({
      ...scenario,
      sourceDigest: sourceById.get(scenario.scenarioId)
        ?? maintenanceOperationalReplayDigest({
          version: 'p14-maintenance-operational-source-v2',
          scenarioId: scenario.scenarioId,
        }),
      sourceRevision: `operational:p14:maintenance:v2:${String(index + 1).padStart(2, '0')}`,
    })),
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

function deterministicResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: scenario.expectedReasonCodes,
    typedOutcome: scenario.typedOutcome,
    metrics: zeroMetrics(),
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

function providerRateLimitedResult(scenario: P14ReplayScenario): P14ReplayResult {
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    reasonCodes: Object.freeze(['provider-rate-limited']),
    typedOutcome: Object.freeze({ ...scenario.typedOutcome, verdict: 'failed' }),
    metrics: zeroMetrics(),
  });
}

const REPLAY_TRANSPORT_PROVIDER_DIAGNOSTICS = new Map<
  string,
  MaintenanceOperationalProviderDiagnosticCode
>([
  ['OP_REPLAY_RATE_LIMIT', 'provider-rate-limited'],
  ['OP_REPLAY_TIMEOUT', 'provider-timeout'],
  ['OP_REPLAY_UPSTREAM_5XX', 'provider-upstream-unavailable'],
  ['OP_REPLAY_UPSTREAM_4XX', 'provider-request-invalid'],
  ['OP_REPLAY_AUTHENTICATION', 'provider-authentication-failed'],
  ['OP_REPLAY_REQUEST_INVALID', 'provider-request-invalid'],
  ['OP_REPLAY_TRANSPORT', 'provider-transport-failed'],
]);

function providerDiagnosticCode(
  error: unknown,
): MaintenanceOperationalProviderDiagnosticCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  let code: unknown, diagnosticCode: unknown;
  try {
    const row = error as { code?: unknown; diagnosticCode?: unknown };
    code = row.code;
    diagnosticCode = row.diagnosticCode;
  } catch { return undefined; }
  if (isProviderDiagnosticCode(diagnosticCode)) return diagnosticCode;
  if (typeof code === 'string') {
    const mapped = REPLAY_TRANSPORT_PROVIDER_DIAGNOSTICS.get(code);
    if (mapped) return mapped;
  }
  return undefined;
}

function safeProviderHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 400 && value <= 499
    ? value : undefined;
}

function providerHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try { return safeProviderHttpStatus((error as { upstreamStatus?: unknown }).upstreamStatus); }
  catch { return undefined; }
}

function providerFailure(error: unknown): boolean {
  if (providerDiagnosticCode(error)) return true;
  if (!error || typeof error !== 'object') return false;
  let message: unknown;
  try { message = (error as { message?: unknown }).message; }
  catch { return false; }
  return typeof message === 'string'
    && /HTTP|fetch|timeout|aborted|provider|transport/iu.test(message)
    && !/proposal|schema|tool|JSON/iu.test(message);
}

function replayBudgetFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try { return (error as { code?: unknown }).code === 'OP_REPLAY_BUDGET'; }
  catch { return false; }
}

export async function runOperationalMaintenanceReplay(
  options: OperationalMaintenanceReplayOptions,
): Promise<OperationalMaintenanceReplayArtifacts> {
  if (!/^session-[0-9]{6,24}$/u.test(options.sessionId)) throw new Error('session-id-invalid');
  const maxOutputTokens = safePositive(options.maxOutputTokens, 'max-output-tokens');
  const inputRate = safePositive(options.inputMicrousdPerMillionTokens, 'input-rate');
  const outputRate = safePositive(options.outputMicrousdPerMillionTokens, 'output-rate');
  const maxCost = safePositive(
    options.maxCostMicrousd,
    'max-cost',
    P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
  );
  const suite = operationalSuite(options.fixture, options, (options.now ?? (() => new Date()))());
  const scenarioById = new Map(suite.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const providerResults = new Map<string, P14ReplayResult>();
  const providerDiagnostics = new Map<ProviderCaseId, MaintenanceOperationalProviderDiagnostic>();
  let providerCalls = 0, inputTokens = 0, outputTokens = 0, costMicrousd = 0;
  let providerErrors = 0, invalidCalls = 0;
  let terminationReason: OperationalMaintenanceReplayArtifacts['terminationReason'] = 'completed';

  // Physical execution order is explicit and independent of fixture order. The dynamic NPC
  // contract canary is always the first possible Provider call.
  for (const scenarioId of P14_MAINTENANCE_OPERATIONAL_CASE_IDS) {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) throw new Error('operational-maintenance-suite-cases-missing');
    const providerCase = PROVIDER_CASES[scenarioId];
    if (terminationReason === 'completed' && costMicrousd >= maxCost) {
      terminationReason = 'budget-cost-exhausted';
    }
    if (terminationReason !== 'completed') {
      providerResults.set(scenarioId, terminationReason === 'budget-cost-exhausted'
        ? costBudgetExhaustedResult(scenario)
        : providerRateLimitedResult(scenario));
      continue;
    }
    if (providerCalls >= P14_MAINTENANCE_OPERATIONAL_CASE_IDS.length) {
      throw new Error('operational-replay-call-budget-exhausted');
    }
    const startedAt = Date.now();
    providerCalls += 1;
    let toolCalls = 0, caseInputTokens = 0, caseOutputTokens = 0, caseCost = 0;
    let valid = false, isProviderError = false, costBudgetExhausted = false;
    let contractFailureReason: MaintenanceOperationalContractFailureReason | undefined;
    let structureFingerprint: MaintenanceOperationalStructureFingerprint | undefined;
    try {
      const response = await options.client.complete({
        model: options.modelId,
        messages: [
          { role: 'system', content: providerCase.system },
          { role: 'user', content: providerCase.user },
        ],
        tools: [...scenarioProviderTools(providerCase)],
        // Match production Maintenance exactly. CommandCode/Gemini has returned a
        // usage-only empty completion for both named and `required` choices, while
        // production uses `auto` and accepts either a native call or the strict
        // Harness text envelope. The exact-name, dynamic-context and semantic checks
        // below still reject read tools, prose and every non-proposal response.
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: maxOutputTokens,
        stream: false,
      }, AbortSignal.timeout(60_000), {
        runId: `p14-q9-maintenance-v2:${scenario.scenarioId}`,
        sessionId: options.sessionId,
        lane: 'maintenance',
      });
      toolCalls = response.toolCalls.length;
      if (!response.usage) {
        contractFailureReason = 'usage-unavailable';
      } else {
        caseInputTokens = response.usage.prompt_tokens;
        caseOutputTokens = response.usage.completion_tokens;
        caseCost = estimatedCost(caseInputTokens, caseOutputTokens, inputRate, outputRate);
        inputTokens += caseInputTokens;
        outputTokens += caseOutputTokens;
        costMicrousd += caseCost;
        if (costMicrousd > maxCost) {
          costBudgetExhausted = true;
          terminationReason = 'budget-cost-exhausted';
        } else {
          const expectedToolName = `propose_${providerCase.taskKind}`;
          const call = response.toolCalls.length === 1 ? response.toolCalls[0] : undefined;
          let args: unknown;
          let argumentTransport: MaintenanceOperationalStructureFingerprint['transport'] | undefined;
          if (response.toolCalls.length > 1) {
            contractFailureReason = 'tool-count-invalid';
          } else if (call && call.name !== expectedToolName) {
            contractFailureReason = 'tool-name-invalid';
          } else if (call) {
            try {
              args = JSON.parse(call.arguments) as unknown;
              argumentTransport = 'native-tool';
            } catch {
              contractFailureReason = 'arguments-json-invalid';
            }
          } else {
            const envelope = parseTextToolEnvelope(response.content, expectedToolName);
            if (envelope.ok) {
              // Harness consumes one tool budget unit after a valid text decision,
              // before schema validation. Mirror that accounting exactly here.
              toolCalls = 1;
              args = envelope.args;
              argumentTransport = 'text-envelope';
            } else {
              contractFailureReason = envelope.reasonCode;
            }
          }
          if (!contractFailureReason) {
            try {
              const validated = validateMaintenanceProposal(
                providerCase.taskKind,
                args,
                providerCase.proposalContext,
              );
              valid = providerCase.validateSemantic(validated.payload);
              if (!valid) {
                contractFailureReason = 'semantic-mismatch';
                if (argumentTransport) {
                  structureFingerprint = maintenanceOperationalStructureFingerprint(
                    providerCase.taskKind, args, providerCase.expectedArgs, argumentTransport,
                  );
                }
              }
            } catch (error) {
              contractFailureReason = providerCase.taskKind === 'npc_state'
                ? npcMaintenanceProposalRejectionCode(error) ?? 'proposal-schema-invalid'
                : 'proposal-schema-invalid';
              if (argumentTransport) {
                structureFingerprint = maintenanceOperationalStructureFingerprint(
                  providerCase.taskKind, args, providerCase.expectedArgs, argumentTransport,
                );
              }
            }
          }
        }
      }
    } catch (error) {
      if (replayBudgetFailure(error)) {
        costBudgetExhausted = true;
        terminationReason = 'budget-cost-exhausted';
      } else {
        isProviderError = providerFailure(error);
        if (isProviderError) {
          providerErrors += 1;
          const diagnosticCode = providerDiagnosticCode(error);
          if (diagnosticCode) {
            const httpStatus = diagnosticCode === 'provider-request-invalid'
              ? providerHttpStatus(error)
              : undefined;
            providerDiagnostics.set(scenarioId, Object.freeze({
              scenarioId,
              providerDiagnosticCode: diagnosticCode,
              ...(httpStatus === undefined ? {} : { providerHttpStatus: httpStatus }),
            }));
            if (diagnosticCode === 'provider-rate-limited') {
              terminationReason = 'provider-rate-limited';
            }
          }
        }
        else contractFailureReason = 'response-invalid';
      }
    }
    if (!valid && !costBudgetExhausted) invalidCalls += 1;
    const result = Object.freeze({
      scenarioId: scenario.scenarioId,
      reasonCodes: Object.freeze(valid ? [...scenario.expectedReasonCodes]
        : [costBudgetExhausted ? 'budget-cost-exhausted'
          : isProviderError ? 'provider-error' : 'provider-output-invalid']),
      typedOutcome: Object.freeze(valid ? { ...scenario.typedOutcome }
        : { ...scenario.typedOutcome, verdict: costBudgetExhausted ? 'failed' as const : 'invalid' as const }),
      metrics: Object.freeze({
        modelCalls: 1,
        toolCalls,
        writes: 0,
        inputTokens: caseInputTokens,
        outputTokens: caseOutputTokens,
        latencyMs: Date.now() - startedAt,
        costMicrousd: caseCost,
        safetyViolations: 0,
        invalidCalls: valid || costBudgetExhausted ? 0 : 1,
      }),
    });
    providerResults.set(scenarioId, result);
    // A schema/semantic-invalid contract response is never sampled again. In particular,
    // an invalid dynamic-NPC canary stops after the first physical call.
    if (contractFailureReason && !costBudgetExhausted) {
      throw new OperationalMaintenanceContractError(
        scenarioId,
        providerCase.taskKind,
        contractFailureReason,
        structureFingerprint,
      );
    }
  }

  const results = suite.scenarios.map((scenario): P14ReplayResult => {
    const providerResult = providerResults.get(scenario.scenarioId);
    if (providerResult) return providerResult;
    if (!TARGET_LANES.has(scenario.typedOutcome.lane)) return skippedResult(scenario);
    return deterministicResult(scenario);
  });
  const run = parseP14ReplayRun(suite, {
    version: P14_REPLAY_RUN_VERSION,
    suiteDigest: p14ReplaySuiteDigest(suite),
    provider: suite.provider,
    results,
  });
  return Object.freeze({
    suite,
    run,
    terminationReason,
    providerDiagnostics: Object.freeze(P14_MAINTENANCE_OPERATIONAL_CASE_IDS.flatMap((scenarioId) => {
      const providerDiagnostic = providerDiagnostics.get(scenarioId);
      return providerDiagnostic
        ? [providerDiagnostic]
        : [];
    })),
    accounting: Object.freeze({
      providerCalls, inputTokens, outputTokens, costMicrousd, providerErrors, invalidCalls,
    }),
  });
}

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}-invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}-invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}-fields-invalid`);
  }
}

function sessionBoundBridgeAccounting(
  value: unknown,
  label: string,
  expectedSessionId?: string,
): MaintenanceOperationalReplayBridgeAccounting {
  plain(value, label);
  exact(value, [
    'sessionId', 'providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd',
  ], label);
  if (typeof value.sessionId !== 'string'
    || !/^session-[0-9]{6,24}$/u.test(value.sessionId)) {
    throw new Error(`${label}-session-id-invalid`);
  }
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) {
    throw new Error('maintenance-operational-accounting-session-mismatch');
  }
  for (const key of ['providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw new Error(`${label}-${key}-invalid`);
    }
  }
  return Object.freeze({
    sessionId: value.sessionId,
    providerCalls: Number(value.providerCalls),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    costMicrousd: Number(value.costMicrousd),
  });
}

function expectedReplayAccounting(suite: P14ReplayEvidence, run: P14ReplayRun) {
  const scenarioById = new Map(suite.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const resultById = new Map(run.results.map((result) => [result.scenarioId, result]));
  let inputTokens = 0, outputTokens = 0, costMicrousd = 0;
  for (const scenarioId of P14_MAINTENANCE_OPERATIONAL_CASE_IDS) {
    const scenario = scenarioById.get(scenarioId);
    const result = resultById.get(scenarioId);
    if (!scenario || !result
      || result.metrics.modelCalls !== 1 || result.metrics.toolCalls !== 1
      || result.metrics.writes !== 0 || result.metrics.invalidCalls !== 0
      || result.metrics.safetyViolations !== 0
      || JSON.stringify(result.typedOutcome) !== JSON.stringify(scenario.typedOutcome)
      || !scenario.expectedReasonCodes.every((reason) => result.reasonCodes.includes(reason))) {
      throw new Error('maintenance-operational-full-replay-required');
    }
    inputTokens += result.metrics.inputTokens;
    outputTokens += result.metrics.outputTokens;
    costMicrousd += result.metrics.costMicrousd;
  }
  return Object.freeze({
    providerCalls: P14_MAINTENANCE_OPERATIONAL_CASE_IDS.length,
    inputTokens,
    outputTokens,
    costMicrousd,
    providerErrors: 0,
    invalidCalls: 0,
  });
}

/** Builds the only accepted v3, session-bound accounting artifact. It is digest-only and prose-incapable. */
export function buildMaintenanceOperationalReplayAccountingEvidence(
  artifacts: Pick<OperationalMaintenanceReplayArtifacts, 'suite' | 'run' | 'accounting' | 'terminationReason'>,
  rawBridgeAccounting: MaintenanceOperationalReplayBridgeAccounting,
): MaintenanceOperationalReplayAccountingEvidence {
  const suite = parseP14ReplayEvidence(artifacts.suite);
  const run = parseP14ReplayRun(suite, artifacts.run);
  if (suite.suiteId !== P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID
    || artifacts.terminationReason !== 'completed') {
    throw new Error('maintenance-operational-full-replay-required');
  }
  const provenance = maintenanceOperationalReplayProvenance();
  if (suite.sourceArtifactDigest !== provenance.sourceArtifactDigest
    || suite.provider.toolSetDigest !== provenance.toolSetDigest) {
    throw new Error('maintenance-operational-provenance-invalid');
  }
  const suiteSourceById = new Map(suite.scenarios.map((scenario) => [scenario.scenarioId, scenario.sourceDigest]));
  if (provenance.sourceManifest.some((entry) => suiteSourceById.get(entry.scenarioId) !== entry.sourceDigest)) {
    throw new Error('maintenance-operational-source-manifest-invalid');
  }
  const expectedAccounting = expectedReplayAccounting(suite, run);
  plain(artifacts.accounting, 'maintenance-operational-replay-accounting');
  exact(artifacts.accounting as unknown as Record<string, unknown>, [
    'providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd', 'providerErrors', 'invalidCalls',
  ], 'maintenance-operational-replay-accounting');
  if (JSON.stringify(artifacts.accounting) !== JSON.stringify(expectedAccounting)) {
    throw new Error('maintenance-operational-replay-accounting-mismatch');
  }
  const bridgeAccounting = sessionBoundBridgeAccounting(
    rawBridgeAccounting,
    'maintenance-operational-bridge-accounting',
  );
  if (bridgeAccounting.providerCalls !== P14_MAINTENANCE_OPERATIONAL_CASE_IDS.length
    || bridgeAccounting.inputTokens !== expectedAccounting.inputTokens
    || bridgeAccounting.outputTokens !== expectedAccounting.outputTokens
    || bridgeAccounting.costMicrousd < expectedAccounting.costMicrousd
    || bridgeAccounting.costMicrousd > P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD) {
    throw new Error('maintenance-operational-bridge-accounting-mismatch');
  }
  const base = Object.freeze({
    version: P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION,
    lane: 'maintenance' as const,
    suiteId: P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID,
    sessionId: bridgeAccounting.sessionId,
    suiteDigest: p14ReplaySuiteDigest(suite),
    runDigest: maintenanceOperationalReplayDigest(run),
    sourceArtifactDigest: provenance.sourceArtifactDigest,
    toolSetDigest: provenance.toolSetDigest,
    sourceManifest: provenance.sourceManifest,
    toolSetManifest: provenance.toolSetManifest,
    replayAccounting: expectedAccounting,
    bridgeAccounting,
  });
  return Object.freeze({
    ...base,
    accountingDigest: maintenanceOperationalReplayDigest(base),
  });
}

/** Strict importer boundary: exact fields, exact ordering, recomputed sources/tools/sums/digests. */
export function parseMaintenanceOperationalReplayAccountingEvidence(
  suiteInput: P14ReplayEvidence,
  runInput: P14ReplayRun,
  value: unknown,
  expectedSessionId: string,
): MaintenanceOperationalReplayAccountingEvidence {
  plain(value, 'maintenance-operational-accounting-evidence');
  exact(value, [
    'version', 'lane', 'suiteId', 'sessionId', 'suiteDigest', 'runDigest', 'sourceArtifactDigest', 'toolSetDigest',
    'sourceManifest', 'toolSetManifest', 'replayAccounting', 'bridgeAccounting', 'accountingDigest',
  ], 'maintenance-operational-accounting-evidence');
  if (value.version !== P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION
    || value.lane !== 'maintenance'
    || value.suiteId !== P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID
    || typeof value.accountingDigest !== 'string' || !SHA_RE.test(value.accountingDigest)) {
    throw new Error('maintenance-operational-accounting-evidence-binding-invalid');
  }
  if (!/^session-[0-9]{6,24}$/u.test(expectedSessionId)
    || value.sessionId !== expectedSessionId) {
    throw new Error('maintenance-operational-accounting-session-mismatch');
  }
  const replay = value.replayAccounting;
  plain(replay, 'maintenance-operational-replay-accounting');
  exact(replay, [
    'providerCalls', 'inputTokens', 'outputTokens', 'costMicrousd', 'providerErrors', 'invalidCalls',
  ], 'maintenance-operational-replay-accounting');
  const bridge = sessionBoundBridgeAccounting(
    value.bridgeAccounting,
    'maintenance-operational-bridge-accounting',
    expectedSessionId,
  );
  const expected = buildMaintenanceOperationalReplayAccountingEvidence({
    suite: suiteInput,
    run: runInput,
    terminationReason: 'completed',
    accounting: {
      providerCalls: Number(replay.providerCalls),
      inputTokens: Number(replay.inputTokens),
      outputTokens: Number(replay.outputTokens),
      costMicrousd: Number(replay.costMicrousd),
      providerErrors: Number(replay.providerErrors),
      invalidCalls: Number(replay.invalidCalls),
    },
  }, bridge);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('maintenance-operational-accounting-evidence-mismatch');
  }
  return expected;
}
