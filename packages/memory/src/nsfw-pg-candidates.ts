import { PG_VECTOR_DIMS, type PgLoreRefQueryResult } from './pg-vector.ts';

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const MAX_QUERY_CHARS = 4_000;
const DEFAULT_TOP_K = 24;
const MAX_TOP_K = 64;

export interface NsfwPgCandidateRef {
  readonly loreId: number;
  readonly score: number;
  readonly source: 'pgvector';
}

export type NsfwPgCandidateResult = Readonly<
  | { status: 'ok'; candidates: readonly NsfwPgCandidateRef[] }
  | {
    status: 'unavailable';
    candidates: readonly NsfwPgCandidateRef[];
    reason: 'invalid-request' | 'embedding-unavailable' | 'pg-unavailable';
  }
>;

export interface NsfwPgCandidateInput {
  /** Session database basename. Never use a global/default namespace. */
  readonly namespace: string;
  /** Bounded scene/user intent used only to create the ANN query vector. */
  readonly query: string;
  readonly topK?: number;
  readonly threshold?: number;
}

export interface NsfwPgCandidatePorts {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly store: {
    readonly isReady: boolean;
    queryLoreRefs(
      namespace: string,
      vector: readonly number[],
      k: number,
      threshold: number,
    ): Promise<PgLoreRefQueryResult>;
  };
}

const unavailable = (
  reason: Extract<NsfwPgCandidateResult, { status: 'unavailable' }>['reason'],
): NsfwPgCandidateResult => Object.freeze({
  status: 'unavailable',
  candidates: Object.freeze([]),
  reason,
});

/**
 * Bounded PostgreSQL/pgvector candidate discovery for NSFW scene curation.
 *
 * This adapter intentionally returns identities and scores only. It does not
 * read or concatenate source prose and it does not decide whether a worldbook
 * is allowed. The session layer must hydrate each loreId from its own SQLite
 * `lorebook_entry`, then enforce active/book/safety policy before passing a
 * candidate to the curator.
 */
export async function retrieveNsfwPgCandidates(
  input: NsfwPgCandidateInput,
  ports: NsfwPgCandidatePorts,
): Promise<NsfwPgCandidateResult> {
  const namespace = input.namespace.trim();
  const query = input.query.trim();
  if (!NAMESPACE.test(namespace) || query.length < 1 || query.length > MAX_QUERY_CHARS) {
    return unavailable('invalid-request');
  }
  if (!ports.store.isReady) return unavailable('pg-unavailable');

  const topK = Number.isFinite(input.topK)
    ? Math.max(1, Math.min(MAX_TOP_K, Math.trunc(input.topK as number)))
    : DEFAULT_TOP_K;
  const threshold = Number.isFinite(input.threshold)
    ? Math.max(-1, Math.min(1, input.threshold as number))
    : 0.35;

  let vector: readonly number[];
  try {
    vector = await ports.embed(query);
  } catch {
    return unavailable('embedding-unavailable');
  }
  if (vector.length !== PG_VECTOR_DIMS || vector.some((value) => !Number.isFinite(value))) {
    return unavailable('embedding-unavailable');
  }

  try {
    const result = await ports.store.queryLoreRefs(namespace, vector, topK, threshold);
    if (result.status !== 'ok') return unavailable('pg-unavailable');
    const bestByLore = new Map<number, number>();
    for (const hit of result.hits) {
      if (!Number.isSafeInteger(hit.loreId) || hit.loreId <= 0 || !Number.isFinite(hit.score)) continue;
      const prior = bestByLore.get(hit.loreId);
      if (prior === undefined || hit.score > prior) bestByLore.set(hit.loreId, hit.score);
    }
    const candidates = [...bestByLore]
      .map(([loreId, score]) => Object.freeze({ loreId, score, source: 'pgvector' as const }))
      .sort((a, b) => b.score - a.score || a.loreId - b.loreId)
      .slice(0, topK);
    return Object.freeze({ status: 'ok', candidates: Object.freeze(candidates) });
  } catch {
    return unavailable('pg-unavailable');
  }
}
