#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildP14OperationalPreflight,
  resolveP14OperationalDataDirectory,
} from './p14-operational-preflight-core.ts';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

function main(): void {
  const argv = process.argv.slice(2);
  const purpose = option(argv, '--purpose') ?? 'lane-traffic';
  if (!['replay', 'recovery', 'lane-traffic'].includes(purpose)) {
    throw new Error('--purpose 只允许 replay、recovery 或 lane-traffic');
  }
  const sessionId = option(argv, '--session');
  if (!sessionId) throw new Error('--session 必填；公开版不绑定任何私人会话');
  if (!/^session-[A-Za-z0-9._-]{1,220}$/u.test(sessionId)) throw new Error('--session 非法');
  const data = resolveP14OperationalDataDirectory({
    explicit: option(argv, '--dir'),
  });
  const report = buildP14OperationalPreflight({
    dataDir: data.path,
    sessionId,
    profileFile: option(argv, '--profile')
      ?? resolve('tools', 'windows', 'public-safe-v0.1.env'),
  });
  const selectedReady = purpose === 'replay'
    ? report.readiness.syntheticReplayInfrastructure.ready
    : purpose === 'recovery'
      ? report.readiness.recovery.ready
      : report.readiness.allLaneTrafficReady;
  process.stdout.write(`${JSON.stringify({ ...report, dataSource: data.source,
    selectedPurpose: purpose, selectedReady }, null,
    argv.includes('--compact') ? 0 : 2)}\n`);
  if (!selectedReady) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
