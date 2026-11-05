// §13.84 production source/policy observation for a queued Maintenance job.
//
// The reader is deliberately synchronous and read-only. A live proof binds one
// stable Manager job, its exact admission decision and its loaded Session
// revision, but never authorizes claim, execution, publication or cutover.
//
// The current production enqueue policy is intentionally different from the
// §13.82 route-plan policy. That mismatch is evidence, not something this
// module is allowed to translate or hide.
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  isPublicMaintenanceJob,
  isSafeOpaqueId,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';
import { MAINTENANCE_ADMISSION_POLICY_VERSION } from '../../packages/agent-policy/public/maintenance-admission.ts';
import {
  AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION,
} from './agent-loop-maintenance-canary-route-plan.ts';
import {
  agentLoopMaintenanceProductionQueuedJobDigest,
} from './agent-loop-maintenance-production-route-contract.ts';
import {
  isAgentAdmissionLedgerInstanceInternal,
  type AgentAdmissionLedger,
} from './agent-admission-ledger.ts';
import {
  isMaintenanceProductionQueuedJobReaderForManagerInternal,
  type MaintenanceJobManager,
  type MaintenanceProductionQueuedJobReader,
} from './maintenance-job-manager.ts';
import { MAINTENANCE_POLICY_VERSION } from './maintenance-types.ts';

export const AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION =
  'agent-loop-maintenance-canary-source-policy-proof-v1' as const;

// Freeze every external version named by proof-v1. If one of the imported
// "current" constants moves, TypeScript must reject this module until the
// proof contract is explicitly reviewed and versioned.
const PRODUCTION_ADMISSION_POLICY_VERSION =
  'p14-maintenance-admission-v3' as const satisfies typeof MAINTENANCE_ADMISSION_POLICY_VERSION;
const ROUTE_PLAN_POLICY_VERSION =
  'p13b-v1' as const satisfies typeof MAINTENANCE_POLICY_VERSION;
const ROUTE_PLAN_VERSION = 'agent-loop-maintenance-canary-route-plan-v1' as const satisfies typeof AGENT_LOOP_MAINTENANCE_CANARY_ROUTE_PLAN_VERSION;

export interface AgentLoopMaintenanceCanarySourcePolicyAdmission {
  readonly decisionId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly factsTaskKind: string;
  readonly decisionTaskKind: string;
  readonly policyVersion: string;
  readonly verdict: string;
  readonly factsDigest: string;
  readonly sourceDigest: string;
  readonly observationDigest: string;
  readonly createdAt: string;
}
export interface AgentLoopMaintenanceCanarySourcePolicySource {
  readonly sessionIdentity: object;
  readonly sourceRevision: string;
  readonly databaseRevision: string;
}

export interface AgentLoopMaintenanceCanarySourcePolicyReaderOptions {
  readonly readJob: (runId: string) => unknown;
  readonly releaseOpen: () => unknown;
  readonly sessionOpen: (sessionId: string) => unknown;
  readonly maintenanceEnabled: (sessionId: string) => unknown;
  readonly modeAllowed: (job: PublicMaintenanceJob) => unknown;
  readonly foregroundActive: (sessionId: string) => unknown;
  readonly summarySkillConflict: (job: PublicMaintenanceJob) => unknown;
  readonly readAdmissions: (sessionId: string, parentRunId: string) => unknown;
  readonly readSource: (sessionId: string) => unknown;
}

export type AgentLoopMaintenanceCanaryAdmissionReader =
  AgentLoopMaintenanceCanarySourcePolicyReaderOptions['readAdmissions'];

interface AgentLoopMaintenanceCanaryAdmissionReaderState {
  readonly resolveLedger: () => unknown;
  boundLedger: AgentAdmissionLedger | null;
}

const SOURCE_POLICY_ADMISSION_READERS = new WeakMap<
  AgentLoopMaintenanceCanaryAdmissionReader,
  AgentLoopMaintenanceCanaryAdmissionReaderState
>();

/**
 * Internal lazy reader whose rows can only come from one exact Admission
 * Ledger instance.  General offline source-policy readers may still supply a
 * plain callback, but production claim composition refuses those callbacks.
 */
export function createAgentLoopMaintenanceCanaryAdmissionReaderInternal(
  resolveLedger: () => unknown,
): AgentLoopMaintenanceCanaryAdmissionReader {
  if (typeof resolveLedger !== 'function' || nodeTypes.isProxy(resolveLedger)) {
    throw new Error('agent-loop-maintenance-canary-admission-reader-invalid');
  }
  const state: AgentLoopMaintenanceCanaryAdmissionReaderState = {
    resolveLedger,
    boundLedger: null,
  };
  const reader: AgentLoopMaintenanceCanaryAdmissionReader = Object.freeze(
    (sessionId: string, parentRunId: string) => {
      try {
        const ledger = state.resolveLedger();
        if (!isAgentAdmissionLedgerInstanceInternal(ledger)) return Object.freeze([]);
        if (state.boundLedger === null) state.boundLedger = ledger;
        if (state.boundLedger !== ledger) return Object.freeze([]);
        return Object.freeze(ledger.listMaintenanceForParentRuns(
          sessionId,
          [parentRunId],
        ).map((row) => Object.freeze({
          decisionId: row.decisionId,
          parentRunId: row.parentRunId,
          sessionId: row.sessionId,
          sourceRevision: row.sourceRevision,
          factsTaskKind: row.facts.taskKind,
          decisionTaskKind: row.decision.taskKind,
          policyVersion: row.decision.policyVersion,
          verdict: row.decision.verdict,
          factsDigest: row.decision.factsDigest,
          sourceDigest: row.facts.sourceDigest,
          observationDigest: row.facts.observationDigest,
          createdAt: row.createdAt,
        })));
      } catch {
        return Object.freeze([]);
      }
    },
  );
  SOURCE_POLICY_ADMISSION_READERS.set(reader, state);
  return reader;
}

function isAgentLoopMaintenanceCanaryAdmissionReaderForLedgerInternal(
  value: unknown,
  ledger: AgentAdmissionLedger,
): value is AgentLoopMaintenanceCanaryAdmissionReader {
  if (typeof value !== 'function' || !isAgentAdmissionLedgerInstanceInternal(ledger)) return false;
  const state = SOURCE_POLICY_ADMISSION_READERS.get(
    value as AgentLoopMaintenanceCanaryAdmissionReader,
  );
  if (!state) return false;
  try {
    const current = state.resolveLedger();
    if (current !== ledger) return false;
    if (state.boundLedger === null) state.boundLedger = ledger;
    return state.boundLedger === ledger;
  } catch {
    return false;
  }
}

export interface AgentLoopMaintenanceCanarySourcePolicyProof {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION;
  readonly classification: 'reader-instance-issued-source-policy-read-only';
  readonly productionSource: Readonly<{
    taskKind: 'rolling_summary';
    mode: 'shadow';
    trigger: 'post-turn';
    policyVersion: typeof PRODUCTION_ADMISSION_POLICY_VERSION;
  }>;
  readonly bindings: Readonly<{
    // Byte-compatible with the deliberately narrower §13.82 job binding.
    routePlanJobDigest: string;
    // All public job fields, with absent optional fields represented by null.
    queuedJobDigest: string;
    sourceRevisionDigest: string;
    admissionDigest: string;
    admissionDecisionIdDigest: string;
  }>;
  readonly observations: Readonly<{
    managerJobStable: true;
    releaseOpen: true;
    sessionOpen: true;
    maintenanceEnabled: true;
    modeAllowed: true;
    foregroundInactive: true;
    summarySkillUnbound: true;
    exactAdmissionStable: true;
    loadedSourceStable: true;
  }>;
  readonly compatibility: Readonly<{
    routePlanVersion: typeof ROUTE_PLAN_VERSION;
    routePlanPolicyVersion: typeof ROUTE_PLAN_POLICY_VERSION;
    routePlanCompatible: false;
    reason: 'production-policy-not-selected-by-route-plan-v1';
  }>;
  readonly sourcePolicyVerified: true;
  readonly readinessAuditAccepted: false;
  readonly claimAuthorized: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly publicationAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
  readonly proofDigest: string;
}

export interface AgentLoopMaintenanceCanarySourcePolicyReader {
  read(runId: string): AgentLoopMaintenanceCanarySourcePolicyProof | null;
  isProof(value: unknown): value is AgentLoopMaintenanceCanarySourcePolicyProof;
}

const SOURCE_POLICY_READERS = new WeakSet<object>();
const SOURCE_POLICY_READER_JOB_READERS = new WeakMap<
  object,
  AgentLoopMaintenanceCanarySourcePolicyReaderOptions['readJob']
>();
const SOURCE_POLICY_READER_ADMISSION_READERS = new WeakMap<
  object,
  AgentLoopMaintenanceCanaryAdmissionReader
>();
const SOURCE_POLICY_READER_PROOF_SESSION_IDENTITIES = new WeakMap<
  object,
  WeakMap<object, AgentLoopMaintenanceCanarySourcePolicySessionEvidence>
>();

export interface AgentLoopMaintenanceCanarySourcePolicySessionEvidence {
  readonly sessionIdentity: object;
  readonly sourceRevision: string;
  readonly databaseRevision: string;
}

/** Exact module-issued reader identity; structural lookalikes and Proxies grant nothing. */
export function isAgentLoopMaintenanceCanarySourcePolicyReader(
  value: unknown,
): value is AgentLoopMaintenanceCanarySourcePolicyReader {
  return typeof value === 'object' && value !== null && SOURCE_POLICY_READERS.has(value);
}

/** Exact reader plus the lazy Manager-bound job source captured at construction. */
export function isAgentLoopMaintenanceCanarySourcePolicyReaderForManager(
  value: unknown,
  manager: MaintenanceJobManager,
): value is AgentLoopMaintenanceCanarySourcePolicyReader {
  if (!isAgentLoopMaintenanceCanarySourcePolicyReader(value)) return false;
  const readJob = SOURCE_POLICY_READER_JOB_READERS.get(value);
  return isMaintenanceProductionQueuedJobReaderForManagerInternal(
    readJob as MaintenanceProductionQueuedJobReader | undefined,
    manager,
  );
}

/** Exact source-policy reader plus the Admission Ledger it is allowed to read. */
export function isAgentLoopMaintenanceCanarySourcePolicyReaderForAdmissionLedgerInternal(
  value: unknown,
  ledger: AgentAdmissionLedger,
): value is AgentLoopMaintenanceCanarySourcePolicyReader {
  if (!isAgentLoopMaintenanceCanarySourcePolicyReader(value)) return false;
  return isAgentLoopMaintenanceCanaryAdmissionReaderForLedgerInternal(
    SOURCE_POLICY_READER_ADMISSION_READERS.get(value),
    ledger,
  );
}

/**
 * Internal claim-time binding for the exact loaded Session object observed by
 * this exact reader when it issued `proof`. The identity is deliberately not
 * serialized into the content-free proof or exposed as a public authority.
 */
export function readAgentLoopMaintenanceCanarySourcePolicyProofSessionEvidenceInternal(
  reader: AgentLoopMaintenanceCanarySourcePolicyReader,
  proof: AgentLoopMaintenanceCanarySourcePolicyProof,
): AgentLoopMaintenanceCanarySourcePolicySessionEvidence | null {
  if (!isAgentLoopMaintenanceCanarySourcePolicyReader(reader)
    || !reader.isProof(proof)) return null;
  return SOURCE_POLICY_READER_PROOF_SESSION_IDENTITIES.get(reader)?.get(proof) ?? null;
}

const OPTION_KEYS = Object.freeze([
  'foregroundActive', 'maintenanceEnabled', 'modeAllowed', 'readAdmissions', 'readJob',
  'readSource', 'releaseOpen', 'sessionOpen', 'summarySkillConflict',
]);
const JOB_KEYS = Object.freeze([
  'attempt', 'budget', 'createdAt', 'errorCode', 'finishedAt', 'mode', 'parentRunId',
  'policyVersion', 'proposal', 'runId', 'sessionId', 'sourceRevision', 'startedAt',
  'status', 'taskKind', 'trigger', 'updatedAt',
]);
const JOB_OPTIONAL_KEYS = Object.freeze([
  'budget', 'errorCode', 'finishedAt', 'parentRunId', 'proposal', 'startedAt',
]);
const ADMISSION_KEYS = Object.freeze([
  'createdAt', 'decisionId', 'decisionTaskKind', 'factsDigest', 'factsTaskKind',
  'observationDigest', 'parentRunId', 'policyVersion', 'sessionId', 'sourceDigest',
  'sourceRevision', 'verdict',
]);
const SOURCE_KEYS = Object.freeze(['databaseRevision', 'sessionIdentity', 'sourceRevision']);
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

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
      // Preserve the zero-mutation fast path for ordinary intrinsic Promises,
      // including frozen/non-extensible instances.
      void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
      return;
    }
    if (!originalConstructor || originalConstructor.configurable
      || (Object.hasOwn(originalConstructor, 'value') && originalConstructor.writable === true)) {
      // Promise.prototype.then consults constructor/@@species. A temporary own
      // intrinsic constructor prevents a subclass, foreign realm or hostile
      // configurable constructor hook from executing while the rejection is
      // marked handled. The exact original descriptor is restored synchronously.
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
      || originalConstructor.value !== INTRINSIC_PROMISE) {
      return;
    }
    void INTRINSIC_PROMISE_THEN.call(value, () => undefined, () => undefined);
  } catch {
    // The value is already rejected as an invalid synchronous dependency.
  } finally {
    if (shadowedConstructor) {
      try {
        if (originalConstructor) Object.defineProperty(value, 'constructor', originalConstructor);
        else Reflect.deleteProperty(value, 'constructor');
      } catch {
        // Native non-Proxy Promises have ordinary property semantics. If a
        // hostile runtime breaks restoration, the reader still fails closed.
      }
    }
  }
}

function synchronous(value: unknown): boolean {
  if (!nodeTypes.isPromise(value)) return true;
  observeOrdinaryPromise(value);
  return false;
}

function exactOwnData(
  input: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
      || !synchronous(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string')) return null;
    const actual = ownKeys as string[];
    const optional = new Set(optionalKeys);
    if (actual.some((key) => !keys.includes(key))
      || keys.some((key) => !optional.has(key) && !actual.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined
        || !synchronous(descriptor.value)) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactFunctionOptions(
  input: AgentLoopMaintenanceCanarySourcePolicyReaderOptions,
): AgentLoopMaintenanceCanarySourcePolicyReaderOptions {
  const value = exactOwnData(input, OPTION_KEYS);
  if (!value || OPTION_KEYS.some((key) => typeof value[key] !== 'function'
    || nodeTypes.isProxy(value[key]))) {
    throw new Error('agent-loop-maintenance-canary-source-policy-options-invalid');
  }
  return Object.freeze(value) as unknown as AgentLoopMaintenanceCanarySourcePolicyReaderOptions;
}

function normalizeJob(value: unknown): PublicMaintenanceJob | null {
  const raw = exactOwnData(value, JOB_KEYS, JOB_OPTIONAL_KEYS);
  // Reject optional mutable/runtime fields before the public validator can
  // descend into an attacker-controlled nested value.
  if (!raw
    || Object.hasOwn(raw, 'startedAt')
    || Object.hasOwn(raw, 'finishedAt')
    || Object.hasOwn(raw, 'errorCode')
    || Object.hasOwn(raw, 'budget')
    || Object.hasOwn(raw, 'proposal')
    || !isPublicMaintenanceJob(raw)
    || raw.taskKind !== 'rolling_summary'
    || raw.mode !== 'shadow'
    || raw.trigger !== 'post-turn'
    || raw.policyVersion !== PRODUCTION_ADMISSION_POLICY_VERSION
    || raw.status !== 'queued'
    || raw.attempt !== 0
    || !isSafeOpaqueId(raw.parentRunId)
    || raw.createdAt !== raw.updatedAt) return null;
  return Object.freeze({ ...raw }) as unknown as PublicMaintenanceJob;
}

/**
 * Strict full queued-job binding shared with later offline evidence joins.
 * It accepts only the same pristine p14 production source as this reader and
 * never invokes accessors, Proxy traps or thenables.
 */
export function agentLoopMaintenanceCanarySourcePolicyQueuedJobDigest(
  input: unknown,
): string | null {
  return agentLoopMaintenanceProductionQueuedJobDigest(input);
}

// Kept byte-compatible with §13.82 so the mismatch cannot be blamed on digest drift.
function routePlanJobDigest(job: PublicMaintenanceJob): string {
  return digest({
    runId: job.runId,
    sessionId: job.sessionId,
    taskKind: job.taskKind,
    sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion,
    mode: job.mode,
    status: job.status,
    attempt: job.attempt,
    createdAt: job.createdAt,
  });
}

function normalizeAdmission(value: unknown): AgentLoopMaintenanceCanarySourcePolicyAdmission | null {
  const row = exactOwnData(value, ADMISSION_KEYS);
  if (!row
    || !isSafeOpaqueId(row.decisionId)
    || !isSafeOpaqueId(row.parentRunId)
    || !isSafeOpaqueId(row.sessionId)
    || !isSafeOpaqueId(row.sourceRevision)
    || typeof row.factsTaskKind !== 'string'
    || typeof row.decisionTaskKind !== 'string'
    || !isSafeOpaqueId(row.policyVersion)
    || typeof row.verdict !== 'string'
    || typeof row.factsDigest !== 'string' || !HASH.test(row.factsDigest)
    || typeof row.sourceDigest !== 'string' || !HASH.test(row.sourceDigest)
    || typeof row.observationDigest !== 'string' || !HASH.test(row.observationDigest)
    || typeof row.createdAt !== 'string' || !ISO.test(row.createdAt)
    || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) return null;
  return Object.freeze({ ...row }) as unknown as AgentLoopMaintenanceCanarySourcePolicyAdmission;
}

function denseArray(value: unknown): readonly unknown[] | null {
  try {
    if (!synchronous(value) || !Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > 256) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === 'symbol')) return null;
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined
        || !synchronous(descriptor.value)) return null;
      output.push(descriptor.value);
    }
    if (ownKeys.length !== output.length + 1) return null;
    return Object.freeze(output);
  } catch {
    return null;
  }
}

function exactAdmission(
  value: unknown,
  job: PublicMaintenanceJob,
): AgentLoopMaintenanceCanarySourcePolicyAdmission | null {
  const rows = denseArray(value);
  if (!rows || rows.length < 1 || rows.length > 256) return null;
  const normalized: AgentLoopMaintenanceCanarySourcePolicyAdmission[] = [];
  for (const raw of rows) {
    const row = normalizeAdmission(raw);
    if (!row || row.parentRunId !== job.parentRunId || row.sessionId !== job.sessionId) return null;
    normalized.push(row);
  }
  const matches = normalized.filter((row) => (
    row.sourceRevision === job.sourceRevision
    && row.factsTaskKind === job.taskKind
    && row.decisionTaskKind === job.taskKind
    && row.policyVersion === job.policyVersion
    && row.verdict === 'would-admit'
    && Date.parse(row.createdAt) <= Date.parse(job.createdAt)
  ));
  return matches.length === 1 ? matches[0]! : null;
}

/** Recomputes the canonical admission binding from a frozen claim-time row set. */
export function agentLoopMaintenanceCanarySourcePolicyAdmissionDigest(
  value: unknown,
  jobValue: unknown,
): string | null {
  const job = normalizeJob(jobValue);
  if (!job) return null;
  const admission = exactAdmission(value, job);
  return admission ? digest(admission) : null;
}

function normalizeSource(
  value: unknown,
  expectedSourceRevision: string,
): AgentLoopMaintenanceCanarySourcePolicySource | null {
  const source = exactOwnData(value, SOURCE_KEYS);
  if (!source || !source.sessionIdentity
    || (typeof source.sessionIdentity !== 'object' && typeof source.sessionIdentity !== 'function')
    || nodeTypes.isProxy(source.sessionIdentity)
    || !synchronous(source.sessionIdentity)
    || typeof source.databaseRevision !== 'string' || !HASH.test(source.databaseRevision)
    || !isSafeOpaqueId(source.sourceRevision)
    || source.sourceRevision !== expectedSourceRevision) return null;
  return Object.freeze({
    sessionIdentity: source.sessionIdentity as object,
    sourceRevision: source.sourceRevision as string,
    databaseRevision: source.databaseRevision as string,
  });
}

function sameJob(first: PublicMaintenanceJob, current: PublicMaintenanceJob): boolean {
  const firstDigest = agentLoopMaintenanceProductionQueuedJobDigest(first);
  return firstDigest !== null
    && firstDigest === agentLoopMaintenanceProductionQueuedJobDigest(current);
}

function exactBoolean(value: unknown, expected: boolean): boolean {
  return synchronous(value) && value === expected;
}

function gatesOpen(
  options: AgentLoopMaintenanceCanarySourcePolicyReaderOptions,
  job: PublicMaintenanceJob,
): boolean {
  return exactBoolean(options.releaseOpen(), true)
    && exactBoolean(options.sessionOpen(job.sessionId), true)
    && exactBoolean(options.maintenanceEnabled(job.sessionId), true)
    && exactBoolean(options.modeAllowed(job), true)
    && exactBoolean(options.foregroundActive(job.sessionId), false)
    && exactBoolean(options.summarySkillConflict(job), false);
}

function freezeProof(
  job: PublicMaintenanceJob,
  admission: AgentLoopMaintenanceCanarySourcePolicyAdmission,
  proofs: WeakSet<object>,
): AgentLoopMaintenanceCanarySourcePolicyProof {
  const stable = {
    version: AGENT_LOOP_MAINTENANCE_CANARY_SOURCE_POLICY_PROOF_VERSION,
    classification: 'reader-instance-issued-source-policy-read-only' as const,
    productionSource: Object.freeze({
      taskKind: 'rolling_summary' as const,
      mode: 'shadow' as const,
      trigger: 'post-turn' as const,
      policyVersion: PRODUCTION_ADMISSION_POLICY_VERSION,
    }),
    bindings: Object.freeze({
      routePlanJobDigest: routePlanJobDigest(job),
      queuedJobDigest: agentLoopMaintenanceProductionQueuedJobDigest(job)!,
      sourceRevisionDigest: digest(job.sourceRevision),
      admissionDigest: digest(admission),
      admissionDecisionIdDigest: digest(admission.decisionId),
    }),
    observations: Object.freeze({
      managerJobStable: true as const,
      releaseOpen: true as const,
      sessionOpen: true as const,
      maintenanceEnabled: true as const,
      modeAllowed: true as const,
      foregroundInactive: true as const,
      summarySkillUnbound: true as const,
      exactAdmissionStable: true as const,
      loadedSourceStable: true as const,
    }),
    compatibility: Object.freeze({
      routePlanVersion: ROUTE_PLAN_VERSION,
      routePlanPolicyVersion: ROUTE_PLAN_POLICY_VERSION,
      routePlanCompatible: false as const,
      reason: 'production-policy-not-selected-by-route-plan-v1' as const,
    }),
    sourcePolicyVerified: true as const,
    readinessAuditAccepted: false as const,
    claimAuthorized: false as const,
    executionAuthorized: false as const,
    completionAuthorized: false as const,
    publicationAuthorized: false as const,
    canaryAuthorized: false as const,
    productionEligible: false as const,
  };
  const proof = Object.freeze({ ...stable, proofDigest: digest(stable) });
  proofs.add(proof);
  return proof;
}

// Construction only captures function references; it performs no Manager,
// ledger, Session, Provider, Store or filesystem access.
export function createAgentLoopMaintenanceCanarySourcePolicyReader(
  unsafeOptions: AgentLoopMaintenanceCanarySourcePolicyReaderOptions,
): AgentLoopMaintenanceCanarySourcePolicyReader {
  const options = exactFunctionOptions(unsafeOptions);
  const proofs = new WeakSet<object>();
  const proofSessionIdentities =
    new WeakMap<object, AgentLoopMaintenanceCanarySourcePolicySessionEvidence>();
  const reader: AgentLoopMaintenanceCanarySourcePolicyReader = Object.freeze({
    read(runId: string): AgentLoopMaintenanceCanarySourcePolicyProof | null {
      if (!isSafeOpaqueId(runId)) return null;
      try {
        const firstJob = normalizeJob(options.readJob(runId));
        if (!firstJob || firstJob.runId !== runId || !gatesOpen(options, firstJob)) return null;
        const firstAdmission = exactAdmission(
          options.readAdmissions(firstJob.sessionId, firstJob.parentRunId!),
          firstJob,
        );
        const firstSource = normalizeSource(
          options.readSource(firstJob.sessionId),
          firstJob.sourceRevision,
        );
        if (!firstAdmission || !firstSource) return null;

        const secondJob = normalizeJob(options.readJob(runId));
        if (!secondJob || !sameJob(firstJob, secondJob) || !gatesOpen(options, secondJob)) return null;
        const secondAdmission = exactAdmission(
          options.readAdmissions(secondJob.sessionId, secondJob.parentRunId!),
          secondJob,
        );
        const secondSource = normalizeSource(
          options.readSource(secondJob.sessionId),
          secondJob.sourceRevision,
        );
        if (!secondAdmission || !secondSource
          || digest(firstAdmission) !== digest(secondAdmission)
          || firstSource.sessionIdentity !== secondSource.sessionIdentity
          || firstSource.sourceRevision !== secondSource.sourceRevision
          || firstSource.databaseRevision !== secondSource.databaseRevision) return null;

        // One final Manager read closes mutation during the second ledger/source pass.
        const finalJob = normalizeJob(options.readJob(runId));
        if (!finalJob || !sameJob(firstJob, finalJob)) return null;
        const proof = freezeProof(firstJob, firstAdmission, proofs);
        proofSessionIdentities.set(proof, firstSource);
        return proof;
      } catch {
        return null;
      }
    },
    isProof(value: unknown): value is AgentLoopMaintenanceCanarySourcePolicyProof {
      return typeof value === 'object' && value !== null && proofs.has(value);
    },
  });
  SOURCE_POLICY_READERS.add(reader);
  SOURCE_POLICY_READER_JOB_READERS.set(reader, options.readJob);
  SOURCE_POLICY_READER_ADMISSION_READERS.set(reader, options.readAdmissions);
  SOURCE_POLICY_READER_PROOF_SESSION_IDENTITIES.set(reader, proofSessionIdentities);
  return reader;
}
