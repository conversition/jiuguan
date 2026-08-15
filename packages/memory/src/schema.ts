/**
 * memory 包 - 记忆服务核心
 * 依据 v2 执行架构方案（07-执行架构方案.md）§5 数据模型 schema v3 实现。
 * 存储：node:sqlite (DatabaseSync) 零原生依赖；FTS5 trigram 中文检索 + vec BLOB 余弦 + RRF 融合。
 */

/** 数据库 schema v3 定义（对应审查 §4.1/§4.5/§4.6 修正） */
export const SCHEMA_V3 = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 剧本元数据 / 推进槽
CREATE TABLE IF NOT EXISTS memory_meta (
  id INTEGER PRIMARY KEY,
  arc_id TEXT, stage TEXT, plot_round INTEGER,
  bars TEXT, config TEXT
);

-- 总体大纲表（AM 编码，平台分配码号）
CREATE TABLE IF NOT EXISTS memory_arc (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  chapter TEXT, title TEXT,
  summary TEXT,
  status TEXT DEFAULT 'active',
  seq INTEGER
);

-- 总结表（每轮增量）
CREATE TABLE IF NOT EXISTS memory_summary (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  round INTEGER, delta TEXT, scene TEXT, created_at TEXT
);

-- 关键事件
CREATE TABLE IF NOT EXISTS memory_event (
  id INTEGER PRIMARY KEY,
  code TEXT, description TEXT,
  characters TEXT,
  refs TEXT, resolved INTEGER DEFAULT 0
);

-- 平行事件（倒计时）
CREATE TABLE IF NOT EXISTS memory_parallel (
  id INTEGER PRIMARY KEY,
  kind TEXT, countdown_min INTEGER,
  actor TEXT, location TEXT, action TEXT, next_stage TEXT
);

-- 实体状态（表0-5 SQL 化）
CREATE TABLE IF NOT EXISTS memory_state (
  id INTEGER PRIMARY KEY,
  entity_type TEXT, entity_id TEXT, name TEXT,
  state_json TEXT, updated_round INTEGER
);

-- 世界书条目缓存（向量化来源）
CREATE TABLE IF NOT EXISTS lorebook_entry (
  id INTEGER PRIMARY KEY,
  uid TEXT, book TEXT, key TEXT, comment TEXT,
  content TEXT, selective INTEGER, depth INTEGER,
  constant INTEGER, use_regex INTEGER, triggers TEXT,
  probability INTEGER DEFAULT 100,     -- v1.1 审查 §5.1：概率门
  useProbability INTEGER DEFAULT 0,    -- v1.1：是否启用概率门
  active INTEGER DEFAULT 1
);

-- 实体精确索引
CREATE TABLE IF NOT EXISTS idx_entity (
  entity TEXT, category TEXT, row_id INTEGER, weight REAL
);
CREATE INDEX IF NOT EXISTS idx_entity_name ON idx_entity(entity);

-- 向量索引：BLOB 存储 f32 小端，维度动态
CREATE TABLE IF NOT EXISTS vec_memory (
  row_id INTEGER PRIMARY KEY,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL
);

-- 审计（写环/校验/重试记录）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  round INTEGER, mode TEXT, validator_output TEXT,
  attempts INTEGER, final_action TEXT, created_at TEXT
);

-- 对话记录（会话持久化）
CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY,
  round INTEGER NOT NULL,
  role TEXT NOT NULL,             -- user / assistant / system(greeting)
  content TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_round ON chat_log(round);

-- ── FTS5 外部内容表：memory_arc ──
CREATE VIRTUAL TABLE IF NOT EXISTS fts_arc USING fts5(
  content, category,
  content='memory_arc', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS arc_ai AFTER INSERT ON memory_arc BEGIN
  INSERT INTO fts_arc(rowid, content, category) VALUES (new.id, new.summary, 'arc');
END;
CREATE TRIGGER IF NOT EXISTS arc_ad AFTER DELETE ON memory_arc BEGIN
  INSERT INTO fts_arc(fts_arc, rowid, content, category) VALUES ('delete', old.id, old.summary, 'arc');
END;
CREATE TRIGGER IF NOT EXISTS arc_au AFTER UPDATE ON memory_arc BEGIN
  INSERT INTO fts_arc(fts_arc, rowid, content, category) VALUES ('delete', old.id, old.summary, 'arc');
  INSERT INTO fts_arc(rowid, content, category) VALUES (new.id, new.summary, 'arc');
END;

-- ── FTS5 外部内容表：memory_summary ──
CREATE VIRTUAL TABLE IF NOT EXISTS fts_summary USING fts5(
  content, category,
  content='memory_summary', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS sum_ai AFTER INSERT ON memory_summary BEGIN
  INSERT INTO fts_summary(rowid, content, category) VALUES (new.id, new.delta, 'summary');
END;
CREATE TRIGGER IF NOT EXISTS sum_ad AFTER DELETE ON memory_summary BEGIN
  INSERT INTO fts_summary(fts_summary, rowid, content, category) VALUES ('delete', old.id, old.delta, 'summary');
END;
CREATE TRIGGER IF NOT EXISTS sum_au AFTER UPDATE ON memory_summary BEGIN
  INSERT INTO fts_summary(fts_summary, rowid, content, category) VALUES ('delete', old.id, old.delta, 'summary');
  INSERT INTO fts_summary(rowid, content, category) VALUES (new.id, new.delta, 'summary');
END;

-- ── FTS5 外部内容表：memory_event ──
CREATE VIRTUAL TABLE IF NOT EXISTS fts_event USING fts5(
  content, category,
  content='memory_event', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS evt_ai AFTER INSERT ON memory_event BEGIN
  INSERT INTO fts_event(rowid, content, category) VALUES (new.id, new.description, 'event');
END;
CREATE TRIGGER IF NOT EXISTS evt_ad AFTER DELETE ON memory_event BEGIN
  INSERT INTO fts_event(fts_event, rowid, content, category) VALUES ('delete', old.id, old.description, 'event');
END;
CREATE TRIGGER IF NOT EXISTS evt_au AFTER UPDATE ON memory_event BEGIN
  INSERT INTO fts_event(fts_event, rowid, content, category) VALUES ('delete', old.id, old.description, 'event');
  INSERT INTO fts_event(rowid, content, category) VALUES (new.id, new.description, 'event');
END;

-- ── FTS5 外部内容表：memory_state（name + state_json 可检索字段）──
CREATE VIRTUAL TABLE IF NOT EXISTS fts_state USING fts5(
  content, category,
  content='memory_state', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS st_ai AFTER INSERT ON memory_state BEGIN
  INSERT INTO fts_state(rowid, content, category)
  VALUES (new.id, new.name || ' ' || new.state_json, 'state');
END;
CREATE TRIGGER IF NOT EXISTS st_ad AFTER DELETE ON memory_state BEGIN
  INSERT INTO fts_state(fts_state, rowid, content, category)
  VALUES ('delete', old.id, old.name || ' ' || old.state_json, 'state');
END;
CREATE TRIGGER IF NOT EXISTS st_au AFTER UPDATE ON memory_state BEGIN
  INSERT INTO fts_state(fts_state, rowid, content, category)
  VALUES ('delete', old.id, old.name || ' ' || old.state_json, 'state');
  INSERT INTO fts_state(rowid, content, category)
  VALUES (new.id, new.name || ' ' || new.state_json, 'state');
END;

-- ── FTS5 外部内容表：lorebook_entry ──
CREATE VIRTUAL TABLE IF NOT EXISTS fts_lore USING fts5(
  content, category,
  content='lorebook_entry', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS lore_ai AFTER INSERT ON lorebook_entry BEGIN
  INSERT INTO fts_lore(rowid, content, category) VALUES (new.id, new.comment || ' ' || new.content, 'lore');
END;
CREATE TRIGGER IF NOT EXISTS lore_ad AFTER DELETE ON lorebook_entry BEGIN
  INSERT INTO fts_lore(fts_lore, rowid, content, category)
  VALUES ('delete', old.id, old.comment || ' ' || old.content, 'lore');
END;
CREATE TRIGGER IF NOT EXISTS lore_au AFTER UPDATE ON lorebook_entry BEGIN
  INSERT INTO fts_lore(fts_lore, rowid, content, category)
  VALUES ('delete', old.id, old.comment || ' ' || old.content, 'lore');
  INSERT INTO fts_lore(rowid, content, category) VALUES (new.id, new.comment || ' ' || new.content, 'lore');
END;
`;

/** 检索融合权重（v2 07 §5.1） */
export const DEFAULT_WEIGHTS = {
  wBm25: 0.45,
  wVec: 0.25,
  wRecency: 0.2,
  wAmPriority: 0.1,
} as const;

/** 置信门控阈值：final < 该值直接丢弃 */
export const DEFAULT_DROP_THRESHOLD = 0.35;

/** AM 码正则：AM + 至少 2 位数字（AM01..AM99, AM100.. 均合法） */
export const AM_CODE_RE = /^AM\d{2,}$/;

/** 下一可用 AM 码（平台自增分配） */
export function nextAmCode(existing: string[]): string {
  let max = 0;
  for (const c of existing) {
    if (!AM_CODE_RE.test(c)) continue;
    const n = parseInt(c.slice(2), 10);
    if (n > max) max = n;
  }
  return `AM${String(max + 1).padStart(2, '0')}`;
}
