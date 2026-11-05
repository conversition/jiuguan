import type {
  AgentSubcapabilityId,
  PublicAgentControlReadModel,
  PublicEffectiveLearningSummary,
  PublicMaintenanceProposalControl,
  PublicMaintenanceSessionStatus,
  PublicWorldbookRepairControl,
  PublicPromptPreferenceToken,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  EFFECTIVE_LEARNING_READ_MODEL_VERSION,
  PUBLIC_BRANCH_ACTION_TAGS,
  PUBLIC_PROMPT_PREFERENCE_TOKENS,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  LEARNING_HYDRATION_VERSION,
  type LearningHydrationSnapshot,
} from '../../packages/agent-policy/src/learning-hydration.ts';
import {
  AGENT_ROLLOUT_THRESHOLDS,
  evaluateAgentLaneRollout,
  type AgentLaneEvidence,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import { agentAdmissionAllowsSession, parseAgentAdmissionRuntimeConfig } from './agent-admission-runtime-config.ts';
import type { AgentAdmissionLedger, AgentRuntimeLeaseRow } from './agent-admission-ledger.ts';
import { buildAgentControlReadModel, type AgentCapabilityGate } from './agent-control-read-model.ts';
import type { AgentControlStore } from './agent-control-store.ts';
import type { StyleProposal } from '../../packages/core/src/learned-style-store.ts';
import type { PreferenceLearningEvidenceState } from '../../packages/memory/src/learning-outbox.ts';
import {
  agentLaneRolloutBucketIdentity,
  MANAGED_LOCAL_ROLLOUT_COHORT_VERSION,
  parseAgentLaneRuntimeConfig,
} from './agent-lane-runtime-config.ts';
import { isCanonicalManagedLocalSessionId } from './managed-local-session-scope.ts';
import { contextCompilerAllowsSession, contextCompilerAllowsShadowSession, parseContextCompilerRuntimeConfig } from './context-compiler-runtime-config.ts';
import { parseInteractiveRuntimeConfig } from './interactive-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from './learning-text-runtime-config.ts';
import {
  DEFAULT_MAINTENANCE_DAILY_BUDGET_24H,
  DEFAULT_MAINTENANCE_SESSION_BUDGET_24H,
  maintenanceAdmissionAllowsSession,
  parseMaintenanceAdmissionRuntimeConfig,
} from './maintenance-admission-runtime-config.ts';
import { parseMaintenanceRuntimeConfig } from './maintenance-runtime-config.ts';
import {
  maintenanceApplyAllowsSession,
  maintenanceGuardedAutoAllowsNpcSession,
  maintenanceMemorySummaryApplyMode,
  parseMaintenanceApplyRuntimeConfig,
} from './maintenance-apply-runtime-config.ts';
import type { MaintenanceSettings, MaintenanceTaskKind, PublicMaintenanceJob } from './maintenance-types.ts';
import { FOREGROUND_SUMMARY_POLICY_MARKER } from './agent-runtime-source.ts';
import {
  maintenanceDailyAttemptBudgetSnapshot,
  maintenanceSessionBudgetSnapshot,
} from './maintenance-admission-shadow.ts';

export interface ReadSessionAgentControlInput {
  readonly rawSessionId: string;
  readonly opaqueSessionId: string;
  readonly controlStore: AgentControlStore;
  readonly admissionLedger: AgentAdmissionLedger | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Host-evaluated Canary binding; this read model does not infer Provider authority. */
  readonly contextCompilerCanaryAllowed?: boolean;
  readonly now?: Date;
  readonly allowedActions?: Partial<PublicAgentControlReadModel['allowedActions']>;
  readonly styleProposals?: readonly StyleProposal[];
  readonly preferenceProfile?: PreferenceLearningEvidenceState;
  readonly effectiveLearning?: LearningHydrationSnapshot;
  readonly preferenceSyncState?: 'synced' | 'pending';
  /** Persistent MaintenanceJobManager gate for this exact raw session. */
  readonly maintenanceSettings: MaintenanceSettings;
  /** Legacy display input retained for wire compatibility; it never gates proposal execution. */
  readonly maintenanceTaskActivation?: Readonly<{
    sessionId: string;
    taskKinds: readonly MaintenanceTaskKind[];
  }>;
  /** Backup-bound sessions that may use guarded NPC apply. */
  readonly maintenanceApplyActivationSessions?: ReadonlySet<string>;
  readonly maintenanceProposals?: readonly PublicMaintenanceProposalControl[];
  readonly worldbookRepairProposals?: readonly PublicWorldbookRepairControl[];
  /** Exact-session jobs used only for content-free admission budget diagnostics. */
  readonly maintenanceJobs?: readonly PublicMaintenanceJob[];
}

const PUBLIC_PROMPT_TOKEN_SET = new Set<string>(PUBLIC_PROMPT_PREFERENCE_TOKENS);
const PUBLIC_PROMPT_CONFLICT_SET = new Set<string>(PUBLIC_PROMPT_PREFERENCE_TOKENS.map((token) => (
  token.split('.').slice(0, -1).join('.')
)));
const PUBLIC_BRANCH_ACTION_SET = new Set<string>(PUBLIC_BRANCH_ACTION_TAGS);

function validProfileOwner(
  scope: 'session' | 'card',
  profile: { readonly scope: 'session' | 'card'; readonly sessionId: string | null;
    readonly cardId: string; readonly contentMode: 'nsf' | 'nsfw' },
  snapshot: LearningHydrationSnapshot,
): boolean {
  return profile.scope === scope
    && profile.cardId === snapshot.identity.cardId
    && profile.contentMode === snapshot.identity.contentMode
    && (scope === 'session'
      ? profile.sessionId === snapshot.identity.sessionId
      : profile.sessionId === null);
}

/** Strict privacy adapter: the public shape contains only frozen labels and aggregate counts. */
export function toPublicEffectiveLearningSummary(
  snapshot: LearningHydrationSnapshot,
  expectedSessionId: string,
): PublicEffectiveLearningSummary | null {
  if (snapshot.version !== LEARNING_HYDRATION_VERSION
    || snapshot.identity.sessionId !== expectedSessionId) return null;

  const promptProfile = snapshot.prompt.profile;
  if ((snapshot.prompt.scope === 'none') !== (promptProfile === null)) return null;
  let prompt: PublicEffectiveLearningSummary['prompt'];
  if (!promptProfile) {
    prompt = Object.freeze({
      scope: 'none', sampleCount: 0,
      tagCounts: Object.freeze([]), conflictTags: Object.freeze([]),
    });
  } else {
    if (!validProfileOwner(snapshot.prompt.scope as 'session' | 'card', promptProfile, snapshot)
      || !Number.isSafeInteger(promptProfile.sampleCount) || promptProfile.sampleCount < 1) return null;
    const entries = Object.entries(promptProfile.tagCounts).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > PUBLIC_PROMPT_TOKEN_SET.size || entries.some(([token, count]) => (
      !PUBLIC_PROMPT_TOKEN_SET.has(token) || !Number.isSafeInteger(count) || count < 1
    ))) return null;
    const conflicts = [...promptProfile.conflictTags].sort();
    if (conflicts.length > PUBLIC_PROMPT_CONFLICT_SET.size
      || new Set(conflicts).size !== conflicts.length
      || conflicts.some((tag) => !PUBLIC_PROMPT_CONFLICT_SET.has(tag))) return null;
    prompt = Object.freeze({
      scope: snapshot.prompt.scope,
      sampleCount: promptProfile.sampleCount,
      tagCounts: Object.freeze(entries.map(([token, count]) => Object.freeze({
        token: token as PublicPromptPreferenceToken,
        count,
      }))),
      conflictTags: Object.freeze(conflicts),
    });
  }

  const branchProfile = snapshot.branch.profile;
  if ((snapshot.branch.scope === 'none') !== (branchProfile === null)) return null;
  let branch: PublicEffectiveLearningSummary['branch'];
  if (!branchProfile) {
    branch = Object.freeze({
      scope: 'none', sampleCount: 0, uniqueSelectionCount: 0,
      actionCounts: Object.freeze(PUBLIC_BRANCH_ACTION_TAGS.map((action) => Object.freeze({ action, count: 0 }))),
    });
  } else {
    if (!validProfileOwner(snapshot.branch.scope as 'session' | 'card', branchProfile, snapshot)
      || !Number.isSafeInteger(branchProfile.sampleCount) || branchProfile.sampleCount < 1
      || !Number.isSafeInteger(branchProfile.uniqueSelectionCount) || branchProfile.uniqueSelectionCount < 0
      || branchProfile.uniqueSelectionCount > branchProfile.sampleCount
      || Object.keys(branchProfile.tagCounts).some((tag) => !PUBLIC_BRANCH_ACTION_SET.has(tag))) return null;
    const actionCounts = PUBLIC_BRANCH_ACTION_TAGS.map((action) => Object.freeze({
      action,
      count: branchProfile.tagCounts[action],
    }));
    if (actionCounts.some(({ count }) => !Number.isSafeInteger(count) || count < 0)
      || actionCounts.reduce((sum, entry) => sum + entry.count, 0) !== branchProfile.sampleCount) return null;
    branch = Object.freeze({
      scope: snapshot.branch.scope,
      sampleCount: branchProfile.sampleCount,
      uniqueSelectionCount: branchProfile.uniqueSelectionCount,
      actionCounts: Object.freeze(actionCounts),
    });
  }

  return Object.freeze({ version: EFFECTIVE_LEARNING_READ_MODEL_VERSION, prompt, branch });
}

function disabled(reason: string): AgentCapabilityGate {
  return Object.freeze({ enabled: false, reasonCodes: Object.freeze([reason]) });
}

function enabled(): AgentCapabilityGate {
  return Object.freeze({ enabled: true });
}

/**
 * Keep local approval payloads bounded without hiding the version that is
 * actually active. Older active versions matter for an informed rollback or
 * replacement decision, even after more than five drafts have accumulated.
 */
function styleReviewVersions(proposal: StyleProposal): StyleProposal['versions'] {
  const versions = [...proposal.versions].sort((left, right) => left.version - right.version);
  if (proposal.activeVersion === null) {
    const selected = new Map<number, StyleProposal['versions'][number]>();
    const approval = versions.findLast((version) => version.evaluation.passed);
    if (approval) selected.set(approval.version, approval);
    for (let index = versions.length - 1; index >= 0 && selected.size < 5; index -= 1) {
      const version = versions[index]!;
      selected.set(version.version, version);
    }
    return [...selected.values()].sort((left, right) => left.version - right.version);
  }
  const active = versions.find((version) => version.version === proposal.activeVersion);
  if (!active) return versions.slice(-5);

  const selected = new Map<number, StyleProposal['versions'][number]>([[active.version, active]]);
  const rollback = versions.findLast((version) => (
    version.version < active.version && version.evaluation.passed
  ));
  if (rollback) selected.set(rollback.version, rollback);
  for (let index = versions.length - 1; index >= 0 && selected.size < 5; index -= 1) {
    const version = versions[index]!;
    selected.set(version.version, version);
  }
  return [...selected.values()].sort((left, right) => left.version - right.version);
}

/** Every full review must also have a legal version control entry. */
function styleAvailableVersions(proposal: StyleProposal): StyleProposal['versions'] {
  const versions = [...proposal.versions].sort((left, right) => left.version - right.version);
  const selected = new Map<number, StyleProposal['versions'][number]>(
    styleReviewVersions(proposal).map((version) => [version.version, version]),
  );
  for (let index = versions.length - 1; index >= 0 && selected.size < 20; index -= 1) {
    const version = versions[index]!;
    selected.set(version.version, version);
  }
  return [...selected.values()].sort((left, right) => left.version - right.version);
}

function runtimeLeases(
  ledger: AgentAdmissionLedger | null,
  rawSessionId: string,
  opaqueSessionId: string,
): readonly AgentRuntimeLeaseRow[] {
  if (!ledger) return Object.freeze([]);
  const rows = [
    ...ledger.listLatestRuntimeLeases({ sessionId: opaqueSessionId, limit: 10_000 }),
    ...(rawSessionId === opaqueSessionId
      ? [] : ledger.listLatestRuntimeLeases({ sessionId: rawSessionId, limit: 10_000 })),
  ];
  return Object.freeze([...new Map(rows.map((row) => [row.leaseIdDigest, row])).values()]);
}

/**
 * Projects the two independent Maintenance progress axes without exposing job
 * payloads, evidence digests or conversation content.
 */
export function toPublicMaintenanceSessionStatus(input: {
  readonly rawSessionId: string;
  readonly opaqueSessionId: string;
  readonly jobs: readonly PublicMaintenanceJob[];
  readonly ledger: AgentAdmissionLedger | null;
  readonly runtimeLeases: readonly AgentRuntimeLeaseRow[];
  readonly nowMs: number;
  readonly budgetLimit: number;
  readonly dailyBudgetLimit: number;
}): PublicMaintenanceSessionStatus {
  const budget = maintenanceSessionBudgetSnapshot({
    existingJobs: input.jobs,
    nowMs: input.nowMs,
    limit: input.budgetLimit,
  });
  const attemptBudget = maintenanceDailyAttemptBudgetSnapshot({
    existingJobs: input.jobs,
    nowMs: input.nowMs,
    limit: input.dailyBudgetLimit,
  });
  const decisions = input.ledger ? [
    ...input.ledger.latestMaintenanceBatch(input.rawSessionId),
    ...(input.rawSessionId === input.opaqueSessionId ? []
      : input.ledger.latestMaintenanceBatch(input.opaqueSessionId)),
  ] : [];
  const uniqueDecisions = [...new Map(decisions.map((row) => [row.decisionId, row])).values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.decisionId.localeCompare(right.decisionId));
  const latestDecisionRow = uniqueDecisions.at(-1);
  const latestBatch = latestDecisionRow ? uniqueDecisions.filter((row) => (
    row.createdAt === latestDecisionRow.createdAt
      && row.parentRunId === latestDecisionRow.parentRunId
      && row.round === latestDecisionRow.round
      && row.sourceRevision === latestDecisionRow.sourceRevision
  )) : [];
  const lastDecision = latestDecisionRow ? Object.freeze({
    occurredAt: latestDecisionRow.createdAt,
    round: latestDecisionRow.round,
    admitted: latestBatch.some((row) => row.decision.verdict === 'would-admit'),
    reasonCodes: Object.freeze([...new Set(latestBatch.flatMap((row) => row.decision.reasonCodes))]),
  }) : null;

  const latestSettlement = [...input.runtimeLeases]
    .filter((row) => row.lane === 'maintenance'
      && !(row.taskKind === 'rolling_summary'
        && row.policyVersion.includes(FOREGROUND_SUMMARY_POLICY_MARKER)))
    .sort((left, right) => left.finishedAt.localeCompare(right.finishedAt)
      || left.leaseIdDigest.localeCompare(right.leaseIdDigest)).at(-1);
  return Object.freeze({
    budget: Object.freeze({
      used: budget.used,
      limit: budget.limit,
      remaining: budget.remaining,
      nextSlotAt: budget.nextSlotAt,
    }),
    attemptBudget: Object.freeze({
      used: attemptBudget.used,
      limit: attemptBudget.limit,
      remaining: attemptBudget.remaining,
      nextSlotAt: attemptBudget.nextSlotAt,
    }),
    lastDecision,
    lastSettlement: latestSettlement ? Object.freeze({
      occurredAt: latestSettlement.finishedAt,
      qualifying: latestSettlement.outcome === 'completed'
        && latestSettlement.authorizationCallsUsed > 0,
      outcome: latestSettlement.outcome,
      reasonCode: latestSettlement.reasonCode ?? null,
    }) : null,
  });
}

/** Read-only composition: never changes desired state, kill state, windows, evaluations or samples. */
export function readSessionAgentControl(input: ReadSessionAgentControlInput): PublicAgentControlReadModel {
  const env = input.env ?? process.env;
  const generatedAt = input.now ?? new Date();
  let laneRuntime;
  try { laneRuntime = parseAgentLaneRuntimeConfig(env); } catch {
    laneRuntime = {
      managed: true,
      ceilings: { interactive: 'off', learning: 'off', maintenance: 'off' },
      cohort: 'per-session',
    } as const;
  }
  const lanes = ['interactive', 'learning', 'maintenance'] as const;
  const laneEvidence = Object.freeze(Object.fromEntries(
    lanes.map((lane) => [lane, input.controlStore.evidence(lane)]),
  ) as Record<AgentRolloutLane, AgentLaneEvidence>);
  const laneDecisions = Object.freeze(Object.fromEntries(
    lanes.map((lane: AgentRolloutLane) => {
      const current = input.controlStore.get(lane);
      const desiredState = laneRuntime.managed
        ? current.desiredState : current.desiredState === 'killed' ? 'killed' : 'on';
      const hostCeiling = laneRuntime.managed ? laneRuntime.ceilings[lane] : 'on';
      return [lane, evaluateAgentLaneRollout({
        lane,
        sessionId: agentLaneRolloutBucketIdentity(
          laneRuntime,
          input.rawSessionId,
          input.opaqueSessionId,
        ),
        desiredState,
        hostCeiling,
        evidence: laneEvidence[lane],
      })];
    }),
  ) as Record<AgentRolloutLane, ReturnType<typeof evaluateAgentLaneRollout>>);
  const laneVerification = Object.freeze(Object.fromEntries(lanes.map((lane) => {
    const evidence = laneEvidence[lane];
    return [lane, Object.freeze({
      qualifyingSamples: evidence.authorizationWindowQualifyingSamples ?? evidence.qualifyingSamples,
      requiredQualifyingSamples: AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples,
      // Failed Provider attempts consume the same finite authorization window as successful calls.
      consumedProviderCalls: (evidence.authorizationWindowCalls ?? evidence.providerCalls)
        + (evidence.authorizationWindowProviderErrors ?? evidence.providerErrors),
      reservedProviderCalls: evidence.authorizationWindowReservedCalls ?? 0,
      maxProviderCalls: evidence.authorizationWindowMaxCalls
        ?? input.controlStore.authorizationWindow(lane).maxProviderCalls,
    })];
  })) as NonNullable<Parameters<typeof buildAgentControlReadModel>[0]['laneVerification']>);
  const controlRevisions = Object.freeze(Object.fromEntries(
    lanes.map((lane) => [
      lane, input.controlStore.get(lane).revision,
    ]),
  ) as Record<AgentRolloutLane, string>);
  const laneKillReasons = Object.freeze(Object.fromEntries(
    lanes.map((lane) => [
      lane, input.controlStore.get(lane).killedReason,
    ]),
  ) as Record<AgentRolloutLane, string | null>);
  const capabilityControls = Object.freeze(Object.fromEntries(
    input.controlStore.capabilityControls().map((control) => [control.capabilityId, control]),
  ) as Record<AgentSubcapabilityId, ReturnType<AgentControlStore['capabilityControl']>>);

  let admissionAllowed = false;
  let admissionReason = 'agent-admission-off';
  try {
    const admission = parseAgentAdmissionRuntimeConfig(env);
    admissionAllowed = agentAdmissionAllowsSession(admission, input.rawSessionId);
    admissionReason = admission.executionEnabled ? 'agent-session-not-allowed' : `agent-admission-${admission.mode}`;
  } catch { admissionReason = 'agent-admission-config-invalid'; }

  let interactiveEnabled = false;
  let hasVariablePolicy = false;
  let interactiveReason = 'interactive-runtime-off';
  try {
    const interactive = parseInteractiveRuntimeConfig(env);
    interactiveEnabled = interactive.enabled;
    hasVariablePolicy = interactive.variableSpecs.length > 0;
    interactiveReason = interactive.enabled ? 'interactive-variable-policy-empty' : `interactive-runtime-${interactive.lane}`;
  } catch { interactiveReason = 'interactive-runtime-config-invalid'; }

  let preferenceEnabled = false;
  let styleEnabled = false;
  let learningReason = 'learning-text-off';
  try {
    const learning = parseLearningTextRuntimeConfig(env);
    preferenceEnabled = learning.preferenceEnabled;
    styleEnabled = learning.styleEnabled;
    learningReason = `learning-text-${learning.mode}`;
  } catch { learningReason = 'learning-text-config-invalid'; }

  let compilerEnabled = false;
  let compilerReason = 'context-compiler-off';
  try {
    const compiler = parseContextCompilerRuntimeConfig(env);
    compilerEnabled = compiler.mode === 'canary'
      ? input.contextCompilerCanaryAllowed === true && compiler.canaryScope?.sessionId === input.rawSessionId
      : contextCompilerAllowsSession(compiler, input.rawSessionId);
    compilerReason = contextCompilerAllowsShadowSession(compiler, input.rawSessionId)
      ? 'context-compiler-shadow-observation-only'
      : compiler.mode === 'canary' && compiler.canaryScope?.sessionId === input.rawSessionId
        ? 'context-compiler-canary-binding-unavailable'
        : compiler.enabled ? 'context-compiler-session-not-allowed' : 'context-compiler-off';
  } catch { compilerReason = 'context-compiler-config-invalid'; }

  let maintenanceEnabled = false;
  let maintenanceReason = 'maintenance-off';
  let maintenanceSessionBudgetLimit: number = DEFAULT_MAINTENANCE_SESSION_BUDGET_24H;
  let maintenanceDailyBudgetLimit: number = DEFAULT_MAINTENANCE_DAILY_BUDGET_24H;
  try {
    const runtime = parseMaintenanceRuntimeConfig(env);
    const admission = parseMaintenanceAdmissionRuntimeConfig(env);
    maintenanceSessionBudgetLimit = admission.sessionBudgetLimit;
    maintenanceDailyBudgetLimit = admission.dailyBudgetLimit;
    const admitted = maintenanceAdmissionAllowsSession(admission, input.rawSessionId);
    const persisted = input.maintenanceSettings;
    // Derive the effective value from both persisted switches here as well as in the manager.
    // This keeps the public reason deterministic even if a non-production caller supplies an
    // internally inconsistent aggregate.
    maintenanceEnabled = runtime.enabled && admitted
      && persisted.globalEnabled && persisted.sessionEnabled;
    maintenanceReason = !runtime.enabled ? 'maintenance-runtime-off'
      : !admitted ? (admission.executionEnabled
        ? 'maintenance-session-not-allowed' : `maintenance-admission-${admission.mode}`)
        : !persisted.globalEnabled ? 'maintenance-persisted-global-disabled'
          : !persisted.sessionEnabled ? 'maintenance-persisted-session-disabled'
            : 'maintenance-enabled';
  } catch { maintenanceReason = 'maintenance-config-invalid'; }

  let maintenanceApplyMode: 'off' | 'manual-approval' | 'guarded-auto' = 'off';
  let maintenanceAutoApplyScope:
    | 'none'
    | 'safe-memory-summary'
    | 'safe-npc-facts'
    | 'low-risk-maintenance' = 'none';
  let guardedNpcWriteConfigured = false;
  let guardedMemorySummaryWriteConfigured = false;
  try {
    const apply = parseMaintenanceApplyRuntimeConfig(env, {
      npcActivationSessions: input.maintenanceApplyActivationSessions,
    });
    guardedNpcWriteConfigured = apply.mode === 'guarded-auto'
      && maintenanceGuardedAutoAllowsNpcSession(apply, input.rawSessionId);
    guardedMemorySummaryWriteConfigured = apply.mode === 'guarded-auto'
      && maintenanceMemorySummaryApplyMode(
        apply, input.rawSessionId, 'memory_consolidation',
      ) === 'apply';
    const manualApprovalActive = maintenanceApplyAllowsSession(apply, input.rawSessionId);
    if (guardedNpcWriteConfigured || guardedMemorySummaryWriteConfigured) {
      maintenanceApplyMode = 'guarded-auto';
      maintenanceAutoApplyScope = guardedNpcWriteConfigured && guardedMemorySummaryWriteConfigured
        ? 'low-risk-maintenance'
        : guardedNpcWriteConfigured ? 'safe-npc-facts' : 'safe-memory-summary';
    }
    else if (manualApprovalActive) maintenanceApplyMode = 'manual-approval';
  } catch { maintenanceApplyMode = 'off'; }

  const maintenanceExecutionActive = maintenanceEnabled && laneDecisions.maintenance.allowed;
  // Backup activation is an apply-time credential, never an execution gate.
  // NPC shadow proposals use the same lane/capability boundary as other typed
  // Maintenance proposals and may therefore exist while formal writes stay off.
  const maintenanceTaskActive = (_taskKind: MaintenanceTaskKind): boolean => maintenanceExecutionActive;
  const maintenanceTaskReason = (_taskKind: MaintenanceTaskKind): string => maintenanceReason;
  const npcExecutionActive = maintenanceTaskActive('npc_state');
  const worldbookExecutionActive = maintenanceTaskActive('worldbook_repair');
  const anyMaintenanceExecutionActive = [
    'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state', 'worldbook_repair',
  ].some((taskKind) => maintenanceTaskActive(taskKind as MaintenanceTaskKind));

  const preludeAllowed = admissionAllowed && interactiveEnabled;
  const gates: Partial<Record<AgentSubcapabilityId, AgentCapabilityGate>> = {
    'interactive.prelude': preludeAllowed ? enabled() : disabled(!admissionAllowed ? admissionReason : interactiveReason),
    'interactive.director': preludeAllowed ? enabled() : disabled(!admissionAllowed ? admissionReason : interactiveReason),
    'interactive.critic': admissionAllowed ? enabled() : disabled(admissionReason),
    'interactive.variableProposal': preludeAllowed
      ? (hasVariablePolicy ? enabled() : { enabled: true, reasonCodes: Object.freeze(['interactive-variable-advisory-only']) })
      : disabled(!admissionAllowed ? admissionReason : interactiveReason),
    'interactive.aqlReplan': admissionAllowed ? enabled() : disabled(admissionReason),
    'learning.preference': admissionAllowed && preferenceEnabled
      ? enabled() : disabled(!admissionAllowed ? admissionReason : learningReason),
    'learning.branchPreference': admissionAllowed && preferenceEnabled
      ? enabled() : disabled(!admissionAllowed ? admissionReason : learningReason),
    'learning.styleCompile': admissionAllowed && styleEnabled
      ? enabled() : disabled(!admissionAllowed ? admissionReason : learningReason),
    'maintenance.memory': maintenanceTaskActive('memory_consolidation')
      ? enabled() : disabled(maintenanceTaskReason('memory_consolidation')),
    'maintenance.branchIndex': maintenanceTaskActive('branch_index')
      ? enabled() : disabled(maintenanceTaskReason('branch_index')),
    'maintenance.arc': maintenanceTaskActive('branch_index')
      ? enabled() : disabled(maintenanceTaskReason('branch_index')),
    'maintenance.npc': npcExecutionActive
      ? enabled() : disabled(maintenanceTaskReason('npc_state')),
    'maintenance.worldbook': worldbookExecutionActive
      ? enabled() : disabled(maintenanceTaskReason('worldbook_repair')),
    'context.compiler': compilerEnabled ? enabled() : disabled(compilerReason),
  };
  const effectiveLearning = input.preferenceSyncState === 'pending' || input.effectiveLearning === undefined
    ? null : toPublicEffectiveLearningSummary(input.effectiveLearning, input.opaqueSessionId);
  const sessionRuntimeLeases = runtimeLeases(
    input.admissionLedger, input.rawSessionId, input.opaqueSessionId,
  );
  const maintenanceSession = input.maintenanceJobs === undefined ? undefined
    : toPublicMaintenanceSessionStatus({
        rawSessionId: input.rawSessionId,
        opaqueSessionId: input.opaqueSessionId,
        jobs: input.maintenanceJobs,
        ledger: input.admissionLedger,
        runtimeLeases: sessionRuntimeLeases,
        nowMs: generatedAt.getTime(),
        budgetLimit: maintenanceSessionBudgetLimit,
        dailyBudgetLimit: maintenanceDailyBudgetLimit,
      });
  return {
    ...buildAgentControlReadModel({
    sessionId: input.opaqueSessionId,
    generatedAt,
    laneDecisions,
    ...(laneRuntime.cohort === MANAGED_LOCAL_ROLLOUT_COHORT_VERSION
      && isCanonicalManagedLocalSessionId(input.rawSessionId)
      ? { rolloutCohortScope: 'managed-local' as const } : {}),
    laneKillReasons,
    controlRevisions,
    capabilityControls,
    laneVerification,
    runtimeLeases: sessionRuntimeLeases,
    ...(maintenanceSession === undefined ? {} : { maintenanceSession }),
    gates,
    allowedActions: input.allowedActions,
    }),
    ...(input.styleProposals === undefined ? {} : {
      // Scope filtering lives in the server read composer so callers cannot
      // accidentally expose another session or a legacy unscoped proposal.
      styleProposals: Object.freeze(input.styleProposals.filter((proposal) => (
        proposal.scope?.sessionId === input.opaqueSessionId
      )).sort((left, right) => right.revision.localeCompare(left.revision)).slice(0, 20)
        .map((proposal) => Object.freeze({
          id: proposal.id,
          status: proposal.status,
          activeVersion: proposal.activeVersion,
          availableVersions: Object.freeze(styleAvailableVersions(proposal)
            .map((version) => version.version)),
          // Full bodies are useful for local approval but comparatively large. Keep
          // at most five review documents while retaining a usable approval or
          // rollback candidate, the active version, and the newest alternatives.
          // Keep up to 20 version IDs and include every projected review target.
          reviewVersions: Object.freeze(styleReviewVersions(proposal).map((version) => Object.freeze({
            version: version.version,
            name: version.draft.name,
            description: version.draft.description,
            keywords: Object.freeze([...version.draft.keywords]),
            body: version.draft.body,
            createdAt: version.createdAt,
            model: version.model,
            policyVersion: version.policyVersion,
            evaluation: Object.freeze({
              passed: version.evaluation.passed,
              score: version.evaluation.score,
              checks: Object.freeze([...version.evaluation.checks]),
              failedChecks: Object.freeze([...version.evaluation.failedChecks]),
            }),
          }))),
          revision: proposal.revision,
        }))),
    }),
    ...(input.preferenceProfile === undefined ? {} : {
      preferenceProfile: Object.freeze({
        revision: input.preferenceProfile.revision,
        sampleCount: input.preferenceProfile.sampleCount,
      }),
    }),
    ...(effectiveLearning === null ? {} : { effectiveLearning }),
    ...(input.preferenceSyncState === undefined ? {} : {
      preferenceSyncState: input.preferenceSyncState,
    }),
    ...(input.maintenanceProposals === undefined ? {} : {
      maintenanceProposals: Object.freeze(input.maintenanceProposals.map((proposal) => Object.freeze({ ...proposal }))),
    }),
    maintenanceRuntime: Object.freeze({
      proposalGeneration: anyMaintenanceExecutionActive ? 'typed-proposals' : 'off',
      applyMode: maintenanceApplyMode,
      automaticWriteActive: maintenanceApplyMode === 'guarded-auto'
        && (
          (guardedNpcWriteConfigured && npcExecutionActive
            && capabilityControls['maintenance.npc'].killedReason === null)
          || (guardedMemorySummaryWriteConfigured
            && maintenanceTaskActive('memory_consolidation')
            && capabilityControls['maintenance.memory'].killedReason === null)
        ),
      autoApplyScope: maintenanceAutoApplyScope,
    }),
    ...(input.worldbookRepairProposals === undefined ? {} : {
      worldbookRepairProposals: Object.freeze(
        input.worldbookRepairProposals.slice(0, 50).map((proposal) => Object.freeze({ ...proposal })),
      ),
    }),
  };
}
