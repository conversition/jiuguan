/** Archive original advisory receipts only; recovery grants no execution or story adoption. */
import { createAgentEvidenceAqlAdvisoryRecord, type AgentEvidenceAqlAdvisoryRecordV1 } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { normalizeAqlReplanSkillSourceReceipt, readAqlReplanSkillSourceFile,
    type AqlReplanSkillSourceReceipt } from '../aql-replan-skill-source.ts';
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
export function aqlAdvisoryEvidenceRecord(rawSessionId: string, value: AqlReplanSkillSourceReceipt): AgentEvidenceAqlAdvisoryRecordV1 {
    const receipt = normalizeAqlReplanSkillSourceReceipt(value);
    if (receipt.source.sessionId !== opaqueLearningToken('session', rawSessionId)) throw new Error('aql-evidence-session-mismatch');
    return createAgentEvidenceAqlAdvisoryRecord({
        recordVersion: 'agent-evidence-aql-advisory-v1', eventType: 'aql-advisory-recorded',
        sessionId: receipt.source.sessionId, contentMode: receipt.source.contentMode, capabilityId: 'interactive.aqlReplan',
        sourceType: receipt.version, sourceRef: `aql-advisory:${sha256Digest(JSON.stringify([receipt.source.runId]))}`,
        sourceDigest: receipt.receiptDigest, artifactDigest: receipt.proof.outputDigest, requestDigest: receipt.proof.requestDigest,
        producerRunId: opaqueLearningToken('run', receipt.source.runId), round: receipt.source.round,
        occurredAt: receipt.observedAt, attributionKind: 'skill', manifestDigests: [...receipt.proof.attribution.selectedManifestDigests],
        candidateDigests: [], executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
        adoption: 'not-applicable', authorizesExecution: false, authorizesPromotion: false,
    });
}

/** The report reader counts corrupt rows; central delivery must reject the whole page before append. */
export function readAqlAdvisoryEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('aql-evidence-page-invalid');
    const allowed = permission(input);
    const page = readAqlReplanSkillSourceFile({ ...input, allowed: () => allowed(input.rawSessionId), limit, cursor });
    if (!page || !allowed(input.rawSessionId)) return null;
    if (page.failed !== 0) throw new Error('aql-evidence-source-corrupt');
    return Object.freeze({ records: Object.freeze(page.entries.map(({ receipt }) => aqlAdvisoryEvidenceRecord(input.rawSessionId, receipt))),
        attempted: page.attempted, nextCursor: page.nextCursor, hasMore: page.hasMore });
}

export function reconcileAqlAdvisoryEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('aql-evidence-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, PAGE_SIZE);
    let attempted = 0, delivered = 0, skipped = 0;
    const failed = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readAqlAdvisoryEvidenceFile({ ...input, allowed, limit, cursor });
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
export function hasRetainedAqlAdvisoryEvidence(path: string, rawSessionId: string): boolean {
    const page = readAqlAdvisoryEvidenceFile({ path, rawSessionId, allowed: () => true });
    return page !== null && page.records.length > 0;
}
export function createAqlAdvisoryEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcileAqlAdvisoryEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
