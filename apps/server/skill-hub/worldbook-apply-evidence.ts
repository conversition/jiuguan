/** Original Worldbook control application history; never replay assets or infer current validity. */
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentEvidenceWorldbookApplyRecord } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { WORLDBOOK_REPAIR_DB_FILE, inspectWorldbookRepairSchema, type WorldbookRepairControl } from '../worldbook-repair-control.ts';
import { WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE } from '../worldbook-repair-apply-receipt.ts';
import { MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE } from '../maintenance-worldbook-skill-source.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

type Sources = { readonly control: Pick<WorldbookRepairControl, 'readSkillApplyEvidence' | 'scanSkillApplyEvidence'> };
export function readWorldbookApplyEvidence(input: Sources, rawSessionId: string, proposalId: string) {
    const original = input.control.readSkillApplyEvidence(proposalId);
    if (!original) return null;
    const { source, receipt } = original, record = source.record, proof = record.proof;
    if (record.sessionId !== rawSessionId || receipt.sessionId !== rawSessionId || receipt.proposalId !== proposalId)
        throw new Error('worldbook-evidence-session-mismatch');
    return createAgentEvidenceWorldbookApplyRecord({
        recordVersion: 'agent-evidence-worldbook-apply-v1', eventType: 'worldbook-repair-applied',
        sessionId: opaqueLearningToken('session', rawSessionId), contentMode: proof.contentMode,
        capabilityId: 'maintenance.worldbook', sourceType: 'maintenance-worldbook-skill-source-v1',
        sourceRef: `worldbook-apply:${sha256Digest(record.operationId)}`, sourceDigest: record.recordDigest,
        artifactDigest: receipt.artifactDigest, commitReceiptDigest: receipt.receiptDigest,
        producerRunId: opaqueLearningToken('run', proof.runId), requestDigests: [...proof.requestDigests], occurredAt: receipt.appliedAt,
        attributionKind: 'skill', manifestDigests: [...proof.attribution.selectedManifestDigests].sort(),
        candidateDigests: [...proof.attribution.activeCandidateDigests].sort(), executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}
export function reconcileWorldbookApplyEvidence(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
}, rawSessionId: string, limit = 8, cursor = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('worldbook-evidence-page-invalid');
    let denied = false, attempted = 0, delivered = 0, skipped = 0;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        if (!allowed()) return fail();
        const page = input.control.scanSkillApplyEvidence(rawSessionId, Math.min(limit, 8), cursor);
        attempted = page.attempted;
        for (const row of page.entries) {
            if (!allowed() || row.sessionId !== rawSessionId) return fail();
            const read = () => readWorldbookApplyEvidence(input, rawSessionId, row.proposalId);
            const original = read();
            if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
            if (!original) { skipped++; continue; }
            const result = input.ledger.append(rawSessionId, original);
            if (result.status === 'discarded-deleted-session') { skipped++; return fail(); }
            if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
            delivered++;
        }
        if (!allowed() || !isDeepStrictEqual(page, input.control.scanSkillApplyEvidence(rawSessionId, Math.min(limit, 8), cursor))
            || !allowed()) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function createWorldbookApplyEvidenceScheduler(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean; readonly onFailure?: () => void;
}) {
    const scheduler = createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (id, limit, cursor, allowed) => reconcileWorldbookApplyEvidence({ ...input, allowed }, id, limit, cursor) });
    return Object.freeze({ ...scheduler, recoverRetained() {
        try {
            let cursor = 0;
            do {
                const page = input.control.scanSkillApplyEvidence(undefined, 8, cursor);
                for (const row of page.entries) scheduler.schedule(row.sessionId);
                if (!page.hasMore) break;
                if (page.nextCursor <= cursor) throw new Error('worldbook-evidence-cursor-invalid');
                cursor = page.nextCursor;
            } while (true);
        } catch { try { input.onFailure?.(); } catch { /* diagnostic only */ } }
    } });
}


/** Query-only discovery. The owner validates each retained receipt before central archive. */
export function hasRetainedWorldbookApplyEvidence(dataDir: string, isSessionDeleted: (id: string) => boolean): boolean {
    const path = join(dataDir, WORLDBOOK_REPAIR_DB_FILE);
    if (!existsSync(path)) return false;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('worldbook-evidence-discovery-file-invalid');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN;');
        inspectWorldbookRepairSchema(db);
        if (![WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE, MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE]
            .every(name => db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))) return false;
        let cursor = 0;
        do {
            const rows = db.prepare(`SELECT r.rowid AS cursor,r.session_id FROM worldbook_repair_apply_receipt r
                JOIN maintenance_worldbook_skill_source s ON s.proposal_id=r.proposal_id AND s.session_id=r.session_id
                WHERE r.rowid>? ORDER BY r.rowid LIMIT 8`).all(cursor);
            for (const row of rows) {
                if (typeof row.session_id !== 'string') throw new Error('worldbook-evidence-discovery-invalid');
                if (isSessionDeleted(row.session_id) === false) return true;
            }
            if (rows.length < 8) return false;
            const next = rows.at(-1)!.cursor;
            if (!Number.isSafeInteger(next) || Number(next) <= cursor) throw new Error('worldbook-evidence-cursor-invalid');
            cursor = Number(next);
        } while (true);
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}
