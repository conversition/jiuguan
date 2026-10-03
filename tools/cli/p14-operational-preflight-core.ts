import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_ROLLOUT_LANES,
  AGENT_ROLLOUT_STATES,
  type AgentRolloutLane,
  type AgentRolloutState,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import { SCHEMA_VERSION as SESSION_SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import {
  AGENT_ADMISSION_APPLICATION_ID,
  AGENT_ADMISSION_DB_FILE,
  AGENT_ADMISSION_SCHEMA_VERSION,
} from '../../apps/server/agent-admission-ledger.ts';
import {
  AGENT_CONTROL_APPLICATION_ID,
  AGENT_CONTROL_DB_FILE,
  AGENT_CONTROL_SCHEMA_VERSION,
} from '../../apps/server/agent-control-store.ts';
import { parseAgentLaneRuntimeConfig } from '../../apps/server/agent-lane-runtime-config.ts';
import { parseAgentAdmissionRuntimeConfig } from '../../apps/server/agent-admission-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from '../../apps/server/learning-text-runtime-config.ts';
import { parseInteractiveRuntimeConfig } from '../../apps/server/interactive-runtime-config.ts';
import { parseMaintenanceRuntimeConfig } from '../../apps/server/maintenance-runtime-config.ts';
import { parseMaintenanceAdmissionRuntimeConfig } from '../../apps/server/maintenance-admission-runtime-config.ts';
import { parseMaintenanceApplyRuntimeConfig } from '../../apps/server/maintenance-apply-runtime-config.ts';
export { resolveOperationalDataDirectory as resolveP14OperationalDataDirectory } from './operational-data-root.ts';
import { readRuntimeProfileEnvironment } from './runtime-profile-env.ts';

export const P14_OPERATIONAL_PREFLIGHT_VERSION = 'p14-operational-preflight-v2' as const;

type SqlRow = Record<string, unknown>;

export interface P14PreflightOptions {
  readonly dataDir: string;
  readonly sessionId: string;
  readonly profileFile: string;
}

function safeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`${name}-invalid`);
  return Number(value);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function inspectSchema(input: {
  path: string;
  expectedApplicationId?: number;
  expectedVersion: number;
  compatibleVersions: readonly number[];
  requiredTable: string;
}) {
  if (!safeFile(input.path)) return Object.freeze({
    exists: false,
    valid: false,
    actualVersion: null,
    expectedVersion: input.expectedVersion,
    migrationRequired: false,
    reason: 'file-missing' as const,
  });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(input.path, { readOnly: true });
    const actualVersion = pragma(db, 'user_version');
    const applicationId = pragma(db, 'application_id');
    const applicationMatches = input.expectedApplicationId === undefined
      || applicationId === input.expectedApplicationId;
    const compatible = input.compatibleVersions.includes(actualVersion);
    const tablePresent = hasTable(db, input.requiredTable);
    return Object.freeze({
      exists: true,
      valid: applicationMatches && compatible && tablePresent,
      actualVersion,
      expectedVersion: input.expectedVersion,
      migrationRequired: applicationMatches && compatible && actualVersion < input.expectedVersion,
      reason: !applicationMatches ? 'application-id-mismatch' as const
        : !compatible ? 'schema-version-unsupported' as const
          : !tablePresent ? 'required-table-missing' as const
            : 'ok' as const,
    });
  } catch {
    return Object.freeze({
      exists: true,
      valid: false,
      actualVersion: null,
      expectedVersion: input.expectedVersion,
      migrationRequired: false,
      reason: 'database-unreadable' as const,
    });
  } finally {
    db?.close();
  }
}

function inspectProfile(path: string, sessionId: string) {
  try {
    const env = readRuntimeProfileEnvironment(path);
    const lane = parseAgentLaneRuntimeConfig(env);
    const admission = parseAgentAdmissionRuntimeConfig(env);
    const learning = parseLearningTextRuntimeConfig(env);
    const interactive = parseInteractiveRuntimeConfig(env);
    const maintenance = parseMaintenanceRuntimeConfig(env);
    const maintenanceAdmission = parseMaintenanceAdmissionRuntimeConfig(env);
    const maintenanceApply = parseMaintenanceApplyRuntimeConfig(env);
    const sessionAllowed = admission.sessionAllowlist.has(sessionId)
      && maintenanceAdmission.sessionAllowlist.has(sessionId);
    return Object.freeze({
      valid: true,
      profileId: env.JG_AGENT_RUNTIME_PROFILE ?? 'unnamed',
      sessionAllowed,
      ceilings: lane.ceilings,
      admissionMode: admission.mode,
      learningTextMode: learning.mode,
      interactiveMode: interactive.lane,
      maintenanceMode: maintenance.lane,
      maintenanceAdmissionMode: maintenanceAdmission.mode,
      maintenanceApplyMode: maintenanceApply.enabled ? 'approval' as const : 'off' as const,
      reason: sessionAllowed ? 'ok' as const : 'target-session-not-allowlisted' as const,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      profileId: null,
      sessionAllowed: false,
      ceilings: null,
      admissionMode: null,
      learningTextMode: null,
      interactiveMode: null,
      maintenanceMode: null,
      maintenanceAdmissionMode: null,
      maintenanceApplyMode: null,
      reason: error instanceof Error ? error.message : 'profile-invalid',
    });
  }
}

function inspectProvider(dataDir: string) {
  const path = join(dataDir, 'provider.json');
  if (!safeFile(path)) return Object.freeze({
    configured: false,
    valid: false,
    keySource: 'none' as const,
    reason: 'provider-config-missing' as const,
  });
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const row = parsed as Record<string, unknown>;
    const configured = typeof row.apiKey === 'string' && row.apiKey.trim().length > 0
      && typeof row.baseUrl === 'string' && row.baseUrl.trim().length > 0
      && typeof row.model === 'string' && row.model.trim().length > 0;
    return Object.freeze({
      configured,
      valid: configured,
      keySource: configured ? 'provider.json' as const : 'none' as const,
      providerId: typeof row.providerId === 'string' ? row.providerId : 'builtin.openai',
      model: typeof row.model === 'string' ? row.model : null,
      kind: row.kind === 'anthropic' ? 'anthropic' as const : 'openai' as const,
      reason: configured ? 'ok' as const : 'provider-fields-incomplete' as const,
    });
  } catch {
    return Object.freeze({
      configured: false,
      valid: false,
      keySource: 'none' as const,
      reason: 'provider-config-invalid' as const,
    });
  }
}

function readinessResult(blockers: readonly string[]) {
  return Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze([...blockers]) });
}

function inspectControl(path: string, schemaValid: boolean, schemaVersion: number | null) {
  const fallback = AGENT_ROLLOUT_LANES.map((lane) => Object.freeze({
    lane,
    desiredState: null,
    killedReason: null,
    operationalEvaluationPassed: false,
    recoveryEvidenceFresh: false,
    authorizationWindow: null,
  }));
  if (!schemaValid || schemaVersion === null) return Object.freeze(fallback);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.freeze(AGENT_ROLLOUT_LANES.map((lane) => {
      const control = db.prepare(
        'SELECT desired_state,killed_reason,updated_at FROM agent_lane_control WHERE lane=?',
      ).get(lane) as SqlRow | undefined;
      const desiredState = typeof control?.desired_state === 'string'
        && AGENT_ROLLOUT_STATES.includes(control.desired_state as AgentRolloutState)
        ? control.desired_state as AgentRolloutState : null;
      const evaluation = db.prepare(schemaVersion >= 6
        ? 'SELECT evidence_class,passed,captured_at,recorded_at FROM agent_lane_evaluation WHERE lane=?'
        : 'SELECT evidence_class,passed,NULL AS captured_at,recorded_at FROM agent_lane_evaluation WHERE lane=?')
        .get(lane) as SqlRow | undefined;
      const killedAt = typeof control?.updated_at === 'string' ? Date.parse(control.updated_at) : Number.NaN;
      const capturedAt = typeof evaluation?.captured_at === 'string'
        ? Date.parse(evaluation.captured_at) : Number.NaN;
      const recordedAt = typeof evaluation?.recorded_at === 'string'
        ? Date.parse(evaluation.recorded_at) : Number.NaN;
      const operationalEvaluationPassed = evaluation?.evidence_class === 'operational'
        && Number(evaluation.passed) === 1;
      let authorizationWindow: null | Readonly<Record<string, unknown>> = null;
      if (schemaVersion >= 3 && hasTable(db, 'agent_lane_authorization_window')) {
        const row = db.prepare(`
          SELECT window_sequence,max_provider_calls,provider_calls,provider_errors,
            reserved_provider_calls,status
          FROM agent_lane_authorization_window WHERE lane=?
          ORDER BY window_sequence DESC LIMIT 1
        `).get(lane) as SqlRow | undefined;
        if (row) authorizationWindow = Object.freeze({
          sequence: Number(row.window_sequence),
          maxProviderCalls: Number(row.max_provider_calls),
          providerCalls: Number(row.provider_calls),
          providerErrors: Number(row.provider_errors),
          reservedProviderCalls: Number(row.reserved_provider_calls),
          remainingProviderCalls: Math.max(0, Number(row.max_provider_calls)
            - Number(row.provider_calls) - Number(row.provider_errors)
            - Number(row.reserved_provider_calls)),
          status: String(row.status),
        });
      }
      return Object.freeze({
        lane,
        desiredState,
        killedReason: typeof control?.killed_reason === 'string' ? control.killed_reason : null,
        operationalEvaluationPassed,
        recoveryEvidenceFresh: operationalEvaluationPassed
          && Number.isFinite(killedAt) && Number.isFinite(capturedAt) && Number.isFinite(recordedAt)
          && capturedAt > killedAt && recordedAt > killedAt,
        authorizationWindow,
      });
    }));
  } finally {
    db.close();
  }
}

export function buildP14OperationalPreflight(options: P14PreflightOptions) {
  const dataDir = resolve(options.dataDir);
  const sessionFile = join(dataDir, `${options.sessionId}.db`);
  const session = inspectSchema({
    path: sessionFile,
    expectedVersion: SESSION_SCHEMA_VERSION,
    compatibleVersions: [SESSION_SCHEMA_VERSION],
    requiredTable: 'turn_observation',
  });
  const admission = inspectSchema({
    path: join(dataDir, AGENT_ADMISSION_DB_FILE),
    expectedApplicationId: AGENT_ADMISSION_APPLICATION_ID,
    expectedVersion: AGENT_ADMISSION_SCHEMA_VERSION,
    compatibleVersions: [AGENT_ADMISSION_SCHEMA_VERSION - 1, AGENT_ADMISSION_SCHEMA_VERSION],
    requiredTable: 'agent_admission_decision',
  });
  const controlPath = join(dataDir, AGENT_CONTROL_DB_FILE);
  const control = inspectSchema({
    path: controlPath,
    expectedApplicationId: AGENT_CONTROL_APPLICATION_ID,
    expectedVersion: AGENT_CONTROL_SCHEMA_VERSION,
    // Read-only preflight runs before the server migration, so every directly migratable
    // predecessor must remain recognizable rather than being mislabeled as corruption.
    compatibleVersions: [2, 3, 4, 5, AGENT_CONTROL_SCHEMA_VERSION],
    requiredTable: 'agent_lane_control',
  });
  const profile = inspectProfile(resolve(options.profileFile), options.sessionId);
  const provider = inspectProvider(dataDir);
  const lanes = inspectControl(controlPath, control.valid, control.actualVersion);
  const schemaBlockers: string[] = [];
  if (!session.valid) schemaBlockers.push(`session:${session.reason}`);
  if (!admission.valid) schemaBlockers.push(`admission:${admission.reason}`);
  else if (admission.migrationRequired) schemaBlockers.push('admission:migration-required');
  if (!control.valid) schemaBlockers.push(`control:${control.reason}`);
  else if (control.migrationRequired) schemaBlockers.push('control:migration-required');
  const sharedRuntimeBlockers = [
    ...(!profile.valid || !profile.sessionAllowed ? [`profile:${profile.reason}`] : []),
    ...(!provider.valid ? [`provider:${provider.reason}`] : []),
  ];
  // Synthetic operational replays are isolated CLI evaluations. They intentionally do
  // not consume the live lane/control window: their own --allow-provider + exact ACK +
  // cost/wall limits are the authorization boundary. This field only means the local
  // infrastructure is ready; it never means the operator has authorized a paid run.
  const syntheticReplayInfrastructure = readinessResult([
    ...(!session.valid ? [`session:${session.reason}`] : []),
    ...(!provider.valid ? [`provider:${provider.reason}`] : []),
  ]);
  const recoveryEvidenceBlockers = lanes.flatMap((row) => (
    row.desiredState === 'killed' && !row.recoveryEvidenceFresh
      ? [`lane:${row.lane}:fresh-operational-recovery-evidence-required`]
      : []
  ));
  const recovery = readinessResult([
    ...schemaBlockers, ...sharedRuntimeBlockers, ...recoveryEvidenceBlockers,
  ]);
  const laneTraffic = Object.freeze(Object.fromEntries(lanes.map((row) => {
    const blockers = [...schemaBlockers, ...sharedRuntimeBlockers];
    if (row.desiredState === null || row.desiredState === 'off' || row.desiredState === 'killed') {
      blockers.push(`lane:${row.lane}:${row.desiredState ?? 'invalid'}`);
    }
    if (!row.operationalEvaluationPassed) blockers.push(`lane:${row.lane}:operational-evaluation-required`);
    if (row.authorizationWindow === null) blockers.push(`lane:${row.lane}:authorization-window-unavailable`);
    else if (row.authorizationWindow.status !== 'active'
      || Number(row.authorizationWindow.remainingProviderCalls) < 1) {
      blockers.push(`lane:${row.lane}:authorization-window-review-required`);
    }
    return [row.lane, readinessResult(blockers)] as const;
  })) as Record<AgentRolloutLane, ReturnType<typeof readinessResult>>);
  const blockers = [...new Set(AGENT_ROLLOUT_LANES.flatMap((lane) => laneTraffic[lane].blockers))];
  const allLaneTrafficReady = AGENT_ROLLOUT_LANES.every((lane) => laneTraffic[lane].ready);
  return Object.freeze({
    version: P14_OPERATIONAL_PREFLIGHT_VERSION,
    targetSession: options.sessionId,
    ready: blockers.length === 0,
    schemas: Object.freeze({ session, admission, control }),
    runtimeProfile: profile,
    provider,
    lanes,
    readiness: Object.freeze({
      syntheticReplayInfrastructure: Object.freeze({
        ...syntheticReplayInfrastructure,
        requiresExplicitProviderAuthorization: true,
      }),
      recovery,
      laneTraffic,
      allLaneTrafficReady,
    }),
    blockers: Object.freeze(blockers),
    nextActions: Object.freeze([
      ...(admission.migrationRequired || control.migrationRequired
        ? ['normal-restart-to-apply-database-migrations'] : []),
      ...lanes.filter((row) => row.desiredState === 'off').map((row) => `operator-review-lane:${row.lane}`),
      ...lanes.filter((row) => !row.operationalEvaluationPassed)
        .map((row) => `register-passed-operational-evaluation:${row.lane}`),
      ...lanes.filter((row) => row.desiredState === 'killed' && !row.recoveryEvidenceFresh)
        .map((row) => `collect-post-kill-operational-evidence:${row.lane}`),
      ...lanes.filter((row) => row.authorizationWindow === null
        || row.authorizationWindow.status !== 'active'
        || Number(row.authorizationWindow.remainingProviderCalls) < 1)
        .map((row) => `explicit-provider-call-authorization-required:${row.lane}`),
    ]),
  });
}
