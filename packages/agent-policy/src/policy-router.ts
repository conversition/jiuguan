import { createHash } from 'node:crypto';

export const POLICY_ROUTER_LEGACY_VERSION = 'p14-policy-router-v1' as const;
export const POLICY_ROUTER_VERSION = 'p14-policy-router-v2' as const;
export const ADMISSION_FACTS_LEGACY_DIGEST_VERSION = 'p14-admission-facts-v1' as const;
export const ADMISSION_FACTS_DIGEST_VERSION = 'p14-admission-facts-v2' as const;
export const POLICY_ROUTER_THRESHOLD = 4 as const;

export const POLICY_REASON_CODES = Object.freeze([
  'explicit-verification',
  'variable-write-intent',
  'entity-ambiguous',
  'worldbook-conflict',
  'old-story-no-high-recall',
  'dormant-arc-reference',
  'sufficient-platform-evidence',
  'duplicate-evidence',
  'provider-ineligible',
  'prompt-budget-conflict',
  'final-reserve-insufficient',
  'no-hard-signal',
  'score-below-threshold',
  'entity-evidence-unavailable',
  'worldbook-evidence-unavailable',
  'arc-evidence-unavailable',
  'semantic-route-eligible',
] as const);

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];
export type PolicyHardSignal =
  | 'explicit-verification'
  | 'variable-write-intent'
  | 'entity-ambiguous'
  | 'worldbook-conflict';
export type PolicyVerdict = 'would-admit' | 'would-deny';
export type PlatformEvidence = 'insufficient' | 'sufficient';
export type EvidenceNovelty = 'novel' | 'duplicate';
export type FactAvailability = 'known' | 'unknown';
export type PolicyRouterVersion = typeof POLICY_ROUTER_LEGACY_VERSION | typeof POLICY_ROUTER_VERSION;
export type SemanticRouteVerdict = 'not-needed' | 'eligible' | 'ineligible';

/**
 * Privacy-safe facts available after the deterministic platform DAG has run.
 * Text, prompts, tool output, model output and hidden reasoning are deliberately absent.
 */
export interface AdmissionFacts {
  readonly routingDigest: string;
  readonly hasStableRevision: boolean;
  readonly providerSupportsToolProtocol: boolean;
  readonly providerReportsUsage: boolean;
  readonly hasExplicitVerificationIntent: boolean;
  readonly hasVariableWriteIntent: boolean;
  readonly entityEvidence: FactAvailability;
  readonly ambiguousEntityCount: number;
  readonly worldbookEvidence: FactAvailability;
  readonly worldbookConflictCount: number;
  readonly referencedOldStory: boolean;
  readonly highConfidenceRecallCount: number;
  readonly arcEvidence: FactAvailability;
  readonly dormantArcReferenceCount: number;
  readonly platformEvidence: PlatformEvidence;
  readonly evidenceNovelty: EvidenceNovelty;
  /** Maximum prompt/input tokens after the final-output reserve has been removed. */
  readonly promptBudgetTokens: number;
  readonly estimatedPromptTokens: number;
  readonly finalReserveTokens: number;
  readonly minimumFinalReserveTokens: number;
}

export interface PolicyRouterDecision {
  readonly policyVersion: PolicyRouterVersion;
  readonly verdict: PolicyVerdict;
  readonly score: number;
  readonly hardSignals: readonly PolicyHardSignal[];
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly factsDigest: string;
  readonly semanticRoute: SemanticRouteVerdict;
}

/** Narrow audit envelope used by the host callback; it contains no prompt or model-authored text. */
export interface PolicyRouterAudit {
  readonly runId: string;
  readonly sessionId: string;
  readonly round: number;
  readonly sourceRevision: string;
  readonly facts: AdmissionFacts;
  readonly decision: PolicyRouterDecision;
  readonly createdAt: string;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ADMISSION_FACT_KEYS = new Set<keyof AdmissionFacts>([
  'routingDigest',
  'hasStableRevision',
  'providerSupportsToolProtocol',
  'providerReportsUsage',
  'hasExplicitVerificationIntent',
  'hasVariableWriteIntent',
  'entityEvidence',
  'ambiguousEntityCount',
  'worldbookEvidence',
  'worldbookConflictCount',
  'referencedOldStory',
  'highConfidenceRecallCount',
  'arcEvidence',
  'dormantArcReferenceCount',
  'platformEvidence',
  'evidenceNovelty',
  'promptBudgetTokens',
  'estimatedPromptTokens',
  'finalReserveTokens',
  'minimumFinalReserveTokens',
]);
const HARD_SIGNAL_SET = new Set<PolicyReasonCode>([
  'explicit-verification',
  'variable-write-intent',
  'entity-ambiguous',
  'worldbook-conflict',
]);

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function normalizeAdmissionFacts(input: AdmissionFacts): AdmissionFacts {
  assertPlainRecord(input, 'admissionFacts');
  for (const key of Object.keys(input)) {
    if (!ADMISSION_FACT_KEYS.has(key as keyof AdmissionFacts)) {
      throw new TypeError(`admissionFacts contains unsupported field: ${key}`);
    }
  }
  if (typeof input.routingDigest !== 'string' || !SHA256_DIGEST.test(input.routingDigest)) {
    throw new TypeError('routingDigest must be a lowercase sha256 digest');
  }
  return Object.freeze({
    routingDigest: input.routingDigest,
    hasStableRevision: boolean(input.hasStableRevision, 'hasStableRevision'),
    providerSupportsToolProtocol: boolean(
      input.providerSupportsToolProtocol,
      'providerSupportsToolProtocol',
    ),
    providerReportsUsage: boolean(input.providerReportsUsage, 'providerReportsUsage'),
    hasExplicitVerificationIntent: boolean(
      input.hasExplicitVerificationIntent,
      'hasExplicitVerificationIntent',
    ),
    hasVariableWriteIntent: boolean(input.hasVariableWriteIntent, 'hasVariableWriteIntent'),
    entityEvidence: enumValue(input.entityEvidence, ['known', 'unknown'] as const, 'entityEvidence'),
    ambiguousEntityCount: count(input.ambiguousEntityCount, 'ambiguousEntityCount'),
    worldbookEvidence: enumValue(input.worldbookEvidence, ['known', 'unknown'] as const, 'worldbookEvidence'),
    worldbookConflictCount: count(input.worldbookConflictCount, 'worldbookConflictCount'),
    referencedOldStory: boolean(input.referencedOldStory, 'referencedOldStory'),
    highConfidenceRecallCount: count(input.highConfidenceRecallCount, 'highConfidenceRecallCount'),
    arcEvidence: enumValue(input.arcEvidence, ['known', 'unknown'] as const, 'arcEvidence'),
    dormantArcReferenceCount: count(input.dormantArcReferenceCount, 'dormantArcReferenceCount'),
    platformEvidence: enumValue(
      input.platformEvidence,
      ['insufficient', 'sufficient'] as const,
      'platformEvidence',
    ),
    evidenceNovelty: enumValue(
      input.evidenceNovelty,
      ['novel', 'duplicate'] as const,
      'evidenceNovelty',
    ),
    promptBudgetTokens: count(input.promptBudgetTokens, 'promptBudgetTokens'),
    estimatedPromptTokens: count(input.estimatedPromptTokens, 'estimatedPromptTokens'),
    finalReserveTokens: count(input.finalReserveTokens, 'finalReserveTokens'),
    minimumFinalReserveTokens: count(input.minimumFinalReserveTokens, 'minimumFinalReserveTokens'),
  });
}

export function serializeAdmissionFacts(
  input: AdmissionFacts,
  version: PolicyRouterVersion = POLICY_ROUTER_VERSION,
): string {
  const facts = normalizeAdmissionFacts(input);
  const shared = {
    digestVersion: version === POLICY_ROUTER_LEGACY_VERSION
      ? ADMISSION_FACTS_LEGACY_DIGEST_VERSION
      : ADMISSION_FACTS_DIGEST_VERSION,
    routingDigest: facts.routingDigest,
    hasStableRevision: facts.hasStableRevision,
    providerSupportsToolProtocol: facts.providerSupportsToolProtocol,
    providerReportsUsage: facts.providerReportsUsage,
    hasExplicitVerificationIntent: facts.hasExplicitVerificationIntent,
    hasVariableWriteIntent: facts.hasVariableWriteIntent,
    ...(version === POLICY_ROUTER_LEGACY_VERSION ? {} : {
      entityEvidence: facts.entityEvidence,
      worldbookEvidence: facts.worldbookEvidence,
      arcEvidence: facts.arcEvidence,
    }),
    ambiguousEntityCount: facts.ambiguousEntityCount,
    worldbookConflictCount: facts.worldbookConflictCount,
    referencedOldStory: facts.referencedOldStory,
    highConfidenceRecallCount: facts.highConfidenceRecallCount,
    dormantArcReferenceCount: facts.dormantArcReferenceCount,
    platformEvidence: facts.platformEvidence,
    evidenceNovelty: facts.evidenceNovelty,
    promptBudgetTokens: facts.promptBudgetTokens,
    estimatedPromptTokens: facts.estimatedPromptTokens,
    finalReserveTokens: facts.finalReserveTokens,
    minimumFinalReserveTokens: facts.minimumFinalReserveTokens,
  };
  return JSON.stringify(shared);
}

export function computeAdmissionFactsDigest(
  input: AdmissionFacts,
  version: PolicyRouterVersion = POLICY_ROUTER_VERSION,
): string {
  return `sha256:${createHash('sha256').update(serializeAdmissionFacts(input, version), 'utf8').digest('hex')}`;
}

/** Pure shadow decision. It never executes a tool, calls a Provider, reads state, or changes a turn. */
export function evaluatePolicyRouter(
  input: AdmissionFacts,
  version: PolicyRouterVersion = POLICY_ROUTER_VERSION,
): PolicyRouterDecision {
  const facts = normalizeAdmissionFacts(input);
  const matched = new Set<PolicyReasonCode>();
  let score = 0;

  if (facts.hasExplicitVerificationIntent) {
    matched.add('explicit-verification');
    score += 4;
  }
  if (facts.hasVariableWriteIntent) {
    matched.add('variable-write-intent');
    score += 4;
  }
  if ((version === POLICY_ROUTER_LEGACY_VERSION || facts.entityEvidence === 'known')
    && facts.ambiguousEntityCount > 0) {
    matched.add('entity-ambiguous');
    score += 3;
  }
  if ((version === POLICY_ROUTER_LEGACY_VERSION || facts.worldbookEvidence === 'known')
    && facts.worldbookConflictCount > 0) {
    matched.add('worldbook-conflict');
    score += 3;
  }
  if (facts.referencedOldStory && facts.highConfidenceRecallCount === 0) {
    matched.add('old-story-no-high-recall');
    score += 2;
  }
  if ((version === POLICY_ROUTER_LEGACY_VERSION || facts.arcEvidence === 'known')
    && facts.dormantArcReferenceCount > 0) {
    matched.add('dormant-arc-reference');
    score += 1;
  }
  if (facts.platformEvidence === 'sufficient') {
    matched.add('sufficient-platform-evidence');
    score -= 3;
  }
  if (facts.evidenceNovelty === 'duplicate') {
    matched.add('duplicate-evidence');
    score -= 3;
  }
  if (version !== POLICY_ROUTER_LEGACY_VERSION) {
    if (facts.entityEvidence === 'unknown') matched.add('entity-evidence-unavailable');
    if (facts.worldbookEvidence === 'unknown') matched.add('worldbook-evidence-unavailable');
    if (facts.arcEvidence === 'unknown') matched.add('arc-evidence-unavailable');
  }

  const providerEligible = facts.providerSupportsToolProtocol && facts.providerReportsUsage;
  if (!providerEligible) matched.add('provider-ineligible');
  const promptBudgetFits = facts.estimatedPromptTokens <= facts.promptBudgetTokens;
  if (!promptBudgetFits) matched.add('prompt-budget-conflict');
  const finalReserveFits = facts.finalReserveTokens >= facts.minimumFinalReserveTokens;
  if (!finalReserveFits) matched.add('final-reserve-insufficient');

  const hardSignals = POLICY_REASON_CODES
    .filter((code): code is PolicyHardSignal => matched.has(code) && HARD_SIGNAL_SET.has(code));
  if (hardSignals.length === 0) matched.add('no-hard-signal');
  if (score < POLICY_ROUTER_THRESHOLD) matched.add('score-below-threshold');

  const softSignalCount = Number(matched.has('old-story-no-high-recall'))
    + Number(matched.has('dormant-arc-reference'));
  const qualitySignal = hardSignals.length > 0 || softSignalCount >= 2;
  const semanticRoute: SemanticRouteVerdict = version !== POLICY_ROUTER_LEGACY_VERSION
    && hardSignals.length === 0 && softSignalCount === 1 && providerEligible
    && facts.hasStableRevision && promptBudgetFits && finalReserveFits
    && facts.platformEvidence === 'insufficient' && facts.evidenceNovelty === 'novel'
    ? 'eligible'
    : hardSignals.length > 0 || softSignalCount >= 2 ? 'not-needed' : 'ineligible';
  if (semanticRoute === 'eligible') matched.add('semantic-route-eligible');
  const eligible = providerEligible
    && facts.hasStableRevision
    && promptBudgetFits
    && finalReserveFits
    && (version === POLICY_ROUTER_LEGACY_VERSION
      ? hardSignals.length > 0 && score >= POLICY_ROUTER_THRESHOLD
      : qualitySignal && score > 0
        && facts.platformEvidence === 'insufficient' && facts.evidenceNovelty === 'novel');
  const reasonCodes = POLICY_REASON_CODES.filter((code) => matched.has(code));

  return Object.freeze({
    policyVersion: version,
    verdict: eligible ? 'would-admit' : 'would-deny',
    score,
    hardSignals: Object.freeze(hardSignals),
    reasonCodes: Object.freeze(reasonCodes),
    factsDigest: computeAdmissionFactsDigest(facts, version),
    semanticRoute,
  });
}
