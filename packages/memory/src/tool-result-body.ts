/** Session-owned untrusted tool bodies. References locate bytes; current host access authorizes every operation. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryDb } from './db.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { validateSessionAuthorityForOwnedAdapter } from './session-authority.ts';
import { boundToolResult, type ToolResultContractMetadata } from '../../harness/public/tool-result-contract.ts';

export const TOOL_RESULT_BODY_REFERENCE_VERSION = 'tool-result-body-ref-v1' as const;
export interface ToolResultBodyAccess {
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly historyEpoch: number;
    readonly readAllowed: boolean;
    readonly writeAllowed: boolean;
    readonly deletionOpen: boolean;
}
export interface ToolResultBodyLimits {
    readonly maxBodyChars: number;
    readonly maxWriteChars: number;
    readonly maxReadChars: number;
    readonly maxTotalWriteChars: number;
    readonly maxTotalReadChars: number;
    readonly maxSessionBytes: number;
    readonly maxTtlMs: number;
}
export interface ToolResultBodyReference {
    readonly version: typeof TOOL_RESULT_BODY_REFERENCE_VERSION;
    readonly refId: string;
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly historyEpoch: number;
    readonly sourceDigest: string;
    readonly originalLength: number;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
}
export interface ToolResultBodyStoreOptions {
    readonly memoryDb: MemoryDb;
    readonly sessionId: string;
    readonly readCurrentAccess: () => ToolResultBodyAccess | null;
    readonly clock: () => number;
    readonly limits: ToolResultBodyLimits;
    /** Opens only existing storage; never installs or repairs a table/marker. */
    readonly readOnly?: boolean;
}
const MARKER_SESSION = '__tool_result_body_owner__', MARKER_KEY = 'tool-result-body-owner-v1';
const SQL = `CREATE TABLE tool_result_body (
    ref_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    content_mode TEXT NOT NULL CHECK(content_mode IN ('nsf','nsfw')),
    history_epoch INTEGER NOT NULL CHECK(history_epoch>=0),
    source_digest TEXT NOT NULL,
    original_length INTEGER NOT NULL CHECK(original_length>=0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>created_at_ms),
    body_utf16le BLOB NOT NULL CHECK(typeof(body_utf16le)='blob' AND length(body_utf16le)=original_length*2),
    UNIQUE(session_id,content_mode,history_epoch,source_digest)
);
CREATE TRIGGER tool_result_body_immutable BEFORE UPDATE ON tool_result_body
BEGIN SELECT RAISE(ABORT,'tool-result-body-immutable'); END;`;
const METADATA = 'ref_id,session_id,content_mode,history_epoch,source_digest,original_length,created_at_ms,expires_at_ms';
const SELECT_METADATA = `${METADATA},length(body_utf16le) AS body_bytes,typeof(body_utf16le) AS body_type`;
const REF = /^tool-result-body:[a-f0-9]{64}$/u, HASH = /^sha256:[a-f0-9]{64}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const REF_FIELDS = ['version', 'refId', 'sessionId', 'contentMode', 'historyEpoch', 'sourceDigest',
    'originalLength', 'createdAtMs', 'expiresAtMs'] as const;
const LIMIT_FIELDS = ['maxBodyChars', 'maxWriteChars', 'maxReadChars', 'maxTotalWriteChars',
    'maxTotalReadChars', 'maxSessionBytes', 'maxTtlMs'] as const;
function fail(code: string): never { throw new Error(`tool-result-body-${code}`); }
function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function own(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('input-invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) fail('input-invalid');
    return Object.fromEntries(fields.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('input-invalid');
        return [key, descriptor.value];
    }));
}
function integer(value: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) fail('input-invalid');
    return Number(value);
}
function mode(value: unknown): 'nsf' | 'nsfw' {
    if (value !== 'nsf' && value !== 'nsfw') fail('input-invalid'); return value;
}
function session(value: unknown): string {
    if (typeof value !== 'string' || !SESSION.test(value)) fail('input-invalid'); return value;
}
function sourceDigest(text: string): string {
    return `sha256:${createHash('sha256').update(text, 'utf16le').digest('hex')}`;
}
function makeReference(input: Omit<ToolResultBodyReference, 'refId'>): ToolResultBodyReference {
    return Object.freeze({ ...input, refId: `tool-result-body:${hash(input).slice(7)}` });
}
function reference(input: unknown): ToolResultBodyReference {
    const value = own(input, REF_FIELDS);
    if (value.version !== TOOL_RESULT_BODY_REFERENCE_VERSION || typeof value.refId !== 'string' || !REF.test(value.refId)
        || typeof value.sourceDigest !== 'string' || !HASH.test(value.sourceDigest)) fail('reference-invalid');
    const parsed = makeReference({ version: TOOL_RESULT_BODY_REFERENCE_VERSION, sessionId: session(value.sessionId),
        contentMode: mode(value.contentMode), historyEpoch: integer(value.historyEpoch), sourceDigest: value.sourceDigest,
        originalLength: integer(value.originalLength), createdAtMs: integer(value.createdAtMs), expiresAtMs: integer(value.expiresAtMs) });
    if (parsed.refId !== value.refId || parsed.expiresAtMs <= parsed.createdAtMs) fail('reference-invalid');
    return parsed;
}
function fromRow(row: Record<string, unknown>): ToolResultBodyReference {
    if (row.body_type !== 'blob' || row.body_bytes !== integer(row.original_length) * 2) fail('digest-mismatch');
    return reference({ version: TOOL_RESULT_BODY_REFERENCE_VERSION, refId: row.ref_id, sessionId: row.session_id,
        contentMode: row.content_mode, historyEpoch: row.history_epoch, sourceDigest: row.source_digest,
        originalLength: row.original_length, createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms });
}
function normalizedSql(value: string): string { return value.trim().replace(/;$/u, ''); }
const OBJECTS = SQL.split(/;\s*(?=CREATE|$)/u).filter(Boolean).map(sql => {
    const match = /^CREATE (TABLE|TRIGGER) (\w+)/u.exec(sql.trim());
    if (!match) fail('schema-contract-invalid');
    return { name: match[2]!, type: match[1]!.toLowerCase(), sql: normalizedSql(sql) };
});
const MARKER = hash({ version: 1, ddl: SQL });

/** Legacy absence is optional. Installed-but-lost or altered truth must never be recreated empty. */
export function inspectToolResultBodyStorage(db: DatabaseSync): boolean {
    const control = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_control'").get();
    if (!control) return false;
    const marker = db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
        .get(MARKER_SESSION, MARKER_KEY) as { value?: unknown } | undefined;
    const objects = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name GLOB '*tool_result_body*' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; type: string; sql: string }>;
    const temporary = db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB '*tool_result_body*' OR tbl_name='tool_result_body'").all();
    if (!marker && objects.length === 0 && temporary.length === 0) return false;
    if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
        || marker?.value !== MARKER || objects.length !== OBJECTS.length || temporary.length) fail('storage-invalid');
    for (const expected of OBJECTS) {
        const actual = objects.find(item => item.name === expected.name);
        if (actual?.type !== expected.type || normalizedSql(actual.sql) !== expected.sql) fail('storage-invalid');
    }
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='tool_result_body'").all();
    if (triggers.length !== 1) fail('storage-invalid');
    return true;
}

/** One instance is one host budget scope; all concurrent tools share its synchronous counters. */
export class ToolResultBodyStore {
    readonly #options: ToolResultBodyStoreOptions;
    #written = 0;
    #read = 0;

    constructor(options: ToolResultBodyStoreOptions) {
        session(options.sessionId);
        for (const callback of [options.clock, options.readCurrentAccess]) {
            if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback)
                || types.isGeneratorFunction(callback)) fail('callback-invalid');
        }
        const limits = own(options.limits, LIMIT_FIELDS);
        LIMIT_FIELDS.forEach(key => integer(limits[key], 1));
        this.#options = Object.freeze({ ...options, limits: Object.freeze({ ...limits }) as unknown as ToolResultBodyLimits });
        const { memoryDb } = options;
        if (options.readOnly) {
            if (!inspectToolResultBodyStorage(memoryDb.db)) fail('storage-missing');
        } else if (!inspectToolResultBodyStorage(memoryDb.db)) {
            memoryDb.transaction(() => {
                if (inspectToolResultBodyStorage(memoryDb.db)) return;
                if (!validateSessionAuthorityForOwnedAdapter(memoryDb.db)) fail('owner-required');
                memoryDb.db.exec(SQL);
                memoryDb.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
                    .run(MARKER_SESSION, MARKER_KEY, MARKER, '1970-01-01T00:00:00.000Z');
                inspectToolResultBodyStorage(memoryDb.db);
            });
        }
    }

    #now(): number { return integer(this.#options.clock()); }
    #authorize(contentMode: 'nsf' | 'nsfw', historyEpoch: number, operation: 'read' | 'write'): void {
        let value: Record<string, unknown>;
        try {
            value = own(this.#options.readCurrentAccess(), ['sessionId', 'contentMode', 'historyEpoch',
                'readAllowed', 'writeAllowed', 'deletionOpen']);
        } catch { fail('access-denied'); }
        if (value.sessionId !== this.#options.sessionId || value.contentMode !== contentMode || value.historyEpoch !== historyEpoch
            || value.deletionOpen !== true || value[operation === 'read' ? 'readAllowed' : 'writeAllowed'] !== true
            || typeof value.readAllowed !== 'boolean' || typeof value.writeAllowed !== 'boolean'
            || !validateSessionAuthorityForOwnedAdapter(this.#options.memoryDb.db)) fail('access-denied');
    }
    #inspect(): void { if (!inspectToolResultBodyStorage(this.#options.memoryDb.db)) fail('storage-missing'); }
    #live(ref: ToolResultBodyReference, contentMode: 'nsf' | 'nsfw', historyEpoch: number): void {
        if (ref.sessionId !== this.#options.sessionId || ref.contentMode !== contentMode || ref.historyEpoch !== historyEpoch) fail('access-denied');
        if (ref.expiresAtMs - ref.createdAtMs > this.#options.limits.maxTtlMs) fail('reference-invalid');
        const now = this.#now();
        if (now < ref.createdAtMs || now >= ref.expiresAtMs) fail('expired');
    }
    #body(ref: ToolResultBodyReference): string {
        const row = this.#options.memoryDb.db.prepare('SELECT body_utf16le FROM tool_result_body WHERE ref_id=?')
            .get(ref.refId) as { body_utf16le?: unknown } | undefined;
        if (!row || !(row.body_utf16le instanceof Uint8Array) || row.body_utf16le.byteLength !== ref.originalLength * 2) fail('digest-mismatch');
        const body = Buffer.from(row.body_utf16le).toString('utf16le');
        if (body.length !== ref.originalLength || sourceDigest(body) !== ref.sourceDigest) fail('digest-mismatch');
        return body;
    }

    write(input: Readonly<{ text: string; contentMode: 'nsf' | 'nsfw'; historyEpoch: number; ttlMs: number }>): ToolResultBodyReference {
        const value = own(input, ['text', 'contentMode', 'historyEpoch', 'ttlMs']);
        const contentMode = mode(value.contentMode), historyEpoch = integer(value.historyEpoch), ttlMs = integer(value.ttlMs, 1);
        const limits = this.#options.limits;
        if (this.#options.readOnly) fail('readonly');
        if (typeof value.text !== 'string') fail('input-invalid');
        const text = value.text;
        if (text.length > limits.maxBodyChars || text.length > limits.maxWriteChars
            || text.length > limits.maxTotalWriteChars - this.#written || ttlMs > limits.maxTtlMs) fail('write-budget-exhausted');
        this.#authorize(contentMode, historyEpoch, 'write');
        const source = sourceDigest(text);
        const result = this.#options.memoryDb.transaction(() => {
            this.#inspect(); this.#authorize(contentMode, historyEpoch, 'write');
            const writeNow = this.#now();
            // Reclaim only this owner. Expiry/branch invalidation removes old identities;
            // a later write creates a new lifetime instead of refreshing an existing ref.
            this.#options.memoryDb.db.prepare(`DELETE FROM tool_result_body WHERE session_id=?
                AND (expires_at_ms<=? OR history_epoch<?)`).run(this.#options.sessionId, writeNow, historyEpoch);
            const existing = this.#options.memoryDb.db.prepare(`SELECT ${SELECT_METADATA} FROM tool_result_body
                WHERE session_id=? AND content_mode=? AND history_epoch=? AND source_digest=?`)
                .get(this.#options.sessionId, contentMode, historyEpoch, source) as Record<string, unknown> | undefined;
            if (existing) {
                const retained = fromRow(existing); this.#live(retained, contentMode, historyEpoch);
                if (retained.originalLength !== text.length) fail('digest-mismatch');
                if (this.#body(retained) !== text) fail('digest-mismatch');
                this.#authorize(contentMode, historyEpoch, 'write'); this.#live(retained, contentMode, historyEpoch);
                return retained;
            }
            const createdAtMs = this.#now(), expiresAtMs = createdAtMs + ttlMs;
            integer(expiresAtMs);
            const ref = makeReference({ version: TOOL_RESULT_BODY_REFERENCE_VERSION, sessionId: this.#options.sessionId,
                contentMode, historyEpoch, sourceDigest: source, originalLength: text.length, createdAtMs, expiresAtMs });
            // The fixed overhead also charges empty bodies and bounded row metadata; no free unlimited rows.
            const used = this.#options.memoryDb.db.prepare(`SELECT COALESCE(SUM(length(body_utf16le)+512),0) AS n
                FROM tool_result_body WHERE session_id=?`).get(this.#options.sessionId)!.n;
            if (integer(used) + text.length * 2 + 512 > limits.maxSessionBytes) fail('capacity-exhausted');
            this.#options.memoryDb.db.prepare(`INSERT INTO tool_result_body(${METADATA},body_utf16le) VALUES(?,?,?,?,?,?,?,?,?)`)
                .run(ref.refId, ref.sessionId, contentMode, historyEpoch, ref.sourceDigest, ref.originalLength,
                    ref.createdAtMs, ref.expiresAtMs, Buffer.from(text, 'utf16le'));
            const stored = this.#options.memoryDb.db.prepare(`SELECT ${SELECT_METADATA} FROM tool_result_body WHERE ref_id=?`)
                .get(ref.refId) as Record<string, unknown> | undefined;
            if (!stored || JSON.stringify(fromRow(stored)) !== JSON.stringify(ref) || this.#body(ref) !== text) fail('write-readback-mismatch');
            this.#authorize(contentMode, historyEpoch, 'write'); this.#live(ref, contentMode, historyEpoch);
            return ref;
        });
        this.#written += text.length;
        return result;
    }

    read(input: Readonly<{ reference: ToolResultBodyReference | string; contentMode: 'nsf' | 'nsfw'; historyEpoch: number; maxChars: number }>):
        Readonly<{ text: string; metadata: ToolResultContractMetadata }> {
        const value = own(input, ['reference', 'contentMode', 'historyEpoch', 'maxChars']);
        const contentMode = mode(value.contentMode), historyEpoch = integer(value.historyEpoch), maxChars = integer(value.maxChars);
        const limits = this.#options.limits;
        if (maxChars > limits.maxReadChars) fail('read-budget-exhausted');
        this.#authorize(contentMode, historyEpoch, 'read');
        const wanted = typeof value.reference === 'string' ? value.reference : reference(value.reference).refId;
        if (!REF.test(wanted)) fail('reference-invalid');
        const db = this.#options.memoryDb.db, ownTransaction = !db.isTransaction;
        if (ownTransaction) db.exec('BEGIN DEFERRED');
        try {
            this.#inspect(); this.#authorize(contentMode, historyEpoch, 'read');
            // Check row scope and persisted sizes before loading any body bytes.
            const row = db.prepare(`SELECT ${SELECT_METADATA} FROM tool_result_body WHERE ref_id=?`).get(wanted) as Record<string, unknown> | undefined;
            if (!row) fail('missing');
            const ref = fromRow(row); this.#live(ref, contentMode, historyEpoch);
            if (typeof value.reference !== 'string' && JSON.stringify(reference(value.reference)) !== JSON.stringify(ref)) fail('reference-invalid');
            if (ref.originalLength > limits.maxBodyChars || ref.originalLength > maxChars
                || ref.originalLength > limits.maxReadChars || ref.originalLength > limits.maxTotalReadChars - this.#read) fail('read-budget-exhausted');
            const text = this.#body(ref);
            this.#authorize(contentMode, historyEpoch, 'read'); this.#live(ref, contentMode, historyEpoch);
            const bounded = boundToolResult(text, maxChars);
            this.#read += text.length;
            return Object.freeze({ text: bounded.text, metadata: bounded.metadata });
        } finally { if (ownTransaction && db.isTransaction) db.exec('ROLLBACK'); }
    }
}
