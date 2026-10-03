export const AGENT_CONTROL_READ_MODEL_VERSION = 'p14-agent-control-read-v1' as const;
export const AGENT_LANE_RECOVERY_ACK = 'p14-agent-lane-recovery-v1' as const;
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

export interface PublicAgentSubcapability {
  readonly id: AgentSubcapabilityId;
  readonly rolloutLane: PublicAgentRolloutLane;
  readonly hostCeiling: PublicAgentRolloutState;
  readonly effectiveState: PublicAgentRolloutState;
  readonly allowed: boolean;
  readonly sessionScope: 'current';
  readonly bucket: number;
  readonly recentReasonCodes: readonly string[];
  readonly killReason: string | null;
  readonly capabilityKilled: boolean;
  readonly proposalDigest: string | null;
  /** Opaque lane CAS token. Capabilities sharing a lane intentionally share this value. */
  readonly controlRevision: string;
  /** Opaque per-capability CAS token used by the trusted-local kill switch. */
  readonly capabilityRevision: string;
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
  readonly revision: string;
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

export interface PublicMaintenanceProposalControl {
  readonly id: string;
  readonly taskKind: 'branch_index' | 'npc_state';
  readonly status: 'pending' | 'applied' | 'rejected' | 'stale' | 'rolled_back';
  readonly proposalDigest: string;
  readonly itemCount: number;
  readonly revision: number;
  readonly applySupported: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface PublicAgentControlReadModel {
  readonly schemaVersion: typeof AGENT_CONTROL_READ_MODEL_VERSION;
  /** Opaque session identity; never the database path or user-visible content. */
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly capabilities: readonly PublicAgentSubcapability[];
  readonly allowedActions: AgentControlAllowedActions;
  /** Present only on trusted-local control surfaces; never contains Skill names or bodies. */
  readonly styleProposals?: readonly PublicStyleProposalControl[];
  /** Present only on trusted-local control surfaces; count + digest only. */
  readonly preferenceProfile?: PublicPreferenceProfileControl;
  /** Effective tombstone-aware profile; safe for any authenticated reader of this session. */
  readonly effectiveLearning?: PublicEffectiveLearningSummary;
  /** Pending suppresses effectiveLearning until the local clear fence reaches the central ledger. */
  readonly preferenceSyncState?: PublicPreferenceSyncState;
  /** Trusted-local, content-free Arc/NPC proposal summaries. */
  readonly maintenanceProposals?: readonly PublicMaintenanceProposalControl[];
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

function nonNegative(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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
      || !Array.isArray(capability.recentReasonCodes)
      || capability.recentReasonCodes.some((reason) => typeof reason !== 'string')
      || !(capability.killReason === null || typeof capability.killReason === 'string')
      || typeof capability.capabilityKilled !== 'boolean'
      || !(capability.proposalDigest === null || (typeof capability.proposalDigest === 'string'
        && /^sha256:[a-f0-9]{64}$/u.test(capability.proposalDigest)))) return false;
    if (typeof capability.controlRevision !== 'string'
      || !Number.isFinite(Date.parse(capability.controlRevision))
      || new Date(capability.controlRevision).toISOString() !== capability.controlRevision) return false;
    if (typeof capability.capabilityRevision !== 'string'
      || !Number.isFinite(Date.parse(capability.capabilityRevision))
      || new Date(capability.capabilityRevision).toISOString() !== capability.capabilityRevision) return false;
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
    if (!Array.isArray(row.styleProposals) || row.styleProposals.length > 50) return false;
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
        || (proposal.taskKind !== 'branch_index' && proposal.taskKind !== 'npc_state')
        || !['pending', 'applied', 'rejected', 'stale', 'rolled_back'].includes(String(proposal.status))
        || typeof proposal.proposalDigest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(proposal.proposalDigest)
        || !nonNegative(proposal.itemCount)
        || !Number.isSafeInteger(proposal.revision) || Number(proposal.revision) < 1
        || typeof proposal.applySupported !== 'boolean'
        || typeof proposal.createdAt !== 'string' || !Number.isFinite(Date.parse(proposal.createdAt))
        || typeof proposal.updatedAt !== 'string' || !Number.isFinite(Date.parse(proposal.updatedAt))) return false;
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
