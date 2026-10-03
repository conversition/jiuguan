#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_ROLLOUT_LANES,
  AGENT_ROLLOUT_STATES,
  AGENT_TEST_SESSION_WINDOW_CALLS,
  narrowAgentRolloutState,
  type AgentRolloutLane,
  type AgentRolloutState,
} from '../../packages/agent-policy/src/lane-rollout.ts';
import { AgentControlStore } from '../../apps/server/agent-control-store.ts';
import { AGENT_LANE_RECOVERY_ACK } from '../../apps/server/agent-control-mutation.ts';
import { parseAgentLaneRuntimeConfig } from '../../apps/server/agent-lane-runtime-config.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';
import { readRuntimeProfileEnvironment } from './runtime-profile-env.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const laneOf = (): AgentRolloutLane => {
  const value = valueOf('--lane');
  if (!AGENT_ROLLOUT_LANES.includes(value as AgentRolloutLane)) throw new Error('--lane invalid');
  return value as AgentRolloutLane;
};
const positiveCallsOf = (lane: AgentRolloutLane): number => {
  const raw = valueOf('--max-provider-calls');
  const value = raw === undefined ? Number.NaN : Number(raw);
  const ceiling = AGENT_TEST_SESSION_WINDOW_CALLS[lane];
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`--max-provider-calls must be an explicit integer in 1..${ceiling} for ${lane}`);
  }
  return value;
};
const expectedRevisionOf = (): string => {
  const value = valueOf('--expected-revision');
  if (!value) throw new Error('--expected-revision required');
  return value;
};
const expectedWindowSequenceOf = (): number => {
  const value = Number(valueOf('--expected-window-sequence'));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--expected-window-sequence must be a positive integer');
  }
  return value;
};
const requireRecoveryAck = (): void => {
  if (valueOf('--ack') !== AGENT_LANE_RECOVERY_ACK) {
    throw new Error(`--ack must equal ${AGENT_LANE_RECOVERY_ACK}`);
  }
};
const data = resolveOperationalDataDirectory({ explicit: valueOf('--data-dir') });
const dataDir = data.path;
const profilePath = resolve(valueOf('--profile')
  ?? 'tools/windows/public-safe-v0.1.env');
const hasProcessRuntime = Boolean(process.env.JG_AGENT_LANE_ROLLOUT?.trim());
const runtimeEnvironment = hasProcessRuntime
  ? process.env
  : { ...process.env, ...readRuntimeProfileEnvironment(profilePath) };
const store = new AgentControlStore({ dataDir });
try {
  if (command === 'status') {
    const runtime = parseAgentLaneRuntimeConfig(runtimeEnvironment);
    console.log(JSON.stringify({
      managed: runtime.managed,
      dataSource: data.source,
      runtimeSource: hasProcessRuntime ? 'process-environment' : 'profile-file',
      lanes: store.list().map((row) => ({
        ...row,
        hostCeiling: runtime.ceilings[row.lane],
        authorizationWindow: store.authorizationWindow(row.lane),
        evidence: store.evidence(row.lane),
      })),
    }, null, 2));
  } else if (command === 'set') {
    const lane = laneOf();
    const state = valueOf('--state') as AgentRolloutState | undefined;
    if (!state || !AGENT_ROLLOUT_STATES.includes(state) || state === 'killed') throw new Error('--state invalid');
    const runtime = parseAgentLaneRuntimeConfig(runtimeEnvironment);
    if (!runtime.managed) throw new Error('set requires explicit JG_AGENT_LANE_ROLLOUT host ceiling');
    if (narrowAgentRolloutState(state, runtime.ceilings[lane]) !== state) {
      throw new Error('requested state exceeds host ceiling');
    }
    store.setDesired(lane, state);
    console.log(JSON.stringify(store.get(lane), null, 2));
  } else if (command === 'kill') {
    const lane = laneOf();
    store.kill(lane, valueOf('--reason') ?? 'operator-kill');
    console.log(JSON.stringify(store.get(lane), null, 2));
  } else if (command === 'clear-kill') {
    const lane = laneOf();
    store.clearKill(lane);
    console.log(JSON.stringify(store.get(lane), null, 2));
  } else if (command === 'recover') {
    const lane = laneOf();
    const expectedRevision = valueOf('--expected-revision');
    const evidenceDigest = valueOf('--evidence-digest');
    if (!expectedRevision) throw new Error('--expected-revision required');
    if (!evidenceDigest) throw new Error('--evidence-digest required');
    if (valueOf('--ack') !== AGENT_LANE_RECOVERY_ACK) {
      throw new Error(`--ack must equal ${AGENT_LANE_RECOVERY_ACK}`);
    }
    console.log(JSON.stringify(store.recoverQualityKillCas({
      lane,
      expectedRevision,
      evidenceDigest,
      maxProviderCalls: positiveCallsOf(lane),
    }), null, 2));
  } else if (command === 'reopen') {
    const lane = laneOf();
    const runtime = parseAgentLaneRuntimeConfig(runtimeEnvironment);
    if (!runtime.managed
      || narrowAgentRolloutState('test-session', runtime.ceilings[lane]) !== 'test-session') {
      throw new Error('reopen requires a managed test-session host ceiling');
    }
    requireRecoveryAck();
    const expectedRevision = expectedRevisionOf();
    const expectedWindowSequence = expectedWindowSequenceOf();
    const maxProviderCalls = positiveCallsOf(lane);
    const before = store.get(lane);
    const beforeWindow = store.authorizationWindow(lane);
    if (before.revision !== expectedRevision) throw new Error('agent-control-revision-conflict');
    if (beforeWindow.sequence !== expectedWindowSequence) {
      throw new Error('authorization-window-sequence-conflict');
    }
    const evidenceDigest = valueOf('--evidence-digest');
    if (before.desiredState === 'killed' && !evidenceDigest) {
      throw new Error('--evidence-digest required for killed lane');
    }
    const reopened = store.reopenLaneCas({
      lane,
      expectedRevision,
      expectedWindowSequence,
      maxProviderCalls,
      ...(evidenceDigest ? { evidenceDigest } : {}),
    });
    console.log(JSON.stringify({
      lane,
      operation: reopened.operation,
      previousControl: before,
      previousAuthorizationWindow: beforeWindow,
      control: reopened.control,
      authorizationWindow: reopened.authorizationWindow,
      evidence: store.evidence(lane),
    }, null, 2));
  } else if (command === 'record-evaluation') {
    const lane = laneOf();
    const file = valueOf('--report');
    if (!file) throw new Error('--report required');
    const report = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
    const laneReport = report[lane] as Record<string, unknown> | undefined;
    const capturedAt = valueOf('--captured-at');
    if (report.version !== 'p14-lane-eval-v1' || typeof report.suiteDigest !== 'string'
      || (report.evidenceClass !== 'fixture' && report.evidenceClass !== 'operational')
      || !laneReport || laneReport.lane !== lane || typeof laneReport.passed !== 'boolean') {
      throw new Error('lane evaluation report invalid');
    }
    if (report.evidenceClass === 'operational') {
      throw new Error('operational evaluation must use the strict p14:evidence:import path');
    }
    if (!capturedAt) throw new Error('--captured-at required from the immutable source suite');
    store.recordEvaluation({
      lane,
      suiteDigest: report.suiteDigest,
      evaluationVersion: report.version,
      evidenceClass: report.evidenceClass,
      passed: laneReport.passed,
      capturedAt,
    });
    console.log(JSON.stringify({ lane, evidence: store.evidence(lane) }, null, 2));
  } else {
    throw new Error('command must be status|set|kill|clear-kill|recover|reopen|record-evaluation');
  }
} finally {
  store.close();
}
