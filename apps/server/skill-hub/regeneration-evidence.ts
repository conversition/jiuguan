/** @author Codex @date 2026-10-27 @version 1.0
 * An original successful regeneration is history, not a negative quality verdict or Skill label.
 */
import {
    createAgentEvidenceRegenerationRecord, agentEvidenceRecordDigest, type AgentEvidenceRegenerationRecordV1,
} from '@jiuguan/skill-hub';
import { normalizeLearningEvent, opaqueLearningToken, sha256Digest,
    type LearningEventRecord } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export interface RegenerationEvidenceSource {
    scan(limit?: number, cursor?: number): Readonly<{
        entries: readonly LearningEventRecord[]; attempted: number; failed: number; nextCursor: number; hasMore: boolean;
    }>;
    read(eventId: string): LearningEventRecord | null;
    close(): void;
}
export interface RegenerationEvidencePorts {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>;
    allowed(rawSessionId: string): boolean;
    open(rawSessionId: string): RegenerationEvidenceSource | null;
    onFailure?(): void;
}

export function regenerationEvidenceRecord(event: LearningEventRecord): AgentEvidenceRegenerationRecordV1 {
    const normalized = normalizeLearningEvent(event);
    if (normalized.eventKind !== 'regenerate' || normalized.payloadDigest !== event.payloadDigest
        || event.deliveredAt !== null && (typeof event.deliveredAt !== 'string'
            || !Number.isFinite(Date.parse(event.deliveredAt)) || new Date(event.deliveredAt).toISOString() !== event.deliveredAt))
        throw new Error('regeneration-evidence-original-invalid');
    const replaced = normalized.features.replacedSourceRevision;
    if (replaced !== undefined && typeof replaced !== 'string') throw new Error('regeneration-evidence-replaced-revision-invalid');
    // payloadDigest excludes createdAt in the original outbox. Bind the full immutable packet here;
    // only the independently mutable delivery acknowledgement is deliberately excluded.
    const { deliveredAt: _acknowledgement, ...packet } = normalized;
    return createAgentEvidenceRegenerationRecord({
        recordVersion: 'agent-evidence-regeneration-v1', eventType: 'history-regenerated',
        sourceType: 'session-learning-regenerate-v1', sourceRef: normalized.eventId,
        sourceDigest: sha256Digest(JSON.stringify(packet)), artifactDigest: normalized.subjectDigest,
        sessionId: normalized.sessionId, cardId: normalized.cardId, contentMode: normalized.contentMode,
        producerRunId: normalized.runId, round: normalized.round, occurredAt: normalized.createdAt,
        replacedSourceRevisionDigest: replaced === undefined ? null : sha256Digest(replaced),
        attributionKind: 'unattributed', manifestDigests: [], candidateDigests: [],
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

/** Re-read the original packet twice, with current deletion fences surrounding any archive write. */
export async function reconcileRegenerationEvidence(
    input: RegenerationEvidencePorts, rawSessionId: string, limit = 64, cursor = 0,
) {
    let attempted = 0, delivered = 0, skipped = 0, failed = 0, nextCursor = cursor, hasMore = false;
    let source: RegenerationEvidenceSource | null = null;
    const allowed = () => input.allowed(rawSessionId) === true;
    try {
        if (!allowed()) throw new Error('evidence-access-denied');
        source = input.open(rawSessionId);
        if (!allowed() || !source) throw new Error('evidence-source-unavailable');
        const batch = source.scan(limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const candidate of batch.entries) {
            try {
                if (!allowed()) throw new Error('evidence-access-denied');
                if (candidate.sessionId !== opaqueLearningToken('session', rawSessionId))
                    throw new Error('regeneration-evidence-session-mismatch');
                const record = regenerationEvidenceRecord(candidate);
                const original = source.read(candidate.eventId);
                if (!original || agentEvidenceRecordDigest(regenerationEvidenceRecord(original)) !== agentEvidenceRecordDigest(record))
                    throw new Error('regeneration-evidence-source-drift');
                if (!allowed()) throw new Error('evidence-access-denied');
                const final = source.read(candidate.eventId);
                if (!final || agentEvidenceRecordDigest(regenerationEvidenceRecord(final)) !== agentEvidenceRecordDigest(record))
                    throw new Error('regeneration-evidence-source-drift');
                if (!allowed()) throw new Error('evidence-access-denied');
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                delivered += 1;
            } catch { failed += 1; break; }
        }
        if (failed === 0 && !allowed()) throw new Error('evidence-access-denied');
        if (failed === 0) { nextCursor = batch.nextCursor; hasMore = batch.hasMore; }
    } catch { failed += 1; }
    finally { try { source?.close(); } catch { failed += 1; } }
    if (failed) { nextCursor = cursor; hasMore = false; }
    return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
}

export function createRegenerationEvidenceScheduler(input: RegenerationEvidencePorts & { retryBaseMs?: number }) {
    return createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (sessionId, limit, cursor, allowed) => reconcileRegenerationEvidence({ ...input, allowed }, sessionId, limit, cursor),
    });
}
