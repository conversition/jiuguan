/** @author Codex @date 2026-10-14 @version 1.0
 * Summary task provenance joined only to immutable, post-COMMIT business history.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureOperationId, agentClosureTimestamp, agentClosureToken,
    executionClassForMaintenanceTrigger, normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../packages/agent-closure/index.ts';
import {
    parseMaintenanceSummarySkillProposalRecord, parseMaintenanceSummarySkillSourceEntry,
    type MaintenanceSummarySkillProposalRecord, type MaintenanceSummarySkillSourceEntry,
} from './maintenance-summary-skill-source.ts';
import {
    parseSummaryWriteIntent, parseSummaryWriteReadback, summaryWriteDigest,
} from './maintenance-summary-write-receipt.ts';
import type { SummaryWriteHistoricalEvidence } from './memory-summary-maintenance-committer.ts';
import { isRollingSummaryApplyContext } from './memory-summary-maintenance-types.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';

export const SUMMARY_WRITE_JOIN_PREFIX = 'maintenance_summary_write_join:';
const MAX_JOIN_CHARS = 32_768;

interface SummaryJoinMetadata {
    readonly version: 'maintenance-summary-write-join-v1';
    readonly run: AgentClosureRunInput;
    readonly sourcePayloadDigest: string;
    readonly recordDigest: string;
    readonly proofDigest: string;
    readonly proposalDigest: string;
    readonly proposalId: string;
    readonly persistedAt: string;
    readonly itemCount: number;
    readonly sourceEvents: readonly AgentClosureEventInput[];
    readonly intentDigest: string | null;
    readonly targetRevision: string | null;
    readonly committedAt: string | null;
    readonly readbackDigest: string | null;
    readonly verifiedAt: string | null;
    readonly rollbackDigest: string | null;
    readonly rolledBackAt: string | null;
    readonly terminalEvent: AgentClosureEventInput | null;
}

export interface SummaryWriteJoinPacket extends SummaryJoinMetadata {
    readonly events: readonly AgentClosureEventInput[];
    readonly packetDigest: string;
}


function packet(input: SummaryJoinMetadata): SummaryWriteJoinPacket {
    const run = normalizeAgentClosureRun(input.run);
    if (input.version !== 'maintenance-summary-write-join-v1' || run.capability !== 'maintenance.memory'
        || run.kind !== 'proposal' || run.lane !== 'maintenance' || !/^mjob_[a-f0-9]{32}$/u.test(run.runId)
        || run.operationId !== agentClosureOperationId('maintenance', run.runId, 'rolling_summary')
        || ![`sdprop_${run.runId.slice(5)}`, `mprop_${run.runId.slice(5)}`].includes(input.proposalId)
        || !Number.isSafeInteger(input.itemCount) || input.itemCount < 0
        || !Array.isArray(input.sourceEvents) || input.sourceEvents.length !== 3) {
        throw new Error('summary-write-join-metadata-invalid');
    }
    const digestOrNull = (value: string | null, label: string) => value === null
        ? null : agentClosureDigest(value, label);
    const timeOrNull = (value: string | null, label: string) => value === null
        ? null : agentClosureTimestamp(value, label);
    const persistedAt = agentClosureTimestamp(input.persistedAt, 'summary-persisted-at');
    const proposalDigest = agentClosureDigest(input.proposalDigest, 'summary-proposal-digest');
    const proposalId = agentClosureToken(input.proposalId, 'summary-proposal-id');
    const sourceEvents = [
        {
            type: 'execution-completed', idempotencyKey: 'execution-completed',
            occurredAt: agentClosureTimestamp(input.sourceEvents[0]?.occurredAt, 'summary-executed-at'),
            sourceRevision: run.sourceRevision
        },
        {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: persistedAt,
            artifactDigest: proposalDigest, evidenceRef: proposalId, sourceRevision: run.sourceRevision
        },
        {
            type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: persistedAt,
            artifactDigest: proposalDigest, sourceRevision: run.sourceRevision, itemCount: input.itemCount
        },
    ].map((event) => normalizeAgentClosureEvent(event as AgentClosureEventInput));
    if (JSON.stringify(sourceEvents) !== JSON.stringify(input.sourceEvents)) {
        throw new Error('summary-write-join-source-events-invalid');
    }
    const metadata: SummaryJoinMetadata = {
        version: input.version, run,
        sourcePayloadDigest: agentClosureDigest(input.sourcePayloadDigest, 'summary-source-payload-digest'),
        recordDigest: agentClosureDigest(input.recordDigest, 'summary-record-digest'),
        proofDigest: agentClosureDigest(input.proofDigest, 'summary-proof-digest'), proposalDigest, proposalId,
        persistedAt, itemCount: input.itemCount, sourceEvents: Object.freeze(sourceEvents),
        intentDigest: digestOrNull(input.intentDigest, 'summary-intent-digest'),
        targetRevision: digestOrNull(input.targetRevision, 'summary-target-revision'),
        committedAt: timeOrNull(input.committedAt, 'summary-committed-at'),
        readbackDigest: digestOrNull(input.readbackDigest, 'summary-readback-digest'),
        verifiedAt: timeOrNull(input.verifiedAt, 'summary-verified-at'),
        rollbackDigest: digestOrNull(input.rollbackDigest, 'summary-rollback-digest'),
        rolledBackAt: timeOrNull(input.rolledBackAt, 'summary-rolled-back-at'),
        terminalEvent: input.terminalEvent === null ? null : normalizeAgentClosureEvent(input.terminalEvent),
    };
    if (run.admittedAt > sourceEvents[0]!.occurredAt || sourceEvents[0]!.occurredAt > persistedAt
        || (metadata.intentDigest === null) !== (metadata.targetRevision === null)
        || (metadata.intentDigest === null) !== (metadata.committedAt === null)
        || (metadata.readbackDigest === null) !== (metadata.verifiedAt === null)
        || (metadata.rollbackDigest === null) !== (metadata.rolledBackAt === null)
        || (metadata.committedAt === null && (metadata.readbackDigest !== null || metadata.rollbackDigest !== null))
        || (metadata.committedAt !== null && persistedAt > metadata.committedAt)
        || (metadata.verifiedAt !== null && metadata.verifiedAt < metadata.committedAt!)
        || (metadata.rolledBackAt !== null
            && metadata.rolledBackAt < (metadata.verifiedAt ?? metadata.committedAt!))
        || (metadata.terminalEvent !== null && (metadata.committedAt !== null
            || !['rejected', 'stale'].includes(metadata.terminalEvent.type)
            || metadata.terminalEvent.idempotencyKey !== `proposal-${metadata.terminalEvent.type}`
            || metadata.terminalEvent.occurredAt < persistedAt
            || JSON.stringify(metadata.terminalEvent) !== JSON.stringify({
                type: metadata.terminalEvent.type, idempotencyKey: metadata.terminalEvent.idempotencyKey,
                occurredAt: metadata.terminalEvent.occurredAt, reasonCode: metadata.terminalEvent.reasonCode,
            })))) {
        throw new Error('summary-write-join-chronology-invalid');
    }
    const events = [...sourceEvents];
    if (metadata.committedAt !== null) events.push(normalizeAgentClosureEvent({
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: metadata.committedAt,
        artifactDigest: proposalDigest, evidenceRef: proposalId, targetRevision: metadata.targetRevision!,
    }));
    if (metadata.readbackDigest !== null) events.push(normalizeAgentClosureEvent({
        type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: metadata.verifiedAt!,
        artifactDigest: metadata.readbackDigest, evidenceRef: proposalId, targetRevision: metadata.targetRevision!,
    }));
    if (metadata.rollbackDigest !== null) events.push(normalizeAgentClosureEvent({
        type: 'rolled-back', idempotencyKey: 'proposal-rolled-back', occurredAt: metadata.rolledBackAt!,
        artifactDigest: metadata.rollbackDigest, evidenceRef: proposalId, reasonCode: 'operator-rolled-back',
    }));
    if (metadata.terminalEvent !== null) events.push(metadata.terminalEvent);
    const value = { ...metadata, events: Object.freeze(events) };
    return Object.freeze({ ...value, packetDigest: summaryWriteDigest(value) });
}


export function parseMaintenanceSummaryWriteJoin(value: unknown): SummaryWriteJoinPacket {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary-write-join-invalid');
    const result = packet(value as SummaryJoinMetadata);
    if (JSON.stringify(result) !== JSON.stringify(value)) throw new Error('summary-write-join-corrupt');
    return result;
}


/** A prepared/pending task proves validation only; a missing history is never reconstructed from longterm. */
export function buildMaintenanceSummaryWriteJoin(sourceValue: MaintenanceSummarySkillSourceEntry,
    recordValue: MaintenanceSummarySkillProposalRecord,
    evidence: SummaryWriteHistoricalEvidence | null,
    pending?: MaintenancePendingProposalRecord | null): SummaryWriteJoinPacket {
    const source = parseMaintenanceSummarySkillSourceEntry(sourceValue);
    const record = parseMaintenanceSummarySkillProposalRecord(recordValue);
    const proof = source.proof;
    if (source.recordDigest !== record.recordDigest || record.proofDigest !== proof.proofDigest
        || record.jobRunId !== proof.runId || record.sessionId !== proof.sessionId
        || record.sourceRevision !== proof.sourceRevision || record.proposalDigest !== proof.proposalDigest
        || record.attempt !== proof.attempt || record.policyVersion !== proof.policyVersion
        || record.parentRunId !== proof.parentRunId || record.createdAt < proof.validatedAt
        || source.run.runId !== record.jobRunId || source.run.sessionId !== record.sessionId
        || source.run.sourceRevision !== record.sourceRevision || source.run.policyVersion !== record.policyVersion
        || (source.run.parentRunId ?? source.run.runId) !== record.parentRunId
        || source.run.admittedAt !== record.jobCreatedAt || source.run.admittedAt > proof.admittedAt
        || source.run.executionClass !== executionClassForMaintenanceTrigger(record.trigger)
        || source.events[0]?.occurredAt !== (record.status === 'pending' ? record.createdAt : proof.executedAt)
        || summaryWriteDigest(record.proposal) !== record.proposalDigest
        || summaryWriteDigest(record.context) !== proof.proposalContextDigest
        || !isRollingSummaryApplyContext(record.context)) {
        throw new Error('summary-write-join-source-identity-mismatch');
    }
    const intent = evidence === null ? null : parseSummaryWriteIntent(evidence.intent);
    const readback = evidence?.readback ? parseSummaryWriteReadback(evidence.readback) : null;
    if (intent && (intent.runId !== record.jobRunId || intent.sessionId !== record.sessionId
        || intent.sourceRevision !== record.sourceRevision || intent.proposalDigest !== record.proposalDigest
        || intent.throughRound !== record.proposal.payload.throughRound
        || intent.summaryDigest !== summaryWriteDigest(record.proposal.payload.summary)
        || intent.historyEpoch !== record.context.historyEpoch
        || !['applied', 'rolled_back'].includes(evidence!.state))) {
        throw new Error('summary-write-join-business-identity-mismatch');
    }
    if (readback && (!intent || readback.runId !== intent.runId || readback.sessionId !== intent.sessionId
        || readback.sourceRevision !== intent.sourceRevision || readback.proposalDigest !== intent.proposalDigest
        || readback.targetRevision !== intent.targetRevision || readback.intentDigest !== intent.intentDigest
        || readback.committedAt !== intent.committedAt || readback.truthVersion !== intent.truthVersion
        || readback.historyEpoch !== intent.historyEpoch || readback.throughRound !== intent.throughRound
        || readback.summaryDigest !== intent.summaryDigest
        || readback.projectionDigest !== summaryWriteDigest({
            operationDigest: intent.operationDigest,
            throughRound: intent.throughRound, summaryDigest: intent.summaryDigest,
            truthVersion: intent.truthVersion, historyEpoch: intent.historyEpoch
        }))) {
        throw new Error('summary-write-join-readback-mismatch');
    }
    const updatedAt = evidence === null ? null : agentClosureTimestamp(evidence.updatedAt, 'summary-updated-at');
    if (intent && (updatedAt! < intent.committedAt
        || (readback && evidence!.state === 'rolled_back' && updatedAt! < readback.verifiedAt)
        || (evidence!.state === 'applied' && evidence!.rollbackDigest !== undefined))) {
        throw new Error('summary-write-join-history-state-mismatch');
    }
    return packet({
        version: 'maintenance-summary-write-join-v1', run: source.run,
        sourcePayloadDigest: source.payloadDigest, recordDigest: record.recordDigest,
        proofDigest: proof.proofDigest, proposalDigest: record.proposalDigest, proposalId: record.proposalId,
        persistedAt: record.createdAt, itemCount: Number(record.diff.itemCount), sourceEvents: source.events,
        intentDigest: intent?.intentDigest ?? null, targetRevision: intent?.targetRevision ?? null,
        committedAt: intent?.committedAt ?? null, readbackDigest: readback?.readbackDigest ?? null,
        verifiedAt: readback?.verifiedAt ?? null,
        rollbackDigest: evidence?.state === 'rolled_back' ? evidence.rollbackDigest! : null,
        rolledBackAt: evidence?.state === 'rolled_back' ? updatedAt : null,
        terminalEvent: evidence === null ? summaryTerminalEvent(record, pending) : null,
    });
}


function summaryTerminalEvent(record: MaintenanceSummarySkillProposalRecord,
    pending: MaintenancePendingProposalRecord | null | undefined): AgentClosureEventInput | null {
    if (!pending) return null;
    if (record.status !== 'pending' || pending.proposalId !== record.proposalId
        || pending.jobRunId !== record.jobRunId || pending.sessionId !== record.sessionId
        || pending.taskKind !== record.taskKind || pending.sourceRevision !== record.sourceRevision
        || pending.proposalDigest !== record.proposalDigest || pending.createdAt !== record.createdAt
        || JSON.stringify(pending.proposal) !== JSON.stringify(record.proposal)
        || JSON.stringify(pending.context) !== JSON.stringify(record.context)) {
        throw new Error('summary-write-join-pending-identity-mismatch');
    }
    if (pending.status !== 'rejected' && pending.status !== 'stale') return null;
    const fallback = pending.status === 'rejected' ? 'proposal-rejected' : 'source-revision-stale';
    const candidate = String(pending.decisionReason ?? fallback).toLowerCase()
        .replace(/[^a-z0-9-]+/gu, '-').replace(/^-+/u, '').replace(/-+/gu, '-').slice(0, 80);
    return normalizeAgentClosureEvent({
        type: pending.status, idempotencyKey: `proposal-${pending.status}`,
        occurredAt: agentClosureTimestamp(pending.updatedAt, 'summary-terminal-at'),
        reasonCode: /^[a-z][a-z0-9-]{0,79}$/u.test(candidate) ? candidate : fallback
    });
}


interface SummaryJoinRecord {
    readonly journalVersion: 'maintenance-summary-write-join-journal-v1';
    readonly packet: SummaryWriteJoinPacket;
    readonly deliveredAt: string | null;
}


function sourceIdentity(value: SummaryWriteJoinPacket): string {
    const { intentDigest, targetRevision, committedAt, readbackDigest, verifiedAt, rollbackDigest,
        rolledBackAt, terminalEvent, events, packetDigest, ...source } = value;
    return summaryWriteDigest(source);
}


/** Existing Session control metadata only; opening this adapter never creates a schema or business write. */
export class MaintenanceSummaryWriteJoinOutbox {
    constructor(private readonly memory: { db: DatabaseSync; transaction<T>(work: () => T): T; },
        private readonly sessionId: string) { }

    #key(runId: string): string {
        if (!/^mjob_[a-f0-9]{32}$/u.test(runId)) throw new Error('summary-write-join-run-invalid');
        return `${SUMMARY_WRITE_JOIN_PREFIX}${runId}`;
    }

    #read(runId: string): SummaryJoinRecord | null {
        const row = this.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.sessionId, this.#key(runId)) as { value: string; } | undefined;
        if (!row) return null;
        if (row.value.length > MAX_JOIN_CHARS) throw new Error('summary-write-join-too-large');
        const value = JSON.parse(row.value) as SummaryJoinRecord;
        const normalized: SummaryJoinRecord = {
            journalVersion: 'maintenance-summary-write-join-journal-v1',
            packet: parseMaintenanceSummaryWriteJoin(value.packet), deliveredAt: value.deliveredAt === null
                ? null : agentClosureTimestamp(value.deliveredAt, 'summary-join-delivered-at'),
        };
        if (normalized.packet.run.runId !== runId || normalized.packet.run.sessionId !== this.sessionId
            || JSON.stringify(normalized) !== row.value) throw new Error('summary-write-join-journal-corrupt');
        return Object.freeze(normalized);
    }

    #transaction<T>(work: () => T): T {
        if (this.memory.db.isTransaction !== false) throw new Error('summary-write-join-outer-transaction');
        const result = this.memory.transaction(() => {
            if (this.memory.db.isTransaction !== true) throw new Error('summary-write-join-transaction-required');
            return work();
        });
        if (this.memory.db.isTransaction !== false) throw new Error('summary-write-join-outer-transaction');
        return result;
    }

    stage(source: MaintenanceSummarySkillSourceEntry, record: MaintenanceSummarySkillProposalRecord,
        evidence: SummaryWriteHistoricalEvidence | null,
        pending?: MaintenancePendingProposalRecord | null): SummaryWriteJoinPacket {
        const expected = buildMaintenanceSummaryWriteJoin(source, record, evidence, pending);
        if (expected.run.sessionId !== this.sessionId) throw new Error('summary-write-join-session-mismatch');
        return this.#transaction(() => {
            const prior = this.#read(expected.run.runId);
            if (prior?.packet.packetDigest === expected.packetDigest) return prior.packet;
            if (prior) {
                if (sourceIdentity(prior.packet) !== sourceIdentity(expected)) {
                    throw new Error('summary-write-join-source-conflict');
                }
                for (const key of ['intentDigest', 'targetRevision', 'committedAt', 'readbackDigest', 'verifiedAt',
                    'rollbackDigest', 'rolledBackAt'] as const) {
                    if (prior.packet[key] !== null && prior.packet[key] !== expected[key]) {
                        throw new Error('summary-write-join-intent-conflict');
                    }
                }
                if (prior.packet.terminalEvent !== null
                    && JSON.stringify(prior.packet.terminalEvent) !== JSON.stringify(expected.terminalEvent)) {
                    throw new Error('summary-write-join-terminal-conflict');
                }
            }
            const json = JSON.stringify({
                journalVersion: 'maintenance-summary-write-join-journal-v1',
                packet: expected, deliveredAt: null
            });
            if (json.length > MAX_JOIN_CHARS) throw new Error('summary-write-join-too-large');
            this.memory.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at)
                VALUES(?,?,?,?) ON CONFLICT(session_key,control_key)
                DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
                .run(this.sessionId, this.#key(expected.run.runId), json,
                    expected.terminalEvent?.occurredAt ?? expected.rolledBackAt ?? expected.verifiedAt
                    ?? expected.committedAt ?? expected.persistedAt);
            if (this.#read(expected.run.runId)?.packet.packetDigest !== expected.packetDigest) {
                throw new Error('summary-write-join-storage-mismatch');
            }
            return expected;
        });
    }

    delivered(value: SummaryWriteJoinPacket): boolean {
        const expected = parseMaintenanceSummaryWriteJoin(value);
        return this.#transaction(() => {
            const row = this.#read(expected.run.runId);
            return row?.packet.packetDigest === expected.packetDigest && row.deliveredAt !== null;
        });
    }

    acknowledge(value: SummaryWriteJoinPacket, at: string): void {
        const expected = parseMaintenanceSummaryWriteJoin(value);
        const deliveredAt = agentClosureTimestamp(at, 'summary-join-delivered-at');
        const latest = expected.terminalEvent?.occurredAt ?? expected.rolledBackAt ?? expected.verifiedAt
            ?? expected.committedAt ?? expected.persistedAt;
        if (deliveredAt < latest) throw new Error('summary-write-join-ack-chronology-invalid');
        this.#transaction(() => {
            const row = this.#read(expected.run.runId);
            if (!row || row.packet.packetDigest !== expected.packetDigest) {
                throw new Error('summary-write-join-ack-conflict');
            }
            const stableAt = row.deliveredAt ?? deliveredAt;
            const json = JSON.stringify({ ...row, deliveredAt: stableAt });
            this.memory.db.prepare(`UPDATE session_control SET value=?,updated_at=?
                WHERE session_key=? AND control_key=?`).run(json, stableAt, this.sessionId,
                this.#key(expected.run.runId));
            if (this.#read(expected.run.runId)?.deliveredAt !== stableAt) {
                throw new Error('summary-write-join-ack-unavailable');
            }
        });
    }
}
