import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentControlStore } from '../../apps/server/agent-control-store.ts';
import {
  AGENT_ROLLOUT_LANES,
  type AgentRolloutLane,
} from '../../packages/agent-policy/src/lane-rollout.ts';
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
import {
  P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID,
  type MaintenanceOperationalReplayAccountingEvidence,
} from '../../packages/operational-replay-contract/index.ts';
import { parseMaintenanceOperationalReplayAccountingEvidence } from './p14-operational-maintenance-replay-core.ts';

export const P14_OPERATIONAL_EVIDENCE_IMPORT_ACK = 'p14-operational-evidence-import-v1' as const;
export const P14_OPERATIONAL_EVIDENCE_BINDING_VERSION = 'p14-operational-evidence-binding-v1' as const;

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;
const MAINTENANCE_OPERATIONAL_EVIDENCE_FILES = new Set<string>([
  'binding.json',
  'bridge-accounting.json',
  'evaluation.json',
  'run.json',
  'suite.json',
]);

export interface OperationalLaneEvidence {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly evaluation: P14LaneEvaluation;
  readonly suiteDigest: string;
  readonly lane: AgentRolloutLane;
  readonly bridgeAccounting?: MaintenanceOperationalReplayAccountingEvidence;
}

export interface OperationalEvidenceImportResult {
  readonly lane: AgentRolloutLane;
  readonly sessionId: string;
  readonly suiteDigest: string;
  readonly evidenceDirectory: string;
  readonly evidence: ReturnType<AgentControlStore['evidence']>;
  readonly control: ReturnType<AgentControlStore['get']>;
  readonly activated: false;
}

export interface MaintenanceOperationalEvidenceBinding {
  readonly version: typeof P14_OPERATIONAL_EVIDENCE_BINDING_VERSION;
  readonly lane: 'maintenance';
  readonly sessionId: string;
  readonly suiteDigest: string;
  readonly evidenceClass: 'operational';
  readonly accountingDigest: string;
  readonly activated: false;
}

function lane(value: string): AgentRolloutLane {
  if (!AGENT_ROLLOUT_LANES.includes(value as AgentRolloutLane)) throw new Error('lane-invalid');
  return value as AgentRolloutLane;
}

export function buildMaintenanceOperationalEvidenceBinding(input: {
  sessionId: string;
  suiteDigest: string;
  accountingDigest: string;
}): MaintenanceOperationalEvidenceBinding {
  if (!SESSION_ID_RE.test(input.sessionId)) throw new Error('session-id-invalid');
  if (!SHA256_RE.test(input.suiteDigest) || !SHA256_RE.test(input.accountingDigest)) {
    throw new Error('maintenance-operational-source-binding-digest-invalid');
  }
  return Object.freeze({
    version: P14_OPERATIONAL_EVIDENCE_BINDING_VERSION,
    lane: 'maintenance',
    sessionId: input.sessionId,
    suiteDigest: input.suiteDigest,
    evidenceClass: 'operational',
    accountingDigest: input.accountingDigest,
    activated: false,
  });
}

function plainDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
}

function exactMaintenanceOperationalEvidenceLayout(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!MAINTENANCE_OPERATIONAL_EVIDENCE_FILES.has(entry.name)) {
      throw new Error('maintenance-operational-evidence-layout-invalid');
    }
    const stats = lstatSync(join(directory, entry.name));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('maintenance-operational-evidence-layout-invalid');
    }
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  plainDirectory(path, 'operational-evidence-destination');
}

function readEvidenceJson(directory: string, name: string): unknown {
  const path = join(directory, name);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`operational-evidence-${name}-invalid`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readMaintenanceOperationalEvidenceBinding(
  directory: string,
  input: {
    expectedSessionId: string;
    suiteDigest: string;
    accountingDigest: string;
  },
): MaintenanceOperationalEvidenceBinding {
  const path = join(directory, 'binding.json');
  if (!existsSync(path)) throw new Error('maintenance-operational-source-binding-required');
  let value: unknown;
  try {
    value = readEvidenceJson(directory, 'binding.json');
  } catch {
    throw new Error('maintenance-operational-source-binding-invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new Error('maintenance-operational-source-binding-invalid');
  }
  const binding = value as Record<string, unknown>;
  const keys = Object.keys(binding).sort();
  const expectedKeys = [
    'version', 'lane', 'sessionId', 'suiteDigest', 'evidenceClass',
    'accountingDigest', 'activated',
  ].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('maintenance-operational-source-binding-invalid');
  }
  if (binding.sessionId !== input.expectedSessionId) {
    throw new Error('maintenance-operational-source-binding-session-mismatch');
  }
  const expected = buildMaintenanceOperationalEvidenceBinding({
    sessionId: input.expectedSessionId,
    suiteDigest: input.suiteDigest,
    accountingDigest: input.accountingDigest,
  });
  if (!isDeepStrictEqual(binding, expected)) {
    throw new Error('maintenance-operational-source-binding-invalid');
  }
  return expected;
}

function writeImmutableJson(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || readFileSync(path, 'utf8') !== content) {
      throw new Error('operational-evidence-immutable-conflict');
    }
    return;
  }
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export function loadOperationalLaneEvidence(input: {
  evidenceDirectory: string;
  expectedDigest: string;
  lane: string;
  expectedSessionId?: string;
}): OperationalLaneEvidence {
  const selectedLane = lane(input.lane);
  const directory = resolve(input.evidenceDirectory);
  plainDirectory(directory, 'operational-evidence-directory');
  if (selectedLane === 'maintenance') exactMaintenanceOperationalEvidenceLayout(directory);
  if (!SHA256_RE.test(input.expectedDigest)) throw new Error('expected-suite-digest-invalid');
  const suite = parseP14ReplayEvidence(readEvidenceJson(directory, 'suite.json'));
  if (suite.evidenceClass !== 'operational') throw new Error('operational-evidence-required');
  if (selectedLane === 'maintenance'
    && suite.suiteId !== P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID) {
    throw new Error('maintenance-operational-replay-v2-required');
  }
  const suiteDigest = p14ReplaySuiteDigest(suite);
  if (suiteDigest !== input.expectedDigest) throw new Error('operational-evidence-digest-mismatch');
  const run = parseP14ReplayRun(suite, readEvidenceJson(directory, 'run.json'));
  const maintenanceSessionId = selectedLane === 'maintenance'
    ? input.expectedSessionId
    : undefined;
  if (selectedLane === 'maintenance' && (typeof maintenanceSessionId !== 'string'
    || !SESSION_ID_RE.test(maintenanceSessionId))) {
    throw new Error('maintenance-operational-expected-session-required');
  }
  const bridgeAccounting = selectedLane === 'maintenance'
    ? parseMaintenanceOperationalReplayAccountingEvidence(
      suite,
      run,
      readEvidenceJson(directory, 'bridge-accounting.json'),
      maintenanceSessionId!,
    )
    : undefined;
  if (selectedLane === 'maintenance') {
    if (!bridgeAccounting) throw new Error('maintenance-operational-accounting-required');
    readMaintenanceOperationalEvidenceBinding(directory, {
      expectedSessionId: maintenanceSessionId!,
      suiteDigest,
      accountingDigest: bridgeAccounting.accountingDigest,
    });
  }
  const evaluation = evaluateP14Lanes(suite, run);
  if (!isDeepStrictEqual(readEvidenceJson(directory, 'evaluation.json'), evaluation)) {
    throw new Error('operational-evaluation-recompute-mismatch');
  }
  const report = selectedLane === 'interactive'
    ? evaluation.interactive
    : selectedLane === 'learning'
      ? evaluation.learning
      : evaluation.maintenance;
  if (!report.passed || !report.releaseEligible || report.gateReason !== 'passed-operational'
    || report.safetyViolations !== 0) throw new Error(`${selectedLane}-operational-gate-failed`);
  if (selectedLane === 'interactive' && evaluation.interactive.criticFalseEditRate !== 0) {
    throw new Error('interactive-operational-false-edit');
  }
  if (selectedLane === 'maintenance' && (
    evaluation.maintenance.staleWriteViolations !== 0
    || evaluation.maintenance.duplicateWriteViolations !== 0
    || evaluation.maintenance.beliefObjectiveContamination !== 0
  )) throw new Error('maintenance-operational-write-gate-failed');
  return Object.freeze({
    suite,
    run,
    evaluation,
    suiteDigest,
    lane: selectedLane,
    ...(bridgeAccounting ? { bridgeAccounting } : {}),
  });
}

export function importOperationalLaneEvidence(input: {
  dataDirectory: string;
  evidenceDirectory: string;
  expectedDigest: string;
  lane: string;
  sessionId: string;
  acknowledgement: string;
}): OperationalEvidenceImportResult {
  if (input.acknowledgement !== P14_OPERATIONAL_EVIDENCE_IMPORT_ACK) {
    throw new Error(`import requires --ack ${P14_OPERATIONAL_EVIDENCE_IMPORT_ACK}`);
  }
  const selectedLane = lane(input.lane);
  const dataDir = resolve(input.dataDirectory);
  plainDirectory(dataDir, 'data-directory');
  if (!SESSION_ID_RE.test(input.sessionId)) throw new Error('session-id-invalid');
  const sessionPath = join(dataDir, `${input.sessionId}.db`);
  if (!existsSync(sessionPath)) throw new Error('selected-session-database-missing');
  const sessionStats = lstatSync(sessionPath);
  if (!sessionStats.isFile() || sessionStats.isSymbolicLink()) {
    throw new Error('selected-session-database-invalid');
  }
  const loaded = loadOperationalLaneEvidence({
    evidenceDirectory: input.evidenceDirectory,
    expectedDigest: input.expectedDigest,
    lane: selectedLane,
    expectedSessionId: input.sessionId,
  });
  const root = join(dataDir, 'p14-evidence');
  const laneRoot = join(root, selectedLane);
  const destination = join(laneRoot, loaded.suiteDigest.slice('sha256:'.length));
  for (const directory of [root, laneRoot, destination]) ensureDirectory(directory);
  writeImmutableJson(join(destination, 'suite.json'), loaded.suite);
  writeImmutableJson(join(destination, 'run.json'), loaded.run);
  writeImmutableJson(join(destination, 'evaluation.json'), loaded.evaluation);
  if (loaded.bridgeAccounting) {
    writeImmutableJson(join(destination, 'bridge-accounting.json'), loaded.bridgeAccounting);
  }
  writeImmutableJson(join(destination, 'binding.json'), loaded.bridgeAccounting
    ? buildMaintenanceOperationalEvidenceBinding({
      sessionId: input.sessionId,
      suiteDigest: loaded.suiteDigest,
      accountingDigest: loaded.bridgeAccounting.accountingDigest,
    })
    : {
      version: P14_OPERATIONAL_EVIDENCE_BINDING_VERSION,
      lane: selectedLane,
      sessionId: input.sessionId,
      suiteDigest: loaded.suiteDigest,
      evidenceClass: 'operational',
      activated: false,
    });
  const store = new AgentControlStore({ dataDir });
  try {
    store.recordEvaluation({
      lane: selectedLane,
      suiteDigest: loaded.suiteDigest,
      evaluationVersion: P14_LANE_EVAL_VERSION,
      evidenceClass: 'operational',
      passed: true,
      capturedAt: loaded.suite.capturedAt,
    });
    return Object.freeze({
      lane: selectedLane,
      sessionId: input.sessionId,
      suiteDigest: loaded.suiteDigest,
      evidenceDirectory: destination,
      evidence: store.evidence(selectedLane),
      control: store.get(selectedLane),
      activated: false,
    });
  } finally {
    store.close();
  }
}
