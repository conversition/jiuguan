import { isSafeOpaqueId } from '../../packages/mobile-contracts/src/index.ts';
import {
  SessionDeletionIdentityConflictError,
  type SessionDeletionIdentity,
  type SessionDeletionJournal,
  type SessionDeletionJournalRow,
  type SessionDeletionPhase,
  type SessionDeletionStepRow,
} from './session-deletion-journal.ts';

const REVISION_RE = /^sha256:[a-f0-9]{64}$/u;

export interface SessionDeletionReservation {
  readonly sessionId: string;
  readonly operationId: string;
  readonly reservationId: string;
}

export interface SessionDeletionCleanupStep {
  /** Stable, non-secret identity persisted in the authoritative journal. */
  readonly id: string;
  /** Stable redacted code persisted when run() fails. Never include the thrown message. */
  readonly failureCode: string;
  /**
   * Must be idempotent. A crash after the side effect but before finishStep() means
   * the same attempt can run again during startup recovery.
   */
  run(identity: SessionDeletionIdentity): void | Promise<void>;
}

export interface SessionDeletionJournalPort {
  prepare(input: SessionDeletionIdentity): ReturnType<SessionDeletionJournal['prepare']>;
  advance(input: Parameters<SessionDeletionJournal['advance']>[0]): ReturnType<SessionDeletionJournal['advance']>;
  ensureStep(input: Parameters<SessionDeletionJournal['ensureStep']>[0]):
    ReturnType<SessionDeletionJournal['ensureStep']>;
  startStep(input: Parameters<SessionDeletionJournal['startStep']>[0]):
    ReturnType<SessionDeletionJournal['startStep']>;
  finishStep(input: Parameters<SessionDeletionJournal['finishStep']>[0]):
    ReturnType<SessionDeletionJournal['finishStep']>;
  get(sessionId: string): SessionDeletionJournalRow | null;
  listPending(): SessionDeletionJournalRow[];
  isBlocked(sessionId: string): boolean;
  isPrivacyCommitted(sessionId: string): boolean;
  listSteps(sessionId: string): SessionDeletionStepRow[];
}

export interface SessionDeletionCoordinatorOptions {
  readonly journal: SessionDeletionJournalPort;
  /**
   * Process-local admission barrier. Acquisition must reject a second writer for
   * the same session, but it must not create durable state.
   */
  readonly reserve: (identity: SessionDeletionIdentity) =>
    SessionDeletionReservation | Promise<SessionDeletionReservation>;
  /** Releases the ephemeral barrier. It must be idempotent. */
  readonly release: (reservation: SessionDeletionReservation) => void | Promise<void>;
  /**
   * Cancels/drains the foreground turn while the ephemeral barrier rejects new
   * admission. The permanent journal fence is deliberately not written yet.
   */
  readonly quiesce: (input: {
    readonly identity: SessionDeletionIdentity;
    readonly reservation: SessionDeletionReservation;
  }) => void | Promise<void>;
  /** Reads the authoritative session snapshot revision after quiescence. */
  readonly readRevision: (sessionId: string) => string | Promise<string>;
  readonly cleanupSteps: readonly SessionDeletionCleanupStep[];
}

export type SessionDeletionCoordinatorResult =
  | Readonly<{
      status: 'conflict';
      reason: 'revision-conflict' | 'identity-conflict';
      sessionId: string;
      operationId: string;
      expectedRevision: string;
      actualRevision: string;
      pending: false;
      replayed: boolean;
    }>
  | Readonly<{
      status: 'accepted';
      sessionId: string;
      operationId: string;
      sourceRevision: string;
      phase: Exclude<SessionDeletionPhase, 'complete'>;
      pending: true;
      replayed: boolean;
      errorCode: string;
      failedStepId?: string;
    }>
  | Readonly<{
      status: 'completed';
      sessionId: string;
      operationId: string;
      sourceRevision: string;
      phase: 'complete';
      pending: false;
      replayed: boolean;
    }>;

function normalizeIdentity(input: SessionDeletionIdentity): SessionDeletionIdentity {
  if (!isSafeOpaqueId(input.sessionId, 160)) throw new Error('session-deletion-session-id-invalid');
  if (!isSafeOpaqueId(input.operationId, 200)) throw new Error('session-deletion-operation-id-invalid');
  if (typeof input.sourceRevision !== 'string' || !REVISION_RE.test(input.sourceRevision)) {
    throw new Error('session-deletion-source-revision-invalid');
  }
  return Object.freeze({
    sessionId: input.sessionId,
    operationId: input.operationId,
    sourceRevision: input.sourceRevision,
  });
}

function validateSteps(steps: readonly SessionDeletionCleanupStep[]): readonly SessionDeletionCleanupStep[] {
  if (!Array.isArray(steps) || steps.length < 1) throw new Error('session-deletion-cleanup-steps-empty');
  const ids = new Set<string>();
  return Object.freeze(steps.map((step) => {
    if (!step || !isSafeOpaqueId(step.id, 120) || ids.has(step.id)
      || !isSafeOpaqueId(step.failureCode, 160) || typeof step.run !== 'function') {
      throw new Error('session-deletion-cleanup-step-invalid');
    }
    ids.add(step.id);
    return Object.freeze({ id: step.id, failureCode: step.failureCode, run: step.run });
  }));
}

function validateRevision(value: unknown): string {
  if (value === 'absent') return value;
  if (typeof value !== 'string' || !REVISION_RE.test(value)) {
    throw new Error('session-deletion-actual-revision-invalid');
  }
  return value;
}

function conflict(
  identity: SessionDeletionIdentity,
  reason: 'revision-conflict' | 'identity-conflict',
  actualRevision: string,
  replayed: boolean,
): SessionDeletionCoordinatorResult {
  return Object.freeze({
    status: 'conflict',
    reason,
    sessionId: identity.sessionId,
    operationId: identity.operationId,
    expectedRevision: identity.sourceRevision,
    actualRevision,
    pending: false,
    replayed,
  });
}

/**
 * Durable privacy-first deletion state machine.
 *
 * The caller's admission function must check journal.isBlocked(sessionId). Before
 * prepare(), the injected reservation is the only barrier and can be released on
 * a revision conflict without leaving a permanent tombstone. After prepare(), the
 * journal fence is authoritative forever and every failure becomes accepted/pending.
 */
export class SessionDeletionCoordinator {
  readonly #journal: SessionDeletionJournalPort;
  readonly #reserve: SessionDeletionCoordinatorOptions['reserve'];
  readonly #release: SessionDeletionCoordinatorOptions['release'];
  readonly #quiesce: SessionDeletionCoordinatorOptions['quiesce'];
  readonly #readRevision: SessionDeletionCoordinatorOptions['readRevision'];
  readonly #steps: readonly SessionDeletionCleanupStep[];

  constructor(options: SessionDeletionCoordinatorOptions) {
    if (!options || typeof options.reserve !== 'function' || typeof options.release !== 'function'
      || typeof options.quiesce !== 'function' || typeof options.readRevision !== 'function') {
      throw new Error('session-deletion-coordinator-options-invalid');
    }
    this.#journal = options.journal;
    this.#reserve = options.reserve;
    this.#release = options.release;
    this.#quiesce = options.quiesce;
    this.#readRevision = options.readRevision;
    this.#steps = validateSteps(options.cleanupSteps);
  }

  async deleteSession(input: SessionDeletionIdentity): Promise<SessionDeletionCoordinatorResult> {
    const identity = normalizeIdentity(input);
    const existing = this.#journal.get(identity.sessionId);
    if (existing) {
      if (!this.#sameIdentity(existing, identity)) {
        return conflict(identity, 'identity-conflict', existing.sourceRevision, true);
      }
      return this.#resume(identity, true);
    }

    let reservation: SessionDeletionReservation | undefined;
    let durableFence = false;
    let prepared: ReturnType<SessionDeletionJournalPort['prepare']> | undefined;
    try {
      reservation = await this.#reserve(identity);
      this.#assertReservation(reservation, identity);
      await this.#quiesce({ identity, reservation });
      const actualRevision = validateRevision(await this.#readRevision(identity.sessionId));
      if (actualRevision !== identity.sourceRevision) {
        return conflict(identity, 'revision-conflict', actualRevision, false);
      }
      try {
        prepared = this.#journal.prepare(identity);
        durableFence = true;
      } catch (error) {
        if (error instanceof SessionDeletionIdentityConflictError) {
          const raced = this.#journal.get(identity.sessionId);
          return conflict(identity, 'identity-conflict', raced?.sourceRevision ?? 'absent', true);
        }
        throw error;
      }
    } finally {
      if (reservation) {
        try {
          await this.#release(reservation);
        } catch (error) {
          // Before prepare there is no durable substitute for the ephemeral barrier.
          // After prepare, the permanent fence safely supersedes it; a process-local
          // release failure must not turn an accepted privacy deletion into HTTP 500.
          if (!durableFence) throw error;
        }
      }
    }
    if (!prepared) throw new Error('session-deletion-prepare-missing');
    return this.#resume(identity, prepared.replayed);
  }

  async resumePending(): Promise<SessionDeletionCoordinatorResult[]> {
    const results: SessionDeletionCoordinatorResult[] = [];
    for (const row of this.#journal.listPending()) {
      const identity: SessionDeletionIdentity = {
        sessionId: row.sessionId,
        operationId: row.operationId,
        sourceRevision: row.sourceRevision,
      };
      results.push(await this.#resume(identity, true));
    }
    return results;
  }

  async #resume(
    identity: SessionDeletionIdentity,
    replayed: boolean,
  ): Promise<SessionDeletionCoordinatorResult> {
    const initial = this.#journal.get(identity.sessionId);
    if (!initial || !this.#sameIdentity(initial, identity)) {
      return conflict(identity, 'identity-conflict', initial?.sourceRevision ?? 'absent', replayed);
    }
    if (initial.phase === 'complete') return this.#completed(identity, replayed);

    try {
      if (initial.phase === 'prepared') {
        this.#journal.advance({ ...identity, phase: 'privacy-committed' });
      }
      for (const step of this.#steps) {
        const ensured = this.#journal.ensureStep({ ...identity, stepId: step.id }).row;
        if (ensured.status === 'succeeded') continue;
        const started = this.#journal.startStep({ ...identity, stepId: step.id }).row;
        if (started.status === 'succeeded') continue;
        try {
          await step.run(identity);
        } catch {
          try {
            this.#journal.finishStep({
              ...identity,
              stepId: step.id,
              status: 'failed',
              errorCode: step.failureCode,
            });
          } catch {
            // The durable running attempt remains recoverable and will be rerun.
          }
          return this.#accepted(identity, replayed, step.failureCode, step.id);
        }
        this.#journal.finishStep({ ...identity, stepId: step.id, status: 'succeeded' });
      }
      const afterSteps = this.#journal.get(identity.sessionId);
      if (!afterSteps) return conflict(identity, 'identity-conflict', 'absent', replayed);
      if (afterSteps.phase === 'privacy-committed') {
        this.#journal.advance({ ...identity, phase: 'cleanup-pending' });
      }
      this.#journal.advance({ ...identity, phase: 'complete' });
      return this.#completed(identity, replayed);
    } catch {
      return this.#accepted(identity, replayed, 'session-deletion-cleanup-pending');
    }
  }

  #accepted(
    identity: SessionDeletionIdentity,
    replayed: boolean,
    errorCode: string,
    failedStepId?: string,
  ): SessionDeletionCoordinatorResult {
    let row = this.#journal.get(identity.sessionId);
    if (!row) return conflict(identity, 'identity-conflict', 'absent', replayed);
    if (row.phase === 'privacy-committed') {
      try {
        row = this.#journal.advance({ ...identity, phase: 'cleanup-pending' }).row;
      } catch {
        row = this.#journal.get(identity.sessionId) ?? row;
      }
    }
    if (row.phase === 'complete') return this.#completed(identity, replayed);
    return Object.freeze({
      status: 'accepted',
      sessionId: identity.sessionId,
      operationId: identity.operationId,
      sourceRevision: identity.sourceRevision,
      phase: row.phase,
      pending: true,
      replayed,
      errorCode,
      ...(failedStepId ? { failedStepId } : {}),
    });
  }

  #completed(identity: SessionDeletionIdentity, replayed: boolean): SessionDeletionCoordinatorResult {
    return Object.freeze({
      status: 'completed',
      sessionId: identity.sessionId,
      operationId: identity.operationId,
      sourceRevision: identity.sourceRevision,
      phase: 'complete',
      pending: false,
      replayed,
    });
  }

  #sameIdentity(row: SessionDeletionJournalRow, identity: SessionDeletionIdentity): boolean {
    return row.sessionId === identity.sessionId && row.operationId === identity.operationId
      && row.sourceRevision === identity.sourceRevision;
  }

  #assertReservation(
    reservation: SessionDeletionReservation,
    identity: SessionDeletionIdentity,
  ): void {
    if (!reservation || reservation.sessionId !== identity.sessionId
      || reservation.operationId !== identity.operationId
      || !isSafeOpaqueId(reservation.reservationId, 160)) {
      throw new Error('session-deletion-reservation-invalid');
    }
  }
}
