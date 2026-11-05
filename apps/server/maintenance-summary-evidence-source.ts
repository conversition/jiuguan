/** @author Codex @date 2026-10-27 @version 1.0
 * Read retained Summary adoption metadata without initializing a Session or mutating its database.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { MaintenanceSummaryConsumptionOutbox }
    from '../../packages/memory/public/maintenance-summary-consumption-outbox.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import type { MaintenanceSummaryEvidenceSource } from './skill-hub/maintenance-summary-evidence.ts';

export function openMaintenanceSummaryEvidenceSource(path: string, rawSessionId: string):
    (MaintenanceSummaryEvidenceSource & Readonly<{
        hasEvidenceBindings(): boolean;
        committer: Pick<MemorySummaryMaintenanceCommitter,
            'readSummaryWriteEvidence' | 'readAgentLoopSummaryWriteEvidence'>;
    }>) | null {
    agentClosureToken(rawSessionId, 'summary-evidence-session');
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('summary-evidence-source-file-invalid');
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
            ])) throw new Error('summary-evidence-source-schema-invalid');
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino)
            throw new Error('summary-evidence-source-file-drift');
        const memory = {
            db,
            transaction<T>(work: () => T): T {
                if (db.isTransaction !== false) throw new Error('summary-evidence-source-outer-transaction');
                db.exec('BEGIN;');
                try { return work(); }
                finally { if (db.isTransaction) db.exec('ROLLBACK;'); }
            },
        };
        const outbox = new MaintenanceSummaryConsumptionOutbox(db, rawSessionId);
        const committer = new MemorySummaryMaintenanceCommitter({ sessionId: rawSessionId, memory }, () => {
            throw new Error('summary-evidence-current-revision-forbidden');
        });
        return Object.freeze({
            hasEvidenceBindings: () => !!db.prepare(`SELECT 1 FROM session_control
                WHERE session_key=? AND control_key GLOB 'maintenance_summary_consumption:*'
                  AND CASE WHEN json_valid(value) THEN json_type(value,'$.payload.evidenceBinding') END='object'
                LIMIT 1`).get(rawSessionId),
            outbox: Object.freeze({
                scanRetained: (limit?: number, cursor?: number) => outbox.scanRetained(limit, cursor),
                readBySourceRef: (sourceRef: string) => outbox.readBySourceRef(sourceRef),
                consumerIsCurrentReadOnly: (entry: Parameters<typeof outbox.consumerIsCurrentReadOnly>[0]) =>
                    outbox.consumerIsCurrentReadOnly(entry),
            }),
            committer: Object.freeze({
                readSummaryWriteEvidence: (runId: string) => committer.readSummaryWriteEvidence(runId),
                readAgentLoopSummaryWriteEvidence: (runId: string) => committer.readAgentLoopSummaryWriteEvidence(runId),
            }), close: () => db.close(),
        });
    } catch (error) { db.close(); throw error; }
}

/** Recording may be off when retained forward-bound receipts first need a central archive. */
export function hasRetainedMaintenanceSummaryEvidence(path: string, rawSessionId: string): boolean {
    const source = openMaintenanceSummaryEvidenceSource(path, rawSessionId);
    if (!source) return false;
    try { return source.hasEvidenceBindings(); }
    finally { source.close(); }
}
