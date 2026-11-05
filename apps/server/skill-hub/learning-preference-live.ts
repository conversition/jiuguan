/** @author Codex @date 2026-10-14 @version 1.0
 * Bind a real initial inference to its fixed request without treating guesses as profile adoption.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import { buildPreferenceExtractionModelRequest } from '../../../packages/harness/public/learning-model-contract.ts';
import { normalizeTypedPreferenceExtraction } from '../../../packages/agent-policy/public/prompt-preference.ts';
import { learningPreferenceSkillOutputDigest }
    from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createLearningPreferenceSkillContextAuthority,
    createLearningPreferenceSkillSourceAuthority,
    type LearningPreferenceSkillContextDependencies,
    type LearningPreferenceSkillSourceSnapshotV1,
} from './learning-preference-context.ts';
import {
    agentSkillLiveEnabled,
    createServerAgentSkillLearningLiveRequest,
    LEARNING_PREFERENCE_SKILL_POLICY_VERSION,
} from './live-request.ts';
import { sealLearningPreferenceSkillOutputProof } from './learning-preference-source-proof.ts';

export { LEARNING_PREFERENCE_SKILL_POLICY_VERSION } from './live-request.ts';

export function learningPreferenceSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return agentSkillLiveEnabled(env) && env.JG_AGENT_SKILL_LEARNING_PREFERENCE_LIVE === '1';
}

export function learningPreferenceSkillPolicyAllowed(policyVersion: string): boolean {
    return policyVersion === LEARNING_PREFERENCE_SKILL_POLICY_VERSION;
}

/** Base revocation is not an optional-assembly failure; do not retry it as a bare classification call. */
export function createLearningPreferenceSkillDispatchAuthority(input: {
    readonly sourceAuthority: ReturnType<typeof createLearningPreferenceSkillSourceAuthority>;
    readonly authorizeHost: (lease: AgentAdmissionLease) => boolean;
    readonly safetyAuthority: LearningPreferenceSkillContextDependencies['safetyAuthority'];
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

/** Optional request assembly only: no write/consume/positive-feedback receipt is issued here. */
export function createLearningPreferenceSkillLiveCall(input: {
    readonly broker: AdmissionTicketBroker;
    readonly source: LearningPreferenceSkillSourceSnapshotV1;
    readonly authority: Omit<LearningPreferenceSkillContextDependencies, 'leaseAuthority' | 'bindings' | 'source'>;
    readonly userPrompt: string;
    readonly request: ChatRequest;
    readonly nowMs?: () => number;
}) {
    const source = input.source;
    const request = structuredClone(input.request);
    const authority = Object.freeze({
        ...input.authority,
        sourceAuthority: Object.freeze({
            readLearningPreferenceSkillSource:
                input.authority.sourceAuthority.readLearningPreferenceSkillSource.bind(input.authority.sourceAuthority)
        }),
        runtimeAuthority: Object.freeze({
            readForLease:
                input.authority.runtimeAuthority.readForLease.bind(input.authority.runtimeAuthority)
        }),
        safetyAuthority: Object.freeze({
            readForLease:
                input.authority.safetyAuthority.readForLease.bind(input.authority.safetyAuthority)
        }),
        controlStore: Object.freeze({
            get: input.authority.controlStore.get.bind(input.authority.controlStore),
            capabilityControl: input.authority.controlStore.capabilityControl.bind(input.authority.controlStore),
        }),
    });
    const promptDigest = `sha256:${createHash('sha256').update(input.userPrompt).digest('hex')}`;
    const expected = {
        model: request.model,
        ...buildPreferenceExtractionModelRequest({
            initialPrompt: input.userPrompt, maxOutputTokens: request.max_tokens,
        }),
    };
    if (source.userPromptDigest !== promptDigest || typeof request.model !== 'string' || !request.model
        || !isDeepStrictEqual(request, expected)) throw new Error('learning-preference-skill-request-invalid');
    let context: ReturnType<typeof createLearningPreferenceSkillContextAuthority> | null = null;
    let currentLease: AgentAdmissionLease | null = null;
    let contextRevision: string | null = null;
    const call = createServerAgentSkillLearningLiveRequest({
        broker: input.broker, consumerId: 'learning.preference', policyVersion: source.policyVersion,
        runId: source.runId, parentRunId: source.parentRunId, sourceRevision: source.sourceRevision,
        nowMs: input.nowMs,
        createAuthority(binding) {
            context = createLearningPreferenceSkillContextAuthority({
                ...authority, source, leaseAuthority: input.broker, bindings: [binding], nowMs: input.nowMs,
            });
            return context;
        },
    });
    let fixedRequestValid = true;
    return Object.freeze({
        async prepareRequest(candidate: Parameters<typeof call.prepareRequest>[0]) {
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false;
                call.abandon();
                return null;
            }
            const prepared = await call.prepareRequest(candidate);
            if (!isDeepStrictEqual(candidate.request, request)) {
                fixedRequestValid = false;
                prepared?.discard();
                call.abandon();
                return null;
            }
            if (prepared && context) {
                currentLease = candidate.lease;
                contextRevision = context.readForLease(candidate.lease).contextRevision;
            }
            return prepared;
        },
        authorizeFixedRequest: () => fixedRequestValid,
        abandon: call.abandon,
        // This is execution provenance, not evidence that inferred tags entered the user's profile.
        takeSuccessfulCall: call.takeSuccessfulCall,
        sealOutput(content: string | null) {
            const success = call.takeSuccessfulCall();
            if (!success || !context || !currentLease || success.requestDigests.length !== 1
                || typeof content !== 'string' || content.length > 8_192) return null;
            try {
                const normalized = normalizeTypedPreferenceExtraction(JSON.parse(content));
                if (!normalized || context.readForLease(currentLease).contextRevision !== contextRevision) return null;
                return sealLearningPreferenceSkillOutputProof({
                    version: 'learning-preference-skill-proof-v1', source,
                    requestDigest: success.requestDigests[0]!,
                    outputDigest: learningPreferenceSkillOutputDigest(normalized.tags.map((tag) => tag.token)),
                    attribution: success.attribution, admittedAt: success.admittedAt,
                    executedAt: success.executedAt, validatedAt: new Date((input.nowMs ?? Date.now)()).toISOString(),
                });
            } catch { return null; }
        },
    });
}
