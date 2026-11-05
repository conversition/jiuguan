/** @author Codex @date 2026-10-16 @version 1.0
 * Adapt original legacy adoption receipts, never model guesses, into metadata-only historical evidence.
 */
import {
    AGENT_EVIDENCE_RECORD_VERSION, createAgentEvidenceRecord, agentEvidenceRecordDigest,
    type AgentEvidenceRecordV1,
} from '@jiuguan/skill-hub';
import {
    explicitPreferenceAdoptionDigest, normalizeExplicitPreferenceAdoptionPayload,
    type ExplicitPreferenceAdoptionEntry, type ExplicitPreferenceAdoptionJournal,
} from '../../../packages/memory/public/explicit-preference-adoption-journal.ts';
import { opaqueLearningToken } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentEvidenceLedger, StoredAgentEvidenceRecord } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export interface ExplicitPreferenceEvidenceSource {
    readonly journal: Pick<ExplicitPreferenceAdoptionJournal, 'scan' | 'readByRunDigest'>;
    close(): void;
}

export interface ExplicitPreferenceEvidencePorts {
    readonly ledger: Pick<AgentEvidenceLedger, 'append' | 'get'>;
    allowed(rawSessionId: string): boolean;
    open(rawSessionId: string): ExplicitPreferenceEvidenceSource | null
        | Promise<ExplicitPreferenceEvidenceSource | null>;
    onFailure?(): void;
}

export interface AgentEvidenceSourceProjection {
    readonly stored: StoredAgentEvidenceRecord;
    readonly state: 'current' | 'invalidated' | 'unavailable';
    readonly reasonCode: null | 'evidence-source-validation-failed' | 'evidence-source-unavailable';
}


export function explicitPreferenceEvidenceRecord(entry: ExplicitPreferenceAdoptionEntry): AgentEvidenceRecordV1 {
    const payload = normalizeExplicitPreferenceAdoptionPayload(entry.payload);
    if (explicitPreferenceAdoptionDigest(payload) !== entry.packetDigest) {
        throw new Error('explicit-evidence-original-packet-mismatch');
    }
    return createAgentEvidenceRecord({
        recordVersion: AGENT_EVIDENCE_RECORD_VERSION, eventType: 'context-consumed',
        sessionId: payload.identity.sessionId, cardId: payload.identity.cardId,
        contentMode: payload.identity.contentMode, capabilityId: 'learning.preference',
        sourceType: payload.version, sourceRef: explicitPreferenceAdoptionDigest(payload.consumer.runId),
        sourceDigest: entry.packetDigest, artifactDigest: payload.consumer.assistantDigest,
        consumerRunId: opaqueLearningToken('run', payload.consumer.runId), requestDigest: payload.requestDigest,
        occurredAt: payload.occurredAt, attributionKind: 'legacy-profile',
        manifestDigests: [], candidateDigests: [], executionClass: 'unknown',
        effectOutcome: 'unknown', learningWeight: 0,
    });
}


function currentReceipt(source: ExplicitPreferenceEvidenceSource, record: AgentEvidenceRecordV1):
    ExplicitPreferenceAdoptionEntry {
    const current = source.journal.readByRunDigest(record.sourceRef);
    if (!current || agentEvidenceRecordDigest(explicitPreferenceEvidenceRecord(current))
        !== agentEvidenceRecordDigest(record)) throw new Error('explicit-evidence-receipt-drift');
    return current;
}


/** Retained receipts replay their original time; invalid sources never become learning positives. */
export async function reconcileExplicitPreferenceEvidence(input: ExplicitPreferenceEvidencePorts,
    rawSessionId: string, limit = 64, cursor = 0) {
    let source: ExplicitPreferenceEvidenceSource | null = null;
    let attempted = 0;
    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    let nextCursor = cursor;
    let hasMore = false;
    const allowed = (): void => {
        if (input.allowed(rawSessionId) !== true) throw new Error('explicit-evidence-recovery-fenced');
    };
    try {
        allowed();
        source = await input.open(rawSessionId);
        allowed();
        if (!source) throw new Error('evidence-source-unavailable');
        const batch = source.journal.scan(limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const entry of batch.entries) {
            try {
                allowed();
                const record = explicitPreferenceEvidenceRecord(entry);
                if (record.sessionId !== opaqueLearningToken('session', rawSessionId)) {
                    throw new Error('explicit-evidence-session-mismatch');
                }
                currentReceipt(source, record);
                allowed();
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                allowed();
                currentReceipt(source, record);
                delivered += 1;
            } catch { failed += 1; break; }
        }
        if (failed === 0) { allowed(); nextCursor = batch.nextCursor; hasMore = batch.hasMore; }
    } catch { failed += 1; }
    finally {
        try { source?.close(); } catch { failed += 1; }
    }
    if (failed) { nextCursor = cursor; hasMore = false; }
    return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
}


/** Central rows are historical and unchecked until the exact original receipt is inspected again. */
export async function readExplicitPreferenceEvidence(input: ExplicitPreferenceEvidencePorts,
    rawSessionId: string, evidenceId: string): Promise<AgentEvidenceSourceProjection | null> {
    let stored: StoredAgentEvidenceRecord | null;
    try {
        if (input.allowed(rawSessionId) !== true) return null;
        stored = input.ledger.get(evidenceId);
        if (!stored || stored.record.sessionId !== opaqueLearningToken('session', rawSessionId)) return null;
    } catch {
        try { input.onFailure?.(); } catch { /* Optional diagnostics are not evidence. */ }
        return null;
    }
    let source: ExplicitPreferenceEvidenceSource | null = null;
    const unavailable = (): AgentEvidenceSourceProjection => Object.freeze({
        stored, state: 'unavailable', reasonCode: 'evidence-source-unavailable',
    });
    let projection = unavailable();
    let denied = false;
    const isAllowed = (): boolean => {
        try {
            if (!denied && input.allowed(rawSessionId) === true) return true;
        } catch { /* A failed admission check cannot be reopened by cleanup. */ }
        denied = true;
        return false;
    };
    try {
        if (stored.record.sourceType === 'explicit-preference-adoption-v1'
            && stored.record.attributionKind === 'legacy-profile') {
            source = await input.open(rawSessionId);
            if (!isAllowed()) throw new Error('explicit-evidence-read-fenced');
            if (source) {
                const receipt = currentReceipt(source, stored.record);
                if (!isAllowed()) throw new Error('explicit-evidence-read-fenced');
                projection = Object.freeze({
                    stored, state: receipt.state === 'recorded' ? 'current' : 'invalidated',
                    reasonCode: receipt.state === 'recorded' ? null : 'evidence-source-validation-failed',
                });
            }
        }
    } catch {
        isAllowed();
        projection = unavailable();
    } finally {
        try { source?.close(); }
        catch {
            try { input.onFailure?.(); } catch { /* Resource cleanup must not block a read projection. */ }
        }
    }
    // Cleanup and asynchronous source opening can overlap a committed Ledger purge.
    // All projection states must still name the exact retained row after cleanup.
    try {
        if (!isAllowed()) return null;
        const current = input.ledger.get(evidenceId);
        if (!current || current.record.evidenceId !== evidenceId
            || current.record.evidenceId !== stored.record.evidenceId
            || current.recordDigest !== stored.recordDigest || current.ingestedAt !== stored.ingestedAt
            || current.sourceStatus !== stored.sourceStatus
            || current.record.sessionId !== opaqueLearningToken('session', rawSessionId)
            || JSON.stringify(current.record) !== JSON.stringify(stored.record)) return null;
        if (!isAllowed()) return null;
        return projection;
    } catch {
        try { input.onFailure?.(); } catch { /* Optional diagnostics are not evidence. */ }
        return null;
    }
}


export function createExplicitPreferenceEvidenceScheduler(input: ExplicitPreferenceEvidencePorts & {
    onFailure?(): void;
    retryBaseMs?: number;
}) {
    return createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (rawSessionId, limit, cursor, allowed) => reconcileExplicitPreferenceEvidence({
            ...input, allowed,
        }, rawSessionId, limit, cursor),
    });
}
