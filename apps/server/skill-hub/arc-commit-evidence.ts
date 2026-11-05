/** Original Skill-backed Arc commits, independent of approval state and downstream consumption. */
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentEvidenceArcCommitRecord } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { ArcMaintenanceCommitter, type ArcMaintenanceCommitRequest } from '../arc-maintenance-committer.ts';
import { ARC_PROJECTION_DB_FILE, type ArcProjectionStore } from '../arc-projection-store.ts';
import { MAINTENANCE_JOB_DB_FILE, type MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { maintenanceArcSkillDigest } from './maintenance-arc-proposal-proof.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

type Sources = { readonly manager: Pick<MaintenanceJobManager, 'readArcCommitSource' | 'scanArcCommitSources'>;
    readonly arcStore: ArcProjectionStore };
export function readArcCommitEvidence(input: Sources, rawSessionId: string, runId: string) {
    const original = input.manager.readArcCommitSource(runId);
    if (!original) return null;
    const { source, proposal } = original, record = source.record, proof = record.proof;
    if (record.sessionId !== rawSessionId || proposal.sessionId !== rawSessionId || record.jobRunId !== runId)
        throw new Error('arc-evidence-session-mismatch');
    const native = new ArcMaintenanceCommitter(input.arcStore, () => { throw new Error('arc-evidence-no-current-authority'); })
        .readCommitEvidence({ runId, proposal: proposal.proposal.payload,
            context: proposal.context as ArcMaintenanceCommitRequest['context'], provenanceDigest: proposal.proposalDigest });
    if (!native) {
        if (proposal.status === 'applied') throw new Error('arc-evidence-native-unavailable');
        return null;
    }
    if (!['pending', 'applied'].includes(proposal.status) || native.committedAt < record.proposalCreatedAt)
        throw new Error('arc-evidence-native-conflict');
    if (proposal.status === 'applied' && (!proposal.receipt
        || !isDeepStrictEqual({ ...proposal.receipt, deduped: true }, native.receipt)))
        throw new Error('arc-evidence-approval-receipt-mismatch');
    const { deduped: _readObservation, ...committed } = native.receipt;
    return createAgentEvidenceArcCommitRecord({
        recordVersion: 'agent-evidence-arc-commit-v1', eventType: 'arc-projection-committed',
        sessionId: opaqueLearningToken('session', rawSessionId), contentMode: proof.contentMode,
        capabilityId: 'maintenance.arc', sourceType: 'maintenance-arc-skill-source-v1',
        sourceRef: `arc-commit:${sha256Digest(runId)}`, sourceDigest: record.recordDigest,
        artifactDigest: native.receipt.projection.projectionDigest, commitReceiptDigest: maintenanceArcSkillDigest(committed),
        producerRunId: opaqueLearningToken('run', runId), requestDigests: [...proof.requestDigests], occurredAt: native.committedAt,
        attributionKind: 'skill', manifestDigests: [...proof.attribution.selectedManifestDigests].sort(),
        candidateDigests: [...proof.attribution.activeCandidateDigests].sort(), executionClass: 'unknown',
        effectOutcome: 'unknown', learningWeight: 0,
    });
}
export function reconcileArcCommitEvidence(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
}, rawSessionId: string, limit = 8, cursor = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('arc-evidence-page-invalid');
    let denied = false, attempted = 0, delivered = 0, skipped = 0;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        if (!allowed()) return fail();
        const page = input.manager.scanArcCommitSources(rawSessionId, Math.min(limit, 8), cursor);
        attempted = page.attempted;
        for (const row of page.entries) {
            if (!allowed() || row.sessionId !== rawSessionId) return fail();
            const read = () => readArcCommitEvidence(input, rawSessionId, row.runId);
            const original = read();
            if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
            if (!original) { skipped++; continue; }
            const result = input.ledger.append(rawSessionId, original);
            if (result.status === 'discarded-deleted-session') { skipped++; return fail(); }
            if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
            delivered++;
        }
        if (!allowed() || !isDeepStrictEqual(page, input.manager.scanArcCommitSources(rawSessionId, Math.min(limit, 8), cursor))
            || !allowed()) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function createArcCommitEvidenceScheduler(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean; readonly onFailure?: () => void;
}) {
    const scheduler = createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (id, limit, cursor, allowed) => reconcileArcCommitEvidence({ ...input, allowed }, id, limit, cursor) });
    return Object.freeze({ ...scheduler, recoverRetained() {
        try {
            let cursor = 0;
            do {
                const page = input.manager.scanArcCommitSources(undefined, 8, cursor);
                for (const row of page.entries) scheduler.schedule(row.sessionId);
                if (!page.hasMore) break;
                if (page.nextCursor <= cursor) throw new Error('arc-evidence-cursor-invalid');
                cursor = page.nextCursor;
            } while (true);
        } catch { try { input.onFailure?.(); } catch { /* diagnostic only */ } }
    } });
}

/** Discovery only; the real Manager and Arc readers must validate the full source before archive. */
export function hasRetainedArcCommitEvidence(dataDir: string, isSessionDeleted: (id: string) => boolean): boolean {
    const paths = [join(dataDir, MAINTENANCE_JOB_DB_FILE), join(dataDir, ARC_PROJECTION_DB_FILE)];
    for (const path of paths) {
        if (!existsSync(path)) return false;
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('arc-evidence-discovery-file-invalid');
    }
    const manager = new DatabaseSync(paths[0]!, { readOnly: true });
    let arc: DatabaseSync | undefined;
    try {
        manager.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (!manager.prepare("SELECT 1 FROM sqlite_master WHERE name='maintenance_arc_skill_source'").get()) return false;
        arc = new DatabaseSync(paths[1]!, { readOnly: true }); arc.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        let cursor = 0;
        do {
            const rows = manager.prepare('SELECT rowid AS cursor,run_id,session_id FROM maintenance_arc_skill_source WHERE rowid>? ORDER BY rowid LIMIT 8')
                .all(cursor) as { cursor: number; run_id: string; session_id: string }[];
            for (const row of rows) {
                if (typeof row.session_id !== 'string' || typeof row.run_id !== 'string') throw new Error('arc-evidence-discovery-invalid');
                if (isSessionDeleted(row.session_id) === false
                    && arc.prepare('SELECT 1 FROM arc_projection_receipt WHERE run_id=? AND session_id=?').get(row.run_id, row.session_id)) return true;
            }
            if (rows.length < 8) return false;
            const next = rows.at(-1)!.cursor;
            if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('arc-evidence-cursor-invalid');
            cursor = next;
        } while (true);
    } finally { arc?.close(); manager.close(); }
}
