/**
 * P7-08 会话一致快照。
 *
 * 只覆盖模型/后台维护任务会读取的业务真值；不纳入向量索引、访问计数、审计、遥测、
 * eventId 或 SQLite 页布局，避免维护性写入制造无意义冲突。
 */
import { createHash } from 'node:crypto';
import type { MemoryDb } from './db.ts';

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

const SNAPSHOT_TABLES: readonly SnapshotTable[] = Object.freeze([
  { name: 'memory_meta', sql: 'SELECT id, arc_id, stage, plot_round, bars, config FROM memory_meta ORDER BY id' },
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
  { name: 'character_fact_log', sql: 'SELECT id, session_key, character_id, field, scope_kind, fact_kind, status, value_json, scene_id, effective_round, effective_message_id, source_refs, history_epoch, entity_version FROM character_fact_log ORDER BY id' },
]);

function hashRecord(hash: ReturnType<typeof createHash>, value: unknown): void {
  hash.update(JSON.stringify(value));
  hash.update('\n');
}

/** 所有 SELECT 在同一个 MemoryDb 事务内完成；同进程写者无法穿插。 */
export function computeSessionDatabaseSnapshot(memory: MemoryDb): SessionDatabaseSnapshot {
  return memory.transaction(() => {
    const hash = createHash('sha256');
    hash.update('jiuguan-session-db-snapshot-v1\n');
    const rowCounts: Record<string, number> = {};
    for (const table of SNAPSHOT_TABLES) {
      const rows = memory.db.prepare(table.sql).all() as unknown[];
      rowCounts[table.name] = rows.length;
      hash.update(`${table.name}\0${rows.length}\n`);
      for (const row of rows) hashRecord(hash, row);
    }
    return {
      databaseRevision: `sha256:${hash.digest('hex')}`,
      rowCounts: Object.freeze(rowCounts),
    };
  });
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
  hash.update('jiuguan-session-snapshot-v1\n');
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
