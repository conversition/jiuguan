/** Metadata-only recovery hints. Discovery never grants execution, replay or settlement authority. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StyleCompileRecoverySessionPage {
  readonly sessionIds: readonly string[];
  /** Last examined filename only when another metadata page remains. */
  readonly nextCursor: string | null;
  readonly failed: number;
}

const MAX_PAGE_SIZE = 256;
const REQUIRED_COLUMNS = ['session_key', 'control_key', 'value', 'updated_at'] as const;
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

function validFileName(value: string): boolean {
  return value.length > 3 && value.length <= 240 && value === value.trim()
    && !/[<>:"|?*\u0000-\u001f\u007f/\\]/u.test(value)
    && value.endsWith('.db') && !['.', '..'].includes(value.slice(0, -3));
}

/** Internal fixed SQL expressions only; no user values are interpolated into this predicate. */
function canonicalTimestampSql(value: string): string {
  return `typeof(${value})='text' AND length(CAST(${value} AS BLOB))=24
    AND ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(${value},12,2) BETWEEN '00' AND '23'
    AND substr(${value},15,2) BETWEEN '00' AND '59'
    AND substr(${value},18,2) BETWEEN '00' AND '59'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',${value}) IS ${value}`;
}

// Only an existence bit crosses the SQLite boundary. Malformed/future metadata remains a hint
// for the owning Memory parser; a merely present receipt cannot conceal such a journal. The
// closed shape checks here are intentionally not a replacement for that parser's exact contract.
const HAS_UNSETTLED_INTENT_SQL = `
SELECT 1 AS present FROM session_control AS i
WHERE i.session_key = ? AND i.control_key GLOB 'style_compile_intent:*'
AND CASE
  WHEN typeof(i.value) <> 'text' OR length(i.value) > 32768 THEN 1
  WHEN json_valid(i.value) <> 1 THEN 1
  WHEN json_extract(i.value, '$.journalVersion') IS NOT 'style-compile-intent-journal-v1'
    OR json_type(i.value) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(i.value)) <> 7
    OR json_type(i.value, '$.payload') IS NOT 'object'
    OR json_extract(i.value, '$.payload.version') IS NOT 'style-compile-intent-v1'
    OR json_extract(i.value, '$.payload.rawSessionId') IS NOT i.session_key
    OR json_extract(i.value, '$.payload.runId') IS NOT substr(i.control_key, 22)
    OR (${canonicalTimestampSql("json_extract(i.value, '$.payload.committedAt')")}) IS NOT 1
    OR json_type(i.value, '$.packetDigest') IS NOT 'text'
    OR length(json_extract(i.value, '$.packetDigest')) <> 71
    OR substr(json_extract(i.value, '$.packetDigest'), 1, 7) <> 'sha256:'
    OR substr(json_extract(i.value, '$.packetDigest'), 8) GLOB '*[^0-9a-f]*'
    OR json_type(i.value, '$.state') IS NOT 'text'
    OR json_extract(i.value, '$.state') NOT IN ('pending', 'delivered', 'invalidated') THEN 1
  ELSE NOT EXISTS (
    SELECT 1 FROM session_control AS r
    WHERE r.session_key = i.session_key
      AND r.control_key = 'style_compile_settlement:' || substr(i.control_key, 22)
      AND CASE
        WHEN typeof(r.value) <> 'text' OR length(r.value) > 32768 THEN 0
        WHEN json_valid(r.value) <> 1 THEN 0
        ELSE json_type(r.value) = 'object'
          AND json_extract(r.value, '$.version') = 'style-compile-settlement-v1'
          AND json_extract(r.value, '$.runId') = substr(i.control_key, 22)
          AND json_extract(r.value, '$.packetDigest') = json_extract(i.value, '$.packetDigest')
          AND json_type(r.value, '$.closedAt') = 'text'
          AND (${canonicalTimestampSql("json_extract(r.value, '$.closedAt')")})
          AND json_extract(r.value, '$.closedAt') >= json_extract(i.value, '$.payload.committedAt')
          AND json_type(r.value, '$.result') = 'object'
          AND (SELECT count(*) FROM json_each(r.value)) = 5
          AND CASE json_extract(r.value, '$.result.status')
            WHEN 'created' THEN json_type(r.value, '$.result.proposalId') = 'text'
              AND length(json_extract(r.value, '$.result.proposalId')) BETWEEN 1 AND 240
              AND (SELECT count(*) FROM json_each(r.value, '$.result')) = 2
            WHEN 'unknown' THEN json_type(r.value, '$.result.attempted') IN ('true', 'null')
              AND (SELECT count(*) FROM json_each(r.value, '$.result')) = 2
            WHEN 'rejected' THEN (SELECT count(*) FROM json_each(r.value, '$.result')) = 1
            WHEN 'skipped' THEN (SELECT count(*) FROM json_each(r.value, '$.result')) = 1
            WHEN 'cancelled' THEN (SELECT count(*) FROM json_each(r.value, '$.result')) = 1
            ELSE 0 END
          AND r.value = json_object(
            'version', 'style-compile-settlement-v1',
            'runId', json_extract(r.value, '$.runId'),
            'packetDigest', json_extract(r.value, '$.packetDigest'),
            'result', json(CASE json_extract(r.value, '$.result.status')
              WHEN 'created' THEN json_object('status', 'created',
                'proposalId', json_extract(r.value, '$.result.proposalId'))
              WHEN 'unknown' THEN CASE json_type(r.value, '$.result.attempted')
                WHEN 'true' THEN '{"status":"unknown","attempted":true}'
                ELSE '{"status":"unknown","attempted":null}' END
              ELSE json_object('status', json_extract(r.value, '$.result.status')) END),
            'closedAt', json_extract(r.value, '$.closedAt'))
      END = 1
  ) END = 1
LIMIT 1`;

/**
 * One bounded page of filenames, not an unbounded search for `limit` matching Sessions. Missing
 * or unsupported stores are never created, migrated, hydrated, or read for conversation prose.
 */
export function scanStyleCompileRecoverySessions(options: Readonly<{
  dataDir: string;
  cursor: string | null;
  limit: number;
  resolveDatabase(fileName: string): string | null;
  allowed(rawSessionId: string): boolean;
}>): StyleCompileRecoverySessionPage {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_PAGE_SIZE) {
    throw new TypeError('style-compile-inventory-limit-invalid');
  }
  if (options.cursor !== null && (typeof options.cursor !== 'string' || options.cursor.length < 4
    || options.cursor.length > 255 || /[\u0000/\\]/u.test(options.cursor) || !options.cursor.endsWith('.db'))) {
    throw new TypeError('style-compile-inventory-cursor-invalid');
  }
  const sessionIds: string[] = [];
  let failed = 0;
  const result = (nextCursor: string | null): StyleCompileRecoverySessionPage => Object.freeze({
    sessionIds: Object.freeze([...sessionIds]), nextCursor, failed,
  });
  const root = resolve(options.dataDir);
  let files: string[];
  let canonicalRoot: string;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) { failed += 1; return result(null); }
    canonicalRoot = realpathSync(root);
    files = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name)
      .filter((name) => name.endsWith('.db'))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .filter((name) => options.cursor === null || name > options.cursor);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) failed += 1;
    return result(null);
  }
  const page = files.slice(0, options.limit);
  for (const fileName of page) {
    let db: DatabaseSync | undefined;
    try {
      if (!validFileName(fileName)) { failed += 1; continue; }
      const rawSessionId = fileName.slice(0, -3);
      if (!options.allowed(rawSessionId)) continue;
      const path = options.resolveDatabase(fileName);
      if (!path || !isAbsolute(path) || !samePath(path, join(root, fileName))) { failed += 1; continue; }
      const fileStat = lstatSync(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()
        || !samePath(realpathSync(path), join(canonicalRoot, fileName))) { failed += 1; continue; }
      db = new DatabaseSync(path, { readOnly: true });
      const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='session_control' LIMIT 1").get();
      if (!table) continue;
      const columns = db.prepare('PRAGMA table_info(session_control)').all() as { name: string }[];
      if (!REQUIRED_COLUMNS.every((column) => columns.some((value) => value.name === column))) {
        failed += 1;
        continue;
      }
      if (db.prepare(HAS_UNSETTLED_INTENT_SQL).get(rawSessionId)) sessionIds.push(rawSessionId);
    } catch { failed += 1; /* A corrupt, removed or inaccessible file cannot starve the next page. */ }
    finally {
      try { db?.close(); } catch { failed += 1; }
    }
  }
  return result(files.length > page.length ? page.at(-1)! : null);
}
