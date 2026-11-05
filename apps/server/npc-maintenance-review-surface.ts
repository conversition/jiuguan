import {
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
  sanitizePublicMaintenanceReviewText,
} from '../../packages/mobile-contracts/src/agent-control.ts';

export interface DynamicNpcReviewVisibilityInput {
  readonly mutationAllowed: boolean;
  readonly sessionLoaded: boolean;
  readonly taskKind: string;
  readonly status: string;
}

/**
 * Live NPC projections may be used to explain only an undecided proposal.
 * Once decided, the immutable apply/rollback audit is the historical record;
 * rebuilding review text from current truth would misrepresent the old choice.
 */
export function shouldExposeDynamicNpcReviewItems(
  input: DynamicNpcReviewVisibilityInput,
): boolean {
  return input.mutationAllowed
    && input.sessionLoaded
    && input.taskKind === 'npc_state'
    && input.status === 'pending';
}

export function boundedNpcReviewText(value: string, maxCodePoints: number): string {
  return sanitizePublicMaintenanceReviewText(value, maxCodePoints);
}

export interface NpcReviewTextCandidate {
  readonly write: boolean;
  readonly title: string;
  readonly detail: string;
}

/** A proposal is applicable only if every actual NPC write is visible without sanitizing/truncating. */
export function npcReviewProposalHasCompleteWriteReview(
  candidates: readonly NpcReviewTextCandidate[],
): boolean {
  return candidates.some((candidate) => candidate.write)
    && candidates.every((candidate) => !candidate.write || (
      boundedNpcReviewText(candidate.title, PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS)
        === candidate.title
      && boundedNpcReviewText(candidate.detail, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS)
        === candidate.detail
    ));
}
