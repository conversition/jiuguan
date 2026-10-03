import { DatabaseSync } from 'node:sqlite';
import { isSafeAssetFileName } from '../../packages/core/src/asset-paths.ts';
import {
  deriveLearningProfileIdentity,
  LearningOutboxStore,
  parsePreferenceClearTombstone,
  type LearningProfileIdentityValue,
  type PreferenceLearningEvidenceState,
} from '../../packages/memory/src/learning-outbox.ts';
import type { LearningHydrationSnapshot } from '../../packages/agent-policy/src/learning-hydration.ts';

interface SessionLearningMetadata {
  readonly card?: string;
  readonly cardFile?: string;
  readonly mode?: 'nsf' | 'nsfw';
}

function parseMetadata(value: unknown): SessionLearningMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.card !== undefined && typeof row.card !== 'string')
    || (row.cardFile !== undefined && typeof row.cardFile !== 'string')
    || (row.mode !== undefined && row.mode !== 'nsf' && row.mode !== 'nsfw')) return null;
  return {
    ...(typeof row.card === 'string' ? { card: row.card } : {}),
    ...(typeof row.cardFile === 'string' && isSafeAssetFileName(row.cardFile)
      ? { cardFile: row.cardFile } : {}),
    ...(row.mode === 'nsf' || row.mode === 'nsfw' ? { mode: row.mode } : {}),
  };
}

/**
 * Resolve the learning owner of an unloaded session without constructing ChatSession. This path
 * must remain a real read: no migrations, reconciliation, outbox acknowledgement or retrieval warmup.
 */
export function readSessionLearningIdentity(
  dbPath: string,
  rawSessionId: string,
): LearningProfileIdentityValue | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT config FROM memory_meta WHERE id=1').get() as { config?: unknown } | undefined;
    if (typeof row?.config !== 'string') return null;
    const metadata = parseMetadata(JSON.parse(row.config));
    if (!metadata) return null;
    if (!(metadata.card && metadata.card.trim().length > 0) && !metadata.cardFile) return null;
    return deriveLearningProfileIdentity({
      rawSessionId,
      cardName: metadata.card,
      cardFile: metadata.cardFile,
      contentMode: metadata.mode,
    });
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only probe already failed */ }
  }
}

/** Trusted-local CAS summary without opening/migrating ChatSession. */
export function readSessionPreferenceEvidenceState(
  dbPath: string,
  identity: LearningProfileIdentityValue,
): PreferenceLearningEvidenceState | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return new LearningOutboxStore(db).preferenceEvidenceState(identity);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only probe already failed */ }
  }
}

export interface SessionPreferenceFenceReader {
  preferenceEpoch(identity: LearningProfileIdentityValue): number;
}

/**
 * Pure read fence comparison. Pending fails closed: it suppresses a central profile until both
 * the exact epoch and the local delivery acknowledgement agree. It never drains or opens a
 * writable session.
 */
export function readSessionPreferenceSyncState(input: {
  readonly ledger: SessionPreferenceFenceReader | null;
  readonly dbPath: string;
  readonly identity: LearningProfileIdentityValue;
}): 'synced' | 'pending' {
  if (!input.ledger) return 'pending';
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(input.dbPath, { readOnly: true });
    const tombstone = new LearningOutboxStore(db).preferenceClearTombstones()
      .map(parsePreferenceClearTombstone)
      .find((item) => item !== null
        && item.identity.sessionId === input.identity.sessionId
        && item.identity.cardId === input.identity.cardId
        && item.identity.contentMode === input.identity.contentMode);
    const localEpoch = tombstone?.preferenceEpoch ?? 0;
    const centralEpoch = input.ledger.preferenceEpoch(input.identity);
    return localEpoch === centralEpoch && (!tombstone || tombstone.event.deliveredAt !== null)
      ? 'synced' : 'pending';
  } catch {
    return 'pending';
  } finally {
    try { db?.close(); } catch { /* read-only probe already failed */ }
  }
}

export interface SessionLearningHydrationReader {
  learningHydration(identity: LearningProfileIdentityValue): LearningHydrationSnapshot;
}

/** Route seam: unavailable ledger/metadata/projection is omitted rather than represented as empty. */
export function readSessionEffectiveLearning(input: {
  readonly ledger: SessionLearningHydrationReader | null;
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly loadedIdentity?: LearningProfileIdentityValue;
}): LearningHydrationSnapshot | undefined {
  if (!input.ledger) return undefined;
  try {
    const identity = input.loadedIdentity
      ?? readSessionLearningIdentity(input.dbPath, input.rawSessionId);
    return identity ? input.ledger.learningHydration(identity) : undefined;
  } catch {
    return undefined;
  }
}
