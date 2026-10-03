import {
  AGENT_TEST_SESSION_WINDOW_CALLS,
  AGENT_ROLLOUT_LANES,
  narrowAgentRolloutState,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import type { AgentControlStore, AgentLaneControlRow } from './agent-control-store.ts';
import {
  AGENT_LANE_RECOVERY_ACK,
  AGENT_SUBCAPABILITY_IDS,
  type AgentSubcapabilityId,
  type StyleProposalControlMutation,
  type WorldbookRepairControlMutation,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import type { LearnedStyleProposalStore } from '../../packages/core/src/learned-style-store.ts';

export const AGENT_CONTROL_MUTATION_ACK = 'p14-agent-control-mutation-v1' as const;
export { AGENT_LANE_RECOVERY_ACK };

export interface AgentControlMutationRuntimeConfig {
  readonly enabled: boolean;
}

export type AgentControlMutation =
  | {
      readonly operation: 'kill';
      readonly lane: AgentRolloutLane;
      readonly expectedRevision: string;
      readonly reasonCode: string;
    }
  | {
      readonly operation: 'clear-kill';
      readonly lane: AgentRolloutLane;
      readonly expectedRevision: string;
    }
  | {
      readonly operation: 'recover';
      readonly lane: AgentRolloutLane;
      readonly expectedRevision: string;
      readonly evidenceDigest: string;
      readonly maxProviderCalls: number;
      readonly acknowledgement: typeof AGENT_LANE_RECOVERY_ACK;
    }
  | {
      readonly operation: 'downgrade';
      readonly lane: AgentRolloutLane;
      readonly expectedRevision: string;
      readonly desiredState: 'off' | 'shadow';
    }
  | {
      readonly operation: 'kill-capability';
      readonly capabilityId: AgentSubcapabilityId;
      readonly expectedRevision: string;
      readonly reasonCode: string;
    }
  | {
      readonly operation: 'clear-capability-kill';
      readonly capabilityId: AgentSubcapabilityId;
      readonly expectedRevision: string;
    }
  | StyleProposalControlMutation
  | {
      readonly operation: 'clear-preference-profile';
      readonly sessionId: string;
      readonly operationId: string;
      readonly expectedRevision: string;
    }
  | {
      readonly operation: 'approve-maintenance-proposal';
      readonly proposalId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly operation: 'rollback-maintenance-proposal';
      readonly proposalId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly operation: 'reject-maintenance-proposal';
      readonly proposalId: string;
      readonly expectedRevision: number;
      readonly reasonCode: string;
    }
  | WorldbookRepairControlMutation;

const REASON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function parseAgentControlMutationRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentControlMutationRuntimeConfig {
  const mode = env.JG_AGENT_CONTROL_MUTATION?.trim() || 'off';
  if (mode !== 'off' && mode !== 'on') throw new Error('JG_AGENT_CONTROL_MUTATION 必须是 off|on');
  if (mode === 'on' && env.JG_AGENT_CONTROL_MUTATION_ACK?.trim() !== AGENT_CONTROL_MUTATION_ACK) {
    throw new Error(`JG_AGENT_CONTROL_MUTATION=on 需要 JG_AGENT_CONTROL_MUTATION_ACK=${AGENT_CONTROL_MUTATION_ACK}`);
  }
  return Object.freeze({ enabled: mode === 'on' });
}

export function authorizeAgentControlMutation(input: {
  readonly runtime: AgentControlMutationRuntimeConfig;
  readonly authority: string;
  readonly localAuthorities: ReadonlySet<string>;
  readonly accessMode: 'local-only' | 'secured';
  readonly authenticatedAdmin: boolean;
}): Readonly<{ allowed: boolean; reasonCode: string }> {
  if (!input.runtime.enabled) return Object.freeze({ allowed: false, reasonCode: 'agent-control-mutation-disabled' });
  if (!input.localAuthorities.has(input.authority)) {
    return Object.freeze({ allowed: false, reasonCode: 'agent-control-local-authority-required' });
  }
  if (input.accessMode === 'secured' && !input.authenticatedAdmin) {
    return Object.freeze({ allowed: false, reasonCode: 'agent-control-admin-required' });
  }
  return Object.freeze({ allowed: true, reasonCode: 'agent-control-mutation-allowed' });
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('agent-control-mutation-invalid');
  }
}

function lane(value: unknown): AgentRolloutLane {
  if (typeof value !== 'string' || !AGENT_ROLLOUT_LANES.includes(value as AgentRolloutLane)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value as AgentRolloutLane;
}

function revision(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error('agent-control-mutation-invalid');
  return value;
}

function capabilityId(value: unknown): AgentSubcapabilityId {
  if (typeof value !== 'string' || !AGENT_SUBCAPABILITY_IDS.includes(value as AgentSubcapabilityId)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value as AgentSubcapabilityId;
}

function styleProposalId(value: unknown): string {
  if (typeof value !== 'string' || !/^style-[a-f0-9]{20}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function digestRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function preferenceClearOperationId(value: unknown): string {
  if (typeof value !== 'string'
    || !/^pclear:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function maintenanceProposalId(value: unknown): string {
  if (typeof value !== 'string' || !/^mprop_[a-f0-9]{32}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function worldbookRepairProposalId(value: unknown): string {
  if (typeof value !== 'string'
    || !/^wbr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('agent-control-mutation-invalid');
  }
  return value;
}

function integerRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('agent-control-mutation-invalid');
  return Number(value);
}

export function parseAgentControlMutation(value: unknown): AgentControlMutation {
  const row = plainRecord(value);
  if (row.operation === 'kill') {
    exactKeys(row, ['operation', 'lane', 'expectedRevision', 'reasonCode']);
    if (typeof row.reasonCode !== 'string' || !REASON_RE.test(row.reasonCode)) {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: 'kill',
      lane: lane(row.lane),
      expectedRevision: revision(row.expectedRevision),
      reasonCode: row.reasonCode,
    });
  }
  if (row.operation === 'clear-kill') {
    exactKeys(row, ['operation', 'lane', 'expectedRevision']);
    return Object.freeze({
      operation: 'clear-kill',
      lane: lane(row.lane),
      expectedRevision: revision(row.expectedRevision),
    });
  }
  if (row.operation === 'recover') {
    exactKeys(row, [
      'operation', 'lane', 'expectedRevision', 'evidenceDigest',
      'maxProviderCalls', 'acknowledgement',
    ]);
    if (row.acknowledgement !== AGENT_LANE_RECOVERY_ACK) {
      throw new Error('lane-recovery-ack-invalid');
    }
    if (typeof row.evidenceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.evidenceDigest)) {
      throw new Error('lane-recovery-evidence-invalid');
    }
    const recoveryLane = lane(row.lane);
    if (!Number.isSafeInteger(row.maxProviderCalls)
      || Number(row.maxProviderCalls) < 1
      || Number(row.maxProviderCalls) > AGENT_TEST_SESSION_WINDOW_CALLS[recoveryLane]) {
      throw new Error('lane-recovery-max-provider-calls-invalid');
    }
    return Object.freeze({
      operation: 'recover',
      lane: recoveryLane,
      expectedRevision: revision(row.expectedRevision),
      evidenceDigest: row.evidenceDigest,
      maxProviderCalls: Number(row.maxProviderCalls),
      acknowledgement: AGENT_LANE_RECOVERY_ACK,
    });
  }
  if (row.operation === 'downgrade') {
    exactKeys(row, ['operation', 'lane', 'expectedRevision', 'desiredState']);
    if (row.desiredState !== 'off' && row.desiredState !== 'shadow') {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: 'downgrade',
      lane: lane(row.lane),
      expectedRevision: revision(row.expectedRevision),
      desiredState: row.desiredState,
    });
  }
  if (row.operation === 'kill-capability') {
    exactKeys(row, ['operation', 'capabilityId', 'expectedRevision', 'reasonCode']);
    if (typeof row.reasonCode !== 'string' || !REASON_RE.test(row.reasonCode)) {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: 'kill-capability',
      capabilityId: capabilityId(row.capabilityId),
      expectedRevision: revision(row.expectedRevision),
      reasonCode: row.reasonCode,
    });
  }
  if (row.operation === 'clear-capability-kill') {
    exactKeys(row, ['operation', 'capabilityId', 'expectedRevision']);
    return Object.freeze({
      operation: 'clear-capability-kill',
      capabilityId: capabilityId(row.capabilityId),
      expectedRevision: revision(row.expectedRevision),
    });
  }
  if (row.operation === 'disable-style-proposal') {
    exactKeys(row, ['operation', 'proposalId', 'expectedRevision']);
    return Object.freeze({
      operation: 'disable-style-proposal',
      proposalId: styleProposalId(row.proposalId),
      expectedRevision: revision(row.expectedRevision),
    });
  }
  if (row.operation === 'approve-style-proposal') {
    exactKeys(row, ['operation', 'proposalId', 'version', 'expectedRevision']);
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: 'approve-style-proposal',
      proposalId: styleProposalId(row.proposalId),
      version: Number(row.version),
      expectedRevision: revision(row.expectedRevision),
    });
  }
  if (row.operation === 'rollback-style-proposal') {
    exactKeys(row, ['operation', 'proposalId', 'version', 'expectedRevision']);
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: 'rollback-style-proposal',
      proposalId: styleProposalId(row.proposalId),
      version: Number(row.version),
      expectedRevision: revision(row.expectedRevision),
    });
  }
  if (row.operation === 'clear-preference-profile') {
    exactKeys(row, ['operation', 'sessionId', 'operationId', 'expectedRevision']);
    return Object.freeze({
      operation: 'clear-preference-profile',
      sessionId: sessionId(row.sessionId),
      operationId: preferenceClearOperationId(row.operationId),
      expectedRevision: digestRevision(row.expectedRevision),
    });
  }
  if (row.operation === 'approve-maintenance-proposal' || row.operation === 'rollback-maintenance-proposal') {
    exactKeys(row, ['operation', 'proposalId', 'expectedRevision']);
    return Object.freeze({
      operation: row.operation,
      proposalId: maintenanceProposalId(row.proposalId),
      expectedRevision: integerRevision(row.expectedRevision),
    });
  }
  if (row.operation === 'reject-maintenance-proposal') {
    exactKeys(row, ['operation', 'proposalId', 'expectedRevision', 'reasonCode']);
    if (typeof row.reasonCode !== 'string' || !REASON_RE.test(row.reasonCode)) {
      throw new Error('agent-control-mutation-invalid');
    }
    return Object.freeze({
      operation: row.operation,
      proposalId: maintenanceProposalId(row.proposalId),
      expectedRevision: integerRevision(row.expectedRevision),
      reasonCode: row.reasonCode,
    });
  }
  if (row.operation === 'approve-worldbook-repair'
    || row.operation === 'apply-worldbook-repair'
    || row.operation === 'reject-worldbook-repair'
    || row.operation === 'revert-worldbook-repair') {
    exactKeys(row, ['operation', 'proposalId', 'expectedRevision']);
    return Object.freeze({
      operation: row.operation,
      proposalId: worldbookRepairProposalId(row.proposalId),
      expectedRevision: integerRevision(row.expectedRevision),
    });
  }
  throw new Error('agent-control-mutation-invalid');
}

/** Applies only fail-safe transitions. Raising a lane remains CLI/operator-review only. */
export function applyAgentControlMutation(
  store: AgentControlStore,
  mutation: AgentControlMutation,
  resources: { readonly styleProposals?: LearnedStyleProposalStore } = {},
): AgentLaneControlRow | ReturnType<AgentControlStore['capabilityControl']>
  | ReturnType<AgentControlStore['recoverQualityKillCas']>
  | ReturnType<LearnedStyleProposalStore['read']> {
  if (mutation.operation === 'kill') {
    return store.killCas(mutation.lane, mutation.reasonCode, mutation.expectedRevision);
  }
  if (mutation.operation === 'clear-kill') {
    return store.clearKillCas(mutation.lane, mutation.expectedRevision);
  }
  if (mutation.operation === 'recover') {
    return store.recoverQualityKillCas({
      lane: mutation.lane,
      expectedRevision: mutation.expectedRevision,
      evidenceDigest: mutation.evidenceDigest,
      maxProviderCalls: mutation.maxProviderCalls,
    });
  }
  if (mutation.operation === 'kill-capability') {
    return store.killCapabilityCas(
      mutation.capabilityId, mutation.reasonCode, mutation.expectedRevision,
    );
  }
  if (mutation.operation === 'clear-capability-kill') {
    return store.clearCapabilityKillCas(mutation.capabilityId, mutation.expectedRevision);
  }
  if (mutation.operation === 'disable-style-proposal') {
    if (!resources.styleProposals) throw new Error('style-proposal-control-unavailable');
    return resources.styleProposals.disableCas(mutation.proposalId, mutation.expectedRevision);
  }
  if (mutation.operation === 'approve-style-proposal') {
    if (!resources.styleProposals) throw new Error('style-proposal-control-unavailable');
    return resources.styleProposals.approveCas(
      mutation.proposalId, mutation.version, mutation.expectedRevision,
    );
  }
  if (mutation.operation === 'rollback-style-proposal') {
    if (!resources.styleProposals) throw new Error('style-proposal-control-unavailable');
    return resources.styleProposals.rollbackCas(
      mutation.proposalId, mutation.version, mutation.expectedRevision,
    );
  }
  if (mutation.operation === 'clear-preference-profile') {
    throw new Error('preference-profile-control-unavailable');
  }
  if (mutation.operation === 'approve-maintenance-proposal'
    || mutation.operation === 'reject-maintenance-proposal'
    || mutation.operation === 'rollback-maintenance-proposal') {
    throw new Error('maintenance-proposal-control-unavailable');
  }
  if (mutation.operation === 'approve-worldbook-repair'
    || mutation.operation === 'apply-worldbook-repair'
    || mutation.operation === 'reject-worldbook-repair'
    || mutation.operation === 'revert-worldbook-repair') {
    throw new Error('worldbook-repair-control-unavailable');
  }
  const current = store.get(mutation.lane);
  if (current.revision !== mutation.expectedRevision) throw new Error('agent-control-revision-conflict');
  if (current.desiredState === 'killed') throw new Error('lane-killed-clear-first');
  if (narrowAgentRolloutState(current.desiredState, mutation.desiredState) !== mutation.desiredState) {
    throw new Error('agent-control-escalation-denied');
  }
  if (current.desiredState === mutation.desiredState) throw new Error('agent-control-noop');
  return store.setDesiredCas(mutation.lane, mutation.desiredState, mutation.expectedRevision);
}
