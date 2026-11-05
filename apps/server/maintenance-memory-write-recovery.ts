/** @author Codex @date 2026-10-14 @version 1.0
 * Open only existing Session metadata for recovery; never initialize ChatSession, assets or a Provider.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
    SCHEMA_VERSION,
    SESSION_STORAGE_PREDECESSOR_VERSION,
} from '../../packages/memory/public/schema.ts';
import { MaintenanceMemoryConsumptionOutbox }
    from '../../packages/memory/public/maintenance-memory-consumption-outbox.ts';
import { SummaryConsumptionOutbox } from '../../packages/memory/public/maintenance-summary-consumption-outbox.ts';
import { MaintenanceMemoryWriteJoinOutbox } from './maintenance-memory-write-join.ts';
import { MaintenanceSummaryWriteJoinOutbox } from './maintenance-summary-write-join.ts';
import { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import type { MemoryWriteRecoveryHandle } from './skill-hub/maintenance-memory-write-reconciler.ts';
import type { SummaryWriteRecoveryHandle } from './skill-hub/maintenance-summary-write-reconciler.ts';

function inspectRecoverySchema(database: DatabaseSync): 'current' | 'predecessor' {
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    const applicationId = database.prepare('PRAGMA application_id').get()?.application_id;
    const columns = database.prepare('PRAGMA table_info(session_control)').all() as {
        name: string; type: string; notnull: number; pk: number;
    }[];
    if (applicationId !== 0
        || JSON.stringify(columns.map((row) => [row.name, row.type, row.notnull, row.pk]))
        !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
        ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) {
        throw new Error('memory-write-recovery-schema-invalid');
    }
    if (version === SCHEMA_VERSION) return 'current';
    if (version === SESSION_STORAGE_PREDECESSOR_VERSION) return 'predecessor';
    throw new Error('memory-write-recovery-schema-invalid');
}

function assertRecoverySchema(database: DatabaseSync): void {
    if (inspectRecoverySchema(database) !== 'current') {
        throw new Error('memory-write-recovery-schema-invalid');
    }
}

function openMemoryRecoveryMetadata(
    path: string,
    sessionId: string,
    options: { readonly predecessorAsUnavailable?: boolean } = {},
) {
    if (!existsSync(path)) return null;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('memory-write-recovery-file-invalid');
    // First open read-only so a missing/unknown database cannot be initialized by a recovery scan.
    const inspect = new DatabaseSync(path, { readOnly: true });
    let opened: DatabaseSync | null = null;
    try {
        const schema = inspectRecoverySchema(inspect);
        // v16 is a supported immutable history format, but only the current
        // v17 owner may participate in consumption recovery. Startup scans
        // therefore treat an exact predecessor as unavailable without opening
        // it writable; unknown or malformed databases still fail closed.
        if (schema === 'predecessor' && options.predecessorAsUnavailable === true) return null;
        if (schema !== 'current') throw new Error('memory-write-recovery-schema-invalid');
        if (!existsSync(path)) return null;
        opened = new DatabaseSync(path);
        assertRecoverySchema(opened);
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino) {
            throw new Error('memory-write-recovery-file-drift');
        }
    } catch (error) {
        opened?.close();
        throw error;
    } finally { inspect.close(); }
    if (!opened) return null;
    const db = opened;
    const memory = {
        db,
        transaction<T>(work: () => T): T {
            if (db.isTransaction !== false) throw new Error('memory-write-recovery-outer-transaction');
            db.exec('BEGIN IMMEDIATE;');
            try {
                const result = work();
                db.exec('COMMIT;');
                return result;
            } catch (error) {
                const transactionStillOpen = (): boolean => db.isTransaction;
                if (transactionStillOpen() === true) db.exec('ROLLBACK;');
                throw error;
            }
        },
    };
    try {
        const committer = new MemorySummaryMaintenanceCommitter({ sessionId, memory }, () => {
            throw new Error('memory-write-recovery-current-revision-forbidden');
        });
        return Object.freeze({ db, memory, committer, close: () => db.close() });
    } catch (error) { db.close(); throw error; }
}

export function openMaintenanceMemoryWriteRecovery(path: string, sessionId: string): MemoryWriteRecoveryHandle | null {
    const opened = openMemoryRecoveryMetadata(path, sessionId);
    if (!opened) return null;
    try {
        return Object.freeze({
            committer: Object.freeze({
                readMemoryWriteEvidence: (runId: string) => opened.committer.readMemoryWriteEvidence(runId),
            }), outbox: new MaintenanceMemoryWriteJoinOutbox(opened.memory, sessionId), close: opened.close,
        });
    } catch (error) { opened.close(); throw error; }
}

/** Summary recovery cannot borrow Memory evidence or expose a live business writer. */
export function openMaintenanceSummaryWriteRecovery(path: string,
    sessionId: string): SummaryWriteRecoveryHandle | null {
    const opened = openMemoryRecoveryMetadata(path, sessionId);
    if (!opened) return null;
    try {
        return Object.freeze({
            committer: Object.freeze({
                readSummaryWriteEvidence: (runId: string) => opened.committer.readSummaryWriteEvidence(runId),
            }), outbox: new MaintenanceSummaryWriteJoinOutbox(opened.memory, sessionId), close: opened.close,
        });
    } catch (error) { opened.close(); throw error; }
}

/** The consumption adapter exposes only historical metadata readers, never the domain writer. */
export function openMaintenanceMemoryConsumptionRecovery(path: string, sessionId: string) {
    const opened = openMemoryRecoveryMetadata(path, sessionId, { predecessorAsUnavailable: true });
    if (!opened) return null;
    try {
        return Object.freeze({
            committer: Object.freeze({
                readMemoryWriteEvidence: (runId: string) => opened.committer.readMemoryWriteEvidence(runId),
            }), outbox: new MaintenanceMemoryConsumptionOutbox(opened.db, sessionId), close: opened.close,
        });
    } catch (error) { opened.close(); throw error; }
}

/** Summary delivery only replays persisted source/write/consumer metadata; no current projection repair. */
export function openMaintenanceSummaryConsumptionRecovery(path: string, sessionId: string) {
    const opened = openMemoryRecoveryMetadata(path, sessionId, { predecessorAsUnavailable: true });
    if (!opened) return null;
    try {
        return Object.freeze({
            committer: Object.freeze({
                readSummaryWriteEvidence: (runId: string) => opened.committer.readSummaryWriteEvidence(runId),
            }), outbox: new SummaryConsumptionOutbox(opened.db, sessionId), close: opened.close,
        });
    } catch (error) { opened.close(); throw error; }
}
