import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import { SCHEMA_VERSION } from './schema.ts';
import {
  SESSION_CLAIM_AUTHORITY_COLUMNS,
} from './session-snapshot.ts';
import {
  SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS,
  SESSION_STORAGE_PREDECESSOR_VERSION,
  SESSION_V16_STORAGE_REQUIRED_COLUMNS,
} from './session-storage-contract.ts';

export const SESSION_AUTHORITY_TABLE = 'session_authority';
export const SESSION_AUTHORITY_TRIGGER_PREFIX = 'session_authority_';
export const SESSION_AUTHORITY_MAX_REVISION = Number.MAX_SAFE_INTEGER;
const SESSION_AUTHORITY_SCHEMA_VERSION = 17;

export interface SessionAuthorityCoordinate {
  readonly generation: string;
  readonly revision: number;
}

const GENERATION_RE =
  /^session-db:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const OPERATIONS = Object.freeze(['delete', 'insert', 'update'] as const);
type AuthorityOperation = typeof OPERATIONS[number];
const AUTHORITY_GUARD_NAMES = Object.freeze({
  delete: 'session_authority_coordinate_delete_guard',
  insert: 'session_authority_coordinate_insert_guard',
  update: 'session_authority_coordinate_update_guard',
} as const);

const SESSION_AUTHORITY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation TEXT NOT NULL,
    revision INTEGER NOT NULL
      CHECK(revision >= 0 AND revision <= ${SESSION_AUTHORITY_MAX_REVISION})
  ) WITHOUT ROWID;
`;

function identifier(value: string): string {
  if (!IDENTIFIER_RE.test(value)) throw new Error('session-authority-identifier-invalid');
  return value;
}

function normalizeSql(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/;$/u, '');
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
  ).get(identifier(table)) !== undefined;
}

function requireTrackedColumns(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
): void {
  const actual = new Set((db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{
    name?: unknown;
  }>).map((row) => String(row.name ?? '')));
  const missing = columns.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(`session-authority-source-columns-invalid:${table}:${missing.join(',')}`);
  }
}

interface PersistentSchemaObject {
  readonly type: string;
  readonly sql: string;
}

function persistentSchemaObject(
  db: DatabaseSync,
  name: string,
): PersistentSchemaObject | null {
  const row = db.prepare(
    'SELECT type,sql FROM sqlite_master WHERE name=? COLLATE NOCASE LIMIT 1',
  ).get(identifier(name)) as { type?: unknown; sql?: unknown } | undefined;
  return typeof row?.type === 'string' && typeof row.sql === 'string'
    ? Object.freeze({ type: row.type, sql: row.sql })
    : null;
}

function requireOrdinaryPredecessorTable(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
  label: 'source' | 'director',
): void {
  const object = persistentSchemaObject(db, table);
  if (!object) {
    throw new Error(`session-predecessor-${label}-table-missing:${table}`);
  }
  const listed = db.prepare(
    "SELECT type FROM pragma_table_list WHERE schema='main' AND name=? COLLATE NOCASE LIMIT 1",
  ).get(identifier(table)) as { type?: unknown } | undefined;
  if (object.type !== 'table' || listed?.type !== 'table'
    || /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(object.sql)) {
    throw new Error(`session-predecessor-${label}-table-invalid:${table}`);
  }
  const actual = new Set((db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{
    name?: unknown;
  }>).map((row) => String(row.name ?? '')));
  const missing = columns.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(
      `session-predecessor-${label}-columns-invalid:${table}:${missing.join(',')}`,
    );
  }
}

/**
 * Read-only schema-v16 gate run before any v17 CREATE IF NOT EXISTS statement.
 *
 * A missing table/column is possible truth loss and must not be repaired as an
 * empty object. Director was optional in v16, but its two tables form one
 * lineage unit. Authority objects are exclusively v17 and therefore prove a
 * file was mislabeled or only partially downgraded.
 */
export function inspectSessionPredecessorV16Storage(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as {
    user_version?: unknown;
  } | undefined)?.user_version;
  if (version !== SESSION_STORAGE_PREDECESSOR_VERSION) {
    throw new Error('session-predecessor-schema-version-invalid');
  }
  if (persistentSchemaObject(db, SESSION_AUTHORITY_TABLE)) {
    throw new Error('session-predecessor-authority-object-invalid');
  }
  const authorityTrigger = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master
     WHERE type='trigger'
       AND (
         instr(lower(name), ?) = 1
         OR instr(lower(COALESCE(sql,'')), ?) > 0
       )
     LIMIT 1`,
  ).get(SESSION_AUTHORITY_TRIGGER_PREFIX, SESSION_AUTHORITY_TABLE);
  if (authorityTrigger) {
    throw new Error('session-predecessor-authority-trigger-invalid');
  }
  for (const [table, columns] of Object.entries(SESSION_V16_STORAGE_REQUIRED_COLUMNS)) {
    requireOrdinaryPredecessorTable(db, table, columns, 'source');
  }

  const director = Object.entries(SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS);
  const directorObjects = director.map(([table]) => persistentSchemaObject(db, table));
  if (directorObjects.every((object) => object === null)) return;
  if (directorObjects.some((object) => object === null)) {
    throw new Error('session-predecessor-director-table-set-invalid');
  }
  for (const [table, columns] of director) {
    requireOrdinaryPredecessorTable(db, table, columns, 'director');
  }
}

function trackedTables(
  db: DatabaseSync,
): ReadonlyArray<readonly [string, readonly string[]]> {
  const output: Array<readonly [string, readonly string[]]> = [];
  for (const [table, columns] of Object.entries(SESSION_CLAIM_AUTHORITY_COLUMNS)) {
    if (!tableExists(db, table)) {
      throw new Error(`session-authority-source-table-missing:${table}`);
    }
    requireTrackedColumns(db, table, columns);
    output.push(Object.freeze([table, columns] as const));
  }
  return Object.freeze(output);
}

function triggerName(table: string, operation: AuthorityOperation): string {
  return identifier(`${SESSION_AUTHORITY_TRIGGER_PREFIX}${identifier(table)}_${operation}`);
}

function triggerSql(
  table: string,
  columns: readonly string[],
  operation: AuthorityOperation,
  ifNotExists: boolean,
): string {
  const name = triggerName(table, operation);
  const event = operation === 'update'
    ? `UPDATE OF ${columns.map(identifier).join(',')}`
    : operation.toUpperCase();
  return `
    CREATE TRIGGER ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name}
    AFTER ${event} ON ${identifier(table)}
    BEGIN
      UPDATE session_authority
      SET revision = revision + 1
      WHERE singleton = 1;
      SELECT CASE WHEN changes() <> 1
        THEN RAISE(ABORT, 'session-authority-invalid') END;
    END;
  `;
}

function authorityGuardSql(
  operation: keyof typeof AUTHORITY_GUARD_NAMES,
  ifNotExists: boolean,
): string {
  const name = AUTHORITY_GUARD_NAMES[operation];
  const create = `CREATE TRIGGER ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name}`;
  if (operation === 'insert') {
    return `
      ${create}
      BEFORE INSERT ON session_authority
      WHEN EXISTS(SELECT 1 FROM session_authority)
      BEGIN
        SELECT RAISE(ABORT, 'session-authority-invalid');
      END;
    `;
  }
  if (operation === 'delete') {
    return `
      ${create}
      BEFORE DELETE ON session_authority
      BEGIN
        SELECT RAISE(ABORT, 'session-authority-invalid');
      END;
    `;
  }
  return `
    ${create}
    BEFORE UPDATE ON session_authority
    BEGIN
      SELECT CASE WHEN NOT (
        NEW.singleton = 1 AND OLD.singleton = 1
        AND NEW.generation = OLD.generation
        AND NEW.revision = OLD.revision + 1
      ) THEN RAISE(ABORT, 'session-authority-invalid') END;
    END;
  `;
}

function expectedTriggers(db: DatabaseSync): ReadonlyArray<Readonly<{
  name: string;
  sql: string;
}>> {
  const output: Array<{ name: string; sql: string }> = [];
  for (const [table, columns] of trackedTables(db)) {
    for (const operation of OPERATIONS) {
      output.push({
        name: triggerName(table, operation),
        sql: normalizeSql(triggerSql(table, columns, operation, false)),
      });
    }
  }
  for (const operation of Object.keys(AUTHORITY_GUARD_NAMES) as Array<
    keyof typeof AUTHORITY_GUARD_NAMES
  >) {
    output.push({
      name: AUTHORITY_GUARD_NAMES[operation],
      sql: normalizeSql(authorityGuardSql(operation, false)),
    });
  }
  output.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(output.map((row) => Object.freeze(row)));
}

function createExpectedTriggers(db: DatabaseSync): void {
  for (const [table, columns] of trackedTables(db)) {
    for (const operation of OPERATIONS) {
      db.exec(triggerSql(table, columns, operation, true));
    }
  }
  for (const operation of Object.keys(AUTHORITY_GUARD_NAMES) as Array<
    keyof typeof AUTHORITY_GUARD_NAMES
  >) {
    db.exec(authorityGuardSql(operation, true));
  }
}

/**
 * Validates the exact trigger set before a Session-owned adapter opens. It is
 * deliberately a no-op for legacy/raw SQLite handles that do not have the
 * schema-v17 authority table. It must never repair in-place: after an
 * untracked write, only writable MemoryDb reopen may rebuild triggers while
 * rotating generation so an old coordinate cannot become valid again.
 */
export function validateSessionAuthorityForOwnedAdapter(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const version = row?.user_version;
  if (!Number.isSafeInteger(version)) throw new Error('session-schema-version-invalid');
  if (Number(version) > SCHEMA_VERSION) throw new Error('session-schema-too-new');
  if (!tableExists(db, SESSION_AUTHORITY_TABLE)
    && Number(version) < SESSION_AUTHORITY_SCHEMA_VERSION) return false;
  inspectSessionAuthoritySchema(db);
  return true;
}

function rebuildSessionAuthorityTriggers(db: DatabaseSync): void {
  for (const [table] of [
    ...Object.entries(SESSION_CLAIM_AUTHORITY_COLUMNS),
  ]) {
    for (const operation of OPERATIONS) {
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName(table, operation)};`);
    }
  }
  for (const name of Object.values(AUTHORITY_GUARD_NAMES)) {
    db.exec(`DROP TRIGGER IF EXISTS ${name};`);
  }
  createExpectedTriggers(db);
}

function sessionAuthorityTableAndCoordinate(
  db: DatabaseSync,
): SessionAuthorityCoordinate {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_authority'",
  ).get() as { sql?: unknown } | undefined;
  const expectedTableSql = normalizeSql(SESSION_AUTHORITY_TABLE_SQL.replace('IF NOT EXISTS ', ''));
  if (!table || typeof table.sql !== 'string' || normalizeSql(table.sql) !== expectedTableSql) {
    throw new Error('session-authority-table-invalid');
  }
  const columns = (db.prepare('PRAGMA table_info(session_authority)').all() as Array<{
    name?: unknown;
  }>).map((row) => String(row.name ?? ''));
  if (columns.join(',') !== 'singleton,generation,revision') {
    throw new Error('session-authority-table-invalid');
  }
  const rows = db.prepare(
    'SELECT singleton,generation,revision FROM session_authority',
  ).all() as Array<{ singleton?: unknown; generation?: unknown; revision?: unknown }>;
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1
    || typeof row.generation !== 'string' || !GENERATION_RE.test(row.generation)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || Number(row.revision) > SESSION_AUTHORITY_MAX_REVISION) {
    throw new Error('session-authority-coordinate-invalid');
  }
  return Object.freeze({
    generation: row.generation,
    revision: Number(row.revision),
  });
}

/** Read-only preflight before current-schema startup executes any repair DDL. */
export function inspectSessionAuthorityStorage(db: DatabaseSync): void {
  sessionAuthorityTableAndCoordinate(db);
  trackedTables(db);
}

/** Exact schema validation shared by writable startup and snapshot capture. */
export function inspectSessionAuthoritySchema(db: DatabaseSync): void {
  inspectSessionAuthorityStorage(db);
  const expected = expectedTriggers(db);
  const all = db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all() as Array<{ name?: unknown; sql?: unknown }>;
  const temporary = db.prepare(
    "SELECT name,sql FROM sqlite_temp_master WHERE type='trigger' ORDER BY name",
  ).all() as Array<{ name?: unknown; sql?: unknown }>;
  const actual = [...all, ...temporary].flatMap((row) => {
    const name = typeof row.name === 'string' ? row.name : '';
    const sql = typeof row.sql === 'string' ? normalizeSql(row.sql) : '';
    return name.startsWith(SESSION_AUTHORITY_TRIGGER_PREFIX)
      || sql.includes(SESSION_AUTHORITY_TABLE)
      ? [{ name, sql }]
      : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (actual.length !== expected.length) {
    throw new Error('session-authority-trigger-set-invalid');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index]?.name !== expected[index]?.name
      || actual[index]?.sql !== expected[index]?.sql) {
      throw new Error('session-authority-trigger-definition-invalid');
    }
  }
}

/** Schema-v17 migration primitive. Existing Session facts are never rewritten. */
export function ensureSessionAuthorityV17(db: DatabaseSync): void {
  db.exec(SESSION_AUTHORITY_TABLE_SQL);
  const exists = db.prepare(
    'SELECT 1 AS ok FROM session_authority WHERE singleton=1',
  ).get();
  if (!exists) {
    db.prepare(
      'INSERT INTO session_authority(singleton,generation,revision) VALUES(1,?,0)',
    ).run(`session-db:${randomUUID()}`);
  }
  rebuildSessionAuthorityTriggers(db);
  inspectSessionAuthoritySchema(db);
}

/** Point-in-time observation only; no lock survives this call. */
export function readSessionAuthorityCoordinate(db: DatabaseSync): SessionAuthorityCoordinate {
  return sessionAuthorityTableAndCoordinate(db);
}

/**
 * Every writable MemoryDb open gets a new lineage generation. The previous
 * coordinate and exact trigger set are validated/repaired under one writer
 * reservation before the generation is replaced.
 */
export function rotateSessionAuthorityGeneration(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = sessionAuthorityTableAndCoordinate(db);
    rebuildSessionAuthorityTriggers(db);
    inspectSessionAuthoritySchema(db);
    let nextGeneration = `session-db:${randomUUID()}`;
    while (nextGeneration === prior.generation) nextGeneration = `session-db:${randomUUID()}`;
    // Ordinary DML may never change generation. The schema owner opens this
    // one transaction-local rotation window while holding the writer lock;
    // SQLite rolls the DROP back too if any later step fails.
    db.exec(`DROP TRIGGER ${AUTHORITY_GUARD_NAMES.update};`);
    const result = db.prepare(
      'UPDATE session_authority SET generation=? WHERE singleton=1',
    ).run(nextGeneration);
    if (result.changes !== 1) throw new Error('session-authority-coordinate-invalid');
    db.exec(authorityGuardSql('update', false));
    inspectSessionAuthoritySchema(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function sessionFenceAsync() {});
const GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(function* sessionFenceGenerator() {});
const ASYNC_GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(
  async function* sessionFenceAsyncGenerator() {},
);

/** Mark only an ordinary native Promise handled; never assimilate a foreign thenable. */
function observeOrdinaryPromise(value: unknown): void {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) return;
  const originalConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  const intrinsicConstructor = Object.getOwnPropertyDescriptor(
    INTRINSIC_PROMISE.prototype,
    'constructor',
  );
  const intrinsicSpecies = Object.getOwnPropertyDescriptor(INTRINSIC_PROMISE, Symbol.species);
  if (!intrinsicConstructor || !Object.hasOwn(intrinsicConstructor, 'value')
    || intrinsicConstructor.value !== INTRINSIC_PROMISE
    || !intrinsicSpecies || intrinsicSpecies.get !== INTRINSIC_PROMISE_SPECIES
    || intrinsicSpecies.set !== undefined) return;

  let shadowedConstructor = false;
  try {
    if (!originalConstructor && Object.getPrototypeOf(value) === INTRINSIC_PROMISE.prototype) {
      void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
      return;
    }
    if (!originalConstructor || originalConstructor.configurable
      || (Object.hasOwn(originalConstructor, 'value') && originalConstructor.writable === true)) {
      Object.defineProperty(value, 'constructor', {
        configurable: originalConstructor?.configurable ?? true,
        enumerable: originalConstructor?.enumerable ?? false,
        value: INTRINSIC_PROMISE,
        writable: originalConstructor && Object.hasOwn(originalConstructor, 'value')
          ? originalConstructor.writable
          : true,
      });
      shadowedConstructor = true;
    } else if (!Object.hasOwn(originalConstructor, 'value')
      || originalConstructor.value !== INTRINSIC_PROMISE) return;
    void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
  } catch {
    // The value is already rejected as invalid synchronous authority.
  } finally {
    if (shadowedConstructor) {
      try {
        if (originalConstructor) Object.defineProperty(value, 'constructor', originalConstructor);
        else Reflect.deleteProperty(value, 'constructor');
      } catch {
        // Native non-Proxy Promises have ordinary property semantics.
      }
    }
  }
}

export function sessionFenceResultIsAsynchronous(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (nodeTypes.isProxy(value) || nodeTypes.isGeneratorObject(value)) return true;
  if (nodeTypes.isPromise(value)) {
    observeOrdinaryPromise(value);
    return true;
  }
  let current: object | null = value;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) return true;
    const then = Object.getOwnPropertyDescriptor(current, 'then');
    if (then) return !Object.hasOwn(then, 'value') || typeof then.value === 'function';
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

export function sessionFenceCallbackIsDeferred(
  callback: (...args: never[]) => unknown,
): boolean {
  if (nodeTypes.isAsyncFunction(callback) || nodeTypes.isGeneratorFunction(callback)) return true;
  const prototype = Object.getPrototypeOf(callback);
  return prototype === ASYNC_FUNCTION_PROTOTYPE
    || prototype === GENERATOR_FUNCTION_PROTOTYPE
    || prototype === ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
}

export function sessionFenceCallbackIsProxy(value: unknown): boolean {
  return typeof value === 'function' && nodeTypes.isProxy(value);
}
