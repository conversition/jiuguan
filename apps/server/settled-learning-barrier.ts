import type {
  LearningDrainResult,
  LearningOutboxSource,
} from './learning-outbox-drainer.ts';

export const MAX_SETTLED_LEARNING_PAGE_SIZE = 1_000 as const;
export const MAX_SETTLED_LEARNING_PAGES = 64 as const;

export type SettledLearningBarrierReason =
  | 'learning-drainer-unavailable'
  | 'learning-barrier-options-invalid'
  | 'learning-drain-failed'
  | 'learning-drain-result-invalid'
  | 'learning-drain-page-limit'
  | 'learning-hydrate-failed';

export interface SettledLearningDrainer {
  drainAvailable(source: LearningOutboxSource, limit?: number): LearningDrainResult;
}

export interface SettledLearningBarrierResult {
  readonly status: 'completed' | 'unavailable' | 'failed';
  readonly ok: boolean;
  readonly reason: SettledLearningBarrierReason | null;
  readonly pages: number;
  readonly scanned: number;
  readonly delivered: number;
  readonly targetReplays: number;
  readonly staleDiscarded: number;
  readonly deletedSessionDiscarded: number;
  readonly fencesSynced: number;
  readonly hydrated: boolean;
}

export interface SettledLearningBarrierInput {
  readonly drainer?: SettledLearningDrainer | null;
  readonly source: LearningOutboxSource;
  readonly hydrate: () => void | Promise<void>;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

interface Totals {
  pages: number;
  scanned: number;
  delivered: number;
  targetReplays: number;
  staleDiscarded: number;
  deletedSessionDiscarded: number;
  fencesSynced: number;
}

const emptyTotals = (): Totals => ({
  pages: 0,
  scanned: 0,
  delivered: 0,
  targetReplays: 0,
  staleDiscarded: 0,
  deletedSessionDiscarded: 0,
  fencesSynced: 0,
});

function result(
  status: SettledLearningBarrierResult['status'],
  reason: SettledLearningBarrierReason | null,
  totals: Totals,
  hydrated = false,
): SettledLearningBarrierResult {
  return Object.freeze({
    status,
    ok: status === 'completed',
    reason,
    ...totals,
    hydrated,
  });
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDrainResult(value: LearningDrainResult, pageSize: number): boolean {
  return value !== null
    && typeof value === 'object'
    && validCount(value.scanned)
    && value.scanned <= pageSize
    && validCount(value.delivered)
    && validCount(value.targetReplays)
    && validCount(value.staleDiscarded)
    && validCount(value.deletedSessionDiscarded)
    && validCount(value.fencesSynced);
}

function add(totals: Totals, page: LearningDrainResult): void {
  totals.pages += 1;
  totals.scanned += page.scanned;
  totals.delivered += page.delivered;
  totals.targetReplays += page.targetReplays;
  totals.staleDiscarded += page.staleDiscarded;
  totals.deletedSessionDiscarded += page.deletedSessionDiscarded;
  totals.fencesSynced += page.fencesSynced;
}

/**
 * Makes an accepted turn's local learning outbox visible to central reducers before
 * post-turn agents read those projections. The source drainer is synchronous today,
 * while the async boundary lets the settled-turn coordinator await hydration without
 * exposing implementation details.
 *
 * This barrier never throws. Any unavailable dependency, invalid bound, drain failure,
 * incomplete bounded scan, or hydration failure returns a stable fail-closed reason.
 */
export async function runSettledLearningBarrier(
  input: SettledLearningBarrierInput,
): Promise<SettledLearningBarrierResult> {
  const totals = emptyTotals();
  if (!input.drainer) {
    return result('unavailable', 'learning-drainer-unavailable', totals);
  }

  const pageSize = input.pageSize ?? 256;
  const maxPages = input.maxPages ?? 8;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_SETTLED_LEARNING_PAGE_SIZE
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_SETTLED_LEARNING_PAGES) {
    return result('failed', 'learning-barrier-options-invalid', totals);
  }

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    let page: LearningDrainResult;
    try {
      page = input.drainer.drainAvailable(input.source, pageSize);
    } catch {
      return result('failed', 'learning-drain-failed', totals);
    }
    if (!validDrainResult(page, pageSize)) {
      return result('failed', 'learning-drain-result-invalid', totals);
    }
    add(totals, page);
    if (page.scanned >= pageSize) continue;

    try {
      await input.hydrate();
    } catch {
      return result('failed', 'learning-hydrate-failed', totals);
    }
    return result('completed', null, totals, true);
  }

  return result('failed', 'learning-drain-page-limit', totals);
}
