/** @author Codex @date 2026-10-27 @version 1.0
 * Read retained Memory adoption metadata without initializing a Session or mutating its database.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { MaintenanceMemoryConsumptionOutbox }
    from '../../packages/memory/public/maintenance-memory-consumption-outbox.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import type { MaintenanceMemoryEvidenceSource } from './skill-hub/maintenance-memory-evidence.ts';

export function openMaintenanceMemoryEvidenceSource(path: string, rawSessionId: string):
    (MaintenanceMemoryEvidenceSource & Readonly<{ hasEvidenceBindings(): boolean }>) | null {
    agentClosureToken(rawSessionId, 'memory-evidence-session');
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('memory-evidence-source-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0
            || JSON.stringify(columns('session_control')) !== JSON.stringify([
                ['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
                ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0],
            ]) || JSON.stringify(columns('chat_log')) !== JSON.stringify([
                ['id', 'INTEGER', 0, 1], ['round', 'INTEGER', 1, 0], ['role', 'TEXT', 1, 0],
                ['content', 'TEXT', 1, 0], ['created_at', 'TEXT', 0, 0],
            ])) throw new Error('memory-evidence-source-schema-invalid');
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino)
            throw new Error('memory-evidence-source-file-drift');
        const memory = {
            db,
            transaction<T>(work: () => T): T {
                if (db.isTransaction !== false) throw new Error('memory-evidence-source-outer-transaction');
                db.exec('BEGIN;');
                try { return work(); }
                finally { if (db.isTransaction) db.exec('ROLLBACK;'); }
            },
        };
        const outbox = new MaintenanceMemoryConsumptionOutbox(db, rawSessionId);
        const committer = new MemorySummaryMaintenanceCommitter({ sessionId: rawSessionId, memory }, () => {
            throw new Error('memory-evidence-current-revision-forbidden');
        });
        return Object.freeze({
            hasEvidenceBindings: () => !!db.prepare(`SELECT 1 FROM session_control
                WHERE session_key=? AND control_key GLOB 'maintenance_memory_consumption:*'
                  AND CASE WHEN json_valid(value) THEN json_type(value,'$.payload.evidenceBinding') END='object'
                LIMIT 1`).get(rawSessionId),
            outbox: Object.freeze({
                scanRetained: (limit?: number, cursor?: number) => outbox.scanRetained(limit, cursor),
                readBySourceRef: (sourceRef: string) => outbox.readBySourceRef(sourceRef),
                consumerIsCurrentReadOnly: (entry: Parameters<typeof outbox.consumerIsCurrentReadOnly>[0]) =>
                    outbox.consumerIsCurrentReadOnly(entry),
            }),
            committer: Object.freeze({
                readMemoryWriteEvidence: (runId: string) => committer.readMemoryWriteEvidence(runId),
            }), close: () => db.close(),
        });
    } catch (error) { db.close(); throw error; }
}

/** Recording may be off when retained forward-bound receipts first need a central archive. */
export function hasRetainedMaintenanceMemoryEvidence(path: string, rawSessionId: string): boolean {
    const source = openMaintenanceMemoryEvidenceSource(path, rawSessionId);
    if (!source) return false;
    try { return source.hasEvidenceBindings(); }
    finally { source.close(); }
}
