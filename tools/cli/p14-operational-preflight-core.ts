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
import {
  AgentProviderConfigFileError,
  AgentProviderSelectionError,
  loadAgentProviderConfig,
  resolveAgentProviderSelection,
} from '../../apps/server/agent-provider-config.ts';
import { parseAgentLaneRuntimeConfig } from '../../apps/server/agent-lane-runtime-config.ts';
import {
  agentAdmissionAllowsSession,
  parseAgentAdmissionRuntimeConfig,
} from '../../apps/server/agent-admission-runtime-config.ts';
import {
  contextCompilerAllowsSession,
  parseContextCompilerRuntimeConfig,
} from '../../apps/server/context-compiler-runtime-config.ts';
import { parseLearningTextRuntimeConfig } from '../../apps/server/learning-text-runtime-config.ts';
import { parseInteractiveRuntimeConfig } from '../../apps/server/interactive-runtime-config.ts';
import { parseMaintenanceRuntimeConfig } from '../../apps/server/maintenance-runtime-config.ts';
import {
  maintenanceAdmissionAllowsSession,
  parseMaintenanceAdmissionRuntimeConfig,
} from '../../apps/server/maintenance-admission-runtime-config.ts';
import { parseMaintenanceApplyRuntimeConfig } from '../../apps/server/maintenance-apply-runtime-config.ts';
import {
  parseWorldbookRepairRuntimeConfig,
  worldbookRepairForwardAllowsSession,
} from '../../apps/server/worldbook-repair-runtime-config.ts';
import { readNpcMaintenanceActivationMarker } from '../../apps/server/npc-maintenance-activation.ts';
import {
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_DB_FILE,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from '../../apps/server/maintenance-job-manager.ts';
export { resolveOperationalDataDirectory as resolveP14OperationalDataDirectory } from './operational-data-root.ts';
import { readRuntimeProfileEnvironment } from './runtime-profile-env.ts';

export const P14_OPERATIONAL_PREFLIGHT_VERSION = 'p14-operational-preflight-v4' as const;

type SqlRow = Record<string, unknown>;

export interface P14PreflightOptions {
  readonly dataDir: string;
  readonly sessionId: string;
  readonly profileFile: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const BUILTIN_PROVIDER_ID = 'builtin.openai';
const CREDENTIAL_LOCKDOWN_OFF_VALUES = new Set(['', '0', 'off', 'false', 'no']);

function credentialLockdownActive(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = environment.JG_TEST_CREDENTIAL_LOCKDOWN;
  return raw !== undefined
    && !CREDENTIAL_LOCKDOWN_OFF_VALUES.has(String(raw).trim().toLowerCase());
}

function environmentText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function configuredPath(
  dataDir: string,
  environment: Readonly<Record<string, string | undefined>>,
  variable: 'JG_PROVIDER_JSON' | 'JG_AGENT_PROVIDER_JSON',
  fallback: string,
): string {
  const override = environment[variable];
  return override ? resolve(override) : join(dataDir, fallback);
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

function inspectProfile(
  path: string,
  sessionId: string,
  npcActivationSessions: ReadonlySet<string>,
) {
  try {
    const env = readRuntimeProfileEnvironment(path);
    const lane = parseAgentLaneRuntimeConfig(env);
    const admission = parseAgentAdmissionRuntimeConfig(env);
    const learning = parseLearningTextRuntimeConfig(env);
    const interactive = parseInteractiveRuntimeConfig(env);
    const maintenance = parseMaintenanceRuntimeConfig(env);
    const maintenanceAdmission = parseMaintenanceAdmissionRuntimeConfig(env);
    const maintenanceApply = parseMaintenanceApplyRuntimeConfig(env, { npcActivationSessions });
    const contextCompiler = parseContextCompilerRuntimeConfig(env);
    const worldbookRepair = parseWorldbookRepairRuntimeConfig(env);
    const admissionAllowed = agentAdmissionAllowsSession(admission, sessionId);
    const maintenanceAdmissionAllowed = maintenanceAdmissionAllowsSession(
      maintenanceAdmission,
      sessionId,
    );
    const contextCompilerAllowed = !contextCompiler.enabled
      || contextCompilerAllowsSession(contextCompiler, sessionId);
    const worldbookRepairAllowed = !worldbookRepair.enabled
      || worldbookRepairForwardAllowsSession(worldbookRepair, sessionId);
    const sessionAllowed = admissionAllowed && maintenanceAdmissionAllowed
      && contextCompilerAllowed && worldbookRepairAllowed;
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
      sessionScope: admission.sessionScope,
      contextCompilerMode: contextCompiler.mode,
      contextCompilerAllowed,
      worldbookRepairMode: worldbookRepair.mode,
      worldbookRepairAllowed,
      // This legacy field reports only the exact-session autonomous write boundary,
      // not the separately acknowledged managed-local operator-approval scope.
      // Treating guarded-auto as generic approval hid the fact that low-risk NPC
      // proposals could commit without an operator click and made diagnostics misleading.
      maintenanceApplyMode: maintenanceApply.mode,
      maintenanceApplyEnabled: maintenanceApplyAllowsExactSession(maintenanceApply, sessionId),
      reason: sessionAllowed ? 'ok' as const : 'target-session-not-allowed-by-runtime-scope' as const,
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
      sessionScope: null,
      contextCompilerMode: null,
      contextCompilerAllowed: false,
      worldbookRepairMode: null,
      worldbookRepairAllowed: false,
      maintenanceApplyMode: null,
      maintenanceApplyEnabled: false,
      reason: error instanceof Error ? error.message : 'profile-invalid',
    });
  }
}

function maintenanceApplyAllowsExactSession(
  config: ReturnType<typeof parseMaintenanceApplyRuntimeConfig>,
  sessionId: string,
): boolean {
  return config.enabled && config.sessionAllowlist.has(sessionId);
}

function inspectNpcMaintenanceActivation(dataDir: string, sessionId: string) {
  try {
    const marker = readNpcMaintenanceActivationMarker(dataDir, sessionId);
    if (!marker) return Object.freeze({
      valid: true,
      active: false,
      sessionAllowed: false,
      taskKinds: Object.freeze([] as string[]),
      reason: 'activation-marker-missing' as const,
    });
    const sessionAllowed = marker.sessionId === sessionId;
    return Object.freeze({
      valid: true,
      active: true,
      sessionAllowed,
      taskKinds: Object.freeze([...marker.taskKinds]),
      reason: sessionAllowed ? 'ok' as const : 'activation-session-mismatch' as const,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      active: false,
      sessionAllowed: false,
      taskKinds: Object.freeze([] as string[]),
      reason: error instanceof Error ? error.message : 'activation-marker-invalid',
    });
  }
}

function inspectProvider(
  dataDir: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (credentialLockdownActive(process.env) || credentialLockdownActive(environment)) return Object.freeze({
    configured: false,
    valid: false,
    keySource: 'none' as const,
    providerId: null,
    model: null,
    kind: null,
    selectionSource: null,
    reason: 'credential-lockdown-active' as const,
  });
  if (process.env.JG_PROVIDER_SPI === '0' || environment.JG_PROVIDER_SPI === '0') return Object.freeze({
    configured: false,
    valid: false,
    keySource: 'none' as const,
    providerId: null,
    model: null,
    kind: null,
    selectionSource: null,
    reason: 'provider-spi-disabled' as const,
  });
  const path = configuredPath(dataDir, environment, 'JG_PROVIDER_JSON', 'provider.json');
  if (!safeFile(path)) return Object.freeze({
    configured: false,
    valid: false,
    keySource: 'none' as const,
    providerId: null,
    model: null,
    kind: null,
    selectionSource: null,
    reason: 'provider-config-missing' as const,
  });
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const row = parsed as Record<string, unknown>;
    const providerIdValue = row.providerId
      ?? environmentText(environment.JG_PROVIDER_ID)
      ?? BUILTIN_PROVIDER_ID;
    const providerId = typeof providerIdValue === 'string' && PROVIDER_ID_RE.test(providerIdValue)
        ? providerIdValue
        : null;
    if (!providerId) throw new Error('invalid');
    // Main Provider loading preserves the configured model verbatim; only the
    // override normalizer trims its own model. Keep that same selection value.
    const model = typeof row.model === 'string' ? row.model : '';
    const kind = row.kind === 'anthropic' || environment.JG_PROVIDER_KIND === 'anthropic'
      ? 'anthropic' as const
      : 'openai' as const;
    const configured = typeof row.apiKey === 'string' && row.apiKey.trim().length > 0
      && typeof row.baseUrl === 'string' && row.baseUrl.trim().length > 0
      && model.trim().length > 0;
    if (!configured) return Object.freeze({
      configured: false,
      valid: false,
      keySource: 'none' as const,
      providerId,
      model: model || null,
      kind,
      selectionSource: null,
      reason: 'provider-fields-incomplete' as const,
    });

    const agentProviderPath = configuredPath(
      dataDir,
      environment,
      'JG_AGENT_PROVIDER_JSON',
      'agent-provider.json',
    );
    let agentConfig: ReturnType<typeof loadAgentProviderConfig>;
    try {
      agentConfig = loadAgentProviderConfig({ path: agentProviderPath });
    } catch (error) {
      if (!(error instanceof AgentProviderConfigFileError)) throw error;
      return Object.freeze({
        configured: false,
        valid: false,
        keySource: 'provider.json' as const,
        providerId,
        model,
        kind,
        selectionSource: null,
        reason: 'agent-provider-config-invalid' as const,
      });
    }

    const selectionSource = agentConfig.mode === 'override'
      ? 'agent-provider-override' as const
      : 'main-provider' as const;
    try {
      const selection = resolveAgentProviderSelection({
        config: agentConfig,
        main: { providerId, model },
        // Only the builtin registration is statically provable. Plugin presence
        // on disk cannot prove that its apply/register lifecycle succeeded or
        // that its own credential validator marked the descriptor configured.
        describe: (candidateId) => candidateId === BUILTIN_PROVIDER_ID
          ? { configured: true }
          : undefined,
      });
      return Object.freeze({
        configured: true,
        valid: true,
        keySource: 'provider.json' as const,
        providerId: selection.providerId,
        model: selection.model,
        kind,
        selectionSource,
        reason: 'ok' as const,
      });
    } catch (error) {
      if (!(error instanceof AgentProviderSelectionError)) throw error;
      const runtimeProofRequired = error.code === 'agent-provider-not-found'
        && error.providerId !== BUILTIN_PROVIDER_ID;
      return Object.freeze({
        configured: false,
        valid: false,
        keySource: 'provider.json' as const,
        providerId: error.providerId,
        model: agentConfig.mode === 'override' ? agentConfig.model : model,
        kind: error.providerId === providerId ? kind : null,
        selectionSource,
        reason: runtimeProofRequired ? 'agent-provider-runtime-proof-required' as const : error.code,
      });
    }
  } catch {
    return Object.freeze({
      configured: false,
      valid: false,
      keySource: 'none' as const,
      providerId: null,
      model: null,
      kind: null,
      selectionSource: null,
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

/** Persistent Maintenance switches are an execution gate, not merely an operator preference.
 * Keep this read-only inspection beside the lane preflight so "all green" cannot coexist with
 * MaintenanceJobManager refusing every enqueue. */
function inspectMaintenanceSettings(path: string, sessionId: string, schemaValid: boolean) {
  const unavailable = (reason: string) => Object.freeze({
    valid: false,
    globalEnabled: null,
    sessionEnabled: null,
    effectiveEnabled: false,
    defaultMode: null,
    reason,
  });
  if (!schemaValid) return unavailable('schema-unavailable');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const global = db.prepare(
      'SELECT global_enabled,default_mode FROM maintenance_settings WHERE singleton=1',
    ).get() as SqlRow | undefined;
    if (!global || (global.global_enabled !== 0 && global.global_enabled !== 1)
      || (global.default_mode !== 'shadow' && global.default_mode !== 'apply')) {
      return unavailable('settings-invalid');
    }
    const local = db.prepare(
      'SELECT enabled FROM maintenance_session_settings WHERE session_id=?',
    ).get(sessionId) as SqlRow | undefined;
    if (local && local.enabled !== 0 && local.enabled !== 1) {
      return unavailable('session-settings-invalid');
    }
    const globalEnabled = global.global_enabled === 1;
    // Mirrors MaintenanceJobManager.settings(): an absent per-session row defaults to enabled.
    const sessionEnabled = local?.enabled !== 0;
    return Object.freeze({
      valid: true,
      globalEnabled,
      sessionEnabled,
      effectiveEnabled: globalEnabled && sessionEnabled,
      defaultMode: global.default_mode as 'shadow' | 'apply',
      reason: globalEnabled ? (sessionEnabled ? 'ok' : 'session-disabled') : 'global-disabled',
    });
  } catch {
    return unavailable('database-unreadable');
  } finally {
    db?.close();
  }
}

export function buildP14OperationalPreflight(options: P14PreflightOptions) {
  const dataDir = resolve(options.dataDir);
  const environment = options.environment ?? process.env;
  const sessionFile = join(dataDir, `${options.sessionId}.db`);
  const session = inspectSchema({
    path: sessionFile,
    expectedVersion: SESSION_SCHEMA_VERSION,
    // MemoryDb performs the immediately preceding additive migration on open.
    // Surface that as a migration requirement instead of an unsupported file.
    compatibleVersions: [SESSION_SCHEMA_VERSION - 1, SESSION_SCHEMA_VERSION],
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
    compatibleVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10, AGENT_CONTROL_SCHEMA_VERSION],
    requiredTable: 'agent_lane_control',
  });
  const maintenancePath = join(dataDir, MAINTENANCE_JOB_DB_FILE);
  const maintenance = inspectSchema({
    path: maintenancePath,
    expectedApplicationId: MAINTENANCE_JOB_APPLICATION_ID,
    expectedVersion: MAINTENANCE_JOB_SCHEMA_VERSION,
    compatibleVersions: [4, 5, 6, 7, MAINTENANCE_JOB_SCHEMA_VERSION],
    requiredTable: 'maintenance_settings',
  });
  const maintenanceSettings = inspectMaintenanceSettings(
    maintenancePath,
    options.sessionId,
    maintenance.valid && !maintenance.migrationRequired,
  );
  const npcMaintenanceActivation = inspectNpcMaintenanceActivation(dataDir, options.sessionId);
  const profile = inspectProfile(
    resolve(options.profileFile),
    options.sessionId,
    npcMaintenanceActivation.active && npcMaintenanceActivation.sessionAllowed
      ? new Set([options.sessionId]) : new Set(),
  );
  const provider = inspectProvider(dataDir, environment);
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
    if (row.lane === 'maintenance') {
      if (!maintenance.valid) blockers.push(`lane:maintenance:settings-${maintenance.reason}`);
      else if (maintenance.migrationRequired) blockers.push('lane:maintenance:settings-migration-required');
      else if (!maintenanceSettings.valid) {
        blockers.push(`lane:maintenance:settings-${maintenanceSettings.reason}`);
      } else if (!maintenanceSettings.globalEnabled) {
        blockers.push('lane:maintenance:persisted-global-disabled');
      } else if (!maintenanceSettings.sessionEnabled) {
        blockers.push('lane:maintenance:persisted-session-disabled');
      }
      if (profile.maintenanceApplyMode === 'guarded-auto'
        && (!npcMaintenanceActivation.valid || !npcMaintenanceActivation.active
          || !npcMaintenanceActivation.sessionAllowed)) {
        blockers.push(`lane:maintenance:npc-${npcMaintenanceActivation.reason}`);
      }
    }
    return [row.lane, readinessResult(blockers)] as const;
  })) as Record<AgentRolloutLane, ReturnType<typeof readinessResult>>);
  const blockers = [...new Set(AGENT_ROLLOUT_LANES.flatMap((lane) => laneTraffic[lane].blockers))];
  const allLaneTrafficReady = AGENT_ROLLOUT_LANES.every((lane) => laneTraffic[lane].ready);
  return Object.freeze({
    version: P14_OPERATIONAL_PREFLIGHT_VERSION,
    targetSession: options.sessionId,
    ready: blockers.length === 0,
    schemas: Object.freeze({ session, admission, control, maintenance }),
    runtimeProfile: profile,
    npcMaintenanceActivation,
    maintenanceSettings,
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
      ...(admission.migrationRequired || control.migrationRequired || maintenance.migrationRequired
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
      ...(!maintenanceSettings.valid || !maintenanceSettings.effectiveEnabled
        ? ['operator-review-persisted-maintenance-settings'] : []),
      ...(profile.maintenanceApplyMode === 'guarded-auto'
        && (!npcMaintenanceActivation.active || !npcMaintenanceActivation.sessionAllowed)
        ? ['run-npc-maintenance-backup-activation'] : []),
    ]),
  });
}
