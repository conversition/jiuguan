/** Bind one native Style compilation to its exact original request, without adopting its draft. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatRequest, ChatResponse } from '../../../packages/proxy/public/client.ts';
import { buildStyleCompilationModelRequest } from '../../../packages/harness/public/model-tool-surfaces.ts';
import { parseLearnedStyleModelResponse } from '../../../packages/agent-policy/public/style-compiler.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createStyleCompileSkillContextAuthority, createStyleCompileSkillSourceAuthority,
    isStyleCompileSkillSourceCurrent,
    type StyleCompileSkillContextDependencies, type StyleCompileSkillSourceSnapshotV1,
} from './style-compile-context.ts';
import {
    agentSkillLiveEnabled, createServerAgentSkillStyleCompileLiveRequest,
    STYLE_COMPILE_SKILL_POLICY_VERSION,
} from './live-request.ts';
import { sealStyleCompileSkillOutputProof, styleCompileSkillProofDigest } from './style-compile-source-proof.ts';

export { STYLE_COMPILE_SKILL_POLICY_VERSION } from './live-request.ts';
export function styleCompileSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_STYLE_COMPILE_LIVE === '1';
}
export function styleCompileSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === STYLE_COMPILE_SKILL_POLICY_VERSION;
}

/** The native source and current safety remain mandatory even without optional Skill assembly. */
export function createStyleCompileSkillDispatchAuthority(input: {
    readonly sourceAuthority: ReturnType<typeof createStyleCompileSkillSourceAuthority>;
    readonly authorizeHost: (lease: AgentAdmissionLease) => boolean;
    readonly safetyAuthority: StyleCompileSkillContextDependencies['safetyAuthority'];
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

export function createStyleCompileSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly source: StyleCompileSkillSourceSnapshotV1;
    readonly authority: Omit<StyleCompileSkillContextDependencies, 'leaseAuthority' | 'bindings' | 'source'>;
    readonly profileVersion: string;
    readonly samples: readonly { readonly sourceRevision: string; readonly prose: string }[];
    readonly request: ChatRequest;
    readonly nowMs?: () => number;
}) {
    const source = input.source;
    const profileVersion = input.profileVersion;
    const samples = structuredClone(input.samples);
    const request = structuredClone(input.request);
    const authority = Object.freeze({
        ...input.authority,
        runtimeAuthority: Object.freeze({ readForLease:
            input.authority.runtimeAuthority.readForLease.bind(input.authority.runtimeAuthority) }),
        safetyAuthority: Object.freeze({ readForLease:
            input.authority.safetyAuthority.readForLease.bind(input.authority.safetyAuthority) }),
        controlStore: Object.freeze({
            get: input.authority.controlStore.get.bind(input.authority.controlStore),
            capabilityControl: input.authority.controlStore.capabilityControl.bind(input.authority.controlStore),
        }),
    });
    const expected = { model: request.model, ...buildStyleCompilationModelRequest({
        profileVersion, samples, maxOutputTokens: request.max_tokens,
    }) };
    const inputDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify({ profileVersion, samples })).digest('hex')}`;
    if (source.inputDigest !== inputDigest || !styleCompileSkillPolicyAllowed(source.policyVersion)
        || !isStyleCompileSkillSourceCurrent(source)
        || typeof request.model !== 'string' || !request.model || !isDeepStrictEqual(request, expected)) {
        throw new Error('style-compile-skill-request-invalid');
    }
    let context: ReturnType<typeof createStyleCompileSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    let fixedRequestValid = true;
    const call = createServerAgentSkillStyleCompileLiveRequest({
        broker: input.broker, consumerId: 'learning.styleCompile', policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sourceRevision: source.sourceRevision,
        nowMs: input.nowMs,
        createAuthority(binding) {
            context = createStyleCompileSkillContextAuthority({
                ...authority, source, leaseAuthority: input.broker, bindings: [binding], nowMs: input.nowMs,
            });
            return context;
        },
    });
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof call.prepareRequest>[0]) {
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; call.abandon(); return null;
            }
            const prepared = await call.prepareRequest(candidate);
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false; prepared?.discard(); call.abandon(); return null;
            }
            try {
                if (prepared && context) {
                    currentLease = candidate.lease;
                    contextRevision = context.readForLease(candidate.lease).contextRevision;
                }
                return prepared;
            } catch { prepared?.discard(); call.abandon(); return null; }
        },
        authorizeFixedRequest: () => fixedRequestValid,
        abandon: call.abandon,
        sealOutput(response: ChatResponse) {
            const success = call.takeSuccessfulCall();
            if (!success || !context || !currentLease || success.requestDigests.length !== 1) return null;
            try {
                const parsed = parseLearnedStyleModelResponse(response);
                if (!parsed.ok || !isStyleCompileSkillSourceCurrent(source)
                    || context.readForLease(currentLease).contextRevision !== contextRevision) return null;
                return sealStyleCompileSkillOutputProof({
                    version: 'style-compile-skill-proof-v1', source,
                    requestDigest: success.requestDigests[0]!,
                    draftDigest: styleCompileSkillProofDigest(parsed.draft), bodyDigest: parsed.draft.bodyDigest,
                    attribution: success.attribution, admittedAt: success.admittedAt, executedAt: success.executedAt,
                    validatedAt: new Date((input.nowMs ?? Date.now)()).toISOString(),
                });
            } catch { return null; }
        },
    });
}
