/** @author Codex @date 2026-10-13 @version 1.0
 * Attribute only the exact repair eventually adopted by the final turn.
 */
import { createHash } from 'node:crypto';
import { agentClosureOperationId, type AgentClosureExecutionClass, type AgentSkillClosureAttributionV1 }
    from '../../../packages/agent-closure/index.ts';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import { parseCriticInputManifest, type CriticInputManifestV1 } from '../../../packages/harness/public/critic-input.ts';
import { createCriticSkillSourceReceipt, CRITIC_SKILL_SOURCE_RECEIPT_VERSION, criticSkillSourceEvidenceDigest }
    from '../../../packages/memory/public/critic-skill-source.ts';
import { assertForegroundSourcePacketSize } from './foreground-source-packet.ts';
import type {
    AgentSkillConsumptionOutboxPayloadV1,
} from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import { agentSkillLiveEnabled, createServerAgentSkillLiveRequest } from './live-request.ts';
export {
    PRECOMMIT_CRITIC_VERSION as CRITIC_SKILL_POLICY_VERSION,
} from '../../../packages/agent-policy/public/precommit-critic.ts';

/** A pre-existing Context pilot must not silently opt another consumer into live prompts. */
export function criticSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_CRITIC_LIVE === '1';
}

export interface CriticSkillConsumptionIdentity {
    readonly rawSessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly draftDigest: string;
    readonly decisionDigest: string;
    readonly responseDigest: string;
    readonly artifactDigest: string;
    readonly payloadDigest?: string;
}

/** The frozen Critic contract permits exactly one repair per turn; this does not add retries. */
export function createCriticSkillLiveCall(input: {
    readonly broker: Parameters<typeof createServerAgentSkillLiveRequest>[0]['broker'];
    readonly policyVersion: string;
    readonly identity: Omit<CriticSkillConsumptionIdentity, 'responseDigest' | 'artifactDigest'>;
    readonly executionClass: AgentClosureExecutionClass;
    readonly authority: Parameters<typeof createServerAgentSkillLiveRequest>[0]['authority'];
    readonly nowMs?: () => number;
    readonly sourceManifest?: CriticInputManifestV1;
    readonly sourceRequest?: ChatRequest;
}) {
    const nowMs = input.nowMs ?? Date.now;
    const manifest = input.sourceManifest === undefined ? null : parseCriticInputManifest(input.sourceManifest);
    if ((manifest === null) !== (input.sourceRequest === undefined)) throw new Error('skill-critic-source-invalid');
    const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
    const payloadFor = (used: CriticSkillConsumptionIdentity, success: {
        readonly admittedAt: string; readonly executedAt: string;
        readonly attribution: AgentSkillClosureAttributionV1; readonly requestDigests: readonly string[];
    }, occurredAt: string): AgentSkillConsumptionOutboxPayloadV1 => Object.freeze({
        run: Object.freeze({
            operationId: agentClosureOperationId('interactive', used.runId, 'interactive.critic'),
            runId: used.runId, sessionId: used.rawSessionId, capability: 'interactive.critic', lane: 'interactive',
            kind: 'advisory', executionClass: input.executionClass, sourceRevision: used.sourceRevision,
            policyVersion: input.policyVersion, evidenceDigest: criticSkillSourceEvidenceDigest(used), admittedAt: success.admittedAt,
        }),
        event: Object.freeze({ type: 'context-consumed', idempotencyKey: `consumed-${used.runId}`, occurredAt,
            artifactDigest: used.artifactDigest, sourceRevision: used.sourceRevision, consumerRunId: used.runId,
            contextBlock: 'criticRevision', skillAttribution: success.attribution }),
        prerequisites: Object.freeze([
            Object.freeze({ type: 'execution-completed', idempotencyKey: 'execution-completed',
                occurredAt: success.executedAt, sourceRevision: used.sourceRevision }),
            Object.freeze({ type: 'artifact-validated', idempotencyKey: 'artifact-validated',
                occurredAt, sourceRevision: used.sourceRevision, artifactDigest: used.artifactDigest }),
        ]),
        ...(manifest ? { criticSource: createCriticSkillSourceReceipt({
            version: CRITIC_SKILL_SOURCE_RECEIPT_VERSION, manifest,
            sessionId: used.rawSessionId, runId: used.runId, sourceRevision: used.sourceRevision,
            policyVersion: input.policyVersion, draftDigest: used.draftDigest, decisionDigest: used.decisionDigest,
            requestDigest: success.requestDigests[0]!, responseDigest: used.responseDigest, artifactDigest: used.artifactDigest,
        }) } : {}),
    });
    if (manifest) assertForegroundSourcePacketSize(input.identity.runId, ({ digest, timestamp, attribution }) =>
        payloadFor({ ...input.identity, responseDigest: digest, artifactDigest: digest },
            { admittedAt: timestamp, executedAt: timestamp, attribution, requestDigests: [digest] }, timestamp),
    'skill-critic-source-too-large');
    const expectedRequestDigest = manifest ? digest(input.sourceRequest) : null;
    const call = createServerAgentSkillLiveRequest({
        ...input, consumerId: 'interactive.critic',
        runId: input.identity.runId, parentRunId: input.identity.runId, sourceRevision: input.identity.sourceRevision
    });
    let responseDigest: string | null = null;
    return Object.freeze({
        prepareRequest: (candidate: Parameters<typeof call.prepareRequest>[0]) => {
            if (!expectedRequestDigest) return call.prepareRequest(candidate);
            let captured: ChatRequest;
            try { captured = structuredClone(candidate.request); }
            catch { call.takeSuccessfulCall(); throw new Error('skill-critic-request-source-mismatch'); }
            if (digest(captured) !== expectedRequestDigest) {
                call.takeSuccessfulCall(); throw new Error('skill-critic-request-source-mismatch');
            }
            return call.prepareRequest({ ...candidate, request: captured });
        },
        bindResponse(digest: string): void {
            if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || responseDigest !== null) {
                call.takeSuccessfulCall(); throw new Error('skill-live-critic-response-binding-invalid');
            }
            responseDigest = digest;
        },
        prepareConsumption(used: CriticSkillConsumptionIdentity): AgentSkillConsumptionOutboxPayloadV1 | null {
            const success = call.takeSuccessfulCall();
            if (!success || used.rawSessionId !== input.identity.rawSessionId || used.runId !== input.identity.runId
                || used.sourceRevision !== input.identity.sourceRevision
                || used.draftDigest !== input.identity.draftDigest
                || used.decisionDigest !== input.identity.decisionDigest || used.responseDigest !== responseDigest
                || !/^sha256:[a-f0-9]{64}$/u.test(used.artifactDigest)
                || (manifest && (used.payloadDigest !== manifest.payloadDigest || success.requestDigests.length !== 1
                    || success.attribution.selectedManifestDigests.length > 1
                    || success.attribution.activeCandidateDigests.length !== 0))) return null;
            const occurredAt = new Date(nowMs()).toISOString();
            return payloadFor(used, success, occurredAt);
        },
    });
}
