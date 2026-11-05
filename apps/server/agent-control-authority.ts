import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const AGENT_CONTROL_AUTHORITY_MAX_REVISION = Number.MAX_SAFE_INTEGER;
export const AGENT_MAINTENANCE_COHORT_GENERATION =
  'agent-loop-maintenance-correction-canary-epoch-v2' as const;
export const AGENT_MAINTENANCE_ROUTE_STATES = Object.freeze([
  'off', 'canary-5', 'canary-25', 'canary-50', 'on', 'killed',
] as const);
export type AgentMaintenanceRouteState = typeof AGENT_MAINTENANCE_ROUTE_STATES[number];

export interface AgentControlAuthorityCoordinate {
  readonly generation: string;
  readonly revision: number;
}

export interface AgentMaintenanceRouteControl {
  readonly cohortGeneration: typeof AGENT_MAINTENANCE_COHORT_GENERATION;
  readonly state: AgentMaintenanceRouteState;
  readonly targetSessionId: string | null;
  readonly evidenceDigest: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

const PREFIX = 'agent_control_authority_';
const GENERATION_RE =
  /^agent-control:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGET_SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const OPS = ['delete', 'insert', 'update'] as const;
type Op = typeof OPS[number];

const TRACKED_V10: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agent_lane_control: ['lane', 'desired_state', 'killed_reason', 'updated_at'],
  agent_capability_control: ['capability_id', 'killed_reason', 'updated_at'],
  agent_lane_authorization_window: [
    'lane', 'window_sequence', 'max_provider_calls', 'provider_calls',
    'reserved_provider_calls', 'provider_errors', 'invalid_calls',
    'qualifying_samples', 'status', 'opened_at', 'closed_at', 'superseded_at',
    'superseded_reason',
  ],
  agent_lane_provider_reservation: [
    'reservation_digest', 'lane', 'window_sequence', 'idempotency_key_digest',
    'request_digest', 'lane_control_revision', 'reserved_provider_calls',
    'settled_provider_calls', 'status', 'created_at', 'deadline_at', 'started_at',
    'settled_at',
  ],
  agent_maintenance_route_control: ['state', 'revision', 'updated_at'],
});
const TRACKED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...TRACKED_V10,
  agent_lane_evaluation: [
    'lane', 'suite_digest', 'evaluation_version', 'evidence_class', 'passed',
    'captured_at', 'recorded_at',
  ],
  agent_maintenance_route_control: [
    'state', 'target_session_id', 'evidence_digest', 'revision', 'updated_at',
  ],
});
export const AGENT_CONTROL_AUTHORITY_TABLE_SQL = `
  CREATE TABLE agent_control_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(
      revision >= 0 AND revision <= ${AGENT_CONTROL_AUTHORITY_MAX_REVISION}
    )
  ) WITHOUT ROWID;
`;
export const AGENT_MAINTENANCE_ROUTE_V10_TABLE_SQL = `
  CREATE TABLE agent_maintenance_route_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    cohort_generation TEXT NOT NULL CHECK(
      cohort_generation = '${AGENT_MAINTENANCE_COHORT_GENERATION}'
    ),
    state TEXT NOT NULL CHECK(
      state IN ('off','canary-5','canary-25','canary-50','on','killed')
    ),
    revision INTEGER NOT NULL CHECK(
      revision >= 0 AND revision <= ${AGENT_CONTROL_AUTHORITY_MAX_REVISION}
    ),
    updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
`;
export const AGENT_MAINTENANCE_ROUTE_TABLE_SQL = `
  CREATE TABLE agent_maintenance_route_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    cohort_generation TEXT NOT NULL CHECK(
      cohort_generation = '${AGENT_MAINTENANCE_COHORT_GENERATION}'
    ),
    state TEXT NOT NULL CHECK(
      state IN ('off','canary-5','canary-25','canary-50','on','killed')
    ),
    target_session_id TEXT,
    evidence_digest TEXT,
    revision INTEGER NOT NULL CHECK(
      revision >= 0 AND revision <= ${AGENT_CONTROL_AUTHORITY_MAX_REVISION}
    ),
    updated_at TEXT NOT NULL,
    CHECK(
      (state = 'canary-5' AND target_session_id IS NOT NULL AND evidence_digest IS NOT NULL)
      OR
      (state <> 'canary-5' AND target_session_id IS NULL AND evidence_digest IS NULL)
    ),
    CHECK(
      target_session_id IS NULL OR (
        length(target_session_id) BETWEEN 14 AND 32
        AND substr(target_session_id,1,8) = 'session-'
        AND substr(target_session_id,9) NOT GLOB '*[^0-9]*'
      )
    ),
    CHECK(
      evidence_digest IS NULL OR (
        length(evidence_digest) = 71
        AND substr(evidence_digest,1,7) = 'sha256:'
        AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'
      )
    )
  ) WITHOUT ROWID;
`;
export const AGENT_ASSET_MUTATION_PENDING_TABLE_SQL = `
  CREATE TABLE agent_asset_mutation_pending (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    mutation_id TEXT NOT NULL,
    started_at TEXT NOT NULL
  ) WITHOUT ROWID;
`;
export const AGENT_CONTROL_V10_SQL = `
  ${AGENT_CONTROL_AUTHORITY_TABLE_SQL}
  ${AGENT_MAINTENANCE_ROUTE_V10_TABLE_SQL}
  ${AGENT_ASSET_MUTATION_PENDING_TABLE_SQL}
`;
export const AGENT_CONTROL_V11_SQL = `
  ${AGENT_CONTROL_AUTHORITY_TABLE_SQL}
  ${AGENT_MAINTENANCE_ROUTE_TABLE_SQL}
  ${AGENT_ASSET_MUTATION_PENDING_TABLE_SQL}
`;

export function isAgentMaintenanceRouteTargetSessionId(value: unknown): value is string {
  return typeof value === 'string' && TARGET_SESSION_ID_RE.test(value);
}

export function isAgentMaintenanceRouteEvidenceDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

const normalizeSql = (sql: string): string => (
  sql.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/;$/u, '')
);
const trackedTriggerName = (table: string, operation: Op): string => (
  `${PREFIX}${table}_${operation}`
);
function trackedTriggerSql(
  table: string,
  columns: readonly string[],
  operation: Op,
): string {
  const event = operation === 'update'
    ? `UPDATE OF ${columns.join(',')}`
    : operation.toUpperCase();
  return `CREATE TRIGGER ${trackedTriggerName(table, operation)} AFTER ${event} ON ${table} BEGIN UPDATE agent_control_authority SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'agent-control-authority-invalid') END; END;`;
}

const AUTHORITY_GUARD_NAMES = {
  delete: `${PREFIX}coordinate_delete_guard`,
  insert: `${PREFIX}coordinate_insert_guard`,
  update: `${PREFIX}coordinate_update_guard`,
} as const;
const ROUTE_GUARD_NAMES = {
  delete: `${PREFIX}route_delete_guard`,
  insert: `${PREFIX}route_insert_guard`,
  update: `${PREFIX}route_update_guard`,
} as const;

function guardSql(
  kind: 'authority' | 'route',
  operation: Op,
  routeVersion: 10 | 11 = 11,
): string {
  const table = kind === 'authority'
    ? 'agent_control_authority'
    : 'agent_maintenance_route_control';
  const name = kind === 'authority'
    ? AUTHORITY_GUARD_NAMES[operation]
    : ROUTE_GUARD_NAMES[operation];
  if (operation === 'insert') {
    return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table}) BEGIN SELECT RAISE(ABORT,'agent-control-authority-invalid'); END;`;
  }
  if (operation === 'delete') {
    return `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'agent-control-authority-invalid'); END;`;
  }
  if (kind === 'authority') {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT CASE WHEN NOT(NEW.singleton=1 AND OLD.singleton=1 AND NEW.generation=OLD.generation AND NEW.revision=OLD.revision+1) THEN RAISE(ABORT,'agent-control-authority-invalid') END; END;`;
  }
  const binding = routeVersion === 10
    ? ''
    : " AND ((NEW.state='canary-5' AND NEW.target_session_id IS NOT NULL AND NEW.evidence_digest IS NOT NULL) OR (NEW.state<>'canary-5' AND NEW.target_session_id IS NULL AND NEW.evidence_digest IS NULL))";
  return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT CASE WHEN NOT(NEW.singleton=1 AND OLD.singleton=1 AND NEW.cohort_generation=OLD.cohort_generation AND NEW.state IN ('off','canary-5','canary-25','canary-50','on','killed')${binding} AND NEW.revision=OLD.revision+1 AND NEW.updated_at>OLD.updated_at) THEN RAISE(ABORT,'agent-control-authority-invalid') END; END;`;
}
function createTriggers(
  db: DatabaseSync,
  tracked: Readonly<Record<string, readonly string[]>>,
  routeVersion: 10 | 11,
): void {
  for (const [table, columns] of Object.entries(tracked)) {
    for (const operation of OPS) db.exec(trackedTriggerSql(table, columns, operation));
  }
  for (const operation of OPS) {
    db.exec(guardSql('authority', operation, routeVersion));
    db.exec(guardSql('route', operation, routeVersion));
  }
}
export function createAgentControlAuthorityV10Triggers(db: DatabaseSync): void {
  createTriggers(db, TRACKED_V10, 10);
}
export function createAgentControlAuthorityTriggers(db: DatabaseSync): void {
  createTriggers(db, TRACKED, 11);
}

interface ExpectedTrigger {
  readonly name: string;
  readonly sql: string;
}

function expectedTriggers(
  tracked: Readonly<Record<string, readonly string[]>>,
  routeVersion: 10 | 11,
): ExpectedTrigger[] {
  const expected: ExpectedTrigger[] = [];
  for (const [table, columns] of Object.entries(tracked)) {
    for (const operation of OPS) {
      expected.push({
        name: trackedTriggerName(table, operation),
        sql: normalizeSql(trackedTriggerSql(table, columns, operation)),
      });
    }
  }
  for (const operation of OPS) {
    expected.push(
      {
        name: AUTHORITY_GUARD_NAMES[operation],
        sql: normalizeSql(guardSql('authority', operation, routeVersion)),
      },
      {
        name: ROUTE_GUARD_NAMES[operation],
        sql: normalizeSql(guardSql('route', operation, routeVersion)),
      },
    );
  }
  return expected.sort((left, right) => left.name.localeCompare(right.name));
}

function inspectTriggers(
  db: DatabaseSync,
  tracked: Readonly<Record<string, readonly string[]>>,
  routeVersion: 10 | 11,
): void {
  const expected = expectedTriggers(tracked, routeVersion);
  const mainTriggerRows = db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger'",
  ).all() as Array<{ name?: unknown; sql?: unknown }>;
  const tempTriggerRows = db.prepare(
    "SELECT name,sql FROM sqlite_temp_master WHERE type='trigger'",
  ).all() as Array<{ name?: unknown; sql?: unknown }>;
  const triggerRows = [...mainTriggerRows, ...tempTriggerRows];
  const actual = triggerRows.flatMap((row): ExpectedTrigger[] => {
    const name = typeof row.name === 'string' ? row.name : '';
    const sql = typeof row.sql === 'string' ? normalizeSql(row.sql) : '';
    return name.startsWith(PREFIX) || sql.includes('agent_control_authority')
      ? [{ name, sql }]
      : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (actual.length !== expected.length) {
    throw new Error('agent-control-authority-trigger-set-invalid');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index]?.name !== expected[index]?.name
      || actual[index]?.sql !== expected[index]?.sql) {
      throw new Error('agent-control-authority-trigger-definition-invalid');
    }
  }
}

function inspectExactTable(
  db: DatabaseSync,
  name: string,
  sql: string,
  expectedColumns: string,
): void {
  const row = db.prepare(
    'SELECT type,sql FROM sqlite_master WHERE name=? COLLATE NOCASE LIMIT 1',
  ).get(name) as { type?: unknown; sql?: unknown } | undefined;
  const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name?: unknown }>)
    .map((value) => String(value.name ?? ''))
    .join(',');
  if (row?.type !== 'table' || typeof row.sql !== 'string'
    || normalizeSql(row.sql) !== normalizeSql(sql) || columns !== expectedColumns) {
    throw new Error(`agent-control-authority-table-invalid:${name}`);
  }
}
export function inspectAgentControlAuthoritySchema(db: DatabaseSync): void {
  inspectExactTable(
    db,
    'agent_control_authority',
    AGENT_CONTROL_AUTHORITY_TABLE_SQL,
    'singleton,generation,revision',
  );
  inspectExactTable(
    db,
    'agent_maintenance_route_control',
    AGENT_MAINTENANCE_ROUTE_TABLE_SQL,
    'singleton,cohort_generation,state,target_session_id,evidence_digest,revision,updated_at',
  );
  inspectExactTable(
    db,
    'agent_asset_mutation_pending',
    AGENT_ASSET_MUTATION_PENDING_TABLE_SQL,
    'singleton,mutation_id,started_at',
  );
  readAgentControlAuthority(db);
  readAgentMaintenanceRouteControl(db);
  inspectTriggers(db, TRACKED, 11);
}

export function inspectAgentControlAuthoritySchemaV10(db: DatabaseSync): void {
  inspectExactTable(
    db,
    'agent_control_authority',
    AGENT_CONTROL_AUTHORITY_TABLE_SQL,
    'singleton,generation,revision',
  );
  inspectExactTable(
    db,
    'agent_maintenance_route_control',
    AGENT_MAINTENANCE_ROUTE_V10_TABLE_SQL,
    'singleton,cohort_generation,state,revision,updated_at',
  );
  inspectExactTable(
    db,
    'agent_asset_mutation_pending',
    AGENT_ASSET_MUTATION_PENDING_TABLE_SQL,
    'singleton,mutation_id,started_at',
  );
  readAgentControlAuthority(db);
  readAgentMaintenanceRouteControlV10(db);
  inspectTriggers(db, TRACKED_V10, 10);
}
export function readAgentControlAuthority(
  db: DatabaseSync,
): AgentControlAuthorityCoordinate {
  const rows = db.prepare(
    'SELECT singleton,generation,revision FROM agent_control_authority',
  ).all() as Array<Record<string, unknown>>;
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1
    || typeof row.generation !== 'string' || !GENERATION_RE.test(row.generation)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || Number(row.revision) > AGENT_CONTROL_AUTHORITY_MAX_REVISION) {
    throw new Error('agent-control-authority-coordinate-invalid');
  }
  return Object.freeze({
    generation: row.generation,
    revision: Number(row.revision),
  });
}

function readAgentMaintenanceRouteControlV10(db: DatabaseSync): void {
  const rows = db.prepare(
    'SELECT singleton,cohort_generation,state,revision,updated_at '
      + 'FROM agent_maintenance_route_control',
  ).all() as Array<Record<string, unknown>>;
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1
    || row.cohort_generation !== AGENT_MAINTENANCE_COHORT_GENERATION
    || typeof row.state !== 'string'
    || !AGENT_MAINTENANCE_ROUTE_STATES.includes(row.state as AgentMaintenanceRouteState)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || Number(row.revision) > AGENT_CONTROL_AUTHORITY_MAX_REVISION
    || typeof row.updated_at !== 'string'
    || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new Error('agent-control-maintenance-route-invalid');
  }
}

export function readAgentMaintenanceRouteControl(
  db: DatabaseSync,
): AgentMaintenanceRouteControl {
  const rows = db.prepare(
    'SELECT singleton,cohort_generation,state,target_session_id,evidence_digest,'
      + 'revision,updated_at '
      + 'FROM agent_maintenance_route_control',
  ).all() as Array<Record<string, unknown>>;
  const row = rows[0];
  const canaryBound = row?.state === 'canary-5'
    && isAgentMaintenanceRouteTargetSessionId(row.target_session_id)
    && isAgentMaintenanceRouteEvidenceDigest(row.evidence_digest);
  const closedUnbound = row?.state !== 'canary-5'
    && row?.target_session_id === null
    && row.evidence_digest === null;
  if (rows.length !== 1 || row?.singleton !== 1
    || row.cohort_generation !== AGENT_MAINTENANCE_COHORT_GENERATION
    || typeof row.state !== 'string'
    || !AGENT_MAINTENANCE_ROUTE_STATES.includes(row.state as AgentMaintenanceRouteState)
    || (!canaryBound && !closedUnbound)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || Number(row.revision) > AGENT_CONTROL_AUTHORITY_MAX_REVISION
    || typeof row.updated_at !== 'string'
    || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new Error('agent-control-maintenance-route-invalid');
  }
  return Object.freeze({
    cohortGeneration: AGENT_MAINTENANCE_COHORT_GENERATION,
    state: row.state as AgentMaintenanceRouteState,
    targetSessionId: row.target_session_id as string | null,
    evidenceDigest: row.evidence_digest as string | null,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  });
}

export function rotateAgentControlAuthorityGeneration(db: DatabaseSync): void {
  const previous = readAgentControlAuthority(db);
  let generation = `agent-control:${randomUUID()}`;
  while (generation === previous.generation) {
    generation = `agent-control:${randomUUID()}`;
  }
  db.exec(`DROP TRIGGER ${AUTHORITY_GUARD_NAMES.update}`);
  const result = db.prepare(
    'UPDATE agent_control_authority SET generation=? WHERE singleton=1',
  ).run(generation);
  if (result.changes !== 1) {
    throw new Error('agent-control-authority-coordinate-invalid');
  }
  db.exec(guardSql('authority', 'update'));
}

export function advanceAgentControlAuthority(db: DatabaseSync): void {
  const result = db.prepare(
    'UPDATE agent_control_authority SET revision=revision+1 WHERE singleton=1',
  ).run();
  if (result.changes !== 1) {
    throw new Error('agent-control-authority-coordinate-invalid');
  }
}
