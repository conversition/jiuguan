/** @author Codex @date 2026-10-27 @version 1.0
 * Read-only recovery of applied variable patches. It restores history only: no replay, no re-apply,
 * no model call, and no authority to execute or promote.
 */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
    VariablePatchApplyEvidenceStore, VariablePatchApplyInvalidationStore,
    readLiteralVariableSnapshotDigest, variablePatchApplySessionDigest,
    type VariablePatchApplyEvidenceEntry, type VariablePatchApplyEvidenceScan,
    type VariablePatchApplyRollbackKind, type VariablePatchApplyInvalidationEntry,
} from '../../packages/memory/public/variable-patch-apply-evidence.ts';
import {
    VariableProposalSkillReceiptStore, type VariableProposalSkillReceiptScan,
} from '../../packages/memory/public/variable-proposal-skill-receipt.ts';
import {
    VariableProposalSkillAdoptionStore, type VariableProposalSkillAdoptionEntry,
} from '../../packages/memory/public/variable-proposal-skill-adoption.ts';
import { variableProposalSkillSessionDigest } from '../../packages/agent-policy/public/variable-proposal-skill.ts';
import { inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';

export type VariablePatchApplyState = 'current' | 'invalidated' | 'superseded' | 'unknown';

export interface VariablePatchApplyRecoveryEntry {
    readonly evidence: VariablePatchApplyEvidenceEntry;
    readonly skillAdoption: VariableProposalSkillAdoptionEntry | null;
    /** Compared against the authoritative whole-literal snapshot, never against a guess. */
    readonly state: VariablePatchApplyState;
    readonly currentSnapshotDigest: string | null;
    readonly rollbackObserved: boolean;
    /** A durable Session rollback marker outranks the derived snapshot state. */
    readonly persistentInvalidation: boolean;
    readonly rollbackKind: VariablePatchApplyRollbackKind | null;
}

export interface VariablePatchApplyRecoveryPage extends Omit<VariablePatchApplyEvidenceScan, 'entries'> {
    readonly version: 'variable-patch-apply-recovery-page-v1';
    readonly entries: readonly VariablePatchApplyRecoveryEntry[];
    readonly sessionDigest: string;
    readonly currentSnapshotDigest: string | null;
    readonly currentCount: number;
    readonly invalidatedCount: number;
    readonly supersededCount: number;
    readonly unknownCount: number;
    readonly persistentInvalidations: number;
    readonly invalidationsTruncated: boolean;
    readonly skillAdoptedCount: number;
    readonly skillAdoptionFailed: number;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
}

function classify(entry: VariablePatchApplyEvidenceEntry, current: string | null,
    rollbackKind: VariablePatchApplyRollbackKind | null): VariablePatchApplyState {
    if (rollbackKind !== null) return 'invalidated';
    if (current === null) return 'unknown';
    if (current === entry.postApplyDigest) return 'current';
    if (current === entry.preApplyDigest) return 'invalidated';
    return 'superseded';
}

function inspectVariableRecoverySchema(db: DatabaseSync): void {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
        || db.prepare('PRAGMA application_id').get()?.application_id !== 0)
        throw new Error('variable-patch-recovery-schema-invalid');
    inspectSessionAuthoritySchema(db);
    const columns = (db.prepare('PRAGMA table_info(session_control)').all() as {
        name: string; type: string; notnull: number; pk: number;
    }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
    if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
        ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]]))
        throw new Error('variable-patch-recovery-control-schema-invalid');
}

export interface VariablePatchInvalidationRecoveryEntry {
    readonly invalidation: VariablePatchApplyInvalidationEntry;
    readonly evidence: VariablePatchApplyEvidenceEntry;
    readonly skillAdoption: VariableProposalSkillAdoptionEntry | null;
}

/** Scan original rollback markers, retaining both kinds for one apply and their original times. */
export function readVariablePatchInvalidationEvidenceFile(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly limit?: number; readonly cursor?: number;
}) {
    const limit = input.limit ?? 8, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('variable-invalidation-page-invalid');
    let denied = false;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(input.rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('variable-invalidation-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        inspectVariableRecoverySchema(db);
        if (!allowed()) return null;
        const page = new VariablePatchApplyInvalidationStore(db, input.rawSessionId).scan({ limit, cursor });
        if (page.failed !== 0) throw new Error('variable-invalidation-source-corrupt');
        const applies = new VariablePatchApplyEvidenceStore(db, input.rawSessionId);
        const adoptions = new VariableProposalSkillAdoptionStore(db, input.rawSessionId);
        const entries: VariablePatchInvalidationRecoveryEntry[] = page.entries.map(invalidation => {
            const evidence = applies.get(invalidation.runId);
            if (!evidence || evidence.receiptDigest !== invalidation.evidenceReceiptDigest
                || evidence.round !== invalidation.round || evidence.sessionDigest !== invalidation.sessionDigest)
                throw new Error('variable-invalidation-apply-mismatch');
            // This reader verifies the original request/apply link; absent legacy links stay absent.
            const skillAdoption = adoptions.get(evidence.runId);
            return Object.freeze({ invalidation, evidence, skillAdoption });
        });
        db.exec('ROLLBACK;');
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino)
            throw new Error('variable-invalidation-file-drift');
        if (!allowed()) return null;
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.attempted,
            nextCursor: page.nextCursor, hasMore: page.hasMore });
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

/** History only. A receipt on disk cannot recover a live capture, a patch body or dispatch authority. */
export function readVariablePatchApplyEvidenceFile(input: {
    readonly path: string;
    readonly rawSessionId: string;
    readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number;
    readonly cursor?: number;
}): VariablePatchApplyRecoveryPage | null {
    const allowed = (): boolean => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('variable-patch-recovery-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        inspectVariableRecoverySchema(db);
        if (!allowed()) return null;
        const store = new VariablePatchApplyEvidenceStore(db, input.rawSessionId);
        const page = store.scan({ limit: input.limit, cursor: input.cursor });
        const currentSnapshotDigest = readLiteralVariableSnapshotDigest(db);
        // Exact keys avoid missing a relevant marker behind unrelated or truncated global pages.
        const invalidations = new VariablePatchApplyInvalidationStore(db, input.rawSessionId);
        const adoptions = new VariableProposalSkillAdoptionStore(db, input.rawSessionId);
        let skillAdoptionFailed = 0;
        const readAdoption = (runId: string): VariableProposalSkillAdoptionEntry | null => {
            try { return adoptions.get(runId); } catch { skillAdoptionFailed += 1; return null; }
        };
        const entries = page.entries.map((evidence) => {
            const rollbackKind = invalidations.findForEvidence(evidence)?.rollbackKind ?? null;
            const state = classify(evidence, currentSnapshotDigest, rollbackKind);
            return Object.freeze({ evidence, skillAdoption: readAdoption(evidence.runId), state, currentSnapshotDigest,
                // A matching pre-apply snapshot alone cannot prove a rollback occurred.
                rollbackObserved: rollbackKind !== null, persistentInvalidation: rollbackKind !== null,
                rollbackKind });
        });
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino) {
            throw new Error('variable-patch-recovery-file-drift');
        }
        if (!allowed()) return null;
        if (JSON.stringify(store.scan({ limit: input.limit, cursor: input.cursor })) !== JSON.stringify(page)) {
            throw new Error('variable-patch-recovery-read-drift');
        }
        if (!allowed()) return null;
        const firstAdoptionFailed = skillAdoptionFailed;
        const repeated = entries.map((entry) => readAdoption(entry.evidence.runId));
        if (JSON.stringify(repeated) !== JSON.stringify(entries.map((entry) => entry.skillAdoption))
            || skillAdoptionFailed !== firstAdoptionFailed * 2) {
            throw new Error('variable-patch-recovery-adoption-read-drift');
        }
        skillAdoptionFailed = firstAdoptionFailed;
        if (!allowed()) return null;
        const count = (state: VariablePatchApplyState): number =>
            entries.filter((entry) => entry.state === state).length;
        db.exec('ROLLBACK;');
        const closedSnapshot = lstatSync(input.path);
        if (!closedSnapshot.isFile() || closedSnapshot.isSymbolicLink()
            || closedSnapshot.dev !== file.dev || closedSnapshot.ino !== file.ino)
            throw new Error('variable-patch-recovery-file-drift');
        if (!allowed()) return null;
        return Object.freeze({ version: 'variable-patch-apply-recovery-page-v1', entries: Object.freeze(entries),
            sessionDigest: variablePatchApplySessionDigest(input.rawSessionId),
            attempted: page.attempted, failed: page.failed, nextCursor: page.nextCursor, hasMore: page.hasMore,
            currentSnapshotDigest, currentCount: count('current'), invalidatedCount: count('invalidated'),
            supersededCount: count('superseded'), unknownCount: count('unknown'),
            persistentInvalidations: entries.filter((entry) => entry.persistentInvalidation).length,
            invalidationsTruncated: false, skillAdoptedCount: entries.filter((entry) => entry.skillAdoption !== null).length,
            skillAdoptionFailed,
            authorizesExecution: false as const, authorizesPromotion: false as const });
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

/** Exact original application and every original rollback marker, from one read-only snapshot. */
export function readVariablePatchApplyWithInvalidations(input: {
    readonly path: string; readonly rawSessionId: string; readonly runId: string;
    readonly allowed: (rawSessionId: string) => boolean;
}): Readonly<{ evidence: VariablePatchApplyEvidenceEntry; skillAdoption: VariableProposalSkillAdoptionEntry | null;
    invalidations: readonly VariablePatchApplyInvalidationEntry[] }> | null {
    let denied = false;
    const allowed = () => { if (denied) return false; try { if (input.allowed(input.rawSessionId) === true) return true; } catch {} denied = true; return false; };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('variable-invalidation-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        inspectVariableRecoverySchema(db);
        if (!allowed()) return null;
        const evidence = new VariablePatchApplyEvidenceStore(db, input.rawSessionId).get(input.runId);
        if (!evidence) return null;
        const skillAdoption = new VariableProposalSkillAdoptionStore(db, input.rawSessionId).get(input.runId);
        const invalidations = new VariablePatchApplyInvalidationStore(db, input.rawSessionId).findAllForEvidence(evidence);
        db.exec('ROLLBACK;');
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino)
            throw new Error('variable-invalidation-file-drift');
        if (!allowed()) return null;
        return Object.freeze({ evidence, skillAdoption, invalidations });
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

/** Exact original run lookup, with source, adoption and current state read in one snapshot. */
export function readVariablePatchApplyEvidenceByRun(input: {
    readonly path: string; readonly rawSessionId: string; readonly runId: string;
    readonly allowed: (rawSessionId: string) => boolean;
}): VariablePatchApplyRecoveryEntry | null {
    let denied = false;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(input.rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('variable-patch-recovery-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        inspectVariableRecoverySchema(db);
        if (!allowed()) return null;
        const evidence = new VariablePatchApplyEvidenceStore(db, input.rawSessionId).get(input.runId);
        if (!evidence) return null;
        const skillAdoption = new VariableProposalSkillAdoptionStore(db, input.rawSessionId).get(input.runId);
        const rollbackKind = new VariablePatchApplyInvalidationStore(db, input.rawSessionId).findForEvidence(evidence)?.rollbackKind ?? null;
        const currentSnapshotDigest = readLiteralVariableSnapshotDigest(db);
        const result = Object.freeze({ evidence, skillAdoption, currentSnapshotDigest,
            state: classify(evidence, currentSnapshotDigest, rollbackKind), rollbackObserved: rollbackKind !== null,
            persistentInvalidation: rollbackKind !== null, rollbackKind });
        db.exec('ROLLBACK;');
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino)
            throw new Error('variable-patch-recovery-file-drift');
        if (!allowed()) return null;
        return result;
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

export interface VariableProposalSkillReceiptPage {
    readonly accepted: number;
    readonly failed: number;
    readonly hasMore: boolean;
    readonly nextCursor: number;
}

/**
 * Proposal-only Skill receipts: same read-only ladder as apply evidence. A row whose session
 * digest does not belong to this file's session is counted as a bad row, never trusted.
 */
export function readVariableProposalSkillReceiptFile(input: {
    readonly path: string;
    readonly rawSessionId: string;
    readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number;
    readonly cursor?: number;
}): VariableProposalSkillReceiptPage | null {
    const allowed = (): boolean => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('variable-proposal-recovery-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) {
            throw new Error('variable-proposal-recovery-schema-invalid');
        }
        inspectSessionAuthoritySchema(db);
        const columns = (db.prepare('PRAGMA table_info(session_control)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
            ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) {
            throw new Error('variable-proposal-recovery-control-schema-invalid');
        }
        if (!allowed()) return null;
        const store = new VariableProposalSkillReceiptStore(db, input.rawSessionId);
        const page: VariableProposalSkillReceiptScan = store.scan({ limit: input.limit, cursor: input.cursor });
        const expectedSession = variableProposalSkillSessionDigest(input.rawSessionId);
        const accepted = page.entries.filter((entry) => entry.sessionDigest === expectedSession).length;
        const failed = page.failed + (page.entries.length - accepted);
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino) {
            throw new Error('variable-proposal-recovery-file-drift');
        }
        if (!allowed()) return null;
        return Object.freeze({ accepted, failed, hasMore: page.hasMore, nextCursor: page.nextCursor });
    } finally { db.close(); }
}
