/** Historical evidence for a successful advisory request, never narrative adoption or execution authority. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { agentClosureTimestamp } from '../../packages/agent-closure/index.ts';
import { MemoryDb, inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { opaqueLearningToken, sha256Digest } from '../../packages/memory/public/learning-outbox.ts';
import { TurnOutcomeStore } from '../../packages/memory/public/turn-outcome.ts';
import { ChatSession } from '../../packages/session/public/session.ts';
import { assertAqlReplanSkillSourceSessionBinding, isAqlReplanSkillSourceCurrent,
    normalizeAqlReplanSkillSourceSnapshot, type AqlReplanSkillSourceSnapshotV1 } from './skill-hub/aql-replan-context.ts';
import { normalizeAqlReplanSkillOutputProof, takeAqlReplanSkillOutputProof,
    type AqlReplanSkillOutputProofV1 } from './skill-hub/aql-replan-source-proof.ts';

export const AQL_REPLAN_SKILL_SOURCE_PREFIX = 'aql_replan_skill_source:';
export interface AqlReplanSkillSourceReceipt {
    readonly version: 'aql-replan-skill-source-receipt-v1';
    readonly source: AqlReplanSkillSourceSnapshotV1;
    readonly proof: AqlReplanSkillOutputProofV1;
    readonly observedAt: string;
    readonly evidence: 'validated-advisory-request';
    readonly adoption: 'not-applicable';
    readonly learningWeight: 0;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly receiptDigest: string;
}
export interface AqlReplanSkillSourcePage {
    readonly version: 'aql-replan-skill-source-page-v1';
    readonly entries: readonly Readonly<{ receipt: AqlReplanSkillSourceReceipt; sourceValidity: 'current' | 'invalidated' }>[];
    readonly attempted: number; readonly failed: number; readonly nextCursor: number; readonly hasMore: boolean;
}
const GET_MEMORY = ChatSession.prototype.getMemory;
const TRANSACTION = MemoryDb.prototype.transaction;
const MAX_RECORD_CHARS = 65_536;
const FIELDS = ['version', 'source', 'proof', 'observedAt', 'evidence', 'adoption', 'learningWeight',
    'authorizesExecution', 'authorizesPromotion', 'receiptDigest'];
function fail(reason = 'invalid'): never { throw new Error(`aql-replan-skill-source-${reason}`); }
export function aqlReplanSkillSourceReceiptDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function count(value: unknown, minimum = 1): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) fail();
    return value;
}
function key(runId: string): string { return AQL_REPLAN_SKILL_SOURCE_PREFIX + aqlReplanSkillSourceReceiptDigest([runId]).slice(7); }
export function normalizeAqlReplanSkillSourceReceipt(value: unknown): AqlReplanSkillSourceReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== FIELDS.length || FIELDS.some((name) => {
        const field = descriptors[name];
        return !field || !field.enumerable || !Object.hasOwn(field, 'value');
    })) fail();
    const row = value as Record<string, unknown>;
    const source = normalizeAqlReplanSkillSourceSnapshot(row.source), proof = normalizeAqlReplanSkillOutputProof(row.proof);
    const observedAt = agentClosureTimestamp(row.observedAt as string, 'aql-skill-observed');
    if (row.version !== 'aql-replan-skill-source-receipt-v1' || row.evidence !== 'validated-advisory-request'
        || row.adoption !== 'not-applicable' || row.learningWeight !== 0 || row.authorizesExecution !== false
        || row.authorizesPromotion !== false || JSON.stringify(source) !== JSON.stringify(proof.source)
        || observedAt < proof.validatedAt) fail();
    const base = { version: 'aql-replan-skill-source-receipt-v1' as const, source, proof, observedAt,
        evidence: 'validated-advisory-request' as const, adoption: 'not-applicable' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const };
    if (row.receiptDigest !== aqlReplanSkillSourceReceiptDigest(base)) fail();
    return Object.freeze({ ...base, receiptDigest: row.receiptDigest as string });
}

/** Stable committed history; an ordinary later turn or current asset change cannot erase past request use. */
function retained(db: DatabaseSync, rawSessionId: string, source: AqlReplanSkillSourceSnapshotV1): boolean {
    if (source.sessionId !== opaqueLearningToken('session', rawSessionId)) fail('session-mismatch');
    const row = db.prepare("SELECT value FROM session_control WHERE session_key=? AND control_key='history_epoch'")
        .get(rawSessionId) as { value: string } | undefined;
    const epoch = row ? count(Number(row.value), 0) : 0;
    if (row && row.value !== String(epoch)) fail('epoch-invalid');
    const assistant = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant'")
        .get(source.assistantMessageId, source.round) as { content: string } | undefined;
    const marker = new TurnOutcomeStore(db).getForRecovery(source.runId);
    return epoch === source.historyEpoch && !!assistant && sha256Digest(assistant.content) === source.assistantDigest
        && marker?.sessionId === rawSessionId && marker.round === source.round
        && marker.assistantMessageId === source.assistantMessageId
        && sha256Digest(JSON.stringify(marker)) === source.markerDigest;
}

/** Required evidence is committed before returning the advisory result; errors never roll back the preceding turn. */
export function commitAqlReplanSkillSourceReceipt(input: {
    readonly rawSessionId: string; readonly session: ChatSession; readonly proof: unknown;
    readonly isCurrentSession: () => boolean;
}): AqlReplanSkillSourceReceipt {
    const proof = takeAqlReplanSkillOutputProof(input.proof);
    if (!proof) fail('proof-invalid');
    const source = proof.source;
    assertAqlReplanSkillSourceSessionBinding(source, input.rawSessionId, input.session);
    const memory = GET_MEMORY.call(input.session).mem;
    const current = () => input.isCurrentSession() === true && memory === GET_MEMORY.call(input.session).mem
        && isAqlReplanSkillSourceCurrent(source);
    if (memory.db.isTransaction !== false || !current()) fail('stale');
    const base = { version: 'aql-replan-skill-source-receipt-v1' as const, source, proof,
        observedAt: new Date().toISOString(), evidence: 'validated-advisory-request' as const,
        adoption: 'not-applicable' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const };
    const receipt = normalizeAqlReplanSkillSourceReceipt({ ...base, receiptDigest: aqlReplanSkillSourceReceiptDigest(base) });
    const write = () => {
        if (memory.db.isTransaction !== true || !current() || !retained(memory.db, input.rawSessionId, source)) fail('stale');
        assertAqlReplanSkillSourceSessionBinding(source, input.rawSessionId, input.session);
        const value = JSON.stringify(receipt), controlKey = key(source.runId);
        if (value.length > MAX_RECORD_CHARS) fail();
        const read = () => memory.db.prepare('SELECT value,updated_at FROM session_control WHERE session_key=? AND control_key=?')
            .get(input.rawSessionId, controlKey) as { value: string; updated_at: string } | undefined;
        if (read()) fail('conflict');
        const written = memory.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(input.rawSessionId, controlKey, value, receipt.observedAt);
        const observed = read();
        if (written.changes !== 1 || observed?.value !== value || observed.updated_at !== receipt.observedAt
            || memory.db.isTransaction !== true || !current() || !retained(memory.db, input.rawSessionId, source)) fail('write-drift');
        return receipt;
    };
    return TRANSACTION.call(memory, write) as AqlReplanSkillSourceReceipt;
}

/** Same-snapshot read-only recovery; no source/output brands, model calls or repairs are restored. */
export function readAqlReplanSkillSourceFile(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number; readonly cursor?: number;
}): AqlReplanSkillSourcePage | null {
    const limit = count(input.limit ?? 50), cursor = count(input.cursor ?? 0, 0);
    if (limit > 100) fail();
    const allowed = () => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const original = lstatSync(input.path);
    if (!original.isFile() || original.isSymbolicLink()) fail('file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) fail('schema-invalid');
        inspectSessionAuthoritySchema(db);
        if (!allowed()) return null;
        const rows = db.prepare(`SELECT rowid,control_key,value,updated_at FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(input.rawSessionId, AQL_REPLAN_SKILL_SOURCE_PREFIX + '*', cursor, limit + 1) as
            { rowid: number; control_key: string; value: string; updated_at: string }[];
        const entries: Array<AqlReplanSkillSourcePage['entries'][number]> = [];
        let failed = 0, nextCursor = cursor;
        for (const row of rows.slice(0, limit)) {
            nextCursor = count(row.rowid);
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) fail();
                const receipt = normalizeAqlReplanSkillSourceReceipt(JSON.parse(row.value));
                if (row.control_key !== key(receipt.source.runId) || row.updated_at !== receipt.observedAt) fail();
                entries.push(Object.freeze({ receipt,
                    sourceValidity: retained(db, input.rawSessionId, receipt.source) ? 'current' : 'invalidated' }));
            } catch { failed++; }
        }
        db.exec('ROLLBACK;');
        const final = lstatSync(input.path);
        if (!final.isFile() || final.isSymbolicLink() || final.dev !== original.dev || final.ino !== original.ino) fail('file-drift');
        if (!allowed()) return null;
        return Object.freeze({ version: 'aql-replan-skill-source-page-v1', entries: Object.freeze(entries),
            attempted: Math.min(rows.length, limit), failed, nextCursor, hasMore: rows.length > limit });
    } finally { db.close(); }
}
