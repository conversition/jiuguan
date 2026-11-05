/** @author Codex @date 2026-10-13 @version 1.0
 * Consumption evidence must remain bound to the business transaction and final artifact.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
    AgentSkillConsumptionOutbox,
    AgentSkillConsumptionOutboxPayloadV1,
    AgentSkillConsumptionEvidenceBindingV1,
} from '../../memory/public/agent-skill-consumption-outbox.ts';
import { bindAgentSkillConsumptionEvidence } from '../../memory/public/agent-skill-consumption-outbox.ts';

export interface AgentSkillCommitExpectation {
    readonly sessionId: string;
    readonly runId: string;
    readonly operationId: string;
    readonly sourceRevision: string;
    readonly capability: 'context.compiler' | 'interactive.critic' | 'interactive.prelude';
    readonly artifactDigest: string;
    readonly contextBlock: 'contextCapsule' | 'criticRevision' | 'interactivePrelude';
    readonly tokenCount?: number;
    readonly policyVersion?: string;
}

/** Session owns adoption; a server receipt cannot attest another turn or artifact. */
export function assertAgentSkillCommitBinding(
    payload: AgentSkillConsumptionOutboxPayloadV1,
    expected: AgentSkillCommitExpectation,
): void {
    const { run, event } = payload;
    if (run.sessionId !== expected.sessionId || run.runId !== expected.runId
        || run.operationId !== expected.operationId || run.sourceRevision !== expected.sourceRevision
        || run.capability !== expected.capability || run.kind !== 'advisory' || run.lane !== 'interactive'
        || (expected.policyVersion !== undefined && run.policyVersion !== expected.policyVersion)
        || event.type !== 'context-consumed' || event.sourceRevision !== run.sourceRevision
        || event.consumerRunId !== run.runId || event.artifactDigest !== expected.artifactDigest
        || event.contextBlock !== expected.contextBlock || event.tokenCount !== expected.tokenCount
        || event.idempotencyKey !== `consumed-${run.runId}` || !event.skillAttribution) {
        throw new Error('skill-consumption-turn-binding-mismatch');
    }
}

/** Optional evidence stays isolated; required live consumption must fail the original outer transaction. */
export function enqueueAgentSkillConsumption(
    db: DatabaseSync,
    outbox: AgentSkillConsumptionOutbox,
    payload: AgentSkillConsumptionOutboxPayloadV1,
    warn: () => void,
    evidenceBinding?: AgentSkillConsumptionEvidenceBindingV1,
    required = false,
): boolean {
    if (!db.isTransaction) throw new Error('skill-consumption-outer-transaction-required');
    let outgoing = payload;
    if (evidenceBinding) {
        try { outgoing = bindAgentSkillConsumptionEvidence(payload, evidenceBinding); }
        catch {
            if (required) throw new Error('skill-consumption-evidence-binding-failed');
            // New evidence metadata is optional; malformed binding cannot remove a valid original receipt.
            try { warn(); } catch { /* Diagnostics cannot grant or revoke a business commit. */ }
        }
    }
    db.exec('SAVEPOINT agent_skill_consumption');
    try {
        outbox.enqueue(outgoing);
        db.exec('RELEASE agent_skill_consumption');
        if (!db.isTransaction) throw new Error('skill-consumption-outer-transaction-lost');
        return true;
    } catch (error) {
        if (!db.isTransaction) throw error;
        db.exec('ROLLBACK TO agent_skill_consumption; RELEASE agent_skill_consumption');
        if (required) throw new Error('skill-consumption-enqueue-failed');
        try { warn(); } catch { /* Diagnostics cannot turn an isolated sidecar failure into a business failure. */ }
        return false;
    }
}
