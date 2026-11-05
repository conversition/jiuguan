/** @author Codex @date 2026-10-16 @version 1.0
 * Read original committed Skill consumption metadata without opening a Session or performing migrations.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { AgentSkillConsumptionOutbox }
    from '../../packages/memory/public/agent-skill-consumption-outbox.ts';
import type { ClosureSkillEvidenceSource } from './skill-hub/closure-skill-evidence.ts';


export function openClosureSkillEvidenceSource(path: string, rawSessionId: string):
    ClosureSkillEvidenceSource | null {
    agentClosureToken(rawSessionId, 'closure-evidence-source-owner');
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('closure-evidence-source-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0;');
        const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0
            || JSON.stringify(columns('session_control')) !== JSON.stringify([
                ['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
                ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0],
            ])
            || JSON.stringify(columns('chat_log')) !== JSON.stringify([
                ['id', 'INTEGER', 0, 1], ['round', 'INTEGER', 1, 0], ['role', 'TEXT', 1, 0],
                ['content', 'TEXT', 1, 0], ['created_at', 'TEXT', 0, 0],
            ])) throw new Error('closure-evidence-source-schema-invalid');
        const outbox = AgentSkillConsumptionOutbox.openExistingReadOnly(db);
        if (!outbox) { db.close(); return null; }
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino) {
            throw new Error('closure-evidence-source-file-drift');
        }
        return Object.freeze({ outbox, close: () => db.close() });
    } catch (error) {
        db.close();
        throw error;
    }
}


/** New installations can recover retained receipts even when forward recording is currently disabled. */
export function hasRetainedClosureSkillEvidence(path: string, rawSessionId: string): boolean {
    const source = openClosureSkillEvidenceSource(path, rawSessionId);
    if (!source) return false;
    try { return source.outbox.hasEvidenceBindings(); }
    finally { source.close(); }
}
