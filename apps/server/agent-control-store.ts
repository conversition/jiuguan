import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import {
  AGENT_CONTROL_AUTHORITY_MAX_REVISION,
  AGENT_CONTROL_V10_SQL,
  AGENT_CONTROL_V11_SQL,
  AGENT_MAINTENANCE_COHORT_GENERATION,
  AGENT_MAINTENANCE_ROUTE_TABLE_SQL,
  AGENT_MAINTENANCE_ROUTE_STATES,
  advanceAgentControlAuthority,
  createAgentControlAuthorityV10Triggers,
  createAgentControlAuthorityTriggers,
  inspectAgentControlAuthoritySchema,
  inspectAgentControlAuthoritySchemaV10,
  isAgentMaintenanceRouteEvidenceDigest,
  isAgentMaintenanceRouteTargetSessionId,
  readAgentControlAuthority,
  readAgentMaintenanceRouteControl,
  rotateAgentControlAuthorityGeneration,
  type AgentControlAuthorityCoordinate,
  type AgentMaintenanceRouteControl,
  type AgentMaintenanceRouteState,
} from './agent-control-authority.ts';
import {
  AGENT_LANE_OPERATOR_OVERRIDE_ACK,
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
  PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID,
  PLAYER_SOVEREIGNTY_POLICY_REVISION,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import type {
  MaintenanceTaskKind,
  NpcMaintenanceProposalRejectionCode,
} from './maintenance-types.ts';
import {
  MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
} from './maintenance-protocol-reasons.ts';

export {
  AGENT_LANE_OBSERVATION_VERSION,
  PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID,
  PLAYER_SOVEREIGNTY_POLICY_REVISION,
};

export const AGENT_CONTROL_DB_FILE = 'agent-control.sqlite';
export const AGENT_CONTROL_SCHEMA_VERSION = 12;
export const AGENT_CONTROL_APPLICATION_ID = 0x4a474143; // JGAC
/**
 * A defect-correction reopen must be able to reach the qualifying-sample gate that reviews it.
 * Interactive's policy-sized window remains the recommended ceiling; a smaller-than-gate window
 * would create another structurally impossible validation cycle.
 */
export const KNOWN_DEFECT_CORRECTION_MIN_PROVIDER_CALLS =
  AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples;
export const KNOWN_DEFECT_CORRECTION_MAX_PROVIDER_CALLS =
  AGENT_TEST_SESSION_WINDOW_CALLS.interactive;
export const LATENCY_SAMPLE_DENOMINATOR_DEFECT_ID =
  'latency-sample-denominator-v1' as const;
/** Preserve the reviewed defect signature's original narrow evidence bound. */
const KNOWN_DEFECT_CORRECTION_MAX_OBSERVATIONS = 16 as const;

const GENERIC_MAINTENANCE_INVALID_TOOL_REJECTION_CODES = [
  'invalid-protocol',
  'tool-not-allowed',
  'schema-rejected',
  'proposal-final-validation-failed',
  'memory-delta-empty',
  'memory-context-mismatch',
  'memory-source-ref-not-allowed',
  'memory-round-out-of-range',
  'memory-status-confidence-invalid',
  'memory-semantic-duplicate',
  'through-round-mismatch',
] as const;
const NPC_MAINTENANCE_INVALID_TOOL_REJECTION_CODE_RECORD:
  Readonly<Record<NpcMaintenanceProposalRejectionCode, true>> = Object.freeze({
  'proposal-shape-invalid': true,
  'proposal-value-invalid': true,
  'proposal-context-invalid': true,
  'proposal-binding-mismatch': true,
  'proposal-field-invalid': true,
  'proposal-duplicate-target': true,
  'source-ref-not-allowed': true,
  'source-ref-duplicate': true,
  'character-id-not-allowed': true,
  'character-version-stale': true,
  'effective-round-out-of-range': true,
  'identity-text-invalid': true,
  'relationship-target-not-allowed': true,
  'evidence-classification-invalid': true,
});

export type MaintenanceInvalidToolRejectionCode =
  | typeof GENERIC_MAINTENANCE_INVALID_TOOL_REJECTION_CODES[number]
  | NpcMaintenanceProposalRejectionCode;
const NPC_MAINTENANCE_INVALID_TOOL_REJECTION_CODES = Object.keys(
  NPC_MAINTENANCE_INVALID_TOOL_REJECTION_CODE_RECORD,
) as NpcMaintenanceProposalRejectionCode[];

/** Stable value-free codes accepted at the persistence boundary. Expanding this is a schema change. */
export const MAINTENANCE_INVALID_TOOL_REJECTION_CODES:
  readonly MaintenanceInvalidToolRejectionCode[] = Object.freeze([
  ...GENERIC_MAINTENANCE_INVALID_TOOL_REJECTION_CODES,
  ...NPC_MAINTENANCE_INVALID_TOOL_REJECTION_CODES,
]);

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
  /** Actual histogram observations; one Provider-call quota unit is not necessarily one sample. */
  readonly latencySamples: number;
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

export interface AgentLaneQualityRecoveryResult extends AgentLaneRecoveryResult {
  /** Capability quality stops cleared in the same transaction as the Lane recovery. */
  readonly recoveredCapabilities: readonly AgentCapabilityControlRow[];
}

/** Immutable audit row written by every operator quality-kill override. */
export interface AgentLaneOperatorOverrideRow {
  readonly overrideId: string;
  readonly lane: AgentRolloutLane;
  readonly suppressedKillReason: string;
  readonly sourceControlRevision: string;
  readonly supersededWindowSequence: number;
  readonly supersededMaxProviderCalls: number;
  readonly supersededProviderCalls: number;
  readonly supersededInvalidCalls: number;
  readonly supersededQualifyingSamples: number;
  readonly openedWindowSequence: number;
  readonly openedMaxProviderCalls: number;
  readonly reopenedTo: AgentRolloutState;
  readonly acknowledgement: string;
  readonly createdAt: string;
}

export interface AgentLaneOperatorOverrideResult extends AgentLaneRecoveryResult {
  readonly override: AgentLaneOperatorOverrideRow;
}

export type MaintenanceCapabilityId = Extract<AgentSubcapabilityId, `maintenance.${string}`>;

export interface ExpectedMaintenanceCapabilityKill {
  readonly capabilityId: MaintenanceCapabilityId;
  readonly expectedRevision: string;
}

interface MaintenanceCapabilityQualityKillRow extends AgentCapabilityControlRow {
  readonly capabilityId: MaintenanceCapabilityId;
  readonly killedReason: typeof MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON;
}

export interface AgentMaintenanceCapabilityQualityRecoveryResult extends AgentLaneRecoveryResult {
  readonly operation: 'capability-quality-recovery';
  readonly recoveredCapabilities: readonly AgentCapabilityControlRow[];
}

export interface AgentLaneReopenResult extends AgentLaneRecoveryResult {
  readonly operation: 'quality-recovery' | 'window-renewal' | 'known-defect-window-repair';
}

export interface AgentLatencySampleDenominatorRepairResult extends AgentLaneRecoveryResult {
  readonly operation: 'known-defect-latency-sample-denominator-v1';
}

export interface AgentKnownDefectCorrection {
  readonly defectId: typeof PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID;
  readonly lane: 'interactive';
  readonly killedReason: 'player-sovereignty-violation';
  readonly fixedPolicyRevision: typeof PLAYER_SOVEREIGNTY_POLICY_REVISION;
  readonly sourceControlRevision: string;
  readonly sourceWindowSequence: number;
  readonly sourceObservationVersion: typeof AGENT_LANE_OBSERVATION_VERSION;
  readonly sourceDay: string;
  readonly correctedPlayerSovereigntyViolations: number;
  /** Digest of the exact local kill/observation signature; no Provider replay is involved. */
  readonly signatureDigest: string;
  /** @deprecated Backward-compatible alias for signatureDigest. */
  readonly evidenceDigest: string;
  readonly createdAt: string;
}

export interface AgentKnownDefectRecoveryResult extends AgentLaneRecoveryResult {
  readonly operation: 'known-defect-correction';
  readonly correction: AgentKnownDefectCorrection;
}

export interface AgentProviderCallReservation {
  readonly reservationDigest: string;
  readonly maxModelCalls: number;
  readonly windowSequence: number;
  readonly laneControlRevision: string;
  readonly created: boolean;
}

/**
 * Content-free invalid Maintenance tool diagnostic. The store deliberately exposes no
 * arguments, prompt/model text, tool result, session id, or raw error message.
 */
export interface MaintenanceInvalidToolDiagnostic {
  readonly taskKind: MaintenanceTaskKind;
  readonly runId: string;
  readonly tool: string;
  readonly rejectionCode: MaintenanceInvalidToolRejectionCode;
  readonly count: number;
  /** ISO timestamp of the most recent matching rejection. */
  readonly timestamp: string;
}

export interface MaintenanceInvalidToolDiagnosticFilter {
  readonly taskKind?: MaintenanceTaskKind;
  readonly runId?: string;
  readonly tool?: string;
  readonly rejectionCode?: MaintenanceInvalidToolRejectionCode;
  /** Defaults to true so callers do not accidentally mix superseded authorization windows. */
  readonly currentWindow?: boolean;
}

export interface MaintenanceInvalidToolDiagnosticListFilter
  extends MaintenanceInvalidToolDiagnosticFilter {
  /** Most-recent aggregate rows to return. Defaults to 50 and is capped at 200. */
  readonly limit?: number;
}

export type MaintenanceProtocolRunOutcome = 'clean' | 'recovered' | 'failed';

export interface MaintenanceProtocolOutcomeRecord {
  readonly eventSequence: number;
  readonly windowSequence: number;
  readonly incidentGroup: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly runId: string;
  readonly outcome: MaintenanceProtocolRunOutcome;
  readonly timestamp: string;
}

export interface MaintenanceProtocolOutcomeResult {
  readonly record: MaintenanceProtocolOutcomeRecord;
  readonly currentWindow: boolean;
  /** Distinct incident groups in the uninterrupted trailing failed-run streak. */
  readonly failureStreakIncidentGroups: readonly string[];
}

const LATENCY_BUCKET_MS = 100;
const MAX_BOUNDED_LATENCY_MS = 120_000;
const OVERFLOW_LATENCY_BUCKET_MS = 86_400_000;

type SqlRow = Record<string, unknown>;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MAINTENANCE_INVALID_TOOL_REJECTION_CODE_SET: ReadonlySet<string> = new Set(
  MAINTENANCE_INVALID_TOOL_REJECTION_CODES,
);
const MAINTENANCE_TASK_KIND_RECORD: Readonly<Record<MaintenanceTaskKind, true>> = Object.freeze({
  memory_consolidation: true,
  branch_index: true,
  rolling_summary: true,
  npc_state: true,
  worldbook_repair: true,
});
const MAINTENANCE_TASK_KINDS = Object.freeze(
  Object.keys(MAINTENANCE_TASK_KIND_RECORD) as MaintenanceTaskKind[],
);
const MAINTENANCE_CAPABILITY_IDS = Object.freeze(
  AGENT_SUBCAPABILITY_IDS.filter(
    (capabilityId): capabilityId is MaintenanceCapabilityId => capabilityId.startsWith('maintenance.'),
  ),
);
const MAINTENANCE_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(MAINTENANCE_CAPABILITY_IDS);

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

const KNOWN_DEFECT_CORRECTION_SQL = `
  CREATE TABLE agent_lane_known_defect_correction (
    defect_id TEXT PRIMARY KEY
      CHECK(defect_id='${PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID}'),
    lane TEXT NOT NULL CHECK(lane='interactive'),
    killed_reason TEXT NOT NULL CHECK(killed_reason='player-sovereignty-violation'),
    fixed_policy_revision TEXT NOT NULL
      CHECK(fixed_policy_revision='${PLAYER_SOVEREIGNTY_POLICY_REVISION}'),
    source_control_revision TEXT NOT NULL,
    source_window_sequence INTEGER NOT NULL CHECK(source_window_sequence >= 1),
    source_observation_version TEXT NOT NULL,
    source_day TEXT NOT NULL,
    corrected_player_sovereignty_violations INTEGER NOT NULL
      CHECK(corrected_player_sovereignty_violations >= 1),
    evidence_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER agent_lane_known_defect_correction_no_update
    BEFORE UPDATE ON agent_lane_known_defect_correction BEGIN
      SELECT RAISE(ABORT, 'known-defect-correction-immutable');
    END;
  CREATE TRIGGER agent_lane_known_defect_correction_no_delete
    BEFORE DELETE ON agent_lane_known_defect_correction BEGIN
      SELECT RAISE(ABORT, 'known-defect-correction-immutable');
    END;
`;

/**
 * Append-only record of operator quality-kill overrides.
 *
 * The override is the only way to leave a quality stop without passing evidence, so every use
 * must be provable after the fact: which stop was cleared, what the stopped window measured,
 * which window replaced it, and what the caller acknowledged. Rows are immutable; a second
 * override appends a new row instead of editing history.
 */
const AGENT_LANE_OPERATOR_OVERRIDE_SQL = `
  CREATE TABLE agent_lane_operator_override (
    override_id TEXT PRIMARY KEY,
    lane TEXT NOT NULL CHECK(lane IN (${AGENT_ROLLOUT_LANES.map((value) => `'${value}'`).join(',')})),
    suppressed_kill_reason TEXT NOT NULL
      CHECK(suppressed_kill_reason IN (${AGENT_LANE_QUALITY_KILL_REASONS
        .map((value) => `'${value}'`).join(',')})),
    source_control_revision TEXT NOT NULL,
    superseded_window_sequence INTEGER NOT NULL CHECK(superseded_window_sequence >= 1),
    superseded_max_provider_calls INTEGER NOT NULL CHECK(superseded_max_provider_calls >= 1),
    superseded_provider_calls INTEGER NOT NULL CHECK(superseded_provider_calls >= 0),
    superseded_invalid_calls INTEGER NOT NULL CHECK(superseded_invalid_calls >= 0),
    superseded_qualifying_samples INTEGER NOT NULL CHECK(superseded_qualifying_samples >= 0),
    opened_window_sequence INTEGER NOT NULL CHECK(opened_window_sequence >= 1),
    opened_max_provider_calls INTEGER NOT NULL CHECK(opened_max_provider_calls >= 1),
    reopened_to TEXT NOT NULL CHECK(reopened_to IN ('off','shadow','test-session')),
    acknowledgement TEXT NOT NULL CHECK(acknowledgement='${AGENT_LANE_OPERATOR_OVERRIDE_ACK}'),
    created_at TEXT NOT NULL
  );
  CREATE INDEX agent_lane_operator_override_lane
    ON agent_lane_operator_override(lane,created_at);
  CREATE TRIGGER agent_lane_operator_override_no_update
    BEFORE UPDATE ON agent_lane_operator_override BEGIN
      SELECT RAISE(ABORT, 'operator-override-immutable');
    END;
  CREATE TRIGGER agent_lane_operator_override_no_delete
    BEFORE DELETE ON agent_lane_operator_override BEGIN
      SELECT RAISE(ABORT, 'operator-override-immutable');
    END;
`;

const MAINTENANCE_INVALID_TOOL_DIAGNOSTIC_SQL = `
  CREATE TABLE maintenance_invalid_tool_diagnostic (
    window_sequence INTEGER NOT NULL CHECK(window_sequence >= 1),
    task_kind TEXT NOT NULL CHECK(task_kind IN (${MAINTENANCE_TASK_KINDS
      .map((value) => `'${value}'`).join(',')})),
    run_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    rejection_code TEXT NOT NULL CHECK(rejection_code IN (${MAINTENANCE_INVALID_TOOL_REJECTION_CODES
      .map((value) => `'${value}'`).join(',')})),
    run_failed INTEGER NOT NULL CHECK(run_failed IN (0,1)),
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY(window_sequence,task_kind,run_id,tool,rejection_code)
  );
  CREATE INDEX maintenance_invalid_tool_diagnostic_task_window
    ON maintenance_invalid_tool_diagnostic(task_kind,window_sequence,occurred_at);
  CREATE INDEX maintenance_invalid_tool_diagnostic_run
    ON maintenance_invalid_tool_diagnostic(run_id,occurred_at);
  CREATE INDEX maintenance_invalid_tool_diagnostic_code_window
    ON maintenance_invalid_tool_diagnostic(rejection_code,window_sequence,occurred_at);
`;

const MAINTENANCE_PROTOCOL_RUN_OUTCOME_SQL = `
  CREATE TABLE maintenance_protocol_run_outcome (
    event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    window_sequence INTEGER NOT NULL CHECK(window_sequence >= 1),
    incident_group TEXT NOT NULL,
    task_kind TEXT NOT NULL CHECK(task_kind IN (${MAINTENANCE_TASK_KINDS
      .map((value) => `'${value}'`).join(',')})),
    run_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('clean','recovered','failed')),
    occurred_at TEXT NOT NULL,
    UNIQUE(window_sequence,run_id)
  );
  CREATE INDEX maintenance_protocol_run_outcome_window_sequence
    ON maintenance_protocol_run_outcome(window_sequence,event_sequence);
`;

function initialize(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as SqlRow).user_version);
  const applicationId = Number((db.prepare('PRAGMA application_id').get() as SqlRow).application_id);
  if (version > AGENT_CONTROL_SCHEMA_VERSION) throw new Error('agent control database too new');
  if (version === AGENT_CONTROL_SCHEMA_VERSION && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    inspectAgentControlAuthoritySchema(db);
    return;
  }
  if (version === 10 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    db.exec('BEGIN IMMEDIATE');
    try {
      inspectAgentControlAuthoritySchemaV10(db);
      const route = db.prepare(
        'SELECT state,revision,updated_at FROM agent_maintenance_route_control WHERE singleton=1',
      ).get() as SqlRow;
      const revision = Number(route.revision);
      if (!Number.isSafeInteger(revision)
        || revision < 0
        || revision >= AGENT_CONTROL_AUTHORITY_MAX_REVISION) {
        throw new Error('agent-control-v10-route-revision-exhausted');
      }
      const previousUpdatedAt = Date.parse(String(route.updated_at));
      const updatedAtMs = Math.max(Date.now(), previousUpdatedAt + 1);
      if (!Number.isFinite(updatedAtMs)) {
        throw new Error('agent-control-v10-route-updated-at-invalid');
      }
      const updatedAt = new Date(updatedAtMs).toISOString();
      const migratedState = route.state === 'killed' ? 'killed' : 'off';
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'agent_control_authority_%'
        ORDER BY name
      `).all() as Array<{ name?: unknown }>;
      for (const row of triggers) {
        const name = String(row.name ?? '').replaceAll('"', '""');
        db.exec(`DROP TRIGGER "${name}"`);
      }
      db.exec(`
        ALTER TABLE agent_maintenance_route_control
          RENAME TO agent_maintenance_route_control_v10;
        ${AGENT_MAINTENANCE_ROUTE_TABLE_SQL}
      `);
      db.prepare(`INSERT INTO agent_maintenance_route_control(
        singleton,cohort_generation,state,target_session_id,evidence_digest,revision,updated_at
      ) VALUES(1,?,?,NULL,NULL,?,?)`).run(
        AGENT_MAINTENANCE_COHORT_GENERATION,
        migratedState,
        revision + 1,
        updatedAt,
      );
      db.exec('DROP TABLE agent_maintenance_route_control_v10');
      createAgentControlAuthorityTriggers(db);
      db.exec('PRAGMA user_version=11');
      inspectAgentControlAuthoritySchema(db);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
    initialize(db); return;
  }
  if (version === 11 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    // v11 had no operator escape hatch from a quality stop. Because a stopped lane cannot
    // produce the passing evidence that recovery demands, such a stop was unrecoverable.
    // Add the append-only audit ledger that every override must write to.
    db.exec(AGENT_LANE_OPERATOR_OVERRIDE_SQL);
    db.exec(`PRAGMA user_version=${AGENT_CONTROL_SCHEMA_VERSION}`);
    return;
  }
  if (version === 9 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    const expectedTables = [
      'agent_capability_control', 'agent_lane_authorization_window',
      'agent_lane_authorization_window_latency', 'agent_lane_control', 'agent_lane_daily',
      'agent_lane_daily_observation', 'agent_lane_evaluation',
      'agent_lane_known_defect_correction', 'agent_lane_latency_histogram',
      'agent_lane_provider_reservation', 'agent_lane_qualifying_sample',
      'maintenance_invalid_tool_diagnostic', 'maintenance_protocol_run_outcome',
    ].sort();
    const actualTables = (db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? ''));
    const forbidden = db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'agent_control_authority_%' OR name IN ('agent_control_authority','agent_maintenance_route_control','agent_asset_mutation_pending') LIMIT 1").get();
    if (actualTables.join(',') !== expectedTables.join(',') || forbidden
      || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
      throw new Error('agent-control-v9-predecessor-invalid');
    }
    const generation = `agent-control:${randomUUID()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(AGENT_CONTROL_V10_SQL);
      db.prepare('INSERT INTO agent_control_authority(singleton,generation,revision) VALUES(1,?,0)').run(generation);
      db.prepare(`INSERT INTO agent_maintenance_route_control(singleton,cohort_generation,state,revision,updated_at)
        VALUES(1,?,'off',0,?)`).run(AGENT_MAINTENANCE_COHORT_GENERATION, new Date().toISOString());
      createAgentControlAuthorityV10Triggers(db);
      db.exec('PRAGMA user_version=10; COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
    initialize(db); return;
  }
  if (version === 8 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    // v8 froze the content-free diagnostics CHECK before strict Memory proposals
    // gained field-level rejection codes. Rebuild only this append-only table,
    // preserving every prior aggregate while expanding the value-free allowlist.
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE maintenance_invalid_tool_diagnostic
        RENAME TO maintenance_invalid_tool_diagnostic_v8;
      DROP INDEX maintenance_invalid_tool_diagnostic_task_window;
      DROP INDEX maintenance_invalid_tool_diagnostic_run;
      DROP INDEX maintenance_invalid_tool_diagnostic_code_window;
      ${MAINTENANCE_INVALID_TOOL_DIAGNOSTIC_SQL}
      INSERT INTO maintenance_invalid_tool_diagnostic(
        window_sequence,task_kind,run_id,tool,rejection_code,run_failed,
        occurrence_count,occurred_at
      )
      SELECT window_sequence,task_kind,run_id,tool,rejection_code,run_failed,
        occurrence_count,occurred_at
      FROM maintenance_invalid_tool_diagnostic_v8;
      DROP TABLE maintenance_invalid_tool_diagnostic_v8;
      PRAGMA user_version = 9;
      COMMIT;
    `);
    initialize(db); return;
  }
  if (version === 7 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    db.exec(`
      BEGIN IMMEDIATE;
      ${MAINTENANCE_INVALID_TOOL_DIAGNOSTIC_SQL}
      ${MAINTENANCE_PROTOCOL_RUN_OUTCOME_SQL}
      PRAGMA user_version = 9;
      COMMIT;
    `);
    initialize(db); return;
  }
  if (version === 6 && applicationId === AGENT_CONTROL_APPLICATION_ID) {
    db.exec(`
      BEGIN IMMEDIATE;
      ${KNOWN_DEFECT_CORRECTION_SQL}
      PRAGMA user_version = 7;
      COMMIT;
    `);
    initialize(db);
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
        PRAGMA user_version = 6;
        COMMIT;
      `);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    initialize(db);
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
    ${KNOWN_DEFECT_CORRECTION_SQL}
    ${MAINTENANCE_INVALID_TOOL_DIAGNOSTIC_SQL}
    ${MAINTENANCE_PROTOCOL_RUN_OUTCOME_SQL}
    PRAGMA user_version = 9;
    COMMIT;
  `);
  const generation = `agent-control:${randomUUID()}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(AGENT_CONTROL_V11_SQL);
    db.exec(AGENT_LANE_OPERATOR_OVERRIDE_SQL);
    db.prepare(
      'INSERT INTO agent_control_authority(singleton,generation,revision) VALUES(1,?,0)',
    ).run(generation);
    db.prepare(`INSERT INTO agent_maintenance_route_control(
      singleton,cohort_generation,state,target_session_id,evidence_digest,revision,updated_at
    ) VALUES(1,?,'off',NULL,NULL,0,?)`).run(
      AGENT_MAINTENANCE_COHORT_GENERATION,
      new Date().toISOString(),
    );
    createAgentControlAuthorityTriggers(db);
    db.exec(`PRAGMA user_version=${AGENT_CONTROL_SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
  inspectAgentControlAuthoritySchema(db);
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

function nullableKillReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    throw new Error('agent-control-killed-reason-invalid');
  }
  return value;
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

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label}-invalid`);
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

function maintenanceTaskKind(value: unknown): MaintenanceTaskKind {
  if (typeof value !== 'string'
    || !(MAINTENANCE_TASK_KINDS as readonly string[]).includes(value)) {
    throw new Error('maintenance-diagnostic-task-kind-invalid');
  }
  return value as MaintenanceTaskKind;
}

function maintenanceInvalidToolRejectionCode(
  value: unknown,
): MaintenanceInvalidToolRejectionCode {
  if (typeof value !== 'string' || !MAINTENANCE_INVALID_TOOL_REJECTION_CODE_SET.has(value)) {
    throw new Error('maintenance-diagnostic-rejection-code-invalid');
  }
  return value as MaintenanceInvalidToolRejectionCode;
}

function diagnosticTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error('maintenance-diagnostic-timestamp-invalid');
  }
  return value;
}

function maintenanceDiagnostic(row: SqlRow): MaintenanceInvalidToolDiagnostic {
  return Object.freeze({
    taskKind: maintenanceTaskKind(row.task_kind),
    runId: identity(row.run_id, 'maintenance-diagnostic-run-id'),
    tool: identity(row.tool, 'maintenance-diagnostic-tool'),
    rejectionCode: maintenanceInvalidToolRejectionCode(row.rejection_code),
    count: positiveInteger(row.occurrence_count, 'maintenance-diagnostic-count'),
    timestamp: diagnosticTimestamp(row.occurred_at),
  });
}

function maintenanceProtocolRunOutcome(value: unknown): MaintenanceProtocolRunOutcome {
  if (value !== 'clean' && value !== 'recovered' && value !== 'failed') {
    throw new Error('maintenance-protocol-outcome-invalid');
  }
  return value;
}

function maintenanceProtocolOutcomeRecord(row: SqlRow): MaintenanceProtocolOutcomeRecord {
  return Object.freeze({
    eventSequence: positiveInteger(row.event_sequence, 'maintenance-protocol-event-sequence'),
    windowSequence: positiveInteger(row.window_sequence, 'maintenance-protocol-window-sequence'),
    incidentGroup: identity(row.incident_group, 'maintenance-protocol-incident-group'),
    taskKind: maintenanceTaskKind(row.task_kind),
    runId: identity(row.run_id, 'maintenance-protocol-run-id'),
    outcome: maintenanceProtocolRunOutcome(row.outcome),
    timestamp: diagnosticTimestamp(row.occurred_at),
  });
}

function controlRevision(value: unknown): string {
  if (typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error('agent-control-revision-invalid');
  }
  return value;
}

function readMaintenanceOperationalEvidenceDigest(db: DatabaseSync): string | null {
  const rows = db.prepare(`
    SELECT lane,suite_digest,evaluation_version,evidence_class,passed,captured_at,recorded_at
    FROM agent_lane_evaluation WHERE lane='maintenance'
  `).all() as SqlRow[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const passed = Number(row.passed);
  if (rows.length !== 1
    || row.lane !== 'maintenance'
    || typeof row.suite_digest !== 'string' || !DIGEST_RE.test(row.suite_digest)
    || typeof row.evaluation_version !== 'string' || !TOKEN_RE.test(row.evaluation_version)
    || (row.evidence_class !== 'fixture' && row.evidence_class !== 'operational')
    || !Number.isSafeInteger(passed) || (passed !== 0 && passed !== 1)
    || (row.evidence_class === 'fixture' && passed !== 0)) {
    throw new Error('agent-control-maintenance-evaluation-invalid');
  }
  const capturedAt = controlRevision(row.captured_at);
  const recordedAt = controlRevision(row.recorded_at);
  if (Date.parse(capturedAt) > Date.parse(recordedAt)) {
    throw new Error('agent-control-maintenance-evaluation-invalid');
  }
  return row.evidence_class === 'operational' && passed === 1
    ? row.suite_digest
    : null;
}

function maintenanceCapabilityId(value: unknown): MaintenanceCapabilityId {
  if (typeof value !== 'string' || !MAINTENANCE_CAPABILITY_ID_SET.has(value)) {
    throw new Error('maintenance-capability-id-invalid');
  }
  return value as MaintenanceCapabilityId;
}

function latencyBucket(value: number): number {
  if (value > MAX_BOUNDED_LATENCY_MS) return OVERFLOW_LATENCY_BUCKET_MS;
  return Math.ceil(value / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
}

export interface AgentControlFenceSnapshot {
  readonly authority: AgentControlAuthorityCoordinate;
  readonly maintenanceRoute: AgentMaintenanceRouteControl;
  readonly maintenanceOperationalEvidenceDigest: string | null;
  readonly maintenanceLane: AgentLaneControlRow;
  readonly maintenanceCapabilities: readonly AgentCapabilityControlRow[];
  readonly currentQuota: Readonly<{
    windowSequence: number;
    maxProviderCalls: number;
    providerCalls: number;
    providerErrors: number;
    reservedProviderCalls: number;
    status: 'active' | 'review';
  }>;
}

export interface AgentMaintenanceRouteControlCasInput {
  readonly expectedRevision: number;
  readonly state: AgentMaintenanceRouteState;
  readonly targetSessionId: string | null;
  readonly evidenceDigest: string | null;
}

const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function agentControlAsync() {});
const GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(
  function* agentControlGenerator() {},
);
const ASYNC_GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(
  async function* agentControlAsyncGenerator() {},
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

function synchronousCallback(callback: unknown): callback is (...args: never[]) => unknown {
  if (typeof callback !== 'function' || nodeTypes.isProxy(callback)
    || nodeTypes.isAsyncFunction(callback) || nodeTypes.isGeneratorFunction(callback)) return false;
  const prototype = Object.getPrototypeOf(callback);
  return prototype !== ASYNC_FUNCTION_PROTOTYPE
    && prototype !== GENERATOR_FUNCTION_PROTOTYPE
    && prototype !== ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
}
function asynchronousResult(value: unknown): boolean {
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

const AGENT_CONTROL_STORE_INSTANCES = new WeakSet<object>();

/** Internal exact-instance seal used by production claim composition. */
export function isAgentControlStoreInstanceInternal(
  value: unknown,
): value is AgentControlStore {
  return typeof value === 'object' && value !== null
    && AGENT_CONTROL_STORE_INSTANCES.has(value);
}

export class AgentControlStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #path: string;

  constructor(input: { dataDir: string; now?: () => Date }) {
    const root = resolve(input.dataDir);
    mkdirSync(root, { recursive: true });
    const path = join(root, AGENT_CONTROL_DB_FILE);
    this.#path = path;
    const existed = existsSync(path);
    this.#db = new DatabaseSync(path);
    try {
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
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      inspectAgentControlAuthoritySchema(this.#db);
      rotateAgentControlAuthorityGeneration(this.#db);
      inspectAgentControlAuthoritySchema(this.#db);
      this.#db.exec('COMMIT');
    } catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
    if (!existed) { try { chmodSync(path, 0o600); } catch { /* Windows ACL remains authoritative. */ } }
    } catch (error) {
      try { this.#db.close(); } catch { /* preserve startup error */ }
      throw error;
    }
    AGENT_CONTROL_STORE_INSTANCES.add(this);
  }

  /** Point-in-time observation only; no writer reservation survives this call. */
  authorityCoordinate(): AgentControlAuthorityCoordinate { return readAgentControlAuthority(this.#db); }

  maintenanceRouteControl(): AgentMaintenanceRouteControl {
    return readAgentMaintenanceRouteControl(this.#db);
  }

  setMaintenanceRouteControl(
    input: AgentMaintenanceRouteControlCasInput,
  ): AgentMaintenanceRouteControl {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || nodeTypes.isProxy(input)) {
      throw new Error('agent-control-maintenance-route-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors).sort();
    const expectedKeys = [
      'evidenceDigest', 'expectedRevision', 'state', 'targetSessionId',
    ];
    if (keys.join(',') !== expectedKeys.join(',')
      || expectedKeys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
          || descriptor.get !== undefined || descriptor.set !== undefined;
      })) {
      throw new Error('agent-control-maintenance-route-invalid');
    }
    const {
      expectedRevision,
      state: nextState,
      targetSessionId,
      evidenceDigest,
    } = input;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !AGENT_MAINTENANCE_ROUTE_STATES.includes(nextState)
      || (nextState === 'canary-5'
        ? !isAgentMaintenanceRouteTargetSessionId(targetSessionId)
          || !isAgentMaintenanceRouteEvidenceDigest(evidenceDigest)
        : targetSessionId !== null || evidenceDigest !== null)) {
      throw new Error('agent-control-maintenance-route-invalid');
    }
    const current = readAgentMaintenanceRouteControl(this.#db);
    if (current.revision !== expectedRevision) throw new Error('agent-control-maintenance-route-conflict');
    const updatedAt = new Date(Math.max(this.#now().getTime(), Date.parse(current.updatedAt) + 1)).toISOString();
    const result = this.#db.prepare(`UPDATE agent_maintenance_route_control
      SET state=?,target_session_id=?,evidence_digest=?,revision=revision+1,updated_at=?
      WHERE singleton=1 AND revision=?`).run(
        nextState,
        targetSessionId,
        evidenceDigest,
        updatedAt,
        expectedRevision,
      );
    if (result.changes !== 1) throw new Error('agent-control-maintenance-route-conflict');
    return readAgentMaintenanceRouteControl(this.#db);
  }

  withClaimFence<T>(callback: (snapshot: AgentControlFenceSnapshot) => T): T {
    if (!synchronousCallback(callback)) throw new Error('agent-control-claim-fence-callback-invalid');
    inspectAgentControlAuthoritySchema(this.#db);
    const db = new DatabaseSync(this.#path); let output!: T; let hasOutput = false; let error: unknown;
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); inspectAgentControlAuthoritySchema(db);
      if (db.prepare('SELECT 1 FROM agent_asset_mutation_pending LIMIT 1').get()) throw new Error('agent-control-asset-mutation-pending');
      const laneRow = db.prepare("SELECT lane,desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane='maintenance'").get() as SqlRow;
      const caps = db.prepare("SELECT capability_id,killed_reason,updated_at FROM agent_capability_control WHERE capability_id LIKE 'maintenance.%' ORDER BY capability_id").all() as SqlRow[];
      if (caps.length !== MAINTENANCE_CAPABILITY_IDS.length
        || caps.some((row) => !MAINTENANCE_CAPABILITY_ID_SET.has(String(row.capability_id)))) {
        throw new Error('agent-control-maintenance-capability-set-invalid');
      }
      const quota = db.prepare(`SELECT window_sequence,max_provider_calls,provider_calls,
        provider_errors,reserved_provider_calls,status,superseded_at
        FROM agent_lane_authorization_window WHERE lane='maintenance'
        ORDER BY window_sequence DESC LIMIT 1`).get() as SqlRow | undefined;
      if (!quota || (quota.status !== 'active' && quota.status !== 'review')
        || quota.superseded_at !== null) {
        throw new Error('agent-control-current-quota-invalid');
      }
      const windowSequence = positiveLimit(quota.window_sequence, 'window-sequence');
      const maxProviderCalls = positiveLimit(quota.max_provider_calls, 'window-max-calls');
      const providerCalls = nonNegative(quota.provider_calls, 'window-provider-calls');
      const providerErrors = nonNegative(quota.provider_errors, 'window-provider-errors');
      const reservedProviderCalls = nonNegative(
        quota.reserved_provider_calls,
        'window-reserved-calls',
      );
      if (providerCalls + providerErrors + reservedProviderCalls > maxProviderCalls) {
        throw new Error('agent-control-current-quota-invalid');
      }
      const maintenanceLaneState = state(laneRow.desired_state);
      const maintenanceLaneKilledReason = nullableKillReason(laneRow.killed_reason);
      if ((maintenanceLaneState === 'killed') !== (maintenanceLaneKilledReason !== null)) {
        throw new Error('agent-control-lane-kill-state-invalid');
      }
      const snapshot: AgentControlFenceSnapshot = Object.freeze({ authority: readAgentControlAuthority(db), maintenanceRoute: readAgentMaintenanceRouteControl(db),
        maintenanceOperationalEvidenceDigest: readMaintenanceOperationalEvidenceDigest(db),
        maintenanceLane: Object.freeze({ lane: 'maintenance', desiredState: maintenanceLaneState, killedReason: maintenanceLaneKilledReason, revision: controlRevision(laneRow.updated_at) }),
        maintenanceCapabilities: Object.freeze(caps.map((row) => Object.freeze({ capabilityId: maintenanceCapabilityId(row.capability_id), killedReason: nullableKillReason(row.killed_reason), revision: controlRevision(row.updated_at) }))),
        currentQuota: Object.freeze({
          windowSequence,
          maxProviderCalls,
          providerCalls,
          providerErrors,
          reservedProviderCalls,
          status: quota.status,
        }), });
      const result = callback(snapshot); if (asynchronousResult(result)) throw new Error('agent-control-claim-fence-result-async'); output = result; hasOutput = true;
    } catch (cause) { error = cause; }
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (cause) { error ??= cause; }
    try { db.close(); } catch (cause) { error ??= cause; }
    if (error !== undefined) throw error; if (!hasOutput) throw new Error('agent-control-claim-fence-result-missing'); return output;
  }

  withAssetMutation<T>(callback: () => T): T {
    if (!synchronousCallback(callback)) throw new Error('agent-control-asset-mutation-callback-invalid');
    inspectAgentControlAuthoritySchema(this.#db);
    const db = new DatabaseSync(this.#path); const mutationId = `asset-mutation:${randomUUID()}`;
    let output!: T; let hasOutput = false; let callbackError: unknown; let primaryError: unknown;
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); inspectAgentControlAuthoritySchema(db);
      db.prepare('INSERT INTO agent_asset_mutation_pending(singleton,mutation_id,started_at) VALUES(1,?,?)')
        .run(mutationId, this.#now().toISOString());
      db.exec('COMMIT');
      db.exec('BEGIN IMMEDIATE'); inspectAgentControlAuthoritySchema(db);
      try {
        const result = callback();
        if (asynchronousResult(result)) throw new Error('agent-control-asset-mutation-result-async');
        output = result; hasOutput = true;
      } catch (error) { callbackError = error; }
      advanceAgentControlAuthority(db);
      if (db.prepare('DELETE FROM agent_asset_mutation_pending WHERE singleton=1 AND mutation_id=?').run(mutationId).changes !== 1) {
        throw new Error('agent-control-asset-mutation-pending-invalid');
      }
      db.exec('COMMIT');
    } catch (error) { primaryError = error; try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* preserve original */ } }
    try { db.close(); } catch (error) { primaryError ??= error; }
    if (primaryError !== undefined) throw primaryError;
    if (callbackError !== undefined) throw callbackError;
    if (!hasOutput) throw new Error('agent-control-asset-mutation-result-missing');
    return output;
  }

  recoverAssetMutationPending<T>(callback: () => T): T {
    if (!synchronousCallback(callback)) throw new Error('agent-control-asset-recovery-callback-invalid');
    inspectAgentControlAuthoritySchema(this.#db);
    const db = new DatabaseSync(this.#path); let output!: T; let hasOutput = false; let error: unknown;
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); inspectAgentControlAuthoritySchema(db);
      const pending = db.prepare('SELECT mutation_id FROM agent_asset_mutation_pending WHERE singleton=1').get() as { mutation_id?: unknown } | undefined;
      const result = callback();
      if (asynchronousResult(result)) throw new Error('agent-control-asset-recovery-result-async');
      output = result; hasOutput = true;
      if (pending) {
        if (typeof pending.mutation_id !== 'string') throw new Error('agent-control-asset-mutation-pending-invalid');
        advanceAgentControlAuthority(db);
        if (db.prepare('DELETE FROM agent_asset_mutation_pending WHERE singleton=1 AND mutation_id=?').run(pending.mutation_id).changes !== 1) {
          throw new Error('agent-control-asset-mutation-pending-invalid');
        }
        db.exec('COMMIT');
      } else {
        // Startup already rotated authority generation. A no-pending recovery callback therefore
        // cannot leave an old claim coordinate reusable and must not invent an extra revision.
        db.exec('ROLLBACK');
      }
    } catch (cause) { error = cause; try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* preserve original */ } }
    try { db.close(); } catch (cause) { error ??= cause; }
    if (error !== undefined) throw error; if (!hasOutput) throw new Error('agent-control-asset-recovery-result-missing'); return output;
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

  #requireNoPermanentSafetyEvidence(laneId: AgentRolloutLane): void {
    // Use effective evidence so an immutable, explicitly corrected known defect does not poison
    // every later quality recovery. Raw safety rows remain stored and auditable; only the exact
    // correction ledger can subtract them. Any new/unmatched permanent evidence still blocks.
    const permanentEvidence = this.evidence(laneId);
    if (permanentEvidence.playerSovereigntyViolations > 0
      || permanentEvidence.unauthorizedOrStaleWrites > 0
      || permanentEvidence.duplicateWrites > 0
      || permanentEvidence.sensitiveAuditViolations > 0) {
      throw new Error('lane-permanent-kill');
    }
  }

  #requireOperationalRecoveryEvidence(
    laneId: AgentRolloutLane,
    evidenceDigest: string,
    newerThanRevisions: readonly string[],
  ): Readonly<{ capturedAt: string; recordedAt: string }> {
    if (!DIGEST_RE.test(evidenceDigest)) throw new Error('lane-recovery-evidence-invalid');
    if (newerThanRevisions.length < 1) throw new Error('lane-recovery-revision-required');
    const revisions = newerThanRevisions.map(controlRevision);
    const evaluation = this.#db.prepare(`
      SELECT suite_digest,evidence_class,passed,captured_at,recorded_at
      FROM agent_lane_evaluation WHERE lane=?
    `).get(laneId) as SqlRow | undefined;
    if (!evaluation || evaluation.suite_digest !== evidenceDigest) {
      throw new Error('lane-recovery-evidence-missing');
    }
    if (evaluation.evidence_class !== 'operational' || Number(evaluation.passed) !== 1) {
      throw new Error('lane-recovery-evidence-not-operational');
    }
    const latestRequiredMs = Math.max(...revisions.map((revision) => Date.parse(revision)));
    const recordedAt = typeof evaluation.recorded_at === 'string' ? evaluation.recorded_at : '';
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) <= latestRequiredMs) {
      throw new Error('lane-recovery-evidence-stale-recorded-at');
    }
    const capturedAt = typeof evaluation.captured_at === 'string' ? evaluation.captured_at : '';
    if (!Number.isFinite(Date.parse(capturedAt)) || Date.parse(capturedAt) <= latestRequiredMs) {
      throw new Error('lane-recovery-evidence-stale-captured-at');
    }
    return Object.freeze({ capturedAt, recordedAt });
  }

  #maintenanceProtocolQualityCapabilityRows(): readonly MaintenanceCapabilityQualityKillRow[] {
    const placeholders = MAINTENANCE_CAPABILITY_IDS.map(() => '?').join(',');
    const rows = this.#db.prepare(`
      SELECT capability_id,killed_reason,updated_at FROM agent_capability_control
      WHERE capability_id IN (${placeholders}) AND killed_reason=?
      ORDER BY capability_id ASC
    `).all(
      ...MAINTENANCE_CAPABILITY_IDS,
      MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
    ) as SqlRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      capabilityId: maintenanceCapabilityId(row.capability_id),
      killedReason: MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
      revision: controlRevision(row.updated_at),
    })));
  }

  #clearMaintenanceProtocolQualityCapabilities(
    rows: readonly MaintenanceCapabilityQualityKillRow[],
  ): readonly MaintenanceCapabilityId[] {
    const cleared: MaintenanceCapabilityId[] = [];
    for (const row of rows) {
      const capabilityId = maintenanceCapabilityId(row.capabilityId);
      const update = this.#db.prepare(`
        UPDATE agent_capability_control SET killed_reason=NULL,updated_at=?
        WHERE capability_id=? AND updated_at=? AND killed_reason=?
      `).run(
        this.#nextRevision(row.revision), capabilityId, row.revision,
        MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
      );
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      cleared.push(capabilityId);
    }
    return Object.freeze(cleared);
  }

  #supersedeWindowAndOpenClean(input: {
    lane: AgentRolloutLane;
    expectedWindowSequence: number;
    maxProviderCalls: number;
    reason: 'quality-recovery' | 'capability-quality-recovery'
      | 'operator-override'
      | 'known-defect-underprovisioned-window'
      | 'known-defect:latency-sample-denominator-v1';
    now: string;
  }): void {
    const sequence = positiveLimit(input.expectedWindowSequence, 'expected-window-sequence');
    const window = this.#db.prepare(`
      SELECT window_sequence,reserved_provider_calls,status,superseded_at
      FROM agent_lane_authorization_window WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
    `).get(input.lane) as SqlRow | undefined;
    if (!window) throw new Error('agent-authorization-window-missing');
    if (positiveLimit(window.window_sequence, 'window-sequence') !== sequence) {
      throw new Error('authorization-window-sequence-conflict');
    }
    if (!['active', 'review'].includes(String(window.status)) || window.superseded_at !== null) {
      throw new Error('authorization-window-not-active');
    }

    // Tickets issued but not begun before recovery must not survive into the clean window.
    // Started leases remain bound to the superseded window and settle there.
    const unstarted = this.#db.prepare(`
      SELECT reservation_digest,reserved_provider_calls
      FROM agent_lane_provider_reservation
      WHERE lane=? AND window_sequence=? AND status='active' AND started_at IS NULL
    `).all(input.lane, sequence) as SqlRow[];
    const unstartedCalls = unstarted.reduce(
      (sum, reservation) => sum + Number(reservation.reserved_provider_calls), 0,
    );
    if (unstartedCalls > 0) {
      const release = this.#db.prepare(`
        UPDATE agent_lane_authorization_window
        SET reserved_provider_calls=reserved_provider_calls-?
        WHERE lane=? AND window_sequence=? AND reserved_provider_calls>=?
      `).run(unstartedCalls, input.lane, sequence, unstartedCalls);
      if (Number(release.changes) !== 1) throw new Error('authorization-window-accounting-failed');
      for (const reservation of unstarted) {
        const invalidated = this.#db.prepare(`
          UPDATE agent_lane_provider_reservation
          SET status='released',settled_provider_calls=0,settled_at=?
          WHERE reservation_digest=? AND status='active' AND started_at IS NULL
        `).run(input.now, String(reservation.reservation_digest));
        if (Number(invalidated.changes) !== 1) throw new Error('authorization-reservation-conflict');
      }
    }
    const superseded = this.#db.prepare(`
      UPDATE agent_lane_authorization_window
      SET superseded_at=?,superseded_reason=?,closed_at=COALESCE(closed_at,?)
      WHERE lane=? AND window_sequence=? AND superseded_at IS NULL
        AND status IN ('active','review')
    `).run(input.now, input.reason, input.now, input.lane, sequence);
    if (Number(superseded.changes) !== 1) throw new Error('authorization-window-sequence-conflict');
    this.#db.prepare(`
      INSERT INTO agent_lane_authorization_window(
        lane,window_sequence,max_provider_calls,provider_calls,reserved_provider_calls,
        provider_errors,invalid_calls,qualifying_samples,status,opened_at
      ) VALUES(?,?,?,0,0,0,0,0,'active',?)
    `).run(input.lane, sequence + 1, input.maxProviderCalls, input.now);
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
    const before = this.capabilityControl(capabilityId);
    // A stale caller must never learn or act on the newer stop classification.
    if (before.revision !== expected) throw new Error('agent-control-revision-conflict');
    if (before.killedReason === null) throw new Error('capability-not-killed');
    if (before.killedReason === MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON) {
      throw new Error('capability-quality-recovery-required');
    }
    const result = this.#db.prepare(`
      UPDATE agent_capability_control SET killed_reason=NULL,updated_at=?
      WHERE capability_id=? AND updated_at=? AND killed_reason=?
    `).run(this.#nextRevision(expected), capabilityId, expected, before.killedReason);
    if (Number(result.changes) !== 1) {
      const current = this.capabilityControl(capabilityId);
      if (current.revision !== expected) throw new Error('agent-control-revision-conflict');
      throw new Error('capability-kill-reason-conflict');
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
      latencySamples: nonNegative(latencyTotal, 'window-latency-samples'),
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
   * Evidence-bound recovery for the enumerated Lane quality kills only. It retains the killed
   * window as superseded history, starts a caller-sized clean window, and restores only `off`
   * unless the internal atomic reopen path explicitly requests `test-session`.
   */
  recoverQualityKillCas(input: {
    lane: AgentRolloutLane;
    expectedRevision: string;
    expectedWindowSequence: number;
    evidenceDigest: string;
    maxProviderCalls: number;
    /** Used only by reopenLaneCas so recovery and activation share one transaction. */
    reopenToTestSession?: boolean;
  }): AgentLaneQualityRecoveryResult {
    const id = lane(input.lane);
    const expected = controlRevision(input.expectedRevision);
    const expectedWindowSequence = positiveLimit(
      input.expectedWindowSequence, 'expected-window-sequence',
    );
    const explicitMax = laneWindowLimit(id, input.maxProviderCalls, 'lane-recovery-max-provider-calls');
    const now = this.#now().toISOString();
    let recoveredCapabilityIds: readonly MaintenanceCapabilityId[] = Object.freeze([]);
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
      this.#requireNoPermanentSafetyEvidence(id);
      const protocolCapabilities = id === 'maintenance'
        ? this.#maintenanceProtocolQualityCapabilityRows() : Object.freeze([]);
      this.#requireOperationalRecoveryEvidence(
        id,
        input.evidenceDigest,
        [expected, ...protocolCapabilities.map((row) => row.revision)],
      );
      this.#supersedeWindowAndOpenClean({
        lane: id,
        expectedWindowSequence,
        maxProviderCalls: explicitMax,
        reason: 'quality-recovery',
        now,
      });
      recoveredCapabilityIds = this.#clearMaintenanceProtocolQualityCapabilities(
        protocolCapabilities,
      );
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
    return Object.freeze({
      control: this.get(id),
      authorizationWindow: this.authorizationWindow(id),
      recoveredCapabilities: Object.freeze(
        recoveredCapabilityIds.map((capabilityId) => this.capabilityControl(capabilityId)),
      ),
    });
  }

  /**
   * Operator escape hatch from a quality stop, for the case where evidence-bound recovery can
   * never succeed.
   *
   * A killed lane cannot issue calls, so the operational replay that `recoverQualityKillCas`
   * demands can only observe refusals and never reaches `passed=1`. Without a manual door a single
   * stray invalid call inside a small window stops a lane permanently. This override therefore:
   * - refuses permanent safety stops and any lane carrying permanent safety evidence,
   * - supersedes the stopped window so its bad counters cannot re-trigger the same kill,
   * - appends an immutable audit row naming the suppressed stop and the replaced measurements,
   * - never marks the lane healthy: it reopens at `test-session` at most.
   */
  operatorOverrideQualityKillCas(input: {
    lane: AgentRolloutLane;
    expectedRevision: string;
    acknowledgement: typeof AGENT_LANE_OPERATOR_OVERRIDE_ACK;
    reopenTo?: 'off' | 'shadow' | 'test-session';
  }): AgentLaneOperatorOverrideResult {
    if (input.acknowledgement !== AGENT_LANE_OPERATOR_OVERRIDE_ACK) {
      throw new Error('operator-override-acknowledgement-required');
    }
    const id = lane(input.lane);
    const expected = controlRevision(input.expectedRevision);
    const reopenTo: AgentRolloutState = input.reopenTo ?? 'test-session';
    if (reopenTo !== 'off' && reopenTo !== 'shadow' && reopenTo !== 'test-session') {
      throw new Error('operator-override-reopen-state-invalid');
    }
    const now = this.#now().toISOString();
    const overrideId = `ovr_${randomUUID()}`;
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
      if (!isQualityKill(killedReason)) throw new Error('lane-quality-kill-required');
      this.#requireNoPermanentSafetyEvidence(id);
      const window = this.#db.prepare(`
        SELECT window_sequence,max_provider_calls,provider_calls,invalid_calls,qualifying_samples
        FROM agent_lane_authorization_window WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
      `).get(id) as SqlRow | undefined;
      if (!window) throw new Error('agent-authorization-window-missing');
      const sequence = positiveLimit(window.window_sequence, 'window-sequence');
      const openedMaxProviderCalls = AGENT_TEST_SESSION_WINDOW_CALLS[id];
      this.#supersedeWindowAndOpenClean({
        lane: id,
        expectedWindowSequence: sequence,
        maxProviderCalls: openedMaxProviderCalls,
        reason: 'operator-override',
        now,
      });
      const update = this.#db.prepare(`
        UPDATE agent_lane_control SET desired_state=?,killed_reason=NULL,updated_at=?
        WHERE lane=? AND updated_at=? AND desired_state='killed'
      `).run(reopenTo, this.#nextRevision(expected), id, expected);
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.prepare(`
        INSERT INTO agent_lane_operator_override(
          override_id,lane,suppressed_kill_reason,source_control_revision,
          superseded_window_sequence,superseded_max_provider_calls,superseded_provider_calls,
          superseded_invalid_calls,superseded_qualifying_samples,
          opened_window_sequence,opened_max_provider_calls,reopened_to,acknowledgement,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        overrideId,
        id,
        String(killedReason),
        expected,
        sequence,
        positiveLimit(window.max_provider_calls, 'window-max-provider-calls'),
        Number(window.provider_calls),
        Number(window.invalid_calls),
        Number(window.qualifying_samples),
        sequence + 1,
        openedMaxProviderCalls,
        reopenTo,
        AGENT_LANE_OPERATOR_OVERRIDE_ACK,
        now,
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return Object.freeze({
      control: this.get(id),
      authorizationWindow: this.authorizationWindow(id),
      // Read the audit row back instead of trusting the literal we just built: a serialization
      // mismatch between write and read would otherwise only surface during an incident review.
      override: this.#operatorOverrideRow(overrideId),
    });
  }

  #operatorOverrideRow(overrideId: string): AgentLaneOperatorOverrideRow {
    const row = this.#db.prepare(
      'SELECT * FROM agent_lane_operator_override WHERE override_id=?',
    ).get(overrideId) as SqlRow | undefined;
    if (!row) throw new Error('operator-override-audit-missing');
    return Object.freeze({
      overrideId: String(row.override_id),
      lane: lane(row.lane),
      suppressedKillReason: String(row.suppressed_kill_reason),
      sourceControlRevision: String(row.source_control_revision),
      supersededWindowSequence: Number(row.superseded_window_sequence),
      supersededMaxProviderCalls: Number(row.superseded_max_provider_calls),
      supersededProviderCalls: Number(row.superseded_provider_calls),
      supersededInvalidCalls: Number(row.superseded_invalid_calls),
      supersededQualifyingSamples: Number(row.superseded_qualifying_samples),
      openedWindowSequence: Number(row.opened_window_sequence),
      openedMaxProviderCalls: Number(row.opened_max_provider_calls),
      reopenedTo: row.reopened_to as AgentRolloutState,
      acknowledgement: String(row.acknowledgement),
      createdAt: String(row.created_at),
    });
  }

  /** Append-only audit trail, newest first. */
  operatorOverrides(laneId: AgentRolloutLane, limit = 20): readonly AgentLaneOperatorOverrideRow[] {
    const id = lane(laneId);
    const cap = positiveLimit(limit, 'operator-override-limit');
    const rows = this.#db.prepare(`
      SELECT override_id FROM agent_lane_operator_override
      WHERE lane=? ORDER BY created_at DESC,override_id DESC LIMIT ?
    `).all(id, cap) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#operatorOverrideRow(String(row.override_id))));
  }

  /**
   * Evidence-bound recovery for task-local Maintenance protocol stops while the Lane itself
   * remains alive. The caller must name the complete current quality-stopped capability set and
   * every CAS revision; one transaction clears that set, rotates the exact authorization window,
   * and reopens only test-session. Operator stops are never part of the selected set.
   */
  recoverMaintenanceCapabilityQualityKillsCas(input: {
    expectedCapabilities: readonly ExpectedMaintenanceCapabilityKill[];
    expectedLaneRevision: string;
    expectedWindowSequence: number;
    evidenceDigest: string;
    maxProviderCalls: number;
  }): AgentMaintenanceCapabilityQualityRecoveryResult {
    if (!Array.isArray(input.expectedCapabilities)
      || input.expectedCapabilities.length < 1
      || input.expectedCapabilities.length > MAINTENANCE_CAPABILITY_IDS.length) {
      throw new Error('capability-quality-recovery-set-invalid');
    }
    const expectedCapabilities = input.expectedCapabilities.map((row) => Object.freeze({
      capabilityId: maintenanceCapabilityId(row?.capabilityId),
      expectedRevision: controlRevision(row?.expectedRevision),
    }));
    if (new Set(expectedCapabilities.map((row) => row.capabilityId)).size
      !== expectedCapabilities.length) {
      throw new Error('capability-quality-recovery-set-invalid');
    }
    const expectedById = new Map(
      expectedCapabilities.map((row) => [row.capabilityId, row.expectedRevision] as const),
    );
    const expectedLaneRevision = controlRevision(input.expectedLaneRevision);
    const expectedWindowSequence = positiveLimit(
      input.expectedWindowSequence, 'expected-window-sequence',
    );
    const explicitMax = laneWindowLimit(
      'maintenance', input.maxProviderCalls, 'capability-recovery-max-provider-calls',
    );
    const now = this.#now().toISOString();
    let recoveredCapabilityIds: readonly MaintenanceCapabilityId[] = Object.freeze([]);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const laneControl = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane='maintenance'
      `).get() as SqlRow | undefined;
      if (!laneControl) throw new Error('agent-control-row-missing');
      if (laneControl.updated_at !== expectedLaneRevision) {
        throw new Error('agent-control-revision-conflict');
      }
      const killedReason = typeof laneControl.killed_reason === 'string'
        ? laneControl.killed_reason : null;
      if (laneControl.desired_state === 'killed') {
        if (isPermanentKill(killedReason)) throw new Error('lane-permanent-kill');
        if (isQualityKill(killedReason)) throw new Error('lane-quality-recovery-required');
        throw new Error('lane-killed-clear-first');
      }
      if (!['off', 'shadow', 'test-session'].includes(String(laneControl.desired_state))) {
        throw new Error('reopen-refuses-rollout-narrowing');
      }

      const currentCapabilities = this.#maintenanceProtocolQualityCapabilityRows();
      if (currentCapabilities.length < 1) throw new Error('capability-quality-kill-required');
      if (currentCapabilities.length !== expectedCapabilities.length
        || currentCapabilities.some((row) => !expectedById.has(row.capabilityId))) {
        throw new Error('capability-quality-recovery-set-conflict');
      }
      for (const row of currentCapabilities) {
        if (expectedById.get(row.capabilityId) !== row.revision) {
          throw new Error('agent-control-revision-conflict');
        }
      }

      this.#requireNoPermanentSafetyEvidence('maintenance');
      this.#requireOperationalRecoveryEvidence(
        'maintenance', input.evidenceDigest, currentCapabilities.map((row) => row.revision),
      );
      this.#supersedeWindowAndOpenClean({
        lane: 'maintenance',
        expectedWindowSequence,
        maxProviderCalls: explicitMax,
        reason: 'capability-quality-recovery',
        now,
      });
      recoveredCapabilityIds = this.#clearMaintenanceProtocolQualityCapabilities(
        currentCapabilities,
      );
      const laneUpdate = this.#db.prepare(`
        UPDATE agent_lane_control
        SET desired_state='test-session',killed_reason=NULL,updated_at=?
        WHERE lane='maintenance' AND updated_at=? AND desired_state IN ('off','shadow','test-session')
      `).run(this.#nextRevision(expectedLaneRevision), expectedLaneRevision);
      if (Number(laneUpdate.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return Object.freeze({
      operation: 'capability-quality-recovery',
      control: this.get('maintenance'),
      authorizationWindow: this.authorizationWindow('maintenance'),
      recoveredCapabilities: Object.freeze(
        recoveredCapabilityIds.map((capabilityId) => this.capabilityControl(capabilityId)),
      ),
    });
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
    const correction = id === 'interactive' ? this.knownDefectCorrection() : null;
    if (id === 'interactive'
      && correction !== null
      && beforeWindow.sequence === correction.sourceWindowSequence + 1
      && beforeWindow.maxProviderCalls < KNOWN_DEFECT_CORRECTION_MIN_PROVIDER_CALLS) {
      return this.#repairUnderprovisionedKnownDefectWindowCas({
        expectedRevision,
        expectedWindowSequence,
        maxProviderCalls: input.maxProviderCalls,
      });
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

  /**
   * Repairs kills produced by the legacy P95 denominator defect. That policy enabled P95 after
   * 20 Provider calls even when a multi-call lease had produced fewer than 20 latency samples.
   * The signature is deliberately narrow and self-proving: only a P95 kill whose current window
   * crossed the call gate, did not cross the latency-sample gate, and still exceeds the threshold
   * is superseded. The old evidence remains immutable and the lane reopens only in test-session.
   */
  repairLegacyLatencySampleDenominatorKill(
    laneId: AgentRolloutLane,
  ): AgentLatencySampleDenominatorRepairResult | null {
    const id = lane(laneId);
    const before = this.get(id);
    if (before.desiredState !== 'killed' || before.killedReason !== 'p95-latency-exceeded') {
      return null;
    }
    const beforeWindow = this.authorizationWindow(id);
    if (beforeWindow.providerCalls < AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
      || beforeWindow.latencySamples >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
      || beforeWindow.p95LatencyMs <= AGENT_ROLLOUT_THRESHOLDS.p95LatencyMaxMs[id]) {
      return null;
    }

    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const control = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?
      `).get(id) as SqlRow | undefined;
      if (!control || control.updated_at !== before.revision) {
        throw new Error('agent-control-revision-conflict');
      }
      if (control.desired_state !== 'killed'
        || control.killed_reason !== 'p95-latency-exceeded') {
        throw new Error('latency-denominator-repair-state-conflict');
      }
      const window = this.#db.prepare(`
        SELECT window_sequence,provider_calls,status,superseded_at
        FROM agent_lane_authorization_window WHERE lane=? ORDER BY window_sequence DESC LIMIT 1
      `).get(id) as SqlRow | undefined;
      if (!window || Number(window.window_sequence) !== beforeWindow.sequence
        || Number(window.provider_calls) < AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples
        || !['active', 'review'].includes(String(window.status))
        || window.superseded_at !== null) {
        throw new Error('latency-denominator-repair-window-conflict');
      }
      const latency = this.#db.prepare(`
        SELECT COALESCE(SUM(sample_count),0) AS samples
        FROM agent_lane_authorization_window_latency
        WHERE lane=? AND window_sequence=?
      `).get(id, beforeWindow.sequence) as SqlRow;
      if (Number(latency.samples) >= AGENT_ROLLOUT_THRESHOLDS.canaryMinSamples) {
        throw new Error('latency-denominator-repair-not-applicable');
      }
      this.#requireNoPermanentSafetyEvidence(id);
      this.#supersedeWindowAndOpenClean({
        lane: id,
        expectedWindowSequence: beforeWindow.sequence,
        maxProviderCalls: AGENT_TEST_SESSION_WINDOW_CALLS[id],
        reason: `known-defect:${LATENCY_SAMPLE_DENOMINATOR_DEFECT_ID}`,
        now,
      });
      const update = this.#db.prepare(`
        UPDATE agent_lane_control
        SET desired_state='test-session',killed_reason=NULL,updated_at=?
        WHERE lane=? AND updated_at=? AND desired_state='killed'
          AND killed_reason='p95-latency-exceeded'
      `).run(this.#nextRevision(before.revision), id, before.revision);
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return Object.freeze({
      operation: 'known-defect-latency-sample-denominator-v1',
      control: this.get(id),
      authorizationWindow: this.authorizationWindow(id),
    });
  }

  /**
   * One-time compatibility repair for the 2026-10-07 correction window that was capped at 16
   * calls even though the review gate requires 20 qualifying samples. The immutable correction
   * row identifies the exact immediately-created window; CAS and a quiescence check prevent this
   * narrow exception from becoming a general way to discard an active window.
   */
  #repairUnderprovisionedKnownDefectWindowCas(input: {
    expectedRevision: string;
    expectedWindowSequence: number;
    maxProviderCalls: number;
  }): AgentLaneReopenResult {
    const expectedRevision = controlRevision(input.expectedRevision);
    const expectedWindowSequence = positiveLimit(
      input.expectedWindowSequence, 'expected-window-sequence',
    );
    const maxProviderCalls = laneWindowLimit(
      'interactive', input.maxProviderCalls, 'authorization-window-max-calls',
    );
    if (maxProviderCalls < KNOWN_DEFECT_CORRECTION_MIN_PROVIDER_CALLS) {
      throw new Error('known-defect-window-too-small');
    }
    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const control = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at
        FROM agent_lane_control WHERE lane='interactive'
      `).get() as SqlRow | undefined;
      if (!control || control.updated_at !== expectedRevision) {
        throw new Error('agent-control-revision-conflict');
      }
      if (control.desired_state !== 'test-session' || control.killed_reason !== null) {
        throw new Error('known-defect-window-repair-state-invalid');
      }
      const correction = this.#db.prepare(`
        SELECT source_window_sequence FROM agent_lane_known_defect_correction
        WHERE defect_id=? AND lane='interactive'
      `).get(PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID) as SqlRow | undefined;
      if (!correction
        || Number(correction.source_window_sequence) + 1 !== expectedWindowSequence) {
        throw new Error('known-defect-window-repair-not-applicable');
      }
      const window = this.#db.prepare(`
        SELECT window_sequence,max_provider_calls,reserved_provider_calls,status,superseded_at
        FROM agent_lane_authorization_window
        WHERE lane='interactive' ORDER BY window_sequence DESC LIMIT 1
      `).get() as SqlRow | undefined;
      if (!window || Number(window.window_sequence) !== expectedWindowSequence) {
        throw new Error('authorization-window-sequence-conflict');
      }
      if (Number(window.max_provider_calls) >= KNOWN_DEFECT_CORRECTION_MIN_PROVIDER_CALLS
        || maxProviderCalls <= Number(window.max_provider_calls)) {
        throw new Error('known-defect-window-repair-not-applicable');
      }
      if (!['active', 'review'].includes(String(window.status))
        || window.superseded_at !== null
        || Number(window.reserved_provider_calls) !== 0) {
        throw new Error('known-defect-window-not-quiescent');
      }
      const activeReservations = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM agent_lane_provider_reservation
        WHERE lane='interactive' AND window_sequence=? AND status='active'
      `).get(expectedWindowSequence) as SqlRow;
      if (Number(activeReservations.count) !== 0) {
        throw new Error('known-defect-window-not-quiescent');
      }
      this.#supersedeWindowAndOpenClean({
        lane: 'interactive',
        expectedWindowSequence,
        maxProviderCalls,
        reason: 'known-defect-underprovisioned-window',
        now,
      });
      const update = this.#db.prepare(`
        UPDATE agent_lane_control
        SET desired_state='test-session',killed_reason=NULL,updated_at=?
        WHERE lane='interactive' AND updated_at=? AND desired_state='test-session'
          AND killed_reason IS NULL
      `).run(this.#nextRevision(expectedRevision), expectedRevision);
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return Object.freeze({
      operation: 'known-defect-window-repair',
      control: this.get('interactive'),
      authorizationWindow: this.authorizationWindow('interactive'),
    });
  }

  knownDefectCorrection(): AgentKnownDefectCorrection | null {
    const row = this.#db.prepare(`
      SELECT defect_id,lane,killed_reason,fixed_policy_revision,
        source_control_revision,source_window_sequence,source_observation_version,source_day,
        corrected_player_sovereignty_violations,evidence_digest,created_at
      FROM agent_lane_known_defect_correction
      WHERE defect_id=?
    `).get(PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID) as SqlRow | undefined;
    if (!row) return null;
    return Object.freeze({
      defectId: PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID,
      lane: 'interactive',
      killedReason: 'player-sovereignty-violation',
      fixedPolicyRevision: PLAYER_SOVEREIGNTY_POLICY_REVISION,
      sourceControlRevision: String(row.source_control_revision),
      sourceWindowSequence: Number(row.source_window_sequence),
      sourceObservationVersion: AGENT_LANE_OBSERVATION_VERSION,
      sourceDay: String(row.source_day),
      correctedPlayerSovereigntyViolations: Number(row.corrected_player_sovereignty_violations),
      signatureDigest: String(row.evidence_digest),
      evidenceDigest: String(row.evidence_digest),
      createdAt: String(row.created_at),
    });
  }

  /**
   * Correct exactly one known 2026-10-07 false-positive class and atomically reopen Interactive.
   *
   * This is intentionally not a general permanent-kill recovery API. Raw observations and the old
   * window remain immutable/auditable; `evidence()` subtracts only the appended correction row.
   */
  correctKnownInteractiveSovereigntyFalsePositiveAndReopenCas(input: {
    lane: 'interactive';
    defectId: typeof PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID;
    fixedPolicyRevision: typeof PLAYER_SOVEREIGNTY_POLICY_REVISION;
    expectedRevision: string;
    expectedWindowSequence: number;
    maxProviderCalls: number;
  }): AgentKnownDefectRecoveryResult {
    if (input.lane !== 'interactive') throw new Error('known-defect-interactive-only');
    if (input.defectId !== PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID) {
      throw new Error('known-defect-id-invalid');
    }
    if (input.fixedPolicyRevision !== PLAYER_SOVEREIGNTY_POLICY_REVISION) {
      throw new Error('known-defect-policy-revision-invalid');
    }
    const expectedRevision = controlRevision(input.expectedRevision);
    const expectedWindowSequence = positiveLimit(
      input.expectedWindowSequence, 'expected-window-sequence',
    );
    const maxProviderCalls = laneWindowLimit(
      'interactive', input.maxProviderCalls, 'known-defect-max-provider-calls',
    );
    if (maxProviderCalls < KNOWN_DEFECT_CORRECTION_MIN_PROVIDER_CALLS) {
      throw new Error('known-defect-window-too-small');
    }
    if (maxProviderCalls > KNOWN_DEFECT_CORRECTION_MAX_PROVIDER_CALLS) {
      throw new Error('known-defect-window-too-large');
    }
    const now = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare(`
        SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane='interactive'
      `).get() as SqlRow | undefined;
      if (!current) throw new Error('agent-control-row-missing');
      if (current.updated_at !== expectedRevision) throw new Error('agent-control-revision-conflict');
      if (current.desired_state !== 'killed'
        || current.killed_reason !== 'player-sovereignty-violation') {
        throw new Error('known-defect-kill-signature-mismatch');
      }
      if (this.#db.prepare(`
        SELECT 1 FROM agent_lane_known_defect_correction WHERE defect_id=?
      `).get(PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID)) {
        throw new Error('known-defect-correction-already-applied');
      }
      const window = this.#db.prepare(`
        SELECT window_sequence,reserved_provider_calls,superseded_at
        FROM agent_lane_authorization_window
        WHERE lane='interactive' ORDER BY window_sequence DESC LIMIT 1
      `).get() as SqlRow | undefined;
      if (!window) throw new Error('agent-authorization-window-missing');
      if (Number(window.window_sequence) !== expectedWindowSequence) {
        throw new Error('authorization-window-sequence-conflict');
      }
      if (window.superseded_at !== null || Number(window.reserved_provider_calls) !== 0) {
        throw new Error('known-defect-window-not-quiescent');
      }
      const activeReservations = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM agent_lane_provider_reservation
        WHERE lane='interactive' AND window_sequence=? AND status='active'
      `).get(expectedWindowSequence) as SqlRow;
      if (Number(activeReservations.count) !== 0) {
        throw new Error('known-defect-window-not-quiescent');
      }
      const permanent = this.#db.prepare(`
        SELECT COALESCE(SUM(player_sovereignty_violations),0) AS sovereignty,
          COALESCE(SUM(unauthorized_or_stale_writes),0) AS stale_writes,
          COALESCE(SUM(duplicate_writes),0) AS duplicate_writes,
          COALESCE(SUM(sensitive_audit_violations),0) AS sensitive
        FROM agent_lane_daily_observation
        WHERE lane='interactive' AND observation_version=?
      `).get(AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
      if (Number(permanent.stale_writes) !== 0 || Number(permanent.duplicate_writes) !== 0
        || Number(permanent.sensitive) !== 0) {
        throw new Error('known-defect-other-permanent-evidence-present');
      }
      const correctedCount = nonNegative(
        permanent.sovereignty, 'known-defect-sovereignty-count',
      );
      if (correctedCount < 1
        || correctedCount > KNOWN_DEFECT_CORRECTION_MAX_OBSERVATIONS) {
        throw new Error('known-defect-observation-signature-mismatch');
      }
      const sourceDay = expectedRevision.slice(0, 10);
      const source = this.#db.prepare(`
        SELECT provider_calls,provider_errors,invalid_calls,player_sovereignty_violations,
          unauthorized_or_stale_writes,duplicate_writes,sensitive_audit_violations
        FROM agent_lane_daily_observation
        WHERE lane='interactive' AND day=? AND observation_version=?
      `).get(sourceDay, AGENT_LANE_OBSERVATION_VERSION) as SqlRow | undefined;
      if (!source
        || Number(source.player_sovereignty_violations) !== correctedCount
        || Number(source.provider_calls) !== correctedCount
        || Number(source.provider_errors) !== 0
        || Number(source.invalid_calls) !== 0
        || Number(source.unauthorized_or_stale_writes) !== 0
        || Number(source.duplicate_writes) !== 0
        || Number(source.sensitive_audit_violations) !== 0) {
        throw new Error('known-defect-observation-signature-mismatch');
      }
      const signatureDigest = `sha256:${createHash('sha256').update(JSON.stringify({
        defectId: PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID,
        lane: 'interactive',
        killedReason: 'player-sovereignty-violation',
        fixedPolicyRevision: PLAYER_SOVEREIGNTY_POLICY_REVISION,
        sourceControlRevision: expectedRevision,
        sourceWindowSequence: expectedWindowSequence,
        sourceObservationVersion: AGENT_LANE_OBSERVATION_VERSION,
        sourceDay,
        providerCalls: Number(source.provider_calls),
        providerErrors: Number(source.provider_errors),
        invalidCalls: Number(source.invalid_calls),
        playerSovereigntyViolations: Number(source.player_sovereignty_violations),
        unauthorizedOrStaleWrites: Number(source.unauthorized_or_stale_writes),
        duplicateWrites: Number(source.duplicate_writes),
        sensitiveAuditViolations: Number(source.sensitive_audit_violations),
      }), 'utf8').digest('hex')}`;
      this.#db.prepare(`
        INSERT INTO agent_lane_known_defect_correction(
          defect_id,lane,killed_reason,fixed_policy_revision,
          source_control_revision,source_window_sequence,source_observation_version,source_day,
          corrected_player_sovereignty_violations,evidence_digest,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID,
        'interactive', 'player-sovereignty-violation',
        PLAYER_SOVEREIGNTY_POLICY_REVISION,
        expectedRevision, expectedWindowSequence, AGENT_LANE_OBSERVATION_VERSION, sourceDay,
        correctedCount, signatureDigest, now,
      );
      const superseded = this.#db.prepare(`
        UPDATE agent_lane_authorization_window
        SET superseded_at=?,superseded_reason=?,closed_at=COALESCE(closed_at,?)
        WHERE lane='interactive' AND window_sequence=? AND superseded_at IS NULL
      `).run(now, `known-defect:${PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID}`,
        now, expectedWindowSequence);
      if (Number(superseded.changes) !== 1) throw new Error('authorization-window-sequence-conflict');
      this.#db.prepare(`
        INSERT INTO agent_lane_authorization_window(
          lane,window_sequence,max_provider_calls,provider_calls,reserved_provider_calls,
          provider_errors,invalid_calls,qualifying_samples,status,opened_at
        ) VALUES('interactive',?,?,0,0,0,0,0,'active',?)
      `).run(expectedWindowSequence + 1, maxProviderCalls, now);
      const update = this.#db.prepare(`
        UPDATE agent_lane_control SET desired_state='test-session',killed_reason=NULL,updated_at=?
        WHERE lane='interactive' AND updated_at=? AND desired_state='killed'
          AND killed_reason='player-sovereignty-violation'
      `).run(this.#nextRevision(expectedRevision), expectedRevision);
      if (Number(update.changes) !== 1) throw new Error('agent-control-revision-conflict');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const correction = this.knownDefectCorrection();
    if (!correction) throw new Error('known-defect-correction-missing');
    return Object.freeze({
      operation: 'known-defect-correction',
      correction,
      control: this.get('interactive'),
      authorizationWindow: this.authorizationWindow('interactive'),
    });
  }

  /**
   * Records one content-free invalid tool rejection against the exact current Maintenance
   * authorization window. Repeats are aggregated; arbitrary caller fields are never serialized.
   */
  recordMaintenanceInvalidToolDiagnostic(input: {
    taskKind: MaintenanceTaskKind;
    runId: string;
    tool: string;
    rejectionCode: string;
    /** Final outcome of this run; a corrected invalid call must pass false. */
    runFailed: boolean;
  }): MaintenanceInvalidToolDiagnostic {
    const taskKind = maintenanceTaskKind(input.taskKind);
    const runId = identity(input.runId, 'maintenance-diagnostic-run-id');
    const tool = identity(input.tool, 'maintenance-diagnostic-tool');
    const rejectionCode = maintenanceInvalidToolRejectionCode(input.rejectionCode);
    if (typeof input.runFailed !== 'boolean') {
      throw new Error('maintenance-diagnostic-run-failed-invalid');
    }
    const timestamp = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const window = this.#db.prepare(`
        SELECT window_sequence FROM agent_lane_authorization_window
        WHERE lane='maintenance' ORDER BY window_sequence DESC LIMIT 1
      `).get() as SqlRow | undefined;
      if (!window) throw new Error('maintenance-diagnostic-window-missing');
      const windowSequence = positiveLimit(
        window.window_sequence, 'maintenance-diagnostic-window-sequence',
      );
      this.#db.prepare(`
        INSERT INTO maintenance_invalid_tool_diagnostic(
          window_sequence,task_kind,run_id,tool,rejection_code,run_failed,
          occurrence_count,occurred_at
        ) VALUES(?,?,?,?,?,?,1,?)
        ON CONFLICT(window_sequence,task_kind,run_id,tool,rejection_code) DO UPDATE SET
          run_failed=MAX(run_failed,excluded.run_failed),
          occurrence_count=occurrence_count+1,
          occurred_at=excluded.occurred_at
      `).run(
        windowSequence, taskKind, runId, tool, rejectionCode,
        input.runFailed ? 1 : 0, timestamp,
      );
      const row = this.#db.prepare(`
        SELECT task_kind,run_id,tool,rejection_code,occurrence_count,occurred_at
        FROM maintenance_invalid_tool_diagnostic
        WHERE window_sequence=? AND task_kind=? AND run_id=? AND tool=? AND rejection_code=?
      `).get(windowSequence, taskKind, runId, tool, rejectionCode) as SqlRow | undefined;
      if (!row) throw new Error('maintenance-diagnostic-write-failed');
      const diagnostic = maintenanceDiagnostic(row);
      this.#db.exec('COMMIT');
      return diagnostic;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  /**
   * Atomically records one content-free protocol run outcome plus any safe rejection codes.
   * The reservation digest is used only to prove which authorization window owns the run;
   * it is deliberately not copied into either diagnostic table.
   */
  recordMaintenanceProtocolRunOutcome(input: {
    quotaReservationDigest: string;
    windowSequence: number;
    incidentGroup: string;
    taskKind: MaintenanceTaskKind;
    runId: string;
    outcome: MaintenanceProtocolRunOutcome;
    rejections: readonly Readonly<{ tool: string; rejectionCode: string }>[];
  }): MaintenanceProtocolOutcomeResult {
    if (!DIGEST_RE.test(input.quotaReservationDigest)) {
      throw new Error('maintenance-protocol-reservation-digest-invalid');
    }
    const windowSequence = positiveInteger(
      input.windowSequence, 'maintenance-protocol-window-sequence',
    );
    const incidentGroup = identity(input.incidentGroup, 'maintenance-protocol-incident-group');
    const taskKind = maintenanceTaskKind(input.taskKind);
    const runId = identity(input.runId, 'maintenance-protocol-run-id');
    const outcome = maintenanceProtocolRunOutcome(input.outcome);
    if (!Array.isArray(input.rejections) || input.rejections.length > 64
      || ((outcome === 'clean') !== (input.rejections.length === 0))
      || (outcome === 'failed' && input.rejections.length < 1)) {
      throw new Error('maintenance-protocol-rejections-invalid');
    }
    const rejections = input.rejections.map((row) => Object.freeze({
      tool: identity(row.tool, 'maintenance-diagnostic-tool'),
      rejectionCode: maintenanceInvalidToolRejectionCode(row.rejectionCode),
    }));
    const timestamp = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const reservation = this.#db.prepare(`
        SELECT lane,window_sequence,status,started_at
        FROM agent_lane_provider_reservation WHERE reservation_digest=?
      `).get(input.quotaReservationDigest) as SqlRow | undefined;
      if (!reservation || reservation.lane !== 'maintenance') {
        throw new Error('maintenance-protocol-reservation-missing');
      }
      if (positiveInteger(reservation.window_sequence, 'maintenance-protocol-window-sequence')
        !== windowSequence) {
        throw new Error('maintenance-protocol-window-binding-mismatch');
      }
      if (reservation.started_at === null
        || (reservation.status !== 'active' && reservation.status !== 'settled')) {
        throw new Error('maintenance-protocol-reservation-not-started');
      }
      const prior = this.#db.prepare(`
        SELECT event_sequence,window_sequence,incident_group,task_kind,run_id,outcome,occurred_at
        FROM maintenance_protocol_run_outcome WHERE window_sequence=? AND run_id=?
      `).get(windowSequence, runId) as SqlRow | undefined;
      let record: MaintenanceProtocolOutcomeRecord;
      if (prior) {
        record = maintenanceProtocolOutcomeRecord(prior);
        if (record.incidentGroup !== incidentGroup || record.taskKind !== taskKind
          || record.outcome !== outcome) {
          throw new Error('maintenance-protocol-outcome-conflict');
        }
      } else {
        for (const rejection of rejections) {
          this.#db.prepare(`
            INSERT INTO maintenance_invalid_tool_diagnostic(
              window_sequence,task_kind,run_id,tool,rejection_code,run_failed,
              occurrence_count,occurred_at
            ) VALUES(?,?,?,?,?,?,1,?)
            ON CONFLICT(window_sequence,task_kind,run_id,tool,rejection_code) DO UPDATE SET
              run_failed=MAX(run_failed,excluded.run_failed),
              occurrence_count=occurrence_count+1,
              occurred_at=excluded.occurred_at
          `).run(
            windowSequence, taskKind, runId, rejection.tool, rejection.rejectionCode,
            outcome === 'failed' ? 1 : 0, timestamp,
          );
        }
        const inserted = this.#db.prepare(`
          INSERT INTO maintenance_protocol_run_outcome(
            window_sequence,incident_group,task_kind,run_id,outcome,occurred_at
          ) VALUES(?,?,?,?,?,?)
        `).run(windowSequence, incidentGroup, taskKind, runId, outcome, timestamp);
        const eventSequence = positiveInteger(
          Number(inserted.lastInsertRowid), 'maintenance-protocol-event-sequence',
        );
        record = Object.freeze({
          eventSequence, windowSequence, incidentGroup, taskKind, runId, outcome, timestamp,
        });
      }
      const latest = this.#db.prepare(`
        SELECT MAX(window_sequence) AS window_sequence FROM agent_lane_authorization_window
        WHERE lane='maintenance'
      `).get() as SqlRow;
      const currentWindow = positiveInteger(
        latest.window_sequence, 'maintenance-protocol-current-window-sequence',
      ) === windowSequence;
      const rows = this.#db.prepare(`
        SELECT incident_group,outcome FROM maintenance_protocol_run_outcome
        WHERE window_sequence=? ORDER BY event_sequence DESC
      `).all(windowSequence) as SqlRow[];
      const streak: string[] = [];
      for (const row of rows) {
        const rowOutcome = maintenanceProtocolRunOutcome(row.outcome);
        if (rowOutcome !== 'failed') break;
        const group = identity(row.incident_group, 'maintenance-protocol-incident-group');
        if (!streak.includes(group)) streak.push(group);
      }
      this.#db.exec('COMMIT');
      return Object.freeze({
        record,
        currentWindow,
        failureStreakIncidentGroups: Object.freeze(streak),
      });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  listMaintenanceInvalidToolDiagnostics(
    input: MaintenanceInvalidToolDiagnosticListFilter = {},
  ): readonly MaintenanceInvalidToolDiagnostic[] {
    const { where, parameters } = this.#maintenanceInvalidToolDiagnosticWhere(input);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('maintenance-diagnostic-limit-invalid');
    }
    const rows = this.#db.prepare(`
      SELECT task_kind,run_id,tool,rejection_code,
        SUM(occurrence_count) AS occurrence_count,MAX(occurred_at) AS occurred_at
      FROM maintenance_invalid_tool_diagnostic
      ${where}
      GROUP BY task_kind,run_id,tool,rejection_code
      ORDER BY occurred_at DESC,task_kind ASC,run_id ASC,tool ASC,rejection_code ASC
      LIMIT ?
    `).all(...parameters, limit) as SqlRow[];
    return Object.freeze(rows.map(maintenanceDiagnostic));
  }

  countMaintenanceInvalidToolDiagnostics(
    input: MaintenanceInvalidToolDiagnosticFilter = {},
  ): number {
    const { where, parameters } = this.#maintenanceInvalidToolDiagnosticWhere(input);
    const row = this.#db.prepare(`
      SELECT COALESCE(SUM(occurrence_count),0) AS occurrence_count
      FROM maintenance_invalid_tool_diagnostic ${where}
    `).get(...parameters) as SqlRow;
    return nonNegative(row.occurrence_count, 'maintenance-diagnostic-count');
  }

  failedMaintenanceTaskKinds(
    input: { readonly currentWindow?: boolean } = {},
  ): readonly MaintenanceTaskKind[] {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('maintenance-diagnostic-filter-invalid');
    }
    if (input.currentWindow !== undefined && typeof input.currentWindow !== 'boolean') {
      throw new Error('maintenance-diagnostic-current-window-invalid');
    }
    const currentWindow = input.currentWindow !== false
      ? `AND window_sequence=(
        SELECT MAX(window_sequence) FROM agent_lane_authorization_window WHERE lane='maintenance'
      )` : '';
    const rows = this.#db.prepare(`
      SELECT DISTINCT task_kind FROM maintenance_invalid_tool_diagnostic
      WHERE run_failed=1 ${currentWindow} ORDER BY task_kind ASC
    `).all() as SqlRow[];
    return Object.freeze(rows.map((row) => maintenanceTaskKind(row.task_kind)));
  }

  #maintenanceInvalidToolDiagnosticWhere(
    input: MaintenanceInvalidToolDiagnosticFilter,
  ): { readonly where: string; readonly parameters: string[] } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('maintenance-diagnostic-filter-invalid');
    }
    if (input.currentWindow !== undefined && typeof input.currentWindow !== 'boolean') {
      throw new Error('maintenance-diagnostic-current-window-invalid');
    }
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (input.currentWindow !== false) {
      clauses.push(`window_sequence=(
        SELECT MAX(window_sequence) FROM agent_lane_authorization_window WHERE lane='maintenance'
      )`);
    }
    if (input.taskKind !== undefined) {
      clauses.push('task_kind=?');
      parameters.push(maintenanceTaskKind(input.taskKind));
    }
    if (input.runId !== undefined) {
      clauses.push('run_id=?');
      parameters.push(identity(input.runId, 'maintenance-diagnostic-run-id'));
    }
    if (input.tool !== undefined) {
      clauses.push('tool=?');
      parameters.push(identity(input.tool, 'maintenance-diagnostic-tool'));
    }
    if (input.rejectionCode !== undefined) {
      clauses.push('rejection_code=?');
      parameters.push(maintenanceInvalidToolRejectionCode(input.rejectionCode));
    }
    return Object.freeze({
      where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      parameters,
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
      SELECT COALESCE(SUM(provider_calls),0) AS calls,COALESCE(SUM(provider_errors),0) AS errors,
        COALESCE(SUM(invalid_calls),0) AS invalid,
        COALESCE(SUM(player_sovereignty_violations),0) AS sovereignty,
        COALESCE(SUM(unauthorized_or_stale_writes),0) AS stale_writes,
        COALESCE(SUM(duplicate_writes),0) AS duplicate_writes,
        COALESCE(SUM(sensitive_audit_violations),0) AS sensitive
      FROM agent_lane_daily_observation WHERE lane=? AND observation_version=?
    `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
    const sampleRow = this.#db.prepare(`
      SELECT COUNT(*) AS samples,COUNT(DISTINCT day) AS days FROM agent_lane_qualifying_sample
      WHERE lane=? AND observation_version=?
    `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
    const latencyRows = this.#db.prepare(`
      SELECT bucket_upper_ms,sample_count FROM agent_lane_latency_histogram
      WHERE lane=? AND observation_version=? ORDER BY bucket_upper_ms ASC
    `).all(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow[];
    const correctionRow = this.#db.prepare(`
      SELECT COALESCE(SUM(corrected_player_sovereignty_violations),0) AS corrected
      FROM agent_lane_known_defect_correction
      WHERE lane=? AND source_observation_version=?
    `).get(id, AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
    const correctedSovereignty = Number(correctionRow.corrected);
    const rawSovereignty = Number(row.sovereignty);
    if (!Number.isSafeInteger(correctedSovereignty) || correctedSovereignty < 0
      || correctedSovereignty > rawSovereignty) {
      throw new Error('known-defect-correction-accounting-invalid');
    }
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
      // A maturity day is anchored by a real qualifying sample, not by a daily aggregate row.
      // This remains migration-safe because v1+ stores already preserve sample days in the
      // versioned qualifying-sample table; legacy flat daily counts are intentionally excluded.
      qualifyingSamples: Number(sampleRow.samples), observationDays: Number(sampleRow.days),
      providerCalls: Number(row.calls), providerErrors: Number(row.errors), invalidCalls: Number(row.invalid),
      p50LatencyMs: percentile(0.50), p95LatencyMs: percentile(0.95),
      playerSovereigntyViolations: rawSovereignty - correctedSovereignty,
      unauthorizedOrStaleWrites: Number(row.stale_writes), duplicateWrites: Number(row.duplicate_writes),
      sensitiveAuditViolations: Number(row.sensitive),
      authorizationWindowCalls: authorizationWindow.providerCalls,
      authorizationWindowReservedCalls: authorizationWindow.reservedProviderCalls,
      authorizationWindowProviderErrors: authorizationWindow.providerErrors,
      authorizationWindowInvalidCalls: authorizationWindow.invalidCalls,
      authorizationWindowQualifyingSamples: authorizationWindow.qualifyingSamples,
      authorizationWindowLatencySamples: authorizationWindow.latencySamples,
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
