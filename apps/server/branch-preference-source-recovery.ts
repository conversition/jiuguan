/** Read-only historical Branch source inspection. No replay, migration, model call or positive adoption. */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BranchPreferenceSkillSourceStore, type BranchPreferenceSkillSourceScan }
    from '../../packages/memory/public/branch-preference-skill-source.ts';
import { inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';

export function readBranchPreferenceSkillSourceFile(input: {
    readonly path: string;
    readonly rawSessionId: string;
    readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number;
    readonly cursor?: number;
}): BranchPreferenceSkillSourceScan | null {
    const allowed = () => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('branch-source-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) {
            throw new Error('branch-source-schema-invalid');
        }
        inspectSessionAuthoritySchema(db);
        const columns = (db.prepare('PRAGMA table_info(session_control)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
            ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) throw new Error('branch-source-control-schema-invalid');
        if (!allowed()) return null;
        const store = new BranchPreferenceSkillSourceStore(db, input.rawSessionId);
        const page = store.scan({ limit: input.limit, cursor: input.cursor });
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino) {
            throw new Error('branch-source-file-drift');
        }
        if (!allowed()) return null;
        if (JSON.stringify(store.scan({ limit: input.limit, cursor: input.cursor })) !== JSON.stringify(page)) {
            throw new Error('branch-source-read-drift');
        }
        return allowed() ? page : null;
    } finally { db.close(); }
}
