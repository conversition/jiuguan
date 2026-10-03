#!/usr/bin/env node
import {
  importOperationalLaneEvidence,
  P14_OPERATIONAL_EVIDENCE_IMPORT_ACK,
} from './p14-operational-evidence-import-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name: string): string => {
  const value = valueOf(name);
  if (!value) throw new Error(`${name} required`);
  return value;
};

if (args.includes('--help')) {
  console.log([
    'Usage: pnpm p14:evidence:import -- --lane <interactive|learning|maintenance>',
    '       --session <id> --evidence-dir <dir> --expected-digest <sha256>',
    `       --ack ${P14_OPERATIONAL_EVIDENCE_IMPORT_ACK} [--data-dir <dir>]`,
    '',
    'Recomputes and immutably preserves one operational lane evidence set.',
    'It records only the evaluation binding and never activates a lane or enables writes.',
  ].join('\n'));
  process.exit(0);
}

const data = resolveOperationalDataDirectory({ explicit: valueOf('--data-dir') });
console.log(JSON.stringify({ ...importOperationalLaneEvidence({
  dataDirectory: data.path,
  evidenceDirectory: required('--evidence-dir'),
  expectedDigest: required('--expected-digest'),
  lane: required('--lane'),
  sessionId: required('--session'),
  acknowledgement: required('--ack'),
}), dataSource: data.source }, null, 2));
