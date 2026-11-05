/** @author Codex @date 2026-10-16 @version 1.1
 * Retained Skill consumption packets with optional committed-consumer evidence, never replay authority.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken,
    normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../agent-closure/index.ts';
import { opaqueLearningToken, sha256Digest } from './learning-outbox.ts';
import { parseContextCompilerSkillSourceReceipt, type ContextCompilerSkillSourceReceipt }
    from './context-compiler-skill-source.ts';
import { parseCriticSkillSourceReceipt, criticSkillSourceEvidenceDigest, type CriticSkillSourceReceiptV1 }
    from './critic-skill-source.ts';
import { parsePreludeSkillSourceReceipt, preludeSkillSourceEvidenceDigest, type PreludeSkillSourceReceiptV1 }
    from './prelude-skill-source.ts';

export interface AgentSkillConsumptionEvidenceBindingV1 {
    readonly bindingVersion: 'agent-skill-consumption-binding-v1';
    readonly identity: Readonly<{ sessionId: string; cardId: string; contentMode: 'nsf' | 'nsfw' }>;
    readonly consumer: Readonly<{
        runId: string; round: number; assistantMessageId: number; assistantDigest: string; historyEpoch: number;
    }>;
    readonly committedAt: string;
}

export interface AgentSkillConsumptionOutboxPayloadV1 {
    readonly run: AgentClosureRunInput;
    readonly event: AgentClosureEventInput;
    /** Original-phase receipts for recovery when the central sidecar missed those observations. */
    readonly prerequisites?: readonly AgentClosureEventInput[];
    readonly evidenceBinding?: AgentSkillConsumptionEvidenceBindingV1;
    /** Present only for an independently bound, actual Context Compiler request. */
    readonly contextCompilerSource?: ContextCompilerSkillSourceReceipt;
    /** Present only for the actual sanitized Critic input and adopted repair. */
    readonly criticSource?: CriticSkillSourceReceiptV1;
    /** Present only for the actual ordered Prelude requests and bounded tool provenance. */
    readonly preludeSource?: PreludeSkillSourceReceiptV1;
}

export interface AgentSkillConsumptionOutboxEntryV1 extends AgentSkillConsumptionOutboxPayloadV1 {
    readonly entryId: string;
    readonly payloadDigest: string;
}

export interface AgentSkillConsumptionOutboxScan {
    readonly entries: readonly AgentSkillConsumptionOutboxEntryV1[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface StoredRow {
    entry_id: string;
    session_id: string;
    payload_digest: string;
    payload_json: string;
}

const TABLE = 'agent_skill_consumption_outbox';
const MAX_PAYLOAD_CHARS = 32_768;
const RUN_FIELDS = ['operationId', 'runId', 'parentRunId', 'sessionId', 'capability', 'lane', 'kind',
    'executionClass', 'sourceRevision', 'policyVersion', 'evidenceDigest', 'admittedAt'];
const EVENT_FIELDS = ['type', 'idempotencyKey', 'occurredAt', 'artifactDigest', 'evidenceRef', 'sourceRevision',
    'targetRevision', 'consumerRunId', 'contextBlock', 'reasonCode', 'itemCount', 'tokenCount',
    'effectOutcome', 'skillAttribution'];
const CONTEXT_BLOCKS: Readonly<Record<string, string>> = Object.freeze({
    'context.compiler': 'contextCapsule',
    'interactive.critic': 'criticRevision',
    'interactive.prelude': 'interactivePrelude',
});

function digest(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('skill-outbox-binding-record-invalid');
    }
    return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new Error('skill-outbox-binding-fields-invalid');
    }
}

function allowedKeys(input: unknown, expected: readonly string[]): void {
    if (Object.keys(record(input)).some((key) => !expected.includes(key))) {
        throw new Error('skill-outbox-binding-fields-invalid');
    }
}

function count(value: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error('skill-outbox-binding-count-invalid');
    return Number(value);
}

/** Strict metadata-only normalization; neither current configuration nor prompts enter historical identity. */
export function normalizeAgentSkillConsumptionEvidenceBinding(input: unknown): AgentSkillConsumptionEvidenceBindingV1 {
    const value = record(input);
    exactKeys(value, ['bindingVersion', 'identity', 'consumer', 'committedAt']);
    const identity = record(value.identity);
    const consumer = record(value.consumer);
    exactKeys(identity, ['sessionId', 'cardId', 'contentMode']);
    exactKeys(consumer, ['runId', 'round', 'assistantMessageId', 'assistantDigest', 'historyEpoch']);
    if (value.bindingVersion !== 'agent-skill-consumption-binding-v1'
        || identity.contentMode !== 'nsf' && identity.contentMode !== 'nsfw') {
        throw new Error('skill-outbox-binding-version-or-mode-invalid');
    }
    return Object.freeze({
        bindingVersion: 'agent-skill-consumption-binding-v1',
        identity: Object.freeze({
            sessionId: agentClosureToken(identity.sessionId, 'binding-session-id'),
            cardId: agentClosureToken(identity.cardId, 'binding-card-id'),
            contentMode: identity.contentMode,
        }),
        consumer: Object.freeze({
            runId: agentClosureToken(consumer.runId, 'binding-run-id'), round: count(consumer.round, 1),
            assistantMessageId: count(consumer.assistantMessageId, 1),
            assistantDigest: agentClosureDigest(consumer.assistantDigest, 'binding-assistant-digest'),
            historyEpoch: count(consumer.historyEpoch),
        }),
        committedAt: agentClosureTimestamp(value.committedAt, 'binding-committed-at'),
    });
}

/** Unbound legacy normalization and JSON property order remain unchanged. */
export function normalizeAgentSkillConsumptionPayload(input: unknown): AgentSkillConsumptionOutboxPayloadV1 {
    const value = record(input);
    // A present malformed extension cannot be silently erased into the legacy packet dialect.
    const sourceDescriptor = Object.getOwnPropertyDescriptor(value, 'contextCompilerSource');
    if (sourceDescriptor && (!Object.hasOwn(sourceDescriptor, 'value') || sourceDescriptor.value === undefined
        || !sourceDescriptor.enumerable)) throw new Error('skill-outbox-context-source-invalid');
    const criticDescriptor = Object.getOwnPropertyDescriptor(value, 'criticSource');
    if (criticDescriptor && (!Object.hasOwn(criticDescriptor, 'value') || criticDescriptor.value === undefined
        || !criticDescriptor.enumerable)) throw new Error('skill-outbox-critic-source-invalid');
    const preludeDescriptor = Object.getOwnPropertyDescriptor(value, 'preludeSource');
    if (preludeDescriptor && (!Object.hasOwn(preludeDescriptor, 'value') || preludeDescriptor.value === undefined
        || !preludeDescriptor.enumerable)) throw new Error('skill-outbox-prelude-source-invalid');
    if ([sourceDescriptor, criticDescriptor, preludeDescriptor].filter(Boolean).length > 1) {
        throw new Error('skill-outbox-source-extensions-conflict');
    }
    const run = normalizeAgentClosureRun(value.run as AgentClosureRunInput);
    const event = normalizeAgentClosureEvent(value.event as AgentClosureEventInput);
    if (event.type !== 'context-consumed' || !event.skillAttribution
        || event.sourceRevision !== run.sourceRevision) throw new Error('skill-outbox-consumption-invalid');
    let prerequisites: readonly AgentClosureEventInput[] | undefined;
    if (value.prerequisites !== undefined) {
        if (!Array.isArray(value.prerequisites) || value.prerequisites.length !== 2) {
            throw new Error('skill-outbox-prerequisites-invalid');
        }
        prerequisites = Object.freeze(value.prerequisites.map(normalizeAgentClosureEvent));
        const [executed, validated] = prerequisites;
        if (executed.type !== 'execution-completed' || executed.idempotencyKey !== 'execution-completed'
            || validated.type !== 'artifact-validated' || validated.idempotencyKey !== 'artifact-validated'
            || validated.artifactDigest !== event.artifactDigest
            || prerequisites.some((item) => item.sourceRevision !== run.sourceRevision
                || item.skillAttribution !== undefined || item.occurredAt < run.admittedAt
                || item.occurredAt > event.occurredAt)
            || executed.occurredAt > validated.occurredAt) throw new Error('skill-outbox-prerequisites-invalid');
    }
    let contextCompilerSource: ContextCompilerSkillSourceReceipt | undefined;
    if (sourceDescriptor) {
        contextCompilerSource = parseContextCompilerSkillSourceReceipt(sourceDescriptor.value);
        if (run.capability !== 'context.compiler' || run.lane !== 'interactive' || run.kind !== 'advisory'
            || event.contextBlock !== 'contextCapsule' || event.consumerRunId !== run.runId
            || contextCompilerSource.sessionId !== run.sessionId || contextCompilerSource.runId !== run.runId
            || contextCompilerSource.sourceRevision !== run.sourceRevision
            || contextCompilerSource.policyVersion !== run.policyVersion
            || contextCompilerSource.manifest.sourceDigest !== run.evidenceDigest
            || contextCompilerSource.capsuleDigest !== event.artifactDigest
            || event.tokenCount === undefined) throw new Error('skill-outbox-context-source-binding-mismatch');
        allowedKeys(value, ['run', 'event', 'prerequisites', 'evidenceBinding', 'contextCompilerSource', 'criticSource', 'preludeSource']);
        allowedKeys(value.run, RUN_FIELDS);
        allowedKeys(value.event, EVENT_FIELDS);
        if (Array.isArray(value.prerequisites)) value.prerequisites.forEach((item) => allowedKeys(item, EVENT_FIELDS));
    }
    let criticSource: CriticSkillSourceReceiptV1 | undefined;
    if (criticDescriptor) {
        criticSource = parseCriticSkillSourceReceipt(criticDescriptor.value);
        if (run.capability !== 'interactive.critic' || run.lane !== 'interactive' || run.kind !== 'advisory'
            || event.contextBlock !== 'criticRevision' || event.consumerRunId !== run.runId
            || criticSource.sessionId !== run.sessionId || criticSource.runId !== run.runId
            || criticSource.sourceRevision !== run.sourceRevision || criticSource.policyVersion !== run.policyVersion
            || criticSource.artifactDigest !== event.artifactDigest
            || criticSkillSourceEvidenceDigest(criticSource) !== run.evidenceDigest) {
            throw new Error('skill-outbox-critic-source-binding-mismatch');
        }
        allowedKeys(value, ['run', 'event', 'prerequisites', 'evidenceBinding', 'contextCompilerSource', 'criticSource', 'preludeSource']);
        allowedKeys(value.run, RUN_FIELDS);
        allowedKeys(value.event, EVENT_FIELDS);
        if (Array.isArray(value.prerequisites)) value.prerequisites.forEach((item) => allowedKeys(item, EVENT_FIELDS));
    }
    let preludeSource: PreludeSkillSourceReceiptV1 | undefined;
    if (preludeDescriptor) {
        preludeSource = parsePreludeSkillSourceReceipt(preludeDescriptor.value);
        if (run.capability !== 'interactive.prelude' || run.lane !== 'interactive' || run.kind !== 'advisory'
            || event.contextBlock !== 'interactivePrelude' || event.consumerRunId !== run.runId
            || preludeSource.sessionId !== run.sessionId || preludeSource.runId !== run.runId
            || preludeSource.sourceRevision !== run.sourceRevision || preludeSource.policyVersion !== run.policyVersion
            || preludeSource.artifactDigest !== event.artifactDigest
            || preludeSkillSourceEvidenceDigest(preludeSource.requestDigests) !== run.evidenceDigest) {
            throw new Error('skill-outbox-prelude-source-binding-mismatch');
        }
        allowedKeys(value, ['run', 'event', 'prerequisites', 'evidenceBinding', 'contextCompilerSource', 'criticSource', 'preludeSource']);
        allowedKeys(value.run, RUN_FIELDS);
        allowedKeys(value.event, EVENT_FIELDS);
        if (Array.isArray(value.prerequisites)) value.prerequisites.forEach((item) => allowedKeys(item, EVENT_FIELDS));
    }
    const base = { run, event, ...(prerequisites === undefined ? {} : { prerequisites }),
        ...(contextCompilerSource === undefined ? {} : { contextCompilerSource }),
        ...(criticSource === undefined ? {} : { criticSource }),
        ...(preludeSource === undefined ? {} : { preludeSource }) };
    if (value.evidenceBinding === undefined) return Object.freeze(base);
    allowedKeys(value, ['run', 'event', 'prerequisites', 'evidenceBinding', 'contextCompilerSource', 'criticSource', 'preludeSource']);
    allowedKeys(value.run, RUN_FIELDS);
    allowedKeys(value.event, EVENT_FIELDS);
    if (Array.isArray(value.prerequisites)) value.prerequisites.forEach((item) => allowedKeys(item, EVENT_FIELDS));
    const evidenceBinding = normalizeAgentSkillConsumptionEvidenceBinding(value.evidenceBinding);
    if (run.lane !== 'interactive' || run.kind !== 'advisory' || !Object.hasOwn(CONTEXT_BLOCKS, run.capability)
        || event.contextBlock !== CONTEXT_BLOCKS[run.capability]
        || evidenceBinding.identity.sessionId !== opaqueLearningToken('session', run.sessionId)
        || evidenceBinding.consumer.runId !== run.runId || event.consumerRunId !== run.runId
        || event.occurredAt < run.admittedAt || event.occurredAt > evidenceBinding.committedAt) {
        throw new Error('skill-outbox-evidence-binding-mismatch');
    }
    return Object.freeze({ ...base, evidenceBinding });
}

/** The owner supplies the committed assistant; this pure helper does not authorize a replay or model call. */
export function bindAgentSkillConsumptionEvidence(
    payload: AgentSkillConsumptionOutboxPayloadV1,
    binding: AgentSkillConsumptionEvidenceBindingV1,
): AgentSkillConsumptionOutboxPayloadV1 {
    if (payload.evidenceBinding !== undefined) throw new Error('skill-outbox-evidence-already-bound');
    const bound = normalizeAgentSkillConsumptionPayload({ ...payload, evidenceBinding: binding });
    if (JSON.stringify(bound).length > MAX_PAYLOAD_CHARS) throw new Error('skill-outbox-payload-too-large');
    return bound;
}

function entryIdOf(payload: AgentSkillConsumptionOutboxPayloadV1): string {
    return `skill-use:${digest(JSON.stringify([
        payload.run.operationId, payload.event.idempotencyKey,
    ])).slice('sha256:'.length)}`;
}

function parseRow(row: StoredRow): AgentSkillConsumptionOutboxEntryV1 {
    if (typeof row.payload_json !== 'string' || row.payload_json.length > MAX_PAYLOAD_CHARS
        || digest(row.payload_json) !== row.payload_digest) throw new Error('skill-outbox-payload-corrupt');
    const payload = normalizeAgentSkillConsumptionPayload(JSON.parse(row.payload_json));
    if (JSON.stringify(payload) !== row.payload_json || payload.run.sessionId !== row.session_id
        || row.entry_id !== entryIdOf(payload)) throw new Error('skill-outbox-binding-corrupt');
    return Object.freeze({ ...payload, entryId: row.entry_id, payloadDigest: row.payload_digest });
}

/** Authoritative final-transaction outbox; retained reads do not restore source runtime authority. */
export class AgentSkillConsumptionOutbox {
    static openExisting(db: DatabaseSync): AgentSkillConsumptionOutbox | null {
        if (db.isTransaction) throw new Error('skill-outbox-uncommitted-open-forbidden');
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
            ? new AgentSkillConsumptionOutbox(db) : null;
    }

    /** No schema creation, acknowledgment, migration or packet mutation, including on a legacy database. */
    static openExistingReadOnly(db: DatabaseSync): AgentSkillConsumptionOutbox | null {
        if (db.isTransaction) throw new Error('skill-outbox-uncommitted-open-forbidden');
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
            ? new AgentSkillConsumptionOutbox(db, true) : null;
    }

    constructor(private readonly db: DatabaseSync, private readonly readOnly = false) {
        if (db.isTransaction) throw new Error('skill-outbox-schema-in-transaction');
        if (!readOnly) db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
            entry_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK(length(payload_json)<=${MAX_PAYLOAD_CHARS}),
            delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))
        );`);
        const columns = (db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[])
            .map((row) => row.name);
        if (JSON.stringify(columns) !== JSON.stringify([
            'entry_id', 'session_id', 'payload_digest', 'payload_json', 'delivered',
        ])) throw new Error('skill-outbox-schema-invalid');
    }

    #mutation(): void {
        if (this.readOnly) throw new Error('skill-outbox-readonly-mutation-forbidden');
    }

    #committed(): void {
        if (this.db.isTransaction) throw new Error('skill-outbox-uncommitted-read-forbidden');
    }

    enqueue(input: AgentSkillConsumptionOutboxPayloadV1): string {
        this.#mutation();
        if (!this.db.isTransaction) throw new Error('skill-outbox-commit-transaction-required');
        const payload = normalizeAgentSkillConsumptionPayload(input);
        const json = JSON.stringify(payload);
        if (json.length > MAX_PAYLOAD_CHARS) throw new Error('skill-outbox-payload-too-large');
        const payloadDigest = digest(json);
        const entryId = entryIdOf(payload);
        const existing = this.db.prepare(`SELECT payload_digest FROM ${TABLE} WHERE entry_id=?`)
            .get(entryId) as { payload_digest: string } | undefined;
        if (existing && existing.payload_digest !== payloadDigest) throw new Error('skill-outbox-idempotency-conflict');
        if (!existing) this.db.prepare(`INSERT INTO ${TABLE}
            (entry_id,session_id,payload_digest,payload_json) VALUES(?,?,?,?)`)
            .run(entryId, payload.run.sessionId, payloadDigest, json);
        const stored = this.db.prepare(`SELECT entry_id,session_id,payload_digest,payload_json
            FROM ${TABLE} WHERE entry_id=?`).get(entryId) as unknown as StoredRow | undefined;
        if (!stored || stored.entry_id !== entryId || stored.session_id !== payload.run.sessionId
            || stored.payload_digest !== payloadDigest || stored.payload_json !== json) {
            throw new Error('skill-outbox-write-readback-mismatch');
        }
        parseRow(stored);
        return entryId;
    }

    pending(limit = 64): readonly AgentSkillConsumptionOutboxEntryV1[] {
        this.#committed();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('skill-outbox-limit-invalid');
        const rows = this.db.prepare(`SELECT entry_id,session_id,payload_digest,payload_json
            FROM ${TABLE} WHERE delivered=0 ORDER BY rowid LIMIT ?`).all(limit) as unknown as StoredRow[];
        return Object.freeze(rows.map(parseRow));
    }

    /** A bad retained row consumes its own cursor position rather than starving later valid receipts. */
    scan(limit = 64, cursor = 0): AgentSkillConsumptionOutboxScan {
        this.#committed();
        count(cursor);
        if (count(limit, 1) > 256) throw new Error('skill-outbox-limit-invalid');
        const rows = this.db.prepare(`SELECT rowid,entry_id,session_id,payload_digest,payload_json
            FROM ${TABLE} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(cursor, limit + 1) as unknown as
            (StoredRow & { rowid: number })[];
        const page = rows.slice(0, limit);
        const entries: AgentSkillConsumptionOutboxEntryV1[] = [];
        let failed = 0;
        for (const row of page) {
            try { entries.push(parseRow(row)); } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit,
        });
    }

    read(entryId: string): AgentSkillConsumptionOutboxEntryV1 | null {
        this.#committed();
        if (typeof entryId !== 'string' || !/^skill-use:[a-f0-9]{64}$/u.test(entryId)) {
            throw new Error('skill-outbox-entry-id-invalid');
        }
        const row = this.db.prepare(`SELECT entry_id,session_id,payload_digest,payload_json
            FROM ${TABLE} WHERE entry_id=?`).get(entryId) as unknown as StoredRow | undefined;
        return row ? parseRow(row) : null;
    }

    /** Conservative full-table existence check includes malformed bound packets and acknowledged rows. */
    hasEvidenceBindings(): boolean {
        this.#committed();
        return !!this.db.prepare(`SELECT 1 FROM ${TABLE}
            WHERE CASE WHEN json_valid(payload_json) THEN
                json_type(payload_json,'$.evidenceBinding') IS NOT NULL
                ELSE 1 END LIMIT 1`).get();
    }

    /** Current consumer validity only: no source reauthorization or current-card/mode inference. */
    consumerIsCurrent(entry: AgentSkillConsumptionOutboxEntryV1): boolean {
        this.#committed();
        try {
            const retained = this.read(entry.entryId);
            if (!retained?.evidenceBinding || JSON.stringify(retained) !== JSON.stringify(entry)) return false;
            const { consumer } = retained.evidenceBinding;
            const row = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
                .get(consumer.assistantMessageId) as { round: number; role: string; content: string } | undefined;
            if (!row || row.role !== 'assistant' || row.round !== consumer.round || typeof row.content !== 'string'
                || sha256Digest(row.content) !== consumer.assistantDigest) return false;
            const epoch = this.db.prepare(`SELECT value FROM session_control
                WHERE session_key=? AND control_key='history_epoch'`)
                .get(retained.run.sessionId) as { value: string } | undefined;
            const value = epoch ? count(Number(epoch.value)) : 0;
            return (!epoch || String(value) === epoch.value) && value === consumer.historyEpoch;
        } catch { return false; }
    }

    acknowledge(entry: AgentSkillConsumptionOutboxEntryV1): void {
        this.#mutation();
        if (this.db.isTransaction) throw new Error('skill-outbox-uncommitted-ack-forbidden');
        const result = this.db.prepare(`UPDATE ${TABLE} SET delivered=1
            WHERE entry_id=? AND payload_digest=?`).run(entry.entryId, entry.payloadDigest);
        if (Number(result.changes) !== 1) throw new Error('skill-outbox-ack-binding-mismatch');
    }

    redactSession(sessionId: string): void {
        this.#mutation();
        agentClosureToken(sessionId, 'session-id');
        this.db.prepare(`DELETE FROM ${TABLE} WHERE session_id=?`).run(sessionId);
    }
}
