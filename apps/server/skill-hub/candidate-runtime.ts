/** @author Codex @date 2026-10-16 @version 1.0
 * Optional durable draft validation, never a live catalog or an automatic publication authority.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentSkillCandidateStore, AGENT_SKILL_CANDIDATE_DB_FILE }
    from '../agent-skill-candidate-store.ts';
import { evaluateCandidateStaticValidation } from '../agent-skill-candidate-static-validator.ts';

const MAX_BATCH = 8;
const LEASE_MS = 30_000;
const MAX_RETRY_MS = 30_000;

export interface CandidateRuntimeOptions {
    readonly dataDir: string;
    submissionEnabled(): boolean;
    readonly now?: () => string;
    onFailure?(code: 'candidate-open-failed' | 'candidate-validation-pending'): void;
}


export function candidateSubmissionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.JG_AGENT_SKILL_CANDIDATES === '1';
}


/** The host can submit drafts and inspect status; no method can promote or replace an active Skill. */
export class AgentSkillCandidateRuntime {
    readonly #store: AgentSkillCandidateStore;
    readonly #options: CandidateRuntimeOptions;
    readonly #owner = `candidate-worker:${randomUUID()}`;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #closed = false;
    #failures = 0;

    constructor(store: AgentSkillCandidateStore, options: CandidateRuntimeOptions) {
        try {
            AgentSkillCandidateStore.prototype.jobStatus.call(store);
        } catch {
            throw new Error('candidate-runtime-store-authority-invalid');
        }
        this.#store = store;
        this.#options = options;
    }

    submitCandidate(input: Parameters<AgentSkillCandidateStore['submit']>[0], idempotencyKey: string) {
        this.#open();
        if (this.#options.submissionEnabled() !== true) throw new Error('candidate-submission-disabled');
        const result = this.#store.submit(input, idempotencyKey);
        this.schedule();
        return result;
    }

    readCandidate(candidateId: string) {
        this.#open();
        return AgentSkillCandidateStore.prototype.readCandidate.call(this.#store, candidateId);
    }

    getJob(jobId: string) {
        this.#open();
        return this.#store.getJob(jobId);
    }

    list(input: Parameters<AgentSkillCandidateStore['list']>[0] = {}) {
        this.#open();
        return this.#store.list(input);
    }

    schedule(): void {
        if (this.#closed) return;
        // Fresh submissions must not wait for another worker's old lease expiry or a retry timer.
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#wake(0);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#store.close();
    }

    #open(): void {
        if (this.#closed) throw new Error('candidate-runtime-closed');
    }

    #now(): string {
        return this.#options.now?.() ?? new Date().toISOString();
    }

    #warn(): void {
        try { this.#options.onFailure?.('candidate-validation-pending'); }
        catch { /* Optional diagnostic failures cannot become draft or live execution authority. */ }
    }

    #wake(delayMs: number): void {
        if (this.#closed) return;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#runBatch();
        }, delayMs);
        this.#timer.unref?.();
    }

    #runBatch(): void {
        if (this.#closed) return;
        try {
            this.#store.recoverExpired();
            for (let index = 0; index < MAX_BATCH && !this.#closed; index += 1) {
                const claim = this.#store.claimNext(this.#owner, LEASE_MS);
                if (!claim) break;
                const stored = this.#store.readCandidate(claim.candidateId);
                if (!stored) throw new Error('candidate-validation-source-missing');
                const proof = evaluateCandidateStaticValidation({
                    candidate: stored.candidate, bundle: stored.bundle, claim, validatedAt: this.#now(),
                });
                this.#store.finishValidation(claim, proof);
            }
            if (this.#closed) return;
            this.#failures = 0;
            const status = this.#store.jobStatus();
            if (status.queued > 0) this.#wake(0);
            else if (status.running > 0 && status.nextLeaseUntil) {
                const delay = Date.parse(status.nextLeaseUntil) - Date.parse(this.#now());
                if (!Number.isFinite(delay)) throw new Error('candidate-job-lease-invalid');
                this.#wake(Math.max(1, Math.min(delay, LEASE_MS)));
            }
        } catch {
            this.#warn();
            this.#failures = Math.min(this.#failures + 1, 10);
            this.#wake(Math.min(100 * 2 ** this.#failures, MAX_RETRY_MS));
        }
    }
}


/** A closed recording switch does not discard already queued, deterministic validation work. */
export function openAgentSkillCandidateRuntime(options: CandidateRuntimeOptions): AgentSkillCandidateRuntime | null {
    let store: AgentSkillCandidateStore | null = null;
    try {
        if (options.submissionEnabled() !== true
            && !existsSync(join(options.dataDir, AGENT_SKILL_CANDIDATE_DB_FILE))) return null;
        store = new AgentSkillCandidateStore({ dataDir: options.dataDir, now: options.now });
        const runtime = new AgentSkillCandidateRuntime(store, options);
        runtime.schedule();
        return runtime;
    } catch {
        try { store?.close(); } catch { /* The startup error remains optional to the original Agent runtime. */ }
        try { options.onFailure?.('candidate-open-failed'); }
        catch { /* Optional diagnostics cannot turn a disabled draft service into a startup failure. */ }
        return null;
    }
}
