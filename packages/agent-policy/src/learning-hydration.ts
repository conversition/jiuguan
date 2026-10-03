import type { BranchPreferenceProfile, BranchPreferenceProfiles } from './branch-preference.ts';
import type { PromptPreferenceProfile, PromptPreferenceProfiles } from './prompt-preference.ts';
import type { StyleEvidenceProfile, StyleEvidenceProfiles } from './style-evidence.ts';

export const LEARNING_HYDRATION_VERSION = 'learning-hydration-v1' as const;

export interface LearningProfileIdentity {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
}

export interface ResolvedLearningProfile<T> {
  readonly scope: 'session' | 'card' | 'none';
  readonly profile: T | null;
}

export interface LearningHydrationSnapshot {
  readonly version: typeof LEARNING_HYDRATION_VERSION;
  readonly identity: LearningProfileIdentity;
  readonly prompt: ResolvedLearningProfile<PromptPreferenceProfile>;
  readonly branch: ResolvedLearningProfile<BranchPreferenceProfile>;
  /** All style identities in the selected scope. Full Learned Skills remain the prose authority. */
  readonly styles: {
    readonly scope: 'session' | 'card' | 'none';
    readonly profiles: readonly StyleEvidenceProfile[];
  };
}

function resolveOne<T extends {
  readonly scope: 'session' | 'card';
  readonly sessionId: string | null;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
}>(
  profiles: { readonly session: readonly T[]; readonly card: readonly T[] },
  identity: LearningProfileIdentity,
): ResolvedLearningProfile<T> {
  const session = profiles.session.find((profile) => profile.sessionId === identity.sessionId
    && profile.cardId === identity.cardId && profile.contentMode === identity.contentMode);
  if (session) return Object.freeze({ scope: 'session', profile: session });
  const card = profiles.card.find((profile) => profile.cardId === identity.cardId
    && profile.contentMode === identity.contentMode);
  return card
    ? Object.freeze({ scope: 'card', profile: card })
    : Object.freeze({ scope: 'none', profile: null });
}

/** Exact session wins, then exact card+contentMode. There is deliberately no global fallback. */
export function resolveLearningHydration(input: {
  readonly identity: LearningProfileIdentity;
  readonly prompt: PromptPreferenceProfiles;
  readonly branch: BranchPreferenceProfiles;
  readonly style: StyleEvidenceProfiles;
}): LearningHydrationSnapshot {
  const sessionStyles = input.style.session.filter((profile) => profile.sessionId === input.identity.sessionId
    && profile.cardId === input.identity.cardId && profile.contentMode === input.identity.contentMode);
  const cardStyles = input.style.card.filter((profile) => profile.cardId === input.identity.cardId
    && profile.contentMode === input.identity.contentMode);
  const styles = sessionStyles.length > 0
    ? { scope: 'session' as const, profiles: sessionStyles }
    : cardStyles.length > 0
      ? { scope: 'card' as const, profiles: cardStyles }
      : { scope: 'none' as const, profiles: [] };
  return Object.freeze({
    version: LEARNING_HYDRATION_VERSION,
    identity: Object.freeze({ ...input.identity }),
    prompt: resolveOne(input.prompt, input.identity),
    branch: resolveOne(input.branch, input.identity),
    styles: Object.freeze({ scope: styles.scope, profiles: Object.freeze([...styles.profiles]) }),
  });
}
