#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { assertProviderReady, loadProviderConfig } from '../../packages/proxy/src/config.ts';
import { evaluateP14Lanes } from '../../packages/harness/src/lane-evaluation.ts';
import { parseP14ReplayEvidence } from '../../packages/harness/src/replay-evidence.ts';
import {
  P14_OPERATIONAL_REPLAY_ACK,
  runOperationalMaintenanceReplay,
} from './p14-operational-maintenance-replay-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

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
    '       [--max-cost-microusd 1000000] [--data-dir <dir>] [--output <dir>]',
    '',
    'Runs exactly eight synthetic, redacted Provider cases against production maintenance tool schemas.',
    'It never reads conversation prose and never applies a domain write.',
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
const cfg = loadProviderConfig();
assertProviderReady(cfg);

// Conservative execution accounting, not an assertion about the upstream invoice.
const artifacts = await runOperationalMaintenanceReplay({
  fixture,
  // Keep the operator's eight-request authorization physical: no hidden HTTP retry.
  client: new OpenAICompatibleClient(cfg, { maxAttempts: 1 }),
  providerId: cfg.providerId,
  modelId: cfg.model,
  sessionId,
  maxOutputTokens: positive('--max-output-tokens', 800),
  inputMicrousdPerMillionTokens: positive('--input-microusd-per-mtok', 50_000_000),
  outputMicrousdPerMillionTokens: positive('--output-microusd-per-mtok', 50_000_000),
  maxCostMicrousd: positive('--max-cost-microusd', 1_000_000),
});
const evaluation = evaluateP14Lanes(artifacts.suite, artifacts.run);
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outputDir = resolve(valueOf('--output') ?? join(dataDir, 'p14-evidence', stamp));
mkdirSync(outputDir, { recursive: true });
for (const [name, value] of [
  ['suite.json', artifacts.suite],
  ['run.json', artifacts.run],
  ['evaluation.json', evaluation],
] as const) {
  writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
console.log(JSON.stringify({
  evidenceClass: artifacts.suite.evidenceClass,
  lane: 'maintenance',
  dataSource: data.source,
  sessionId,
  outputDirectory: basename(outputDir),
  terminationReason: artifacts.terminationReason,
  accounting: artifacts.accounting,
  report: evaluation.maintenance,
  nonTargetLanesReleaseEligible: {
    interactive: evaluation.interactive.releaseEligible,
    learning: evaluation.learning.releaseEligible,
  },
}, null, 2));
if (!evaluation.maintenance.releaseEligible) process.exitCode = 2;
