#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activateNpcMaintenance,
  NPC_MAINTENANCE_ACTIVATION_ACK,
} from './npc-maintenance-activate-core.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

export type NpcMaintenanceActivationCliArgs = Readonly<
  | { help: true }
  | {
      help: false;
      sessionId: string;
      acknowledgement: string;
      dataDirectory?: string;
    }
>;

const VALUE_FLAGS = new Set(['--session', '--ack', '--data-dir']);

/** Strict parser: a misspelled or incomplete data-dir flag must never fall back to live data. */
export function parseNpcMaintenanceActivationArgs(args: readonly string[]): NpcMaintenanceActivationCliArgs {
  const values = new Map<string, string>();
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--help') {
      if (help) throw new Error('duplicate option: --help');
      help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`unknown option: ${token}`);
    if (values.has(token)) throw new Error(`duplicate option: ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.trim() !== value || value.startsWith('-')) {
      throw new Error(`${token} requires one non-empty value`);
    }
    values.set(token, value);
    index += 1;
  }
  if (help) {
    if (values.size !== 0) throw new Error('--help cannot be combined with activation options');
    return Object.freeze({ help: true });
  }
  const sessionId = values.get('--session');
  const acknowledgement = values.get('--ack');
  if (!sessionId) throw new Error('--session required');
  if (!acknowledgement) throw new Error('--ack required');
  const dataDirectory = values.get('--data-dir');
  return Object.freeze({
    help: false,
    sessionId,
    acknowledgement,
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  });
}

function run(args: readonly string[]): void {
  const parsed = parseNpcMaintenanceActivationArgs(args);
  if (parsed.help) {
    console.log([
      'Usage:',
      `  pnpm p14:npc:activate -- --session <id> --ack ${NPC_MAINTENANCE_ACTIVATION_ACK} [--data-dir <dir>]`,
      '',
      'Requires the Jiuguan server to be stopped. It takes integrity-checked SQLite backups,',
      'migrates only the selected session to the current schema, and enables persisted',
      'Maintenance shadow execution. It makes zero Provider calls.',
    ].join('\n'));
    return;
  }

  const data = resolveOperationalDataDirectory({ explicit: parsed.dataDirectory });
  const result = activateNpcMaintenance({
    dataDirectory: data.path,
    sessionId: parsed.sessionId,
    acknowledgement: parsed.acknowledgement,
  });
  console.log(JSON.stringify({ ...result, dataSource: data.source }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2));
}
