/** @author Codex @date 2026-10-16 @version 1.0
 * Content-free legacy preference adoption receipts; never skill authority or replay work.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    LearningOutboxStore, opaqueLearningToken, preferenceEpochOf, sha256Digest,
    type LearningEventRecord, type LearningProfileIdentityValue,
} from './learning-outbox.ts';

export interface ExplicitPreferenceAdoptionSourceEvent {
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly userMessageId: number;
    readonly assistantMessageId: number;
    readonly userDigest: string;
    readonly assistantDigest: string;
}

export interface ExplicitPreferenceAdoptionPayload {
    readonly version: 'explicit-preference-adoption-v1';
    readonly sourceKind: 'explicit-user';
    readonly attributionKind: 'legacy-profile';
    readonly effect: 'unknown';
    readonly identity: LearningProfileIdentityValue;
    readonly preferenceEpoch: number;
    readonly evidenceRevision: string;
    readonly profileDigest: string;
    readonly preferenceDigest: string;
    readonly blockDigest: string;
    readonly carrierDigest: string;
    readonly requestDigest: string;
    readonly tagCount: number;
    readonly sourceEvents: readonly ExplicitPreferenceAdoptionSourceEvent[];
    readonly consumer: Readonly<{
        runId: string;
        round: number;
        assistantMessageId: number;
        assistantDigest: string;
        historyEpoch: number;
    }>;
    readonly occurredAt: string;
}

export interface ExplicitPreferenceAdoptionEntry {
    readonly payload: ExplicitPreferenceAdoptionPayload;
    readonly packetDigest: string;
    readonly state: 'recorded' | 'invalidated';
    readonly reasonCode: null | 'explicit-preference-adoption-source-invalidated';
}

export interface ExplicitPreferenceAdoptionScan {
    readonly entries: readonly ExplicitPreferenceAdoptionEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface JournalPacket {
    readonly journalVersion: 'explicit-preference-adoption-journal-v1';
    readonly payload: ExplicitPreferenceAdoptionPayload;
    readonly packetDigest: string;
}

export const EXPLICIT_PREFERENCE_ADOPTION_PREFIX = 'explicit_preference_adoption:';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TAG = /^(pace|tone|interaction|viewpoint|relationship|action)\.[a-z][a-z0-9_]*\.(like|avoid)$/u;
const MAX_SOURCE_EVENTS = 64;
const MAX_TAG_COUNT = 32;
const MAX_PACKET_CHARS = 32_768;
const MAX_SCAN_LIMIT = 256;

export function explicitPreferenceAdoptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('explicit-preference-adoption-record-invalid');
    }
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new Error('explicit-preference-adoption-keys-invalid');
    }
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('explicit-preference-adoption-token-invalid');
    return value;
}

function count(value: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new Error('explicit-preference-adoption-count-invalid');
    }
    return Number(value);
}

function digest(value: unknown): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw new Error('explicit-preference-adoption-digest-invalid');
    }
    return value;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('explicit-preference-adoption-time-invalid');
    return value;
}

function sourceEvent(input: unknown): ExplicitPreferenceAdoptionSourceEvent {
    const value = record(input);
    keys(value, ['eventId', 'payloadDigest', 'userMessageId', 'assistantMessageId',
        'userDigest', 'assistantDigest']);
    return Object.freeze({
        eventId: token(value.eventId), payloadDigest: digest(value.payloadDigest),
        userMessageId: count(value.userMessageId, 1), assistantMessageId: count(value.assistantMessageId, 1),
        userDigest: digest(value.userDigest), assistantDigest: digest(value.assistantDigest),
    });
}

/** Only references, enums and bounded counts survive; caller prose and tag values are rejected. */
export function normalizeExplicitPreferenceAdoptionPayload(input: unknown): ExplicitPreferenceAdoptionPayload {
    const value = record(input);
    keys(value, ['version', 'sourceKind', 'attributionKind', 'effect', 'identity', 'preferenceEpoch',
        'evidenceRevision', 'profileDigest', 'preferenceDigest', 'blockDigest', 'carrierDigest',
        'requestDigest', 'tagCount', 'sourceEvents', 'consumer', 'occurredAt']);
    const identity = record(value.identity);
    const consumer = record(value.consumer);
    keys(identity, ['sessionId', 'cardId', 'contentMode']);
    keys(consumer, ['runId', 'round', 'assistantMessageId', 'assistantDigest', 'historyEpoch']);
    if (value.version !== 'explicit-preference-adoption-v1' || value.sourceKind !== 'explicit-user'
        || value.attributionKind !== 'legacy-profile' || value.effect !== 'unknown'
        || !['nsf', 'nsfw'].includes(String(identity.contentMode))
        || !Array.isArray(value.sourceEvents) || value.sourceEvents.length < 1
        || value.sourceEvents.length > MAX_SOURCE_EVENTS) {
        throw new Error('explicit-preference-adoption-payload-invalid');
    }
    const sourceEvents = Array.from(value.sourceEvents, sourceEvent);
    const tagCount = count(value.tagCount, 1);
    if (tagCount > MAX_TAG_COUNT || new Set(sourceEvents.map((event) => event.eventId)).size !== sourceEvents.length) {
        throw new Error('explicit-preference-adoption-bounds-invalid');
    }
    return Object.freeze({
        version: 'explicit-preference-adoption-v1', sourceKind: 'explicit-user',
        attributionKind: 'legacy-profile', effect: 'unknown',
        identity: Object.freeze({
            sessionId: token(identity.sessionId), cardId: token(identity.cardId),
            contentMode: identity.contentMode as LearningProfileIdentityValue['contentMode'],
        }),
        preferenceEpoch: count(value.preferenceEpoch), evidenceRevision: digest(value.evidenceRevision),
        profileDigest: digest(value.profileDigest), preferenceDigest: digest(value.preferenceDigest),
        blockDigest: digest(value.blockDigest), carrierDigest: digest(value.carrierDigest),
        requestDigest: digest(value.requestDigest), tagCount, sourceEvents: Object.freeze(sourceEvents),
        consumer: Object.freeze({
            runId: token(consumer.runId), round: count(consumer.round, 1),
            assistantMessageId: count(consumer.assistantMessageId, 1),
            assistantDigest: digest(consumer.assistantDigest), historyEpoch: count(consumer.historyEpoch),
        }),
        occurredAt: timestamp(value.occurredAt),
    });
}

function packetKey(payload: ExplicitPreferenceAdoptionPayload): string {
    return `${EXPLICIT_PREFERENCE_ADOPTION_PREFIX}${explicitPreferenceAdoptionDigest(payload.consumer.runId)}`;
}

function parsePacket(json: string): JournalPacket {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) {
        throw new Error('explicit-preference-adoption-packet-size-invalid');
    }
    const value = record(JSON.parse(json));
    keys(value, ['journalVersion', 'payload', 'packetDigest']);
    const payload = normalizeExplicitPreferenceAdoptionPayload(value.payload);
    const result = Object.freeze({
        journalVersion: 'explicit-preference-adoption-journal-v1' as const, payload,
        packetDigest: explicitPreferenceAdoptionDigest(payload),
    });
    if (value.journalVersion !== result.journalVersion || value.packetDigest !== result.packetDigest
        || JSON.stringify(result) !== json) throw new Error('explicit-preference-adoption-packet-corrupt');
    return result;
}

/** No DDL, second profile, cross-session ledger, provider calls or recovery authorization. */
export class ExplicitPreferenceAdoptionJournal {
    constructor(private readonly db: DatabaseSync, private readonly rawSessionId: string) {
        token(rawSessionId);
    }

    #owner(payload: ExplicitPreferenceAdoptionPayload): boolean {
        return payload.identity.sessionId === opaqueLearningToken('session', this.rawSessionId);
    }

    #message(id: number, role: string, round: number, expectedDigest: string): boolean {
        const row = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
            .get(id) as { round: number; role: string; content: string } | undefined;
        return !!row && row.role === role && row.round === round && typeof row.content === 'string'
            && sha256Digest(row.content) === expectedDigest;
    }

    #historyEpoch(): number {
        const row = this.db.prepare(`SELECT value FROM session_control
            WHERE session_key=? AND control_key='history_epoch'`)
            .get(this.rawSessionId) as { value: string } | undefined;
        if (!row) return 0;
        const epoch = count(Number(row.value));
        if (String(epoch) !== row.value) throw new Error('explicit-preference-adoption-history-epoch-corrupt');
        return epoch;
    }

    #source(payload: ExplicitPreferenceAdoptionPayload, expected: ExplicitPreferenceAdoptionSourceEvent,
        outbox: LearningOutboxStore): boolean {
        const event = outbox.get(expected.eventId);
        if (!event || event.payloadDigest !== expected.payloadDigest || !this.#explicitEvent(event)
            || event.sessionId !== payload.identity.sessionId || event.cardId !== payload.identity.cardId
            || event.contentMode !== payload.identity.contentMode
            || preferenceEpochOf(event) !== payload.preferenceEpoch
            || event.userMessageId !== expected.userMessageId
            || event.assistantMessageId !== expected.assistantMessageId
            || event.subjectDigest !== expected.userDigest || event.createdAt > payload.occurredAt
            || event.sourceRevision !== `round-1-assistant-${expected.assistantMessageId}`
            || expected.userMessageId >= expected.assistantMessageId
            || expected.assistantMessageId >= payload.consumer.assistantMessageId
            || payload.consumer.round <= event.round) return false;
        return this.#message(expected.userMessageId, 'user', event.round, expected.userDigest)
            && this.#message(expected.assistantMessageId, 'assistant', event.round, expected.assistantDigest);
    }

    #explicitEvent(event: LearningEventRecord): boolean {
        const features = event.features;
        const tags = features.explicitPreferenceTags;
        return event.eventKind === 'session_start_prompt' && event.round === 1
            && features.preferenceExtractorVersion === 'prompt-preference-v1'
            && features.preferenceConfidence === 'explicit' && Array.isArray(tags)
            && tags.length > 0 && tags.length <= MAX_TAG_COUNT
            && tags.every((tag) => typeof tag === 'string' && TAG.test(tag))
            && new Set(tags).size === tags.length && features.explicitPreferenceCount === tags.length;
    }

    #current(payload: ExplicitPreferenceAdoptionPayload, exactRevision: boolean): boolean {
        const outbox = new LearningOutboxStore(this.db);
        if (!this.#owner(payload) || outbox.currentPreferenceEpoch(payload.identity) !== payload.preferenceEpoch
            || exactRevision && outbox.preferenceEvidenceState(payload.identity).revision !== payload.evidenceRevision
            || this.#historyEpoch() !== payload.consumer.historyEpoch
            || !this.#message(payload.consumer.assistantMessageId, 'assistant',
                payload.consumer.round, payload.consumer.assistantDigest)) return false;
        return payload.sourceEvents.every((event) => this.#source(payload, event, outbox));
    }

    /** The owner isolates failures with its own SAVEPOINT, and must surface native ROLLBACK. */
    enqueue(input: ExplicitPreferenceAdoptionPayload): boolean {
        if (this.db.isTransaction !== true) {
            throw new Error('explicit-preference-adoption-business-transaction-required');
        }
        const payload = normalizeExplicitPreferenceAdoptionPayload(input);
        if (!this.#owner(payload)) throw new Error('explicit-preference-adoption-owner-invalid');
        const packetDigest = explicitPreferenceAdoptionDigest(payload);
        const key = packetKey(payload);
        const previous = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key) as { value: string } | undefined;
        if (previous) {
            const parsed = parsePacket(previous.value);
            if (!this.#owner(parsed.payload) || packetKey(parsed.payload) !== key
                || parsed.packetDigest !== packetDigest) {
                throw new Error('explicit-preference-adoption-intent-conflict');
            }
            return true;
        }
        if (!this.#current(payload, true)) throw new Error('explicit-preference-adoption-source-invalid');
        const json = JSON.stringify({
            journalVersion: 'explicit-preference-adoption-journal-v1', payload, packetDigest,
        });
        if (json.length > MAX_PACKET_CHARS) throw new Error('explicit-preference-adoption-packet-size-invalid');
        this.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.rawSessionId, key, json, payload.occurredAt);
        if (this.db.isTransaction !== true) throw new Error('explicit-preference-adoption-business-transaction-lost');
        const stored = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key) as { value: string } | undefined;
        if (stored?.value !== json) throw new Error('explicit-preference-adoption-storage-mismatch');
        return true;
    }

    #project(controlKey: string, json: string): ExplicitPreferenceAdoptionEntry {
        const packet = parsePacket(json);
        if (!this.#owner(packet.payload) || packetKey(packet.payload) !== controlKey) {
            throw new Error('explicit-preference-adoption-row-owner-invalid');
        }
        let valid = false;
        try { valid = this.#current(packet.payload, false); }
        catch { /* Source corruption cannot re-authorize a retained historical receipt. */ }
        return Object.freeze({
            payload: packet.payload, packetDigest: packet.packetDigest,
            state: valid ? 'recorded' : 'invalidated',
            reasonCode: valid ? null : 'explicit-preference-adoption-source-invalidated',
        });
    }

    /** Exact retained receipt lookup; callers need no scan or raw consumer run identity. */
    readByRunDigest(consumerRunDigest: string): ExplicitPreferenceAdoptionEntry | null {
        if (this.db.isTransaction !== false) throw new Error('explicit-preference-adoption-uncommitted-read');
        const key = `${EXPLICIT_PREFERENCE_ADOPTION_PREFIX}${digest(consumerRunDigest)}`;
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key) as { value: string } | undefined;
        return row ? this.#project(key, row.value) : null;
    }

    /** Retain historical bytes; fences invalidate the view without rewriting an old adoption claim. */
    scan(limit = 64, cursor = 0): ExplicitPreferenceAdoptionScan {
        if (this.db.isTransaction !== false) throw new Error('explicit-preference-adoption-uncommitted-read');
        count(cursor);
        if (count(limit, 1) > MAX_SCAN_LIMIT) throw new Error('explicit-preference-adoption-scan-limit-invalid');
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.rawSessionId, `${EXPLICIT_PREFERENCE_ADOPTION_PREFIX}*`, cursor, limit + 1) as {
                rowid: number; control_key: string; value: string;
            }[];
        const page = rows.slice(0, limit);
        const entries: ExplicitPreferenceAdoptionEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                entries.push(this.#project(row.control_key, row.value));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit,
        });
    }
}
