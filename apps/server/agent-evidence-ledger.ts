/** @author Codex @date 2026-10-16 @version 1.0 */
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    agentEvidenceRecordDigest,
    createAgentEvidenceInvalidationRecord,
    normalizeAgentEvidenceEnvelope,
    type AgentEvidenceEnvelope,
    type AgentEvidenceInvalidationRecordV1,
} from '@jiuguan/skill-hub';
import { opaqueLearningToken } from '../../packages/memory/public/learning-outbox.ts';

export const AGENT_EVIDENCE_DB_FILE = 'agent-evidence.sqlite';
export const AGENT_EVIDENCE_SCHEMA_VERSION = 1;
export const AGENT_EVIDENCE_APPLICATION_ID = 0x4a474556; // JGEV

export interface StoredAgentEvidenceRecord {
    readonly record: AgentEvidenceEnvelope;
    readonly recordDigest: string;
    readonly ingestedAt: string;
    /** The archive cannot attest that the original source remains authoritative. */
    readonly sourceStatus: 'unchecked';
}

export interface AgentEvidenceAppendResult {
    readonly status: 'inserted' | 'replayed' | 'discarded-deleted-session';
    readonly record: StoredAgentEvidenceRecord | null;
}

export interface AgentEvidencePage {
    readonly records: readonly StoredAgentEvidenceRecord[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

type SqlRow = Record<string, unknown>;
const MAX_PAGE_SIZE = 256;
const RAW_SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SCHEMA_STATEMENTS = Object.freeze([
    `CREATE TABLE evidence_record (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
        record_digest TEXT NOT NULL CHECK(length(record_digest) = 71),
        ingested_at TEXT NOT NULL
    )`,
    `CREATE TABLE evidence_session_tombstone (
        session_key TEXT NOT NULL PRIMARY KEY,
        redacted_at TEXT NOT NULL
    )`,
    'CREATE INDEX evidence_record_session ON evidence_record(session_key)',
    `CREATE TRIGGER evidence_record_no_update BEFORE UPDATE ON evidence_record
        BEGIN SELECT RAISE(ABORT, 'agent evidence is immutable'); END`,
    `CREATE TRIGGER evidence_session_tombstone_no_update BEFORE UPDATE ON evidence_session_tombstone
        BEGIN SELECT RAISE(ABORT, 'agent evidence deletion fence is immutable'); END`,
    `CREATE TRIGGER evidence_session_tombstone_no_delete BEFORE DELETE ON evidence_session_tombstone
        BEGIN SELECT RAISE(ABORT, 'agent evidence deletion fence is immutable'); END`,
]);


function normalizeSchemaSql(value: string): string {
    return value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
}


function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
    const value = (db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined)?.[name];
    if (!Number.isSafeInteger(value)) throw new Error(`agent-evidence-${name}-invalid`);
    return Number(value);
}


function schemaSql(db: DatabaseSync): string[] {
    const rows = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ).all() as SqlRow[];
    return rows.map((row) => {
        if (typeof row.sql !== 'string') throw new Error('agent-evidence-schema-invalid');
        return normalizeSchemaSql(row.sql);
    }).sort();
}


/** Read-only schema contract, shared by normal open and online snapshot validation. */
export function inspectAgentEvidenceSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== AGENT_EVIDENCE_APPLICATION_ID
        || pragma(db, 'user_version') !== AGENT_EVIDENCE_SCHEMA_VERSION) {
        throw new Error('agent-evidence-metadata-mismatch');
    }
    const expected = SCHEMA_STATEMENTS.map(normalizeSchemaSql).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expected)) {
        throw new Error('agent-evidence-schema-mismatch');
    }
}


function initialize(db: DatabaseSync): void {
    const version = pragma(db, 'user_version');
    const applicationId = pragma(db, 'application_id');
    if (version !== 0 || applicationId !== 0) {
        inspectAgentEvidenceSchema(db);
        return;
    }
    if (schemaSql(db).length !== 0) throw new Error('agent-evidence-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${AGENT_EVIDENCE_APPLICATION_ID};`);
        for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
        db.exec(`PRAGMA user_version=${AGENT_EVIDENCE_SCHEMA_VERSION};`);
        inspectAgentEvidenceSchema(db);
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
}


function existingStat(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}


function assertPrivateDirectory(dataDir: string): void {
    if (dataDir === parse(dataDir).root) throw new Error('agent-evidence-data-dir-invalid');
    let current = dataDir;
    while (current !== dirname(current)) {
        const stat = existingStat(current);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
            throw new Error('agent-evidence-data-dir-invalid');
        }
        current = dirname(current);
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}


function assertRegularFile(path: string): void {
    const stat = existingStat(path);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('agent-evidence-file-invalid');
}


function rawSessionId(value: unknown): string {
    if (typeof value !== 'string' || !RAW_SESSION_ID.test(value)) {
        throw new Error('agent-evidence-session-key-invalid');
    }
    return value;
}


function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('agent-evidence-timestamp-invalid');
    return value;
}


function nonNegativeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`agent-evidence-${field}-invalid`);
    return Number(value);
}


function parseRow(row: SqlRow): StoredAgentEvidenceRecord {
    const sessionKey = rawSessionId(row.session_key);
    if (typeof row.envelope_json !== 'string') throw new Error('agent-evidence-envelope-invalid');
    const record = normalizeAgentEvidenceEnvelope(JSON.parse(row.envelope_json));
    const recordDigest = agentEvidenceRecordDigest(record);
    if (record.evidenceId !== row.evidence_id || record.sessionId !== opaqueLearningToken('session', sessionKey)
        || typeof row.record_digest !== 'string' || !DIGEST.test(row.record_digest)
        || recordDigest !== row.record_digest || JSON.stringify(record) !== row.envelope_json) {
        throw new Error('agent-evidence-record-mismatch');
    }
    return Object.freeze({ record, recordDigest, ingestedAt: timestamp(row.ingested_at), sourceStatus: 'unchecked' });
}


/** Metadata archive only: no model calls, profile reconstruction, replay authority or promotion. */
export class AgentEvidenceLedger {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #isSessionDeleted: (rawSessionId: string) => boolean;
    #closed = false;

    constructor(options: {
        readonly dataDir: string;
        readonly now?: () => string;
        /** Receives the raw backend session key, never the envelope identity. */
        readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    }) {
        if (typeof options.dataDir !== 'string' || options.dataDir.trim() === '') {
            throw new Error('agent-evidence-data-dir-invalid');
        }
        const dataDir = resolve(options.dataDir);
        assertPrivateDirectory(dataDir);
        const path = join(dataDir, AGENT_EVIDENCE_DB_FILE);
        for (const suffix of ['', '-wal', '-shm', '-journal']) assertRegularFile(`${path}${suffix}`);
        this.#db = new DatabaseSync(path);
        try {
            // Optional synchronous sidecars must not stall the main event loop while another writer owns the file.
            this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
            initialize(this.#db);
            this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
            for (const suffix of ['', '-wal', '-shm']) {
                const file = `${path}${suffix}`;
                assertRegularFile(file);
                if (existingStat(file)) {
                    try {
                        chmodSync(file, 0o600);
                    } catch (error) {
                        if (process.platform !== 'win32') throw error;
                        // Windows inherits the private parent ACL instead of POSIX owner permissions.
                    }
                }
            }
        } catch (error) {
            this.#db.close();
            throw error;
        }
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#isSessionDeleted = options.isSessionDeleted ?? (() => false);
    }

    append(sessionIdValue: string, input: AgentEvidenceEnvelope): AgentEvidenceAppendResult {
        this.#assertOpen();
        const sessionKey = rawSessionId(sessionIdValue);
        const record = normalizeAgentEvidenceEnvelope(input);
        if (record.sessionId !== opaqueLearningToken('session', sessionKey)) {
            throw new Error('agent-evidence-session-binding-mismatch');
        }
        return this.#transaction(() => {
            if (this.#blocked(sessionKey)) return this.#discarded();
            if (record.eventType === 'source-invalidated') this.#assertInvalidationAnchor(sessionKey, record);
            const existing = this.#find(record.evidenceId);
            const recordDigest = agentEvidenceRecordDigest(record);
            if (existing) {
                const stored = this.#stored(existing);
                if (existing.session_key !== sessionKey || stored.recordDigest !== recordDigest) {
                    throw new Error('agent-evidence-record-conflict');
                }
                if (this.#blocked(sessionKey)) return this.#discarded();
                return Object.freeze({ status: 'replayed', record: stored });
            }
            this.#db.prepare(`
                INSERT INTO evidence_record(evidence_id,session_key,envelope_json,record_digest,ingested_at)
                VALUES(?,?,?,?,?)
            `).run(record.evidenceId, sessionKey, JSON.stringify(record), recordDigest, timestamp(this.#now()));
            const inserted = this.#find(record.evidenceId);
            if (!inserted) throw new Error('agent-evidence-insert-missing');
            const stored = this.#stored(inserted);
            if (stored.recordDigest !== recordDigest) throw new Error('agent-evidence-insert-mismatch');
            if (this.#blocked(sessionKey)) throw new Error('agent-evidence-session-deleted-during-append');
            return Object.freeze({ status: 'inserted', record: stored });
        });
    }

    /** Original immutable history only; source validity must be re-projected outside this archive. */
    get(evidenceId: string): StoredAgentEvidenceRecord | null {
        this.#assertOpen();
        if (typeof evidenceId !== 'string' || !DIGEST.test(evidenceId)) {
            throw new Error('agent-evidence-id-invalid');
        }
        const row = this.#find(evidenceId);
        if (!row || this.#blocked(rawSessionId(row.session_key))) return null;
        const stored = this.#stored(row);
        // A deletion lookup or validation can overlap an external privacy
        // commit. Never return the row captured before that visible fence.
        return this.#blocked(rawSessionId(row.session_key)) ? null : stored;
    }

    /** The cursor counts actual examined rows, including invalid or deleted-source rows. */
    list(input: { readonly rawSessionId?: string; readonly limit?: number; readonly cursor?: number } = {}):
        AgentEvidencePage {
        this.#assertOpen();
        const limit = nonNegativeInteger(input.limit ?? 64, 'limit');
        const cursor = nonNegativeInteger(input.cursor ?? 0, 'cursor');
        if (limit < 1 || limit > MAX_PAGE_SIZE) throw new Error('agent-evidence-limit-invalid');
        const sessionKey = input.rawSessionId === undefined ? null : rawSessionId(input.rawSessionId);
        if (sessionKey !== null && this.#blocked(sessionKey)) return this.#emptyPage(cursor);
        const rows = this.#db.prepare(`
            SELECT * FROM evidence_record WHERE record_id > ?${sessionKey === null ? '' : ' AND session_key = ?'}
            ORDER BY record_id LIMIT ?
        `).all(...(sessionKey === null ? [cursor, limit + 1] : [cursor, sessionKey, limit + 1])) as SqlRow[];
        const pageRows = rows.slice(0, limit);
        const records: { sessionKey: string; stored: StoredAgentEvidenceRecord }[] = [];
        let failed = 0;
        let nextCursor = cursor;
        for (const row of pageRows) {
            nextCursor = nonNegativeInteger(row.record_id, 'row-cursor');
            let key: string;
            try { key = rawSessionId(row.session_key); } catch { failed += 1; continue; }
            if (this.#blocked(key)) continue;
            try { records.push({ sessionKey: key, stored: this.#stored(row) }); } catch { failed += 1; }
        }
        // Validate the whole collected page after reading/validating every row:
        // a later source's lookup can observe deletion of an earlier source.
        // This is bounded sampling, not a cross-Journal/Ledger atomic snapshot.
        const blocked = new Map<string, boolean>();
        for (const { sessionKey: key } of records) {
            if (!blocked.has(key)) blocked.set(key, this.#blocked(key));
        }
        return Object.freeze({
            records: Object.freeze(records.filter(({ sessionKey: key }) => !blocked.get(key))
                .map(({ stored }) => stored)), attempted: pageRows.length, failed,
            nextCursor, hasMore: rows.length > limit,
        });
    }

    /** Atomic purge and durable fence prevent restored or late sources from reinserting this session. */
    redactSession(sessionIdValue: string): Readonly<{ deleted: number }> {
        this.#assertOpen();
        const sessionKey = rawSessionId(sessionIdValue);
        return this.#transaction(() => {
            this.#db.prepare(`
                INSERT INTO evidence_session_tombstone(session_key,redacted_at) VALUES(?,?)
                ON CONFLICT(session_key) DO NOTHING
            `).run(sessionKey, timestamp(this.#now()));
            this.#localTombstone(sessionKey);
            const deleted = Number(this.#db.prepare('DELETE FROM evidence_record WHERE session_key=?')
                .run(sessionKey).changes);
            if (this.#db.prepare('SELECT 1 FROM evidence_record WHERE session_key=?').get(sessionKey)) {
                throw new Error('agent-evidence-redaction-incomplete');
            }
            return Object.freeze({ deleted });
        });
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }

    #find(evidenceId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM evidence_record WHERE evidence_id=?').get(evidenceId) as
            SqlRow | undefined;
    }

    #assertInvalidationAnchor(sessionKey: string, record: AgentEvidenceInvalidationRecordV1): void {
        const row = this.#find(record.sourceRef);
        if (!row || row.session_key !== sessionKey) throw new Error('agent-evidence-invalidation-anchor-missing');
        const anchor = parseRow(row);
        if (anchor.record.eventType !== 'context-consumed') {
            throw new Error('agent-evidence-invalidation-anchor-invalid');
        }
        const expected = createAgentEvidenceInvalidationRecord({
            consumed: anchor.record,
            domain: record.sourceType === 'maintenance-memory-rollback-v1' ? 'memory' : 'summary',
            rollbackDigest: record.artifactDigest, rolledBackAt: record.occurredAt,
        });
        if (anchor.recordDigest !== record.sourceDigest
            || agentEvidenceRecordDigest(expected) !== agentEvidenceRecordDigest(record)) {
            throw new Error('agent-evidence-invalidation-anchor-mismatch');
        }
    }

    #stored(row: SqlRow): StoredAgentEvidenceRecord {
        const stored = parseRow(row);
        if (stored.record.eventType === 'source-invalidated') {
            this.#assertInvalidationAnchor(rawSessionId(row.session_key), stored.record);
        }
        return stored;
    }

    #localTombstone(sessionKey: string): boolean {
        const row = this.#db.prepare('SELECT * FROM evidence_session_tombstone WHERE session_key=?')
            .get(sessionKey) as SqlRow | undefined;
        if (!row) return false;
        if (row.session_key !== sessionKey) throw new Error('agent-evidence-tombstone-invalid');
        timestamp(row.redacted_at);
        return true;
    }

    #blocked(sessionKey: string): boolean {
        if (this.#localTombstone(sessionKey)) return true;
        const deleted = this.#isSessionDeleted(sessionKey);
        if (typeof deleted !== 'boolean') throw new Error('agent-evidence-session-deletion-state-invalid');
        return deleted;
    }

    #transaction<T>(action: () => T): T {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            if (!this.#db.isTransaction) throw new Error('agent-evidence-transaction-lost');
            this.#db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    #discarded(): AgentEvidenceAppendResult {
        return Object.freeze({ status: 'discarded-deleted-session', record: null });
    }

    #emptyPage(cursor: number): AgentEvidencePage {
        return Object.freeze({
            records: Object.freeze([]), attempted: 0, failed: 0, nextCursor: cursor, hasMore: false,
        });
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error('agent-evidence-ledger-closed');
    }
}
