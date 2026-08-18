/**
 * 验证脚本：SQLite 统一事务 + migration（0.5.0 B）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-migration.ts
 * 场景：建 v1 旧库（缺列/缺表 + 已有数据）→ 用 MemoryDb 打开跑迁移 → schema 对齐 + 数据不丢。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryDb } from '../../packages/memory/src/db.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const hasCol = (db: DatabaseSync, table: string, col: string): boolean => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
};

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'jg-migrate-'));
  const file = join(dir, 'old.db');

  // ---- 建 v1 旧库：仅有 core 表 + 部分老 schema + 数据 ----
  {
    const old = new DatabaseSync(file);
    old.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE memory_meta (id INTEGER PRIMARY KEY, arc_id TEXT, stage TEXT, plot_round INTEGER, bars TEXT, config TEXT);
      CREATE TABLE memory_arc (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, chapter TEXT, title TEXT, summary TEXT, status TEXT DEFAULT 'active', seq INTEGER);
      CREATE TABLE lorebook_entry (id INTEGER PRIMARY KEY, uid TEXT, book TEXT, key TEXT, comment TEXT, content TEXT, selective INTEGER, depth INTEGER, constant INTEGER, use_regex INTEGER, triggers TEXT, active INTEGER DEFAULT 1);
      INSERT INTO memory_meta (id, arc_id, stage, plot_round, bars, config) VALUES (1, 'arc-1', 'development', 5, '{}', '{}');
      INSERT INTO memory_arc (code, chapter, title, summary, status, seq) VALUES ('AM01', 'c1', 'R5', '旧数据', 'active', 1);
      INSERT INTO lorebook_entry (uid, book, key, comment, content) VALUES ('u1', 'b1', 'k1', '旧世界书', '内容');
    `);
    old.close();
  }

  // ---- 用 MemoryDb 打开：触发 SCHEMA_V3 + 版本化迁移 ----
  const mem = new MemoryDb({ path: file });

  // 1. 版本号已升级到当前
  check('user_version 升级到当前 (3)', mem.userVersion() === 3, `v=${mem.userVersion()}`);

  // 2. 旧库数据不丢
  const meta = mem.db.prepare('SELECT plot_round FROM memory_meta WHERE id=1').get() as { plot_round: number };
  check('旧数据 plot_round 保留', meta?.plot_round === 5);
  const arc = mem.db.prepare('SELECT summary FROM memory_arc WHERE code=?').get('AM01') as { summary: string };
  check('旧数据 memory_arc 保留', arc?.summary === '旧数据');
  const lore = mem.db.prepare('SELECT comment FROM lorebook_entry WHERE uid=?').get('u1') as { comment: string };
  check('旧数据 lorebook_entry 保留', lore?.comment === '旧世界书');

  // 3. 缺失列已补齐（lorebook_entry.probability / useProbability）
  check('补列 probability', hasCol(mem.db, 'lorebook_entry', 'probability'));
  check('补列 useProbability', hasCol(mem.db, 'lorebook_entry', 'useProbability'));
  check('补列 longterm', hasCol(mem.db, 'memory_meta', 'longterm'));
  check('补列 summary_round', hasCol(mem.db, 'memory_meta', 'summary_round'));

  // 4. 缺失表已补齐（round_ledger / story_index）
  check(
    '补表 round_ledger',
    mem.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='round_ledger'").get() !== undefined
  );
  check(
    '补表 story_index',
    mem.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_index'").get() !== undefined
  );

  // 5. 新库（空缓存库）打开正常且版本正确
  const freshFile = join(dir, 'fresh.db');
  const fresh = new MemoryDb({ path: freshFile });
  check('新库 user_version = 3', fresh.userVersion() === 3, `v=${fresh.userVersion()}`);
  fresh.close();

  mem.checkpoint();
  mem.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nmigration 验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
