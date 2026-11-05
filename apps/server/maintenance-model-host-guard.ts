/** Synchronous host source fence only. It neither owns a lease nor grants AL execution. */
import { createHash } from 'node:crypto';
import {
  agentBudgetProfileDigest, normalizeAgentBudgetProfile,
} from '../../packages/agent-policy/public/budget-profile.ts';
import {
  MODEL_RUNTIME_PROFILE_VERSION, modelRuntimeProfileDigest, parseStaticModelRuntimeProfiles,
  type ModelRuntimeProfile,
} from '../../packages/prompt/public/model-runtime-profile.ts';
import type { AgentAdmissionLease } from './agent-admission-broker.ts';
import type { MaintenanceExecutionRecord } from './maintenance-job-manager.ts';
import {
  isMaintenanceMode, isMaintenanceTaskKind, isMaintenanceTrigger, type PublicMaintenanceJob,
} from './maintenance-types.ts';

type BudgetInput = Parameters<typeof normalizeAgentBudgetProfile>[0];
type NormalizedBudget = ReturnType<typeof normalizeAgentBudgetProfile>;
type FixedJob = Readonly<Pick<PublicMaintenanceJob,
  'runId' | 'sessionId' | 'taskKind' | 'sourceRevision' | 'policyVersion' | 'parentRunId'
  | 'trigger' | 'mode' | 'status' | 'attempt' | 'createdAt' | 'startedAt'>>;

export interface MaintenanceModelHostEnvironment {
  readonly execution: MaintenanceExecutionRecord;
  /** Exact loaded Session reference, deliberately never serialized or frozen by this module. */
  readonly sessionIdentity: object;
  readonly sourceRevision: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly providerId: string;
  readonly modelId: string;
  readonly runtimeProfile: ModelRuntimeProfile;
  readonly budgetProfile: BudgetInput;
}
export interface MaintenanceModelHostGuardOptions {
  readonly job: PublicMaintenanceJob;
  readonly execution: MaintenanceExecutionRecord;
  readonly verifiedSourceRevision: string;
  readonly budgetProfile: BudgetInput;
  /** Durable Manager route, never inferred from owner names or a running job DTO. */
  readonly expectedExecutorRoute?: MaintenanceExecutionRecord['executorRoute'];
  /** Trusted synchronous readback also enforces loaded/deletion/privacy/eligibility/control gates. */
  readonly readCurrent: () => MaintenanceModelHostEnvironment | null;
  readonly clock: () => string;
}
export interface MaintenanceModelHostFixed {
  readonly job: FixedJob;
  readonly ownerInstanceId: string;
  readonly executorRoute: MaintenanceExecutionRecord['executorRoute'];
  readonly sourceRevision: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly providerId: string;
  readonly modelId: string;
  readonly runtimeProfile: ModelRuntimeProfile;
  readonly runtimeProfileDigest: string;
  readonly budgetProfile: NormalizedBudget;
  readonly budgetProfileDigest: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const REJECTED = 'maintenance-model-host-guard-rejected';
const RUNTIME_KEYS = new Set([
  'version', 'providerIdDigest', 'modelId', 'contextWindowTokens', 'maxOutputTokens', 'tokenizer',
  'supportsTools', 'supportsStreaming', 'inputMicrousdPerMillionTokens',
  'outputMicrousdPerMillionTokens', 'source', 'updatedAt',
]);
function reject(): never { throw new Error(REJECTED); }
function token(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function at(clock: () => string): string {
  const value = clock();
  if (!timestamp(value)) reject();
  return value;
}
function fixedJob(job: PublicMaintenanceJob): FixedJob {
  if (!job || !token(job.runId) || !token(job.sessionId) || !isMaintenanceTaskKind(job.taskKind)
    || !HASH.test(job.sourceRevision) || !token(job.policyVersion)
    || (job.parentRunId !== undefined && !token(job.parentRunId))
    || !isMaintenanceTrigger(job.trigger) || !isMaintenanceMode(job.mode) || job.status !== 'running'
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !timestamp(job.createdAt)
    || !timestamp(job.updatedAt) || !timestamp(job.startedAt) || job.finishedAt !== undefined) reject();
  return Object.freeze({ runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind,
    sourceRevision: job.sourceRevision, policyVersion: job.policyVersion,
    ...(job.parentRunId === undefined ? {} : { parentRunId: job.parentRunId }),
    trigger: job.trigger, mode: job.mode, status: job.status, attempt: job.attempt,
    createdAt: job.createdAt, startedAt: job.startedAt });
}
function sameJob(left: FixedJob, right: FixedJob): boolean {
  // These are selected scalar headers, never arbitrary Session/job bodies.
  return JSON.stringify(left) === JSON.stringify(right);
}
function executionAt(execution: MaintenanceExecutionRecord, now: string,
  expectedExecutorRoute: MaintenanceExecutionRecord['executorRoute'], requireLiveTtl = true): FixedJob {
  if (!execution || !token(execution.leaseOwnerInstanceId) || !timestamp(execution.leaseExpiresAt)
    || execution.executorRoute !== expectedExecutorRoute
    || (requireLiveTtl && Date.parse(execution.leaseExpiresAt) <= Date.parse(now))
    || execution.cancelRequestedAt !== undefined) reject();
  return fixedJob(execution.job);
}
function runtimeFor(environment: MaintenanceModelHostEnvironment): ModelRuntimeProfile {
  const runtime = environment.runtimeProfile;
  if (!runtime || (Object.getPrototypeOf(runtime) !== Object.prototype && Object.getPrototypeOf(runtime) !== null)
    || Object.keys(runtime).some((key) => !RUNTIME_KEYS.has(key))
    || runtime.version !== MODEL_RUNTIME_PROFILE_VERSION || runtime.modelId !== environment.modelId
    || runtime.providerIdDigest !== `sha256:${createHash('sha256').update(environment.providerId, 'utf8').digest('hex')}`
    || (runtime.source !== 'static-declaration' && runtime.source !== 'provider-verified')) reject();
  // Reuse the public profile contract validator; never resolve environment defaults or a Client here.
  const [declaration] = parseStaticModelRuntimeProfiles(JSON.stringify([{
    providerId: environment.providerId, modelId: runtime.modelId,
    contextWindowTokens: runtime.contextWindowTokens, maxOutputTokens: runtime.maxOutputTokens,
    tokenizer: runtime.tokenizer, supportsTools: runtime.supportsTools, supportsStreaming: runtime.supportsStreaming,
    ...(runtime.inputMicrousdPerMillionTokens === undefined ? {} : {
      inputMicrousdPerMillionTokens: runtime.inputMicrousdPerMillionTokens,
    }),
    ...(runtime.outputMicrousdPerMillionTokens === undefined ? {} : {
      outputMicrousdPerMillionTokens: runtime.outputMicrousdPerMillionTokens,
    }),
    updatedAt: runtime.updatedAt,
  }]));
  if (!declaration) reject();
  return Object.freeze({ version: MODEL_RUNTIME_PROFILE_VERSION,
    providerIdDigest: runtime.providerIdDigest, modelId: declaration.modelId,
    contextWindowTokens: declaration.contextWindowTokens, maxOutputTokens: declaration.maxOutputTokens,
    tokenizer: declaration.tokenizer, supportsTools: declaration.supportsTools, supportsStreaming: declaration.supportsStreaming,
    ...(declaration.inputMicrousdPerMillionTokens === undefined ? {} : {
      inputMicrousdPerMillionTokens: declaration.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: declaration.outputMicrousdPerMillionTokens,
    }), source: runtime.source, updatedAt: declaration.updatedAt });
}
function environmentOf(current: MaintenanceModelHostEnvironment | null): MaintenanceModelHostEnvironment & {
  readonly budgetProfile: NormalizedBudget;
} {
  if (!current || current.sessionIdentity === null || typeof current.sessionIdentity !== 'object'
    || !HASH.test(current.sourceRevision) || !token(current.providerId) || !token(current.modelId)
    || (current.contentMode !== 'nsf' && current.contentMode !== 'nsfw')) reject();
  const runtimeProfile = runtimeFor(current), budgetProfile = normalizeAgentBudgetProfile(current.budgetProfile);
  if (budgetProfile.providerContextWindowTokens > runtimeProfile.contextWindowTokens
    || budgetProfile.agentOutputBudgetTokens > runtimeProfile.maxOutputTokens) reject();
  // Copy/freeze metadata, not the opaque Session reference or the caller's objects.
  const job = fixedJob(current.execution.job);
  const execution = Object.freeze({ job: Object.freeze({ ...job, updatedAt: current.execution.job.updatedAt }),
    executorRoute: current.execution.executorRoute,
    leaseOwnerInstanceId: current.execution.leaseOwnerInstanceId, leaseExpiresAt: current.execution.leaseExpiresAt,
    ...(current.execution.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: current.execution.cancelRequestedAt }) });
  return Object.freeze({ execution, sessionIdentity: current.sessionIdentity, sourceRevision: current.sourceRevision,
    contentMode: current.contentMode, providerId: current.providerId, modelId: current.modelId,
    runtimeProfile, budgetProfile });
}

export function createMaintenanceModelHostGuard(options: MaintenanceModelHostGuardOptions): Readonly<{
  fixed: MaintenanceModelHostFixed;
  assertCurrent(): MaintenanceModelHostEnvironment;
  /** Read-only liveness, not a source/dispatch/write grant. Only an already
   * authorized domain ACT may use this after its own source-changing write. */
  assertLiveClaim(): MaintenanceModelHostEnvironment;
  authorizeDispatch(lease: AgentAdmissionLease): boolean;
}> {
  try {
    if (!options || typeof options.readCurrent !== 'function' || typeof options.clock !== 'function'
      || !HASH.test(options.verifiedSourceRevision)) reject();
    const { readCurrent, clock } = options;
    const expectedExecutorRoute = options.expectedExecutorRoute === undefined ? 'legacy' : options.expectedExecutorRoute;
    if (expectedExecutorRoute !== 'legacy' && expectedExecutorRoute !== 'agent-loop') reject();
    const budgetProfile = normalizeAgentBudgetProfile(options.budgetProfile);
    const budgetProfileDigest = agentBudgetProfileDigest(budgetProfile);
    const captured = environmentOf(readCurrent());
    const now = at(clock), expectedJob = fixedJob(options.job);
    // The original claim DTO precedes asynchronous snapshot loading. Heartbeats
    // may have renewed its TTL; only fresh authoritative readback grants liveness.
    if (!sameJob(expectedJob, executionAt(options.execution, now, expectedExecutorRoute, false))
      || !sameJob(expectedJob, executionAt(captured.execution, now, expectedExecutorRoute))
      || captured.execution.leaseOwnerInstanceId !== options.execution.leaseOwnerInstanceId
      || expectedJob.sourceRevision !== options.verifiedSourceRevision
      || captured.sourceRevision !== options.verifiedSourceRevision
      || agentBudgetProfileDigest(captured.budgetProfile) !== budgetProfileDigest) reject();
    const sessionIdentity = captured.sessionIdentity;
    const fixed: MaintenanceModelHostFixed = Object.freeze({ job: expectedJob,
      ownerInstanceId: captured.execution.leaseOwnerInstanceId, executorRoute: captured.execution.executorRoute,
      sourceRevision: captured.sourceRevision,
      contentMode: captured.contentMode, providerId: captured.providerId, modelId: captured.modelId,
      runtimeProfile: captured.runtimeProfile, runtimeProfileDigest: modelRuntimeProfileDigest(captured.runtimeProfile),
      budgetProfile, budgetProfileDigest });
    const assertLiveClaim = (): MaintenanceModelHostEnvironment => {
      try {
        const current = environmentOf(readCurrent());
        if (!sameJob(fixed.job, executionAt(current.execution, at(clock), fixed.executorRoute))
          || current.execution.leaseOwnerInstanceId !== fixed.ownerInstanceId
          || current.sessionIdentity !== sessionIdentity
          || current.contentMode !== fixed.contentMode || current.providerId !== fixed.providerId || current.modelId !== fixed.modelId
          || modelRuntimeProfileDigest(current.runtimeProfile) !== fixed.runtimeProfileDigest
          || agentBudgetProfileDigest(current.budgetProfile) !== fixed.budgetProfileDigest) reject();
        return current;
      } catch { return reject(); }
    };
    const assertCurrent = (): MaintenanceModelHostEnvironment => {
      const current = assertLiveClaim();
      if (current.sourceRevision !== fixed.sourceRevision) reject();
      return current;
    };
    return Object.freeze({ fixed, assertCurrent, assertLiveClaim,
      authorizeDispatch(lease: AgentAdmissionLease): boolean {
        try {
          assertCurrent();
          return !!lease && lease.runId === fixed.job.runId && lease.parentRunId === (fixed.job.parentRunId ?? fixed.job.runId)
            && lease.sessionId === fixed.job.sessionId && lease.sourceRevision === fixed.sourceRevision
            && lease.lane === 'maintenance' && lease.taskKind === fixed.job.taskKind && lease.policyVersion === fixed.job.policyVersion
            && lease.modelId === fixed.modelId && lease.mode === fixed.contentMode && lease.budgetProfileDigest === fixed.budgetProfileDigest
            && Number.isSafeInteger(lease.expiresAtMs) && lease.expiresAtMs > Date.parse(at(clock));
        } catch { return false; }
      },
    });
  } catch { return reject(); }
}
