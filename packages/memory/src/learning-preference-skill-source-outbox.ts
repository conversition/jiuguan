/** @author Codex @date 2026-10-14 @version 1.0
 * Preserve inferred-low execution provenance without turning model guesses into preference adoption.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, normalizeAgentSkillClosureAttribution,
    type AgentSkillClosureAttributionV1,
} from '../../agent-closure/index.ts';
import {
    LearningOutboxStore, normalizeLearningEvent, opaqueLearningToken, preferenceEpochOf,
    type LearningEventRecord,
} from './learning-outbox.ts';

declare const LEARNING_PREFERENCE_SKILL_PREPARATION: unique symbol;

/** Serialization retains provenance, never the issuing host's process-local one-shot authority. */
export interface LearningPreferenceSkillPreparation {
    readonly [LEARNING_PREFERENCE_SKILL_PREPARATION]: true;
}

export interface LearningPreferenceSkillSourceMetadataV1 {
    readonly sourceVersion: 'session-learning-preference-skill-source-v1';
    readonly taskKind: 'preference_extract';
    readonly policyVersion: 'p14-q6-preference-v1';
    readonly stage: 'initial-prompt-inference';
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: Readonly<{ sessionId: string; cardId?: string; worldId?: string }>;
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly round: 1;
    readonly explicitPreferenceCount: 0;
    readonly regenerate: false;
    readonly userPromptDigest: string;
    readonly inputDigest: string;
    readonly preferenceEpoch: number;
    readonly preferenceEvidenceRevision: string;
    readonly authorityRevision: string;
    readonly sourceDigest: string;
}

export interface LearningPreferenceSkillProofV1 {
    readonly version: 'learning-preference-skill-proof-v1';
    readonly source: LearningPreferenceSkillSourceMetadataV1;
    readonly requestDigest: string;
    readonly outputDigest: string;
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly proofDigest: string;
}

export interface LearningPreferenceSkillSourcePayload {
    readonly version: 'learning-preference-skill-source-v1';
    readonly rawSessionId: string;
    readonly proof: LearningPreferenceSkillProofV1;
    readonly learningEvent: LearningEventRecord;
    readonly assistant: Readonly<{ messageId: number; round: 1; proseDigest: string; historyEpoch: number }>;
    readonly committedAt: string;
}

export interface LearningPreferenceSkillSourceEntry extends LearningPreferenceSkillSourcePayload {
    readonly packetDigest: string;
    readonly state: 'pending' | 'delivered' | 'invalidated';
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export interface LearningPreferenceSkillSourceScan {
    readonly entries: readonly LearningPreferenceSkillSourceEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface Journal {
    readonly journalVersion: 'learning-preference-skill-source-journal-v1';
    readonly payload: LearningPreferenceSkillSourcePayload;
    readonly packetDigest: string;
    readonly state: LearningPreferenceSkillSourceEntry['state'];
    readonly deliveredAt: string | null;
    readonly invalidatedAt: string | null;
    readonly reasonCode: string | null;
}

export const LEARNING_PREFERENCE_SKILL_SOURCE_PREFIX = 'learning_preference_skill_source:';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const TAG = /^(pace|tone|interaction|viewpoint|relationship|action)\.[a-z][a-z0-9_]*\.(like|avoid)$/u;
const MAX_PACKET_CHARS = 32_768;

export function learningPreferenceSkillSourceDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('learning-preference-skill-record-invalid');
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new Error('learning-preference-skill-keys-invalid');
    }
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('learning-preference-skill-token-invalid');
    return value;
}

function count(value: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new Error('learning-preference-skill-count-invalid');
    }
    return Number(value);
}

/** Mirrors the already-normalized inference result, never a prompt or unbounded model response. */
export function learningPreferenceSkillOutputDigest(tokens: readonly string[]): string {
    if (!Array.isArray(tokens) || tokens.length > 32
        || Array.from({ length: tokens.length }, (_, index) => index)
            .some((index) => !Object.hasOwn(tokens, index)
                || typeof tokens[index] !== 'string' || !TAG.test(tokens[index]!))) {
        throw new Error('learning-preference-skill-tags-invalid');
    }
    const sorted = [...new Set(tokens)].sort();
    return learningPreferenceSkillSourceDigest({
        version: 'typed-preference-v1', confidence: 'inferred-low', tags: sorted.map((item) => ({ token: item })),
    });
}

function normalizeSource(input: unknown): LearningPreferenceSkillSourceMetadataV1 {
    const value = record(input);
    const scope = record(value.scope);
    exactKeys(value, [
        'sourceVersion', 'taskKind', 'policyVersion', 'stage', 'runId', 'parentRunId', 'sessionId',
        'sourceRevision', 'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision', 'round',
        'explicitPreferenceCount', 'regenerate', 'userPromptDigest', 'inputDigest', 'preferenceEpoch',
        'preferenceEvidenceRevision', 'authorityRevision', 'sourceDigest',
    ]);
    if (Object.keys(scope).some((field) => !['sessionId', 'cardId', 'worldId'].includes(field))
        || value.sourceVersion !== 'session-learning-preference-skill-source-v1'
        || value.taskKind !== 'preference_extract' || value.policyVersion !== 'p14-q6-preference-v1'
        || value.stage !== 'initial-prompt-inference' || value.round !== 1
        || value.explicitPreferenceCount !== 0 || value.regenerate !== false
        || !['nsf', 'nsfw'].includes(String(value.contentMode))) {
        throw new Error('learning-preference-skill-source-invalid');
    }
    const source = Object.freeze({
        sourceVersion: 'session-learning-preference-skill-source-v1' as const,
        taskKind: 'preference_extract' as const, policyVersion: 'p14-q6-preference-v1' as const,
        stage: 'initial-prompt-inference' as const,
        runId: token(value.runId), parentRunId: token(value.parentRunId), sessionId: token(value.sessionId),
        sourceRevision: token(value.sourceRevision), contentMode: value.contentMode as 'nsf' | 'nsfw',
        scope: Object.freeze({
            sessionId: token(scope.sessionId),
            ...(scope.cardId === undefined ? {} : { cardId: token(scope.cardId) }),
            ...(scope.worldId === undefined ? {} : { worldId: token(scope.worldId) }),
        }),
        assetRevision: agentClosureDigest(value.assetRevision, 'asset-revision'),
        worldbookSourceRevision: agentClosureDigest(value.worldbookSourceRevision, 'worldbook-source-revision'),
        round: 1 as const, explicitPreferenceCount: 0 as const, regenerate: false as const,
        userPromptDigest: agentClosureDigest(value.userPromptDigest, 'user-prompt-digest'),
        inputDigest: agentClosureDigest(value.inputDigest, 'input-digest'),
        preferenceEpoch: count(value.preferenceEpoch),
        preferenceEvidenceRevision:
            agentClosureDigest(value.preferenceEvidenceRevision, 'preference-evidence-revision'),
        authorityRevision: agentClosureDigest(value.authorityRevision, 'authority-revision'),
    });
    const requestIdentity = {
        sourceVersion: source.sourceVersion, stage: source.stage, userPromptDigest: source.userPromptDigest,
        round: source.round, explicitPreferenceCount: source.explicitPreferenceCount, regenerate: source.regenerate,
    };
    const originalSource = {
        ...requestIdentity, taskKind: source.taskKind, policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sessionId: source.sessionId,
        sourceRevision: source.sourceRevision, contentMode: source.contentMode, scope: source.scope,
        assetRevision: source.assetRevision, worldbookSourceRevision: source.worldbookSourceRevision,
        inputDigest: source.inputDigest, preferenceEpoch: source.preferenceEpoch,
        preferenceEvidenceRevision: source.preferenceEvidenceRevision,
    };
    const sourceDigest = agentClosureDigest(value.sourceDigest, 'source-digest');
    if (source.parentRunId !== source.runId || source.scope.sessionId !== source.sessionId
        || source.inputDigest !== learningPreferenceSkillSourceDigest(requestIdentity)
        || source.authorityRevision !== learningPreferenceSkillSourceDigest(originalSource)
        || sourceDigest !== learningPreferenceSkillSourceDigest(source)) {
        throw new Error('learning-preference-skill-source-digest-invalid');
    }
    return Object.freeze({ ...source, sourceDigest });
}

export function normalizeLearningPreferenceSkillProof(input: unknown): LearningPreferenceSkillProofV1 {
    const value = record(input);
    exactKeys(value, ['version', 'source', 'requestDigest', 'outputDigest', 'attribution',
        'admittedAt', 'executedAt', 'validatedAt', 'proofDigest']);
    if (value.version !== 'learning-preference-skill-proof-v1') {
        throw new Error('learning-preference-skill-proof-version-invalid');
    }
    const proof = Object.freeze({
        version: 'learning-preference-skill-proof-v1' as const, source: normalizeSource(value.source),
        requestDigest: agentClosureDigest(value.requestDigest, 'request-digest'),
        outputDigest: agentClosureDigest(value.outputDigest, 'output-digest'),
        attribution: normalizeAgentSkillClosureAttribution(value.attribution),
        admittedAt: agentClosureTimestamp(value.admittedAt, 'admitted-at'),
        executedAt: agentClosureTimestamp(value.executedAt, 'executed-at'),
        validatedAt: agentClosureTimestamp(value.validatedAt, 'validated-at'),
    });
    const proofDigest = agentClosureDigest(value.proofDigest, 'proof-digest');
    if (proof.executedAt < proof.admittedAt || proof.validatedAt < proof.executedAt
        || proof.attribution.selectedManifestDigests.length === 0
        || learningPreferenceSkillSourceDigest(proof) !== proofDigest) {
        throw new Error('learning-preference-skill-proof-digest-invalid');
    }
    return Object.freeze({ ...proof, proofDigest });
}

export function normalizeLearningPreferenceSkillSourcePayload(input: unknown): LearningPreferenceSkillSourcePayload {
    const value = record(input);
    const assistant = record(value.assistant);
    exactKeys(value, ['version', 'rawSessionId', 'proof', 'learningEvent', 'assistant', 'committedAt']);
    exactKeys(assistant, ['messageId', 'round', 'proseDigest', 'historyEpoch']);
    const rawSessionId = token(value.rawSessionId);
    const eventInput = record(value.learningEvent);
    exactKeys(eventInput, ['eventId', 'runId', 'sessionId', 'cardId', 'contentMode', 'eventKind', 'round',
        'userMessageId', 'assistantMessageId', 'sourceRevision', 'subjectDigest', 'features',
        'createdAt', 'payloadDigest', 'deliveredAt']);
    const event = normalizeLearningEvent(eventInput as unknown as LearningEventRecord);
    if (event.payloadDigest !== eventInput.payloadDigest || eventInput.deliveredAt !== null) {
        throw new Error('learning-preference-skill-event-digest-invalid');
    }
    const proof = normalizeLearningPreferenceSkillProof(value.proof);
    const used = Object.freeze({
        messageId: count(assistant.messageId, 1), round: 1 as const,
        proseDigest: agentClosureDigest(assistant.proseDigest, 'assistant-prose-digest'),
        historyEpoch: count(assistant.historyEpoch),
    });
    const committedAt = agentClosureTimestamp(value.committedAt, 'committed-at');
    const features = event.features;
    const tags = features.inferredPreferenceTags;
    if (value.version !== 'learning-preference-skill-source-v1' || assistant.round !== 1
        || event.eventKind !== 'session_start_prompt' || event.round !== 1 || event.userMessageId === null
        || event.assistantMessageId !== used.messageId
        || event.sourceRevision !== `round-1-assistant-${used.messageId}`
        || event.runId !== opaqueLearningToken('run', proof.source.runId)
        || event.sessionId !== opaqueLearningToken('session', rawSessionId)
        || event.sessionId !== proof.source.sessionId || event.contentMode !== proof.source.contentMode
        || event.subjectDigest !== proof.source.userPromptDigest
        || preferenceEpochOf(event) !== proof.source.preferenceEpoch
        || features.preferenceExtractorVersion !== 'prompt-preference-v1'
        || !Array.isArray(features.explicitPreferenceTags) || features.explicitPreferenceTags.length !== 0
        || features.explicitPreferenceCount !== 0 || features.hasPreferenceConflict !== false
        || !Array.isArray(tags) || features.inferredPreferenceCount !== tags.length
        || features.preferenceConfidence !== (tags.length > 0 ? 'inferred-low' : 'none')
        || learningPreferenceSkillOutputDigest(tags) !== proof.outputDigest
        || committedAt < proof.validatedAt || event.createdAt !== committedAt) {
        throw new Error('learning-preference-skill-payload-binding-invalid');
    }
    return Object.freeze({
        version: 'learning-preference-skill-source-v1', rawSessionId, proof,
        learningEvent: event, assistant: used, committedAt,
    });
}

function key(payload: LearningPreferenceSkillSourcePayload): string {
    return `${LEARNING_PREFERENCE_SKILL_SOURCE_PREFIX}${payload.learningEvent.eventId}`;
}

function payloadOf(value: LearningPreferenceSkillSourceEntry): LearningPreferenceSkillSourcePayload {
    return normalizeLearningPreferenceSkillSourcePayload({
        version: value.version, rawSessionId: value.rawSessionId, proof: value.proof,
        learningEvent: value.learningEvent, assistant: value.assistant, committedAt: value.committedAt,
    });
}

function entry(value: Journal): LearningPreferenceSkillSourceEntry {
    return Object.freeze({
        ...value.payload, packetDigest: value.packetDigest, state: value.state,
        deliveredAt: value.deliveredAt, invalidatedAt: value.invalidatedAt, reasonCode: value.reasonCode,
    });
}

function parseJournal(json: string): Journal {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) {
        throw new Error('learning-preference-skill-journal-size-invalid');
    }
    const value = record(JSON.parse(json));
    exactKeys(value, ['journalVersion', 'payload', 'packetDigest', 'state',
        'deliveredAt', 'invalidatedAt', 'reasonCode']);
    const payload = normalizeLearningPreferenceSkillSourcePayload(value.payload);
    const normalized: Journal = Object.freeze({
        journalVersion: 'learning-preference-skill-source-journal-v1', payload,
        packetDigest: learningPreferenceSkillSourceDigest(payload),
        state: value.state as Journal['state'],
        deliveredAt: value.deliveredAt === null ? null : agentClosureTimestamp(value.deliveredAt, 'delivered-at'),
        invalidatedAt: value.invalidatedAt === null ? null
            : agentClosureTimestamp(value.invalidatedAt, 'invalidated-at'),
        reasonCode: value.reasonCode === null ? null : token(value.reasonCode),
    });
    if (!['pending', 'delivered', 'invalidated'].includes(normalized.state)
        || normalized.state === 'pending' && (normalized.deliveredAt !== null
            || normalized.invalidatedAt !== null || normalized.reasonCode !== null)
        || normalized.state === 'delivered' && (normalized.deliveredAt === null
            || normalized.invalidatedAt !== null || normalized.reasonCode !== null)
        || normalized.state === 'invalidated' && (normalized.invalidatedAt === null
            || normalized.deliveredAt !== null || normalized.reasonCode === null)
        || normalized.deliveredAt !== null && normalized.deliveredAt < payload.committedAt
        || normalized.invalidatedAt !== null && normalized.invalidatedAt < payload.committedAt
        || JSON.stringify(normalized) !== json) {
        throw new Error('learning-preference-skill-journal-corrupt');
    }
    return normalized;
}

/** No DDL or provider access; source metadata can fail without cancelling a valid business turn. */
export class LearningPreferenceSkillSourceOutbox {
    constructor(private readonly db: DatabaseSync, private readonly rawSessionId: string) {
        token(rawSessionId);
    }

    #outsideTransaction(): void {
        if (this.db.isTransaction !== false) throw new Error('learning-preference-skill-uncommitted-read');
    }

    #read(payload: LearningPreferenceSkillSourcePayload): Journal | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key(payload)) as { value: string } | undefined;
        if (!row) return null;
        const current = parseJournal(row.value);
        if (current.payload.rawSessionId !== this.rawSessionId || key(current.payload) !== key(payload)) {
            throw new Error('learning-preference-skill-journal-owner-invalid');
        }
        return current;
    }

    #write(value: Journal): void {
        const json = JSON.stringify(value);
        if (json.length > MAX_PACKET_CHARS) throw new Error('learning-preference-skill-journal-size-invalid');
        this.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.rawSessionId, key(value.payload), json,
                value.invalidatedAt ?? value.deliveredAt ?? value.payload.committedAt);
        if (JSON.stringify(this.#read(value.payload)) !== json) {
            throw new Error('learning-preference-skill-storage-mismatch');
        }
    }

    #transaction<T>(work: () => T): T {
        this.#outsideTransaction();
        this.db.exec('BEGIN IMMEDIATE;');
        try {
            const result = work();
            if (this.db.isTransaction !== true) throw new Error('learning-preference-skill-transaction-lost');
            this.db.exec('COMMIT;');
            return result;
        } catch (error) {
            if (this.db.isTransaction === true) this.db.exec('ROLLBACK;');
            throw error;
        }
    }

    #assertEntry(value: LearningPreferenceSkillSourceEntry): LearningPreferenceSkillSourcePayload {
        const payload = payloadOf(value);
        if (payload.rawSessionId !== this.rawSessionId
            || learningPreferenceSkillSourceDigest(payload) !== value.packetDigest) {
            throw new Error('learning-preference-skill-entry-digest-invalid');
        }
        return payload;
    }

    #currentEvent(payload: LearningPreferenceSkillSourcePayload): LearningEventRecord | null {
        const expected = payload.learningEvent;
        const outbox = new LearningOutboxStore(this.db);
        const current = outbox.get(expected.eventId);
        if (!current || JSON.stringify({ ...current, deliveredAt: null }) !== JSON.stringify(expected)) return null;
        if (outbox.currentPreferenceEpoch(expected) !== payload.proof.source.preferenceEpoch) return null;
        const epoch = this.db.prepare(`SELECT value FROM session_control
            WHERE session_key=? AND control_key='history_epoch'`)
            .get(this.rawSessionId) as { value: string } | undefined;
        const currentEpoch = epoch ? Number(epoch.value) : 0;
        count(currentEpoch);
        if (epoch && epoch.value !== String(currentEpoch)) {
            throw new Error('learning-preference-skill-history-epoch-corrupt');
        }
        if (currentEpoch !== payload.assistant.historyEpoch) return null;
        const assistant = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?')
            .get(payload.assistant.messageId) as { round: number; role: string; content: string } | undefined;
        if (!assistant || assistant.round !== 1 || assistant.role !== 'assistant'
            || typeof assistant.content !== 'string'
            || learningPreferenceSkillSourceDigest(assistant.content) !== payload.assistant.proseDigest) return null;
        return current;
    }

    enqueue(input: LearningPreferenceSkillSourcePayload): boolean {
        if (this.db.isTransaction !== true) throw new Error('learning-preference-skill-business-transaction-required');
        this.db.exec('SAVEPOINT learning_preference_skill_source_enqueue;');
        try {
            const payload = normalizeLearningPreferenceSkillSourcePayload(input);
            if (payload.rawSessionId !== this.rawSessionId || !this.#currentEvent(payload)) {
                throw new Error('learning-preference-skill-business-source-invalid');
            }
            const packetDigest = learningPreferenceSkillSourceDigest(payload);
            const previous = this.#read(payload);
            if (previous && (previous.packetDigest !== packetDigest || previous.state === 'invalidated')) {
                throw new Error('learning-preference-skill-source-intent-conflict');
            }
            if (!previous) this.#write({
                journalVersion: 'learning-preference-skill-source-journal-v1', payload, packetDigest,
                state: 'pending', deliveredAt: null, invalidatedAt: null, reasonCode: null,
            });
            this.db.exec('RELEASE learning_preference_skill_source_enqueue;');
            if (this.db.isTransaction !== true) throw new Error('learning-preference-skill-business-transaction-lost');
            return true;
        } catch (error) {
            if (this.db.isTransaction !== true) throw error;
            this.db.exec('ROLLBACK TO learning_preference_skill_source_enqueue;'
                + ' RELEASE learning_preference_skill_source_enqueue;');
            return false;
        }
    }

    /** Reads retained delivered rows too, so deleting/rebuilding the central ledger does not destroy provenance. */
    scan(limit = 64, cursor = 0): LearningPreferenceSkillSourceScan {
        this.#outsideTransaction();
        count(cursor);
        if (count(limit, 1) > 256) throw new Error('learning-preference-skill-scan-limit-invalid');
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.rawSessionId, `${LEARNING_PREFERENCE_SKILL_SOURCE_PREFIX}*`, cursor, limit) as {
                rowid: number; control_key: string; value: string;
            }[];
        const entries: LearningPreferenceSkillSourceEntry[] = [];
        let failed = 0;
        for (const row of rows) {
            try {
                const current = parseJournal(row.value);
                if (current.payload.rawSessionId !== this.rawSessionId || key(current.payload) !== row.control_key) {
                    throw new Error('learning-preference-skill-journal-row-invalid');
                }
                entries.push(entry(current));
            } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: rows.length, failed,
            nextCursor: rows.length === limit ? Number(rows.at(-1)!.rowid) : 0, hasMore: rows.length === limit,
        });
    }

    /** Corruption throws for retry; only a genuine historical fence or missing authority returns null. */
    readCurrentEvent(value: LearningPreferenceSkillSourceEntry): LearningEventRecord | null {
        const payload = this.#assertEntry(value);
        return this.#transaction(() => {
            const current = this.#read(payload);
            if (!current || current.packetDigest !== value.packetDigest || current.state === 'invalidated') return null;
            return this.#currentEvent(payload);
        });
    }

    acknowledge(value: LearningPreferenceSkillSourceEntry, at: string): void {
        const payload = this.#assertEntry(value);
        const deliveredAt = agentClosureTimestamp(at, 'delivered-at');
        this.#transaction(() => {
            const current = this.#read(payload);
            if (!current || current.packetDigest !== value.packetDigest || current.state === 'invalidated'
                || deliveredAt < payload.committedAt || !this.#currentEvent(payload)) {
                throw new Error('learning-preference-skill-ack-conflict');
            }
            if (current.state === 'delivered') return;
            this.#write({ ...current, state: 'delivered', deliveredAt });
        });
    }

    /** Invalidation never asserts a profile rollback or changes the original inferred-low source event. */
    invalidate(value: LearningPreferenceSkillSourceEntry, at: string, reasonCode: string): void {
        const payload = this.#assertEntry(value);
        const invalidatedAt = agentClosureTimestamp(at, 'invalidated-at');
        const reason = token(reasonCode);
        this.#transaction(() => {
            const current = this.#read(payload);
            if (!current || current.packetDigest !== value.packetDigest || invalidatedAt < payload.committedAt) {
                throw new Error('learning-preference-skill-invalidate-conflict');
            }
            if (current.state === 'invalidated') return;
            this.#write({ ...current, state: 'invalidated', deliveredAt: null, invalidatedAt, reasonCode: reason });
        });
    }
}
