/** @author Codex @date 2026-10-27 @version 1.0
 * Read original committed regeneration events without opening or migrating a Session.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { LearningOutboxStore, opaqueLearningToken } from '../../packages/memory/public/learning-outbox.ts';
import type { RegenerationEvidenceSource } from './skill-hub/regeneration-evidence.ts';

export function openRegenerationEvidenceSource(path: string, rawSessionId: string):
    (RegenerationEvidenceSource & Readonly<{ hasEvents(): boolean }>) | null {
    agentClosureToken(rawSessionId, 'regeneration-evidence-session');
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('regeneration-evidence-source-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        const columns = (db.prepare('PRAGMA table_info(learning_outbox)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0
            || JSON.stringify(columns) !== JSON.stringify([
                ['event_id', 'TEXT', 0, 1], ['run_id', 'TEXT', 0, 0], ['session_id', 'TEXT', 1, 0],
                ['card_id', 'TEXT', 1, 0], ['content_mode', 'TEXT', 1, 0], ['event_kind', 'TEXT', 1, 0],
                ['round', 'INTEGER', 1, 0], ['user_message_id', 'INTEGER', 0, 0],
                ['assistant_message_id', 'INTEGER', 0, 0], ['source_revision', 'TEXT', 0, 0],
                ['subject_digest', 'TEXT', 1, 0], ['features_json', 'TEXT', 1, 0],
                ['payload_digest', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0], ['delivered_at', 'TEXT', 0, 0],
            ])) throw new Error('regeneration-evidence-source-schema-invalid');
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino)
            throw new Error('regeneration-evidence-source-file-drift');
        const identity = opaqueLearningToken('session', rawSessionId);
        const outbox = new LearningOutboxStore(db);
        const snapshot = <T>(work: () => T): T => {
            if (db.isTransaction !== false) throw new Error('regeneration-evidence-source-outer-transaction');
            db.exec('BEGIN;');
            try { return work(); }
            finally { if (db.isTransaction) db.exec('ROLLBACK;'); }
        };
        const read = (eventId: string) => {
            const event = outbox.get(eventId);
            if (!event) return null;
            if (event.sessionId !== identity || event.eventKind !== 'regenerate')
                throw new Error('regeneration-evidence-source-scope-invalid');
            return event;
        };
        return Object.freeze({
            hasEvents: () => snapshot(() => !!db.prepare(`SELECT 1 FROM learning_outbox
                WHERE session_id=? AND event_kind='regenerate' LIMIT 1`).get(identity)),
            scan(limit = 64, cursor = 0) {
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256
                    || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('regeneration-evidence-page-invalid');
                return snapshot(() => {
                    const rows = db.prepare(`SELECT rowid AS source_cursor,event_id FROM learning_outbox
                        WHERE session_id=? AND event_kind='regenerate' AND rowid>? ORDER BY rowid LIMIT ?`)
                        .all(identity, cursor, limit) as { source_cursor: number; event_id: string }[];
                    let failed = 0;
                    const entries = rows.flatMap((row) => {
                        try { const event = read(row.event_id); if (!event) throw new Error('regeneration-evidence-source-missing');
                            return [event]; }
                        catch { failed += 1; return []; }
                    });
                    const nextCursor = rows.at(-1)?.source_cursor ?? cursor;
                    if (!Number.isSafeInteger(nextCursor) || nextCursor < cursor || rows.length > 0 && nextCursor === cursor)
                        throw new Error('regeneration-evidence-cursor-invalid');
                    const hasMore = !!db.prepare(`SELECT 1 FROM learning_outbox WHERE session_id=?
                        AND event_kind='regenerate' AND rowid>? LIMIT 1`).get(identity, nextCursor);
                    return Object.freeze({ entries: Object.freeze(entries), attempted: rows.length, failed, nextCursor, hasMore });
                });
            },
            read: (eventId: string) => snapshot(() => read(eventId)),
            close: () => db.close(),
        });
    } catch (error) { db.close(); throw error; }
}

/** Delivered learning events also remain historical archive sources. No acknowledgement or migration. */
export function hasRetainedRegenerationEvidence(path: string, rawSessionId: string): boolean {
    const source = openRegenerationEvidenceSource(path, rawSessionId);
    if (!source) return false;
    try { return source.hasEvents(); }
    finally { source.close(); }
}
