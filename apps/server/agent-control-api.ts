import type {
  AgentSubcapabilityId,
  PublicAgentControlReadModel,
  PublicEffectiveLearningSummary,
  PublicMaintenanceProposalControl,
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
import { evaluateAgentLaneRollout, type AgentRolloutLane } from '../../packages/agent-policy/src/lane-rollout.ts';
import { agentAdmissionAllowsSession, parseAgentAdmissionRuntimeConfig } from './agent-admission-runtime-config.ts';
import type { AgentAdmissionLedger, AgentRuntimeLeaseRow } from './agent-admission-ledger.ts';
import { buildAgentControlReadModel, type AgentCapabilityGate } from './agent-control-read-model.ts';
import type { AgentControlStore } from './agent-control-store.ts';
import type { StyleProposal } from '../../packages/core/src/learned-style-store.ts';
import type { PreferenceLearningEvidenceState } from '../../packages/memory/src/learning-outbox.ts';
import { parseAgentLaneRuntimeConfig } from './agent-lane-runtime-config.ts';
import { contextCompilerAllowsSession, parseContextCompilerRuntimeConfig } from './context-compiler-runtime-config.ts';
import { parseInteractiveRuntimeConfig } from './interactive-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from './learning-text-runtime-config.ts';
import { maintenanceAdmissionAllowsSession, parseMaintenanceAdmissionRuntimeConfig } from './maintenance-admission-runtime-config.ts';
import { parseMaintenanceRuntimeConfig } from './maintenance-runtime-config.ts';

export interface ReadSessionAgentControlInput {
  readonly rawSessionId: string;
  readonly opaqueSessionId: string;
  readonly controlStore: AgentControlStore;
  readonly admissionLedger: AgentAdmissionLedger | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly allowedActions?: Partial<PublicAgentControlReadModel['allowedActions']>;
  readonly styleProposals?: readonly StyleProposal[];
  readonly preferenceProfile?: PreferenceLearningEvidenceState;
  readonly effectiveLearning?: LearningHydrationSnapshot;
  readonly preferenceSyncState?: 'synced' | 'pending';
  readonly maintenanceProposals?: readonly PublicMaintenanceProposalControl[];
  readonly worldbookRepairProposals?: readonly PublicWorldbookRepairControl[];
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

function runtimeLeases(
  ledger: AgentAdmissionLedger | null,
  rawSessionId: string,
  opaqueSessionId: string,
): readonly AgentRuntimeLeaseRow[] {
  if (!ledger) return Object.freeze([]);
  const rows = [
    ...ledger.listRuntimeLeases({ sessionId: opaqueSessionId, limit: 10_000 }),
    ...(rawSessionId === opaqueSessionId ? [] : ledger.listRuntimeLeases({ sessionId: rawSessionId, limit: 10_000 })),
  ];
  return Object.freeze([...new Map(rows.map((row) => [row.leaseIdDigest, row])).values()]);
}

/** Read-only composition: never changes desired state, kill state, windows, evaluations or samples. */
export function readSessionAgentControl(input: ReadSessionAgentControlInput): PublicAgentControlReadModel {
  const env = input.env ?? process.env;
  let laneRuntime;
  try { laneRuntime = parseAgentLaneRuntimeConfig(env); } catch {
    laneRuntime = { managed: true, ceilings: { interactive: 'off', learning: 'off', maintenance: 'off' } } as const;
  }
  const laneDecisions = Object.freeze(Object.fromEntries(
    (['interactive', 'learning', 'maintenance'] as const).map((lane: AgentRolloutLane) => {
      const current = input.controlStore.get(lane);
      const desiredState = laneRuntime.managed
        ? current.desiredState : current.desiredState === 'killed' ? 'killed' : 'on';
      const hostCeiling = laneRuntime.managed ? laneRuntime.ceilings[lane] : 'on';
      return [lane, evaluateAgentLaneRollout({
        lane, sessionId: input.opaqueSessionId, desiredState, hostCeiling,
        evidence: input.controlStore.evidence(lane),
      })];
    }),
  ) as Record<AgentRolloutLane, ReturnType<typeof evaluateAgentLaneRollout>>);
  const controlRevisions = Object.freeze(Object.fromEntries(
    (['interactive', 'learning', 'maintenance'] as const).map((lane) => [
      lane, input.controlStore.get(lane).revision,
    ]),
  ) as Record<AgentRolloutLane, string>);
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
    compilerEnabled = contextCompilerAllowsSession(compiler, input.rawSessionId);
    compilerReason = compiler.enabled ? 'context-compiler-session-not-allowed' : 'context-compiler-off';
  } catch { compilerReason = 'context-compiler-config-invalid'; }

  let maintenanceEnabled = false;
  let maintenanceReason = 'maintenance-off';
  try {
    const runtime = parseMaintenanceRuntimeConfig(env);
    const admission = parseMaintenanceAdmissionRuntimeConfig(env);
    maintenanceEnabled = runtime.enabled && maintenanceAdmissionAllowsSession(admission, input.rawSessionId);
    maintenanceReason = !runtime.enabled ? 'maintenance-runtime-off'
      : admission.executionEnabled ? 'maintenance-session-not-allowed' : `maintenance-admission-${admission.mode}`;
  } catch { maintenanceReason = 'maintenance-config-invalid'; }

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
    'maintenance.memory': maintenanceEnabled ? enabled() : disabled(maintenanceReason),
    'maintenance.branchIndex': maintenanceEnabled ? enabled() : disabled(maintenanceReason),
    'maintenance.arc': maintenanceEnabled ? enabled() : disabled(maintenanceReason),
    'maintenance.npc': maintenanceEnabled ? enabled() : disabled(maintenanceReason),
    'context.compiler': compilerEnabled ? enabled() : disabled(compilerReason),
  };
  const effectiveLearning = input.preferenceSyncState === 'pending' || input.effectiveLearning === undefined
    ? null : toPublicEffectiveLearningSummary(input.effectiveLearning, input.opaqueSessionId);
  return {
    ...buildAgentControlReadModel({
    sessionId: input.opaqueSessionId,
    generatedAt: input.now,
    laneDecisions,
    controlRevisions,
    capabilityControls,
    runtimeLeases: runtimeLeases(input.admissionLedger, input.rawSessionId, input.opaqueSessionId),
    gates,
    allowedActions: input.allowedActions,
    }),
    ...(input.styleProposals === undefined ? {} : {
      // Scope filtering lives in the server read composer so callers cannot
      // accidentally expose another session or a legacy unscoped proposal.
      styleProposals: Object.freeze(input.styleProposals.filter((proposal) => (
        proposal.scope?.sessionId === input.opaqueSessionId
      )).slice(-50).map((proposal) => Object.freeze({
        id: proposal.id,
        status: proposal.status,
        activeVersion: proposal.activeVersion,
        availableVersions: Object.freeze(proposal.versions.slice(-20).map((version) => version.version)),
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
    ...(input.worldbookRepairProposals === undefined ? {} : {
      worldbookRepairProposals: Object.freeze(
        input.worldbookRepairProposals.slice(0, 50).map((proposal) => Object.freeze({ ...proposal })),
      ),
    }),
  };
}
