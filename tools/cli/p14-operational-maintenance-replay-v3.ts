#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD } from '../../packages/operational-replay-contract/index.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';
import { createOperationalReplayTransport } from './operational-replay-transport.ts';
import {
  P14_MAINTENANCE_OPERATIONAL_V3_ACK,
  P14_MAINTENANCE_OPERATIONAL_V3_MAX_PROVIDER_CALLS,
  buildMaintenanceOperationalV3Evidence,
  parseMaintenanceOperationalV3Fixture,
  parseMaintenanceOperationalV3ScenarioArg,
  runOperationalMaintenanceV3Replay,
} from './p14-operational-maintenance-replay-v3-core.ts';

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
    'Usage: pnpm p14:replay:maintenance:v3 -- --lane maintenance --session <session-id>',
    `       --allow-provider --ack ${P14_MAINTENANCE_OPERATIONAL_V3_ACK}`,
    `       [--max-cost-microusd ${P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD}]`,
    '       [--expected-provider <id>] [--expected-model <id>] [--scenario <scenario-id>]',
    '       [--data-dir <dir>] [--output <dir>]',
    '',
    'By default runs exactly three fixed, synthetic, redacted shadow calls: memory consolidation,',
    'rolling summary, and worldbook repair. --scenario runs one repair-only case and does not',
    'qualify as a full-suite gate. It never reads conversation prose, retries,',
    'or applies a business/domain write. Provider failures still consume their physical-call budget.',
  ].join('\n'));
  process.exit(0);
}

// Resolve the optional one-call selector before any replay transport can be
// created. Missing, flag-shaped, or duplicate values fail closed.
const selectedScenarioId = parseMaintenanceOperationalV3ScenarioArg(args);

if (valueOf('--lane') !== 'maintenance') throw new Error('only --lane maintenance is supported');
if (!args.includes('--allow-provider') || valueOf('--ack') !== P14_MAINTENANCE_OPERATIONAL_V3_ACK) {
  throw new Error(`real Provider replay requires --allow-provider --ack ${P14_MAINTENANCE_OPERATIONAL_V3_ACK}`);
}
const sessionId = valueOf('--session');
if (!sessionId) throw new Error('--session required');
const data = resolveOperationalDataDirectory({ explicit: valueOf('--data-dir') });
const dataDir = data.path;
if (!existsSync(join(dataDir, `${sessionId}.db`))) throw new Error('selected session database does not exist');

const fixturePath = resolve(valueOf('--suite')
  ?? 'packages/harness/tests/fixtures/p14-maintenance-operational-v3.redacted.json');
// Parse before beginning the one-shot bridge authorization. Any fixture/context
// error therefore consumes zero Provider calls.
const fixture = parseMaintenanceOperationalV3Fixture(JSON.parse(readFileSync(fixturePath, 'utf8')));
if (selectedScenarioId && !fixture.cases.some((item) => item.scenarioId === selectedScenarioId)) {
  throw new Error('--scenario does not exist in the fixed suite');
}
const expectedProviderCalls = selectedScenarioId ? 1 : P14_MAINTENANCE_OPERATIONAL_V3_MAX_PROVIDER_CALLS;
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

const transport = await createOperationalReplayTransport({
  dataDir,
  lane: 'maintenance',
  ack: P14_MAINTENANCE_OPERATIONAL_V3_ACK,
  sessionId,
  maxProviderCalls: expectedProviderCalls,
  maxOutputTokens,
  maxWallMs: 60_000,
  maxCostMicrousd,
  inputMicrousdPerMillionTokens: inputRate,
  outputMicrousdPerMillionTokens: outputRate,
  ...(valueOf('--expected-provider') ? { expectedProviderId: valueOf('--expected-provider') } : {}),
  ...(valueOf('--expected-model') ? { expectedModel: valueOf('--expected-model') } : {}),
});

let report: Awaited<ReturnType<typeof runOperationalMaintenanceV3Replay>>;
let bridgeFinish: Awaited<ReturnType<typeof transport.finish>> | undefined;
let replayFailed = false;
try {
  report = await runOperationalMaintenanceV3Replay({
    fixture,
    client: transport.client,
    providerId: transport.providerId,
    modelId: transport.modelId,
    sessionId,
    maxOutputTokens,
    inputMicrousdPerMillionTokens: inputRate,
    outputMicrousdPerMillionTokens: outputRate,
    maxCostMicrousd,
    ...(selectedScenarioId ? { scenarioIds: [selectedScenarioId] } : {}),
  });
} catch (error) {
  replayFailed = true;
  throw error;
} finally {
  try { bridgeFinish = await transport.finish(); }
  catch (finishError) { if (!replayFailed) throw finishError; }
}
if (!bridgeFinish) throw new Error('operational replay bridge accounting unavailable');
const bridgeAccounting = bridgeFinish.accounting;
const evidence = buildMaintenanceOperationalV3Evidence(report, bridgeAccounting);
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outputDir = resolve(valueOf('--output') ?? join(dataDir, 'p14-evidence', stamp));
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, 'maintenance-v3-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);

const allValid = evidence.terminationReason === 'completed'
  && evidence.results.length === expectedProviderCalls
  && evidence.results.every((item) => item.classification === 'valid');
console.log(JSON.stringify({
  suiteId: evidence.suiteId,
  evidenceClass: evidence.evidenceClass,
  evidenceScope: evidence.evidenceScope,
  qualifiesFullSuite: evidence.evidenceScope === 'full-suite' && allValid,
  dataSource: data.source,
  outputDirectory: basename(outputDir),
  terminationReason: evidence.terminationReason,
  accounting: evidence.accounting,
  bridgeAccounting: evidence.bridgeAccounting,
  classifications: evidence.results.map((item) => ({
    scenarioId: item.scenarioId,
    taskKind: item.taskKind,
    classification: item.classification,
    failureCode: item.failureCode,
  })),
  allValid,
}, null, 2));
if (!allValid) process.exitCode = 2;
