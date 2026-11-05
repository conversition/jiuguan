/** @author Codex @date 2026-10-16 @version 1.0
 * Independent conformance evaluation records fixture receipts, never candidate mutations or promotion authority.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    SkillEvaluateStore, SKILL_EVALUATE_DB_FILE, type SkillEvaluateJobV1,
    type SkillEvaluateClaimV1, type SkillEvaluateFailureReason
} from '../skill-evaluate-store.ts';
import { readSkillEvaluateProof, runSkillEvaluateModel } from '../skill-evaluate-model.ts';
import { normalizeSkillEvaluatePlan, type SkillEvaluatePlan } from '../skill-evaluate-registry.ts';

type ModelContext = Omit<Parameters<typeof runSkillEvaluateModel>[0], 'claim' | 'allowed' | 'signal'>;
const RETRY_MS = 5_000;

export interface SkillEvaluateRuntimeOptions {
    readonly dataDir: string;
    enabled(): boolean;
    sourceAllowed(rawSessionId: string): boolean;
    resolvePlan(compileJobId: string): SkillEvaluatePlan | null;
    resolveModel(): ModelContext | null;
    readonly now?: () => string;
    readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    onFailure?(code: 'skill-evaluate-open-failed' | 'skill-evaluate-recovery-pending'): void;
}


export function skillEvaluateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.JG_AGENT_SKILL_EVALUATE === '1';
}


export function skillEvaluateSourceCurrent(options: SkillEvaluateRuntimeOptions, plan: SkillEvaluatePlan): boolean {
    try {
        if (!options.sourceAllowed(plan.compilePacket.rawSessionId)) return false;
        const source = options.resolvePlan(plan.compilePacket.jobId);
        return source !== null && normalizeSkillEvaluatePlan(source).planDigest === plan.planDigest;
    } catch { return false; }
}


export function skillEvaluateJobView(job: SkillEvaluateJobV1) {
    return Object.freeze({
        jobId: job.jobId, state: job.state, revision: job.revision, attempt: job.attempt,
        compileJobId: job.plan.compilePacket.jobId, candidateId: job.plan.candidate.candidateId,
        bundleDigest: job.plan.candidate.bundleDigest, candidateRevision: job.plan.candidate.revision,
        evaluatorId: job.plan.evaluatorId, evaluatorVersion: job.plan.evaluatorVersion,
        createdAt: job.createdAt, updatedAt: job.updatedAt, reasonCode: job.reasonCode,
        executionClass: 'fixture' as const, promotionEligible: false, effect: 'unknown' as const,
        literaryQuality: 'unmeasured' as const, sourceCurrentness: 'unchecked' as const,
    });
}


export class SkillEvaluateRuntime {
    readonly #store: SkillEvaluateStore;
    readonly #options: SkillEvaluateRuntimeOptions;
    readonly #owner = `skill-evaluate-worker:${randomUUID()}`;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #active: { rawSessionId: string; controller: AbortController; done: Promise<void> } | null = null;
    #closed = false;
    #busy = false;
    #recovering = true;

    constructor(store: SkillEvaluateStore, options: SkillEvaluateRuntimeOptions) {
        this.#store = store;
        this.#options = options;
        store.recoverUncertain();
        this.#recovering = store.status().running > 0;
    }

    submit(input: { compileJobId: string; idempotencyKey: string }) {
        this.#open();
        if (!this.#options.enabled()) throw new Error('skill-evaluate-disabled');
        const source = this.#options.resolvePlan(input.compileJobId);
        if (!source) throw new Error('skill-evaluate-source-unavailable');
        const plan = normalizeSkillEvaluatePlan(source);
        if (!skillEvaluateSourceCurrent(this.#options, plan)) throw new Error('skill-evaluate-source-unavailable');
        const model = this.#options.resolveModel();
        if (!model) throw new Error('skill-evaluate-model-unavailable');
        const job = this.#store.enqueue({
            rawSessionId: plan.compilePacket.rawSessionId, plan,
            modelId: model.modelId, modelBindingDigest: model.modelBindingDigest, createdAt: this.#now(),
        }, input.idempotencyKey);
        this.schedule();
        return skillEvaluateJobView(job);
    }

    readJob(jobId: string) {
        this.#open();
        const stored = this.#store.read(jobId);
        if (!stored) return null;
        return Object.freeze({
            ...skillEvaluateJobView(stored.job), evaluation: stored.receipt
                ? {
                    packetDigest: stored.receipt.packetDigest, completedAt: stored.receipt.completedAt,
                    passed: stored.receipt.receipt.passed
                } : null
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
        if (this.#closed) throw new Error('skill-evaluate-runtime-closed');
    }

    #now(): string { return this.#options.now?.() ?? new Date().toISOString(); }

    #warn(): void {
        try { this.#options.onFailure?.('skill-evaluate-recovery-pending'); }
        catch { /* Optional diagnostics cannot change conformance verdicts or model execution authority. */ }
    }

    #wake(delayMs: number): void {
        if (this.#closed) return;
        this.#timer = setTimeout(() => { this.#timer = null; void this.#runBatch(); }, delayMs);
        this.#timer.unref?.();
    }

    #allowed(claim: SkillEvaluateClaimV1, signal: AbortSignal): boolean {
        try {
            if (this.#closed || signal.aborted || !this.#options.enabled()
                || !skillEvaluateSourceCurrent(this.#options, claim.plan)) return false;
            const job = this.#store.read(claim.jobId)?.job;
            const model = this.#options.resolveModel();
            return job?.state === 'running' && job.ownerToken === claim.ownerToken
                && model?.modelId === claim.modelId && model.modelBindingDigest === claim.modelBindingDigest;
        } catch { return false; }
    }

    #fail(claim: SkillEvaluateClaimV1, reason: SkillEvaluateFailureReason): void {
        if (this.#closed) return;
        try { this.#store.markFailed(claim, reason); }
        catch { this.#warn(); }
    }

    async #evaluate(claim: SkillEvaluateClaimV1, controller: AbortController): Promise<void> {
        let proof: Awaited<ReturnType<typeof runSkillEvaluateModel>>;
        try {
            const model = this.#options.resolveModel();
            if (!model || !this.#allowed(claim, controller.signal)) {
                throw new Error('skill-evaluate-source-invalidated');
            }
            proof = await runSkillEvaluateModel({
                ...model, claim, signal: controller.signal,
                allowed: () => this.#allowed(claim, controller.signal)
            });
            if (!this.#allowed(claim, controller.signal)) throw new Error('skill-evaluate-source-invalidated');
        } catch {
            this.#fail(claim, this.#allowed(claim, controller.signal)
                ? 'skill-evaluate-model-failed' : 'skill-evaluate-source-invalidated');
            return;
        }
        try { this.#store.finish(claim, proof); }
        catch {
            if (this.#closed) return;
            try {
                const stored = this.#store.read(claim.jobId);
                if (stored?.job.state === 'succeeded'
                    && stored.receipt?.packetDigest === readSkillEvaluateProof(proof).packetDigest) return;
            } catch { this.#warn(); }
            this.#fail(claim, this.#allowed(claim, controller.signal)
                ? 'skill-evaluate-persistence-unconfirmed' : 'skill-evaluate-source-invalidated');
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
                const claim = this.#store.claimNext(this.#owner, 32_000);
                if (claim) {
                    const controller = new AbortController();
                    const done = this.#evaluate(claim, controller);
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
                    if (this.#recovering) this.#wake(1);
                    else if (this.#store.status().queued > 0) this.#wake(RETRY_MS);
                } catch { this.#warn(); this.#wake(RETRY_MS); }
            }
        }
    }
}


export function openSkillEvaluateRuntime(options: SkillEvaluateRuntimeOptions): SkillEvaluateRuntime | null {
    let store: SkillEvaluateStore | null = null;
    try {
        if (!options.enabled() && !existsSync(join(options.dataDir, SKILL_EVALUATE_DB_FILE))) return null;
        store = new SkillEvaluateStore({
            dataDir: options.dataDir, now: options.now,
            isSessionDeleted: options.isSessionDeleted,
            sourceCurrent: (plan) => skillEvaluateSourceCurrent(options, plan)
        });
        const runtime = new SkillEvaluateRuntime(store, options);
        runtime.schedule();
        return runtime;
    } catch {
        try { store?.close(); } catch { /* Preserve the optional service's closed state. */ }
        try { options.onFailure?.('skill-evaluate-open-failed'); }
        catch { /* Optional diagnostics must not block the original dialogue Agents. */ }
        return null;
    }
}
