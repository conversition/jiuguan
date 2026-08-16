/**
 * memory 包 - 数据库访问层
 * node:sqlite (DatabaseSync) 封装：schema 初始化、WAL、备份、健康检查。
 */
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V3 } from './schema.ts';

export interface MemoryDbOptions {
  /** 数据库文件路径；缺省为内存库（测试用） */
  path?: string;
  /** 自动执行 schema v3 */
  autoInit?: boolean;
}

export class MemoryDb {
  readonly db: DatabaseSync;

  constructor(opts: MemoryDbOptions = {}) {
    this.db = opts.path ? new DatabaseSync(opts.path) : new DatabaseSync(':memory:');
    if (opts.autoInit !== false) {
      this.db.exec(SCHEMA_V3);
      this.migrate();
    }
  }

  /** 迁移：旧库补列/补表（CREATE IF NOT EXISTS 不更新已存在表，故手工 ALTER） */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(lorebook_entry)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('probability')) {
      this.db.exec('ALTER TABLE lorebook_entry ADD COLUMN probability INTEGER DEFAULT 100');
    }
    if (!names.has('useProbability')) {
      this.db.exec('ALTER TABLE lorebook_entry ADD COLUMN useProbability INTEGER DEFAULT 0');
    }
    // v2.0：memory_meta 补 longterm 滚动摘要列（滑动窗口功能）
    const metaCols = this.db.prepare('PRAGMA table_info(memory_meta)').all() as { name: string }[];
    if (!metaCols.some((c) => c.name === 'longterm')) {
      this.db.exec('ALTER TABLE memory_meta ADD COLUMN longterm TEXT DEFAULT ""');
    }
    if (!metaCols.some((c) => c.name === 'summary_round')) {
      this.db.exec('ALTER TABLE memory_meta ADD COLUMN summary_round INTEGER DEFAULT 0');
    }
    // v2.0：round_ledger 账本表
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS round_ledger (
         round INTEGER PRIMARY KEY,
         user_msg_id INTEGER, assistant_msg_id INTEGER,
         meta_snapshot TEXT, state_snapshot TEXT, created TEXT, created_at TEXT
       )`
    );
    // v2.0：story_index 剧情分支索引缓存表
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS story_index (
         round INTEGER PRIMARY KEY,
         content TEXT, created_at TEXT
       )`
    );
  }

  /** WAL checkpoint（备份/退出前调用） */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** 完整性检查（kill -9 后重启调用） */
  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row?.integrity_check ?? 'unknown';
  }

  /** 在线热备：拷贝到目标路径 */
  backupTo(targetPath: string): void {
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.db.close();
  }
}
