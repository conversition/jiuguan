export const AGENT_CONTROL_READ_MODEL_VERSION = 'p14-agent-control-read-v1' as const;
export const AGENT_LANE_RECOVERY_ACK = 'p14-agent-lane-recovery-v1' as const;
/**
 * Explicit acknowledgement for the operator quality-kill override.
 *
 * Evidence-bound recovery stays the only path that proves a lane healthy again. This override
 * exists because a quality kill is otherwise unrecoverable: the lane is stopped, so replays
 * cannot produce the passing evidence that recovery demands. It clears only quality stops,
 * never permanent safety stops, always rotates the authorization window, and always appends an
 * immutable audit row.
 */
export const AGENT_LANE_OPERATOR_OVERRIDE_ACK = 'p14-agent-lane-operator-override-v1' as const;
export const EFFECTIVE_LEARNING_READ_MODEL_VERSION = 'p14-effective-learning-v1' as const;

export const PUBLIC_BRANCH_ACTION_TAGS = Object.freeze([
  'investigate', 'social', 'move', 'confront', 'wait', 'other',
] as const);
export type PublicBranchActionTag = (typeof PUBLIC_BRANCH_ACTION_TAGS)[number];

/** Mirrored public vocabulary. Server tests keep this equal to the reducer's frozen vocabulary. */
export const PUBLIC_PROMPT_PREFERENCE_TOKENS = Object.freeze([
  'pace.slow.like', 'pace.slow.avoid',
  'pace.balanced.like', 'pace.balanced.avoid',
  'pace.fast.like', 'pace.fast.avoid',
  'tone.romance.like', 'tone.romance.avoid',
  'tone.mystery.like', 'tone.mystery.avoid',
  'tone.action.like', 'tone.action.avoid',
  'tone.slice_of_life.like', 'tone.slice_of_life.avoid',
  'tone.dark.like', 'tone.dark.avoid',
  'tone.comedy.like', 'tone.comedy.avoid',
  'tone.horror.like', 'tone.horror.avoid',
  'interaction.choice_guided.like', 'interaction.choice_guided.avoid',
  'interaction.freeform.like', 'interaction.freeform.avoid',
  'interaction.dialogue_heavy.like', 'interaction.dialogue_heavy.avoid',
  'interaction.exploration.like', 'interaction.exploration.avoid',
  'viewpoint.first_person.like', 'viewpoint.first_person.avoid',
  'viewpoint.second_person.like', 'viewpoint.second_person.avoid',
  'viewpoint.third_person.like', 'viewpoint.third_person.avoid',
  'relationship.slow_burn.like', 'relationship.slow_burn.avoid',
  'relationship.trust.like', 'relationship.trust.avoid',
  'relationship.romance.like', 'relationship.romance.avoid',
  'relationship.rivalry.like', 'relationship.rivalry.avoid',
  'action.proactive.like', 'action.proactive.avoid',
  'action.cautious.like', 'action.cautious.avoid',
  'action.diplomatic.like', 'action.diplomatic.avoid',
  'action.confrontational.like', 'action.confrontational.avoid',
] as const);
export type PublicPromptPreferenceToken = (typeof PUBLIC_PROMPT_PREFERENCE_TOKENS)[number];
export type PublicLearningProfileScope = 'session' | 'card' | 'none';
export type PublicPreferenceSyncState = 'synced' | 'pending';

export interface PublicPromptPreferenceCount {
  readonly token: PublicPromptPreferenceToken;
  readonly count: number;
}

export interface PublicBranchActionCount {
  readonly action: PublicBranchActionTag;
  readonly count: number;
}

export interface PublicEffectivePromptPreference {
  readonly scope: PublicLearningProfileScope;
  readonly sampleCount: number;
  readonly tagCounts: readonly PublicPromptPreferenceCount[];
  readonly conflictTags: readonly string[];
}

export interface PublicEffectiveBranchPreference {
  readonly scope: PublicLearningProfileScope;
  readonly sampleCount: number;
  readonly uniqueSelectionCount: number;
  readonly actionCounts: readonly PublicBranchActionCount[];
}

export interface PublicEffectiveLearningSummary {
  readonly version: typeof EFFECTIVE_LEARNING_READ_MODEL_VERSION;
  readonly prompt: PublicEffectivePromptPreference;
  readonly branch: PublicEffectiveBranchPreference;
}

export const AGENT_SUBCAPABILITY_IDS = Object.freeze([
  'interactive.prelude',
  'interactive.director',
  'interactive.critic',
  'interactive.variableProposal',
  'interactive.aqlReplan',
  'learning.preference',
  'learning.branchPreference',
  'learning.styleCompile',
  'maintenance.memory',
  'maintenance.branchIndex',
  'maintenance.arc',
  'maintenance.npc',
  'maintenance.worldbook',
  'context.compiler',
] as const);

export type AgentSubcapabilityId = (typeof AGENT_SUBCAPABILITY_IDS)[number];
export type PublicAgentRolloutLane = 'interactive' | 'learning' | 'maintenance';
export type PublicAgentRolloutState =
  | 'off' | 'shadow' | 'test-session' | 'canary-5' | 'canary-25' | 'canary-50' | 'on' | 'killed';

export interface PublicAgentCapabilityMetrics {
  /** A lease can serve multiple logical capabilities; shared metrics must not be summed across rows. */
  readonly attribution: 'exclusive' | 'shared';
  readonly sourceTaskKinds: readonly string[];
  readonly leases: number;
  readonly modelCalls: number;
  /** Gateway-completed Provider leases; this is not a domain proposal-yield counter. */
  readonly successfulLeases: number;
  readonly budgetFailures: number;
  readonly providerFailures: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}

/** Current operator-authorized verification window shared by every capability in a Lane. */
export interface PublicAgentVerificationProgress {
  readonly qualifyingSamples: number;
  readonly requiredQualifyingSamples: number;
  /** Settled Provider attempts, including both successful calls and Provider errors. */
  readonly consumedProviderCalls: number;
  readonly reservedProviderCalls: number;
  readonly maxProviderCalls: number;
}

export interface PublicAgentSubcapability {
  readonly id: AgentSubcapabilityId;
  readonly rolloutLane: PublicAgentRolloutLane;
  readonly hostCeiling: PublicAgentRolloutState;
  readonly effectiveState: PublicAgentRolloutState;
  readonly allowed: boolean;
  readonly sessionScope: 'current';
  readonly bucket: number;
  /** Present when canonical local sessions share this installation's rollout bucket. */
  readonly rolloutCohortScope?: 'managed-local';
  readonly recentReasonCodes: readonly string[];
  readonly killReason: string | null;
  /** Distinguishes control-plane stops from policy, safety and host ceilings. */
  readonly stopSource?: 'none' | 'policy-quality' | 'policy-safety'
    | 'lane-operator' | 'host-ceiling' | 'capability-operator' | 'capability-quality';
  readonly capabilityKilled: boolean;
  readonly proposalDigest: string | null;
  /** Opaque lane CAS token. Capabilities sharing a lane intentionally share this value. */
  readonly controlRevision: string;
  /** Opaque per-capability CAS token used by the trusted-local kill switch. */
  readonly capabilityRevision: string;
  /** Optional for compatibility with older servers; all capabilities in one Lane share this progress. */
  readonly verification?: PublicAgentVerificationProgress;
  readonly metrics: PublicAgentCapabilityMetrics;
}

export interface AgentControlAllowedActions {
  readonly canChangeLane: boolean;
  readonly canKill: boolean;
  readonly canClearKill: boolean;
  readonly canClearProfile: boolean;
  readonly canApprove: boolean;
  readonly canRollback: boolean;
}

export interface PublicStyleProposalControl {
  readonly id: string;
  readonly status: 'disabled' | 'enabled';
  readonly activeVersion: number | null;
  readonly availableVersions: readonly number[];
  /**
   * Trusted-local review material. The whole styleProposals surface is omitted for
   * remote/mobile readers, so a human can inspect the complete derived Skill before
   * approving it without sending private prose back over the private network.
   */
  readonly reviewVersions?: readonly PublicStyleProposalVersionReview[];
  readonly revision: string;
}

export const PUBLIC_STYLE_EVALUATION_CHECKS = Object.freeze([
  'sections-complete',
  'sample-copy-safe',
  'character-isolation',
  'applicability-explicit',
  'prohibitions-complete',
  'steps-executable',
  'example-operational',
] as const);
export type PublicStyleEvaluationCheck = (typeof PUBLIC_STYLE_EVALUATION_CHECKS)[number];

export interface PublicStyleProposalVersionReview {
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  /** Complete learned Skill instructions, never a tag-only summary. */
  readonly body: string;
  readonly createdAt: string;
  readonly model: string;
  readonly policyVersion: string;
  readonly evaluation: Readonly<{
    readonly passed: boolean;
    readonly score: number;
    readonly checks: readonly PublicStyleEvaluationCheck[];
    readonly failedChecks: readonly PublicStyleEvaluationCheck[];
  }>;
}

/** Trusted-local mutations for a learned Style proposal; all writes require an exact CAS revision. */
export type StyleProposalControlMutation =
  | {
      readonly operation: 'disable-style-proposal';
      readonly proposalId: string;
      readonly expectedRevision: string;
    }
  | {
      readonly operation: 'approve-style-proposal';
      readonly proposalId: string;
      readonly version: number;
      readonly expectedRevision: string;
    }
  | {
      readonly operation: 'rollback-style-proposal';
      readonly proposalId: string;
      readonly version: number;
      readonly expectedRevision: string;
    };

export interface PublicPreferenceProfileControl {
  /** Content-free CAS digest of the current session's prompt/branch preference positive evidence. */
  readonly revision: string;
  readonly sampleCount: number;
}

/**
 * Bounded, human-readable review material. The server includes it only for the
 * trusted local operator surface; remote/mobile readers receive proposal metadata only.
 */
export interface PublicMaintenanceProposalReviewItem {
  readonly kind: 'memory' | 'summary' | 'arc' | 'fact' | 'relationship' | 'identity' | 'unresolved';
  readonly title: string;
  readonly detail: string;
  /** True only when this item corresponds to a write the typed committer may actually apply. */
  readonly applicable: boolean;
  readonly decision: 'auto' | 'review';
  readonly reasonCodes: readonly string[];
  readonly sourceRefs: readonly string[];
}

export interface PublicMaintenanceProposalControl {
  readonly id: string;
  readonly taskKind: 'memory_consolidation' | 'branch_index' | 'rolling_summary' | 'npc_state';
  readonly status: 'pending' | 'applied' | 'rejected' | 'stale' | 'rolled_back';
  readonly proposalDigest: string;
  readonly itemCount: number;
  readonly revision: number;
  readonly applySupported: boolean;
  readonly reviewItems?: readonly PublicMaintenanceProposalReviewItem[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Content-free Maintenance execution summary for the exact session.
 *
 * The model is intentionally proposal-only even when a separate, typed policy
 * permits a subset of proposals to reach business truth. Keeping both axes
 * explicit prevents the UI from calling the whole pipeline "shadow" after a
 * guarded committer has been enabled.
 */
export interface PublicMaintenanceRuntimeStatus {
  readonly proposalGeneration: 'off' | 'typed-proposals';
  readonly applyMode: 'off' | 'manual-approval' | 'guarded-auto';
  readonly automaticWriteActive: boolean;
  /** Compact, content-free declaration of the automatic write policy in force. */
  readonly autoApplyScope:
    | 'none'
    | 'safe-memory-summary'
    | 'safe-npc-facts'
    | 'low-risk-maintenance';
}

/**
 * Content-free status for this exact session's Maintenance scheduler.
 *
 * `capabilities[].verification` is a Lane-wide rollout window shared by all
 * sessions. This projection deliberately keeps the independent per-session
 * admission budget beside it so clients do not mistake one for the other.
 */
export interface PublicMaintenanceSessionStatus {
  /** Releasable scheduling capacity for this session. */
  readonly budget: Readonly<{
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
    /** First rolling-window slot expected to return; null when no slot is waiting to expire. */
    readonly nextSlotAt: string | null;
  }>;
  /** Hard 24-hour Provider-attempt safety capacity for this session. */
  readonly attemptBudget: Readonly<{
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
    /** First rolling-window attempt slot expected to return; null while only active jobs reserve capacity. */
    readonly nextSlotAt: string | null;
  }>;
  /** Latest post-turn admission batch for this session, without evidence or conversation content. */
  readonly lastDecision: Readonly<{
    readonly occurredAt: string;
    readonly round: number;
    /** Policy produced at least one would-admit candidate; this does not prove a job was enqueued. */
    readonly admitted: boolean;
    readonly reasonCodes: readonly string[];
  }> | null;
  /** Latest settled Maintenance Provider lease for this session. */
  readonly lastSettlement: Readonly<{
    readonly occurredAt: string;
    readonly qualifying: boolean;
    readonly outcome: 'completed' | 'budget_exhausted' | 'usage_unavailable' | 'provider_error' | 'cancelled' | 'expired';
    readonly reasonCode: string | null;
  }> | null;
}

/** Content-free Worldbook repair summary exposed only through an exact session read. */
export interface PublicWorldbookRepairControl {
  readonly proposalId: string;
  readonly file: string;
  readonly evidenceSetDigest: string;
  readonly proposalDigest: string;
  readonly sourceRevision: string;
  readonly appliedRevision?: string;
  readonly status: 'pending' | 'approved' | 'applied' | 'rejected' | 'stale' | 'reverted';
  readonly revision: number;
  readonly changeCount: number;
  /**
   * 去重后的原因码枚举（resolve-conflict / clarify-scope / disable-stale-entry）。
   * 只暴露**分类**，不暴露条目正文 —— 与上面 "content-free" 的既有边界一致。
   */
  readonly reasonCodes: readonly string[];
  /**
   * 条目级变更的审阅视图（uid + 原因 + patch）。**只在本机可操作者的读取路径上提供**
   * （远端/无 mutation 权限的客户端永远拿不到），用于在确认弹窗里「查看变更内容」。
   * patch 的 content 是唯一可能较长的字段，消费方须自行截断展示。
   */
  readonly changes?: readonly {
    readonly entryUid: string;
    readonly reasonCode: string;
    readonly patch: {
      readonly content?: string;
      readonly enabled?: boolean;
      readonly name?: string;
      readonly key?: readonly string[];
    };
  }[];
  readonly forwardAllowed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Deliberately ID-only: proposal bytes and before/after images never cross the
 * HTTP control surface.
 */
export type WorldbookRepairControlOperation =
  | 'approve-worldbook-repair'
  | 'apply-worldbook-repair'
  | 'reject-worldbook-repair'
  | 'revert-worldbook-repair';

export type WorldbookRepairControlMutation = {
  readonly [Operation in WorldbookRepairControlOperation]: {
    readonly operation: Operation;
    readonly proposalId: string;
    readonly expectedRevision: number;
  }
}[WorldbookRepairControlOperation];

export interface PublicStyleAdoptionEvidencePage {
  readonly version: 'style-adoption-evidence-page-v1';
  readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
    state: 'current' | 'invalidated' | 'unavailable';
    sourceValidity: 'current' | 'invalidated' | null; consumerValidity: 'current' | 'invalidated' | null }>[];
  /** Ledger cursor counts every examined record, including other evidence types. */
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface PublicVariableApplyEvidencePage {
  readonly version: 'variable-apply-evidence-page-v1';
  readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
    state: 'current' | 'invalidated' | 'superseded' | 'unknown' | 'unavailable';
    rollbackObserved: boolean | null }>[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface PublicVariableApplyEvidencePageV2 {
  readonly version: 'variable-apply-evidence-page-v2';
  /** Historical apply and verified rollback facts; committed does not assert current variable values. */
  readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
    execution: 'unknown'; verification: 'unknown'; adoption: 'unknown'; effect: 'unknown';
    commit: Readonly<{ state: 'committed' | 'rolled-back' | 'rollback-pending';
      rollbacks: readonly Readonly<{ evidenceId: string; occurredAt: string;
        kind: 'round-delete' | 'regenerate-state-only' }>[] }> }>[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface PublicAgentControlReadModel {
  readonly schemaVersion: typeof AGENT_CONTROL_READ_MODEL_VERSION;
  /** Opaque session identity; never the database path or user-visible content. */
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly capabilities: readonly PublicAgentSubcapability[];
  readonly allowedActions: AgentControlAllowedActions;
  /** Present only on trusted-local control surfaces; includes bounded review material. */
  readonly styleProposals?: readonly PublicStyleProposalControl[];
  /** Explicit operator-only opt-in; no conversation text or source identifiers. */
  readonly styleAdoptionEvidence?: PublicStyleAdoptionEvidencePage;
  /** Explicit operator-only opt-in; no variable values or source identifiers. */
  readonly variableApplyEvidence?: PublicVariableApplyEvidencePage | PublicVariableApplyEvidencePageV2;
  /** Present only on trusted-local control surfaces; count + digest only. */
  readonly preferenceProfile?: PublicPreferenceProfileControl;
  /** Effective tombstone-aware profile; safe for any authenticated reader of this session. */
  readonly effectiveLearning?: PublicEffectiveLearningSummary;
  /** Pending suppresses effectiveLearning until the local clear fence reaches the central ledger. */
  readonly preferenceSyncState?: PublicPreferenceSyncState;
  /** Trusted-local, content-free Arc/NPC proposal summaries. */
  readonly maintenanceProposals?: readonly PublicMaintenanceProposalControl[];
  /** Content-free split between proposal generation and guarded business writes. */
  readonly maintenanceRuntime?: PublicMaintenanceRuntimeStatus;
  /** Exact-session admission/settlement diagnostics; separate from shared Lane verification. */
  readonly maintenanceSession?: PublicMaintenanceSessionStatus;
  /** Exact-session, content-free and bounded Worldbook repair summaries. */
  readonly worldbookRepairProposals?: readonly PublicWorldbookRepairControl[];
}

const STATES = new Set<string>(['off', 'shadow', 'test-session', 'canary-5', 'canary-25', 'canary-50', 'on', 'killed']);
const LANES = new Set<string>(['interactive', 'learning', 'maintenance']);
const IDS = new Set<string>(AGENT_SUBCAPABILITY_IDS);
const LEARNING_SCOPES = new Set<string>(['session', 'card', 'none']);
const PROMPT_TOKENS = new Set<string>(PUBLIC_PROMPT_PREFERENCE_TOKENS);
const PROMPT_CONFLICT_TAGS = new Set<string>(PUBLIC_PROMPT_PREFERENCE_TOKENS.map((token) => (
  token.split('.').slice(0, -1).join('.')
)));
const BRANCH_ACTIONS = new Set<string>(PUBLIC_BRANCH_ACTION_TAGS);
const STYLE_CHECKS = new Set<string>(PUBLIC_STYLE_EVALUATION_CHECKS);

function nonNegative(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export const PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS = 240;
export const PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS = 1_200;

// Keep review text visually honest. These controls can reorder visible text or
// hide separators without changing the underlying proposal/audit material.
const PUBLIC_MAINTENANCE_REVIEW_UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

/** Sanitize first, then bound by Unicode code points (not UTF-16 code units). */
export function sanitizePublicMaintenanceReviewText(value: string, maxCodePoints: number): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError('maintenance-review-max-code-points-invalid');
  }
  const codePoints = [...value.replace(PUBLIC_MAINTENANCE_REVIEW_UNSAFE_TEXT, '')];
  return codePoints.length <= maxCodePoints
    ? codePoints.join('')
    : `${codePoints.slice(0, maxCodePoints - 1).join('')}…`;
}

function isPublicMaintenanceReviewText(value: unknown, maxCodePoints: number): value is string {
  if (typeof value !== 'string') return false;
  const count = [...value].length;
  return count >= 1
    && count <= maxCodePoints
    && sanitizePublicMaintenanceReviewText(value, maxCodePoints) === value;
}

function isEffectiveLearningSummary(value: unknown): value is PublicEffectiveLearningSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (!hasExactOwnKeys(summary, ['version', 'prompt', 'branch'])
    || summary.version !== EFFECTIVE_LEARNING_READ_MODEL_VERSION) return false;
  const prompt = summary.prompt;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return false;
  const promptRow = prompt as Record<string, unknown>;
  if (!hasExactOwnKeys(promptRow, ['scope', 'sampleCount', 'tagCounts', 'conflictTags'])
    || typeof promptRow.scope !== 'string' || !LEARNING_SCOPES.has(promptRow.scope)
    || !nonNegative(promptRow.sampleCount)
    || !Array.isArray(promptRow.tagCounts) || promptRow.tagCounts.length > PROMPT_TOKENS.size
    || !Array.isArray(promptRow.conflictTags) || promptRow.conflictTags.length > PROMPT_CONFLICT_TAGS.size) return false;
  const seenPrompt = new Set<string>();
  for (const item of promptRow.tagCounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const count = item as Record<string, unknown>;
    if (!hasExactOwnKeys(count, ['token', 'count'])
      || typeof count.token !== 'string' || !PROMPT_TOKENS.has(count.token) || seenPrompt.has(count.token)
      || !Number.isSafeInteger(count.count) || Number(count.count) < 1) return false;
    seenPrompt.add(count.token);
  }
  const seenConflicts = new Set<string>();
  for (const conflict of promptRow.conflictTags) {
    if (typeof conflict !== 'string' || !PROMPT_CONFLICT_TAGS.has(conflict)
      || seenConflicts.has(conflict)) return false;
    seenConflicts.add(conflict);
  }
  if (promptRow.scope === 'none'
    && (promptRow.sampleCount !== 0 || seenPrompt.size !== 0 || seenConflicts.size !== 0)) return false;
  if (promptRow.scope !== 'none' && Number(promptRow.sampleCount) < 1) return false;

  const branch = summary.branch;
  if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return false;
  const branchRow = branch as Record<string, unknown>;
  if (!hasExactOwnKeys(branchRow, ['scope', 'sampleCount', 'uniqueSelectionCount', 'actionCounts'])
    || typeof branchRow.scope !== 'string' || !LEARNING_SCOPES.has(branchRow.scope)
    || !nonNegative(branchRow.sampleCount) || !nonNegative(branchRow.uniqueSelectionCount)
    || Number(branchRow.uniqueSelectionCount) > Number(branchRow.sampleCount)
    || !Array.isArray(branchRow.actionCounts)
    || branchRow.actionCounts.length !== BRANCH_ACTIONS.size) return false;
  const seenActions = new Set<string>();
  let actionTotal = 0;
  for (const item of branchRow.actionCounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const count = item as Record<string, unknown>;
    if (!hasExactOwnKeys(count, ['action', 'count'])
      || typeof count.action !== 'string' || !BRANCH_ACTIONS.has(count.action) || seenActions.has(count.action)
      || !nonNegative(count.count)) return false;
    seenActions.add(count.action);
    actionTotal += Number(count.count);
  }
  if (seenActions.size !== BRANCH_ACTIONS.size || actionTotal !== Number(branchRow.sampleCount)) return false;
  if (branchRow.scope === 'none'
    && (branchRow.sampleCount !== 0 || branchRow.uniqueSelectionCount !== 0)) return false;
  if (branchRow.scope !== 'none' && Number(branchRow.sampleCount) < 1) return false;
  return true;
}

/** Forward-compatible guard: validates the stable required surface and ignores unknown fields. */
export function isPublicAgentControlReadModel(value: unknown): value is PublicAgentControlReadModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== AGENT_CONTROL_READ_MODEL_VERSION
    || typeof row.sessionId !== 'string' || row.sessionId.length < 1
    || typeof row.generatedAt !== 'string' || !Number.isFinite(Date.parse(row.generatedAt as string))
    || !Array.isArray(row.capabilities) || row.capabilities.length !== AGENT_SUBCAPABILITY_IDS.length
    || !row.allowedActions || typeof row.allowedActions !== 'object' || Array.isArray(row.allowedActions)) return false;
  const actions = row.allowedActions as Record<string, unknown>;
  if (['canChangeLane', 'canKill', 'canClearKill', 'canClearProfile', 'canApprove', 'canRollback']
    .some((key) => typeof actions[key] !== 'boolean')) return false;
  const seen = new Set<string>();
  for (const entry of row.capabilities) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const capability = entry as Record<string, unknown>;
    if (typeof capability.id !== 'string' || !IDS.has(capability.id) || seen.has(capability.id)
      || typeof capability.rolloutLane !== 'string' || !LANES.has(capability.rolloutLane)
      || typeof capability.hostCeiling !== 'string' || !STATES.has(capability.hostCeiling)
      || typeof capability.effectiveState !== 'string' || !STATES.has(capability.effectiveState)
      || typeof capability.allowed !== 'boolean' || capability.sessionScope !== 'current'
      || !nonNegative(capability.bucket) || Number(capability.bucket) > 99
      || (capability.rolloutCohortScope !== undefined
        && capability.rolloutCohortScope !== 'managed-local')
      || !Array.isArray(capability.recentReasonCodes)
      || capability.recentReasonCodes.some((reason) => typeof reason !== 'string')
      || !(capability.killReason === null || typeof capability.killReason === 'string')
      || (capability.stopSource !== undefined
        && ![
          'none', 'policy-quality', 'policy-safety', 'lane-operator', 'host-ceiling', 'capability-operator',
          'capability-quality',
        ].includes(String(capability.stopSource)))
      || typeof capability.capabilityKilled !== 'boolean'
      || !(capability.proposalDigest === null || (typeof capability.proposalDigest === 'string'
        && /^sha256:[a-f0-9]{64}$/u.test(capability.proposalDigest)))) return false;
    if (typeof capability.controlRevision !== 'string'
      || !Number.isFinite(Date.parse(capability.controlRevision))
      || new Date(capability.controlRevision).toISOString() !== capability.controlRevision) return false;
    if (typeof capability.capabilityRevision !== 'string'
      || !Number.isFinite(Date.parse(capability.capabilityRevision))
      || new Date(capability.capabilityRevision).toISOString() !== capability.capabilityRevision) return false;
    if (capability.verification !== undefined) {
      if (!capability.verification || typeof capability.verification !== 'object'
        || Array.isArray(capability.verification)) return false;
      const verification = capability.verification as Record<string, unknown>;
      if (!hasExactOwnKeys(verification, [
        'qualifyingSamples', 'requiredQualifyingSamples', 'consumedProviderCalls',
        'reservedProviderCalls', 'maxProviderCalls',
      ])
        || !nonNegative(verification.qualifyingSamples)
        || !Number.isSafeInteger(verification.requiredQualifyingSamples)
        || Number(verification.requiredQualifyingSamples) < 1
        || !nonNegative(verification.consumedProviderCalls)
        || !nonNegative(verification.reservedProviderCalls)
        || !Number.isSafeInteger(verification.maxProviderCalls)
        || Number(verification.maxProviderCalls) < 1
        || Number(verification.consumedProviderCalls) > Number(verification.maxProviderCalls)
        || Number(verification.reservedProviderCalls)
          > Number(verification.maxProviderCalls) - Number(verification.consumedProviderCalls)) return false;
    }
    const metrics = capability.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
    const metric = metrics as Record<string, unknown>;
    if ((metric.attribution !== 'exclusive' && metric.attribution !== 'shared')
      || !Array.isArray(metric.sourceTaskKinds)
      || metric.sourceTaskKinds.some((kind) => typeof kind !== 'string')
      || ['leases', 'modelCalls', 'successfulLeases', 'budgetFailures', 'providerFailures',
        'p50LatencyMs', 'p95LatencyMs', 'inputTokens', 'outputTokens', 'costMicrousd']
        .some((key) => !nonNegative(metric[key]))) return false;
    seen.add(capability.id);
  }
  if (row.styleProposals !== undefined) {
    if (!Array.isArray(row.styleProposals) || row.styleProposals.length > 20) return false;
    for (const item of row.styleProposals) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const proposal = item as Record<string, unknown>;
      if (typeof proposal.id !== 'string' || !/^style-[a-f0-9]{20}$/u.test(proposal.id)
        || (proposal.status !== 'disabled' && proposal.status !== 'enabled')
        || (proposal.activeVersion !== null && (!Number.isSafeInteger(proposal.activeVersion)
          || Number(proposal.activeVersion) < 1))
        || !Array.isArray(proposal.availableVersions) || proposal.availableVersions.length > 20
        || proposal.availableVersions.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 1)
        || typeof proposal.revision !== 'string' || !Number.isFinite(Date.parse(proposal.revision))) return false;
      if (proposal.reviewVersions !== undefined) {
        if (!Array.isArray(proposal.reviewVersions) || proposal.reviewVersions.length > 5) return false;
        const knownVersions = new Set(proposal.availableVersions as number[]);
        const reviewedVersions = new Set<number>();
        for (const entry of proposal.reviewVersions) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const review = entry as Record<string, unknown>;
          if (!hasExactOwnKeys(review, [
            'version', 'name', 'description', 'keywords', 'body', 'createdAt', 'model', 'policyVersion', 'evaluation',
          ])
            || !Number.isSafeInteger(review.version) || Number(review.version) < 1
            || !knownVersions.has(Number(review.version)) || reviewedVersions.has(Number(review.version))
            || typeof review.name !== 'string' || review.name.length < 1 || review.name.length > 80
            || typeof review.description !== 'string' || review.description.length < 12 || review.description.length > 500
            || !Array.isArray(review.keywords) || review.keywords.length < 1 || review.keywords.length > 16
            || review.keywords.some((keyword) => typeof keyword !== 'string'
              || keyword.length < 1 || keyword.length > 40)
            || typeof review.body !== 'string' || review.body.length < 400 || review.body.length > 20_000
            || typeof review.createdAt !== 'string' || !Number.isFinite(Date.parse(review.createdAt))
            || typeof review.model !== 'string' || review.model.length < 1 || review.model.length > 240
            || typeof review.policyVersion !== 'string' || review.policyVersion.length < 1
              || review.policyVersion.length > 240
            || !review.evaluation || typeof review.evaluation !== 'object'
              || Array.isArray(review.evaluation)) return false;
          const evaluation = review.evaluation as Record<string, unknown>;
          if (!hasExactOwnKeys(evaluation, ['passed', 'score', 'checks', 'failedChecks'])
            || typeof evaluation.passed !== 'boolean'
            || typeof evaluation.score !== 'number' || !Number.isFinite(evaluation.score)
              || evaluation.score < 0 || evaluation.score > 1
            || !Array.isArray(evaluation.checks) || !Array.isArray(evaluation.failedChecks)
            || evaluation.checks.some((check) => typeof check !== 'string' || !STYLE_CHECKS.has(check))
            || evaluation.failedChecks.some((check) => typeof check !== 'string' || !STYLE_CHECKS.has(check))) return false;
          const allChecks = [...evaluation.checks, ...evaluation.failedChecks] as string[];
          if (allChecks.length !== STYLE_CHECKS.size
            || new Set(allChecks).size !== STYLE_CHECKS.size
            || [...STYLE_CHECKS].some((check) => !allChecks.includes(check))
            || evaluation.passed !== (evaluation.failedChecks.length === 0)
            || Math.abs(evaluation.score - (evaluation.checks.length / STYLE_CHECKS.size)) > 1e-12) return false;
          reviewedVersions.add(Number(review.version));
        }
        if (proposal.status === 'enabled' && proposal.activeVersion !== null
          && !reviewedVersions.has(Number(proposal.activeVersion))) return false;
      }
    }
  }
  if (row.styleAdoptionEvidence !== undefined) {
    const page = row.styleAdoptionEvidence;
    if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
    const data = page as Record<string, unknown>;
    if (!hasExactOwnKeys(data, ['version', 'entries', 'nextCursor', 'hasMore'])
      || data.version !== 'style-adoption-evidence-page-v1' || !nonNegative(data.nextCursor)
      || typeof data.hasMore !== 'boolean' || !Array.isArray(data.entries) || data.entries.length > 10) return false;
    for (const item of data.entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const entry = item as Record<string, unknown>;
      if (!hasExactOwnKeys(entry, ['evidenceId', 'occurredAt', 'state', 'sourceValidity', 'consumerValidity'])
        || typeof entry.evidenceId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.evidenceId)
        || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))
        || new Date(entry.occurredAt).toISOString() !== entry.occurredAt) return false;
      if (entry.state === 'unavailable') {
        if (entry.sourceValidity !== null || entry.consumerValidity !== null) return false;
      } else if (entry.state === 'current') {
        if (entry.sourceValidity !== 'current' || entry.consumerValidity !== 'current') return false;
      } else if (entry.state === 'invalidated') {
        if (!['current', 'invalidated'].includes(String(entry.sourceValidity))
          || !['current', 'invalidated'].includes(String(entry.consumerValidity))
          || (entry.sourceValidity === 'current' && entry.consumerValidity === 'current')) return false;
      } else return false;
    }
  }
  if (row.variableApplyEvidence !== undefined) {
    const page = row.variableApplyEvidence;
    if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
    const data = page as Record<string, unknown>;
    if (!hasExactOwnKeys(data, ['version', 'entries', 'nextCursor', 'hasMore'])
      || (data.version !== 'variable-apply-evidence-page-v2' && data.version !== 'variable-apply-evidence-page-v1') || !nonNegative(data.nextCursor)
      || typeof data.hasMore !== 'boolean' || !Array.isArray(data.entries) || data.entries.length > 10) return false;
    for (const item of data.entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const entry = item as Record<string, unknown>;
      if (data.version === 'variable-apply-evidence-page-v2') {
        if (!hasExactOwnKeys(entry, ['evidenceId', 'occurredAt', 'execution', 'verification', 'adoption', 'effect', 'commit'])
          || entry.execution !== 'unknown' || entry.verification !== 'unknown' || entry.adoption !== 'unknown' || entry.effect !== 'unknown'
          || typeof entry.evidenceId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.evidenceId)
          || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))
          || new Date(entry.occurredAt).toISOString() !== entry.occurredAt
          || !entry.commit || typeof entry.commit !== 'object' || Array.isArray(entry.commit)) return false;
        const commit = entry.commit as Record<string, unknown>;
        if (!hasExactOwnKeys(commit, ['state', 'rollbacks']) || !Array.isArray(commit.rollbacks)
          || commit.rollbacks.length > 2 || (commit.state !== 'committed' && commit.state !== 'rolled-back' && commit.state !== 'rollback-pending')
          || (commit.state === 'rollback-pending' && commit.rollbacks.length >= 2)
          || (commit.state === 'committed' && commit.rollbacks.length !== 0)
          || (commit.state === 'rolled-back' && commit.rollbacks.length === 0)) return false;
        const kinds = new Set<string>();
        for (const value of commit.rollbacks) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const rollback = value as Record<string, unknown>;
          if (!hasExactOwnKeys(rollback, ['evidenceId', 'occurredAt', 'kind'])
            || typeof rollback.evidenceId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(rollback.evidenceId)
            || typeof rollback.occurredAt !== 'string' || !Number.isFinite(Date.parse(rollback.occurredAt))
            || new Date(rollback.occurredAt).toISOString() !== rollback.occurredAt
            || (rollback.kind !== 'round-delete' && rollback.kind !== 'regenerate-state-only')
            || kinds.has(rollback.kind)) return false;
          kinds.add(rollback.kind as string);
        }
        continue;
      }
      if (!hasExactOwnKeys(entry, ['evidenceId', 'occurredAt', 'state', 'rollbackObserved'])
        || typeof entry.evidenceId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.evidenceId)
        || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))
        || new Date(entry.occurredAt).toISOString() !== entry.occurredAt) return false;
      if (entry.state === 'unavailable') {
        if (entry.rollbackObserved !== null) return false;
      } else if (entry.state === 'invalidated') {
        if (typeof entry.rollbackObserved !== 'boolean') return false;
      } else if (['current', 'superseded', 'unknown'].includes(String(entry.state))) {
        if (entry.rollbackObserved !== false) return false;
      } else return false;
    }
  }
  if (row.preferenceProfile !== undefined) {
    if (!row.preferenceProfile || typeof row.preferenceProfile !== 'object'
      || Array.isArray(row.preferenceProfile)) return false;
    const profile = row.preferenceProfile as Record<string, unknown>;
    if (typeof profile.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(profile.revision)
      || !nonNegative(profile.sampleCount)) return false;
  }
  if (row.effectiveLearning !== undefined && !isEffectiveLearningSummary(row.effectiveLearning)) return false;
  if (row.preferenceSyncState !== undefined
    && row.preferenceSyncState !== 'synced' && row.preferenceSyncState !== 'pending') return false;
  if (row.preferenceSyncState === 'pending' && row.effectiveLearning !== undefined) return false;
  if (row.maintenanceProposals !== undefined) {
    if (!Array.isArray(row.maintenanceProposals) || row.maintenanceProposals.length > 100) return false;
    for (const item of row.maintenanceProposals) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const proposal = item as Record<string, unknown>;
      if (typeof proposal.id !== 'string' || !/^mprop_[a-f0-9]{32}$/u.test(proposal.id)
        || !['memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state']
          .includes(String(proposal.taskKind))
        || !['pending', 'applied', 'rejected', 'stale', 'rolled_back'].includes(String(proposal.status))
        || typeof proposal.proposalDigest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(proposal.proposalDigest)
        || !nonNegative(proposal.itemCount)
        || !Number.isSafeInteger(proposal.revision) || Number(proposal.revision) < 1
        || typeof proposal.applySupported !== 'boolean'
        || typeof proposal.createdAt !== 'string' || !Number.isFinite(Date.parse(proposal.createdAt))
        || typeof proposal.updatedAt !== 'string' || !Number.isFinite(Date.parse(proposal.updatedAt))) return false;
      if (proposal.reviewItems !== undefined) {
        const actions = row.allowedActions as Record<string, unknown> | undefined;
        if (actions?.canApprove !== true
          || proposal.status !== 'pending'
          || !Array.isArray(proposal.reviewItems) || proposal.reviewItems.length < 1
          || proposal.reviewItems.length > 64) return false;
        for (const rawReview of proposal.reviewItems) {
          if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) return false;
          const review = rawReview as Record<string, unknown>;
          if (!hasExactOwnKeys(review, [
            'kind', 'title', 'detail', 'applicable', 'decision', 'reasonCodes', 'sourceRefs',
          ])
            || !['memory', 'summary', 'arc', 'fact', 'relationship', 'identity', 'unresolved']
              .includes(String(review.kind))
            || !isPublicMaintenanceReviewText(
              review.title,
              PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
            )
            || !isPublicMaintenanceReviewText(
              review.detail,
              PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
            )
            || typeof review.applicable !== 'boolean'
            || (review.decision !== 'auto' && review.decision !== 'review')
            || !Array.isArray(review.reasonCodes) || review.reasonCodes.length > 16
            || review.reasonCodes.some((reason) => typeof reason !== 'string'
              || !/^[a-z][a-z0-9-]{0,79}$/u.test(reason))
            || new Set(review.reasonCodes).size !== review.reasonCodes.length
            || !Array.isArray(review.sourceRefs) || review.sourceRefs.length < 1
              || review.sourceRefs.length > 32
            || review.sourceRefs.some((source) => typeof source !== 'string'
              || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(source))
            || new Set(review.sourceRefs).size !== review.sourceRefs.length) return false;
        }
        const kinds = new Set((proposal.reviewItems as Array<Record<string, unknown>>)
          .map((review) => String(review.kind)));
        if ((proposal.taskKind === 'memory_consolidation'
            && [...kinds].some((kind) => kind !== 'memory'))
          || (proposal.taskKind === 'rolling_summary'
            && [...kinds].some((kind) => kind !== 'summary'))
          || (proposal.taskKind === 'branch_index'
            && [...kinds].some((kind) => kind !== 'arc'))
          || (proposal.taskKind === 'npc_state'
            && [...kinds].some((kind) => !['fact', 'relationship', 'identity', 'unresolved'].includes(kind)))) {
          return false;
        }
      }
      if (proposal.taskKind === 'rolling_summary' && proposal.itemCount !== 1) return false;
    }
  }
  if (row.maintenanceRuntime !== undefined) {
    if (!row.maintenanceRuntime || typeof row.maintenanceRuntime !== 'object'
      || Array.isArray(row.maintenanceRuntime)) return false;
    const runtime = row.maintenanceRuntime as Record<string, unknown>;
    if (!hasExactOwnKeys(runtime, [
      'proposalGeneration', 'applyMode', 'automaticWriteActive', 'autoApplyScope',
    ])
      || (runtime.proposalGeneration !== 'off' && runtime.proposalGeneration !== 'typed-proposals')
      || !['off', 'manual-approval', 'guarded-auto'].includes(String(runtime.applyMode))
      || typeof runtime.automaticWriteActive !== 'boolean'
      || !['none', 'safe-memory-summary', 'safe-npc-facts', 'low-risk-maintenance']
        .includes(String(runtime.autoApplyScope))
      || (runtime.automaticWriteActive && (
        runtime.proposalGeneration !== 'typed-proposals' || runtime.applyMode !== 'guarded-auto'
      ))
      || (runtime.applyMode === 'guarded-auto') !== (runtime.autoApplyScope !== 'none')) return false;
  }
  if (row.maintenanceSession !== undefined) {
    if (!row.maintenanceSession || typeof row.maintenanceSession !== 'object'
      || Array.isArray(row.maintenanceSession)) return false;
    const status = row.maintenanceSession as Record<string, unknown>;
    if (!hasExactOwnKeys(status, ['budget', 'attemptBudget', 'lastDecision', 'lastSettlement'])
      || !status.budget || typeof status.budget !== 'object' || Array.isArray(status.budget)
      || !status.attemptBudget || typeof status.attemptBudget !== 'object'
      || Array.isArray(status.attemptBudget)) return false;
    const budget = status.budget as Record<string, unknown>;
    if (!hasExactOwnKeys(budget, ['used', 'limit', 'remaining', 'nextSlotAt'])
      || !nonNegative(budget.used)
      || !Number.isSafeInteger(budget.limit) || Number(budget.limit) < 1
      || !nonNegative(budget.remaining)
      || Number(budget.remaining) !== Math.max(0, Number(budget.limit) - Number(budget.used))
      || !(budget.nextSlotAt === null || (typeof budget.nextSlotAt === 'string'
        && Number.isFinite(Date.parse(budget.nextSlotAt))
        && new Date(budget.nextSlotAt).toISOString() === budget.nextSlotAt))) return false;
    const attemptBudget = status.attemptBudget as Record<string, unknown>;
    if (!hasExactOwnKeys(attemptBudget, ['used', 'limit', 'remaining', 'nextSlotAt'])
      || !nonNegative(attemptBudget.used)
      || !Number.isSafeInteger(attemptBudget.limit) || Number(attemptBudget.limit) < 1
      || !nonNegative(attemptBudget.remaining)
      || Number(attemptBudget.remaining) !== Math.max(0,
        Number(attemptBudget.limit) - Number(attemptBudget.used))
      || !(attemptBudget.nextSlotAt === null || (typeof attemptBudget.nextSlotAt === 'string'
        && Number.isFinite(Date.parse(attemptBudget.nextSlotAt))
        && new Date(attemptBudget.nextSlotAt).toISOString() === attemptBudget.nextSlotAt))) return false;
    if (status.lastDecision !== null) {
      if (!status.lastDecision || typeof status.lastDecision !== 'object'
        || Array.isArray(status.lastDecision)) return false;
      const decision = status.lastDecision as Record<string, unknown>;
      if (!hasExactOwnKeys(decision, ['occurredAt', 'round', 'admitted', 'reasonCodes'])
        || typeof decision.occurredAt !== 'string' || !Number.isFinite(Date.parse(decision.occurredAt))
        || new Date(decision.occurredAt).toISOString() !== decision.occurredAt
        || !Number.isSafeInteger(decision.round) || Number(decision.round) < 1
        || typeof decision.admitted !== 'boolean'
        || !Array.isArray(decision.reasonCodes) || decision.reasonCodes.length > 16
        || decision.reasonCodes.some((reason) => typeof reason !== 'string'
          || !/^[a-z][a-z0-9-]{0,79}$/u.test(reason))
        || new Set(decision.reasonCodes).size !== decision.reasonCodes.length) return false;
    }
    if (status.lastSettlement !== null) {
      if (!status.lastSettlement || typeof status.lastSettlement !== 'object'
        || Array.isArray(status.lastSettlement)) return false;
      const settlement = status.lastSettlement as Record<string, unknown>;
      if (!hasExactOwnKeys(settlement, ['occurredAt', 'qualifying', 'outcome', 'reasonCode'])
        || typeof settlement.occurredAt !== 'string' || !Number.isFinite(Date.parse(settlement.occurredAt))
        || new Date(settlement.occurredAt).toISOString() !== settlement.occurredAt
        || typeof settlement.qualifying !== 'boolean'
        || !['completed', 'budget_exhausted', 'usage_unavailable', 'provider_error', 'cancelled', 'expired']
          .includes(String(settlement.outcome))
        || !(settlement.reasonCode === null || (typeof settlement.reasonCode === 'string'
          && /^[a-z][a-z0-9-]{0,79}$/u.test(settlement.reasonCode)))) return false;
    }
  }
  if (row.worldbookRepairProposals !== undefined) {
    if (!Array.isArray(row.worldbookRepairProposals) || row.worldbookRepairProposals.length > 50) return false;
    for (const item of row.worldbookRepairProposals) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const proposal = item as Record<string, unknown>;
      const allowedKeys = new Set([
        'proposalId', 'file', 'evidenceSetDigest', 'proposalDigest', 'sourceRevision',
        'appliedRevision', 'status', 'revision', 'changeCount', 'forwardAllowed',
        'createdAt', 'updatedAt',
      ]);
      if (Object.keys(proposal).some((key) => !allowedKeys.has(key))
        || typeof proposal.proposalId !== 'string'
        || !/^wbr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(proposal.proposalId)
        || typeof proposal.file !== 'string'
        || !/^[^\\/\u0000-\u001f\u007f]{1,200}\.json$/iu.test(proposal.file)
        || typeof proposal.evidenceSetDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(proposal.evidenceSetDigest)
        || typeof proposal.proposalDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(proposal.proposalDigest)
        || typeof proposal.sourceRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(proposal.sourceRevision)
        || (proposal.appliedRevision !== undefined
          && (typeof proposal.appliedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(proposal.appliedRevision)))
        || !['pending', 'approved', 'applied', 'rejected', 'stale', 'reverted'].includes(String(proposal.status))
        || !Number.isSafeInteger(proposal.revision) || Number(proposal.revision) < 1
        || !Number.isSafeInteger(proposal.changeCount) || Number(proposal.changeCount) < 1
        || Number(proposal.changeCount) > 16 || typeof proposal.forwardAllowed !== 'boolean'
        || typeof proposal.createdAt !== 'string' || !Number.isFinite(Date.parse(proposal.createdAt))
        || typeof proposal.updatedAt !== 'string' || !Number.isFinite(Date.parse(proposal.updatedAt))) return false;
      const applied = proposal.status === 'applied' || proposal.status === 'reverted';
      if (applied !== (proposal.appliedRevision !== undefined)) return false;
    }
  }
  return seen.size === AGENT_SUBCAPABILITY_IDS.length;
}
