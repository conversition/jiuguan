import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LearnedStyleProposalStore } from '../../packages/core/src/learned-style-store.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'list';
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataDir = resolve(value('--data-dir') ?? process.env.JG_USER_DATA_DIR ?? 'data');
const store = new LearnedStyleProposalStore(
  resolve(dataDir, 'style-proposals'),
  resolve(dataDir, 'skills'),
);

if (command === 'list') {
  console.log(JSON.stringify(store.list(), null, 2));
} else if (command === 'create') {
  const file = value('--input');
  if (!file) throw new Error('create requires --input <json>');
  console.log(JSON.stringify(store.create(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
} else if (command === 'revise') {
  const id = value('--id');
  const file = value('--input');
  if (!id || !file) throw new Error('revise requires --id and --input <json>');
  console.log(JSON.stringify(store.revise(id, JSON.parse(readFileSync(file, 'utf8'))), null, 2));
} else if (command === 'enable' || command === 'rollback') {
  const id = value('--id');
  const rawVersion = value('--version');
  if (!id) throw new Error(`${command} requires --id`);
  const version = rawVersion === undefined ? undefined : Number(rawVersion);
  if (rawVersion !== undefined && (!Number.isSafeInteger(version) || version! < 1)) {
    throw new Error(`${command} --version must be a positive integer`);
  }
  if (command === 'rollback' && version === undefined) {
    throw new Error('rollback requires --version');
  }
  console.log(JSON.stringify(command === 'rollback'
    ? store.rollback(id, version!)
    : store.activate(id, version), null, 2));
} else if (command === 'diff') {
  const id = value('--id');
  const left = Number(value('--left'));
  const right = Number(value('--right'));
  if (!id || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Error('diff requires --id --left --right');
  }
  console.log(JSON.stringify(store.diff(id, left, right), null, 2));
} else {
  throw new Error('usage: style-proposal <list|create|revise|enable|rollback|diff> [--data-dir <dir>]');
}
