import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export const P14_OPERATIONAL_EVIDENCE_IMPORT_ACK = 'p14-operational-evidence-import-v1' as const;
export const P14_OPERATIONAL_EVIDENCE_BINDING_VERSION = 'p14-operational-evidence-binding-v1' as const;

const SESSION_ID_RE = /^session-[0-9]{6,24}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

export interface OperationalLaneEvidence {
  readonly suite: P14ReplayEvidence;
  readonly run: P14ReplayRun;
  readonly evaluation: P14LaneEvaluation;
  readonly suiteDigest: string;
  readonly lane: AgentRolloutLane;
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

function lane(value: string): AgentRolloutLane {
  if (!AGENT_ROLLOUT_LANES.includes(value as AgentRolloutLane)) throw new Error('lane-invalid');
  return value as AgentRolloutLane;
}

function plainDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}-invalid`);
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
}): OperationalLaneEvidence {
  const selectedLane = lane(input.lane);
  const directory = resolve(input.evidenceDirectory);
  plainDirectory(directory, 'operational-evidence-directory');
  if (!SHA256_RE.test(input.expectedDigest)) throw new Error('expected-suite-digest-invalid');
  const suite = parseP14ReplayEvidence(readEvidenceJson(directory, 'suite.json'));
  if (suite.evidenceClass !== 'operational') throw new Error('operational-evidence-required');
  const suiteDigest = p14ReplaySuiteDigest(suite);
  if (suiteDigest !== input.expectedDigest) throw new Error('operational-evidence-digest-mismatch');
  const run = parseP14ReplayRun(suite, readEvidenceJson(directory, 'run.json'));
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
  return Object.freeze({ suite, run, evaluation, suiteDigest, lane: selectedLane });
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
  });
  const root = join(dataDir, 'p14-evidence');
  const laneRoot = join(root, selectedLane);
  const destination = join(laneRoot, loaded.suiteDigest.slice('sha256:'.length));
  for (const directory of [root, laneRoot, destination]) ensureDirectory(directory);
  writeImmutableJson(join(destination, 'suite.json'), loaded.suite);
  writeImmutableJson(join(destination, 'run.json'), loaded.run);
  writeImmutableJson(join(destination, 'evaluation.json'), loaded.evaluation);
  writeImmutableJson(join(destination, 'binding.json'), {
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
