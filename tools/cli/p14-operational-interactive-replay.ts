#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { assertProviderReady, loadProviderConfig } from '../../packages/proxy/src/config.ts';
import { evaluateP14Lanes } from '../../packages/harness/src/lane-evaluation.ts';
import { parseP14ReplayEvidence } from '../../packages/harness/src/replay-evidence.ts';
import {
  P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
  P14_INTERACTIVE_OPERATIONAL_REPLAY_ACK,
  runOperationalInteractiveReplay,
} from './p14-operational-interactive-replay-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positive = (name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  const raw = valueOf(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} invalid`);
  }
  return value;
};

if (args.includes('--help')) {
  console.log([
    'Usage: pnpm p14:replay:interactive -- --lane interactive --session <session-id>',
    `       --allow-provider --ack ${P14_INTERACTIVE_OPERATIONAL_REPLAY_ACK}`,
    '       [--max-provider-calls 18] [--max-cost-microusd 1500000]',
    '       [--max-wall-ms 15000] [--data-dir <dir>] [--output <dir>]',
    '',
    'Runs bounded synthetic Provider cases through the production Router, Director,',
    'Interactive Prelude and Critic contracts. It reads no conversation prose, emits',
    'no user-visible reply and performs no business write.',
  ].join('\n'));
  process.exit(0);
}
if (valueOf('--lane') !== 'interactive') throw new Error('only --lane interactive is supported');
if (!args.includes('--allow-provider')
  || valueOf('--ack') !== P14_INTERACTIVE_OPERATIONAL_REPLAY_ACK) {
  throw new Error(
    `real Provider replay requires --allow-provider --ack ${P14_INTERACTIVE_OPERATIONAL_REPLAY_ACK}`,
  );
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

const artifacts = await runOperationalInteractiveReplay({
  fixture,
  // Operator authorization counts every physical request, including failures.
  // Disable the production client's transparent HTTP retries for this replay.
  client: new OpenAICompatibleClient(cfg, { maxAttempts: 1 }),
  providerId: cfg.providerId,
  modelId: cfg.model,
  sessionId,
  maxOutputTokens: positive('--max-output-tokens', 1_200, 1_200),
  inputMicrousdPerMillionTokens: positive('--input-microusd-per-mtok', 50_000_000),
  outputMicrousdPerMillionTokens: positive('--output-microusd-per-mtok', 50_000_000),
  maxCostMicrousd: positive('--max-cost-microusd', 1_500_000),
  maxProviderCalls: positive(
    '--max-provider-calls',
    P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
    P14_INTERACTIVE_OPERATIONAL_MAX_PROVIDER_CALLS,
  ),
  maxWallMs: positive('--max-wall-ms', 15_000, 15_000),
});
const evaluation = evaluateP14Lanes(artifacts.suite, artifacts.run);
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outputDir = resolve(valueOf('--output') ?? join(dataDir, 'p14-evidence', stamp));
mkdirSync(outputDir, { recursive: true });
for (const [name, value] of [
  ['suite.json', artifacts.suite],
  ['run.json', artifacts.run],
  ['evaluation.json', evaluation],
  ['accounting.json', artifacts.accounting],
] as const) {
  writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}
console.log(JSON.stringify({
  evidenceClass: artifacts.suite.evidenceClass,
  lane: 'interactive',
  dataSource: data.source,
  sessionId,
  outputDirectory: basename(outputDir),
  accounting: artifacts.accounting,
  report: evaluation.interactive,
  nonTargetLanesReleaseEligible: {
    learning: evaluation.learning.releaseEligible,
    maintenance: evaluation.maintenance.releaseEligible,
  },
}, null, 2));
if (!evaluation.interactive.releaseEligible) process.exitCode = 2;
