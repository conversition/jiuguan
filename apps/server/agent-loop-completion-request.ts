/** A host request grants only the original OBSERVE -> VERIFY transition.
 * Its content-free DTO is not a Model Decision, completion outcome or JSON permit.
 * Authority is bound to one actual Store/record/owner/action and burned on exchange.
 */
import { createHash } from 'node:crypto';
import { normalizeAgentLoopTaskEnvelope } from '@jiuguan/agent-loop-contract';
import { AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';

export interface AgentLoopCompletionRequest {
    readonly contractVersion: 'agent-loop-completion-request-v1';
    readonly kind: 'request_complete';
}
interface RequestData {
    readonly store: AgentLoopProjectionStore;
    readonly record: AgentLoopTaskRecord;
    readonly ownerId: string;
    readonly actionWatermark: string;
    readonly assertSourceCurrent: () => unknown;
}
const requests = new WeakMap<object, RequestData>();
function invalid(): never { throw new Error('agent-loop-completion-request-invalid'); }

/** Copy own data only, before any normalizer can inspect untrusted nested fields. */
function copyData(value: unknown, seen = new Set<object>(), depth = 0): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
    if (typeof value !== 'object' || depth > 64 || seen.has(value)) invalid();
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            if (value.length > 16_384 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
            const output: unknown[] = [];
            for (let i = 0; i < value.length; i++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
                output.push(copyData(descriptor.value, seen, depth + 1));
            }
            return output;
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
        const entries: [string, unknown][] = [];
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
            entries.push([key, copyData(descriptor.value, seen, depth + 1)]);
        }
        return Object.fromEntries(entries);
    } finally { seen.delete(value); }
}
function pinnedRecord(input: unknown): AgentLoopTaskRecord {
    const value = normalizeAgentLoopActionObject(copyData(input), ['envelope', 'envelopeDigest', 'ownerId',
        'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
    const envelope = normalizeAgentLoopTaskEnvelope(value.envelope);
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`;
    if (envelope.state !== 'RUNNING' || envelope.phase !== 'OBSERVE' || !envelope.currentAttemptId
        || value.revision !== envelope.revision || value.envelopeDigest !== digest || value.fenced !== false
        || value.fenceReason !== null || typeof value.ownerId !== 'string' || typeof value.leaseExpiresAt !== 'string') invalid();
    return Object.freeze({ envelope, envelopeDigest: digest, revision: envelope.revision,
        ownerId: normalizeAgentLoopActionToken(value.ownerId), leaseExpiresAt: value.leaseExpiresAt,
        fenced: false, fenceReason: null });
}
function sameRecord(left: AgentLoopTaskRecord, right: AgentLoopTaskRecord): boolean {
    // A heartbeat may renew a lease without changing the semantic record. The
    // original writer checks its actual fresh TTL and both full snapshots.
    return left.ownerId === right.ownerId && left.fenced === right.fenced && left.fenceReason === right.fenceReason
        && left.revision === right.revision && left.envelopeDigest === right.envelopeDigest
        && JSON.stringify(left.envelope) === JSON.stringify(right.envelope);
}

export function issueAgentLoopCompletionRequest(input: Readonly<{
    store: AgentLoopProjectionStore; record: AgentLoopTaskRecord; ownerId: string;
    actionWatermark: string | null; assertSourceCurrent: () => unknown;
}>): AgentLoopCompletionRequest {
    let selected: RequestData;
    try {
        const value = normalizeAgentLoopActionObject(input, ['store', 'record', 'ownerId', 'actionWatermark', 'assertSourceCurrent']);
        if (!(value.store instanceof AgentLoopProjectionStore) || typeof value.assertSourceCurrent !== 'function') invalid();
        const record = pinnedRecord(value.record), ownerId = normalizeAgentLoopActionToken(value.ownerId);
        const actionWatermark = normalizeAgentLoopActionToken(value.actionWatermark);
        const current = value.store.read(record.envelope.taskId);
        if (ownerId !== record.ownerId || !current || !sameRecord(record, current)
            || !actionWatermark.startsWith('action-completed:')
            || [...value.store.readEvents(record.envelope.taskId)].reverse().find(event => event.kind === 'action-completed')?.eventId !== actionWatermark) invalid();
        selected = Object.freeze({ store: value.store, record, ownerId, actionWatermark,
            assertSourceCurrent: value.assertSourceCurrent as () => unknown });
    } catch { return invalid(); }
    const request = Object.freeze({ contractVersion: 'agent-loop-completion-request-v1', kind: 'request_complete' } as const);
    requests.set(request, selected);
    return request;
}

export function isPreparedAgentLoopCompletionRequest(value: unknown): value is AgentLoopCompletionRequest {
    return value !== null && typeof value === 'object' && requests.has(value);
}

/** Revocation only, including Core rejection before the trusted consumer runs.
 * Copies/JSON/unknown values are harmless; no authority is ever reconstructed.
 */
export function revokeAgentLoopCompletionRequest(value: unknown): void {
    if (value !== null && typeof value === 'object') requests.delete(value);
}

export function consumeAgentLoopCompletionRequest(value: unknown, input: Readonly<{
    store: AgentLoopProjectionStore; record: AgentLoopTaskRecord; ownerId: string; actionWatermark: string | null;
}>): AgentLoopTaskRecord {
    const selected = value !== null && typeof value === 'object' ? requests.get(value) : undefined;
    if (value !== null && typeof value === 'object') requests.delete(value);
    if (!selected) invalid();
    try {
        const fields = normalizeAgentLoopActionObject(input, ['store', 'record', 'ownerId', 'actionWatermark']);
        const record = pinnedRecord(fields.record);
        if (fields.store !== selected.store || fields.ownerId !== selected.ownerId
            || fields.actionWatermark !== selected.actionWatermark || !sameRecord(record, selected.record)) invalid();
    } catch { return invalid(); }
    return selected.store.commitRequestedVerification({ taskId: selected.record.envelope.taskId,
        ownerId: selected.ownerId, expectedRevision: selected.record.revision,
        envelopeDigest: selected.record.envelopeDigest, actionWatermark: selected.actionWatermark }, selected.assertSourceCurrent);
}
