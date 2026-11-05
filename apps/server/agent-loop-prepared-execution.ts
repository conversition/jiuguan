/** Host-only, one-use initial execution grant. JSON / extension patches cannot mint it. */
import {
  AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopTaskEnvelope,
  type AgentLoopTaskEnvelopeV1,
} from '@jiuguan/agent-loop-contract';
import { normalizeAgentLoopArtifactRefDescriptor, type AgentLoopTaskRecord,
  type AgentLoopArtifactRefDescriptor, type AgentLoopArtifactRefRecord } from './agent-loop-projection-store.ts';
import { prepareAgentLoopGetVariablesAuthorization, finalizeAgentLoopGetVariablesAuthorization, assertAgentLoopGetVariablesPreparedAuthorization,
  type AgentLoopGetVariablesAuthorization, type AgentLoopGetVariablesPreparedAuthorization,
  type AgentLoopGetVariablesCapability } from './agent-loop-get-variables-authorization.ts';
import { prepareAgentLoopRollingSummaryProposalAuthorization, finalizeAgentLoopRollingSummaryProposalAuthorization,
  assertAgentLoopRollingSummaryProposalPreparedAuthorization,
  type AgentLoopRollingSummaryProposalAuthorization, type AgentLoopRollingSummaryProposalPreparedAuthorization,
  type AgentLoopRollingSummaryProposalCapability } from './agent-loop-rolling-summary-proposal-authorization.ts';
import { prepareAgentLoopRollingSummaryApplyAuthorization, finalizeAgentLoopRollingSummaryApplyAuthorization,
  assertAgentLoopRollingSummaryApplyPreparedAuthorization,
  type AgentLoopRollingSummaryApplyAuthorization, type AgentLoopRollingSummaryApplyPreparedAuthorization,
  type AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';

export const AGENT_LOOP_PREPARED_EXECUTION_VERSION = 'agent-loop-prepared-execution-v1' as const;
export interface AgentLoopPreparedExecution {
  readonly contractVersion: typeof AGENT_LOOP_PREPARED_EXECUTION_VERSION;
}
interface PreparedData {
  readonly taskId: string;
  readonly revision: number;
  readonly envelopeDigest: string;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly budget: AgentLoopTaskEnvelopeV1['budget'];
  readonly artifacts: AgentLoopTaskEnvelopeV1['artifacts'];
  readonly artifactRefs?: readonly AgentLoopArtifactRefDescriptor[];
  readonly authorizeCommit: () => unknown;
  readonly getVariablesAuthorization?: AgentLoopGetVariablesPreparedAuthorization;
  readonly rollingSummaryProposalAuthorization?: AgentLoopRollingSummaryProposalPreparedAuthorization;
  readonly rollingSummaryApplyAuthorization?: AgentLoopRollingSummaryApplyPreparedAuthorization;
}
const grants = new WeakMap<object, PreparedData>();
const consumed = new WeakMap<object, Omit<PreparedData, 'authorizeCommit'>>();
function reject(): never { throw new Error('agent-loop-prepared-execution-invalid'); }

/** Read-only metadata from the original live grant; structural copies return null. */
export function readAgentLoopPreparedExecutionArtifactRefs(value: unknown): Readonly<{
  artifacts: AgentLoopTaskEnvelopeV1['artifacts']; artifactRefs: readonly AgentLoopArtifactRefDescriptor[];
}> | null {
  if (!value || typeof value !== 'object') return null;
  const data = grants.get(value);
  return data?.artifactRefs ? Object.freeze({ artifacts: data.artifacts, artifactRefs: data.artifactRefs }) : null;
}

/** Initial grant only. A later PREPARE must not reset spent/reserved or top up a grant. */
export function createAgentLoopPreparedExecution(input: Readonly<{
  record: AgentLoopTaskRecord; ownerId: string; attemptId: string;
  budget: AgentLoopTaskEnvelopeV1['budget']; artifact: AgentLoopTaskEnvelopeV1['artifacts'][number];
  authorizeCommit: () => unknown;
  getVariablesAuthorization?: AgentLoopGetVariablesAuthorization;
  rollingSummaryProposalAuthorization?: AgentLoopRollingSummaryProposalAuthorization;
  rollingSummaryApplyAuthorization?: AgentLoopRollingSummaryApplyAuthorization;
  artifactRefs?: readonly AgentLoopArtifactRefDescriptor[];
}>): AgentLoopPreparedExecution {
  const { record, ownerId, attemptId, budget, artifact, authorizeCommit } = input;
  const readAuthorization = input.getVariablesAuthorization;
  const proposalAuthorization = input.rollingSummaryProposalAuthorization;
  const applyAuthorization = input.rollingSummaryApplyAuthorization;
  if ([readAuthorization, proposalAuthorization, applyAuthorization].filter(value => value !== undefined).length > 1) reject();
  const summaryAuthorization = proposalAuthorization !== undefined || applyAuthorization !== undefined;
  let artifactRefs: readonly AgentLoopArtifactRefDescriptor[] | undefined;
  if (input.artifactRefs !== undefined) {
    if (!summaryAuthorization || !Array.isArray(input.artifactRefs) || input.artifactRefs.length !== 1
      || Reflect.ownKeys(input.artifactRefs).length !== 2) reject();
    const item = Object.getOwnPropertyDescriptor(input.artifactRefs, '0');
    if (!item || !Object.hasOwn(item, 'value')) reject();
    const descriptor = normalizeAgentLoopArtifactRefDescriptor(item.value);
    if (descriptor.refId !== artifact.artifactRef || descriptor.kind !== 'session-artifact'
      || descriptor.policy !== 'required' || descriptor.aclClass !== 'restricted' || descriptor.expandBudgetTokens !== 0) reject();
    artifactRefs = Object.freeze([descriptor]);
  } else if (summaryAuthorization) reject();
  const envelope = record.envelope;
  if (record.ownerId !== ownerId || record.fenced || envelope.state !== 'CREATED'
    || envelope.phase !== 'PREPARE' || envelope.currentAttemptId !== undefined
    || typeof authorizeCommit !== 'function'
    || AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => envelope.budget.granted[key] !== 0
      || envelope.budget.spent[key] !== 0 || envelope.budget.reserved[key] !== 0)
    || budget.policyRef !== envelope.budget.policyRef || budget.granted.modelCalls !== 1
    || budget.granted.toolCalls !== (readAuthorization === undefined && !summaryAuthorization ? 0 : 1)
    || budget.granted.writes !== (summaryAuthorization ? 1 : 0)
    || ['highRiskActions', 'childTasks'].some((key) =>
      budget.granted[key as keyof typeof budget.granted] !== 0)
    || AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => budget.spent[key] !== 0 || budget.reserved[key] !== 0)
    || ['inputTokens', 'outputTokens', 'costMicrousd', 'wallMs'].some((key) =>
      budget.granted[key as keyof typeof budget.granted] < 1)
    || artifact.kind !== 'agent-loop-execution-binding' || artifact.status !== 'declared') reject();
  const normalized = normalizeAgentLoopTaskEnvelope({ ...envelope, state: 'RUNNING', phase: 'MODEL',
    currentAttemptId: attemptId, budget, artifacts: [...envelope.artifacts, artifact], revision: record.revision + 1 });
  const getVariablesAuthorization = readAuthorization === undefined ? undefined
    : prepareAgentLoopGetVariablesAuthorization(readAuthorization, { record, ownerId,
      attemptId: normalized.currentAttemptId!, budget: normalized.budget, artifact: normalized.artifacts.at(-1)! });
  const rollingSummaryProposalAuthorization = proposalAuthorization === undefined ? undefined
    : prepareAgentLoopRollingSummaryProposalAuthorization(proposalAuthorization, { record, ownerId,
      attemptId: normalized.currentAttemptId!, budget: normalized.budget, artifact: normalized.artifacts.at(-1)!, artifactRef: artifactRefs![0]! });
  const rollingSummaryApplyAuthorization = applyAuthorization === undefined ? undefined
    : prepareAgentLoopRollingSummaryApplyAuthorization(applyAuthorization, { record, ownerId,
      attemptId: normalized.currentAttemptId!, budget: normalized.budget, artifact: normalized.artifacts.at(-1)!, artifactRef: artifactRefs![0]! });
  const value = Object.freeze({ contractVersion: AGENT_LOOP_PREPARED_EXECUTION_VERSION });
  grants.set(value, Object.freeze({ taskId: envelope.taskId, revision: record.revision,
    envelopeDigest: record.envelopeDigest, ownerId, attemptId: normalized.currentAttemptId!,
    budget: normalized.budget, artifacts: normalized.artifacts, authorizeCommit,
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(getVariablesAuthorization ? { getVariablesAuthorization } : {}),
    ...(rollingSummaryProposalAuthorization ? { rollingSummaryProposalAuthorization } : {}),
    ...(rollingSummaryApplyAuthorization ? { rollingSummaryApplyAuthorization } : {}) }));
  return value;
}

/** Consumed immediately before the Coordinator's original CAS, never a second grant commit. */
export function consumeAgentLoopPreparedExecution(value: unknown, current: AgentLoopTaskRecord,
  ownerId: string): Omit<PreparedData, 'authorizeCommit'> | null {
  if (value === null || typeof value !== 'object') return null;
  const data = grants.get(value);
  if (!data) return null;
  grants.delete(value);
  if (current.fenced || current.ownerId !== ownerId || data.ownerId !== ownerId
    || data.taskId !== current.envelope.taskId || data.revision !== current.revision
    || data.envelopeDigest !== current.envelopeDigest) reject();
  const allowed = data.authorizeCommit();
  // Never await or assimilate an accidental thenable; the final readback is synchronous.
  if (allowed !== null && typeof allowed === 'object') {
    try { void Promise.prototype.then.call(allowed, () => undefined, () => undefined); }
    catch { /* A non-native thenable is never assimilated. */ }
  }
  if (allowed !== true) reject();
  if (data.getVariablesAuthorization) assertAgentLoopGetVariablesPreparedAuthorization(data.getVariablesAuthorization, current, ownerId);
  if (data.rollingSummaryProposalAuthorization) {
    assertAgentLoopRollingSummaryProposalPreparedAuthorization(data.rollingSummaryProposalAuthorization, current, ownerId);
  }
  if (data.rollingSummaryApplyAuthorization) {
    assertAgentLoopRollingSummaryApplyPreparedAuthorization(data.rollingSummaryApplyAuthorization, current, ownerId);
  }
  const { authorizeCommit: _authorize, ...result } = data;
  const valueConsumed = Object.freeze(result);
  consumed.set(valueConsumed, valueConsumed);
  return valueConsumed;
}

export interface AgentLoopPreparedExecutionCapabilities {
  readonly getVariablesCapability?: AgentLoopGetVariablesCapability;
  readonly rollingSummaryProposalCapability?: AgentLoopRollingSummaryProposalCapability;
  readonly rollingSummaryApplyCapability?: AgentLoopRollingSummaryApplyCapability;
}
const NO_CAPABILITIES: AgentLoopPreparedExecutionCapabilities = Object.freeze({});

/** Post-CAS only. Burn the single consumed grant once, then hand off at most one independent capability. */
export function finalizeAgentLoopPreparedExecutionCapabilities(value: unknown,
  record: AgentLoopTaskRecord, registeredRefs?: readonly AgentLoopArtifactRefRecord[]): AgentLoopPreparedExecutionCapabilities {
  if (!value || typeof value !== 'object') return NO_CAPABILITIES;
  const data = consumed.get(value); consumed.delete(value);
  if (!data || [data.getVariablesAuthorization, data.rollingSummaryProposalAuthorization,
      data.rollingSummaryApplyAuthorization].filter(value => value !== undefined).length > 1
    || record.ownerId !== data.ownerId || record.fenced
    || record.envelope.taskId !== data.taskId || record.revision !== data.revision + 1
    || record.envelope.currentAttemptId !== data.attemptId || record.envelope.phase !== 'MODEL'
    || JSON.stringify(record.envelope.budget) !== JSON.stringify(data.budget)
    || JSON.stringify(record.envelope.artifacts) !== JSON.stringify(data.artifacts)) return NO_CAPABILITIES;
  // The durable grant is already committed. A failed fresh source/deadline check
  // withholds the in-memory capability; it does not pretend the CAS rolled back.
  try {
    if (data.getVariablesAuthorization) return Object.freeze({
      getVariablesCapability: finalizeAgentLoopGetVariablesAuthorization(data.getVariablesAuthorization, record),
    });
    if (data.rollingSummaryProposalAuthorization || data.rollingSummaryApplyAuthorization) return Object.freeze({
      ...(data.artifactRefs?.length === 1 && registeredRefs?.some(ref => {
        const expected = data.artifactRefs![0]!;
        return ref.taskRevision === record.revision && ref.refId === expected.refId && ref.kind === expected.kind
          && ref.ownerRef === expected.ownerRef && ref.expectedDigest === expected.expectedDigest
          && ref.expectedRevision === expected.expectedRevision && ref.policy === expected.policy
          && ref.aclClass === expected.aclClass && ref.expandBudgetTokens === expected.expandBudgetTokens;
      }) ? data.rollingSummaryProposalAuthorization
        ? { rollingSummaryProposalCapability: finalizeAgentLoopRollingSummaryProposalAuthorization(data.rollingSummaryProposalAuthorization, record) }
        : { rollingSummaryApplyCapability: finalizeAgentLoopRollingSummaryApplyAuthorization(data.rollingSummaryApplyAuthorization!, record) } : {}),
    });
  } catch { /* The committed grant is not rolled back; a failed fresh fence grants no capability. */ }
  return NO_CAPABILITIES;
}

/** Compatibility wrapper: the original API never returns either summary capability as a read grant. */
export function finalizeAgentLoopPreparedExecution(value: unknown,
  record: AgentLoopTaskRecord): AgentLoopGetVariablesCapability | undefined {
  return finalizeAgentLoopPreparedExecutionCapabilities(value, record).getVariablesCapability;
}
