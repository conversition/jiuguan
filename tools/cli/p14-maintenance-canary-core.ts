import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentControlStore } from '../../apps/server/agent-control-store.ts';
import { MaintenanceJobManager } from '../../apps/server/maintenance-job-manager.ts';
import {
  evaluateP14Lanes,
  parseP14ReplayRun,
  P14_LANE_EVAL_VERSION,
  type P14LaneEvaluation,
  type P14ReplayRun,
} from '../../packages/harness/src/lane-evaluation.ts';
import {
  parseP14ReplayEvidence,
  p14ReplaySuiteDigest,
  type P14ReplayEvidence,
} from '../../packages/harness/src/replay-evidence.ts';

export const P14_MAINTENANCE_CANARY_ACK = 'p14-maintenance-test-session-v1' as const;
export const P14_MAINTENANCE_CANARY_BINDING_VERSION = 'p14-maintenance-canary-binding-v1' as const;

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

export interface OperationalMaintenanceEvidence {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly evaluation: P14LaneEvaluation;
  readonly suiteDigest: string;
}

export interface MaintenanceCanaryStatus {
  readonly sessionId: string;
  readonly sessionDatabaseExists: boolean;
  readonly maintenance: ReturnType<AgentControlStore['get']>;
  readonly evidence: ReturnType<AgentControlStore['evidence']>;
  readonly settings: ReturnType<MaintenanceJobManager['settings']>;
  readonly evidenceDirectory: string | null;
}

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

function readEvidenceJson(directory: string, name: string): unknown {
  const path = join(directory, name);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`operational-evidence-${name}-invalid`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Recompute from strict suite/run contracts; evaluation.json is only a cross-check. */
export function loadOperationalMaintenanceEvidence(
  evidenceDirectory: string,
  expectedDigest: string,
): OperationalMaintenanceEvidence {
  const directory = resolve(evidenceDirectory);
  requirePlainDirectory(directory, 'operational-evidence-directory');
  if (!SHA256_RE.test(expectedDigest)) throw new Error('expected-suite-digest-invalid');
  const suite = parseP14ReplayEvidence(readEvidenceJson(directory, 'suite.json'));
  if (suite.evidenceClass !== 'operational') throw new Error('operational-evidence-required');
  const suiteDigest = p14ReplaySuiteDigest(suite);
  if (suiteDigest !== expectedDigest) throw new Error('operational-evidence-digest-mismatch');
  const run = parseP14ReplayRun(suite, readEvidenceJson(directory, 'run.json'));
  const evaluation = evaluateP14Lanes(suite, run);
  if (!isDeepStrictEqual(readEvidenceJson(directory, 'evaluation.json'), evaluation)) {
    throw new Error('operational-evaluation-recompute-mismatch');
  }
  if (!evaluation.maintenance.passed || !evaluation.maintenance.releaseEligible
    || evaluation.maintenance.gateReason !== 'passed-operational'
    || evaluation.maintenance.safetyViolations !== 0
    || evaluation.maintenance.staleWriteViolations !== 0
    || evaluation.maintenance.duplicateWriteViolations !== 0
    || evaluation.maintenance.beliefObjectiveContamination !== 0) {
    throw new Error('maintenance-operational-gate-failed');
  }
  return Object.freeze({ suite, run, evaluation, suiteDigest });
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
  writeImmutableJson(join(destination, 'binding.json'), {
    version: P14_MAINTENANCE_CANARY_BINDING_VERSION,
    lane: 'maintenance',
    sessionId,
    suiteDigest: evidence.suiteDigest,
    evidenceClass: 'operational',
  });
  return destination;
}

export function maintenanceCanaryStatus(dataDirectory: string, sessionId: string): MaintenanceCanaryStatus {
  const dataDir = resolve(dataDirectory);
  requirePlainDirectory(dataDir, 'data-directory');
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('session-id-invalid');
  const store = new AgentControlStore({ dataDir });
  const manager = new MaintenanceJobManager({ dataDir });
  try {
    const evidence = store.evidence('maintenance');
    const evidenceRoot = join(dataDir, 'p14-evidence', 'maintenance');
    return Object.freeze({
      sessionId,
      sessionDatabaseExists: existsSync(join(dataDir, `${sessionId}.db`)),
      maintenance: store.get('maintenance'),
      evidence,
      settings: manager.settings(sessionId),
      evidenceDirectory: evidence.operationalEvaluationPassed && existsSync(evidenceRoot)
        ? evidenceRoot : null,
    });
  } finally {
    manager.close();
    store.close();
  }
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
  const evidence = loadOperationalMaintenanceEvidence(input.evidenceDirectory, input.expectedDigest);
  const store = new AgentControlStore({ dataDir });
  const manager = new MaintenanceJobManager({ dataDir });
  try {
    if (store.get('maintenance').desiredState === 'killed') {
      throw new Error('maintenance-lane-killed-clear-explicitly-first');
    }
    // Fail closed while the two independent control databases are updated.
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
    return Object.freeze({
      sessionId: input.sessionId,
      sessionDatabaseExists: true,
      maintenance: store.get('maintenance'),
      evidence: store.evidence('maintenance'),
      settings: manager.settings(input.sessionId),
      evidenceDirectory: destination,
    });
  } catch (error) {
    manager.setGlobalEnabled(false);
    throw error;
  } finally {
    manager.close();
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
    if (store.get('maintenance').desiredState !== 'killed') store.setDesired('maintenance', 'off');
  } finally {
    manager.close();
    store.close();
  }
}
