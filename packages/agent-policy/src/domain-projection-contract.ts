import type { ArcSessionProjection } from './arc-projection.ts';
import type { NpcSessionProjection } from './npc-evidence.ts';

export const DOMAIN_PROJECTION_CONTRACT_VERSION = 'domain-projection-contract-v1' as const;

export const DOMAIN_TRUTH_ROLES = Object.freeze({
  arc: Object.freeze({
    businessTruth: 'session-sqlite:memory_arc',
    learningProjection: 'agent-learning-ledger:arc-session-projection',
    maintenanceProjection: 'arc-projection.sqlite:disposable-approved-actions',
    directorReads: 'agent-learning-ledger:arc-session-projection+arc-projection.sqlite:approved-overlay',
    retrievalReads: 'session-sqlite:memory_arc',
    uiReads: 'session-sqlite:memory_arc+story_index',
  }),
  npc: Object.freeze({
    businessTruth: 'session-sqlite:character-store',
    learningProjection: 'agent-learning-ledger:npc-session-projection',
    maintenanceProposal: 'maintenance-job:strict-npc-proposal',
    directorReads: 'agent-learning-ledger:npc-session-projection',
    retrievalReads: 'session-sqlite:character-store',
    uiReads: 'session-sqlite:character-store',
  }),
});

export interface DomainProjectionIdentity {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
}

/** Exact identity only: no cross-session, cross-card or cross-mode fallback for structured facts. */
export function selectArcSessionProjection(
  projections: readonly ArcSessionProjection[],
  identity: DomainProjectionIdentity,
): ArcSessionProjection | undefined {
  return projections.find((entry) => entry.sessionId === identity.sessionId
    && entry.cardId === identity.cardId
    && entry.contentMode === identity.contentMode);
}

/** CharacterStore remains truth; this selects only its rebuildable, redacted learning statistics. */
export function selectNpcSessionProjection(
  projections: readonly NpcSessionProjection[],
  identity: DomainProjectionIdentity,
): NpcSessionProjection | undefined {
  return projections.find((entry) => entry.sessionId === identity.sessionId
    && entry.cardId === identity.cardId
    && entry.contentMode === identity.contentMode);
}
