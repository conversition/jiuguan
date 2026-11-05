import { existsSync, lstatSync } from 'node:fs';
/** Original explicitly referenced branch submitted with changed input; no inferred edit time or quality. */
import { createAgentEvidenceBranchModifiedRecord, type AgentEvidenceBranchModifiedRecordV1 } from '@jiuguan/skill-hub';
import { normalizeLearningEvent, opaqueLearningToken, sha256Digest,
    type LearningEventRecord } from '../../../packages/memory/public/learning-outbox.ts';
import { openBranchSelectionEvidenceSource } from '../branch-selection-evidence-source.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export interface BranchSelectionEvidenceSource {
    scan(limit?: number, cursor?: number): Readonly<{
        entries: readonly LearningEventRecord[]; attempted: number; failed: number; nextCursor: number; hasMore: boolean;
    }>;
    read(eventId: string): LearningEventRecord | null;
    close(): void;
}
export function branchModifiedEvidenceRecord(event: LearningEventRecord): AgentEvidenceBranchModifiedRecordV1 | null {
    const source = normalizeLearningEvent(event);
    if (source.eventKind !== 'branch_exact_selected' || source.payloadDigest !== event.payloadDigest
        || event.deliveredAt !== null && (typeof event.deliveredAt !== 'string'
            || !Number.isFinite(Date.parse(event.deliveredAt)) || new Date(event.deliveredAt).toISOString() !== event.deliveredAt))
        throw new Error('branch-modified-source-invalid');
    const features = source.features;
    if (features.selectionSource === undefined || features.inputEditedFromSelection === undefined) return null;
    if (!['explicit-click', 'exact-text', 'semantic'].includes(String(features.selectionSource))
        || typeof features.inputEditedFromSelection !== 'boolean') throw new Error('branch-modified-selection-invalid');
    if (features.selectionSource !== 'explicit-click' || features.inputEditedFromSelection === false) return null;
    const count = features.branchCount, index = features.selectedIndex, exposureRound = features.exposureRound;
    if (features.matchConfidence !== 'explicit' || source.round < 2 || source.userMessageId === null || source.assistantMessageId === null
        || source.sourceRevision !== `round-${source.round}-assistant-${source.assistantMessageId}`
        || !Number.isSafeInteger(count) || Number(count) < 1 || !Number.isSafeInteger(index)
        || Number(index) < 0 || Number(index) >= Number(count) || exposureRound !== source.round - 1)
        throw new Error('branch-modified-binding-invalid');
    const { deliveredAt: _acknowledgement, ...packet } = source;
    return createAgentEvidenceBranchModifiedRecord({
        recordVersion: 'agent-evidence-branch-modified-v1', eventType: 'branch-selection-modified-submitted',
        sessionId: source.sessionId, cardId: source.cardId, contentMode: source.contentMode,
        sourceType: 'session-branch-selection-v1', sourceRef: source.eventId,
        sourceDigest: sha256Digest(JSON.stringify(packet)), artifactDigest: source.subjectDigest,
        producerRunId: source.runId, round: source.round, occurredAt: source.createdAt,
        attributionKind: 'unattributed', manifestDigests: [], candidateDigests: [],
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}
type Input = { readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean };
function permission(input: Pick<Input, 'rawSessionId' | 'allowed'>) {
    let denied = false;
    return (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
}
export function readBranchModifiedEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? 8, cursor = input.cursor ?? 0, allowed = permission(input);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('branch-modified-page-invalid');
    if (!allowed(input.rawSessionId) || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('branch-modified-file-invalid');
    const source = openBranchSelectionEvidenceSource(input.path, input.rawSessionId);
    if (!source) return null;
    try {
        if (!allowed(input.rawSessionId)) return null;
        const page = source.scan(limit, cursor);
        if (page.failed !== 0) throw new Error('branch-modified-source-corrupt');
        const records: AgentEvidenceBranchModifiedRecordV1[] = [];
        for (const event of page.entries) {
            if (event.sessionId !== opaqueLearningToken('session', input.rawSessionId)) throw new Error('branch-modified-session-mismatch');
            const record = branchModifiedEvidenceRecord(event);
            if (record) records.push(record);
        }
        const tail = lstatSync(input.path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.dev !== file.dev || tail.ino !== file.ino)
            throw new Error('branch-modified-file-drift');
        if (!allowed(input.rawSessionId)) return null;
        return Object.freeze({ records: Object.freeze(records), attempted: page.attempted, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } finally { source.close(); }
}
export function reconcileBranchModifiedEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? 8, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('branch-modified-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, 8);
    let attempted = 0, delivered = 0, skipped = 0;
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readBranchModifiedEvidenceFile({ ...input, allowed, limit, cursor });
        const page = read();
        if (!page) return fail();
        attempted = page.attempted;
        const same = () => { const current = read(); return current !== null && JSON.stringify(current) === JSON.stringify(page); };
        for (const record of page.records) {
            if (!same() || !allowed(input.rawSessionId)) return fail();
            if (input.ledger.append(input.rawSessionId, record).status === 'discarded-deleted-session') { skipped++; return fail(); }
            if (!same() || !allowed(input.rawSessionId)) return fail();
            delivered++;
        }
        if (!same() || !allowed(input.rawSessionId)) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function hasRetainedBranchModifiedEvidence(path: string, rawSessionId: string): boolean {
    let cursor = 0;
    do {
        const page = readBranchModifiedEvidenceFile({ path, rawSessionId, allowed: () => true, cursor });
        if (!page) return false;
        if (page.records.length) return true;
        if (!page.hasMore) return false;
        if (page.nextCursor <= cursor) throw new Error('branch-modified-cursor-invalid');
        cursor = page.nextCursor;
    } while (true);
}
export function createBranchModifiedEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcileBranchModifiedEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
