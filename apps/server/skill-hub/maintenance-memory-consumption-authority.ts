/** @author Codex @date 2026-10-14 @version 1.0
 * One-shot host authority joining retained Memory facts to original verified Skill writes.
 */
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken, normalizeAgentClosureEvent,
} from '../../../packages/agent-closure/index.ts';
import { memoryConsumptionEventKey, type MemoryConsumptionPayload, type MemoryConsumptionPreparation }
    from '../../../packages/memory/public/maintenance-memory-consumption-outbox.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { buildMaintenanceMemoryWriteJoin, type MemoryWriteJoinPacket } from '../maintenance-memory-write-join.ts';
import type {
    MemorySummaryMaintenanceCommitter, MemoryWriteHistoricalEvidence,
} from '../memory-summary-maintenance-committer.ts';
import { maintenanceMemorySkillDigest } from './maintenance-memory-proposal-proof.ts';

interface RetainedHit {
    readonly rowId: number;
    readonly code: string;
    readonly contentDigest: string;
}

export interface MemoryConsumptionPrepareInput {
    readonly rawSessionId: string;
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly carrierDigest: string;
    readonly hits: readonly RetainedHit[];
}

export interface MemoryConsumptionCommitInput {
    readonly rawSessionId: string;
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly preparation: MemoryConsumptionPreparation;
    readonly carrierDigest: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly historyEpoch: number;
    readonly occurredAt: string;
}

interface PreparedClaim {
    readonly packet: MemoryWriteJoinPacket;
    readonly sourcePayloadDigest: string;
    readonly proofDigest: string;
    readonly attribution: MemoryConsumptionPayload['event']['skillAttribution'];
}

interface PreparedBinding {
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly carrierDigest: string;
    readonly hits: readonly RetainedHit[];
    readonly claims: readonly PreparedClaim[];
}

const MAX_CLAIMS = 8;

/** Ports are synchronous trusted readers. Disk metadata can never recover a live handle. */
export class MaintenanceMemoryConsumptionAuthority {
    readonly #handles = new WeakMap<object, PreparedBinding>();

    constructor(private readonly input: {
        readonly sessionId: string;
        readonly manager: Pick<MaintenanceJobManager, 'readMemorySkillProvenance' | 'getMemoryWriteProposalForJob'>;
        readonly committer: Pick<MemorySummaryMaintenanceCommitter,
            'readMemoryRetrievalLineage' | 'readMemoryRetrievalLineageInTransaction'>;
        readonly allowed: (mode: 'nsf' | 'nsfw', consumerRunId: string) => boolean;
    }) { }

    #requireAllowed(sessionId: string, mode: 'nsf' | 'nsfw', consumerRunId: string): void {
        if (sessionId !== this.input.sessionId || !['nsf', 'nsfw'].includes(mode)
            || !this.input.allowed(mode, consumerRunId)) throw new Error('memory-consumption-host-fenced');
        agentClosureToken(consumerRunId, 'memory-consumer-run');
    }

    #claim(history: MemoryWriteHistoricalEvidence, mode: 'nsf' | 'nsfw', consumerRunId: string): PreparedClaim {
        const source = this.input.manager.readMemorySkillProvenance(history.intent.runId);
        const proposal = this.input.manager.getMemoryWriteProposalForJob(history.intent.runId);
        if (!source || !proposal || source.run.sessionId !== this.input.sessionId
            || source.proof.contentMode !== mode || source.run.runId === consumerRunId
            || source.proof.parentRunId === consumerRunId || history.state !== 'applied' || !history.readback) {
            throw new Error('memory-consumption-source-unavailable');
        }
        const packet = buildMaintenanceMemoryWriteJoin(source, proposal, history);
        if (packet.readbackDigest !== history.readback.readbackDigest || packet.rollbackDigest !== null
            || packet.events.length !== 5) throw new Error('memory-consumption-write-unverified');
        return Object.freeze({
            packet, sourcePayloadDigest: source.payloadDigest,
            proofDigest: source.proof.proofDigest, attribution: source.proof.attribution
        });
    }

    prepare(input: MemoryConsumptionPrepareInput): MemoryConsumptionPreparation | null {
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        const carrierDigest = agentClosureDigest(input.carrierDigest, 'memory-carrier-digest');
        if (!Array.isArray(input.hits) || input.hits.length < 1 || input.hits.length > 128) return null;
        const hits = Object.freeze(input.hits.map((hit) => Object.freeze({
            rowId: hit.rowId, code: hit.code,
            contentDigest: agentClosureDigest(hit.contentDigest, 'memory-content-digest'),
        })));
        const histories = this.input.committer.readMemoryRetrievalLineage(hits);
        const claims: PreparedClaim[] = [];
        for (const history of histories) {
            if (claims.length >= MAX_CLAIMS) break;
            try { claims.push(this.#claim(history, input.contentMode, input.consumerRunId)); }
            catch { /* An ineligible old source does not obscure a different exact verified write. */ }
        }
        if (claims.length === 0) return null;
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        const handle = Object.freeze({}) as MemoryConsumptionPreparation;
        this.#handles.set(handle, Object.freeze({
            consumerRunId: input.consumerRunId,
            contentMode: input.contentMode, carrierDigest, hits, claims: Object.freeze(claims)
        }));
        return handle;
    }

    /** Called inside the successful main-turn transaction, after the real assistant row exists. */
    commit(input: MemoryConsumptionCommitInput): readonly MemoryConsumptionPayload[] {
        const binding = this.#handles.get(input.preparation);
        this.#handles.delete(input.preparation);
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        if (!binding || input.consumerRunId !== binding.consumerRunId || input.contentMode !== binding.contentMode
            || input.carrierDigest !== binding.carrierDigest) throw new Error('memory-consumption-handle-invalid');
        const at = agentClosureTimestamp(input.occurredAt, 'memory-consumption-at');
        const assistantDigest = agentClosureDigest(input.assistantDigest, 'memory-assistant-digest');
        if (!Number.isSafeInteger(input.round) || input.round < 1
            || !Number.isSafeInteger(input.assistantMessageId) || input.assistantMessageId < 1
            || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0) {
            throw new Error('memory-consumption-consumer-invalid');
        }
        const histories = this.input.committer.readMemoryRetrievalLineageInTransaction(binding.hits);
        const current = new Map(histories.map((history) => [history.intent.runId, history]));
        const payloads: MemoryConsumptionPayload[] = [];
        for (const original of binding.claims) {
            const history = current.get(original.packet.run.runId);
            if (!history) continue;
            try {
                const claim = this.#claim(history, input.contentMode, input.consumerRunId);
                if (maintenanceMemorySkillDigest(claim) !== maintenanceMemorySkillDigest(original)
                    || at < claim.packet.verifiedAt!) continue;
                payloads.push(Object.freeze({
                    version: 'maintenance-memory-consumption-v1', contentMode: input.contentMode, run: claim.packet.run,
                    prerequisites: claim.packet.events, sourcePayloadDigest: claim.sourcePayloadDigest,
                    proofDigest: claim.proofDigest, writeJoinDigest: claim.packet.packetDigest,
                    intentDigest: claim.packet.intentDigest, carrierDigest: binding.carrierDigest,
                    consumer: Object.freeze({
                        runId: input.consumerRunId, round: input.round,
                        assistantMessageId: input.assistantMessageId, assistantDigest,
                        historyEpoch: input.historyEpoch
                    }),
                    event: normalizeAgentClosureEvent({
                        type: 'context-consumed', idempotencyKey: memoryConsumptionEventKey(input.consumerRunId),
                        occurredAt: at, artifactDigest: claim.packet.readbackDigest!,
                        evidenceRef: claim.packet.proposalId, sourceRevision: claim.packet.run.sourceRevision,
                        targetRevision: claim.packet.targetRevision, consumerRunId: input.consumerRunId,
                        contextBlock: 'memory', itemCount: history.intent.facts.length,
                        skillAttribution: claim.attribution,
                    }),
                }));
            } catch { /* Changed source or business truth stays unproven, never repaired from later facts. */ }
        }
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        return Object.freeze(payloads);
    }
}
