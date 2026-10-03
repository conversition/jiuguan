#!/usr/bin/env node
import {
  disableMaintenanceCanary,
  maintenanceCanaryStatus,
  P14_MAINTENANCE_CANARY_ACK,
  prepareMaintenanceCanary,
} from './p14-maintenance-canary-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const valueOf = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name: string): string => {
  const value = valueOf(name);
  if (!value) throw new Error(`${name} required`);
  return value;
};
const data = resolveOperationalDataDirectory({ explicit: valueOf('--data-dir') });
const dataDirectory = data.path;

if (args.includes('--help')) {
  console.log([
    'Usage:',
    `  pnpm p14:canary prepare --session <id> --evidence-dir <dir> --expected-digest <sha256> --ack ${P14_MAINTENANCE_CANARY_ACK} [--data-dir <dir>]`,
    '  pnpm p14:canary status --session <id> [--data-dir <dir>]',
    '  pnpm p14:canary disable [--data-dir <dir>]',
    '',
    'prepare strictly recomputes suite.json + run.json, preserves an immutable private audit copy,',
    'then enables only the persistent Maintenance shadow test-session controls. It never enables apply.',
  ].join('\n'));
  process.exit(0);
}

if (command === 'prepare') {
  console.log(JSON.stringify({ ...prepareMaintenanceCanary({
    dataDirectory,
    evidenceDirectory: required('--evidence-dir'),
    expectedDigest: required('--expected-digest'),
    sessionId: required('--session'),
    acknowledgement: required('--ack'),
  }), dataSource: data.source }, null, 2));
} else if (command === 'status') {
  console.log(JSON.stringify({ ...maintenanceCanaryStatus(dataDirectory, required('--session')),
    dataSource: data.source }, null, 2));
} else if (command === 'disable') {
  disableMaintenanceCanary(dataDirectory);
  console.log(JSON.stringify({ ok: true, maintenance: 'off', globalEnabled: false,
    dataSource: data.source }, null, 2));
} else {
  throw new Error('command must be prepare|status|disable');
}
