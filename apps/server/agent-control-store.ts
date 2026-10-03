import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_SUBCAPABILITY_IDS,
  type AgentSubcapabilityId,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  AGENT_LANE_OBSERVATION_VERSION,
  AGENT_LANE_PERMANENT_KILL_REASONS,
  AGENT_LANE_QUALITY_KILL_REASONS,
  AGENT_ROLLOUT_LANES,
  AGENT_ROLLOUT_STATES,
  evaluateAgentLaneRollout,
  type AgentLaneDecision,
  type AgentLaneEvidence,
  type AgentRolloutLane,
  type AgentRolloutState,
  AGENT_ROLLOUT_THRESHOLDS,
  AGENT_TEST_SESSION_WINDOW_CALLS,
} from '../../packages/agent-policy/src/lane-rollout.ts';

export const AGENT_CONTROL_DB_FILE = 'agent-control.sqlite';
export const AGENT_CONTROL_SCHEMA_VERSION = 6;
export const AGENT_CONTROL_APPLICATION_ID = 0x4a474143; // JGAC

export interface AgentLaneControlRow {
  readonly lane: AgentRolloutLane;
  readonly desiredState: AgentRolloutState;
  readonly killedReason: string | null;
  /** Opaque compare-and-swap token. It contains no user or model content. */
  readonly revision: string;
}

export interface AgentCapabilityControlRow {
  readonly capabilityId: AgentSubcapabilityId;
  readonly killedReason: string | null;
  readonly revision: string;
}

export interface AgentAuthorizationWindow {
  readonly lane: AgentRolloutLane;
  readonly sequence: number;
  readonly maxProviderCalls: number;
  readonly providerCalls: number;
  readonly reservedProviderCalls: number;
  readonly providerErrors: number;
  readonly invalidCalls: number;
  readonly qualifyingSamples: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly status: 'active' | 'review' | 'superseded';
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly supersededAt: string | null;
  readonly supersededReason: string | null;
}

export interface AgentLaneRecoveryResult {
  readonly control: AgentLaneControlRow;
  readonly authorizationWindow: AgentAuthorizationWindow;
}

export interface AgentLaneReopenResult extends AgentLaneRecoveryResult {
  readonly operation: 'quality-recovery' | 'window-renewal';
}

export interface AgentProviderCallReservation {
  readonly reservationDigest: string;
  readonly maxModelCalls: number;
  readonly windowSequence: number;
  readonly laneControlRevision: string;
  readonly created: boolean;
}

const LATENCY_BUCKET_MS = 100;
const MAX_BOUNDED_LATENCY_MS = 120_000;
const OVERFLOW_LATENCY_BUCKET_MS = 86_400_000;

type SqlRow = Record<string, unknown>;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

const AUTHORIZATION_WINDOW_SQL = `
  CREATE TABLE agent_lane_authorization_window (
    lane TEXT NOT NULL,
    window_sequence INTEGER NOT NULL CHECK(window_sequence >= 1),
    max_provider_calls INTEGER NOT NULL CHECK(max_provider_calls >= 1),
    provider_calls INTEGER NOT NULL DEFAULT 0 CHECK(provider_calls >= 0),
    reserved_provider_calls INTEGER NOT NULL DEFAULT 0 CHECK(reserved_provider_calls >= 0),
    provider_errors INTEGER NOT NULL DEFAULT 0 CHECK(provider_errors >= 0),
    invalid_calls INTEGER NOT NULL DEFAULT 0 CHECK(invalid_calls >= 0),
    qualifying_samples INTEGER NOT NULL DEFAULT 0 CHECK(qualifying_samples >= 0),
    status TEXT NOT NULL CHECK(status IN ('active','review')),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    superseded_at TEXT,
    superseded_reason TEXT,
    PRIMARY KEY(lane,window_sequence)
  );
  CREATE INDEX agent_lane_authorization_window_status
    ON agent_lane_authorization_window(lane,status,window_sequence);
  CREATE TABLE agent_lane_authorization_window_latency (
    lane TEXT NOT NULL,
    window_sequence INTEGER NOT NULL,
    bucket_upper_ms INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
    PRIMARY KEY(lane,window_sequence,bucket_upper_ms)
  );
  CREATE TABLE agent_lane_provider_reservation (
    reservation_digest TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    window_sequence INTEGER NOT NULL,
    idempotency_key_digest TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    lane_control_revision TEXT NOT NULL,
    reserved_provider_calls INTEGER NOT NULL CHECK(reserved_provider_calls >= 1),
    settled_provider_calls INTEGER CHECK(settled_provider_calls >= 0),
    status TEXT NOT NULL CHECK(status IN ('active','settled','released','abandoned')),
    created_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    started_at TEXT,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX agent_lane_provider_reservation_idempotency
    ON agent_lane_provider_reservation(lane,idempotency_key_digest);
  CREATE INDEX agent_lane_provider_reservation_window
    ON agent_lane_provider_reservation(lane,window_sequence,status);
`;

const CAPABILITY_CONTROL_SQL = `
  CREATE TABLE agent_capability_control (
    capability_id TEXT PRIMARY KEY,
    killed_reason TEXT,
    updated_at TEXT NOT NULL
  );
`;

function initialize(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as SqlRow).user_version);
  const applicationId = Number((db.prepare('PRAGMA application_id').get() as SqlRow).application_id);
  if (version > AGENT_CONTROL_SCHEMA_VERSION) throw new Error('agent control database too new');
  if (version === AGENT_CONTROL_SCHEMA_VERSION && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    return;
  }
  if (version === 5 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    // v5 was still under development when durable reservations gained revision binding. Complete
    // that draft first, then make the evidence suite's digest-bound capture time durable. Existing
    // rows deliberately remain NULL: they may still describe rollout health, but cannot recover a
    // killed lane until the original immutable evidence is imported again.
    const reservationColumns = (db.prepare(
      'PRAGMA table_info(agent_lane_provider_reservation)',
    ).all() as SqlRow[]).map((row) => String(row.name));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!reservationColumns.includes('lane_control_revision')) {
        db.exec(`
        ALTER TABLE agent_lane_provider_reservation ADD COLUMN lane_control_revision TEXT;
        UPDATE agent_lane_provider_reservation
        SET lane_control_revision=(
          SELECT updated_at FROM agent_lane_control
          WHERE agent_lane_control.lane=agent_lane_provider_reservation.lane
        )
        WHERE lane_control_revision IS NULL;
        `);
      }
      db.exec(`
        ALTER TABLE agent_lane_evaluation ADD COLUMN captured_at TEXT;
        PRAGMA user_version = ${AGENT_CONTROL_SCHEMA_VERSION};
        COMMIT;
      `);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return;
  }
  if (version === 4 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    // v4 did not bind quality observations to the authorization window that produced them.
    // Preserve every old row, and for a non-killed unfinished lane carry only its remaining
    // authority into a clean v5 window. A killed lane gets no new authority until explicit
    // evidence-bound recovery creates a caller-sized window.
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE agent_lane_authorization_window
        ADD COLUMN reserved_provider_calls INTEGER NOT NULL DEFAULT 0 CHECK(reserved_provider_calls >= 0);
      ALTER TABLE agent_lane_authorization_window
        ADD COLUMN provider_errors INTEGER NOT NULL DEFAULT 0 CHECK(provider_errors >= 0);
      ALTER TABLE agent_lane_authorization_window
        ADD COLUMN invalid_calls INTEGER NOT NULL DEFAULT 0 CHECK(invalid_calls >= 0);
      ALTER TABLE agent_lane_authorization_window
        ADD COLUMN qualifying_samples INTEGER NOT NULL DEFAULT 0 CHECK(qualifying_samples >= 0);
      ALTER TABLE agent_lane_authorization_window ADD COLUMN superseded_at TEXT;
      ALTER TABLE agent_lane_authorization_window ADD COLUMN superseded_reason TEXT;
      CREATE TABLE agent_lane_authorization_window_latency (
        lane TEXT NOT NULL,
        window_sequence INTEGER NOT NULL,
        bucket_upper_ms INTEGER NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
        PRIMARY KEY(lane,window_sequence,bucket_upper_ms)
      );
      CREATE TABLE agent_lane_provider_reservation (
        reservation_digest TEXT PRIMARY KEY,
        lane TEXT NOT NULL,
        window_sequence INTEGER NOT NULL,
        idempotency_key_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        lane_control_revision TEXT NOT NULL,
        reserved_provider_calls INTEGER NOT NULL CHECK(reserved_provider_calls >= 1),
        settled_provider_calls INTEGER CHECK(settled_provider_calls >= 0),
        status TEXT NOT NULL CHECK(status IN ('active','settled','released','abandoned')),
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        started_at TEXT,
        settled_at TEXT
      );
      CREATE UNIQUE INDEX agent_lane_provider_reservation_idempotency
        ON agent_lane_provider_reservation(lane,idempotency_key_digest);
      CREATE INDEX agent_lane_provider_reservation_window
        ON agent_lane_provider_reservation(lane,window_sequence,status);
      UPDATE agent_lane_authorization_window AS w
      SET superseded_at=datetime('now'),superseded_reason='v5-quality-boundary',closed_at=datetime('now')
      WHERE w.status='active' AND w.provider_calls<w.max_provider_calls
        AND w.window_sequence=(
          SELECT MAX(latest.window_sequence) FROM agent_lane_authorization_window latest
          WHERE latest.lane=w.lane
        )
        AND COALESCE((SELECT desired_state FROM agent_lane_control c WHERE c.lane=w.lane),'off')<>'killed';
      INSERT INTO agent_lane_authorization_window(
        lane,window_sequence,max_provider_calls,provider_calls,reserved_provider_calls,
        provider_errors,invalid_calls,qualifying_samples,status,opened_at
      )
      SELECT lane,window_sequence+1,max_provider_calls-provider_calls,0,0,0,0,0,'active',datetime('now')
      FROM agent_lane_authorization_window
      WHERE superseded_reason='v5-quality-boundary';
      PRAGMA user_version = 5;
      COMMIT;
    `);
    initialize(db);
    return;
  }
  if (version === 3 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    db.exec(`
      BEGIN IMMEDIATE;
      ${CAPABILITY_CONTROL_SQL}
      PRAGMA user_version = 4;
      COMMIT;
    `);
    initialize(db);
    return;
  }
  if (version === 2 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    // Migrate the legacy flat 24-call window to the per-lane default. The flat ceiling could not
    // yield canaryMinSamples qualifying samples in one window, so a lane could never promote.
    const windowCallsSql = `CASE c.lane${AGENT_ROLLOUT_LANES
      .map((lane) => ` WHEN '${lane}' THEN ${AGENT_TEST_SESSION_WINDOW_CALLS[lane]}`)
      .join('')} ELSE ${AGENT_ROLLOUT_THRESHOLDS.testSessionMaxProviderCalls} END`;
    db.exec(`
      BEGIN IMMEDIATE;
      ${AUTHORIZATION_WINDOW_SQL}
      ${CAPABILITY_CONTROL_SQL}
      INSERT INTO agent_lane_authorization_window(
        lane,window_sequence,max_provider_calls,provider_calls,status,opened_at,closed_at
      )
      SELECT c.lane,1,${windowCallsSql},
        COALESCE(SUM(o.provider_calls),0),
        CASE WHEN COALESCE(SUM(o.provider_calls),0) >= ${windowCallsSql}
          THEN 'review' ELSE 'active' END,
        c.updated_at,
        CASE WHEN COALESCE(SUM(o.provider_calls),0) >= ${windowCallsSql}
          THEN datetime('now') ELSE NULL END
      FROM agent_lane_control c
      LEFT JOIN agent_lane_daily_observation o ON o.lane=c.lane
      GROUP BY c.lane,c.updated_at;
      PRAGMA user_version = 5;
      COMMIT;
    `);
    initialize(db);
    return;
  }
  if (version === 1 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE agent_lane_daily_observation (
        lane TEXT NOT NULL,
        day TEXT NOT NULL,
        observation_version TEXT NOT NULL,
        provider_calls INTEGER NOT NULL DEFAULT 0,
        provider_errors INTEGER NOT NULL DEFAULT 0,
        invalid_calls INTEGER NOT NULL DEFAULT 0,
        player_sovereignty_violations INTEGER NOT NULL DEFAULT 0,
        unauthorized_or_stale_writes INTEGER NOT NULL DEFAULT 0,
        duplicate_writes INTEGER NOT NULL DEFAULT 0,
        sensitive_audit_violations INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(lane,day,observation_version)
      );
      CREATE TABLE agent_lane_qualifying_sample (
        lane TEXT NOT NULL,
        observation_version TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        day TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(lane,observation_version,session_id,parent_run_id)
      );
      CREATE TABLE agent_lane_latency_histogram (
        lane TEXT NOT NULL,
        observation_version TEXT NOT NULL,
        day TEXT NOT NULL,
        bucket_upper_ms INTEGER NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(lane,observation_version,day,bucket_upper_ms)
      );
      ${AUTHORIZATION_WINDOW_SQL}
      ${CAPABILITY_CONTROL_SQL}
      PRAGMA user_version = 5;
      COMMIT;
    `);
    initialize(db);
    return;
  }
  if (version !== 0 || applicationId !== 0) throw new Error('agent control database metadata mismatch');
  db.exec(`
    BEGIN IMMEDIATE;
    PRAGMA application_id = ${AGENT_CONTROL_APPLICATION_ID};
    CREATE TABLE agent_lane_control (
      lane TEXT PRIMARY KEY,
      desired_state TEXT NOT NULL,
      killed_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_lane_evaluation (
      lane TEXT PRIMARY KEY,
      suite_digest TEXT NOT NULL,
      evaluation_version TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      passed INTEGER NOT NULL CHECK(passed IN (0,1)),
      captured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE agent_lane_daily (
      lane TEXT NOT NULL,
      day TEXT NOT NULL,
      qualifying_samples INTEGER NOT NULL DEFAULT 0,
      provider_calls INTEGER NOT NULL DEFAULT 0,
      provider_errors INTEGER NOT NULL DEFAULT 0,
      invalid_calls INTEGER NOT NULL DEFAULT 0,
      p95_latency_ms INTEGER NOT NULL DEFAULT 0,
      player_sovereignty_violations INTEGER NOT NULL DEFAULT 0,
      unauthorized_or_stale_writes INTEGER NOT NULL DEFAULT 0,
      duplicate_writes INTEGER NOT NULL DEFAULT 0,
      sensitive_audit_violations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(lane,day)
    );
    CREATE TABLE agent_lane_daily_observation (
      lane TEXT NOT NULL,
      day TEXT NOT NULL,
      observation_version TEXT NOT NULL,
      provider_calls INTEGER NOT NULL DEFAULT 0,
      provider_errors INTEGER NOT NULL DEFAULT 0,
      invalid_calls INTEGER NOT NULL DEFAULT 0,
      player_sovereignty_violations INTEGER NOT NULL DEFAULT 0,
      unauthorized_or_stale_writes INTEGER NOT NULL DEFAULT 0,
      duplicate_writes INTEGER NOT NULL DEFAULT 0,
      sensitive_audit_violations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(lane,day,observation_version)
    );
    CREATE TABLE agent_lane_qualifying_sample (
      lane TEXT NOT NULL,
      observation_version TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_run_id TEXT NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(lane,observation_version,session_id,parent_run_id)
    );
    CREATE TABLE agent_lane_latency_histogram (
      lane TEXT NOT NULL,
      observation_version TEXT NOT NULL,
      day TEXT NOT NULL,
      bucket_upper_ms INTEGER NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(lane,observation_version,day,bucket_upper_ms)
    );
    ${AUTHORIZATION_WINDOW_SQL}
    ${CAPABILITY_CONTROL_SQL}
    PRAGMA user_version = ${AGENT_CONTROL_SCHEMA_VERSION};
    COMMIT;
  `);
}

function lane(value: unknown): AgentRolloutLane {
  if (typeof value !== 'string' || !AGENT_ROLLOUT_LANES.includes(value as AgentRolloutLane)) {
    throw new Error('agent-control-lane-invalid');
  }
  return value as AgentRolloutLane;
}

function state(value: unknown): AgentRolloutState {
  if (typeof value !== 'string' || !AGENT_ROLLOUT_STATES.includes(value as AgentRolloutState)) {
    throw new Error('agent-control-state-invalid');
  }
  return value as AgentRolloutState;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}-invalid`);
  return Number(value);
}

function positiveLimit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10_000) {
    throw new Error(`${label}-invalid`);
  }
  return Number(value);
}

function laneWindowLimit(
  laneId: AgentRolloutLane,
  value: unknown,
  label: string,
): number {
  const limit = positiveLimit(value, label);
  if (limit > AGENT_TEST_SESSION_WINDOW_CALLS[laneId]) {
    throw new Error(`${label}-exceeds-lane-ceiling`);
  }
  return limit;
}

function isQualityKill(reason: string | null): boolean {
  return reason !== null && AGENT_LANE_QUALITY_KILL_REASONS.includes(
    reason as (typeof AGENT_LANE_QUALITY_KILL_REASONS)[number],
  );
}

function isPermanentKill(reason: string | null): boolean {
  return reason !== null && AGENT_LANE_PERMANENT_KILL_REASONS.includes(
    reason as (typeof AGENT_LANE_PERMANENT_KILL_REASONS)[number],
  );
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

function controlRevision(value: unknown): string {
  if (typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error('agent-control-revision-invalid');
  }
  return value;
}

function latencyBucket(value: number): number {
  if (value > MAX_BOUNDED_LATENCY_MS) return OVERFLOW_LATENCY_BUCKET_MS;
  return Math.ceil(value / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
}

export class AgentControlStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(input: { dataDir: string; now?: () => Date }) {
    const root = resolve(input.dataDir);
    mkdirSync(root, { recursive: true });
    const path = join(root, AGENT_CONTROL_DB_FILE);
    const existed = existsSync(path);
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    initialize(this.#db);
    this.#now = input.now ?? (() => new Date());
    const createdAt = this.#now().toISOString();
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO agent_lane_control(lane,desired_state,updated_at) VALUES(?,?,?)',
    );
    for (const value of AGENT_ROLLOUT_LANES) insert.run(value, 'off', createdAt);
    const insertWindow = this.#db.prepare(`
      INSERT OR IGNORE INTO agent_lane_authorization_window(
        lane,window_sequence,max_provider_calls,provider_calls,status,opened_at
      ) VALUES(?,1,?,0,'active',?)
    `);
    for (const value of AGENT_ROLLOUT_LANES) {
      insertWindow.run(value, AGENT_TEST_SESSION_WINDOW_CALLS[value], createdAt);
    }
    const insertCapability = this.#db.prepare(
      'INSERT OR IGNORE INTO agent_capability_control(capability_id,updated_at) VALUES(?,?)',
    );
    for (const capabilityId of AGENT_SUBCAPABILITY_IDS) insertCapability.run(capabilityId, createdAt);
    if (!existed) { try { chmodSync(path, 0o600); } catch { /* Windows ACL remains authoritative. */ } }
  }

  get(laneId: AgentRolloutLane): AgentLaneControlRow {
    const id = lane(laneId);
    const row = this.#db.prepare(
      'SELECT lane,desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?',
    ).get(id) as SqlRow | undefined;
    if (!row) throw new Error('agent-control-row-missing');
    return Object.freeze({
      lane: lane(row.lane),
      desiredState: state(row.desired_state),
      killedReason: typeof row.killed_reason === 'string' ? row.killed_reason : null,
      revision: controlRevision(row.updated_at),
    });
  }

  list(): readonly ReturnType<AgentControlStore['get']>[] {
    return Object.freeze(AGENT_ROLLOUT_LANES.map((value) => this.get(value)));
  }

  setDesired(laneId: AgentRolloutLane, desiredState: AgentRolloutState): void {
    const id = lane(laneId);
    const desired = state(desiredState);
    if (desired === 'killed') throw new Error('use-kill-operation');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!current) throw new Error('agent-control-row-missing');
      if (current.desired_state === 'killed') throw new Error('lane-killed-clear-first');
      if (current.desired_state !== desired) {
        const update = this.#db.prepare(`
          UPDATE agent_lane_control SET desired_state=?,killed_reason=NULL,updated_at=?
          WHERE lane=? AND updated_at=? AND desired_state<>'killed'
        `).run(desired, this.#nextRevision(String(current.updated_at)), id, String(current.updated_at));
        if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  kill(laneId: AgentRolloutLane, reasonCode: string): void {
    const id = lane(laneId);
    if (!TOKEN_RE.test(reasonCode)) throw new Error('kill-reason-invalid');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!current) throw new Error('agent-control-row-missing');
      const currentReason = typeof current.killed_reason === 'string' ? current.killed_reason : null;
      if (current.desired_state === 'killed') {
        if (currentReason === reasonCode) {
          this.#db.exec('COMMIT');
          return;
        }
        if (isPermanentKill(currentReason) || !isPermanentKill(reasonCode)) {
          throw new Error(isPermanentKill(currentReason)
            ? 'lane-permanent-kill-sticky' : 'lane-kill-reason-sticky');
        }
      }
      const update = this.#db.prepare(`
        UPDATE agent_lane_control SET desired_state='killed',killed_reason=?,updated_at=?
        WHERE lane=? AND updated_at=?
      `).run(reasonCode, this.#nextRevision(String(current.updated_at)), id, String(current.updated_at));
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  clearKill(laneId: AgentRolloutLane): void {
    const id = lane(laneId);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!current) throw new Error('agent-control-row-missing');
      const currentReason = typeof current.killed_reason === 'string' ? current.killed_reason : null;
      if (isQualityKill(currentReason)) throw new Error('lane-quality-recovery-required');
      if (isPermanentKill(currentReason)) throw new Error('lane-permanent-kill');
      const update = this.#db.prepare(`
        UPDATE agent_lane_control SET desired_state='off',killed_reason=NULL,updated_at=?
        WHERE lane=? AND updated_at=?
      `).run(this.#nextRevision(String(current.updated_at)), id, String(current.updated_at));
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #nextRevision(expectedRevision: string): string {
    const expected = controlRevision(expectedRevision);
    const nextMs = Math.max(this.#now().getTime(), Date.parse(expected) + 1);
    return new Date(nextMs).toISOString();
  }

  setDesiredCas(
    laneId: AgentRolloutLane,
    desiredState: AgentRolloutState,
    expectedRevision: string,
  ): AgentLaneControlRow {
    const id = lane(laneId);
    const desired = state(desiredState);
    if (desired === 'killed') throw new Error('use-kill-operation');
    const expected = controlRevision(expectedRevision);
    const nextRevision = this.#nextRevision(expected);
    const result = this.#db.prepare(`
      UPDATE agent_lane_control
      SET desired_state=?,killed_reason=NULL,updated_at=?
      WHERE lane=? AND updated_at=? AND desired_state<>'killed'
    `).run(desired, nextRevision, id, expected);
    if (Number(result.changes) !== 1) {
      const current = this.get(id);
      if (current.revision !== expected) throw new Error('agent-control-revision-conflict');
      if (current.desiredState === 'killed') throw new Error('lane-killed-clear-first');
      throw new Error('agent-control-update-failed');
    }
    return this.get(id);
  }

  killCas(
    laneId: AgentRolloutLane,
    reasonCode: string,
    expectedRevision: string,
  ): AgentLaneControlRow {
    const id = lane(laneId);
    if (!TOKEN_RE.test(reasonCode)) throw new Error('kill-reason-invalid');
    const expected = controlRevision(expectedRevision);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!current || current.updated_at !== expected) throw new Error('agent-control-revision-conflict');
      const currentReason = typeof current.killed_reason === 'string' ? current.killed_reason : null;
      if (current.desired_state === 'killed') {
        if (currentReason === reasonCode) {
          this.#db.exec('COMMIT');
          return this.get(id);
        }
        if (isPermanentKill(currentReason) || !isPermanentKill(reasonCode)) {
          throw new Error(isPermanentKill(currentReason)
            ? 'lane-permanent-kill-sticky' : 'lane-kill-reason-sticky');
        }
      }
      const result = this.#db.prepare(`
        UPDATE agent_lane_control
        SET desired_state='killed',killed_reason=?,updated_at=?
        WHERE lane=? AND updated_at=?
      `).run(reasonCode, this.#nextRevision(expected), id, expected);
      if (Number(result.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  clearKillCas(laneId: AgentRolloutLane, expectedRevision: string): AgentLaneControlRow {
    const id = lane(laneId);
    const expected = controlRevision(expectedRevision);
    const before = this.get(id);
    if (before.revision !== expected) throw new Error('agent-control-revision-conflict');
    if (before.desiredState !== 'killed') throw new Error('lane-not-killed');
    if (isQualityKill(before.killedReason)) throw new Error('lane-quality-recovery-required');
    if (isPermanentKill(before.killedReason)) throw new Error('lane-permanent-kill');
    const result = this.#db.prepare(`
      UPDATE agent_lane_control
      SET desired_state='off',killed_reason=NULL,updated_at=?
      WHERE lane=? AND updated_at=? AND desired_state='killed'
    `).run(this.#nextRevision(expected), id, expected);
    if (Number(result.changes) !== 1) throw new Error('agent-control-revision-conflict');
    return this.get(id);
  }

  capabilityControl(capabilityId: AgentSubcapabilityId): AgentCapabilityControlRow {
    if (!AGENT_SUBCAPABILITY_IDS.includes(capabilityId)) {
      throw new Error('agent-capability-id-invalid');
    }
    const row = this.#db.prepare(`
      SELECT capability_id,killed_reason,updated_at
      FROM agent_capability_control WHERE capability_id=?
    `).get(capabilityId) as SqlRow | undefined;
    if (!row) throw new Error('agent-capability-control-row-missing');
    return Object.freeze({
      capabilityId,
      killedReason: typeof row.killed_reason === 'string' ? row.killed_reason : null,
      revision: controlRevision(row.updated_at),
    });
  }

  capabilityControls(): readonly AgentCapabilityControlRow[] {
    return Object.freeze(AGENT_SUBCAPABILITY_IDS.map((id) => this.capabilityControl(id)));
  }

  killCapabilityCas(
    capabilityId: AgentSubcapabilityId,
    reasonCode: string,
    expectedRevision: string,
  ): AgentCapabilityControlRow {
    if (!AGENT_SUBCAPABILITY_IDS.includes(capabilityId)) throw new Error('agent-capability-id-invalid');
    if (!TOKEN_RE.test(reasonCode)) throw new Error('kill-reason-invalid');
    const expected = controlRevision(expectedRevision);
    const result = this.#db.prepare(`
      UPDATE agent_capability_control SET killed_reason=?,updated_at=?
      WHERE capability_id=? AND updated_at=?
    `).run(reasonCode, this.#nextRevision(expected), capabilityId, expected);
    if (Number(result.changes) !== 1) throw new Error('agent-control-revision-conflict');
    return this.capabilityControl(capabilityId);
  }

  clearCapabilityKillCas(
    capabilityId: AgentSubcapabilityId,
    expectedRevision: string,
  ): AgentCapabilityControlRow {
    if (!AGENT_SUBCAPABILITY_IDS.includes(capabilityId)) throw new Error('agent-capability-id-invalid');
    const expected = controlRevision(expectedRevision);
    const result = this.#db.prepare(`
      UPDATE agent_capability_control SET killed_reason=NULL,updated_at=?
      WHERE capability_id=? AND updated_at=? AND killed_reason IS NOT NULL
    `).run(this.#nextRevision(expected), capabilityId, expected);
    if (Number(result.changes) !== 1) {
      const current = this.capabilityControl(capabilityId);
      if (current.revision !== expected) throw new Error('agent-control-revision-conflict');
      throw new Error('capability-not-killed');
    }
    return this.capabilityControl(capabilityId);
  }

  authorizationWindow(laneId: AgentRolloutLane): AgentAuthorizationWindow {
    const id = lane(laneId);
    const row = this.#db.prepare(`
      SELECT * FROM agent_lane_authorization_window
      WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
    `).get(id) as SqlRow | undefined;
    if (!row) throw new Error('agent-authorization-window-missing');
    const storedStatus = row.status === 'active' || row.status === 'review'
      ? row.status : (() => { throw new Error('authorization-window-status-invalid'); })();
    const sequence = nonNegative(row.window_sequence, 'window-sequence');
    const latencyRows = this.#db.prepare(`
      SELECT bucket_upper_ms,sample_count FROM agent_lane_authorization_window_latency
      WHERE lane=? AND window_sequence=? ORDER BY bucket_upper_ms ASC
    `).all(id, sequence) as SqlRow[];
    const latencyTotal = latencyRows.reduce((sum, value) => sum + Number(value.sample_count), 0);
    const percentile = (ratio: number): number => {
      if (latencyTotal === 0) return 0;
      const target = Math.ceil(latencyTotal * ratio);
      let cumulative = 0;
      for (const value of latencyRows) {
        cumulative += Number(value.sample_count);
        if (cumulative >= target) return Number(value.bucket_upper_ms);
      }
      return Number(latencyRows.at(-1)?.bucket_upper_ms ?? 0);
    };
    const supersededAt = typeof row.superseded_at === 'string' ? row.superseded_at : null;
    return Object.freeze({
      lane: id,
      sequence,
      maxProviderCalls: nonNegative(row.max_provider_calls, 'window-max-calls'),
      providerCalls: nonNegative(row.provider_calls, 'window-provider-calls'),
      reservedProviderCalls: nonNegative(row.reserved_provider_calls, 'window-reserved-calls'),
      providerErrors: nonNegative(row.provider_errors, 'window-provider-errors'),
      invalidCalls: nonNegative(row.invalid_calls, 'window-invalid-calls'),
      qualifyingSamples: nonNegative(row.qualifying_samples, 'window-qualifying-samples'),
      p50LatencyMs: percentile(0.50),
      p95LatencyMs: percentile(0.95),
      status: supersededAt ? 'superseded' : storedStatus,
      openedAt: String(row.opened_at),
      closedAt: typeof row.closed_at === 'string' ? row.closed_at : null,
      supersededAt,
      supersededReason: typeof row.superseded_reason === 'string' ? row.superseded_reason : null,
    });
  }

  /** Explicit operator action. Historical evidence is retained and the quota is never inferred. */
  authorizeNextWindow(
    laneId: AgentRolloutLane,
    maxProviderCalls: number,
  ): ReturnType<AgentControlStore['authorizationWindow']> {
    const control = this.get(laneId);
    const window = this.authorizationWindow(laneId);
    return this.authorizeNextWindowCas({
      lane: laneId,
      maxProviderCalls,
      expectedControlRevision: control.revision,
      expectedWindowSequence: window.sequence,
    });
  }

  /** Explicit renewal bound to both the control row and the exact exhausted window. */
  authorizeNextWindowCas(input: {
    lane: AgentRolloutLane;
    maxProviderCalls: number;
    expectedControlRevision: string;
    expectedWindowSequence: number;
    /** Used only by reopenLaneCas so window renewal and activation share one transaction. */
    reopenToTestSession?: boolean;
  }): ReturnType<AgentControlStore['authorizationWindow']> {
    const id = lane(input.lane);
    const explicitMax = laneWindowLimit(id, input.maxProviderCalls, 'authorization-window-max-calls');
    const expectedControlRevision = controlRevision(input.expectedControlRevision);
    const expectedWindowSequence = positiveLimit(input.expectedWindowSequence, 'expected-window-sequence');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const control = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!control) throw new Error('agent-control-row-missing');
      if (control.updated_at !== expectedControlRevision) throw new Error('agent-control-revision-conflict');
      const killedReason = typeof control.killed_reason === 'string' ? control.killed_reason : null;
      if (control.desired_state === 'killed') {
        if (isQualityKill(killedReason)) throw new Error('lane-quality-recovery-required');
        if (isPermanentKill(killedReason)) throw new Error('lane-permanent-kill');
        throw new Error('lane-killed-window-renewal-denied');
      }
      if (input.reopenToTestSession === true
        && !['off', 'shadow', 'test-session'].includes(String(control.desired_state))) {
        throw new Error('reopen-refuses-rollout-narrowing');
      }
      const current = this.#db.prepare(`
        SELECT window_sequence,max_provider_calls,provider_calls,provider_errors,status,superseded_at
        FROM agent_lane_authorization_window WHERE lane=?
        ORDER BY window_sequence DESC LIMIT 1
      `).get(id) as SqlRow | undefined;
      if (Number(current?.window_sequence) !== expectedWindowSequence) {
        throw new Error('authorization-window-sequence-conflict');
      }
      const consumedAttempts = Number(current?.provider_calls ?? 0)
        + Number(current?.provider_errors ?? 0);
      if (!current || !['active', 'review'].includes(String(current.status))
        || current.superseded_at !== null
        || consumedAttempts < Number(current.max_provider_calls)) {
        throw new Error('authorization-window-review-required');
      }
      // v6 windows created before failed attempts consumed authority can still be stored as
      // active even though calls+errors reached the ceiling. Normalize that legacy edge in-place.
      if (current.status === 'active') {
        this.#db.prepare(`
          UPDATE agent_lane_authorization_window
          SET status='review',closed_at=COALESCE(closed_at,?)
          WHERE lane=? AND window_sequence=? AND status='active'
        `).run(this.#now().toISOString(), id, expectedWindowSequence);
      }
      this.#db.prepare(`
        INSERT INTO agent_lane_authorization_window(
          lane,window_sequence,max_provider_calls,provider_calls,status,opened_at
        ) VALUES(?,?,?,0,'active',?)
      `).run(id, expectedWindowSequence + 1, explicitMax, this.#now().toISOString());
      if (input.reopenToTestSession === true) {
        const update = this.#db.prepare(`
          UPDATE agent_lane_control
          SET desired_state='test-session',killed_reason=NULL,updated_at=?
          WHERE lane=? AND updated_at=? AND desired_state<>'killed'
        `).run(this.#nextRevision(expectedControlRevision), id, expectedControlRevision);
        if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.authorizationWindow(id);
  }

  /**
   * Atomically reserves Provider-call authority before a ticket exists. The returned model-call
   * ceiling may be narrower than the request, but can never exceed the window's unreserved balance.
   * Replays of the same active digest are idempotent; settled reservations cannot mint a new ticket.
   */
  #reapExpiredProviderReservations(now: string): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // An unstarted expired ticket is safely released. A started lease whose process died before
      // audit is never refunded: conservatively charge its full reservation, so restart recovery
      // cannot mint duplicate Provider authority and a full window progresses to review.
      const expired = this.#db.prepare(`
        SELECT reservation_digest,lane,window_sequence,reserved_provider_calls,started_at
        FROM agent_lane_provider_reservation
        WHERE status='active' AND deadline_at<=?
      `).all(now) as SqlRow[];
      for (const row of expired) {
        const reserved = Number(row.reserved_provider_calls);
        const started = row.started_at !== null;
        const account = started
          ? this.#db.prepare(`
              UPDATE agent_lane_authorization_window SET
                provider_errors=provider_errors+?,
                reserved_provider_calls=reserved_provider_calls-?,
                status=CASE WHEN provider_calls+provider_errors+?>=max_provider_calls THEN 'review' ELSE status END,
                closed_at=CASE WHEN provider_calls+provider_errors+?>=max_provider_calls AND closed_at IS NULL
                  THEN ? ELSE closed_at END
              WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
            `).run(
              reserved, reserved, reserved, reserved, now,
              String(row.lane), Number(row.window_sequence), reserved,
            )
          : this.#db.prepare(`
              UPDATE agent_lane_authorization_window
              SET reserved_provider_calls=reserved_provider_calls-?
              WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
            `).run(reserved, String(row.lane), Number(row.window_sequence), reserved);
        if (Number(account.changes) !== 1) throw new Error('authorization-window-accounting-failed');
        const settle = this.#db.prepare(`
          UPDATE agent_lane_provider_reservation
          SET status=?,settled_provider_calls=?,settled_at=?
          WHERE reservation_digest=? AND status='active'
        `).run(
          started ? 'abandoned' : 'released', started ? reserved : 0,
          now, String(row.reservation_digest),
        );
        if (Number(settle.changes) !== 1) throw new Error('authorization-reservation-conflict');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  reserveProviderCalls(input: {
    lane: AgentRolloutLane;
    expectedControlRevision: string;
    idempotencyKey: string;
    requestDigest: string;
    maxProviderCalls: number;
    deadlineMs: number;
  }): AgentProviderCallReservation {
    const id = lane(input.lane);
    const expectedControlRevision = controlRevision(input.expectedControlRevision);
    const idempotencyKey = identity(input.idempotencyKey, 'authorization-reservation-idempotency');
    if (!DIGEST_RE.test(input.requestDigest)) throw new Error('authorization-reservation-request-invalid');
    const requested = positiveLimit(input.maxProviderCalls, 'authorization-reservation-calls');
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) {
      throw new Error('authorization-reservation-deadline-invalid');
    }
    const nowDate = this.#now();
    if (input.deadlineMs <= nowDate.getTime()) throw new Error('authorization-reservation-expired');
    const now = nowDate.toISOString();
    const deadlineAt = new Date(input.deadlineMs).toISOString();
    const idempotencyKeyDigest = `sha256:${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}`;
    this.#reapExpiredProviderReservations(now);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const control = this.#db.prepare(
        'SELECT desired_state,updated_at FROM agent_lane_control WHERE lane=?',
      ).get(id) as SqlRow | undefined;
      if (!control) throw new Error('agent-control-row-missing');
      if (control.desired_state === 'killed') throw new Error('authorization-lane-killed');
      if (control.updated_at !== expectedControlRevision) {
        throw new Error('authorization-lane-control-changed');
      }
      const prior = this.#db.prepare(`
        SELECT reservation_digest,lane,window_sequence,request_digest,lane_control_revision,
          reserved_provider_calls,status,started_at
        FROM agent_lane_provider_reservation WHERE lane=? AND idempotency_key_digest=?
      `).get(id, idempotencyKeyDigest) as SqlRow | undefined;
      if (prior) {
        if (prior.request_digest !== input.requestDigest) throw new Error('authorization-reservation-conflict');
        if (prior.lane_control_revision !== expectedControlRevision) {
          throw new Error('authorization-lane-control-changed');
        }
        if (prior.status !== 'active') throw new Error('authorization-reservation-settled');
        if (prior.started_at !== null) throw new Error('authorization-reservation-started');
        const result = Object.freeze({
          reservationDigest: String(prior.reservation_digest),
          maxModelCalls: positiveLimit(prior.reserved_provider_calls, 'authorization-reservation-calls'),
          windowSequence: positiveLimit(prior.window_sequence, 'window-sequence'),
          laneControlRevision: controlRevision(prior.lane_control_revision),
          created: false,
        });
        this.#db.exec('COMMIT');
        return result;
      }
      const window = this.#db.prepare(`
        SELECT * FROM agent_lane_authorization_window
        WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
      `).get(id) as SqlRow | undefined;
      if (!window || window.status !== 'active' || window.superseded_at !== null) {
        throw new Error('authorization-window-not-active');
      }
      const max = positiveLimit(window.max_provider_calls, 'authorization-window-max-calls');
      const used = nonNegative(window.provider_calls, 'window-provider-calls')
        + nonNegative(window.provider_errors, 'window-provider-errors');
      const reserved = nonNegative(window.reserved_provider_calls, 'window-reserved-calls');
      const remaining = max - used - reserved;
      if (remaining < 1) throw new Error('authorization-window-call-budget-exhausted');
      const granted = Math.min(requested, remaining);
      const sequence = positiveLimit(window.window_sequence, 'window-sequence');
      const reservationDigest = `sha256:${createHash('sha256')
        .update(`${id}\0${sequence}\0${idempotencyKeyDigest}`, 'utf8').digest('hex')}`;
      const update = this.#db.prepare(`
        UPDATE agent_lane_authorization_window
        SET reserved_provider_calls=reserved_provider_calls+?
        WHERE lane=? AND window_sequence=? AND status='active' AND superseded_at IS NULL
          AND provider_calls+provider_errors+reserved_provider_calls+?<=max_provider_calls
      `).run(granted, id, sequence, granted);
      if (Number(update.changes) !== 1) throw new Error('authorization-window-call-budget-exhausted');
      this.#db.prepare(`
        INSERT INTO agent_lane_provider_reservation(
          reservation_digest,lane,window_sequence,idempotency_key_digest,request_digest,
          lane_control_revision,reserved_provider_calls,status,created_at,deadline_at
        ) VALUES(?,?,?,?,?,?,?, 'active', ?, ?)
      `).run(
        reservationDigest, id, sequence, idempotencyKeyDigest, input.requestDigest,
        expectedControlRevision, granted, now, deadlineAt,
      );
      this.#db.exec('COMMIT');
      return Object.freeze({
        reservationDigest,
        maxModelCalls: granted,
        windowSequence: sequence,
        laneControlRevision: expectedControlRevision,
        created: true,
      });
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  markProviderCallReservationStarted(reservationDigest: string): void {
    if (!DIGEST_RE.test(reservationDigest)) throw new Error('authorization-reservation-digest-invalid');
    const now = this.#now().toISOString();
    let killed = false;
    let changed = false;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT r.lane,r.window_sequence,r.reserved_provider_calls,r.status,r.started_at,r.deadline_at,
          r.lane_control_revision,c.desired_state,c.updated_at AS current_control_revision
        FROM agent_lane_provider_reservation r
        JOIN agent_lane_control c ON c.lane=r.lane
        WHERE r.reservation_digest=?
      `).get(reservationDigest) as SqlRow | undefined;
      if (!current) throw new Error('authorization-reservation-missing');
      if (current.status !== 'active') throw new Error('authorization-reservation-settled');
      if (current.started_at !== null) {
        this.#db.exec('COMMIT');
        return;
      }
      if (current.desired_state === 'killed'
        || current.current_control_revision !== current.lane_control_revision) {
        const reserved = Number(current.reserved_provider_calls);
        const release = this.#db.prepare(`
          UPDATE agent_lane_authorization_window SET reserved_provider_calls=reserved_provider_calls-?
          WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
        `).run(reserved, String(current.lane), Number(current.window_sequence), reserved);
        if (Number(release.changes) !== 1) throw new Error('authorization-window-accounting-failed');
        const invalidate = this.#db.prepare(`
          UPDATE agent_lane_provider_reservation
          SET status='released',settled_provider_calls=0,settled_at=?
          WHERE reservation_digest=? AND status='active' AND started_at IS NULL
        `).run(now, reservationDigest);
        if (Number(invalidate.changes) !== 1) throw new Error('authorization-reservation-conflict');
        killed = current.desired_state === 'killed';
        if (!killed) changed = true;
      } else {
        if (String(current.deadline_at) <= now) throw new Error('authorization-reservation-expired');
        const update = this.#db.prepare(`
          UPDATE agent_lane_provider_reservation SET started_at=?
          WHERE reservation_digest=? AND status='active' AND started_at IS NULL
        `).run(now, reservationDigest);
        if (Number(update.changes) !== 1) throw new Error('authorization-reservation-conflict');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    if (killed) throw new Error('authorization-lane-killed');
    if (changed) throw new Error('authorization-lane-control-changed');
  }

  releaseProviderCallReservation(reservationDigest: string): void {
    if (!DIGEST_RE.test(reservationDigest)) throw new Error('authorization-reservation-digest-invalid');
    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const reservation = this.#db.prepare(`
        SELECT lane,window_sequence,reserved_provider_calls,status,started_at
        FROM agent_lane_provider_reservation WHERE reservation_digest=?
      `).get(reservationDigest) as SqlRow | undefined;
      if (!reservation || reservation.status !== 'active') {
        this.#db.exec('COMMIT');
        return;
      }
      if (reservation.started_at !== null) throw new Error('authorization-reservation-started');
      const release = this.#db.prepare(`
        UPDATE agent_lane_authorization_window SET reserved_provider_calls=reserved_provider_calls-?
        WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
      `).run(
        Number(reservation.reserved_provider_calls), String(reservation.lane),
        Number(reservation.window_sequence), Number(reservation.reserved_provider_calls),
      );
      if (Number(release.changes) !== 1) throw new Error('authorization-window-accounting-failed');
      this.#db.prepare(`
        UPDATE agent_lane_provider_reservation
        SET status='released',settled_provider_calls=0,settled_at=?
        WHERE reservation_digest=? AND status='active' AND started_at IS NULL
      `).run(now, reservationDigest);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Evidence-bound recovery for the three quality kills only. It preserves the killed window,
   * starts a caller-sized clean window, and intentionally restores only `off`.
   */
  recoverQualityKillCas(input: {
    lane: AgentRolloutLane;
    expectedRevision: string;
    evidenceDigest: string;
    maxProviderCalls: number;
    expectedWindowSequence?: number;
    /** Used only by reopenLaneCas so recovery and activation share one transaction. */
    reopenToTestSession?: boolean;
  }): AgentLaneRecoveryResult {
    const id = lane(input.lane);
    const expected = controlRevision(input.expectedRevision);
    if (!DIGEST_RE.test(input.evidenceDigest)) throw new Error('lane-recovery-evidence-invalid');
    const explicitMax = laneWindowLimit(id, input.maxProviderCalls, 'lane-recovery-max-provider-calls');
    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!current) throw new Error('agent-control-row-missing');
      if (current.updated_at !== expected) throw new Error('agent-control-revision-conflict');
      if (current.desired_state !== 'killed') throw new Error('lane-not-killed');
      const killedReason = typeof current.killed_reason === 'string' ? current.killed_reason : null;
      if (isPermanentKill(killedReason)) throw new Error('lane-permanent-kill');
      if (!isQualityKill(killedReason)) throw new Error('lane-recovery-quality-kill-required');
      const permanentEvidence = this.#db.prepare(`
        SELECT
          COALESCE(SUM(player_sovereignty_violations),0) AS sovereignty,
          COALESCE(SUM(unauthorized_or_stale_writes),0) AS stale_writes,
          COALESCE(SUM(duplicate_writes),0) AS duplicate_writes,
          COALESCE(SUM(sensitive_audit_violations),0) AS sensitive
        FROM agent_lane_daily_observation WHERE lane=? AND observation_version=?
      `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
      if (Number(permanentEvidence.sovereignty) > 0
        || Number(permanentEvidence.stale_writes) > 0
        || Number(permanentEvidence.duplicate_writes) > 0
        || Number(permanentEvidence.sensitive) > 0) {
        throw new Error('lane-permanent-kill');
      }
      const evaluation = this.#db.prepare(`
        SELECT suite_digest,evidence_class,passed,captured_at,recorded_at
        FROM agent_lane_evaluation WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!evaluation || evaluation.suite_digest !== input.evidenceDigest) {
        throw new Error('lane-recovery-evidence-missing');
      }
      if (evaluation.evidence_class !== 'operational' || Number(evaluation.passed) !== 1) {
        throw new Error('lane-recovery-evidence-not-operational');
      }
      const recordedAt = typeof evaluation.recorded_at === 'string' ? evaluation.recorded_at : '';
      if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) <= Date.parse(expected)) {
        throw new Error('lane-recovery-evidence-stale-recorded-at');
      }
      const capturedAt = typeof evaluation.captured_at === 'string' ? evaluation.captured_at : '';
      if (!Number.isFinite(Date.parse(capturedAt)) || Date.parse(capturedAt) <= Date.parse(expected)) {
        throw new Error('lane-recovery-evidence-stale-captured-at');
      }
      const window = this.#db.prepare(`
        SELECT window_sequence,max_provider_calls,provider_calls,reserved_provider_calls,status,superseded_at
        FROM agent_lane_authorization_window WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
      `).get(id) as SqlRow | undefined;
      if (!window) throw new Error('agent-authorization-window-missing');
      const sequence = positiveLimit(window.window_sequence, 'window-sequence');
      if (input.expectedWindowSequence !== undefined
        && positiveLimit(input.expectedWindowSequence, 'expected-window-sequence') !== sequence) {
        throw new Error('authorization-window-sequence-conflict');
      }
      // Tickets issued but not begun before the kill must not survive recovery. Started leases stay
      // bound to the superseded window and settle there; unstarted reservations are invalidated.
      const unstarted = this.#db.prepare(`
        SELECT reservation_digest,reserved_provider_calls
        FROM agent_lane_provider_reservation
        WHERE lane=? AND window_sequence=? AND status='active' AND started_at IS NULL
      `).all(id, sequence) as SqlRow[];
      const unstartedCalls = unstarted.reduce(
        (sum, reservation) => sum + Number(reservation.reserved_provider_calls), 0,
      );
      if (unstartedCalls > 0) {
        const release = this.#db.prepare(`
          UPDATE agent_lane_authorization_window
          SET reserved_provider_calls=reserved_provider_calls-?
          WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
        `).run(unstartedCalls, id, sequence, unstartedCalls);
        if (Number(release.changes) !== 1) throw new Error('authorization-window-accounting-failed');
        for (const reservation of unstarted) {
          const invalidated = this.#db.prepare(`
            UPDATE agent_lane_provider_reservation
            SET status='released',settled_provider_calls=0,settled_at=?
            WHERE reservation_digest=? AND status='active' AND started_at IS NULL
          `).run(now, String(reservation.reservation_digest));
          if (Number(invalidated.changes) !== 1) throw new Error('authorization-reservation-conflict');
        }
      }
      if (window.status === 'active' && window.superseded_at === null) {
        this.#db.prepare(`
          UPDATE agent_lane_authorization_window
          SET superseded_at=?,superseded_reason='quality-recovery',closed_at=COALESCE(closed_at,?)
          WHERE lane=? AND window_sequence=? AND superseded_at IS NULL
        `).run(now, now, id, sequence);
      }
      this.#db.prepare(`
        INSERT INTO agent_lane_authorization_window(
          lane,window_sequence,max_provider_calls,provider_calls,reserved_provider_calls,
          provider_errors,invalid_calls,qualifying_samples,status,opened_at
        ) VALUES(?,?,?,0,0,0,0,0,'active',?)
      `).run(id, sequence + 1, explicitMax, now);
      const update = this.#db.prepare(`
        UPDATE agent_lane_control SET desired_state=?,killed_reason=NULL,updated_at=?
        WHERE lane=? AND updated_at=? AND desired_state='killed'
      `).run(input.reopenToTestSession === true ? 'test-session' : 'off',
        this.#nextRevision(expected), id, expected);
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return Object.freeze({ control: this.get(id), authorizationWindow: this.authorizationWindow(id) });
  }

  /**
   * One operator intent: open a fresh exact window and restore only test-session.
   * Both branches perform their window/control mutations in one BEGIN IMMEDIATE transaction.
   */
  reopenLaneCas(input: {
    lane: AgentRolloutLane;
    expectedRevision: string;
    expectedWindowSequence: number;
    maxProviderCalls: number;
    evidenceDigest?: string;
  }): AgentLaneReopenResult {
    const id = lane(input.lane);
    const expectedRevision = controlRevision(input.expectedRevision);
    const expectedWindowSequence = positiveLimit(
      input.expectedWindowSequence, 'expected-window-sequence',
    );
    const before = this.get(id);
    if (before.revision !== expectedRevision) throw new Error('agent-control-revision-conflict');
    const beforeWindow = this.authorizationWindow(id);
    if (beforeWindow.sequence !== expectedWindowSequence) {
      throw new Error('authorization-window-sequence-conflict');
    }
    if (before.desiredState === 'killed') {
      if (!input.evidenceDigest) throw new Error('lane-recovery-evidence-required');
      const recovered = this.recoverQualityKillCas({
        lane: id,
        expectedRevision,
        expectedWindowSequence,
        evidenceDigest: input.evidenceDigest,
        maxProviderCalls: input.maxProviderCalls,
        reopenToTestSession: true,
      });
      return Object.freeze({ operation: 'quality-recovery', ...recovered });
    }
    if (!['off', 'shadow', 'test-session'].includes(before.desiredState)) {
      throw new Error('reopen-refuses-rollout-narrowing');
    }
    const authorizationWindow = this.authorizeNextWindowCas({
      lane: id,
      maxProviderCalls: input.maxProviderCalls,
      expectedControlRevision: expectedRevision,
      expectedWindowSequence,
      reopenToTestSession: true,
    });
    return Object.freeze({
      operation: 'window-renewal',
      control: this.get(id),
      authorizationWindow,
    });
  }

  recordEvaluation(input: {
    lane: AgentRolloutLane;
    suiteDigest: string;
    evaluationVersion: string;
    evidenceClass: 'fixture' | 'operational';
    passed: boolean;
    /** Original suite capture time. It is covered by suiteDigest and is not the import time. */
    capturedAt: string;
  }): void {
    const id = lane(input.lane);
    if (!DIGEST_RE.test(input.suiteDigest) || !TOKEN_RE.test(input.evaluationVersion)) {
      throw new Error('agent-evaluation-binding-invalid');
    }
    const recordedAt = this.#now().toISOString();
    if (!Number.isFinite(Date.parse(input.capturedAt))
      || new Date(input.capturedAt).toISOString() !== input.capturedAt
      || Date.parse(input.capturedAt) > Date.parse(recordedAt)) {
      throw new Error('agent-evaluation-captured-at-invalid');
    }
    const operationalPassed = input.evidenceClass === 'operational' && input.passed;
    this.#db.prepare(`
      INSERT INTO agent_lane_evaluation(
        lane,suite_digest,evaluation_version,evidence_class,passed,captured_at,recorded_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(lane) DO UPDATE SET
        suite_digest=excluded.suite_digest,evaluation_version=excluded.evaluation_version,
        evidence_class=excluded.evidence_class,passed=excluded.passed,
        captured_at=excluded.captured_at,recorded_at=excluded.recorded_at
    `).run(id, input.suiteDigest, input.evaluationVersion, input.evidenceClass,
      operationalPassed ? 1 : 0, input.capturedAt, recordedAt);
  }

  recordObservation(input: {
    lane: AgentRolloutLane;
    sessionId: string;
    parentRunId: string;
    reservationDigest?: string;
    qualifyingSample?: boolean;
    providerCalls?: number;
    providerErrors?: number;
    invalidCalls?: number;
    latencyMs?: number;
    playerSovereigntyViolations?: number;
    unauthorizedOrStaleWrites?: number;
    duplicateWrites?: number;
    sensitiveAuditViolations?: number;
  }): AgentLaneEvidence {
    const id = lane(input.lane);
    const sessionId = identity(input.sessionId, 'sessionId');
    const parentRunId = identity(input.parentRunId, 'parentRunId');
    if (input.reservationDigest !== undefined && !DIGEST_RE.test(input.reservationDigest)) {
      throw new Error('authorization-reservation-digest-invalid');
    }
    if (input.qualifyingSample !== undefined && typeof input.qualifyingSample !== 'boolean') {
      throw new Error('qualifyingSample-invalid');
    }
    const values = {
      providerCalls: nonNegative(input.providerCalls ?? 0, 'providerCalls'),
      providerErrors: nonNegative(input.providerErrors ?? 0, 'providerErrors'),
      invalidCalls: nonNegative(input.invalidCalls ?? 0, 'invalidCalls'),
      latencyMs: input.latencyMs === undefined ? null : nonNegative(input.latencyMs, 'latencyMs'),
      playerSovereigntyViolations: nonNegative(input.playerSovereigntyViolations ?? 0, 'playerSovereigntyViolations'),
      unauthorizedOrStaleWrites: nonNegative(input.unauthorizedOrStaleWrites ?? 0, 'unauthorizedOrStaleWrites'),
      duplicateWrites: nonNegative(input.duplicateWrites ?? 0, 'duplicateWrites'),
      sensitiveAuditViolations: nonNegative(input.sensitiveAuditViolations ?? 0, 'sensitiveAuditViolations'),
    };
    const now = this.#now().toISOString();
    const day = now.slice(0, 10);
    const providerAttempts = values.providerCalls + values.providerErrors;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`
      INSERT INTO agent_lane_daily_observation(
        lane,day,observation_version,provider_calls,provider_errors,invalid_calls,
        player_sovereignty_violations,unauthorized_or_stale_writes,duplicate_writes,sensitive_audit_violations
      ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lane,day,observation_version) DO UPDATE SET
        provider_calls=provider_calls+excluded.provider_calls,
        provider_errors=provider_errors+excluded.provider_errors,
        invalid_calls=invalid_calls+excluded.invalid_calls,
        player_sovereignty_violations=player_sovereignty_violations+excluded.player_sovereignty_violations,
        unauthorized_or_stale_writes=unauthorized_or_stale_writes+excluded.unauthorized_or_stale_writes,
        duplicate_writes=duplicate_writes+excluded.duplicate_writes,
        sensitive_audit_violations=sensitive_audit_violations+excluded.sensitive_audit_violations
      `).run(id, day, AGENT_LANE_OBSERVATION_VERSION, values.providerCalls, values.providerErrors,
        values.invalidCalls, values.playerSovereigntyViolations, values.unauthorizedOrStaleWrites,
        values.duplicateWrites, values.sensitiveAuditViolations);
      let qualifyingSampleAdded = 0;
      if (input.qualifyingSample === true) {
        const sample = this.#db.prepare(`
          INSERT OR IGNORE INTO agent_lane_qualifying_sample(
            lane,observation_version,session_id,parent_run_id,day,created_at
          ) VALUES(?,?,?,?,?,?)
        `).run(id, AGENT_LANE_OBSERVATION_VERSION, sessionId, parentRunId, day, now);
        qualifyingSampleAdded = Number(sample.changes);
      }
      if (values.providerCalls > 0 && values.latencyMs !== null) {
        this.#db.prepare(`
          INSERT INTO agent_lane_latency_histogram(
            lane,observation_version,day,bucket_upper_ms,sample_count
          ) VALUES(?,?,?,?,1) ON CONFLICT(lane,observation_version,day,bucket_upper_ms)
          DO UPDATE SET sample_count=sample_count+1
        `).run(id, AGENT_LANE_OBSERVATION_VERSION, day, latencyBucket(values.latencyMs));
      }
      let windowSequence: number;
      let reservedToRelease = 0;
      if (input.reservationDigest !== undefined) {
        const reservation = this.#db.prepare(`
          SELECT lane,window_sequence,reserved_provider_calls,status
          FROM agent_lane_provider_reservation WHERE reservation_digest=?
        `).get(input.reservationDigest) as SqlRow | undefined;
        if (!reservation || reservation.lane !== id) throw new Error('authorization-reservation-missing');
        if (reservation.status !== 'active') throw new Error('authorization-reservation-settled');
        reservedToRelease = positiveLimit(
          reservation.reserved_provider_calls, 'authorization-reservation-calls',
        );
        if (providerAttempts > reservedToRelease) throw new Error('authorization-reservation-overrun');
        windowSequence = positiveLimit(reservation.window_sequence, 'window-sequence');
        const settle = this.#db.prepare(`
          UPDATE agent_lane_provider_reservation
          SET status='settled',settled_provider_calls=?,settled_at=?
          WHERE reservation_digest=? AND status='active'
        `).run(providerAttempts, now, input.reservationDigest);
        if (Number(settle.changes) !== 1) throw new Error('authorization-reservation-conflict');
      } else {
        const currentWindow = this.#db.prepare(`
          SELECT window_sequence,max_provider_calls,provider_calls,provider_errors,
            reserved_provider_calls,status,superseded_at
          FROM agent_lane_authorization_window WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
        `).get(id) as SqlRow | undefined;
        if (!currentWindow || currentWindow.status !== 'active' || currentWindow.superseded_at !== null) {
          if (providerAttempts > 0) throw new Error('authorization-window-not-active');
        }
        windowSequence = positiveLimit(currentWindow?.window_sequence, 'window-sequence');
        const projected = Number(currentWindow!.provider_calls)
          + Number(currentWindow!.provider_errors)
          + Number(currentWindow!.reserved_provider_calls) + providerAttempts;
        if (providerAttempts > 0 && projected > Number(currentWindow!.max_provider_calls)) {
          throw new Error('authorization-window-call-budget-exhausted');
        }
      }
      const update = this.#db.prepare(`
        UPDATE agent_lane_authorization_window SET
          provider_calls=provider_calls+?,
          reserved_provider_calls=reserved_provider_calls-?,
          provider_errors=provider_errors+?,
          invalid_calls=invalid_calls+?,
          qualifying_samples=qualifying_samples+?,
          status=CASE WHEN provider_calls+provider_errors+?>=max_provider_calls THEN 'review' ELSE status END,
          closed_at=CASE WHEN provider_calls+provider_errors+?>=max_provider_calls AND closed_at IS NULL THEN ? ELSE closed_at END
        WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
      `).run(
        values.providerCalls, reservedToRelease, values.providerErrors, values.invalidCalls,
        qualifyingSampleAdded, providerAttempts, providerAttempts, now,
        id, windowSequence, reservedToRelease,
      );
      if (Number(update.changes) !== 1) throw new Error('authorization-window-accounting-failed');
      if (values.providerCalls > 0 && values.latencyMs !== null) {
        this.#db.prepare(`
          INSERT INTO agent_lane_authorization_window_latency(
            lane,window_sequence,bucket_upper_ms,sample_count
          ) VALUES(?,?,?,1) ON CONFLICT(lane,window_sequence,bucket_upper_ms)
          DO UPDATE SET sample_count=sample_count+1
        `).run(id, windowSequence, latencyBucket(values.latencyMs));
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.evidence(id);
  }

  evidence(laneId: AgentRolloutLane): AgentLaneEvidence {
    const id = lane(laneId);
    const evaluation = this.#db.prepare(
      'SELECT evidence_class,passed FROM agent_lane_evaluation WHERE lane=?',
    ).get(id) as SqlRow | undefined;
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS days,
        COALESCE(SUM(provider_calls),0) AS calls,COALESCE(SUM(provider_errors),0) AS errors,
        COALESCE(SUM(invalid_calls),0) AS invalid,
        COALESCE(SUM(player_sovereignty_violations),0) AS sovereignty,
        COALESCE(SUM(unauthorized_or_stale_writes),0) AS stale_writes,
        COALESCE(SUM(duplicate_writes),0) AS duplicate_writes,
        COALESCE(SUM(sensitive_audit_violations),0) AS sensitive
      FROM agent_lane_daily_observation WHERE lane=? AND observation_version=?
    `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
    const sampleRow = this.#db.prepare(`
      SELECT COUNT(*) AS samples FROM agent_lane_qualifying_sample
      WHERE lane=? AND observation_version=?
    `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
    const latencyRows = this.#db.prepare(`
      SELECT bucket_upper_ms,sample_count FROM agent_lane_latency_histogram
      WHERE lane=? AND observation_version=? ORDER BY bucket_upper_ms ASC
    `).all(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow[];
    const latencyTotal = latencyRows.reduce((sum, value) => sum + Number(value.sample_count), 0);
    const percentile = (ratio: number): number => {
      if (latencyTotal === 0) return 0;
      const target = Math.ceil(latencyTotal * ratio);
      let cumulative = 0;
      for (const value of latencyRows) {
        cumulative += Number(value.sample_count);
        if (cumulative >= target) return Number(value.bucket_upper_ms);
      }
      return Number(latencyRows.at(-1)?.bucket_upper_ms ?? 0);
    };
    const authorizationWindow = this.authorizationWindow(id);
    return Object.freeze({
      observationVersion: AGENT_LANE_OBSERVATION_VERSION,
      operationalEvaluationPassed: evaluation?.evidence_class === 'operational' && Number(evaluation.passed) === 1,
      qualifyingSamples: Number(sampleRow.samples), observationDays: Number(row.days),
      providerCalls: Number(row.calls), providerErrors: Number(row.errors), invalidCalls: Number(row.invalid),
      p50LatencyMs: percentile(0.50), p95LatencyMs: percentile(0.95),
      playerSovereigntyViolations: Number(row.sovereignty),
      unauthorizedOrStaleWrites: Number(row.stale_writes), duplicateWrites: Number(row.duplicate_writes),
      sensitiveAuditViolations: Number(row.sensitive),
      authorizationWindowCalls: authorizationWindow.providerCalls,
      authorizationWindowReservedCalls: authorizationWindow.reservedProviderCalls,
      authorizationWindowProviderErrors: authorizationWindow.providerErrors,
      authorizationWindowInvalidCalls: authorizationWindow.invalidCalls,
      authorizationWindowQualifyingSamples: authorizationWindow.qualifyingSamples,
      authorizationWindowP50LatencyMs: authorizationWindow.p50LatencyMs,
      authorizationWindowP95LatencyMs: authorizationWindow.p95LatencyMs,
      authorizationWindowMaxCalls: authorizationWindow.maxProviderCalls,
      authorizationWindowSequence: authorizationWindow.sequence,
    });
  }

  decide(laneId: AgentRolloutLane, sessionId: string, hostCeiling: AgentRolloutState): AgentLaneDecision {
    const current = this.get(laneId);
    const decision = evaluateAgentLaneRollout({
      lane: laneId, sessionId, desiredState: current.desiredState, hostCeiling, evidence: this.evidence(laneId),
    });
    if (decision.shouldKill) {
      const reason = decision.reasonCodes[0]!;
      if (current.desiredState !== 'killed'
        || (isPermanentKill(reason) && !isPermanentKill(current.killedReason))) {
        this.kill(laneId, reason);
      }
    }
    return decision;
  }

  /**
   * Removes session-identifying qualifying-sample keys while intentionally
   * retaining anonymous daily, safety, latency, and authorization aggregates.
   */
  deleteSessionReferences(sessionIdValue: string): { readonly qualifyingSamples: number } {
    const sessionId = identity(sessionIdValue, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const qualifyingSamples = Number(this.#db.prepare(
        'DELETE FROM agent_lane_qualifying_sample WHERE session_id=?',
      ).run(sessionId).changes);
      this.#db.exec('COMMIT');
      return Object.freeze({ qualifyingSamples });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  close(): void { this.#db.close(); }
}
