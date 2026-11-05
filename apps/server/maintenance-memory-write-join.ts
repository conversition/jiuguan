/** @author Codex @date 2026-10-14 @version 1.0
 * Exact task-source/business-history join. No model, current fact reads or consumption claims.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken, executionClassForMaintenanceTrigger,
    normalizeAgentClosureEvent,
    normalizeAgentClosureRun, type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../packages/agent-closure/index.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';
import { parseMaintenanceMemoryDirectProposal,
    type MaintenanceMemoryDirectProposalRecord } from './maintenance-memory-direct-proposal.ts';
import type { MaintenanceMemorySkillOutboxEntry } from './maintenance-memory-skill-outbox.ts';
import type { MemoryWriteHistoricalEvidence } from './memory-summary-maintenance-committer.ts';
import { memoryWriteDigest, parseMemoryWriteIntent,
    parseMemoryWriteReadback } from './maintenance-memory-write-receipt.ts';
import { parseMaintenanceMemorySkillProposalProof } from './skill-hub/maintenance-memory-proposal-proof.ts';

export const MEMORY_WRITE_JOIN_PREFIX = 'maintenance_memory_write_join:';
const MAX_JOIN_CHARS = 32_768;
interface JoinMetadata {
    readonly version: 'maintenance-memory-write-join-v1' | 'maintenance-memory-write-join-v2';
    readonly run: AgentClosureRunInput;
    readonly sourcePayloadDigest: string;
    readonly proofDigest: string;
    readonly proposalDigest: string;
    readonly proposalId: string;
    readonly persistedAt: string;
    readonly itemCount: number | null;
    readonly intentDigest: string;
    readonly targetRevision: string;
    readonly committedAt: string;
    readonly readbackDigest: string | null;
    readonly verifiedAt: string | null;
    readonly rollbackDigest: string | null;
    readonly rolledBackAt: string | null;
    readonly preparationDigest?: string;
    readonly sourceEvents?: readonly AgentClosureEventInput[];
}

export type MaintenanceMemoryWriteProposal = MaintenancePendingProposalRecord | MaintenanceMemoryDirectProposalRecord;

export interface MemoryWriteJoinPacket extends JoinMetadata {
    readonly events: readonly AgentClosureEventInput[];
    readonly packetDigest: string;
}

function packet(input: JoinMetadata): MemoryWriteJoinPacket {
    const run = normalizeAgentClosureRun(input.run);
    const direct = input.version === 'maintenance-memory-write-join-v2';
    if ((!direct && input.version !== 'maintenance-memory-write-join-v1') || run.capability !== 'maintenance.memory'
        || run.kind !== 'proposal' || run.lane !== 'maintenance' || !/^mjob_[a-f0-9]{32}$/u.test(run.runId)
        || input.proposalId !== `${direct ? 'mdprop' : 'mprop'}_${run.runId.slice(5)}`
        || (input.itemCount !== null && (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0))) {
        throw new Error('memory-write-join-metadata-invalid');
    }
    const metadata: JoinMetadata = {
        version: input.version, run,
        sourcePayloadDigest: agentClosureDigest(input.sourcePayloadDigest, 'source-payload-digest'),
        proofDigest: agentClosureDigest(input.proofDigest, 'proof-digest'),
        proposalDigest: agentClosureDigest(input.proposalDigest, 'proposal-digest'),
        proposalId: agentClosureToken(input.proposalId, 'proposal-id'),
        persistedAt: agentClosureTimestamp(input.persistedAt, 'persisted-at'), itemCount: input.itemCount,
        intentDigest: agentClosureDigest(input.intentDigest, 'intent-digest'),
        targetRevision: agentClosureDigest(input.targetRevision, 'target-revision'),
        committedAt: agentClosureTimestamp(input.committedAt, 'committed-at'),
        readbackDigest: input.readbackDigest === null
            ? null : agentClosureDigest(input.readbackDigest, 'readback-digest'),
        verifiedAt: input.verifiedAt === null ? null : agentClosureTimestamp(input.verifiedAt, 'verified-at'),
        rollbackDigest: input.rollbackDigest === null
            ? null : agentClosureDigest(input.rollbackDigest, 'rollback-digest'),
        rolledBackAt: input.rolledBackAt === null ? null : agentClosureTimestamp(input.rolledBackAt, 'rolled-back-at'),
        ...(direct ? {
            preparationDigest: agentClosureDigest(input.preparationDigest, 'preparation-digest'),
            sourceEvents: directSourceEvents(input, run),
        } : {}),
    };
    if (run.admittedAt > metadata.persistedAt || metadata.persistedAt > metadata.committedAt
        || (metadata.readbackDigest === null) !== (metadata.verifiedAt === null)
        || (metadata.rollbackDigest === null) !== (metadata.rolledBackAt === null)
        || (metadata.verifiedAt !== null && metadata.verifiedAt < metadata.committedAt)
        || (metadata.rolledBackAt !== null
            && metadata.rolledBackAt < (metadata.verifiedAt ?? metadata.committedAt))) {
        throw new Error('memory-write-join-chronology-invalid');
    }
    if (direct) return finishPacket(metadata, [...metadata.sourceEvents!]);
    // The original settled/pending milestones intentionally retain the legacy observer's exact intent.
    const events: AgentClosureEventInput[] = [
        {
            type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: metadata.persistedAt,
            sourceRevision: run.sourceRevision
        },
        {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: metadata.persistedAt,
            artifactDigest: '', evidenceRef: metadata.proposalId, sourceRevision: run.sourceRevision
        },
    ];
    // The proposal digest is carried by the stable admitted lineage's join input, not guessed from a write digest.
    return finishPacket(metadata, events);
}

function directSourceEvents(input: JoinMetadata, run: AgentClosureRunInput): readonly AgentClosureEventInput[] {
    if (!Array.isArray(input.sourceEvents) || input.sourceEvents.length !== 3) {
        throw new Error('memory-write-join-source-events-invalid');
    }
    const executedAt = agentClosureTimestamp(input.sourceEvents[0]?.occurredAt, 'source-executed-at');
    const persistedAt = agentClosureTimestamp(input.persistedAt, 'persisted-at');
    if (executedAt < run.admittedAt || executedAt > persistedAt) {
        throw new Error('memory-write-join-source-chronology-invalid');
    }
    const expected: AgentClosureEventInput[] = [
        {
            type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: executedAt,
            sourceRevision: run.sourceRevision,
        },
        {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: persistedAt,
            artifactDigest: input.proposalDigest, evidenceRef: input.proposalId, sourceRevision: run.sourceRevision,
        },
        {
            type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: persistedAt,
            artifactDigest: input.proposalDigest, sourceRevision: run.sourceRevision,
            ...(input.itemCount === null ? {} : { itemCount: input.itemCount }),
        },
    ];
    const normalized = Object.freeze(expected.map(normalizeAgentClosureEvent));
    if (JSON.stringify(normalized) !== JSON.stringify(input.sourceEvents)) {
        throw new Error('memory-write-join-source-events-invalid');
    }
    return normalized;
}

function finishPacket(metadata: JoinMetadata, events: AgentClosureEventInput[]): MemoryWriteJoinPacket {
    const proposalDigest = metadata.proposalDigest;
    if (metadata.version === 'maintenance-memory-write-join-v1') {
        events[1] = { ...events[1]!, artifactDigest: proposalDigest };
        events.push({
            type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: metadata.persistedAt,
            artifactDigest: proposalDigest, sourceRevision: metadata.run.sourceRevision,
            ...(metadata.itemCount === null ? {} : { itemCount: metadata.itemCount })
        });
    }
    events.push({
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: metadata.committedAt,
        artifactDigest: proposalDigest, evidenceRef: metadata.proposalId, targetRevision: metadata.targetRevision
    });
    if (metadata.readbackDigest !== null) events.push({
        type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: metadata.verifiedAt!,
            artifactDigest: metadata.readbackDigest, evidenceRef: metadata.proposalId,
            targetRevision: metadata.targetRevision,
    });
    if (metadata.rollbackDigest !== null) events.push({
        type: 'rolled-back', idempotencyKey: 'proposal-rolled-back', occurredAt: metadata.rolledBackAt!,
        artifactDigest: metadata.rollbackDigest, evidenceRef: metadata.proposalId, reasonCode: 'operator-rolled-back',
    });
    const value = { ...metadata, events: Object.freeze(events.map(normalizeAgentClosureEvent)) };
    return Object.freeze({ ...value, packetDigest: memoryWriteDigest(value) });
}

function normalizePacket(value: unknown): MemoryWriteJoinPacket {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory-write-join-invalid');
    const normalized = packet(value as JoinMetadata);
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('memory-write-join-corrupt');
    return normalized;
}

export function buildMaintenanceMemoryWriteJoin(source: MaintenanceMemorySkillOutboxEntry,
    proposal: MaintenanceMemoryWriteProposal, evidence: MemoryWriteHistoricalEvidence): MemoryWriteJoinPacket {
    const proof = parseMaintenanceMemorySkillProposalProof(source.proof);
    const expected = parseMemoryWriteIntent(evidence.intent);
    const { payloadDigest, ...sourcePayload } = source;
    const direct = 'preparationDigest' in proposal ? parseMaintenanceMemoryDirectProposal(proposal) : null;
    if ((direct ? source.payloadVersion !== 'maintenance-memory-skill-outbox-v2'
        : source.payloadVersion !== 'maintenance-memory-skill-outbox-v1')
        || memoryWriteDigest(sourcePayload) !== payloadDigest
        || proposal.taskKind !== 'memory_consolidation' || proposal.jobRunId !== expected.runId
        || proposal.sessionId !== expected.sessionId || proposal.sourceRevision !== expected.sourceRevision
        || proposal.proposalDigest !== expected.proposalDigest
        || memoryWriteDigest(proposal.proposal) !== expected.proposalDigest
        || proof.runId !== expected.runId || proof.sessionId !== expected.sessionId
        || proof.sourceRevision !== expected.sourceRevision || proof.proposalDigest !== expected.proposalDigest
        || source.run.runId !== proof.runId || source.run.sessionId !== proof.sessionId
        || source.run.sourceRevision !== proof.sourceRevision || source.run.policyVersion !== proof.policyVersion
        || (source.run.parentRunId ?? source.run.runId) !== proof.parentRunId
        || source.run.admittedAt > proof.admittedAt || proof.validatedAt > proposal.createdAt
        || (direct ? proposal.status !== 'prepared' : !['pending', 'applied', 'rolled_back'].includes(proposal.status))
        || !['applied', 'rolled_back'].includes(evidence.state)) {
        throw new Error('memory-write-join-identity-mismatch');
    }
    if (direct && (source.preparationDigest !== direct.preparationDigest
        || direct.proofDigest !== proof.proofDigest || direct.attempt !== proof.attempt
        || direct.policyVersion !== proof.policyVersion || direct.parentRunId !== proof.parentRunId
        || direct.jobCreatedAt !== source.run.admittedAt
        || executionClassForMaintenanceTrigger(direct.trigger) !== source.run.executionClass
        || source.events[0]?.occurredAt !== proof.executedAt)) {
        throw new Error('memory-write-join-preparation-mismatch');
    }
    const readback = evidence.readback === null ? null : parseMemoryWriteReadback(evidence.readback);
    if (readback && (readback.runId !== expected.runId || readback.sessionId !== expected.sessionId
        || readback.sourceRevision !== expected.sourceRevision || readback.proposalDigest !== expected.proposalDigest
        || readback.intentDigest !== expected.intentDigest || readback.targetRevision !== expected.targetRevision
        || readback.committedAt !== expected.committedAt)) throw new Error('memory-write-join-readback-mismatch');
    const updatedAt = agentClosureTimestamp(evidence.updatedAt, 'write-updated-at');
    if (updatedAt < expected.committedAt || (evidence.state === 'applied' && proposal.status === 'rolled_back')) {
        throw new Error('memory-write-join-state-mismatch');
    }
    const value = packet({
        version: direct ? 'maintenance-memory-write-join-v2' : 'maintenance-memory-write-join-v1', run: source.run,
        sourcePayloadDigest: payloadDigest, proofDigest: proof.proofDigest, proposalId: proposal.proposalId,
        persistedAt: proposal.createdAt,
        itemCount: Number.isSafeInteger(proposal.diff.itemCount) ? Number(proposal.diff.itemCount) : null,
        intentDigest: expected.intentDigest, targetRevision: expected.targetRevision, committedAt: expected.committedAt,
        readbackDigest: readback?.readbackDigest ?? null, verifiedAt: readback?.verifiedAt ?? null,
        rollbackDigest: evidence.state === 'rolled_back' ? evidence.rollbackDigest! : null,
        rolledBackAt: evidence.state === 'rolled_back' ? updatedAt : null,
        proposalDigest: expected.proposalDigest,
        ...(direct ? { preparationDigest: direct.preparationDigest, sourceEvents: source.events } : {}),
    });
    if (JSON.stringify(value.events.slice(0, 3)) !== JSON.stringify(source.events)) {
        throw new Error('memory-write-join-source-events-mismatch');
    }
    return value;
}

interface JoinRecord {
    readonly journalVersion: 'maintenance-memory-write-join-journal-v1';
    readonly packet: MemoryWriteJoinPacket;
    readonly deliveredAt: string | null;
}

function immutableJoinDigest(value: MemoryWriteJoinPacket): string {
    const { readbackDigest, verifiedAt, rollbackDigest, rolledBackAt, events, packetDigest, ...base } = value;
    return memoryWriteDigest(base);
}

/** Optional metadata in the existing Session control table; no schema creation or business writer. */
export class MaintenanceMemoryWriteJoinOutbox {
    constructor(private readonly memory: { db: DatabaseSync; transaction<T>(work: () => T): T; },
        private readonly sessionId: string) { }

    #key(runId: string): string {
        if (!/^mjob_[a-f0-9]{32}$/u.test(runId)) throw new Error('memory-write-join-run-invalid');
        return `${MEMORY_WRITE_JOIN_PREFIX}${runId}`;
    }

    #read(runId: string): JoinRecord | null {
        const row = this.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, this.#key(runId)) as { value: string; } | undefined;
        if (!row) return null;
        if (row.value.length > MAX_JOIN_CHARS) throw new Error('memory-write-join-too-large');
        const value = JSON.parse(row.value) as JoinRecord;
        const normalized: JoinRecord = {
            journalVersion: 'maintenance-memory-write-join-journal-v1',
            packet: normalizePacket(value.packet), deliveredAt: value.deliveredAt === null
                ? null : agentClosureTimestamp(value.deliveredAt, 'join-delivered-at')
        };
        if (normalized.packet.run.runId !== runId || normalized.packet.run.sessionId !== this.sessionId
            || JSON.stringify(normalized) !== row.value) throw new Error('memory-write-join-journal-corrupt');
        return Object.freeze(normalized);
    }

    #transaction<T>(work: () => T): T {
        if (this.memory.db.isTransaction !== false) throw new Error('memory-write-join-outer-transaction');
        const result = this.memory.transaction(() => {
            if (this.memory.db.isTransaction !== true) throw new Error('memory-write-join-transaction-required');
            return work();
        });
        if (this.memory.db.isTransaction !== false) throw new Error('memory-write-join-outer-transaction');
        return result;
    }

    stage(source: MaintenanceMemorySkillOutboxEntry, proposal: MaintenanceMemoryWriteProposal,
        evidence: MemoryWriteHistoricalEvidence): MemoryWriteJoinPacket {
        const expected = buildMaintenanceMemoryWriteJoin(source, proposal, evidence);
        if (expected.run.sessionId !== this.sessionId) throw new Error('memory-write-join-session-mismatch');
        return this.#transaction(() => {
            const prior = this.#read(expected.run.runId);
            if (prior?.packet.packetDigest === expected.packetDigest) return prior.packet;
            if (prior) {
                const before = prior.packet;
                if (immutableJoinDigest(before) !== immutableJoinDigest(expected)
                    || (before.rollbackDigest !== null && before.rollbackDigest !== expected.rollbackDigest)
                    || (before.rolledBackAt !== null && before.rolledBackAt !== expected.rolledBackAt)
                    || (before.readbackDigest !== null && before.readbackDigest !== expected.readbackDigest)
                    || (before.verifiedAt !== null && before.verifiedAt !== expected.verifiedAt)) {
                    throw new Error('memory-write-join-intent-conflict');
                }
            }
            const json = JSON.stringify({
                journalVersion: 'maintenance-memory-write-join-journal-v1',
                packet: expected, deliveredAt: null
            });
            if (json.length > MAX_JOIN_CHARS) throw new Error('memory-write-join-too-large');
            this.memory.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
                .run(this.sessionId, this.#key(expected.run.runId), json,
                    expected.rolledBackAt ?? expected.verifiedAt ?? expected.committedAt);
            if (this.#read(expected.run.runId)?.packet.packetDigest !== expected.packetDigest) {
                throw new Error('memory-write-join-storage-mismatch');
            }
            return expected;
        });
    }

    delivered(value: MemoryWriteJoinPacket): boolean {
        const expected = normalizePacket(value);
        return this.#transaction(() => {
            const row = this.#read(expected.run.runId);
            return row?.packet.packetDigest === expected.packetDigest && row.deliveredAt !== null;
        });
    }

    acknowledge(value: MemoryWriteJoinPacket, at: string): void {
        const expected = normalizePacket(value);
        const deliveredAt = agentClosureTimestamp(at, 'join-delivered-at');
        this.#transaction(() => {
            const row = this.#read(expected.run.runId);
            if (!row || row.packet.packetDigest !== expected.packetDigest) {
                throw new Error('memory-write-join-ack-conflict');
            }
            const json = JSON.stringify({ ...row, deliveredAt: row.deliveredAt ?? deliveredAt });
            this.memory.db.prepare(`UPDATE session_control SET value=?,updated_at=?
                WHERE session_key=? AND control_key=?`)
                .run(json, deliveredAt, this.sessionId, this.#key(expected.run.runId));
            if (this.#read(expected.run.runId)?.deliveredAt !== (row.deliveredAt ?? deliveredAt)) {
                throw new Error('memory-write-join-ack-unavailable');
            }
        });
    }
}
