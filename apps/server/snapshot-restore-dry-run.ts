#!/usr/bin/env node
import { resolve } from 'node:path';
import { validateRestoredDataDir } from './snapshot-restore.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('缺少参数 ' + name);
  return process.argv[index + 1]!;
}

if (process.env.JG_SNAPSHOT_DRY_RUN !== '1') throw new Error('只允许由 snapshot restore dry-run adapter 启动');
const dataDir = resolve(argument('--data-dir'));
const snapshotId = argument('--snapshot-id');
validateRestoredDataDir(dataDir, snapshotId);
process.stdout.write('snapshot-restore-dry-run:ok\n');
