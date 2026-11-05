/** P17-01.3c: resource-scoped priority, cancellation, and settle-only physical permits. */
import { randomUUID } from 'node:crypto';
import {
  providerArbitrationKey, providerArbitrationResourceKey,
  type ModelEntryKind, type ProviderArbitrationClass,
} from './provider-arbitration.ts';

export const PROVIDER_ARBITER_VERSION = 'provider-arbiter-v3' as const;
export const ARBITER_REASON_CODES = Object.freeze([
  'arbiter-queue-full', 'arbiter-deadline-exceeded', 'arbiter-closed',
  'arbiter-aborted-by-foreground', 'arbiter-discarded', 'arbiter-cancelled',
] as const);
export type ArbiterReasonCode = typeof ARBITER_REASON_CODES[number];
export type ArbiterTicketState = 'queued' | 'running' | 'done' | 'aborted' | 'rejected';
type ClassCounts = { foreground: number; background: number };

export interface ArbiterTicket {
  readonly ticketId: string;
  readonly class: ProviderArbitrationClass;
  readonly entryKind: ModelEntryKind;
  /** Full invocation identity for audit; not the scheduling pool. */
  readonly keyDigest: string;
  readonly resourceKeyDigest: string;
  readonly deadlineAt: string | null;
  readonly signal: AbortSignal;
  readonly state: ArbiterTicketState;
  readonly reasonCode: ArbiterReasonCode | null;
}
interface MutableTicket {
  ticketId: string;
  entryKind: ModelEntryKind;
  class: ProviderArbitrationClass;
  keyDigest: string;
  resourceKeyDigest: string;
  deadlineAt: string | null;
  controller: AbortController;
  started: { promise: Promise<void>; resolve: () => void };
  sourceSignal?: AbortSignal;
  sourceListener?: () => void;
  executionStarted: boolean;
  state: ArbiterTicketState;
  reasonCode: ArbiterReasonCode | null;
}
export interface ProviderArbiterOptions {
  readonly now?: () => string;
  /** Process-wide waiting limits; executing requests do not consume waiting slots. */
  readonly queueLimit?: Readonly<ClassCounts>;
  /** Per-resource limits, accounting for logical permits and unsettled physical calls together. */
  readonly maxConcurrent?: Readonly<ClassCounts>;
  /** Separate foreground/background process limits; abort alone never frees a physical permit. */
  readonly totalMaxConcurrent?: Readonly<ClassCounts>;
  /** Host-owned, stable policy for explicitly shared upstream quotas; never provided by a request. */
  readonly resourceGroupFor?: (site: Readonly<{ providerId: string; modelId: string }>) => string | undefined;
  readonly ticketId?: () => string;
  /** Retained settled terminal records; active and physically unsettled records are never evicted. */
  readonly terminalRetentionLimit?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}
export interface ArbiterPoolSnapshot {
  readonly resourceKeyDigest: string;
  readonly running: Readonly<ClassCounts>;
  readonly queued: Readonly<ClassCounts>;
  readonly inFlight: Readonly<ClassCounts>;
}
export interface ArbiterSnapshot {
  readonly version: typeof PROVIDER_ARBITER_VERSION;
  readonly closed: boolean;
  readonly running: Readonly<ClassCounts>;
  readonly queued: Readonly<ClassCounts>;
  readonly inFlight: Readonly<ClassCounts>;
  readonly retainedTickets: number;
  /** Includes terminal calls still physically in flight, which cannot yet be evicted. */
  readonly terminalTickets: number;
  readonly pools: readonly ArbiterPoolSnapshot[];
  readonly backgroundDeferrals: number;
  readonly totals: Readonly<{ acquired: number; rejected: number; aborted: number; discarded: number }>;
}
export interface ArbiterOutcome {
  readonly granted: boolean;
  readonly ticket: ArbiterTicket | null;
  readonly reasonCode: ArbiterReasonCode | null;
}
const DEFAULT_LIMIT = Object.freeze({ foreground: 16, background: 64 });
const DEFAULT_CONCURRENCY = Object.freeze({ foreground: 4, background: 2 });
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function counts(value: Readonly<ClassCounts>, minimum: number, name: string): ClassCounts {
  for (const entry of [value.foreground, value.background]) {
    if (!Number.isSafeInteger(entry) || entry < minimum) throw new TypeError('arbiter ' + name + ' invalid');
  }
  return { foreground: value.foreground, background: value.background };
}
function time(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError('arbiter timestamp invalid');
  return millis;
}

export class ProviderArbiter {
  readonly #now: () => string;
  readonly #limit: ClassCounts;
  readonly #concurrency: ClassCounts;
  readonly #totalConcurrency: ClassCounts;
  readonly #terminalLimit: number;
  readonly #resourceGroupFor: NonNullable<ProviderArbiterOptions['resourceGroupFor']>;
  readonly #nextId: () => string;
  readonly #setTimer: NonNullable<ProviderArbiterOptions['setTimer']>;
  readonly #clearTimer: NonNullable<ProviderArbiterOptions['clearTimer']>;
  readonly #tickets = new Map<string, MutableTicket>();
  readonly #views = new WeakMap<MutableTicket, ArbiterTicket>();
  readonly #owners = new WeakMap<ArbiterTicket, MutableTicket>();
  readonly #queued: Record<ProviderArbitrationClass, MutableTicket[]> = { foreground: [], background: [] };
  readonly #running = new Set<MutableTicket>();
  readonly #executing = new Set<MutableTicket>();
  readonly #terminal = new Set<MutableTicket>();
  readonly #pendingAborts: MutableTicket[] = [];
  #timer: unknown;
  #timerDeadline: number | null = null;
  #timerGeneration = 0;
  #notifying = false;
  #closed = false;
  #backgroundDeferrals = 0;
  #totals = { acquired: 0, rejected: 0, aborted: 0, discarded: 0 };

  constructor(options: ProviderArbiterOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nextId = options.ticketId ?? (() => 'ticket.' + randomUUID());
    this.#resourceGroupFor = options.resourceGroupFor ?? (() => undefined);
    this.#limit = counts(options.queueLimit ?? DEFAULT_LIMIT, 0, 'queueLimit');
    this.#concurrency = counts(options.maxConcurrent ?? DEFAULT_CONCURRENCY, 1, 'maxConcurrent');
    this.#totalConcurrency = counts(options.totalMaxConcurrent ?? DEFAULT_CONCURRENCY, 1, 'totalMaxConcurrent');
    this.#terminalLimit = options.terminalRetentionLimit ?? 256;
    if (!Number.isSafeInteger(this.#terminalLimit) || this.#terminalLimit < 0) {
      throw new TypeError('arbiter terminalRetentionLimit invalid');
    }
    if ((options.setTimer === undefined) !== (options.clearTimer === undefined)) {
      throw new TypeError('arbiter setTimer and clearTimer must be supplied together');
    }
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return handle;
    });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }
  get closed(): boolean { return this.#closed; }

  acquire(input: Readonly<{
    providerId: string; modelId: string; profileRef: string; entryKind: ModelEntryKind;
    deadlineAt?: string; signal?: AbortSignal;
  }>): ArbiterOutcome {
    if (this.#closed) return this.#reject('arbiter-closed');
    if (input.signal?.aborted) return this.#reject('arbiter-cancelled');
    const key = providerArbitrationKey(input);
    const group = this.#resourceGroupFor(Object.freeze({ providerId: key.providerId, modelId: key.modelId }));
    const resource = providerArbitrationResourceKey({
      providerId: key.providerId, modelId: key.modelId,
      ...(group === undefined ? {} : { resourceGroupRef: group }),
    });
    const deadlineAt = input.deadlineAt ?? null;
    if (deadlineAt !== null && time(deadlineAt) <= time(this.#now())) {
      return this.#reject('arbiter-deadline-exceeded');
    }
    // Drain eligible waiters first. Zero waiting capacity still allows idle direct execution.
    this.#pump();
    if (this.#queued[key.class].length >= this.#limit[key.class]
      && !this.#canStart(key.class, resource.resourceKeyDigest)) {
      this.#flushAborts();
      return this.#reject('arbiter-queue-full');
    }
    const id = this.#nextId();
    if (this.#tickets.has(id)) throw new TypeError('arbiter duplicate ticket id');
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const ticket: MutableTicket = {
      ticketId: id, entryKind: key.entryKind, class: key.class, keyDigest: key.keyDigest,
      resourceKeyDigest: resource.resourceKeyDigest, deadlineAt, controller: new AbortController(),
      started: { promise: started, resolve: resolveStarted }, executionStarted: false,
      state: 'queued', reasonCode: null,
    };
    this.#tickets.set(id, ticket);
    this.#queued[key.class].push(ticket);
    this.#totals.acquired += 1;
    if (input.signal) {
      ticket.sourceSignal = input.signal;
      ticket.sourceListener = () => {
        if (ticket.state !== 'queued' && ticket.state !== 'running') return;
        this.#abort(ticket, 'arbiter-cancelled');
        this.#pump();
        this.#flushAborts();
      };
      input.signal.addEventListener('abort', ticket.sourceListener, { once: true });
      // Also close the add-listener race for signals that were cancelled during acquisition.
      if (input.signal.aborted) ticket.sourceListener();
    }
    if (ticket.state === 'queued' && key.class === 'foreground') {
      for (const running of [...this.#running]) {
        // A dispatched director request must settle; only future work is deferred.
        // Its physical permit remains occupied until the transport actually settles.
        if (running.class === 'background' && running.resourceKeyDigest === ticket.resourceKeyDigest
            && !(running.entryKind === 'director-creative' && running.executionStarted)) {
          this.#abort(running, 'arbiter-aborted-by-foreground');
        }
      }
    }
    // Reserve foreground slots before abort listeners can synchronously reenter acquire().
    this.#pump();
    this.#flushAborts();
    return Object.freeze({ granted: true, ticket: this.#view(ticket), reasonCode: null });
  }

  /** Synchronous final dispatch check. A ticket may start exactly one physical operation. */
  beginExecution(ticket: ArbiterTicket): boolean {
    const internal = this.#internal(ticket);
    if (!internal || internal.state !== 'running' || internal.executionStarted) return false;
    if (this.#expired(internal, time(this.#now()))) {
      this.#abort(internal, 'arbiter-deadline-exceeded');
      this.#pump();
      this.#flushAborts();
      return false;
    }
    if (internal.sourceSignal?.aborted || internal.controller.signal.aborted) {
      this.#abort(internal, 'arbiter-cancelled');
      this.#pump();
      this.#flushAborts();
      return false;
    }
    internal.executionStarted = true;
    this.#executing.add(internal);
    return true;
  }

  /** Called only when the actual upstream promise settles, never merely because it was aborted. */
  settleExecution(ticket: ArbiterTicket): void {
    const internal = this.#internal(ticket);
    if (!internal || !this.#executing.delete(internal)) return;
    this.#pump();
    this.#flushAborts();
  }

  commit(ticket: ArbiterTicket): Readonly<{ committed: boolean; reasonCode: ArbiterReasonCode | null }> {
    const internal = this.#internal(ticket);
    if (!internal) return Object.freeze({ committed: false, reasonCode: 'arbiter-discarded' });
    if (internal.state === 'running' && this.#expired(internal, time(this.#now()))) {
      this.#abort(internal, 'arbiter-deadline-exceeded');
    }
    if (internal.state !== 'running') {
      this.#totals.discarded += 1;
      this.#pump();
      this.#flushAborts();
      return Object.freeze({ committed: false, reasonCode: internal.reasonCode ?? 'arbiter-discarded' });
    }
    internal.state = 'done';
    internal.reasonCode = null;
    this.#running.delete(internal);
    this.#finish(internal);
    this.#pump();
    this.#flushAborts();
    return Object.freeze({ committed: true, reasonCode: null });
  }

  release(ticket: ArbiterTicket): void {
    const internal = this.#internal(ticket);
    if (!internal || (internal.state !== 'running' && internal.state !== 'queued')) return;
    this.#abort(internal, 'arbiter-discarded');
    this.#pump();
    this.#flushAborts();
  }

  expire(): readonly ArbiterTicket[] {
    const affected = this.#sweepExpired();
    this.#pump();
    this.#flushAborts();
    return Object.freeze(affected.map((ticket) => this.#view(ticket)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearDeadlineTimer();
    for (const ticket of this.#tickets.values()) {
      if (ticket.state === 'running') this.#abort(ticket, 'arbiter-closed');
      else if (ticket.state === 'queued') {
        this.#abort(ticket, 'arbiter-closed', 'rejected');
        this.#totals.rejected += 1;
      }
    }
    this.#pruneTerminal();
    this.#flushAborts();
  }

  snapshot(): ArbiterSnapshot {
    const pools = new Map<string, {
      resourceKeyDigest: string; running: ClassCounts; queued: ClassCounts; inFlight: ClassCounts;
    }>();
    const add = (ticket: MutableTicket, state: 'running' | 'queued' | 'inFlight') => {
      let pool = pools.get(ticket.resourceKeyDigest);
      if (!pool) {
        pool = {
          resourceKeyDigest: ticket.resourceKeyDigest,
          running: { foreground: 0, background: 0 }, queued: { foreground: 0, background: 0 },
          inFlight: { foreground: 0, background: 0 },
        };
        pools.set(ticket.resourceKeyDigest, pool);
      }
      pool[state][ticket.class] += 1;
    };
    for (const ticket of this.#running) add(ticket, 'running');
    for (const ticket of [...this.#queued.foreground, ...this.#queued.background]) add(ticket, 'queued');
    for (const ticket of this.#executing) add(ticket, 'inFlight');
    return Object.freeze({
      version: PROVIDER_ARBITER_VERSION, closed: this.#closed,
      running: Object.freeze({
        foreground: this.#count(this.#running, 'foreground'), background: this.#count(this.#running, 'background'),
      }),
      queued: Object.freeze({ foreground: this.#queued.foreground.length, background: this.#queued.background.length }),
      inFlight: Object.freeze({
        foreground: this.#count(this.#executing, 'foreground'), background: this.#count(this.#executing, 'background'),
      }),
      retainedTickets: this.#tickets.size, terminalTickets: this.#terminal.size,
      pools: Object.freeze([...pools.values()].sort((a, b) => a.resourceKeyDigest.localeCompare(b.resourceKeyDigest))
        .map((pool) => Object.freeze({
          resourceKeyDigest: pool.resourceKeyDigest,
          running: Object.freeze(pool.running), queued: Object.freeze(pool.queued), inFlight: Object.freeze(pool.inFlight),
        }))),
      backgroundDeferrals: this.#backgroundDeferrals, totals: Object.freeze({ ...this.#totals }),
    });
  }

  waitForStart(ticket: ArbiterTicket): Promise<void> {
    return this.#internal(ticket)?.started.promise ?? Promise.resolve();
  }

  #internal(ticket: ArbiterTicket): MutableTicket | undefined {
    const internal = this.#owners.get(ticket);
    return internal && this.#tickets.get(internal.ticketId) === internal ? internal : undefined;
  }
  #reject(reasonCode: ArbiterReasonCode): ArbiterOutcome {
    this.#totals.rejected += 1;
    return Object.freeze({ granted: false, ticket: null, reasonCode });
  }
  #hasForeground(resource: string): boolean {
    return this.#countOccupied('foreground', resource) > 0
      || this.#queued.foreground.some((ticket) => ticket.resourceKeyDigest === resource);
  }
  #canStart(kind: ProviderArbitrationClass, resource: string): boolean {
    return !this.#closed
      && this.#countOccupied(kind) < this.#totalConcurrency[kind]
      && this.#countOccupied(kind, resource) < this.#concurrency[kind]
      && (kind === 'foreground' || !this.#hasForeground(resource));
  }
  #count(tickets: ReadonlySet<MutableTicket>, kind: ProviderArbitrationClass, resource?: string): number {
    let count = 0;
    for (const ticket of tickets) {
      if (ticket.class === kind && (resource === undefined || ticket.resourceKeyDigest === resource)) count += 1;
    }
    return count;
  }
  #countOccupied(kind: ProviderArbitrationClass, resource?: string): number {
    // A logical running ticket that has begun executing consumes one slot, not two.
    return this.#count(new Set([...this.#running, ...this.#executing]), kind, resource);
  }
  #expired(ticket: MutableTicket, now: number): boolean {
    return ticket.deadlineAt !== null && time(ticket.deadlineAt) <= now;
  }
  #sweepExpired(): MutableTicket[] {
    const now = time(this.#now());
    const affected: MutableTicket[] = [];
    for (const ticket of this.#tickets.values()) {
      if ((ticket.state === 'queued' || ticket.state === 'running') && this.#expired(ticket, now)) {
        this.#abort(ticket, 'arbiter-deadline-exceeded');
        affected.push(ticket);
      }
    }
    return affected;
  }
  #pump(): void {
    if (!this.#closed) {
      this.#sweepExpired();
      for (const kind of ['foreground', 'background'] as const) {
        const queue = this.#queued[kind];
        while (true) {
          // The oldest eligible resource may run even if another resource at the head is blocked.
          const index = queue.findIndex((ticket) => this.#canStart(kind, ticket.resourceKeyDigest));
          if (index < 0) break;
          const ticket = queue.splice(index, 1)[0]!;
          ticket.state = 'running';
          this.#running.add(ticket);
          ticket.started.resolve();
        }
      }
      if (this.#queued.background.some((ticket) => this.#hasForeground(ticket.resourceKeyDigest))) {
        this.#backgroundDeferrals += 1;
      }
    }
    this.#scheduleDeadline();
    this.#pruneTerminal();
  }
  #abort(ticket: MutableTicket, reason: ArbiterReasonCode, state: 'aborted' | 'rejected' = 'aborted'): void {
    if (ticket.state !== 'queued' && ticket.state !== 'running') return;
    this.#running.delete(ticket);
    const queue = this.#queued[ticket.class];
    const index = queue.indexOf(ticket);
    if (index >= 0) queue.splice(index, 1);
    ticket.state = state;
    ticket.reasonCode = reason;
    ticket.started.resolve();
    this.#finish(ticket);
    if (state === 'aborted') this.#totals.aborted += 1;
    this.#pendingAborts.push(ticket);
  }
  #finish(ticket: MutableTicket): void {
    if (ticket.sourceSignal && ticket.sourceListener) {
      ticket.sourceSignal.removeEventListener('abort', ticket.sourceListener);
    }
    ticket.sourceListener = undefined;
    ticket.sourceSignal = undefined;
    this.#terminal.add(ticket);
  }
  #pruneTerminal(): void {
    let removable = this.#terminal.size - this.#executingTerminalCount();
    for (const ticket of this.#terminal) {
      if (removable <= this.#terminalLimit) break;
      if (this.#executing.has(ticket)) continue;
      this.#terminal.delete(ticket);
      if (this.#tickets.get(ticket.ticketId) === ticket) this.#tickets.delete(ticket.ticketId);
      removable -= 1;
    }
  }
  #executingTerminalCount(): number {
    let count = 0;
    for (const ticket of this.#executing) if (this.#terminal.has(ticket)) count += 1;
    return count;
  }
  #clearDeadlineTimer(): void {
    if (this.#timerDeadline !== null) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#timerDeadline = null;
    this.#timerGeneration += 1;
  }
  #scheduleDeadline(): void {
    let earliest: number | null = null;
    if (!this.#closed) {
      for (const ticket of this.#tickets.values()) {
        if ((ticket.state === 'queued' || ticket.state === 'running') && ticket.deadlineAt !== null) {
          const deadline = time(ticket.deadlineAt);
          if (earliest === null || deadline < earliest) earliest = deadline;
        }
      }
    }
    if (earliest === this.#timerDeadline) return;
    this.#clearDeadlineTimer();
    if (earliest === null) return;
    this.#timerDeadline = earliest;
    const generation = this.#timerGeneration;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - time(this.#now())));
    this.#timer = this.#setTimer(() => {
      if (generation !== this.#timerGeneration) return;
      this.#timer = undefined;
      this.#timerDeadline = null;
      this.#pump();
      this.#flushAborts();
    }, delay);
  }
  #flushAborts(): void {
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      while (this.#pendingAborts.length > 0) {
        const ticket = this.#pendingAborts.shift()!;
        ticket.controller.abort(ticket.reasonCode);
      }
    } finally { this.#notifying = false; }
  }
  #view(ticket: MutableTicket): ArbiterTicket {
    const existing = this.#views.get(ticket);
    if (existing) return existing;
    const view = Object.freeze({
      ticketId: ticket.ticketId, class: ticket.class, entryKind: ticket.entryKind,
      keyDigest: ticket.keyDigest, resourceKeyDigest: ticket.resourceKeyDigest, deadlineAt: ticket.deadlineAt,
      signal: ticket.controller.signal,
      get state() { return ticket.state; },
      get reasonCode() { return ticket.reasonCode; },
    });
    this.#views.set(ticket, view);
    this.#owners.set(view, ticket);
    return view;
  }
}
