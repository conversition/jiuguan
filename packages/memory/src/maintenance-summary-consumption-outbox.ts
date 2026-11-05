/** @author Codex @date 2026-10-14 @version 1.0
 * Committed Summary adoption metadata belongs to the consuming Session, never a second business writer.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureOperationId, agentClosureTimestamp, agentClosureToken, normalizeAgentClosureEvent,
    normalizeAgentClosureRun, type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../agent-closure/index.ts';
import {
    normalizeAgentSkillConsumptionEvidenceBinding, type AgentSkillConsumptionEvidenceBindingV1,
} from './agent-skill-consumption-outbox.ts';
import { opaqueLearningToken } from './learning-outbox.ts';

declare const SUMMARY_CONSUMPTION_PREPARATION: unique symbol;

/** Only the issuing host's WeakMap can turn this process-local identity into a real preparation. */
export interface SummaryConsumptionPreparation {
    readonly [SUMMARY_CONSUMPTION_PREPARATION]: true;
}

export interface SummaryConsumptionSummary {
    readonly summaryDigest: string;
    readonly throughRound: number;
    readonly historyEpoch: number;
}

export interface SummaryConsumptionConsumer {
    readonly runId: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly historyEpoch: number;
}

export interface SummaryConsumptionPayload {
    readonly version: 'maintenance-summary-consumption-v1';
    readonly contentMode: 'nsf' | 'nsfw';
    readonly run: AgentClosureRunInput;
    readonly prerequisites: readonly AgentClosureEventInput[];
    readonly sourcePayloadDigest: string;
    readonly proofDigest: string;
    readonly writeJoinDigest: string;
    readonly intentDigest: string;
    readonly carrierDigest: string;
    readonly summary: SummaryConsumptionSummary;
    readonly consumer: SummaryConsumptionConsumer;
    readonly event: AgentClosureEventInput;
    /** Original accepted-turn identity only; old unbound packets remain byte-compatible. */
    readonly evidenceBinding?: AgentSkillConsumptionEvidenceBindingV1;
}

export interface SummaryConsumptionEntry extends SummaryConsumptionPayload {
    readonly packetDigest: string;
    readonly state: 'pending' | 'delivered' | 'invalidated';
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export interface SummaryConsumptionScan {
    readonly entries: readonly SummaryConsumptionEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface Journal {
    readonly journalVersion: 'maintenance-summary-consumption-journal-v1';
    readonly payload: SummaryConsumptionPayload;
    readonly packetDigest: string;
    readonly state: SummaryConsumptionEntry['state'];
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export const SUMMARY_CONSUMPTION_PREFIX = 'maintenance_summary_consumption:';
export const SUMMARY_CURRENT_OWNER_KEY = 'maintenance_summary_current_owner';
const MAX_PACKET_CHARS = 32_768;
const PREREQUISITE_TYPES = Object.freeze([
    'execution-completed', 'proposal-persisted', 'artifact-validated', 'apply-committed', 'readback-verified',
]);

export function summaryConsumptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function summaryConsumptionEventKey(consumerRunId: string): string {
    agentClosureToken(consumerRunId, 'consumer-run-id');
    return `summary-consumed-${summaryConsumptionDigest([consumerRunId]).slice('sha256:'.length)}`;
}

function count(value: number, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error('summary-consumption-count-invalid');
    return value;
}

function consumer(input: SummaryConsumptionConsumer): SummaryConsumptionConsumer {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('summary-consumption-consumer-invalid');
    }
    return Object.freeze({
        runId: agentClosureToken(input.runId, 'consumer-run-id'), round: count(input.round, 1),
        assistantMessageId: count(input.assistantMessageId, 1),
        assistantDigest: agentClosureDigest(input.assistantDigest, 'assistant-digest'),
        historyEpoch: count(input.historyEpoch, 0),
    });
}

function validateLineage(run: AgentClosureRunInput, prerequisites: readonly AgentClosureEventInput[],
    event: AgentClosureEventInput, used: SummaryConsumptionConsumer): void {
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
        || event.consumerRunId !== used.runId || event.contextBlock !== 'summary'
        || event.idempotencyKey !== summaryConsumptionEventKey(used.runId) || !event.skillAttribution
        || event.artifactDigest !== readback!.artifactDigest || event.itemCount !== 1
        || event.targetRevision !== readback!.targetRevision || event.evidenceRef !== persisted!.evidenceRef) {
        throw new Error('summary-consumption-lineage-invalid');
    }
}

/** Canonical metadata only. Parsing cannot mint a live preparation or prove a new Provider request. */
export function normalizeSummaryConsumptionPayload(input: SummaryConsumptionPayload): SummaryConsumptionPayload {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || input.version !== 'maintenance-summary-consumption-v1'
        || !['nsf', 'nsfw'].includes(input.contentMode)
        || !Array.isArray(input.prerequisites) || input.prerequisites.length !== 5) {
        throw new Error('summary-consumption-payload-invalid');
    }
    const run = normalizeAgentClosureRun(input.run);
    if (run.capability !== 'maintenance.memory' || run.kind !== 'proposal' || run.lane !== 'maintenance'
        || !/^mjob_[a-f0-9]{32}$/u.test(run.runId)
        || run.operationId !== agentClosureOperationId('maintenance', run.runId, 'rolling_summary')) {
        throw new Error('summary-consumption-run-invalid');
    }
    if (!input.summary || typeof input.summary !== 'object' || Array.isArray(input.summary)) {
        throw new Error('summary-consumption-summary-invalid');
    }
    const summary = Object.freeze({
        summaryDigest: agentClosureDigest(input.summary.summaryDigest, 'summary-digest'),
        throughRound: count(input.summary.throughRound, 1), historyEpoch: count(input.summary.historyEpoch, 0),
    });
    const prerequisites = Object.freeze(input.prerequisites.map(normalizeAgentClosureEvent));
    const used = consumer(input.consumer);
    if (used.round <= summary.throughRound || used.historyEpoch !== summary.historyEpoch) {
        throw new Error('summary-consumption-consumer-boundary-invalid');
    }
    const event = normalizeAgentClosureEvent(input.event);
    validateLineage(run, prerequisites, event, used);
    const base = {
        version: input.version, contentMode: input.contentMode, run, prerequisites,
        sourcePayloadDigest: agentClosureDigest(input.sourcePayloadDigest, 'source-payload-digest'),
        proofDigest: agentClosureDigest(input.proofDigest, 'proof-digest'),
        writeJoinDigest: agentClosureDigest(input.writeJoinDigest, 'write-join-digest'),
        intentDigest: agentClosureDigest(input.intentDigest, 'intent-digest'),
        carrierDigest: agentClosureDigest(input.carrierDigest, 'carrier-digest'), summary, consumer: used, event,
    };
    if (input.evidenceBinding === undefined) return Object.freeze(base);
    const evidenceBinding = normalizeAgentSkillConsumptionEvidenceBinding(input.evidenceBinding);
    if (evidenceBinding.identity.sessionId !== opaqueLearningToken('session', run.sessionId)
        || evidenceBinding.identity.contentMode !== input.contentMode
        || JSON.stringify(evidenceBinding.consumer) !== JSON.stringify(used)
        || evidenceBinding.committedAt !== event.occurredAt) {
        throw new Error('summary-consumption-evidence-binding-mismatch');
    }
    return Object.freeze({ ...base, evidenceBinding });
}

export function summaryConsumptionSourceRef(payload: SummaryConsumptionPayload): string {
    return `${SUMMARY_CONSUMPTION_PREFIX}${summaryConsumptionDigest([
        payload.run.operationId, payload.consumer.runId,
    ]).slice('sha256:'.length)}`;
}

const key = summaryConsumptionSourceRef;

function entry(record: Journal): SummaryConsumptionEntry {
    return Object.freeze({
        ...record.payload, packetDigest: record.packetDigest, state: record.state,
        deliveredAt: record.deliveredAt, invalidatedAt: record.invalidatedAt, reasonCode: record.reasonCode,
    });
}

function parseJournal(json: string): Journal {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) {
        throw new Error('summary-consumption-journal-too-large');
    }
    const input = JSON.parse(json) as Journal;
    const payload = normalizeSummaryConsumptionPayload(input.payload);
    const normalized: Journal = Object.freeze({
        journalVersion: 'maintenance-summary-consumption-journal-v1', payload,
        packetDigest: summaryConsumptionDigest(payload), state: input.state,
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
        || JSON.stringify(normalized) !== json) throw new Error('summary-consumption-journal-corrupt');
    return normalized;
}

/** No DDL. Optional INSERT failures cannot roll back an otherwise valid final business turn. */
export class MaintenanceSummaryConsumptionOutbox {
    constructor(private readonly db: DatabaseSync, private readonly sessionId: string) {
        agentClosureToken(sessionId, 'session-id');
    }

    #outsideTransaction(): void {
        if (this.db.isTransaction !== false) throw new Error('summary-consumption-uncommitted-read');
    }

    #read(payload: SummaryConsumptionPayload): Journal | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, key(payload)) as { value: string; } | undefined;
        if (!row) return null;
        const record = parseJournal(row.value);
        if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== key(payload)) {
            throw new Error('summary-consumption-journal-binding-invalid');
        }
        return record;
    }

    #transaction<T>(work: () => T): T {
        this.#outsideTransaction();
        this.db.exec('BEGIN IMMEDIATE;');
        try {
            const result = work();
            if (this.db.isTransaction !== true) throw new Error('summary-consumption-transaction-lost');
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
        if (json.length > MAX_PACKET_CHARS) throw new Error('summary-consumption-journal-too-large');
        this.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.sessionId, key(record.payload), json,
                record.invalidatedAt ?? record.deliveredAt ?? record.payload.event.occurredAt);
        if (JSON.stringify(this.#read(record.payload)) !== json) {
            throw new Error('summary-consumption-storage-mismatch');
        }
    }

    enqueue(input: SummaryConsumptionPayload): boolean {
        if (this.db.isTransaction !== true) throw new Error('summary-consumption-business-transaction-required');
        this.db.exec('SAVEPOINT summary_consumption_enqueue;');
        try {
            const payload = normalizeSummaryConsumptionPayload(input);
            if (payload.run.sessionId !== this.sessionId) throw new Error('summary-consumption-session-mismatch');
            const packetDigest = summaryConsumptionDigest(payload);
            const previous = this.#read(payload);
            if (previous && (previous.packetDigest !== packetDigest || previous.state === 'invalidated')) {
                throw new Error('summary-consumption-intent-conflict');
            }
            if (!previous) this.#write({
                journalVersion: 'maintenance-summary-consumption-journal-v1', payload, packetDigest,
                state: 'pending', deliveredAt: null, invalidatedAt: null, reasonCode: null,
            });
            this.db.exec('RELEASE summary_consumption_enqueue;');
            if (this.db.isTransaction !== true) throw new Error('summary-consumption-business-transaction-lost');
            return true;
        } catch (error) {
            if (this.db.isTransaction !== true) throw error;
            this.db.exec('ROLLBACK TO summary_consumption_enqueue; RELEASE summary_consumption_enqueue;');
            return false;
        }
    }

    scan(limit = 64, cursor = 0): SummaryConsumptionScan {
        this.#outsideTransaction();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('summary-consumption-limit-invalid');
        }
        count(cursor, 0);
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.sessionId, `${SUMMARY_CONSUMPTION_PREFIX}*`, cursor, limit) as {
                rowid: number; control_key: string; value: string;
            }[];
        const entries: SummaryConsumptionEntry[] = [];
        let failed = 0;
        for (const row of rows) {
            try {
                const record = parseJournal(row.value);
                if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== row.control_key) {
                    throw new Error('summary-consumption-row-binding-invalid');
                }
                if (record.state === 'pending') entries.push(entry(record));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: rows.length, failed,
            nextCursor: rows.length === limit ? Number(rows.at(-1)!.rowid) : 0, hasMore: rows.length === limit,
        });
    }

    /** Historical evidence reads retained rows after the original Closure delivery was acknowledged. */
    scanRetained(limit = 64, cursor = 0): SummaryConsumptionScan {
        this.#outsideTransaction();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('summary-consumption-limit-invalid');
        }
        count(cursor, 0);
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.sessionId, `${SUMMARY_CONSUMPTION_PREFIX}*`, cursor, limit + 1) as {
                rowid: number; control_key: string; value: string;
            }[];
        const page = rows.slice(0, limit);
        const entries: SummaryConsumptionEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                const record = parseJournal(row.value);
                if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== row.control_key) {
                    throw new Error('summary-consumption-row-binding-invalid');
                }
                entries.push(entry(record));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit,
        });
    }

    readBySourceRef(sourceRef: string): SummaryConsumptionEntry | null {
        this.#outsideTransaction();
        if (typeof sourceRef !== 'string'
            || !/^maintenance_summary_consumption:[a-f0-9]{64}$/u.test(sourceRef)) {
            throw new Error('summary-consumption-source-ref-invalid');
        }
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, sourceRef) as { value: string; } | undefined;
        if (!row) return null;
        const record = parseJournal(row.value);
        if (record.payload.run.sessionId !== this.sessionId || key(record.payload) !== sourceRef) {
            throw new Error('summary-consumption-row-binding-invalid');
        }
        return entry(record);
    }

    /** One deferred snapshot, usable on a read-only SQLite connection; never acknowledges a source row. */
    consumerIsCurrentReadOnly(value: SummaryConsumptionEntry): boolean {
        this.#outsideTransaction();
        const payload = normalizeSummaryConsumptionPayload(value);
        if (summaryConsumptionDigest(payload) !== value.packetDigest) {
            throw new Error('summary-consumption-entry-digest-invalid');
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

    #consumerCurrent(payload: SummaryConsumptionPayload, canonicalEpoch = false): boolean {
        const used = payload.consumer;
        const row = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
            .get(used.assistantMessageId) as { round: number; role: string; content: string; } | undefined;
        const epoch = this.db.prepare(`SELECT value FROM session_control
            WHERE session_key=? AND control_key='history_epoch'`).get(this.sessionId) as { value: string; } | undefined;
        const currentEpoch = epoch ? Number(epoch.value) : 0;
        if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0 || currentEpoch !== used.historyEpoch
            || canonicalEpoch && epoch !== undefined && String(currentEpoch) !== epoch.value
            || !row || row.round !== used.round || row.role !== 'assistant' || typeof row.content !== 'string'
            || summaryConsumptionDigest(row.content) !== used.assistantDigest) return false;
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
    consumerIsCurrent(value: SummaryConsumptionEntry): boolean {
        const payload = normalizeSummaryConsumptionPayload(value);
        if (summaryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('summary-consumption-entry-digest-invalid');
        }
        return this.#transaction(() => {
            const record = this.#read(payload);
            return record?.packetDigest === value.packetDigest && record.state === 'pending'
                && this.#consumerCurrent(payload);
        });
    }

    acknowledge(value: SummaryConsumptionEntry, at: string): void {
        const payload = normalizeSummaryConsumptionPayload(value);
        if (summaryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('summary-consumption-entry-digest-invalid');
        }
        const deliveredAt = agentClosureTimestamp(at, 'delivered-at');
        this.#transaction(() => {
            const record = this.#read(payload);
            if (!record || record.packetDigest !== value.packetDigest || record.state === 'invalidated'
                || deliveredAt < payload.event.occurredAt || !this.#consumerCurrent(payload)) {
                throw new Error('summary-consumption-ack-conflict');
            }
            if (record.state === 'delivered') return;
            this.#write({ ...record, state: 'delivered', deliveredAt });
        });
    }

    /** Retains the original intent; invalidation never fabricates a producer rollback. */
    invalidate(value: SummaryConsumptionEntry, at: string, reasonCode: string): void {
        const payload = normalizeSummaryConsumptionPayload(value);
        if (summaryConsumptionDigest(payload) !== value.packetDigest || value.state !== 'pending') {
            throw new Error('summary-consumption-entry-digest-invalid');
        }
        const invalidatedAt = agentClosureTimestamp(at, 'invalidated-at');
        const reason = agentClosureToken(reasonCode, 'reason-code');
        this.#transaction(() => {
            const record = this.#read(payload);
            if (!record || record.packetDigest !== value.packetDigest || invalidatedAt < payload.event.occurredAt) {
                throw new Error('summary-consumption-invalidate-conflict');
            }
            if (record.state !== 'pending') return;
            this.#write({ ...record, state: 'invalidated', invalidatedAt, reasonCode: reason });
        });
    }
}

export { MaintenanceSummaryConsumptionOutbox as SummaryConsumptionOutbox };
