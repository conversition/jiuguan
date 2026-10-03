import { createHash } from 'node:crypto';

export const PRECOMMIT_CRITIC_VERSION = 'p14-precommit-critic-v1' as const;
export const PRECOMMIT_ISSUE_CODES = Object.freeze([
  'fact-reference-gap',
  'player-sovereignty-violation',
  'duplicate-output',
  'npc-knowledge-conflict',
  'contract-invalid',
] as const);

export type PrecommitIssueCode = (typeof PRECOMMIT_ISSUE_CODES)[number];
export type PrecommitSeverity = 'pass' | 'warn' | 'repairable' | 'hard-deny';

/**
 * H0-R6 execution boundary. The deterministic gate protects persistence on every
 * turn path; the optional model Critic is only a quality-beta Interactive repair.
 */
export const PRECOMMIT_CRITIC_BOUNDARY = Object.freeze({
  deterministicGateScope: 'all-turn-paths',
  modelCriticScope: 'interactive-quality-beta-only',
  ordinaryTurnModelCalls: 0,
  modelCriticMaxCalls: 1,
  hardDenyFallback: 'reject-candidate',
  repairFailureFallback: 'use-original-draft-after-hard-gate',
} as const);

export function permitsModelCritic(input: {
  readonly interactiveActive: boolean;
  readonly autonomyProfile: 'legacy' | 'balanced' | 'quality-beta' | null;
  readonly repairDraftAvailable: boolean;
}): boolean {
  return input.interactiveActive
    && input.autonomyProfile === 'quality-beta'
    && input.repairDraftAvailable;
}

export interface PrecommitTurnLike {
  readonly plan: {
    readonly key_events?: readonly {
      readonly reference_source?: readonly string[];
      readonly character_focus?: readonly {
        readonly knows?: readonly string[];
        readonly unknowns?: readonly string[];
      }[];
    }[];
  };
  readonly memory_delta: {
    readonly state_changes?: readonly {
      readonly entity_type?: string;
      readonly field?: string;
      readonly action?: string;
    }[];
  };
  readonly prose: string;
}

export interface PrecommitCriticDecision {
  readonly policyVersion: typeof PRECOMMIT_CRITIC_VERSION;
  readonly severity: PrecommitSeverity;
  readonly issueCodes: readonly PrecommitIssueCode[];
  readonly hardDenyCodes: readonly PrecommitIssueCode[];
  readonly repairableCodes: readonly PrecommitIssueCode[];
  readonly factsDigest: string;
}

const SOVEREIGNTY_FIELD = /(?:^|[._:/-])(?:intent|decision|choice|action|goal|意图|决定|选择|行动|目标)(?:$|[._:/-])/iu;

/** Deterministic post-draft gate. It returns codes/count-derived digest, never hidden reasoning. */
export function evaluatePrecommitCritic(input: {
  readonly turn: PrecommitTurnLike;
  readonly duplicateOutput: boolean;
  readonly contractIssueCount: number;
}): PrecommitCriticDecision {
  if (!input.turn || typeof input.turn !== 'object' || typeof input.turn.prose !== 'string') {
    throw new TypeError('precommit turn is invalid');
  }
  if (typeof input.duplicateOutput !== 'boolean'
    || !Number.isSafeInteger(input.contractIssueCount) || input.contractIssueCount < 0) {
    throw new TypeError('precommit flags are invalid');
  }
  const issues = new Set<PrecommitIssueCode>();
  const events = input.turn.plan.key_events ?? [];
  if (events.some((event) => (event.reference_source ?? []).length === 0
    && (event.character_focus ?? []).some((focus) => (focus.knows ?? []).length > 0))) {
    issues.add('fact-reference-gap');
  }
  if ((input.turn.memory_delta.state_changes ?? []).some((change) => (
    change.entity_type === 'protagonist'
      && (change.action === 'delete' || SOVEREIGNTY_FIELD.test(change.field ?? ''))
  ))) issues.add('player-sovereignty-violation');
  if (input.duplicateOutput) issues.add('duplicate-output');
  if (events.some((event) => (event.character_focus ?? []).some((focus) => {
    const known = new Set((focus.knows ?? []).map((value) => value.normalize('NFKC').trim()).filter(Boolean));
    return (focus.unknowns ?? []).some((value) => known.has(value.normalize('NFKC').trim()));
  }))) issues.add('npc-knowledge-conflict');
  if (input.contractIssueCount > 0) issues.add('contract-invalid');
  const issueCodes = Object.freeze(PRECOMMIT_ISSUE_CODES.filter((code) => issues.has(code)));
  const hardDenyCodes = Object.freeze(issueCodes.filter((code) => (
    code === 'player-sovereignty-violation'
      || code === 'npc-knowledge-conflict'
      || code === 'contract-invalid'
  )));
  const repairableCodes = Object.freeze(issueCodes.filter((code) => (
    code === 'fact-reference-gap' || code === 'duplicate-output'
  )));
  const severity: PrecommitSeverity = hardDenyCodes.length > 0
    ? 'hard-deny'
    : repairableCodes.length > 0 ? 'repairable' : 'pass';
  const factsDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    version: PRECOMMIT_CRITIC_VERSION,
    issueCodes,
    hardDenyCodes,
    repairableCodes,
  }), 'utf8').digest('hex')}`;
  return Object.freeze({
    policyVersion: PRECOMMIT_CRITIC_VERSION,
    severity,
    issueCodes,
    hardDenyCodes,
    repairableCodes,
    factsDigest,
  });
}
