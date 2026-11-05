/** Archive only original accepted Scene Skill receipts; never replay curation or infer current permission. */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAgentEvidenceSceneConsumptionRecord, type AgentEvidenceSceneConsumptionRecordV1 } from '@jiuguan/skill-hub';
import { inspectSessionAuthoritySchema } from '../../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../../packages/memory/public/schema.ts';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { readNsfwSceneSkillReceipt } from '../../../packages/session/public/nsfw-scene-receipt-reader.ts';
import type { NsfwSceneSkillReceipt } from '../../../packages/session/public/nsfw-scene-skill.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

const PAGE_SIZE = 8;
type Input = { readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean };
function permission(input: Pick<Input, 'rawSessionId' | 'allowed'>) {
    let denied = false;
    return (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
}
export function nsfwSceneEvidenceRecord(rawSessionId: string, receipt: NsfwSceneSkillReceipt): AgentEvidenceSceneConsumptionRecordV1 {
    if (receipt.source.sessionId !== rawSessionId) throw new Error('scene-evidence-session-mismatch');
    return createAgentEvidenceSceneConsumptionRecord({
        recordVersion: 'agent-evidence-scene-consumption-v1', eventType: 'scene-skill-consumed',
        sessionId: opaqueLearningToken('session', rawSessionId), contentMode: 'nsfw', capabilityId: receipt.profileId,
        sourceType: 'nsfw-scene-skill-receipt-v1',
        sourceRef: `scene-use:${sha256Digest(JSON.stringify([receipt.source.runId, receipt.source.round]))}`,
        sourceDigest: receipt.receiptDigest, artifactDigest: receipt.artifactDigest, requestDigest: receipt.requestDigest,
        consumerRunId: opaqueLearningToken('run', receipt.source.runId), round: receipt.source.round,
        occurredAt: receipt.acceptedAt, attributionKind: 'skill', manifestDigests: [...receipt.selectedManifestDigests],
        candidateDigests: [], executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

/** Reads accepted history in one original Session snapshot. Missing rows never imply observed rollback. */
export function readNsfwSceneEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('scene-evidence-page-invalid');
    const allowed = permission(input);
    if (!allowed(input.rawSessionId) || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('scene-evidence-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) throw new Error('scene-evidence-schema-invalid');
        inspectSessionAuthoritySchema(db);
        if (!allowed(input.rawSessionId)) return null;
        const rows = db.prepare('SELECT round FROM round_ledger WHERE round>? ORDER BY round LIMIT ?')
            .all(cursor, limit + 1) as { round: number }[];
        const records: AgentEvidenceSceneConsumptionRecordV1[] = [];
        let nextCursor = cursor;
        for (const row of rows.slice(0, limit)) {
            if (!Number.isSafeInteger(row.round) || row.round <= nextCursor) throw new Error('scene-evidence-cursor-invalid');
            nextCursor = row.round;
            const receipt = readNsfwSceneSkillReceipt(db, input.rawSessionId, row.round);
            if (receipt) records.push(nsfwSceneEvidenceRecord(input.rawSessionId, receipt));
        }
        db.exec('ROLLBACK;');
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.ino !== file.ino || tail.dev !== file.dev)
            throw new Error('scene-evidence-file-drift');
        if (!allowed(input.rawSessionId)) return null;
        return Object.freeze({ records: Object.freeze(records), attempted: Math.min(rows.length, limit),
            nextCursor, hasMore: rows.length > limit });
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

export function reconcileNsfwSceneEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('scene-evidence-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, PAGE_SIZE);
    let attempted = 0, delivered = 0, skipped = 0;
    const failed = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readNsfwSceneEvidenceFile({ ...input, allowed, limit, cursor });
        const page = read();
        if (!page) return failed();
        attempted = page.attempted;
        const same = () => {
            const current = read();
            return current !== null && JSON.stringify(current) === JSON.stringify(page);
        };
        for (const record of page.records) {
            if (!same() || !allowed(input.rawSessionId)) return failed();
            const result = input.ledger.append(input.rawSessionId, record);
            if (result.status === 'discarded-deleted-session') { skipped++; return failed(); }
            if (!same() || !allowed(input.rawSessionId)) return failed();
            delivered++;
        }
        if (!same() || !allowed(input.rawSessionId)) return failed();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return failed(); }
}
export function hasRetainedNsfwSceneEvidence(path: string, rawSessionId: string): boolean {
    let cursor = 0;
    do {
        const page = readNsfwSceneEvidenceFile({ path, rawSessionId, allowed: () => true, cursor });
        if (!page) return false;
        if (page.records.length) return true;
        if (!page.hasMore) return false;
        cursor = page.nextCursor;
    } while (true);
}
export function createNsfwSceneEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcileNsfwSceneEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
