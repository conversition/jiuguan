#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseP14ReplayEvidence,
  summarizeP14ReplayEvidence,
} from '../../packages/harness/src/replay-evidence.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (args.includes('--help')) {
  console.log([
    'Usage: pnpm p14:replay [--file <redacted-manifest.json>]',
    '                       [--allow-operational --ack p14-q9-operational-replay-v1]',
    '',
    'Read-only: validates and summarizes an already-redacted manifest; never calls a Provider.',
  ].join('\n'));
  process.exit(0);
}

const defaultFile = resolve('packages/harness/tests/fixtures/p14-q9-evidence.v1.json');
const file = resolve(valueOf('--file') ?? defaultFile);
const suite = parseP14ReplayEvidence(JSON.parse(readFileSync(file, 'utf8')));
if (suite.evidenceClass === 'operational'
  && (!args.includes('--allow-operational') || valueOf('--ack') !== 'p14-q9-operational-replay-v1')) {
  throw new Error('operational replay requires explicit acknowledgement');
}
console.log(JSON.stringify(summarizeP14ReplayEvidence(suite), null, 2));
