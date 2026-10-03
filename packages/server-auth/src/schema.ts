/**
 * auth.sqlite 的 schema、逐版迁移 runner 与"打开之前"的文件级校验（A1-02 第 2 步）。
 *
 * 设计要点（对应交接说明 §4.3/§4.4 与总清单 §6.3）：
 * - **打开顺序**是"先只读识别、再读写迁移"：本模块只提供"识别"与"迁移"两件事，
 *   编排在 `store.ts` 的 `openAuthStore()`。**不要**复用"先执行最新 CREATE、再判断版本"
 *   的顺序 —— 那会掩盖未来版与损坏库。
 * - 每版迁移在**单一事务**内完成 schema/data/index 之后才写 `PRAGMA user_version`；
 *   失败时 `ROLLBACK` 会把 DDL 与版本号**一起**回滚（Node v22.22.2 实测）。
 * - 约束写在 schema 内，而不是只靠 TypeScript：外键、UNIQUE、CHECK（含 selector 的小写 hex
 *   形状、digest 长度、JSON 数组类型）与过期/吊销索引全部落在 DDL 里。
 * - 迁移只做 expand/contract，不做不可逆删列。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AuthStorageError } from './storage-error.ts';

/** auth.sqlite 的 `PRAGMA application_id`：ASCII 'JGUA'。 */
export const AUTH_DB_APPLICATION_ID = 0x4a475541;
/** 当前 schema 版本；每版迁移成功后写入 `PRAGMA user_version`。 */
export const AUTH_SCHEMA_VERSION = 1;

/** SQLite 文件头（前 16 字节）。 */
export const SQLITE_FILE_HEADER = 'SQLite format 3\0';
/** 一个合法 SQLite 数据库至少要有 100 字节的文件头。 */
const SQLITE_HEADER_BYTES = 100;
/** 头部中 `user_version` 与 `application_id` 的偏移（big-endian uint32）。 */
const HEADER_USER_VERSION_OFFSET = 60;
const HEADER_APPLICATION_ID_OFFSET = 68;

/** selector 必须是 24 位**小写** hex：与 `crypto.ts` 的 selector 形状一致。 */
const SELECTOR_HEX_CHECK = "length(selector) = 24 AND selector NOT GLOB '*[^0-9a-f]*'";
/** digest 列固定 32 字节（HMAC-SHA-256）。 */
const DIGEST_LENGTH_CHECK = 'length(credential_digest) = 32';

/** 六张表；顺序即创建顺序（外键依赖：device → session → capability）。 */
export const AUTH_TABLES = [
  'auth_meta',
  'auth_device',
  'auth_session',
  'auth_pairing',
  'auth_asset_capability',
  'auth_audit',
] as const;
export type AuthTableName = (typeof AUTH_TABLES)[number];

export interface AuthMigration {
  readonly version: number;
  /** 迁移的可读名字，仅用于诊断信息，不参与版本判定。 */
  readonly name: string;
  readonly statements: readonly string[];
}

/** 逐版迁移。新增版本时**只追加**，不要修改已发布的语句。 */
export const AUTH_SCHEMA_MIGRATIONS: readonly AuthMigration[] = [
  {
    version: 1,
    name: 'initial-auth-schema',
    statements: [
      // 空库的 application_id 也在这里落地：写头部是事务性的，失败会一起回滚。
      `PRAGMA application_id = ${AUTH_DB_APPLICATION_ID};`,

      // 单行元数据：schema 版本、安全 epoch、storage binding 与 generation 的绑定关系。
      `CREATE TABLE auth_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
         security_epoch INTEGER NOT NULL CHECK (security_epoch >= 1),
         generation_id TEXT NOT NULL CHECK (length(generation_id) = 24),
         storage_binding TEXT NOT NULL CHECK (length(storage_binding) = 64),
         updated_at TEXT NOT NULL
       );`,

      `CREATE TABLE auth_device (
         device_id TEXT PRIMARY KEY CHECK (length(device_id) BETWEEN 8 AND 64),
         selector TEXT NOT NULL UNIQUE CHECK (${SELECTOR_HEX_CHECK}),
         credential_digest BLOB NOT NULL CHECK (${DIGEST_LENGTH_CHECK}),
         display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
         platform TEXT NOT NULL CHECK (platform IN ('web','pwa','android','ios','desktop')),
         scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
         transports_json TEXT NOT NULL CHECK (json_valid(transports_json) AND json_type(transports_json) = 'array'),
         client_instance_id TEXT CHECK (client_instance_id IS NULL OR length(client_instance_id) BETWEEN 8 AND 64),
         created_at TEXT NOT NULL,
         last_seen_at TEXT,
         revoked_at TEXT,
         security_epoch INTEGER NOT NULL CHECK (security_epoch >= 1)
       );`,
      `CREATE INDEX idx_auth_device_revoked ON auth_device (revoked_at);`,
      `CREATE INDEX idx_auth_device_epoch ON auth_device (security_epoch);`,

      `CREATE TABLE auth_session (
         selector TEXT PRIMARY KEY CHECK (${SELECTOR_HEX_CHECK}),
         public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 8 AND 64),
         credential_digest BLOB NOT NULL CHECK (${DIGEST_LENGTH_CHECK}),
         csrf_epoch INTEGER NOT NULL CHECK (csrf_epoch >= 0),
         device_id TEXT NOT NULL REFERENCES auth_device (device_id) ON DELETE CASCADE,
         transport TEXT NOT NULL CHECK (transport IN ('same-origin-cookie','bearer')),
         issued_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         last_seen_at TEXT,
         revoked_at TEXT,
         security_epoch INTEGER NOT NULL CHECK (security_epoch >= 1),
         CHECK (expires_at > issued_at)
       );`,
      `CREATE INDEX idx_auth_session_device ON auth_session (device_id);`,
      `CREATE INDEX idx_auth_session_validity ON auth_session (revoked_at, expires_at);`,

      // pairing 必须有**唯一 selector**：只存 pairing_id + digest 会让 selector 查询无法确定唯一行。
      `CREATE TABLE auth_pairing (
         pairing_id TEXT PRIMARY KEY CHECK (length(pairing_id) BETWEEN 8 AND 64),
         selector TEXT NOT NULL UNIQUE CHECK (${SELECTOR_HEX_CHECK}),
         code_digest BLOB NOT NULL CHECK (length(code_digest) = 32),
         allowed_scopes_json TEXT NOT NULL CHECK (json_valid(allowed_scopes_json) AND json_type(allowed_scopes_json) = 'array'),
         allowed_transports_json TEXT NOT NULL CHECK (json_valid(allowed_transports_json) AND json_type(allowed_transports_json) = 'array'),
         display_name_hint TEXT CHECK (display_name_hint IS NULL OR length(display_name_hint) BETWEEN 1 AND 64),
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 10),
         consumed_at TEXT,
         consumed_device_id TEXT REFERENCES auth_device (device_id),
         revoked_at TEXT,
         security_epoch INTEGER NOT NULL CHECK (security_epoch >= 1),
         CHECK (expires_at > created_at)
       );`,
      `CREATE INDEX idx_auth_pairing_state ON auth_pairing (consumed_at, revoked_at, expires_at);`,

      `CREATE TABLE auth_asset_capability (
         selector TEXT PRIMARY KEY CHECK (${SELECTOR_HEX_CHECK}),
         digest BLOB NOT NULL CHECK (length(digest) = 32),
         asset_id TEXT NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 256),
         target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
         purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 32),
         session_selector TEXT NOT NULL REFERENCES auth_session (selector) ON DELETE CASCADE,
         allowed_methods_json TEXT NOT NULL CHECK (json_valid(allowed_methods_json) AND json_type(allowed_methods_json) = 'array'),
         range_policy TEXT NOT NULL CHECK (length(range_policy) BETWEEN 1 AND 64),
         issued_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         requests_remaining INTEGER NOT NULL CHECK (requests_remaining >= 0),
         bytes_remaining INTEGER NOT NULL CHECK (bytes_remaining >= 0),
         reservation_version INTEGER NOT NULL CHECK (reservation_version >= 0),
         revoked_at TEXT,
         CHECK (expires_at > issued_at)
       );`,
      `CREATE INDEX idx_auth_capability_session ON auth_asset_capability (session_selector);`,
      `CREATE INDEX idx_auth_capability_validity ON auth_asset_capability (revoked_at, expires_at);`,

      // 审计行**故意不加** device/session 外键：吊销或删除后审计必须仍然留存可查。
      `CREATE TABLE auth_audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         occurred_at TEXT NOT NULL,
         request_id TEXT,
         action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
         route_template TEXT,
         decision TEXT NOT NULL CHECK (length(decision) BETWEEN 1 AND 32),
         reason_code TEXT,
         device_id TEXT,
         session_public_id TEXT,
         status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
         latency_bucket TEXT,
         bytes_bucket TEXT
       );`,
      `CREATE INDEX idx_auth_audit_occurred ON auth_audit (occurred_at);`,
    ],
  },
];

/** 给定迁移列表所能达到的最高版本。 */
export function authSchemaVersionOf(
  migrations: readonly AuthMigration[] = AUTH_SCHEMA_MIGRATIONS,
): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

/**
 * 每张表的**精确列名**（含顺序）。备份恢复要做的"精确 schema 检查"以这里为准；
 * `tests/verify-schema.ts` 会断言迁移建出的真实列名与它一致，任何一侧漂移都会失败。
 */
export const AUTH_TABLE_COLUMNS: Readonly<Record<AuthTableName, readonly string[]>> = {
  auth_meta: ['id', 'schema_version', 'security_epoch', 'generation_id', 'storage_binding', 'updated_at'],
  auth_device: [
    'device_id', 'selector', 'credential_digest', 'display_name', 'platform', 'scopes_json',
    'transports_json', 'client_instance_id', 'created_at', 'last_seen_at', 'revoked_at', 'security_epoch',
  ],
  auth_session: [
    'selector', 'public_id', 'credential_digest', 'csrf_epoch', 'device_id', 'transport',
    'issued_at', 'expires_at', 'last_seen_at', 'revoked_at', 'security_epoch',
  ],
  auth_pairing: [
    'pairing_id', 'selector', 'code_digest', 'allowed_scopes_json', 'allowed_transports_json',
    'display_name_hint', 'created_at', 'expires_at', 'attempts_remaining', 'consumed_at',
    'consumed_device_id', 'revoked_at', 'security_epoch',
  ],
  auth_asset_capability: [
    'selector', 'digest', 'asset_id', 'target_digest', 'purpose', 'session_selector',
    'allowed_methods_json', 'range_policy', 'issued_at', 'expires_at', 'requests_remaining',
    'bytes_remaining', 'reservation_version', 'revoked_at',
  ],
  auth_audit: [
    'id', 'occurred_at', 'request_id', 'action', 'route_template', 'decision', 'reason_code',
    'device_id', 'session_public_id', 'status', 'latency_bucket', 'bytes_bucket',
  ],
};

export interface SchemaExactnessVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * 精确 schema 检查：表集合与每张表的列名（含顺序）都必须与 `AUTH_TABLE_COLUMNS` 完全一致。
 * 备份副本在恢复前必须通过它；"表在但列不同"的库不能当合法备份。
 */
export function inspectAuthSchemaExactness(db: DatabaseSync): SchemaExactnessVerdict {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  const present = rows.map((row) => row.name).filter((name) => !name.startsWith('sqlite_'));
  const expected = [...AUTH_TABLES].sort();
  if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) {
    return { ok: false, detail: `表集合不一致：期望 ${expected.join(',')}，实际 ${present.join(',')}` };
  }
  for (const table of AUTH_TABLES) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const columns = info.map((row) => row.name);
    const wanted = AUTH_TABLE_COLUMNS[table];
    if (columns.length !== wanted.length || columns.some((name, index) => name !== wanted[index])) {
      return {
        ok: false,
        detail: `${table} 列不一致：期望 [${wanted.join(',')}]，实际 [${columns.join(',')}]`,
      };
    }
  }
  return { ok: true, detail: 'exact' };
}

/** 读取 `PRAGMA user_version`；读不出来按损坏库处理。 */
export function readAuthSchemaVersion(db: DatabaseSync): number {
  let row: unknown;
  try {
    row = db.prepare('PRAGMA user_version').get();
  } catch (error) {
    throw new AuthStorageError(
      'auth-db-corrupt',
      `无法读取 user_version：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = (row as { user_version?: unknown } | undefined)?.user_version;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new AuthStorageError('auth-db-corrupt', 'user_version 不是非负整数');
  }
  return Number(value);
}

/** 读取 `PRAGMA application_id`；读不出来按损坏库处理。 */
export function readAuthApplicationId(db: DatabaseSync): number {
  let row: unknown;
  try {
    row = db.prepare('PRAGMA application_id').get();
  } catch (error) {
    throw new AuthStorageError(
      'auth-db-corrupt',
      `无法读取 application_id：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = (row as { application_id?: unknown } | undefined)?.application_id;
  if (!Number.isInteger(value)) {
    throw new AuthStorageError('auth-db-corrupt', 'application_id 不是整数');
  }
  return Number(value);
}

/** 写入 `PRAGMA user_version`。只能用字面量（PRAGMA 不支持绑定参数）。 */
export function writeAuthSchemaVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new AuthStorageError('invalid-layout', `非法 schema 版本：${String(version)}`);
  }
  db.exec(`PRAGMA user_version = ${version};`);
}

export interface AuthDatabaseHeader {
  readonly applicationId: number;
  readonly userVersion: number;
}

/**
 * **打开之前**的文件级校验：用 fd 只读前 100 字节，不经过 SQLite，也不把整个库读进内存。
 *
 * 提前分类能让错误码更准确，也能避免把"非本项目的库"交给 SQLite 去解释：
 * - 长度不足 / 魔数不符（含 0 字节文件）→ `auth-db-corrupt`；
 * - 魔数正确但 `application_id` 不是本项目 → `application-id-mismatch`。
 */
export function inspectAuthDatabaseFile(path: string): AuthDatabaseHeader {
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  let fd: number | undefined;
  let read = 0;
  try {
    fd = openSync(path, 'r');
    read = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
  } catch (error) {
    throw new AuthStorageError(
      'io-failed',
      `读取数据库文件头失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不改变"文件头是否可信"的结论 */
      }
    }
  }
  if (read < SQLITE_HEADER_BYTES) {
    throw new AuthStorageError(
      'auth-db-corrupt',
      `数据库文件不足 ${SQLITE_HEADER_BYTES} 字节（实际 ${read}），不是合法 SQLite 库`,
    );
  }
  if (header.subarray(0, 16).toString('latin1') !== SQLITE_FILE_HEADER) {
    throw new AuthStorageError('auth-db-corrupt', '数据库文件头魔数不符，不是 SQLite 库');
  }
  const applicationId = header.readUInt32BE(HEADER_APPLICATION_ID_OFFSET);
  if (applicationId !== AUTH_DB_APPLICATION_ID) {
    throw new AuthStorageError(
      'application-id-mismatch',
      `application_id=0x${applicationId.toString(16)} 不是本项目的认证库`,
    );
  }
  return {
    applicationId,
    userVersion: header.readUInt32BE(HEADER_USER_VERSION_OFFSET),
  };
}

export interface ApplyMigrationsOptions {
  readonly from: number;
  readonly to?: number;
  readonly migrations?: readonly AuthMigration[];
}

/**
 * 逐版事务迁移。
 *
 * 每版：`BEGIN IMMEDIATE` → 该版全部语句 → 写 `user_version` → `COMMIT`；
 * 任何一步失败都 `ROLLBACK` 并把版本号与 DDL 一起回滚，然后抛 `schema-migration-failed`。
 * 已是最新版或版本比当前高（需要切换构建）时直接抛错，绝不"降级"。
 */
export function applyAuthMigrations(db: DatabaseSync, options: ApplyMigrationsOptions): number {
  const migrations = options.migrations ?? AUTH_SCHEMA_MIGRATIONS;
  const target = options.to ?? authSchemaVersionOf(migrations);
  const from = options.from;

  if (!Number.isInteger(from) || from < 0) {
    throw new AuthStorageError('invalid-layout', `非法起始 schema 版本：${String(from)}`);
  }
  if (target < from) {
    throw new AuthStorageError('schema-future', `目标版本 ${target} 低于当前 ${from}，拒绝降级`);
  }
  if (target === from) return from;

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let version = from + 1; version <= target; version++) {
    const migration = ordered.find((entry) => entry.version === version);
    if (!migration) {
      throw new AuthStorageError('schema-future', `缺少第 ${version} 版迁移，无法到达 ${target}`);
    }
    try {
      db.exec('BEGIN IMMEDIATE;');
      for (const statement of migration.statements) db.exec(statement);
      writeAuthSchemaVersion(db, migration.version);
      db.exec('COMMIT;');
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* 连接可能已失效；回滚失败不改变"迁移失败"的结论 */
      }
      throw new AuthStorageError(
        'schema-migration-failed',
        `第 ${migration.version} 版迁移（${migration.name}）失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const applied = readAuthSchemaVersion(db);
  if (applied !== target) {
    throw new AuthStorageError(
      'schema-migration-failed',
      `迁移结束但 user_version=${applied}，期望 ${target}`,
    );
  }
  return applied;
}
