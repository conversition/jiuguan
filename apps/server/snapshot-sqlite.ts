import { WORLDBOOK_REPAIR_APPLICATION_ID, inspectWorldbookRepairSchema } from './worldbook-repair-control.ts';
import { DIRECTOR_CREATIVE_APPLICATION_ID, inspectDirectorCreativeSchema } from './director-creative-store.ts';
import { DatabaseSync } from 'node:sqlite';
import { inspectToolResultBodyStorage } from '../../packages/memory/public/tool-result-body.ts';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AUTH_DB_APPLICATION_ID,
  AUTH_SCHEMA_VERSION,
  inspectAuthSchemaExactness,
} from '../../packages/server-auth/src/index.ts';
import { SCHEMA_VERSION as SESSION_SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import {
  MemoryDb,
  SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS,
  SESSION_STORAGE_PREDECESSOR_VERSION,
  SESSION_V16_STORAGE_REQUIRED_COLUMNS,
  inspectSessionAuthoritySchema,
  inspectRpChildAnalysisStorage,
  inspectSessionPredecessorV16Storage,
} from '../../packages/memory/public/session-database.ts';
import {
  TURN_JOB_APPLICATION_ID,
  TURN_JOB_SCHEMA_VERSION,
} from './turn-job-manager.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_SCHEMA_VERSION,
  inspectMaintenanceProductionRouteReceiptSchema,
} from './maintenance-job-manager.ts';
import { MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE,
  MAINTENANCE_MEMORY_SKILL_OUTBOX_COLUMNS } from './maintenance-memory-skill-outbox.ts';
import { inspectMaintenanceMemoryDirectProposalSchema,
  MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE,
  MAINTENANCE_MEMORY_DIRECT_PROPOSAL_COLUMNS } from './maintenance-memory-direct-proposal.ts';
import {
  inspectMaintenanceSummarySkillSourceSchema,
  MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE,
  MAINTENANCE_SUMMARY_SKILL_SOURCE_COLUMNS,
} from './maintenance-summary-skill-source.ts';
import {
  INTERACTIVE_LEDGER_APPLICATION_ID,
  INTERACTIVE_LEDGER_SCHEMA_VERSION,
} from './interactive-call-ledger.ts';
import {
  MODEL_USAGE_APPLICATION_ID,
  MODEL_USAGE_SCHEMA_VERSION,
} from './model-usage-ledger.ts';
import {
  AGENT_ADMISSION_APPLICATION_ID,
  AGENT_ADMISSION_SCHEMA_VERSION,
} from './agent-admission-ledger.ts';
import {
  AGENT_LEARNING_APPLICATION_ID,
  AGENT_LEARNING_SCHEMA_VERSION,
} from './agent-learning-ledger.ts';
import {
  ARC_PROJECTION_APPLICATION_ID,
  ARC_PROJECTION_SCHEMA_VERSION,
} from './arc-projection-store.ts';
import {
  AGENT_LOOP_PROJECTION_DB_FILE,
  AGENT_LOOP_PROJECTION_APPLICATION_ID,
  AGENT_LOOP_PROJECTION_SCHEMA_VERSION,
  inspectAgentLoopProjectionSchemaExact,
  inspectAgentLoopProjectionSchemaV7Exact,
  inspectAgentLoopProjectionSchemaV8Exact,
} from './agent-loop-projection-store.ts';
import {
  AGENT_CONTROL_APPLICATION_ID,
  AGENT_CONTROL_SCHEMA_VERSION,
} from './agent-control-store.ts';
import { inspectAgentControlAuthoritySchema } from './agent-control-authority.ts';
import {
  AGENT_CLOSURE_APPLICATION_ID,
  AGENT_CLOSURE_SCHEMA_VERSION,
} from './agent-closure-store.ts';
import {
    AGENT_EVIDENCE_APPLICATION_ID,
    inspectAgentEvidenceSchema,
} from './agent-evidence-ledger.ts';
import {
    AGENT_SKILL_CANDIDATE_APPLICATION_ID, inspectAgentSkillCandidateSchema,
} from './agent-skill-candidate-store.ts';
import { SKILL_COMPILE_APPLICATION_ID, inspectSkillCompileSchema } from './skill-compile-store.ts';
import { SKILL_EVALUATE_APPLICATION_ID, inspectSkillEvaluateSchema } from './skill-evaluate-store.ts';
import { SKILL_SAMPLE_APPLICATION_ID, inspectSkillSampleSchema } from './skill-sample-store.ts';
import { SKILL_QUALITY_APPLICATION_ID, inspectSkillQualitySchema } from './skill-quality-store.ts';
import { SKILL_PACKAGE_PIN_APPLICATION_ID, inspectSkillPackagePinSchema } from './skill-package-pin-store.ts';
import { STYLE_COMPILE_JOB_APPLICATION_ID, STYLE_COMPILE_JOB_SCHEMA_VERSION } from './skill-hub/style-compile-job-store.ts';
import {
  SnapshotCoordinatorError,
  type SnapshotComponentPlan,
  type SnapshotSqliteCaptureAdapter,
} from './snapshot-coordinator.ts';

const SESSION_V17_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...SESSION_V16_STORAGE_REQUIRED_COLUMNS,
  ...SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS,
});

const TURN_JOB_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  turn_job: [
    'run_id', 'session_id', 'action', 'request_id', 'origin_device_id', 'status',
    'request_hash', 'request_json', 'round', 'created_at', 'updated_at', 'started_at',
    'finished_at', 'cancel_requested_at', 'commit_fence_at', 'lease_owner_instance_id',
    'lease_expires_at', 'lease_heartbeat_at', 'version', 'public_error_code',
    'assistant_message_id', 'result_revision',
  ],
  turn_job_idempotency: [
    'origin_device_id', 'action', 'session_id', 'key_digest', 'request_hash',
    'run_id', 'created_at', 'expires_at',
  ],
});

const MAINTENANCE_JOB_V4_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  maintenance_settings: ['singleton', 'global_enabled', 'default_mode', 'updated_at'],
  maintenance_session_settings: ['session_id', 'enabled', 'updated_at'],
  maintenance_job: [
    'run_id', 'session_id', 'task_kind', 'source_revision', 'policy_version', 'parent_run_id',
    'trigger_kind', 'mode', 'status', 'attempt', 'created_at', 'updated_at', 'started_at',
    'finished_at', 'cancel_requested_at', 'lease_owner_instance_id', 'lease_expires_at',
    'error_code', 'budget_json', 'proposal_digest', 'proposal_disposition', 'diff_json',
  ],
  maintenance_outbox: ['outbox_id', 'job_run_id', 'available_at', 'claimed_at', 'delivered_at'],
  maintenance_pending_proposal: [
    'proposal_id', 'job_run_id', 'session_id', 'task_kind', 'source_revision',
    'proposal_digest', 'proposal_json', 'context_json', 'diff_json', 'status', 'revision',
    'created_at', 'updated_at', 'decided_at', 'decision_reason', 'receipt_json',
    'rollback_anchor_json',
  ],
});

const MAINTENANCE_JOB_V5_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...MAINTENANCE_JOB_V4_EXACT_COLUMNS,
  maintenance_job: [...MAINTENANCE_JOB_V4_EXACT_COLUMNS.maintenance_job, 'executor_route'],
});

const MAINTENANCE_JOB_V6_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...MAINTENANCE_JOB_V5_EXACT_COLUMNS,
  maintenance_pending_proposal: [...MAINTENANCE_JOB_V5_EXACT_COLUMNS.maintenance_pending_proposal, 'agent_loop_preparation_json'],
});

const MAINTENANCE_JOB_V7_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...MAINTENANCE_JOB_V6_EXACT_COLUMNS,
  maintenance_pending_proposal: [...MAINTENANCE_JOB_V6_EXACT_COLUMNS.maintenance_pending_proposal, 'agent_loop_publication_json'],
});

const MAINTENANCE_JOB_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...MAINTENANCE_JOB_V7_EXACT_COLUMNS,
  maintenance_production_route_receipt: [
    'run_id', 'claimed_at', 'receipt_digest', 'receipt_json',
  ],
});

const INTERACTIVE_LEDGER_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  interactive_tool_call: [
    'run_id', 'step_index', 'tool_call_id', 'args_hash', 'input_revision', 'tool_name',
    'tool_version', 'effect', 'status', 'result_chars', 'result_digest', 'elapsed_ms',
    'error_code', 'created_at', 'session_id',
  ],
});

const MODEL_USAGE_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  model_call_usage: [
    'call_id', 'run_id', 'parent_run_id', 'session_id', 'round', 'lane', 'call_index',
    'provider_id', 'model', 'transport', 'outcome', 'usage_source', 'prompt_tokens',
    'completion_tokens', 'total_tokens', 'cached_input_tokens', 'cache_write_tokens',
    'reasoning_tokens', 'cost_microusd', 'rate_card_id', 'finish_reason', 'error_code',
    'started_at', 'finished_at', 'elapsed_ms',
  ],
});

const AGENT_ADMISSION_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  maintenance_admission_authority: ['singleton', 'generation', 'revision'],
  agent_admission_decision: [
    'decision_id', 'run_id', 'session_id', 'round', 'source_revision', 'policy_version',
    'verdict', 'score', 'hard_signals_json', 'reason_codes_json', 'routing_digest',
    'facts_digest', 'has_stable_revision', 'provider_supports_tool_protocol',
    'provider_reports_usage', 'has_explicit_verification_intent', 'has_variable_write_intent',
    'entity_evidence', 'ambiguous_entity_count', 'worldbook_evidence', 'worldbook_conflict_count', 'referenced_old_story',
    'high_confidence_recall_count', 'arc_evidence', 'dormant_arc_reference_count', 'platform_evidence',
    'evidence_novelty', 'prompt_budget_tokens', 'estimated_prompt_tokens',
    'final_reserve_tokens', 'minimum_final_reserve_tokens', 'semantic_route', 'created_at',
  ],
  maintenance_admission_decision: [
    'decision_id', 'parent_run_id', 'session_id', 'round', 'source_revision', 'task_kind',
    'policy_version', 'verdict', 'reason_codes_json', 'facts_digest', 'source_digest',
    'recent_success_digest', 'observation_digest', 'has_stable_revision', 'new_event_count', 'sample_count',
    'entity_signal_count', 'foreground_active', 'prior_state', 'same_source_succeeded',
    'cooldown_elapsed_ms', 'cooldown_required_ms', 'session_budget_remaining',
    'daily_budget_remaining', 'created_at',
  ],
  director_critic_shadow_decision: [
    'decision_id', 'run_id', 'session_id', 'round', 'source_revision', 'policy_version',
    'director_verdict', 'critic_verdict', 'director_score', 'critic_score',
    'reason_codes_json', 'facts_digest', 'routing_digest', 'has_stable_revision',
    'key_event_count', 'parallel_event_count', 'active_arc_count',
    'unresolved_dependency_count', 'evidence_gap_count', 'fact_reference_risk_count',
    'player_sovereignty_risk_count', 'duplicate_output', 'npc_knowledge_risk_count',
    'contract_issue_count', 'model_attempts', 'created_at',
  ],
  agent_runtime_lease_outcome: [
    'lease_id_digest', 'run_id', 'parent_run_id', 'session_id', 'source_revision',
    'lane', 'task_kind', 'policy_version', 'evidence_digests_json',
    'budget_profile_digest', 'tool_set_digest', 'outcome', 'reason_code',
    'model_calls_used', 'authorization_calls_used', 'provider_error_attempts_used',
    'provider_diagnostic_code',
    'input_tokens_used', 'output_tokens_used', 'cost_microusd_used',
    'wall_ms_used', 'started_at', 'finished_at',
  ],
});

function normalizeAgentAdmissionAuthorityTriggerSql(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function agentAdmissionAuthorityTriggerSql(
  name: string,
  operation: 'DELETE' | 'INSERT' | 'UPDATE',
): string {
  // sqlite_master removes IF NOT EXISTS and the final statement semicolon,
  // while preserving the trigger body. Compare the complete normalized text
  // so a disabled predicate or unreachable RAISE cannot masquerade as exact.
  return normalizeAgentAdmissionAuthorityTriggerSql(`
    CREATE TRIGGER ${name}
    AFTER ${operation} ON maintenance_admission_decision
    BEGIN
      UPDATE maintenance_admission_authority
      SET revision = revision + 1
      WHERE singleton = 1;
      SELECT CASE WHEN changes() <> 1
        THEN RAISE(ABORT, 'maintenance-admission-authority-invalid') END;
    END
  `);
}

const AGENT_ADMISSION_AUTHORITY_TRIGGERS = Object.freeze({
  maintenance_admission_authority_delete: agentAdmissionAuthorityTriggerSql(
    'maintenance_admission_authority_delete',
    'DELETE',
  ),
  maintenance_admission_authority_insert: agentAdmissionAuthorityTriggerSql(
    'maintenance_admission_authority_insert',
    'INSERT',
  ),
  maintenance_admission_authority_update: agentAdmissionAuthorityTriggerSql(
    'maintenance_admission_authority_update',
    'UPDATE',
  ),
} as const);

function inspectAgentAdmissionAuthoritySchema(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT singleton,generation,revision FROM maintenance_admission_authority
  `).all() as Array<{ singleton: unknown; generation: unknown; revision: unknown }>;
  if (rows.length !== 1 || rows[0]?.singleton !== 1
    || typeof rows[0].generation !== 'string'
    || !/^maintenance-admission:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(rows[0].generation)
    || !Number.isSafeInteger(rows[0].revision) || Number(rows[0].revision) < 0) {
    throw new Error('agent admission authority 坐标不匹配');
  }
  const triggers = db.prepare(`
    SELECT name,sql FROM sqlite_master
    WHERE type='trigger' AND tbl_name='maintenance_admission_decision'
    ORDER BY name
  `).all() as Array<{ name: string; sql: string | null }>;
  const expected = Object.entries(AGENT_ADMISSION_AUTHORITY_TRIGGERS);
  if (triggers.length !== expected.length) {
    throw new Error('agent admission authority trigger 集合不匹配');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const [name, expectedSql] = expected[index]!;
    const trigger = triggers[index];
    const sql = trigger?.sql
      ? normalizeAgentAdmissionAuthorityTriggerSql(trigger.sql)
      : '';
    if (trigger?.name !== name
      || sql !== expectedSql) {
      throw new Error('agent admission authority trigger 定义不匹配');
    }
  }
}

const AGENT_LEARNING_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  learning_event: [
    'event_id', 'payload_digest', 'run_id', 'session_id', 'card_id', 'content_mode',
    'event_kind', 'round', 'user_message_id', 'assistant_message_id', 'source_revision',
    'subject_digest', 'features_json', 'source_created_at', 'ingested_at',
  ],
});

const ARC_PROJECTION_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  arc_projection_action: [
    'id', 'session_id', 'run_id', 'source_revision', 'proposal_digest', 'provenance_digest',
    'action_index', 'action_kind', 'action_json', 'created_at',
  ],
  arc_projection_receipt: [
    'run_id', 'session_id', 'source_revision', 'proposal_digest', 'provenance_digest',
    'projection_json', 'created_at',
  ],
});

const AGENT_CONTROL_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agent_control_authority: ['singleton', 'generation', 'revision'],
  agent_maintenance_route_control: [
    'singleton', 'cohort_generation', 'state', 'target_session_id', 'evidence_digest',
    'revision', 'updated_at',
  ],
  agent_asset_mutation_pending: ['singleton', 'mutation_id', 'started_at'],
  agent_lane_control: ['lane', 'desired_state', 'killed_reason', 'updated_at'],
  agent_capability_control: ['capability_id', 'killed_reason', 'updated_at'],
  agent_lane_evaluation: [
    'lane', 'suite_digest', 'evaluation_version', 'evidence_class', 'passed', 'captured_at',
    'recorded_at',
  ],
  agent_lane_daily: [
    'lane', 'day', 'qualifying_samples', 'provider_calls', 'provider_errors', 'invalid_calls',
    'p95_latency_ms', 'player_sovereignty_violations', 'unauthorized_or_stale_writes',
    'duplicate_writes', 'sensitive_audit_violations',
  ],
  agent_lane_daily_observation: [
    'lane', 'day', 'observation_version', 'provider_calls', 'provider_errors', 'invalid_calls',
    'player_sovereignty_violations', 'unauthorized_or_stale_writes', 'duplicate_writes',
    'sensitive_audit_violations',
  ],
  agent_lane_qualifying_sample: [
    'lane', 'observation_version', 'session_id', 'parent_run_id', 'day', 'created_at',
  ],
  agent_lane_latency_histogram: [
    'lane', 'observation_version', 'day', 'bucket_upper_ms', 'sample_count',
  ],
  agent_lane_authorization_window: [
    'lane', 'window_sequence', 'max_provider_calls', 'provider_calls',
    'reserved_provider_calls', 'provider_errors', 'invalid_calls', 'qualifying_samples',
    'status', 'opened_at', 'closed_at', 'superseded_at', 'superseded_reason',
  ],
  agent_lane_authorization_window_latency: [
    'lane', 'window_sequence', 'bucket_upper_ms', 'sample_count',
  ],
  agent_lane_provider_reservation: [
    'reservation_digest', 'lane', 'window_sequence', 'idempotency_key_digest',
    'request_digest', 'lane_control_revision', 'reserved_provider_calls',
    'settled_provider_calls', 'status', 'created_at', 'deadline_at', 'started_at', 'settled_at',
  ],
  agent_lane_known_defect_correction: [
    'defect_id', 'lane', 'killed_reason', 'fixed_policy_revision',
    'source_control_revision', 'source_window_sequence', 'source_observation_version',
    'source_day', 'corrected_player_sovereignty_violations', 'evidence_digest', 'created_at',
  ],
  maintenance_invalid_tool_diagnostic: [
    'window_sequence', 'task_kind', 'run_id', 'tool', 'rejection_code', 'run_failed',
    'occurrence_count', 'occurred_at',
  ],
  maintenance_protocol_run_outcome: [
    'event_sequence', 'window_sequence', 'incident_group', 'task_kind', 'run_id', 'outcome',
    'occurred_at',
  ],
});

const AGENT_CLOSURE_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agent_closure_run: [
    'operation_id', 'contract_version', 'run_id', 'parent_run_id', 'session_id',
    'capability', 'lane', 'closure_kind', 'execution_class', 'source_revision',
    'policy_version', 'evidence_digest', 'current_stage', 'status',
    'next_required_event', 'consumed_count', 'production_closed', 'latest_reason_code',
    'revision', 'admitted_at', 'created_at', 'updated_at',
  ],
  agent_closure_event: [
    'event_id', 'operation_id', 'sequence', 'event_type', 'idempotency_key',
    'occurred_at', 'artifact_digest', 'evidence_ref', 'source_revision',
    'target_revision', 'consumer_run_id', 'context_block', 'reason_code',
    'item_count', 'token_count', 'effect_outcome', 'skill_attribution_json',
  ],
});

const STYLE_COMPILE_JOB_LEGACY_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    style_compile_job: [
        'job_id', 'session_id', 'content_mode', 'style_skill_id', 'round', 'source_revision',
        'explicit_request', 'state', 'attempts', 'owner', 'lease_expires_at', 'reason_code',
        'created_at', 'updated_at', 'availability_deferrals', 'not_before', 'run_id',
        'intent_packet_digest', 'execution_started_at', 'result_json',
    ],
    style_compile_job_schema: ['id', 'version'],
});

const STYLE_COMPILE_JOB_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    ...STYLE_COMPILE_JOB_LEGACY_EXACT_COLUMNS,
    style_compile_pilot_budget: [
        'pilot_id_digest', 'policy_digest', 'max_calls', 'max_cost_microusd', 'expires_at', 'halted',
    ],
    style_compile_pilot_permit: [
        'reservation_digest', 'pilot_id_digest', 'reserved_cost_microusd', 'created_at',
    ],
});

function pragmaInteger(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare('PRAGMA ' + name).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error('无法读取 PRAGMA ' + name);
  return Number(value);
}

function integrityOk(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>;
  return rows.length === 1 && String(rows[0]?.integrity_check ?? '').toLowerCase() === 'ok';
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  if (!/^[a-z_]+$/.test(table)) throw new Error('内部表名非法');
  return (db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name?: unknown }>)
    .map((row) => String(row.name ?? ''));
}

function sessionOrdinaryTableExists(db: DatabaseSync, table: string): boolean {
  const schema = db.prepare(
    'SELECT type,sql FROM sqlite_master WHERE name=? COLLATE NOCASE LIMIT 1',
  ).get(table) as { type?: unknown; sql?: unknown } | undefined;
  const listed = db.prepare(
    "SELECT type FROM pragma_table_list WHERE schema='main' AND name=? COLLATE NOCASE LIMIT 1",
  ).get(table) as { type?: unknown } | undefined;
  return schema?.type === 'table'
    && typeof schema.sql === 'string'
    && listed?.type === 'table'
    && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(schema.sql);
}

function inspectSessionSchema(db: DatabaseSync, version: number): void {
  inspectRpChildAnalysisStorage(db);
  inspectToolResultBodyStorage(db);
  if (version === SESSION_STORAGE_PREDECESSOR_VERSION) {
    inspectSessionPredecessorV16Storage(db);
    return;
  }
  if (version !== SESSION_SCHEMA_VERSION) throw new Error('session DB schema 版本不受支持');
  for (const [table, columns] of Object.entries(SESSION_V17_REQUIRED_COLUMNS)) {
    if (!sessionOrdinaryTableExists(db, table)) {
      throw new Error('session schema 缺少 ' + table + ' 必需普通表');
    }
    const actual = new Set(tableColumns(db, table));
    if (columns.some((column) => !actual.has(column))) {
      throw new Error('session schema 缺少 ' + table + ' 必需列');
    }
  }
  inspectSessionAuthoritySchema(db);
}

function inspectExactSchema(
  db: DatabaseSync,
  exact: Readonly<Record<string, readonly string[]>>,
  label: string,
  orderedColumns = true,
): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name?: unknown }>).map((row) => String(row.name ?? ''));
  const expectedTables = Object.keys(exact).sort();
  if (tables.join(',') !== expectedTables.join(',')) throw new Error(label + ' 表集合不一致');
  for (const [table, expected] of Object.entries(exact)) {
    const actual = tableColumns(db, table);
    if ((orderedColumns ? actual : actual.sort()).join(',')
      !== (orderedColumns ? expected : [...expected].sort()).join(',')) {
      throw new Error(label + ' 表列不一致：' + table);
    }
  }
}

function inspectRole(
  db: DatabaseSync,
  component: SnapshotComponentPlan,
): void {
  const version = pragmaInteger(db, 'user_version');
  if (version !== component.schemaVersion) {
    throw new Error('SQLite 副本 user_version 与 inventory 不一致');
  }
  const applicationId = pragmaInteger(db, 'application_id');
  // This reserved component cannot be replaced by another otherwise valid control/Session DB.
  if (component.sourceRelativePath.replace(/\\/gu, '/').toLowerCase() === `agent-loop-projection/${AGENT_LOOP_PROJECTION_DB_FILE}`
    && (component.role !== 'control-db' || applicationId !== AGENT_LOOP_PROJECTION_APPLICATION_ID)) {
    throw new Error('agent loop projection 路径必须绑定 JGLP control-db');
  }
  if (component.role === 'session-db') {
    if (applicationId !== 0) throw new Error('session DB application_id 必须是 0');
    if (version !== SESSION_STORAGE_PREDECESSOR_VERSION && version !== SESSION_SCHEMA_VERSION) {
      throw new Error('session DB schema 版本不受支持');
    }
    inspectSessionSchema(db, version);
    return;
  }
  if (component.role === 'control-db') {
    if (applicationId === WORLDBOOK_REPAIR_APPLICATION_ID) {
      inspectWorldbookRepairSchema(db);
      return;
    }
    if (applicationId === AGENT_LOOP_PROJECTION_APPLICATION_ID) {
      // Preserve released AL7/AL8 backups without granting a backup reader migration authority.
      if (version === 7) inspectAgentLoopProjectionSchemaV7Exact(db);
      else if (version === 8) inspectAgentLoopProjectionSchemaV8Exact(db);
      else if (version === AGENT_LOOP_PROJECTION_SCHEMA_VERSION) inspectAgentLoopProjectionSchemaExact(db);
      else throw new Error('agent loop projection schema 不是受支持版本');
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        throw new Error('agent loop projection foreign key 不完整');
      }
      return;
    }
    if (applicationId === STYLE_COMPILE_JOB_APPLICATION_ID) {
      if (version !== 4 && version !== STYLE_COMPILE_JOB_SCHEMA_VERSION) {
        throw new Error('style compile job schema 不是受支持版本');
      }
      // Legacy upgrades append columns; identical closed column sets need not share physical order.
      const exact = version === 4 ? STYLE_COMPILE_JOB_LEGACY_EXACT_COLUMNS : STYLE_COMPILE_JOB_EXACT_COLUMNS;
      inspectExactSchema(db, exact, 'style compile job', false);
      const schema = db.prepare('SELECT id,version FROM style_compile_job_schema LIMIT 2').all();
      if (schema.length !== 1 || schema[0]?.id !== 1 || schema[0]?.version !== version) {
        throw new Error('style compile job schema 元数据不匹配');
      }
      return;
    }
    if (applicationId === TURN_JOB_APPLICATION_ID) {
      if (version !== TURN_JOB_SCHEMA_VERSION) throw new Error('turn job schema 不是当前版本');
      inspectExactSchema(db, TURN_JOB_EXACT_COLUMNS, 'turn job');
      return;
    }
    if (applicationId === MAINTENANCE_JOB_APPLICATION_ID) {
      if (![4, 5, 6, 7, MAINTENANCE_JOB_SCHEMA_VERSION].includes(version)) throw new Error('maintenance job schema 不是受支持版本');
      const hasSkillOutbox = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE);
      const hasDirectProposal = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE);
      const hasSummarySource = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?')
        .get(MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE);
      inspectExactSchema(db, {
        ...(version === 4 ? MAINTENANCE_JOB_V4_EXACT_COLUMNS
          : version === 5 ? MAINTENANCE_JOB_V5_EXACT_COLUMNS
            : version === 6 ? MAINTENANCE_JOB_V6_EXACT_COLUMNS
              : version === 7 ? MAINTENANCE_JOB_V7_EXACT_COLUMNS
                : MAINTENANCE_JOB_EXACT_COLUMNS),
        ...(hasSkillOutbox ? {
          [MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE]: MAINTENANCE_MEMORY_SKILL_OUTBOX_COLUMNS,
        } : {}),
        ...(hasDirectProposal ? {
          [MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE]: MAINTENANCE_MEMORY_DIRECT_PROPOSAL_COLUMNS,
        } : {}),
        ...(hasSummarySource ? {
          [MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE]: MAINTENANCE_SUMMARY_SKILL_SOURCE_COLUMNS,
        } : {}),
      }, 'maintenance job');
      if (hasDirectProposal) inspectMaintenanceMemoryDirectProposalSchema(db);
      if (hasSummarySource) inspectMaintenanceSummarySkillSourceSchema(db);
      if (version === MAINTENANCE_JOB_SCHEMA_VERSION) {
        inspectMaintenanceProductionRouteReceiptSchema(db);
      }
      return;
    }
    if (applicationId === INTERACTIVE_LEDGER_APPLICATION_ID) {
      if (version !== INTERACTIVE_LEDGER_SCHEMA_VERSION) throw new Error('interactive ledger schema 不是当前版本');
      inspectExactSchema(db, INTERACTIVE_LEDGER_EXACT_COLUMNS, 'interactive ledger');
      return;
    }
    if (applicationId === MODEL_USAGE_APPLICATION_ID) {
      if (version !== MODEL_USAGE_SCHEMA_VERSION) throw new Error('model usage schema 不是当前版本');
      inspectExactSchema(db, MODEL_USAGE_EXACT_COLUMNS, 'model usage');
      return;
    }
    if (applicationId === AGENT_ADMISSION_APPLICATION_ID) {
      if (version !== AGENT_ADMISSION_SCHEMA_VERSION) throw new Error('agent admission schema 不是当前版本');
      inspectExactSchema(db, AGENT_ADMISSION_EXACT_COLUMNS, 'agent admission');
      inspectAgentAdmissionAuthoritySchema(db);
      return;
    }
    if (applicationId === AGENT_LEARNING_APPLICATION_ID) {
      if (version !== AGENT_LEARNING_SCHEMA_VERSION) throw new Error('agent learning schema 不是当前版本');
      inspectExactSchema(db, AGENT_LEARNING_EXACT_COLUMNS, 'agent learning');
      return;
    }
    if (applicationId === ARC_PROJECTION_APPLICATION_ID) {
      if (version !== ARC_PROJECTION_SCHEMA_VERSION) throw new Error('arc projection schema 不是当前版本');
      inspectExactSchema(db, ARC_PROJECTION_EXACT_COLUMNS, 'arc projection');
      return;
    }
    if (applicationId === AGENT_CONTROL_APPLICATION_ID) {
      if (version !== AGENT_CONTROL_SCHEMA_VERSION) throw new Error('agent control schema 不是当前版本');
      inspectExactSchema(db, AGENT_CONTROL_EXACT_COLUMNS, 'agent control');
      inspectAgentControlAuthoritySchema(db);
      return;
    }
    if (applicationId === AGENT_CLOSURE_APPLICATION_ID) {
      if (version !== 1 && version !== AGENT_CLOSURE_SCHEMA_VERSION) throw new Error('agent closure schema 版本不支持');
      const columns = version === 1 ? Object.fromEntries(Object.entries(AGENT_CLOSURE_EXACT_COLUMNS)
        .map(([table, fields]) => [table, fields.filter((field) => field !== 'skill_attribution_json')]))
        : AGENT_CLOSURE_EXACT_COLUMNS;
      inspectExactSchema(db, columns, 'agent closure');
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(agent_closure_event)')
        .all() as Array<Record<string, unknown>>;
      if (foreignKeys.length !== 1
        || foreignKeys[0]?.table !== 'agent_closure_run'
        || foreignKeys[0]?.from !== 'operation_id'
        || foreignKeys[0]?.to !== 'operation_id'
        || String(foreignKeys[0]?.on_delete).toUpperCase() !== 'CASCADE') {
        throw new Error('agent closure foreign key 不匹配');
      }
      return;
    }
    if (applicationId === DIRECTOR_CREATIVE_APPLICATION_ID) {
        inspectDirectorCreativeSchema(db);
        return;
    }
    if (applicationId === AGENT_EVIDENCE_APPLICATION_ID) {
        // The ledger owns its append-only checks and deletion fences, not just column names.
        inspectAgentEvidenceSchema(db);
        return;
    }
    if (applicationId === AGENT_SKILL_CANDIDATE_APPLICATION_ID) {
        inspectAgentSkillCandidateSchema(db);
        return;
    }
    if (applicationId === SKILL_COMPILE_APPLICATION_ID) {
        inspectSkillCompileSchema(db);
        return;
    }
    if (applicationId === SKILL_EVALUATE_APPLICATION_ID) {
        inspectSkillEvaluateSchema(db);
        return;
    }
    if (applicationId === SKILL_SAMPLE_APPLICATION_ID) {
        inspectSkillSampleSchema(db);
        return;
    }
    if (applicationId === SKILL_QUALITY_APPLICATION_ID) {
        inspectSkillQualitySchema(db);
        return;
    }
    if (applicationId === SKILL_PACKAGE_PIN_APPLICATION_ID) {
        inspectSkillPackagePinSchema(db);
        return;
    }
    throw new Error('control-db application_id 不匹配');
  }
  if (component.role === 'auth-db') {
    if (applicationId !== AUTH_DB_APPLICATION_ID) throw new Error('auth application_id 不匹配');
    if (version !== AUTH_SCHEMA_VERSION) throw new Error('auth schema 不是当前版本');
    const exactness = inspectAuthSchemaExactness(db);
    if (!exactness.ok) throw new Error('auth schema 不精确：' + exactness.detail);
    return;
  }
  throw new Error('SQLite adapter 只接受数据库 role');
}

/**
 * Prove that a frozen v16 artifact can be taken over by the current Session
 * owner without mutating the artifact itself. Column checks cannot cover every
 * SQLite object collision or virtual-table restriction exercised by real DDL.
 */
function probeSessionPredecessorOwnerMigration(sourcePath: string): void {
  let probeRoot: string | undefined;
  let migrated: MemoryDb | undefined;
  let primaryError: unknown;
  try {
    probeRoot = mkdtempSync(join(tmpdir(), 'jg-session-v16-owner-probe-'));
    const probePath = join(probeRoot, 'session.db');
    copyFileSync(sourcePath, probePath);
    // copyFile preserves a read-only source mode on Windows. The probe is an
    // isolated disposable owner candidate, so make only that copy writable.
    chmodSync(probePath, 0o600);
    migrated = new MemoryDb({ path: probePath });
    if (migrated.userVersion() !== SESSION_SCHEMA_VERSION) {
      throw new Error('session v16 owner probe 未迁移到当前版本');
    }
    inspectSessionAuthoritySchema(migrated.db);
  } catch (error) {
    primaryError = error;
  }

  // Close before recursive cleanup so Windows never retains the probe file.
  if (migrated?.db.isOpen) {
    try { migrated.close(); } catch (error) { primaryError ??= error; }
  }
  if (probeRoot !== undefined) {
    try { rmSync(probeRoot, { recursive: true, force: true }); } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

/** 对已落盘的恢复/快照 SQLite 单文件执行只读完整性与角色结构验证。 */
export function verifySnapshotSqliteFile(
  component: SnapshotComponentPlan,
  path: string,
): void {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 校验目标必须是普通文件');
  }
  if (existsSync(absolute + '-wal') || existsSync(absolute + '-shm')) {
    throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 校验目标不得携带 WAL/SHM');
  }
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    if (!integrityOk(db)) throw new Error('SQLite 副本 integrity_check 非 ok');
    inspectRole(db, component);
  } catch (cause) {
    throw cause instanceof SnapshotCoordinatorError
      ? cause
      : new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 单文件完整性/结构校验失败', { cause });
  } finally {
    db.close();
  }
  if (component.role === 'session-db'
    && component.schemaVersion === SESSION_STORAGE_PREDECESSOR_VERSION) {
    try {
      probeSessionPredecessorOwnerMigration(absolute);
    } catch (cause) {
      throw new SnapshotCoordinatorError(
        'snapshot-invalid',
        'Session v16 副本无法由当前 owner 完整迁移',
        { cause },
      );
    }
  }
}

function sqlString(value: string): string {
  return "'" + value.replace(/\\/g, '/').replace(/'/g, "''") + "'";
}

function cleanupOutput(destinationPath: string): void {
  rmSync(destinationPath, { force: true });
  rmSync(destinationPath + '-wal', { force: true });
  rmSync(destinationPath + '-shm', { force: true });
}

/** Snapshot copies are recovery artifacts, never reusable authorization windows. Source stays read-only. */
function sealStylePilotBudgetSnapshot(component: SnapshotComponentPlan, destinationPath: string): void {
    if (component.role !== 'control-db') return;
    const copy = new DatabaseSync(destinationPath);
    try {
        if (pragmaInteger(copy, 'application_id') !== STYLE_COMPILE_JOB_APPLICATION_ID) return;
        if (pragmaInteger(copy, 'user_version') !== STYLE_COMPILE_JOB_SCHEMA_VERSION) return;
        copy.exec('UPDATE style_compile_pilot_budget SET halted=1');
        if (copy.prepare('SELECT 1 FROM style_compile_pilot_budget WHERE halted IS NOT 1 LIMIT 1').get()) {
            throw new Error('style compile pilot snapshot seal failed');
        }
    } finally {
        copy.close();
    }
}

export class SqliteOnlineSnapshotAdapter implements SnapshotSqliteCaptureAdapter {
  captureOnline(input: {
    component: SnapshotComponentPlan;
    sourcePath: string;
    destinationPath: string;
  }): void {
    const sourcePath = resolve(input.sourcePath);
    const destinationPath = resolve(input.destinationPath);
    if (sourcePath === destinationPath) {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 来源与目标路径非法');
    }
    const sourceStats = lstatSync(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 来源必须是普通文件');
    }
    for (const path of [destinationPath, destinationPath + '-wal', destinationPath + '-shm']) {
      if (existsSync(path)) {
        throw new SnapshotCoordinatorError('snapshot-conflict', 'SQLite capture 目标或旁文件已存在');
      }
    }
    if (input.component.captureMode !== 'sqlite-online') {
      throw new SnapshotCoordinatorError('snapshot-invalid', 'SQLite adapter 拒绝非 sqlite-online 组件');
    }

    let source: DatabaseSync | undefined;
    try {
      source = new DatabaseSync(sourcePath, { readOnly: true });
      source.exec('PRAGMA busy_timeout = 250; VACUUM INTO ' + sqlString(destinationPath));
      source.close();
      source = undefined;

      if (existsSync(destinationPath + '-wal') || existsSync(destinationPath + '-shm')) {
        throw new Error('SQLite 在线副本产生 WAL/SHM 旁文件');
      }
      const outputStats = lstatSync(destinationPath);
      if (!outputStats.isFile() || outputStats.isSymbolicLink()) throw new Error('SQLite 在线副本不是普通文件');
      verifySnapshotSqliteFile(input.component, destinationPath);
      sealStylePilotBudgetSnapshot(input.component, destinationPath);
      verifySnapshotSqliteFile(input.component, destinationPath);
    } catch (cause) {
      try { source?.close(); } catch { /* 保留原始错误。 */ }
      cleanupOutput(destinationPath);
      throw cause instanceof SnapshotCoordinatorError
        ? cause
        : new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 在线 capture/校验失败', { cause });
    }
  }
}
