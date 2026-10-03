#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseP14ReplayEvidence } from '../../packages/harness/src/replay-evidence.ts';
import {
  buildFixtureReplayRun,
  evaluateP14Lanes,
  type P14ReplayRun,
} from '../../packages/harness/src/lane-evaluation.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const suitePath = resolve(valueOf('--suite')
  ?? 'packages/harness/tests/fixtures/p14-q9-evidence.v1.json');
const suite = parseP14ReplayEvidence(JSON.parse(readFileSync(suitePath, 'utf8')));
let run: P14ReplayRun;
if (args.includes('--fixture-self-check')) {
  run = buildFixtureReplayRun(suite);
} else {
  const runPath = valueOf('--run');
  if (!runPath) throw new Error('provide --run <redacted-run.json> or --fixture-self-check');
  run = JSON.parse(readFileSync(resolve(runPath), 'utf8')) as P14ReplayRun;
}
console.log(JSON.stringify(evaluateP14Lanes(suite, run), null, 2));
