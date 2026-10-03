import { createHash } from 'node:crypto';

export const DIRECTOR_CRITIC_SHADOW_VERSION = 'p14-director-critic-shadow-v1' as const;
export const DIRECTOR_COMPLEXITY_THRESHOLD = 4 as const;

export const DIRECTOR_CRITIC_REASON_CODES = Object.freeze([
  'director-goal-conflict',
  'director-evidence-gap',
  'director-unresolved-dependency',
  'director-high-complexity',
  'critic-fact-reference-risk',
  'critic-player-sovereignty-risk',
  'critic-duplicate-output',
  'critic-npc-knowledge-risk',
  'critic-contract-retry',
  'unstable-revision',
  'no-director-signal',
  'no-critic-signal',
] as const);

export type DirectorCriticReasonCode = (typeof DIRECTOR_CRITIC_REASON_CODES)[number];
export type DirectorVerdict = 'would-direct' | 'skip-direct';
export type CriticVerdict = 'would-critic' | 'skip-critic';

/** 只允许摘要、布尔量和计数；不得放入 prompt、正文、工具结果或人物名。 */
export interface DirectorCriticFacts {
  readonly routingDigest: string;
  readonly hasStableRevision: boolean;
  readonly keyEventCount: number;
  readonly parallelEventCount: number;
  readonly activeArcCount: number;
  readonly unresolvedDependencyCount: number;
  readonly evidenceGapCount: number;
  readonly factReferenceRiskCount: number;
  readonly playerSovereigntyRiskCount: number;
  readonly duplicateOutput: boolean;
  readonly npcKnowledgeRiskCount: number;
  readonly contractIssueCount: number;
  readonly modelAttempts: number;
}

export interface DirectorCriticDecision {
  readonly policyVersion: typeof DIRECTOR_CRITIC_SHADOW_VERSION;
  readonly directorVerdict: DirectorVerdict;
  readonly criticVerdict: CriticVerdict;
  readonly directorScore: number;
  readonly criticScore: number;
  readonly reasonCodes: readonly DirectorCriticReasonCode[];
  readonly factsDigest: string;
}

export interface DirectorCriticAudit {
  readonly runId: string;
  readonly sessionId: string;
  readonly round: number;
  readonly sourceRevision: string;
  readonly facts: DirectorCriticFacts;
  readonly decision: DirectorCriticDecision;
  readonly createdAt: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const FACT_KEYS = new Set<keyof DirectorCriticFacts>([
  'routingDigest', 'hasStableRevision', 'keyEventCount', 'parallelEventCount', 'activeArcCount',
  'unresolvedDependencyCount', 'evidenceGapCount', 'factReferenceRiskCount',
  'playerSovereigntyRiskCount', 'duplicateOutput', 'npcKnowledgeRiskCount',
  'contractIssueCount', 'modelAttempts',
]);

function plain(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('directorCriticFacts must be a plain object');
  }
}

function count(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new TypeError(`${field} must be a safe integer >= ${minimum}`);
  return Number(value);
}

export function normalizeDirectorCriticFacts(input: DirectorCriticFacts): DirectorCriticFacts {
  plain(input);
  for (const key of Object.keys(input)) {
    if (!FACT_KEYS.has(key as keyof DirectorCriticFacts)) throw new TypeError(`unsupported directorCriticFacts field: ${key}`);
  }
  if (!DIGEST.test(input.routingDigest)) throw new TypeError('routingDigest must be a lowercase sha256 digest');
  if (typeof input.hasStableRevision !== 'boolean' || typeof input.duplicateOutput !== 'boolean') {
    throw new TypeError('directorCriticFacts booleans are invalid');
  }
  return Object.freeze({
    routingDigest: input.routingDigest,
    hasStableRevision: input.hasStableRevision,
    keyEventCount: count(input.keyEventCount, 'keyEventCount'),
    parallelEventCount: count(input.parallelEventCount, 'parallelEventCount'),
    activeArcCount: count(input.activeArcCount, 'activeArcCount'),
    unresolvedDependencyCount: count(input.unresolvedDependencyCount, 'unresolvedDependencyCount'),
    evidenceGapCount: count(input.evidenceGapCount, 'evidenceGapCount'),
    factReferenceRiskCount: count(input.factReferenceRiskCount, 'factReferenceRiskCount'),
    playerSovereigntyRiskCount: count(input.playerSovereigntyRiskCount, 'playerSovereigntyRiskCount'),
    duplicateOutput: input.duplicateOutput,
    npcKnowledgeRiskCount: count(input.npcKnowledgeRiskCount, 'npcKnowledgeRiskCount'),
    contractIssueCount: count(input.contractIssueCount, 'contractIssueCount'),
    modelAttempts: count(input.modelAttempts, 'modelAttempts', 1),
  });
}

export function serializeDirectorCriticFacts(input: DirectorCriticFacts): string {
  return JSON.stringify({ version: DIRECTOR_CRITIC_SHADOW_VERSION, ...normalizeDirectorCriticFacts(input) });
}

export function computeDirectorCriticFactsDigest(input: DirectorCriticFacts): string {
  return `sha256:${createHash('sha256').update(serializeDirectorCriticFacts(input), 'utf8').digest('hex')}`;
}

/** 纯 shadow 裁决：不读状态、不调用模型、不改写 plan/prose。 */
export function evaluateDirectorCriticShadow(input: DirectorCriticFacts): DirectorCriticDecision {
  const facts = normalizeDirectorCriticFacts(input);
  const matched = new Set<DirectorCriticReasonCode>();
  let directorScore = 0;
  let criticScore = 0;
  if (facts.activeArcCount > 1) { matched.add('director-goal-conflict'); directorScore += 3; }
  if (facts.evidenceGapCount > 0) { matched.add('director-evidence-gap'); directorScore += 3; }
  if (facts.unresolvedDependencyCount > 0) { matched.add('director-unresolved-dependency'); directorScore += 2; }
  const structuralComplexity = Math.max(0, facts.keyEventCount - 1)
    + facts.parallelEventCount * 2 + Math.max(0, facts.activeArcCount - 1) * 2;
  if (structuralComplexity >= DIRECTOR_COMPLEXITY_THRESHOLD) {
    matched.add('director-high-complexity');
    directorScore += structuralComplexity;
  }
  if (facts.factReferenceRiskCount > 0) { matched.add('critic-fact-reference-risk'); criticScore += 2; }
  if (facts.playerSovereigntyRiskCount > 0) { matched.add('critic-player-sovereignty-risk'); criticScore += 4; }
  if (facts.duplicateOutput) { matched.add('critic-duplicate-output'); criticScore += 3; }
  if (facts.npcKnowledgeRiskCount > 0) { matched.add('critic-npc-knowledge-risk'); criticScore += 4; }
  if (facts.contractIssueCount > 0 || facts.modelAttempts > 1) { matched.add('critic-contract-retry'); criticScore += 2; }
  const hasDirectorSignal = [...matched].some((code) => code.startsWith('director-'));
  const hasCriticSignal = [...matched].some((code) => code.startsWith('critic-'));
  if (!facts.hasStableRevision) matched.add('unstable-revision');
  if (!hasDirectorSignal) matched.add('no-director-signal');
  if (!hasCriticSignal) matched.add('no-critic-signal');
  return Object.freeze({
    policyVersion: DIRECTOR_CRITIC_SHADOW_VERSION,
    directorVerdict: facts.hasStableRevision && hasDirectorSignal ? 'would-direct' : 'skip-direct',
    criticVerdict: facts.hasStableRevision && hasCriticSignal ? 'would-critic' : 'skip-critic',
    directorScore,
    criticScore,
    reasonCodes: Object.freeze(DIRECTOR_CRITIC_REASON_CODES.filter((code) => matched.has(code))),
    factsDigest: computeDirectorCriticFactsDigest(facts),
  });
}
