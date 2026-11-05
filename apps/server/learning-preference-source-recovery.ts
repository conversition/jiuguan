/** @author Codex @date 2026-10-14 @version 1.0
 * Open only existing Session metadata for inference-source recovery; never load dialogue assets or Providers.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { MemoryDb } from '../../packages/memory/public/db.ts';
import { LearningPreferenceSkillSourceOutbox }
    from '../../packages/memory/public/learning-preference-skill-source-outbox.ts';
import { LearningOutboxStore } from '../../packages/memory/public/learning-outbox.ts';

function sessionControlColumns(db: DatabaseSync): string {
    return JSON.stringify((db.prepare('PRAGMA table_info(session_control)').all() as {
        name: string; type: string; notnull: number; pk: number;
    }[]).map((row) => [row.name, row.type, row.notnull, row.pk]));
}

const SESSION_CONTROL_COLUMNS = JSON.stringify([['session_key', 'TEXT', 1, 1],
    ['control_key', 'TEXT', 1, 2], ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]]);

/**
 * A background sweep can reach a session database that has not been opened by the normal
 * resume path yet, so its `user_version` may still be one release behind (v16 while the code
 * is at v17). Strictly demanding the current version turned that into a permanent sweep
 * failure loop. The read-only probe therefore accepts the current version **or any older one
 * with the identical control-column shape**; the writable open then migrates through the
 * official MemoryDb path before the strict check runs.
 */
function validateReadable(db: DatabaseSync): void {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown })
        .user_version ?? 0);
    if (version < 1 || version > SCHEMA_VERSION
        || (db.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id !== 0
        || sessionControlColumns(db) !== SESSION_CONTROL_COLUMNS) {
        throw new Error('learning-preference-source-recovery-schema-invalid');
    }
}

function validateCurrent(db: DatabaseSync): void {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown })
        .user_version ?? 0);
    if (version !== SCHEMA_VERSION
        || (db.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id !== 0
        || sessionControlColumns(db) !== SESSION_CONTROL_COLUMNS) {
        throw new Error('learning-preference-source-recovery-schema-invalid');
    }
}

export function openLearningPreferenceSkillSourceRecovery(path: string, rawSessionId: string) {
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('learning-preference-source-recovery-file-invalid');
    const inspect = new DatabaseSync(path, { readOnly: true });
    let opened: DatabaseSync | null = null;
    try {
        validateReadable(inspect);
        if (!existsSync(path)) return null;
        // The official open path migrates legacy versions before the strict check; opening the
        // raw database here instead would leave every older-version session unrecoverable.
        opened = new MemoryDb({ path }).db;
        validateCurrent(opened);
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino) {
            throw new Error('learning-preference-source-recovery-file-drift');
        }
        const db = opened;
        return Object.freeze({
            outbox: new LearningPreferenceSkillSourceOutbox(db, rawSessionId),
            preferenceClearTombstones: () => new LearningOutboxStore(db).preferenceClearTombstones(),
            close: () => db.close()
        });
    } catch (error) { opened?.close(); throw error; }
    finally { inspect.close(); }
}
