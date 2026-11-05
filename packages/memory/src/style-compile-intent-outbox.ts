/** Durable Style input provenance only; no Provider authority, retry loop or installed Skill writes. */
import type { DatabaseSync } from 'node:sqlite';
import { LearningOutboxStore, opaqueLearningToken, sha256Digest } from './learning-outbox.ts';
import { TurnOutcomeStore } from './turn-outcome.ts';

export interface StyleCompileBinding {
    readonly version: 'style-compile-binding-v1';
    readonly policyVersion: 'p14-q7-style-compiler-v1';
    readonly providerId: string;
    readonly modelId: string;
    readonly authorityDigest: string;
    readonly modelBindingDigest: string;
    readonly modelProfileDigest: string;
    readonly budgetProfileDigest: string;
}
export interface StyleCompileSampleRef {
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly sourceRevision: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly subjectDigest: string;
    readonly proseDigest: string;
}
export interface StyleCompileIntent {
    readonly version: 'style-compile-intent-v1';
    readonly rawSessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly historyEpoch: number;
    readonly scope: Readonly<{ sessionId: string; cardId: string; contentMode: 'nsf' | 'nsfw'; baseStyleSkillId: string }>;
    readonly styleSkillId: string;
    readonly forbiddenIdentityDigest: string;
    readonly sourceDigest: string;
    readonly profileVersion: string;
    readonly acceptedSamples: number;
    readonly explicitRequest: boolean;
    readonly anchor: StyleCompileSampleRef;
    readonly samples: readonly StyleCompileSampleRef[];
    readonly binding: StyleCompileBinding;
    readonly committedAt: string;
}
export interface StyleCompileIntentEntry {
    readonly payload: StyleCompileIntent;
    readonly packetDigest: string;
    readonly state: 'pending' | 'delivered' | 'invalidated';
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}
export interface StyleCompileIntentScan {
    readonly entries: readonly StyleCompileIntentEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}
/** Closed, content-free business results. Unknown never authorizes another Provider attempt. */
export type StyleCompileSettlementResult =
    | Readonly<{ status: 'created'; proposalId: string }>
    | Readonly<{ status: 'rejected' | 'skipped' | 'cancelled' }>
    | Readonly<{ status: 'unknown'; attempted: true | null }>;
export interface StyleCompileIntentSettlement {
    readonly version: 'style-compile-settlement-v1';
    readonly runId: string;
    readonly packetDigest: string;
    readonly result: StyleCompileSettlementResult;
    readonly closedAt: string;
}
interface Journal extends StyleCompileIntentEntry {
    readonly journalVersion: 'style-compile-intent-journal-v1';
}
export const STYLE_COMPILE_INTENT_PREFIX = 'style_compile_intent:';
export const STYLE_COMPILE_SETTLEMENT_PREFIX = 'style_compile_settlement:';
const MAX_PACKET_CHARS = 32_768;
const MAX_SOURCE_EVENTS = 10_000;
const MAX_RESERVATIONS = 256;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const OPAQUE = /^[A-Za-z0-9._:-]{1,160}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function fail(code: string): never { throw new Error(`style-compile-intent-${code}`); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('record-invalid');
    return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
        || JSON.stringify(own.sort()) !== JSON.stringify([...keys].sort())) fail('keys-invalid');
}
function token(value: unknown, opaque = false): string {
    if (typeof value !== 'string' || !(opaque ? OPAQUE : TOKEN).test(value)) fail('token-invalid');
    return value;
}
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)
        || Number(value) < minimum || Number(value) > maximum) fail('count-invalid');
    return Number(value);
}
function digest(value: unknown): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) fail('digest-invalid');
    return value;
}
function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) fail('timestamp-invalid');
    return value;
}
function hash(value: unknown): string { return sha256Digest(JSON.stringify(value)); }

export function normalizeStyleCompileBinding(input: unknown): StyleCompileBinding {
    const value = record(input);
    exact(value, ['version', 'policyVersion', 'providerId', 'modelId', 'authorityDigest',
        'modelBindingDigest', 'modelProfileDigest', 'budgetProfileDigest']);
    if (value.version !== 'style-compile-binding-v1'
        || value.policyVersion !== 'p14-q7-style-compiler-v1') fail('binding-version-invalid');
    return Object.freeze({
        version: 'style-compile-binding-v1', policyVersion: 'p14-q7-style-compiler-v1',
        providerId: token(value.providerId), modelId: token(value.modelId),
        authorityDigest: digest(value.authorityDigest), modelBindingDigest: digest(value.modelBindingDigest),
        modelProfileDigest: digest(value.modelProfileDigest), budgetProfileDigest: digest(value.budgetProfileDigest),
    });
}
function normalizeRef(input: unknown): StyleCompileSampleRef {
    const value = record(input);
    exact(value, ['eventId', 'payloadDigest', 'sourceRevision', 'round', 'assistantMessageId', 'subjectDigest', 'proseDigest']);
    const round = count(value.round, 1);
    const assistantMessageId = count(value.assistantMessageId, 1);
    const sourceRevision = token(value.sourceRevision);
    if (sourceRevision !== `round-${round}-assistant-${assistantMessageId}`) fail('sample-revision-invalid');
    return Object.freeze({ eventId: token(value.eventId), payloadDigest: digest(value.payloadDigest),
        sourceRevision, round, assistantMessageId, subjectDigest: digest(value.subjectDigest),
        proseDigest: digest(value.proseDigest) });
}
export function normalizeStyleCompileIntent(input: unknown): StyleCompileIntent {
    const value = record(input);
    exact(value, ['version', 'rawSessionId', 'runId', 'sourceRevision', 'round', 'assistantMessageId',
        'historyEpoch', 'scope', 'styleSkillId', 'forbiddenIdentityDigest', 'sourceDigest', 'profileVersion', 'acceptedSamples',
        'explicitRequest', 'anchor', 'samples', 'binding', 'committedAt']);
    if (value.version !== 'style-compile-intent-v1' || typeof value.explicitRequest !== 'boolean') fail('version-invalid');
    const scope = record(value.scope);
    exact(scope, ['sessionId', 'cardId', 'contentMode', 'baseStyleSkillId']);
    if (scope.contentMode !== 'nsf' && scope.contentMode !== 'nsfw') fail('scope-mode-invalid');
    if (!Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 8
        || Object.keys(value.samples).length !== value.samples.length
        || Reflect.ownKeys(value.samples).length !== value.samples.length + 1
        || Array.from({ length: value.samples.length }, (_, index) => index)
            .some((index) => !Object.hasOwn(value.samples as unknown[], index))) fail('samples-invalid');
    const samples = Object.freeze(value.samples.map(normalizeRef));
    if (new Set(samples.map((item) => item.eventId)).size !== samples.length
        || new Set(samples.map((item) => item.sourceRevision)).size !== samples.length
        || new Set(samples.map((item) => item.assistantMessageId)).size !== samples.length) fail('samples-duplicate');
    const anchor = normalizeRef(value.anchor);
    const acceptedSamples = count(value.acceptedSamples, 0, MAX_SOURCE_EVENTS);
    const sourceDigest = digest(value.sourceDigest);
    const round = count(value.round, 1);
    const assistantMessageId = count(value.assistantMessageId, 1);
    const sourceRevision = token(value.sourceRevision);
    if (value.profileVersion !== `style-profile-v1-${acceptedSamples}`
        || sourceRevision !== `round-${round}-assistant-${assistantMessageId}`
        || anchor.sourceRevision !== sourceRevision
        || !samples.some((item) => JSON.stringify(item) === JSON.stringify(anchor))
        || sourceDigest !== hash({ acceptedSamples, representatives: samples
            .map((item) => ({ revision: item.sourceRevision, subject: item.subjectDigest }))
            .sort((left, right) => left.revision.localeCompare(right.revision)) })) fail('source-digest-invalid');
    const result: StyleCompileIntent = Object.freeze({
        version: 'style-compile-intent-v1', rawSessionId: token(value.rawSessionId, true),
        runId: token(value.runId, true), sourceRevision, round, assistantMessageId,
        historyEpoch: count(value.historyEpoch), scope: Object.freeze({ sessionId: token(scope.sessionId),
            cardId: token(scope.cardId), contentMode: scope.contentMode, baseStyleSkillId: token(scope.baseStyleSkillId) }),
        styleSkillId: token(value.styleSkillId), forbiddenIdentityDigest: digest(value.forbiddenIdentityDigest),
        sourceDigest, profileVersion: String(value.profileVersion),
        acceptedSamples, explicitRequest: value.explicitRequest, anchor, samples,
        binding: normalizeStyleCompileBinding(value.binding), committedAt: timestamp(value.committedAt),
    });
    if (JSON.stringify(result).length > MAX_PACKET_CHARS) fail('packet-size-invalid');
    return result;
}
export function styleCompileIntentDigest(input: StyleCompileIntent): string {
    return hash(normalizeStyleCompileIntent(input));
}
function key(runId: string): string { return `${STYLE_COMPILE_INTENT_PREFIX}${runId}`; }
function settlementKey(runId: string): string { return `${STYLE_COMPILE_SETTLEMENT_PREFIX}${runId}`; }
function normalizeSettlementResult(input: unknown): StyleCompileSettlementResult {
    const value = record(input);
    const status: unknown = Object.getOwnPropertyDescriptor(value, 'status')?.value;
    if (status === 'created') {
        exact(value, ['status', 'proposalId']);
        return Object.freeze({ status: 'created', proposalId: token(value.proposalId) });
    }
    if (status === 'rejected' || status === 'skipped' || status === 'cancelled') {
        exact(value, ['status']);
        return Object.freeze({ status });
    }
    if (status === 'unknown') {
        exact(value, ['status', 'attempted']);
        if (value.attempted !== true && value.attempted !== null) return fail('settlement-result-invalid');
        return Object.freeze({ status: 'unknown', attempted: value.attempted });
    }
    return fail('settlement-result-invalid');
}
function parseSettlement(json: string): StyleCompileIntentSettlement {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) fail('settlement-size-invalid');
    const value = record(JSON.parse(json));
    exact(value, ['version', 'runId', 'packetDigest', 'result', 'closedAt']);
    if (value.version !== 'style-compile-settlement-v1') fail('settlement-version-invalid');
    const result: StyleCompileIntentSettlement = Object.freeze({ version: 'style-compile-settlement-v1',
        runId: token(value.runId, true), packetDigest: digest(value.packetDigest),
        result: normalizeSettlementResult(value.result), closedAt: timestamp(value.closedAt) });
    if (JSON.stringify(result) !== json) fail('settlement-corrupt');
    return result;
}
function entry(value: Journal): StyleCompileIntentEntry {
    return Object.freeze({ payload: value.payload, packetDigest: value.packetDigest, state: value.state,
        deliveredAt: value.deliveredAt, invalidatedAt: value.invalidatedAt, reasonCode: value.reasonCode });
}
function parseJournal(json: string): Journal {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) fail('journal-size-invalid');
    const value = record(JSON.parse(json));
    exact(value, ['journalVersion', 'payload', 'packetDigest', 'state', 'deliveredAt', 'invalidatedAt', 'reasonCode']);
    if (value.journalVersion !== 'style-compile-intent-journal-v1') fail('journal-version-invalid');
    const payload = normalizeStyleCompileIntent(value.payload);
    const result: Journal = Object.freeze({ journalVersion: 'style-compile-intent-journal-v1', payload,
        packetDigest: styleCompileIntentDigest(payload), state: value.state as Journal['state'],
        deliveredAt: value.deliveredAt === null ? null : timestamp(value.deliveredAt),
        invalidatedAt: value.invalidatedAt === null ? null : timestamp(value.invalidatedAt),
        reasonCode: value.reasonCode === null ? null : token(value.reasonCode) });
    if (!['pending', 'delivered', 'invalidated'].includes(result.state)
        || result.state === 'pending' && (result.deliveredAt !== null || result.invalidatedAt !== null || result.reasonCode !== null)
        || result.state === 'delivered' && (result.deliveredAt === null || result.invalidatedAt !== null || result.reasonCode !== null)
        || result.state === 'invalidated' && (result.invalidatedAt === null || result.deliveredAt !== null || result.reasonCode === null)
        || result.deliveredAt !== null && result.deliveredAt < payload.committedAt
        || result.invalidatedAt !== null && result.invalidatedAt < payload.committedAt
        || JSON.stringify(result) !== json) fail('journal-corrupt');
    return result;
}

/** A journal in the owning business database, never a second authority or an automatic executor. */
export class StyleCompileIntentOutbox {
    constructor(private readonly db: DatabaseSync, private readonly rawSessionId: string) {
        token(rawSessionId, true);
    }

    #outside(): void {
        if (this.db.isTransaction !== false) fail('uncommitted-read');
    }
    #read(runId: string): Journal | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key(runId)) as { value: string } | undefined;
        if (!row) return null;
        const current = parseJournal(row.value);
        if (current.payload.rawSessionId !== this.rawSessionId || current.payload.runId !== runId) fail('journal-owner-invalid');
        return current;
    }
    #write(value: Journal): void {
        const json = JSON.stringify(value);
        if (json.length > MAX_PACKET_CHARS) fail('journal-size-invalid');
        this.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.rawSessionId, key(value.payload.runId), json,
                value.invalidatedAt ?? value.deliveredAt ?? value.payload.committedAt);
        if (JSON.stringify(this.#read(value.payload.runId)) !== json) fail('storage-mismatch');
    }
    #readSettlement(runId: string): StyleCompileIntentSettlement | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, settlementKey(runId)) as { value: string } | undefined;
        if (!row) return null;
        const receipt = parseSettlement(row.value);
        const journal = this.#read(runId);
        if (receipt.runId !== runId || !journal || receipt.packetDigest !== journal.packetDigest
            || receipt.closedAt < journal.payload.committedAt) fail('settlement-owner-invalid');
        return receipt;
    }
    #writeSettlement(receipt: StyleCompileIntentSettlement): void {
        const json = JSON.stringify(receipt);
        this.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.rawSessionId, settlementKey(receipt.runId), json, receipt.closedAt);
        if (JSON.stringify(this.#readSettlement(receipt.runId)) !== json) fail('settlement-storage-mismatch');
    }
    #maxBaseline(controlKey: string, acceptedSamples: number, at: string): void {
        const previous = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, controlKey) as { value: string } | undefined;
        const previousCount = previous ? count(Number(previous.value), 0, MAX_SOURCE_EVENTS) : 0;
        if (previous && previous.value !== String(previousCount)) fail('baseline-corrupt');
        const maximum = Math.max(previousCount, acceptedSamples);
        this.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.rawSessionId, controlKey, String(maximum), at);
        const stored = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, controlKey) as { value: string } | undefined;
        if (!stored || stored.value !== String(maximum)) fail('baseline-storage-mismatch');
    }
    #assertEntry(input: StyleCompileIntentEntry): StyleCompileIntent {
        const value = record(input);
        exact(value, ['payload', 'packetDigest', 'state', 'deliveredAt', 'invalidatedAt', 'reasonCode']);
        const parsed = parseJournal(JSON.stringify({ journalVersion: 'style-compile-intent-journal-v1',
            payload: normalizeStyleCompileIntent(value.payload), packetDigest: value.packetDigest,
            state: value.state, deliveredAt: value.deliveredAt,
            invalidatedAt: value.invalidatedAt, reasonCode: value.reasonCode }));
        if (parsed.payload.rawSessionId !== this.rawSessionId) fail('entry-owner-invalid');
        return parsed.payload;
    }
    #current(payload: StyleCompileIntent): boolean {
        if (payload.rawSessionId !== this.rawSessionId) return false;
        const marker = new TurnOutcomeStore(this.db).get(payload.runId);
        if (!marker || marker.sessionId !== this.rawSessionId || marker.action !== 'turn'
            || marker.revision !== payload.sourceRevision || marker.round !== payload.round
            || marker.assistantMessageId !== payload.assistantMessageId
            || marker.committedAt !== payload.committedAt) return false;
        const epoch = this.db.prepare(`SELECT value FROM session_control
            WHERE session_key=? AND control_key='history_epoch'`).get(this.rawSessionId) as { value: string } | undefined;
        const historyEpoch = epoch ? count(Number(epoch.value)) : 0;
        if (epoch && epoch.value !== String(historyEpoch)) fail('history-epoch-corrupt');
        if (historyEpoch !== payload.historyEpoch) return false;
        const outbox = new LearningOutboxStore(this.db);
        for (const ref of payload.samples) {
            const event = outbox.get(ref.eventId);
            if (!event || event.payloadDigest !== ref.payloadDigest || event.eventKind !== 'turn_accepted_weak'
                || event.sessionId !== payload.scope.sessionId || event.cardId !== payload.scope.cardId
                || event.contentMode !== payload.scope.contentMode || event.sourceRevision !== ref.sourceRevision
                || event.round !== ref.round || event.assistantMessageId !== ref.assistantMessageId
                || event.subjectDigest !== ref.subjectDigest || event.features.styleAcceptance !== 'weak'
                || event.features.styleSkillId !== payload.styleSkillId || event.features.proseDigest !== ref.proseDigest
                || ref.eventId === payload.anchor.eventId && event.runId !== opaqueLearningToken('run', payload.runId)) return false;
            // Tombstones fence the original source even if deletion/regeneration changed content mode.
            const tombstone = this.db.prepare(`SELECT event_id FROM learning_outbox
                WHERE session_id=? AND card_id=? AND
                    ((event_kind='delete' AND source_revision=?) OR
                    (event_kind='regenerate' AND json_extract(features_json,'$.replacedSourceRevision')=?)) LIMIT 1`)
                .get(payload.scope.sessionId, payload.scope.cardId, ref.sourceRevision, ref.sourceRevision);
            if (tombstone) return false;
            const assistant = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
                .get(ref.assistantMessageId) as { round: number; role: string; content: string } | undefined;
            if (!assistant || assistant.round !== ref.round || assistant.role !== 'assistant'
                || typeof assistant.content !== 'string' || sha256Digest(assistant.content) !== ref.proseDigest) return false;
        }
        return true;
    }
    #transaction<T>(work: () => T): T {
        this.#outside();
        this.db.exec('BEGIN IMMEDIATE;');
        try {
            const result = work();
            if (this.db.isTransaction !== true) fail('transaction-lost');
            this.db.exec('COMMIT;');
            return result;
        } catch (error) {
            if (this.db.isTransaction === true) this.db.exec('ROLLBACK;');
            throw error;
        }
    }
    /** Keep all authority joins and the returned prose in one SQLite snapshot, not several autocommit reads. */
    #readSnapshot<T>(work: () => T, reuseBusinessTransaction = false): T {
        if (Boolean(this.db.isTransaction)) {
            if (reuseBusinessTransaction) return work();
            fail('uncommitted-read');
        }
        this.#outside();
        this.db.exec('BEGIN DEFERRED;');
        try {
            const result = work();
            if (this.db.isTransaction !== true) fail('read-snapshot-lost');
            this.db.exec('COMMIT;');
            return result;
        } catch (error) {
            if (this.db.isTransaction === true) this.db.exec('ROLLBACK;');
            throw error;
        }
    }
    enqueue(input: StyleCompileIntent): boolean {
        if (this.db.isTransaction !== true) fail('business-transaction-required');
        this.db.exec('SAVEPOINT style_compile_intent_enqueue;');
        try {
            const payload = normalizeStyleCompileIntent(input);
            if (!this.#current(payload)) fail('business-source-invalid');
            const packetDigest = styleCompileIntentDigest(payload);
            const previous = this.#read(payload.runId);
            if (this.#readSettlement(payload.runId)) fail('already-settled');
            if (previous && (previous.packetDigest !== packetDigest || previous.state === 'invalidated')) fail('conflict');
            if (!previous) this.#write({ journalVersion: 'style-compile-intent-journal-v1', payload,
                packetDigest, state: 'pending', deliveredAt: null, invalidatedAt: null, reasonCode: null });
            this.db.exec('RELEASE style_compile_intent_enqueue;');
            if (this.db.isTransaction !== true) fail('business-transaction-lost');
            return true;
        } catch (error) {
            // A native ROLLBACK destroyed the business transaction: the caller must not continue committing.
            if (this.db.isTransaction !== true) throw error;
            this.db.exec('ROLLBACK TO style_compile_intent_enqueue; RELEASE style_compile_intent_enqueue;');
            return false;
        }
    }
    read(runId: string): StyleCompileIntentEntry | null {
        this.#outside();
        const current = this.#read(token(runId, true));
        return current ? entry(current) : null;
    }
    /** Historical source metadata only. A successful settlement is not source revocation.
     * This read may share the owning business snapshot; it never grants dispatch or replay rights.
     */
    readRetainedSource(runId: string): Readonly<{
        entry: StyleCompileIntentEntry; current: boolean; settlement: StyleCompileIntentSettlement | null;
    }> | null {
        return this.#readSnapshot(() => {
            const journal = this.#read(token(runId, true));
            if (!journal) return null;
            return Object.freeze({ entry: entry(journal),
                current: journal.state !== 'invalidated' && this.#current(journal.payload),
                settlement: this.#readSettlement(runId) });
        }, true);
    }
    readSettlement(runId: string): StyleCompileIntentSettlement | null {
        this.#outside();
        return this.#readSnapshot(() => this.#readSettlement(token(runId, true)));
    }
    scan(limit = 64, cursor = 0): StyleCompileIntentScan {
        this.#outside();
        count(cursor);
        count(limit, 1, 256);
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.rawSessionId, `${STYLE_COMPILE_INTENT_PREFIX}*`, cursor, limit + 1) as {
                rowid: number; control_key: string; value: string;
            }[];
        const attempted = rows.slice(0, limit);
        const entries: StyleCompileIntentEntry[] = [];
        let failed = 0;
        for (const row of attempted) {
            try {
                const current = parseJournal(row.value);
                if (current.payload.rawSessionId !== this.rawSessionId || key(current.payload.runId) !== row.control_key) fail('journal-owner-invalid');
                entries.push(entry(current));
            } catch { failed += 1; }
        }
        const hasMore = rows.length > limit;
        return Object.freeze({ entries: Object.freeze(entries), attempted: attempted.length, failed,
            nextCursor: hasMore ? Number(attempted.at(-1)!.rowid) : 0, hasMore });
    }
    isCurrent(value: StyleCompileIntentEntry): boolean {
        this.#outside();
        const payload = this.#assertEntry(value);
        return this.#readSnapshot(() => {
            const current = this.#read(payload.runId);
            return current !== null && current.packetDigest === value.packetDigest
                && current.state !== 'invalidated' && !this.#readSettlement(payload.runId) && this.#current(payload);
        });
    }
    readSamples(value: StyleCompileIntentEntry): readonly Readonly<{ sourceRevision: string; prose: string }>[] | null {
        this.#outside();
        const payload = this.#assertEntry(value);
        return this.#readSnapshot(() => {
            const current = this.#read(payload.runId);
            if (!current || current.packetDigest !== value.packetDigest
                || current.state === 'invalidated' || this.#readSettlement(payload.runId) || !this.#current(payload)) return null;
            const samples: Readonly<{ sourceRevision: string; prose: string }>[] = [];
            for (const ref of payload.samples) {
                const row = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
                    .get(ref.assistantMessageId) as { round: number; role: string; content: string } | undefined;
                if (!row || row.round !== ref.round || row.role !== 'assistant'
                    || typeof row.content !== 'string' || sha256Digest(row.content) !== ref.proseDigest) return null;
                samples.push(Object.freeze({ sourceRevision: ref.sourceRevision, prose: row.content }));
            }
            return Object.freeze(samples);
        });
    }
    /** Reservations only gate repeated proposals; they never assert a model attempt or a successful compilation. */
    reservedSampleCount(scopeInput: StyleCompileIntent['scope'], styleSkillIdInput: string): number {
        const scope = record(scopeInput);
        exact(scope, ['sessionId', 'cardId', 'contentMode', 'baseStyleSkillId']);
        const styleSkillId = token(styleSkillIdInput);
        for (const field of ['sessionId', 'cardId', 'baseStyleSkillId']) token(scope[field]);
        if (scope.contentMode !== 'nsf' && scope.contentMode !== 'nsfw') fail('scope-mode-invalid');
        return this.#readSnapshot(() => {
        // Validate before SQL exclusion: a malformed/forged receipt must never hide an active reservation.
        const receipts = this.db.prepare(`SELECT control_key,value FROM session_control WHERE session_key=?
            AND control_key GLOB ? ORDER BY rowid LIMIT ?`)
            .all(this.rawSessionId, `${STYLE_COMPILE_SETTLEMENT_PREFIX}*`, MAX_SOURCE_EVENTS + 1) as {
                control_key: string; value: string;
            }[];
        if (receipts.length > MAX_SOURCE_EVENTS) fail('settlement-limit-exceeded');
        for (const row of receipts) {
            const receipt = parseSettlement(row.value);
            if (settlementKey(receipt.runId) !== row.control_key) fail('settlement-owner-invalid');
            this.#readSettlement(receipt.runId);
        }
        const corrupt = this.db.prepare(`SELECT 1 FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND NOT json_valid(value) LIMIT 1`)
            .get(this.rawSessionId, `${STYLE_COMPILE_INTENT_PREFIX}*`);
        if (corrupt) fail('reservation-journal-corrupt');
        const unsupported = this.db.prepare(`SELECT 1 FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND (
                json_extract(value,'$.journalVersion') IS NOT 'style-compile-intent-journal-v1'
                OR json_extract(value,'$.state') IS NULL
                OR json_extract(value,'$.state') NOT IN ('pending','delivered','invalidated')) LIMIT 1`)
            .get(this.rawSessionId, `${STYLE_COMPILE_INTENT_PREFIX}*`);
        if (unsupported) fail('reservation-journal-unsupported');
        const rows = this.db.prepare(`SELECT i.control_key,i.value FROM session_control AS i
            LEFT JOIN session_control AS s ON s.session_key=i.session_key
                AND s.control_key=? || json_extract(i.value,'$.payload.runId')
            WHERE i.session_key=? AND i.control_key GLOB ?
            AND json_extract(i.value,'$.state') IN ('pending','delivered')
            AND json_extract(i.value,'$.payload.scope.sessionId')=? AND json_extract(i.value,'$.payload.scope.cardId')=?
            AND json_extract(i.value,'$.payload.scope.contentMode')=? AND json_extract(i.value,'$.payload.scope.baseStyleSkillId')=?
            AND json_extract(i.value,'$.payload.styleSkillId')=?
            AND (s.control_key IS NULL OR (json_extract(s.value,'$.result.status')='unknown'
                AND json_extract(s.value,'$.result.attempted') IS NULL))
            ORDER BY i.rowid DESC LIMIT ?`)
            .all(STYLE_COMPILE_SETTLEMENT_PREFIX, this.rawSessionId, `${STYLE_COMPILE_INTENT_PREFIX}*`, String(scope.sessionId), String(scope.cardId),
                String(scope.contentMode), String(scope.baseStyleSkillId), styleSkillId, MAX_RESERVATIONS + 1) as {
                    control_key: string; value: string;
                }[];
        if (rows.length > MAX_RESERVATIONS) fail('reservation-limit-exceeded');
        let maximum = 0;
        for (const row of rows) {
            const current = parseJournal(row.value);
            if (current.payload.rawSessionId !== this.rawSessionId || key(current.payload.runId) !== row.control_key) fail('journal-owner-invalid');
            if (this.#current(current.payload)) maximum = Math.max(maximum, current.payload.acceptedSamples);
        }
            return maximum;
        }, true);
    }
    markDelivered(value: StyleCompileIntentEntry, at: string): boolean {
        const payload = this.#assertEntry(value);
        const deliveredAt = timestamp(at);
        return this.#transaction(() => {
            const current = this.#read(payload.runId);
            if (!current || current.packetDigest !== value.packetDigest || current.state === 'invalidated'
                || deliveredAt < payload.committedAt || this.#readSettlement(payload.runId) || !this.#current(payload)) return false;
            if (current.state === 'delivered') return true;
            this.#write({ ...current, state: 'delivered', deliveredAt });
            return true;
        });
    }
    /** One closed receipt and its monotonic evidence baselines share the owning business database transaction. */
    settle(value: StyleCompileIntentEntry, resultInput: StyleCompileSettlementResult, at: string): boolean {
        const payload = this.#assertEntry(value);
        const result = normalizeSettlementResult(resultInput);
        const closedAt = timestamp(at);
        return this.#transaction(() => {
            const current = this.#read(payload.runId);
            if (!current || current.packetDigest !== value.packetDigest) return false;
            const previous = this.#readSettlement(payload.runId);
            if (previous) return JSON.stringify(previous.result) === JSON.stringify(result);
            if (closedAt < payload.committedAt || current.deliveredAt !== null && closedAt < current.deliveredAt) return false;
            const attempted = result.status === 'created' || result.status === 'rejected'
                || result.status === 'unknown' && result.attempted === true;
            if (attempted && (current.state !== 'delivered' || !this.#current(payload))) return false;
            if (attempted) this.#maxBaseline(`style-proposal-attempt-count:${payload.scope.contentMode}`, payload.acceptedSamples, closedAt);
            if (result.status === 'created') this.#maxBaseline(`style-proposal-count:${payload.scope.contentMode}`, payload.acceptedSamples, closedAt);
            this.#writeSettlement(Object.freeze({ version: 'style-compile-settlement-v1', runId: payload.runId,
                packetDigest: current.packetDigest, result, closedAt }));
            return true;
        });
    }
    invalidate(value: StyleCompileIntentEntry, at: string, reasonCode: string): boolean {
        const payload = this.#assertEntry(value);
        const invalidatedAt = timestamp(at);
        const reason = token(reasonCode);
        return this.#transaction(() => {
            const current = this.#read(payload.runId);
            if (!current || current.packetDigest !== value.packetDigest || invalidatedAt < payload.committedAt) return false;
            if (current.state === 'invalidated') return true;
            this.#write({ ...current, state: 'invalidated', deliveredAt: null, invalidatedAt, reasonCode: reason });
            return true;
        });
    }
}
