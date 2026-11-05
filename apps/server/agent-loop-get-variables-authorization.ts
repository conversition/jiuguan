/** Host-only initial read authorization, followed by a post-CAS one-use ACT capability.
 * Durable grant/artifact bytes are audit evidence, never executable capabilities or restart permits.
 */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS, normalizeAgentLoopDecision,
    type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import type { AgentLoopMaintenanceExecutionPrepareOptions } from './agent-loop-maintenance-execution-prepare.ts';
import { resolveAgentLoopMaintenanceProfile, validateAgentLoopMaintenanceSnapshot,
    type AgentLoopMaintenancePrepareSource } from './agent-loop-prepare.ts';
import { isPristineShadowProjection, MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';
import { AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';
export { agentLoopMaintenanceClaimDigest } from './maintenance-job-contract.ts';

export interface AgentLoopGetVariablesAuthorization {
    readonly contractVersion: 'agent-loop-get-variables-authorization-v1';
}
export interface AgentLoopGetVariablesCapability {
    readonly contractVersion: 'agent-loop-get-variables-capability-v1';
}
/** Internal opaque handoff only; only the genuine consumed PreparedExecution can finalize it. */
export interface AgentLoopGetVariablesPreparedAuthorization {
    readonly contractVersion: 'agent-loop-get-variables-prepared-authorization-v1';
}
type ReadCurrent = AgentLoopMaintenanceExecutionPrepareOptions['readCurrent'];
type Budget = AgentLoopTaskEnvelopeV1['budget'];
type Artifact = AgentLoopTaskEnvelopeV1['artifacts'][number];
interface AuthorizationData {
    readonly store: AgentLoopProjectionStore;
    readonly ownerId: string;
    readonly clock: () => string;
    readonly signal: AbortSignal;
    readonly readCurrent: ReadCurrent;
    readonly taskId: string;
    readonly initialRevision: number;
    readonly initialDigest: string;
    readonly attemptId: string;
    readonly sessionIdentity: object;
    readonly claimDigest: string;
    readonly profileDigest: string;
    readonly snapshotDigest: string;
    readonly deadlineMs: number;
    readonly bindingRef: string;
    readonly evidenceDigest: string;
    readonly budget: Budget;
}
interface CapabilityData {
    readonly authorization: AuthorizationData;
    readonly modelRevision: number;
    readonly artifactsDigest: string;
}
const authorizations = new WeakMap<object, AuthorizationData>();
const prepared = new WeakMap<object, AuthorizationData>();
const capabilities = new WeakMap<object, CapabilityData>();
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function reject(): never { throw new Error('agent-loop-get-variables-authorization-invalid'); }
function object(value: unknown): value is object { return value !== null && typeof value === 'object'; }
function now(clock: () => string): number {
    const text = clock(), value = Date.parse(text);
    if (!Number.isSafeInteger(value) || new Date(value).toISOString() !== text) reject();
    return value;
}

export function agentLoopMaintenanceBindingRef(execution: MaintenanceExecutionRecord, source: AgentLoopMaintenancePrepareSource): string {
    return `execution.prepare:${digest({ claim: agentLoopMaintenanceClaimDigest(execution),
        profile: resolveAgentLoopMaintenanceProfile(source), snapshot: validateAgentLoopMaintenanceSnapshot(source) }).slice(7)}`;
}

function capture(input: Readonly<{ ownerId: string; clock: () => string; signal: AbortSignal; readCurrent: ReadCurrent }>) {
    if (input.signal.aborted) reject();
    const current = input.readCurrent();
    // Observe an accidental native Promise rejection without awaiting or assimilating
    // any thenable. A Promise is never a synchronous source-authority readback.
    if (object(current)) {
        let asynchronous = false;
        try { void Promise.prototype.then.call(current, () => undefined, () => undefined); asynchronous = true; }
        catch { /* Plain records/foreign thenables are not assimilated. */ }
        if (asynchronous) reject();
    }
    if (!current || !current.execution || !current.source) reject();
    const { execution, source } = current, job = execution.job, at = now(input.clock);
    if (execution.executorRoute !== 'agent-loop' || execution.leaseOwnerInstanceId !== input.ownerId
        || job.taskKind !== 'rolling_summary' || job.status !== 'running' || execution.cancelRequestedAt !== undefined
        || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !execution.leaseExpiresAt
        || !Number.isFinite(Date.parse(execution.leaseExpiresAt)) || new Date(execution.leaseExpiresAt).toISOString() !== execution.leaseExpiresAt
        || Date.parse(execution.leaseExpiresAt) <= at || !object(source.sessionIdentity)
        || JSON.stringify(source.job) !== JSON.stringify(job) || source.snapshot.revision !== job.sourceRevision) reject();
    const profile = resolveAgentLoopMaintenanceProfile(source);
    if (profile.budgetProfile.maxModelCalls !== 1 || profile.budgetProfile.maxToolCalls < 1
        || profile.budgetProfile.maxToolResultChars < 1) reject();
    const start = Date.parse(job.startedAt ?? ''), deadlineMs = start + profile.budgetProfile.maxWallMs;
    if (!Number.isSafeInteger(start) || new Date(start).toISOString() !== job.startedAt
        || !Number.isSafeInteger(deadlineMs) || !Number.isFinite(new Date(deadlineMs).getTime()) || at >= deadlineMs) reject();
    return { execution, source, at, profile, deadlineMs, claimDigest: agentLoopMaintenanceClaimDigest(execution),
        profileDigest: digest(profile), snapshotDigest: digest(validateAgentLoopMaintenanceSnapshot(source)) };
}
function fresh(data: AuthorizationData): void {
    const current = capture(data);
    if (current.source.sessionIdentity !== data.sessionIdentity || current.claimDigest !== data.claimDigest
        || current.profileDigest !== data.profileDigest || current.snapshotDigest !== data.snapshotDigest
        || current.deadlineMs !== data.deadlineMs) reject();
}
function actualRecord(data: AuthorizationData, supplied: AgentLoopTaskRecord): AgentLoopTaskRecord {
    const current = data.store.read(data.taskId), at = now(data.clock);
    if (!current || current.fenced || current.ownerId !== data.ownerId || current.envelope.taskId !== data.taskId
        || current.revision !== supplied.revision || current.envelopeDigest !== supplied.envelopeDigest
        || JSON.stringify(current.envelope) !== JSON.stringify(supplied.envelope)
        || !current.leaseExpiresAt || !Number.isFinite(Date.parse(current.leaseExpiresAt))
        || new Date(current.leaseExpiresAt).toISOString() !== current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= at) reject();
    return current;
}
function binding(data: AuthorizationData, record: AgentLoopTaskRecord): void {
    const values = record.envelope.artifacts.filter(value => value.kind === 'agent-loop-execution-binding');
    if (values.length !== 1 || values[0]!.artifactRef !== data.bindingRef || values[0]!.status !== 'declared'
        || !values[0]!.evidenceRefs.includes(data.evidenceDigest)
        || record.envelope.currentAttemptId !== data.attemptId
        || JSON.stringify(record.envelope.budget.granted) !== JSON.stringify(data.budget.granted)
        || record.envelope.budget.policyRef !== data.budget.policyRef) reject();
}

export function issueAgentLoopGetVariablesAuthorization(input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; clock: () => string; signal: AbortSignal; readCurrent: ReadCurrent;
}>): AgentLoopGetVariablesAuthorization {
    try {
        const fixed = capture(input), taskId = `agentloop.maintenance.${fixed.execution.job.runId}`;
        const record = input.store.read(taskId), registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
        if (!record || record.fenced || record.ownerId !== input.ownerId || !isPristineShadowProjection(input.store, record)
            || record.envelope.taskKind !== registration.taskKind || record.envelope.taskContractRef !== registration.contractRef
            || !record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= fixed.at) reject();
        const zero = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, 0])) as unknown as Budget['granted'];
        const profile = fixed.profile.budgetProfile;
        const budget: Budget = Object.freeze({ policyRef: record.envelope.budget.policyRef,
            granted: Object.freeze({ ...zero, modelCalls: 1, toolCalls: 1, inputTokens: profile.agentInputBudgetTokens,
                outputTokens: profile.agentOutputBudgetTokens, costMicrousd: profile.maxCostMicrousd, wallMs: profile.maxWallMs }),
            reserved: Object.freeze({ ...zero }), spent: Object.freeze({ ...zero }) });
        const evidenceDigest = digest({ version: 'agent-loop-get-variables-authorization-v1', taskId,
            initialRevision: record.revision, envelopeDigest: record.envelopeDigest, ownerId: input.ownerId,
            actionContractRef: AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT, claimDigest: fixed.claimDigest,
            profileDigest: fixed.profileDigest, snapshotDigest: fixed.snapshotDigest, deadlineMs: fixed.deadlineMs,
            budget });
        const value: AgentLoopGetVariablesAuthorization = Object.freeze({ contractVersion: 'agent-loop-get-variables-authorization-v1' });
        authorizations.set(value, Object.freeze({ ...input, taskId, initialRevision: record.revision,
            initialDigest: record.envelopeDigest, attemptId: `attempt.al.${fixed.claimDigest.slice(7)}`,
            sessionIdentity: fixed.source.sessionIdentity, claimDigest: fixed.claimDigest,
            profileDigest: fixed.profileDigest, snapshotDigest: fixed.snapshotDigest, deadlineMs: fixed.deadlineMs,
            bindingRef: agentLoopMaintenanceBindingRef(fixed.execution, fixed.source), evidenceDigest, budget }));
        return value;
    } catch { return reject(); }
}

/** Read-only audit digest. Repeated inspection grants nothing and never substitutes for the brand. */
export function agentLoopGetVariablesAuthorizationEvidence(value: unknown, record: AgentLoopTaskRecord, ownerId: string): string {
    const data = object(value) ? authorizations.get(value) : undefined;
    if (!data || ownerId !== data.ownerId || record.revision !== data.initialRevision || record.envelopeDigest !== data.initialDigest) reject();
    fresh(data); actualRecord(data, record);
    return data.evidenceDigest;
}

/** Internal initial-grant handoff. The input brand is burned even when a binding check fails. */
export function prepareAgentLoopGetVariablesAuthorization(value: unknown, input: Readonly<{
    record: AgentLoopTaskRecord; ownerId: string; attemptId: string; budget: Budget; artifact: Artifact;
}>): AgentLoopGetVariablesPreparedAuthorization {
    const data = object(value) ? authorizations.get(value) : undefined;
    if (object(value)) authorizations.delete(value);
    if (!data || input.ownerId !== data.ownerId || input.attemptId !== data.attemptId
        || input.record.revision !== data.initialRevision || input.record.envelopeDigest !== data.initialDigest
        || JSON.stringify(input.budget) !== JSON.stringify(data.budget)
        || input.artifact.artifactRef !== data.bindingRef || input.artifact.kind !== 'agent-loop-execution-binding'
        || input.artifact.status !== 'declared' || !input.artifact.evidenceRefs.includes(data.evidenceDigest)) reject();
    fresh(data); actualRecord(data, input.record);
    const valuePrepared: AgentLoopGetVariablesPreparedAuthorization = Object.freeze({ contractVersion: 'agent-loop-get-variables-prepared-authorization-v1' });
    prepared.set(valuePrepared, data); return valuePrepared;
}

/** Mandatory last synchronous source check inside PreparedExecution consumption, before its CAS. */
export function assertAgentLoopGetVariablesPreparedAuthorization(value: unknown, record: AgentLoopTaskRecord, ownerId: string): void {
    const data = object(value) ? prepared.get(value) : undefined;
    if (!data || ownerId !== data.ownerId || record.revision !== data.initialRevision || record.envelopeDigest !== data.initialDigest) reject();
    fresh(data); actualRecord(data, record);
}

/** Called only after the original PreparedExecution CAS and consumed-grant identity check succeeded. */
export function finalizeAgentLoopGetVariablesAuthorization(value: unknown, committed: AgentLoopTaskRecord): AgentLoopGetVariablesCapability {
    const data = object(value) ? prepared.get(value) : undefined;
    if (object(value)) prepared.delete(value);
    if (!data) reject();
    fresh(data); const current = actualRecord(data, committed);
    if (current.revision !== data.initialRevision + 1 || current.envelope.phase !== 'MODEL' || current.envelope.state !== 'RUNNING'
        || JSON.stringify(current.envelope.budget) !== JSON.stringify(data.budget)) reject();
    binding(data, current);
    const capability: AgentLoopGetVariablesCapability = Object.freeze({ contractVersion: 'agent-loop-get-variables-capability-v1' });
    capabilities.set(capability, Object.freeze({ authorization: data, modelRevision: current.revision,
        artifactsDigest: digest(current.envelope.artifacts) }));
    return capability;
}

export function consumeAgentLoopGetVariablesCapability(value: unknown, input: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; record: AgentLoopTaskRecord; decision: unknown;
}>): boolean {
    const entry = object(value) ? capabilities.get(value) : undefined;
    if (object(value)) capabilities.delete(value);
    if (!entry) return false;
    try {
        const data = entry.authorization;
        if (input.store !== data.store || input.ownerId !== data.ownerId) return false;
        fresh(data); const record = actualRecord(data, input.record), task = record.envelope;
        const decision = normalizeAgentLoopDecision(input.decision);
        if (record.revision !== entry.modelRevision + 1 || task.phase !== 'ACT' || task.state !== 'RUNNING'
            || task.currentAttemptId !== data.attemptId || digest(task.artifacts) !== entry.artifactsDigest
            || decision.kind !== 'act' || decision.actionContractRef !== AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT
            || decision.taskId !== task.taskId || decision.attemptId !== data.attemptId
            || decision.expectedTaskRevision !== entry.modelRevision || decision.taskContractRef !== task.taskContractRef) return false;
        binding(data, record);
        const budget = task.budget;
        if (budget.spent.modelCalls !== 1 || budget.spent.toolCalls !== 0
            || AGENT_LOOP_TASK_BUDGET_KEYS.some(key => budget.reserved[key] !== 0
                || budget.spent[key] > budget.granted[key])
            || ['writes', 'highRiskActions', 'childTasks'].some(key => budget.spent[key as keyof typeof budget.spent] !== 0)) return false;
        return true;
    } catch { return false; }
}

export function revokeAgentLoopGetVariablesCapability(value: unknown): void {
    if (object(value)) capabilities.delete(value);
}
