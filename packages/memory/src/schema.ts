/**
 * memory 包 - 记忆服务核心
 * 依据 v2 执行架构方案（07-执行架构方案.md）§5 数据模型 schema v3 实现。
 * 存储：node:sqlite (DatabaseSync) 零原生依赖；FTS5 trigram 中文检索 + vec BLOB 余弦 + RRF 融合。
 */

/** P14-01B：脱敏、append-only 的回合观察记录。正文与 Prompt 不得进入此表。 */
export const TURN_OBSERVATION_SQL = `
CREATE TABLE IF NOT EXISTS turn_observation (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT,
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  assistant_message_id INTEGER NOT NULL CHECK (assistant_message_id >= 1),
  source_revision TEXT NOT NULL,
  query_plan_version TEXT NOT NULL,
  routing_digest TEXT NOT NULL,
  recall_hit_count INTEGER CHECK (recall_hit_count IS NULL OR recall_hit_count >= 0),
  recall_codes_json TEXT,
  worldbook_hit_count INTEGER CHECK (worldbook_hit_count IS NULL OR worldbook_hit_count >= 0),
  resolved_entity_count INTEGER CHECK (resolved_entity_count IS NULL OR resolved_entity_count >= 0),
  ambiguous_entity_count INTEGER CHECK (ambiguous_entity_count IS NULL OR ambiguous_entity_count >= 0),
  skill_ids_json TEXT,
  skill_body_hashes_json TEXT,
  skill_tokens INTEGER CHECK (skill_tokens IS NULL OR skill_tokens >= 0),
  assembled_prompt_tokens INTEGER CHECK (assembled_prompt_tokens IS NULL OR assembled_prompt_tokens >= 0),
  harness_lane TEXT CHECK (harness_lane IS NULL OR harness_lane IN ('off', 'shadow', 'on')),
  harness_evidence_count INTEGER CHECK (harness_evidence_count IS NULL OR harness_evidence_count >= 0),
  model_attempts INTEGER CHECK (model_attempts IS NULL OR model_attempts >= 1),
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_observation_run
  ON turn_observation(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turn_observation_session_round
  ON turn_observation(session_id, round, assistant_message_id);
`;

/** P14-03A：事务型学习事件 outbox。只保存引用、digest、枚举和统计，禁止复制正文。 */
export const LEARNING_OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS learning_outbox (
  event_id TEXT PRIMARY KEY,
  run_id TEXT,
  session_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  content_mode TEXT NOT NULL CHECK (content_mode IN ('nsf','nsfw')),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'session_start_prompt','branch_exposed','branch_exact_selected','regenerate',
    'delete','turn_accepted_weak','explicit_preference'
  )),
  round INTEGER NOT NULL CHECK (round >= 0),
  user_message_id INTEGER CHECK (user_message_id IS NULL OR user_message_id >= 1),
  assistant_message_id INTEGER CHECK (assistant_message_id IS NULL OR assistant_message_id >= 1),
  source_revision TEXT,
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 71),
  features_json TEXT NOT NULL CHECK (json_valid(features_json)),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 71),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_outbox_pending
  ON learning_outbox(delivered_at, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_learning_outbox_session_round
  ON learning_outbox(session_id, round, event_kind);
CREATE INDEX IF NOT EXISTS idx_learning_outbox_run
  ON learning_outbox(run_id, event_kind) WHERE run_id IS NOT NULL;
`;

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
  seq INTEGER,
  access_count INTEGER DEFAULT 0,    -- 记忆衰减：被检索注入次数
  last_access_ms INTEGER DEFAULT 0   -- 记忆衰减：最近一次被注入的时间戳(ms)
);

-- 总结表（每轮增量）
CREATE TABLE IF NOT EXISTS memory_summary (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  round INTEGER, delta TEXT, scene TEXT, created_at TEXT,
  access_count INTEGER DEFAULT 0,
  last_access_ms INTEGER DEFAULT 0
);

-- 关键事件
CREATE TABLE IF NOT EXISTS memory_event (
  id INTEGER PRIMARY KEY,
  code TEXT, description TEXT,
  characters TEXT,
  refs TEXT, resolved INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_access_ms INTEGER DEFAULT 0
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
  state_json TEXT, updated_round INTEGER,
  access_count INTEGER DEFAULT 0,
  last_access_ms INTEGER DEFAULT 0
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

CREATE TABLE IF NOT EXISTS vec_index_build (
  build_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  preprocess TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  activated_at INTEGER DEFAULT 0
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

-- 回合账本（重新生成/删除历史回滚：每轮写环前快照 + 本轮新写行）
CREATE TABLE IF NOT EXISTS round_ledger (
  round INTEGER PRIMARY KEY,
  user_msg_id INTEGER, assistant_msg_id INTEGER,
  meta_snapshot TEXT, state_snapshot TEXT, created TEXT, created_at TEXT
);

-- P7-03B：服务端生成任务的会话侧成功回执。
-- 与最终 assistant / memory / state / ledger 写入处于同一事务；任务库据此在崩溃后对账，
-- 绝不能仅凭 Provider 已返回就宣告 succeeded。
CREATE TABLE IF NOT EXISTS turn_job_outcome (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('turn', 'regenerate')),
  round INTEGER NOT NULL CHECK (round >= 1),
  assistant_message_id INTEGER NOT NULL CHECK (assistant_message_id >= 1),
  revision TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_job_outcome_session_round
  ON turn_job_outcome(session_id, round);

${TURN_OBSERVATION_SQL}

${LEARNING_OUTBOX_SQL}

-- 剧情分支索引（AI 生成缓存，按轮次；供前端"剧情索引"面板）
CREATE TABLE IF NOT EXISTS story_index (
  round INTEGER PRIMARY KEY,
  content TEXT, created_at TEXT
);

-- 回合遥测（AQL 信号底座：隐式反馈 reward + 上下文指纹）
-- 纪律：只追加写（INSERT），回滚/删除历史不读不删本表 → verify-rollback/abort/fallback 不回归。
CREATE TABLE IF NOT EXISTS turn_ledger (
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
CREATE INDEX IF NOT EXISTS idx_turnledger_round ON turn_ledger(round);
CREATE INDEX IF NOT EXISTS idx_turnledger_session ON turn_ledger(session_id);

-- 纪要段（AQL 纪要可检索化：longterm 按主题段化落库，query 命中主题时可独立召回而非整块长摘）
CREATE TABLE IF NOT EXISTS summary_segment (
  id INTEGER PRIMARY KEY,
  seg_type TEXT,
  text TEXT,
  round INTEGER,
  created_at TEXT
);

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

/**
 * 状态快照存储（FE-C1）：把「变量状态」从 Node MVU 引擎对象的生命周期中**解耦**。
 *
 * 职责边界：
 *  - 本表 = 权威状态仓库（读快照 / 保存 / 版本 / 归属）
 *  - 运行时适配器（Node 沙箱或浏览器宿主）= 解释变量更新、执行卡片逻辑
 *  - 提交协调器 = 决定一次业务操作何时有效提交
 *
 * 作用域（FE-C1 楼层身份）：
 *  scope='session' → 会话级权威状态（scope_key 固定 'global'）
 *  scope='message' → 按**稳定消息身份**（chat_log.id，非外部楼层号）分别保存；
 *                    外部数字楼层由协议层翻译，找不到时**不得**静默退回最新状态。
 *  branch_key 预留剧情分支 / 回复版本维度（本批固定 'main'）。
 *
 * state_commit 记录已提交的操作 ID → 同一逻辑操作重试返回首次结果（幂等，FE-C4 基础）。
 */
export const STATE_STORE_SQL = `
CREATE TABLE IF NOT EXISTS state_snapshot (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  branch_key TEXT NOT NULL DEFAULT 'main',
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  instance_id TEXT,
  initialized INTEGER NOT NULL DEFAULT 1,
  updated_round INTEGER,
  updated_at TEXT,
  history_epoch INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_state_snapshot_key ON state_snapshot(scope, scope_key, branch_key);

CREATE TABLE IF NOT EXISTS state_commit (
  operation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  branch_key TEXT NOT NULL DEFAULT 'main',
  instance_id TEXT,
  state_version INTEGER NOT NULL,
  changes_json TEXT,
  intent_hash TEXT,
  result_json TEXT,
  status TEXT NOT NULL DEFAULT 'committed',
  created_at TEXT,
  history_epoch INTEGER,
  predecessor_json TEXT
);
`;

/**
 * AM-02：历史代际（不可回退保护）与合法前驱（v11 增量迁移）。
 *
 * ── 为什么不能只靠 state_version ──────────────────────────────────
 * 历史回滚（重新生成 / 删除整轮）会把剧情位置变小。若"防旧写"用的是会随存档一起退回的
 * 版本号，回滚后旧请求的锁号又被恢复成合法 → 迟到写入重新生效。
 * 因此代际必须放在**不会随剧情回滚一起退回**的控制位置：session_control。
 * 回滚只动 chat_log / memory_*，从不读写 session_control。
 *
 * 合法前驱：把「这次写入依据的是哪条源正文、哪一轮」显式记下来并可回查，
 * 源正文被删除/撤回（回滚后 chat_log 行不存在或轮次不符）→ 该候选不再是合法写入。
 */
export const STATE_EPOCH_SQL = `
ALTER TABLE state_snapshot ADD COLUMN history_epoch INTEGER;
ALTER TABLE state_commit ADD COLUMN history_epoch INTEGER;
ALTER TABLE state_commit ADD COLUMN predecessor_json TEXT;
CREATE TABLE IF NOT EXISTS session_control (
  session_key TEXT NOT NULL,
  control_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (session_key, control_key)
);
`;

/**
 * AM-01：人物身份、别名候选与角色投影（v11）。
 *
 * 职责划分（**不建立第二套权威记忆库**）：
 *  - character_registry / character_alias：稳定 characterId（代码分配）与别名候选；
 *    人物身份绑定会话命名空间，**不以名字作主键或文件名**。
 *  - character_fact_log：有来源的字段/关系变更记录（证据 + 生效语义 + 事实类别）。
 *  - 当前投影本体仍走 state_snapshot（scope='character'），复用既有提交/幂等/乐观锁入口；
 *    JSON 是固定 schema 的**只读投影**，默认直接作为 API/数据库记录形状返回，不强制落物理文件。
 *
 * 与既有身份的边界（不得互相替代）：
 *  - AM 码    → 定位记忆事件（memory_arc / memory_event / memory_summary）
 *  - MemoryRef→ 定位某来源的物理记录（source + record_id）
 *  - characterId → 定位人物
 */
export const CHARACTER_STORE_SQL = `
CREATE TABLE IF NOT EXISTS character_registry (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  character_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'npc',
  create_operation_id TEXT,
  created_at TEXT,
  UNIQUE (session_key, character_id)
);
/**
 * 注意：name **不是唯一键**。剧情里完全可能存在同名人物；若按名字做唯一约束，
 * 跨批次重复发现就会退化为「同名必合并」，与 §2.1「不按名字作为主键」冲突。
 * 因此只建非唯一索引：同名 → 消歧返回 unresolved，变更必须按稳定 characterId 定位。
 */
CREATE INDEX IF NOT EXISTS idx_character_registry_name ON character_registry(session_key, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_registry_op ON character_registry(create_operation_id);

CREATE TABLE IF NOT EXISTS character_alias (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  character_id TEXT NOT NULL,
  explicit INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  UNIQUE (session_key, alias, character_id)
);
CREATE INDEX IF NOT EXISTS idx_character_alias_lookup ON character_alias(session_key, alias);

CREATE TABLE IF NOT EXISTS character_fact_log (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  character_id TEXT NOT NULL,
  field TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'fact',
  fact_kind TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'confirmed',
  value_json TEXT,
  scene_id TEXT,
  effective_round INTEGER,
  effective_message_id INTEGER,
  source_refs TEXT NOT NULL DEFAULT '[]',
  history_epoch INTEGER NOT NULL DEFAULT 0,
  entity_version INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT,
  candidate_fingerprint TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_character_fact_lookup ON character_fact_log(session_key, character_id, field);
CREATE INDEX IF NOT EXISTS idx_character_fact_op ON character_fact_log(operation_id);
`;

/**
 * AM-07：人物候选**临时层**（v12）。
 *
 * ── 为什么需要它（两处已实证的失败）────────────────────────────────
 * ① 未注册的 NPC 只能落进 `unresolved`，而 unresolved 由 `character_pending` **覆盖写**，
 *    跨轮证据被冲掉：实测「角色乙」在正文出现 12+ 轮、`memory_state` 里 round 3 就有
 *    `('npc','角色乙')`，却始终进不了 `character_registry` —— 因为旧链路只允许
 *    `entity_type='protagonist'` 按 `entity_id` 建人，npc 一律拒绝。它防的是
 *    `char_001|角色甲` / `entity_alpha` 这类卡引擎实体键，但判据用错了轴，
 *    连人类可读的名字（本可用 `isPlausibleCharacterName` 拦住）也一起被杀。
 * ② 只在**单轮**出现过的非人实体（实测有 `char_003='主角所在地点'`、`char_004='祥子外观'`）
 *    会被直接建人，注册表被污染。
 *
 * ── 判据：用「持续性」，不用名字形态 ────────────────────────────────
 * 名字形态无法区分人 / 地点 / 字段（「角色乙」「示例学园」「主角所在地点」都是纯汉字）。
 * 能区分的是**持续存在**：`rounds_json` 按【轮】去重累计（同一轮写多条 state_changes 只算一次），
 * 累计到阈值且拿到可读名 → 一次性促升，走既有 `admit` 入口（不新增写入通道）。
 * 同一个机制同时解决 ① 和 ②，不需要任何名字词表。
 *
 * ── 边界（不破坏既有纪律）────────────────────────────────────────
 *  - **不参与任何读路径**：factBlock / resolveMentions / list 都不查池子 → 对 prompt 零 token 影响
 *  - **不是第二套权威库**：`pending_json` 只是暂存，促升后即转正并清空
 *  - `mention_key` 只作累计键，**绝不当人物名**（`char_001` / `char_001|角色甲` 都不是显示名）
 */
export const CHARACTER_POOL_SQL = `
CREATE TABLE IF NOT EXISTS character_mention_pool (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  mention_key TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'npc',
  display_name TEXT,
  name_candidates TEXT NOT NULL DEFAULT '[]',
  rounds_json TEXT NOT NULL DEFAULT '[]',
  pending_json TEXT NOT NULL DEFAULT '{}',
  first_round INTEGER,
  last_round INTEGER,
  first_message_id INTEGER,
  last_message_id INTEGER,
  promoted_character_id TEXT,
  promoted_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (session_key, mention_key)
);
CREATE INDEX IF NOT EXISTS idx_character_pool_session ON character_mention_pool(session_key, promoted_character_id, last_round);
`;

/**
 * FE-04-A：快照**溯源**列（v9 增量迁移）。
 * 目的：回答"这份状态是怎么来的" —— 卡片/用户写入，还是回合推进（Agent 未产生卡专属变量时
 * 明确标注为**沿用**而不是"最新状态"）。不用空对象冒充，也不在读取时临时取最新状态。
 */
export const SNAPSHOT_PROVENANCE_SQL = `
ALTER TABLE state_snapshot ADD COLUMN source TEXT;
ALTER TABLE state_snapshot ADD COLUMN note TEXT;
`;

/** 作用域常量：内部身份用 chat_log.id，不用外部楼层号 */
export const SCOPE_SESSION = 'session';
export const SCOPE_MESSAGE = 'message';
/** AM-01：人物作用域。scope_key = `<sessionKey>:<characterId>`（跨会话同名人物不共享单局状态） */
export const SCOPE_CHARACTER = 'character';
/** 会话级作用域的固定键（单会话一条权威状态） */
export const SESSION_SCOPE_KEY = 'global';
/** 默认分支键（剧情分支 / 回复版本维度预留） */
export const DEFAULT_BRANCH_KEY = 'main';
/** session_control 中保存历史代际的控制键（不随剧情回滚退回） */
export const CONTROL_HISTORY_EPOCH = 'history_epoch';

/** 当前 schema 版本号（v13：turn outcome；v14：Observation；v15：transactional learning outbox） */
export const SCHEMA_VERSION = 15;

/** 记忆衰减（Ebbinghaus 遗忘曲线）+ 访问提升 默认参数（均可用 env / RecallQuery 覆盖） */
export const DECAY_LAMBDA_DEFAULT = 0.1;  // 每天衰减系数：7 天≈50% 残留（exp(-0.7)≈0.497）
export const ACCESS_BOOST_DEFAULT = 0.5;  // 每次被检索注入的提升系数（叠加到归一化得分）
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 检索融合权重（v2 07 §5.1） */
export const DEFAULT_WEIGHTS = {
  wBm25: 0.45,
  wVec: 0.25,
  wRecency: 0.2,
  wAmPriority: 0.1,
};

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
