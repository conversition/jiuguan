import {
  parsePreferenceClearTombstone,
  type LearningEventRecord,
} from '../../packages/memory/src/learning-outbox.ts';
import type { AgentLearningLedger } from './agent-learning-ledger.ts';

export interface LearningOutboxSource {
  /** Latest durable fence for every exact preference owner; never cursor/page limited. */
  preferenceClearTombstones(): LearningEventRecord[];
  pendingLearningEvents(limit?: number): LearningEventRecord[];
  learningEventsForRebuild?(input?: {
    limit?: number;
    after?: { createdAt: string; eventId: string };
  }): LearningEventRecord[];
  markLearningEventDelivered(eventId: string, payloadDigest: string, deliveredAt: string): { replayed: boolean };
}

export interface LearningDrainResult {
  readonly scanned: number;
  readonly delivered: number;
  readonly targetReplays: number;
  readonly staleDiscarded: number;
  /** Valid source events terminally acknowledged because their session has a durable deletion intent. */
  readonly deletedSessionDiscarded: number;
  readonly fencesSynced: number;
  readonly nextCursor: { createdAt: string; eventId: string } | null;
}

export interface LearningFenceSyncResult {
  readonly scanned: number;
  readonly synced: number;
  readonly delivered: number;
  readonly targetReplays: number;
  readonly deletedSessionDiscarded: number;
}

export class LearningOutboxDrainer {
  readonly #ledger: AgentLearningLedger;
  readonly #now: () => string;
  readonly #afterTargetAppend?: (event: LearningEventRecord) => void;

  constructor(options: {
    ledger: AgentLearningLedger;
    now?: () => string;
    /** crash-window fixture hook; production must omit. */
    afterTargetAppend?: (event: LearningEventRecord) => void;
  }) {
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#afterTargetAppend = options.afterTargetAppend;
  }

  drainAvailable(source: LearningOutboxSource, limit = 256): LearningDrainResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('learning-drain-limit-invalid');
    const fences = this.syncPreferenceFences(source);
    return this.#deliver(source, source.pendingLearningEvents(limit), fences);
  }

  /** 恢复/重建扫描包含已 delivered 的源事件；eventId 幂等使目标库可从 session outbox 重新构造。 */
  reconcileAvailable(
    source: LearningOutboxSource,
    input: { limit?: number; after?: { createdAt: string; eventId: string } } = {},
  ): LearningDrainResult {
    if (!source.learningEventsForRebuild) throw new Error('learning-rebuild-source-unsupported');
    const limit = input.limit ?? 256;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('learning-drain-limit-invalid');
    const fences = this.syncPreferenceFences(source);
    return this.#deliver(
      source,
      source.learningEventsForRebuild({ limit, ...(input.after ? { after: input.after } : {}) }),
      fences,
    );
  }

  /** Public seam used by clear POST: local fence commits before central cleanup and acknowledgement. */
  syncPreferenceFences(source: LearningOutboxSource): LearningFenceSyncResult {
    const fences = source.preferenceClearTombstones();
    let delivered = 0;
    let targetReplays = 0;
    let deletedSessionDiscarded = 0;
    for (const event of fences) {
      if (!parsePreferenceClearTombstone(event)) throw new Error('learning-preference-fence-invalid');
      const target = this.#ledger.append(event);
      if (target.discardedStale) throw new Error('learning-preference-fence-discarded');
      if (target.discardedDeletedSession) deletedSessionDiscarded += 1;
      if (target.replayed) targetReplays += 1;
      if (!target.discardedDeletedSession) this.#afterTargetAppend?.(event);
      if (event.deliveredAt === null) {
        source.markLearningEventDelivered(event.eventId, event.payloadDigest, this.#now());
      }
      delivered += 1;
    }
    return Object.freeze({
      scanned: fences.length,
      synced: fences.length - deletedSessionDiscarded,
      delivered,
      targetReplays,
      deletedSessionDiscarded,
    });
  }

  #deliver(
    source: LearningOutboxSource,
    events: LearningEventRecord[],
    fences: LearningFenceSyncResult,
  ): LearningDrainResult {
    let delivered = fences.delivered;
    let targetReplays = fences.targetReplays;
    let staleDiscarded = 0;
    let deletedSessionDiscarded = fences.deletedSessionDiscarded;
    for (const event of events) {
      const target = this.#ledger.append(event);
      if (target.replayed) targetReplays += 1;
      if (target.discardedStale) staleDiscarded += 1;
      if (target.discardedDeletedSession) deletedSessionDiscarded += 1;
      if (!target.discardedDeletedSession) this.#afterTargetAppend?.(event);
      if (event.deliveredAt === null) {
        source.markLearningEventDelivered(event.eventId, event.payloadDigest, this.#now());
      }
      delivered += 1;
    }
    const last = events.at(-1);
    return Object.freeze({
      scanned: events.length,
      delivered,
      targetReplays,
      staleDiscarded,
      deletedSessionDiscarded,
      fencesSynced: fences.synced,
      nextCursor: last ? Object.freeze({ createdAt: last.createdAt, eventId: last.eventId }) : null,
    });
  }
}
