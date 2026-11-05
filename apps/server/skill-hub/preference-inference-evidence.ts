/** Archive original low-confidence inference receipts only; recovery grants no preference adoption or execution. */
import { createAgentEvidencePreferenceInferenceRecord, type AgentEvidencePreferenceInferenceRecordV1 } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../../packages/memory/public/schema.ts';
import { inspectSessionAuthoritySchema } from '../../../packages/memory/public/session-database.ts';
import { LearningPreferenceSkillSourceOutbox, type LearningPreferenceSkillSourceEntry }
    from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';
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
export function preferenceInferenceEvidenceRecord(rawSessionId: string, entry: LearningPreferenceSkillSourceEntry): AgentEvidencePreferenceInferenceRecordV1 {
    if (entry.rawSessionId !== rawSessionId || entry.proof.source.sessionId !== opaqueLearningToken('session', rawSessionId))
        throw new Error('preference-evidence-session-mismatch');
    return createAgentEvidencePreferenceInferenceRecord({
        recordVersion: 'agent-evidence-preference-inference-v1', eventType: 'preference-inference-recorded',
        sessionId: entry.proof.source.sessionId, contentMode: entry.proof.source.contentMode, capabilityId: 'learning.preference',
        sourceType: entry.version, sourceRef: `preference-inference:${sha256Digest(JSON.stringify([entry.learningEvent.eventId]))}`,
        sourceDigest: entry.packetDigest, artifactDigest: entry.proof.outputDigest, requestDigest: entry.proof.requestDigest,
        producerRunId: opaqueLearningToken('run', entry.proof.source.runId), round: entry.proof.source.round,
        occurredAt: entry.committedAt, attributionKind: 'skill', manifestDigests: [...entry.proof.attribution.selectedManifestDigests].sort(),
        candidateDigests: [...entry.proof.attribution.activeCandidateDigests].sort(), executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
        adoption: 'not-applicable', authorizesExecution: false, authorizesPromotion: false,
    });
}
/** Scan the original read-only outbox; mutable delivery/invalidation state is excluded from immutable history. */
export function readPreferenceInferenceEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('preference-evidence-page-invalid');
    const allowed = permission(input);
    if (!allowed(input.rawSessionId) || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('preference-evidence-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) throw new Error('preference-evidence-schema-invalid');
        inspectSessionAuthoritySchema(db);
        if (!allowed(input.rawSessionId)) return null;
        const page = new LearningPreferenceSkillSourceOutbox(db, input.rawSessionId).scan(limit, cursor);
        if (page.failed !== 0) throw new Error('preference-evidence-source-corrupt');
        const records = page.entries.map(entry => preferenceInferenceEvidenceRecord(input.rawSessionId, entry));
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.ino !== file.ino || tail.dev !== file.dev)
            throw new Error('preference-evidence-file-drift');
        if (!allowed(input.rawSessionId)) return null;
        return Object.freeze({ records: Object.freeze(records), attempted: page.attempted,
            nextCursor: page.hasMore ? page.nextCursor : cursor, hasMore: page.hasMore });
    } finally { db.close(); }
}

export function reconcilePreferenceInferenceEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('preference-evidence-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, PAGE_SIZE);
    let attempted = 0, delivered = 0, skipped = 0;
    const failed = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readPreferenceInferenceEvidenceFile({ ...input, allowed, limit, cursor });
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
export function hasRetainedPreferenceInferenceEvidence(path: string, rawSessionId: string): boolean {
    const page = readPreferenceInferenceEvidenceFile({ path, rawSessionId, allowed: () => true });
    return page !== null && page.records.length > 0;
}
export function createPreferenceInferenceEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcilePreferenceInferenceEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
