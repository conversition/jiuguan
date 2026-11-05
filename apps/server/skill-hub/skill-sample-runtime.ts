/** @author Codex @date 2026-10-16 @version 1.0
 * Independent neutral paired samples and offline observations; never live consumption or promotion.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    SkillSampleStore, SKILL_SAMPLE_DB_FILE, type SkillSampleJobV1,
    skillSampleSuiteId, type SkillSampleClaimV1, type SkillSampleFailureReason,
    type SkillSamplePacket, type SkillSampleStoredSuite,
} from '../skill-sample-store.ts';
import {
    readSkillSampleProof, runSkillSampleModel, SkillSampleModelError,
    type SkillSampleDispatchSidecarFactory,
} from '../skill-sample-model.ts';
import {
    assertCurrentSkillSampleExecutionPlan, createSkillSampleSuitePlans, normalizeSkillSamplePlan,
    SKILL_SAMPLE_PLAN_VERSION, SKILL_SAMPLE_SUITE_PLAN_VERSION,
    type SkillSampleExecutionPlan, type SkillSamplePlan,
} from '../skill-sample-registry.ts';
import {
    agentBudgetProfileDigest, normalizeAgentBudgetProfile,
} from '../../../packages/agent-policy/public/budget-profile.ts';

type ModelContext = Omit<Parameters<typeof runSkillSampleModel>[0], 'claim' | 'allowed' | 'signal'>;
const RETRY_MS = 5_000;
const CLAIM_LEASE_MS = 47_000;

export interface SkillSampleRuntimeOptions {
    readonly dataDir: string;
    enabled(): boolean;
    suiteEnabled?(): boolean;
    sourceAllowed(rawSessionId: string): boolean;
    resolvePlan(compileJobId: string): SkillSamplePlan | null;
    /** Readback only: reconstruct the exact immutable source for already-completed evidence. */
    resolveCompletedPlan?(compileJobId: string): SkillSamplePlan | null;
    resolveModel(): ModelContext | null;
    /** Trusted host-only Candidate arm ledger. Presence makes every V2 dispatch require evidence. */
    resolveDispatchSidecarFactory?(input: Readonly<{
        jobId: string;
        plan: SkillSampleExecutionPlan;
        modelId: string;
        modelBindingDigest: string;
    }>): SkillSampleDispatchSidecarFactory;
    readonly now?: () => string;
    readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    onFailure?(code: 'skill-sample-open-failed' | 'skill-sample-recovery-pending'): void;
}


/** Private downstream hand-off. This contains generated bodies and must never be serialized by an API adapter. */
export interface SkillSampleQualityInput {
    readonly rawSessionId: string;
    readonly sampleSuiteId: string;
    readonly sampleManifestDigest: string;
    readonly sampleMatrixDigest: string;
    readonly samplePackets: readonly SkillSamplePacket[];
    readonly generation: Readonly<{
        modelId: string;
        modelBindingDigest: string;
    }>;
}


export function skillSampleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.JG_AGENT_SKILL_SAMPLE === '1';
}


export function skillSampleSuiteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return skillSampleEnabled(env) && env.JG_AGENT_SKILL_SAMPLE_SUITE === '1';
}


export function skillSampleSourceCurrent(options: SkillSampleRuntimeOptions, plan: SkillSampleExecutionPlan,
    completed = false): boolean {
    try {
        if (!options.sourceAllowed(plan.source.compilePacket.rawSessionId)) return false;
        if (completed && !options.resolveCompletedPlan) return false;
        const source = completed ? options.resolveCompletedPlan!(plan.source.compilePacket.jobId)
            : options.resolvePlan(plan.source.compilePacket.jobId);
        if (source === null) return false;
        const current = normalizeSkillSamplePlan(source);
        if (plan.planVersion === SKILL_SAMPLE_PLAN_VERSION) return current.planDigest === plan.planDigest;
        assertCurrentSkillSampleExecutionPlan(plan);
        return current.source.planDigest === plan.source.planDigest
            && current.candidateInstructionDigest === plan.candidateInstructionDigest;
    } catch { return false; }
}


export function skillSampleJobView(job: SkillSampleJobV1) {
    const suite = job.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION ? {
        suiteDefinitionId: job.plan.suite.suiteDefinitionId, suiteId: job.plan.suite.suiteId,
        suiteManifestDigest: job.plan.suite.manifestDigest,
        scenarioOrdinal: job.plan.suite.scenarioOrdinal, repeatIndex: job.plan.suite.repeatIndex,
    } : {};
    return Object.freeze({
        jobId: job.jobId, state: job.state, revision: job.revision, attempt: job.attempt,
        compileJobId: job.plan.source.compilePacket.jobId, candidateId: job.plan.source.candidate.candidateId,
        bundleDigest: job.plan.source.candidate.bundleDigest, candidateRevision: job.plan.source.candidate.revision,
        fixtureId: job.plan.fixture.fixtureId, fixtureSetDigest: job.plan.fixtureSetDigest,
        rendererVersion: job.plan.rendererVersion, compilerRevision: job.plan.compilerRevision,
        createdAt: job.createdAt, updatedAt: job.updatedAt, reasonCode: job.reasonCode,
        executionClass: 'fixture' as const, promotionEligible: false, effect: 'unknown' as const,
        literaryQuality: 'unmeasured' as const, sourceCurrentness: 'unchecked' as const,
        ...suite,
    });
}


export function skillSampleSuiteView(stored: SkillSampleStoredSuite) {
    const first = stored.plans[0]!;
    const states = stored.jobs.map((item) => item.job.state);
    const completedPairCount = states.filter((state) => state === 'succeeded').length;
    const failedPairCount = states.filter((state) => state === 'failed').length;
    const uncertainPairCount = states.filter((state) => state === 'uncertain').length;
    const runningPairCount = states.filter((state) => state === 'running').length;
    const queuedPairCount = states.filter((state) => state === 'queued').length;
    let completeScenarioCount = 0;
    for (let ordinal = 0; ordinal < first.suite.scenarioCount; ordinal += 1) {
        const start = ordinal * first.suite.repeatCount;
        if (states.slice(start, start + first.suite.repeatCount).every((state) => state === 'succeeded')) {
            completeScenarioCount += 1;
        }
    }
    return Object.freeze({
        suiteId: stored.suiteId, suiteDefinitionId: first.suite.suiteDefinitionId,
        state: stored.state, compileJobId: first.source.compilePacket.jobId,
        candidateId: first.source.candidate.candidateId, bundleDigest: first.source.candidate.bundleDigest,
        candidateRevision: first.source.candidate.revision, fixtureSetDigest: first.fixtureSetDigest,
        suiteManifestDigest: first.suite.manifestDigest,
        scenarioCount: first.suite.scenarioCount, repeatCount: first.suite.repeatCount,
        pairCount: first.suite.pairCount, totalModelCalls: first.suite.totalModelCalls,
        perPairBudgetDigest: first.suite.perPairBudgetDigest,
        totalInputTokens: first.suite.totalInputTokens, totalOutputTokens: first.suite.totalOutputTokens,
        totalMaxCostMicrousd: first.suite.totalMaxCostMicrousd,
        coverage: {
            completedPairCount, failedPairCount, uncertainPairCount, runningPairCount, queuedPairCount,
            missingPairCount: 0, completeScenarioCount,
            completionRateBps: Math.floor(completedPairCount * 10_000 / first.suite.pairCount),
            matrixStatus: completedPairCount === first.suite.pairCount ? 'complete' as const : 'incomplete' as const,
        },
        children: stored.jobs.map((item, index) => Object.freeze({
            jobId: item.job.jobId, state: item.job.state,
            scenarioOrdinal: stored.plans[index]!.suite.scenarioOrdinal,
            repeatIndex: stored.plans[index]!.suite.repeatIndex,
            updatedAt: item.job.updatedAt, reasonCode: item.job.reasonCode,
        })),
        createdAt: stored.createdAt, updatedAt: stored.updatedAt,
        evaluation: stored.evaluation ? {
            evidenceDigest: stored.evaluation.evidenceDigest,
            algorithmVersion: stored.evaluation.algorithmVersion,
            sourceAlgorithmVersion: stored.evaluation.sourceAlgorithmVersion,
            scenarioSetDigest: stored.evaluation.scenarioSetDigest,
            sampleMatrixDigest: stored.evaluation.sampleMatrixDigest,
            generationConfigDigest: stored.evaluation.generationConfigDigest,
            metricPolicyDigest: stored.evaluation.metricPolicyDigest,
            coverage: stored.evaluation.coverage, metrics: stored.evaluation.metrics,
        } : null,
        executionClass: 'fixture' as const, interpretation: 'descriptive-proxy-only' as const,
        causalEffect: 'unsupported' as const, effect: 'unknown' as const,
        literaryQuality: 'unmeasured' as const, semanticQuality: 'unmeasured' as const,
        promotionEligible: false, sourceCurrentness: 'unchecked' as const,
    });
}


export class SkillSampleRuntime {
    readonly #store: SkillSampleStore;
    readonly #options: SkillSampleRuntimeOptions;
    readonly #owner = `skill-sample-worker:${randomUUID()}`;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #active: { rawSessionId: string; controller: AbortController; done: Promise<void> } | null = null;
    #closed = false;
    #busy = false;
    #recovering = true;

    constructor(store: SkillSampleStore, options: SkillSampleRuntimeOptions) {
        this.#store = store;
        this.#options = options;
        store.recoverUncertain();
        this.#recovering = store.status().running > 0;
    }

    submit(input: { compileJobId: string; idempotencyKey: string }) {
        this.#open();
        if (!this.#options.enabled()) throw new Error('skill-sample-disabled');
        const source = this.#options.resolvePlan(input.compileJobId);
        if (!source) throw new Error('skill-sample-source-unavailable');
        const plan = normalizeSkillSamplePlan(source);
        if (!skillSampleSourceCurrent(this.#options, plan)) throw new Error('skill-sample-source-unavailable');
        const model = this.#options.resolveModel();
        if (!model) throw new Error('skill-sample-model-unavailable');
        const job = this.#store.enqueue({
            rawSessionId: plan.source.compilePacket.rawSessionId, plan,
            modelId: model.modelId, modelBindingDigest: model.modelBindingDigest, createdAt: this.#now(),
        }, input.idempotencyKey);
        this.schedule();
        return skillSampleJobView(job);
    }

    submitSuite(input: { compileJobId: string; idempotencyKey: string }) {
        this.#open();
        if (!this.#suiteEnabled()) throw new Error('skill-sample-suite-disabled');
        const source = this.#options.resolvePlan(input.compileJobId);
        if (!source) throw new Error('skill-sample-suite-source-unavailable');
        const base = normalizeSkillSamplePlan(source);
        if (!skillSampleSourceCurrent(this.#options, base)) {
            throw new Error('skill-sample-suite-source-unavailable');
        }
        const model = this.#options.resolveModel();
        if (!model) throw new Error('skill-sample-suite-model-unavailable');
        let budget: ReturnType<typeof normalizeAgentBudgetProfile>;
        try {
            budget = normalizeAgentBudgetProfile(model.budgetProfile);
            if (budget.lane !== 'style' || budget.maxModelCalls !== 2 || budget.maxSteps !== 2
                || budget.maxToolCalls !== 0 || budget.maxWrites !== 0
                || budget.agentInputBudgetTokens > 6_000
                || budget.agentOutputBudgetTokens < 2 || budget.agentOutputBudgetTokens > 4_800
                || budget.maxWallMs > 45_000) throw new Error('invalid');
        } catch { throw new Error('skill-sample-suite-model-unavailable'); }
        const suiteId = skillSampleSuiteId(input.idempotencyKey);
        const plans = createSkillSampleSuitePlans(base.source, {
            suiteId, perPairBudgetDigest: agentBudgetProfileDigest(budget),
            perPairInputTokens: budget.agentInputBudgetTokens,
            perPairOutputTokens: budget.agentOutputBudgetTokens,
            perPairMaxCostMicrousd: budget.maxCostMicrousd,
        });
        const stored = this.#store.enqueueSuite({
            rawSessionId: base.source.compilePacket.rawSessionId, plans,
            modelId: model.modelId, modelBindingDigest: model.modelBindingDigest, createdAt: this.#now(),
        }, input.idempotencyKey);
        this.schedule();
        return skillSampleSuiteView(stored);
    }

    readJob(jobId: string) {
        this.#open();
        const stored = this.#store.read(jobId);
        if (!stored) return null;
        return Object.freeze({
            ...skillSampleJobView(stored.job), evaluation: stored.evaluation
                ? {
                    evidenceDigest: stored.evaluation.evidenceDigest,
                    packetDigest: stored.packet?.packetDigest, completedAt: stored.packet?.completedAt,
                    algorithmVersion: stored.evaluation.algorithmVersion, rubricDigest: stored.evaluation.rubricDigest,
                    arms: stored.evaluation.arms, delta: stored.evaluation.delta,
                    goalObservations: stored.evaluation.goalObservations
                } : null,
        });
    }

    readSuite(suiteId: string) {
        this.#open();
        const stored = this.#store.readSuite(suiteId);
        return stored ? skillSampleSuiteView(stored) : null;
    }

    /**
     * 只读：把**存储层**的 suite 交给发布侧的汇合适配器（需要 packet/execution，视图里没有）。
     * 不做额外授权判定；调用方负责自己的准入。
     */
    readStoredSuite(suiteId: string): SkillSampleStoredSuite | null {
        this.#open();
        return this.#store.readSuite(suiteId);
    }

    /**
     * A successful, still-current V2 matrix is the only quality-stage source.
     * Unlike readSuite(), this is an in-process capability port and deliberately carries raw arm bodies.
     */
    readQualityInput(suiteId: string): SkillSampleQualityInput | null {
        return this.#readQualityInput(suiteId, false);
    }

    /** Completed evidence only; never used to start or dispatch a model call. */
    readCompletedQualityInput(suiteId: string): SkillSampleQualityInput | null {
        return this.#readQualityInput(suiteId, true);
    }

    #readQualityInput(suiteId: string, completed: boolean): SkillSampleQualityInput | null {
        this.#open();
        const stored = this.#store.readSuite(suiteId);
        if (!stored || stored.state !== 'succeeded' || !stored.evaluation
            || stored.plans.some((plan) => plan.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION
                || !skillSampleSourceCurrent(this.#options, plan, completed))) return null;
        const first = stored.jobs[0]?.job;
        if (!first || first.plan.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION
            || first.plan.suite.suiteId !== suiteId) return null;
        const packets: SkillSamplePacket[] = [];
        for (const item of stored.jobs) {
            if (!item.packet || item.job.rawSessionId !== first.rawSessionId
                || item.job.modelId !== first.modelId
                || item.job.modelBindingDigest !== first.modelBindingDigest) return null;
            packets.push(item.packet);
        }
        return Object.freeze({
            rawSessionId: first.rawSessionId,
            sampleSuiteId: suiteId,
            sampleManifestDigest: first.plan.suite.manifestDigest,
            sampleMatrixDigest: stored.evaluation.sampleMatrixDigest,
            samplePackets: Object.freeze(packets),
            generation: Object.freeze({
                modelId: first.modelId,
                modelBindingDigest: first.modelBindingDigest,
            }),
        });
    }

    schedule(): void {
        if (this.#closed || this.#busy) return;
        if (this.#timer) clearTimeout(this.#timer);
        this.#wake(0);
    }

    async quiesceSession(rawSessionId: string): Promise<void> {
        const active = this.#active;
        if (active?.rawSessionId !== rawSessionId) return;
        active.controller.abort();
        await active.done;
    }

    redactSession(rawSessionId: string): void {
        this.#open();
        if (this.#active?.rawSessionId === rawSessionId) this.#active.controller.abort();
        this.#store.redactSession(rawSessionId);
    }

    async shutdown(): Promise<void> {
        this.#active?.controller.abort();
        await this.#active?.done.catch(() => this.#warn());
        this.close();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#active?.controller.abort();
        this.#store.close();
    }

    #open(): void {
        if (this.#closed) throw new Error('skill-sample-runtime-closed');
    }

    #now(): string { return this.#options.now?.() ?? new Date().toISOString(); }

    #suiteEnabled(): boolean {
        try { return this.#options.enabled() && this.#options.suiteEnabled?.() === true; }
        catch { return false; }
    }

    #warn(): void {
        try { this.#options.onFailure?.('skill-sample-recovery-pending'); }
        catch { /* Optional diagnostics cannot change the sample execution authority. */ }
    }

    #wake(delayMs: number): void {
        if (this.#closed) return;
        this.#timer = setTimeout(() => { this.#timer = null; void this.#runBatch(); }, delayMs);
        this.#timer.unref?.();
    }

    #allowed(claim: SkillSampleClaimV1, signal: AbortSignal): boolean {
        try {
            if (this.#closed || signal.aborted || !this.#options.enabled()
                || claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION && !this.#suiteEnabled()
                || !skillSampleSourceCurrent(this.#options, claim.plan)) return false;
            const job = this.#store.read(claim.jobId)?.job;
            const model = this.#options.resolveModel();
            return job?.state === 'running' && job.ownerToken === claim.ownerToken
                && model?.modelId === claim.modelId && model.modelBindingDigest === claim.modelBindingDigest;
        } catch { return false; }
    }

    #fail(claim: SkillSampleClaimV1, reason: SkillSampleFailureReason): void {
        if (this.#closed) return;
        try {
            this.#store.markFailed(claim, reason);
            if (claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION) {
                this.#store.closeSuiteQueued(claim.plan.suite.suiteId);
            }
        }
        catch {
            this.#recovering = true;
            this.#warn();
        }
    }

    async #sample(claim: SkillSampleClaimV1, controller: AbortController): Promise<void> {
        let proof: Awaited<ReturnType<typeof runSkillSampleModel>>;
        try {
            const model = this.#options.resolveModel();
            if (!model || !this.#allowed(claim, controller.signal)) {
                throw new Error('skill-sample-source-invalidated');
            }
            let dispatchSidecarFactory: SkillSampleDispatchSidecarFactory | undefined;
            if (claim.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION) {
                const resolve = this.#options.resolveDispatchSidecarFactory;
                if (!resolve) throw new SkillSampleModelError(
                    'skill-sample-dispatch-evidence-unavailable',
                );
                try {
                    dispatchSidecarFactory = resolve({
                        jobId: claim.jobId, plan: claim.plan,
                        modelId: claim.modelId, modelBindingDigest: claim.modelBindingDigest,
                    });
                } catch {
                    throw new SkillSampleModelError('skill-sample-dispatch-evidence-unavailable');
                }
            }
            proof = await runSkillSampleModel({
                ...model, claim, signal: controller.signal, allowed: () => this.#allowed(claim, controller.signal),
                dispatchSidecarFactory,
            });
            if (!this.#allowed(claim, controller.signal)) throw new Error('skill-sample-source-invalidated');
        } catch (error) {
            const current = this.#allowed(claim, controller.signal);
            this.#fail(claim, current && error instanceof SkillSampleModelError
                && error.code === 'skill-sample-dispatch-evidence-unavailable'
                ? 'skill-sample-dispatch-evidence-unavailable'
                : current ? 'skill-sample-model-failed' : 'skill-sample-source-invalidated');
            return;
        }
        try { this.#store.finish(claim, proof); }
        catch {
            if (this.#closed) return;
            try {
                const stored = this.#store.read(claim.jobId);
                if (stored?.job.state === 'succeeded'
                    && stored.packet?.packetDigest === readSkillSampleProof(proof).packetDigest) return;
            } catch { this.#warn(); }
            this.#fail(claim, this.#allowed(claim, controller.signal)
                ? 'skill-sample-persistence-unconfirmed' : 'skill-sample-source-invalidated');
            this.#warn();
        }
    }

    async #runBatch(): Promise<void> {
        if (this.#closed || this.#busy) return;
        this.#busy = true;
        try {
            if (this.#recovering) {
                this.#store.recoverUncertain();
                this.#recovering = this.#store.status().running > 0;
                if (this.#recovering) return;
            }
            if (this.#options.enabled()) {
                const claim = this.#store.claimNext(this.#owner, CLAIM_LEASE_MS, (plan) =>
                    plan.planVersion === SKILL_SAMPLE_PLAN_VERSION || this.#suiteEnabled());
                if (claim) {
                    const controller = new AbortController();
                    const done = this.#sample(claim, controller);
                    this.#active = { rawSessionId: claim.rawSessionId, controller, done };
                    try { await done; }
                    finally { this.#active = null; }
                }
            }
        } catch { this.#warn(); }
        finally {
            this.#busy = false;
            if (!this.#closed) {
                try {
                    if (this.#recovering) this.#wake(RETRY_MS);
                    else if (this.#store.status().queued > 0) this.#wake(RETRY_MS);
                } catch { this.#warn(); this.#wake(RETRY_MS); }
            }
        }
    }
}


export function openSkillSampleRuntime(options: SkillSampleRuntimeOptions): SkillSampleRuntime | null {
    let store: SkillSampleStore | null = null;
    try {
        if (!options.enabled() && !existsSync(join(options.dataDir, SKILL_SAMPLE_DB_FILE))) return null;
        store = new SkillSampleStore({
            dataDir: options.dataDir, now: options.now, isSessionDeleted: options.isSessionDeleted,
            sourceCurrent: (plan) => skillSampleSourceCurrent(options, plan),
        });
        const runtime = new SkillSampleRuntime(store, options);
        runtime.schedule();
        return runtime;
    } catch {
        try { store?.close(); } catch { /* Preserve the optional service's closed state. */ }
        try { options.onFailure?.('skill-sample-open-failed'); }
        catch { /* A fixture service failure must not block original dialogue Agents. */ }
        return null;
    }
}
