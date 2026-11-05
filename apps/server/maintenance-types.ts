import type { HarnessBudgetPolicy } from '../../packages/harness/src/types.ts';
import { createHash } from 'node:crypto';
import {
  arcMaintenanceProposalRejectionCode,
  normalizeArcMaintenanceProposal,
  type ArcMaintenanceEvidenceBinding,
  type ArcMaintenanceProposalRejectionCode,
  type ArcMaintenanceProposalContext,
  type ArcMaintenanceReviewDescriptor,
} from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';
import {
  npcMaintenanceProposalRejectionCode,
  normalizeNpcMaintenanceNoopTerminal,
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceNoopTerminal,
  type NpcMaintenanceProposalRejectionCode,
  type NpcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import {
  isWorldbookRepairProposalContext,
  normalizeWorldbookRepairProposalWithContext,
  type WorldbookRepairFileEvidence,
  type WorldbookRepairProposalContext,
} from '../../packages/agent-policy/src/worldbook-repair-proposal.ts';
import {
  MAINTENANCE_TASK_KINDS,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
  type MaintenanceMode,
  type MaintenanceSettings,
  type MaintenanceStatus,
  type MaintenanceTaskKind,
  type MaintenanceTrigger,
  type PublicMaintenanceJob,
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
  sanitizePublicMaintenanceReviewText,
  type PublicMaintenanceProposalReviewItem,
} from '../../packages/mobile-contracts/src/index.ts';

export {
  MAINTENANCE_TASK_KINDS,
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
  isWorldbookRepairProposalContext,
  sanitizePublicMaintenanceReviewText,
};
export type {
  ArcMaintenanceProposalContext,
  ArcMaintenanceEvidenceBinding,
  ArcMaintenanceProposalRejectionCode,
  ArcMaintenanceReviewDescriptor,
  MaintenanceMode,
  MaintenanceSettings,
  MaintenanceStatus,
  MaintenanceTaskKind,
  MaintenanceTrigger,
  PublicMaintenanceJob,
  PublicMaintenanceProposalReviewItem,
  NpcMaintenanceProposalContext,
  NpcMaintenanceNoopTerminal,
  NpcMaintenanceProposalRejectionCode,
  WorldbookRepairFileEvidence,
  WorldbookRepairProposalContext,
};
export {
  arcMaintenanceProposalRejectionCode,
  npcMaintenanceProposalRejectionCode,
  normalizeNpcMaintenanceNoopTerminal,
};

export const MAINTENANCE_POLICY_VERSION = 'p13b-v1';
/** Versioned identity of strict proposal dispatch plus the typed NPC no-op parser. */
export { MAINTENANCE_OUTPUT_VALIDATOR_VERSION } from './maintenance-model-contract.ts';
export const MAINTENANCE_POLICY: Readonly<HarnessBudgetPolicy> = Object.freeze({
  maxSteps: 6,
  maxModelCalls: 3,
  maxToolCalls: 8,
  maxTokens: 12_000,
  maxCostMicrousd: 100_000,
  maxWallMs: 90_000,
  maxWrites: 1,
  maxToolResultChars: 16_384,
  maxFinalChars: 8_192,
  maxTraceSteps: 64,
});

export interface MaintenanceProposal {
  readonly taskKind: MaintenanceTaskKind;
  readonly payload: Record<string, unknown>;
}

export type MaintenanceStrictProposalContext =
  | ArcMaintenanceProposalContext
  | NpcMaintenanceProposalContext
  | MemoryConsolidationProposalContext
  | RollingSummaryProposalContext
  | WorldbookRepairProposalContext;

/** Fixed-snapshot binding for durable memory facts. */
export interface MemoryConsolidationProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly allowedSourceRefs: readonly string[];
  readonly maxRound: number;
  /** Required by the formal committer; optional only for frozen shadow replay compatibility. */
  readonly historyEpoch?: number;
  readonly sourceEvidence?: readonly MaintenanceMessageEvidenceBinding[];
}

export interface MaintenanceMessageEvidenceBinding {
  readonly ref: string;
  readonly messageId: number;
  readonly round: number;
  readonly role: 'user' | 'assistant';
  readonly contentDigest: string;
}

export interface MemoryConsolidationFact {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string | number | boolean | null;
  readonly status: 'confirmed' | 'pending' | 'last-known' | 'history_only';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly effectiveRound: number;
  readonly sourceRefs: readonly string[];
}

export interface MemoryConsolidationProposalV1 {
  readonly version: 'memory-consolidation-proposal-v1';
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly facts: readonly MemoryConsolidationFact[];
}

/** Fixed-snapshot binding for summaries: the model may only summarize through this exact round. */
export interface RollingSummaryProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly targetRound: number;
  /** Session summary watermark captured in the same fixed snapshot. */
  readonly expectedSummaryRound?: number;
  /** Domain-level branch fence; later appends do not change it. */
  readonly historyEpoch?: number;
  /** Digest of the complete, untruncated baseline summary shown to the model. */
  readonly baseSummaryDigest?: string;
  /** Digest of baseline + exact contiguous message evidence through targetRound. */
  readonly inputDigest?: string;
  readonly sourceEvidence?: readonly MaintenanceMessageEvidenceBinding[];
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

export function maintenanceValueDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function maintenanceMessageEvidenceBinding(input: {
  readonly id: number;
  readonly round: number;
  readonly role: string;
  readonly content: string;
}): MaintenanceMessageEvidenceBinding {
  if (!Number.isSafeInteger(input.id) || input.id < 1
    || !Number.isSafeInteger(input.round) || input.round < 1
    || (input.role !== 'user' && input.role !== 'assistant')
    || typeof input.content !== 'string') {
    throw new Error('maintenance-message-evidence-invalid');
  }
  return Object.freeze({
    ref: `msg:${input.id}`,
    messageId: input.id,
    round: input.round,
    role: input.role,
    contentDigest: maintenanceValueDigest({
      id: input.id, round: input.round, role: input.role, content: input.content,
    }),
  });
}

export function maintenanceSummaryInputDigest(input: {
  readonly historyEpoch: number;
  readonly expectedSummaryRound: number;
  readonly targetRound: number;
  readonly baseSummaryDigest: string;
  readonly sourceEvidence: readonly MaintenanceMessageEvidenceBinding[];
}): string {
  return maintenanceValueDigest({
    version: 'maintenance-summary-input-v1',
    historyEpoch: input.historyEpoch,
    expectedSummaryRound: input.expectedSummaryRound,
    targetRound: input.targetRound,
    baseSummaryDigest: input.baseSummaryDigest,
    sourceEvidence: input.sourceEvidence,
  });
}

export type MaintenanceProposalRejectionCode =
  | 'memory-delta-empty'
  | 'memory-context-mismatch'
  | 'memory-source-ref-not-allowed'
  | 'memory-round-out-of-range'
  | 'memory-status-confidence-invalid'
  | 'memory-semantic-duplicate'
  | 'through-round-mismatch';

const MAINTENANCE_PROPOSAL_REJECTION_CODES: ReadonlySet<string> = new Set([
  'memory-delta-empty',
  'memory-context-mismatch',
  'memory-source-ref-not-allowed',
  'memory-round-out-of-range',
  'memory-status-confidence-invalid',
  'memory-semantic-duplicate',
  'through-round-mismatch',
]);

/** Extracts only value-free, allow-listed diagnostics from proposal validation failures. */
export function maintenanceProposalRejectionCode(
  error: unknown,
): MaintenanceProposalRejectionCode | undefined {
  const code = error instanceof Error ? error.message : '';
  return MAINTENANCE_PROPOSAL_REJECTION_CODES.has(code)
    ? code as MaintenanceProposalRejectionCode
    : undefined;
}

function isRollingSummaryProposalContext(
  value: MaintenanceStrictProposalContext | undefined,
): value is RollingSummaryProposalContext {
  return value !== undefined && 'targetRound' in value
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(value.sessionId)
    && typeof value.sourceRevision === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.sourceRevision)
    && Number.isSafeInteger(value.targetRound) && value.targetRound >= 0
    && (value.expectedSummaryRound === undefined
      || (Number.isSafeInteger(value.expectedSummaryRound) && value.expectedSummaryRound >= 0
        && value.expectedSummaryRound <= value.targetRound));
}

function validMessageEvidence(
  value: unknown,
): value is MaintenanceMessageEvidenceBinding {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, [
    'ref', 'messageId', 'round', 'role', 'contentDigest',
  ])
    && typeof row.ref === 'string' && /^msg:[1-9][0-9]*$/u.test(row.ref)
    && Number.isSafeInteger(row.messageId) && Number(row.messageId) >= 1
    && row.ref === `msg:${row.messageId}`
    && Number.isSafeInteger(row.round) && Number(row.round) >= 1
    && (row.role === 'user' || row.role === 'assistant')
    && typeof row.contentDigest === 'string' && SHA256_RE.test(row.contentDigest));
}

function validEvidenceSet(value: unknown): value is readonly MaintenanceMessageEvidenceBinding[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every(validMessageEvidence)
    && new Set(value.map((row) => row.ref)).size === value.length;
}

export function isMemoryConsolidationProposalContext(
  value: MaintenanceStrictProposalContext | undefined,
): value is MemoryConsolidationProposalContext {
  return value !== undefined && 'allowedSourceRefs' in value && !('allowedArcIds' in value)
    && !('allowedCharacterIds' in value)
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(value.sessionId)
    && typeof value.sourceRevision === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.sourceRevision)
    && Array.isArray(value.allowedSourceRefs)
    && value.allowedSourceRefs.length > 0 && value.allowedSourceRefs.length <= 128
    && new Set(value.allowedSourceRefs).size === value.allowedSourceRefs.length
    && value.allowedSourceRefs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(ref))
    && Number.isSafeInteger(value.maxRound) && value.maxRound >= 1;
}

/** Formal-write context. Frozen replay contexts deliberately fail this stronger guard. */
export function isMemoryConsolidationApplyContext(
  value: MaintenanceStrictProposalContext | undefined,
): value is MemoryConsolidationProposalContext & Readonly<{
  historyEpoch: number;
  sourceEvidence: readonly MaintenanceMessageEvidenceBinding[];
}> {
  return isMemoryConsolidationProposalContext(value)
    && Number.isSafeInteger(value.historyEpoch) && value.historyEpoch! >= 0
    && validEvidenceSet(value.sourceEvidence)
    && value.sourceEvidence!.every((row) => (
      value.allowedSourceRefs.includes(row.ref) && row.round <= value.maxRound
    ))
    && value.sourceEvidence!.length === value.allowedSourceRefs.length
    && value.allowedSourceRefs.every((ref) => value.sourceEvidence!.some((row) => row.ref === ref));
}

/** Formal summary-write context with a complete contiguous round window. */
export function isRollingSummaryApplyContext(
  value: MaintenanceStrictProposalContext | undefined,
): value is RollingSummaryProposalContext & Readonly<{
  expectedSummaryRound: number;
  historyEpoch: number;
  baseSummaryDigest: string;
  inputDigest: string;
  sourceEvidence: readonly MaintenanceMessageEvidenceBinding[];
}> {
  if (!isRollingSummaryProposalContext(value)
    || !Number.isSafeInteger(value.expectedSummaryRound) || value.expectedSummaryRound! < 0
    || value.expectedSummaryRound! >= value.targetRound
    || !Number.isSafeInteger(value.historyEpoch) || value.historyEpoch! < 0
    || typeof value.baseSummaryDigest !== 'string' || !SHA256_RE.test(value.baseSummaryDigest)
    || typeof value.inputDigest !== 'string' || !SHA256_RE.test(value.inputDigest)
    || !validEvidenceSet(value.sourceEvidence)) return false;
  const rounds = new Map<number, Set<string>>();
  for (const evidence of value.sourceEvidence) {
    if (evidence.round <= value.expectedSummaryRound! || evidence.round > value.targetRound) return false;
    const roles = rounds.get(evidence.round) ?? new Set<string>();
    roles.add(evidence.role);
    rounds.set(evidence.round, roles);
  }
  for (let round = value.expectedSummaryRound! + 1; round <= value.targetRound; round += 1) {
    const roles = rounds.get(round);
    if (!roles?.has('user') || !roles.has('assistant')) return false;
  }
  return value.inputDigest === maintenanceSummaryInputDigest({
    historyEpoch: value.historyEpoch!,
    expectedSummaryRound: value.expectedSummaryRound!,
    targetRound: value.targetRound,
    baseSummaryDigest: value.baseSummaryDigest,
    sourceEvidence: value.sourceEvidence,
  });
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(row);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(row, key)) && keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validFact(value: unknown): boolean {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['subject', 'predicate', 'value'], ['sourceRound'])) return false;
  if (!boundedString(row.subject, 240) || !boundedString(row.predicate, 120)) return false;
  if (!['string', 'number', 'boolean'].includes(typeof row.value) && row.value !== null) return false;
  if (typeof row.value === 'string' && row.value.length > 2_000) return false;
  return row.sourceRound === undefined
    || (Number.isInteger(row.sourceRound) && (row.sourceRound as number) >= 0);
}

/** Normalize a memory proposal only against the exact fixed snapshot that produced it. */
export function normalizeMemoryConsolidationProposal(
  value: unknown,
  context: MemoryConsolidationProposalContext,
): MemoryConsolidationProposalV1 {
  const payload = plainRecord(value);
  if (!payload || !exactKeys(payload, ['version', 'sessionId', 'sourceRevision', 'facts'])
    || payload.version !== 'memory-consolidation-proposal-v1'
    || payload.sessionId !== context.sessionId
    || payload.sourceRevision !== context.sourceRevision) {
    throw new Error('memory-context-mismatch');
  }
  if (!Array.isArray(payload.facts) || payload.facts.length < 1 || payload.facts.length > 64) {
    throw new Error('memory-delta-empty');
  }
  const allowedRefs = new Set(context.allowedSourceRefs);
  const facts = payload.facts.map((candidate): MemoryConsolidationFact => {
    const row = plainRecord(candidate);
    if (!row || !exactKeys(row, [
      'subject', 'predicate', 'value', 'status', 'confidence', 'effectiveRound', 'sourceRefs',
    ]) || !boundedString(row.subject, 240) || !boundedString(row.predicate, 120)
      || (!['string', 'number', 'boolean'].includes(typeof row.value) && row.value !== null)
      || (typeof row.value === 'string' && row.value.length > 2_000)
      || !['confirmed', 'pending', 'last-known', 'history_only'].includes(String(row.status))
      || !['high', 'medium', 'low'].includes(String(row.confidence))
      || !Array.isArray(row.sourceRefs) || row.sourceRefs.length < 1 || row.sourceRefs.length > 16
      || new Set(row.sourceRefs).size !== row.sourceRefs.length
      || row.sourceRefs.some((ref) => typeof ref !== 'string')) {
      throw new Error('proposal-schema-invalid');
    }
    if (row.sourceRefs.some((ref) => !allowedRefs.has(ref as string))) {
      throw new Error('memory-source-ref-not-allowed');
    }
    if (!Number.isSafeInteger(row.effectiveRound) || Number(row.effectiveRound) < 1
      || Number(row.effectiveRound) > context.maxRound) {
      throw new Error('memory-round-out-of-range');
    }
    if ((row.status === 'confirmed' && row.confidence !== 'high')
      || (row.status === 'history_only' && row.confidence === 'high')) {
      throw new Error('memory-status-confidence-invalid');
    }
    return Object.freeze({
      subject: String(row.subject).trim(),
      predicate: String(row.predicate).trim(),
      value: row.value as string | number | boolean | null,
      status: row.status as MemoryConsolidationFact['status'],
      confidence: row.confidence as MemoryConsolidationFact['confidence'],
      effectiveRound: Number(row.effectiveRound),
      sourceRefs: Object.freeze((row.sourceRefs as string[]).map((ref) => ref)),
    });
  });
  const semanticIdentities = facts.map((fact) => JSON.stringify([
    fact.subject.normalize('NFC'),
    fact.predicate.normalize('NFC'),
    typeof fact.value === 'string' ? fact.value.normalize('NFC') : fact.value,
  ]));
  if (new Set(semanticIdentities).size !== facts.length) {
    throw new Error('memory-semantic-duplicate');
  }
  return Object.freeze({
    version: 'memory-consolidation-proposal-v1',
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    facts: Object.freeze(facts),
  });
}

function validBranch(value: unknown): boolean {
  const row = plainRecord(value);
  return row !== null && exactKeys(row, ['branchId', 'title', 'summary', 'status'])
    && boundedString(row.branchId, 160) && boundedString(row.title, 240)
    && boundedString(row.summary, 2_000)
    && ['open', 'closed', 'dormant'].includes(String(row.status));
}

function validCharacter(value: unknown): boolean {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['characterId', 'patch'], ['sourceRound', 'evidenceKind'])
    || !boundedString(row.characterId, 160)) return false;
  if (row.evidenceKind !== undefined && ![
    'profile', 'objective_fact', 'belief', 'knowledge', 'secret', 'goal', 'history_only',
  ].includes(String(row.evidenceKind))) return false;
  const patch = plainRecord(row.patch);
  if (!patch || Object.keys(patch).length < 1 || Object.keys(patch).length > 32) return false;
  if (Object.entries(patch).some(([key, item]) => !boundedString(key, 120)
    || (!['string', 'number', 'boolean'].includes(typeof item) && item !== null)
    || (typeof item === 'string' && item.length > 2_000))) return false;
  return row.sourceRound === undefined
    || (Number.isInteger(row.sourceRound) && (row.sourceRound as number) >= 0);
}

function validateMaintenanceProposalInternal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
  strictContext: MaintenanceStrictProposalContext | undefined,
  allowLegacyDomainProposal: boolean,
): MaintenanceProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('proposal-payload-invalid');
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('proposal-payload-too-large');
  const payload = value as Record<string, unknown>;
  if (taskKind === 'memory_consolidation' && isMemoryConsolidationProposalContext(strictContext)) {
    const normalized = normalizeMemoryConsolidationProposal(payload, strictContext);
    return { taskKind, payload: structuredClone(normalized) as unknown as Record<string, unknown> };
  }
  if (taskKind === 'branch_index' && strictContext && 'allowedArcIds' in strictContext) {
    const normalized = normalizeArcMaintenanceProposal(payload, strictContext);
    const { proposalDigest: _proposalDigest, ...persisted } = normalized;
    return { taskKind, payload: structuredClone(persisted) };
  }
  if (taskKind === 'npc_state' && strictContext && 'allowedCharacterIds' in strictContext) {
    const normalized = normalizeNpcMaintenanceProposal(payload, strictContext);
    const { proposalDigest: _proposalDigest, ...persisted } = normalized;
    return { taskKind, payload: structuredClone(persisted) };
  }
  if (taskKind === 'worldbook_repair' && isWorldbookRepairProposalContext(strictContext)) {
    // 世界书修正：模型只能引用证据上下文里列出的条目 uid/digest，revision 也必须来自上下文。
    const normalized = normalizeWorldbookRepairProposalWithContext(payload, strictContext);
    return { taskKind, payload: structuredClone(normalized) as unknown as Record<string, unknown> };
  }
  if ((taskKind === 'branch_index' || taskKind === 'npc_state' || taskKind === 'worldbook_repair')
    && !allowLegacyDomainProposal) {
    throw new Error('proposal-strict-context-required');
  }
  if (taskKind === 'rolling_summary' && !allowLegacyDomainProposal
    && !isRollingSummaryProposalContext(strictContext)) {
    throw new Error('proposal-strict-context-required');
  }
  const allowedKeys: Readonly<Record<MaintenanceTaskKind, readonly string[]>> = {
    memory_consolidation: ['facts', 'supersedes'],
    branch_index: ['branches'],
    rolling_summary: ['summary', 'throughRound'],
    npc_state: ['characters'],
    // 仅历史回放路径可达（生产必须带 strict context，见上面的分支）。
    worldbook_repair: ['version', 'sessionId', 'file', 'expectedRevision', 'evidenceSetDigest', 'changes'],
  };
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => !allowedKeys[taskKind].includes(key))) {
    throw new Error('proposal-schema-invalid');
  }
  if (taskKind === 'rolling_summary') {
    if (typeof payload.summary !== 'string' || payload.summary.length === 0 || payload.summary.length > 16_000
      || !Number.isInteger(payload.throughRound) || (payload.throughRound as number) < 0) {
      throw new Error('proposal-schema-invalid');
    }
    if (isRollingSummaryProposalContext(strictContext)
      && payload.throughRound !== strictContext.targetRound) {
      throw new Error('through-round-mismatch');
    }
  } else {
    const primary = taskKind === 'memory_consolidation' ? payload.facts
      : taskKind === 'branch_index' ? payload.branches : payload.characters;
    if (!Array.isArray(primary) || primary.length > 512) throw new Error('proposal-schema-invalid');
    const valid = taskKind === 'memory_consolidation' ? primary.every(validFact)
      : taskKind === 'branch_index' ? primary.every(validBranch) : primary.every(validCharacter);
    if (!valid) throw new Error('proposal-schema-invalid');
    if (taskKind === 'memory_consolidation') {
      if (!Array.isArray(payload.supersedes) || payload.supersedes.length > 512
        || payload.supersedes.some((item) => !boundedString(item, 160))) {
        throw new Error('proposal-schema-invalid');
      }
      if (primary.length === 0 && payload.supersedes.length === 0) {
        throw new Error('memory-delta-empty');
      }
    }
  }
  return { taskKind, payload: structuredClone(payload) };
}

/** Production boundary: Arc/NPC require their fixed-snapshot strict context. */
export function validateMaintenanceProposal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
  strictContext?: MaintenanceStrictProposalContext,
): MaintenanceProposal {
  return validateMaintenanceProposalInternal(taskKind, value, strictContext, false);
}

/** Historical replay compatibility only; production Harness must never call this entry point. */
export function validateLegacyMaintenanceReplayProposal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
): MaintenanceProposal {
  return validateMaintenanceProposalInternal(taskKind, value, undefined, true);
}
