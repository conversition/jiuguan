/** Archive an original durable rollback of an existing Skill-linked apply; never infer from current values. */
import { agentEvidenceRecordDigest, createAgentEvidenceVariableInvalidationRecord,
    type AgentEvidenceVariableInvalidationRecordV1 } from '@jiuguan/skill-hub';
import { readVariablePatchInvalidationEvidenceFile, type VariablePatchInvalidationRecoveryEntry }
    from '../variable-patch-apply-recovery.ts';
import { variableApplyEvidenceRecord } from './variable-apply-evidence.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export function variableInvalidationEvidenceRecord(rawSessionId: string,
    entry: VariablePatchInvalidationRecoveryEntry): AgentEvidenceVariableInvalidationRecordV1 | null {
    const applied = variableApplyEvidenceRecord(rawSessionId, entry);
    if (!applied) return null;
    const marker = entry.invalidation;
    if (marker.sessionDigest !== entry.evidence.sessionDigest || marker.runId !== entry.evidence.runId
        || marker.round !== applied.round || marker.evidenceReceiptDigest !== applied.applyReceiptDigest)
        throw new Error('variable-invalidation-binding-invalid');
    return createAgentEvidenceVariableInvalidationRecord({
        recordVersion: 'agent-evidence-variable-invalidation-v1', eventType: 'variable-patch-invalidated',
        sessionId: applied.sessionId, sourceType: 'variable-patch-apply-invalidation-v1',
        sourceRef: marker.controlKey, sourceDigest: marker.invalidationDigest, artifactDigest: applied.artifactDigest,
        appliedEvidenceId: applied.evidenceId, appliedRecordDigest: agentEvidenceRecordDigest(applied),
        applyReceiptDigest: applied.applyReceiptDigest, rollbackKind: marker.rollbackKind,
        producerRunId: applied.producerRunId, round: applied.round, occurredAt: marker.occurredAt,
        attributionKind: 'unattributed', manifestDigests: [], candidateDigests: [],
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}
type Input = { readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean };
export function reconcileVariableInvalidationEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? 8, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('variable-invalidation-page-invalid');
    let denied = false;
    const allowed = (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    let attempted = 0, delivered = 0, skipped = 0;
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readVariablePatchInvalidationEvidenceFile({ ...input, allowed, limit: Math.min(requested, 8), cursor });
        const page = read();
        if (!page) return fail();
        attempted = page.attempted;
        const same = () => { const current = read(); return current !== null && JSON.stringify(current) === JSON.stringify(page); };
        for (const entry of page.entries) {
            const record = variableInvalidationEvidenceRecord(input.rawSessionId, entry);
            if (!record) { skipped++; continue; }
            if (!same() || !allowed(input.rawSessionId)) return fail();
            if (input.ledger.append(input.rawSessionId, record).status === 'discarded-deleted-session') { skipped++; return fail(); }
            if (!same() || !allowed(input.rawSessionId)) return fail();
            delivered++;
        }
        if (!same() || !allowed(input.rawSessionId)) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function hasRetainedVariableInvalidationEvidence(path: string, rawSessionId: string): boolean {
    let cursor = 0;
    do {
        const page = readVariablePatchInvalidationEvidenceFile({ path, rawSessionId, allowed: () => true, cursor });
        if (!page) return false;
        if (page.entries.some(entry => variableInvalidationEvidenceRecord(rawSessionId, entry) !== null)) return true;
        if (!page.hasMore) return false;
        if (page.nextCursor <= cursor) throw new Error('variable-invalidation-cursor-invalid');
        cursor = page.nextCursor;
    } while (true);
}
export function createVariableInvalidationEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            const failure = { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!allowed(rawSessionId)) return failure;
            const path = input.resolvePath(rawSessionId);
            if (!path || !allowed(rawSessionId)) return failure;
            return reconcileVariableInvalidationEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
