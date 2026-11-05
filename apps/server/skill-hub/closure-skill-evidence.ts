/** @author Codex @date 2026-10-16 @version 1.0
 * Original committed foreground Skill receipts adapt into historical evidence, never new execution authority.
 */
import { createHash } from 'node:crypto';
import {
    AGENT_EVIDENCE_RECORD_VERSION, createAgentEvidenceRecord, agentEvidenceRecordDigest,
    type AgentEvidenceRecordV1,
} from '@jiuguan/skill-hub';
import {
    agentClosureOperationId, normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEventInput,
} from '../../../packages/agent-closure/index.ts';
import {
    normalizeAgentSkillConsumptionPayload, type AgentSkillConsumptionOutbox,
    type AgentSkillConsumptionOutboxEntryV1,
} from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import { opaqueLearningToken } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentClosureStore } from '../agent-closure-store.ts';
import type { AgentEvidenceLedger, StoredAgentEvidenceRecord } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export interface ClosureSkillEvidenceSource {
    readonly outbox: Pick<AgentSkillConsumptionOutbox,
        'scan' | 'read' | 'hasEvidenceBindings' | 'consumerIsCurrent'>;
    close(): void;
}

export interface ClosureSkillEvidencePorts {
    readonly ledger: Pick<AgentEvidenceLedger, 'append' | 'get'>;
    readonly closure: Pick<AgentClosureStore, 'begin' | 'record' | 'get'>;
    allowed(rawSessionId: string): boolean;
    open(rawSessionId: string): ClosureSkillEvidenceSource | null | Promise<ClosureSkillEvidenceSource | null>;
    onFailure?(): void;
    onClosureReady?(rawSessionId: string): void;
}

export interface ClosureSkillEvidenceProjection {
    readonly stored: StoredAgentEvidenceRecord;
    readonly state: 'current' | 'invalidated' | 'unavailable';
    readonly reasonCode: null | 'evidence-source-validation-failed' | 'evidence-source-unavailable';
}

const SOURCE_TYPE = 'agent-closure-skill-consumption-v1';
const CAPABILITIES = ['context.compiler', 'interactive.critic', 'interactive.prelude'];


function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


function normalizedEntry(entry: AgentSkillConsumptionOutboxEntryV1) {
    const source = Object.getOwnPropertyDescriptor(entry, 'contextCompilerSource');
    if (source && (!Object.hasOwn(source, 'value') || !source.enumerable || source.value === undefined)) {
        throw new Error('closure-evidence-original-packet-mismatch');
    }
    const critic = Object.getOwnPropertyDescriptor(entry, 'criticSource');
    if (critic && (!Object.hasOwn(critic, 'value') || !critic.enumerable || critic.value === undefined)) {
        throw new Error('closure-evidence-original-packet-mismatch');
    }
    const prelude = Object.getOwnPropertyDescriptor(entry, 'preludeSource');
    if (prelude && (!Object.hasOwn(prelude, 'value') || !prelude.enumerable || prelude.value === undefined)) {
        throw new Error('closure-evidence-original-packet-mismatch');
    }
    const payload = normalizeAgentSkillConsumptionPayload({
        run: entry.run, event: entry.event,
        ...(entry.prerequisites === undefined ? {} : { prerequisites: entry.prerequisites }),
        ...(entry.evidenceBinding === undefined ? {} : { evidenceBinding: entry.evidenceBinding }),
        ...(source ? { contextCompilerSource: source.value } : {}),
        ...(critic ? { criticSource: critic.value } : {}),
        ...(prelude ? { preludeSource: prelude.value } : {}),
    });
    if (digest(payload) !== entry.payloadDigest
        || entry.entryId !== `skill-use:${digest([
            payload.run.operationId, payload.event.idempotencyKey,
        ]).slice('sha256:'.length)}`) throw new Error('closure-evidence-original-packet-mismatch');
    if (!payload.evidenceBinding || !payload.prerequisites || payload.prerequisites.length !== 2
        || !CAPABILITIES.includes(payload.run.capability) || !payload.run.evidenceDigest
        || payload.run.kind !== 'advisory'
        || payload.run.lane !== 'interactive' || payload.event.consumerRunId !== payload.run.runId
        || payload.evidenceBinding.consumer.runId !== payload.run.runId
        || payload.evidenceBinding.identity.sessionId !== opaqueLearningToken('session', payload.run.sessionId)) {
        throw new Error('closure-evidence-original-binding-required');
    }
    const contextBlock = payload.run.capability === 'context.compiler' ? 'contextCapsule'
        : payload.run.capability === 'interactive.critic' ? 'criticRevision' : 'interactivePrelude';
    const operationId = payload.run.capability === 'context.compiler'
        ? agentClosureOperationId('context', payload.run.runId, payload.run.evidenceDigest ?? '')
        : agentClosureOperationId('interactive', payload.run.runId, payload.run.capability);
    if (payload.event.contextBlock !== contextBlock || payload.run.operationId !== operationId
        || payload.event.idempotencyKey !== `consumed-${payload.run.runId}`) {
        throw new Error('closure-evidence-domain-binding-mismatch');
    }
    return payload;
}


/** No historical card or effective mode is inferred from the current Session configuration. */
export function closureSkillEvidenceRecord(entry: AgentSkillConsumptionOutboxEntryV1): AgentEvidenceRecordV1 {
    const payload = normalizedEntry(entry);
    const binding = payload.evidenceBinding!;
    const attribution = payload.event.skillAttribution!;
    return createAgentEvidenceRecord({
        recordVersion: AGENT_EVIDENCE_RECORD_VERSION, eventType: 'context-consumed',
        sessionId: binding.identity.sessionId, cardId: binding.identity.cardId,
        contentMode: binding.identity.contentMode, capabilityId: payload.run.capability,
        sourceType: SOURCE_TYPE, sourceRef: entry.entryId, sourceDigest: entry.payloadDigest,
        artifactDigest: payload.event.artifactDigest!,
        consumerRunId: opaqueLearningToken('run', binding.consumer.runId),
        requestDigest: payload.contextCompilerSource?.requestDigest ?? payload.criticSource?.requestDigest
            ?? (payload.preludeSource?.requestDigests.length === 1 ? payload.preludeSource.requestDigests[0]! : null),
        occurredAt: payload.event.occurredAt, attributionKind: 'skill',
        manifestDigests: [...attribution.selectedManifestDigests].sort(),
        candidateDigests: [...attribution.activeCandidateDigests].sort(),
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}


function currentReceipt(source: ClosureSkillEvidenceSource, rawSessionId: string,
    record: AgentEvidenceRecordV1): AgentSkillConsumptionOutboxEntryV1 {
    const entry = source.outbox.read(record.sourceRef);
    if (!entry || entry.run.sessionId !== rawSessionId
        || record.sessionId !== opaqueLearningToken('session', rawSessionId)
        || agentEvidenceRecordDigest(closureSkillEvidenceRecord(entry)) !== agentEvidenceRecordDigest(record)) {
        throw new Error('closure-evidence-receipt-drift');
    }
    return entry;
}


function sameEvent(left: AgentClosureEventInput, right: AgentClosureEventInput): boolean {
    return JSON.stringify(normalizeAgentClosureEvent(left)) === JSON.stringify(normalizeAgentClosureEvent(right));
}


/** Central event IDs and insertion sequences are deliberately excluded from the original receipt identity. */
function exactClosure(closure: ClosureSkillEvidencePorts['closure'], entry: AgentSkillConsumptionOutboxEntryV1):
    boolean {
    const original = normalizedEntry(entry);
    const current = closure.get(original.run.operationId);
    if (!current) return false;
    if (JSON.stringify(normalizeAgentClosureRun(current)) !== JSON.stringify(original.run)) {
        throw new Error('closure-evidence-run-drift');
    }
    const admitted = current.events.find((event) => event.type === 'admitted');
    if (!admitted || admitted.occurredAt !== original.run.admittedAt
        || admitted.sourceRevision !== original.run.sourceRevision
        || admitted.artifactDigest !== original.run.evidenceDigest) {
        throw new Error('closure-evidence-admission-drift');
    }
    let complete = true;
    for (const expected of [...original.prerequisites!, original.event]) {
        const matching = current.events.filter((event) => event.idempotencyKey === expected.idempotencyKey);
        if (matching.length === 0) { complete = false; continue; }
        if (matching.length !== 1 || !sameEvent(matching[0] as AgentClosureEventInput, expected)) {
            throw new Error('closure-evidence-event-drift');
        }
    }
    return complete;
}


function closureInvalidated(closure: ClosureSkillEvidencePorts['closure'], operationId: string): boolean {
    const current = closure.get(operationId);
    return current !== undefined && ['stale', 'failed', 'cancelled', 'rejected', 'rolled_back', 'no_op']
        .includes(current.status);
}


/** Repair only missing original metadata while its original consumer remains current; no Agent is rerun. */
function ensureClosure(input: ClosureSkillEvidencePorts, source: ClosureSkillEvidenceSource,
    rawSessionId: string, record: AgentEvidenceRecordV1, allowed: () => void):
    AgentSkillConsumptionOutboxEntryV1 {
    let entry = currentReceipt(source, rawSessionId, record);
    if (exactClosure(input.closure, entry)) return entry;
    const beforeWrite = (): AgentSkillConsumptionOutboxEntryV1 => {
        allowed();
        entry = currentReceipt(source, rawSessionId, record);
        if (!source.outbox.consumerIsCurrent(entry) || closureInvalidated(input.closure, entry.run.operationId)) {
            throw new Error('closure-evidence-consumer-invalidated');
        }
        exactClosure(input.closure, entry);
        return entry;
    };
    input.closure.begin(beforeWrite().run);
    for (const prerequisite of entry.prerequisites!) {
        const current = beforeWrite();
        input.closure.record(current.run.operationId, prerequisite);
    }
    const current = beforeWrite();
    input.closure.record(current.run.operationId, current.event);
    entry = currentReceipt(source, rawSessionId, record);
    if (!exactClosure(input.closure, entry)) throw new Error('closure-evidence-original-lineage-incomplete');
    return entry;
}


/** Scan every retained receipt, including acknowledged history; old unbound rows are never retrofitted. */
export async function reconcileClosureSkillEvidence(input: ClosureSkillEvidencePorts,
    rawSessionId: string, limit = 64, cursor = 0) {
    let source: ClosureSkillEvidenceSource | null = null;
    let attempted = 0;
    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    let nextCursor = cursor;
    let hasMore = false;
    const allowed = (): void => {
        if (input.allowed(rawSessionId) !== true) throw new Error('closure-evidence-recovery-fenced');
    };
    try {
        allowed();
        source = await input.open(rawSessionId);
        allowed();
        if (!source) throw new Error('evidence-source-unavailable');
        const batch = source.outbox.scan(limit, cursor);
        attempted = batch.attempted;
        if (batch.failed !== 0) throw new Error('evidence-source-invalid');
        for (const item of batch.entries) {
            if (!item.evidenceBinding) { skipped += 1; continue; }
            try {
                allowed();
                const record = closureSkillEvidenceRecord(item);
                ensureClosure(input, source, rawSessionId, record, allowed);
                try { input.onClosureReady?.(rawSessionId); } catch { /* original Closure receipt remains authoritative */ }
                allowed();
                const current = currentReceipt(source, rawSessionId, record);
                if (!exactClosure(input.closure, current)) throw new Error('closure-evidence-lineage-unavailable');
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') throw new Error('evidence-session-deleted');
                allowed();
                currentReceipt(source, rawSessionId, record);
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


/** Raw archive rows remain unchecked; this read-only projection checks both original receipt and Closure intent. */
export async function readClosureSkillEvidence(input: ClosureSkillEvidencePorts,
    rawSessionId: string, evidenceId: string): Promise<ClosureSkillEvidenceProjection | null> {
    let stored: StoredAgentEvidenceRecord | null;
    try {
        if (input.allowed(rawSessionId) !== true) return null;
        stored = input.ledger.get(evidenceId);
        if (!stored || stored.record.sessionId !== opaqueLearningToken('session', rawSessionId)) return null;
    } catch {
        try { input.onFailure?.(); } catch { /* Optional diagnostics cannot become authority. */ }
        return null;
    }
    let source: ClosureSkillEvidenceSource | null = null;
    const unavailable = (): ClosureSkillEvidenceProjection => Object.freeze({
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
        if (stored.record.sourceType === SOURCE_TYPE && stored.record.attributionKind === 'skill') {
            source = await input.open(rawSessionId);
            if (!isAllowed()) throw new Error('closure-evidence-read-fenced');
            if (source) {
                const entry = currentReceipt(source, rawSessionId, stored.record);
                if (exactClosure(input.closure, entry)) {
                    const current = source.outbox.consumerIsCurrent(entry)
                        && !closureInvalidated(input.closure, entry.run.operationId);
                    if (!isAllowed()) throw new Error('closure-evidence-read-fenced');
                    projection = Object.freeze({
                        stored, state: current ? 'current' : 'invalidated',
                        reasonCode: current ? null : 'evidence-source-validation-failed',
                    });
                }
            }
        }
    } catch {
        isAllowed();
        projection = unavailable();
    } finally {
        try { source?.close(); }
        catch { try { input.onFailure?.(); } catch { /* Cleanup cannot block a read projection. */ } }
    }
    // Source cleanup may itself observe deletion, so no projection is returned
    // until the same immutable Ledger packet is rechecked after that boundary.
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
        try { input.onFailure?.(); } catch { /* Optional diagnostics cannot become authority. */ }
        return null;
    }
}


export function createClosureSkillEvidenceScheduler(input: ClosureSkillEvidencePorts & { retryBaseMs?: number }) {
    return createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryBaseMs: input.retryBaseMs, retryOnFailure: false,
        reconcile: (rawSessionId, limit, cursor, allowed) => reconcileClosureSkillEvidence({
            ...input, allowed,
        }, rawSessionId, limit, cursor),
    });
}
