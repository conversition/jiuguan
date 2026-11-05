/** @author Codex @date 2026-10-14 @version 1.0
 * One-shot Summary adoption authority, isolated from Memory facts and foreground summary producers.
 */
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken, normalizeAgentClosureEvent,
} from '../../../packages/agent-closure/index.ts';
import {
    summaryConsumptionEventKey, type SummaryConsumptionPayload, type SummaryConsumptionPreparation,
    type SummaryConsumptionSummary,
} from '../../../packages/memory/public/maintenance-summary-consumption-outbox.ts';
import type { MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { buildMaintenanceSummaryWriteJoin, type SummaryWriteJoinPacket }
    from '../maintenance-summary-write-join.ts';
import { summaryWriteDigest } from '../maintenance-summary-write-receipt.ts';
import type {
    MemorySummaryMaintenanceCommitter, SummaryWriteHistoricalEvidence,
} from '../memory-summary-maintenance-committer.ts';

export interface SummaryConsumptionPrepareInput {
    readonly rawSessionId: string;
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly carrierDigest: string;
    readonly summary: SummaryConsumptionSummary;
}

export interface SummaryConsumptionCommitInput {
    readonly rawSessionId: string;
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly preparation: SummaryConsumptionPreparation;
    readonly carrierDigest: string;
    readonly round: number;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly historyEpoch: number;
    readonly occurredAt: string;
}

interface PreparedClaim {
    readonly packet: SummaryWriteJoinPacket;
    readonly sourcePayloadDigest: string;
    readonly proofDigest: string;
    readonly attribution: SummaryConsumptionPayload['event']['skillAttribution'];
}

interface PreparedBinding {
    readonly consumerRunId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly carrierDigest: string;
    readonly summary: SummaryConsumptionSummary;
    readonly claim: PreparedClaim;
}


/** Ports are synchronous trusted readers. A disk receipt cannot recover a live preparation handle. */
export class MaintenanceSummaryConsumptionAuthority {
    readonly #handles = new WeakMap<object, PreparedBinding>();

    constructor(private readonly input: {
        readonly sessionId: string;
        readonly manager: Pick<MaintenanceJobManager, 'readSummarySkillProvenance' | 'getSummarySkillProposal'>;
        readonly committer: Pick<MemorySummaryMaintenanceCommitter,
            'readSummaryRetrievalLineage' | 'readSummaryRetrievalLineageInTransaction'>;
        readonly allowed: (mode: 'nsf' | 'nsfw', consumerRunId: string) => boolean;
    }) { }

    #requireAllowed(sessionId: string, mode: 'nsf' | 'nsfw', consumerRunId: string): void {
        if (sessionId !== this.input.sessionId || !['nsf', 'nsfw'].includes(mode)
            || !this.input.allowed(mode, consumerRunId)) throw new Error('summary-consumption-host-fenced');
        agentClosureToken(consumerRunId, 'summary-consumer-run');
    }

    #claim(history: SummaryWriteHistoricalEvidence, mode: 'nsf' | 'nsfw', consumerRunId: string): PreparedClaim {
        const source = this.input.manager.readSummarySkillProvenance(history.intent.runId);
        const proposal = this.input.manager.getSummarySkillProposal(history.intent.runId);
        if (!source || !proposal || source.run.sessionId !== this.input.sessionId
            || source.proof.contentMode !== mode || source.run.runId === consumerRunId
            || source.proof.parentRunId === consumerRunId || history.state !== 'applied' || !history.readback) {
            throw new Error('summary-consumption-source-unavailable');
        }
        const packet = buildMaintenanceSummaryWriteJoin(source, proposal, history);
        if (packet.readbackDigest !== history.readback.readbackDigest || packet.rollbackDigest !== null
            || packet.events.length !== 5) throw new Error('summary-consumption-write-unverified');
        return Object.freeze({
            packet, sourcePayloadDigest: source.payloadDigest,
            proofDigest: source.proof.proofDigest, attribution: source.proof.attribution,
        });
    }

    prepare(input: SummaryConsumptionPrepareInput): SummaryConsumptionPreparation | null {
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        const carrierDigest = agentClosureDigest(input.carrierDigest, 'summary-carrier-digest');
        const summary = Object.freeze({
            summaryDigest: agentClosureDigest(input.summary?.summaryDigest, 'summary-content-digest'),
            throughRound: input.summary?.throughRound, historyEpoch: input.summary?.historyEpoch,
        });
        const history = this.input.committer.readSummaryRetrievalLineage(summary);
        if (!history) return null;
        let claim: PreparedClaim;
        try { claim = this.#claim(history, input.contentMode, input.consumerRunId); }
        catch { return null; }
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        const handle = Object.freeze({}) as SummaryConsumptionPreparation;
        this.#handles.set(handle, Object.freeze({
            consumerRunId: input.consumerRunId, contentMode: input.contentMode, carrierDigest, summary, claim,
        }));
        return handle;
    }

    /** Called only inside the successful consumer turn transaction after the actual assistant row exists. */
    commit(input: SummaryConsumptionCommitInput): readonly SummaryConsumptionPayload[] {
        const binding = this.#handles.get(input.preparation);
        this.#handles.delete(input.preparation);
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        if (!binding || input.consumerRunId !== binding.consumerRunId || input.contentMode !== binding.contentMode
            || input.carrierDigest !== binding.carrierDigest) throw new Error('summary-consumption-handle-invalid');
        const at = agentClosureTimestamp(input.occurredAt, 'summary-consumption-at');
        const assistantDigest = agentClosureDigest(input.assistantDigest, 'summary-assistant-digest');
        if (!Number.isSafeInteger(input.round) || input.round <= binding.summary.throughRound
            || !Number.isSafeInteger(input.assistantMessageId) || input.assistantMessageId < 1
            || input.historyEpoch !== binding.summary.historyEpoch) {
            throw new Error('summary-consumption-consumer-invalid');
        }
        const history = this.input.committer.readSummaryRetrievalLineageInTransaction(binding.summary);
        if (!history || history.intent.runId !== binding.claim.packet.run.runId) return Object.freeze([]);
        let claim: PreparedClaim;
        try { claim = this.#claim(history, input.contentMode, input.consumerRunId); }
        catch { return Object.freeze([]); }
        if (summaryWriteDigest(claim) !== summaryWriteDigest(binding.claim)
            || at < claim.packet.verifiedAt!) return Object.freeze([]);
        this.#requireAllowed(input.rawSessionId, input.contentMode, input.consumerRunId);
        return Object.freeze([Object.freeze({
            version: 'maintenance-summary-consumption-v1' as const, contentMode: input.contentMode,
            run: claim.packet.run, prerequisites: claim.packet.events, sourcePayloadDigest: claim.sourcePayloadDigest,
            proofDigest: claim.proofDigest, writeJoinDigest: claim.packet.packetDigest,
            intentDigest: claim.packet.intentDigest!, carrierDigest: binding.carrierDigest, summary: binding.summary,
            consumer: Object.freeze({
                runId: input.consumerRunId, round: input.round, assistantMessageId: input.assistantMessageId,
                assistantDigest, historyEpoch: input.historyEpoch,
            }),
            event: normalizeAgentClosureEvent({
                type: 'context-consumed', idempotencyKey: summaryConsumptionEventKey(input.consumerRunId),
                occurredAt: at, artifactDigest: claim.packet.readbackDigest!, evidenceRef: claim.packet.proposalId,
                sourceRevision: claim.packet.run.sourceRevision, targetRevision: claim.packet.targetRevision!,
                consumerRunId: input.consumerRunId, contextBlock: 'summary', itemCount: 1,
                skillAttribution: claim.attribution,
            }),
        })]);
    }
}
