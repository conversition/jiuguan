/**
 * memory 包 - 数据库访问层
 * node:sqlite (DatabaseSync) 封装：schema 初始化、WAL、备份、健康检查。
 */
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V3, SCHEMA_VERSION, STATE_STORE_SQL, SNAPSHOT_PROVENANCE_SQL, STATE_EPOCH_SQL, CHARACTER_STORE_SQL, CHARACTER_POOL_SQL, TURN_OBSERVATION_SQL, LEARNING_OUTBOX_SQL } from './schema.ts';

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
  {
    version: 6,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(vec_memory)').all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('source')) {
        db.exec(
          `ALTER TABLE vec_memory RENAME TO vec_memory_legacy;
           CREATE TABLE vec_memory (
             source TEXT NOT NULL DEFAULT 'legacy',
             row_id INTEGER NOT NULL,
             dims INTEGER NOT NULL,
             embedding BLOB NOT NULL,
             PRIMARY KEY (source, row_id)
           );
           INSERT OR IGNORE INTO vec_memory (source, row_id, dims, embedding)
             SELECT 'legacy', row_id, dims, embedding FROM vec_memory_legacy;
           DROP TABLE vec_memory_legacy;`
        );
      } else if (!names.has('build_id')) {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_memory_source_row ON vec_memory(source, row_id)');
      }
    },
  },
  {
    version: 7,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(vec_memory)').all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      const hasFullKey = names.has('build_id') && names.has('content_hash') && names.has('model') && names.has('preprocess') && names.has('indexed_at') && names.has('active');
      if (!hasFullKey) {
        db.exec(
          `ALTER TABLE vec_memory RENAME TO vec_memory_v6;
           CREATE TABLE vec_memory (
             source TEXT NOT NULL DEFAULT 'legacy',
             row_id INTEGER NOT NULL,
             build_id TEXT NOT NULL DEFAULT 'legacy',
             content_hash TEXT NOT NULL DEFAULT '',
             model TEXT NOT NULL DEFAULT '',
             preprocess TEXT NOT NULL DEFAULT '{}',
             indexed_at INTEGER NOT NULL DEFAULT 0,
             active INTEGER NOT NULL DEFAULT 1,
             dims INTEGER NOT NULL,
             embedding BLOB NOT NULL,
             PRIMARY KEY (source, row_id, build_id)
           );
           INSERT OR IGNORE INTO vec_memory (source, row_id, build_id, content_hash, model, preprocess, indexed_at, active, dims, embedding)
             SELECT source, row_id, 'legacy', '', '', '{}', 0, 0, dims, embedding FROM vec_memory_v6;
           DROP TABLE vec_memory_v6;`
        );
      }
      db.exec(
        `CREATE TABLE IF NOT EXISTS vec_index_build (
           build_id TEXT PRIMARY KEY,
           source TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT '',
           preprocess TEXT NOT NULL DEFAULT '{}',
           status TEXT NOT NULL DEFAULT 'active',
           created_at INTEGER NOT NULL,
           activated_at INTEGER DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_vec_memory_active_source ON vec_memory(active, source, row_id);
         CREATE INDEX IF NOT EXISTS idx_vec_memory_hash ON vec_memory(source, row_id, content_hash, model, preprocess);`
      );
    },
  },
  {
    version: 8,
    apply: (db) => {
      // FE-C1：状态快照存储（把变量状态从 Node MVU 引擎生命周期解耦）+ 提交记录（幂等基础）。
      // 新建库与旧库都经此迁移，保证两路径 schema 一致。
      db.exec(STATE_STORE_SQL);
    },
  },
  {
    version: 9,
    apply: (db) => {
      // FE-04-A：快照溯源（source/note）—— 让"状态从哪来"可读，避免读取时取"最新状态"冒充。
      // 新库：SCHEMA 全量建表已含该列 → ALTER 会失败，忽略即可；旧库：补齐列。
      for (const sql of SNAPSHOT_PROVENANCE_SQL.split(';').map((x) => x.trim()).filter(Boolean)) {
        try { db.exec(sql); } catch { /* 列已存在 */ }
      }
    },
  },
  {
    version: 10,
    apply: (db) => {
      const cols = db.prepare('PRAGMA table_info(state_commit)').all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('intent_hash')) db.exec('ALTER TABLE state_commit ADD COLUMN intent_hash TEXT');
      if (!names.has('result_json')) db.exec('ALTER TABLE state_commit ADD COLUMN result_json TEXT');
      if (!names.has('status')) db.exec("ALTER TABLE state_commit ADD COLUMN status TEXT NOT NULL DEFAULT 'committed'");
    },
  },
  {
    version: 11,
    apply: (db) => {
      // AM-02：历史代际（不可回退保护）+ 合法前驱 + session_control（回滚不触碰的控制位置）。
      // 新库：STATE_STORE_SQL 已含 history_epoch / predecessor_json → ALTER 失败忽略；旧库：补齐列。
      for (const sql of STATE_EPOCH_SQL.split(';').map((x) => x.trim()).filter(Boolean)) {
        try { db.exec(sql); } catch { /* 列已存在 */ }
      }
      // AM-01：人物身份/别名/事实日志（幂等建表；旧档与投影按需重建，不在此迁移业务数据）
      db.exec(CHARACTER_STORE_SQL);
    },
  },
  {
    version: 12,
    apply: (db) => {
      // AM-07：人物候选临时层（幂等建表）。**不迁移任何业务数据**——池子只承载新写入，
      // 历史 unresolved 不回溯补池（无从知道它们当时算第几轮，补进去等于伪造计数）。
      db.exec(CHARACTER_POOL_SQL);
    },
  },
  {
    version: 13,
    apply: (db) => {
      // P7-03B：会话最终提交回执。CREATE IF NOT EXISTS 兼容 SCHEMA_V3 已创建的新库。
      db.exec(
        `CREATE TABLE IF NOT EXISTS turn_job_outcome (
           run_id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           action TEXT NOT NULL CHECK (action IN ('turn', 'regenerate')),
           round INTEGER NOT NULL CHECK (round >= 1),
           assistant_message_id INTEGER NOT NULL CHECK (assistant_message_id >= 1),
           revision TEXT NOT NULL,
           committed_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_turn_job_outcome_session_round
           ON turn_job_outcome(session_id, round);`,
      );
    },
  },
  {
    version: 14,
    apply: (db) => {
      // P14-01B：只建脱敏观察表，不回填历史正文，不接回合写入。
      db.exec(TURN_OBSERVATION_SQL);
    },
  },
  {
    version: 15,
    apply: (db) => {
      // P14-03A-01：只建空 outbox，不从历史正文伪造学习证据。
      db.exec(LEARNING_OUTBOX_SQL);
    },
  },
];

export class MemoryDb {
  readonly db: DatabaseSync;
  #transactionDepth = 0;

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

  /** 可组合同步事务：内层调用复用外层事务，不重复 BEGIN/COMMIT。 */
  transaction<T>(work: () => T): T {
    if (this.#transactionDepth > 0) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.#transactionDepth = 1;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 保留原始错误。 */ }
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
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
