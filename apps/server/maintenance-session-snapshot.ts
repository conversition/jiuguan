import type { MaintenanceSnapshot } from './maintenance-harness-service.ts';
import { arcProjectionIdForName } from '../../packages/agent-policy/public/arc-review.ts';
import type {
  ArcMaintenanceEvidenceBinding,
  ArcMaintenanceReviewDescriptor,
  MaintenanceTaskKind,
  WorldbookRepairProposalContext,
} from './maintenance-types.ts';
import {
  maintenanceMessageEvidenceBinding,
  maintenanceSummaryInputDigest,
  maintenanceValueDigest,
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
  sanitizePublicMaintenanceReviewText,
  type MaintenanceMessageEvidenceBinding,
  type RollingSummaryProposalContext,
} from './maintenance-types.ts';
import { maintenanceProviderTools } from './admitted-maintenance-model.ts';
import { estimateAdmittedRequestInputTokens } from './admitted-model-gateway.ts';
import { buildNpcMvuProjection } from '../../packages/agent-policy/src/npc-mvu.ts';
import {
  isEligibleNpcMentionCandidate,
} from '../../packages/memory/public/character-identity.ts';

/** Versioned identities beside the bounded Provider-input snapshot builder. */
export {
  MAINTENANCE_SESSION_INPUT_VERSION,
  MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION,
} from './maintenance-model-contract.ts';

export interface MaintenanceSessionReader {
  getHistory(): Array<{ id: number; round: number; role: string; content: string }>;
  getHistoryEpoch?(): number;
  getStateRows(): Array<{ entity_type: string; entity_id: string; state_json: string; updated_round: number }>;
  getArcRows(): Array<{ code: string; chapter: string; title: string; summary: string; status: string }>;
  getMeta(): { plot_round: number; bars: string; stage: string } | null;
  getVariables(): { values: Record<string, string | number | boolean> };
  getMvuState?(): {
    exists: boolean;
    state: Record<string, unknown>;
    stateVersion: number;
  };
  getCharacterProjections(): unknown[];
  getCharacterRegistry(): Array<{ characterId: string; name: string; kind: string; aliases: string[] }>;
  getCharacterPool(): {
    threshold: number;
    entries: Array<{
      mentionKey: string;
      entityType: string;
      displayName?: string;
      nameCandidates: string[];
      rounds: number[];
      pending: Array<{ field: string; round?: number; messageId?: number; value: unknown }>;
      firstRound?: number;
      lastRound?: number;
      promotedCharacterId?: string;
    }>;
  };
  getSessionConfig(): { worldbooks: string[] };
}

function text(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

function boundedRows(rows: readonly unknown[], maxChars: number, maxItems: number): unknown[] {
  const output: unknown[] = [];
  let used = 2;
  for (const row of rows.slice(-maxItems)) {
    let encoded: string;
    try { encoded = JSON.stringify(row); } catch { continue; }
    if (encoded.length > 4_096 || used + encoded.length + 1 > maxChars) continue;
    output.push(JSON.parse(encoded));
    used += encoded.length + 1;
  }
  return output;
}

function boundedVariables(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  let used = 2;
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).slice(0, 100)) {
    const safeKey = text(key, 160);
    const safeValue = typeof value === 'string' ? value.slice(0, 1_000) : value;
    const encoded = JSON.stringify([safeKey, safeValue]);
    if (used + encoded.length + 1 > 12_000) break;
    output[safeKey] = safeValue;
    used += encoded.length + 1;
  }
  return output;
}

const SUMMARY_BASE_MAX_CHARS = 16_000;
const SUMMARY_HISTORY_MAX_CHARS = 12_000;
const SUMMARY_HISTORY_MAX_MESSAGES = 128;
const FIXED_EVIDENCE_MAX_CHARS = 12_000;
const FIXED_EVIDENCE_MAX_MESSAGES = 16;
const FIXED_EVIDENCE_MAX_MESSAGE_CHARS = 4_096;
export const MAINTENANCE_SNAPSHOT_INSTRUCTION = '先使用 evidence 中的固定快照证据；只有仍缺必要信息时才调用只读工具。随后提交一份有类型的维护提案，不要复述原文。';

/**
 * Select complete Provider-visible rows for strict Memory/Arc source refs.
 * A source ref must never bind hidden bytes behind a display truncation: an
 * oversized row is excluded whole, and every selected row is copied verbatim.
 */
function fixedProviderEvidenceRows(
  rows: readonly Readonly<{ id: number; round: number; role: string; content: string }>[],
): readonly Readonly<{
  id: number; round: number; role: 'user' | 'assistant'; content: string;
}>[] {
  const selected: Array<{
    id: number; round: number; role: 'user' | 'assistant'; content: string;
  }> = [];
  let used = 2;
  for (let index = rows.length - 1; index >= 0 && selected.length < FIXED_EVIDENCE_MAX_MESSAGES; index -= 1) {
    const row = rows[index]!;
    if (!Number.isSafeInteger(row.id) || row.id < 1
      || !Number.isSafeInteger(row.round) || row.round < 1
      || (row.role !== 'user' && row.role !== 'assistant')
      || typeof row.content !== 'string') continue;
    const normalized = {
      id: row.id, round: row.round, role: row.role, content: row.content,
    } as const;
    let encoded: string;
    try { encoded = JSON.stringify(normalized); } catch { continue; }
    if (encoded.length > FIXED_EVIDENCE_MAX_MESSAGE_CHARS
      || used + encoded.length + 1 > FIXED_EVIDENCE_MAX_CHARS) continue;
    selected.push(normalized);
    used += encoded.length + 1;
  }
  return Object.freeze(selected.reverse().map((row) => Object.freeze({ ...row })));
}

interface RollingSummarySnapshotBinding {
  readonly context: RollingSummaryProposalContext & Readonly<{
    expectedSummaryRound: number;
    historyEpoch: number;
    baseSummaryDigest: string;
    inputDigest: string;
    sourceEvidence: readonly MaintenanceMessageEvidenceBinding[];
  }>;
  readonly rollingSummary: Readonly<Record<string, unknown>>;
  readonly recentHistory: readonly Readonly<{
    id: number; round: number; role: 'user' | 'assistant'; content: string;
  }>[];
  readonly userMessage: string;
}

function rollingSummarySnapshotBinding(input: Readonly<{
  sessionId: string;
  revision: string;
  historyEpoch: number;
  expectedSummaryRound: number;
  baselineSummary: string;
  coverage: ReturnType<typeof rollingSummaryCoverage>;
}>): RollingSummarySnapshotBinding {
  const sourceEvidence = input.coverage.rows.map(maintenanceMessageEvidenceBinding);
  const baseSummaryDigest = maintenanceValueDigest(input.baselineSummary);
  const inputDigest = maintenanceSummaryInputDigest({
    historyEpoch: input.historyEpoch,
    expectedSummaryRound: input.expectedSummaryRound,
    targetRound: input.coverage.targetRound,
    baseSummaryDigest,
    sourceEvidence,
  });
  const context = Object.freeze({
    sessionId: input.sessionId,
    sourceRevision: input.revision,
    targetRound: input.coverage.targetRound,
    expectedSummaryRound: input.expectedSummaryRound,
    historyEpoch: input.historyEpoch,
    baseSummaryDigest,
    inputDigest,
    sourceEvidence: Object.freeze(sourceEvidence.map((row) => Object.freeze({ ...row }))),
  });
  const rollingSummary = Object.freeze({
    longterm: input.baselineSummary,
    summaryRound: input.expectedSummaryRound,
    targetRound: input.coverage.targetRound,
    historyEpoch: input.historyEpoch,
    baseSummaryDigest,
    inputDigest,
  });
  const recentHistory = Object.freeze(input.coverage.rows.map((row) => Object.freeze({ ...row })));
  const userMessage = JSON.stringify({
    taskKind: 'rolling_summary',
    sourceRevision: input.revision,
    proposalContext: context,
    evidence: { rollingSummary, recentHistory },
    instruction: MAINTENANCE_SNAPSHOT_INSTRUCTION,
  });
  return Object.freeze({ context, rollingSummary, recentHistory, userMessage });
}

function rollingSummaryProviderInputTokens(
  binding: RollingSummarySnapshotBinding,
  system: string,
): number {
  return estimateAdmittedRequestInputTokens({
    model: 'maintenance-preflight',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: binding.userMessage },
    ],
    tools: [...maintenanceProviderTools('rolling_summary', binding.context)],
    temperature: 0,
    max_tokens: 1,
    stream: false,
  });
}

/**
 * Selects only a contiguous prefix of complete, untruncated user/assistant rounds.
 * A gap or one over-budget round stops the cursor before that round; it can never
 * advance summary_round past evidence the model did not receive.
 */
function rollingSummaryCoverage(
  rows: readonly Readonly<{ id: number; round: number; role: string; content: string }>[],
  expectedSummaryRound: number,
  plotRound: number,
): Readonly<{
  targetRound: number;
  rows: readonly Readonly<{ id: number; round: number; role: 'user' | 'assistant'; content: string }>[];
}> {
  const byRound = new Map<number, Array<{
    id: number; round: number; role: 'user' | 'assistant'; content: string;
  }>>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 1
      || !Number.isSafeInteger(row.round) || row.round < 1
      || row.round <= expectedSummaryRound || row.round > plotRound
      || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const current = byRound.get(row.round) ?? [];
    current.push({ id: row.id, round: row.round, role: row.role, content: row.content });
    byRound.set(row.round, current);
  }
  const selected: Array<{
    id: number; round: number; role: 'user' | 'assistant'; content: string;
  }> = [];
  let used = 2;
  let targetRound = expectedSummaryRound;
  for (let round = expectedSummaryRound + 1; round <= plotRound; round += 1) {
    const candidates = byRound.get(round)?.sort((left, right) => left.id - right.id) ?? [];
    if (!candidates.some((row) => row.role === 'user')
      || !candidates.some((row) => row.role === 'assistant')) break;
    const encoded = JSON.stringify(candidates);
    if (selected.length + candidates.length > SUMMARY_HISTORY_MAX_MESSAGES
      || encoded.length > SUMMARY_HISTORY_MAX_CHARS
      || used + encoded.length + 1 > SUMMARY_HISTORY_MAX_CHARS) break;
    selected.push(...candidates);
    used += encoded.length + 1;
    targetRound = round;
  }
  return Object.freeze({
    targetRound,
    rows: Object.freeze(selected.map((row) => Object.freeze(row))),
  });
}

function identityKey(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('und');
}

function boundedStrings(values: readonly unknown[], maxItems: number, maxChars: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  let used = 2;
  for (const value of values) {
    const item = text(value, 160).trim();
    const key = identityKey(item);
    if (!item || seen.has(key)) continue;
    const encoded = JSON.stringify(item);
    if (output.length >= maxItems || used + encoded.length + 1 > maxChars) break;
    output.push(item);
    seen.add(key);
    used += encoded.length + 1;
  }
  return output;
}

function projectionLatestRound(value: Record<string, unknown> | undefined): number {
  if (!value) return -1;
  let latest = -1;
  const inspect = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const effectiveAt = (candidate as Record<string, unknown>).effectiveAt;
    if (!effectiveAt || typeof effectiveAt !== 'object' || Array.isArray(effectiveAt)) return;
    const round = (effectiveAt as Record<string, unknown>).round;
    if (Number.isSafeInteger(round)) latest = Math.max(latest, Number(round));
  };
  for (const key of ['profile', 'facts'] as const) {
    const section = value[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    Object.values(section as Record<string, unknown>).forEach(inspect);
  }
  for (const key of ['relationships', 'history'] as const) {
    const section = value[key];
    if (Array.isArray(section)) section.forEach(inspect);
  }
  return latest;
}

type NpcCompletionNeed = 'profile' | 'knowledge_boundary' | 'goal' | 'relationship';

interface NpcIdentitySnapshot {
  readonly characterId: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly entityVersion: number;
}

interface NpcCompletionTargetSnapshot {
  readonly characterId: string;
  readonly entityVersion: number;
  readonly lastEvidenceRound: number | null;
  readonly needs: readonly NpcCompletionNeed[];
}

interface NpcProviderEvidenceRow {
  readonly id: number;
  readonly round: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

const NPC_EVIDENCE_MAX_MESSAGES = 32;
const NPC_EVIDENCE_MAX_CHARS = 12_000;
const NPC_EVIDENCE_MAX_MESSAGE_CHARS = 4_096;
const NPC_OLD_EVIDENCE_PER_TARGET = 2;
const NPC_RECENT_EVIDENCE_MESSAGES = 16;

// Stable identity already supplies the name. `appearance` is the sole minimum
// profile field in the frozen standard NPC vocabulary; arbitrary profile keys
// (notes, trivia, one-off labels) must not make the whole profile look complete.
const NPC_MINIMUM_PROFILE_FIELDS = Object.freeze(['appearance'] as const);
const CURRENT_FACT_STATUSES = new Set(['confirmed', 'pending']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function currentProjectionRecord(value: unknown): value is Record<string, unknown> {
  const row = record(value);
  return (row.factKind === 'fact' || row.factKind === 'correction')
    && CURRENT_FACT_STATUSES.has(String(row.status));
}

function storedFieldName(value: unknown): string {
  return String(value ?? '').replace(/^(?:profile|fact)\./u, '');
}

function semanticHistoryFields(history: readonly Record<string, unknown>[]): readonly string[] {
  // Subjective beliefs and plans intentionally live in history so they never
  // masquerade as objective state. Their validity is category-local: a newer
  // appearance/status observation must not reopen an older, still-current goal.
  // `history_only` is stored as `recall`, so it can never close a current gap.
  return history.filter((item) => (
    CURRENT_FACT_STATUSES.has(String(item.status))
    && (item.factKind === 'hypothesis' || item.factKind === 'plan')
    && /^(?:belief|knowledge|secret|goal)(?:\.|$)/u.test(storedFieldName(item.field))
  )).map((item) => storedFieldName(item.field));
}

/**
 * 纯读的「人物档案缺口」目录。它只说哪一类信息还没有记录，
 * 绝不把「缺失」推断成事实。Provider 仍必须从消息证据里找到支持，
 * 并通过 typed proposal / sourceRefs / entityVersion 门禁才能补全。
 */
function npcCompletionNeeds(value: Record<string, unknown> | undefined): readonly NpcCompletionNeed[] {
  const projection = value ?? {};
  const profile = record(projection.profile);
  const facts = record(projection.facts);
  const history = Array.isArray(projection.history)
    ? projection.history.filter((item): item is Record<string, unknown> => (
      item !== null && typeof item === 'object' && !Array.isArray(item)
    ))
    : [];
  const relationships = Array.isArray(projection.relationships)
    ? projection.relationships.filter(currentProjectionRecord)
    : [];
  const profileFields = new Set(Object.entries(profile)
    .filter(([, fact]) => currentProjectionRecord(fact))
    .map(([field]) => storedFieldName(field)));
  const fields = [
    ...Object.entries(facts)
      .filter(([, fact]) => currentProjectionRecord(fact))
      .map(([field]) => storedFieldName(field)),
    ...semanticHistoryFields(history),
  ];
  const hasPrefix = (prefixes: readonly string[]): boolean => fields.some((field) => (
    prefixes.some((prefix) => field === prefix || field.startsWith(`${prefix}.`))
  ));
  const needs: NpcCompletionNeed[] = [];
  if (NPC_MINIMUM_PROFILE_FIELDS.some((field) => !profileFields.has(field))) needs.push('profile');
  if (!hasPrefix(['knowledge', 'belief', 'secret'])) needs.push('knowledge_boundary');
  if (!hasPrefix(['goal'])) needs.push('goal');
  if (relationships.length === 0) needs.push('relationship');
  return Object.freeze(needs);
}

/**
 * Provider-visible NPC evidence is a deterministic union of the newest complete
 * messages and at most two older exact name/alias hits for each incomplete NPC.
 * Rows are never truncated: an oversized row is excluded together with its
 * sourceRef, so every allowed msg:* reference points to bytes the model saw.
 */
function npcProviderEvidenceRows(
  rawHistory: readonly Readonly<{ id: number; round: number; role: string; content: string }>[],
  identities: readonly NpcIdentitySnapshot[],
  completionTargets: readonly NpcCompletionTargetSnapshot[],
): readonly NpcProviderEvidenceRow[] {
  const eligible = rawHistory.flatMap((row): NpcProviderEvidenceRow[] => {
    if (!Number.isSafeInteger(row.id) || row.id < 1
      || !Number.isSafeInteger(row.round) || row.round < 1
      || (row.role !== 'user' && row.role !== 'assistant')
      || typeof row.content !== 'string') return [];
    const normalized = {
      id: row.id, round: row.round, role: row.role, content: row.content,
    } as const;
    let encoded: string;
    try { encoded = JSON.stringify(normalized); } catch { return []; }
    return encoded.length <= NPC_EVIDENCE_MAX_MESSAGE_CHARS ? [normalized] : [];
  });
  const recent = eligible.slice(-NPC_RECENT_EVIDENCE_MESSAGES);
  const recentIds = new Set(recent.map((row) => row.id));
  const identitiesById = new Map(identities.map((identity) => [identity.characterId, identity]));
  const selected = new Map<number, NpcProviderEvidenceRow>();
  let used = 2;
  const add = (row: NpcProviderEvidenceRow): boolean => {
    if (selected.has(row.id)) return true;
    let encoded: string;
    try { encoded = JSON.stringify(row); } catch { return false; }
    if (selected.size >= NPC_EVIDENCE_MAX_MESSAGES
      || encoded.length > NPC_EVIDENCE_MAX_MESSAGE_CHARS
      || used + encoded.length + 1 > NPC_EVIDENCE_MAX_CHARS) return false;
    selected.set(row.id, row);
    used += encoded.length + 1;
    return true;
  };

  // Old target-specific rows are selected first so a long conversation cannot
  // erase the relation/goal evidence that caused a completion target to exist.
  for (const target of completionTargets) {
    const identity = identitiesById.get(target.characterId);
    if (!identity) continue;
    const terms = npcEvidenceIdentityTerms(identity);
    if (terms.length < 1) continue;
    let hits = 0;
    for (let index = eligible.length - 1; index >= 0 && hits < NPC_OLD_EVIDENCE_PER_TARGET; index -= 1) {
      const row = eligible[index]!;
      if (recentIds.has(row.id)) continue;
      const content = row.content.normalize('NFKC');
      if (!terms.some((term) => content.includes(term))) continue;
      if (add(row)) hits += 1;
    }
  }
  for (let index = recent.length - 1; index >= 0; index -= 1) add(recent[index]!);
  return Object.freeze([...selected.values()]
    .sort((left, right) => left.round - right.round || left.id - right.id)
    .map((row) => Object.freeze({ ...row })));
}

function npcEvidenceIdentityTerms(identity: NpcIdentitySnapshot): readonly string[] {
  return Object.freeze(boundedStrings([
    identity.characterId, identity.name, ...identity.aliases,
  ], 9, 960).map((value) => value.normalize('NFKC')).filter(Boolean));
}

function npcAllowedSourceRefsByCharacter(
  rows: readonly NpcProviderEvidenceRow[],
  identities: readonly NpcIdentitySnapshot[],
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(identities.map((identity) => {
    const terms = npcEvidenceIdentityTerms(identity);
    const matched = rows.filter((row) => {
      const content = row.content.normalize('NFKC');
      return terms.some((term) => content.includes(term));
    }).map((row) => `msg:${row.id}`);
    // Preserve up to two old exact hits plus the six newest exact hits. This
    // keeps the per-character binding compact without discarding the old
    // goal/relation evidence deliberately recovered above.
    const refs = [...new Set([...matched.slice(0, 2), ...matched.slice(-6)])];
    return [identity.characterId, Object.freeze(refs)];
  })));
}

const ARC_REVIEW_ID = /^arc:sha256:[a-f0-9]{64}$/u;
const ARC_REVIEW_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const ARC_REVIEW_STATUSES = new Set<ArcMaintenanceEvidenceBinding['status']>([
  'open', 'dormant', 'closed',
]);
const ARC_REVIEW_SNAPSHOT_LIMIT = 32;

function publicReviewTextIsLossless(value: string, maximum: number): boolean {
  return sanitizePublicMaintenanceReviewText(value, maximum) === value;
}

export interface ArcMaintenanceReviewSnapshotBinding {
  readonly allowedArcIds: readonly string[];
  readonly arcEvidence: readonly ArcMaintenanceEvidenceBinding[];
  readonly arcReviewDescriptors: readonly ArcMaintenanceReviewDescriptor[];
}

/**
 * Exact trusted-local join between digest-only learning rows and readable Arc
 * labels. Ambiguous rows fail closed per Arc: callers never pick an arbitrary
 * duplicate. Approved projection state is applied before evidence is frozen,
 * so a subsequent same-status proposal is recognizable as a no-op.
 */
export function bindArcMaintenanceReviewSnapshot(input: Readonly<{
  readonly learningArcs: readonly ArcMaintenanceEvidenceBinding[];
  readonly reviewCatalog: readonly ArcMaintenanceReviewDescriptor[];
  readonly approvedStatuses?: Readonly<Record<string, ArcMaintenanceEvidenceBinding['status']>>;
  readonly mergedInto?: Readonly<Record<string, string>>;
}>): ArcMaintenanceReviewSnapshotBinding {
  const learningByArcId = new Map<string, ArcMaintenanceEvidenceBinding[]>();
  for (const row of input.learningArcs) {
    if (!row || typeof row !== 'object' || !ARC_REVIEW_ID.test(String(row.arcId ?? ''))) continue;
    const entries = learningByArcId.get(row.arcId) ?? [];
    entries.push(row);
    learningByArcId.set(row.arcId, entries);
  }

  // Count a catalog row as soon as its exact join key is structurally usable.
  // If one duplicate later fails title validation, the other row must not win
  // merely because it was the valid-looking member of an ambiguous pair.
  const catalogByExactKey = new Map<string, ArcMaintenanceReviewDescriptor[]>();
  for (const row of input.reviewCatalog) {
    if (!row || typeof row !== 'object'
      || !ARC_REVIEW_ID.test(String(row.arcId ?? ''))
      || !ARC_REVIEW_REVISION.test(String(row.sourceRevision ?? ''))
      || !Number.isSafeInteger(row.lastRound) || row.lastRound < 1) continue;
    const key = `${row.arcId}\0${row.sourceRevision}\0${row.lastRound}`;
    const entries = catalogByExactKey.get(key) ?? [];
    entries.push(row);
    catalogByExactKey.set(key, entries);
  }

  const candidates: Array<Readonly<{
    evidence: ArcMaintenanceEvidenceBinding;
    descriptor: ArcMaintenanceReviewDescriptor;
  }>> = [];
  for (const [arcId, rows] of learningByArcId) {
    if (rows.length !== 1
      || Object.prototype.hasOwnProperty.call(input.mergedInto ?? {}, arcId)) continue;
    const row = rows[0]!;
    if (!ARC_REVIEW_STATUSES.has(row.status)
      || !Number.isSafeInteger(row.firstRound) || row.firstRound < 1
      || !Number.isSafeInteger(row.lastRound) || row.lastRound < row.firstRound
      || !Number.isSafeInteger(row.evidenceCount) || row.evidenceCount < 1
      || !ARC_REVIEW_REVISION.test(row.latestSourceRevision)) continue;

    const hasApprovedStatus = Object.prototype.hasOwnProperty.call(
      input.approvedStatuses ?? {}, arcId,
    );
    const approvedStatus = input.approvedStatuses?.[arcId];
    if (hasApprovedStatus && !ARC_REVIEW_STATUSES.has(approvedStatus!)) continue;
    const exactKey = `${arcId}\0${row.latestSourceRevision}\0${row.lastRound}`;
    const descriptors = catalogByExactKey.get(exactKey) ?? [];
    if (descriptors.length !== 1) continue;
    const descriptor = descriptors[0]!;
    if (typeof descriptor.title !== 'string' || descriptor.title.length < 1
      || [...descriptor.title].length > 240
      || !publicReviewTextIsLossless(
        descriptor.title, PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
      )
      || arcProjectionIdForName(descriptor.title) !== arcId
      || typeof descriptor.currentStage !== 'string'
      || [...descriptor.currentStage].length > 240
      || !publicReviewTextIsLossless(
        descriptor.currentStage, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
      )
      || typeof descriptor.nextMilestone !== 'string'
      || [...descriptor.nextMilestone].length > 240
      || !publicReviewTextIsLossless(
        descriptor.nextMilestone, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
      )) continue;

    candidates.push(Object.freeze({
      evidence: Object.freeze({
        arcId,
        status: hasApprovedStatus ? approvedStatus! : row.status,
        firstRound: row.firstRound,
        lastRound: row.lastRound,
        evidenceCount: row.evidenceCount,
        latestSourceRevision: row.latestSourceRevision,
      }),
      descriptor: Object.freeze({
        arcId,
        title: descriptor.title,
        currentStage: descriptor.currentStage,
        nextMilestone: descriptor.nextMilestone,
        lastRound: descriptor.lastRound,
        sourceRevision: descriptor.sourceRevision,
      }),
    }));
  }

  const selected = candidates
    .sort((left, right) => right.evidence.lastRound - left.evidence.lastRound
      || left.evidence.arcId.localeCompare(right.evidence.arcId))
    .slice(0, ARC_REVIEW_SNAPSHOT_LIMIT);
  const arcEvidence = Object.freeze(selected.map((entry) => entry.evidence));
  const arcReviewDescriptors = Object.freeze(selected.map((entry) => entry.descriptor));
  return Object.freeze({
    allowedArcIds: Object.freeze(arcEvidence.map((entry) => entry.arcId)),
    arcEvidence,
    arcReviewDescriptors,
  });
}

/**
 * 只读、确定性、有界的后台上下文。它不包含 Provider 凭据、插件配置或完整 prompt，
 * 且每一类工具种子都控制在 ToolRegistry 的 16KiB 结果上限以内。
 */
export function buildMaintenanceSessionSnapshot(input: {
  readonly session: MaintenanceSessionReader;
  readonly sessionId: string;
  readonly revision: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly allowedArcIds?: readonly string[];
  /** Disposable Arc overlay head captured beside arcProjection. */
  readonly arcProjectionDigest?: string;
  /** Stable learning-projection rows corresponding one-to-one with allowedArcIds. */
  readonly arcProjection?: readonly ArcMaintenanceEvidenceBinding[];
  /** Session-local readable bindings; never sourced from the central learning ledger. */
  readonly arcReviewCatalog?: readonly ArcMaintenanceReviewDescriptor[];
  readonly worldbookEntries?: readonly unknown[];
  /** Captured by the server from memory_meta in the same revision fence. */
  readonly summaryState?: Readonly<{ longterm: string; summaryRound: number }>;
  /** Exact first-call Provider input ceiling and system prompt. Production always supplies it. */
  readonly providerInputBudget?: Readonly<{ maxTokens: number; system: string }>;
  /** 世界书修正专用证据（多文件：每本书的 revision + 条目 uid/digest 白名单），由 server 侧读取资产后注入。 */
  readonly worldbookRepairContext?: WorldbookRepairProposalContext;
}): MaintenanceSnapshot {
  const rawHistory = input.session.getHistory();
  const historySourceRows = fixedProviderEvidenceRows(rawHistory);
  const history = historySourceRows.map((row) => ({
    id: row.id,
    round: row.round,
    role: row.role,
    content: row.content,
  }));
  const states = input.session.getStateRows().slice(-32).map((row) => ({
    type: text(row.entity_type, 80),
    id: text(row.entity_id, 160),
    state: text(row.state_json, 500),
    round: row.updated_round,
  }));
  const arcs = input.session.getArcRows().slice(-32).map((row) => ({
    code: text(row.code, 80), chapter: text(row.chapter, 120), title: text(row.title, 240),
    summary: text(row.summary, 500), status: text(row.status, 40),
  }));
  const allCharacterProjections = input.session.getCharacterProjections();
  const registry = input.session.getCharacterRegistry();
  const projectionsById = new Map<string, Record<string, unknown>>();
  for (const value of allCharacterProjections) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.characterId === 'string') projectionsById.set(row.characterId, row);
  }
  const characterPool = input.taskKind === 'npc_state' ? input.session.getCharacterPool() : undefined;
  const activityByCharacterId = new Map<string, number>();
  for (const [characterId, projection] of projectionsById) {
    activityByCharacterId.set(characterId, projectionLatestRound(projection));
  }
  for (const entry of characterPool?.entries ?? []) {
    if (!entry.promotedCharacterId) continue;
    const latest = Math.max(
      entry.lastRound ?? -1,
      ...entry.rounds.filter(Number.isSafeInteger),
    );
    activityByCharacterId.set(
      entry.promotedCharacterId,
      Math.max(activityByCharacterId.get(entry.promotedCharacterId) ?? -1, latest),
    );
  }
  const registeredNpcIdentities = boundedRows(registry
    // Registry/card identities are authoritative. The strict generic-name gate
    // applies only while auto-promoting a mention or accepting model newEntity;
    // an intentionally registered title-only NPC such as "守卫" stays usable.
    .filter((character) => character.kind === 'npc')
    // Preserve the NPCs that actually appeared most recently before applying
    // byte/item caps; stable ID remains the deterministic tie-breaker.
    .sort((left, right) => (
      (activityByCharacterId.get(right.characterId) ?? -1)
        - (activityByCharacterId.get(left.characterId) ?? -1)
      || left.characterId.localeCompare(right.characterId)
    ))
    .slice(0, 32)
    .map((character) => {
      const projection = projectionsById.get(character.characterId);
      const version = projection?.entityVersion;
      return {
        characterId: text(character.characterId, 160),
        name: text(character.name, 160),
        aliases: boundedStrings(character.aliases, 6, 500),
        entityVersion: Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0,
      };
    }), 3_000, 32) as NpcIdentitySnapshot[];
  const npcIds = new Set(registeredNpcIdentities.map((character) => character.characterId));
  const npcCompletionTargets = input.taskKind === 'npc_state'
    ? boundedRows(registeredNpcIdentities.flatMap((character) => {
      const needs = npcCompletionNeeds(projectionsById.get(character.characterId));
      if (needs.length === 0) return [];
      return [{
        characterId: character.characterId,
        entityVersion: character.entityVersion,
        lastEvidenceRound: activityByCharacterId.get(character.characterId) ?? null,
        needs,
      }];
    }), 2_000, 24) as NpcCompletionTargetSnapshot[]
    : [];
  let npcMvuOverlay: unknown[] = [];
  let npcMvuProjectionDigest: string | undefined;
  let npcMvuStateVersion: number | undefined;
  if (input.taskKind === 'npc_state' && input.session.getMvuState) {
    try {
      const snapshot = input.session.getMvuState();
      if (snapshot.exists) {
        const projection = buildNpcMvuProjection({
          characters: registeredNpcIdentities,
          state: snapshot.state,
          stateVersion: snapshot.stateVersion,
        });
        npcMvuOverlay = boundedRows(projection.values
          .filter((value) => value.visibility === 'public')
          .map((value) => ({
            characterId: value.characterId,
            entityVersion: value.entityVersion,
            field: value.field,
            value: value.value,
            valueDigest: value.valueDigest,
            source: value.source,
            writePolicy: value.writePolicy,
          })), 2_000, 24);
        npcMvuProjectionDigest = projection.projectionDigest;
        npcMvuStateVersion = projection.stateVersion;
      }
    } catch {
      // Optional overlay failure must not invalidate the CharacterStore snapshot.
    }
  }
  // npc_state must never silently treat the protagonist as NPC evidence. Other
  // maintenance tasks retain the pre-existing complete bounded character view.
  const rawCharacterProjections = input.taskKind === 'npc_state'
    ? allCharacterProjections.filter((value) => value && typeof value === 'object'
      && !Array.isArray(value) && npcIds.has(String((value as Record<string, unknown>).characterId ?? '')))
    : allCharacterProjections;
  const characters = boundedRows(rawCharacterProjections, 3_000, 24);
  const protagonistTerms = new Set(registry
    .filter((character) => character.kind === 'protagonist')
    .flatMap((character) => [character.characterId, character.name, ...character.aliases])
    .map(identityKey)
    .filter(Boolean));
  const characterCandidates = characterPool
    ? boundedRows(characterPool.entries
      .filter((entry) => !entry.promotedCharacterId)
      .filter((entry) => isEligibleNpcMentionCandidate({
        mentionKey: entry.mentionKey,
        entityType: entry.entityType,
        nameHints: [entry.displayName, ...entry.nameCandidates],
      }))
      .filter((entry) => {
        const type = identityKey(entry.entityType);
        if (type === 'protagonist' || type === 'player' || type === 'user' || type === 'main') return false;
        return [entry.mentionKey, entry.displayName, ...entry.nameCandidates]
          .every((value) => !protagonistTerms.has(identityKey(value)));
      })
      .sort((left, right) => (right.lastRound ?? -1) - (left.lastRound ?? -1)
        || left.mentionKey.localeCompare(right.mentionKey))
      .slice(0, 32)
      .map((entry) => ({
        mentionKey: text(entry.mentionKey, 160),
        entityType: text(entry.entityType, 40),
        displayName: entry.displayName ? text(entry.displayName, 160) : undefined,
        nameCandidates: boundedStrings(entry.nameCandidates, 6, 600),
        hitCount: new Set(entry.rounds.filter(Number.isSafeInteger)).size,
        evidenceRounds: entry.rounds.filter(Number.isSafeInteger).slice(-8),
        pendingFields: boundedStrings(entry.pending.map((candidate) => candidate.field), 12, 800),
        firstRound: entry.firstRound,
        lastRound: entry.lastRound,
      })), 2_000, 32)
    : [];
  const historyEpoch = Math.max(0, Math.trunc(input.session.getHistoryEpoch?.() ?? 0));
  const npcEvidenceRows = input.taskKind === 'npc_state'
    ? npcProviderEvidenceRows(rawHistory, registeredNpcIdentities, npcCompletionTargets)
    : [];
  const sourceEvidence = (input.taskKind === 'npc_state' ? npcEvidenceRows : historySourceRows)
    .map(maintenanceMessageEvidenceBinding);
  const sourceRefs = sourceEvidence.map((row) => row.ref);
  const npcSourceRefsByCharacter = input.taskKind === 'npc_state'
    ? npcAllowedSourceRefsByCharacter(npcEvidenceRows, registeredNpcIdentities)
    : undefined;
  const maxRound = Math.max(1, ...(input.taskKind === 'npc_state' ? npcEvidenceRows : history)
    .map((row) => row.round));
  const requestedAllowedArcIds = input.taskKind === 'branch_index'
    ? Object.freeze([...new Set(input.allowedArcIds ?? [])])
    : Object.freeze([] as string[]);
  const arcProjectionDigest = input.taskKind === 'branch_index'
    && /^sha256:[a-f0-9]{64}$/u.test(input.arcProjectionDigest ?? '')
    ? input.arcProjectionDigest
    : undefined;
  const requestedAllowedArcIdSet = new Set(requestedAllowedArcIds);
  const arcReviewBinding = bindArcMaintenanceReviewSnapshot({
    learningArcs: input.taskKind === 'branch_index'
      ? (input.arcProjection ?? []).filter((entry) => requestedAllowedArcIdSet.has(entry.arcId))
      : [],
    reviewCatalog: input.taskKind === 'branch_index' ? input.arcReviewCatalog ?? [] : [],
  });
  const { allowedArcIds, arcEvidence, arcReviewDescriptors } = arcReviewBinding;
  const arcReviewDescriptorsComplete = requestedAllowedArcIds.length > 0
    && allowedArcIds.length === requestedAllowedArcIds.length
    && requestedAllowedArcIds.every((arcId) => allowedArcIds.includes(arcId));
  const meta = input.session.getMeta();
  const plotRound = Number.isSafeInteger(meta?.plot_round) && (meta?.plot_round ?? -1) >= 0
    ? meta!.plot_round
    : Math.max(0, ...history.map((row) => row.round));
  const expectedSummaryRound = Number.isSafeInteger(input.summaryState?.summaryRound)
    ? input.summaryState!.summaryRound : 0;
  let summaryCoverage = rollingSummaryCoverage(rawHistory, expectedSummaryRound, plotRound);
  const baselineSummary = String(input.summaryState?.longterm ?? '');
  const summaryBaseVisible = baselineSummary.length <= SUMMARY_BASE_MAX_CHARS;
  let summaryInputBudgetExhausted = false;
  let summaryBinding = summaryBaseVisible && summaryCoverage.targetRound > expectedSummaryRound
    ? rollingSummarySnapshotBinding({
      sessionId: input.sessionId,
      revision: input.revision,
      historyEpoch,
      expectedSummaryRound,
      baselineSummary,
      coverage: summaryCoverage,
    })
    : undefined;
  if (input.taskKind === 'rolling_summary' && summaryBinding && input.providerInputBudget) {
    while (summaryBinding && rollingSummaryProviderInputTokens(
      summaryBinding, input.providerInputBudget.system,
    ) > input.providerInputBudget.maxTokens) {
      const lastRound = summaryCoverage.targetRound;
      const remaining = summaryCoverage.rows.filter((row) => row.round !== lastRound);
      const targetRound = remaining.length > 0
        ? Math.max(...remaining.map((row) => row.round)) : expectedSummaryRound;
      summaryCoverage = Object.freeze({ targetRound, rows: Object.freeze(remaining) });
      summaryBinding = targetRound > expectedSummaryRound
        ? rollingSummarySnapshotBinding({
          sessionId: input.sessionId,
          revision: input.revision,
          historyEpoch,
          expectedSummaryRound,
          baselineSummary,
          coverage: summaryCoverage,
        })
        : undefined;
    }
    if (!summaryBinding) summaryInputBudgetExhausted = true;
  }
  const summarySourceEvidence = summaryBinding?.context.sourceEvidence ?? [];
  const baseSummaryDigest = maintenanceValueDigest(baselineSummary);
  const summaryInputDigest = summaryBinding?.context.inputDigest
    ?? maintenanceSummaryInputDigest({
      historyEpoch,
      expectedSummaryRound,
      targetRound: summaryCoverage.targetRound,
      baseSummaryDigest,
      sourceEvidence: summarySourceEvidence,
    });
  const proposalContext = input.taskKind === 'branch_index'
    && arcReviewDescriptorsComplete && arcProjectionDigest && sourceRefs.length > 0
    ? {
      sessionId: input.sessionId,
      sourceRevision: input.revision,
      arcProjectionDigest,
      allowedArcIds,
      allowedSourceRefs: Object.freeze([...sourceRefs]),
      maxRound,
      arcEvidence,
      arcReviewDescriptors,
    }
    : input.taskKind === 'memory_consolidation' && sourceRefs.length > 0
      ? {
        sessionId: input.sessionId,
        sourceRevision: input.revision,
        allowedSourceRefs: Object.freeze([...sourceRefs]),
        maxRound,
        historyEpoch,
        sourceEvidence: Object.freeze([...sourceEvidence]),
      }
      : input.taskKind === 'npc_state' && sourceRefs.length > 0
      ? (() => {
        const rows = registeredNpcIdentities.map((character) => ({
          characterId: character.characterId,
          entityVersion: character.entityVersion,
        }));
        if (rows.length < 1 || new Set(rows.map((row) => row.characterId)).size !== rows.length) return undefined;
        const completionTargetIds = npcCompletionTargets.map((target) => target.characterId);
        return {
          sessionId: input.sessionId,
          sourceRevision: input.revision,
          allowedCharacterIds: Object.freeze(rows.map((row) => row.characterId)),
          allowedSourceRefs: Object.freeze([...sourceRefs]),
          allowedSourceRefsByCharacter: npcSourceRefsByCharacter!,
          sourceEvidence: Object.freeze([...sourceEvidence]),
          evidenceSetDigest: maintenanceValueDigest({
            version: 'npc-provider-evidence-v1',
            sourceEvidence,
          }),
          completionTargetIds: Object.freeze([...completionTargetIds]),
          expectedEntityVersions: Object.freeze(Object.fromEntries(
            rows.map((row) => [row.characterId, row.entityVersion]),
          )),
          maxRound,
        };
      })()
      // 世界书修正：证据完全来自资产读取结果，不依赖对话 sourceRefs。
      // 每个文件的 revision 与条目 digest 由 normalizeWorldbookRepairProposalWithContext 逐条复核。
      : input.taskKind === 'worldbook_repair'
        ? input.worldbookRepairContext
        : input.taskKind === 'rolling_summary'
          && summaryBinding
          ? summaryBinding.context
          : undefined;
  const providerProposalContext = input.taskKind === 'branch_index' && proposalContext
    && 'allowedArcIds' in proposalContext
    ? {
      sessionId: proposalContext.sessionId,
      sourceRevision: proposalContext.sourceRevision,
      arcProjectionDigest: proposalContext.arcProjectionDigest,
      allowedArcIds: proposalContext.allowedArcIds,
      allowedSourceRefs: proposalContext.allowedSourceRefs,
      maxRound: proposalContext.maxRound,
      arcEvidence: proposalContext.arcEvidence,
    }
    : proposalContext;
  // Keep the same bounded values in seededState.memory and the first Provider
  // request. Production sessions attach a readMemory callback, so query_memory
  // may intentionally bypass seededState.memory; keeping the task's minimum
  // evidence in userMessage prevents an evidence-free first call while
  // preserving the fixed revision/source-ref fence.
  const recentHistory = input.taskKind === 'rolling_summary'
    ? summaryBinding?.recentHistory ?? []
    : input.taskKind === 'npc_state'
      ? npcEvidenceRows
      : boundedRows(history, 6_000, 16);
  const snapshotArcs = boundedRows(arcs, input.taskKind === 'npc_state' ? 800 : 2_500, 32);
  const rollingSummary = {
    ...(summaryBaseVisible ? { longterm: baselineSummary } : { baselineUnavailable: true }),
    summaryRound: expectedSummaryRound,
    targetRound: summaryCoverage.targetRound,
    historyEpoch,
    baseSummaryDigest,
    inputDigest: summaryInputDigest,
  };
  const npcContext = {
    characterRegistry: boundedRows(registeredNpcIdentities, 3_000, 64),
    npcCompletionTargets,
    characterCandidates,
  };
  const memory = {
    recentHistory,
    states: boundedRows(states, input.taskKind === 'npc_state' ? 1_200 : 3_000, 32),
    arcs: snapshotArcs,
    ...(input.taskKind === 'branch_index' ? { arcProjection: arcEvidence } : {}),
    characters,
    ...(input.taskKind === 'npc_state' ? {
      characterRegistry: npcContext.characterRegistry,
      characterCandidateThreshold: characterPool?.threshold,
      characterCandidates,
      npcCompletionTargets,
      npcMvuOverlay,
      ...(npcMvuProjectionDigest ? { npcMvuProjectionDigest, npcMvuStateVersion } : {}),
    } : {}),
    meta,
    ...(input.taskKind === 'rolling_summary' ? {
      rollingSummary,
    } : {}),
  };
  const evidence = input.taskKind === 'memory_consolidation'
    ? { recentHistory }
    : input.taskKind === 'rolling_summary'
      ? { rollingSummary, recentHistory }
      : input.taskKind === 'branch_index'
        ? { arcProjection: arcEvidence, recentHistory }
        : input.taskKind === 'npc_state'
          ? { recentHistory, npcContext }
          : undefined;
  const worldbooks = input.worldbookEntries === undefined
    ? input.session.getSessionConfig().worldbooks.slice(0, 32).map((name) => ({ name: text(name, 240) }))
    : boundedRows(input.worldbookEntries, 12_000, 64);
  return {
    revision: input.revision,
    state: {
      memory,
      worldbook: worldbooks,
      variables: boundedVariables(input.session.getVariables().values),
    },
    userMessage: JSON.stringify({
      taskKind: input.taskKind,
      sourceRevision: input.revision,
      proposalContext: providerProposalContext,
      // Task-specific, data-only evidence for the first Provider call. Never
      // include credentials, full projections or unadmitted candidate values.
      ...(evidence ? { evidence } : {}),
      instruction: MAINTENANCE_SNAPSHOT_INSTRUCTION,
    }),
    ...(proposalContext ? { proposalContext } : {}),
    ...(providerProposalContext ? { providerProposalContext } : {}),
    ...(!proposalContext && input.taskKind === 'rolling_summary'
      ? {
        strictContextUnavailableReason: !summaryBaseVisible
          ? 'maintenance-summary-baseline-too-large' as const
          : summaryInputBudgetExhausted
            ? 'maintenance-summary-input-budget-exhausted' as const
            : undefined,
      }
      : !proposalContext && input.taskKind === 'branch_index'
        ? { strictContextUnavailableReason: 'maintenance-arc-projection-unavailable' as const }
        : {}),
  };
}
