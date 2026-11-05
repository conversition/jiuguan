/** Retained provenance for semantic branch attribution, never positive preference or execution authority. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, normalizeAgentSkillClosureAttribution,
    type AgentSkillClosureAttributionV1,
} from '../../agent-closure/index.ts';
import {
    LearningOutboxStore, normalizeLearningEvent, opaqueLearningToken, preferenceEpochOf, sha256Digest,
    type LearningEventRecord,
} from './learning-outbox.ts';

declare const BRANCH_PREFERENCE_SKILL_PREPARATION: unique symbol;
export interface BranchPreferenceSkillPreparation { readonly [BRANCH_PREFERENCE_SKILL_PREPARATION]: true }

export interface BranchPreferenceSkillSourceMetadataV1 {
    readonly sourceVersion: 'session-branch-preference-skill-source-v1';
    readonly taskKind: 'preference_extract';
    readonly policyVersion: 'p14-q6-branch-semantic-v1';
    readonly stage: 'edited-branch-attribution';
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: Readonly<{ sessionId: string; cardId?: string; worldId?: string }>;
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly round: number;
    readonly exposureRound: number;
    readonly regenerate: false;
    readonly userInputDigest: string;
    readonly branchSetDigest: string;
    readonly storyIndexDigest: string;
    readonly exposureDigest: string;
    readonly candidatesDigest: string;
    readonly preferenceEpoch: number;
    readonly preferenceEvidenceRevision: string;
    readonly historyEpoch: number;
    readonly inputDigest: string;
    readonly authorityRevision: string;
    readonly sourceDigest: string;
}

export interface BranchPreferenceSkillProofV1 {
    readonly version: 'branch-preference-skill-proof-v1';
    readonly source: BranchPreferenceSkillSourceMetadataV1;
    readonly requestDigest: string;
    readonly output: Readonly<{ selectedIndex: number; confidence: number }>;
    readonly outputDigest: string;
    readonly attribution: AgentSkillClosureAttributionV1;
    readonly admittedAt: string;
    readonly executedAt: string;
    readonly validatedAt: string;
    readonly proofDigest: string;
}

export interface BranchPreferenceSkillSourcePayload {
    readonly version: 'branch-preference-skill-source-v1';
    readonly rawSessionId: string;
    readonly proof: BranchPreferenceSkillProofV1;
    readonly learningEvent: LearningEventRecord;
    readonly assistant: Readonly<{ messageId: number; round: number; proseDigest: string; historyEpoch: number }>;
    readonly committedAt: string;
}

export interface BranchPreferenceSkillSourceEntry extends BranchPreferenceSkillSourcePayload {
    readonly packetDigest: string;
    readonly state: 'retained' | 'invalidated';
    readonly reasonCode: null | 'branch-preference-source-invalidated';
}
export interface BranchPreferenceSkillSourceScan {
    readonly entries: readonly BranchPreferenceSkillSourceEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

export const BRANCH_PREFERENCE_SKILL_SOURCE_PREFIX = 'branch_preference_skill_source:';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MAX_PACKET_CHARS = 32_768;
const SOURCE_FIELDS = ['sourceVersion', 'taskKind', 'policyVersion', 'stage', 'runId', 'parentRunId',
    'sessionId', 'sourceRevision', 'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision',
    'round', 'exposureRound', 'regenerate', 'userInputDigest', 'branchSetDigest', 'storyIndexDigest',
    'exposureDigest', 'candidatesDigest', 'preferenceEpoch', 'preferenceEvidenceRevision', 'historyEpoch',
    'inputDigest', 'authorityRevision', 'sourceDigest'];
const EVENT_FIELDS = ['eventId', 'runId', 'sessionId', 'cardId', 'contentMode', 'eventKind', 'round',
    'userMessageId', 'assistantMessageId', 'sourceRevision', 'subjectDigest', 'features', 'createdAt',
    'payloadDigest', 'deliveredAt'];

export function branchPreferenceSkillSourceDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('branch-preference-skill-record-invalid');
    }
    return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, fields: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
        throw new Error('branch-preference-skill-fields-invalid');
    }
}
function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('branch-preference-skill-token-invalid');
    return value;
}
function count(value: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new Error('branch-preference-skill-count-invalid');
    }
    return Number(value);
}
function output(value: unknown): BranchPreferenceSkillProofV1['output'] {
    const item = record(value);
    exactKeys(item, ['selectedIndex', 'confidence']);
    const selectedIndex = count(item.selectedIndex);
    if (selectedIndex > 7 || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
        || item.confidence < 0.6 || item.confidence > 1) throw new Error('branch-preference-skill-output-invalid');
    return Object.freeze({ selectedIndex, confidence: item.confidence });
}
export function branchPreferenceSkillOutputDigest(value: BranchPreferenceSkillProofV1['output']): string {
    const normalized = output(value);
    return branchPreferenceSkillSourceDigest({ version: 'branch-semantic-v1', ...normalized, ambiguous: false });
}

/** Fixed, body-free Session contract. Normalization neither issues nor restores host capabilities. */
export function normalizeBranchPreferenceSkillSource(input: unknown): BranchPreferenceSkillSourceMetadataV1 {
    const value = record(input);
    exactKeys(value, SOURCE_FIELDS);
    const scope = record(value.scope);
    if (Object.keys(scope).some((key) => !['sessionId', 'cardId', 'worldId'].includes(key))
        || value.sourceVersion !== 'session-branch-preference-skill-source-v1'
        || value.taskKind !== 'preference_extract' || value.policyVersion !== 'p14-q6-branch-semantic-v1'
        || value.stage !== 'edited-branch-attribution' || value.regenerate !== false
        || value.contentMode !== 'nsf' && value.contentMode !== 'nsfw') {
        throw new Error('branch-preference-skill-source-invalid');
    }
    const source = Object.freeze({
        sourceVersion: 'session-branch-preference-skill-source-v1' as const,
        taskKind: 'preference_extract' as const, policyVersion: 'p14-q6-branch-semantic-v1' as const,
        stage: 'edited-branch-attribution' as const,
        runId: token(value.runId), parentRunId: token(value.parentRunId), sessionId: token(value.sessionId),
        sourceRevision: token(value.sourceRevision), contentMode: value.contentMode,
        scope: Object.freeze({ sessionId: token(scope.sessionId),
            ...(scope.cardId === undefined ? {} : { cardId: token(scope.cardId) }),
            ...(scope.worldId === undefined ? {} : { worldId: token(scope.worldId) }) }),
        assetRevision: agentClosureDigest(value.assetRevision, 'branch-asset-revision'),
        worldbookSourceRevision: agentClosureDigest(value.worldbookSourceRevision, 'branch-worldbook-revision'),
        round: count(value.round, 2), exposureRound: count(value.exposureRound, 1), regenerate: false as const,
        userInputDigest: agentClosureDigest(value.userInputDigest, 'branch-user-input-digest'),
        branchSetDigest: agentClosureDigest(value.branchSetDigest, 'branch-set-digest'),
        storyIndexDigest: agentClosureDigest(value.storyIndexDigest, 'branch-story-index-digest'),
        exposureDigest: agentClosureDigest(value.exposureDigest, 'branch-exposure-digest'),
        candidatesDigest: agentClosureDigest(value.candidatesDigest, 'branch-candidates-digest'),
        preferenceEpoch: count(value.preferenceEpoch),
        preferenceEvidenceRevision: agentClosureDigest(value.preferenceEvidenceRevision, 'branch-preference-revision'),
        historyEpoch: count(value.historyEpoch), inputDigest: agentClosureDigest(value.inputDigest, 'branch-input-digest'),
    });
    const requestIdentity = { sourceVersion: source.sourceVersion, stage: source.stage, round: source.round,
        exposureRound: source.exposureRound, regenerate: source.regenerate, userInputDigest: source.userInputDigest,
        branchSetDigest: source.branchSetDigest, storyIndexDigest: source.storyIndexDigest,
        exposureDigest: source.exposureDigest, candidatesDigest: source.candidatesDigest };
    const authorityRevision = agentClosureDigest(value.authorityRevision, 'branch-authority-revision');
    const metadata = Object.freeze({ ...source, authorityRevision });
    const sourceDigest = agentClosureDigest(value.sourceDigest, 'branch-source-digest');
    if (source.runId !== source.parentRunId || source.scope.sessionId !== source.sessionId
        || source.round !== source.exposureRound + 1
        || source.inputDigest !== branchPreferenceSkillSourceDigest(requestIdentity)
        || authorityRevision !== branchPreferenceSkillSourceDigest(source)
        || sourceDigest !== branchPreferenceSkillSourceDigest(metadata)) {
        throw new Error('branch-preference-skill-source-digest-invalid');
    }
    return Object.freeze({ ...metadata, sourceDigest });
}

export function normalizeBranchPreferenceSkillProof(input: unknown): BranchPreferenceSkillProofV1 {
    const value = record(input);
    exactKeys(value, ['version', 'source', 'requestDigest', 'output', 'outputDigest', 'attribution',
        'admittedAt', 'executedAt', 'validatedAt', 'proofDigest']);
    if (value.version !== 'branch-preference-skill-proof-v1') throw new Error('branch-preference-skill-proof-version-invalid');
    const proof = Object.freeze({
        version: 'branch-preference-skill-proof-v1' as const, source: normalizeBranchPreferenceSkillSource(value.source),
        requestDigest: agentClosureDigest(value.requestDigest, 'branch-request-digest'), output: output(value.output),
        outputDigest: agentClosureDigest(value.outputDigest, 'branch-output-digest'),
        attribution: normalizeAgentSkillClosureAttribution(value.attribution),
        admittedAt: agentClosureTimestamp(value.admittedAt, 'branch-admitted-at'),
        executedAt: agentClosureTimestamp(value.executedAt, 'branch-executed-at'),
        validatedAt: agentClosureTimestamp(value.validatedAt, 'branch-validated-at'),
    });
    const proofDigest = agentClosureDigest(value.proofDigest, 'branch-proof-digest');
    if (proof.executedAt < proof.admittedAt || proof.validatedAt < proof.executedAt
        || proof.attribution.selectedManifestDigests.length === 0
        || proof.outputDigest !== branchPreferenceSkillOutputDigest(proof.output)
        || proofDigest !== branchPreferenceSkillSourceDigest(proof)) {
        throw new Error('branch-preference-skill-proof-digest-invalid');
    }
    return Object.freeze({ ...proof, proofDigest });
}

export function normalizeBranchPreferenceSkillSourcePayload(input: unknown): BranchPreferenceSkillSourcePayload {
    const value = record(input), assistant = record(value.assistant), rawEvent = record(value.learningEvent);
    exactKeys(value, ['version', 'rawSessionId', 'proof', 'learningEvent', 'assistant', 'committedAt']);
    exactKeys(assistant, ['messageId', 'round', 'proseDigest', 'historyEpoch']);
    exactKeys(rawEvent, EVENT_FIELDS);
    const proof = normalizeBranchPreferenceSkillProof(value.proof);
    const event = normalizeLearningEvent(rawEvent as unknown as LearningEventRecord);
    const rawSessionId = token(value.rawSessionId);
    const used = Object.freeze({ messageId: count(assistant.messageId, 1), round: count(assistant.round, 2),
        proseDigest: agentClosureDigest(assistant.proseDigest, 'branch-assistant-digest'),
        historyEpoch: count(assistant.historyEpoch) });
    const committedAt = agentClosureTimestamp(value.committedAt, 'branch-committed-at');
    const features = event.features;
    exactKeys(record(features), ['normalizationVersion', 'actionTag', 'lengthBucket', 'selectedIndex', 'branchCount',
        'exposureRound', 'selectionSource', 'inputEditedFromSelection', 'matchConfidence', 'preferenceEpoch']);
    if (value.version !== 'branch-preference-skill-source-v1' || event.payloadDigest !== rawEvent.payloadDigest
        || rawEvent.deliveredAt !== null || event.eventKind !== 'branch_exact_selected'
        || event.userMessageId === null || event.assistantMessageId !== used.messageId
        || event.round !== used.round || used.round !== proof.source.round
        || event.sourceRevision !== `round-${used.round}-assistant-${used.messageId}`
        || event.runId !== opaqueLearningToken('run', proof.source.runId)
        || event.sessionId !== opaqueLearningToken('session', rawSessionId) || event.sessionId !== proof.source.sessionId
        || event.contentMode !== proof.source.contentMode || preferenceEpochOf(event) !== proof.source.preferenceEpoch
        || used.historyEpoch !== proof.source.historyEpoch || features.normalizationVersion !== 'branch-semantic-v1'
        || features.selectionSource !== 'semantic' || features.matchConfidence !== 'semantic-low'
        || features.inputEditedFromSelection !== true || features.exposureRound !== proof.source.exposureRound
        || features.selectedIndex !== proof.output.selectedIndex
        || !Number.isSafeInteger(features.branchCount) || Number(features.branchCount) < 1
        || Number(features.branchCount) > 8 || proof.output.selectedIndex >= Number(features.branchCount)
        || !['investigate', 'social', 'move', 'confront', 'wait', 'other'].includes(String(features.actionTag))
        || !['short', 'medium', 'long'].includes(String(features.lengthBucket))
        || committedAt < proof.validatedAt || committedAt !== event.createdAt) {
        throw new Error('branch-preference-skill-payload-binding-invalid');
    }
    return Object.freeze({ version: 'branch-preference-skill-source-v1', rawSessionId, proof,
        learningEvent: event, assistant: used, committedAt });
}

interface StoredPacket { readonly payload: BranchPreferenceSkillSourcePayload; readonly packetDigest: string }
function key(runId: string): string { return `${BRANCH_PREFERENCE_SKILL_SOURCE_PREFIX}${branchPreferenceSkillSourceDigest(token(runId)).slice(7)}`; }
function parsePacket(json: string): StoredPacket {
    if (typeof json !== 'string' || json.length > MAX_PACKET_CHARS) throw new Error('branch-preference-skill-packet-size-invalid');
    const value = record(JSON.parse(json));
    exactKeys(value, ['payload', 'packetDigest']);
    const payload = normalizeBranchPreferenceSkillSourcePayload(value.payload);
    const packetDigest = agentClosureDigest(value.packetDigest, 'branch-packet-digest');
    if (packetDigest !== branchPreferenceSkillSourceDigest(payload)
        || JSON.stringify({ payload, packetDigest }) !== json) throw new Error('branch-preference-skill-packet-corrupt');
    return Object.freeze({ payload, packetDigest });
}

/** Optional metadata in the original Session transaction; construction and all recovery reads perform no DDL. */
export class BranchPreferenceSkillSourceStore {
    constructor(private readonly db: DatabaseSync, private readonly rawSessionId: string) { token(rawSessionId); }

    #read(runId: string): StoredPacket | null {
        const row = this.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.rawSessionId, key(runId)) as { value: string } | undefined;
        if (!row) return null;
        const packet = parsePacket(row.value);
        if (packet.payload.rawSessionId !== this.rawSessionId || packet.payload.proof.source.runId !== runId) {
            throw new Error('branch-preference-skill-packet-owner-invalid');
        }
        return packet;
    }

    #current(payload: BranchPreferenceSkillSourcePayload): LearningEventRecord | null {
        if (payload.rawSessionId !== this.rawSessionId) return null;
        const expected = payload.learningEvent, source = payload.proof.source;
        const outbox = new LearningOutboxStore(this.db), current = outbox.get(expected.eventId);
        if (!current || JSON.stringify({ ...current, deliveredAt: null }) !== JSON.stringify(expected)
            || outbox.currentPreferenceEpoch(expected) !== source.preferenceEpoch) return null;
        const epoch = this.db.prepare("SELECT value FROM session_control WHERE session_key=? AND control_key='history_epoch'")
            .get(this.rawSessionId) as { value: string } | undefined;
        const historyEpoch = epoch ? Number(epoch.value) : 0;
        if (!Number.isSafeInteger(historyEpoch) || historyEpoch < 0 || epoch && epoch.value !== String(historyEpoch)) {
            throw new Error('branch-preference-skill-history-epoch-corrupt');
        }
        if (historyEpoch !== payload.assistant.historyEpoch) return null;
        const readMessage = (id: number, role: string): string | null => {
            const message = this.db.prepare('SELECT round,role,content FROM chat_log WHERE id=?').get(id) as
                { round: number; role: string; content: string } | undefined;
            return message?.round === expected.round && message.role === role && typeof message.content === 'string'
                ? message.content : null;
        };
        const user = readMessage(expected.userMessageId!, 'user'), assistant = readMessage(payload.assistant.messageId, 'assistant');
        if (user === null || assistant === null || sha256Digest(user) !== source.userInputDigest
            || branchPreferenceSkillSourceDigest(assistant) !== payload.assistant.proseDigest) return null;
        const story = this.db.prepare('SELECT content FROM story_index WHERE round=?').get(source.exposureRound) as
            { content: string } | undefined;
        if (!story || typeof story.content !== 'string' || sha256Digest(story.content) !== source.storyIndexDigest) return null;
        const exposureRows = this.db.prepare(`SELECT event_id FROM learning_outbox WHERE event_kind='branch_exposed'
            AND session_id=? AND content_mode=? AND round=? AND subject_digest=? AND payload_digest=?`)
            .all(expected.sessionId, expected.contentMode, source.exposureRound, source.branchSetDigest, source.exposureDigest) as
            { event_id: string }[];
        if (exposureRows.length !== 1 || outbox.get(exposureRows[0]!.event_id)?.payloadDigest !== source.exposureDigest) return null;
        const invalidated = this.db.prepare(`SELECT event_id FROM learning_outbox WHERE session_id=?
            AND event_kind IN ('delete','regenerate')`).all(expected.sessionId) as { event_id: string }[];
        for (const row of invalidated) {
            const event = outbox.get(row.event_id);
            if (event && (event.eventKind === 'delete' && event.sourceRevision === expected.sourceRevision
                || event.eventKind === 'regenerate' && event.features.replacedSourceRevision === expected.sourceRevision)) return null;
        }
        return current;
    }

    enqueue(input: BranchPreferenceSkillSourcePayload): boolean {
        if (this.db.isTransaction !== true) throw new Error('branch-preference-skill-business-transaction-required');
        this.db.exec('SAVEPOINT branch_preference_skill_source_enqueue;');
        try {
            const payload = normalizeBranchPreferenceSkillSourcePayload(input);
            if (!this.#current(payload)) throw new Error('branch-preference-skill-business-source-invalid');
            const packet = Object.freeze({ payload, packetDigest: branchPreferenceSkillSourceDigest(payload) });
            const previous = this.#read(payload.proof.source.runId), json = JSON.stringify(packet);
            if (json.length > MAX_PACKET_CHARS || previous && JSON.stringify(previous) !== json) {
                throw new Error('branch-preference-skill-source-intent-conflict');
            }
            if (!previous) this.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
                .run(this.rawSessionId, key(payload.proof.source.runId), json, payload.committedAt);
            if (JSON.stringify(this.#read(payload.proof.source.runId)) !== json || !this.#current(payload)) {
                throw new Error('branch-preference-skill-storage-mismatch');
            }
            this.db.exec('RELEASE branch_preference_skill_source_enqueue;');
            if (this.db.isTransaction !== true) throw new Error('branch-preference-skill-business-transaction-lost');
            return true;
        } catch (error) {
            if (this.db.isTransaction !== true) throw error;
            this.db.exec('ROLLBACK TO branch_preference_skill_source_enqueue; RELEASE branch_preference_skill_source_enqueue;');
            return false;
        }
    }

    #entry(packet: StoredPacket): BranchPreferenceSkillSourceEntry {
        const current = this.#current(packet.payload) !== null;
        return Object.freeze({ ...packet.payload, packetDigest: packet.packetDigest,
            state: current ? 'retained' : 'invalidated',
            reasonCode: current ? null : 'branch-preference-source-invalidated' });
    }

    get(runId: string): BranchPreferenceSkillSourceEntry | null {
        const packet = this.#read(token(runId));
        return packet ? this.#entry(packet) : null;
    }

    /** Historical payload remains immutable; live state is derived, never written by a reader. */
    readCurrentEvent(value: BranchPreferenceSkillSourcePayload | BranchPreferenceSkillSourceEntry): LearningEventRecord | null {
        const payload = normalizeBranchPreferenceSkillSourcePayload({ version: value.version, rawSessionId: value.rawSessionId,
            proof: value.proof, learningEvent: value.learningEvent, assistant: value.assistant, committedAt: value.committedAt });
        const packet = this.#read(payload.proof.source.runId);
        if (!packet || packet.packetDigest !== branchPreferenceSkillSourceDigest(payload)) return null;
        return this.#current(payload);
    }

    /** Rowid cursor advances past corrupt rows too. Compatible with readOnly/query_only physical recovery. */
    scan(input: Readonly<{ limit?: number; cursor?: number }> = {}): BranchPreferenceSkillSourceScan {
        const limit = count(input.limit ?? 64, 1), cursor = count(input.cursor ?? 0);
        if (limit > 256) throw new Error('branch-preference-skill-scan-limit-invalid');
        const rows = this.db.prepare(`SELECT rowid,control_key,value FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.rawSessionId, `${BRANCH_PREFERENCE_SKILL_SOURCE_PREFIX}*`, cursor, limit + 1) as
            { rowid: number; control_key: string; value: string }[];
        const page = rows.slice(0, limit), entries: BranchPreferenceSkillSourceEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                const packet = parsePacket(row.value);
                if (packet.payload.rawSessionId !== this.rawSessionId || key(packet.payload.proof.source.runId) !== row.control_key) {
                    throw new Error('branch-preference-skill-packet-row-invalid');
                }
                entries.push(this.#entry(packet));
            } catch { failed += 1; }
        }
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit });
    }
}
