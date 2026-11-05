/** Archive the original Skill-linked variable application, never context consumption or quality. */
import { agentEvidenceRecordDigest, createAgentEvidenceVariableApplyRecord, type AgentEvidenceVariableApplyRecordV1 } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { readVariablePatchApplyEvidenceFile, readVariablePatchApplyEvidenceByRun, type VariablePatchApplyRecoveryEntry,
    type VariablePatchApplyState }
    from '../variable-patch-apply-recovery.ts';
import type { AgentEvidenceLedger, StoredAgentEvidenceRecord } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

// Each candidate is re-read around the archive write; cap the underlying page to bound synchronous work.
const VARIABLE_APPLY_EVIDENCE_PAGE_SIZE = 8;

export function variableApplyEvidenceRecord(rawSessionId: string,
    entry: Pick<VariablePatchApplyRecoveryEntry, 'evidence' | 'skillAdoption'>): AgentEvidenceVariableApplyRecordV1 | null {
    const adoption = entry.skillAdoption;
    if (!adoption) return null;
    if (adoption.runId !== entry.evidence.runId || adoption.round !== entry.evidence.round
        || adoption.applyReceiptDigest !== entry.evidence.receiptDigest
        || adoption.patchDigest !== entry.evidence.patchDigest || adoption.occurredAt !== entry.evidence.occurredAt)
        throw new Error('variable-apply-evidence-link-invalid');
    return createAgentEvidenceVariableApplyRecord({
        recordVersion: 'agent-evidence-variable-apply-v1', eventType: 'variable-patch-applied',
        sessionId: opaqueLearningToken('session', rawSessionId), sourceType: 'variable-proposal-skill-adoption-v1',
        sourceRef: `variable-adoption:${sha256Digest(adoption.runId)}`, sourceDigest: adoption.receiptDigest,
        artifactDigest: adoption.patchDigest, requestReceiptDigest: adoption.requestReceiptDigest,
        applyReceiptDigest: adoption.applyReceiptDigest, producerRunId: opaqueLearningToken('run', adoption.runId),
        round: adoption.round, occurredAt: adoption.occurredAt, attributionKind: 'unattributed',
        manifestDigests: [], candidateDigests: [], executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

export interface VariableApplyEvidenceProjection {
    readonly stored: StoredAgentEvidenceRecord;
    readonly state: VariablePatchApplyState | 'unavailable';
    readonly rollbackObserved: boolean | null;
}
export interface VariableApplyEvidencePage {
    readonly version: 'variable-apply-evidence-page-v1';
    readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
        state: VariablePatchApplyState | 'unavailable'; rollbackObserved: boolean | null }>[];
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

/** A historical commit remains historical; current state comes from the exact native receipt. */
export function readVariableApplyEvidence(input: {
    readonly path: string; readonly rawSessionId: string; readonly evidenceId: string;
    readonly allowed: (id: string) => boolean; readonly ledger: Pick<AgentEvidenceLedger, 'get'>;
}): VariableApplyEvidenceProjection | null {
    let denied = false;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(input.rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed()) return null;
    let stored: StoredAgentEvidenceRecord | null;
    try {
        stored = input.ledger.get(input.evidenceId);
        if (!stored || stored.record.evidenceId !== input.evidenceId
            || stored.record.sessionId !== opaqueLearningToken('session', input.rawSessionId)) return null;
    } catch { return null; }
    let projection: VariableApplyEvidenceProjection = Object.freeze({ stored, state: 'unavailable', rollbackObserved: null });
    try {
        const record = stored.record;
        if (record.eventType === 'variable-patch-applied' && record.sourceType === 'variable-proposal-skill-adoption-v1') {
            const read = () => readVariablePatchApplyEvidenceByRun({ path: input.path, rawSessionId: input.rawSessionId,
                runId: record.producerRunId, allowed: () => allowed() });
            const first = read();
            if (!allowed()) return null;
            const original = first && variableApplyEvidenceRecord(input.rawSessionId, first);
            if (first && original && agentEvidenceRecordDigest(original) === stored.recordDigest
                && JSON.stringify(original) === JSON.stringify(record)) {
                const second = read();
                if (!allowed()) return null;
                if (second && JSON.stringify(first) === JSON.stringify(second))
                    projection = Object.freeze({ stored, state: first.state, rollbackObserved: first.rollbackObserved });
            }
        }
    } catch { if (!allowed()) return null; }
    try {
        if (!allowed()) return null;
        const current = input.ledger.get(input.evidenceId);
        if (!current || current.record.evidenceId !== stored.record.evidenceId || current.recordDigest !== stored.recordDigest
            || current.ingestedAt !== stored.ingestedAt || current.sourceStatus !== stored.sourceStatus
            || JSON.stringify(current.record) !== JSON.stringify(stored.record)) return null;
        if (!allowed()) return null;
        return projection;
    } catch { return null; }
}

/** Bounded operator metadata only; Ledger cursor counts all evidence types. */
export function readVariableApplyEvidencePage(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly ledger: Pick<AgentEvidenceLedger, 'get' | 'list'>; readonly limit: number; readonly cursor: number;
}): VariableApplyEvidencePage | null {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10
        || !Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('variable-evidence-page-invalid');
    let denied = false;
    const allowed = (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed(input.rawSessionId)) return null;
    const page = input.ledger.list({ rawSessionId: input.rawSessionId, limit: input.limit, cursor: input.cursor });
    if (!allowed(input.rawSessionId)) return null;
    if (page.failed !== 0) throw new Error('variable-evidence-ledger-unavailable');
    const entries: VariableApplyEvidencePage['entries'][number][] = [];
    for (const stored of page.records) {
        if (stored.record.eventType !== 'variable-patch-applied' || stored.record.sourceType !== 'variable-proposal-skill-adoption-v1') continue;
        const projection = readVariableApplyEvidence({ path: input.path, rawSessionId: input.rawSessionId,
            evidenceId: stored.record.evidenceId, allowed, ledger: input.ledger });
        if (!projection || projection.stored.recordDigest !== stored.recordDigest || projection.stored.ingestedAt !== stored.ingestedAt) return null;
        entries.push(Object.freeze({ evidenceId: stored.record.evidenceId, occurredAt: stored.record.occurredAt,
            state: projection.state, rollbackObserved: projection.rollbackObserved }));
    }
    if (!allowed(input.rawSessionId)) return null;
    for (const stored of page.records) {
        const current = input.ledger.get(stored.record.evidenceId);
        if (!current || JSON.stringify(current) !== JSON.stringify(stored)) return null;
    }
    const currentPage = input.ledger.list({ rawSessionId: input.rawSessionId, limit: input.limit, cursor: input.cursor });
    if (JSON.stringify(currentPage) !== JSON.stringify(page)) return null;
    if (!allowed(input.rawSessionId)) return null;
    return Object.freeze({ version: 'variable-apply-evidence-page-v1', entries: Object.freeze(entries),
        nextCursor: page.nextCursor, hasMore: page.hasMore });
}

/** Re-read the exact original link around archive writes; never replay a patch or call a model. */
export function reconcileVariableApplyEvidence(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requestedLimit = input.limit ?? VARIABLE_APPLY_EVIDENCE_PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1
        || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('variable-apply-evidence-page-invalid');
    const limit = Math.min(requestedLimit, VARIABLE_APPLY_EVIDENCE_PAGE_SIZE);
    let denied = false;
    const allowed = (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    const read = () => readVariablePatchApplyEvidenceFile({ path: input.path, rawSessionId: input.rawSessionId,
        allowed, limit, cursor });
    const batch = read();
    if (!batch) return Object.freeze({ attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false });
    let delivered = 0, skipped = 0, failed = batch.failed + batch.skillAdoptionFailed;
    if (failed) return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed,
        nextCursor: cursor, hasMore: false });
    for (const entry of batch.entries) {
        try {
            if (!allowed(input.rawSessionId)) { skipped++; failed++; return Object.freeze({ attempted: batch.attempted,
                delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            const record = variableApplyEvidenceRecord(input.rawSessionId, entry);
            if (!record) { skipped++; continue; }
            const same = () => {
                const page = read();
                if (!page || page.failed || page.skillAdoptionFailed) return false;
                const matches = page.entries.filter((item) => item.skillAdoption?.receiptDigest === entry.skillAdoption?.receiptDigest);
                return matches.length === 1 && JSON.stringify(variableApplyEvidenceRecord(input.rawSessionId, matches[0]!)) === JSON.stringify(record);
            };
            if (!same()) throw new Error('variable-apply-evidence-source-drift');
            if (!allowed(input.rawSessionId)) { skipped++; failed++; return Object.freeze({ attempted: batch.attempted,
                delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            const result = input.ledger.append(input.rawSessionId, record);
            if (result.status === 'discarded-deleted-session') { skipped++; failed++; return Object.freeze({
                attempted: batch.attempted, delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            if (!same() || !allowed(input.rawSessionId)) throw new Error('variable-apply-evidence-post-append-drift');
            delivered++;
        } catch {
            failed++;
            return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed, nextCursor: cursor, hasMore: false });
        }
    }
    return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed, nextCursor: batch.nextCursor, hasMore: batch.hasMore });
}

export function hasRetainedVariableApplyEvidence(path: string, rawSessionId: string): boolean {
    let cursor = 0;
    do {
        const page = readVariablePatchApplyEvidenceFile({ path, rawSessionId, allowed: () => true,
            limit: VARIABLE_APPLY_EVIDENCE_PAGE_SIZE, cursor });
        if (!page) return false;
        if (page.failed || page.skillAdoptionFailed) throw new Error('variable-apply-evidence-source-invalid');
        if (page.entries.some((entry) => entry.skillAdoption !== null)) return true;
        if (!page.hasMore) return false;
        if (page.nextCursor <= cursor) throw new Error('variable-apply-evidence-cursor-invalid');
        cursor = page.nextCursor;
    } while (true);
}

export function createVariableApplyEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null; readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            if (!allowed(rawSessionId)) return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            const path = input.resolvePath(rawSessionId);
            if (!allowed(rawSessionId)) return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!path) return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            return reconcileVariableApplyEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        } });
}
