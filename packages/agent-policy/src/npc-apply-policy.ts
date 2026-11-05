import type {
  NpcMaintenanceEntry,
  NpcMaintenanceFactEntry,
  NpcMaintenanceProposal,
} from './npc-maintenance-proposal.js';

export const NPC_APPLY_POLICY_VERSION = 'p14-npc-apply-policy-v2' as const;

/**
 * Immutable host ceilings. Runtime configuration may reduce remainingAutoWrites,
 * but it cannot raise the per-proposal write or character limits.
 */
export const NPC_APPLY_POLICY_LIMITS = Object.freeze({
  maxAutoWritesPerProposal: 8,
  maxAutoCharactersPerProposal: 4,
  maxOccupiedFactTargets: 512,
} as const);

export type NpcApplyVerdict = 'auto' | 'review';
export type NpcApplyReasonCode =
  | 'pending-fact'
  | 'last-known-fact'
  | 'history-only-fact'
  | 'objective-double-source'
  | 'confidence-not-high'
  | 'relationship-requires-review'
  | 'existing-relationship-overwrite'
  | 'identity-resolution-requires-review'
  | 'identity-unresolved'
  | 'identity-conflict'
  | 'existing-fact-overwrite'
  | 'objective-source-quorum-missing'
  | 'confirmed-nonobjective-requires-review'
  | 'uncertain-status-requires-review'
  | 'auto-write-budget-exhausted'
  | 'auto-character-limit-exceeded';

/** A current CharacterStore projection target. Presence means a proposal would overwrite it. */
export interface NpcApplyOccupiedFactTarget {
  readonly characterId: string;
  readonly scope: 'profile' | 'fact';
  readonly field: string;
}
export interface NpcApplyPolicyContext {
  /** Remaining write allowance for this operation, capped by NPC_APPLY_POLICY_LIMITS. */
  readonly remainingAutoWrites: number;
  /** Current projection keys, not history rows. */
  readonly occupiedFactTargets: readonly NpcApplyOccupiedFactTarget[];
  /** Current relationship targets; required to authorize a new objective relationship automatically. */
  readonly occupiedRelationshipTargets?: readonly Readonly<{
    characterId: string;
    toCharacterId: string;
    relationType: string;
  }>[];
}

export interface NpcApplyEntryDecision {
  readonly entryIndex: number;
  readonly verdict: NpcApplyVerdict;
  readonly reasonCodes: readonly NpcApplyReasonCode[];
}

export interface NpcApplyPolicyDecision {
  readonly policyVersion: typeof NPC_APPLY_POLICY_VERSION;
  readonly proposalDigest: string;
  /** A proposal is auto-applicable as a whole only when every entry is auto. */
  readonly verdict: NpcApplyVerdict;
  readonly reasonCodes: readonly NpcApplyReasonCode[];
  readonly approvedAutoWrites: number;
  readonly remainingAutoWrites: number;
  readonly entryDecisions: readonly NpcApplyEntryDecision[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const FIELD = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.:\-\u4e00-\u9fff]{0,95}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

const REASON_ORDER: readonly NpcApplyReasonCode[] = Object.freeze([
  'pending-fact',
  'last-known-fact',
  'history-only-fact',
  'objective-double-source',
  'confidence-not-high',
  'relationship-requires-review',
  'existing-relationship-overwrite',
  'identity-resolution-requires-review',
  'identity-unresolved',
  'identity-conflict',
  'existing-fact-overwrite',
  'objective-source-quorum-missing',
  'confirmed-nonobjective-requires-review',
  'uncertain-status-requires-review',
  'auto-write-budget-exhausted',
  'auto-character-limit-exceeded',
]);
const REASON_RANK = new Map(REASON_ORDER.map((reason, index) => [reason, index]));

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function orderedReasons(reasons: Iterable<NpcApplyReasonCode>): readonly NpcApplyReasonCode[] {
  return Object.freeze([...new Set(reasons)].sort((left, right) => REASON_RANK.get(left)! - REASON_RANK.get(right)!));
}

function factTarget(entry: NpcMaintenanceFactEntry): NpcApplyOccupiedFactTarget {
  if (entry.kind === 'profile') return { characterId: entry.characterId, scope: 'profile', field: entry.field };
  const prefix = entry.kind === 'belief'
    ? 'belief.'
    : entry.kind === 'knowledge'
      ? 'knowledge.'
      : entry.kind === 'secret'
        ? 'secret.'
        : entry.kind === 'goal'
          ? 'goal.'
          : entry.kind === 'history_only'
            ? 'history.'
            : '';
  return { characterId: entry.characterId, scope: 'fact', field: `${prefix}${entry.field}` };
}

function targetKey(target: NpcApplyOccupiedFactTarget): string {
  return `${target.characterId}\0${target.scope}\0${target.field}`;
}

function normalizeContext(context: NpcApplyPolicyContext): {
  readonly remainingAutoWrites: number;
  readonly occupiedKeys: ReadonlySet<string>;
  readonly occupiedRelationshipKeys: ReadonlySet<string> | null;
} {
  plain(context, 'npcApplyPolicyContext');
  exact(context, [
    'remainingAutoWrites', 'occupiedFactTargets',
    ...(context.occupiedRelationshipTargets === undefined ? [] : ['occupiedRelationshipTargets']),
  ], 'npcApplyPolicyContext');
  if (!Number.isSafeInteger(context.remainingAutoWrites) || context.remainingAutoWrites < 0
    || context.remainingAutoWrites > NPC_APPLY_POLICY_LIMITS.maxAutoWritesPerProposal) {
    throw new TypeError('remainingAutoWrites exceeds the NPC auto-apply host ceiling');
  }
  if (!Array.isArray(context.occupiedFactTargets)
    || context.occupiedFactTargets.length > NPC_APPLY_POLICY_LIMITS.maxOccupiedFactTargets) {
    throw new TypeError('occupiedFactTargets exceeds the NPC apply policy limit');
  }
  const occupiedKeys = new Set<string>();
  context.occupiedFactTargets.forEach((raw, index) => {
    plain(raw, `occupiedFactTargets[${index}]`);
    exact(raw, ['characterId', 'scope', 'field'], `occupiedFactTargets[${index}]`);
    if (typeof raw.characterId !== 'string' || !TOKEN.test(raw.characterId)
      || (raw.scope !== 'profile' && raw.scope !== 'fact')
      || typeof raw.field !== 'string' || !FIELD.test(raw.field)) {
      throw new TypeError(`occupiedFactTargets[${index}] is invalid`);
    }
    const key = targetKey(raw as unknown as NpcApplyOccupiedFactTarget);
    if (occupiedKeys.has(key)) throw new TypeError('occupiedFactTargets contains duplicates');
    occupiedKeys.add(key);
  });
  let occupiedRelationshipKeys: ReadonlySet<string> | null = null;
  if (context.occupiedRelationshipTargets !== undefined) {
    if (!Array.isArray(context.occupiedRelationshipTargets)
      || context.occupiedRelationshipTargets.length > NPC_APPLY_POLICY_LIMITS.maxOccupiedFactTargets) {
      throw new TypeError('occupiedRelationshipTargets exceeds the NPC apply policy limit');
    }
    const keys = new Set<string>();
    context.occupiedRelationshipTargets.forEach((raw, index) => {
      plain(raw, `occupiedRelationshipTargets[${index}]`);
      exact(raw, ['characterId', 'toCharacterId', 'relationType'], `occupiedRelationshipTargets[${index}]`);
      if (typeof raw.characterId !== 'string' || !TOKEN.test(raw.characterId)
        || typeof raw.toCharacterId !== 'string' || !TOKEN.test(raw.toCharacterId)
        || typeof raw.relationType !== 'string' || !FIELD.test(raw.relationType)) {
        throw new TypeError(`occupiedRelationshipTargets[${index}] is invalid`);
      }
      const key = `${raw.characterId}\0${raw.toCharacterId}\0${raw.relationType}`;
      if (keys.has(key)) throw new TypeError('occupiedRelationshipTargets contains duplicates');
      keys.add(key);
    });
    occupiedRelationshipKeys = keys;
  }
  return Object.freeze({ remainingAutoWrites: context.remainingAutoWrites, occupiedKeys, occupiedRelationshipKeys });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function baseDecision(
  entry: NpcMaintenanceEntry,
  occupiedKeys: ReadonlySet<string>,
  occupiedRelationshipKeys: ReadonlySet<string> | null,
): { verdict: NpcApplyVerdict; reasons: NpcApplyReasonCode[]; characterId?: string } {
  if (entry.kind === 'unresolved') {
    return {
      verdict: 'review',
      reasons: [entry.reasonCode === 'conflicting-identity' ? 'identity-conflict' : 'identity-unresolved'],
    };
  }
  if (entry.kind === 'relationship') {
    const safeObjective = entry.perspective === 'objective' && entry.status === 'confirmed'
      && entry.confidence === 'high' && new Set(entry.sourceRefs).size >= 2;
    const occupied = occupiedRelationshipKeys?.has(
      `${entry.characterId}\0${entry.toCharacterId}\0${entry.relationType}`,
    ) === true;
    return {
      verdict: safeObjective && occupiedRelationshipKeys !== null && !occupied ? 'auto' : 'review',
      reasons: occupied ? ['existing-relationship-overwrite']
        : safeObjective && occupiedRelationshipKeys !== null ? [] : ['relationship-requires-review'],
      characterId: entry.characterId,
    };
  }
  if (entry.kind === 'identity_resolution') {
    return {
      verdict: 'review',
      reasons: ['identity-resolution-requires-review'],
      characterId: entry.characterId,
    };
  }

  const highConfidence = entry.confidence === 'high';
  const autoReason: NpcApplyReasonCode | null = highConfidence
    ? entry.kind === 'history_only'
      ? 'history-only-fact'
      : entry.status === 'pending'
        ? 'pending-fact'
        : entry.status === 'last-known'
          ? 'last-known-fact'
          : entry.kind === 'objective_fact' && entry.status === 'confirmed'
            && new Set(entry.sourceRefs).size >= 2
            ? 'objective-double-source'
            : null
    : null;
  const reasons: NpcApplyReasonCode[] = autoReason ? [autoReason] : [];
  if (!highConfidence) reasons.push('confidence-not-high');
  // history_only is converted to FactKind=recall by the committer and can only
  // append history; it never replaces a current projection target.
  const occupied = entry.kind !== 'history_only' && occupiedKeys.has(targetKey(factTarget(entry)));
  if (occupied) reasons.push('existing-fact-overwrite');

  if (autoReason && !occupied) return { verdict: 'auto', reasons, characterId: entry.characterId };
  if (entry.kind === 'objective_fact' && entry.sourceRefs.length < 2) {
    reasons.push('objective-source-quorum-missing');
  } else if (entry.status === 'confirmed') {
    reasons.push('confirmed-nonobjective-requires-review');
  } else if (entry.status === 'unknown' || entry.status === 'unresolved') {
    reasons.push('uncertain-status-requires-review');
  }
  return { verdict: 'review', reasons, characterId: entry.characterId };
}

/**
 * Classifies a normalized NPC maintenance proposal without performing writes.
 * Existing current targets, relationships and identity ambiguity always remain
 * review-only. Budget selection is canonical and therefore input-order neutral.
 */
export function evaluateNpcApplyPolicy(
  proposal: NpcMaintenanceProposal,
  context: NpcApplyPolicyContext,
): NpcApplyPolicyDecision {
  plain(proposal, 'npcMaintenanceProposal');
  if (!DIGEST.test(proposal.proposalDigest) || !Array.isArray(proposal.entries) || proposal.entries.length < 1) {
    throw new TypeError('npcMaintenanceProposal must be normalized before apply policy evaluation');
  }
  const normalizedContext = normalizeContext(context);
  const classified = proposal.entries.map((entry, entryIndex) => ({
    entry,
    entryIndex,
    stableKey: canonical(entry),
    ...baseDecision(entry, normalizedContext.occupiedKeys, normalizedContext.occupiedRelationshipKeys),
  }));

  const candidates = classified.filter((item) => item.verdict === 'auto')
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  const admittedCharacters = new Set<string>();
  let approvedAutoWrites = 0;
  for (const candidate of candidates) {
    const characterId = candidate.characterId!;
    if (!admittedCharacters.has(characterId)
      && admittedCharacters.size >= NPC_APPLY_POLICY_LIMITS.maxAutoCharactersPerProposal) {
      candidate.verdict = 'review';
      candidate.reasons.push('auto-character-limit-exceeded');
      continue;
    }
    if (approvedAutoWrites >= normalizedContext.remainingAutoWrites
      || approvedAutoWrites >= NPC_APPLY_POLICY_LIMITS.maxAutoWritesPerProposal) {
      candidate.verdict = 'review';
      candidate.reasons.push('auto-write-budget-exhausted');
      continue;
    }
    admittedCharacters.add(characterId);
    approvedAutoWrites += 1;
  }

  const entryDecisions = Object.freeze(classified.sort((left, right) => left.entryIndex - right.entryIndex)
    .map((item): NpcApplyEntryDecision => Object.freeze({
      entryIndex: item.entryIndex,
      verdict: item.verdict,
      reasonCodes: orderedReasons(item.reasons),
    })));
  const reasonCodes = orderedReasons(entryDecisions.flatMap((decision) => decision.reasonCodes));
  return Object.freeze({
    policyVersion: NPC_APPLY_POLICY_VERSION,
    proposalDigest: proposal.proposalDigest,
    verdict: entryDecisions.every((decision) => decision.verdict === 'auto') ? 'auto' : 'review',
    reasonCodes,
    approvedAutoWrites,
    remainingAutoWrites: normalizedContext.remainingAutoWrites - approvedAutoWrites,
    entryDecisions,
  });
}
