/** @author Codex @date 2026-10-16 @version 1.0
 * Explicit author compilation runs outside game turns; durable model attempts are never replayed.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    SkillCompileStore, SKILL_COMPILE_DB_FILE, type SkillCompileClaimV1,
    type SkillCompileJobV1, type SkillCompilePacket
} from '../skill-compile-store.ts';
import { normalizeSkillCompileSpec, runSkillCompileModel } from '../skill-compile-model.ts';
import { normalizeAgentSkillCandidate, type AgentSkillCandidateRecordV1 } from '@jiuguan/skill-hub';
import type { AgentSkillCandidateRuntime } from './candidate-runtime.ts';

type ModelContext = Omit<Parameters<typeof runSkillCompileModel>[0], 'claim' | 'allowed' | 'signal'>;
type CandidatePort = Pick<AgentSkillCandidateRuntime, 'submitCandidate' | 'readCandidate' | 'getJob'>;
const RETRY_MS = 5_000;
const MAX_PREPARED = 64;

export interface SkillCompileRuntimeOptions {
    readonly dataDir: string;
    readonly candidates: CandidatePort | null;
    enabled(): boolean;
    sourceAllowed(rawSessionId: string): boolean;
    resolveModel(): ModelContext | null;
    readonly now?: () => string;
    readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    onFailure?(code: 'skill-compile-open-failed' | 'skill-compile-recovery-pending'): void;
}


export function skillCompileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.JG_AGENT_SKILL_COMPILE === '1' && env.JG_AGENT_SKILL_CANDIDATES === '1';
}


export function skillCompileJobView(job: SkillCompileJobV1) {
    return Object.freeze({
        jobId: job.jobId, state: job.state, revision: job.revision, attempt: job.attempt,
        skillId: job.spec.skillId, version: job.spec.version,
        createdAt: job.createdAt, updatedAt: job.updatedAt, candidateId: job.candidateId,
        validationJobId: job.validationJobId, reasonCode: job.reasonCode,
        publication: 'draft-only' as const,
    });
}


/**
 * Completed evaluation evidence is permanently bound to the validated/rev1 snapshot which entered
 * Compile. Adoption is the only lifecycle step allowed to retain that historical snapshot: it adds
 * one validated -> validated transition and does not change the bundle or validation evidence.
 *
 * This projection is deliberately narrower than a general revision rewind. It cannot make a live
 * Sample/Evaluate source current and it rejects fixture replay, promotion, kill, or future revisions.
 */
function completedEvidenceCandidate(
    candidate: AgentSkillCandidateRecordV1,
): AgentSkillCandidateRecordV1 | null {
    if (candidate.state === 'validated' && candidate.revision === 1) return candidate;
    if (candidate.state !== 'validated' || candidate.revision !== 2 || candidate.history.length !== 2) {
        return null;
    }
    const validation = candidate.history[0];
    const adoption = candidate.history[1];
    if (!validation || !adoption
        || validation.revision !== 1 || validation.eventType !== 'validation-result'
        || validation.fromState !== 'candidate' || validation.toState !== 'validated'
        || adoption.revision !== 2 || adoption.eventType !== 'adoption'
        || adoption.fromState !== 'validated' || adoption.toState !== 'validated'
        || candidate.validationEvidenceDigest !== validation.evidenceDigest
        || candidate.operationalReplayEvidenceDigest !== null) return null;
    try {
        return normalizeAgentSkillCandidate({
            ...candidate,
            revision: 1,
            updatedAt: validation.occurredAt,
            operationalReplayEvidenceDigest: null,
            history: [validation],
        });
    } catch { return null; }
}


export class SkillCompileRuntime {
    readonly #store: SkillCompileStore;
    readonly #options: SkillCompileRuntimeOptions;
    readonly #owner = `skill-compile-worker:${randomUUID()}`;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #closed = false;
    #busy = false;
    #recovering = true;
    #cursor = 0;
    #active: { rawSessionId: string; controller: AbortController; done: Promise<void> } | null = null;

    constructor(store: SkillCompileStore, options: SkillCompileRuntimeOptions) {
        this.#store = store;
        this.#options = options;
        // Only startup may close an unknown paid attempt. It must never be turned back into queued.
        store.recoverUncertain();
        this.#recovering = store.status().running > 0;
    }

    submit(input: { rawSessionId: string; idempotencyKey: string; spec: unknown }) {
        this.#open();
        if (!this.#options.enabled() || !this.#options.candidates) throw new Error('skill-compile-disabled');
        const spec = normalizeSkillCompileSpec(input.spec);
        if (!this.#options.sourceAllowed(input.rawSessionId)) throw new Error('skill-compile-source-unavailable');
        const model = this.#options.resolveModel();
        if (!model) throw new Error('skill-compile-model-unavailable');
        const job = this.#store.enqueue({
            rawSessionId: input.rawSessionId, spec, modelId: model.modelId,
            modelBindingDigest: model.modelBindingDigest, createdAt: this.#now(),
        }, input.idempotencyKey);
        this.schedule();
        return skillCompileJobView(job);
    }

    readJob(jobId: string) {
        this.#open();
        const stored = this.#store.read(jobId);
        if (!stored) return null;
        const candidate = stored.job.candidateId
            ? this.#options.candidates?.readCandidate(stored.job.candidateId) : null;
        return Object.freeze({
            ...skillCompileJobView(stored.job),
            candidateState: candidate?.candidate.state ?? null,
            staticValidationPassed: candidate?.validation?.passed ?? null,
            operationallyVerified: false, active: false,
        });
    }

    readEvaluationInput(jobId: string) {
        this.#open();
        const source = this.#store.read(jobId);
        if (source?.job.state !== 'succeeded' || !source.preparedPacket
            || !source.job.candidateId || !source.job.validationJobId || !this.#options.candidates) return null;
        const stored = this.#options.candidates.readCandidate(source.job.candidateId);
        const validationJob = this.#options.candidates.getJob(source.job.validationJobId);
        if (!stored?.validation?.passed || stored.candidate.state !== 'validated'
            || stored.candidate.revision !== 1 || validationJob?.state !== 'succeeded'
            || validationJob.candidateId !== stored.candidate.candidateId
            || stored.bundle.bundleDigest !== source.preparedPacket.submission.bundle.bundleDigest
            || stored.candidate.createdAt !== source.preparedPacket.completedAt) return null;
        // This is historical input, not model-success authority or permission to promote a candidate.
        return Object.freeze({ compilePacket: source.preparedPacket,
            candidate: stored.candidate, validation: stored.validation });
    }

    /**
     * Read-only restart path for already-completed durable evidence. Unlike readEvaluationInput,
     * this may project an adopted rev2 record back to its exact immutable validated/rev1 source.
     * It is not a dispatch authority; callers must still verify their completed/current evidence.
     */
    readCompletedEvidenceInput(jobId: string) {
        this.#open();
        const source = this.#store.read(jobId);
        if (source?.job.state !== 'succeeded' || !source.preparedPacket
            || !source.job.candidateId || !source.job.validationJobId || !this.#options.candidates) return null;
        const stored = this.#options.candidates.readCandidate(source.job.candidateId);
        const validationJob = this.#options.candidates.getJob(source.job.validationJobId);
        if (!stored?.validation?.passed || validationJob?.state !== 'succeeded'
            || validationJob.candidateId !== stored.candidate.candidateId
            || stored.bundle.bundleDigest !== source.preparedPacket.submission.bundle.bundleDigest
            || stored.candidate.createdAt !== source.preparedPacket.completedAt) return null;
        const candidate = completedEvidenceCandidate(stored.candidate);
        if (!candidate || candidate.candidateId !== source.job.candidateId
            || candidate.validationEvidenceDigest !== stored.validation.evidenceDigest
            || candidate.updatedAt !== stored.validation.validatedAt) return null;
        return Object.freeze({ compilePacket: source.preparedPacket,
            candidate, validation: stored.validation });
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
        await this.#active?.done.catch(() => { this.#warn(); });
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
        if (this.#closed) throw new Error('skill-compile-runtime-closed');
    }

    #now(): string {
        return this.#options.now?.() ?? new Date().toISOString();
    }

    #wake(delayMs: number): void {
        if (this.#closed) return;
        this.#timer = setTimeout(() => { this.#timer = null; void this.#runBatch(); }, delayMs);
        this.#timer.unref?.();
    }

    #warn(): void {
        try { this.#options.onFailure?.('skill-compile-recovery-pending'); }
        catch { /* Diagnostic failure cannot authorize model replay or publication. */ }
    }

    #allowed(claim: SkillCompileClaimV1, signal: AbortSignal): boolean {
        try {
            if (this.#closed || signal.aborted || !this.#options.enabled()
                || !this.#options.sourceAllowed(claim.rawSessionId)) return false;
            const current = this.#store.read(claim.jobId)?.job;
            const model = this.#options.resolveModel();
            return current?.state === 'running' && current.ownerToken === claim.ownerToken
                && model?.modelId === claim.modelId && model.modelBindingDigest === claim.modelBindingDigest;
        } catch { return false; }
    }

    #deliver(job: SkillCompileJobV1, packet: SkillCompilePacket): void {
        if (job.state !== 'prepared' || this.#closed || !this.#options.enabled()
            || !this.#options.sourceAllowed(job.rawSessionId) || !this.#options.candidates) return;
        const result = this.#options.candidates.submitCandidate(packet.submission, `skill-compile:${job.jobId}`);
        const readback = this.#options.candidates.readCandidate(result.candidate.candidateId);
        const validationJob = this.#options.candidates.getJob(result.job.jobId);
        if (!readback || !validationJob || readback.candidate.bundleDigest !== result.candidate.bundleDigest
            || readback.bundle.bundleDigest !== packet.submission.bundle.bundleDigest
            || readback.candidate.createdAt !== packet.submission.createdAt
            || validationJob.candidateId !== result.candidate.candidateId) {
            throw new Error('skill-compile-candidate-readback-failed');
        }
        this.#store.markDelivered(job.jobId, packet.packetDigest, result.candidate.candidateId, result.job.jobId);
    }

    async #compile(claim: SkillCompileClaimV1, controller: AbortController): Promise<void> {
        let prepared: ReturnType<SkillCompileStore['prepare']>;
        try {
            const model = this.#options.resolveModel();
            if (!model || !this.#allowed(claim, controller.signal)) {
                throw new Error('skill-compile-source-invalidated');
            }
            const proof = await runSkillCompileModel({
                ...model, claim, signal: controller.signal,
                allowed: () => this.#allowed(claim, controller.signal)
            });
            if (!this.#allowed(claim, controller.signal)) throw new Error('skill-compile-source-invalidated');
            prepared = this.#store.prepare(claim, proof);
        } catch {
            if (!this.#closed) {
                try {
                    this.#store.markFailed(claim, this.#allowed(claim, controller.signal)
                        ? 'skill-compile-model-failed' : 'skill-compile-source-invalidated');
                }
                catch { this.#warn(); }
            }
            return;
        }
        // Delivery failure retains the exact durable packet. This branch can never call a model again.
        if (prepared.preparedPacket) this.#deliver(prepared.job, prepared.preparedPacket);
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
            const previousCursor = this.#cursor;
            const page = this.#store.scanPrepared(MAX_PREPARED, previousCursor);
            this.#cursor = page.hasMore ? page.nextCursor : 0;
            if (page.failed > 0) this.#store.quarantineInvalidPrepared(MAX_PREPARED, previousCursor);
            for (const entry of page.entries) {
                try { this.#deliver(entry.job, entry.packet); }
                catch { this.#warn(); }
            }
            if (this.#options.enabled() && this.#options.candidates && !this.#closed) {
                const claim = this.#store.claimNext(this.#owner, 32_000);
                if (claim) {
                    const controller = new AbortController();
                    const done = this.#compile(claim, controller);
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
                    const status = this.#store.status();
                    if (this.#recovering) this.#wake(1);
                    else if (status.queued > 0 || status.prepared > 0) this.#wake(RETRY_MS);
                } catch { this.#warn(); this.#wake(RETRY_MS); }
            }
        }
    }
}


export function openSkillCompileRuntime(options: SkillCompileRuntimeOptions): SkillCompileRuntime | null {
    let store: SkillCompileStore | null = null;
    try {
        if (!options.enabled() && !existsSync(join(options.dataDir, SKILL_COMPILE_DB_FILE))) return null;
        store = new SkillCompileStore({
            dataDir: options.dataDir, now: options.now,
            isSessionDeleted: options.isSessionDeleted
        });
        const runtime = new SkillCompileRuntime(store, options);
        runtime.schedule();
        return runtime;
    } catch {
        try { store?.close(); } catch { /* Preserve the closed optional service state. */ }
        try { options.onFailure?.('skill-compile-open-failed'); }
        catch { /* Diagnostics must not affect existing dialogue Agents. */ }
        return null;
    }
}
