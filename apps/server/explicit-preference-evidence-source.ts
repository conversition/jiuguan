/** @author Codex @date 2026-10-16 @version 1.0
 * Read existing adoption receipts only; no Session initialization, writes, assets or Provider access.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { ExplicitPreferenceAdoptionJournal }
    from '../../packages/memory/public/explicit-preference-adoption-journal.ts';


export function openExplicitPreferenceEvidenceSource(path: string, rawSessionId: string) {
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('explicit-evidence-source-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const columns = db.prepare('PRAGMA table_info(session_control)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[];
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0
            || JSON.stringify(columns.map((row) => [row.name, row.type, row.notnull, row.pk]))
            !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
            ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) {
            throw new Error('explicit-evidence-source-schema-invalid');
        }
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino) {
            throw new Error('explicit-evidence-source-file-drift');
        }
        return Object.freeze({
            journal: new ExplicitPreferenceAdoptionJournal(db, rawSessionId),
            close: () => db.close(),
        });
    } catch (error) {
        db.close();
        throw error;
    }
}


/** A newly introduced central store must discover retained local receipts even with recording off. */
export function hasRetainedExplicitPreferenceEvidence(path: string, rawSessionId: string): boolean {
    const source = openExplicitPreferenceEvidenceSource(path, rawSessionId);
    if (!source) return false;
    try { return source.journal.scan(1).attempted > 0; }
    finally { source.close(); }
}
