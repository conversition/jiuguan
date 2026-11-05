/** Durable repair metadata is folded only from the original task events.
 * Policies are trusted host minimum-remaining gates, never budget grants or
 * Model/Action/completion permits. No attempt change resets lifetime usage.
 */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_TASK_BUDGET_KEYS, type AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';
import type { AgentLoopTaskEvent, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';

export interface AgentLoopRepairPolicy {
    readonly version: 'agent-loop-repair-policy-v1';
    readonly policyRef: string;
    readonly taskKind: string;
    readonly taskContractRef: string;
    readonly verifierSetRef: string;
    readonly verifierSetRevision: string;
    readonly maxAttempts: number;
    readonly requiredBudget: AgentLoopTaskEnvelopeV1['budget']['granted'];
}
export interface AgentLoopRepairState {
    readonly version: 'agent-loop-repair-state-v1';
    readonly taskId: string;
    readonly taskRevision: number;
    readonly envelopeDigest: string;
    readonly attempts: number;
    readonly maxAttempts: number | null;
    /** Task-bound full-policy hash, exactly the repair-policy event suffix. */
    readonly policyDigest: string | null;
    readonly snapshotDigest: string;
}
export interface AgentLoopRepairCommitResult {
    readonly verdict: 'repair' | 'terminal-failure' | 'inconclusive';
    readonly record: AgentLoopTaskRecord;
    readonly state: AgentLoopRepairState;
    readonly reasonCodes: readonly string[];
}
function invalid(): never { throw new Error('agent-loop-repair-budget-invalid'); }
function own(input: unknown, required: readonly string[], optional: readonly string[] = []) {
    const value = normalizeAgentLoopActionObject(input, required, optional);
    if (Reflect.ownKeys(value).some(key => !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) invalid();
    return value;
}
function hash(value: unknown): string {
    const canonical = (v: unknown): unknown => v !== null && typeof v === 'object'
        ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical((v as Record<string, unknown>)[key])])) : v;
    return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex')}`;
}
export function normalizeAgentLoopRepairPolicy(input: unknown): AgentLoopRepairPolicy {
    try {
        const value = own(input, ['version', 'policyRef', 'taskKind', 'taskContractRef', 'verifierSetRef', 'verifierSetRevision', 'maxAttempts', 'requiredBudget']);
        if (value.version !== 'agent-loop-repair-policy-v1' || !Number.isSafeInteger(value.maxAttempts)
            || Number(value.maxAttempts) < 0 || Number(value.maxAttempts) > 16) invalid();
        const budget = own(value.requiredBudget, AGENT_LOOP_TASK_BUDGET_KEYS);
        for (const key of AGENT_LOOP_TASK_BUDGET_KEYS) {
            if (!Number.isSafeInteger(budget[key]) || Number(budget[key]) < (['modelCalls', 'inputTokens', 'outputTokens', 'wallMs'].includes(key) ? 1 : 0)) invalid();
        }
        const requiredBudget = Object.freeze(Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, Number(budget[key])]))) as unknown as AgentLoopRepairPolicy['requiredBudget'];
        return Object.freeze({ version: 'agent-loop-repair-policy-v1', policyRef: normalizeAgentLoopActionToken(value.policyRef),
            taskKind: normalizeAgentLoopActionToken(value.taskKind), taskContractRef: normalizeAgentLoopActionToken(value.taskContractRef),
            verifierSetRef: normalizeAgentLoopActionToken(value.verifierSetRef), verifierSetRevision: normalizeAgentLoopActionToken(value.verifierSetRevision),
            maxAttempts: Number(value.maxAttempts), requiredBudget });
    } catch { return invalid(); }
}
export function agentLoopRepairPolicyDigest(policy: unknown): string { return hash(normalizeAgentLoopRepairPolicy(policy)); }
export function agentLoopRepairPolicyBindingDigest(taskId: string, policy: unknown): string {
    return hash({ taskId: normalizeAgentLoopActionToken(taskId), policy: normalizeAgentLoopRepairPolicy(policy) });
}

/** Strict legacy/current lineage fold. Anonymous annotations can never increase
 * authority: the write APIs reserve every repair kind and event-id namespace.
 */
export function foldAgentLoopRepairEvents(input: Readonly<{ taskId: string; taskRevision: number;
    events: readonly AgentLoopTaskEvent[] }>): Readonly<{ attempts: number; maxAttempts: number | null; policyDigest: string | null }> {
    try {
        const value = own(input, ['taskId', 'taskRevision', 'events']), taskId = normalizeAgentLoopActionToken(value.taskId);
        if (!Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || !Array.isArray(value.events)
            || Reflect.ownKeys(value.events).length !== value.events.length + 1) invalid();
        let attempts = 0, maxAttempts: number | null = null, policyDigest: string | null = null;
        let previousRevision = 0, previousAt = '', policyRevision = 0, policyAt = '', legacyAttempts = 0;
        let pendingPolicy = false, failedRepair = false;
        const ids = new Set<string>(), repairRevisions = new Set<number>();
        for (let i = 0; i < value.events.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value.events, String(i));
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
            const event = own(descriptor.value, ['eventVersion', 'eventId', 'taskId', 'revision', 'kind', 'eventDigest', 'acceptedAt'], ['reasonCode']);
            if (event.eventVersion !== 'agent-loop-projection-event-v1' || event.taskId !== taskId
                || !Number.isSafeInteger(event.revision) || Number(event.revision) < 1 || Number(event.revision) > Number(value.taskRevision)
                || typeof event.acceptedAt !== 'string' || !Number.isFinite(Date.parse(event.acceptedAt))
                || new Date(event.acceptedAt).toISOString() !== event.acceptedAt
                || typeof event.eventDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(event.eventDigest)) invalid();
            const eventId = normalizeAgentLoopActionToken(event.eventId), kind = normalizeAgentLoopActionToken(event.kind), revision = Number(event.revision);
            if (event.reasonCode !== undefined) normalizeAgentLoopActionToken(event.reasonCode);
            if (ids.has(eventId) || revision < previousRevision || event.acceptedAt < previousAt) invalid();
            ids.add(eventId); previousRevision = revision; previousAt = event.acceptedAt;
            if (pendingPolicy && (revision !== policyRevision || event.acceptedAt !== policyAt
                || kind !== 'verify-repairable' && kind !== 'task-failed-repair')) invalid();
            pendingPolicy = false;
            if (kind === 'repair-policy-bound') {
                if (policyDigest !== null || !/^repair-policy:[a-f0-9]{64}$/u.test(eventId)
                    || typeof event.reasonCode !== 'string' || !/^repair-limit-(?:[0-9]|1[0-6])$/u.test(event.reasonCode)) invalid();
                maxAttempts = Number(event.reasonCode.slice('repair-limit-'.length)); policyDigest = `sha256:${eventId.slice('repair-policy:'.length)}`;
                policyRevision = revision; policyAt = event.acceptedAt; pendingPolicy = true;
            } else if (kind === 'verify-repairable') {
                if (failedRepair || revision < 2 || eventId !== `phase:${taskId}:${revision - 1}:VERIFY-PREPARE` || repairRevisions.has(revision)) invalid();
                if (policyDigest === null) {
                    if (event.reasonCode !== undefined) invalid();
                    legacyAttempts++;
                } else if (event.reasonCode !== 'verification-repairable' || revision < policyRevision
                    || revision === policyRevision && event.acceptedAt !== policyAt) invalid();
                repairRevisions.add(revision); attempts++;
                if (maxAttempts !== null && attempts > Math.max(legacyAttempts, maxAttempts)) invalid();
            } else if (kind === 'task-failed-repair') {
                if (failedRepair || policyDigest === null || revision < 2 || revision < policyRevision
                    || eventId !== `repair-failed:${hash({ taskId, revision: revision - 1, policyDigest }).slice(7)}`
                    || !['repair-attempts-exhausted', 'repair-budget-insufficient'].includes(String(event.reasonCode))
                    || event.reasonCode === 'repair-attempts-exhausted' && attempts < maxAttempts!) invalid();
                failedRepair = true;
            } else if (eventId.startsWith('repair-policy:') || eventId.startsWith('repair-failed:') || eventId.endsWith(':VERIFY-PREPARE')) invalid();
        }
        if (pendingPolicy) invalid();
        return Object.freeze({ attempts, maxAttempts, policyDigest });
    } catch { return invalid(); }
}
