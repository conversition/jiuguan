/** @author Codex @date 2026-10-17 @version 1.0
 * Process-local wrapper for one durable Candidate evaluation batch.
 * It exposes neither the Store claim nor the Validator ticket/proof and grants no quality,
 * adoption, promotion, publication, Provider, or Gateway authority.
 */
import type { ChatResponse } from '../../../packages/proxy/public/client.ts';
import {
  CandidateEvaluationBatchStore,
} from '../candidate-evaluation-batch-store.ts';
import {
  isCandidateEvaluationValidatorAuthority,
  type CandidateEvaluationFailure,
  type CandidateEvaluationProof,
  type CandidateEvaluationReceipt,
  type CandidateEvaluationValidatorAuthority,
} from './candidate-evaluation-validator.ts';

export const CANDIDATE_EVALUATION_BATCH_RUNTIME_HANDLE_VERSION =
  'candidate-evaluation-batch-runtime-handle-v1' as const;
export const CANDIDATE_EVALUATION_BATCH_RUNTIME_RESULT_VERSION =
  'candidate-evaluation-batch-runtime-result-v1' as const;

export const CANDIDATE_EVALUATION_BATCH_RUNTIME_ERROR_CODES = Object.freeze([
  'candidate-evaluation-batch-runtime-input-invalid',
  'candidate-evaluation-batch-runtime-store-invalid',
  'candidate-evaluation-batch-runtime-authority-invalid',
  'candidate-evaluation-batch-runtime-handle-not-owned',
  'candidate-evaluation-batch-runtime-handle-not-current',
  'candidate-evaluation-batch-runtime-terminal-conflict',
  'candidate-evaluation-batch-runtime-terminal-uncertain',
  'candidate-evaluation-batch-runtime-closed',
] as const);
export type CandidateEvaluationBatchRuntimeErrorCode =
  typeof CANDIDATE_EVALUATION_BATCH_RUNTIME_ERROR_CODES[number];

export class CandidateEvaluationBatchRuntimeError extends Error {
  constructor(readonly code: CandidateEvaluationBatchRuntimeErrorCode) {
    if (!(CANDIDATE_EVALUATION_BATCH_RUNTIME_ERROR_CODES as readonly unknown[]).includes(code)) {
      throw new Error('candidate-evaluation-batch-runtime-error-code-invalid');
    }
    super(code);
    this.name = 'CandidateEvaluationBatchRuntimeError';
  }
}

declare const CANDIDATE_EVALUATION_BATCH_RUNTIME_HANDLE: unique symbol;
export interface CandidateEvaluationBatchRuntimeHandle {
  readonly [CANDIDATE_EVALUATION_BATCH_RUNTIME_HANDLE]: true;
  readonly handleVersion: typeof CANDIDATE_EVALUATION_BATCH_RUNTIME_HANDLE_VERSION;
}

export interface CandidateEvaluationBatchRuntimeResult {
  readonly resultVersion: typeof CANDIDATE_EVALUATION_BATCH_RUNTIME_RESULT_VERSION;
  readonly sampleKey: string;
  readonly arm: CandidateEvaluationReceipt['arm'];
  readonly attemptId: string;
  readonly outcome: CandidateEvaluationReceipt['outcome'];
  readonly reasonCode: CandidateEvaluationReceipt['reasonCode'];
  readonly receiptDigest: string;
  readonly providerExecution: 'unverified';
  readonly causalEffect: 'unsupported';
  readonly winner: 'not-declared';
  readonly promotionEligible: false;
}

type StoreClaimInput = Parameters<CandidateEvaluationBatchStore['claimNext']>[0];
export type CandidateEvaluationBatchRuntimeClaimInput = Omit<StoreClaimInput, 'authority'>;
type StoreClaim = NonNullable<ReturnType<CandidateEvaluationBatchStore['claimNext']>>;

type TerminalMode = 'response' | CandidateEvaluationFailure;
const CANDIDATE_EVALUATION_BATCH_RUNTIMES = new WeakSet<object>();
type HandleEntry = {
  readonly claim: StoreClaim;
  mode: TerminalMode | null;
  proof: CandidateEvaluationProof | null;
  receipt: CandidateEvaluationReceipt | null;
  result: CandidateEvaluationBatchRuntimeResult | null;
  poisoned: boolean;
};

function reject(code: CandidateEvaluationBatchRuntimeErrorCode): never {
  throw new CandidateEvaluationBatchRuntimeError(code);
}

function terminalFailure(input: unknown): CandidateEvaluationFailure {
  if (input !== 'provider-error' && input !== 'timeout' && input !== 'cancelled'
    && input !== 'validator-error') {
    reject('candidate-evaluation-batch-runtime-input-invalid');
  }
  return input;
}

function isRealStore(input: unknown): input is CandidateEvaluationBatchStore {
  if (!(input instanceof CandidateEvaluationBatchStore)) return false;
  try {
    // Invoke the class method directly so an own-property override cannot forge the Store's
    // private-field brand. `status` is read-only and also rejects a closed Store.
    CandidateEvaluationBatchStore.prototype.status.call(input);
    return true;
  } catch { return false; }
}

function resultFor(receipt: CandidateEvaluationReceipt): CandidateEvaluationBatchRuntimeResult {
  return Object.freeze({
    resultVersion: CANDIDATE_EVALUATION_BATCH_RUNTIME_RESULT_VERSION,
    sampleKey: receipt.sampleKey,
    arm: receipt.arm,
    attemptId: receipt.attemptId,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode,
    receiptDigest: receipt.receiptDigest,
    providerExecution: 'unverified' as const,
    causalEffect: 'unsupported' as const,
    winner: 'not-declared' as const,
    promotionEligible: false as const,
  });
}

/**
 * One Runtime owns one exact Store and one exact Pack Validator authority. The Store performs the
 * atomic durable reservation and ticket issue; this wrapper retains the returned claim/ticket in a
 * WeakMap and gives callers only a process identity handle.
 */
export class CandidateEvaluationBatchRuntime {
  readonly #store: CandidateEvaluationBatchStore;
  readonly #authority: CandidateEvaluationValidatorAuthority;
  readonly #now: () => string;
  readonly #handles = new WeakMap<object, HandleEntry>();
  #closed = false;

  constructor(input: Readonly<{
    store: CandidateEvaluationBatchStore;
    authority: CandidateEvaluationValidatorAuthority;
    now?: () => string;
  }>) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !isRealStore(input.store)) {
      reject('candidate-evaluation-batch-runtime-store-invalid');
    }
    if (!isCandidateEvaluationValidatorAuthority(input.authority)) {
      reject('candidate-evaluation-batch-runtime-authority-invalid');
    }
    if (input.now !== undefined && typeof input.now !== 'function') {
      reject('candidate-evaluation-batch-runtime-input-invalid');
    }
    this.#store = input.store;
    this.#authority = input.authority;
    this.#now = input.now ?? (() => new Date().toISOString());
    CANDIDATE_EVALUATION_BATCH_RUNTIMES.add(this);
  }

  claimNext(input: CandidateEvaluationBatchRuntimeClaimInput):
    CandidateEvaluationBatchRuntimeHandle | null {
    this.#open();
    const claim = this.#store.claimNext({
      ...input,
      authority: this.#authority,
    } as StoreClaimInput);
    if (claim === null) return null;
    if (!this.#store.ownsClaim(claim)) {
      reject('candidate-evaluation-batch-runtime-handle-not-current');
    }
    const handle = Object.freeze({
      handleVersion: CANDIDATE_EVALUATION_BATCH_RUNTIME_HANDLE_VERSION,
    }) as CandidateEvaluationBatchRuntimeHandle;
    this.#handles.set(handle, {
      claim,
      mode: null,
      proof: null,
      receipt: null,
      result: null,
      poisoned: false,
    });
    return handle;
  }

  ownsClaim(handle: unknown): boolean {
    if (this.#closed || !handle || typeof handle !== 'object') return false;
    const entry = this.#handles.get(handle);
    if (!entry || entry.poisoned || entry.result !== null) return false;
    try { return this.#store.ownsClaim(entry.claim); }
    catch { return false; }
  }

  succeeded(handle: unknown, response: ChatResponse): CandidateEvaluationBatchRuntimeResult {
    return this.#settle(handle, 'response', response);
  }

  /**
   * Content-free settlement identity for the trusted Sample bridge: the usage-inclusive
   * Candidate response digest (null when the arm did not pass). Never returns response
   * content, prompt binding or request material.
   */
  terminalResponseDigest(handle: unknown): string | null {
    const entry = this.#entry(handle);
    return entry.receipt?.responseDigest ?? null;
  }

  terminalize(
    handle: unknown,
    failure: CandidateEvaluationFailure,
  ): CandidateEvaluationBatchRuntimeResult {
    return this.#settle(handle, terminalFailure(failure));
  }

  recoverUncertain(limit?: number): number {
    this.#open();
    return this.#store.recoverUncertain(limit).length;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  #open(): void {
    if (this.#closed) reject('candidate-evaluation-batch-runtime-closed');
  }

  #entry(handle: unknown): HandleEntry {
    this.#open();
    if (!handle || typeof handle !== 'object') {
      reject('candidate-evaluation-batch-runtime-handle-not-owned');
    }
    const entry = this.#handles.get(handle);
    if (!entry) reject('candidate-evaluation-batch-runtime-handle-not-owned');
    if (entry.poisoned) reject('candidate-evaluation-batch-runtime-terminal-uncertain');
    return entry;
  }

  #settle(
    handle: unknown,
    requestedMode: TerminalMode,
    response?: ChatResponse,
  ): CandidateEvaluationBatchRuntimeResult {
    const entry = this.#entry(handle);
    if (entry.result !== null) {
      if (entry.mode !== requestedMode) {
        reject('candidate-evaluation-batch-runtime-terminal-conflict');
      }
      return entry.result;
    }
    if (entry.mode !== null && entry.mode !== requestedMode) {
      reject('candidate-evaluation-batch-runtime-terminal-conflict');
    }

    if (entry.proof === null) {
      if (!this.#store.ownsClaim(entry.claim)) {
        reject('candidate-evaluation-batch-runtime-handle-not-current');
      }
      entry.mode = requestedMode;
      let proof: CandidateEvaluationProof;
      try {
        const occurredAt = this.#now();
        proof = requestedMode === 'response'
          ? this.#authority.evaluate({
            ticket: entry.claim.ticket,
            response: response as ChatResponse,
            occurredAt,
          })
          : this.#authority.terminalizeFailure({
            ticket: entry.claim.ticket,
            failure: requestedMode,
            occurredAt,
          });
        const receipt = this.#authority.readCurrentForTicket(entry.claim.ticket, proof);
        if (receipt === null) {
          reject('candidate-evaluation-batch-runtime-handle-not-current');
        }
        entry.receipt = receipt;
        entry.proof = proof;
      } catch (error) {
        // Ticket consumption is no longer safely knowable. Keep the durable reservation unresolved
        // so Store recovery seals it uncertain; never invoke the Validator again.
        entry.poisoned = true;
        throw error;
      }
    }

    // Do not re-check ownsClaim here. A previous finish may have committed and then thrown during
    // read-back. The Store is the sole idempotent authority for resolving that state.
    this.#store.finish(entry.claim, entry.proof);
    const receipt = entry.receipt;
    if (receipt === null) reject('candidate-evaluation-batch-runtime-terminal-uncertain');
    const result = resultFor(receipt);
    entry.result = result;
    return result;
  }
}

/** Process-local brand check for narrow host bridges; structural copies and Proxies are rejected. */
export function isCandidateEvaluationBatchRuntime(
  input: unknown,
): input is CandidateEvaluationBatchRuntime {
  return Boolean(input && typeof input === 'object'
    && CANDIDATE_EVALUATION_BATCH_RUNTIMES.has(input));
}
