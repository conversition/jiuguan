#!/usr/bin/env node
import {
  activateMaintenanceProductionCanary,
  disableMaintenanceCanary,
  maintenanceCanaryStatus,
  P14_MAINTENANCE_CANARY_ACK,
  P17_MAINTENANCE_PRODUCTION_CANARY_ACK,
  prepareMaintenanceCanary,
  rollbackMaintenanceProductionCanary,
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
    `  pnpm p14:canary activate --session <id> --evidence-dir <dir> --expected-digest <sha256> --ack ${P17_MAINTENANCE_PRODUCTION_CANARY_ACK} [--data-dir <dir>]`,
    '  pnpm p14:canary status --session <id> [--data-dir <dir>]',
    '  pnpm p14:canary rollback [--data-dir <dir>]',
    '  pnpm p14:canary disable [--data-dir <dir>]',
    '',
    'prepare strictly recomputes suite.json + run.json + evaluation.json, validates bridge-accounting.json',
    'and the exact session-bound binding.json, and preserves an immutable private audit copy,',
    'then enables only the persistent Maintenance shadow test-session controls. It never enables apply.',
    'activate requires the server to be stopped, revalidates the same evidence, rejects an active',
    'target production backlog, and commits only the exact session to canary-5. status reports a',
    'per-binding non-authorizing lifecycle assessment that closes over exact queued/unreceipted work;',
    'rollback sends future queued work to Legacy.',
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
} else if (command === 'activate') {
  console.log(JSON.stringify({ ...activateMaintenanceProductionCanary({
    dataDirectory,
    evidenceDirectory: required('--evidence-dir'),
    expectedDigest: required('--expected-digest'),
    sessionId: required('--session'),
    acknowledgement: required('--ack'),
  }), dataSource: data.source }, null, 2));
} else if (command === 'status') {
  console.log(JSON.stringify({ ...maintenanceCanaryStatus(dataDirectory, required('--session')),
    dataSource: data.source }, null, 2));
} else if (command === 'rollback') {
  console.log(JSON.stringify({ ok: true, maintenanceRoute:
    rollbackMaintenanceProductionCanary(dataDirectory), dataSource: data.source }, null, 2));
} else if (command === 'disable') {
  disableMaintenanceCanary(dataDirectory);
  console.log(JSON.stringify({ ok: true, maintenance: 'off', globalEnabled: false,
    dataSource: data.source }, null, 2));
} else {
  throw new Error('command must be prepare|activate|status|rollback|disable');
}
