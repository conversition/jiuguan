/** Bind one actual edited-branch request to its own Skill source, without positive preference adoption. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import { buildBranchAttributionModelRequest } from '../../../packages/harness/public/learning-model-contract.ts';
import {
    normalizeSemanticBranchAttribution, type SemanticBranchCandidate,
} from '../../../packages/agent-policy/public/branch-preference.ts';
import { branchPreferenceSkillOutputDigest }
    from '../../../packages/memory/public/branch-preference-skill-source.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createBranchPreferenceSkillContextAuthority, createBranchPreferenceSkillSourceAuthority,
    type BranchPreferenceSkillContextDependencies, type BranchPreferenceSkillSourceSnapshotV1,
} from './branch-preference-context.ts';
import {
    agentSkillLiveEnabled, createServerAgentSkillBranchPreferenceLiveRequest,
    BRANCH_PREFERENCE_SKILL_POLICY_VERSION,
} from './live-request.ts';
import { sealBranchPreferenceSkillOutputProof } from './branch-preference-source-proof.ts';

export { BRANCH_PREFERENCE_SKILL_POLICY_VERSION } from './live-request.ts';
export function branchPreferenceSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_BRANCH_PREFERENCE_LIVE === '1';
}
export function branchPreferenceSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === BRANCH_PREFERENCE_SKILL_POLICY_VERSION;
}

/** Source/host/safety revocation cannot fall back to an unbound semantic classification call. */
export function createBranchPreferenceSkillDispatchAuthority(input: {
    readonly sourceAuthority: ReturnType<typeof createBranchPreferenceSkillSourceAuthority>;
    readonly authorizeHost: (lease: AgentAdmissionLease) => boolean;
    readonly safetyAuthority: BranchPreferenceSkillContextDependencies['safetyAuthority'];
}) {
    const readSource = input.sourceAuthority.readForLease.bind(input.sourceAuthority);
    const authorizeHost = input.authorizeHost;
    const readSafety = input.safetyAuthority.readForLease.bind(input.safetyAuthority);
    return (lease: AgentAdmissionLease): boolean => {
        if (!authorizeHost(lease)) return false;
        const source = readSource(lease);
        if (!source) return false;
        if (source.contentMode !== 'nsfw') return true;
        const safety = readSafety(lease, source);
        return Boolean(safety && safety.sessionId === lease.sessionId
            && safety.sourceRevision === source.sourceRevision && safety.state.enabled
            && safety.state.reasonCode === 'active' && safety.state.adultAttestation === 'verified'
            && safety.state.participantsAdult && safety.state.consent === 'confirmed'
            && Number.isSafeInteger(safety.state.revision) && safety.state.revision >= 1
            && safety.state.sourceRevision === source.worldbookSourceRevision);
    };
}

/** Optional exact-request assembly. The final semantic event remains owned by Session's transaction. */
export function createBranchPreferenceSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly source: BranchPreferenceSkillSourceSnapshotV1;
    readonly authority: Omit<BranchPreferenceSkillContextDependencies, 'leaseAuthority' | 'bindings' | 'source'>;
    readonly editedInput: string;
    readonly candidates: readonly SemanticBranchCandidate[];
    readonly branches: readonly string[];
    readonly request: ChatRequest;
    readonly nowMs?: () => number;
}) {
    const source = input.source;
    const request = structuredClone(input.request);
    const candidates = structuredClone(input.candidates);
    const branches = structuredClone(input.branches);
    const authority = Object.freeze({
        ...input.authority,
        sourceAuthority: Object.freeze({ readBranchPreferenceSkillSource:
            input.authority.sourceAuthority.readBranchPreferenceSkillSource.bind(input.authority.sourceAuthority) }),
        runtimeAuthority: Object.freeze({ readForLease:
            input.authority.runtimeAuthority.readForLease.bind(input.authority.runtimeAuthority) }),
        safetyAuthority: Object.freeze({ readForLease:
            input.authority.safetyAuthority.readForLease.bind(input.authority.safetyAuthority) }),
        controlStore: Object.freeze({
            get: input.authority.controlStore.get.bind(input.authority.controlStore),
            capabilityControl: input.authority.controlStore.capabilityControl.bind(input.authority.controlStore),
        }),
    });
    const textDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const expected = { model: request.model, ...buildBranchAttributionModelRequest({
        editedInput: input.editedInput, candidates, branches, maxOutputTokens: request.max_tokens,
    }) };
    if (source.userInputDigest !== textDigest(input.editedInput)
        || source.branchSetDigest !== textDigest(JSON.stringify(branches))
        || source.candidatesDigest !== textDigest(JSON.stringify(candidates))
        || typeof request.model !== 'string' || !request.model || !isDeepStrictEqual(request, expected)) {
        throw new Error('branch-preference-skill-request-invalid');
    }
    let context: ReturnType<typeof createBranchPreferenceSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    const call = createServerAgentSkillBranchPreferenceLiveRequest({
        broker: input.broker, consumerId: 'learning.branchPreference', policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sourceRevision: source.sourceRevision,
        nowMs: input.nowMs,
        createAuthority(binding) {
            context = createBranchPreferenceSkillContextAuthority({
                ...authority, source, leaseAuthority: input.broker, bindings: [binding], nowMs: input.nowMs,
            });
            return context;
        },
    });
    let fixedRequestValid = true;
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof call.prepareRequest>[0]) {
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; call.abandon(); return null;
            }
            const prepared = await call.prepareRequest(candidate);
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; prepared?.discard(); call.abandon(); return null;
            }
            if (prepared && context) {
                currentLease = candidate.lease;
                contextRevision = context.readForLease(candidate.lease).contextRevision;
            }
            return prepared;
        },
        authorizeFixedRequest: () => fixedRequestValid,
        abandon: call.abandon,
        takeSuccessfulCall: call.takeSuccessfulCall,
        sealOutput(content: string | null) {
            const success = call.takeSuccessfulCall();
            if (!success || !context || !currentLease || success.requestDigests.length !== 1
                || typeof content !== 'string' || content.length > 8_192) return null;
            try {
                const output = normalizeSemanticBranchAttribution(JSON.parse(content), candidates);
                if (!output || context.readForLease(currentLease).contextRevision !== contextRevision) return null;
                return sealBranchPreferenceSkillOutputProof({
                    version: 'branch-preference-skill-proof-v1', source,
                    requestDigest: success.requestDigests[0]!, output,
                    outputDigest: branchPreferenceSkillOutputDigest(output), attribution: success.attribution,
                    admittedAt: success.admittedAt, executedAt: success.executedAt,
                    validatedAt: new Date((input.nowMs ?? Date.now)()).toISOString(),
                });
            } catch { return null; }
        },
    });
}
