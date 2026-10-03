import { createHash } from 'node:crypto';
import {
  normalizeSkillAdmissionSnapshot,
  type SkillAdmissionSnapshot,
} from './skill-admission.ts';
import {
  normalizeAgentBudgetProfile,
  type AgentBudgetProfileInput,
} from './budget-profile.ts';

export const ADMISSION_TICKET_VERSION = 'p14-admission-ticket-v2' as const;

export const AGENT_TASK_KINDS = Object.freeze([
  'interactive_prelude',
  'context_compiler',
  'memory_consolidation',
  'branch_index',
  'rolling_summary',
  'npc_state',
  'preference_extract',
  'style_compile',
  'arc_maintenance',
  'npc_maintenance',
  'critic_revision',
  'aql_replan',
] as const);

export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];
export type AgentLane = 'interactive' | 'maintenance' | 'learning' | 'critic';
export type AgentContentMode = 'nsf' | 'nsfw';
export type ExpectedBenefit =
  | 'fact-verification'
  | 'state-correctness'
  | 'memory-quality'
  | 'branch-relevance'
  | 'preference-learning'
  | 'style-learning'
  | 'arc-coherence'
  | 'npc-consistency'
  | 'draft-correction'
  | 'context-recovery';
export type AdmissionFallback =
  | 'continue-deterministic'
  | 'skip-optional-agent'
  | 'use-original-draft'
  | 'defer-maintenance';

export interface AdmissionLimits {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicrousd: number;
  readonly maxWallMs: number;
}

export interface AdmissionRequest {
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly modelId: string;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly mode: AgentContentMode;
  readonly reasonCodes: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly noveltyDigest: string;
  readonly expectedBenefit: ExpectedBenefit;
  readonly limits: AdmissionLimits;
  readonly deadlineMs: number;
  readonly allowedTools: readonly string[];
  readonly fullSkillSnapshots: readonly SkillAdmissionSnapshot[];
  readonly cooldownKey: string;
  readonly idempotencyKey: string;
  readonly fallback: AdmissionFallback;
}

export interface AdmissionTicket extends AdmissionRequest {
  readonly version: typeof ADMISSION_TICKET_VERSION;
  readonly ticketId: string;
  readonly requestDigest: string;
  /** Server-generated digest of durable Provider-call authority; never a user/content identity. */
  readonly quotaReservationDigest?: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AdmissionLease {
  readonly version: typeof ADMISSION_TICKET_VERSION;
  readonly ticketId: string;
  readonly requestDigest: string;
  readonly quotaReservationDigest?: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly modelId: string;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly mode: AgentContentMode;
  readonly reasonCodes: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly limits: AdmissionLimits;
  readonly allowedTools: readonly string[];
  readonly fullSkillSnapshots: readonly SkillAdmissionSnapshot[];
  readonly consumedAtMs: number;
  readonly expiresAtMs: number;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const TOOL_RE = /^[a-z][a-z0-9._:-]{0,127}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const REQUEST_KEYS = new Set<keyof AdmissionRequest>([
  'runId', 'parentRunId', 'sessionId', 'sourceRevision', 'lane', 'taskKind', 'policyVersion',
  'modelId', 'budgetProfileDigest', 'toolSetDigest', 'mode',
  'reasonCodes', 'evidenceDigests', 'noveltyDigest', 'expectedBenefit', 'limits', 'deadlineMs',
  'allowedTools', 'fullSkillSnapshots', 'cooldownKey', 'idempotencyKey', 'fallback',
]);
const LIMIT_KEYS = new Set<keyof AdmissionLimits>([
  'maxModelCalls', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCostMicrousd', 'maxWallMs',
]);
const LANE_TASKS: Readonly<Record<AgentLane, ReadonlySet<AgentTaskKind>>> = Object.freeze({
  interactive: new Set<AgentTaskKind>(['interactive_prelude', 'context_compiler', 'aql_replan']),
  maintenance: new Set<AgentTaskKind>(['memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state', 'arc_maintenance', 'npc_maintenance']),
  learning: new Set<AgentTaskKind>(['preference_extract', 'style_compile']),
  critic: new Set<AgentTaskKind>(['critic_revision']),
});

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new TypeError(`${label} must be an opaque stable token`);
  return value.normalize('NFC');
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  return value as number;
}

function uniqueSortedTokens(value: unknown, label: string, maximum: number, pattern = TOKEN_RE): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded array`);
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || !pattern.test(item)) throw new TypeError(`${label}[${index}] is invalid`);
    return item.normalize('NFC');
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze([...normalized].sort());
}

export function normalizeAdmissionLimits(input: AdmissionLimits): AdmissionLimits {
  assertPlainRecord(input, 'limits');
  for (const key of Object.keys(input)) {
    if (!LIMIT_KEYS.has(key as keyof AdmissionLimits)) throw new TypeError(`limits contains unsupported field: ${key}`);
  }
  return Object.freeze({
    maxModelCalls: safeInteger(input.maxModelCalls, 'limits.maxModelCalls', 1),
    maxToolCalls: safeInteger(input.maxToolCalls, 'limits.maxToolCalls', 0),
    maxInputTokens: safeInteger(input.maxInputTokens, 'limits.maxInputTokens', 1),
    maxOutputTokens: safeInteger(input.maxOutputTokens, 'limits.maxOutputTokens', 1),
    maxCostMicrousd: safeInteger(input.maxCostMicrousd, 'limits.maxCostMicrousd', 0),
    maxWallMs: safeInteger(input.maxWallMs, 'limits.maxWallMs', 1),
  });
}

/** Convert a non-legacy Agent budget ceiling into the existing Ticket limits shape. */
export function admissionLimitsFromBudgetProfile(input: AgentBudgetProfileInput): AdmissionLimits {
  const profile = normalizeAgentBudgetProfile(input);
  if (profile.maxModelCalls < 1 || profile.agentInputBudgetTokens < 1
    || profile.agentOutputBudgetTokens < 1 || profile.maxWallMs < 1) {
    throw new TypeError('inactive budget profile cannot issue an AdmissionTicket');
  }
  return normalizeAdmissionLimits({
    maxModelCalls: profile.maxModelCalls,
    maxToolCalls: profile.maxToolCalls,
    maxInputTokens: profile.agentInputBudgetTokens,
    maxOutputTokens: profile.agentOutputBudgetTokens,
    maxCostMicrousd: profile.maxCostMicrousd,
    maxWallMs: profile.maxWallMs,
  });
}

function canonicalToolContract(value: unknown, depth = 0): string {
  if (depth > 32) throw new TypeError('tool contract nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('tool contract numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalToolContract(item, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('tool contract must use plain objects');
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalToolContract(item, depth + 1)}`)
      .join(',')}}`;
  }
  throw new TypeError('tool contract contains an unsupported value');
}

/** Stable, order-independent digest of the full Provider tool declarations, not only names. */
export function agentToolSetDigest(tools: readonly unknown[]): string {
  if (!Array.isArray(tools) || tools.length > 64) throw new TypeError('tools must be a bounded array');
  const contracts = tools.map((tool) => canonicalToolContract(tool)).sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(contracts), 'utf8').digest('hex')}`;
}

export function normalizeAdmissionRequest(input: AdmissionRequest): AdmissionRequest {
  assertPlainRecord(input, 'admissionRequest');
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key as keyof AdmissionRequest)) throw new TypeError(`admissionRequest contains unsupported field: ${key}`);
  }
  const lane = enumValue(input.lane, ['interactive', 'maintenance', 'learning', 'critic'] as const, 'lane');
  const taskKind = enumValue(input.taskKind, AGENT_TASK_KINDS, 'taskKind');
  if (!LANE_TASKS[lane].has(taskKind)) throw new TypeError('taskKind is not allowed in lane');
  const reasonCodes = uniqueSortedTokens(input.reasonCodes, 'reasonCodes', 32);
  if (reasonCodes.length === 0) throw new TypeError('reasonCodes must not be empty');
  if (!Array.isArray(input.evidenceDigests) || input.evidenceDigests.length > 64) {
    throw new TypeError('evidenceDigests must be a bounded array');
  }
  const evidenceDigests = Object.freeze(input.evidenceDigests.map((item, index) => digest(item, `evidenceDigests[${index}]`)).sort());
  if (new Set(evidenceDigests).size !== evidenceDigests.length) throw new TypeError('evidenceDigests must not contain duplicates');
  const allowedTools = uniqueSortedTokens(input.allowedTools, 'allowedTools', 64, TOOL_RE);
  const toolSetDigest = digest(input.toolSetDigest, 'toolSetDigest');
  if (!Array.isArray(input.fullSkillSnapshots) || input.fullSkillSnapshots.length > 64) {
    throw new TypeError('fullSkillSnapshots must be a bounded array');
  }
  const fullSkillSnapshots = Object.freeze(input.fullSkillSnapshots.map(normalizeSkillAdmissionSnapshot));
  const identities = fullSkillSnapshots.map((snapshot) => `${snapshot.sourceHash}\0${snapshot.version}\0${snapshot.bodyHash}`);
  if (new Set(identities).size !== identities.length) throw new TypeError('fullSkillSnapshots must not contain duplicates');
  return Object.freeze({
    runId: token(input.runId, 'runId'),
    parentRunId: token(input.parentRunId, 'parentRunId'),
    sessionId: token(input.sessionId, 'sessionId'),
    sourceRevision: token(input.sourceRevision, 'sourceRevision'),
    lane,
    taskKind,
    policyVersion: token(input.policyVersion, 'policyVersion'),
    modelId: token(input.modelId, 'modelId'),
    budgetProfileDigest: digest(input.budgetProfileDigest, 'budgetProfileDigest'),
    toolSetDigest,
    mode: enumValue(input.mode, ['nsf', 'nsfw'] as const, 'mode'),
    reasonCodes,
    evidenceDigests,
    noveltyDigest: digest(input.noveltyDigest, 'noveltyDigest'),
    expectedBenefit: enumValue(input.expectedBenefit, [
      'fact-verification', 'state-correctness', 'memory-quality', 'branch-relevance',
      'preference-learning', 'style-learning', 'arc-coherence', 'npc-consistency', 'draft-correction',
      'context-recovery',
    ] as const, 'expectedBenefit'),
    limits: normalizeAdmissionLimits(input.limits),
    deadlineMs: safeInteger(input.deadlineMs, 'deadlineMs', 1),
    allowedTools,
    fullSkillSnapshots,
    cooldownKey: token(input.cooldownKey, 'cooldownKey'),
    idempotencyKey: token(input.idempotencyKey, 'idempotencyKey'),
    fallback: enumValue(input.fallback, [
      'continue-deterministic', 'skip-optional-agent', 'use-original-draft', 'defer-maintenance',
    ] as const, 'fallback'),
  });
}

export function serializeAdmissionRequest(input: AdmissionRequest): string {
  return JSON.stringify(normalizeAdmissionRequest(input));
}

export function admissionRequestDigest(input: AdmissionRequest): string {
  return `sha256:${createHash('sha256').update(serializeAdmissionRequest(input), 'utf8').digest('hex')}`;
}
