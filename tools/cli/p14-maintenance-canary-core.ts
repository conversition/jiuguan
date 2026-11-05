import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENT_CONTROL_APPLICATION_ID,
  AGENT_CONTROL_DB_FILE,
  AGENT_CONTROL_SCHEMA_VERSION,
  AGENT_LANE_OBSERVATION_VERSION,
  AgentControlStore,
} from '../../apps/server/agent-control-store.ts';
import {
  inspectAgentControlAuthoritySchema,
  readAgentControlAuthority,
  readAgentMaintenanceRouteControl,
} from '../../apps/server/agent-control-authority.ts';
import {
  MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE,
  MAINTENANCE_JOB_APPLICATION_ID,
  MAINTENANCE_JOB_DB_FILE,
  MaintenanceJobManager,
  inspectMaintenanceProductionRouteReceiptSchema,
  listMaintenanceProductionRouteReceipts,
  readMaintenanceProductionRouteReceipt,
  type MaintenanceProductionRouteReceipt,
} from '../../apps/server/maintenance-job-manager.ts';
import { MAINTENANCE_JOB_SCHEMA_VERSION } from '../../apps/server/maintenance-job-contract.ts';
import { isMaintenanceMode } from '../../apps/server/maintenance-types.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD,
  agentLoopMaintenanceCanaryRouteBucketV2,
} from '../../apps/server/agent-loop-maintenance-canary-route-plan-v2.ts';
import {
  AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT,
} from '../../apps/server/agent-loop-maintenance-production-route-contract.ts';
import { acquireServerProcessLock } from '../../apps/server/process-lock.ts';
import { P14_LANE_EVAL_VERSION } from '../../packages/harness/src/lane-evaluation.ts';
import {
  loadOperationalLaneEvidence,
  P14_OPERATIONAL_EVIDENCE_BINDING_VERSION,
  type OperationalLaneEvidence,
} from './p14-operational-evidence-import-core.ts';

export const P14_MAINTENANCE_CANARY_ACK = 'p14-maintenance-test-session-v1' as const;
export const P17_MAINTENANCE_PRODUCTION_CANARY_ACK =
  'p17-maintenance-production-canary-5-v1' as const;
export const P14_MAINTENANCE_CANARY_BINDING_VERSION = 'p14-maintenance-canary-binding-v2' as const;

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const STATUS_SNAPSHOT_ATTEMPTS = 3;
const MAINTENANCE_CANARY_RECEIPT_LIMIT = 50 as const;
type SqlRow = Record<string, unknown>;

type MaintenanceCanaryObservedJobStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale';

interface MaintenanceCanaryObservedJob {
  readonly status: MaintenanceCanaryObservedJobStatus;
  readonly finishedAt: string | null;
}

interface MaintenanceCanaryActiveExactJobs {
  readonly queued: number;
  readonly running: number;
}

export type MaintenanceCanaryExitAssessmentState =
  | 'inconclusive'
  | 'awaiting-first-claim'
  | 'running'
  | 'failed'
  | 'succeeded';

export interface MaintenanceCanaryExitAssessment {
  readonly state: MaintenanceCanaryExitAssessmentState;
  readonly observationComplete: boolean;
  readonly allObservedJobsSucceeded: boolean;
  readonly rollbackDrained: boolean;
  /** Lifecycle evidence is diagnostic only and never grants a wider rollout. */
  readonly authorizesPromotion: false;
}

export interface MaintenanceCanaryProductionObservation {
  readonly receiptLimit: typeof MAINTENANCE_CANARY_RECEIPT_LIMIT;
  readonly scannedReceipts: number;
  /** True when the newest session-history summary exceeded the bounded window. */
  readonly historyTruncated: boolean;
  /** True only when the selected exact binding itself exceeded the bounded window. */
  readonly truncated: boolean;
  readonly exactBinding: Readonly<{
    targetSessionId: string;
    evidenceDigest: string;
    routeRevision: number;
  }> | null;
  readonly routeClosed: boolean;
  readonly canaryReceipts: number;
  readonly exactBindingReceipts: number;
  readonly staleBindingReceipts: number;
  readonly jobStates: Readonly<Record<MaintenanceCanaryObservedJobStatus, number>>;
  /**
   * Exact-namespace work not represented by the current route's receipts.
   * Queued work matters only while the route is open; unexplained running work
   * remains visible after close so rollback drain cannot be overstated.
   */
  readonly unobservedExactJobs: Readonly<{
    readonly queued: number;
    readonly running: number;
    readonly total: number;
  }>;
  /** True only after a complete bounded scan found an exact binding and no running receipt. */
  readonly noRunningExactBinding: boolean;
  readonly exitAssessment: MaintenanceCanaryExitAssessment;
  readonly latestExactClaim: Readonly<{
    runId: string;
    receiptDigest: string;
    claimedAt: string;
    status: MaintenanceCanaryObservedJobStatus;
    finishedAt: string | null;
  }> | null;
}

interface MaintenanceEvaluationCoordinate {
  readonly suiteDigest: string;
  readonly evaluationVersion: string;
  readonly evidenceClass: 'fixture' | 'operational';
  readonly passed: 0 | 1;
  readonly capturedAt: string;
  readonly recordedAt: string;
}

interface MaintenanceControlCoordinate {
  readonly authority: ReturnType<typeof readAgentControlAuthority>;
  readonly maintenanceRoute: MaintenanceCanaryStatus['maintenanceRoute'];
  readonly maintenance: MaintenanceCanaryStatus['maintenance'];
  readonly evaluation: MaintenanceEvaluationCoordinate | null;
}

export interface OperationalMaintenanceEvidence
  extends Omit<OperationalLaneEvidence, 'lane' | 'bridgeAccounting'> {
  readonly lane: 'maintenance';
  readonly bridgeAccounting: NonNullable<OperationalLaneEvidence['bridgeAccounting']>;
}

export interface MaintenanceCanaryStatus {
  readonly sessionId: string;
  readonly sessionDatabaseExists: boolean;
  readonly maintenance: ReturnType<AgentControlStore['get']>;
  readonly evidence: ReturnType<AgentControlStore['evidence']>;
  readonly settings: ReturnType<MaintenanceJobManager['settings']>;
  readonly maintenanceRoute: ReturnType<AgentControlStore['maintenanceRouteControl']>;
  readonly productionCanary: Readonly<{
    bucket: number;
    threshold: typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD;
    eligible: boolean;
    selected: boolean;
  }>;
  readonly productionObservation: MaintenanceCanaryProductionObservation;
  readonly evidenceDirectory: string | null;
}

const READ_ONLY_AGENT_ROLLOUT_STATES: readonly MaintenanceCanaryStatus[
  'maintenance'
]['desiredState'][] = Object.freeze([
  'off',
  'shadow',
  'test-session',
  'canary-5',
  'canary-25',
  'canary-50',
  'on',
  'killed',
]);

function requirePlainDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

function requireSessionDatabase(dataDir: string, sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('session-id-invalid');
  const path = join(dataDir, `${sessionId}.db`);
  if (!existsSync(path)) throw new Error('selected-session-database-missing');
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('selected-session-database-invalid');
}

/** Reuse the strict Maintenance v2 suite/run/accounting importer contract. */
export function loadOperationalMaintenanceEvidence(
  evidenceDirectory: string,
  expectedDigest: string,
  expectedSessionId: string,
): OperationalMaintenanceEvidence {
  const evidence = loadOperationalLaneEvidence({
    evidenceDirectory,
    expectedDigest,
    lane: 'maintenance',
    expectedSessionId,
  });
  if (!evidence.bridgeAccounting) throw new Error('maintenance-operational-accounting-required');
  return Object.freeze({
    ...evidence,
    lane: 'maintenance',
    bridgeAccounting: evidence.bridgeAccounting,
  });
}

function ensurePlainDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  requirePlainDirectory(path, 'canary-evidence-destination');
}

function writeImmutableJson(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || readFileSync(path, 'utf8') !== content) {
      throw new Error('canary-evidence-immutable-conflict');
    }
    return;
  }
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) throw error;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function compatibleOperationalImportBinding(
  path: string,
  sessionId: string,
  evidence: OperationalMaintenanceEvidence,
): boolean {
  let value: unknown;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return exactKeys(binding, [
    'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass',
    'accountingDigest', 'activated',
  ])
    && binding.version === P14_OPERATIONAL_EVIDENCE_BINDING_VERSION
    && binding.lane === 'maintenance'
    && binding.sessionId === sessionId
    && binding.suiteDigest === evidence.suiteDigest
    && binding.evidenceClass === 'operational'
    && binding.accountingDigest === evidence.bridgeAccounting.accountingDigest
    && binding.activated === false;
}

function writeCanaryEvidenceBinding(
  path: string,
  sessionId: string,
  evidence: OperationalMaintenanceEvidence,
): void {
  const binding = {
    version: P14_MAINTENANCE_CANARY_BINDING_VERSION,
    lane: 'maintenance',
    sessionId,
    suiteDigest: evidence.suiteDigest,
    evidenceClass: 'operational',
    accountingDigest: evidence.bridgeAccounting.accountingDigest,
  } as const;
  const content = `${JSON.stringify(binding, null, 2)}\n`;
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (stats.isFile() && !stats.isSymbolicLink()
      && (readFileSync(path, 'utf8') === content
        || compatibleOperationalImportBinding(path, sessionId, evidence))) return;
    throw new Error('canary-evidence-immutable-conflict');
  }
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    if (existsSync(path)) {
      const stats = lstatSync(path);
      if (stats.isFile() && !stats.isSymbolicLink()
        && (readFileSync(path, 'utf8') === content
          || compatibleOperationalImportBinding(path, sessionId, evidence))) return;
    }
    throw new Error('canary-evidence-immutable-conflict');
  }
}

function preserveOperationalEvidence(
  dataDir: string,
  sessionId: string,
  evidence: OperationalMaintenanceEvidence,
): string {
  const root = join(dataDir, 'p14-evidence');
  const maintenance = join(root, 'maintenance');
  const destination = join(maintenance, evidence.suiteDigest.slice('sha256:'.length));
  for (const directory of [root, maintenance, destination]) ensurePlainDirectory(directory);
  writeImmutableJson(join(destination, 'suite.json'), evidence.suite);
  writeImmutableJson(join(destination, 'run.json'), evidence.run);
  writeImmutableJson(join(destination, 'evaluation.json'), evidence.evaluation);
  writeImmutableJson(join(destination, 'bridge-accounting.json'), evidence.bridgeAccounting);
  writeCanaryEvidenceBinding(join(destination, 'binding.json'), sessionId, evidence);
  return destination;
}

function canaryReceiptBinding(
  receipt: Readonly<MaintenanceProductionRouteReceipt>,
  sessionId: string,
): MaintenanceCanaryProductionObservation['exactBinding'] {
  const decision = receipt.decision;
  if (decision.routeBasis !== 'audited-canary'
    || decision.executorRoute !== 'agent-loop'
    || decision.routeControlState !== 'canary-5'
    || decision.routeControlTargetSessionId !== sessionId
    || typeof decision.routeControlEvidenceDigest !== 'string'
    || !SHA256_RE.test(decision.routeControlEvidenceDigest)
    || !Number.isSafeInteger(decision.routeControlRevision)
    || Number(decision.routeControlRevision) < 0) return null;
  return Object.freeze({
    targetSessionId: sessionId,
    evidenceDigest: decision.routeControlEvidenceDigest,
    routeRevision: Number(decision.routeControlRevision),
  });
}

function activeCanaryBinding(
  sessionId: string,
  route: MaintenanceCanaryStatus['maintenanceRoute'],
): MaintenanceCanaryProductionObservation['exactBinding'] {
  if (route.state !== 'canary-5'
    || route.targetSessionId !== sessionId
    || typeof route.evidenceDigest !== 'string'
    || !SHA256_RE.test(route.evidenceDigest)
    || !Number.isSafeInteger(route.revision)
    || route.revision < 0) return null;
  return Object.freeze({
    targetSessionId: sessionId,
    evidenceDigest: route.evidenceDigest,
    routeRevision: route.revision,
  });
}

function sameCanaryBinding(
  left: NonNullable<MaintenanceCanaryProductionObservation['exactBinding']>,
  right: NonNullable<MaintenanceCanaryProductionObservation['exactBinding']>,
): boolean {
  return left.targetSessionId === right.targetSessionId
    && left.evidenceDigest === right.evidenceDigest
    && left.routeRevision === right.routeRevision;
}

function latestMaintenanceProductionRouteReceiptBinding(
  db: DatabaseSync,
  sessionId: string,
): MaintenanceCanaryProductionObservation['exactBinding'] {
  const row = db.prepare(`
    SELECT r.run_id
    FROM ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} r
    JOIN maintenance_job j ON j.run_id=r.run_id
    WHERE j.session_id=?
      AND json_extract(r.receipt_json,'$.decision.routeBasis')='audited-canary'
      AND json_extract(r.receipt_json,'$.decision.executorRoute')='agent-loop'
      AND json_extract(r.receipt_json,'$.decision.routeControlState')='canary-5'
      AND json_extract(r.receipt_json,'$.decision.routeControlTargetSessionId')=?
    ORDER BY CAST(json_extract(
      r.receipt_json,'$.decision.routeControlRevision'
    ) AS INTEGER) DESC,r.claimed_at DESC,r.run_id DESC
    LIMIT 1
  `).get(sessionId, sessionId) as SqlRow | undefined;
  if (!row) return null;
  const receipt = readMaintenanceProductionRouteReceipt(db, row.run_id as string);
  if (!receipt) throw new Error('maintenance-canary-historical-receipt-missing');
  const binding = canaryReceiptBinding(receipt, sessionId);
  if (binding === null) {
    throw new Error('maintenance-canary-historical-receipt-binding-invalid');
  }
  return binding;
}

function listMaintenanceProductionRouteReceiptsForBinding(
  db: DatabaseSync,
  sessionId: string,
  binding: NonNullable<MaintenanceCanaryProductionObservation['exactBinding']>,
): readonly Readonly<MaintenanceProductionRouteReceipt>[] {
  const rows = db.prepare(`
    SELECT r.run_id
    FROM ${MAINTENANCE_PRODUCTION_ROUTE_RECEIPT_TABLE} r
    JOIN maintenance_job j ON j.run_id=r.run_id
    WHERE j.session_id=?
      AND json_extract(r.receipt_json,'$.decision.routeBasis')='audited-canary'
      AND json_extract(r.receipt_json,'$.decision.executorRoute')='agent-loop'
      AND json_extract(r.receipt_json,'$.decision.routeControlState')='canary-5'
      AND json_extract(r.receipt_json,'$.decision.routeControlTargetSessionId')=?
      AND json_extract(r.receipt_json,'$.decision.routeControlEvidenceDigest')=?
      AND json_extract(r.receipt_json,'$.decision.routeControlRevision')=?
    ORDER BY r.claimed_at DESC,r.run_id DESC
    LIMIT ?
  `).all(
    sessionId,
    binding.targetSessionId,
    binding.evidenceDigest,
    binding.routeRevision,
    MAINTENANCE_CANARY_RECEIPT_LIMIT + 1,
  ) as SqlRow[];
  return Object.freeze(rows.map((row) => {
    const receipt = readMaintenanceProductionRouteReceipt(db, row.run_id as string);
    if (!receipt) throw new Error('maintenance-canary-exact-receipt-missing');
    const observedBinding = canaryReceiptBinding(receipt, sessionId);
    if (observedBinding === null || !sameCanaryBinding(observedBinding, binding)) {
      throw new Error('maintenance-canary-exact-receipt-binding-invalid');
    }
    return receipt;
  }));
}

function normalizeObservedJob(
  row: SqlRow,
  receipt: Readonly<MaintenanceProductionRouteReceipt>,
): MaintenanceCanaryObservedJob {
  const statusValue = row.status;
  if (statusValue !== 'running'
    && statusValue !== 'succeeded'
    && statusValue !== 'failed'
    && statusValue !== 'cancelled'
    && statusValue !== 'stale') {
    throw new Error('maintenance-canary-receipt-job-status-invalid');
  }
  if (row.run_id !== receipt.runId
    || row.attempt !== 1
    || row.started_at !== receipt.claimedAt) {
    throw new Error('maintenance-canary-receipt-job-claim-binding-invalid');
  }
  if (statusValue === 'running') {
    if (row.finished_at !== null
      || row.error_code !== null
      || typeof row.lease_owner_instance_id !== 'string'
      || !TOKEN_RE.test(row.lease_owner_instance_id)) {
      throw new Error('maintenance-canary-running-job-state-invalid');
    }
    controlTimestamp(row.lease_expires_at, 'maintenance-canary-running-job-lease-expires-at');
    return Object.freeze({ status: statusValue, finishedAt: null });
  }
  const finishedAt = controlTimestamp(
    row.finished_at,
    'maintenance-canary-terminal-job-finished-at',
  );
  if (Date.parse(finishedAt) < Date.parse(receipt.claimedAt)
    || row.lease_owner_instance_id !== null
    || row.lease_expires_at !== null
    || (statusValue === 'failed'
      ? typeof row.error_code !== 'string' || !TOKEN_RE.test(row.error_code)
      : row.error_code !== null)) {
    throw new Error('maintenance-canary-terminal-job-state-invalid');
  }
  return Object.freeze({ status: statusValue, finishedAt });
}

function buildMaintenanceCanaryExitAssessment(input: Readonly<{
  truncated: boolean;
  exactBinding: MaintenanceCanaryProductionObservation['exactBinding'];
  routeClosed: boolean;
  exactBindingReceipts: number;
  states: Readonly<Record<MaintenanceCanaryObservedJobStatus, number>>;
  unobservedExactJobs: MaintenanceCanaryProductionObservation['unobservedExactJobs'];
}>): MaintenanceCanaryExitAssessment {
  const nonSuccess = input.states.failed + input.states.cancelled + input.states.stale;
  let state: MaintenanceCanaryExitAssessmentState;
  if (nonSuccess > 0) state = 'failed';
  else if (input.states.running > 0) state = 'running';
  else if (input.exactBinding === null || input.truncated) state = 'inconclusive';
  else if (!input.routeClosed && input.unobservedExactJobs.running > 0) state = 'inconclusive';
  else if (input.exactBindingReceipts === 0) state = 'awaiting-first-claim';
  else if (!input.routeClosed && input.unobservedExactJobs.total > 0) state = 'inconclusive';
  else if (input.states.succeeded === input.exactBindingReceipts) state = 'succeeded';
  else state = 'inconclusive';

  const observationComplete = input.exactBinding !== null
    && !input.truncated
    && input.exactBindingReceipts > 0
    && input.states.running === 0
    && input.unobservedExactJobs.total === 0;
  return Object.freeze({
    state,
    observationComplete,
    allObservedJobsSucceeded: observationComplete && state === 'succeeded',
    rollbackDrained: input.routeClosed
      && input.exactBinding !== null
      && !input.truncated
      && input.exactBindingReceipts > 0
      && input.states.running === 0
      && input.unobservedExactJobs.running === 0,
    authorizesPromotion: false,
  });
}

function buildMaintenanceProductionObservation(input: {
  sessionId: string;
  maintenanceRoute: MaintenanceCanaryStatus['maintenanceRoute'];
  receipts: readonly Readonly<MaintenanceProductionRouteReceipt>[];
  exactBinding: MaintenanceCanaryProductionObservation['exactBinding'];
  exactReceipts: readonly Readonly<MaintenanceProductionRouteReceipt>[];
  readJob: (receipt: Readonly<MaintenanceProductionRouteReceipt>) => MaintenanceCanaryObservedJob;
  activeExactJobs: MaintenanceCanaryActiveExactJobs;
}): MaintenanceCanaryProductionObservation {
  const historyTruncated = input.receipts.length > MAINTENANCE_CANARY_RECEIPT_LIMIT;
  const receipts = input.receipts.slice(0, MAINTENANCE_CANARY_RECEIPT_LIMIT);
  const canaryReceipts = receipts.flatMap((receipt) => {
    const binding = canaryReceiptBinding(receipt, input.sessionId);
    return binding === null ? [] : [{ receipt, binding }];
  });
  const activeBinding = activeCanaryBinding(input.sessionId, input.maintenanceRoute);
  const exactBinding = input.exactBinding;
  const truncated = input.exactReceipts.length > MAINTENANCE_CANARY_RECEIPT_LIMIT;
  const exactReceipts = input.exactReceipts.slice(0, MAINTENANCE_CANARY_RECEIPT_LIMIT);
  const states: Record<MaintenanceCanaryObservedJobStatus, number> = {
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    stale: 0,
  };
  let latestExactClaim: MaintenanceCanaryProductionObservation['latestExactClaim'] = null;
  for (const receipt of exactReceipts) {
    const job = input.readJob(receipt);
    states[job.status] += 1;
    if (latestExactClaim === null) {
      latestExactClaim = Object.freeze({
        runId: receipt.runId,
        receiptDigest: receipt.receiptDigest,
        claimedAt: receipt.claimedAt,
        status: job.status,
        finishedAt: job.finishedAt,
      });
    }
  }
  const routeClosed = exactBinding === null
    || activeBinding === null
    || !sameCanaryBinding(activeBinding, exactBinding);
  if (states.running > input.activeExactJobs.running) {
    throw new Error('maintenance-canary-active-job-observation-invalid');
  }
  const queued = routeClosed ? 0 : input.activeExactJobs.queued;
  const running = input.activeExactJobs.running - states.running;
  const unobservedExactJobs = Object.freeze({
    queued,
    running,
    total: queued + running,
  });
  const frozenStates = Object.freeze({ ...states });
  return Object.freeze({
    receiptLimit: MAINTENANCE_CANARY_RECEIPT_LIMIT,
    scannedReceipts: receipts.length,
    historyTruncated,
    truncated,
    exactBinding,
    routeClosed,
    canaryReceipts: canaryReceipts.length,
    exactBindingReceipts: exactReceipts.length,
    staleBindingReceipts: exactBinding === null
      ? canaryReceipts.length
      : canaryReceipts.filter(({ binding }) => !sameCanaryBinding(binding, exactBinding)).length,
    jobStates: frozenStates,
    unobservedExactJobs,
    noRunningExactBinding: exactBinding !== null && !truncated && states.running === 0,
    exitAssessment: buildMaintenanceCanaryExitAssessment({
      truncated,
      exactBinding,
      routeClosed,
      exactBindingReceipts: exactReceipts.length,
      states: frozenStates,
      unobservedExactJobs,
    }),
    latestExactClaim,
  });
}

function hasMaintenanceProductionCanaryBacklog(
  manager: MaintenanceJobManager,
  sessionId: string,
): boolean {
  const admission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
  return manager.listActiveForSession(sessionId).some((job) => (
    job.taskKind === admission.taskKind
    && job.policyVersion === admission.policyVersion
    && job.trigger === admission.trigger
    && job.mode === admission.mode
    && typeof job.parentRunId === 'string'
  ));
}

/**
 * `activate` is the explicit operator review boundary for the one production canary route:
 * it requires the production ACK and revalidates an immutable operational evidence suite.
 * Completing the qualifying-sample review must also advance the lane so runtime admission
 * can execute the selected route. Quota exhaustion/reservation and every safety/quality denial
 * remain fail-closed.
 */
function maintenanceProductionCanaryAdmissionState(
  store: AgentControlStore,
  sessionId: string,
): 'test-session' | 'canary-5' | null {
  const decision = store.decide('maintenance', sessionId, 'test-session');
  if (decision.allowed) return 'test-session';
  const window = store.authorizationWindow('maintenance');
  const reviewOnly = !decision.shouldKill
    && decision.effectiveState === 'test-session'
    && decision.reasonCodes.length === 2
    && decision.reasonCodes[0] === 'test-session-review-required'
    && decision.reasonCodes[1] === 'test-session-sample-target-reached';
  const providerAttempts = window.providerCalls + window.providerErrors;
  return reviewOnly
    && providerAttempts + window.reservedProviderCalls < window.maxProviderCalls
    ? 'canary-5' : null;
}

function buildMaintenanceCanaryStatus(input: {
  dataDir: string;
  sessionId: string;
  maintenance: MaintenanceCanaryStatus['maintenance'];
  evidence: MaintenanceCanaryStatus['evidence'];
  settings: MaintenanceCanaryStatus['settings'];
  maintenanceRoute: MaintenanceCanaryStatus['maintenanceRoute'];
  productionObservation: MaintenanceCanaryProductionObservation;
  evaluationSuiteDigest: string | null;
  evidenceDirectory?: string;
}): MaintenanceCanaryStatus {
  const bucket = agentLoopMaintenanceCanaryRouteBucketV2(input.sessionId);
  const eligible = bucket < AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD;
  const passingEvaluationDigest = input.evidence.operationalEvaluationPassed
    ? input.evaluationSuiteDigest : null;
  const evaluatedEvidenceDirectory = passingEvaluationDigest === null
    ? null
    : join(
      input.dataDir,
      'p14-evidence',
      'maintenance',
      passingEvaluationDigest.slice('sha256:'.length),
    );
  let evidenceDirectory = input.evidenceDirectory ?? null;
  if (input.evidenceDirectory === undefined && evaluatedEvidenceDirectory !== null
    && existsSync(evaluatedEvidenceDirectory)) {
    const stats = lstatSync(evaluatedEvidenceDirectory);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      evidenceDirectory = evaluatedEvidenceDirectory;
    }
  }
  return Object.freeze({
    sessionId: input.sessionId,
    sessionDatabaseExists: existsSync(join(input.dataDir, `${input.sessionId}.db`)),
    maintenance: input.maintenance,
    evidence: input.evidence,
    settings: input.settings,
    maintenanceRoute: input.maintenanceRoute,
    productionCanary: Object.freeze({
      bucket,
      threshold: AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD,
      eligible,
      selected: eligible
        && passingEvaluationDigest !== null
        && input.maintenanceRoute.state === 'canary-5'
        && input.maintenanceRoute.targetSessionId === input.sessionId
        && input.maintenanceRoute.evidenceDigest === passingEvaluationDigest,
    }),
    productionObservation: input.productionObservation,
    evidenceDirectory,
  });
}

function statusFromStores(
  dataDir: string,
  sessionId: string,
  store: AgentControlStore,
  manager: MaintenanceJobManager,
  evaluationSuiteDigest: string,
  evidenceDirectory?: string,
): MaintenanceCanaryStatus {
  const maintenanceRoute = store.maintenanceRouteControl();
  const observationDb = openReadOnlyDatabase(
    join(dataDir, MAINTENANCE_JOB_DB_FILE),
    'maintenance',
  );
  let productionObservation: MaintenanceCanaryProductionObservation;
  try {
    productionObservation = readTransaction(
      observationDb,
      () => readMaintenanceProductionObservation(
        observationDb,
        sessionId,
        maintenanceRoute,
      ),
    );
  } finally {
    observationDb.close();
  }
  return buildMaintenanceCanaryStatus({
    dataDir,
    sessionId,
    maintenance: store.get('maintenance'),
    evidence: store.evidence('maintenance'),
    settings: manager.settings(sessionId),
    maintenanceRoute,
    productionObservation,
    evaluationSuiteDigest,
    ...(evidenceDirectory === undefined ? {} : { evidenceDirectory }),
  });
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}-invalid`);
  return Number(value);
}

function percentile(
  rows: readonly SqlRow[],
  total: number,
  ratio: number,
): number {
  if (total === 0) return 0;
  const target = Math.ceil(total * ratio);
  let cumulative = 0;
  for (const value of rows) {
    cumulative += Number(value.sample_count);
    if (cumulative >= target) return Number(value.bucket_upper_ms);
  }
  return Number(rows.at(-1)?.bucket_upper_ms ?? 0);
}

function readPragma(
  db: DatabaseSync,
  name: 'application_id' | 'user_version',
  label: string,
): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) throw new Error(`${label}-database-metadata-invalid`);
  return Number(value);
}

function openReadOnlyDatabase(path: string, label: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`${label}-database-missing`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}-database-invalid`);
  return new DatabaseSync(path, { readOnly: true });
}

function readMaintenanceControl(db: DatabaseSync): MaintenanceCanaryStatus['maintenance'] {
  const rows = db.prepare(`
    SELECT lane,desired_state,killed_reason,updated_at
    FROM agent_lane_control WHERE lane='maintenance'
  `).all() as SqlRow[];
  const row = rows[0];
  if (rows.length !== 1 || row?.lane !== 'maintenance'
    || typeof row.desired_state !== 'string'
    || !READ_ONLY_AGENT_ROLLOUT_STATES.includes(
      row.desired_state as MaintenanceCanaryStatus['maintenance']['desiredState'],
    )
    || typeof row.updated_at !== 'string'
    || !Number.isFinite(Date.parse(row.updated_at))
    || new Date(row.updated_at).toISOString() !== row.updated_at) {
    throw new Error('agent-control-row-invalid');
  }
  return Object.freeze({
    lane: 'maintenance',
    desiredState: row.desired_state as MaintenanceCanaryStatus['maintenance']['desiredState'],
    killedReason: typeof row.killed_reason === 'string' ? row.killed_reason : null,
    revision: row.updated_at,
  });
}

function controlTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function readMaintenanceEvaluation(
  db: DatabaseSync,
): MaintenanceEvaluationCoordinate | null {
  const rows = db.prepare(`
    SELECT lane,suite_digest,evaluation_version,evidence_class,passed,captured_at,recorded_at
    FROM agent_lane_evaluation WHERE lane='maintenance'
  `).all() as SqlRow[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const passed = Number(row.passed);
  if (rows.length !== 1 || row.lane !== 'maintenance'
    || typeof row.suite_digest !== 'string' || !SHA256_RE.test(row.suite_digest)
    || typeof row.evaluation_version !== 'string' || !TOKEN_RE.test(row.evaluation_version)
    || (row.evidence_class !== 'fixture' && row.evidence_class !== 'operational')
    || !Number.isSafeInteger(passed) || (passed !== 0 && passed !== 1)
    || (row.evidence_class === 'fixture' && passed !== 0)) {
    throw new Error('agent-control-maintenance-evaluation-invalid');
  }
  const capturedAt = controlTimestamp(row.captured_at, 'evaluation-captured-at');
  const recordedAt = controlTimestamp(row.recorded_at, 'evaluation-recorded-at');
  if (Date.parse(capturedAt) > Date.parse(recordedAt)) {
    throw new Error('agent-control-maintenance-evaluation-invalid');
  }
  return Object.freeze({
    suiteDigest: row.suite_digest,
    evaluationVersion: row.evaluation_version,
    evidenceClass: row.evidence_class,
    passed: passed as 0 | 1,
    capturedAt,
    recordedAt,
  });
}

function readMaintenanceAuthorizationWindow(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT * FROM agent_lane_authorization_window
    WHERE lane='maintenance' ORDER BY window_sequence DESC LIMIT 1
  `).get() as SqlRow | undefined;
  if (!row) throw new Error('agent-authorization-window-missing');
  const storedStatus = row.status === 'active' || row.status === 'review'
    ? row.status : (() => { throw new Error('authorization-window-status-invalid'); })();
  const sequence = nonNegative(row.window_sequence, 'window-sequence');
  const latencyRows = db.prepare(`
    SELECT bucket_upper_ms,sample_count FROM agent_lane_authorization_window_latency
    WHERE lane='maintenance' AND window_sequence=? ORDER BY bucket_upper_ms ASC
  `).all(sequence) as SqlRow[];
  const latencyTotal = latencyRows.reduce((sum, value) => sum + Number(value.sample_count), 0);
  const supersededAt = typeof row.superseded_at === 'string' ? row.superseded_at : null;
  return Object.freeze({
    providerCalls: nonNegative(row.provider_calls, 'window-provider-calls'),
    reservedProviderCalls: nonNegative(row.reserved_provider_calls, 'window-reserved-calls'),
    providerErrors: nonNegative(row.provider_errors, 'window-provider-errors'),
    invalidCalls: nonNegative(row.invalid_calls, 'window-invalid-calls'),
    qualifyingSamples: nonNegative(row.qualifying_samples, 'window-qualifying-samples'),
    latencySamples: nonNegative(latencyTotal, 'window-latency-samples'),
    p50LatencyMs: percentile(latencyRows, latencyTotal, 0.50),
    p95LatencyMs: percentile(latencyRows, latencyTotal, 0.95),
    maxProviderCalls: nonNegative(row.max_provider_calls, 'window-max-calls'),
    sequence,
    status: supersededAt ? 'superseded' as const : storedStatus,
  });
}

function readMaintenanceEvidence(
  db: DatabaseSync,
  evaluation: MaintenanceEvaluationCoordinate | null,
): MaintenanceCanaryStatus['evidence'] {
  const row = db.prepare(`
    SELECT COALESCE(SUM(provider_calls),0) AS calls,COALESCE(SUM(provider_errors),0) AS errors,
      COALESCE(SUM(invalid_calls),0) AS invalid,
      COALESCE(SUM(player_sovereignty_violations),0) AS sovereignty,
      COALESCE(SUM(unauthorized_or_stale_writes),0) AS stale_writes,
      COALESCE(SUM(duplicate_writes),0) AS duplicate_writes,
      COALESCE(SUM(sensitive_audit_violations),0) AS sensitive
    FROM agent_lane_daily_observation
    WHERE lane='maintenance' AND observation_version=?
  `).get(AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
  const samples = db.prepare(`
    SELECT COUNT(*) AS samples,COUNT(DISTINCT day) AS days
    FROM agent_lane_qualifying_sample
    WHERE lane='maintenance' AND observation_version=?
  `).get(AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
  const latencyRows = db.prepare(`
    SELECT bucket_upper_ms,sample_count FROM agent_lane_latency_histogram
    WHERE lane='maintenance' AND observation_version=? ORDER BY bucket_upper_ms ASC
  `).all(AGENT_LANE_OBSERVATION_VERSION) as SqlRow[];
  const correction = db.prepare(`
    SELECT COALESCE(SUM(corrected_player_sovereignty_violations),0) AS corrected
    FROM agent_lane_known_defect_correction
    WHERE lane='maintenance' AND source_observation_version=?
  `).get(AGENT_LANE_OBSERVATION_VERSION) as SqlRow;
  const correctedSovereignty = Number(correction.corrected);
  const rawSovereignty = Number(row.sovereignty);
  if (!Number.isSafeInteger(correctedSovereignty) || correctedSovereignty < 0
    || correctedSovereignty > rawSovereignty) {
    throw new Error('known-defect-correction-accounting-invalid');
  }
  const latencyTotal = latencyRows.reduce((sum, value) => sum + Number(value.sample_count), 0);
  const window = readMaintenanceAuthorizationWindow(db);
  return Object.freeze({
    observationVersion: AGENT_LANE_OBSERVATION_VERSION,
    operationalEvaluationPassed: evaluation?.evidenceClass === 'operational'
      && evaluation.passed === 1,
    qualifyingSamples: Number(samples.samples),
    observationDays: Number(samples.days),
    providerCalls: Number(row.calls),
    providerErrors: Number(row.errors),
    invalidCalls: Number(row.invalid),
    p50LatencyMs: percentile(latencyRows, latencyTotal, 0.50),
    p95LatencyMs: percentile(latencyRows, latencyTotal, 0.95),
    playerSovereigntyViolations: rawSovereignty - correctedSovereignty,
    unauthorizedOrStaleWrites: Number(row.stale_writes),
    duplicateWrites: Number(row.duplicate_writes),
    sensitiveAuditViolations: Number(row.sensitive),
    authorizationWindowCalls: window.providerCalls,
    authorizationWindowReservedCalls: window.reservedProviderCalls,
    authorizationWindowProviderErrors: window.providerErrors,
    authorizationWindowInvalidCalls: window.invalidCalls,
    authorizationWindowQualifyingSamples: window.qualifyingSamples,
    authorizationWindowLatencySamples: window.latencySamples,
    authorizationWindowP50LatencyMs: window.p50LatencyMs,
    authorizationWindowP95LatencyMs: window.p95LatencyMs,
    authorizationWindowMaxCalls: window.maxProviderCalls,
    authorizationWindowSequence: window.sequence,
  });
}

function readMaintenanceSettings(
  db: DatabaseSync,
  sessionId: string,
): MaintenanceCanaryStatus['settings'] {
  const rows = db.prepare(`
    SELECT singleton,global_enabled,default_mode,updated_at FROM maintenance_settings
  `).all() as SqlRow[];
  const global = rows[0];
  if (rows.length !== 1 || global?.singleton !== 1
    || (global.global_enabled !== 0 && global.global_enabled !== 1)
    || !isMaintenanceMode(global.default_mode)) {
    throw new Error('maintenance-settings-invalid');
  }
  const local = db.prepare(
    'SELECT enabled FROM maintenance_session_settings WHERE session_id=?',
  ).get(sessionId) as SqlRow | undefined;
  if (local && local.enabled !== 0 && local.enabled !== 1) {
    throw new Error('maintenance-session-settings-invalid');
  }
  const globalEnabled = global.global_enabled === 1;
  const sessionEnabled = local?.enabled !== 0;
  return {
    globalEnabled,
    defaultMode: global.default_mode,
    sessionEnabled,
    effectiveEnabled: globalEnabled && sessionEnabled,
  };
}

function readMaintenanceProductionObservation(
  db: DatabaseSync,
  sessionId: string,
  maintenanceRoute: MaintenanceCanaryStatus['maintenanceRoute'],
): MaintenanceCanaryProductionObservation {
  const admission = AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT.jobAdmission;
  const activeRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running_count
    FROM maintenance_job
    WHERE session_id=? AND status IN ('queued','running')
      AND task_kind=? AND policy_version=? AND trigger_kind=? AND mode=?
      AND parent_run_id IS NOT NULL
  `).get(
    sessionId,
    admission.taskKind,
    admission.policyVersion,
    admission.trigger,
    admission.mode,
  ) as SqlRow | undefined;
  if (!activeRow) throw new Error('maintenance-canary-active-job-observation-missing');
  const activeExactJobs = Object.freeze({
    queued: nonNegative(activeRow.queued_count ?? 0, 'maintenance-canary-active-queued-count'),
    running: nonNegative(activeRow.running_count ?? 0, 'maintenance-canary-active-running-count'),
  });
  const receipts = listMaintenanceProductionRouteReceipts(
    db,
    sessionId,
    MAINTENANCE_CANARY_RECEIPT_LIMIT + 1,
  );
  const activeBinding = activeCanaryBinding(sessionId, maintenanceRoute);
  const historicalBinding = activeBinding === null
    ? latestMaintenanceProductionRouteReceiptBinding(db, sessionId)
    : null;
  const exactBinding = activeBinding ?? historicalBinding;
  const exactReceipts = exactBinding === null
    ? Object.freeze([] as Readonly<MaintenanceProductionRouteReceipt>[])
    : listMaintenanceProductionRouteReceiptsForBinding(db, sessionId, exactBinding);
  const readJob = db.prepare(`
    SELECT run_id,status,attempt,started_at,finished_at,error_code,
      lease_owner_instance_id,lease_expires_at
    FROM maintenance_job
    WHERE run_id=? AND session_id=?
  `);
  return buildMaintenanceProductionObservation({
    sessionId,
    maintenanceRoute,
    receipts,
    exactBinding,
    exactReceipts,
    activeExactJobs,
    readJob: (receipt) => {
      const row = readJob.get(receipt.runId, sessionId) as SqlRow | undefined;
      if (!row) throw new Error('maintenance-canary-receipt-job-missing');
      return normalizeObservedJob(row, receipt);
    },
  });
}

function readTransaction<T>(db: DatabaseSync, read: () => T): T {
  db.exec('BEGIN DEFERRED');
  try {
    const result = read();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* preserve the read error */ }
    throw error;
  }
}

function readMaintenanceControlCoordinate(db: DatabaseSync): MaintenanceControlCoordinate {
  return Object.freeze({
    authority: readAgentControlAuthority(db),
    maintenanceRoute: readAgentMaintenanceRouteControl(db),
    maintenance: readMaintenanceControl(db),
    evaluation: readMaintenanceEvaluation(db),
  });
}

function readMaintenanceControlSnapshot(db: DatabaseSync): Readonly<{
  coordinate: MaintenanceControlCoordinate;
  evidence: MaintenanceCanaryStatus['evidence'];
}> {
  return readTransaction(db, () => {
    const coordinate = readMaintenanceControlCoordinate(db);
    return Object.freeze({
      coordinate,
      evidence: readMaintenanceEvidence(db, coordinate.evaluation),
    });
  });
}

function statusFromReadOnlyDatabases(dataDir: string, sessionId: string): MaintenanceCanaryStatus {
  const control = openReadOnlyDatabase(join(dataDir, AGENT_CONTROL_DB_FILE), 'agent-control');
  let maintenance: DatabaseSync | undefined;
  try {
    if (readPragma(control, 'application_id', 'agent-control') !== AGENT_CONTROL_APPLICATION_ID
      || readPragma(control, 'user_version', 'agent-control') !== AGENT_CONTROL_SCHEMA_VERSION) {
      throw new Error('agent-control-database-metadata-mismatch');
    }
    inspectAgentControlAuthoritySchema(control);
    maintenance = openReadOnlyDatabase(join(dataDir, MAINTENANCE_JOB_DB_FILE), 'maintenance');
    if (readPragma(maintenance, 'application_id', 'maintenance')
        !== MAINTENANCE_JOB_APPLICATION_ID
      || readPragma(maintenance, 'user_version', 'maintenance')
        !== MAINTENANCE_JOB_SCHEMA_VERSION) {
      throw new Error('maintenance-database-metadata-mismatch');
    }
    inspectMaintenanceProductionRouteReceiptSchema(maintenance);
    for (let attempt = 0; attempt < STATUS_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const first = readMaintenanceControlSnapshot(control);
      const managerSnapshot = readTransaction(
        maintenance,
        () => Object.freeze({
          settings: readMaintenanceSettings(maintenance!, sessionId),
          productionObservation: readMaintenanceProductionObservation(
            maintenance!,
            sessionId,
            first.coordinate.maintenanceRoute,
          ),
        }),
      );
      const second = readTransaction(
        control,
        () => readMaintenanceControlCoordinate(control),
      );
      if (isDeepStrictEqual(first.coordinate, second)) {
        return buildMaintenanceCanaryStatus({
          dataDir,
          sessionId,
          maintenance: first.coordinate.maintenance,
          evidence: first.evidence,
          settings: managerSnapshot.settings,
          maintenanceRoute: first.coordinate.maintenanceRoute,
          productionObservation: managerSnapshot.productionObservation,
          evaluationSuiteDigest: first.coordinate.evaluation?.suiteDigest ?? null,
        });
      }
    }
    throw new Error('maintenance-canary-status-control-changed');
  } finally {
    try { maintenance?.close(); } finally { control.close(); }
  }
}

export function maintenanceCanaryStatus(dataDirectory: string, sessionId: string): MaintenanceCanaryStatus {
  const dataDir = resolve(dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('session-id-invalid');
  return statusFromReadOnlyDatabases(dataDir, sessionId);
}

export function prepareMaintenanceCanary(input: {
  dataDirectory: string;
  evidenceDirectory: string;
  expectedDigest: string;
  sessionId: string;
  acknowledgement: string;
}): MaintenanceCanaryStatus {
  if (input.acknowledgement !== P14_MAINTENANCE_CANARY_ACK) {
    throw new Error(`prepare requires --ack ${P14_MAINTENANCE_CANARY_ACK}`);
  }
  const dataDir = resolve(input.dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  requireSessionDatabase(dataDir, input.sessionId);
  const evidence = loadOperationalMaintenanceEvidence(
    input.evidenceDirectory,
    input.expectedDigest,
    input.sessionId,
  );
  const store = new AgentControlStore({ dataDir });
  const manager = new MaintenanceJobManager({ dataDir });
  let configurationStarted = false;
  try {
    if (store.maintenanceRouteControl().state !== 'off') {
      throw new Error('maintenance-production-route-must-be-off');
    }
    if (store.get('maintenance').desiredState === 'killed') {
      throw new Error('maintenance-lane-killed-clear-explicitly-first');
    }
    // Fail closed while the two independent control databases are updated.
    configurationStarted = true;
    manager.setGlobalEnabled(false);
    const destination = preserveOperationalEvidence(dataDir, input.sessionId, evidence);
    store.recordEvaluation({
      lane: 'maintenance',
      suiteDigest: evidence.suiteDigest,
      evaluationVersion: P14_LANE_EVAL_VERSION,
      evidenceClass: 'operational',
      passed: evidence.evaluation.maintenance.passed,
      capturedAt: evidence.suite.capturedAt,
    });
    for (const lane of ['interactive', 'learning'] as const) {
      if (store.get(lane).desiredState !== 'killed') store.setDesired(lane, 'off');
    }
    store.setDesired('maintenance', 'test-session');
    manager.setDefaultMode('shadow');
    manager.setSessionEnabled(input.sessionId, true);
    manager.setGlobalEnabled(true);
    return statusFromStores(
      dataDir,
      input.sessionId,
      store,
      manager,
      evidence.suiteDigest,
      destination,
    );
  } catch (error) {
    if (configurationStarted) {
      try { manager.setGlobalEnabled(false); } catch { /* preserve the preparation error */ }
    }
    throw error;
  } finally {
    manager.close();
    store.close();
  }
}

/**
 * Offline, zero-Provider activation of the one production canary route.
 * The durable route CAS is the final commit marker; no business write follows it.
 */
export function activateMaintenanceProductionCanary(input: {
  dataDirectory: string;
  evidenceDirectory: string;
  expectedDigest: string;
  sessionId: string;
  acknowledgement: string;
}): MaintenanceCanaryStatus {
  if (input.acknowledgement !== P17_MAINTENANCE_PRODUCTION_CANARY_ACK) {
    throw new Error(`activate requires --ack ${P17_MAINTENANCE_PRODUCTION_CANARY_ACK}`);
  }
  const dataDir = resolve(input.dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  requireSessionDatabase(dataDir, input.sessionId);
  const preflightEvidence = loadOperationalMaintenanceEvidence(
    input.evidenceDirectory,
    input.expectedDigest,
    input.sessionId,
  );
  const bucket = agentLoopMaintenanceCanaryRouteBucketV2(input.sessionId);
  if (bucket >= AGENT_LOOP_MAINTENANCE_PRODUCTION_CANARY_THRESHOLD) {
    throw new Error('maintenance-production-canary-session-outside-cohort');
  }

  const lock = acquireServerProcessLock({
    dataDir,
    instanceId: `p17-canary-${randomUUID()}`,
  });
  let store: AgentControlStore | undefined;
  let manager: MaintenanceJobManager | undefined;
  let openedRouteRevision: number | null = null;
  let configurationStarted = false;
  try {
    lock.assertOwned();
    requirePlainDirectory(dataDir, 'data-directory');
    requireSessionDatabase(dataDir, input.sessionId);
    const evidence = loadOperationalMaintenanceEvidence(
      input.evidenceDirectory,
      input.expectedDigest,
      input.sessionId,
    );
    if (evidence.suiteDigest !== preflightEvidence.suiteDigest) {
      throw new Error('operational-evidence-changed-during-activation');
    }
    store = new AgentControlStore({ dataDir });
    manager = new MaintenanceJobManager({ dataDir });
    const beforeRoute = store.maintenanceRouteControl();
    const alreadyActive = beforeRoute.state === 'canary-5'
      && beforeRoute.targetSessionId === input.sessionId
      && beforeRoute.evidenceDigest === evidence.suiteDigest;
    if (beforeRoute.state === 'killed') {
      throw new Error('maintenance-production-route-killed-clear-explicitly-first');
    }
    if (beforeRoute.state !== 'off' && !alreadyActive) {
      throw new Error('maintenance-production-route-binding-conflict');
    }
    if (store.get('maintenance').desiredState === 'killed') {
      throw new Error('maintenance-lane-killed-clear-explicitly-first');
    }
    if (!alreadyActive && hasMaintenanceProductionCanaryBacklog(manager, input.sessionId)) {
      throw new Error('maintenance-production-canary-backlog-not-empty');
    }

    configurationStarted = true;
    manager.setGlobalEnabled(false);
    const destination = preserveOperationalEvidence(dataDir, input.sessionId, evidence);
    store.recordEvaluation({
      lane: 'maintenance',
      suiteDigest: evidence.suiteDigest,
      evaluationVersion: P14_LANE_EVAL_VERSION,
      evidenceClass: 'operational',
      passed: evidence.evaluation.maintenance.passed,
      capturedAt: evidence.suite.capturedAt,
    });
    for (const lane of ['interactive', 'learning'] as const) {
      if (store.get(lane).desiredState !== 'killed') store.setDesired(lane, 'off');
    }
    store.setDesired('maintenance', 'test-session');
    manager.setDefaultMode('shadow');
    manager.setSessionEnabled(input.sessionId, true);
    const admittedLaneState = maintenanceProductionCanaryAdmissionState(store, input.sessionId);
    if (admittedLaneState === null) {
      throw new Error('maintenance-production-canary-admission-blocked');
    }
    store.setDesired('maintenance', admittedLaneState);
    const prepared = manager.settings(input.sessionId);
    if (prepared.globalEnabled || !prepared.sessionEnabled || prepared.effectiveEnabled
      || prepared.defaultMode !== 'shadow') {
      throw new Error('maintenance-production-canary-settings-invalid');
    }

    // The server cannot start while this lock is owned. Opening the legacy
    // execution gate before the route remains AL-safe because route=off.
    lock.assertOwned();
    manager.setGlobalEnabled(true);
    if (alreadyActive) {
      lock.assertOwned();
      if (!isDeepStrictEqual(store.maintenanceRouteControl(), beforeRoute)) {
        throw new Error('maintenance-production-route-changed-during-activation');
      }
    } else {
      lock.assertOwned();
      const activeRoute = store.setMaintenanceRouteControl({
        expectedRevision: beforeRoute.revision,
        state: 'canary-5',
        targetSessionId: input.sessionId,
        evidenceDigest: evidence.suiteDigest,
      });
      openedRouteRevision = activeRoute.revision;
    }

    // Do not add fallible persistent work below the route commit marker.
    return statusFromStores(
      dataDir,
      input.sessionId,
      store,
      manager,
      evidence.suiteDigest,
      destination,
    );
  } catch (error) {
    if (store && openedRouteRevision !== null) {
      try {
        const route = store.maintenanceRouteControl();
        if (route.revision === openedRouteRevision
          && route.state === 'canary-5'
          && route.targetSessionId === input.sessionId
          && route.evidenceDigest === preflightEvidence.suiteDigest) {
          store.setMaintenanceRouteControl({
            expectedRevision: route.revision,
            state: 'off',
            targetSessionId: null,
            evidenceDigest: null,
          });
        }
      } catch { /* preserve the activation error; global close below remains fail-safe */ }
    }
    if (configurationStarted) {
      try { manager?.setGlobalEnabled(false); } catch { /* preserve the activation error */ }
      try {
        if (store && store.get('maintenance').desiredState !== 'killed') {
          store.setDesired('maintenance', 'off');
        }
      } catch { /* preserve the activation error */ }
    }
    throw error;
  } finally {
    try { manager?.close(); } finally {
      try { store?.close(); } finally { lock.release(); }
    }
  }
}

function closeMaintenanceProductionRoute(
  store: AgentControlStore,
): ReturnType<AgentControlStore['maintenanceRouteControl']> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const route = store.maintenanceRouteControl();
    if (route.state === 'killed') return route;
    try {
      // Even off -> off advances the route revision. This is the close barrier
      // that invalidates an offline activation which observed an older off row.
      return store.setMaintenanceRouteControl({
        expectedRevision: route.revision,
        state: 'off',
        targetSessionId: null,
        evidenceDigest: null,
      });
    } catch (error) {
      if (!(error instanceof Error)
        || error.message !== 'agent-control-maintenance-route-conflict') throw error;
    }
  }
  throw new Error('maintenance-production-route-close-conflict');
}

/** Live rollback for future queued work; already claimed/running routes are unchanged. */
export function rollbackMaintenanceProductionCanary(
  dataDirectory: string,
): ReturnType<AgentControlStore['maintenanceRouteControl']> {
  const dataDir = resolve(dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  const store = new AgentControlStore({ dataDir });
  try {
    return closeMaintenanceProductionRoute(store);
  } finally {
    store.close();
  }
}

export function disableMaintenanceCanary(dataDirectory: string): void {
  const dataDir = resolve(dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  const store = new AgentControlStore({ dataDir });
  const manager = new MaintenanceJobManager({ dataDir });
  try {
    manager.setGlobalEnabled(false);
    closeMaintenanceProductionRoute(store);
    if (store.get('maintenance').desiredState !== 'killed') store.setDesired('maintenance', 'off');
  } finally {
    manager.close();
    store.close();
  }
}
