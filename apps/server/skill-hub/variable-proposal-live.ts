import { isDeepStrictEqual } from 'node:util';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import {
    buildVariableProposalSkillRequest, normalizeVariableProposalSkillSource,
    parseVariableProposalSkillOutput, variableProposalSkillSessionDigest,
    type VariableProposalSkillSourceV1, type VariableProposalSkillSpec,
} from '../../../packages/agent-policy/public/variable-proposal-skill.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createServerAgentSkillContextAuthority, type ServerAgentSkillContextAuthorityDependencies,
} from './context-authority.ts';
import {
    agentSkillLiveEnabled, createServerAgentSkillVariableProposalLiveRequest,
    VARIABLE_PROPOSAL_SKILL_POLICY_VERSION,
} from './live-request.ts';

export { VARIABLE_PROPOSAL_SKILL_POLICY_VERSION } from './live-request.ts';

export function variableProposalSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_VARIABLE_PROPOSAL_LIVE === '1';
}

export function variableProposalSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === VARIABLE_PROPOSAL_SKILL_POLICY_VERSION;
}

export function createVariableProposalSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly rawSessionId: string;
    readonly source: VariableProposalSkillSourceV1;
    readonly specs: readonly VariableProposalSkillSpec[];
    readonly values: Readonly<Record<string, string | number | boolean>>;
    readonly userInput: string;
    readonly request: ChatRequest;
    readonly authority: Omit<ServerAgentSkillContextAuthorityDependencies, 'bindings' | 'leaseAuthority'>;
    readonly nowMs?: () => number;
}) {
    const source = normalizeVariableProposalSkillSource(input.source);
    const specs = structuredClone(input.specs);
    const values = structuredClone(input.values);
    const request = structuredClone(input.request);
    if (typeof request.model !== 'string' || !request.model) {
        throw new Error('variable-proposal-skill-request-invalid');
    }
    const expected = buildVariableProposalSkillRequest({ source, specs, values,
        userInput: input.userInput, model: request.model });
    if (source.sessionDigest !== variableProposalSkillSessionDigest(input.rawSessionId)
        || !variableProposalSkillPolicyAllowed(source.policyVersion) || !isDeepStrictEqual(request, expected)) {
        throw new Error('variable-proposal-skill-request-invalid');
    }
    const authority = Object.freeze({
        turnAuthority: Object.freeze({ readAgentSkillTurnContext:
            input.authority.turnAuthority.readAgentSkillTurnContext.bind(input.authority.turnAuthority) }),
        runtimeAuthority: Object.freeze({ readForLease:
            input.authority.runtimeAuthority.readForLease.bind(input.authority.runtimeAuthority) }),
        safetyAuthority: Object.freeze({ readForLease:
            input.authority.safetyAuthority.readForLease.bind(input.authority.safetyAuthority) }),
        controlStore: Object.freeze({ get: input.authority.controlStore.get.bind(input.authority.controlStore),
            capabilityControl: input.authority.controlStore.capabilityControl.bind(input.authority.controlStore) }),
    });
    let context: ReturnType<typeof createServerAgentSkillContextAuthority> | null = null;
    let lease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    let responseContent: string | null = null;
    let fixedRequestValid = true;
    const call = createServerAgentSkillVariableProposalLiveRequest({
        broker: input.broker, consumerId: 'interactive.variableProposal', policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sourceRevision: source.sourceRevision,
        nowMs: input.nowMs,
        createAuthority(binding) {
            context = createServerAgentSkillContextAuthority({ ...authority,
                leaseAuthority: input.broker, bindings: [binding], nowMs: input.nowMs });
            return context;
        },
    });
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof call.prepareRequest>[0]) {
            if (!isDeepStrictEqual(candidate.request, request)
                || candidate.lease.modelId !== request.model || candidate.lease.mode !== source.contentMode) {
                fixedRequestValid = false; call.abandon(); return null;
            }
            const prepared = await call.prepareRequest(candidate);
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; prepared?.discard(); call.abandon(); return null;
            }
            if (prepared && context) {
                try {
                    lease = candidate.lease;
                    contextRevision = context.readForLease(lease).contextRevision;
                } catch { prepared.discard(); call.abandon(); return null; }
            }
            if (!prepared) return null;
            return Object.freeze({ ...prepared, succeeded(response: Parameters<typeof prepared.succeeded>[0]) {
                prepared.succeeded(response);
                responseContent = response.toolCalls.length === 0 && typeof response.content === 'string'
                    ? response.content : null;
            } });
        },
        authorizeFixedRequest: () => fixedRequestValid,
        authorizeCurrentContext(candidate: AgentAdmissionLease): boolean {
            if (!fixedRequestValid || !context || !lease || candidate !== lease || !contextRevision) return false;
            try { return context.readForLease(lease).contextRevision === contextRevision; }
            catch { return false; }
        },
        abandon: call.abandon,
        sealOutput(content: string | null, candidateDigest: string): boolean {
            const success = call.takeSuccessfulCall();
            if (!success || success.requestDigests.length !== 1 || !context || !lease || !contextRevision
                || !fixedRequestValid || typeof content !== 'string' || content !== responseContent) return false;
            try {
                const candidate = parseVariableProposalSkillOutput(content, specs, source.maxCandidateCount);
                return Boolean(candidate && candidate.candidateDigest === candidateDigest
                    && context.readForLease(lease).contextRevision === contextRevision);
            } catch { return false; }
        },
    });
}
