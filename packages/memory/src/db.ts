/**
 * memory 包 - 数据库访问层
 * node:sqlite (DatabaseSync) 封装：schema 初始化、WAL、备份、健康检查。
 */
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V3, SCHEMA_VERSION } from './schema.ts';

export interface MemoryDbOptions {
  /** 数据库文件路径；缺省为内存库（测试用） */
  path?: string;
  /** 自动执行 schema + migration */
  autoInit?: boolean;
}

/** 增量迁移（v1 → 当前版本，幂等：已存在的列/表自动跳过）。
 *  迁移编号 = 目标版本号；<current user_version> 之后的按序执行。
 *  01-03 为 v1 遗留库补齐（列存在时跳过，兼容新库已带全列）。 */
const MIGRATIONS: { version: number; apply: (db: DatabaseSync) => void }[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS round_ledger (
           round INTEGER PRIMARY KEY,
           user_msg_id INTEGER, assistant_msg_id INTEGER,
           meta_snapshot TEXT, state_snapshot TEXT, created TEXT, created_at TEXT
         );
         CREATE TABLE IF NOT EXISTS story_index (
           round INTEGER PRIMARY KEY,
           content TEXT, created_at TEXT
         );`
      );
    },
  },
  {
    version: 2,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(memory_meta)').all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('longterm')) db.exec('ALTER TABLE memory_meta ADD COLUMN longterm TEXT DEFAULT ""');
      if (!names.has('summary_round')) db.exec('ALTER TABLE memory_meta ADD COLUMN summary_round INTEGER DEFAULT 0');
    },
  },
  {
    version: 3,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(lorebook_entry)').all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('probability')) db.exec('ALTER TABLE lorebook_entry ADD COLUMN probability INTEGER DEFAULT 100');
      if (!names.has('useProbability')) db.exec('ALTER TABLE lorebook_entry ADD COLUMN useProbability INTEGER DEFAULT 0');
    },
  },
  {
    version: 4,
    apply: (db) => {
      // 记忆衰减列补齐：四张动态记忆表（旧库老数据 last_access_ms=0 → 检索层视为不衰减，不误伤存量）
      const decayTables = ['memory_arc', 'memory_summary', 'memory_event', 'memory_state'];
      for (const t of decayTables) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        if (!names.has('access_count')) db.exec(`ALTER TABLE ${t} ADD COLUMN access_count INTEGER DEFAULT 0`);
        if (!names.has('last_access_ms')) db.exec(`ALTER TABLE ${t} ADD COLUMN last_access_ms INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 5,
    apply: (db) => {
      // AQL 信号底座：回合遥测 + 纪要段（幂等：SCHEMA_V3 已含同样 DDL，旧库经此补齐）
      db.exec(
        `CREATE TABLE IF NOT EXISTS turn_ledger (
           id INTEGER PRIMARY KEY,
           session_id TEXT,
           round INTEGER,
           attempt INTEGER DEFAULT 0,
           retry_index INTEGER DEFAULT 0,
           clicked_regenerate INTEGER DEFAULT 0,
           outcome TEXT,
           token_cost INTEGER DEFAULT 0,
           context_fingerprint TEXT,
           reward TEXT,
           prev_prose_md5 TEXT,
           created_at TEXT
         );
         CREATE TABLE IF NOT EXISTS summary_segment (
           id INTEGER PRIMARY KEY,
           seg_type TEXT,
           text TEXT,
           round INTEGER,
           created_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_turnledger_round ON turn_ledger(round);
         CREATE INDEX IF NOT EXISTS idx_turnledger_session ON turn_ledger(session_id);`
      );
    },
  },
];

export class MemoryDb {
  readonly db: DatabaseSync;

  constructor(opts: MemoryDbOptions = {}) {
    this.db = opts.path ? new DatabaseSync(opts.path) : new DatabaseSync(':memory:');
    if (opts.autoInit !== false) {
      // 新库全量建表（幂等）；旧库仅建缺失表，遗留差异由 MIGRATIONS 补齐
      this.db.exec(SCHEMA_V3);
      this.migrate();
    }
  }

  /** 版本化迁移：把旧库逐级升到当前 SCHEMA_VERSION（0.5.0 引入 user_version 追踪） */
  private migrate(): void {
    let current = this.userVersion();
    while (current < SCHEMA_VERSION) {
      const target = current + 1;
      const mig = MIGRATIONS.find((m) => m.version === target);
      if (!mig) throw new Error(`缺少版本 ${target} 的迁移脚本`);
      // 单事务执行：迁移失败回滚，不留下半成品 schema
      // （SCHEMA_V3 已在构造函数整体执行过：建缺失表 + PRAGMA，勿在事务内再跑）
      this.db.exec('BEGIN IMMEDIATE');
      try {
        mig.apply(this.db);
        this.db.exec(`PRAGMA user_version = ${target}`);
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
        throw e;
      }
      current = target;
    }
  }

  /** 当前 schema 版本（PRAGMA user_version，缺省 0 = 未打标旧库） */
  userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row?.user_version ?? 0;
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
