import type {
  SkillSelectionObservationV2,
  SkillSelectionObserver,
} from '../../../packages/session/public/skill-selection-observer.ts';
import type { LegacyAgentSkillCatalogAdapter } from './legacy-catalog-adapter.ts';

export const SESSION_AGENT_SKILL_SHADOW_RUNNER_METRICS_VERSION =
  'session-agent-skill-shadow-runner-metrics-v1' as const;
export const SESSION_AGENT_SKILL_CATALOG_CACHE_METRICS_VERSION =
  'session-agent-skill-catalog-cache-metrics-v1' as const;

type Schedule = (task: () => void) => void;
type Clock = () => number;

const defaultSchedule: Schedule = (task) => { setImmediate(task); };
const defaultClock: Clock = () => Date.now();

function iso(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function errorCode(reason: unknown, fallback: string): string {
  let candidate: unknown;
  try {
    candidate = reason && typeof reason === 'object'
      ? (reason as { code?: unknown }).code
      : undefined;
  } catch {
    return fallback;
  }
  if (typeof candidate !== 'string') return fallback;
  const normalized = candidate.normalize('NFC');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(normalized) ? normalized : fallback;
}

export interface SessionAgentSkillShadowRunnerMetricsSnapshotV1 {
  readonly snapshotVersion: typeof SESSION_AGENT_SKILL_SHADOW_RUNNER_METRICS_VERSION;
  readonly attempts: number;
  readonly completed: number;
  readonly failed: number;
  readonly dropped: number;
  readonly inFlight: 0 | 1;
  readonly pending: 0 | 1;
  readonly running: boolean;
  readonly faulted: boolean;
  readonly stale: boolean;
  readonly lastOutcome: 'success' | 'failure' | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface SessionAgentSkillShadowRunnerOptions {
  readonly schedule?: Schedule;
  readonly now?: Clock;
  /** No activity beyond this interval is reported as stale; this never changes selection. */
  readonly staleAfterMs?: number;
}

/**
 * A one-worker, one-pending-slot runner for the observe-only selector.
 * `observe()` only updates memory and schedules work. It never awaits the delegate or performs I/O.
 */
export class SessionAgentSkillShadowRunner implements SkillSelectionObserver {
  private readonly schedule: Schedule;
  private readonly now: Clock;
  private readonly staleAfterMs: number;
  private pendingInput: SkillSelectionObservationV2 | undefined;
  private scheduled = false;
  private active = false;
  private attempts = 0;
  private completed = 0;
  private failed = 0;
  private dropped = 0;
  private lastAttemptAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private lastFailureAt: number | undefined;
  private lastErrorCode: string | null = null;
  private lastOutcome: 'success' | 'failure' | null = null;

  constructor(
    private readonly delegate: SkillSelectionObserver,
    options: SessionAgentSkillShadowRunnerOptions = {},
  ) {
    if (!delegate || typeof delegate.observe !== 'function') {
      throw new TypeError('session Agent Skill shadow runner delegate is invalid');
    }
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? defaultClock;
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 1_000) {
      throw new TypeError('session Agent Skill shadow staleAfterMs must be at least 1000');
    }
  }

  observe(input: SkillSelectionObservationV2): void {
    this.attempts += 1;
    this.lastAttemptAt = this.now();
    if (this.pendingInput !== undefined) this.dropped += 1;
    this.pendingInput = input;
    this.scheduleDrain();
  }

  snapshot(): SessionAgentSkillShadowRunnerMetricsSnapshotV1 {
    const activityAt = Math.max(
      this.lastAttemptAt ?? 0,
      this.lastSuccessAt ?? 0,
      this.lastFailureAt ?? 0,
    );
    const running = this.active || this.scheduled || this.pendingInput !== undefined;
    return Object.freeze({
      snapshotVersion: SESSION_AGENT_SKILL_SHADOW_RUNNER_METRICS_VERSION,
      attempts: this.attempts,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
      inFlight: this.active ? 1 : 0,
      pending: this.pendingInput === undefined ? 0 : 1,
      running,
      faulted: this.lastOutcome === 'failure',
      stale: this.attempts > 0 && !running && this.now() - activityAt >= this.staleAfterMs,
      lastOutcome: this.lastOutcome,
      lastAttemptAt: iso(this.lastAttemptAt),
      lastSuccessAt: iso(this.lastSuccessAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastErrorCode: this.lastErrorCode,
    });
  }

  private scheduleDrain(): void {
    if (this.active || this.scheduled || this.pendingInput === undefined) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active || this.pendingInput === undefined) return;
    const input = this.pendingInput;
    this.pendingInput = undefined;
    this.active = true;
    try {
      await this.delegate.observe(input);
      this.completed += 1;
      this.lastSuccessAt = this.now();
      this.lastOutcome = 'success';
    } catch (reason) {
      this.failed += 1;
      this.lastFailureAt = this.now();
      this.lastErrorCode = errorCode(reason, 'agent-skill-shadow-observer-failed');
      this.lastOutcome = 'failure';
    } finally {
      this.active = false;
      this.scheduleDrain();
    }
  }
}

export interface CachedLegacyAgentSkillCatalogResolverOptions {
  readonly load: () => LegacyAgentSkillCatalogAdapter | Promise<LegacyAgentSkillCatalogAdapter>;
  readonly ttlMs?: number;
  readonly schedule?: Schedule;
  readonly now?: Clock;
}

export interface SessionAgentSkillCatalogCacheMetricsSnapshotV1 {
  readonly snapshotVersion: typeof SESSION_AGENT_SKILL_CATALOG_CACHE_METRICS_VERSION;
  readonly policy: 'ttl-fail-closed';
  readonly ttlMs: number;
  readonly cached: boolean;
  readonly fresh: boolean;
  readonly stale: boolean;
  readonly refreshing: boolean;
  readonly ageMs: number | null;
  readonly refreshAttempts: number;
  readonly refreshCompleted: number;
  readonly refreshFailures: number;
  readonly lastRefreshAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastErrorCode: string | null;
}

/**
 * Reuses an immutable adapter for a short TTL. Expired snapshots are never served on refresh
 * failure: a failed refresh rejects the observation so it cannot become a promotion-green sample.
 */
export class CachedLegacyAgentSkillCatalogResolver {
  private readonly ttlMs: number;
  private readonly schedule: Schedule;
  private readonly now: Clock;
  private cached: { readonly adapter: LegacyAgentSkillCatalogAdapter; readonly loadedAt: number } | undefined;
  private refreshPromise: Promise<LegacyAgentSkillCatalogAdapter> | undefined;
  private refreshAttempts = 0;
  private refreshCompleted = 0;
  private refreshFailures = 0;
  private lastRefreshAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private lastFailureAt: number | undefined;
  private lastErrorCode: string | null = null;

  constructor(private readonly options: CachedLegacyAgentSkillCatalogResolverOptions) {
    if (!options || typeof options.load !== 'function') {
      throw new TypeError('session Agent Skill catalog cache loader is invalid');
    }
    this.ttlMs = options.ttlMs ?? 5_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 250 || this.ttlMs > 60_000) {
      throw new TypeError('session Agent Skill catalog cache ttlMs must be between 250 and 60000');
    }
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? defaultClock;
  }

  resolve(): Promise<LegacyAgentSkillCatalogAdapter> {
    const now = this.now();
    if (this.cached && now - this.cached.loadedAt < this.ttlMs) {
      return Promise.resolve(this.cached.adapter);
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshAttempts += 1;
    this.lastRefreshAt = now;
    this.refreshPromise = new Promise<LegacyAgentSkillCatalogAdapter>((resolve, reject) => {
      this.schedule(() => {
        let loaded: LegacyAgentSkillCatalogAdapter | Promise<LegacyAgentSkillCatalogAdapter>;
        try {
          loaded = this.options.load();
        } catch (reason) {
          this.finishFailure(reason);
          reject(reason);
          return;
        }
        void Promise.resolve(loaded).then(
          (adapter) => {
            const loadedAt = this.now();
            this.cached = Object.freeze({ adapter, loadedAt });
            this.refreshCompleted += 1;
            this.lastSuccessAt = loadedAt;
            this.lastErrorCode = null;
            this.refreshPromise = undefined;
            resolve(adapter);
          },
          (reason) => {
            this.finishFailure(reason);
            reject(reason);
          },
        );
      });
    });
    return this.refreshPromise;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  snapshot(): SessionAgentSkillCatalogCacheMetricsSnapshotV1 {
    const ageMs = this.cached ? Math.max(0, this.now() - this.cached.loadedAt) : null;
    return Object.freeze({
      snapshotVersion: SESSION_AGENT_SKILL_CATALOG_CACHE_METRICS_VERSION,
      policy: 'ttl-fail-closed',
      ttlMs: this.ttlMs,
      cached: this.cached !== undefined,
      fresh: ageMs !== null && ageMs < this.ttlMs,
      stale: ageMs !== null && ageMs >= this.ttlMs,
      refreshing: this.refreshPromise !== undefined,
      ageMs,
      refreshAttempts: this.refreshAttempts,
      refreshCompleted: this.refreshCompleted,
      refreshFailures: this.refreshFailures,
      lastRefreshAt: iso(this.lastRefreshAt),
      lastSuccessAt: iso(this.lastSuccessAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastErrorCode: this.lastErrorCode,
    });
  }

  private finishFailure(reason: unknown): void {
    this.refreshFailures += 1;
    this.lastFailureAt = this.now();
    this.lastErrorCode = errorCode(reason, 'agent-skill-catalog-refresh-failed');
    this.refreshPromise = undefined;
  }
}
