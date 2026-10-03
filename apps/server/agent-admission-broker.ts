import { randomBytes } from 'node:crypto';
import {
  ADMISSION_TICKET_VERSION,
  admissionRequestDigest,
  normalizeAdmissionRequest,
  type AdmissionLease,
  type AdmissionLimits,
  type AdmissionRequest,
  type AdmissionTicket,
  type AgentContentMode,
  type AgentLane,
  type AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';

export type AdmissionTicketErrorCode =
  | 'ticket-id-invalid'
  | 'ticket-id-collision'
  | 'ticket-request-expired'
  | 'ticket-lane-disabled'
  | 'ticket-idempotency-conflict'
  | 'ticket-unknown'
  | 'ticket-replayed'
  | 'ticket-expired'
  | 'ticket-binding-mismatch'
  | 'ticket-toolset-mismatch'
  | 'ticket-budget-escalation';

export class AdmissionTicketError extends Error {
  constructor(readonly code: AdmissionTicketErrorCode) {
    super(code);
    this.name = 'AdmissionTicketError';
  }
}

export interface BeginAdmissionRequest {
  readonly ticketId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly modelId: string;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly mode: AgentContentMode;
  /** Omitted means the full signed maximum; a subset only reduces authority. */
  readonly allowedTools?: readonly string[];
  /** Every provided field may only lower the signed limit. */
  readonly limits?: Partial<AdmissionLimits>;
}

interface StoredTicket {
  readonly ticket: AdmissionTicket;
  consumed: boolean;
}

export interface AdmissionTicketBrokerOptions {
  readonly nowMs?: () => number;
  readonly createTicketId?: () => string;
  /** Re-evaluated for every issue attempt, including idempotent replays. */
  readonly authorizeIssue?: (request: AdmissionRequest) => boolean | Readonly<{
    readonly allowed: boolean;
    /** May only narrow the signed request after durable reservation. */
    readonly maxModelCalls?: number;
    readonly quotaReservationDigest?: string;
    /** Only a reservation created by this issue attempt may be released if issue fails. */
    readonly reservationCreated?: boolean;
  }>;
  /** Re-reads runtime/capability authority after bindings validate and immediately before start. */
  readonly authorizeBegin?: (ticket: AdmissionTicket) => boolean;
  /** Marks the reservation irreversible only after every ticket binding has validated. */
  readonly markReservationStarted?: (reservationDigest: string) => void;
  /** Releases authority for an unconsumed, expired, or binding-rejected ticket. */
  readonly releaseReservation?: (reservationDigest: string) => void;
}

const TICKET_ID_RE = /^jgat1_[A-Za-z0-9_-]{32,128}$/u;
const TOOL_RE = /^[a-z][a-z0-9._:-]{0,127}$/u;
const LIMIT_KEYS = new Set<keyof AdmissionLimits>([
  'maxModelCalls', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCostMicrousd', 'maxWallMs',
]);

function freezeTicket(
  ticketId: string,
  request: AdmissionRequest,
  requestDigest: string,
  issuedAtMs: number,
  quotaReservationDigest?: string,
): AdmissionTicket {
  return Object.freeze({
    version: ADMISSION_TICKET_VERSION,
    ticketId,
    requestDigest,
    ...(quotaReservationDigest ? { quotaReservationDigest } : {}),
    ...request,
    issuedAtMs,
    expiresAtMs: request.deadlineMs,
  });
}

function requestedTools(value: readonly string[] | undefined, signed: readonly string[]): readonly string[] {
  if (value === undefined) return signed;
  if (!Array.isArray(value) || value.length > 64) throw new AdmissionTicketError('ticket-toolset-mismatch');
  const normalized = value.map((tool) => {
    if (typeof tool !== 'string' || !TOOL_RE.test(tool)) throw new AdmissionTicketError('ticket-toolset-mismatch');
    return tool;
  });
  if (new Set(normalized).size !== normalized.length) throw new AdmissionTicketError('ticket-toolset-mismatch');
  const allowed = new Set(signed);
  if (normalized.some((tool) => !allowed.has(tool))) throw new AdmissionTicketError('ticket-toolset-mismatch');
  return Object.freeze([...normalized].sort());
}

function requestedLimits(value: Partial<AdmissionLimits> | undefined, signed: AdmissionLimits): AdmissionLimits {
  if (value === undefined) return signed;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdmissionTicketError('ticket-budget-escalation');
  }
  for (const key of Object.keys(value)) {
    if (!LIMIT_KEYS.has(key as keyof AdmissionLimits)) throw new AdmissionTicketError('ticket-budget-escalation');
  }
  const merged = { ...signed };
  for (const key of LIMIT_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    const minimum = key === 'maxToolCalls' || key === 'maxCostMicrousd' ? 0 : 1;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > signed[key]) {
      throw new AdmissionTicketError('ticket-budget-escalation');
    }
    merged[key] = candidate;
  }
  return Object.freeze(merged);
}

/**
 * Process-local, non-persistent, one-shot authority broker. It deliberately has no Provider,
 * HTTP, plugin, or storage dependency. A successful lookup burns the ticket before any binding
 * validation, so rejected or failed executions can never restore authority.
 */
export class AdmissionTicketBroker {
  readonly #nowMs: () => number;
  readonly #createTicketId: () => string;
  readonly #authorizeIssue: AdmissionTicketBrokerOptions['authorizeIssue'];
  readonly #authorizeBegin: AdmissionTicketBrokerOptions['authorizeBegin'];
  readonly #markReservationStarted: AdmissionTicketBrokerOptions['markReservationStarted'];
  readonly #releaseReservation: AdmissionTicketBrokerOptions['releaseReservation'];
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #idempotency = new Map<string, { requestDigest: string; ticketId: string }>();

  constructor(options: AdmissionTicketBrokerOptions = {}) {
    this.#nowMs = options.nowMs ?? Date.now;
    this.#createTicketId = options.createTicketId ?? (() => `jgat1_${randomBytes(32).toString('base64url')}`);
    this.#authorizeIssue = options.authorizeIssue;
    this.#authorizeBegin = options.authorizeBegin;
    this.#markReservationStarted = options.markReservationStarted;
    this.#releaseReservation = options.releaseReservation;
  }

  #release(ticket: AdmissionTicket): void {
    if (!ticket.quotaReservationDigest) return;
    try { this.#releaseReservation?.(ticket.quotaReservationDigest); } catch {
      // Fail closed: a release failure leaves the durable reservation consumed, never expanded.
    }
  }

  issue(input: AdmissionRequest): AdmissionTicket {
    let request = normalizeAdmissionRequest(input);
    const now = this.#nowMs();
    for (const stored of this.#tickets.values()) {
      if (!stored.consumed && stored.ticket.expiresAtMs <= now) {
        stored.consumed = true;
        this.#release(stored.ticket);
      }
    }
    if (request.deadlineMs <= now) throw new AdmissionTicketError('ticket-request-expired');
    const authorization = this.#authorizeIssue?.(request);
    if (authorization === false
      || (typeof authorization === 'object' && authorization.allowed !== true)) {
      throw new AdmissionTicketError('ticket-lane-disabled');
    }
    let quotaReservationDigest: string | undefined;
    let reservationCreated = false;
    if (typeof authorization === 'object') {
      quotaReservationDigest = authorization.quotaReservationDigest;
      reservationCreated = authorization.reservationCreated === true;
      if (quotaReservationDigest !== undefined
        && !/^sha256:[a-f0-9]{64}$/u.test(quotaReservationDigest)) {
        throw new AdmissionTicketError('ticket-budget-escalation');
      }
      if (authorization.maxModelCalls !== undefined) {
        if (!Number.isSafeInteger(authorization.maxModelCalls)
          || authorization.maxModelCalls < 1
          || authorization.maxModelCalls > request.limits.maxModelCalls) {
          throw new AdmissionTicketError('ticket-budget-escalation');
        }
        request = normalizeAdmissionRequest({
          ...request,
          limits: { ...request.limits, maxModelCalls: authorization.maxModelCalls },
        });
      }
    }
    try {
      const requestDigest = admissionRequestDigest(request);
      const prior = this.#idempotency.get(request.idempotencyKey);
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new AdmissionTicketError('ticket-idempotency-conflict');
        return this.#tickets.get(prior.ticketId)!.ticket;
      }
      let ticketId = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = this.#createTicketId();
        if (!TICKET_ID_RE.test(candidate)) throw new AdmissionTicketError('ticket-id-invalid');
        if (!this.#tickets.has(candidate)) { ticketId = candidate; break; }
      }
      if (!ticketId) throw new AdmissionTicketError('ticket-id-collision');
      const ticket = freezeTicket(ticketId, request, requestDigest, now, quotaReservationDigest);
      this.#tickets.set(ticketId, { ticket, consumed: false });
      this.#idempotency.set(request.idempotencyKey, { requestDigest, ticketId });
      return ticket;
    } catch (error) {
      if (quotaReservationDigest && reservationCreated) {
        try { this.#releaseReservation?.(quotaReservationDigest); } catch { /* fail closed */ }
      }
      throw error;
    }
  }

  begin(input: BeginAdmissionRequest): AdmissionLease {
    if (typeof input?.ticketId !== 'string' || !TICKET_ID_RE.test(input.ticketId)) {
      throw new AdmissionTicketError('ticket-id-invalid');
    }
    const stored = this.#tickets.get(input.ticketId);
    if (!stored) throw new AdmissionTicketError('ticket-unknown');
    if (stored.consumed) throw new AdmissionTicketError('ticket-replayed');
    // Atomic in one JS turn: no await occurs between lookup and the irreversible state change.
    stored.consumed = true;
    const now = this.#nowMs();
    const ticket = stored.ticket;
    try {
      if (now >= ticket.expiresAtMs) throw new AdmissionTicketError('ticket-expired');
      if (input.runId !== ticket.runId
      || input.parentRunId !== ticket.parentRunId
      || input.sessionId !== ticket.sessionId
      || input.sourceRevision !== ticket.sourceRevision
      || input.lane !== ticket.lane
      || input.taskKind !== ticket.taskKind
      || input.policyVersion !== ticket.policyVersion
      || input.modelId !== ticket.modelId
      || input.mode !== ticket.mode) {
        throw new AdmissionTicketError('ticket-binding-mismatch');
      }
      if (input.toolSetDigest !== ticket.toolSetDigest) {
        throw new AdmissionTicketError('ticket-toolset-mismatch');
      }
      if (input.budgetProfileDigest !== ticket.budgetProfileDigest) {
        throw new AdmissionTicketError('ticket-budget-escalation');
      }
      const allowedTools = requestedTools(input.allowedTools, ticket.allowedTools);
      const requested = requestedLimits(input.limits, ticket.limits);
      const limits = Object.freeze({
        ...requested,
        maxWallMs: Math.min(requested.maxWallMs, ticket.expiresAtMs - now),
      });
      if (this.#authorizeBegin?.(ticket) === false) {
        throw new AdmissionTicketError('ticket-lane-disabled');
      }
      if (ticket.quotaReservationDigest) {
        this.#markReservationStarted?.(ticket.quotaReservationDigest);
      }
      return Object.freeze({
      version: ADMISSION_TICKET_VERSION,
      ticketId: ticket.ticketId,
      requestDigest: ticket.requestDigest,
      ...(ticket.quotaReservationDigest
        ? { quotaReservationDigest: ticket.quotaReservationDigest }
        : {}),
      runId: ticket.runId,
      parentRunId: ticket.parentRunId,
      sessionId: ticket.sessionId,
      sourceRevision: ticket.sourceRevision,
      lane: ticket.lane,
      taskKind: ticket.taskKind,
      policyVersion: ticket.policyVersion,
      modelId: ticket.modelId,
      budgetProfileDigest: ticket.budgetProfileDigest,
      toolSetDigest: ticket.toolSetDigest,
      mode: ticket.mode,
      reasonCodes: ticket.reasonCodes,
      evidenceDigests: ticket.evidenceDigests,
      limits,
      allowedTools,
      fullSkillSnapshots: ticket.fullSkillSnapshots,
      consumedAtMs: now,
      expiresAtMs: ticket.expiresAtMs,
      });
    } catch (error) {
      this.#release(ticket);
      throw error;
    }
  }

  get size(): number { return this.#tickets.size; }
}
