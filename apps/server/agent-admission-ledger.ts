import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  POLICY_ROUTER_LEGACY_VERSION,
  POLICY_ROUTER_VERSION,
  POLICY_REASON_CODES,
  computeAdmissionFactsDigest,
  evaluatePolicyRouter,
  normalizeAdmissionFacts,
  type AdmissionFacts,
  type PolicyHardSignal,
  type PolicyReasonCode,
  type PolicyRouterAudit,
  type PolicyRouterDecision,
  type PolicyVerdict,
  type PolicyRouterVersion,
} from '../../packages/agent-policy/src/policy-router.ts';
import {
  MAINTENANCE_ADMISSION_REASON_CODES,
  MAINTENANCE_ADMISSION_TASKS,
  evaluateMaintenanceAdmissionBatch,
  MAINTENANCE_ADMISSION_POLICY_VERSIONS,
  normalizeMaintenanceAdmissionFacts,
  type MaintenanceAdmissionAudit,
  type MaintenanceAdmissionDecision,
  type MaintenanceAdmissionFacts,
  type MaintenanceAdmissionReasonCode,
  type MaintenanceAdmissionTask,
  type MaintenanceAdmissionVerdict,
} from '../../packages/agent-policy/src/maintenance-admission.ts';
import {
  DIRECTOR_CRITIC_REASON_CODES,
  evaluateDirectorCriticShadow,
  normalizeDirectorCriticFacts,
  type CriticVerdict,
  type DirectorCriticAudit,
  type DirectorCriticDecision,
  type DirectorCriticFacts,
  type DirectorCriticReasonCode,
  type DirectorVerdict,
} from '../../packages/agent-policy/src/director-critic-shadow.ts';
import type {
  AdmittedModelGatewayErrorCode,
  AdmittedModelLeaseAudit,
  AdmittedModelLeaseOutcome,
} from './admitted-model-gateway.ts';
import {
  AGENT_TASK_KINDS,
  type AgentLane,
  type AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';
import type { ProviderFailureDiagnosticCode } from '../../packages/proxy/src/provider-registry.ts';

export const AGENT_ADMISSION_DB_FILE = 'agent-admission.sqlite';
export const AGENT_ADMISSION_SCHEMA_VERSION = 7;
export const AGENT_ADMISSION_APPLICATION_ID = 0x4a474144; // JGAD

export interface AgentAdmissionRow {
  readonly decisionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly round: number;
  readonly sourceRevision: string;
  readonly facts: AdmissionFacts;
  readonly decision: PolicyRouterDecision;
  readonly createdAt: string;
}

export interface AgentAdmissionFilters {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly verdict?: PolicyVerdict;
  readonly limit?: number;
}

export interface MaintenanceAdmissionRow {
  readonly decisionId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly round: number;
  readonly sourceRevision: string;
  readonly facts: MaintenanceAdmissionFacts;
  readonly decision: MaintenanceAdmissionDecision;
  readonly createdAt: string;
}

export interface MaintenanceAdmissionFilters {
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly taskKind?: MaintenanceAdmissionTask;
  readonly verdict?: MaintenanceAdmissionVerdict;
  readonly limit?: number;
}

export interface AgentAdmissionFileRows {
  readonly interactive: readonly AgentAdmissionRow[];
  readonly maintenance: readonly MaintenanceAdmissionRow[];
  readonly directorCritic: readonly DirectorCriticAdmissionRow[];
  readonly runtimeLeases: readonly AgentRuntimeLeaseRow[];
}

export interface AgentRuntimeLeaseRow {
  readonly leaseIdDigest: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly evidenceDigests: readonly string[];
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly outcome: AdmittedModelLeaseOutcome;
  readonly reasonCode?: AdmittedModelGatewayErrorCode;
  readonly modelCallsUsed: number;
  readonly authorizationCallsUsed: number;
  readonly providerErrorAttemptsUsed: number;
  readonly providerDiagnosticCode?: ProviderFailureDiagnosticCode;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
  readonly costMicrousdUsed: number;
  readonly wallMsUsed: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface AgentRuntimeLeaseFilters {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly outcome?: AdmittedModelLeaseOutcome;
  readonly limit?: number;
}

export interface DirectorCriticAdmissionRow extends DirectorCriticAudit {
  readonly decisionId: string;
}

export interface DirectorCriticAdmissionFilters {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly directorVerdict?: DirectorVerdict;
  readonly criticVerdict?: CriticVerdict;
  readonly limit?: number;
}

export interface AgentAdmissionSessionDeleteResult {
  readonly interactiveDecisions: number;
  readonly maintenanceDecisions: number;
  readonly directorCriticDecisions: number;
  readonly runtimeLeaseOutcomes: number;
}

type Row = Record<string, unknown>;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const DIRECTOR_CRITIC_TABLE_SQL = `
  CREATE TABLE director_critic_shadow_decision (
    decision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    round INTEGER NOT NULL CHECK(round >= 1),
    source_revision TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    director_verdict TEXT NOT NULL CHECK(director_verdict IN ('would-direct','skip-direct')),
    critic_verdict TEXT NOT NULL CHECK(critic_verdict IN ('would-critic','skip-critic')),
    director_score INTEGER NOT NULL CHECK(director_score >= 0),
    critic_score INTEGER NOT NULL CHECK(critic_score >= 0),
    reason_codes_json TEXT NOT NULL,
    facts_digest TEXT NOT NULL,
    routing_digest TEXT NOT NULL,
    has_stable_revision INTEGER NOT NULL CHECK(has_stable_revision IN (0,1)),
    key_event_count INTEGER NOT NULL CHECK(key_event_count >= 0),
    parallel_event_count INTEGER NOT NULL CHECK(parallel_event_count >= 0),
    active_arc_count INTEGER NOT NULL CHECK(active_arc_count >= 0),
    unresolved_dependency_count INTEGER NOT NULL CHECK(unresolved_dependency_count >= 0),
    evidence_gap_count INTEGER NOT NULL CHECK(evidence_gap_count >= 0),
    fact_reference_risk_count INTEGER NOT NULL CHECK(fact_reference_risk_count >= 0),
    player_sovereignty_risk_count INTEGER NOT NULL CHECK(player_sovereignty_risk_count >= 0),
    duplicate_output INTEGER NOT NULL CHECK(duplicate_output IN (0,1)),
    npc_knowledge_risk_count INTEGER NOT NULL CHECK(npc_knowledge_risk_count >= 0),
    contract_issue_count INTEGER NOT NULL CHECK(contract_issue_count >= 0),
    model_attempts INTEGER NOT NULL CHECK(model_attempts >= 1),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, source_revision, policy_version)
  );
  CREATE INDEX director_critic_shadow_run ON director_critic_shadow_decision(run_id, created_at);
  CREATE INDEX director_critic_shadow_session ON director_critic_shadow_decision(session_id, created_at);
  CREATE INDEX director_critic_shadow_verdict ON director_critic_shadow_decision(director_verdict, critic_verdict, created_at);
`;
const RUNTIME_LEASE_TABLE_SQL = `
  CREATE TABLE agent_runtime_lease_outcome (
    lease_id_digest TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    lane TEXT NOT NULL CHECK(lane IN ('interactive','maintenance','learning','critic')),
    task_kind TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    evidence_digests_json TEXT NOT NULL,
    budget_profile_digest TEXT NOT NULL,
    tool_set_digest TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','budget_exhausted','usage_unavailable','provider_error','cancelled','expired')),
    reason_code TEXT,
    model_calls_used INTEGER NOT NULL CHECK(model_calls_used >= 0),
    authorization_calls_used INTEGER NOT NULL CHECK(authorization_calls_used >= 0 AND authorization_calls_used <= model_calls_used),
    provider_error_attempts_used INTEGER NOT NULL CHECK(
      provider_error_attempts_used >= 0
      AND authorization_calls_used + provider_error_attempts_used <= model_calls_used
    ),
    provider_diagnostic_code TEXT CHECK(provider_diagnostic_code IS NULL OR provider_diagnostic_code IN (
      'provider-not-configured','provider-authentication-failed','provider-request-invalid',
      'provider-rate-limited','provider-timeout','provider-upstream-unavailable',
      'provider-transport-failed','provider-stream-failed','provider-stream-incomplete',
      'provider-disposed','provider-failed'
    )),
    input_tokens_used INTEGER NOT NULL CHECK(input_tokens_used >= 0),
    output_tokens_used INTEGER NOT NULL CHECK(output_tokens_used >= 0),
    cost_microusd_used INTEGER NOT NULL CHECK(cost_microusd_used >= 0),
    wall_ms_used INTEGER NOT NULL CHECK(wall_ms_used >= 0),
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );
  CREATE INDEX agent_runtime_lease_run ON agent_runtime_lease_outcome(run_id, finished_at);
  CREATE INDEX agent_runtime_lease_session ON agent_runtime_lease_outcome(session_id, finished_at);
  CREATE INDEX agent_runtime_lease_task ON agent_runtime_lease_outcome(task_kind, finished_at);
  CREATE INDEX agent_runtime_lease_outcome_idx ON agent_runtime_lease_outcome(outcome, finished_at);
`;

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`agent-admission-${name}-invalid`);
  return Number(value);
}

function ensureRouterV2Columns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(agent_admission_decision)').all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  if (!columns.has('entity_evidence')) {
    db.exec("ALTER TABLE agent_admission_decision ADD COLUMN entity_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(entity_evidence IN ('known','unknown')); ");
  }
  if (!columns.has('worldbook_evidence')) {
    db.exec("ALTER TABLE agent_admission_decision ADD COLUMN worldbook_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(worldbook_evidence IN ('known','unknown')); ");
  }
  if (!columns.has('arc_evidence')) {
    db.exec("ALTER TABLE agent_admission_decision ADD COLUMN arc_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(arc_evidence IN ('known','unknown')); ");
  }
  if (!columns.has('semantic_route')) {
    db.exec("ALTER TABLE agent_admission_decision ADD COLUMN semantic_route TEXT NOT NULL DEFAULT 'ineligible' CHECK(semantic_route IN ('not-needed','eligible','ineligible')); ");
    db.exec("UPDATE agent_admission_decision SET semantic_route=CASE WHEN hard_signals_json='[]' THEN 'ineligible' ELSE 'not-needed' END");
  }
}

function ensureRuntimeLeaseV6Columns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(agent_runtime_lease_outcome)').all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  if (!columns.has('lane')) {
    db.exec("ALTER TABLE agent_runtime_lease_outcome ADD COLUMN lane TEXT NOT NULL DEFAULT 'interactive' CHECK(lane IN ('interactive','maintenance','learning','critic')); ");
  }
  if (!columns.has('task_kind')) {
    db.exec("ALTER TABLE agent_runtime_lease_outcome ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'interactive_prelude'; ");
  }
  if (!columns.has('policy_version')) {
    db.exec("ALTER TABLE agent_runtime_lease_outcome ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'legacy-runtime-v1'; ");
  }
  if (!columns.has('evidence_digests_json')) {
    db.exec("ALTER TABLE agent_runtime_lease_outcome ADD COLUMN evidence_digests_json TEXT NOT NULL DEFAULT '[]'; ");
  }
  db.exec('CREATE INDEX IF NOT EXISTS agent_runtime_lease_task ON agent_runtime_lease_outcome(task_kind, finished_at);');
}

function rebuildRuntimeLeaseV7(db: DatabaseSync): void {
  // ALTER TABLE appends columns after finished_at, which violates the exact snapshot schema.
  // Rebuild once so upgraded databases and fresh databases have the same canonical layout.
  db.exec(`
    ALTER TABLE agent_runtime_lease_outcome RENAME TO agent_runtime_lease_outcome_v6;
    DROP INDEX IF EXISTS agent_runtime_lease_run;
    DROP INDEX IF EXISTS agent_runtime_lease_session;
    DROP INDEX IF EXISTS agent_runtime_lease_task;
    DROP INDEX IF EXISTS agent_runtime_lease_outcome_idx;
    ${RUNTIME_LEASE_TABLE_SQL}
    INSERT INTO agent_runtime_lease_outcome(
      lease_id_digest,run_id,parent_run_id,session_id,source_revision,
      lane,task_kind,policy_version,evidence_digests_json,
      budget_profile_digest,tool_set_digest,outcome,reason_code,
      model_calls_used,authorization_calls_used,provider_error_attempts_used,
      provider_diagnostic_code,input_tokens_used,output_tokens_used,cost_microusd_used,
      wall_ms_used,started_at,finished_at
    )
    SELECT
      lease_id_digest,run_id,parent_run_id,session_id,source_revision,
      lane,task_kind,policy_version,evidence_digests_json,
      budget_profile_digest,tool_set_digest,outcome,reason_code,
      model_calls_used,model_calls_used,0,NULL,
      input_tokens_used,output_tokens_used,cost_microusd_used,
      wall_ms_used,started_at,finished_at
    FROM agent_runtime_lease_outcome_v6;
    DROP TABLE agent_runtime_lease_outcome_v6;
  `);
}

function initialize(db: DatabaseSync): void {
  const version = pragma(db, 'user_version');
  const appId = pragma(db, 'application_id');
  if (version > AGENT_ADMISSION_SCHEMA_VERSION) throw new Error('agent-admission-too-new');
  if (version === AGENT_ADMISSION_SCHEMA_VERSION) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    return;
  }
  if (version === 6) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      rebuildRuntimeLeaseV7(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION}; COMMIT;`);
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (version === 5) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      ensureRuntimeLeaseV6Columns(db);
      rebuildRuntimeLeaseV7(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION}; COMMIT;`);
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (version === 4) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      ensureRouterV2Columns(db);
      ensureRuntimeLeaseV6Columns(db);
      rebuildRuntimeLeaseV7(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION}; COMMIT;`);
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (version === 3) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(RUNTIME_LEASE_TABLE_SQL);
      ensureRouterV2Columns(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION};`);
      db.exec('COMMIT;');
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (version === 2) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`${DIRECTOR_CRITIC_TABLE_SQL} ${RUNTIME_LEASE_TABLE_SQL}`);
      ensureRouterV2Columns(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION};`);
      db.exec('COMMIT;');
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (version === 1) {
    if (appId !== AGENT_ADMISSION_APPLICATION_ID) throw new Error('agent-admission-metadata-mismatch');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
        CREATE TABLE maintenance_admission_decision (
          decision_id TEXT PRIMARY KEY,
          parent_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          round INTEGER NOT NULL CHECK(round >= 1),
          source_revision TEXT NOT NULL,
          task_kind TEXT NOT NULL CHECK(task_kind IN ('memory_consolidation','branch_index','rolling_summary','npc_state')),
          policy_version TEXT NOT NULL,
          verdict TEXT NOT NULL CHECK(verdict IN ('would-admit','would-deny')),
          reason_codes_json TEXT NOT NULL,
          facts_digest TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          recent_success_digest TEXT,
          observation_digest TEXT NOT NULL,
          has_stable_revision INTEGER NOT NULL CHECK(has_stable_revision IN (0,1)),
          new_event_count INTEGER NOT NULL CHECK(new_event_count >= 0),
          sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
          entity_signal_count INTEGER NOT NULL CHECK(entity_signal_count >= 0),
          foreground_active INTEGER NOT NULL CHECK(foreground_active IN (0,1)),
          prior_state TEXT NOT NULL CHECK(prior_state IN ('none','queued','running','succeeded','terminal')),
          same_source_succeeded INTEGER NOT NULL CHECK(same_source_succeeded IN (0,1)),
          cooldown_elapsed_ms INTEGER NOT NULL CHECK(cooldown_elapsed_ms >= 0),
          cooldown_required_ms INTEGER NOT NULL CHECK(cooldown_required_ms >= 0),
          session_budget_remaining INTEGER NOT NULL CHECK(session_budget_remaining >= 0),
          daily_budget_remaining INTEGER NOT NULL CHECK(daily_budget_remaining >= 0),
          created_at TEXT NOT NULL,
          UNIQUE(parent_run_id, task_kind, source_revision, policy_version)
        );
        CREATE INDEX maintenance_admission_parent ON maintenance_admission_decision(parent_run_id, created_at);
        CREATE INDEX maintenance_admission_session ON maintenance_admission_decision(session_id, created_at);
        CREATE INDEX maintenance_admission_task ON maintenance_admission_decision(task_kind, verdict, created_at);
        ${DIRECTOR_CRITIC_TABLE_SQL}
        ${RUNTIME_LEASE_TABLE_SQL}
      `);
      ensureRouterV2Columns(db);
      db.exec(`PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION};`);
      db.exec('COMMIT;');
      return;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }
  if (appId !== 0) throw new Error('agent-admission-application-id-mismatch');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      PRAGMA application_id = ${AGENT_ADMISSION_APPLICATION_ID};
      CREATE TABLE agent_admission_decision (
        decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round >= 0),
        source_revision TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('would-admit','would-deny')),
        score INTEGER NOT NULL,
        hard_signals_json TEXT NOT NULL,
        reason_codes_json TEXT NOT NULL,
        routing_digest TEXT NOT NULL,
        facts_digest TEXT NOT NULL,
        has_stable_revision INTEGER NOT NULL CHECK(has_stable_revision IN (0,1)),
        provider_supports_tool_protocol INTEGER NOT NULL CHECK(provider_supports_tool_protocol IN (0,1)),
        provider_reports_usage INTEGER NOT NULL CHECK(provider_reports_usage IN (0,1)),
        has_explicit_verification_intent INTEGER NOT NULL CHECK(has_explicit_verification_intent IN (0,1)),
        has_variable_write_intent INTEGER NOT NULL CHECK(has_variable_write_intent IN (0,1)),
        entity_evidence TEXT NOT NULL CHECK(entity_evidence IN ('known','unknown')),
        ambiguous_entity_count INTEGER NOT NULL CHECK(ambiguous_entity_count >= 0),
        worldbook_evidence TEXT NOT NULL CHECK(worldbook_evidence IN ('known','unknown')),
        worldbook_conflict_count INTEGER NOT NULL CHECK(worldbook_conflict_count >= 0),
        referenced_old_story INTEGER NOT NULL CHECK(referenced_old_story IN (0,1)),
        high_confidence_recall_count INTEGER NOT NULL CHECK(high_confidence_recall_count >= 0),
        arc_evidence TEXT NOT NULL CHECK(arc_evidence IN ('known','unknown')),
        dormant_arc_reference_count INTEGER NOT NULL CHECK(dormant_arc_reference_count >= 0),
        platform_evidence TEXT NOT NULL CHECK(platform_evidence IN ('insufficient','sufficient')),
        evidence_novelty TEXT NOT NULL CHECK(evidence_novelty IN ('novel','duplicate')),
        prompt_budget_tokens INTEGER NOT NULL CHECK(prompt_budget_tokens >= 0),
        estimated_prompt_tokens INTEGER NOT NULL CHECK(estimated_prompt_tokens >= 0),
        final_reserve_tokens INTEGER NOT NULL CHECK(final_reserve_tokens >= 0),
        minimum_final_reserve_tokens INTEGER NOT NULL CHECK(minimum_final_reserve_tokens >= 0),
        semantic_route TEXT NOT NULL CHECK(semantic_route IN ('not-needed','eligible','ineligible')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_admission_run ON agent_admission_decision(run_id, created_at);
      CREATE INDEX agent_admission_session ON agent_admission_decision(session_id, created_at);
      CREATE INDEX agent_admission_verdict ON agent_admission_decision(verdict, created_at);
      CREATE INDEX agent_admission_facts ON agent_admission_decision(facts_digest, created_at);
      CREATE TABLE maintenance_admission_decision (
        decision_id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round >= 1),
        source_revision TEXT NOT NULL,
        task_kind TEXT NOT NULL CHECK(task_kind IN ('memory_consolidation','branch_index','rolling_summary','npc_state')),
        policy_version TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('would-admit','would-deny')),
        reason_codes_json TEXT NOT NULL,
        facts_digest TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        recent_success_digest TEXT,
        observation_digest TEXT NOT NULL,
        has_stable_revision INTEGER NOT NULL CHECK(has_stable_revision IN (0,1)),
        new_event_count INTEGER NOT NULL CHECK(new_event_count >= 0),
        sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
        entity_signal_count INTEGER NOT NULL CHECK(entity_signal_count >= 0),
        foreground_active INTEGER NOT NULL CHECK(foreground_active IN (0,1)),
        prior_state TEXT NOT NULL CHECK(prior_state IN ('none','queued','running','succeeded','terminal')),
        same_source_succeeded INTEGER NOT NULL CHECK(same_source_succeeded IN (0,1)),
        cooldown_elapsed_ms INTEGER NOT NULL CHECK(cooldown_elapsed_ms >= 0),
        cooldown_required_ms INTEGER NOT NULL CHECK(cooldown_required_ms >= 0),
        session_budget_remaining INTEGER NOT NULL CHECK(session_budget_remaining >= 0),
        daily_budget_remaining INTEGER NOT NULL CHECK(daily_budget_remaining >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(parent_run_id, task_kind, source_revision, policy_version)
      );
      CREATE INDEX maintenance_admission_parent ON maintenance_admission_decision(parent_run_id, created_at);
      CREATE INDEX maintenance_admission_session ON maintenance_admission_decision(session_id, created_at);
      CREATE INDEX maintenance_admission_task ON maintenance_admission_decision(task_kind, verdict, created_at);
      ${DIRECTOR_CRITIC_TABLE_SQL}
      ${RUNTIME_LEASE_TABLE_SQL}
      PRAGMA user_version = ${AGENT_ADMISSION_SCHEMA_VERSION};
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
    throw error;
  }
}

function token(value: unknown, label: string, max = 240): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}-invalid`);
  return Number(value);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label}-invalid`);
  return Number(value);
}

function booleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`${label}-invalid`);
  return value === 1;
}

function timestamp(value: unknown): string {
  const text = token(value, 'created-at', 40);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new Error('created-at-invalid');
  }
  return text;
}

function digest(value: unknown, label: string): string {
  const text = token(value, label, 71);
  if (!DIGEST_RE.test(text)) throw new Error(`${label}-invalid`);
  return text;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function verdict(value: unknown): PolicyVerdict {
  if (value !== 'would-admit' && value !== 'would-deny') throw new Error('verdict-invalid');
  return value;
}

function policyVersion(value: unknown): PolicyRouterVersion {
  if (value !== POLICY_ROUTER_LEGACY_VERSION && value !== POLICY_ROUTER_VERSION) {
    throw new Error('policy-version-invalid');
  }
  return value;
}

function factAvailability(value: unknown, label: string): 'known' | 'unknown' {
  if (value !== 'known' && value !== 'unknown') throw new Error(`${label}-invalid`);
  return value;
}

function semanticRoute(value: unknown): PolicyRouterDecision['semanticRoute'] {
  if (value !== 'not-needed' && value !== 'eligible' && value !== 'ineligible') {
    throw new Error('semantic-route-invalid');
  }
  return value;
}

function jsonList<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): readonly T[] {
  let parsed: unknown;
  try { parsed = JSON.parse(token(value, label, 4_096)); } catch { throw new Error(`${label}-invalid`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    throw new Error(`${label}-invalid`);
  }
  return Object.freeze(parsed as T[]);
}

function digestJsonList(value: unknown, label: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(token(value, label, 8_192)); } catch { throw new Error(`${label}-invalid`); }
  if (!Array.isArray(parsed) || parsed.length > 64
    || parsed.some((item) => typeof item !== 'string' || !DIGEST_RE.test(item))) {
    throw new Error(`${label}-invalid`);
  }
  const normalized = [...new Set(parsed as string[])].sort();
  if (normalized.length !== parsed.length) throw new Error(`${label}-invalid`);
  return Object.freeze(normalized);
}

function decisionIdentity(audit: PolicyRouterAudit): string {
  return `decision:sha256:${createHash('sha256').update([
    audit.runId,
    audit.sessionId,
    String(audit.round),
    audit.sourceRevision,
    audit.decision.factsDigest,
  ].join('\0'), 'utf8').digest('hex')}`;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function validateAudit(audit: PolicyRouterAudit): {
  runId: string;
  sessionId: string;
  round: number;
  sourceRevision: string;
  facts: AdmissionFacts;
  decision: PolicyRouterDecision;
  createdAt: string;
} {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) throw new Error('audit-invalid');
  const facts = normalizeAdmissionFacts(audit.facts);
  const actual = audit.decision;
  const version = policyVersion(actual?.policyVersion);
  const expected = evaluatePolicyRouter(facts, version);
  if (!actual || actual.policyVersion !== expected.policyVersion
    || actual.verdict !== expected.verdict || actual.score !== expected.score
    || actual.factsDigest !== expected.factsDigest || actual.semanticRoute !== expected.semanticRoute
    || !sameList(actual.hardSignals, expected.hardSignals)
    || !sameList(actual.reasonCodes, expected.reasonCodes)) {
    throw new Error('decision-mismatch');
  }
  return {
    runId: token(audit.runId, 'run-id'),
    sessionId: token(audit.sessionId, 'session-id'),
    round: nonNegative(audit.round, 'round'),
    sourceRevision: token(audit.sourceRevision, 'source-revision'),
    facts,
    decision: expected,
    createdAt: timestamp(audit.createdAt),
  };
}

const HARD_SIGNALS = new Set(['explicit-verification', 'variable-write-intent', 'entity-ambiguous', 'worldbook-conflict']);
const REASON_CODES = new Set<string>(POLICY_REASON_CODES);
const MAINTENANCE_REASON_CODES = new Set<string>(MAINTENANCE_ADMISSION_REASON_CODES);
const MAINTENANCE_TASK_SET = new Set<string>(MAINTENANCE_ADMISSION_TASKS);
const DIRECTOR_CRITIC_REASONS = new Set<string>(DIRECTOR_CRITIC_REASON_CODES);
const RUNTIME_LEASE_OUTCOMES = new Set<string>([
  'completed', 'budget_exhausted', 'usage_unavailable', 'provider_error', 'cancelled', 'expired',
]);
const RUNTIME_LEASE_REASON_CODES = new Set<string>([
  'gateway-model-required', 'gateway-tools-invalid', 'gateway-budget-lane-mismatch',
  'gateway-output-budget-invalid', 'gateway-cost-estimator-unavailable',
  'gateway-model-binding-mismatch', 'gateway-toolset-binding-mismatch',
  'gateway-concurrent-call', 'gateway-lease-closed', 'gateway-model-call-budget-exhausted',
  'gateway-input-budget-exhausted', 'gateway-output-budget-exhausted',
  'gateway-cost-budget-exhausted', 'gateway-wall-budget-exhausted',
  'gateway-provider-usage-unavailable', 'gateway-provider-usage-invalid',
  'gateway-provider-call-failed', 'gateway-provider-call-cancelled',
  'gateway-lease-audit-failed',
]);
const PROVIDER_DIAGNOSTIC_CODES = new Set<string>([
  'provider-not-configured', 'provider-authentication-failed', 'provider-request-invalid',
  'provider-rate-limited', 'provider-timeout', 'provider-upstream-unavailable',
  'provider-transport-failed', 'provider-stream-failed', 'provider-stream-incomplete',
  'provider-disposed', 'provider-failed',
]);
const AGENT_LANES = new Set<string>(['interactive', 'maintenance', 'learning', 'critic']);
const AGENT_TASK_KIND_SET = new Set<string>(AGENT_TASK_KINDS);

function runtimeLeaseLane(value: unknown): AgentLane {
  if (typeof value !== 'string' || !AGENT_LANES.has(value)) throw new Error('runtime-lease-lane-invalid');
  return value as AgentLane;
}

function runtimeLeaseTaskKind(value: unknown): AgentTaskKind {
  if (typeof value !== 'string' || !AGENT_TASK_KIND_SET.has(value)) throw new Error('runtime-lease-task-kind-invalid');
  return value as AgentTaskKind;
}

function parseRow(row: Row): AgentAdmissionRow {
  const hardSignals = jsonList<PolicyHardSignal>(row.hard_signals_json, HARD_SIGNALS, 'hard-signals-json');
  const reasonCodes = jsonList<PolicyReasonCode>(row.reason_codes_json, REASON_CODES, 'reason-codes-json');
  const facts = normalizeAdmissionFacts({
    routingDigest: digest(row.routing_digest, 'routing-digest'),
    hasStableRevision: booleanInteger(row.has_stable_revision, 'has-stable-revision'),
    providerSupportsToolProtocol: booleanInteger(row.provider_supports_tool_protocol, 'provider-tools'),
    providerReportsUsage: booleanInteger(row.provider_reports_usage, 'provider-usage'),
    hasExplicitVerificationIntent: booleanInteger(row.has_explicit_verification_intent, 'explicit-verification'),
    hasVariableWriteIntent: booleanInteger(row.has_variable_write_intent, 'variable-write'),
    entityEvidence: factAvailability(row.entity_evidence, 'entity-evidence'),
    ambiguousEntityCount: nonNegative(row.ambiguous_entity_count, 'ambiguous-entity-count'),
    worldbookEvidence: factAvailability(row.worldbook_evidence, 'worldbook-evidence'),
    worldbookConflictCount: nonNegative(row.worldbook_conflict_count, 'worldbook-conflict-count'),
    referencedOldStory: booleanInteger(row.referenced_old_story, 'referenced-old-story'),
    highConfidenceRecallCount: nonNegative(row.high_confidence_recall_count, 'high-confidence-recall-count'),
    arcEvidence: factAvailability(row.arc_evidence, 'arc-evidence'),
    dormantArcReferenceCount: nonNegative(row.dormant_arc_reference_count, 'dormant-arc-reference-count'),
    platformEvidence: row.platform_evidence === 'sufficient' ? 'sufficient' : row.platform_evidence === 'insufficient' ? 'insufficient' : (() => { throw new Error('platform-evidence-invalid'); })(),
    evidenceNovelty: row.evidence_novelty === 'duplicate' ? 'duplicate' : row.evidence_novelty === 'novel' ? 'novel' : (() => { throw new Error('evidence-novelty-invalid'); })(),
    promptBudgetTokens: nonNegative(row.prompt_budget_tokens, 'prompt-budget-tokens'),
    estimatedPromptTokens: nonNegative(row.estimated_prompt_tokens, 'estimated-prompt-tokens'),
    finalReserveTokens: nonNegative(row.final_reserve_tokens, 'final-reserve-tokens'),
    minimumFinalReserveTokens: nonNegative(row.minimum_final_reserve_tokens, 'minimum-final-reserve-tokens'),
  });
  const decision: PolicyRouterDecision = Object.freeze({
    policyVersion: policyVersion(row.policy_version),
    verdict: verdict(row.verdict),
    score: integer(row.score, 'score'),
    hardSignals,
    reasonCodes,
    factsDigest: digest(row.facts_digest, 'facts-digest'),
    semanticRoute: semanticRoute(row.semantic_route),
  });
  const expected = evaluatePolicyRouter(facts, decision.policyVersion);
  if (decision.policyVersion !== expected.policyVersion || decision.verdict !== expected.verdict
    || decision.score !== expected.score || decision.factsDigest !== expected.factsDigest
    || !sameList(decision.hardSignals, expected.hardSignals)
    || decision.semanticRoute !== expected.semanticRoute
    || !sameList(decision.reasonCodes, expected.reasonCodes)) throw new Error('stored-decision-mismatch');
  return Object.freeze({
    decisionId: token(row.decision_id, 'decision-id'),
    runId: token(row.run_id, 'run-id'),
    sessionId: token(row.session_id, 'session-id'),
    round: nonNegative(row.round, 'round'),
    sourceRevision: token(row.source_revision, 'source-revision'),
    facts,
    decision,
    createdAt: timestamp(row.created_at),
  });
}

function listRows(db: DatabaseSync, filters: AgentAdmissionFilters): AgentAdmissionRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.runId !== undefined) { where.push('run_id=?'); params.push(token(filters.runId, 'run-id')); }
  if (filters.sessionId !== undefined) { where.push('session_id=?'); params.push(token(filters.sessionId, 'session-id')); }
  if (filters.verdict !== undefined) { where.push('verdict=?'); params.push(verdict(filters.verdict)); }
  const limit = filters.limit === undefined ? 1_000 : nonNegative(filters.limit, 'limit');
  if (limit < 1 || limit > 10_000) throw new Error('limit-invalid');
  params.push(limit);
  return (db.prepare(
    `SELECT * FROM agent_admission_decision${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,decision_id LIMIT ?`,
  ).all(...params) as Row[]).map(parseRow);
}

function maintenanceVerdict(value: unknown): MaintenanceAdmissionVerdict {
  if (value !== 'would-admit' && value !== 'would-deny') throw new Error('maintenance-verdict-invalid');
  return value;
}

function maintenanceTask(value: unknown): MaintenanceAdmissionTask {
  if (typeof value !== 'string' || !MAINTENANCE_TASK_SET.has(value)) throw new Error('maintenance-task-invalid');
  return value as MaintenanceAdmissionTask;
}

function maintenanceDecisionIdentity(audit: MaintenanceAdmissionAudit): string {
  return `maintenance:sha256:${createHash('sha256').update([
    audit.parentRunId, audit.sessionId, String(audit.round), audit.sourceRevision,
    audit.facts.taskKind, audit.decision.factsDigest,
  ].join('\0'), 'utf8').digest('hex')}`;
}

function validateMaintenanceBatch(input: readonly MaintenanceAdmissionAudit[]): readonly MaintenanceAdmissionAudit[] {
  if (!Array.isArray(input) || input.length !== MAINTENANCE_ADMISSION_TASKS.length) {
    throw new Error('maintenance-audit-batch-invalid');
  }
  const normalized = input.map((audit) => {
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) throw new Error('maintenance-audit-invalid');
    return Object.freeze({
      parentRunId: token(audit.parentRunId, 'parent-run-id'),
      sessionId: token(audit.sessionId, 'session-id'),
      round: nonNegative(audit.round, 'round'),
      sourceRevision: token(audit.sourceRevision, 'source-revision'),
      facts: normalizeMaintenanceAdmissionFacts(audit.facts),
      decision: audit.decision,
      createdAt: timestamp(audit.createdAt),
    });
  });
  if (normalized.some((audit) => audit.round < 1)) throw new Error('maintenance-round-invalid');
  const first = normalized[0]!;
  if (normalized.some((audit) => audit.parentRunId !== first.parentRunId
    || audit.sessionId !== first.sessionId || audit.round !== first.round
    || audit.sourceRevision !== first.sourceRevision || audit.createdAt !== first.createdAt)) {
    throw new Error('maintenance-audit-envelope-mismatch');
  }
  const policyVersions = [...new Set(normalized.map((audit) => audit.decision?.policyVersion))];
  if (policyVersions.length !== 1
    || !MAINTENANCE_ADMISSION_POLICY_VERSIONS.includes(policyVersions[0] as never)) {
    throw new Error('maintenance-policy-version-mismatch');
  }
  const expected = evaluateMaintenanceAdmissionBatch(
    first.round,
    normalized.map((audit) => audit.facts),
    policyVersions[0] as (typeof MAINTENANCE_ADMISSION_POLICY_VERSIONS)[number],
  );
  const expectedByTask = new Map(expected.map((decision) => [decision.taskKind, decision]));
  for (const audit of normalized) {
    const actual = audit.decision;
    const wanted = expectedByTask.get(audit.facts.taskKind);
    if (!wanted || !actual || actual.policyVersion !== wanted.policyVersion
      || actual.taskKind !== wanted.taskKind || actual.verdict !== wanted.verdict
      || actual.factsDigest !== wanted.factsDigest
      || !sameList(actual.reasonCodes, wanted.reasonCodes)) {
      throw new Error('maintenance-decision-mismatch');
    }
  }
  return Object.freeze(normalized);
}

function parseMaintenanceRow(row: Row): MaintenanceAdmissionRow {
  const facts = normalizeMaintenanceAdmissionFacts({
    taskKind: maintenanceTask(row.task_kind),
    sourceDigest: digest(row.source_digest, 'source-digest'),
    recentSuccessDigest: nullableDigest(row.recent_success_digest, 'recent-success-digest'),
    observationDigest: digest(row.observation_digest, 'observation-digest'),
    hasStableRevision: booleanInteger(row.has_stable_revision, 'has-stable-revision'),
    newEventCount: nonNegative(row.new_event_count, 'new-event-count'),
    sampleCount: nonNegative(row.sample_count, 'sample-count'),
    entitySignalCount: nonNegative(row.entity_signal_count, 'entity-signal-count'),
    foregroundActive: booleanInteger(row.foreground_active, 'foreground-active'),
    priorState: row.prior_state as MaintenanceAdmissionFacts['priorState'],
    sameSourceSucceeded: booleanInteger(row.same_source_succeeded, 'same-source-succeeded'),
    cooldownElapsedMs: nonNegative(row.cooldown_elapsed_ms, 'cooldown-elapsed-ms'),
    cooldownRequiredMs: nonNegative(row.cooldown_required_ms, 'cooldown-required-ms'),
    sessionBudgetRemaining: nonNegative(row.session_budget_remaining, 'session-budget-remaining'),
    dailyBudgetRemaining: nonNegative(row.daily_budget_remaining, 'daily-budget-remaining'),
  });
  const decision: MaintenanceAdmissionDecision = Object.freeze({
    policyVersion: token(row.policy_version, 'policy-version') as MaintenanceAdmissionDecision['policyVersion'],
    taskKind: facts.taskKind,
    verdict: maintenanceVerdict(row.verdict),
    reasonCodes: jsonList<MaintenanceAdmissionReasonCode>(row.reason_codes_json, MAINTENANCE_REASON_CODES, 'maintenance-reason-codes-json'),
    factsDigest: digest(row.facts_digest, 'facts-digest'),
  });
  return Object.freeze({
    decisionId: token(row.decision_id, 'decision-id'),
    parentRunId: token(row.parent_run_id, 'parent-run-id'),
    sessionId: token(row.session_id, 'session-id'),
    round: nonNegative(row.round, 'round'),
    sourceRevision: token(row.source_revision, 'source-revision'),
    facts,
    decision,
    createdAt: timestamp(row.created_at),
  });
}

function listMaintenanceRows(db: DatabaseSync, filters: MaintenanceAdmissionFilters): MaintenanceAdmissionRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.parentRunId !== undefined) { where.push('parent_run_id=?'); params.push(token(filters.parentRunId, 'parent-run-id')); }
  if (filters.sessionId !== undefined) { where.push('session_id=?'); params.push(token(filters.sessionId, 'session-id')); }
  const rows = (db.prepare(
    `SELECT * FROM maintenance_admission_decision${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,decision_id`,
  ).all(...params) as Row[]).map(parseMaintenanceRow);
  const groups = new Map<string, MaintenanceAdmissionRow[]>();
  for (const row of rows) {
    const key = `${row.parentRunId}\0${row.sessionId}\0${row.round}\0${row.sourceRevision}\0${row.createdAt}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    validateMaintenanceBatch(group.map((row) => ({
      parentRunId: row.parentRunId, sessionId: row.sessionId, round: row.round,
      sourceRevision: row.sourceRevision, facts: row.facts, decision: row.decision, createdAt: row.createdAt,
    })));
  }
  let filtered = rows;
  if (filters.taskKind !== undefined) filtered = filtered.filter((row) => row.facts.taskKind === maintenanceTask(filters.taskKind));
  if (filters.verdict !== undefined) filtered = filtered.filter((row) => row.decision.verdict === maintenanceVerdict(filters.verdict));
  const limit = filters.limit === undefined ? 1_000 : nonNegative(filters.limit, 'limit');
  if (limit < 1 || limit > 10_000) throw new Error('limit-invalid');
  return filtered.slice(0, limit);
}

function directorVerdict(value: unknown): DirectorVerdict {
  if (value !== 'would-direct' && value !== 'skip-direct') throw new Error('director-verdict-invalid');
  return value;
}

function criticVerdict(value: unknown): CriticVerdict {
  if (value !== 'would-critic' && value !== 'skip-critic') throw new Error('critic-verdict-invalid');
  return value;
}

function directorCriticIdentity(audit: DirectorCriticAudit): string {
  return `director-critic:sha256:${createHash('sha256').update([
    audit.runId, audit.sessionId, String(audit.round), audit.sourceRevision, audit.decision.factsDigest,
  ].join('\0'), 'utf8').digest('hex')}`;
}

function validateDirectorCriticAudit(input: DirectorCriticAudit): DirectorCriticAudit {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('director-critic-audit-invalid');
  const facts = normalizeDirectorCriticFacts(input.facts);
  const expected = evaluateDirectorCriticShadow(facts);
  const actual = input.decision;
  if (!actual || actual.policyVersion !== expected.policyVersion
    || actual.directorVerdict !== expected.directorVerdict || actual.criticVerdict !== expected.criticVerdict
    || actual.directorScore !== expected.directorScore || actual.criticScore !== expected.criticScore
    || actual.factsDigest !== expected.factsDigest || !sameList(actual.reasonCodes, expected.reasonCodes)) {
    throw new Error('director-critic-decision-mismatch');
  }
  return Object.freeze({
    runId: token(input.runId, 'run-id'), sessionId: token(input.sessionId, 'session-id'),
    round: nonNegative(input.round, 'round'), sourceRevision: token(input.sourceRevision, 'source-revision'),
    facts, decision: expected, createdAt: timestamp(input.createdAt),
  });
}

function parseDirectorCriticRow(row: Row): DirectorCriticAdmissionRow {
  const facts = normalizeDirectorCriticFacts({
    routingDigest: digest(row.routing_digest, 'routing-digest'),
    hasStableRevision: booleanInteger(row.has_stable_revision, 'has-stable-revision'),
    keyEventCount: nonNegative(row.key_event_count, 'key-event-count'),
    parallelEventCount: nonNegative(row.parallel_event_count, 'parallel-event-count'),
    activeArcCount: nonNegative(row.active_arc_count, 'active-arc-count'),
    unresolvedDependencyCount: nonNegative(row.unresolved_dependency_count, 'unresolved-dependency-count'),
    evidenceGapCount: nonNegative(row.evidence_gap_count, 'evidence-gap-count'),
    factReferenceRiskCount: nonNegative(row.fact_reference_risk_count, 'fact-reference-risk-count'),
    playerSovereigntyRiskCount: nonNegative(row.player_sovereignty_risk_count, 'player-sovereignty-risk-count'),
    duplicateOutput: booleanInteger(row.duplicate_output, 'duplicate-output'),
    npcKnowledgeRiskCount: nonNegative(row.npc_knowledge_risk_count, 'npc-knowledge-risk-count'),
    contractIssueCount: nonNegative(row.contract_issue_count, 'contract-issue-count'),
    modelAttempts: nonNegative(row.model_attempts, 'model-attempts'),
  });
  const decision: DirectorCriticDecision = Object.freeze({
    policyVersion: token(row.policy_version, 'policy-version') as DirectorCriticDecision['policyVersion'],
    directorVerdict: directorVerdict(row.director_verdict), criticVerdict: criticVerdict(row.critic_verdict),
    directorScore: nonNegative(row.director_score, 'director-score'),
    criticScore: nonNegative(row.critic_score, 'critic-score'),
    reasonCodes: jsonList<DirectorCriticReasonCode>(row.reason_codes_json, DIRECTOR_CRITIC_REASONS, 'director-critic-reasons-json'),
    factsDigest: digest(row.facts_digest, 'facts-digest'),
  });
  const expected = evaluateDirectorCriticShadow(facts);
  if (decision.policyVersion !== expected.policyVersion || decision.directorVerdict !== expected.directorVerdict
    || decision.criticVerdict !== expected.criticVerdict || decision.directorScore !== expected.directorScore
    || decision.criticScore !== expected.criticScore || decision.factsDigest !== expected.factsDigest
    || !sameList(decision.reasonCodes, expected.reasonCodes)) throw new Error('stored-director-critic-decision-mismatch');
  return Object.freeze({
    decisionId: token(row.decision_id, 'decision-id'), runId: token(row.run_id, 'run-id'),
    sessionId: token(row.session_id, 'session-id'), round: nonNegative(row.round, 'round'),
    sourceRevision: token(row.source_revision, 'source-revision'), facts, decision,
    createdAt: timestamp(row.created_at),
  });
}

function listDirectorCriticRows(db: DatabaseSync, filters: DirectorCriticAdmissionFilters): DirectorCriticAdmissionRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.runId !== undefined) { where.push('run_id=?'); params.push(token(filters.runId, 'run-id')); }
  if (filters.sessionId !== undefined) { where.push('session_id=?'); params.push(token(filters.sessionId, 'session-id')); }
  if (filters.directorVerdict !== undefined) { where.push('director_verdict=?'); params.push(directorVerdict(filters.directorVerdict)); }
  if (filters.criticVerdict !== undefined) { where.push('critic_verdict=?'); params.push(criticVerdict(filters.criticVerdict)); }
  const limit = filters.limit === undefined ? 1_000 : nonNegative(filters.limit, 'limit');
  if (limit < 1 || limit > 10_000) throw new Error('limit-invalid');
  params.push(limit);
  return (db.prepare(
    `SELECT * FROM director_critic_shadow_decision${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,decision_id LIMIT ?`,
  ).all(...params) as Row[]).map(parseDirectorCriticRow);
}

function runtimeLeaseOutcome(value: unknown): AdmittedModelLeaseOutcome {
  if (typeof value !== 'string' || !RUNTIME_LEASE_OUTCOMES.has(value)) {
    throw new Error('runtime-lease-outcome-invalid');
  }
  return value as AdmittedModelLeaseOutcome;
}

function runtimeLeaseReason(value: unknown): AdmittedModelGatewayErrorCode | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !RUNTIME_LEASE_REASON_CODES.has(value)) {
    throw new Error('runtime-lease-reason-invalid');
  }
  return value as AdmittedModelGatewayErrorCode;
}

function providerDiagnosticCode(value: unknown): ProviderFailureDiagnosticCode | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !PROVIDER_DIAGNOSTIC_CODES.has(value)) {
    throw new Error('runtime-lease-provider-diagnostic-invalid');
  }
  return value as ProviderFailureDiagnosticCode;
}

function validateRuntimeLeaseAccounting(input: {
  modelCallsUsed: number;
  authorizationCallsUsed: number;
  providerErrorAttemptsUsed: number;
  providerDiagnosticCode?: ProviderFailureDiagnosticCode;
  inputTokensUsed: number;
  outputTokensUsed: number;
  costMicrousdUsed: number;
}): void {
  if (input.authorizationCallsUsed + input.providerErrorAttemptsUsed > input.modelCallsUsed) {
    throw new Error('runtime-lease-authorization-calls-invalid');
  }
  const zeroUsage = input.inputTokensUsed === 0
    && input.outputTokensUsed === 0
    && input.costMicrousdUsed === 0;
  if (input.providerDiagnosticCode === 'provider-transport-failed'
    && zeroUsage
    && (input.authorizationCallsUsed !== 0 || input.providerErrorAttemptsUsed < 1)) {
    throw new Error('runtime-lease-transport-authorization-invalid');
  }
}

function validateRuntimeLeaseAudit(input: AdmittedModelLeaseAudit): AgentRuntimeLeaseRow {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.status !== 'closed') {
    throw new Error('runtime-lease-audit-invalid');
  }
  const startedAt = timestamp(input.startedAt);
  const finishedAt = timestamp(input.finishedAt);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error('runtime-lease-time-invalid');
  const modelCallsUsed = nonNegative(input.modelCallsUsed, 'model-calls-used');
  const authorizationCallsUsed = nonNegative(input.authorizationCallsUsed, 'authorization-calls-used');
  const providerErrorAttemptsUsed = nonNegative(
    input.providerErrorAttemptsUsed, 'provider-error-attempts-used',
  );
  const diagnostic = providerDiagnosticCode(input.providerDiagnosticCode);
  const inputTokensUsed = nonNegative(input.inputTokensUsed, 'input-tokens-used');
  const outputTokensUsed = nonNegative(input.outputTokensUsed, 'output-tokens-used');
  const costMicrousdUsed = nonNegative(input.costMicrousdUsed, 'cost-microusd-used');
  validateRuntimeLeaseAccounting({
    modelCallsUsed,
    authorizationCallsUsed,
    providerErrorAttemptsUsed,
    ...(diagnostic ? { providerDiagnosticCode: diagnostic } : {}),
    inputTokensUsed,
    outputTokensUsed,
    costMicrousdUsed,
  });
  return Object.freeze({
    leaseIdDigest: digest(input.leaseIdDigest, 'lease-id-digest'),
    runId: token(input.runId, 'run-id'),
    parentRunId: token(input.parentRunId, 'parent-run-id'),
    sessionId: token(input.sessionId, 'session-id'),
    sourceRevision: token(input.sourceRevision, 'source-revision'),
    lane: runtimeLeaseLane(input.lane),
    taskKind: runtimeLeaseTaskKind(input.taskKind),
    policyVersion: token(input.policyVersion, 'policy-version'),
    evidenceDigests: digestJsonList(JSON.stringify(input.evidenceDigests), 'evidence-digests-json'),
    budgetProfileDigest: digest(input.budgetProfileDigest, 'budget-profile-digest'),
    toolSetDigest: digest(input.toolSetDigest, 'tool-set-digest'),
    outcome: runtimeLeaseOutcome(input.outcome),
    ...(input.reasonCode === undefined ? {} : { reasonCode: runtimeLeaseReason(input.reasonCode) }),
    modelCallsUsed,
    authorizationCallsUsed,
    providerErrorAttemptsUsed,
    ...(diagnostic ? { providerDiagnosticCode: diagnostic } : {}),
    inputTokensUsed,
    outputTokensUsed,
    costMicrousdUsed,
    wallMsUsed: nonNegative(input.wallMsUsed, 'wall-ms-used'),
    startedAt,
    finishedAt,
  });
}

function parseRuntimeLeaseRow(row: Row): AgentRuntimeLeaseRow {
  const modelCallsUsed = nonNegative(row.model_calls_used, 'model-calls-used');
  const authorizationCallsUsed = nonNegative(row.authorization_calls_used, 'authorization-calls-used');
  const providerErrorAttemptsUsed = nonNegative(
    row.provider_error_attempts_used, 'provider-error-attempts-used',
  );
  const diagnostic = providerDiagnosticCode(row.provider_diagnostic_code);
  const inputTokensUsed = nonNegative(row.input_tokens_used, 'input-tokens-used');
  const outputTokensUsed = nonNegative(row.output_tokens_used, 'output-tokens-used');
  const costMicrousdUsed = nonNegative(row.cost_microusd_used, 'cost-microusd-used');
  validateRuntimeLeaseAccounting({
    modelCallsUsed,
    authorizationCallsUsed,
    providerErrorAttemptsUsed,
    ...(diagnostic ? { providerDiagnosticCode: diagnostic } : {}),
    inputTokensUsed,
    outputTokensUsed,
    costMicrousdUsed,
  });
  return Object.freeze({
    leaseIdDigest: digest(row.lease_id_digest, 'lease-id-digest'),
    runId: token(row.run_id, 'run-id'),
    parentRunId: token(row.parent_run_id, 'parent-run-id'),
    sessionId: token(row.session_id, 'session-id'),
    sourceRevision: token(row.source_revision, 'source-revision'),
    lane: runtimeLeaseLane(row.lane),
    taskKind: runtimeLeaseTaskKind(row.task_kind),
    policyVersion: token(row.policy_version, 'policy-version'),
    evidenceDigests: digestJsonList(row.evidence_digests_json, 'evidence-digests-json'),
    budgetProfileDigest: digest(row.budget_profile_digest, 'budget-profile-digest'),
    toolSetDigest: digest(row.tool_set_digest, 'tool-set-digest'),
    outcome: runtimeLeaseOutcome(row.outcome),
    ...(row.reason_code === null ? {} : { reasonCode: runtimeLeaseReason(row.reason_code) }),
    modelCallsUsed,
    authorizationCallsUsed,
    providerErrorAttemptsUsed,
    ...(diagnostic ? { providerDiagnosticCode: diagnostic } : {}),
    inputTokensUsed,
    outputTokensUsed,
    costMicrousdUsed,
    wallMsUsed: nonNegative(row.wall_ms_used, 'wall-ms-used'),
    startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at),
  });
}

function listRuntimeLeaseRows(
  db: DatabaseSync,
  filters: AgentRuntimeLeaseFilters,
  schemaVersion = AGENT_ADMISSION_SCHEMA_VERSION,
): AgentRuntimeLeaseRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.runId !== undefined) { where.push('run_id=?'); params.push(token(filters.runId, 'run-id')); }
  if (filters.sessionId !== undefined) { where.push('session_id=?'); params.push(token(filters.sessionId, 'session-id')); }
  if (filters.outcome !== undefined) { where.push('outcome=?'); params.push(runtimeLeaseOutcome(filters.outcome)); }
  const limit = filters.limit === undefined ? 1_000 : nonNegative(filters.limit, 'limit');
  if (limit < 1 || limit > 10_000) throw new Error('limit-invalid');
  params.push(limit);
  const projection = schemaVersion === 5 ? `
    lease_id_digest,run_id,parent_run_id,session_id,source_revision,
    'interactive' AS lane,'interactive_prelude' AS task_kind,
    'legacy-runtime-v1' AS policy_version,'[]' AS evidence_digests_json,
    budget_profile_digest,tool_set_digest,outcome,reason_code,model_calls_used,
    model_calls_used AS authorization_calls_used,0 AS provider_error_attempts_used,
    NULL AS provider_diagnostic_code,
    input_tokens_used,output_tokens_used,cost_microusd_used,wall_ms_used,started_at,finished_at
  ` : schemaVersion === 6
    ? '*,model_calls_used AS authorization_calls_used,0 AS provider_error_attempts_used,NULL AS provider_diagnostic_code'
    : '*';
  return (db.prepare(
    `SELECT ${projection} FROM agent_runtime_lease_outcome${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY finished_at,lease_id_digest LIMIT ?`,
  ).all(...params) as Row[]).map(parseRuntimeLeaseRow);
}

/**
 * Strict read-only report entrypoint: never creates, migrates, checkpoints, or changes WAL mode.
 * The immediately preceding v5 is projected with the exact defaults used by the v5→v6 migration,
 * so an operator can inspect a stopped/older runtime before restart. Older/future schemas still fail closed.
 */
export function readAgentAdmissionFile(file: string): AgentAdmissionFileRows {
  const path = resolve(file);
  if (!existsSync(path)) return Object.freeze({
    interactive: Object.freeze([]), maintenance: Object.freeze([]), directorCritic: Object.freeze([]),
    runtimeLeases: Object.freeze([]),
  });
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agent-admission-file-invalid');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const applicationId = pragma(db, 'application_id');
    const schemaVersion = pragma(db, 'user_version');
    if (applicationId !== AGENT_ADMISSION_APPLICATION_ID
      || ![AGENT_ADMISSION_SCHEMA_VERSION, 6, 5].includes(schemaVersion)) {
      throw new Error('agent-admission-metadata-mismatch');
    }
    return Object.freeze({
      interactive: Object.freeze(listRows(db, { limit: 10_000 })),
      maintenance: Object.freeze(listMaintenanceRows(db, { limit: 10_000 })),
      directorCritic: Object.freeze(listDirectorCriticRows(db, { limit: 10_000 })),
      runtimeLeases: Object.freeze(listRuntimeLeaseRows(db, { limit: 10_000 }, schemaVersion)),
    });
  } finally {
    db.close();
  }
}

export class AgentAdmissionLedger {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: { dataDir: string; busyTimeoutMs?: number }) {
    const dataDir = resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('agent-admission-data-dir-invalid');
    const path = join(dataDir, AGENT_ADMISSION_DB_FILE);
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('agent-admission-file-invalid');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5_000};`);
      initialize(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      try { chmodSync(path, 0o600); } catch { /* Windows ACL handled by the parent directory. */ }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  record(input: PolicyRouterAudit): AgentAdmissionRow {
    this.#assertOpen();
    const audit = validateAudit(input);
    const decisionId = decisionIdentity(audit);
    const facts = audit.facts;
    const decision = audit.decision;
    this.#db.prepare(`
      INSERT INTO agent_admission_decision(
        decision_id,run_id,session_id,round,source_revision,policy_version,verdict,score,
        hard_signals_json,reason_codes_json,routing_digest,facts_digest,has_stable_revision,
        provider_supports_tool_protocol,provider_reports_usage,has_explicit_verification_intent,
        has_variable_write_intent,entity_evidence,ambiguous_entity_count,worldbook_evidence,worldbook_conflict_count,
        referenced_old_story,high_confidence_recall_count,dormant_arc_reference_count,
        platform_evidence,evidence_novelty,prompt_budget_tokens,estimated_prompt_tokens,
        final_reserve_tokens,minimum_final_reserve_tokens,arc_evidence,semantic_route,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      decisionId, audit.runId, audit.sessionId, audit.round, audit.sourceRevision,
      decision.policyVersion, decision.verdict, decision.score,
      JSON.stringify(decision.hardSignals), JSON.stringify(decision.reasonCodes),
      facts.routingDigest, decision.factsDigest, Number(facts.hasStableRevision),
      Number(facts.providerSupportsToolProtocol), Number(facts.providerReportsUsage),
      Number(facts.hasExplicitVerificationIntent), Number(facts.hasVariableWriteIntent),
      facts.entityEvidence, facts.ambiguousEntityCount, facts.worldbookEvidence,
      facts.worldbookConflictCount, Number(facts.referencedOldStory),
      facts.highConfidenceRecallCount, facts.dormantArcReferenceCount, facts.platformEvidence,
      facts.evidenceNovelty, facts.promptBudgetTokens, facts.estimatedPromptTokens,
      facts.finalReserveTokens, facts.minimumFinalReserveTokens, facts.arcEvidence,
      decision.semanticRoute, audit.createdAt,
    );
    return Object.freeze({ decisionId, ...audit });
  }

  recordMaintenanceBatch(input: readonly MaintenanceAdmissionAudit[]): readonly MaintenanceAdmissionRow[] {
    this.#assertOpen();
    const audits = validateMaintenanceBatch(input);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const rows = audits.map((audit) => {
        const decisionId = maintenanceDecisionIdentity(audit);
        const facts = audit.facts;
        const decision = audit.decision;
        this.#db.prepare(`
          INSERT INTO maintenance_admission_decision(
            decision_id,parent_run_id,session_id,round,source_revision,task_kind,policy_version,
            verdict,reason_codes_json,facts_digest,source_digest,recent_success_digest,observation_digest,
            has_stable_revision,new_event_count,sample_count,entity_signal_count,foreground_active,
            prior_state,same_source_succeeded,cooldown_elapsed_ms,cooldown_required_ms,
            session_budget_remaining,daily_budget_remaining,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          decisionId, audit.parentRunId, audit.sessionId, audit.round, audit.sourceRevision,
          facts.taskKind, decision.policyVersion, decision.verdict, JSON.stringify(decision.reasonCodes),
          decision.factsDigest, facts.sourceDigest, facts.recentSuccessDigest, facts.observationDigest,
          Number(facts.hasStableRevision), facts.newEventCount, facts.sampleCount,
          facts.entitySignalCount, Number(facts.foregroundActive), facts.priorState,
          Number(facts.sameSourceSucceeded), facts.cooldownElapsedMs, facts.cooldownRequiredMs,
          facts.sessionBudgetRemaining, facts.dailyBudgetRemaining, audit.createdAt,
        );
        return Object.freeze({ decisionId, ...audit });
      });
      this.#db.exec('COMMIT;');
      return Object.freeze(rows);
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  recordDirectorCritic(input: DirectorCriticAudit): DirectorCriticAdmissionRow {
    this.#assertOpen();
    const audit = validateDirectorCriticAudit(input);
    const decisionId = directorCriticIdentity(audit);
    const { facts, decision } = audit;
    this.#db.prepare(`INSERT INTO director_critic_shadow_decision(
      decision_id,run_id,session_id,round,source_revision,policy_version,director_verdict,critic_verdict,
      director_score,critic_score,reason_codes_json,facts_digest,routing_digest,has_stable_revision,
      key_event_count,parallel_event_count,active_arc_count,unresolved_dependency_count,evidence_gap_count,
      fact_reference_risk_count,player_sovereignty_risk_count,duplicate_output,npc_knowledge_risk_count,
      contract_issue_count,model_attempts,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      decisionId, audit.runId, audit.sessionId, audit.round, audit.sourceRevision, decision.policyVersion,
      decision.directorVerdict, decision.criticVerdict, decision.directorScore, decision.criticScore,
      JSON.stringify(decision.reasonCodes), decision.factsDigest, facts.routingDigest, Number(facts.hasStableRevision),
      facts.keyEventCount, facts.parallelEventCount, facts.activeArcCount, facts.unresolvedDependencyCount,
      facts.evidenceGapCount, facts.factReferenceRiskCount, facts.playerSovereigntyRiskCount,
      Number(facts.duplicateOutput), facts.npcKnowledgeRiskCount, facts.contractIssueCount,
      facts.modelAttempts, audit.createdAt,
    );
    return Object.freeze({ decisionId, ...audit });
  }

  recordRuntimeLease(input: AdmittedModelLeaseAudit): AgentRuntimeLeaseRow {
    this.#assertOpen();
    const row = validateRuntimeLeaseAudit(input);
    this.#db.prepare(`INSERT INTO agent_runtime_lease_outcome(
      lease_id_digest,run_id,parent_run_id,session_id,source_revision,budget_profile_digest,
      lane,task_kind,policy_version,evidence_digests_json,tool_set_digest,outcome,reason_code,
      model_calls_used,authorization_calls_used,provider_error_attempts_used,provider_diagnostic_code,
      input_tokens_used,output_tokens_used,
      cost_microusd_used,wall_ms_used,started_at,finished_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.leaseIdDigest, row.runId, row.parentRunId, row.sessionId, row.sourceRevision,
      row.budgetProfileDigest, row.lane, row.taskKind, row.policyVersion,
      JSON.stringify(row.evidenceDigests), row.toolSetDigest, row.outcome, row.reasonCode ?? null,
      row.modelCallsUsed, row.authorizationCallsUsed, row.providerErrorAttemptsUsed,
      row.providerDiagnosticCode ?? null,
      row.inputTokensUsed, row.outputTokensUsed, row.costMicrousdUsed,
      row.wallMsUsed, row.startedAt, row.finishedAt,
    );
    return row;
  }

  list(filters: AgentAdmissionFilters = {}): AgentAdmissionRow[] {
    this.#assertOpen();
    return listRows(this.#db, filters);
  }

  listMaintenance(filters: MaintenanceAdmissionFilters = {}): MaintenanceAdmissionRow[] {
    this.#assertOpen();
    return listMaintenanceRows(this.#db, filters);
  }

  listDirectorCritic(filters: DirectorCriticAdmissionFilters = {}): DirectorCriticAdmissionRow[] {
    this.#assertOpen();
    return listDirectorCriticRows(this.#db, filters);
  }

  listRuntimeLeases(filters: AgentRuntimeLeaseFilters = {}): AgentRuntimeLeaseRow[] {
    this.#assertOpen();
    return listRuntimeLeaseRows(this.#db, filters);
  }

  /** Deletes only audit rows whose persisted session identity exactly matches. */
  deleteSession(sessionIdValue: string): AgentAdmissionSessionDeleteResult {
    this.#assertOpen();
    const sessionId = token(sessionIdValue, 'session-id');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const interactiveDecisions = Number(this.#db.prepare(
        'DELETE FROM agent_admission_decision WHERE session_id=?',
      ).run(sessionId).changes);
      const maintenanceDecisions = Number(this.#db.prepare(
        'DELETE FROM maintenance_admission_decision WHERE session_id=?',
      ).run(sessionId).changes);
      const directorCriticDecisions = Number(this.#db.prepare(
        'DELETE FROM director_critic_shadow_decision WHERE session_id=?',
      ).run(sessionId).changes);
      const runtimeLeaseOutcomes = Number(this.#db.prepare(
        'DELETE FROM agent_runtime_lease_outcome WHERE session_id=?',
      ).run(sessionId).changes);
      this.#db.exec('COMMIT;');
      return Object.freeze({
        interactiveDecisions,
        maintenanceDecisions,
        directorCriticDecisions,
        runtimeLeaseOutcomes,
      });
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('agent-admission-closed');
  }
}
