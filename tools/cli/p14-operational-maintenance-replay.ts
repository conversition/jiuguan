#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { evaluateP14Lanes } from '../../packages/harness/src/lane-evaluation.ts';
import { parseP14ReplayEvidence } from '../../packages/harness/src/replay-evidence.ts';
import {
  P14_OPERATIONAL_REPLAY_ACK,
  buildMaintenanceOperationalFailureArtifact,
  buildMaintenanceOperationalReplayAccountingEvidence,
  runOperationalMaintenanceReplay,
} from './p14-operational-maintenance-replay-core.ts';
import { P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD } from '../../packages/operational-replay-contract/index.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';
import { createOperationalReplayTransport } from './operational-replay-transport.ts';
import { buildMaintenanceOperationalEvidenceBinding } from './p14-operational-evidence-import-core.ts';
import { createMaintenanceReplayOutputPublisher } from './p14-operational-maintenance-replay-output.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positive = (name: string, fallback: number): number => {
  const raw = valueOf(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} invalid`);
  return value;
};
if (args.includes('--help')) {
  console.log([
    'Usage: pnpm p14:replay:maintenance -- --lane maintenance --session <session-id>',
    `       --allow-provider --ack ${P14_OPERATIONAL_REPLAY_ACK}`,
    `       [--max-cost-microusd ${P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD}] [--expected-provider <id>] [--expected-model <id>]`,
    '       [--data-dir <dir>] [--output <dir>]',
    '',
    'Runs exactly eight synthetic, redacted Provider cases against current production maintenance tool schemas.',
    'It never reads conversation prose and never applies a domain write.',
    'Success writes suite.json, run.json, evaluation.json, session-bound bridge-accounting.json, and binding.json.',
    'Any replay or post-processing failure writes one non-importable failure.json with redacted accounting.',
  ].join('\n'));
  process.exit(0);
}
if (valueOf('--lane') !== 'maintenance') throw new Error('only --lane maintenance is supported');
if (!args.includes('--allow-provider') || valueOf('--ack') !== P14_OPERATIONAL_REPLAY_ACK) {
  throw new Error(`real Provider replay requires --allow-provider --ack ${P14_OPERATIONAL_REPLAY_ACK}`);
}
const sessionId = valueOf('--session');
if (!sessionId) throw new Error('--session required');
const data = resolveOperationalDataDirectory({ explicit: valueOf('--data-dir') });
const dataDir = data.path;
if (!existsSync(join(dataDir, `${sessionId}.db`))) {
  throw new Error('selected session database does not exist');
}
const fixturePath = resolve(valueOf('--suite')
  ?? 'packages/harness/tests/fixtures/p14-q9-evidence.v1.json');
const fixture = parseP14ReplayEvidence(JSON.parse(readFileSync(fixturePath, 'utf8')));
// The replay must be able to carry the same typed proposal that production
// accepts. Qwen tool-call reasoning can consume more than 800 output tokens even
// when the final proposal is small; 1,600 remains far below the production
// quality Maintenance ceiling (6,000) and is still cost-capped independently.
const maxOutputTokens = positive('--max-output-tokens', 1_600);
const inputRate = positive('--input-microusd-per-mtok', 50_000_000);
const outputRate = positive('--output-microusd-per-mtok', 50_000_000);
const maxCostMicrousd = positive(
  '--max-cost-microusd',
  P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD,
);
if (maxCostMicrousd > P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD) {
  throw new Error('--max-cost-microusd exceeds maintenance replay cap');
}
const explicitOutput = valueOf('--output');
const output = createMaintenanceReplayOutputPublisher({
  dataDirectory: dataDir,
  ...(explicitOutput === undefined ? {} : { explicitOutput }),
});
const transport = await (async () => {
  try {
    return await createOperationalReplayTransport({
      dataDir,
      lane: 'maintenance',
      ack: P14_OPERATIONAL_REPLAY_ACK,
      sessionId,
      maxProviderCalls: 8,
      maxOutputTokens,
      maxWallMs: 60_000,
      maxCostMicrousd,
      inputMicrousdPerMillionTokens: inputRate,
      outputMicrousdPerMillionTokens: outputRate,
      ...(valueOf('--expected-provider') ? { expectedProviderId: valueOf('--expected-provider') } : {}),
      ...(valueOf('--expected-model') ? { expectedModel: valueOf('--expected-model') } : {}),
    });
  } catch (error) {
    // No Provider call has started. Do not leak an empty reservation if bridge construction fails.
    try { output.release(); }
    catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'maintenance operational transport failed and output reservation release failed',
      );
    }
    throw error;
  }
})();

// Conservative execution accounting, not an assertion about the upstream invoice.
let artifacts: Awaited<ReturnType<typeof runOperationalMaintenanceReplay>> | undefined;
let bridgeFinish: Awaited<ReturnType<typeof transport.finish>> | undefined;
let replayFailed = false;
let replayError: unknown;
let finishError: unknown;
try {
  artifacts = await runOperationalMaintenanceReplay({
    fixture,
    client: transport.client,
    providerId: transport.providerId,
    modelId: transport.modelId,
    sessionId,
    maxOutputTokens,
    inputMicrousdPerMillionTokens: inputRate,
    outputMicrousdPerMillionTokens: outputRate,
    maxCostMicrousd,
  });
} catch (error) {
  replayFailed = true;
  replayError = error;
} finally {
  try { bridgeFinish = await transport.finish(); }
  catch (error) { finishError = error; }
}
const sessionBoundFinishAccounting = (
  finish: Awaited<ReturnType<typeof transport.finish>>,
) => Object.freeze({
  sessionId: finish.sessionId,
  providerCalls: finish.accounting.providerCalls,
  inputTokens: finish.accounting.inputTokens,
  outputTokens: finish.accounting.outputTokens,
  costMicrousd: finish.accounting.costMicrousd,
});
const failureBridgeAccounting = bridgeFinish
  ? sessionBoundFinishAccounting(bridgeFinish)
  : undefined;
const persistFailure = (
  error: unknown,
  stage: 'replay' | 'post-processing',
  replayArtifacts?: Awaited<ReturnType<typeof runOperationalMaintenanceReplay>>,
): never => {
  const failure = buildMaintenanceOperationalFailureArtifact(error, failureBridgeAccounting, {
    stage,
    expectedSessionId: sessionId,
    ...(replayArtifacts ? { artifacts: replayArtifacts } : {}),
  });
  output.publishFailure(failure);
  console.error(JSON.stringify({
    outputDirectory: basename(output.outputDirectory),
    failure,
  }, null, 2));
  throw error;
};
if (replayFailed) persistFailure(replayError, 'replay');
const completedArtifacts = artifacts ?? persistFailure(
  new Error('operational replay artifacts unavailable'),
  'post-processing',
);
if (finishError) persistFailure(finishError, 'post-processing', completedArtifacts);
const completedBridgeFinish = bridgeFinish ?? persistFailure(
  new Error('operational replay bridge accounting unavailable'),
  'post-processing',
  completedArtifacts,
);
const bridgeAccounting = sessionBoundFinishAccounting(completedBridgeFinish);
const finalizeEvidence = () => {
  const evaluation = evaluateP14Lanes(completedArtifacts.suite, completedArtifacts.run);
  const accountingEvidence = buildMaintenanceOperationalReplayAccountingEvidence(
    completedArtifacts,
    bridgeAccounting,
  );
  const binding = buildMaintenanceOperationalEvidenceBinding({
    sessionId: accountingEvidence.sessionId,
    suiteDigest: accountingEvidence.suiteDigest,
    accountingDigest: accountingEvidence.accountingDigest,
  });
  return Object.freeze({ evaluation, accountingEvidence, binding });
};
const finalized = (() => {
  try { return finalizeEvidence(); }
  catch (error) { return persistFailure(error, 'post-processing', completedArtifacts); }
})();
const { evaluation, accountingEvidence, binding } = finalized;
try {
  output.publishSuccess({
    suite: completedArtifacts.suite,
    run: completedArtifacts.run,
    evaluation,
    bridgeAccounting: accountingEvidence,
    binding,
  });
} catch (error) {
  persistFailure(error, 'post-processing', completedArtifacts);
}
console.log(JSON.stringify({
  evidenceClass: completedArtifacts.suite.evidenceClass,
  lane: 'maintenance',
  dataSource: data.source,
  sessionId,
  outputDirectory: basename(output.outputDirectory),
  terminationReason: completedArtifacts.terminationReason,
  accounting: completedArtifacts.accounting,
  bridgeAccounting,
  report: evaluation.maintenance,
  nonTargetLanesReleaseEligible: {
    interactive: evaluation.interactive.releaseEligible,
    learning: evaluation.learning.releaseEligible,
  },
}, null, 2));
if (!evaluation.maintenance.releaseEligible) process.exitCode = 2;
