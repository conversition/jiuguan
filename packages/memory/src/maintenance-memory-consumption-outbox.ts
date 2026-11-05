/** @author Codex @date 2026-10-14 @version 1.0
 * Committed Memory adoption metadata belongs to the consuming Session, never a second business writer.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken, normalizeAgentClosureEvent,
    normalizeAgentClosureRun, type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../agent-closure/index.ts';
import {
    normalizeAgentSkillConsumptionEvidenceBinding, type AgentSkillConsumptionEvidenceBindingV1,
} from './agent-skill-consumption-outbox.ts';
import { opaqueLearningToken } from './learning-outbox.ts';

declare const MEMORY_CONSUMPTION_PREPARATION: unique symbol;

/** Only the issuing host's WeakMap can turn this process-local identity into a real preparation. */
export interface MemoryConsumptionPreparation {
    readonly [MEMORY_CONSUMPTION_PREPARATION]: true;
}

export interface MemoryConsumptionRetainedHit {
    readonly rowId: number;
    readonly code: string;
    readonly contentDigest: string;
}

export interface MemoryConsumptionConsumer {
    readonly runId: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly historyEpoch: number;
}

export interface MemoryConsumptionPayload {
    readonly version: 'maintenance-memory-consumption-v1';
    readonly contentMode: 'nsf' | 'nsfw';
    readonly run: AgentClosureRunInput;
    readonly prerequisites: readonly AgentClosureEventInput[];
    readonly sourcePayloadDigest: string;
    readonly proofDigest: string;
    readonly writeJoinDigest: string;
    readonly intentDigest: string;
    readonly carrierDigest: string;
    readonly consumer: MemoryConsumptionConsumer;
    readonly event: AgentClosureEventInput;
    /** Original accepted-turn identity only; old unbound packets remain byte-compatible. */
    readonly evidenceBinding?: AgentSkillConsumptionEvidenceBindingV1;
}

export interface MemoryConsumptionEntry extends MemoryConsumptionPayload {
    readonly packetDigest: string;
    readonly state: 'pending' | 'delivered' | 'invalidated';
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export interface MemoryConsumptionScan {
    readonly entries: readonly MemoryConsumptionEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface Journal {
    readonly journalVersion: 'maintenance-memory-consumption-journal-v1';
    readonly payload: MemoryConsumptionPayload;
    readonly packetDigest: string;
    readonly state: MemoryConsumptionEntry['state'];
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export const MEMORY_CONSUMPTION_PREFIX = 'maintenance_memory_consumption:';
const MAX_PACKET_CHARS = 32_768;
const PREREQUISITE_TYPES = Object.freeze([
    'execution-completed', 'proposal-persisted', 'artifact-validated', 'apply-committed', 'readback-verified',
]);

export function memoryConsumptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function memoryConsumptionEventKey(consumerRunId: string): string {
    agentClosureToken(consumerRunId, 'consumer-run-id');
    return `memory-consumed-${memoryConsumptionDigest([consumerRunId]).slice('sha256:'.length)}`;
}

function count(value: number, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error('memory-consumption-count-invalid');
    return value;
}

function consumer(input: MemoryConsumptionConsumer): MemoryConsumptionConsumer {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('memory-consumption-consumer-invalid');
    }
    return Object.freeze({
        runId: agentClosureToken(input.runId, 'consumer-run-id'), round: count(input.round, 1),
        assistantMessageId: count(input.assistantMessageId, 1),
        assistantDigest: agentClosureDigest(input.assistantDigest, 'assistant-digest'),
        historyEpoch: count(input.historyEpoch, 0),
    });
}

function validateLineage(run: AgentClosureRunInput, prerequisites: readonly AgentClosureEventInput[],
    event: AgentClosureEventInput, used: MemoryConsumptionConsumer): void {
    const [executed, persisted, validated, applied, readback] = prerequisites;
    if (prerequisites.some((item, index) => item.type !== PREREQUISITE_TYPES[index]
        || item.idempotencyKey !== PREREQUISITE_TYPES[index] || item.skillAttribution !== undefined
        || item.occurredAt < run.admittedAt || item.occurredAt > event.occurredAt
        || index > 0 && item.occurredAt < prerequisites[index - 1]!.occurredAt)
        || [executed, persisted, validated].some((item) => item!.sourceRevision !== run.sourceRevision)
        || persisted!.artifactDigest !== validated!.artifactDigest
        || persisted!.artifactDigest !== applied!.artifactDigest
        || persisted!.evidenceRef !== applied!.evidenceRef || persisted!.evidenceRef !== readback!.evidenceRef
        || !applied!.targetRevision || applied!.targetRevision !== readback!.targetRevision
        || event.type !== 'context-consumed' || event.sourceRevision !== run.sourceRevision
        || event.consumerRunId !== used.runId || event.contextBlock !== 'memory'
        || event.idempotencyKey !== memoryConsumptionEventKey(used.runId) || !event.skillAttribution
        || event.artifactDigest !== readback!.artifactDigest) {
        throw new Error('memory-consumption-lineage-invalid');
    }
}

/** Canonical metadata only. Parsing cannot mint a live preparation or prove a new Provider request. */
export function normalizeMemoryConsumptionPayload(input: MemoryConsumptionPayload): MemoryConsumptionPayload {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || input.version !== 'maintenance-memory-consumption-v1'
        || !['nsf', 'nsfw'].includes(input.contentMode)
        || !Array.isArray(input.prerequisites) || input.prerequisites.length !== 5) {
        throw new Error('memory-consumption-payload-invalid');
    }
    const run = normalizeAgentClosureRun(input.run);
    if (run.capability !== 'maintenance.memory' || run.kind !== 'proposal' || run.lane !== 'maintenance'
        || !/^mjob_[a-f0-9]{32}$/u.test(run.runId)) throw new Error('memory-consumption-run-invalid');
    const prerequisites = Object.freeze(input.prerequisites.map(normalizeAgentClosureEvent));
    const used = consumer(input.consumer);
    const event = normalizeAgentClosureEvent(input.event);
    validateLineage(run, prerequisites, event, used);
    const base = {
        version: input.version, contentMode: input.contentMode, run, prerequisites,
        sourcePayloadDigest: agentClosureDigest(input.sourcePayloadDigest, 'source-payload-digest'),
        proofDigest: agentClosureDigest(input.proofDigest, 'proof-digest'),
        writeJoinDigest: agentClosureDigest(input.writeJoinDigest, 'write-join-digest'),
        intentDigest: agentClosureDigest(input.intentDigest, 'intent-digest'),
        carrierDigest: agentClosureDigest(input.carrierDigest, 'carrier-digest'), consumer: used, event,
    };
    if (input.evidenceBinding === undefined) return Object.freeze(base);
    const evidenceBinding = normalizeAgentSkillConsumptionEvidenceBinding(input.evidenceBinding);
    if (evidenceBinding.identity.sessionId !== opaqueLearningToken('session', run.sessionId)
        || evidenceBinding.identity.contentMode !== input.contentMode
        || JSON.stringify(evidenceBinding.consumer) !== JSON.stringify(used)
        || evidenceBinding.committedAt !== event.occurredAt) {
        throw new Error('memory-consumption-evidence-binding-mismatch');
    }
    return Object.freeze({ ...base, evidenceBinding });
}

export function memoryConsumptionSourceRef(payload: MemoryConsumptionPayload): string {
    return `${MEMORY_CONSUMPTION_PREFIX}${memoryConsumptionDigest([
        payload.run.operationId, payload.consumer.runId,
    ]).slice('sha256:'.length)}`;
}

const key = memoryConsumptionSourceRef;

function entry(record: Journal): MemoryConsumptionEntry {
    return Object.freeze({
        ...record.payload, packetDigest: record.packetDigest, state: record.state,
        deliveredAt: record.deliveredAt, invalidatedAt: record.invalidatedAt, reasonCode: record.reasonCode,
    });
}

function parseJournal(json: string): Journal {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) {
        throw new Error('memory-consumption-journal-too-large');
    }
    const input = JSON.parse(json) as Journal;
    const payload = normalizeMemoryConsumptionPayload(input.payload);
    const normalized: Journal = Object.freeze({
        journalVersion: 'maintenance-memory-consumption-journal-v1', payload,
        packetDigest: memoryConsumptionDigest(payload), state: input.state,
        deliveredAt: input.deliveredAt === null ? null : agentClosureTimestamp(input.deliveredAt, 'delivered-at'),
        invalidatedAt: input.invalidatedAt === null ? null
            : agentClosureTimestamp(input.invalidatedAt, 'invalidated-at'),
        reasonCode: input.reasonCode === null ? null : agentClosureToken(input.reasonCode, 'reason-code'),
    });
    if (!['pending', 'delivered', 'invalidated'].includes(normalized.state)
        || (normalized.state === 'pending' && (normalized.deliveredAt !== null
            || normalized.invalidatedAt !== null || normalized.reasonCode !== null))
        || (normalized.state === 'delivered' && (normalized.deliveredAt === null
            || normalized.invalidatedAt !== null || normalized.reasonCode !== null))
        || (normalized.state === 'invalidated' && (normalized.invalidatedAt === null
            || normalized.reasonCode === null || normalized.deliveredAt !== null))
        || normalized.deliveredAt !== null && normalized.deliveredAt < payload.event.occurredAt
        || normalized.invalidatedAt !== null && normalized.invalidatedAt < payload.event.occurredAt
        || JSON.stringify(normalized) !== json) throw new Error('memory-consumption-journal-corrupt');
    return normalized;
}

/** No DDL. Optional INSERT failures cannot roll back an otherwise valid final business turn. */
export class MaintenanceMemoryConsumptionOutbox {
    constructor(private readonly db: DatabaseSync, private readonly sessionId: string) {
        agentClosureToken(sessionId, 'session-id');
    }

    #outsideTransaction(): void {
        if (this.db.isTransaction !== false) throw new Error('memory-consumption-uncommitted-read');
    }

    #read(payload: MemoryConsumptionPayload): Journal | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, key(payload)) as { value: string } | undefined;
        if (!row) return null;
        const record = parseJournal(row.value);
        if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== key(payload)) {
            throw new Error('memory-consumption-journal-binding-invalid');
        }
        return record;
    }

    #transaction<T>(work: () => T): T {
        this.#outsideTransaction();
        this.db.exec('BEGIN IMMEDIATE;');
        try {
            const result = work();
            if (this.db.isTransaction !== true) throw new Error('memory-consumption-transaction-lost');
            this.db.exec('COMMIT;');
            this.#outsideTransaction();
            return result;
        } catch (error) {
            if (this.db.isTransaction === true) this.db.exec('ROLLBACK;');
            throw error;
        }
    }

    #write(record: Journal): void {
        const json = JSON.stringify(record);
        if (json.length > MAX_PACKET_CHARS) throw new Error('memory-consumption-journal-too-large');
        this.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.sessionId, key(record.payload), json,
                record.invalidatedAt ?? record.deliveredAt ?? record.payload.event.occurredAt);
        if (JSON.stringify(this.#read(record.payload)) !== json) {
            throw new Error('memory-consumption-storage-mismatch');
        }
    }

    enqueue(input: MemoryConsumptionPayload): boolean {
        if (this.db.isTransaction !== true) throw new Error('memory-consumption-business-transaction-required');
        this.db.exec('SAVEPOINT memory_consumption_enqueue;');
        try {
            const payload = normalizeMemoryConsumptionPayload(input);
            if (payload.run.sessionId !== this.sessionId) throw new Error('memory-consumption-session-mismatch');
            const packetDigest = memoryConsumptionDigest(payload);
            const previous = this.#read(payload);
            if (previous && (previous.packetDigest !== packetDigest || previous.state === 'invalidated')) {
                throw new Error('memory-consumption-intent-conflict');
            }
            if (!previous) this.#write({
                journalVersion: 'maintenance-memory-consumption-journal-v1', payload, packetDigest,
                state: 'pending', deliveredAt: null, invalidatedAt: null, reasonCode: null,
            });
            this.db.exec('RELEASE memory_consumption_enqueue;');
            if (this.db.isTransaction !== true) throw new Error('memory-consumption-business-transaction-lost');
            return true;
        } catch (error) {
            if (this.db.isTransaction !== true) throw error;
            this.db.exec('ROLLBACK TO memory_consumption_enqueue; RELEASE memory_consumption_enqueue;');
            return false;
        }
    }

    scan(limit = 64, cursor = 0): MemoryConsumptionScan {
        this.#outsideTransaction();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('memory-consumption-limit-invalid');
        }
        count(cursor, 0);
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.sessionId, `${MEMORY_CONSUMPTION_PREFIX}*`, cursor, limit) as {
                rowid: number; control_key: string; value: string;
            }[];
        const entries: MemoryConsumptionEntry[] = [];
        let failed = 0;
        for (const row of rows) {
            try {
                const record = parseJournal(row.value);
                if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== row.control_key) {
                    throw new Error('memory-consumption-row-binding-invalid');
                }
                if (record.state === 'pending') entries.push(entry(record));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: rows.length, failed,
            nextCursor: rows.length === limit ? Number(rows.at(-1)!.rowid) : 0, hasMore: rows.length === limit,
        });
    }

    /** Historical evidence reads retained rows even after the original Closure delivery was acknowledged. */
    scanRetained(limit = 64, cursor = 0): MemoryConsumptionScan {
        this.#outsideTransaction();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('memory-consumption-limit-invalid');
        }
        count(cursor, 0);
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.sessionId, `${MEMORY_CONSUMPTION_PREFIX}*`, cursor, limit + 1) as {
                rowid: number; control_key: string; value: string;
            }[];
        const page = rows.slice(0, limit);
        const entries: MemoryConsumptionEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                const record = parseJournal(row.value);
                if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== row.control_key) {
                    throw new Error('memory-consumption-row-binding-invalid');
                }
                entries.push(entry(record));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit,
        });
    }

    readBySourceRef(sourceRef: string): MemoryConsumptionEntry | null {
        this.#outsideTransaction();
        if (typeof sourceRef !== 'string'
            || !/^maintenance_memory_consumption:[a-f0-9]{64}$/u.test(sourceRef)) {
            throw new Error('memory-consumption-source-ref-invalid');
        }
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, sourceRef) as { value: string } | undefined;
        if (!row) return null;
        const record = parseJournal(row.value);
        if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== sourceRef) {
            throw new Error('memory-consumption-row-binding-invalid');
        }
        return entry(record);
    }

    /** One deferred read snapshot, usable on a read-only SQLite connection; never acknowledges a source row. */
    consumerIsCurrentReadOnly(value: MemoryConsumptionEntry): boolean {
        this.#outsideTransaction();
        const payload = normalizeMemoryConsumptionPayload(value);
        if (memoryConsumptionDigest(payload) !== value.packetDigest) {
            throw new Error('memory-consumption-entry-digest-invalid');
        }
        if (value.state === 'invalidated') return false;
        this.db.exec('BEGIN;');
        try {
            const record = this.#read(payload);
            return record?.packetDigest === value.packetDigest && record.state !== 'invalidated'
                && this.#consumerCurrent(payload, true);
        } finally {
            if (this.db.isTransaction === true) this.db.exec('ROLLBACK;');
        }
    }

    #consumerCurrent(payload: MemoryConsumptionPayload, canonicalEpoch = false): boolean {
        const used = payload.consumer;
        const row = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
            .get(used.assistantMessageId) as { round: number; role: string; content: string } | undefined;
        const epoch = this.db.prepare(`SELECT value FROM session_control
            WHERE session_key=? AND control_key='history_epoch'`).get(this.sessionId) as { value: string } | undefined;
        const currentEpoch = epoch ? Number(epoch.value) : 0;
        if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0 || currentEpoch !== used.historyEpoch
            || canonicalEpoch && epoch !== undefined && String(currentEpoch) !== epoch.value
            || !row || row.round !== used.round || row.role !== 'assistant' || typeof row.content !== 'string'
            || memoryConsumptionDigest(row.content) !== used.assistantDigest) return false;
        const marker = this.db.prepare('SELECT * FROM turn_job_outcome WHERE run_id=?').get(used.runId) as {
            session_id: string; round: number; assistant_message_id: number; revision: string;
            action: string; committed_at: string;
        } | undefined;
        if (marker && (!['turn', 'regenerate'].includes(marker.action)
            || typeof marker.committed_at !== 'string' || !Number.isFinite(Date.parse(marker.committed_at))
            || new Date(marker.committed_at).toISOString() !== marker.committed_at)) return false;
        return !marker || marker.session_id === this.sessionId && marker.round === used.round
            && marker.assistant_message_id === used.assistantMessageId
            && marker.revision === `round-${used.round}-assistant-${used.assistantMessageId}`;
    }

    /** The consumer is checked against its own commit epoch, not the older producer write epoch. */
    consumerIsCurrent(value: MemoryConsumptionEntry): boolean {
        const payload = normalizeMemoryConsumptionPayload(value);
        if (memoryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('memory-consumption-entry-digest-invalid');
        }
        return this.#transaction(() => {
            const record = this.#read(payload);
            return record?.packetDigest === value.packetDigest && record.state === 'pending'
                && this.#consumerCurrent(payload);
        });
    }

    acknowledge(value: MemoryConsumptionEntry, at: string): void {
        const payload = normalizeMemoryConsumptionPayload(value);
        if (memoryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('memory-consumption-entry-digest-invalid');
        }
        const deliveredAt = agentClosureTimestamp(at, 'delivered-at');
        this.#transaction(() => {
            const record = this.#read(payload);
            if (!record || record.packetDigest !== value.packetDigest || record.state === 'invalidated'
                || deliveredAt < payload.event.occurredAt || !this.#consumerCurrent(payload)) {
                throw new Error('memory-consumption-ack-conflict');
            }
            if (record.state === 'delivered') return;
            this.#write({ ...record, state: 'delivered', deliveredAt });
        });
    }

    /** Retains the original intent; invalidation never fabricates a producer rollback. */
    invalidate(value: MemoryConsumptionEntry, at: string, reasonCode: string): void {
        const payload = normalizeMemoryConsumptionPayload(value);
        if (memoryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('memory-consumption-entry-digest-invalid');
        }
        const invalidatedAt = agentClosureTimestamp(at, 'invalidated-at');
        const reason = agentClosureToken(reasonCode, 'reason-code');
        this.#transaction(() => {
            const record = this.#read(payload);
            if (!record || record.packetDigest !== value.packetDigest || invalidatedAt < payload.event.occurredAt) {
                throw new Error('memory-consumption-invalidate-conflict');
            }
            if (record.state !== 'pending') return;
            this.#write({ ...record, state: 'invalidated', invalidatedAt, reasonCode: reason });
        });
    }
}

export { MaintenanceMemoryConsumptionOutbox as MemoryConsumptionOutbox };
