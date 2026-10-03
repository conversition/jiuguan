import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTH_DB_APPLICATION_ID,
  AUTH_SCHEMA_VERSION,
  inspectAuthSchemaExactness,
} from '../../packages/server-auth/src/index.ts';
import { SCHEMA_VERSION as SESSION_SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import {
  TURN_JOB_APPLICATION_ID,
  TURN_JOB_SCHEMA_VERSION,
} from './turn-job-manager.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from './maintenance-job-manager.ts';
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
  AGENT_CONTROL_APPLICATION_ID,
  AGENT_CONTROL_SCHEMA_VERSION,
} from './agent-control-store.ts';
import {
  SnapshotCoordinatorError,
  type SnapshotComponentPlan,
  type SnapshotSqliteCaptureAdapter,
} from './snapshot-coordinator.ts';

const SESSION_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  memory_meta: ['id', 'arc_id', 'stage', 'plot_round', 'bars', 'config'],
  chat_log: ['id', 'round', 'role', 'content'],
  memory_arc: ['id', 'code', 'chapter', 'title', 'summary', 'status', 'seq'],
  memory_summary: ['id', 'code', 'round', 'delta', 'scene'],
  memory_event: ['id', 'code', 'description', 'characters', 'refs', 'resolved'],
  memory_parallel: ['id', 'kind', 'countdown_min', 'actor', 'location', 'action', 'next_stage'],
  memory_state: ['id', 'entity_type', 'entity_id', 'name', 'state_json', 'updated_round'],
  lorebook_entry: ['id', 'uid', 'book', 'key', 'comment', 'content'],
  state_snapshot: ['scope', 'scope_key', 'branch_key', 'state_json', 'state_version'],
  session_control: ['session_key', 'control_key', 'value'],
  character_registry: ['session_key', 'character_id', 'name', 'kind'],
  character_alias: ['session_key', 'alias', 'character_id', 'explicit'],
  character_fact_log: ['session_key', 'character_id', 'field', 'value_json', 'history_epoch'],
  character_mention_pool: ['session_key', 'mention_key', 'rounds_json', 'pending_json'],
  turn_job_outcome: ['run_id', 'session_id', 'action', 'round', 'revision'],
  turn_observation: [
    'observation_id', 'run_id', 'session_id', 'round', 'assistant_message_id',
    'source_revision', 'query_plan_version', 'routing_digest', 'recall_hit_count',
    'recall_codes_json', 'worldbook_hit_count', 'resolved_entity_count',
    'ambiguous_entity_count', 'skill_ids_json', 'skill_body_hashes_json',
    'skill_tokens', 'assembled_prompt_tokens', 'harness_lane',
    'harness_evidence_count', 'model_attempts', 'payload_digest', 'created_at',
  ],
  learning_outbox: [
    'event_id', 'run_id', 'session_id', 'card_id', 'content_mode', 'event_kind',
    'round', 'user_message_id', 'assistant_message_id', 'source_revision',
    'subject_digest', 'features_json', 'payload_digest', 'created_at', 'delivered_at',
  ],
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

const MAINTENANCE_JOB_EXACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
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

function inspectSessionSchema(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(SESSION_REQUIRED_COLUMNS)) {
    const actual = new Set(tableColumns(db, table));
    if (columns.some((column) => !actual.has(column))) {
      throw new Error('session schema 缺少 ' + table + ' 必需列');
    }
  }
}

function inspectExactSchema(db: DatabaseSync, exact: Readonly<Record<string, readonly string[]>>, label: string): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name?: unknown }>).map((row) => String(row.name ?? ''));
  const expectedTables = Object.keys(exact).sort();
  if (tables.join(',') !== expectedTables.join(',')) throw new Error(label + ' 表集合不一致');
  for (const [table, expected] of Object.entries(exact)) {
    if (tableColumns(db, table).join(',') !== expected.join(',')) {
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
  if (component.role === 'session-db') {
    if (applicationId !== 0) throw new Error('session DB application_id 必须是 0');
    if (version !== SESSION_SCHEMA_VERSION) throw new Error('session DB schema 不是当前版本');
    inspectSessionSchema(db);
    return;
  }
  if (component.role === 'control-db') {
    if (applicationId === TURN_JOB_APPLICATION_ID) {
      if (version !== TURN_JOB_SCHEMA_VERSION) throw new Error('turn job schema 不是当前版本');
      inspectExactSchema(db, TURN_JOB_EXACT_COLUMNS, 'turn job');
      return;
    }
    if (applicationId === MAINTENANCE_JOB_APPLICATION_ID) {
      if (version !== MAINTENANCE_JOB_SCHEMA_VERSION) throw new Error('maintenance job schema 不是当前版本');
      inspectExactSchema(db, MAINTENANCE_JOB_EXACT_COLUMNS, 'maintenance job');
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
}

function sqlString(value: string): string {
  return "'" + value.replace(/\\/g, '/').replace(/'/g, "''") + "'";
}

function cleanupOutput(destinationPath: string): void {
  rmSync(destinationPath, { force: true });
  rmSync(destinationPath + '-wal', { force: true });
  rmSync(destinationPath + '-shm', { force: true });
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
    } catch (cause) {
      try { source?.close(); } catch { /* 保留原始错误。 */ }
      cleanupOutput(destinationPath);
      throw cause instanceof SnapshotCoordinatorError
        ? cause
        : new SnapshotCoordinatorError('snapshot-invalid', 'SQLite 在线 capture/校验失败', { cause });
    }
  }
}
