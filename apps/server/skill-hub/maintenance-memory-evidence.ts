/** @author Codex @date 2026-10-27 @version 1.0
 * Archive original Memory adoption metadata; current validity is a separate read-only projection.
 */
import {
    AGENT_EVIDENCE_RECORD_VERSION, createAgentEvidenceRecord, agentEvidenceRecordDigest,
    createAgentEvidenceInvalidationRecord, agentEvidenceInvalidationId,
    type AgentEvidenceRecordV1,
} from '@jiuguan/skill-hub';
import {
    memoryConsumptionDigest, memoryConsumptionSourceRef, normalizeMemoryConsumptionPayload,
    type MemoryConsumptionEntry, type MemoryConsumptionOutbox,
} from '../../../packages/memory/public/maintenance-memory-consumption-outbox.ts';
import { opaqueLearningToken } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentEvidenceLedger, StoredAgentEvidenceRecord } from '../agent-evidence-ledger.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { buildMaintenanceMemoryWriteJoin } from '../maintenance-memory-write-join.ts';
import type { MemorySummaryMaintenanceCommitter } from '../memory-summary-maintenance-committer.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export const MAINTENANCE_MEMORY_EVIDENCE_SOURCE_TYPE = 'maintenance-memory-consumption-v1' as const;

export interface MaintenanceMemoryEvidenceSource {
    readonly outbox: Pick<MemoryConsumptionOutbox,
        'scanRetained' | 'readBySourceRef' | 'consumerIsCurrentReadOnly'>;
    readonly committer: Pick<MemorySummaryMaintenanceCommitter, 'readMemoryWriteEvidence'>;
    close(): void;
}

export interface MaintenanceMemoryEvidencePorts {
    readonly ledger: Pick<AgentEvidenceLedger, 'append' | 'get'>;
    readonly manager: Pick<MaintenanceJobManager,
        'readMemorySkillProvenance' | 'getMemoryWriteProposalForJob'>;
    allowed(rawSessionId: string): boolean;
    open(rawSessionId: string): MaintenanceMemoryEvidenceSource | null
        | Promise<MaintenanceMemoryEvidenceSource | null>;
    onFailure?(): void;
}

export interface MaintenanceMemoryEvidenceProjection {
    readonly stored: StoredAgentEvidenceRecord;
    readonly state: 'current' | 'invalidated' | 'unavailable';
    readonly reasonCode: null | 'evidence-source-validation-failed' | 'evidence-source-unavailable';
}

/** Identity is captured with the original consumer, never inferred from today's card or mode. */
export function maintenanceMemoryEvidenceRecord(entry: MemoryConsumptionEntry): AgentEvidenceRecordV1 {
    const payload = normalizeMemoryConsumptionPayload(entry);
    if (memoryConsumptionDigest(payload) !== entry.packetDigest || !payload.evidenceBinding) {
        throw new Error('memory-evidence-original-binding-required');
    }
    const binding = payload.evidenceBinding;
    const attribution = payload.event.skillAttribution!;
    return createAgentEvidenceRecord({
        recordVersion: AGENT_EVIDENCE_RECORD_VERSION, eventType: 'context-consumed',
        sessionId: binding.identity.sessionId, cardId: binding.identity.cardId,
        contentMode: binding.identity.contentMode, capabilityId: 'maintenance.memory',
        sourceType: MAINTENANCE_MEMORY_EVIDENCE_SOURCE_TYPE,
        sourceRef: memoryConsumptionSourceRef(payload), sourceDigest: entry.packetDigest,
        artifactDigest: payload.event.artifactDigest!,
        consumerRunId: opaqueLearningToken('run', binding.consumer.runId), requestDigest: null,
        occurredAt: payload.event.occurredAt, attributionKind: 'skill',
        manifestDigests: [...attribution.selectedManifestDigests].sort(),
        candidateDigests: [...attribution.activeCandidateDigests].sort(),
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

function currentReceipt(source: MaintenanceMemoryEvidenceSource, rawSessionId: string,
    record: AgentEvidenceRecordV1): MemoryConsumptionEntry {
    const entry = source.outbox.readBySourceRef(record.sourceRef);
    if (!entry || entry.run.sessionId !== rawSessionId
        || record.sessionId !== opaqueLearningToken('session', rawSessionId)
        || agentEvidenceRecordDigest(maintenanceMemoryEvidenceRecord(entry)) !== agentEvidenceRecordDigest(record)) {
        throw new Error('memory-evidence-receipt-drift');
    }
    return entry;
}

/** Later rollback metadata must not change the identity of the original five-stage write packet. */
function originalWriteDigest(packet: ReturnType<typeof buildMaintenanceMemoryWriteJoin>): string {
    if (packet.rollbackDigest === null) return packet.packetDigest;
    const { events, packetDigest: ignored, ...metadata } = packet;
    void ignored;
    return memoryConsumptionDigest({
        ...metadata, rollbackDigest: null, rolledBackAt: null,
        events: events.slice(0, 5),
    });
}

function originalSource(input: MaintenanceMemoryEvidencePorts, source: MaintenanceMemoryEvidenceSource,
    entry: MemoryConsumptionEntry): ReturnType<typeof buildMaintenanceMemoryWriteJoin> {
    const producer = input.manager.readMemorySkillProvenance(entry.run.runId);
    const proposal = input.manager.getMemoryWriteProposalForJob(entry.run.runId);
    if (!producer || !proposal || producer.payloadDigest !== entry.sourcePayloadDigest
        || producer.proof.proofDigest !== entry.proofDigest
        || producer.proof.contentMode !== entry.contentMode
        || JSON.stringify(producer.run) !== JSON.stringify(entry.run)
        || JSON.stringify(producer.proof.attribution) !== JSON.stringify(entry.event.skillAttribution)) {
        throw new Error('memory-evidence-source-drift');
    }
    const history = source.committer.readMemoryWriteEvidence(entry.run.runId);
    if (!history) throw new Error('memory-evidence-history-unavailable');
    const packet = buildMaintenanceMemoryWriteJoin(producer, proposal, history);
    if (packet.intentDigest !== entry.intentDigest || packet.readbackDigest === null
        || packet.readbackDigest !== entry.event.artifactDigest
        || originalWriteDigest(packet) !== entry.writeJoinDigest
        || JSON.stringify(packet.events.slice(0, 5)) !== JSON.stringify(entry.prerequisites)) {
        throw new Error('memory-evidence-write-drift');
    }
    return packet;
}

/** Replays all retained bound receipts, including acknowledged or invalidated history, without ack or repair. */
export async function reconcileMaintenanceMemoryEvidence(input: MaintenanceMemoryEvidencePorts,
    rawSessionId: string, limit = 64, cursor = 0) {
    let source: MaintenanceMemoryEvidenceSource | null = null;
    let attempted = 0, delivered = 0, skipped = 0, failed = 0, nextCursor = cursor, hasMore = false;
    const allowed = (): void => {
        if (input.allowed(rawSessionId) !== true) throw new Error('memory-evidence-recovery-fenced');
    };
    try {
        allowed();
        source = await input.open(rawSessionId);
        allowed();
        if (!source) throw new Error('evidence-source-unavailable');
        const batch = source.outbox.scanRetained(limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const candidate of batch.entries) {
            if (!candidate.evidenceBinding) { skipped += 1; continue; }
            try {
                allowed();
                const record = maintenanceMemoryEvidenceRecord(candidate);
                const entry = currentReceipt(source, rawSessionId, record);
                const packet = originalSource(input, source, entry);
                allowed();
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                allowed();
                const finalPacket = originalSource(input, source, currentReceipt(source, rawSessionId, record));
                if (finalPacket.packetDigest !== packet.packetDigest) throw new Error('memory-evidence-recovery-drift');
                if (finalPacket.rollbackDigest !== null) {
                    const observation = createAgentEvidenceInvalidationRecord({ consumed: record, domain: 'memory',
                        rollbackDigest: finalPacket.rollbackDigest, rolledBackAt: finalPacket.rolledBackAt! });
                    allowed();
                    const archived = input.ledger.append(rawSessionId, observation);
                    if (archived.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                    allowed();
                    if (originalSource(input, source, currentReceipt(source, rawSessionId, record)).packetDigest
                        !== finalPacket.packetDigest) throw new Error('memory-evidence-recovery-drift');
                }
                delivered += 1;
            } catch { failed += 1; break; }
        }
        if (failed === 0) {
            allowed();
            nextCursor = batch.nextCursor;
            hasMore = batch.hasMore;
        }
    } catch { failed += 1; }
    finally { try { source?.close(); } catch { failed += 1; } }
    if (failed) { nextCursor = cursor; hasMore = false; }
    return Object.freeze({ attempted, delivered, skipped, failed, nextCursor, hasMore });
}

/** Source revocation is unavailable; verified rollback or consumer invalidation is explicitly invalidated. */
export async function readMaintenanceMemoryEvidence(input: MaintenanceMemoryEvidencePorts,
    rawSessionId: string, evidenceId: string): Promise<MaintenanceMemoryEvidenceProjection | null> {
    let stored: StoredAgentEvidenceRecord | null;
    try {
        if (input.allowed(rawSessionId) !== true) return null;
        stored = input.ledger.get(evidenceId);
        if (!stored || stored.record.sessionId !== opaqueLearningToken('session', rawSessionId)) return null;
    } catch { return null; }
    let source: MaintenanceMemoryEvidenceSource | null = null;
    const unavailable = (): MaintenanceMemoryEvidenceProjection => Object.freeze({
        stored, state: 'unavailable', reasonCode: 'evidence-source-unavailable',
    });
    const projection = await (async (): Promise<MaintenanceMemoryEvidenceProjection | null> => {
        try {
            const record = stored.record;
            if (record.eventType !== 'context-consumed'
                || record.sourceType !== MAINTENANCE_MEMORY_EVIDENCE_SOURCE_TYPE
                || record.capabilityId !== 'maintenance.memory'
                || record.attributionKind !== 'skill') return unavailable();
            const observation = input.ledger.get(agentEvidenceInvalidationId(record, 'memory'));
            if (observation) {
                const archived = observation.record;
                if (archived.eventType !== 'source-invalidated'
                    || JSON.stringify(archived) !== JSON.stringify(createAgentEvidenceInvalidationRecord({
                        consumed: record, domain: 'memory', rollbackDigest: archived.artifactDigest,
                        rolledBackAt: archived.occurredAt,
                    }))) return unavailable();
                if (input.allowed(rawSessionId) !== true) return null;
                return Object.freeze({ stored, state: 'invalidated', reasonCode: 'evidence-source-validation-failed' });
            }
            source = await input.open(rawSessionId);
            if (input.allowed(rawSessionId) !== true) return null;
            if (!source) return unavailable();
            const entry = currentReceipt(source, rawSessionId, record);
            const packet = originalSource(input, source, entry);
            let current = packet.rollbackDigest === null && source.outbox.consumerIsCurrentReadOnly(entry);
            // Both producer history and the retained journal may change between individual reads.
            const finalEntry = currentReceipt(source, rawSessionId, record);
            if (originalSource(input, source, finalEntry).packetDigest !== packet.packetDigest)
                return unavailable();
            current = current && source.outbox.consumerIsCurrentReadOnly(finalEntry);
            if (input.allowed(rawSessionId) !== true) return null;
            return Object.freeze({
                stored, state: current ? 'current' : 'invalidated',
                reasonCode: current ? null : 'evidence-source-validation-failed',
            });
        } catch {
            try { if (input.allowed(rawSessionId) !== true) return null; } catch { return null; }
            return unavailable();
        } finally {
            try { source?.close(); }
            catch { try { input.onFailure?.(); } catch { /* Cleanup diagnostics are not evidence. */ } }
        }
    })();
    // Cleanup may run host callbacks; never return metadata captured before a deletion or revocation.
    if (!projection) return null;
    try {
        if (input.allowed(rawSessionId) !== true) return null;
        const current = input.ledger.get(evidenceId);
        if (!current || current.record.evidenceId !== stored.record.evidenceId
            || current.recordDigest !== stored.recordDigest || current.ingestedAt !== stored.ingestedAt
            || current.record.sessionId !== stored.record.sessionId
            || current.record.sessionId !== opaqueLearningToken('session', rawSessionId)) return null;
        if (input.allowed(rawSessionId) !== true) return null;
        return projection;
    } catch { return null; }
}

export function createMaintenanceMemoryEvidenceScheduler(input: MaintenanceMemoryEvidencePorts & {
    retryBaseMs?: number;
}) {
    return createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (rawSessionId, limit, cursor, allowed) => reconcileMaintenanceMemoryEvidence({
            ...input, allowed,
        }, rawSessionId, limit, cursor),
    });
}
