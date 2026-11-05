import { isDeepStrictEqual } from 'node:util';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import { sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { buildAqlReplanRequest } from '../../../packages/agent-policy/public/aql-replan-request.ts';
import { parseAqlReplanOutput } from '../../../packages/agent-policy/public/aql-replan-output.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createAqlReplanSkillContextAuthority, isAqlReplanSkillSourceCurrent,
    type AqlReplanSkillContextDependencies, type AqlReplanSkillSourceSnapshotV1,
} from './aql-replan-context.ts';
import { agentSkillLiveEnabled, createServerAgentSkillAqlReplanLiveRequest,
    AQL_REPLAN_SKILL_POLICY_VERSION } from './live-request.ts';
import { sealAqlReplanSkillOutputProof } from './aql-replan-source-proof.ts';

export { AQL_REPLAN_SKILL_POLICY_VERSION } from './live-request.ts';
export function aqlReplanSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_AQL_REPLAN_LIVE === '1';
}
export function aqlReplanSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === AQL_REPLAN_SKILL_POLICY_VERSION;
}

/** A single native AQL request. The completed story turn is never reopened or replayed. */
export function createAqlReplanSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly source: AqlReplanSkillSourceSnapshotV1;
    readonly prompt: string;
    readonly request: ChatRequest;
    readonly authority: Omit<AqlReplanSkillContextDependencies, 'bindings' | 'leaseAuthority' | 'source' | 'sourceAuthority'>;
    readonly nowMs?: () => number;
}) {
    const source = input.source, request = structuredClone(input.request);
    if (!isAqlReplanSkillSourceCurrent(source) || source.inputDigest !== sha256Digest(input.prompt)
        || typeof request.model !== 'string' || !request.model || !Number.isSafeInteger(request.max_tokens)
        || (request.max_tokens ?? 0) < 1 || !isDeepStrictEqual(request, buildAqlReplanRequest(input.prompt, {
            variant: 'managed', model: request.model, maxTokens: request.max_tokens!,
        }))) throw new Error('aql-replan-skill-request-invalid');
    const authority = Object.freeze({
        ...input.authority,
        runtimeAuthority: Object.freeze({ readForLease: input.authority.runtimeAuthority.readForLease.bind(input.authority.runtimeAuthority) }),
        safetyAuthority: Object.freeze({ readForLease: input.authority.safetyAuthority.readForLease.bind(input.authority.safetyAuthority) }),
        controlStore: Object.freeze({ get: input.authority.controlStore.get.bind(input.authority.controlStore),
            capabilityControl: input.authority.controlStore.capabilityControl.bind(input.authority.controlStore) }),
    });
    let context: ReturnType<typeof createAqlReplanSkillContextAuthority> | null = null;
    let lease: AgentAdmissionLease | null = null, contextRevision: string | null = null;
    let requestSignal: AbortSignal | undefined;
    let responseContent: string | null = null, fixedRequestValid = true;
    const call = createServerAgentSkillAqlReplanLiveRequest({
        broker: input.broker, consumerId: 'interactive.aqlReplan', policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sourceRevision: source.sourceRevision, nowMs: input.nowMs,
        createAuthority(binding) {
            context = createAqlReplanSkillContextAuthority({ ...authority, source,
                leaseAuthority: input.broker, bindings: [binding], nowMs: input.nowMs });
            return context;
        },
    });
    const current = (candidate: AgentAdmissionLease): boolean => {
        if (!fixedRequestValid || requestSignal?.aborted || !context || !lease || candidate !== lease || !contextRevision
            || !isAqlReplanSkillSourceCurrent(source)) return false;
        try { return context.readForLease(lease).contextRevision === contextRevision; }
        catch { return false; }
    };
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof call.prepareRequest>[0]) {
            if (!isDeepStrictEqual(candidate.request, request) || candidate.lease.modelId !== request.model
                || candidate.lease.mode !== source.contentMode) {
                fixedRequestValid = false; call.abandon(); return null;
            }
            const prepared = await call.prepareRequest(candidate);
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; prepared?.discard(); call.abandon(); return null;
            }
            if (prepared && context) {
                try {
                    lease = candidate.lease; requestSignal = candidate.signal;
                    contextRevision = context.readForLease(lease).contextRevision;
                }
                catch { prepared.discard(); call.abandon(); return null; }
            }
            if (!prepared) return null;
            return Object.freeze({ ...prepared, succeeded(response: Parameters<typeof prepared.succeeded>[0]) {
                prepared.succeeded(response);
                responseContent = response.toolCalls.length === 0 && typeof response.content === 'string'
                    ? response.content : null;
            } });
        },
        authorizeFixedRequest: () => fixedRequestValid,
        authorizeCurrentContext: current,
        abandon: call.abandon,
        sealOutput(content: string | null) {
            const success = call.takeSuccessfulCall();
            if (!success || success.requestDigests.length !== 1 || !lease || !current(lease)
                || typeof content !== 'string' || content !== responseContent) return null;
            const output = parseAqlReplanOutput(content);
            if (!output) return null;
            return sealAqlReplanSkillOutputProof({ version: 'aql-replan-skill-proof-v1', source,
                requestDigest: success.requestDigests[0]!, outputDigest: sha256Digest(output.suggestion),
                attribution: success.attribution, admittedAt: success.admittedAt, executedAt: success.executedAt,
                validatedAt: new Date((input.nowMs ?? Date.now)()).toISOString() });
        },
    });
}
