/** @author Codex @date 2026-10-13 @version 1.0
 * A complete Prelude series, not its latest successful call, owns final consumption.
 */
import { createHash } from 'node:crypto';
import { agentClosureOperationId, type AgentClosureExecutionClass, type AgentSkillClosureAttributionV1 }
    from '../../../packages/agent-closure/index.ts';
import { capturePreludeRequest, capturePreludeResponse, createPreludeSourceManifest, parsePreludeSourceManifest,
    PRELUDE_SOURCE_VERSION, type PreludeSourceStep, type PreludeSourceManifest }
    from '../../../packages/harness/public/prelude-source.ts';
import { createPreludeSkillSourceReceipt, PRELUDE_SKILL_SOURCE_RECEIPT_VERSION,
    type PreludeSkillSourceReceiptV1 } from '../../../packages/memory/public/prelude-skill-source.ts';
import { assertForegroundSourcePacketSize } from './foreground-source-packet.ts';
import type {
    AgentSkillConsumptionOutboxPayloadV1,
} from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import { POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION }
    from '../../../packages/agent-policy/public/interactive-policy.ts';
import { agentSkillLiveEnabled, createServerAgentSkillLiveCallGroup } from './live-request.ts';

export function preludeSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_PRELUDE_LIVE === '1';
}

export function preludeSkillPolicyAllowed(policyVersion: string): boolean {
    return [POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION]
        .some((version) => version === policyVersion);
}

export interface PreludeSkillIdentity {
    readonly rawSessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly artifactDigest: string;
    readonly traceDigest?: string;
}

export function createPreludeSkillLiveCall(input: {
    readonly broker: Parameters<typeof createServerAgentSkillLiveCallGroup>[0]['broker'];
    readonly policyVersion: string;
    readonly identity: Omit<PreludeSkillIdentity, 'artifactDigest'>;
    readonly executionClass: AgentClosureExecutionClass;
    readonly authority: Parameters<typeof createServerAgentSkillLiveCallGroup>[0]['authority'];
    readonly nowMs?: () => number;
    /** The deployed live route requires the Native series; omission preserves historical callers. */
    readonly captureSource?: true;
}) {
    const nowMs = input.nowMs ?? Date.now;
    const group = createServerAgentSkillLiveCallGroup({
        ...input, consumerId: 'interactive.prelude',
        runId: input.identity.runId, parentRunId: input.identity.runId, sourceRevision: input.identity.sourceRevision
    });
    let sealed: Readonly<{
        success: NonNullable<ReturnType<typeof group.seal>>;
        artifactDigest: string; validatedAt: string; source?: PreludeSourceManifest;
    }> | null = null;
    const steps: PreludeSourceStep[] = [];
    const requestDigests: string[] = [];
    const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
    const payloadFor = (used: PreludeSkillIdentity, success: {
        readonly attribution: AgentSkillClosureAttributionV1; readonly admittedAt: string;
        readonly requestDigests: readonly string[];
    }, validatedAt: string, occurredAt: string, source?: PreludeSkillSourceReceiptV1): AgentSkillConsumptionOutboxPayloadV1 => Object.freeze({
        run: Object.freeze({ operationId: agentClosureOperationId('interactive', used.runId, 'interactive.prelude'),
            runId: used.runId, sessionId: used.rawSessionId, sourceRevision: used.sourceRevision,
            capability: 'interactive.prelude', lane: 'interactive', kind: 'advisory',
            policyVersion: input.policyVersion, executionClass: input.executionClass,
            evidenceDigest: digest(['prelude-dispatch-series-v1', success.requestDigests]), admittedAt: success.admittedAt }),
        event: Object.freeze({ type: 'context-consumed', idempotencyKey: `consumed-${used.runId}`,
            occurredAt, sourceRevision: used.sourceRevision, artifactDigest: used.artifactDigest,
            consumerRunId: used.runId, contextBlock: 'interactivePrelude', skillAttribution: success.attribution }),
        prerequisites: Object.freeze([
            Object.freeze({ type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: validatedAt,
                sourceRevision: used.sourceRevision }),
            Object.freeze({ type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: validatedAt,
                sourceRevision: used.sourceRevision, artifactDigest: used.artifactDigest }),
        ]), ...(source ? { preludeSource: source } : {}),
    });
    // The response determines which tools will run. Check known metadata before each dispatch,
    // and check the actual response again before any of its tools can execute.
    const assertFits = (trace: readonly PreludeSourceStep[]) => assertForegroundSourcePacketSize(input.identity.runId,
        ({ digest: width, timestamp, count, attribution }) => {
            const metadata = (scope: 'tool-result' | 'evidence-carrier') => ({
                version: 'tool-result-contract-v1' as const, scope, state: 'complete' as const,
                sizeUnit: 'utf16-code-units' as const, originalLength: count, returnedLength: count,
                previewLength: count, maxLength: count, sourceDigest: width, digestEncoding: 'utf16le' as const,
                parseability: 'not-asserted' as const,
            });
            const manifest: PreludeSourceManifest = { sourceVersion: PRELUDE_SOURCE_VERSION,
                initialRequestDigest: trace[0]!.request.semanticDigest, steps: trace,
                toolResults: trace.flatMap(step => step.response.toolCalls.map((call, index) => ({
                    stepOrdinal: step.ordinal, callOrdinal: index + 1,
                    toolCallId: call.id || `call-${step.ordinal - 1}-${index}`, toolName: call.name,
                    metadata: metadata('tool-result'),
                }))), evidenceCarrier: metadata('evidence-carrier'), traceDigest: width };
            const requests = trace.map((_, index) => requestDigests[index] ?? width);
            const source: PreludeSkillSourceReceiptV1 = { version: PRELUDE_SKILL_SOURCE_RECEIPT_VERSION, manifest,
                sessionId: input.identity.rawSessionId, runId: input.identity.runId, sourceRevision: input.identity.sourceRevision,
                policyVersion: input.policyVersion, requestDigests: requests, artifactDigest: width, receiptDigest: width };
            return payloadFor({ ...input.identity, artifactDigest: width },
                { attribution, admittedAt: timestamp, requestDigests: requests }, timestamp, timestamp, source);
        }, 'skill-prelude-source-too-large');
    let settled = false;
    return Object.freeze({
        prepareRequest: async (candidate: Parameters<typeof group.prepareRequest>[0]) => {
            if (settled) sealed = null;
            if (!input.captureSource) return group.prepareRequest(candidate);
            const request = structuredClone(candidate.request);
            const captured = capturePreludeRequest(request);
            const placeholder = { responseDigest: `sha256:${'0'.repeat(64)}`, contentDigest: null,
                contentLength: 0, finishReason: 'stop', toolCalls: [] };
            assertFits([...steps, { ordinal: steps.length + 1, request: captured, response: placeholder }]);
            const prepared = await group.prepareRequest({ ...candidate, request });
            if (!prepared) return null;
            let recorded = false;
            return Object.freeze({ ...prepared, succeeded: (response: Parameters<typeof prepared.succeeded>[0]) => {
                if (recorded) return;
                prepared.succeeded(response);
                recorded = true;
                steps.push(Object.freeze({ ordinal: steps.length + 1, request: captured, response: capturePreludeResponse(response) }));
                requestDigests.push(digest(prepared.request));
                assertFits(steps);
            } });
        },
        /** Called by the trusted runner owner only after tools and local validation have finished. */
        sealArtifact(result: { sourceRevision: string; artifactDigest: string; completed: boolean;
            sourceManifest?: PreludeSourceManifest }): boolean {
            if (settled) { sealed = null; group.abandon(); return false; }
            settled = true;
            const success = group.seal();
            if (!success || !result.completed || !preludeSkillPolicyAllowed(input.policyVersion)
                || result.sourceRevision !== input.identity.sourceRevision
                || !/^sha256:[a-f0-9]{64}$/u.test(result.artifactDigest)) return false;
            let source: PreludeSourceManifest | undefined;
            if (input.captureSource) {
                source = parsePreludeSourceManifest(result.sourceManifest);
                const actual = createPreludeSourceManifest(steps, { state: 'complete', evidenceCarrier: source.evidenceCarrier,
                    toolResults: source.toolResults.map(({ toolCallId, toolName, metadata }) => ({ toolCallId, toolName, metadata })) });
                if (actual.traceDigest !== source.traceDigest || JSON.stringify(success.requestDigests) !== JSON.stringify(requestDigests)
                    || success.attribution.selectedManifestDigests.length > 1 || success.attribution.activeCandidateDigests.length) {
                    throw new Error('skill-prelude-source-mismatch');
                }
            }
            sealed = Object.freeze({
                success, artifactDigest: result.artifactDigest,
                validatedAt: new Date(nowMs()).toISOString(), ...(source ? { source } : {}),
            });
            return true;
        },
        abandon(): void { settled = true; sealed = null; group.abandon(); },
        prepareConsumption(used: PreludeSkillIdentity): AgentSkillConsumptionOutboxPayloadV1 | null {
            const result = sealed;
            sealed = null;
            if (!result || used.rawSessionId !== input.identity.rawSessionId || used.runId !== input.identity.runId
                || used.sourceRevision !== input.identity.sourceRevision
                || used.artifactDigest !== result.artifactDigest
                || (result.source && used.traceDigest !== result.source.traceDigest)) return null;
            const { success, validatedAt } = result;
            const source = result.source ? createPreludeSkillSourceReceipt({ version: PRELUDE_SKILL_SOURCE_RECEIPT_VERSION,
                manifest: result.source, sessionId: used.rawSessionId, runId: used.runId, sourceRevision: used.sourceRevision,
                policyVersion: input.policyVersion, requestDigests: success.requestDigests, artifactDigest: used.artifactDigest }) : undefined;
            return payloadFor(used, success, validatedAt, new Date(nowMs()).toISOString(), source);
        },
    });
}
