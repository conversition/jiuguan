/** @author Codex @date 2026-10-16 @version 1.0
 * Two isolated generations under one admitted lease; no self-judgment or publication authority.
 */
import { types as nodeTypes } from 'node:util';
import { agentBudgetProfileDigest, normalizeAgentBudgetProfile }
    from '../../packages/agent-policy/public/budget-profile.ts';
import { admissionLimitsFromBudgetProfile, agentToolSetDigest }
    from '../../packages/agent-policy/public/admission.ts';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/public/client.ts';
import { AdmissionTicketBroker } from './agent-admission-broker.ts';
import {
    AdmittedModelGateway, AdmittedModelGatewayError, safeAdmittedModelGatewayErrorCode,
    estimateAdmittedRequestInputTokens, type AdmittedModelGatewayOptions, type AdmittedModelLease,
    type AdmittedModelLeaseAudit
}
    from './admitted-model-gateway.ts';
import {
    normalizeSkillSampleExecution, skillSampleCommonResponseBinding,
    type SkillSampleExecution, type SkillSampleExecutionArm,
} from './skill-sample-execution.ts';
import {
    assertCurrentSkillSampleExecutionPlan, normalizeSkillSampleExecutionPlan,
    SKILL_SAMPLE_SUITE_PLAN_VERSION, type SkillSampleExecutionPlan
}
    from './skill-sample-registry.ts';
import {
    evalDense, evalDigest, evalFreeze, evalHash, evalRawDigest, evalRecord, evalSnapshot,
    evalTime, evalToken, evalUniqueJson
} from './skill-evaluate-data.ts';
import {
    isCandidateEvaluationSampleDispatchFactory,
    isCandidateEvaluationSampleDispatchSidecar,
} from './skill-hub/candidate-evaluation-sample-dispatch.ts';

export {
    normalizeSkillSamplePlan, skillSamplePlanDigest, normalizeSkillSampleExecutionPlan,
    skillSampleExecutionPlanDigest
} from './skill-sample-registry.ts';
export type { SkillSamplePlan, SkillSampleExecutionPlan } from './skill-sample-registry.ts';
export const SKILL_SAMPLE_POLICY_VERSION = 'skill-sample-neutral-pair-v1' as const;
export const SKILL_SAMPLE_PACKET_VERSION = 'skill-sample-packet-v1' as const;
export const SKILL_SAMPLE_DISPATCH_CONTEXT_VERSION = 'skill-sample-dispatch-context-v1' as const;
export const SKILL_SAMPLE_TOOL_NAME = 'submit_skill_sample' as const;
const MAX_TEXT_CHARS = 6_000;
const MAX_RESPONSE_CHARS = 65_536;

export interface SkillSampleClaim {
    readonly claimVersion: 'skill-sample-claim-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillSampleExecutionPlan;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly createdAt: string;
    readonly ownerId: string;
    readonly ownerToken: string;
    readonly attempt: 1;
    readonly revision: number;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
}
export interface SkillSampleArm {
    readonly variant: 'baseline' | 'candidate';
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly text: string;
    readonly textDigest: string;
    readonly usage: Readonly<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }>;
    readonly finishReason: 'tool_calls';
}
export interface SkillSamplePacket {
    readonly packetVersion: typeof SKILL_SAMPLE_PACKET_VERSION;
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly jobRequestDigest: string;
    readonly claimDigest: string;
    readonly plan: SkillSampleExecutionPlan;
    readonly planDigest: string;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly arms: readonly [SkillSampleArm, SkillSampleArm];
    readonly completedAt: string;
    readonly packetDigest: string;
}
declare const SKILL_SAMPLE_PROOF: unique symbol;
export interface SkillSampleProof { readonly [SKILL_SAMPLE_PROOF]: true; }
const PROOFS = new WeakMap<object, SkillSamplePacket>();
/**
 * D-Q3a2b2b：只有品牌 dispatch 路径（48 臂批次桥）才产生执行证据；
 * 未品牌路径为 `null`。证据与 proof 同生命周期，不单独持久正文。
 */
const EXECUTIONS = new WeakMap<object, SkillSampleExecution>();
const USED_CLAIMS = new WeakSet<object>();
export const SKILL_SAMPLE_MODEL_ERROR_CODES = Object.freeze([
    'skill-sample-audit-unavailable', 'skill-sample-authority-denied', 'skill-sample-cancelled',
    'skill-sample-claim-invalid', 'skill-sample-claim-replayed', 'skill-sample-deadline-exceeded',
    'skill-sample-dispatch-evidence-unavailable',
    'skill-sample-packet-invalid', 'skill-sample-proof-not-owned', 'skill-sample-provider-failed',
    'skill-sample-request-invalid', 'skill-sample-response-invalid', 'skill-sample-registry-stale',
] as const);
export type SkillSampleModelErrorCode = typeof SKILL_SAMPLE_MODEL_ERROR_CODES[number];
export class SkillSampleModelError extends Error {
    constructor(readonly code: SkillSampleModelErrorCode) {
        if (!(SKILL_SAMPLE_MODEL_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-sample-error-code-invalid');
        }
        super(code); this.name = 'SkillSampleModelError';
    }
}


function reject(code: SkillSampleModelErrorCode): never { throw new SkillSampleModelError(code); }


function normalizeClaim(input: unknown): SkillSampleClaim {
    try {
        const value = evalRecord(evalSnapshot(input), ['claimVersion', 'jobId', 'rawSessionId', 'requestDigest',
            'plan', 'modelId', 'modelBindingDigest', 'createdAt', 'ownerId', 'ownerToken', 'attempt', 'revision',
            'claimedAt', 'leaseExpiresAt']);
        if (value.claimVersion !== 'skill-sample-claim-v1' || value.attempt !== 1
            || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('claim-invalid');
        const plan = normalizeSkillSampleExecutionPlan(value.plan);
        const claim = evalFreeze({
            claimVersion: 'skill-sample-claim-v1' as const, jobId: evalToken(value.jobId),
            rawSessionId: evalToken(value.rawSessionId), requestDigest: evalHash(value.requestDigest), plan,
            modelId: evalToken(value.modelId), modelBindingDigest: evalHash(value.modelBindingDigest),
            createdAt: evalTime(value.createdAt), ownerId: evalToken(value.ownerId),
            ownerToken: evalToken(value.ownerToken),
            attempt: 1 as const, revision: Number(value.revision), claimedAt: evalTime(value.claimedAt),
            leaseExpiresAt: evalTime(value.leaseExpiresAt),
        });
        if (claim.rawSessionId !== plan.source.compilePacket.rawSessionId
            || claim.createdAt < plan.source.candidate.updatedAt || claim.createdAt > claim.claimedAt
            || claim.claimedAt >= claim.leaseExpiresAt) throw new Error('claim-binding-invalid');
        return claim;
    } catch { reject('skill-sample-claim-invalid'); }
}


export function skillSampleClaimDigest(input: unknown): string { return evalDigest(normalizeClaim(input)); }
export const SKILL_SAMPLE_TOOL = evalFreeze({
    type: 'function', function: {
        name: SKILL_SAMPLE_TOOL_NAME, description: 'Submit only the generated narrative text for the supplied scene.',
        parameters: {
            type: 'object', additionalProperties: false, required: ['text'], properties: {
                text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_CHARS },
            }
        },
    }
});


export function buildSkillSampleModelRequest(input: {
    plan: unknown; modelId: string; variant: SkillSampleArm['variant']; maxOutputTokens: number;
}): ChatRequest {
    try {
        const plan = assertCurrentSkillSampleExecutionPlan(input.plan);
        if (!['baseline', 'candidate'].includes(input.variant) || !Number.isSafeInteger(input.maxOutputTokens)
            || input.maxOutputTokens < 1 || input.maxOutputTokens > 2_400) reject('skill-sample-request-invalid');
        const common = 'Write the Chinese narrative requested by the supplied scene. '
            + 'Return only the required submission tool with exactly one text field. '
            + 'Do not return commentary, comparisons, scores, judgments, or additional tools.';
        return evalFreeze({
            model: evalToken(input.modelId), messages: [
                {
                    role: 'system', content: common + (input.variant === 'candidate'
                        ? `\nHost Style instructions:\n${plan.candidateInstruction}` : '')
                },
                { role: 'user', content: plan.fixture.prompt },
            ], tools: [SKILL_SAMPLE_TOOL],
            tool_choice: { type: 'function', function: { name: SKILL_SAMPLE_TOOL_NAME } },
            temperature: 0, max_tokens: input.maxOutputTokens
        } as ChatRequest);
    } catch { reject('skill-sample-request-invalid'); }
}


export function skillSampleModelRequestDigest(input: ChatRequest): string {
    return evalRawDigest(JSON.stringify(input));
}


export interface SkillSampleDispatchArmContext {
    readonly variant: SkillSampleArm['variant'];
    readonly requestDigest: string;
    readonly promptBindingDigest: string;
}

export interface SkillSampleDispatchContext {
    readonly contextVersion: typeof SKILL_SAMPLE_DISPATCH_CONTEXT_VERSION;
    readonly jobId: string;
    readonly planDigest: string;
    readonly sampleKey: string;
    readonly scenarioOrdinal: number;
    readonly repeatIndex: number;
    readonly arms: readonly [SkillSampleDispatchArmContext, SkillSampleDispatchArmContext];
}

export interface SkillSampleDispatchSidecar {
    readonly prepareRequest: NonNullable<AdmittedModelGatewayOptions['prepareRequest']>;
    readonly authorizeDispatch: NonNullable<AdmittedModelGatewayOptions['authorizeDispatch']>;
    /**
     * Mandatory after the one Provider response; failure forbids a Sample proof and the next arm.
     * Returns the Candidate settlement identities so the Sample execution evidence can bind both
     * response digest dialects without a second read of mutable state.
     */
    succeededRequired(input: Readonly<{
        variant: SkillSampleArm['variant'];
        requestDigest: string;
    }>): Readonly<{
        receiptDigest: string;
        responseDigest: string | null;
    }>;
}

export type SkillSampleDispatchSidecarFactory =
    (context: SkillSampleDispatchContext) => SkillSampleDispatchSidecar;

export function skillSamplePromptBindingDigest(input: Readonly<{
    jobId: string;
    planDigest: string;
    scenarioOrdinal: number;
    repeatIndex: number;
    variant: SkillSampleArm['variant'];
    requestDigest: string;
}>): string {
    return evalDigest({
        bindingVersion: 'skill-sample-prompt-binding-v1',
        jobId: evalToken(input.jobId),
        planDigest: evalHash(input.planDigest),
        scenarioOrdinal: input.scenarioOrdinal,
        repeatIndex: input.repeatIndex,
        variant: input.variant,
        requestDigest: evalHash(input.requestDigest),
    });
}


function normalizeDispatchSidecar(input: unknown): SkillSampleDispatchSidecar {
    if (!isCandidateEvaluationSampleDispatchSidecar(input)
        || !input || typeof input !== 'object' || nodeTypes.isProxy(input)) {
        reject('skill-sample-dispatch-evidence-unavailable');
    }
    const keys = Reflect.ownKeys(input);
    const expected = ['prepareRequest', 'authorizeDispatch', 'succeededRequired'];
    if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
        || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
        reject('skill-sample-dispatch-evidence-unavailable');
    }
    for (const key of expected) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
            || typeof descriptor.value !== 'function') {
            reject('skill-sample-dispatch-evidence-unavailable');
        }
    }
    return input as SkillSampleDispatchSidecar;
}


function textValue(input: unknown): string {
    if (typeof input !== 'string' || input.length < 1 || input.length > MAX_TEXT_CHARS || input.trim().length === 0) {
        reject('skill-sample-response-invalid');
    }
    return input;
}


function normalizeUsage(input: unknown, exact = true): SkillSampleArm['usage'] {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) reject('skill-sample-response-invalid');
    const keys = Reflect.ownKeys(input);
    const expected = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
    const optional = ['cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens'];
    if (!exact && keys.some((key) => typeof key !== 'string' || ![...expected, ...optional].includes(key))) {
        reject('skill-sample-response-invalid');
    }
    const value = evalRecord(input, exact ? expected : keys as string[]);
    if (expected.some((key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
        || Number(value.total_tokens) < Number(value.prompt_tokens) + Number(value.completion_tokens)
        || optional.some((key) => value[key] !== undefined
            && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))) reject('skill-sample-response-invalid');
    return evalFreeze({
        prompt_tokens: Number(value.prompt_tokens), completion_tokens: Number(value.completion_tokens),
        total_tokens: Number(value.total_tokens)
    });
}


export function parseSkillSampleModelResponse(input: unknown): Readonly<{
    text: string; textDigest: string; responseDigest: string;
    usage: SkillSampleArm['usage']; finishReason: 'tool_calls';
}> {
    try {
        if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) reject('skill-sample-response-invalid');
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string'
            || !['content', 'toolCalls', 'finishReason', 'usage', 'raw'].includes(key)))
            reject('skill-sample-response-invalid');
        const value = evalRecord(input, keys as string[]);
        if ((value.content !== null && value.content !== '') || value.finishReason !== 'tool_calls') {
            reject('skill-sample-response-invalid');
        }
        const tool = evalRecord(evalDense(value.toolCalls, 1, 1)[0], ['id', 'name', 'arguments']);
        evalToken(tool.id);
        if (tool.name !== SKILL_SAMPLE_TOOL_NAME || typeof tool.arguments !== 'string'
            || tool.arguments.length < 1 || tool.arguments.length > MAX_RESPONSE_CHARS)
            reject('skill-sample-response-invalid');
        const output = evalRecord(evalUniqueJson(tool.arguments), ['text']);
        const text = textValue(output.text);
        return evalFreeze({
            text, textDigest: evalRawDigest(text), usage: normalizeUsage(value.usage, false),
            finishReason: 'tool_calls' as const, responseDigest: evalRawDigest(JSON.stringify({
                content: value.content, toolCalls: [{ id: tool.id, name: tool.name, arguments: tool.arguments }],
                finishReason: value.finishReason,
            }))
        });
    } catch { reject('skill-sample-response-invalid'); }
}


function normalizeArm(input: unknown, variant: SkillSampleArm['variant']): SkillSampleArm {
    const value = evalRecord(input, ['variant', 'requestDigest', 'responseDigest', 'text', 'textDigest', 'usage',
        'finishReason']);
    const text = textValue(value.text);
    if (value.variant !== variant || value.finishReason !== 'tool_calls' || value.textDigest !== evalRawDigest(text)) {
        reject('skill-sample-packet-invalid');
    }
    return evalFreeze({
        variant, requestDigest: evalHash(value.requestDigest),
        responseDigest: evalHash(value.responseDigest), text, textDigest: evalRawDigest(text),
        usage: normalizeUsage(value.usage), finishReason: 'tool_calls' as const
    });
}


/** Serialized history validates bytes and bindings but never recovers a model-success brand. */
export function normalizeSkillSamplePacket(input: unknown): SkillSamplePacket {
    try {
        const value = evalRecord(evalSnapshot(input), ['packetVersion', 'jobId', 'rawSessionId', 'jobRequestDigest',
            'claimDigest', 'plan', 'planDigest', 'modelId', 'modelBindingDigest', 'arms', 'completedAt',
            'packetDigest']);
        const plan = normalizeSkillSampleExecutionPlan(value.plan);
        const arms = evalDense(value.arms, 2, 2);
        const core = {
            packetVersion: SKILL_SAMPLE_PACKET_VERSION, jobId: evalToken(value.jobId),
            rawSessionId: evalToken(value.rawSessionId), jobRequestDigest: evalHash(value.jobRequestDigest),
            claimDigest: evalHash(value.claimDigest), plan, planDigest: evalHash(value.planDigest),
            modelId: evalToken(value.modelId), modelBindingDigest: evalHash(value.modelBindingDigest),
            arms: [normalizeArm(arms[0], 'baseline'), normalizeArm(arms[1], 'candidate')] as const,
            completedAt: evalTime(value.completedAt)
        };
        if (value.packetVersion !== SKILL_SAMPLE_PACKET_VERSION || core.planDigest !== plan.planDigest
            || core.rawSessionId !== plan.source.compilePacket.rawSessionId
            || core.completedAt < plan.source.candidate.updatedAt || value.packetDigest !== evalDigest(core)) {
            reject('skill-sample-packet-invalid');
        }
        return evalFreeze({ ...core, packetDigest: evalHash(value.packetDigest) });
    } catch { reject('skill-sample-packet-invalid'); }
}


export function readSkillSampleProof(input: unknown): SkillSamplePacket {
    const packet = input && typeof input === 'object' ? PROOFS.get(input) : undefined;
    if (!packet) reject('skill-sample-proof-not-owned');
    assertCurrentSkillSampleExecutionPlan(packet.plan);
    return normalizeSkillSamplePacket(packet);
}

/** D-Q3a2b2b：读取与 proof 同源的执行证据；非品牌路径返回 null。 */
export function readSkillSampleExecution(input: unknown): SkillSampleExecution | null {
    if (!input || typeof input !== 'object' || !PROOFS.has(input)) reject('skill-sample-proof-not-owned');
    return EXECUTIONS.get(input) ?? null;
}

export interface RunSkillSampleModelInput {
    readonly claim: unknown;
    readonly broker: AdmissionTicketBroker;
    readonly client: ChatCompletionClient;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
    readonly estimateCostMicrousd: NonNullable<AdmittedModelGatewayOptions['estimateCostMicrousd']>;
    readonly auditRequired?: boolean;
    readonly onLeaseClosed?: AdmittedModelGatewayOptions['onLeaseClosed'];
    /** Trusted host-only bridge. Omitted keeps the existing Sample path unchanged. */
    readonly dispatchSidecarFactory?: SkillSampleDispatchSidecarFactory;
    allowed(): boolean;
    readonly signal?: AbortSignal;
    readonly now?: () => string;
}


function guardedClient(client: ChatCompletionClient, assertAuthority: () => void): ChatCompletionClient {
    const complete = client.complete.bind(client);
    return {
        async complete(actual, providerSignal, call) {
            assertAuthority();
            if (!providerSignal || providerSignal.aborted) reject('skill-sample-cancelled');
            return await new Promise<ChatResponse>((resolve, rejectPromise) => {
                let settled = false;
                const settle = (error: unknown, response?: ChatResponse) => {
                    if (settled) return;
                    settled = true; providerSignal.removeEventListener('abort', aborted);
                    if (error) rejectPromise(error); else resolve(response!);
                };
                const aborted = () => settle(new SkillSampleModelError('skill-sample-cancelled'));
                providerSignal.addEventListener('abort', aborted, { once: true });
                try {
                    Promise.resolve(complete(actual, providerSignal, call))
                    .then((response) => settle(null, response), (error) => settle(error));
                }
                catch (error) { settle(error); }
                if (providerSignal.aborted) aborted();
            });
        }, async stream() { reject('skill-sample-request-invalid'); }
    };
}


/** One durable attempt, one lease and two independent calls; partial pairs never obtain a success proof. */
export async function runSkillSampleModel(input: RunSkillSampleModelInput): Promise<SkillSampleProof> {
    const claim = normalizeClaim(input.claim);
    try { assertCurrentSkillSampleExecutionPlan(claim.plan); } catch { reject('skill-sample-registry-stale'); }
    const claimDigest = skillSampleClaimDigest(claim);
    const modelId = evalToken(input.modelId);
    const modelBindingDigest = evalHash(input.modelBindingDigest);
    const budget = normalizeAgentBudgetProfile(input.budgetProfile);
    const budgetProfileDigest = agentBudgetProfileDigest(budget);
    const now = input.now ?? (() => new Date().toISOString());
    const allowed = input.allowed.bind(input);
    if (budget.lane !== 'style' || budget.maxModelCalls !== 2 || budget.maxSteps !== 2
        || budget.maxToolCalls !== 0 || budget.maxWrites !== 0 || budget.agentInputBudgetTokens > 6_000
        || budget.agentOutputBudgetTokens < 2 || budget.agentOutputBudgetTokens > 4_800 || budget.maxWallMs > 45_000
        || claim.modelId !== modelId || claim.modelBindingDigest !== modelBindingDigest)
        reject('skill-sample-claim-invalid');
    if (claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION
        && (claim.plan.suite.perPairBudgetDigest !== budgetProfileDigest
            || claim.plan.suite.perPairInputTokens !== budget.agentInputBudgetTokens
            || claim.plan.suite.perPairOutputTokens !== budget.agentOutputBudgetTokens
            || claim.plan.suite.perPairMaxCostMicrousd !== budget.maxCostMicrousd)) {
        reject('skill-sample-claim-invalid');
    }
    if (typeof input.estimateCostMicrousd !== 'function'
        || input.auditRequired !== false && typeof input.onLeaseClosed !== 'function')
        reject('skill-sample-audit-unavailable');
    const assertAuthority = (): void => {
        if (input.signal?.aborted) reject('skill-sample-cancelled');
        const current = evalTime(now());
        if (current < claim.claimedAt || current >= claim.leaseExpiresAt) reject('skill-sample-deadline-exceeded');
        let open = false;
        try { open = allowed() === true; } catch { /* Host source/control readers fail closed. */ }
        if (!open || skillSampleClaimDigest(input.claim) !== claimDigest || input.modelId !== modelId
            || input.modelBindingDigest !== modelBindingDigest) reject('skill-sample-authority-denied');
    };
    assertAuthority();
    const variants = ['baseline', 'candidate'] as const;
    const suitePlan = claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION
        ? claim.plan : null;
    if (suitePlan && input.dispatchSidecarFactory === undefined) {
        reject('skill-sample-dispatch-evidence-unavailable');
    }
    const requests = variants.map((variant) => buildSkillSampleModelRequest({
        plan: claim.plan, modelId, variant,
        maxOutputTokens: Math.floor(budget.agentOutputBudgetTokens / 2)
    }));
    const requestDigests = requests.map(skillSampleModelRequestDigest);
    let dispatchSidecar: SkillSampleDispatchSidecar | null = null;
    let dispatchArms: readonly [SkillSampleDispatchArmContext, SkillSampleDispatchArmContext] | null = null;
    if (input.dispatchSidecarFactory !== undefined) {
        if (!isCandidateEvaluationSampleDispatchFactory(input.dispatchSidecarFactory) || !suitePlan) {
            reject('skill-sample-dispatch-evidence-unavailable');
        }
        if (input.auditRequired === false || typeof input.onLeaseClosed !== 'function') {
            reject('skill-sample-audit-unavailable');
        }
        const arms = variants.map((variant, index) => evalFreeze({
            variant,
            requestDigest: requestDigests[index]!,
            promptBindingDigest: skillSamplePromptBindingDigest({
                jobId: claim.jobId,
                planDigest: claim.plan.planDigest,
                scenarioOrdinal: suitePlan.suite.scenarioOrdinal,
                repeatIndex: suitePlan.suite.repeatIndex,
                variant,
                requestDigest: requestDigests[index]!,
            }),
        })) as unknown as readonly [SkillSampleDispatchArmContext, SkillSampleDispatchArmContext];
        dispatchArms = arms;
        const context = evalFreeze({
            contextVersion: SKILL_SAMPLE_DISPATCH_CONTEXT_VERSION,
            jobId: claim.jobId,
            planDigest: claim.plan.planDigest,
            sampleKey: claim.jobId,
            scenarioOrdinal: suitePlan.suite.scenarioOrdinal,
            repeatIndex: suitePlan.suite.repeatIndex,
            arms,
        });
        try { dispatchSidecar = normalizeDispatchSidecar(input.dispatchSidecarFactory(context)); }
        catch (error) {
            if (error instanceof SkillSampleModelError) throw error;
            reject('skill-sample-dispatch-evidence-unavailable');
        }
    }
    if (requests.reduce((sum, request) => sum + estimateAdmittedRequestInputTokens(request), 0)
        > budget.agentInputBudgetTokens) reject('skill-sample-request-invalid');
    const deadline = Math.min(Date.parse(claim.leaseExpiresAt), Date.parse(now()) + budget.maxWallMs);
    const controller = new AbortController();
    const combined = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.parse(now()))); timer.unref?.();
    let lease: AdmittedModelLease | null = null;
    /** D-Q3a2b2b：Gateway 的 lease audit 只在关闭回调里出现一次；这里同步留存供执行证据绑定。 */
    let capturedAudit: AdmittedModelLeaseAudit | null = null;
    const candidateBindings: Array<Readonly<{ receiptDigest: string; responseDigest: string | null }>> = [];
    try {
        if (USED_CLAIMS.has(input.claim as object)) reject('skill-sample-claim-replayed');
        USED_CLAIMS.add(input.claim as object);
        const gateway = new AdmittedModelGateway(input.broker, guardedClient(input.client, assertAuthority), {
            nowMs: () => Date.parse(now()), estimateCostMicrousd: input.estimateCostMicrousd,
            auditRequired: input.auditRequired !== false,
            onLeaseClosed: (audit) => {
                capturedAudit = audit;
                input.onLeaseClosed?.(audit);
            },
            prepareRequest: dispatchSidecar?.prepareRequest ?? (async () => null),
            prepareRequestRequired: dispatchSidecar !== null,
            authorizeDispatch: (admission) => {
                try {
                    assertAuthority();
                    return dispatchSidecar?.authorizeDispatch(admission) ?? true;
                } catch { return false; }
            },
        });
        assertAuthority();
        const parentRunId = claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION
            ? claim.plan.suite.suiteId : claim.jobId;
        const ticket = input.broker.issue({
            runId: claim.jobId, parentRunId, sessionId: claim.rawSessionId,
            sourceRevision: claim.plan.planDigest, lane: 'learning', taskKind: 'skill_sample',
            policyVersion: SKILL_SAMPLE_POLICY_VERSION, modelId, budgetProfileDigest,
            toolSetDigest: agentToolSetDigest(requests[0]!.tools ?? []), mode: 'nsf',
            reasonCodes: ['explicit-author-skill-sample'], evidenceDigests: [claim.requestDigest, claim.plan.planDigest,
            claim.plan.source.compilePacket.packetDigest, claim.plan.source.validation.evidenceDigest],
            noveltyDigest: claim.requestDigest, expectedBenefit: 'style-learning',
            limits: admissionLimitsFromBudgetProfile(budget), deadlineMs: deadline,
            allowedTools: [SKILL_SAMPLE_TOOL_NAME], fullSkillSnapshots: [], cooldownKey: `skill-sample:${claim.jobId}`,
            idempotencyKey: `skill-sample:${claim.jobId}:${claim.revision}`, fallback: 'skip-optional-agent'
        });
        lease = gateway.open({
            modelId, tools: requests[0]!.tools, binding: {
                ticketId: ticket.ticketId, runId: ticket.runId, parentRunId: ticket.parentRunId,
                sessionId: ticket.sessionId,
                sourceRevision: ticket.sourceRevision, lane: ticket.lane, taskKind: ticket.taskKind,
                policyVersion: ticket.policyVersion, mode: ticket.mode, budgetProfile: budget,
            }
        });
        const arms: SkillSampleArm[] = [];
        for (const [index, request] of requests.entries()) {
            assertAuthority();
            const response = await lease.complete(request, combined);
            if (dispatchSidecar) {
                try {
                    candidateBindings.push(dispatchSidecar.succeededRequired({
                        variant: variants[index]!, requestDigest: requestDigests[index]!,
                    }));
                } catch { reject('skill-sample-dispatch-evidence-unavailable'); }
            }
            assertAuthority();
            if (combined.aborted || skillSampleModelRequestDigest(request) !== requestDigests[index]) {
                reject('skill-sample-authority-denied');
            }
            arms.push(evalFreeze({
                variant: variants[index]!, requestDigest: requestDigests[index]!,
                ...parseSkillSampleModelResponse(response)
            }));
        }
        assertAuthority();
        let execution: SkillSampleExecution | null = null;
        if (dispatchSidecar && dispatchArms && suitePlan) {
            // Branded path only: close the lease now so the content-free audit is captured
            // synchronously, before the proof (and the execution evidence) leaves this call.
            if (lease.snapshot().status === 'open') lease.finish('completed');
            if (!capturedAudit || candidateBindings.length !== 2) {
                reject('skill-sample-dispatch-evidence-unavailable');
            }
            const audit = capturedAudit as AdmittedModelLeaseAudit;
            if (audit.outcome !== 'completed' || audit.modelCallsUsed !== 2) {
                reject('skill-sample-dispatch-evidence-unavailable');
            }
            const executionArms = arms.map((arm, index): SkillSampleExecutionArm => {
                const binding = candidateBindings[index]!;
                const dispatchArm = dispatchArms![index]!;
                return {
                    variant: arm.variant,
                    promptBindingDigest: dispatchArm.promptBindingDigest,
                    sampleResponseDigest: arm.responseDigest,
                    sampleTextDigest: arm.textDigest,
                    candidateReceiptDigest: binding.receiptDigest,
                    candidateResponseDigest: binding.responseDigest,
                    usage: arm.usage,
                    commonResponseBinding: skillSampleCommonResponseBinding({
                        sampleTextDigest: arm.textDigest, usage: arm.usage,
                    }),
                };
            });
            const executionCore = {
                executionVersion: 'skill-sample-execution-v1' as const,
                jobId: claim.jobId,
                sampleKey: claim.jobId,
                scenarioOrdinal: suitePlan.suite.scenarioOrdinal,
                repeatIndex: suitePlan.suite.repeatIndex,
                planDigest: claim.plan.planDigest,
                arms: executionArms as unknown as readonly [SkillSampleExecutionArm, SkillSampleExecutionArm],
                gatewayAudit: {
                    leaseIdDigest: audit.leaseIdDigest,
                    runId: audit.runId,
                    parentRunId: audit.parentRunId,
                    sourceRevision: audit.sourceRevision,
                    policyVersion: audit.policyVersion,
                    modelId: audit.modelId,
                    budgetProfileDigest: audit.budgetProfileDigest,
                    toolSetDigest: audit.toolSetDigest,
                    startedAt: audit.startedAt,
                    finishedAt: audit.finishedAt,
                    outcome: audit.outcome ?? 'completed',
                    modelCallsUsed: audit.modelCallsUsed,
                    inputTokensUsed: audit.inputTokensUsed,
                    outputTokensUsed: audit.outputTokensUsed,
                    costMicrousdUsed: audit.costMicrousdUsed,
                    quotaReservationDigest: audit.quotaReservationDigest ?? null,
                },
                joinedAt: evalTime(now()),
            };
            execution = normalizeSkillSampleExecution({
                ...executionCore, executionDigest: evalDigest(executionCore),
            });
        }
        const core = {
            packetVersion: SKILL_SAMPLE_PACKET_VERSION, jobId: claim.jobId, rawSessionId: claim.rawSessionId,
            jobRequestDigest: claim.requestDigest, claimDigest, plan: claim.plan, planDigest: claim.plan.planDigest,
            modelId, modelBindingDigest, arms, completedAt: evalTime(now())
        };
        const packet = normalizeSkillSamplePacket({ ...core, packetDigest: evalDigest(core) });
        const proof = evalFreeze({}) as SkillSampleProof;
        PROOFS.set(proof, packet);
        if (execution) EXECUTIONS.set(proof, execution);
        return proof;
    } catch (error) {
        if (error instanceof SkillSampleModelError) throw new SkillSampleModelError(error.code);
        const gatewayCode = safeAdmittedModelGatewayErrorCode(error);
        if (gatewayCode) throw new AdmittedModelGatewayError(gatewayCode);
        return reject('skill-sample-provider-failed');
    } finally {
        clearTimeout(timer);
        if (lease?.snapshot().status === 'open') lease.finish(combined.aborted ? 'cancelled' : 'provider_error');
    }
}
