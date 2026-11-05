/**
 * P7-08 会话一致快照。
 *
 * 只覆盖模型/后台维护任务会读取的业务真值；不纳入向量索引、访问计数、审计、遥测、
 * eventId 或 SQLite 页布局，避免维护性写入制造无意义冲突。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryDb } from './db.ts';

export const SESSION_DATABASE_SNAPSHOT_VERSION = 'jiuguan-session-db-snapshot-v2' as const;
export const SESSION_SNAPSHOT_VERSION = 'jiuguan-session-snapshot-v1' as const;

export interface SessionAssetRevision {
  kind: 'card' | 'worldbook' | 'preset';
  id: string;
  revision: string;
}

export interface SessionDatabaseSnapshot {
  databaseRevision: string;
  rowCounts: Readonly<Record<string, number>>;
}

export interface SessionSnapshot {
  snapshotToken: string;
  databaseRevision: string;
  rowCounts: Readonly<Record<string, number>>;
  assets: readonly SessionAssetRevision[];
}

interface SnapshotTable {
  name: string;
  sql: string;
}

/**
 * Columns whose committed values invalidate a frozen Session claim.
 *
 * The contract contains every business-snapshot input plus semantic lineage
 * read by Session-owned adapters. Fields deliberately omitted here (for
 * example access_count/last_access_ms and most created_at values) are
 * operational metadata and must not invalidate a semantic claim. INSERT and
 * DELETE still advance authority for every listed table.
 */
function freezeColumnContract(
  value: Record<string, readonly string[]>,
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([table, columns]) => [table, Object.freeze([...columns])]),
  ));
}

export const SESSION_CLAIM_AUTHORITY_COLUMNS: Readonly<Record<string, readonly string[]>> =
  freezeColumnContract({
    memory_meta: ['id', 'arc_id', 'stage', 'plot_round', 'bars', 'config', 'longterm', 'summary_round'],
    chat_log: ['id', 'round', 'role', 'content'],
    memory_arc: ['id', 'code', 'chapter', 'title', 'summary', 'status', 'seq'],
    memory_summary: ['id', 'code', 'round', 'delta', 'scene'],
    memory_event: ['id', 'code', 'description', 'characters', 'refs', 'resolved'],
    memory_parallel: ['id', 'kind', 'countdown_min', 'actor', 'location', 'action', 'next_stage'],
    memory_state: ['id', 'entity_type', 'entity_id', 'name', 'state_json', 'updated_round'],
    lorebook_entry: [
      'id', 'uid', 'book', 'key', 'comment', 'content', 'selective', 'depth', 'constant',
      'use_regex', 'triggers', 'probability', 'useProbability', 'active',
    ],
    state_snapshot: [
      'scope', 'scope_key', 'branch_key', 'state_json', 'state_version', 'instance_id',
      'initialized', 'updated_round', 'source', 'note', 'history_epoch',
    ],
    session_control: ['session_key', 'control_key', 'value'],
    character_registry: [
      'session_key', 'character_id', 'name', 'kind', 'create_operation_id',
    ],
    character_alias: ['id', 'session_key', 'alias', 'character_id', 'explicit'],
    character_alias_operation: [
      'id', 'session_key', 'character_id', 'operation_id', 'alias', 'alias_digest', 'mention_key',
      'expected_entity_version', 'rollback_entity_version', 'created_alias', 'source_refs',
      'provenance_digest', 'intent_fingerprint', 'rolled_back_at',
    ],
    character_fact_log: [
      'id', 'session_key', 'character_id', 'field', 'scope_kind', 'fact_kind', 'status',
      'value_json', 'scene_id', 'effective_round', 'effective_message_id', 'source_refs',
      'history_epoch', 'entity_version', 'operation_id', 'candidate_fingerprint',
    ],
    // Maintenance NPC source reads this bounded candidate pool even though the
    // historical database snapshot hash predates that input.
    character_mention_pool: [
      'id', 'session_key', 'mention_key', 'entity_type', 'display_name', 'name_candidates',
      'rounds_json', 'pending_json', 'first_round', 'last_round', 'first_message_id',
      'last_message_id', 'promoted_character_id', 'promoted_at',
    ],
    // Schema v17 owns Director continuity in the Session database. These are
    // required authority sources even though old read-only snapshots may not
    // have them yet.
    director_continuity_snapshot: [
      'session_id', 'projection_version', 'source_revision', 'source_round', 'parent_digest',
      'input_digest', 'projection_digest', 'projection_json', 'idempotency_key', 'created_at',
    ],
    director_continuity_invalidation: [
      'session_id', 'invalidation_version', 'invalid_from_round',
      'through_projection_version', 'reason', 'created_at',
    ],
  });

const SNAPSHOT_TABLES: readonly SnapshotTable[] = Object.freeze([
  { name: 'memory_meta', sql: 'SELECT id, arc_id, stage, plot_round, bars, config, longterm, summary_round FROM memory_meta ORDER BY id' },
  { name: 'chat_log', sql: 'SELECT id, round, role, content FROM chat_log ORDER BY id' },
  { name: 'memory_arc', sql: 'SELECT id, code, chapter, title, summary, status, seq FROM memory_arc ORDER BY id' },
  { name: 'memory_summary', sql: 'SELECT id, code, round, delta, scene FROM memory_summary ORDER BY id' },
  { name: 'memory_event', sql: 'SELECT id, code, description, characters, refs, resolved FROM memory_event ORDER BY id' },
  { name: 'memory_parallel', sql: 'SELECT id, kind, countdown_min, actor, location, action, next_stage FROM memory_parallel ORDER BY id' },
  { name: 'memory_state', sql: 'SELECT id, entity_type, entity_id, name, state_json, updated_round FROM memory_state ORDER BY id' },
  { name: 'lorebook_entry', sql: 'SELECT id, uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active FROM lorebook_entry ORDER BY id' },
  { name: 'state_snapshot', sql: 'SELECT scope, scope_key, branch_key, state_json, state_version, instance_id, initialized, updated_round, source, note, history_epoch FROM state_snapshot ORDER BY scope, scope_key, branch_key' },
  { name: 'session_control', sql: 'SELECT session_key, control_key, value FROM session_control ORDER BY session_key, control_key' },
  { name: 'character_registry', sql: 'SELECT session_key, character_id, name, kind FROM character_registry ORDER BY session_key, character_id' },
  { name: 'character_alias', sql: 'SELECT session_key, alias, character_id, explicit FROM character_alias ORDER BY session_key, alias, character_id' },
  { name: 'character_alias_operation', sql: 'SELECT session_key, character_id, operation_id, alias_digest, expected_entity_version, rollback_entity_version, created_alias, source_refs, provenance_digest, intent_fingerprint, rolled_back_at FROM character_alias_operation ORDER BY id' },
  { name: 'character_fact_log', sql: 'SELECT id, session_key, character_id, field, scope_kind, fact_kind, status, value_json, scene_id, effective_round, effective_message_id, source_refs, history_epoch, entity_version FROM character_fact_log ORDER BY id' },
]);

function hashRecord(hash: ReturnType<typeof createHash>, value: unknown): void {
  hash.update(JSON.stringify(value));
  hash.update('\n');
}

/**
 * Director continuity is append-only so regenerated/deleted branches remain as
 * local audit history.  A semantic session revision must bind only the newest
 * projection visible at the current committed plot round; hashing every audit
 * row would make a rolled-back branch change the business snapshot forever.
 *
 * The table is optional only for legacy pre-v17 databases and is therefore
 * discovered without forcing a write during this read-only snapshot operation.
 */
function directorContinuityHead(db: DatabaseSync): unknown | null {
  const exists = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='director_continuity_snapshot' LIMIT 1",
  ).get() as { ok: number } | undefined;
  if (!exists) return null;
  const invalidationsExist = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='director_continuity_invalidation' LIMIT 1",
  ).get() as { ok: number } | undefined;
  const validityClause = invalidationsExist ? `
       AND NOT EXISTS (
         SELECT 1 FROM director_continuity_invalidation invalidation
         WHERE invalidation.session_id=director_continuity_snapshot.session_id
           AND director_continuity_snapshot.source_round>=invalidation.invalid_from_round
           AND director_continuity_snapshot.projection_version<=invalidation.through_projection_version
       )` : '';
  return db.prepare(
    `SELECT session_id,projection_version,source_revision,source_round,projection_digest
     FROM director_continuity_snapshot
     WHERE source_round <= COALESCE((SELECT plot_round FROM memory_meta WHERE id=1),0)${validityClause}
     ORDER BY projection_version DESC LIMIT 1`,
  ).get() ?? null;
}

/** @internal Caller must already hold a transaction on `db`. */
export function computeSessionDatabaseSnapshotInTransaction(
  db: DatabaseSync,
): SessionDatabaseSnapshot {
  if (!db.isTransaction) throw new Error('session-snapshot-transaction-required');
  const hash = createHash('sha256');
  hash.update(`${SESSION_DATABASE_SNAPSHOT_VERSION}\n`);
  const rowCounts: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(table.sql).all() as unknown[];
    rowCounts[table.name] = rows.length;
    hash.update(`${table.name}\0${rows.length}\n`);
    for (const row of rows) hashRecord(hash, row);
  }
  const directorHead = directorContinuityHead(db);
  rowCounts.director_continuity_head = directorHead ? 1 : 0;
  hash.update(`director_continuity_head\0${directorHead ? 1 : 0}\n`);
  if (directorHead) hashRecord(hash, directorHead);
  return Object.freeze({
    databaseRevision: `sha256:${hash.digest('hex')}`,
    rowCounts: Object.freeze(rowCounts),
  });
}

/** 所有 SELECT 共享一致读快照；复用现有事务，且不争用独立 claim fence 的写锁。 */
export function computeSessionDatabaseSnapshot(memory: MemoryDb): SessionDatabaseSnapshot {
  const db = memory.db;
  if (db.isTransaction) return computeSessionDatabaseSnapshotInTransaction(db);
  db.exec('BEGIN DEFERRED');
  try {
    const snapshot = computeSessionDatabaseSnapshotInTransaction(db);
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* preserve snapshot error */ }
    throw error;
  }
}

/** 聚合 DB 快照与外部文件依赖；资产顺序不影响 token。 */
export function aggregateSessionSnapshot(
  database: SessionDatabaseSnapshot,
  assets: readonly SessionAssetRevision[],
): SessionSnapshot {
  if (!/^sha256:[a-f0-9]{64}$/.test(database.databaseRevision)) {
    throw new TypeError('databaseRevision 非法');
  }
  const normalized = [...assets]
    .map((asset) => ({ ...asset }))
    .sort((a, b) => `${a.kind}\0${a.id}`.localeCompare(`${b.kind}\0${b.id}`));
  const identities = new Set<string>();
  for (const asset of normalized) {
    const identity = `${asset.kind}\0${asset.id}`;
    if (identities.has(identity)) throw new TypeError(`重复会话资产: ${asset.kind}/${asset.id}`);
    identities.add(identity);
    if (!asset.id || /[\u0000-\u001f\u007f]/.test(asset.id) || asset.id.length > 240) {
      throw new TypeError('会话资产 id 非法');
    }
    if (asset.revision !== 'absent' && !/^sha256:[a-f0-9]{64}$/.test(asset.revision)) {
      throw new TypeError('会话资产 revision 非法');
    }
  }
  const hash = createHash('sha256');
  hash.update(`${SESSION_SNAPSHOT_VERSION}\n`);
  hash.update(database.databaseRevision);
  hash.update('\n');
  for (const asset of normalized) hashRecord(hash, asset);
  return {
    snapshotToken: `sha256:${hash.digest('hex')}`,
    databaseRevision: database.databaseRevision,
    rowCounts: database.rowCounts,
    assets: Object.freeze(normalized),
  };
}
