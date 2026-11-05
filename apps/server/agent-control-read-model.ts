import {
  AGENT_CONTROL_READ_MODEL_VERSION,
  AGENT_SUBCAPABILITY_IDS,
  type AgentControlAllowedActions,
  type AgentSubcapabilityId,
  type PublicAgentControlReadModel,
  type PublicAgentRolloutLane,
  type PublicAgentSubcapability,
  type PublicAgentVerificationProgress,
  type PublicMaintenanceSessionStatus,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  AGENT_LANE_QUALITY_KILL_REASONS,
  AGENT_LANE_PERMANENT_KILL_REASONS,
  type AgentLaneDecision,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import type { AgentRuntimeLeaseRow } from './agent-admission-ledger.ts';
import type { AgentCapabilityControlRow } from './agent-control-store.ts';
import { FOREGROUND_SUMMARY_POLICY_MARKER } from './agent-runtime-source.ts';

interface CapabilityBinding {
  readonly lane: PublicAgentRolloutLane;
  readonly taskKinds: readonly AgentRuntimeLeaseRow['taskKind'][];
  readonly attribution: 'exclusive' | 'shared';
  readonly policyIncludes?: string;
  readonly policyExcludes?: readonly string[];
}

const BINDINGS: Readonly<Record<AgentSubcapabilityId, CapabilityBinding>> = Object.freeze({
  'interactive.prelude': { lane: 'interactive', taskKinds: ['interactive_prelude'], attribution: 'shared' },
  'interactive.director': { lane: 'interactive', taskKinds: ['interactive_prelude'], attribution: 'shared' },
  'interactive.critic': { lane: 'interactive', taskKinds: ['critic_revision'], attribution: 'exclusive' },
  'interactive.variableProposal': { lane: 'interactive', taskKinds: ['interactive_prelude'], attribution: 'shared' },
  'interactive.aqlReplan': { lane: 'interactive', taskKinds: ['aql_replan'], attribution: 'exclusive' },
  'learning.preference': {
    lane: 'learning', taskKinds: ['preference_extract'], attribution: 'exclusive', policyIncludes: 'preference-v1',
  },
  'learning.branchPreference': {
    lane: 'learning', taskKinds: ['preference_extract'], attribution: 'exclusive', policyIncludes: 'branch-semantic',
  },
  'learning.styleCompile': {
    lane: 'learning', taskKinds: ['style_compile', 'skill_compile', 'skill_evaluate', 'skill_sample', 'skill_quality'],
    attribution: 'exclusive',
  },
  'maintenance.memory': {
    lane: 'maintenance', taskKinds: ['memory_consolidation', 'rolling_summary'], attribution: 'exclusive',
    policyExcludes: [FOREGROUND_SUMMARY_POLICY_MARKER],
  },
  // branch_index is the persisted compatibility taskKind that executes Arc maintenance.
  // Both rows intentionally share its lease metrics; they must never be summed as two calls.
  'maintenance.branchIndex': { lane: 'maintenance', taskKinds: ['branch_index'], attribution: 'shared' },
  'maintenance.arc': { lane: 'maintenance', taskKinds: ['branch_index'], attribution: 'shared' },
  'maintenance.npc': {
    lane: 'maintenance', taskKinds: ['npc_state'], attribution: 'exclusive',
  },
  // 世界书修正提案：只产提案，落地必须经人工审批（approve → apply）。
  'maintenance.worldbook': {
    lane: 'maintenance', taskKinds: ['worldbook_repair'], attribution: 'exclusive',
  },
  'context.compiler': { lane: 'interactive', taskKinds: ['context_compiler'], attribution: 'exclusive' },
});

export interface AgentCapabilityGate {
  readonly enabled: boolean;
  readonly reasonCodes?: readonly string[];
  readonly proposalDigest?: string | null;
}

export interface BuildAgentControlReadModelInput {
  readonly sessionId: string;
  readonly generatedAt?: Date;
  readonly laneDecisions: Readonly<Record<PublicAgentRolloutLane, AgentLaneDecision>>;
  readonly rolloutCohortScope?: PublicAgentSubcapability['rolloutCohortScope'];
  /** Needed when a task-local quality escalator stopped a Lane directly. */
  readonly laneKillReasons?: Readonly<Record<PublicAgentRolloutLane, string | null>>;
  readonly controlRevisions: Readonly<Record<PublicAgentRolloutLane, string>>;
  readonly capabilityControls: Readonly<Record<AgentSubcapabilityId, AgentCapabilityControlRow>>;
  readonly runtimeLeases: readonly AgentRuntimeLeaseRow[];
  /** Current operator-authorized verification window, shared by capabilities in each Lane. */
  readonly laneVerification?: Readonly<Record<PublicAgentRolloutLane, PublicAgentVerificationProgress>>;
  /** Exact-session diagnostics, kept distinct from the shared Lane verification window. */
  readonly maintenanceSession?: PublicMaintenanceSessionStatus;
  readonly gates?: Partial<Readonly<Record<AgentSubcapabilityId, AgentCapabilityGate>>>;
  readonly allowedActions?: Partial<AgentControlAllowedActions>;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)]!;
}

function rowsFor(
  binding: CapabilityBinding,
  rows: readonly AgentRuntimeLeaseRow[],
): readonly AgentRuntimeLeaseRow[] {
  return rows.filter((row) => binding.taskKinds.includes(row.taskKind)
    && (!binding.policyIncludes || row.policyVersion.includes(binding.policyIncludes))
    && !(binding.policyExcludes ?? []).some((marker) => row.policyVersion.includes(marker)));
}

function metrics(binding: CapabilityBinding, rows: readonly AgentRuntimeLeaseRow[]): PublicAgentSubcapability['metrics'] {
  const selected = rowsFor(binding, rows);
  return Object.freeze({
    attribution: binding.attribution,
    sourceTaskKinds: Object.freeze([...binding.taskKinds]),
    leases: selected.length,
    modelCalls: selected.reduce((sum, row) => sum + row.modelCallsUsed, 0),
    successfulLeases: selected.filter((row) => row.outcome === 'completed' && row.modelCallsUsed > 0).length,
    budgetFailures: selected.filter((row) => row.outcome === 'budget_exhausted').length,
    providerFailures: selected.filter((row) => row.outcome === 'provider_error' || row.outcome === 'usage_unavailable').length,
    p50LatencyMs: percentile(selected.map((row) => row.wallMsUsed), 0.50),
    p95LatencyMs: percentile(selected.map((row) => row.wallMsUsed), 0.95),
    inputTokens: selected.reduce((sum, row) => sum + row.inputTokensUsed, 0),
    outputTokens: selected.reduce((sum, row) => sum + row.outputTokensUsed, 0),
    costMicrousd: selected.reduce((sum, row) => sum + row.costMicrousdUsed, 0),
  });
}

const DEFAULT_ACTIONS: AgentControlAllowedActions = Object.freeze({
  canChangeLane: false,
  canKill: false,
  canClearKill: false,
  canClearProfile: false,
  canApprove: false,
  canRollback: false,
});

/** Builds a content-free operational view. Caller must pass only leases for this opaque session. */
export function buildAgentControlReadModel(input: BuildAgentControlReadModelInput): PublicAgentControlReadModel {
  if (typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > 240) {
    throw new Error('agent-read-model-session-invalid');
  }
  const capabilities = AGENT_SUBCAPABILITY_IDS.map((id): PublicAgentSubcapability => {
    const binding = BINDINGS[id];
    const decision = input.laneDecisions[binding.lane];
    const gate = input.gates?.[id] ?? { enabled: true };
    const selected = rowsFor(binding, input.runtimeLeases);
    const recent = [...selected].sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0];
    const capabilityControl = input.capabilityControls[id];
    const capabilityKilled = capabilityControl.killedReason !== null;
    const capabilityQualityStopped = capabilityControl.killedReason === 'maintenance-protocol-invalid';
    const persistedLaneReason = input.laneKillReasons?.[binding.lane] ?? null;
    const persistedLaneQualityStopped = persistedLaneReason !== null
      && AGENT_LANE_QUALITY_KILL_REASONS.includes(
        persistedLaneReason as (typeof AGENT_LANE_QUALITY_KILL_REASONS)[number],
      );
    const persistedLaneSafetyStopped = persistedLaneReason !== null
      && AGENT_LANE_PERMANENT_KILL_REASONS.includes(
        persistedLaneReason as (typeof AGENT_LANE_PERMANENT_KILL_REASONS)[number],
      );
    const effectiveState = capabilityKilled ? 'killed' : gate.enabled ? decision.effectiveState : 'off';
    const policySafetyStop = decision.shouldKill && decision.reasonCodes.some((reason) => (
      AGENT_LANE_PERMANENT_KILL_REASONS.includes(
        reason as (typeof AGENT_LANE_PERMANENT_KILL_REASONS)[number],
      )
    ));
    const stopSource = capabilityKilled
      ? capabilityQualityStopped ? 'capability-quality' as const : 'capability-operator' as const
      : decision.shouldKill
        ? policySafetyStop ? 'policy-safety' as const : 'policy-quality' as const
        : persistedLaneSafetyStopped ? 'policy-safety' as const
          : persistedLaneQualityStopped ? 'policy-quality' as const
        : decision.effectiveState !== 'killed'
          ? 'none' as const
          : decision.hostCeiling === 'killed' && decision.desiredState !== 'killed'
            ? 'host-ceiling' as const
            : 'lane-operator' as const;
    const gateReasons = gate.reasonCodes ?? [];
    const rolloutStopped = stopSource !== 'none' && stopSource !== 'capability-operator';
    const recentReasons = capabilityKilled
      ? [capabilityControl.killedReason!, 'capability-killed']
      : rolloutStopped ? (persistedLaneReason
        ? [persistedLaneReason, ...decision.reasonCodes.filter((reason) => reason !== persistedLaneReason)]
        : decision.reasonCodes)
        : gateReasons.length > 0 ? gateReasons
          : !decision.allowed ? decision.reasonCodes
            : recent?.reasonCode ? [recent.reasonCode]
              : recent ? [`lease-${recent.outcome}`] : decision.reasonCodes;
    return Object.freeze({
      id,
      rolloutLane: binding.lane,
      hostCeiling: decision.hostCeiling,
      effectiveState,
      allowed: !capabilityKilled && gate.enabled && decision.allowed,
      sessionScope: 'current',
      bucket: decision.bucket,
      ...(input.rolloutCohortScope === undefined ? {} : { rolloutCohortScope: input.rolloutCohortScope }),
      recentReasonCodes: Object.freeze([...recentReasons]),
      killReason: capabilityControl.killedReason
        ?? (rolloutStopped ? persistedLaneReason : null)
        ?? (rolloutStopped ? decision.reasonCodes.find((reason) => reason !== 'lane-killed')
          ?? (stopSource === 'host-ceiling' ? 'host-ceiling-killed' : 'lane-killed') : null),
      stopSource,
      capabilityKilled,
      proposalDigest: gate.proposalDigest ?? null,
      controlRevision: input.controlRevisions[binding.lane],
      capabilityRevision: capabilityControl.revision,
      ...(input.laneVerification === undefined ? {} : {
        verification: Object.freeze({ ...input.laneVerification[binding.lane] }),
      }),
      metrics: metrics(binding, input.runtimeLeases),
    });
  });
  return Object.freeze({
    schemaVersion: AGENT_CONTROL_READ_MODEL_VERSION,
    sessionId: input.sessionId,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    capabilities: Object.freeze(capabilities),
    allowedActions: Object.freeze({ ...DEFAULT_ACTIONS, ...input.allowedActions }),
    ...(input.maintenanceSession === undefined ? {} : {
      maintenanceSession: Object.freeze({
        budget: Object.freeze({ ...input.maintenanceSession.budget }),
        attemptBudget: Object.freeze({ ...input.maintenanceSession.attemptBudget }),
        lastDecision: input.maintenanceSession.lastDecision === null ? null : Object.freeze({
          ...input.maintenanceSession.lastDecision,
          reasonCodes: Object.freeze([...input.maintenanceSession.lastDecision.reasonCodes]),
        }),
        lastSettlement: input.maintenanceSession.lastSettlement === null ? null : Object.freeze({
          ...input.maintenanceSession.lastSettlement,
        }),
      }),
    }),
  });
}
