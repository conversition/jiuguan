/** @author Codex @date 2026-10-16 @version 1.0
 * One admitted model observation of a fixed Style conformance plan; no quality or publication authority.
 */
import { agentBudgetProfileDigest, normalizeAgentBudgetProfile }
    from '../../packages/agent-policy/public/budget-profile.ts';
import { types as nodeTypes } from 'node:util';
import { admissionLimitsFromBudgetProfile, agentToolSetDigest }
    from '../../packages/agent-policy/public/admission.ts';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/public/client.ts';
import { AdmissionTicketBroker } from './agent-admission-broker.ts';
import { AdmittedModelGateway, AdmittedModelGatewayError, safeAdmittedModelGatewayErrorCode,
    type AdmittedModelGatewayOptions, type AdmittedModelLease } from './admitted-model-gateway.ts';
import { assertCurrentSkillEvaluatePlan, normalizeSkillEvaluatePlan, skillEvaluatePlanDigest,
    skillEvaluateHostFindings, SKILL_EVALUATE_RUBRIC, type SkillEvaluatePlan } from './skill-evaluate-registry.ts';
import { evalCanonical, evalDense, evalDigest, evalFreeze, evalHash, evalRawDigest, evalRecord,
    evalSnapshot, evalTime, evalToken, evalUniqueJson } from './skill-evaluate-data.ts';

export { normalizeSkillEvaluatePlan, skillEvaluatePlanDigest } from './skill-evaluate-registry.ts';
export type { SkillEvaluatePlan } from './skill-evaluate-registry.ts';
export const SKILL_EVALUATE_POLICY_VERSION = 'skill-evaluate-style-conformance-v1' as const;
export const SKILL_EVALUATE_PACKET_VERSION = 'skill-evaluate-packet-v1' as const;
export const SKILL_EVALUATE_RECEIPT_VERSION = 'skill-evaluate-receipt-v1' as const;
export const SKILL_EVALUATE_TOOL_NAME = 'submit_skill_evaluation' as const;

export interface SkillEvaluateClaim {
    readonly claimVersion: 'skill-evaluate-claim-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillEvaluatePlan;
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

export interface SkillEvaluateFinding { readonly caseId: string; readonly observed: boolean; }
export interface SkillEvaluateReceipt {
    readonly receiptVersion: typeof SKILL_EVALUATE_RECEIPT_VERSION;
    readonly planDigest: string;
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly expectedCandidateRevision: 1;
    readonly evaluatorId: SkillEvaluatePlan['evaluatorId'];
    readonly evaluatorVersion: SkillEvaluatePlan['evaluatorVersion'];
    readonly registryDigest: string;
    readonly rubricDigest: string;
    readonly fixtureSetDigest: string;
    readonly primitiveRegistryDigest: string;
    readonly findings: readonly Readonly<SkillEvaluateFinding & { hostPassed: boolean; agreement: boolean }>[];
    readonly passed: boolean;
    readonly executionClass: 'fixture';
    readonly evaluationScope: 'style-safeprogram-goal-conformance';
    readonly promotionEligible: false;
    readonly effectOutcome: 'unknown';
    readonly literaryQuality: 'unmeasured';
    readonly completedAt: string;
    readonly evidenceDigest: string;
}

export interface SkillEvaluatePacket {
    readonly packetVersion: typeof SKILL_EVALUATE_PACKET_VERSION;
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly jobRequestDigest: string;
    readonly claimDigest: string;
    readonly plan: SkillEvaluatePlan;
    readonly planDigest: string;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly modelRequestDigest: string;
    readonly responseDigest: string;
    readonly completedAt: string;
    readonly receipt: SkillEvaluateReceipt;
    readonly packetDigest: string;
}

declare const SKILL_EVALUATE_PROOF: unique symbol;
export interface SkillEvaluateProof { readonly [SKILL_EVALUATE_PROOF]: true; }
const PROOFS = new WeakMap<object, SkillEvaluatePacket>();
const USED_CLAIMS = new WeakSet<object>();
const MAX_RESPONSE_CHARS = 16_384;
const RECEIPT_FIELDS = ['receiptVersion', 'planDigest', 'candidateId', 'bundleDigest', 'expectedCandidateRevision',
    'evaluatorId', 'evaluatorVersion', 'registryDigest', 'rubricDigest', 'fixtureSetDigest', 'primitiveRegistryDigest',
    'findings', 'passed', 'executionClass', 'evaluationScope', 'promotionEligible', 'effectOutcome',
    'literaryQuality', 'completedAt', 'evidenceDigest'];

export const SKILL_EVALUATE_MODEL_ERROR_CODES = Object.freeze([
    'skill-evaluate-audit-unavailable', 'skill-evaluate-authority-denied', 'skill-evaluate-cancelled',
    'skill-evaluate-claim-invalid', 'skill-evaluate-claim-replayed', 'skill-evaluate-deadline-exceeded',
    'skill-evaluate-packet-invalid', 'skill-evaluate-proof-not-owned', 'skill-evaluate-provider-failed',
    'skill-evaluate-request-invalid', 'skill-evaluate-response-invalid', 'skill-evaluate-registry-stale',
] as const);
export type SkillEvaluateModelErrorCode = typeof SKILL_EVALUATE_MODEL_ERROR_CODES[number];

export class SkillEvaluateModelError extends Error {
    constructor(readonly code: SkillEvaluateModelErrorCode) {
        if (!(SKILL_EVALUATE_MODEL_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-evaluate-error-code-invalid');
        }
        super(code);
        this.name = 'SkillEvaluateModelError';
    }
}


function reject(code: SkillEvaluateModelErrorCode): never { throw new SkillEvaluateModelError(code); }


function normalizeClaim(input: unknown): SkillEvaluateClaim {
    try {
        const value = evalRecord(evalSnapshot(input), ['claimVersion', 'jobId', 'rawSessionId', 'requestDigest',
            'plan', 'modelId', 'modelBindingDigest', 'createdAt', 'ownerId', 'ownerToken', 'attempt', 'revision',
            'claimedAt', 'leaseExpiresAt']);
        if (value.claimVersion !== 'skill-evaluate-claim-v1' || value.attempt !== 1
            || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('claim-invalid');
        const plan = normalizeSkillEvaluatePlan(value.plan);
        const claim = evalFreeze({
            claimVersion: 'skill-evaluate-claim-v1' as const, jobId: evalToken(value.jobId),
            rawSessionId: evalToken(value.rawSessionId), requestDigest: evalHash(value.requestDigest), plan,
            modelId: evalToken(value.modelId), modelBindingDigest: evalHash(value.modelBindingDigest),
            createdAt: evalTime(value.createdAt), ownerId: evalToken(value.ownerId),
            ownerToken: evalToken(value.ownerToken),
            attempt: 1 as const, revision: Number(value.revision), claimedAt: evalTime(value.claimedAt),
            leaseExpiresAt: evalTime(value.leaseExpiresAt),
        });
        if (claim.rawSessionId !== plan.compilePacket.rawSessionId
            || claim.createdAt < plan.candidate.updatedAt || claim.createdAt > claim.claimedAt
            || claim.claimedAt >= claim.leaseExpiresAt) throw new Error('claim-binding-invalid');
        return claim;
    } catch { reject('skill-evaluate-claim-invalid'); }
}


export function skillEvaluateClaimDigest(input: unknown): string { return evalDigest(normalizeClaim(input)); }


export const SKILL_EVALUATE_TOOL = evalFreeze({
    type: 'function', function: {
        name: SKILL_EVALUATE_TOOL_NAME,
        description: 'Submit only observed truth values for every supplied host-defined conformance case.',
        parameters: {
            type: 'object', additionalProperties: false, required: ['findings'], properties: {
                findings: {
                    type: 'array', minItems: 1, maxItems: 4, items: {
                        type: 'object', additionalProperties: false, required: ['caseId', 'observed'], properties: {
                            caseId: { type: 'string', enum: SKILL_EVALUATE_RUBRIC.map((rule) => `goal.${rule.goal}`) },
                            observed: { type: 'boolean' },
                        },
                    },
                },
            },
        },
    },
});
export const SKILL_EVALUATE_TOOL_SCHEMA_DIGEST = evalDigest(SKILL_EVALUATE_TOOL);


export function buildSkillEvaluateModelRequest(input: { plan: unknown; modelId: string; maxOutputTokens: number }):
    ChatRequest {
    try {
        const plan = assertCurrentSkillEvaluatePlan(input.plan);
        if (!Number.isSafeInteger(input.maxOutputTokens)
            || input.maxOutputTokens < 1 || input.maxOutputTokens > 1_200) {
            reject('skill-evaluate-request-invalid');
        }
        return evalFreeze({
            model: evalToken(input.modelId), messages: [
                {
                    role: 'system', content: 'Observe the supplied host-defined Style SafeProgram conformance cases. '
                        + 'For each case report observed=true only when its exact registered predicate holds '
                        + 'in the supplied program. Missing primitives and zero axes are false. '
                        + 'Use only the required submission tool and cover each case exactly once. '
                        + 'Do not emit prose, scores, pass decisions, new cases, manifest fields, or other tools. '
                        + 'This is fixture goal conformance, not literary quality, production effect, or promotion.'
                },
                { role: 'user', content: evalCanonical({
                    dataVersion: 'skill-evaluate-model-input-v1', rubric: SKILL_EVALUATE_RUBRIC,
                    cases: plan.cases, goals: plan.compilePacket.spec.goals,
                    program: JSON.parse(plan.compilePacket.submission.bundle.body) as unknown,
                }) },
            ], tools: [SKILL_EVALUATE_TOOL],
            tool_choice: { type: 'function', function: { name: SKILL_EVALUATE_TOOL_NAME } },
            temperature: 0, max_tokens: input.maxOutputTokens,
        } as ChatRequest);
    } catch { reject('skill-evaluate-request-invalid'); }
}


/** Exact host request-input bytes, not Provider wire defaults or a reconstructed configuration claim. */
export function skillEvaluateModelRequestDigest(input: ChatRequest): string {
    return evalRawDigest(JSON.stringify(input));
}


function normalizeFindings(input: unknown, plan: SkillEvaluatePlan): readonly SkillEvaluateFinding[] {
    const findings = evalDense(input, plan.cases.length, plan.cases.length).map((item) => {
        const value = evalRecord(item, ['caseId', 'observed']);
        if (typeof value.observed !== 'boolean'
            || !plan.cases.some((entry) => entry.caseId === value.caseId)) reject('skill-evaluate-response-invalid');
        return { caseId: value.caseId as string, observed: value.observed };
    }).sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
    if (new Set(findings.map((item) => item.caseId)).size !== plan.cases.length) {
        reject('skill-evaluate-response-invalid');
    }
    return evalFreeze(findings);
}


export function parseSkillEvaluateModelResponse(input: unknown, planInput: unknown):
    Readonly<{ findings: readonly SkillEvaluateFinding[]; responseDigest: string }> {
    try {
        const plan = normalizeSkillEvaluatePlan(planInput);
        if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) reject('skill-evaluate-response-invalid');
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string'
            || !['content', 'toolCalls', 'finishReason', 'usage', 'raw'].includes(key))) {
            reject('skill-evaluate-response-invalid');
        }
        const value = evalRecord(input, keys as string[]);
        if ((value.content !== null && value.content !== '') || value.finishReason !== 'tool_calls') {
            reject('skill-evaluate-response-invalid');
        }
        const tool = evalRecord(evalDense(value.toolCalls, 1, 1)[0], ['id', 'name', 'arguments']);
        evalToken(tool.id);
        if (tool.name !== SKILL_EVALUATE_TOOL_NAME || typeof tool.arguments !== 'string'
            || tool.arguments.length < 1 || tool.arguments.length > MAX_RESPONSE_CHARS) {
            reject('skill-evaluate-response-invalid');
        }
        const output = evalRecord(evalUniqueJson(tool.arguments), ['findings']);
        const findings = normalizeFindings(output.findings, plan);
        return evalFreeze({ findings, responseDigest: evalRawDigest(JSON.stringify({
            content: value.content, toolCalls: [{ id: tool.id, name: tool.name, arguments: tool.arguments }],
            finishReason: value.finishReason,
        })) });
    } catch { reject('skill-evaluate-response-invalid'); }
}


function receiptFor(plan: SkillEvaluatePlan, observations: readonly SkillEvaluateFinding[], completedAt: string):
    SkillEvaluateReceipt {
    const host = skillEvaluateHostFindings(plan);
    const findings = normalizeFindings(observations, plan).map((item) => {
        const hostPassed = host.find((entry) => entry.caseId === item.caseId)!.passed;
        return { ...item, hostPassed, agreement: item.observed === hostPassed };
    });
    const core = {
        receiptVersion: SKILL_EVALUATE_RECEIPT_VERSION, planDigest: plan.planDigest,
        candidateId: plan.candidate.candidateId, bundleDigest: plan.candidate.bundleDigest,
        expectedCandidateRevision: 1 as const, evaluatorId: plan.evaluatorId, evaluatorVersion: plan.evaluatorVersion,
        registryDigest: plan.registryDigest, rubricDigest: plan.rubricDigest, fixtureSetDigest: plan.fixtureSetDigest,
        primitiveRegistryDigest: plan.primitiveRegistryDigest, findings,
        passed: findings.every((item) => item.hostPassed && item.agreement),
        executionClass: 'fixture' as const, evaluationScope: 'style-safeprogram-goal-conformance' as const,
        promotionEligible: false as const, effectOutcome: 'unknown' as const, literaryQuality: 'unmeasured' as const,
        completedAt: evalTime(completedAt),
    };
    return evalFreeze({ ...core, evidenceDigest: evalDigest(core) });
}


/** Passive historical packet. Even fully rehashed JSON cannot recover Provider-success proof authority. */
export function normalizeSkillEvaluatePacket(input: unknown): SkillEvaluatePacket {
    try {
        const value = evalRecord(evalSnapshot(input), ['packetVersion', 'jobId', 'rawSessionId', 'jobRequestDigest',
            'claimDigest', 'plan', 'planDigest', 'modelId', 'modelBindingDigest', 'modelRequestDigest',
            'responseDigest', 'completedAt', 'receipt', 'packetDigest']);
        if (value.packetVersion !== SKILL_EVALUATE_PACKET_VERSION) reject('skill-evaluate-packet-invalid');
        const plan = normalizeSkillEvaluatePlan(value.plan);
        const metadata = {
            packetVersion: SKILL_EVALUATE_PACKET_VERSION, jobId: evalToken(value.jobId),
            rawSessionId: evalToken(value.rawSessionId), jobRequestDigest: evalHash(value.jobRequestDigest),
            claimDigest: evalHash(value.claimDigest), plan, planDigest: evalHash(value.planDigest),
            modelId: evalToken(value.modelId), modelBindingDigest: evalHash(value.modelBindingDigest),
            modelRequestDigest: evalHash(value.modelRequestDigest), responseDigest: evalHash(value.responseDigest),
            completedAt: evalTime(value.completedAt),
        };
        if (metadata.planDigest !== plan.planDigest || metadata.rawSessionId !== plan.compilePacket.rawSessionId
            || metadata.completedAt < plan.candidate.updatedAt) reject('skill-evaluate-packet-invalid');
        const old = evalRecord(value.receipt, RECEIPT_FIELDS);
        const observations = evalDense(old.findings, plan.cases.length, plan.cases.length).map((item) => {
            const finding = evalRecord(item, ['caseId', 'observed', 'hostPassed', 'agreement']);
            return { caseId: finding.caseId, observed: finding.observed };
        });
        const receipt = receiptFor(plan, observations as readonly SkillEvaluateFinding[], metadata.completedAt);
        if (evalCanonical(old) !== evalCanonical(receipt)) reject('skill-evaluate-packet-invalid');
        const core = { ...metadata, receipt };
        if (evalHash(value.packetDigest) !== evalDigest(core)) reject('skill-evaluate-packet-invalid');
        return evalFreeze({ ...core, packetDigest: value.packetDigest as string });
    } catch { reject('skill-evaluate-packet-invalid'); }
}


export function readSkillEvaluateProof(input: unknown): SkillEvaluatePacket {
    const packet = input && typeof input === 'object' ? PROOFS.get(input) : undefined;
    if (!packet) reject('skill-evaluate-proof-not-owned');
    assertCurrentSkillEvaluatePlan(packet.plan);
    return normalizeSkillEvaluatePacket(packet);
}

export interface RunSkillEvaluateModelInput {
    readonly claim: unknown;
    readonly broker: AdmissionTicketBroker;
    readonly client: ChatCompletionClient;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
    readonly estimateCostMicrousd: NonNullable<AdmittedModelGatewayOptions['estimateCostMicrousd']>;
    readonly auditRequired?: boolean;
    readonly onLeaseClosed?: AdmittedModelGatewayOptions['onLeaseClosed'];
    allowed(): boolean;
    readonly signal?: AbortSignal;
    readonly now?: () => string;
}


/** One real task dispatch; cancellation closes the lease even when an upstream client ignores its signal. */
export async function runSkillEvaluateModel(input: RunSkillEvaluateModelInput): Promise<SkillEvaluateProof> {
    const claim = normalizeClaim(input.claim);
    try { assertCurrentSkillEvaluatePlan(claim.plan); }
    catch { reject('skill-evaluate-registry-stale'); }
    const claimDigest = skillEvaluateClaimDigest(claim);
    const modelId = evalToken(input.modelId);
    const modelBindingDigest = evalHash(input.modelBindingDigest);
    const allowed = input.allowed.bind(input);
    const now = input.now ?? (() => new Date().toISOString());
    const signal = input.signal;
    const estimateCostMicrousd = input.estimateCostMicrousd;
    const onLeaseClosed = input.onLeaseClosed;
    const auditRequired = input.auditRequired !== false;
    const complete = input.client.complete.bind(input.client);
    const budget = normalizeAgentBudgetProfile(input.budgetProfile);
    if (budget.lane !== 'style' || budget.maxModelCalls !== 1 || budget.maxSteps !== 1
        || budget.maxToolCalls !== 0 || budget.maxWrites !== 0 || budget.agentInputBudgetTokens > 8_000
        || budget.agentOutputBudgetTokens > 1_200 || budget.maxWallMs > 30_000
        || claim.modelId !== modelId || claim.modelBindingDigest !== modelBindingDigest) {
        reject('skill-evaluate-claim-invalid');
    }
    if (typeof estimateCostMicrousd !== 'function' || auditRequired && typeof onLeaseClosed !== 'function') {
        reject('skill-evaluate-audit-unavailable');
    }
    const assertAuthority = (): void => {
        if (signal?.aborted) reject('skill-evaluate-cancelled');
        const currentTime = evalTime(now());
        if (currentTime < claim.claimedAt || currentTime >= claim.leaseExpiresAt) {
            reject('skill-evaluate-deadline-exceeded');
        }
        let open = false;
        try { open = allowed() === true; } catch { /* Host source/control readers fail closed. */ }
        if (!open || skillEvaluateClaimDigest(input.claim) !== claimDigest || input.modelId !== modelId
            || input.modelBindingDigest !== modelBindingDigest) reject('skill-evaluate-authority-denied');
    };
    assertAuthority();
    const request = buildSkillEvaluateModelRequest({ plan: claim.plan, modelId,
        maxOutputTokens: budget.agentOutputBudgetTokens });
    const modelRequestDigest = skillEvaluateModelRequestDigest(request);
    const deadline = Math.min(Date.parse(claim.leaseExpiresAt), Date.parse(now()) + budget.maxWallMs);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.parse(now())));
    timer.unref?.();
    let lease: AdmittedModelLease | null = null;
    try {
        if (USED_CLAIMS.has(input.claim as object)) reject('skill-evaluate-claim-replayed');
        USED_CLAIMS.add(input.claim as object);
        const delegate: ChatCompletionClient = {
            async complete(actual, providerSignal, call) {
                assertAuthority();
                if (!providerSignal || providerSignal.aborted) reject('skill-evaluate-cancelled');
                return await new Promise<ChatResponse>((resolve, rejectPromise) => {
                    let settled = false;
                    const settle = (error: unknown, response?: ChatResponse) => {
                        if (settled) return;
                        settled = true;
                        providerSignal.removeEventListener('abort', aborted);
                        if (error) rejectPromise(error); else resolve(response!);
                    };
                    const aborted = () => settle(new SkillEvaluateModelError('skill-evaluate-cancelled'));
                    providerSignal.addEventListener('abort', aborted, { once: true });
                    try {
                        Promise.resolve(complete(actual, providerSignal, call))
                            .then((response) => settle(null, response), (error) => settle(error));
                    } catch (error) { settle(error); }
                    if (providerSignal.aborted) aborted();
                });
            },
            async stream() { reject('skill-evaluate-request-invalid'); },
        };
        const gateway = new AdmittedModelGateway(input.broker, delegate, {
            nowMs: () => Date.parse(now()), estimateCostMicrousd, auditRequired, onLeaseClosed,
            prepareRequest: async () => null,
            authorizeDispatch: () => { try { assertAuthority(); return true; } catch { return false; } },
        });
        assertAuthority();
        const ticket = input.broker.issue({
            runId: claim.jobId, parentRunId: claim.jobId, sessionId: claim.rawSessionId,
            sourceRevision: claim.plan.planDigest, lane: 'learning', taskKind: 'skill_evaluate',
            policyVersion: SKILL_EVALUATE_POLICY_VERSION, modelId,
            budgetProfileDigest: agentBudgetProfileDigest(budget),
            toolSetDigest: agentToolSetDigest(request.tools ?? []), mode: 'nsf',
            reasonCodes: ['explicit-author-skill-evaluate'],
            evidenceDigests: [claim.requestDigest, claim.plan.planDigest, claim.plan.compilePacket.packetDigest,
                claim.plan.validation.evidenceDigest],
            noveltyDigest: claim.requestDigest, expectedBenefit: 'style-learning',
            limits: admissionLimitsFromBudgetProfile(budget), deadlineMs: deadline,
            allowedTools: [SKILL_EVALUATE_TOOL_NAME], fullSkillSnapshots: [],
            cooldownKey: `skill-evaluate:${claim.jobId}`,
            idempotencyKey: `skill-evaluate:${claim.jobId}:${claim.revision}`, fallback: 'skip-optional-agent',
        });
        lease = gateway.open({ modelId, tools: request.tools, binding: {
            ticketId: ticket.ticketId, runId: ticket.runId, parentRunId: ticket.parentRunId,
            sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision, lane: ticket.lane,
            taskKind: ticket.taskKind, policyVersion: ticket.policyVersion, mode: ticket.mode, budgetProfile: budget,
        } });
        const response = await lease.complete(request, combined);
        assertAuthority();
        if (combined.aborted || skillEvaluateModelRequestDigest(request) !== modelRequestDigest) {
            reject('skill-evaluate-authority-denied');
        }
        const parsed = parseSkillEvaluateModelResponse(response, claim.plan);
        const completedAt = evalTime(now());
        const core = {
            packetVersion: SKILL_EVALUATE_PACKET_VERSION, jobId: claim.jobId, rawSessionId: claim.rawSessionId,
            jobRequestDigest: claim.requestDigest, claimDigest, plan: claim.plan, planDigest: claim.plan.planDigest,
            modelId, modelBindingDigest, modelRequestDigest, responseDigest: parsed.responseDigest, completedAt,
            receipt: receiptFor(claim.plan, parsed.findings, completedAt),
        };
        assertAuthority();
        const packet = normalizeSkillEvaluatePacket({ ...core, packetDigest: evalDigest(core) });
        const proof = evalFreeze({}) as SkillEvaluateProof;
        PROOFS.set(proof, packet);
        return proof;
    } catch (error) {
        if (error instanceof SkillEvaluateModelError
            && (SKILL_EVALUATE_MODEL_ERROR_CODES as readonly unknown[]).includes(error.code)) {
            throw new SkillEvaluateModelError(error.code);
        }
        const gatewayCode = safeAdmittedModelGatewayErrorCode(error);
        if (gatewayCode) throw new AdmittedModelGatewayError(gatewayCode);
        return reject('skill-evaluate-provider-failed');
    } finally {
        clearTimeout(timer);
        if (lease?.snapshot().status === 'open') lease.finish(combined.aborted ? 'cancelled' : 'provider_error');
    }
}
