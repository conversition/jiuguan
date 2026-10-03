import { createHash } from 'node:crypto';

export const DIRECTOR_PRELUDE_POLICY_VERSION = 'p14-director-prelude-v1' as const;
export const DIRECTOR_PRELUDE_REASON_CODES = Object.freeze([
  'multiple-active-arcs',
  'remote-evidence-gap',
  'unresolved-arc-dependency',
  'npc-goal-conflict',
  'important-turning-point',
  'no-director-signal',
] as const);

export type DirectorPreludeReasonCode = (typeof DIRECTOR_PRELUDE_REASON_CODES)[number];

export interface DirectorPreludeFacts {
  readonly routingDigest: string;
  readonly hasStableRevision: boolean;
  readonly activeArcCount: number;
  readonly unresolvedDependencyCount: number;
  readonly npcGoalConflictCount: number;
  readonly remoteEvidenceGapCount: number;
  readonly importantTurningPoint: boolean;
}

export interface DirectorPreludeDecision {
  readonly policyVersion: typeof DIRECTOR_PRELUDE_POLICY_VERSION;
  readonly verdict: 'would-direct' | 'skip-direct';
  readonly score: number;
  readonly reasonCodes: readonly DirectorPreludeReasonCode[];
  readonly factsDigest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function count(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

export function normalizeDirectorPreludeFacts(input: DirectorPreludeFacts): DirectorPreludeFacts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('directorPreludeFacts must be an object');
  if (!DIGEST.test(input.routingDigest)) throw new TypeError('routingDigest must be a lowercase sha256 digest');
  if (typeof input.hasStableRevision !== 'boolean' || typeof input.importantTurningPoint !== 'boolean') {
    throw new TypeError('directorPreludeFacts booleans are invalid');
  }
  return Object.freeze({
    routingDigest: input.routingDigest,
    hasStableRevision: input.hasStableRevision,
    activeArcCount: count(input.activeArcCount, 'activeArcCount'),
    unresolvedDependencyCount: count(input.unresolvedDependencyCount, 'unresolvedDependencyCount'),
    npcGoalConflictCount: count(input.npcGoalConflictCount, 'npcGoalConflictCount'),
    remoteEvidenceGapCount: count(input.remoteEvidenceGapCount, 'remoteEvidenceGapCount'),
    importantTurningPoint: input.importantTurningPoint,
  });
}

export function directorPreludeFactsDigest(input: DirectorPreludeFacts): string {
  const facts = normalizeDirectorPreludeFacts(input);
  return `sha256:${createHash('sha256').update(JSON.stringify({
    version: DIRECTOR_PRELUDE_POLICY_VERSION,
    ...facts,
  }), 'utf8').digest('hex')}`;
}

/** Pure pre-generation admission. It consumes counts/digests only and never reads candidate prose. */
export function evaluateDirectorPrelude(input: DirectorPreludeFacts): DirectorPreludeDecision {
  const facts = normalizeDirectorPreludeFacts(input);
  const matched = new Set<DirectorPreludeReasonCode>();
  let score = 0;
  if (facts.activeArcCount > 1) { matched.add('multiple-active-arcs'); score += 3; }
  if (facts.remoteEvidenceGapCount > 0) { matched.add('remote-evidence-gap'); score += 3; }
  if (facts.unresolvedDependencyCount > 0) { matched.add('unresolved-arc-dependency'); score += 2; }
  if (facts.npcGoalConflictCount > 0) { matched.add('npc-goal-conflict'); score += 3; }
  if (facts.importantTurningPoint) { matched.add('important-turning-point'); score += 2; }
  if (matched.size === 0) matched.add('no-director-signal');
  return Object.freeze({
    policyVersion: DIRECTOR_PRELUDE_POLICY_VERSION,
    verdict: facts.hasStableRevision && score >= 2 ? 'would-direct' : 'skip-direct',
    score,
    reasonCodes: Object.freeze(DIRECTOR_PRELUDE_REASON_CODES.filter((code) => matched.has(code))),
    factsDigest: directorPreludeFactsDigest(facts),
  });
}
