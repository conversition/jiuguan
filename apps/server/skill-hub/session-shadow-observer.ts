import {
  AGENT_SKILL_GRANT_VERSION,
  AGENT_SKILL_SELECTION_REQUEST_VERSION,
  selectAgentSkillHeaders,
  type AgentSkillCandidateRefV1,
  type AgentSkillExecutionGrantV1,
} from '@jiuguan/skill-hub';
import type {
  SkillSelectionObservationV2,
  SkillSelectionScopeDigestsV2,
  SkillSelectionObserver,
} from '../../../packages/session/public/skill-selection-observer.ts';
import type { LegacyAgentSkillCatalogAdapter } from './legacy-catalog-adapter.ts';
import {
  observeAgentSkillSelection,
  type AgentSkillShadowObservation,
  type LegacySkillMatchObservation,
} from './shadow-selection.ts';

export const SESSION_AGENT_SKILL_SHADOW_VERSION = 'session-agent-skill-shadow-v1' as const;
export const SESSION_AGENT_SKILL_SHADOW_MINIMUM_QUALIFYING_SAMPLES = 20 as const;

export type SessionAgentSkillShadowContentMode = 'nsf' | 'nsfw';

export type SessionAgentSkillShadowPromotionBlockerV1 =
  | 'shadow-disabled'
  | 'validation-window-health-misaligned'
  | 'runner-failed'
  | 'runner-dropped'
  | 'runner-in-flight'
  | 'runner-pending'
  | 'runner-faulted'
  | 'catalog-refresh-failed'
  | 'qualifying-samples-insufficient'
  | 'selection-unmapped'
  | 'selection-mismatch';

export interface SessionAgentSkillShadowAuditV1 {
  readonly auditVersion: typeof SESSION_AGENT_SKILL_SHADOW_VERSION;
  readonly mode: 'observe-only';
  /** Exact immutable catalog used by this observation. */
  readonly catalogRevision: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly scopeDigests: SkillSelectionScopeDigestsV2;
  readonly discoveryDigest: string;
  /** Header-only shadow cost, including Catalog snapshot resolution; never foreground latency. */
  readonly durationMicros: number;
  readonly mappedCandidateCount: number;
  readonly unmappedCandidateCount: number;
  readonly mappedLegacyCount: number;
  readonly unmappedLegacyCount: number;
  /**
   * True only when this turn actually exposed at least one candidate or legacy selection.
   * Both mapped and unmapped refs qualify, so mapping drift stays in the promotion denominator.
   * Ordinary turns with no matching evidence remain observable but never count as promotion-green.
   */
  readonly qualifying: boolean;
  /** False whenever catalog drift or incomplete compatibility metadata prevents a full comparison. */
  readonly promotionCompatible: boolean;
  readonly comparison: AgentSkillShadowObservation;
}

export interface SessionAgentSkillShadowObserverOptions {
  /** Exact configured roots. Out-of-scope legacy matches never enter Pilot evidence. */
  readonly allowedRootSkillIds: readonly string[];
  /** Resolve a frozen adapter for each successful turn so edits cannot mix catalog revisions. */
  readonly resolveCatalog: () => LegacyAgentSkillCatalogAdapter | Promise<LegacyAgentSkillCatalogAdapter>;
  /** Local isolated audit sink. It must not forward detailed Skill refs into generic telemetry. */
  readonly audit: (entry: SessionAgentSkillShadowAuditV1) => void | Promise<void>;
}

export interface SessionAgentSkillShadowMetricsSnapshotV1 {
  readonly snapshotVersion: 'session-agent-skill-shadow-metrics-v1';
  /** Current validation window. A catalog revision change resets all non-lifetime counters. */
  readonly catalogRevision: string | null;
  readonly validationWindow: number;
  readonly observedTurns: number;
  /** Triggered samples only; this is the promotion-rate denominator. */
  readonly qualifyingTurns: number;
  /** Ordinary empty turns, retained for visibility but excluded from promotion decisions. */
  readonly nonQualifyingTurns: number;
  readonly promotionCompatibleTurns: number;
  readonly mismatchTurns: number;
  readonly unmappedCandidates: number;
  readonly unmappedLegacySelections: number;
  readonly nsfTurns: number;
  readonly nsfwTurns: number;
  readonly totalDurationMicros: number;
  readonly maxDurationMicros: number;
  readonly averageDurationMicros: number;
  readonly lifetimeObservedTurns: number;
  readonly lifetimeQualifyingTurns: number;
  readonly lifetimeNonQualifyingTurns: number;
  readonly lifetimeValidationWindows: number;
  /**
   * Promotion evidence is isolated by content mode. The aggregate fields above remain only for
   * compatibility and observability; they must never be used to declare a mode promotion-ready.
   */
  readonly contentModeMetrics: Readonly<Record<
    SessionAgentSkillShadowContentMode,
    SessionAgentSkillShadowContentModeMetricsV1
  >>;
}

export interface SessionAgentSkillShadowContentModeMetricsV1 {
  readonly observedTurns: number;
  readonly qualifyingTurns: number;
  readonly nonQualifyingTurns: number;
  readonly promotionCompatibleTurns: number;
  readonly mismatchTurns: number;
  readonly unmappedCandidates: number;
  readonly unmappedLegacySelections: number;
  readonly totalDurationMicros: number;
  readonly maxDurationMicros: number;
  readonly averageDurationMicros: number;
}

export interface SessionAgentSkillShadowPromotionHealthV1 {
  readonly enabled: boolean;
  /** False means the health baseline is not bound to the selection catalog revision. */
  readonly validationWindowHealthAligned: boolean;
  readonly failed: number;
  readonly dropped: number;
  readonly inFlight: number;
  readonly pending: number;
  readonly faulted: boolean;
  readonly catalogRefreshFailures: number;
}

export interface SessionAgentSkillShadowPromotionStatusV1 {
  /** @deprecated Aggregate compatibility signal. Use promotionByContentMode[mode].promotionReady. */
  readonly promotionAttemptDenominator: number;
  /** @deprecated Aggregate compatibility signal. Use promotionByContentMode[mode].promotionReady. */
  readonly promotionCompatibleRateBps: number;
  /** @deprecated Compatibility summary. True only when at least one isolated mode is promotion-ready. */
  readonly promotionOperationallyClean: boolean;
  readonly promotionByContentMode: Readonly<Record<
    SessionAgentSkillShadowContentMode,
    SessionAgentSkillShadowContentModePromotionStatusV1
  >>;
}

export interface SessionAgentSkillShadowContentModePromotionStatusV1 {
  readonly qualifyingTurns: number;
  readonly minimumQualifyingTurns: typeof SESSION_AGENT_SKILL_SHADOW_MINIMUM_QUALIFYING_SAMPLES;
  readonly remainingQualifyingTurns: number;
  readonly sampleGatePassed: boolean;
  readonly selectionConsistent: boolean;
  readonly operationalHealthPassed: boolean;
  readonly promotionReady: boolean;
  readonly blockers: readonly SessionAgentSkillShadowPromotionBlockerV1[];
}

function operationalHealthBlockers(
  health: SessionAgentSkillShadowPromotionHealthV1,
): readonly SessionAgentSkillShadowPromotionBlockerV1[] {
  const blockers: SessionAgentSkillShadowPromotionBlockerV1[] = [];
  if (!health.enabled) blockers.push('shadow-disabled');
  if (!health.validationWindowHealthAligned) blockers.push('validation-window-health-misaligned');
  if (health.failed > 0) blockers.push('runner-failed');
  if (health.dropped > 0) blockers.push('runner-dropped');
  if (health.inFlight > 0) blockers.push('runner-in-flight');
  if (health.pending > 0) blockers.push('runner-pending');
  if (health.faulted) blockers.push('runner-faulted');
  if (health.catalogRefreshFailures > 0) blockers.push('catalog-refresh-failed');
  return blockers;
}

function evaluateContentModePromotion(
  metrics: SessionAgentSkillShadowContentModeMetricsV1,
  healthBlockers: readonly SessionAgentSkillShadowPromotionBlockerV1[],
): SessionAgentSkillShadowContentModePromotionStatusV1 {
  const remainingQualifyingTurns = Math.max(
    0,
    SESSION_AGENT_SKILL_SHADOW_MINIMUM_QUALIFYING_SAMPLES - metrics.qualifyingTurns,
  );
  const sampleGatePassed = remainingQualifyingTurns === 0;
  const hasUnmappedSelection = metrics.unmappedCandidates > 0
    || metrics.unmappedLegacySelections > 0;
  const selectionConsistent = metrics.qualifyingTurns > 0
    && metrics.promotionCompatibleTurns === metrics.qualifyingTurns
    && metrics.mismatchTurns === 0
    && !hasUnmappedSelection;
  const blockers = [...healthBlockers];
  if (!sampleGatePassed) blockers.push('qualifying-samples-insufficient');
  if (hasUnmappedSelection) blockers.push('selection-unmapped');
  if (metrics.qualifyingTurns > 0 && !selectionConsistent) blockers.push('selection-mismatch');
  const operationalHealthPassed = healthBlockers.length === 0;
  return Object.freeze({
    qualifyingTurns: metrics.qualifyingTurns,
    minimumQualifyingTurns: SESSION_AGENT_SKILL_SHADOW_MINIMUM_QUALIFYING_SAMPLES,
    remainingQualifyingTurns,
    sampleGatePassed,
    selectionConsistent,
    operationalHealthPassed,
    promotionReady: sampleGatePassed && selectionConsistent && operationalHealthPassed,
    blockers: Object.freeze(blockers),
  });
}

/** Keep selection evidence and runner/cache health as separate promotion gates. */
export function evaluateSessionAgentSkillShadowPromotion(
  metrics: SessionAgentSkillShadowMetricsSnapshotV1,
  health: SessionAgentSkillShadowPromotionHealthV1,
): SessionAgentSkillShadowPromotionStatusV1 {
  const denominator = metrics.qualifyingTurns;
  const compatibleRateBps = denominator === 0
    ? 0
    : Math.floor((metrics.promotionCompatibleTurns * 10_000) / denominator);
  const healthBlockers = operationalHealthBlockers(health);
  const promotionByContentMode = Object.freeze({
    nsf: evaluateContentModePromotion(metrics.contentModeMetrics.nsf, healthBlockers),
    nsfw: evaluateContentModePromotion(metrics.contentModeMetrics.nsfw, healthBlockers),
  });
  return Object.freeze({
    promotionAttemptDenominator: denominator,
    promotionCompatibleRateBps: compatibleRateBps,
    // Existing readers stay fail-closed: one aggregate sample can no longer look green.
    promotionOperationallyClean: promotionByContentMode.nsf.promotionReady
      || promotionByContentMode.nsfw.promotionReady,
    promotionByContentMode,
  });
}

export interface SessionAgentSkillShadowCumulativeHealthV1 {
  readonly failed: number;
  readonly dropped: number;
  readonly catalogRefreshFailures: number;
}

export interface SessionAgentSkillShadowWindowHealthSnapshotV1 {
  /** Revision whose catalog-bound audit established the current health window. */
  readonly catalogRevision: string | null;
  readonly aligned: boolean;
  readonly failed: number;
  readonly dropped: number;
  readonly catalogRefreshFailures: number;
  readonly lifetimeFailed: number;
  readonly lifetimeDropped: number;
  readonly lifetimeCatalogRefreshFailures: number;
}

function healthCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('session Agent Skill shadow health counter must be a non-negative safe integer');
  }
  return value;
}

/**
 * Binds cumulative runner/cache counters to the exact catalog revision that produced an audit.
 * Runner and cache work starts before a revision is known, so rotation happens only at the first
 * successful catalog-bound audit. The previous successful audit is the hand-off checkpoint: old
 * faults cannot poison every future revision, while work after that checkpoint (including failures
 * before the new revision's first success) is conservatively attributed to the new window.
 */
export class SessionAgentSkillShadowHealthWindow {
  private catalogRevision: string | null = null;
  private failedBaseline = 0;
  private droppedBaseline = 0;
  private catalogRefreshFailuresBaseline = 0;
  private lastSuccessfulAuditFailed = 0;
  private lastSuccessfulAuditDropped = 0;
  private lastSuccessfulAuditCatalogRefreshFailures = 0;

  recordSuccessfulAudit(
    catalogRevision: string,
    cumulative: SessionAgentSkillShadowCumulativeHealthV1,
  ): boolean {
    if (typeof catalogRevision !== 'string' || catalogRevision.length === 0) {
      throw new TypeError('session Agent Skill shadow catalog revision is required');
    }
    const failed = healthCounter(cumulative.failed);
    const dropped = healthCounter(cumulative.dropped);
    const catalogRefreshFailures = healthCounter(cumulative.catalogRefreshFailures);
    if (failed < this.lastSuccessfulAuditFailed
      || dropped < this.lastSuccessfulAuditDropped
      || catalogRefreshFailures < this.lastSuccessfulAuditCatalogRefreshFailures) {
      throw new TypeError('session Agent Skill shadow cumulative health counter regressed');
    }
    const rotated = this.catalogRevision !== catalogRevision;
    if (rotated) {
      // Attribute work since the previous successful audit to the new window. Taking the
      // current counters here would erase drops/refresh failures that happened while resolving
      // the first sample of this revision. The very first window deliberately starts at zero.
      this.failedBaseline = this.lastSuccessfulAuditFailed;
      this.droppedBaseline = this.lastSuccessfulAuditDropped;
      this.catalogRefreshFailuresBaseline = this.lastSuccessfulAuditCatalogRefreshFailures;
      this.catalogRevision = catalogRevision;
    }
    this.lastSuccessfulAuditFailed = failed;
    this.lastSuccessfulAuditDropped = dropped;
    this.lastSuccessfulAuditCatalogRefreshFailures = catalogRefreshFailures;
    return rotated;
  }

  snapshot(
    expectedCatalogRevision: string | null,
    cumulative: SessionAgentSkillShadowCumulativeHealthV1,
  ): SessionAgentSkillShadowWindowHealthSnapshotV1 {
    const lifetimeFailed = healthCounter(cumulative.failed);
    const lifetimeDropped = healthCounter(cumulative.dropped);
    const lifetimeCatalogRefreshFailures = healthCounter(cumulative.catalogRefreshFailures);
    const aligned = expectedCatalogRevision !== null
      && this.catalogRevision === expectedCatalogRevision;
    // A missing/misaligned baseline is fail-closed: expose all lifetime faults as current-window
    // faults instead of silently creating a baseline during an API read.
    const failedBaseline = aligned ? this.failedBaseline : 0;
    const droppedBaseline = aligned ? this.droppedBaseline : 0;
    const refreshBaseline = aligned ? this.catalogRefreshFailuresBaseline : 0;
    return Object.freeze({
      catalogRevision: this.catalogRevision,
      aligned,
      failed: Math.max(0, lifetimeFailed - failedBaseline),
      dropped: Math.max(0, lifetimeDropped - droppedBaseline),
      catalogRefreshFailures: Math.max(0, lifetimeCatalogRefreshFailures - refreshBaseline),
      lifetimeFailed,
      lifetimeDropped,
      lifetimeCatalogRefreshFailures,
    });
  }
}

interface MutableSessionAgentSkillShadowContentModeMetrics {
  observedTurns: number;
  qualifyingTurns: number;
  nonQualifyingTurns: number;
  promotionCompatibleTurns: number;
  mismatchTurns: number;
  unmappedCandidates: number;
  unmappedLegacySelections: number;
  totalDurationMicros: number;
  maxDurationMicros: number;
}

function emptyContentModeMetrics(): MutableSessionAgentSkillShadowContentModeMetrics {
  return {
    observedTurns: 0,
    qualifyingTurns: 0,
    nonQualifyingTurns: 0,
    promotionCompatibleTurns: 0,
    mismatchTurns: 0,
    unmappedCandidates: 0,
    unmappedLegacySelections: 0,
    totalDurationMicros: 0,
    maxDurationMicros: 0,
  };
}

function emptyContentModeMetricsByMode(): Record<
  SessionAgentSkillShadowContentMode,
  MutableSessionAgentSkillShadowContentModeMetrics
> {
  return { nsf: emptyContentModeMetrics(), nsfw: emptyContentModeMetrics() };
}

function snapshotContentModeMetrics(
  metrics: MutableSessionAgentSkillShadowContentModeMetrics,
): SessionAgentSkillShadowContentModeMetricsV1 {
  return Object.freeze({
    observedTurns: metrics.observedTurns,
    qualifyingTurns: metrics.qualifyingTurns,
    nonQualifyingTurns: metrics.nonQualifyingTurns,
    promotionCompatibleTurns: metrics.promotionCompatibleTurns,
    mismatchTurns: metrics.mismatchTurns,
    unmappedCandidates: metrics.unmappedCandidates,
    unmappedLegacySelections: metrics.unmappedLegacySelections,
    totalDurationMicros: metrics.totalDurationMicros,
    maxDurationMicros: metrics.maxDurationMicros,
    averageDurationMicros: metrics.observedTurns === 0
      ? 0
      : Math.round(metrics.totalDurationMicros / metrics.observedTurns),
  });
}

/** Aggregate-only in-memory metrics; detailed Skill refs remain inside the isolated callback. */
export class SessionAgentSkillShadowMetrics {
  private catalogRevision: string | null = null;
  private validationWindow = 0;
  private observedTurns = 0;
  private qualifyingTurns = 0;
  private nonQualifyingTurns = 0;
  private promotionCompatibleTurns = 0;
  private mismatchTurns = 0;
  private unmappedCandidates = 0;
  private unmappedLegacySelections = 0;
  private nsfTurns = 0;
  private nsfwTurns = 0;
  private totalDurationMicros = 0;
  private maxDurationMicros = 0;
  private lifetimeObservedTurns = 0;
  private lifetimeQualifyingTurns = 0;
  private lifetimeNonQualifyingTurns = 0;
  private contentModeMetrics = emptyContentModeMetricsByMode();

  record(entry: SessionAgentSkillShadowAuditV1): void {
    if (this.catalogRevision !== entry.catalogRevision) {
      this.catalogRevision = entry.catalogRevision;
      this.validationWindow += 1;
      this.observedTurns = 0;
      this.qualifyingTurns = 0;
      this.nonQualifyingTurns = 0;
      this.promotionCompatibleTurns = 0;
      this.mismatchTurns = 0;
      this.unmappedCandidates = 0;
      this.unmappedLegacySelections = 0;
      this.nsfTurns = 0;
      this.nsfwTurns = 0;
      this.totalDurationMicros = 0;
      this.maxDurationMicros = 0;
      this.contentModeMetrics = emptyContentModeMetricsByMode();
    }
    const contentMode = this.contentModeMetrics[entry.contentMode];
    this.observedTurns += 1;
    this.lifetimeObservedTurns += 1;
    contentMode.observedTurns += 1;
    if (entry.qualifying) {
      this.qualifyingTurns += 1;
      this.lifetimeQualifyingTurns += 1;
      contentMode.qualifyingTurns += 1;
      if (entry.promotionCompatible) {
        this.promotionCompatibleTurns += 1;
        contentMode.promotionCompatibleTurns += 1;
      } else {
        this.mismatchTurns += 1;
        contentMode.mismatchTurns += 1;
      }
    } else {
      this.nonQualifyingTurns += 1;
      this.lifetimeNonQualifyingTurns += 1;
      contentMode.nonQualifyingTurns += 1;
    }
    this.unmappedCandidates += entry.unmappedCandidateCount;
    this.unmappedLegacySelections += entry.unmappedLegacyCount;
    contentMode.unmappedCandidates += entry.unmappedCandidateCount;
    contentMode.unmappedLegacySelections += entry.unmappedLegacyCount;
    if (entry.contentMode === 'nsf') this.nsfTurns += 1;
    else this.nsfwTurns += 1;
    this.totalDurationMicros += entry.durationMicros;
    this.maxDurationMicros = Math.max(this.maxDurationMicros, entry.durationMicros);
    contentMode.totalDurationMicros += entry.durationMicros;
    contentMode.maxDurationMicros = Math.max(contentMode.maxDurationMicros, entry.durationMicros);
  }

  snapshot(): SessionAgentSkillShadowMetricsSnapshotV1 {
    return Object.freeze({
      snapshotVersion: 'session-agent-skill-shadow-metrics-v1',
      catalogRevision: this.catalogRevision,
      validationWindow: this.validationWindow,
      observedTurns: this.observedTurns,
      qualifyingTurns: this.qualifyingTurns,
      nonQualifyingTurns: this.nonQualifyingTurns,
      promotionCompatibleTurns: this.promotionCompatibleTurns,
      mismatchTurns: this.mismatchTurns,
      unmappedCandidates: this.unmappedCandidates,
      unmappedLegacySelections: this.unmappedLegacySelections,
      nsfTurns: this.nsfTurns,
      nsfwTurns: this.nsfwTurns,
      totalDurationMicros: this.totalDurationMicros,
      maxDurationMicros: this.maxDurationMicros,
      averageDurationMicros: this.observedTurns === 0
        ? 0
        : Math.round(this.totalDurationMicros / this.observedTurns),
      lifetimeObservedTurns: this.lifetimeObservedTurns,
      lifetimeQualifyingTurns: this.lifetimeQualifyingTurns,
      lifetimeNonQualifyingTurns: this.lifetimeNonQualifyingTurns,
      lifetimeValidationWindows: this.validationWindow,
      contentModeMetrics: Object.freeze({
        nsf: snapshotContentModeMetrics(this.contentModeMetrics.nsf),
        nsfw: snapshotContentModeMetrics(this.contentModeMetrics.nsfw),
      }),
    });
  }
}

const SHADOW_CAPABILITY_ID = 'dialogue.skillMatch';
const SHADOW_TASK_KIND = 'dialogue_turn';
const SHADOW_ROOT_SKILL_ID_RE = /^skill:sha256:[a-f0-9]{64}$/u;

function shadowGrant(budgetTokens: number): AgentSkillExecutionGrantV1 {
  return Object.freeze({
    grantVersion: AGENT_SKILL_GRANT_VERSION,
    tools: Object.freeze([]),
    writableArtifactKinds: Object.freeze([]),
    maxRiskTier: 'advisory',
    maxModelCalls: 0,
    maxToolCalls: 0,
    maxInputTokens: budgetTokens,
    maxOutputTokens: 0,
  });
}

/**
 * Server-side Phase-B bridge from the committed legacy turn snapshot to the new header selector.
 * It never materializes bodies, never receives a Provider client and cannot mutate the active catalog.
 */
export function createSessionAgentSkillShadowObserver(
  options: SessionAgentSkillShadowObserverOptions,
): SkillSelectionObserver {
  if (!options || typeof options.resolveCatalog !== 'function' || typeof options.audit !== 'function') {
    throw new TypeError('session Agent Skill shadow observer options are invalid');
  }
  if (!Array.isArray(options.allowedRootSkillIds)
    || options.allowedRootSkillIds.length > 64
    || options.allowedRootSkillIds.some((skillId) => (
      typeof skillId !== 'string' || !SHADOW_ROOT_SKILL_ID_RE.test(skillId)
    ))
    || new Set(options.allowedRootSkillIds).size !== options.allowedRootSkillIds.length) {
    throw new TypeError('session Agent Skill shadow roots must be exact and unique');
  }
  const allowedRootSkillIds = new Set(options.allowedRootSkillIds);
  return Object.freeze({
    async observe(input: SkillSelectionObservationV2): Promise<void> {
      const startedAt = process.hrtime.bigint();
      const adapter = await options.resolveCatalog();
      const headerBySkillId = new Map(adapter.snapshot.headers.map((header) => [
        header.manifest.skillId,
        header,
      ]));
      const publishedBySkillId = new Map(adapter.published.map((item) => [item.skillId, item]));
      const candidates: AgentSkillCandidateRefV1[] = [];
      let unmappedCandidateCount = 0;
      for (const candidate of input.candidates) {
        // Legacy discovery observes the whole repository. Only configured roots belong to this
        // Pilot; dependency headers may enter solely through the selector's requires closure.
        if (!allowedRootSkillIds.has(candidate.skillId)) continue;
        const published = publishedBySkillId.get(candidate.skillId);
        const header = headerBySkillId.get(candidate.skillId);
        if (!published || !header
          || published.sourceVersion !== candidate.sourceVersion
          || published.documentIdentityDigest !== candidate.documentIdentityDigest
          || header.manifest.version !== published.version
          || header.manifest.bodyHash !== candidate.bodyHash) {
          unmappedCandidateCount += 1;
          continue;
        }
        candidates.push(Object.freeze({
          skillId: published.skillId,
          version: published.version,
          reasonCode: candidate.reasonCode,
          scoreBps: candidate.scoreBps,
          evidenceDigest: candidate.evidenceDigest,
        }));
      }

      const legacyMatches: LegacySkillMatchObservation[] = [];
      let unmappedLegacyCount = 0;
      for (const selected of input.legacySelected) {
        if (!allowedRootSkillIds.has(selected.skillId)) continue;
        const published = publishedBySkillId.get(selected.skillId);
        const header = headerBySkillId.get(selected.skillId);
        if (!published || !header
          || published.sourceVersion !== selected.sourceVersion
          || published.documentIdentityDigest !== selected.documentIdentityDigest
          || header.manifest.version !== published.version
          || header.manifest.bodyHash !== selected.bodyHash) {
          unmappedLegacyCount += 1;
          continue;
        }
        const candidate = input.candidates.find((item) => item.skillId === selected.skillId);
        legacyMatches.push(Object.freeze({
          skillId: published.skillId,
          version: published.version,
          score: (candidate?.scoreBps ?? 0) / 10_000,
          selectionReason: candidate?.reasonCode ?? 'legacy.selected',
        }));
      }

      const grant = shadowGrant(input.budgetTokens);
      const receipt = selectAgentSkillHeaders(adapter.snapshot.headers, {
        requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
        catalogRevision: adapter.snapshot.catalogRevision,
        capabilityId: SHADOW_CAPABILITY_ID,
        taskKind: SHADOW_TASK_KIND,
        phase: 'plan',
        contentMode: input.contentMode,
        scope: input.scopeDigests,
        grant,
        budgetTokens: input.budgetTokens,
        maxSkills: Math.max(1, input.maxSkills),
        explicit: [],
        candidates,
      });
      const comparison = observeAgentSkillSelection(legacyMatches, receipt);
      const qualifying = candidates.length + unmappedCandidateCount
        + legacyMatches.length + unmappedLegacyCount > 0;
      const durationMicros = Math.min(
        Number.MAX_SAFE_INTEGER,
        Number((process.hrtime.bigint() - startedAt) / 1_000n),
      );
      const entry: SessionAgentSkillShadowAuditV1 = Object.freeze({
        auditVersion: SESSION_AGENT_SKILL_SHADOW_VERSION,
        mode: 'observe-only',
        catalogRevision: adapter.snapshot.catalogRevision,
        contentMode: input.contentMode,
        scopeDigests: input.scopeDigests,
        discoveryDigest: input.discoveryDigest,
        durationMicros,
        mappedCandidateCount: candidates.length,
        unmappedCandidateCount,
        mappedLegacyCount: legacyMatches.length,
        unmappedLegacyCount,
        qualifying,
        promotionCompatible: qualifying
          && comparison.promotionCompatible
          && unmappedCandidateCount === 0
          && unmappedLegacyCount === 0,
        comparison,
      });
      await options.audit(entry);
    },
  });
}
