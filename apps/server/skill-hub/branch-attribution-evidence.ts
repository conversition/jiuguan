/** Archive original low-confidence inference receipts only; recovery grants no preference adoption or execution. */
import { createAgentEvidenceBranchAttributionRecord, type AgentEvidenceBranchAttributionRecordV1 } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { readBranchPreferenceSkillSourceFile } from '../branch-preference-source-recovery.ts';
import type { BranchPreferenceSkillSourceEntry } from '../../../packages/memory/public/branch-preference-skill-source.ts';
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
export function branchAttributionEvidenceRecord(rawSessionId: string, entry: BranchPreferenceSkillSourceEntry): AgentEvidenceBranchAttributionRecordV1 {
    if (entry.rawSessionId !== rawSessionId || entry.proof.source.sessionId !== opaqueLearningToken('session', rawSessionId))
        throw new Error('branch-evidence-session-mismatch');
    return createAgentEvidenceBranchAttributionRecord({
        recordVersion: 'agent-evidence-branch-attribution-v1', eventType: 'branch-attribution-recorded',
        sessionId: entry.proof.source.sessionId, contentMode: entry.proof.source.contentMode, capabilityId: 'learning.branchPreference',
        sourceType: entry.version, sourceRef: `branch-attribution:${sha256Digest(JSON.stringify([entry.learningEvent.eventId]))}`,
        sourceDigest: entry.packetDigest, artifactDigest: entry.proof.outputDigest, requestDigest: entry.proof.requestDigest,
        producerRunId: opaqueLearningToken('run', entry.proof.source.runId), round: entry.proof.source.round,
        occurredAt: entry.committedAt, attributionKind: 'skill', manifestDigests: [...entry.proof.attribution.selectedManifestDigests].sort(),
        candidateDigests: [...entry.proof.attribution.activeCandidateDigests].sort(), executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
        adoption: 'not-applicable', authorizesExecution: false, authorizesPromotion: false,
    });
}
/** Scan the original read-only outbox; mutable delivery/invalidation state is excluded from immutable history. */
export function readBranchAttributionEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('branch-evidence-page-invalid');
    const allowed = permission(input);
    const page = readBranchPreferenceSkillSourceFile({ ...input, allowed, limit, cursor });
    if (!page || !allowed(input.rawSessionId)) return null;
    if (page.failed !== 0) throw new Error('branch-evidence-source-corrupt');
    return Object.freeze({ records: Object.freeze(page.entries.map(entry => branchAttributionEvidenceRecord(input.rawSessionId, entry))),
        attempted: page.attempted, nextCursor: page.nextCursor, hasMore: page.hasMore });
}

export function reconcileBranchAttributionEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('branch-evidence-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, PAGE_SIZE);
    let attempted = 0, delivered = 0, skipped = 0;
    const failed = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readBranchAttributionEvidenceFile({ ...input, allowed, limit, cursor });
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
export function hasRetainedBranchAttributionEvidence(path: string, rawSessionId: string): boolean {
    const page = readBranchAttributionEvidenceFile({ path, rawSessionId, allowed: () => true });
    return page !== null && page.records.length > 0;
}
export function createBranchAttributionEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcileBranchAttributionEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
