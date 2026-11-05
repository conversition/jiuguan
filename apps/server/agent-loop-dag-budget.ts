/** @author Codex @date 2026-10-26 @version 1.0
 * Content-free contracts for the original AL Store's root-to-read-only-leaf budget ledger.
 * Holds and accounting never constitute a Runner, execution permit or result/join authority.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AGENT_LOOP_TASK_BUDGET_KEYS, type AgentLoopTaskBudgetVectorV1 } from '@jiuguan/agent-loop-contract';

export type AgentLoopDagBudgetVector = AgentLoopTaskBudgetVectorV1;
export interface AgentLoopDagLeafProfile {
    readonly version: 'agent-loop-dag-leaf-profile-v1';
    readonly profileRef: string;
    readonly allowedCapabilities: readonly ['read'];
    readonly canDelegate: false;
}
export interface AgentLoopDagRootPolicy {
    readonly version: 'agent-loop-dag-policy-v1';
    readonly policyRef: string;
    readonly maxDepth: 1;
    readonly maxConcurrentChildren: number;
    readonly maxTotalChildren: number;
    readonly deadlineAt: string;
    readonly leafProfile: AgentLoopDagLeafProfile;
}
export function dagBudgetInvalid(): never {
    throw new Error('agent-loop-dag-budget-input-invalid');
}
export function dagBudgetExact(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (
        types.isProxy(input) ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
        dagBudgetInvalid();
    const record = input as Record<string, unknown>,
        own = Reflect.ownKeys(record);
    if (own.length !== keys.length || keys.some((key) => !own.includes(key))) dagBudgetInvalid();
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) dagBudgetInvalid();
    }
    return record;
}
export function dagBudgetToken(input: unknown): string {
    if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(input)) dagBudgetInvalid();
    return input;
}
export function dagBudgetInteger(input: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(input) || Number(input) < minimum || Number(input) > maximum) dagBudgetInvalid();
    return Number(input);
}
export function dagBudgetTimestamp(input: unknown): string {
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
        dagBudgetInvalid();
    return input;
}
export function normalizeAgentLoopDagBudget(input: unknown): AgentLoopDagBudgetVector {
    const value = dagBudgetExact(input, AGENT_LOOP_TASK_BUDGET_KEYS);
    return Object.freeze(
        Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => [key, dagBudgetInteger(value[key])])),
    ) as AgentLoopDagBudgetVector;
}
export function normalizeAgentLoopDagLeafProfile(input: unknown): AgentLoopDagLeafProfile {
    const value = dagBudgetExact(input, ['version', 'profileRef', 'allowedCapabilities', 'canDelegate']);
    if (
        value.version !== 'agent-loop-dag-leaf-profile-v1' ||
        value.canDelegate !== false ||
        types.isProxy(value.allowedCapabilities) ||
        !Array.isArray(value.allowedCapabilities) ||
        Reflect.ownKeys(value.allowedCapabilities).length !== 2 ||
        Object.getOwnPropertyDescriptor(value.allowedCapabilities, '0')?.value !== 'read'
    )
        dagBudgetInvalid();
    return Object.freeze({
        version: value.version,
        profileRef: dagBudgetToken(value.profileRef),
        allowedCapabilities: Object.freeze(['read'] as const),
        canDelegate: false,
    });
}
export function normalizeAgentLoopDagRootPolicy(input: unknown): AgentLoopDagRootPolicy {
    const value = dagBudgetExact(input, [
        'version',
        'policyRef',
        'maxDepth',
        'maxConcurrentChildren',
        'maxTotalChildren',
        'deadlineAt',
        'leafProfile',
    ]);
    if (value.version !== 'agent-loop-dag-policy-v1' || value.maxDepth !== 1) dagBudgetInvalid();
    const maxTotalChildren = dagBudgetInteger(value.maxTotalChildren, 1, 128);
    const maxConcurrentChildren = dagBudgetInteger(value.maxConcurrentChildren, 1, 32);
    if (maxConcurrentChildren > maxTotalChildren) dagBudgetInvalid();
    return Object.freeze({
        version: value.version,
        policyRef: dagBudgetToken(value.policyRef),
        maxDepth: 1,
        maxConcurrentChildren,
        maxTotalChildren,
        deadlineAt: dagBudgetTimestamp(value.deadlineAt),
        leafProfile: normalizeAgentLoopDagLeafProfile(value.leafProfile),
    });
}
export function agentLoopDagBudgetDigest(input: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}
export function addAgentLoopDagBudget(
    left: AgentLoopDagBudgetVector,
    right: AgentLoopDagBudgetVector,
): AgentLoopDagBudgetVector {
    return normalizeAgentLoopDagBudget(
        Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => [key, left[key] + right[key]])),
    );
}
export function subtractAgentLoopDagBudget(
    left: AgentLoopDagBudgetVector,
    right: AgentLoopDagBudgetVector,
): AgentLoopDagBudgetVector {
    return normalizeAgentLoopDagBudget(
        Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => [key, left[key] - right[key]])),
    );
}
