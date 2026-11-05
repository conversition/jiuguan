/** Content-free AL Summary write origin. These functions normalize metadata;
 * they do not issue a capability, register an Action or authorize execution.
 * New origin/record digests use canonical sorted JSON. Existing Summary
 * proposal/context/intent byte digests retain their original algorithms.
 */
import { createHash } from 'node:crypto';
import { AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT, normalizeAgentLoopActionObject,
    normalizeAgentLoopActionToken, normalizeAgentLoopActionDigest } from './agent-loop-action-receipt.ts';

export const AGENT_LOOP_SUMMARY_WRITE_ORIGIN_VERSION = 'agent-loop-summary-write-origin-v1' as const;
export const AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION = 'agent-loop-summary-write-origin-record-v1' as const;
export const AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX = 'agent_loop_summary_write_origin:';
export const AGENT_LOOP_SUMMARY_APPLY_ACTION_CONTRACT = AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT;

export interface AgentLoopSummaryWriteOrigin {
    readonly version: typeof AGENT_LOOP_SUMMARY_WRITE_ORIGIN_VERSION;
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly taskRevision: number;
    readonly actionId: string;
    readonly actionDigest: string;
    readonly actionContractRef: typeof AGENT_LOOP_SUMMARY_APPLY_ACTION_CONTRACT;
    readonly ownerId: string;
    readonly claimAttempt: number;
    readonly claimDigest: string;
    readonly sourceRevision: string;
    readonly sourceDigest: string;
    readonly proposalDigest: string;
    readonly contextDigest: string;
    readonly budgetDigest: string;
    readonly authorizedAt: string;
    readonly authorizationExpiresAt: string;
    readonly sessionId: string;
    readonly originDigest: string;
}
export interface AgentLoopSummaryWriteOriginRecord {
    readonly version: typeof AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION;
    readonly origin: AgentLoopSummaryWriteOrigin;
    readonly intentDigest: string;
    readonly operationDigest: string;
    readonly committedAt: string;
    readonly recordDigest: string;
}
const ORIGIN_KEYS = ['version', 'runId', 'taskId', 'attemptId', 'taskRevision', 'actionId', 'actionDigest', 'actionContractRef',
    'ownerId', 'claimAttempt', 'claimDigest', 'sourceRevision', 'sourceDigest', 'proposalDigest', 'contextDigest', 'budgetDigest',
    'authorizedAt', 'authorizationExpiresAt', 'sessionId'] as const;
function invalid(): never { throw new Error('agent-loop-summary-write-origin-invalid'); }
function object(input: unknown, required: readonly string[]) {
    const result = normalizeAgentLoopActionObject(input, required);
    if (Reflect.ownKeys(result).some(key => !Object.getOwnPropertyDescriptor(result, key)?.enumerable)) invalid();
    return result;
}
function time(input: unknown): string {
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) invalid();
    return input;
}
function positive(input: unknown): number {
    if (!Number.isSafeInteger(input) || Number(input) < 1) invalid(); return Number(input);
}
/** Own data only: never reads then/toJSON/getters or assimilates a Promise. */
export function agentLoopSummaryWriteDigest(input: unknown): string {
    const seen = new Set<object>(); let nodes = 0;
    const canonical = (value: unknown, depth: number): unknown => {
        if (++nodes > 16_384 || depth > 64) invalid();
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (!value || typeof value !== 'object' || seen.has(value)) invalid();
        seen.add(value);
        try {
            if (Array.isArray(value)) {
                if (value.length > 16_384 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
                const result: unknown[] = [];
                for (let i = 0; i < value.length; i++) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
                    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
                    result.push(canonical(descriptor.value, depth + 1));
                }
                return result;
            }
            if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
            const entries: [string, unknown][] = [];
            for (const key of Reflect.ownKeys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
                entries.push([key, canonical(descriptor.value, depth + 1)]);
            }
            return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        } finally { seen.delete(value); }
    };
    try { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(input, 0)), 'utf8').digest('hex')}`; }
    catch { return invalid(); }
}
export function createAgentLoopSummaryWriteOrigin(input: Omit<AgentLoopSummaryWriteOrigin, 'originDigest'>): AgentLoopSummaryWriteOrigin {
    try {
        const value = object(input, ORIGIN_KEYS);
        if (value.version !== AGENT_LOOP_SUMMARY_WRITE_ORIGIN_VERSION || typeof value.runId !== 'string'
            || !/^mjob_[a-f0-9]{32}$/u.test(value.runId) || value.taskId !== `agentloop.maintenance.${value.runId}`
            || value.actionContractRef !== AGENT_LOOP_SUMMARY_APPLY_ACTION_CONTRACT) invalid();
        const authorizedAt = time(value.authorizedAt), authorizationExpiresAt = time(value.authorizationExpiresAt);
        if (authorizationExpiresAt <= authorizedAt) invalid();
        const result = Object.freeze({ version: AGENT_LOOP_SUMMARY_WRITE_ORIGIN_VERSION, runId: value.runId,
            taskId: value.taskId, attemptId: normalizeAgentLoopActionToken(value.attemptId), taskRevision: positive(value.taskRevision),
            actionId: normalizeAgentLoopActionDigest(value.actionId), actionDigest: normalizeAgentLoopActionDigest(value.actionDigest),
            actionContractRef: AGENT_LOOP_SUMMARY_APPLY_ACTION_CONTRACT, ownerId: normalizeAgentLoopActionToken(value.ownerId),
            claimAttempt: positive(value.claimAttempt), claimDigest: normalizeAgentLoopActionDigest(value.claimDigest),
            sourceRevision: normalizeAgentLoopActionDigest(value.sourceRevision), sourceDigest: normalizeAgentLoopActionDigest(value.sourceDigest),
            proposalDigest: normalizeAgentLoopActionDigest(value.proposalDigest), contextDigest: normalizeAgentLoopActionDigest(value.contextDigest),
            budgetDigest: normalizeAgentLoopActionDigest(value.budgetDigest), authorizedAt, authorizationExpiresAt,
            sessionId: normalizeAgentLoopActionToken(value.sessionId) });
        return Object.freeze({ ...result, originDigest: agentLoopSummaryWriteDigest(result) });
    } catch { return invalid(); }
}
export function parseAgentLoopSummaryWriteOrigin(input: unknown): AgentLoopSummaryWriteOrigin {
    try {
        const value = object(input, [...ORIGIN_KEYS, 'originDigest']);
        const { originDigest, ...body } = value;
        const normalized = createAgentLoopSummaryWriteOrigin(body as unknown as Omit<AgentLoopSummaryWriteOrigin, 'originDigest'>);
        if (originDigest !== normalized.originDigest) invalid(); return normalized;
    } catch { return invalid(); }
}
export function createAgentLoopSummaryWriteOriginRecord(input: Omit<AgentLoopSummaryWriteOriginRecord, 'recordDigest'>): AgentLoopSummaryWriteOriginRecord {
    try {
        const value = object(input, ['version', 'origin', 'intentDigest', 'operationDigest', 'committedAt']);
        if (value.version !== AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION) invalid();
        const origin = parseAgentLoopSummaryWriteOrigin(value.origin), committedAt = time(value.committedAt);
        if (committedAt < origin.authorizedAt || committedAt >= origin.authorizationExpiresAt) invalid();
        const result = Object.freeze({ version: AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION, origin,
            intentDigest: normalizeAgentLoopActionDigest(value.intentDigest), operationDigest: normalizeAgentLoopActionDigest(value.operationDigest), committedAt });
        return Object.freeze({ ...result, recordDigest: agentLoopSummaryWriteDigest(result) });
    } catch { return invalid(); }
}
export function parseAgentLoopSummaryWriteOriginRecord(input: unknown): AgentLoopSummaryWriteOriginRecord {
    try {
        const value = object(input, ['version', 'origin', 'intentDigest', 'operationDigest', 'committedAt', 'recordDigest']);
        const { recordDigest, ...body } = value;
        const normalized = createAgentLoopSummaryWriteOriginRecord(body as unknown as Omit<AgentLoopSummaryWriteOriginRecord, 'recordDigest'>);
        if (recordDigest !== normalized.recordDigest) invalid(); return normalized;
    } catch { return invalid(); }
}
