import type { DatabaseSync } from 'node:sqlite';

/** Shared synchronous transaction boundary; domain stores retain their own CAS and permissions. */
export function sqliteTransaction<T>(db: DatabaseSync, work: () => T,
    write = true, prefix = 'sqlite'): T {
    if (db.isTransaction) throw new Error(`${prefix}-nested-transaction`);
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
        const result = work();
        if (!db.isTransaction) throw new Error(`${prefix}-transaction-lost`);
        db.exec('COMMIT');
        return result;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
